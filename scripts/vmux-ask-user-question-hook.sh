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

# Extract the question + option labels.  Shape per Claude Code docs:
#   tool_input: { question: "...", options: [{label: "..."}, ...] }
# Some variants flatten to tool_input.questions (plural) — handle both.
question=$(echo "$input" | jq -r '.tool_input.question // .tool_input.questions[0].question // empty' 2>/dev/null)
option_labels=$(echo "$input" | jq -r '[.tool_input.options[]?.label // empty, .tool_input.questions[0]?.options[]?.label // empty] | map(select(length > 0)) | join(", ")' 2>/dev/null)

if [ -z "$question" ]; then
    # Unknown shape — announce generically rather than go silent.
    tts_message="Claude is asking a question. Check the terminal to respond."
elif [ -n "$option_labels" ]; then
    tts_message="${question} Options are: ${option_labels}."
else
    tts_message="${question}"
fi

session_cwd="$cwd"
statusline_file="$VMUX_DIR/sessions/${claude_session_id}.json"
if [ -f "$statusline_file" ]; then
    pd=$(jq -r '.workspace.project_dir // empty' "$statusline_file" 2>/dev/null)
    [ -n "$pd" ] && session_cwd="$pd"
fi

relay_session_id=$(printf '%s' "$session_cwd" | shasum -a 256 | awk '{print substr($1, 1, 12)}')

# Spoken announcement so the user knows they need to respond.
tts_payload=$(jq -n --arg text "$tts_message" '{text: $text, interruptible: false}')
curl -sS -X POST \
    -H "X-Daemon-Secret: $DAEMON_SECRET" \
    -H "Content-Type: application/json" \
    --max-time 5 \
    "$RELAY_URL/api/sessions/$relay_session_id/tts" \
    -d "$tts_payload" >/dev/null 2>&1 &

# Structured question payload so the web UI can render an interactive
# card with click-to-answer buttons.  Uses jq to extract the full
# question shape (question text, header, options with labels and
# descriptions) — handles both top-level and questions[0] forms.
struct_payload=$(echo "$input" | jq -c '
    (.tool_input.questions[0] // .tool_input) as $q
    | {
        question: ($q.question // ""),
        header: ($q.header // ""),
        multiSelect: ($q.multiSelect // false),
        options: ([$q.options[]? | {label, description}])
      }
    | select(.question != "" and (.options | length) > 0)
')
if [ -n "$struct_payload" ]; then
    curl -sS -X POST \
        -H "X-Daemon-Secret: $DAEMON_SECRET" \
        -H "Content-Type: application/json" \
        --max-time 5 \
        "$RELAY_URL/api/sessions/$relay_session_id/question" \
        -d "$struct_payload" >/dev/null 2>&1 &
fi

exit 0
