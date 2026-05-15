#!/usr/bin/env bash
#
# vmux-post-tool-use-hook.sh — Claude Code PostToolUse hook
#
# Watches Bash tool output for GitHub PR URLs (typically from `gh pr create`)
# and POSTs each detected PR to the relay so the web UI can render a compact
# session-scoped PR list.  Detect-only: no CI polling, no GitHub API calls.

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
tool_name=$(echo "$input" | jq -r '.tool_name // empty' 2>/dev/null)
if [ "$tool_name" != "Bash" ]; then
    exit 0
fi

claude_session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
cwd=$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null)
command_str=$(echo "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
stdout=$(echo "$input" | jq -r '.tool_response.stdout // .tool_response.output // empty' 2>/dev/null)
stderr=$(echo "$input" | jq -r '.tool_response.stderr // empty' 2>/dev/null)

if [ -z "$cwd" ]; then
    exit 0
fi

# Collect candidate text from stdout, stderr, and the command itself (the
# command may include `--title "..."` we want to extract).
combined="$stdout"$'\n'"$stderr"

# Match GitHub PR URLs.  Use grep -E for portability.
pr_urls=$(printf '%s\n' "$combined" | grep -oE 'https://github\.com/[^/[:space:]]+/[^/[:space:]]+/pull/[0-9]+' | sort -u)

if [ -z "$pr_urls" ]; then
    exit 0
fi

# Try to pull a --title "..." or --title '...' value from the command for the
# first detected PR.  Best-effort, not validated.
title_from_command=""
if [ -n "$command_str" ]; then
    title_from_command=$(printf '%s' "$command_str" | grep -oE -- '--title[[:space:]]+("[^"]+"|'"'"'[^'"'"']+'"'"')' | head -n1 | sed -E 's/^--title[[:space:]]+["'"'"']?//; s/["'"'"']$//')
fi

# Map cwd → relay session_id (prefer workspace.project_dir from statusline).
session_cwd="$cwd"
statusline_file="$VMUX_DIR/sessions/${claude_session_id}.json"
if [ -f "$statusline_file" ]; then
    pd=$(jq -r '.workspace.project_dir // empty' "$statusline_file" 2>/dev/null)
    [ -n "$pd" ] && session_cwd="$pd"
fi
relay_session_id=$(printf '%s' "$session_cwd" | shasum -a 256 | awk '{print substr($1, 1, 12)}')

while IFS= read -r url; do
    [ -z "$url" ] && continue
    pr_number=$(printf '%s' "$url" | grep -oE '[0-9]+$')
    [ -z "$pr_number" ] && continue

    payload=$(jq -n \
        --arg url "$url" \
        --arg pr_number "$pr_number" \
        --arg title "$title_from_command" \
        '{url: $url, pr_number: ($pr_number | tonumber), title: $title}')

    curl -sS -X POST \
        -H "X-Daemon-Secret: $DAEMON_SECRET" \
        -H "Content-Type: application/json" \
        --max-time 3 \
        "$RELAY_URL/api/sessions/$relay_session_id/pr-detected" \
        -d "$payload" >/dev/null 2>&1 &
done <<< "$pr_urls"

exit 0
