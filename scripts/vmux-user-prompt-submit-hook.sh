#!/usr/bin/env bash
#
# vmux-user-prompt-submit-hook.sh — Claude Code UserPromptSubmit hook
#
# Fires on every user prompt.  Re-injects a compressed voice-mode brevity
# reminder so long sessions don't drift verbose.  The full voice-style
# block lives on SessionStart; this is the lightweight per-turn anchor
# (~80 tokens) that used to be a side effect of standby's pre-v4.0.5
# context-priming.
#
# Gates on the same /register response the SessionStart hook uses — the
# relay's fast path returns 200 cheaply for an already-registered
# session, so non-vmux Claude Code sessions get nothing (404) and
# vmux-managed ones get the reminder.

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
cwd=$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null)
claude_session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
if [ -z "$cwd" ]; then
    exit 0
fi

# Mirror the SessionStart hook: prefer workspace.project_dir from the
# statusline so the session_id derivation matches the MCP plugin's.
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

# Fast-path register — for an already-registered session this just bumps
# the heartbeat and returns 200, so it's safe to call every turn.  404
# means "not vmux-managed", in which case we emit nothing.
http_code=$(curl -sS -X POST \
    -H "X-Daemon-Secret: $DAEMON_SECRET" \
    -H "Content-Type: application/json" \
    --max-time 3 \
    -o /dev/null \
    -w "%{http_code}" \
    "$RELAY_URL/api/sessions/$relay_session_id/register" \
    -d "$payload" 2>/dev/null)

if [ "$http_code" = "200" ]; then
    read -r -d '' reminder <<'INSTR_EOF' || true
Voice mode. Keep replies short and conversational — one or two sentences when possible. No bullets, headers, or tables unless asked or you're rendering code/data. Skip preamble.
INSTR_EOF
    jq -nc --arg ctx "$reminder" \
        '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $ctx}}'
fi

exit 0
