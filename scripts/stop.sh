#!/usr/bin/env bash
#
# claude-voice-multiplexer:stop
#
# Stop Claude Voice Multiplexer services.
#
# Detection strategy:
#   1. Check the PID file (.vmux.pid) for the start script's process
#   2. If PID file is missing or stale, search for the process by name
#   3. Send SIGTERM for graceful shutdown, then SIGKILL if needed
#
# Usage:
#   ./scripts/stop.sh
#

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$PROJECT_DIR/.vmux.pid"
PROCESS_NAME="claude-voice-multiplexer:start"

find_vmux_pid() {
    # Strategy 1: PID file
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE" 2>/dev/null)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            echo "$pid"
            return 0
        fi
        # Stale PID file — clean it up
        rm -f "$PID_FILE"
    fi

    # Strategy 2: Search by process name
    local pids
    pids=$(pgrep -f "$PROCESS_NAME" 2>/dev/null | grep -v "$$" || true)
    if [ -n "$pids" ]; then
        # Return the oldest (parent) process
        echo "$pids" | head -1
        return 0
    fi

    return 1
}

pid=$(find_vmux_pid) || true

if [ -z "$pid" ]; then
    echo "Claude Voice Multiplexer is not running."
    # Clean up stale PID file if it exists
    rm -f "$PID_FILE"
    exit 0
fi

echo "Stopping Claude Voice Multiplexer (PID $pid)..."

# Send SIGTERM — the start script's trap handler will clean up child processes
kill "$pid" 2>/dev/null || true

# Wait up to 5 seconds for graceful shutdown
for i in $(seq 1 10); do
    if ! kill -0 "$pid" 2>/dev/null; then
        echo "Stopped."
        rm -f "$PID_FILE"
        exit 0
    fi
    sleep 0.5
done

# Force kill if still running
echo "Graceful shutdown timed out, force-killing..."
kill -9 "$pid" 2>/dev/null || true
rm -f "$PID_FILE"

# Also clean up any orphaned child processes
for orphan_pid in $(pgrep -f "$PROCESS_NAME" 2>/dev/null || true); do
    if [ "$orphan_pid" != "$$" ]; then
        kill -9 "$orphan_pid" 2>/dev/null || true
    fi
done

# Kill any processes still listening on our service ports
DATA_DIR="$HOME/.claude/voice-multiplexer"
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
