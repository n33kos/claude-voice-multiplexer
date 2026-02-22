#!/usr/bin/env bash
#
# claude-voice-multiplexer:stop
#
# DEPRECATED: In v2.0+, services are managed by vmuxd.
# This script is kept as a backwards-compatibility wrapper.
#
# For daemon-based installs: use `vmux shutdown`
#

DATA_DIR="$HOME/.claude/voice-multiplexer"
VMUX_CLI="$DATA_DIR/daemon/vmux"

# --- Try vmuxd first ---
if [ -f "$VMUX_CLI" ]; then
    if "$VMUX_CLI" status &>/dev/null 2>&1; then
        echo "Stopping vmuxd daemon..."
        "$VMUX_CLI" shutdown
        exit 0
    fi
    echo "Daemon is not running."
    exit 0
fi

# --- Legacy fallback ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$HOME/.claude/voice-multiplexer/.vmux.pid"

find_vmux_pid() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE" 2>/dev/null)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            echo "$pid"; return 0
        fi
        rm -f "$PID_FILE"
    fi
    local pids
    pids=$(pgrep -f "scripts/start.sh" 2>/dev/null | grep -v "$$" || true)
    if [ -n "$pids" ]; then
        echo "$pids" | head -1; return 0
    fi
    return 1
}

pid=$(find_vmux_pid) || true

if [ -z "$pid" ]; then
    echo "Claude Voice Multiplexer is not running."
    rm -f "$PID_FILE"
    exit 0
fi

echo "Stopping Claude Voice Multiplexer (PID $pid)..."
kill "$pid" 2>/dev/null || true

for i in $(seq 1 10); do
    if ! kill -0 "$pid" 2>/dev/null; then
        echo "Stopped."
        rm -f "$PID_FILE"
        exit 0
    fi
    sleep 0.5
done

echo "Force-killing..."
kill -9 "$pid" 2>/dev/null || true
rm -f "$PID_FILE"

if [ -f "$DATA_DIR/voice-multiplexer.env" ]; then
    set -a; source "$DATA_DIR/voice-multiplexer.env"; set +a
fi
for port in "${VMUX_WHISPER_PORT:-8100}" "${VMUX_KOKORO_PORT:-8101}" "${LIVEKIT_PORT:-7880}" "${RELAY_PORT:-3100}"; do
    port_pids=$(lsof -ti:"$port" 2>/dev/null || true)
    if [ -n "$port_pids" ]; then
        echo "$port_pids" | xargs kill -9 2>/dev/null || true
    fi
done
echo "Stopped."
