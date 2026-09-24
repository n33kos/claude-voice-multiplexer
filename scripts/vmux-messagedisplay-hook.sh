#!/usr/bin/env bash
#
# vmux-messagedisplay-hook.sh — Claude Code MessageDisplay hook for Voice Multiplexer
#
# Fires while each assistant text block is displayed, including intermediate
# blocks that precede tool calls.  Forwards the raw chunk to the relay's
# streaming endpoint, which handles sentence-level TTS and per-chunk transcript
# bubbles.  This replaces the old Stop-hook transcript scrape: every block is
# spoken and shown, not just the final one.
#
# Input (stdin JSON from Claude Code):
#   {
#     "session_id": "<claude-session-uuid>",
#     "cwd": "/path/to/working/dir",
#     "hook_event_name": "MessageDisplay",
#     "message_id": "<per-block uuid>",
#     "turn_id": "<per-turn uuid>",
#     "index": 0,
#     "final": false,
#     "delta": "<the text chunk>"
#   }
#
# The POST is synchronous (not backgrounded) so chunks arrive at the relay in
# index order.  The relay session_id is sha256(project_dir)[:12].

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
claude_session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
message_id=$(printf '%s' "$input" | jq -r '.message_id // empty' 2>/dev/null)
index=$(printf '%s' "$input" | jq -r '.index // 0' 2>/dev/null)
final=$(printf '%s' "$input" | jq -r '.final // false' 2>/dev/null)
delta=$(printf '%s' "$input" | jq -r '.delta // empty' 2>/dev/null)

if [ -z "$cwd" ] || [ -z "$message_id" ]; then
    exit 0
fi

# Prefer workspace.project_dir from the statusline JSON (same as the other
# hooks) so a subfolder cwd still maps to the registered relay session.
statusline_file="$VMUX_DIR/sessions/${claude_session_id}.json"
session_cwd="$cwd"
if [ -f "$statusline_file" ]; then
    pd=$(jq -r '.workspace.project_dir // empty' "$statusline_file" 2>/dev/null)
    if [ -n "$pd" ]; then
        session_cwd="$pd"
    fi
fi
relay_session_id=$(printf '%s' "$session_cwd" | shasum -a 256 | awk '{print substr($1, 1, 12)}')

payload=$(jq -n \
    --arg message_id "$message_id" \
    --argjson index "${index:-0}" \
    --argjson final "${final:-false}" \
    --arg delta "$delta" \
    '{message_id: $message_id, index: $index, final: $final, delta: $delta}')

curl -sS -X POST \
    -H "X-Daemon-Secret: $DAEMON_SECRET" \
    -H "Content-Type: application/json" \
    --max-time 5 \
    "$RELAY_URL/api/sessions/$relay_session_id/stream" \
    -d "$payload" >/dev/null 2>&1

exit 0
