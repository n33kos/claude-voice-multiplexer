#!/usr/bin/env bash
#
# vmux-tool-activity-hook.sh — Claude Code PreToolUse hook
#
# Fires before every tool call.  Posts a short activity status to the
# relay so the web UI's activity badge reflects what Claude is about
# to do — "Running Bash", "Reading file", etc.  Silent: no TTS.
#
# Skips AskUserQuestion (has its own dedicated hook that TTSes the
# question + options).

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
tool_name=$(echo "$input" | jq -r '.tool_name // .tool // empty' 2>/dev/null)
claude_session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
cwd=$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null)
if [ -z "$cwd" ] || [ -z "$tool_name" ]; then
    exit 0
fi

# AskUserQuestion has its own dedicated announcement hook.
if [ "$tool_name" = "AskUserQuestion" ]; then
    exit 0
fi

# Turn the tool input into a short human-readable activity string.
# Tool input shapes from Claude Code docs:
#   Bash:   { command, description }
#   Read:   { file_path }
#   Edit:   { file_path, old_string, new_string, replace_all? }
#   Write:  { file_path, content }
#   Grep:   { pattern, path?, output_mode? }
#   Glob:   { pattern, path? }
#   WebFetch: { url, prompt }
#   WebSearch: { query }
#   Task:   { subagent_type, description, prompt }
#
# We intentionally keep the description short and Claude-Code-like; the
# point is "what's happening right now", not full context.
activity=$(echo "$input" | jq -r --arg t "$tool_name" '
    .tool_input as $in
    |
    if $t == "Bash" then
        ($in.description // $in.command // "command") as $d
        | "Running Bash: " + ($d | tostring | .[0:80])
    elif $t == "Read" then
        "Reading " + ($in.file_path // "file" | tostring | sub(".*/"; ""))
    elif $t == "Edit" then
        "Editing " + ($in.file_path // "file" | tostring | sub(".*/"; ""))
    elif $t == "Write" then
        "Writing " + ($in.file_path // "file" | tostring | sub(".*/"; ""))
    elif $t == "Grep" then
        "Searching for: " + (($in.pattern // "") | tostring | .[0:60])
    elif $t == "Glob" then
        "Finding files: " + (($in.pattern // "") | tostring | .[0:60])
    elif $t == "WebFetch" then
        "Fetching " + (($in.url // "") | tostring | .[0:80])
    elif $t == "WebSearch" then
        "Searching web: " + (($in.query // "") | tostring | .[0:60])
    elif $t == "Task" then
        "Running agent: " + (($in.description // $in.subagent_type // "subtask") | tostring | .[0:80])
    elif $t == "TodoWrite" or $t == "TaskCreate" or $t == "TaskUpdate" or $t == "TaskList" then
        "Updating tasks"
    else
        $t
    end
' 2>/dev/null)

if [ -z "$activity" ]; then
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

payload=$(jq -n --arg activity "$activity" '{activity: $activity}')
curl -sS -X POST \
    -H "X-Daemon-Secret: $DAEMON_SECRET" \
    -H "Content-Type: application/json" \
    --max-time 3 \
    "$RELAY_URL/api/sessions/$relay_session_id/activity" \
    -d "$payload" >/dev/null 2>&1 &

exit 0
