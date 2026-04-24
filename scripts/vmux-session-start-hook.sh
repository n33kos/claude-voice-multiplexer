#!/usr/bin/env bash
#
# vmux-session-start-hook.sh — Claude Code SessionStart hook for Voice Multiplexer
#
# Fires once when a Claude Code session begins.  Registers the session with
# the relay server so it shows up in the web UI and can receive voice input
# and TTS audio.
#
# Replaces the old `/voice-multiplexer:standby` one-shot invocation.
#
# Input (stdin JSON from Claude Code):
#   {
#     "session_id": "<claude-session-uuid>",
#     "transcript_path": "...",
#     "cwd": "/path/to/cwd",
#     "hook_event_name": "SessionStart",
#     ...
#   }
#
# The relay session_id is sha256(cwd)[:12] — same derivation used everywhere
# else in the codebase.

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

input=$(cat)
cwd=$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null)
claude_session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
if [ -z "$cwd" ]; then
    exit 0
fi

# Prefer workspace.project_dir from the statusline JSON so this matches
# the cwd the MCP plugin uses for registration.  Falls back to cwd if the
# statusline file does not exist yet (first turn of a fresh session).
session_cwd="$cwd"
statusline_file="$VMUX_DIR/sessions/${claude_session_id}.json"
if [ -f "$statusline_file" ]; then
    pd=$(jq -r '.workspace.project_dir // empty' "$statusline_file" 2>/dev/null)
    if [ -n "$pd" ]; then
        session_cwd="$pd"
    fi
fi

relay_session_id=$(printf '%s' "$session_cwd" | shasum -a 256 | awk '{print substr($1, 1, 12)}')
dir_name=$(basename "$session_cwd")
payload=$(jq -n --arg cwd "$session_cwd" --arg name "$dir_name" '{cwd: $cwd, name: $name}')

curl -sS -X POST \
    -H "X-Daemon-Secret: $DAEMON_SECRET" \
    -H "Content-Type: application/json" \
    --max-time 5 \
    "$RELAY_URL/api/sessions/$relay_session_id/register" \
    -d "$payload" >/dev/null 2>&1

exit 0
