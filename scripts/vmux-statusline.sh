#!/usr/bin/env bash
#
# vmux-statusline.sh — Claude Code status line hook for Voice Multiplexer
#
# Claude Code pipes session JSON via stdin after each assistant message.
# We extract key fields and write them to a per-session file so the vmux
# daemon can read accurate context/model info without scraping JSONL logs.
#

SESSIONS_DIR="$HOME/.claude/voice-multiplexer/sessions"
mkdir -p "$SESSIONS_DIR" 2>/dev/null

input=$(cat)
session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
if [ -z "$session_id" ]; then
    exit 0
fi

echo "$input" | jq -c '. + {updated_at: (now | todate)}' > "$SESSIONS_DIR/${session_id}.json" 2>/dev/null
