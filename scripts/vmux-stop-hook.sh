#!/usr/bin/env bash
#
# vmux-stop-hook.sh — Claude Code Stop hook for Voice Multiplexer
#
# Fires at the end of each assistant turn.  Speaking is now handled by the
# MessageDisplay hook (per-block streaming into the relay), so this hook no
# longer reads the transcript or ships TTS.  Its only jobs are:
#   1. Re-register the session (idempotent self-heal if the relay restarted).
#   2. Signal turn-complete so the web client re-enables the microphone.
#
# The relay defers the turn-complete idle transition while a message stream is
# still open, so the final streamed sentence finishes before the mic re-enables.
#
# Input (stdin JSON from Claude Code):
#   {
#     "session_id": "<claude-session-uuid>",
#     "cwd": "/path/to/working/dir",
#     "hook_event_name": "Stop",
#   }
#
# The relay session_id is sha256(project_dir)[:12].

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
if [ -z "$cwd" ]; then
    exit 0
fi

# Prefer workspace.project_dir from the statusline JSON; fall back to cwd.
statusline_file="$VMUX_DIR/sessions/${claude_session_id}.json"
session_cwd="$cwd"
if [ -f "$statusline_file" ]; then
    pd=$(jq -r '.workspace.project_dir // empty' "$statusline_file" 2>/dev/null)
    if [ -n "$pd" ]; then
        session_cwd="$pd"
    fi
fi

relay_session_id=$(printf '%s' "$session_cwd" | shasum -a 256 | awk '{print substr($1, 1, 12)}')

# Re-register before signalling.  /register is idempotent and self-heals if
# the relay was restarted since our SessionStart hook fired.
dir_name=$(basename "$session_cwd")
register_payload=$(jq -n --arg cwd "$session_cwd" --arg name "$dir_name" '{cwd: $cwd, name: $name}')
curl -sS -X POST \
    -H "X-Daemon-Secret: $DAEMON_SECRET" \
    -H "Content-Type: application/json" \
    --max-time 3 \
    "$RELAY_URL/api/sessions/$relay_session_id/register" \
    -d "$register_payload" >/dev/null 2>&1

# Signal turn-complete so the mic re-enables.  The relay holds this until any
# open message stream finishes and the TTS queue drains.
curl -sS -X POST \
    -H "X-Daemon-Secret: $DAEMON_SECRET" \
    -H "Content-Type: application/json" \
    --max-time 3 \
    "$RELAY_URL/api/sessions/$relay_session_id/turn-complete" \
    -d '{}' >/dev/null 2>&1

exit 0
