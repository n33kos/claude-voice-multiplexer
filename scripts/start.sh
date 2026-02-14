#!/usr/bin/env bash
#
# claude-voice-multiplexer:start
#
# Start Claude Voice Multiplexer services: Whisper (STT), Kokoro (TTS),
# LiveKit, relay server, and optionally the Vite dev server.
# All child processes are killed on exit.
#
# Prerequisites: Run ./scripts/install.sh first.
# The MCP server is started automatically by Claude Code via the plugin system.
#
# Usage:
#   ./scripts/start.sh         # Production: serves built web app from web/dist
#   ./scripts/start.sh --dev   # Development: starts Vite dev server with HMR
#

# Note: no `set -e` — we handle errors explicitly. The `wait` at the end
# would exit non-zero when any child terminates, killing the script.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$HOME/.claude/voice-multiplexer"
PID_FILE="$DATA_DIR/.vmux.pid"

# Load configuration
if [ -f "$DATA_DIR/voice-multiplexer.env" ]; then
    set -a
    source "$DATA_DIR/voice-multiplexer.env"
    set +a
fi

# --- Check installation ---

if [ ! -d "$DATA_DIR" ]; then
    echo "ERROR: Voice Multiplexer not installed."
    echo "  Run: ./scripts/install.sh"
    exit 1
fi

# Resolve settings from voice-multiplexer.env
WHISPER_PORT="${VMUX_WHISPER_PORT:-8100}"
WHISPER_MODEL="${VMUX_WHISPER_MODEL:-base}"
WHISPER_THREADS="${VMUX_WHISPER_THREADS:-auto}"
KOKORO_PORT="${VMUX_KOKORO_PORT:-8101}"
KOKORO_DEVICE="${VMUX_KOKORO_DEVICE:-auto}"

# Relay server reads WHISPER_URL and KOKORO_URL from env
export WHISPER_URL="${WHISPER_URL:-http://127.0.0.1:${WHISPER_PORT}/v1}"
export KOKORO_URL="${KOKORO_URL:-http://127.0.0.1:${KOKORO_PORT}/v1}"

RELAY_PORT="${RELAY_PORT:-3100}"
LIVEKIT_PORT="${LIVEKIT_PORT:-7880}"
LIVEKIT_API_KEY="${LIVEKIT_API_KEY:-devkey}"
LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET:-secret}"
WEB_PORT="${WEB_PORT:-5173}"

DEV_MODE="${DEV_MODE:-false}"
if [ "$1" = "--dev" ]; then
    DEV_MODE=true
fi

# --- Check for existing instance ---

is_vmux_running() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE" 2>/dev/null)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
        rm -f "$PID_FILE"
    fi
    if pgrep -f "claude-voice-multiplexer:start" | grep -v "$$" > /dev/null 2>&1; then
        return 0
    fi
    return 1
}

if is_vmux_running; then
    echo "Claude Voice Multiplexer is already running."
    if [ -f "$PID_FILE" ]; then
        echo "  PID: $(cat "$PID_FILE")"
    fi
    echo "  Use ./scripts/stop.sh to stop it first."
    exit 1
fi

# Write PID file
echo $$ > "$PID_FILE"

# Track child PIDs for cleanup
PIDS=()

cleanup() {
    echo ""
    echo "Shutting down..."

    # 1. Kill tracked child PIDs
    for pid in "${PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
    done

    # 2. Kill processes on our service ports (catches orphaned subshell children)
    for port in "$WHISPER_PORT" "$KOKORO_PORT" "$LIVEKIT_PORT" "$RELAY_PORT" "$WEB_PORT"; do
        local pids_on_port
        pids_on_port=$(lsof -ti:"$port" 2>/dev/null || true)
        if [ -n "$pids_on_port" ]; then
            echo "$pids_on_port" | xargs kill 2>/dev/null || true
        fi
    done

    sleep 1

    # 3. Force-kill any survivors
    for pid in "${PIDS[@]}"; do
        kill -9 "$pid" 2>/dev/null || true
    done
    for port in "$WHISPER_PORT" "$KOKORO_PORT"; do
        local pids_on_port
        pids_on_port=$(lsof -ti:"$port" 2>/dev/null || true)
        if [ -n "$pids_on_port" ]; then
            echo "$pids_on_port" | xargs kill -9 2>/dev/null || true
        fi
    done

    rm -f "$PID_FILE"
    echo "All services stopped."
}

trap cleanup EXIT INT TERM

# --- Log setup ---

LOG_DIR="$DATA_DIR/logs"
mkdir -p "$LOG_DIR"

# Rotate logs that exceed 5 MB — keep one .old backup
rotate_log() {
    local log_file="$1"
    local max_bytes=$((5 * 1024 * 1024))  # 5 MB
    if [ -f "$log_file" ] && [ "$(stat -f%z "$log_file" 2>/dev/null || stat --format=%s "$log_file" 2>/dev/null || echo 0)" -ge "$max_bytes" ]; then
        mv "$log_file" "${log_file}.old"
    fi
}

rotate_log "$LOG_DIR/whisper.log"
rotate_log "$LOG_DIR/kokoro.log"
rotate_log "$LOG_DIR/start.log"

# Log helper — prints to terminal and appends to start.log
log() {
    echo "$1"
    echo "$1" >> "$LOG_DIR/start.log"
}

log "=== $(date '+%Y-%m-%d %H:%M:%S') ==="
log "Starting Claude Voice Multiplexer..."
log ""

# --- Helper: wait for service ---

wait_for_service() {
    local name="$1"
    local url="$2"
    local timeout="${3:-30}"
    local elapsed=0

    while ! curl -s "$url" > /dev/null 2>&1; do
        sleep 1
        elapsed=$((elapsed + 1))
        if [ "$elapsed" -ge "$timeout" ]; then
            log "  WARNING: $name did not respond within ${timeout}s"
            return 1
        fi
    done
    return 0
}

# --- Start Whisper ---

WHISPER_BINARY="$DATA_DIR/whisper/whisper.cpp/build/bin/whisper-server"
WHISPER_MODEL_PATH="$DATA_DIR/whisper/models/ggml-${WHISPER_MODEL}.bin"

if curl -s "http://127.0.0.1:${WHISPER_PORT}/" > /dev/null 2>&1; then
    log "  Whisper: already running on :${WHISPER_PORT}"
else
    if [ ! -f "$WHISPER_BINARY" ]; then
        log "  ERROR: Whisper binary not found. Run ./scripts/install.sh"
        exit 1
    fi
    if [ ! -f "$WHISPER_MODEL_PATH" ]; then
        log "  ERROR: Whisper model not found: ggml-${WHISPER_MODEL}.bin"
        log "  Run: ./scripts/install.sh --whisper-model ${WHISPER_MODEL}"
        exit 1
    fi

    # Resolve threads
    if [ "$WHISPER_THREADS" = "auto" ]; then
        WHISPER_THREADS=$(sysctl -n hw.logicalcpu 2>/dev/null || nproc 2>/dev/null || echo 4)
    fi

    log "  Whisper: starting on :${WHISPER_PORT} (model: ${WHISPER_MODEL}, threads: ${WHISPER_THREADS})..."
    "$WHISPER_BINARY" \
        --host 127.0.0.1 \
        --port "$WHISPER_PORT" \
        --model "$WHISPER_MODEL_PATH" \
        --inference-path /v1/audio/transcriptions \
        --threads "$WHISPER_THREADS" \
        --convert \
        >> "$LOG_DIR/whisper.log" 2>&1 &
    PIDS+=($!)

    if wait_for_service "Whisper" "http://127.0.0.1:${WHISPER_PORT}/" 15; then
        log "  Whisper: running on :${WHISPER_PORT}"
    fi
fi

# --- Start Kokoro ---

KOKORO_REPO="$DATA_DIR/kokoro/kokoro-fastapi"

if curl -s "http://127.0.0.1:${KOKORO_PORT}/health" > /dev/null 2>&1; then
    log "  Kokoro: already running on :${KOKORO_PORT}"
else
    if [ ! -d "$KOKORO_REPO/.venv" ]; then
        log "  ERROR: Kokoro not installed. Run ./scripts/install.sh"
        exit 1
    fi

    # Auto-detect device if needed
    if [ "$KOKORO_DEVICE" = "auto" ]; then
        if [ "$(uname)" = "Darwin" ]; then
            KOKORO_DEVICE="mps"
        else
            KOKORO_DEVICE="cpu"
        fi
    fi

    log "  Kokoro: starting on :${KOKORO_PORT} (device: ${KOKORO_DEVICE})..."

    # Launch Kokoro with a clean environment via env -i.
    # Kokoro's pydantic Settings rejects unknown env vars, so we isolate it.
    (
        cd "$KOKORO_REPO"
        env -i \
            HOME="$HOME" \
            PATH="$KOKORO_REPO/.venv/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
            USE_GPU=true \
            USE_ONNX=false \
            PYTHONPATH="$KOKORO_REPO:$KOKORO_REPO/api" \
            MODEL_DIR=src/models \
            VOICES_DIR=src/voices/v1_0 \
            DEVICE_TYPE="$KOKORO_DEVICE" \
            PYTORCH_ENABLE_MPS_FALLBACK=1 \
            "$KOKORO_REPO/.venv/bin/uvicorn" api.src.main:app \
                --host 127.0.0.1 \
                --port "$KOKORO_PORT" \
                >> "$LOG_DIR/kokoro.log" 2>&1
    ) &
    PIDS+=($!)

    if wait_for_service "Kokoro" "http://127.0.0.1:${KOKORO_PORT}/health" 60; then
        log "  Kokoro: running on :${KOKORO_PORT}"
    fi
fi

# --- Start LiveKit ---

LIVEKIT_CHECK_URL="http://127.0.0.1:${LIVEKIT_PORT}"

if curl -s "$LIVEKIT_CHECK_URL" > /dev/null 2>&1; then
    log "  LiveKit: already running on :${LIVEKIT_PORT}"
else
    log "  LiveKit: starting on :${LIVEKIT_PORT}..."
    livekit-server --bind 0.0.0.0 --keys "${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}" > /dev/null 2>&1 &
    PIDS+=($!)
    sleep 2
    log "  LiveKit: running on :${LIVEKIT_PORT}"
fi

# --- Start relay server ---

# Create dist folder exists for Vite to serve, even if empty (avoids errors in dev mode before first build)
mkdir -p "$PROJECT_DIR/web/dist" 

log "  Relay server: starting on :${RELAY_PORT}..."
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
    log "  Web dev server: starting on :${WEB_PORT}..."
    
    cd "$PROJECT_DIR/web"
    npm install --silent > /dev/null
    npx vite --port "$WEB_PORT" &

    PIDS+=($!)
    log ""
    log "Open http://localhost:${WEB_PORT} in your browser"
else
    log "  Web app: building for production..."
    
    cd "$PROJECT_DIR/web"
    npm install --silent > /dev/null
    npx vite build > /dev/null

    if [ -d "$PROJECT_DIR/web/dist" ]; then
        log "Open http://localhost:${RELAY_PORT} in your browser (serving built web app)"
    else
        log "Web app not built. Run 'npm run build' in web/ or use --dev for dev mode."
        log "API available at http://localhost:${RELAY_PORT}/api/sessions"
    fi
fi

log ""
log "Press Ctrl+C to stop all services."
log ""

# Wait for all children — Ctrl+C triggers cleanup trap which kills them all
wait || true
