#!/usr/bin/env bash
#
# vmux-permission-request-hook.sh — Claude Code PermissionRequest hook
#
# Fires when Claude is about to run a tool that requires user approval.
# In voice mode the user otherwise has no audio signal that the session
# is blocked waiting on them; this hook TTSes a short "Claude needs
# permission to use <tool>" prompt so they know to look at the terminal.
#
# Does NOT auto-approve.  The user still responds via keyboard.

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
tool_name=$(echo "$input" | jq -r '.tool_name // .tool // empty' 2>/dev/null)
if [ -z "$cwd" ]; then
    exit 0
fi

# Skip tools that have their own dedicated announcement hook, so we
# don't double-speak.  AskUserQuestion is handled by the PreToolUse
# matcher in hooks.json which speaks the actual question + options.
case "$tool_name" in
    AskUserQuestion) exit 0 ;;
esac

# Prefer workspace.project_dir from statusline JSON (matches MCP cwd).
session_cwd="$cwd"
statusline_file="$VMUX_DIR/sessions/${claude_session_id}.json"
if [ -f "$statusline_file" ]; then
    pd=$(jq -r '.workspace.project_dir // empty' "$statusline_file" 2>/dev/null)
    [ -n "$pd" ] && session_cwd="$pd"
fi

relay_session_id=$(printf '%s' "$session_cwd" | shasum -a 256 | awk '{print substr($1, 1, 12)}')

if [ "$tool_name" = "Skill" ]; then
    skill_name=$(echo "$input" | jq -r '.tool_input.skill // empty' 2>/dev/null)
    if [ -n "$skill_name" ]; then
        tts_message="Claude needs permission to use the ${skill_name} skill. Check the web app to approve or deny."
    else
        tts_message="Claude needs permission to use a skill. Check the web app to approve or deny."
    fi
elif [ -n "$tool_name" ]; then
    tts_message="Claude needs permission to use ${tool_name}. Check the web app to approve or deny."
else
    tts_message="Claude needs your permission. Check the web app to respond."
fi

# TTS announcement so the user knows their attention is needed.
tts_payload=$(jq -n --arg text "$tts_message" '{text: $text, interruptible: false}')
curl -sS -X POST \
    -H "X-Daemon-Secret: $DAEMON_SECRET" \
    -H "Content-Type: application/json" \
    --max-time 5 \
    "$RELAY_URL/api/sessions/$relay_session_id/tts" \
    -d "$tts_payload" >/dev/null 2>&1 &

# Structured payload so the web UI can render a click-to-answer card.
# Summarize tool_input so the user can see what's being requested without
# needing to look at the terminal (e.g. "git status" vs "rm -rf").
summary=$(echo "$input" | jq -r --arg t "$tool_name" '
    .tool_input as $in
    |
    if $t == "Bash" then ($in.command // "") | tostring | .[0:200]
    elif $t == "Read" or $t == "Edit" or $t == "Write" then ($in.file_path // "") | tostring
    elif $t == "Grep" then "pattern: " + (($in.pattern // "") | tostring | .[0:120])
    elif $t == "Glob" then "pattern: " + (($in.pattern // "") | tostring | .[0:120])
    elif $t == "WebFetch" then ($in.url // "") | tostring
    elif $t == "WebSearch" then ($in.query // "") | tostring | .[0:120]
    elif $t == "Task" then ($in.description // $in.subagent_type // "") | tostring | .[0:160]
    elif $t == "Skill" then
        (($in.skill // "") | tostring) as $s
        | (($in.args // "") | tostring) as $a
        | if $a == "" then $s else ($s + ": " + ($a | .[0:200])) end
    else ""
    end
' 2>/dev/null)

struct_payload=$(jq -n \
    --arg tool "$tool_name" \
    --arg summary "$summary" \
    '{tool_name: $tool, summary: $summary}')

curl -sS -X POST \
    -H "X-Daemon-Secret: $DAEMON_SECRET" \
    -H "Content-Type: application/json" \
    --max-time 5 \
    "$RELAY_URL/api/sessions/$relay_session_id/permission-request" \
    -d "$struct_payload" >/dev/null 2>&1 &

exit 0
