#!/usr/bin/env bash
#
# vmux-subagent-stop-hook.sh — Claude Code SubagentStop hook
#
# Fires when a spawned subagent completes.  Posts a short
# "<name> complete." callout to the relay so the web UI renders the
# faded "Background Agent" system bubble and TTSes the announcement.

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
agent_id=$(echo "$input" | jq -r '.agent_id // empty' 2>/dev/null)
agent_type=$(echo "$input" | jq -r '.agent_type // .subagent_type // empty' 2>/dev/null)

# Filter out ghost SubagentStop events. Claude Code 2.1.142 internally
# spawns sidechain LLM calls (likely next-prompt prediction or summary
# generation) that fire SubagentStop hooks but have no agent_type, no
# transcript file, and a last_assistant_message that looks like predicted
# user input. Real Agent-tool subagents always have a non-empty agent_type.
if [ -z "$agent_type" ] || [ "$agent_type" = "null" ]; then
    exit 0
fi
last_msg=$(echo "$input" | jq -r '.last_assistant_message // empty' 2>/dev/null)
description=$(echo "$input" | jq -r '.description // .task // .tool_input.description // empty' 2>/dev/null)
result_text=$(echo "$input" | jq -r '.response // .result // .output // .tool_result // empty' 2>/dev/null)
transcript_path=$(echo "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
if [ -z "$cwd" ]; then
    exit 0
fi

if [ -z "$agent_type" ] || [ "$agent_type" = "null" ]; then
    label="Subagent"
else
    label="$agent_type subagent"
fi

# Build a one-liner summary: prefer the subagent's final message, then result, then description.
summary=""
if [ -n "$last_msg" ] && [ "$last_msg" != "null" ]; then
    # First sentence of the final message, capped at ~200 chars.
    summary=$(printf '%s' "$last_msg" | tr '\n' ' ' | head -c 200)
elif [ -n "$result_text" ] && [ "$result_text" != "null" ]; then
    summary=$(printf '%s' "$result_text" | head -n 1 | head -c 120)
elif [ -n "$description" ] && [ "$description" != "null" ]; then
    summary="$description"
fi

session_cwd="$cwd"
statusline_file="$VMUX_DIR/sessions/${claude_session_id}.json"
if [ -f "$statusline_file" ]; then
    pd=$(jq -r '.workspace.project_dir // empty' "$statusline_file" 2>/dev/null)
    [ -n "$pd" ] && session_cwd="$pd"
fi
relay_session_id=$(printf '%s' "$session_cwd" | shasum -a 256 | awk '{print substr($1, 1, 12)}')

if [ -n "$summary" ]; then
    message="${summary}"
else
    message="${label} complete."
fi
# Pass empty source so the relay doesn't prepend "[Explore] " — the
# SubagentGroup UI already shows the subagent type as its label.
payload=$(jq -n --arg message "$message" \
    --arg agent_id "$agent_id" --arg agent_type "$agent_type" --arg kind "subagent_stop" \
    '{message: $message, source: "", speak: true, agent_id: $agent_id, agent_type: $agent_type, kind: $kind}')

curl -sS -X POST \
    -H "X-Daemon-Secret: $DAEMON_SECRET" \
    -H "Content-Type: application/json" \
    --max-time 3 \
    "$RELAY_URL/api/sessions/$relay_session_id/notify" \
    -d "$payload" >/dev/null 2>&1 &

exit 0
