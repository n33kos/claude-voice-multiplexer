#!/usr/bin/env bash
#
# vmux-stop-hook.sh — Claude Code Stop hook for Voice Multiplexer
#
# Fires at the end of each assistant turn.  Reads the last assistant message
# from the transcript JSONL, ships its text content to the relay for TTS
# synthesis, then broadcasts a turn-complete signal so the web client
# re-enables the microphone.
#
# Input (stdin JSON from Claude Code):
#   {
#     "session_id": "<claude-session-uuid>",
#     "transcript_path": "/path/to/transcript.jsonl",
#     "cwd": "/path/to/working/dir",
#     "hook_event_name": "Stop",
#     "permission_mode": "default",
#   }
#
# The relay session_id is sha256(cwd)[:12] — same derivation used in
# relay-server/mcp_tools.py and daemon/session_manager.py.

set -uo pipefail

VMUX_DIR="$HOME/.claude/voice-multiplexer"
SECRET_FILE="$VMUX_DIR/daemon.secret"
RELAY_HOST="${RELAY_HOST:-127.0.0.1}"
RELAY_PORT="${RELAY_PORT:-3100}"
RELAY_URL="http://${RELAY_HOST}:${RELAY_PORT}"

# Bail silently if the relay environment is not present.
if [ ! -f "$SECRET_FILE" ]; then
    exit 0
fi
DAEMON_SECRET=$(tr -d '[:space:]' < "$SECRET_FILE")

# Read hook payload
input=$(cat)
transcript_path=$(echo "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
claude_session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
cwd=$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null)
if [ -z "$transcript_path" ] || [ -z "$cwd" ] || [ ! -f "$transcript_path" ]; then
    exit 0
fi

# The relay registers sessions under the MCP project dir, which may not
# match Claude Code's cwd (e.g., when Claude is operating in a subfolder
# like /path/to/project/web).  Prefer workspace.project_dir from the
# statusline JSON we maintain; fall back to cwd if that file is missing.
statusline_file="$VMUX_DIR/sessions/${claude_session_id}.json"
session_cwd="$cwd"
if [ -f "$statusline_file" ]; then
    pd=$(jq -r '.workspace.project_dir // empty' "$statusline_file" 2>/dev/null)
    if [ -n "$pd" ]; then
        session_cwd="$pd"
    fi
fi

relay_session_id=$(printf '%s' "$session_cwd" | shasum -a 256 | awk '{print substr($1, 1, 12)}')

# Extract the most recent assistant message's text content.
#
# Claude Code flushes the current turn's assistant text to the JSONL
# asynchronously, which can race with the Stop hook firing.  We poll
# the file for a short window, preferring a text that appeared within
# the last few seconds.  If we never see fresh text (tool-only turn),
# last_text stays empty and no TTS is sent.
_extract_fresh_text() {
    # Use jq slurp mode so multi-line content is handled as a single
    # record (earlier head -n 1 truncated responses at the first newline).
    local cutoff=$(($(date +%s) - 5))
    jq -rs --argjson cutoff "$cutoff" '
        [.[]
         | select(.message.role == "assistant")
         | select((.timestamp // "" | sub("\\.\\d+Z$"; "Z") | fromdate? // 0) >= $cutoff)]
        | map(.message.content | map(select(.type == "text") | .text) | join("\n"))
        | map(select(length > 0))
        | .[-1] // ""
    ' "$transcript_path" 2>/dev/null
}

last_text=""
for i in 1 2 3 4 5 6 7 8; do
    last_text=$(_extract_fresh_text)
    if [ -n "$last_text" ]; then
        break
    fi
    sleep 0.3
done

# Resilience: re-register before each turn.  /register is idempotent
# (replaces any existing entry with the same ID) and this self-heals if
# the relay was restarted since our SessionStart hook fired.  Cheap
# enough (single HTTP round-trip on loopback) to run on every turn.
dir_name=$(basename "$session_cwd")
register_payload=$(jq -n --arg cwd "$session_cwd" --arg name "$dir_name" '{cwd: $cwd, name: $name}')
curl -sS -X POST \
    -H "X-Daemon-Secret: $DAEMON_SECRET" \
    -H "Content-Type: application/json" \
    --max-time 3 \
    "$RELAY_URL/api/sessions/$relay_session_id/register" \
    -d "$register_payload" >/dev/null 2>&1

# Order matters: ship TTS FIRST and block until the relay has queued it,
# so /turn-complete arrives after the response_queue is populated.  If
# /turn-complete arrives first, handle_claude_listening races and marks
# the session idle before TTS starts, so the TTS-end transition lands
# on "thinking" instead of "idle" and the mic stays disabled.
if [ -n "$last_text" ]; then
    payload=$(jq -n --arg text "$last_text" '{text: $text, interruptible: true}')
    curl -sS -X POST \
        -H "X-Daemon-Secret: $DAEMON_SECRET" \
        -H "Content-Type: application/json" \
        --max-time 5 \
        "$RELAY_URL/api/sessions/$relay_session_id/tts" \
        -d "$payload" >/dev/null 2>&1
fi

# Always signal turn-complete so the mic re-enables after TTS — even for
# tool-only turns (silent is acceptable per plan Q4).
curl -sS -X POST \
    -H "X-Daemon-Secret: $DAEMON_SECRET" \
    -H "Content-Type: application/json" \
    --max-time 3 \
    "$RELAY_URL/api/sessions/$relay_session_id/turn-complete" \
    -d '{}' >/dev/null 2>&1

exit 0
