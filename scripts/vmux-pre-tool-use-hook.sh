#!/usr/bin/env bash
#
# vmux-pre-tool-use-hook.sh — Claude Code PreToolUse hook
#
# Fires before each tool use in an assistant turn.  At this point any
# intermediate text Claude wrote ("I'll look at that now", etc.) has
# already been flushed to the transcript JSONL but Stop hasn't fired yet.
# We TTS those intermediate chunks so the user can hear Claude's inline
# narration, not just the final summary.
#
# Uses a per-session watermark file to avoid re-TTSing text we've already
# spoken.  Watermark = ISO timestamp of the last assistant text message
# that was shipped to TTS.
#
# Unlike the Stop hook, this does NOT signal turn-complete — the mic
# should stay disabled until the full turn ends.

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
transcript_path=$(echo "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
claude_session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
cwd=$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null)
if [ -z "$transcript_path" ] || [ -z "$cwd" ] || [ ! -f "$transcript_path" ]; then
    exit 0
fi

# Prefer workspace.project_dir from statusline JSON (matches MCP registration cwd).
session_cwd="$cwd"
statusline_file="$VMUX_DIR/sessions/${claude_session_id}.json"
if [ -f "$statusline_file" ]; then
    pd=$(jq -r '.workspace.project_dir // empty' "$statusline_file" 2>/dev/null)
    if [ -n "$pd" ]; then
        session_cwd="$pd"
    fi
fi

relay_session_id=$(printf '%s' "$session_cwd" | shasum -a 256 | awk '{print substr($1, 1, 12)}')

# Watermark: the ISO timestamp of the last assistant text we TTS'd for
# this session.  Stored per Claude-session-id so multiple concurrent
# sessions do not interfere with each other.
watermark_dir="$VMUX_DIR/tts-watermarks"
mkdir -p "$watermark_dir" 2>/dev/null
watermark_file="$watermark_dir/${claude_session_id}.ts"
if [ -f "$watermark_file" ]; then
    watermark=$(cat "$watermark_file" 2>/dev/null)
else
    watermark=""
fi

# Extract ALL assistant text chunks newer than the watermark, joined by
# blank lines.  jq's slurp mode loads the full JSONL as an array so we
# can filter and sort by timestamp without line-parsing headaches.
result=$(jq -rs --arg watermark "$watermark" '
    [.[]
     | select(.message.role == "assistant")
     | select((.timestamp // "") > $watermark)]
    | sort_by(.timestamp // "")
    | {
        text: (map(.message.content | map(select(.type == "text") | .text) | join("\n"))
               | map(select(length > 0))
               | join("\n\n")),
        latest_ts: (map(.timestamp // "") | max // "")
      }
    | "\(.latest_ts)\n\(.text)"
' "$transcript_path" 2>/dev/null)

# First line is the latest timestamp, remainder is the concatenated text.
new_watermark=$(echo "$result" | head -n 1)
new_text=$(echo "$result" | tail -n +2)

if [ -z "$new_text" ]; then
    # No fresh text to speak — Claude is going straight to a tool call.
    exit 0
fi

# Ship TTS for the accumulated intermediate text.
payload=$(jq -n --arg text "$new_text" '{text: $text, interruptible: true}')
curl -sS -X POST \
    -H "X-Daemon-Secret: $DAEMON_SECRET" \
    -H "Content-Type: application/json" \
    --max-time 5 \
    "$RELAY_URL/api/sessions/$relay_session_id/tts" \
    -d "$payload" >/dev/null 2>&1

# Advance the watermark so the Stop hook (and subsequent PreToolUse hooks)
# don't re-speak this text.
if [ -n "$new_watermark" ]; then
    echo "$new_watermark" > "$watermark_file"
fi

exit 0
