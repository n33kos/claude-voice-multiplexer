#!/usr/bin/env bash
#
# claude-voice-multiplexer:status
#
# Check the status of all Claude Voice Multiplexer services.
# Exit code 0 if the multiplexer is running, 1 if not.
#
# Usage:
#   ./scripts/status.sh           # Human-readable output
#   ./scripts/status.sh --quiet   # Exit code only (for scripting)
#

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$HOME/.claude/voice-multiplexer/.vmux.pid"
PROCESS_NAME="claude-voice-multiplexer:start"
DATA_DIR="$HOME/.claude/voice-multiplexer"
QUIET=false

if [ "$1" = "--quiet" ] || [ "$1" = "-q" ]; then
    QUIET=true
fi

# Load config for port info
if [ -f "$DATA_DIR/voice-multiplexer.env" ]; then
    set -a
    source "$DATA_DIR/voice-multiplexer.env"
    set +a
fi

WHISPER_PORT="${VMUX_WHISPER_PORT:-8100}"
KOKORO_PORT="${VMUX_KOKORO_PORT:-8101}"
RELAY_PORT="${RELAY_PORT:-3100}"
LIVEKIT_PORT="${LIVEKIT_PORT:-7880}"

# Check if the main start script is running
vmux_running=false
vmux_pid=""

if [ -f "$PID_FILE" ]; then
    vmux_pid=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$vmux_pid" ] && kill -0 "$vmux_pid" 2>/dev/null; then
        vmux_running=true
    else
        vmux_pid=""
    fi
fi

if [ "$vmux_running" = false ]; then
    vmux_pid=$(pgrep -f "$PROCESS_NAME" 2>/dev/null | grep -v "$$" | head -1 || true)
    if [ -n "$vmux_pid" ]; then
        vmux_running=true
    fi
fi

if [ "$QUIET" = true ]; then
    # Check that the multiplexer AND critical services are actually responding
    if [ "$vmux_running" = true ] \
        && curl -s --max-time 2 "http://127.0.0.1:${WHISPER_PORT}/" > /dev/null 2>&1 \
        && curl -s --max-time 2 "http://127.0.0.1:${KOKORO_PORT}/health" > /dev/null 2>&1 \
        && curl -s --max-time 2 "http://127.0.0.1:${RELAY_PORT}/api/auth/status" > /dev/null 2>&1; then
        exit 0
    else
        exit 1
    fi
fi

echo "Claude Voice Multiplexer Status"
echo ""

# Installation
if [ -d "$DATA_DIR" ]; then
    TOTAL_SIZE=$(du -sh "$DATA_DIR" 2>/dev/null | cut -f1)
    WHISPER_MODEL="${VMUX_WHISPER_MODEL:-base}"
    echo "  Installed: yes ($DATA_DIR, $TOTAL_SIZE)"
    if [ -f "$DATA_DIR/whisper/models/ggml-${WHISPER_MODEL}.bin" ]; then
        MODEL_SIZE=$(du -h "$DATA_DIR/whisper/models/ggml-${WHISPER_MODEL}.bin" 2>/dev/null | cut -f1)
        echo "  Whisper model: ${WHISPER_MODEL} ($MODEL_SIZE)"
    fi
else
    echo "  Installed: no"
    echo "  Run ./scripts/install.sh to install"
fi

echo ""

# Services
if [ "$vmux_running" = true ]; then
    echo "  Multiplexer: running (PID $vmux_pid)"
else
    echo "  Multiplexer: stopped"
fi

if curl -s "http://127.0.0.1:${WHISPER_PORT}/" > /dev/null 2>&1; then
    echo "  Whisper: running on :${WHISPER_PORT}"
else
    echo "  Whisper: not responding"
fi

if curl -s "http://127.0.0.1:${KOKORO_PORT}/health" > /dev/null 2>&1; then
    echo "  Kokoro: running on :${KOKORO_PORT}"
else
    echo "  Kokoro: not responding"
fi

if curl -s "http://127.0.0.1:${LIVEKIT_PORT}" > /dev/null 2>&1; then
    echo "  LiveKit: running on :${LIVEKIT_PORT}"
else
    echo "  LiveKit: not responding"
fi

if curl -s "http://127.0.0.1:${RELAY_PORT}/api/sessions" > /dev/null 2>&1; then
    echo "  Relay server: running on :${RELAY_PORT}"
else
    echo "  Relay server: not responding"
fi

[ "$vmux_running" = true ] && exit 0 || exit 1
