#!/usr/bin/env bash
#
# vmux-ask-user-question-hook.sh — Claude Code PreToolUse hook for
# the AskUserQuestion tool (the `/ask` skill).
#
# Fires when Claude is about to call AskUserQuestion to present a
# multiple-choice prompt.  In voice mode the user has no audio cue
# that their input is expected, so we TTS the question and its
# options.  Does NOT auto-answer — the user still selects a choice
# from the terminal.

set -uo pipefail

VMUX_DIR="$HOME/.claude/voice-multiplexer"
SECRET_FILE="$VMUX_DIR/daemon.secret"
RELAY_HOST="${RELAY_HOST:-127.0.0.1}"
RELAY_PORT="${RELAY_PORT:-3100}"
RELAY_URL="http://${RELAY_HOST}:${RELAY_PORT}"

if [ ! -f "$SECRET_FILE" ]; then
    exit 0
fi
DAEMON_SECRET=$(tr -d '[:space:]' < "$SECRET_FILE")

input=$(cat)
claude_session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
cwd=$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null)
tool_name=$(echo "$input" | jq -r '.tool_name // empty' 2>/dev/null)
if [ -z "$cwd" ]; then
    exit 0
fi

# Only speak when the matcher lands us on AskUserQuestion.  The
# PreToolUse matcher in hooks.json should already gate this, but
# double-check in case the script is invoked more broadly.
if [ -n "$tool_name" ] && [ "$tool_name" != "AskUserQuestion" ]; then
    exit 0
fi

session_cwd="$cwd"
statusline_file="$VMUX_DIR/sessions/${claude_session_id}.json"
if [ -f "$statusline_file" ]; then
    pd=$(jq -r '.workspace.project_dir // empty' "$statusline_file" 2>/dev/null)
    [ -n "$pd" ] && session_cwd="$pd"
fi

relay_session_id=$(printf '%s' "$session_cwd" | shasum -a 256 | awk '{print substr($1, 1, 12)}')

# AskUserQuestion's documented shape is `tool_input.questions[]` (1-4 items).
# Older / variant shapes flatten a single question to the top level. Normalize
# both into a single questions[] array so we can iterate uniformly.
normalized=$(echo "$input" | jq -c '
    .tool_input as $ti
    | (
        if ($ti.questions | type) == "array" and ($ti.questions | length) > 0 then
            $ti.questions
        elif ($ti.question // "") != "" then
            [{question: $ti.question, header: ($ti.header // ""), multiSelect: ($ti.multiSelect // false), options: ($ti.options // [])}]
        else
            []
        end
      )
    | map(select((.question // "") != "" and ((.options // []) | length) > 0))
' 2>/dev/null)

count=$(echo "$normalized" | jq 'length' 2>/dev/null)
count=${count:-0}

if [ "$count" -eq 0 ]; then
    # Unknown shape — announce generically rather than go silent.
    tts_payload=$(jq -n '{text: "Claude is asking a question. Check the terminal to respond.", interruptible: false}')
    curl -sS -X POST \
        -H "X-Daemon-Secret: $DAEMON_SECRET" \
        -H "Content-Type: application/json" \
        --max-time 5 \
        "$RELAY_URL/api/sessions/$relay_session_id/tts" \
        -d "$tts_payload" >/dev/null 2>&1 &
    exit 0
fi

# Build one TTS message that covers all questions in order. Claude's picker
# only shows one at a time in the terminal, but the user benefits from
# hearing the full set up front so they know how many responses are coming.
if [ "$count" -gt 1 ]; then
    tts_message=$(echo "$normalized" | jq -r '
        to_entries
        | map(
            "Question \(.key + 1) of \(length): \(.value.question)"
            + (if ((.value.options // []) | length) > 0
                then " Options are: " + ((.value.options | map(.label // "") | map(select(length > 0))) | join(", ")) + "."
                else "" end)
          )
        | join(" ")
    ')
else
    tts_message=$(echo "$normalized" | jq -r '
        .[0] |
        .question
        + (if ((.options // []) | length) > 0
            then " Options are: " + ((.options | map(.label // "") | map(select(length > 0))) | join(", ")) + "."
            else "" end)
    ')
fi

tts_payload=$(jq -n --arg text "$tts_message" '{text: $text, interruptible: false}')
curl -sS -X POST \
    -H "X-Daemon-Secret: $DAEMON_SECRET" \
    -H "Content-Type: application/json" \
    --max-time 5 \
    "$RELAY_URL/api/sessions/$relay_session_id/tts" \
    -d "$tts_payload" >/dev/null 2>&1 &

# Broadcast one structured /question payload per question so the web UI
# renders an interactive card for each. The picker in the terminal advances
# sequentially, so click-to-answer responses are routed by terminal state.
i=0
while [ "$i" -lt "$count" ]; do
    struct_payload=$(echo "$normalized" | jq -c --argjson i "$i" --argjson n "$count" '
        .[$i] |
        {
            question: (.question // ""),
            header: (.header // ""),
            multiSelect: (.multiSelect // false),
            options: ([.options[]? | {label, description}]),
            question_index: $i,
            question_count: $n
        }
    ')
    if [ -n "$struct_payload" ]; then
        # Sequential (no trailing &) so the broadcasts arrive in order; otherwise
        # the web client can see question 3 before question 1 and gating fails.
        curl -sS -X POST \
            -H "X-Daemon-Secret: $DAEMON_SECRET" \
            -H "Content-Type: application/json" \
            --max-time 5 \
            "$RELAY_URL/api/sessions/$relay_session_id/question" \
            -d "$struct_payload" >/dev/null 2>&1
    fi
    i=$((i + 1))
done

exit 0
