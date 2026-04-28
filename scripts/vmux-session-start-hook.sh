#!/usr/bin/env bash
#
# vmux-session-start-hook.sh — Claude Code SessionStart hook for Voice Multiplexer
#
# Fires once when a Claude Code session begins.  Registers the session with
# the relay server so it shows up in the web UI and can receive voice input
# and TTS audio.
#
# Replaces the old `/voice-multiplexer:standby` one-shot invocation.
#
# Input (stdin JSON from Claude Code):
#   {
#     "session_id": "<claude-session-uuid>",
#     "transcript_path": "...",
#     "cwd": "/path/to/cwd",
#     "hook_event_name": "SessionStart",
#     ...
#   }
#
# The relay session_id is sha256(cwd)[:12] — same derivation used everywhere
# else in the codebase.

set -uo pipefail

VMUX_DIR="$HOME/.claude/voice-multiplexer"
SECRET_FILE="$VMUX_DIR/daemon.secret"
RELAY_HOST="${RELAY_HOST:-127.0.0.1}"
RELAY_PORT="${RELAY_PORT:-3100}"
RELAY_URL="http://${RELAY_HOST}:${RELAY_PORT}"

# Bail silently if the relay environment is not present.
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

# Prefer workspace.project_dir from the statusline JSON so this matches
# the cwd the MCP plugin uses for registration.  Falls back to cwd if the
# statusline file does not exist yet (first turn of a fresh session).
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

# Register, capturing the HTTP status code.  200 = vmuxd manages this cwd
# (we're inside a vmux session); 404 = not vmux-managed; anything else =
# transient error.  This is also our gate for whether to inject the voice
# style guidance below — same gate the relay uses for /register.
http_code=$(curl -sS -X POST \
    -H "X-Daemon-Secret: $DAEMON_SECRET" \
    -H "Content-Type: application/json" \
    --max-time 5 \
    -o /dev/null \
    -w "%{http_code}" \
    "$RELAY_URL/api/sessions/$relay_session_id/register" \
    -d "$payload" 2>/dev/null)

# If vmuxd manages this cwd, push voice-mode style guidance into Claude's
# context so replies are optimized for spoken delivery.  Plain Claude Code
# sessions (not spawned by vmux) get nothing — http_code will be 404.
if [ "$http_code" = "200" ]; then
    # NOTE: using `read -r -d ''` instead of `$(cat <<EOF)` because bash's
    # parser tracks single-quote balance across command substitution even
    # for quoted heredocs — apostrophes ("don't", "I'll") inside `$(cat <<'EOF')`
    # cause unexpected-EOF parse errors.  `read -d ''` keeps the heredoc out
    # of `$()` and sidesteps the bug.
    read -r -d '' voice_instructions <<'INSTR_EOF' || true
You are being driven through Voice Multiplexer — replies are spoken aloud after each turn. Optimize for the ear:

- Default to short, conversational prose. One or two sentences when you can.
- Skip preamble ("Great question!", "Sure, I'll do that for you"). Just answer.
- Save bullets, headers, tables for when the user explicitly asks for structure or you're showing code, diffs, or data via relay_code_block.
- For long answers: give a one-line summary, then offer to expand if they want more.
- Don't volunteer big code dumps unless asked — narrate intent, render code only when it earns its space.
- Markdown is fine when it carries meaning; avoid it when it'd just narrate longer.
INSTR_EOF
    jq -nc --arg ctx "$voice_instructions" \
        '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
fi

exit 0
