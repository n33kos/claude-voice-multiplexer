#!/usr/bin/env bash
#
# claude-voice-multiplexer:status
#
# Check the status of all Claude Voice Multiplexer services.
# Exit code 0 if services are running, 1 if not.
#
# Usage:
#   ./scripts/status.sh           # Human-readable output
#   ./scripts/status.sh --quiet   # Exit code only (for scripting)
#

DATA_DIR="$HOME/.claude/voice-multiplexer"
VMUX_CLI="$DATA_DIR/daemon/vmux"
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

# --- Prefer vmux daemon status ---
if [ -f "$VMUX_CLI" ]; then
    if [ "$QUIET" = true ]; then
        # Quiet: check if relay is responding (daemon manages everything)
        if curl -s --max-time 2 "http://127.0.0.1:${RELAY_PORT}/api/auth/status" > /dev/null 2>&1 \
            && curl -s --max-time 2 "http://127.0.0.1:${WHISPER_PORT}/" > /dev/null 2>&1 \
            && curl -s --max-time 2 "http://127.0.0.1:${KOKORO_PORT}/health" > /dev/null 2>&1; then
            exit 0
        else
            exit 1
        fi
    fi

    # Human-readable via vmux status
    "$VMUX_CLI" status 2>/dev/null && exit 0

    echo "vmuxd is not running."
    echo "  Start with: launchctl start com.vmux.daemon"
    exit 1
fi

# --- Legacy fallback (pre-daemon install) ---
PID_FILE="$DATA_DIR/.vmux.pid"

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
    vmux_pid=$(pgrep -f "scripts/start.sh" 2>/dev/null | grep -v "$$" | head -1 || true)
    if [ -n "$vmux_pid" ]; then
        vmux_running=true
    fi
fi

if [ "$QUIET" = true ]; then
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

if [ "$vmux_running" = true ]; then
    echo "  Multiplexer: running (PID $vmux_pid)"
else
    echo "  Multiplexer: stopped"
fi

curl -s --max-time 2 "http://127.0.0.1:${WHISPER_PORT}/" > /dev/null 2>&1 \
    && echo "  Whisper: running on :${WHISPER_PORT}" \
    || echo "  Whisper: not responding"

curl -s --max-time 2 "http://127.0.0.1:${KOKORO_PORT}/health" > /dev/null 2>&1 \
    && echo "  Kokoro: running on :${KOKORO_PORT}" \
    || echo "  Kokoro: not responding"

curl -s --max-time 2 "http://127.0.0.1:${LIVEKIT_PORT}" > /dev/null 2>&1 \
    && echo "  LiveKit: running on :${LIVEKIT_PORT}" \
    || echo "  LiveKit: not responding"

curl -s --max-time 2 "http://127.0.0.1:${RELAY_PORT}/api/auth/status" > /dev/null 2>&1 \
    && echo "  Relay server: running on :${RELAY_PORT}" \
    || echo "  Relay server: not responding"

[ "$vmux_running" = true ] && exit 0 || exit 1
