#!/usr/bin/env bash
#
# Start Claude Voice Multiplexer services
#
# Starts LiveKit, relay server, and (in dev mode) the Vite dev server.
# All child processes are killed on exit (Ctrl+C or SIGTERM).
#
# Prerequisites: Whisper and Kokoro must be running (e.g. via voice-mode CLI).
# The MCP server is started automatically by Claude Code via the plugin system.
#
# Usage:
#   ./scripts/start.sh         # Production: serves built web app from web/dist
#   ./scripts/start.sh --dev   # Development: starts Vite dev server with HMR
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load .env if present
if [ -f "$PROJECT_DIR/.env" ]; then
    set -a
    source "$PROJECT_DIR/.env"
    set +a
fi

# Resolve settings
RELAY_PORT="${RELAY_PORT:-3100}"
LIVEKIT_PORT="${LIVEKIT_PORT:-7880}"
WEB_PORT="${WEB_PORT:-5173}"
WHISPER_CHECK_URL="${WHISPER_URL:-http://127.0.0.1:8100/v1}/models"
KOKORO_CHECK_URL="${KOKORO_URL:-http://127.0.0.1:8101/v1}/models"
LIVEKIT_CHECK_URL="http://127.0.0.1:${LIVEKIT_PORT}"

DEV_MODE="${DEV_MODE:-false}"
if [ "$1" = "--dev" ]; then
    DEV_MODE=true
fi

# Track child PIDs for cleanup
PIDS=()

cleanup() {
    echo ""
    echo "Shutting down..."
    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
        fi
    done
    # Wait briefly for graceful shutdown, then force-kill stragglers
    sleep 1
    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill -9 "$pid" 2>/dev/null || true
        fi
    done
    echo "All services stopped."
}

trap cleanup EXIT INT TERM

echo "Starting Claude Voice Multiplexer..."
echo ""

# --- Check prerequisites ---

if curl -s "$WHISPER_CHECK_URL" > /dev/null 2>&1; then
    echo "  Whisper: running at ${WHISPER_URL:-http://127.0.0.1:8100/v1}"
else
    echo "  Whisper: NOT running (start with 'voice-mode service whisper start')"
fi

if curl -s "$KOKORO_CHECK_URL" > /dev/null 2>&1; then
    echo "  Kokoro: running at ${KOKORO_URL:-http://127.0.0.1:8101/v1}"
else
    echo "  Kokoro: NOT running (start with 'voice-mode service kokoro start')"
fi

# --- Start LiveKit ---

if curl -s "$LIVEKIT_CHECK_URL" > /dev/null 2>&1; then
    echo "  LiveKit: running at $LIVEKIT_CHECK_URL"
else
    echo "  LiveKit: starting on :${LIVEKIT_PORT}..."
    livekit-server --dev --bind 127.0.0.1 > /dev/null 2>&1 &
    PIDS+=($!)
    sleep 2
    echo "  LiveKit: started on :${LIVEKIT_PORT}"
fi

# --- Start relay server ---

echo "  Relay server: starting on :${RELAY_PORT}..."
cd "$PROJECT_DIR/relay-server"
uv run \
    --with "fastapi>=0.110" \
    --with "uvicorn>=0.27" \
    --with "websockets>=12.0" \
    --with "httpx>=0.27" \
    --with "python-dotenv>=1.0" \
    --with "livekit-api>=0.7" \
    --with "livekit>=1.0" \
    --with "numpy>=1.24" \
    --with "scipy>=1.10" \
    --with "webrtcvad>=2.0.10" \
    --with "setuptools" \
    server.py &
PIDS+=($!)

# --- Start web dev server (dev mode only) ---

if [ "$DEV_MODE" = true ]; then
    echo "  Web dev server: starting on :${WEB_PORT}..."
    cd "$PROJECT_DIR/web"
    npx vite --port "$WEB_PORT" &
    PIDS+=($!)
    echo ""
    echo "Open http://localhost:${WEB_PORT} in your browser"
else
    echo ""
    if [ -d "$PROJECT_DIR/web/dist" ]; then
        echo "Open http://localhost:${RELAY_PORT} in your browser (serving built web app)"
    else
        echo "Web app not built. Run 'npm run build' in web/ or use --dev for dev mode."
        echo "API available at http://localhost:${RELAY_PORT}/api/sessions"
    fi
fi

echo ""
echo "Press Ctrl+C to stop all services."
echo ""

# Wait for all children — Ctrl+C triggers cleanup trap which kills them all
wait
