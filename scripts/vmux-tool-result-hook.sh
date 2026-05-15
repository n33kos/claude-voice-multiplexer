#!/usr/bin/env bash
#
# vmux-tool-result-hook.sh — Claude Code PostToolUse hook (all tools)
#
# Captures the tool result and POSTs a compact, formatted payload to the
# relay so the web UI can render an expandable result body next to the
# activity badge for that tool call. Silent: no TTS.

set -uo pipefail

VMUX_DIR="$HOME/.claude/voice-multiplexer"
SECRET_FILE="$VMUX_DIR/daemon.secret"
RELAY_HOST="${RELAY_HOST:-127.0.0.1}"
RELAY_PORT="${RELAY_PORT:-3100}"
RELAY_URL="http://${RELAY_HOST}:${RELAY_PORT}"

# Truncation budget — keep payloads small.
MAX_CHARS=8000
MAX_LINES=200

if [ ! -f "$SECRET_FILE" ]; then
    exit 0
fi
DAEMON_SECRET=$(tr -d '[:space:]' < "$SECRET_FILE")

input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name // .tool // empty' 2>/dev/null)
tool_use_id=$(echo "$input" | jq -r '.tool_use_id // empty' 2>/dev/null)
claude_session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
cwd=$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null)

if [ -z "$cwd" ] || [ -z "$tool_name" ] || [ -z "$tool_use_id" ]; then
    exit 0
fi

# Skip AskUserQuestion — that flow renders its own bubble.
if [ "$tool_name" = "AskUserQuestion" ]; then
    exit 0
fi

# Flatten tool_response into displayable text. Tool response shape varies:
#   Bash:        {stdout, stderr, interrupted, ...}
#   Read:        {file, ...} or string
#   Edit/Write:  {filePath, oldString, newString, ...} or string
#   Grep/Glob:   string (filenames) or object
#   default:     pretty-print the object
result_text=$(echo "$input" | jq -r --arg t "$tool_name" '
    .tool_response as $r
    | if ($r | type) == "string" then $r
      elif ($r | type) == "null" then ""
      elif $t == "Bash" then
          (($r.stdout // "") +
           (if ($r.stderr // "") != "" then "\n--- stderr ---\n" + $r.stderr else "" end) +
           (if ($r.interrupted // false) then "\n[interrupted]" else "" end))
      elif $t == "Read" then
          ($r.file.content // $r.content // ($r | tojson))
      elif $t == "Edit" or $t == "Write" then
          ($r.message // $r.filePath // ($r | tojson))
      elif $t == "Grep" or $t == "Glob" then
          ($r.content // $r.matches // ($r | tojson))
      else
          ($r | tojson)
      end
' 2>/dev/null)

if [ -z "$result_text" ]; then
    exit 0
fi

# Truncate by line count first, then char count.
lines_total=$(printf '%s\n' "$result_text" | wc -l | tr -d ' ')
truncated="false"
if [ "$lines_total" -gt "$MAX_LINES" ]; then
    result_text=$(printf '%s\n' "$result_text" | head -n "$MAX_LINES")
    truncated="true"
fi
char_len=${#result_text}
if [ "$char_len" -gt "$MAX_CHARS" ]; then
    result_text=$(printf '%s' "${result_text:0:$MAX_CHARS}")
    truncated="true"
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
    --arg tool_use_id "$tool_use_id" \
    --arg tool_name "$tool_name" \
    --arg result_text "$result_text" \
    --argjson lines_total "$lines_total" \
    --argjson truncated "$truncated" \
    '{tool_use_id: $tool_use_id, tool_name: $tool_name, result_text: $result_text, lines_total: $lines_total, truncated: $truncated}')

curl -sS -X POST \
    -H "X-Daemon-Secret: $DAEMON_SECRET" \
    -H "Content-Type: application/json" \
    --max-time 3 \
    "$RELAY_URL/api/sessions/$relay_session_id/tool-result" \
    -d "$payload" >/dev/null 2>&1 &

exit 0
