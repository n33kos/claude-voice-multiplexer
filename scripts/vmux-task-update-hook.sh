#!/usr/bin/env bash
#
# vmux-task-update-hook.sh — Claude Code TaskUpdate hook
#
# Fires when a task is updated (typically marked completed via TaskUpdate,
# or when an agent-team teammate finishes with in-progress tasks).  POSTs
# the change to the relay so the web UI's TaskListPanel can transition
# the task's state.

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
status=$(echo "$input" | jq -r '.status // .task.status // .new_status // "completed"' 2>/dev/null)
subject=$(echo "$input" | jq -r '.task_subject // .task.subject // .subject // empty' 2>/dev/null)
teammate=$(echo "$input" | jq -r '.teammate_name // .team_name // empty' 2>/dev/null)

if [ -z "$cwd" ] || [ -z "$task_id" ]; then
    exit 0
fi

# Normalize unexpected statuses to "completed" (the hook's primary signal).
case "$status" in
    pending|in_progress|completed|deleted) ;;
    *) status="completed" ;;
esac

session_cwd="$cwd"
statusline_file="$VMUX_DIR/sessions/${claude_session_id}.json"
if [ -f "$statusline_file" ]; then
    pd=$(jq -r '.workspace.project_dir // empty' "$statusline_file" 2>/dev/null)
    [ -n "$pd" ] && session_cwd="$pd"
fi
relay_session_id=$(printf '%s' "$session_cwd" | shasum -a 256 | awk '{print substr($1, 1, 12)}')

payload=$(jq -n \
    --arg task_id "$task_id" \
    --arg status "$status" \
    --arg subject "$subject" \
    --arg teammate "$teammate" \
    '{task_id: $task_id, status: $status, subject: $subject, teammate: $teammate}')

curl -sS -X POST \
    -H "X-Daemon-Secret: $DAEMON_SECRET" \
    -H "Content-Type: application/json" \
    --max-time 3 \
    "$RELAY_URL/api/sessions/$relay_session_id/task-update" \
    -d "$payload" >/dev/null 2>&1 &

exit 0
