#!/usr/bin/env bash
#
# vmux-pre-compact-hook.sh — Claude Code PreCompact hook
#
# Fires just before Claude auto-compacts the conversation. Posts a short
# "Compaction event detected..." callout to the relay so the web UI
# renders the faded system bubble and TTSes the announcement directly
# through Kokoro (bypassing Claude — this is a system event).

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

session_cwd="$cwd"
statusline_file="$VMUX_DIR/sessions/${claude_session_id}.json"
if [ -f "$statusline_file" ]; then
    pd=$(jq -r '.workspace.project_dir // empty' "$statusline_file" 2>/dev/null)
    [ -n "$pd" ] && session_cwd="$pd"
fi
relay_session_id=$(printf '%s' "$session_cwd" | shasum -a 256 | awk '{print substr($1, 1, 12)}')

message="Compaction event detected. Compacting now — I'll let you know when it's done."
payload=$(jq -n --arg message "$message" \
    '{message: $message, speak: true}')

curl -sS -X POST \
    -H "X-Daemon-Secret: $DAEMON_SECRET" \
    -H "Content-Type: application/json" \
    --max-time 3 \
    "$RELAY_URL/api/sessions/$relay_session_id/notify" \
    -d "$payload" >/dev/null 2>&1 &

exit 0
