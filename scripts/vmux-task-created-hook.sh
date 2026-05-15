#!/usr/bin/env bash
#
# vmux-task-created-hook.sh — Claude Code TaskCreated hook
#
# Fires when Claude calls the TaskCreate tool.  POSTs the task to the
# relay so the web UI's TaskListPanel renders the live task list.

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
task_id=$(echo "$input" | jq -r '.task_id // .task.id // empty' 2>/dev/null)
subject=$(echo "$input" | jq -r '.task_subject // .task.subject // .subject // empty' 2>/dev/null)
description=$(echo "$input" | jq -r '.task_description // .task.description // .description // empty' 2>/dev/null)
teammate=$(echo "$input" | jq -r '.teammate_name // .team_name // empty' 2>/dev/null)

if [ -z "$cwd" ] || [ -z "$task_id" ]; then
    exit 0
fi

# Map cwd → relay session_id (prefer workspace.project_dir from statusline).
session_cwd="$cwd"
statusline_file="$VMUX_DIR/sessions/${claude_session_id}.json"
if [ -f "$statusline_file" ]; then
    pd=$(jq -r '.workspace.project_dir // empty' "$statusline_file" 2>/dev/null)
    [ -n "$pd" ] && session_cwd="$pd"
fi
relay_session_id=$(printf '%s' "$session_cwd" | shasum -a 256 | awk '{print substr($1, 1, 12)}')

payload=$(jq -n \
    --arg task_id "$task_id" \
    --arg subject "$subject" \
    --arg description "$description" \
    --arg teammate "$teammate" \
    '{task_id: $task_id, subject: $subject, description: $description, teammate: $teammate, status: "pending"}')

curl -sS -X POST \
    -H "X-Daemon-Secret: $DAEMON_SECRET" \
    -H "Content-Type: application/json" \
    --max-time 3 \
    "$RELAY_URL/api/sessions/$relay_session_id/task-created" \
    -d "$payload" >/dev/null 2>&1 &

exit 0
