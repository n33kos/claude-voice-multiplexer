#!/usr/bin/env bash
#
# claude-voice-multiplexer:install
#
# Install Whisper (STT) and Kokoro (TTS) services for the voice multiplexer.
# Everything is installed to ~/.claude/voice-multiplexer/.
#
# Usage:
#   ./scripts/install.sh                    # Install with defaults (base model)
#   ./scripts/install.sh --whisper-model small  # Install with a larger model
#   ./scripts/install.sh --force            # Reinstall even if already installed
#
# Prerequisites:
#   - macOS with Homebrew
#   - Xcode Command Line Tools
#   - Python 3.10+ with uv
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$HOME/.claude/voice-multiplexer"

WHISPER_MODEL="base"
FORCE=false

# Parse arguments
while [ $# -gt 0 ]; do
    case "$1" in
        --whisper-model)
            WHISPER_MODEL="$2"
            shift 2
            ;;
        --force)
            FORCE=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--whisper-model MODEL] [--force]"
            exit 1
            ;;
    esac
done

# --- Helpers ---

log() { echo "  $1"; }
log_section() { echo ""; echo "--- $1 ---"; echo ""; }
check_cmd() {
    if ! command -v "$1" &> /dev/null; then
        return 1
    fi
    return 0
}

# --- Preflight checks ---

log_section "Checking prerequisites"

# Xcode CLI tools
if ! xcode-select -p &> /dev/null; then
    echo "ERROR: Xcode Command Line Tools not installed."
    echo "  Run: xcode-select --install"
    exit 1
fi
log "Xcode CLI tools: OK"

# Homebrew
if ! check_cmd brew; then
    echo "ERROR: Homebrew not found."
    echo "  Install from https://brew.sh"
    exit 1
fi
log "Homebrew: OK"

# cmake
if ! check_cmd cmake; then
    log "cmake: not found, installing via Homebrew..."
    brew install cmake
fi
log "cmake: OK ($(cmake --version | head -1))"

# Python
if ! check_cmd python3; then
    echo "ERROR: Python 3 not found."
    exit 1
fi
log "Python: OK ($(python3 --version))"

# uv
if ! check_cmd uv; then
    echo "ERROR: uv not found."
    echo "  Install with: curl -LsSf https://astral.sh/uv/install.sh | sh"
    exit 1
fi
log "uv: OK ($(uv --version))"

# git
if ! check_cmd git; then
    echo "ERROR: git not found."
    exit 1
fi
log "git: OK"

# Node.js and npm
if ! check_cmd node; then
    log "Node.js: not found, installing via Homebrew..."
    brew install node
fi
log "Node.js: OK ($(node --version))"

if ! check_cmd npm; then
    echo "ERROR: npm not found despite Node.js installation."
    exit 1
fi
log "npm: OK ($(npm --version))"

# LiveKit server
if ! check_cmd livekit-server; then
    log "livekit-server: not found, installing via Homebrew..."
    brew install livekit
fi
log "livekit-server: OK"

# --- Create data directory ---

mkdir -p "$DATA_DIR/logs"

# --- Install Whisper ---

log_section "Installing Whisper (whisper.cpp)"

WHISPER_DIR="$DATA_DIR/whisper"
WHISPER_REPO="$WHISPER_DIR/whisper.cpp"
WHISPER_BINARY="$WHISPER_REPO/build/bin/whisper-server"
WHISPER_MODELS="$WHISPER_DIR/models"

if [ -f "$WHISPER_BINARY" ] && [ "$FORCE" = false ]; then
    log "Whisper already installed at $WHISPER_BINARY"
    log "  Use --force to reinstall"
else
    mkdir -p "$WHISPER_DIR"

    # Clone or update repo
    if [ -d "$WHISPER_REPO" ]; then
        log "Updating whisper.cpp..."
        cd "$WHISPER_REPO"
        git fetch --tags
        LATEST_TAG=$(git tag --sort=-v:refname | head -1)
        git checkout "$LATEST_TAG"
    else
        log "Cloning whisper.cpp..."
        LATEST_TAG=$(git ls-remote --tags --sort=-v:refname https://github.com/ggerganov/whisper.cpp.git | head -1 | sed 's/.*refs\/tags\///')
        git clone --depth 1 --branch "$LATEST_TAG" https://github.com/ggerganov/whisper.cpp.git "$WHISPER_REPO"
    fi

    # Build
    log "Building whisper.cpp with Metal acceleration..."
    cd "$WHISPER_REPO"
    rm -rf build
    cmake -B build \
        -DGGML_METAL=ON \
        -DWHISPER_COREML=ON \
        -DWHISPER_COREML_ALLOW_FALLBACK=ON \
        -DCMAKE_BUILD_TYPE=Release
    cmake --build build -j "$(sysctl -n hw.logicalcpu)" --config Release

    if [ ! -f "$WHISPER_BINARY" ]; then
        echo "ERROR: whisper-server binary not found after build."
        echo "  Expected at: $WHISPER_BINARY"
        exit 1
    fi
    log "Build complete: $WHISPER_BINARY"
fi

# Download model
mkdir -p "$WHISPER_MODELS"
MODEL_FILE="$WHISPER_MODELS/ggml-${WHISPER_MODEL}.bin"

if [ -f "$MODEL_FILE" ] && [ "$FORCE" = false ]; then
    log "Model already downloaded: ggml-${WHISPER_MODEL}.bin"
else
    MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL}.bin"
    log "Downloading ggml-${WHISPER_MODEL}.bin from Hugging Face..."
    curl -L --progress-bar -o "$MODEL_FILE" "$MODEL_URL"

    if [ ! -s "$MODEL_FILE" ]; then
        echo "ERROR: Model download failed or file is empty."
        rm -f "$MODEL_FILE"
        exit 1
    fi
    MODEL_SIZE=$(du -h "$MODEL_FILE" | cut -f1)
    log "Model downloaded: ggml-${WHISPER_MODEL}.bin ($MODEL_SIZE)"
fi

log "Whisper installation complete."

# --- Install Kokoro ---

log_section "Installing Kokoro (kokoro-fastapi)"

KOKORO_DIR="$DATA_DIR/kokoro"
KOKORO_REPO="$KOKORO_DIR/kokoro-fastapi"

if [ -d "$KOKORO_REPO/.venv" ] && [ "$FORCE" = false ]; then
    log "Kokoro already installed at $KOKORO_REPO"
    log "  Use --force to reinstall"
else
    mkdir -p "$KOKORO_DIR"

    # Clone or update repo
    if [ -d "$KOKORO_REPO" ]; then
        log "Updating kokoro-fastapi..."
        cd "$KOKORO_REPO"
        git fetch --tags
        LATEST_TAG=$(git tag --sort=-v:refname | head -1)
        git checkout "$LATEST_TAG"
    else
        log "Cloning kokoro-fastapi..."
        LATEST_TAG=$(git ls-remote --tags --sort=-v:refname https://github.com/remsky/kokoro-fastapi.git | head -1 | sed 's/.*refs\/tags\///')
        git clone --depth 1 --branch "$LATEST_TAG" https://github.com/remsky/kokoro-fastapi.git "$KOKORO_REPO"
    fi

    # Set up Python environment
    cd "$KOKORO_REPO"
    log "Creating Python virtual environment..."
    uv venv

    log "Installing dependencies (this may take a few minutes)..."
    uv pip install -e .

    # Download model
    log "Downloading Kokoro TTS model..."
    uv run --no-sync python docker/scripts/download_model.py --output api/src/models/v1_0

    log "Kokoro installation complete."
fi

# --- Install MCP server dependencies ---

log_section "Installing MCP server dependencies"

MCP_VENV="$DATA_DIR/mcp-venv"

if [ -d "$MCP_VENV" ] && [ "$FORCE" = false ]; then
    log "MCP venv already exists at $MCP_VENV"
    log "  Use --force to reinstall"
else
    log "Creating MCP virtual environment..."
    uv venv "$MCP_VENV"
    log "Installing fastmcp and websockets..."
    uv pip install --python "$MCP_VENV/bin/python" "fastmcp>=2.0" "websockets>=12.0" "python-dotenv>=1.0"
    log "MCP server dependencies installed."
fi

# --- Build web app ---

log_section "Building web app"

WEB_DIR="$PROJECT_DIR/web"
WEB_DIST="$WEB_DIR/dist"

if [ -d "$WEB_DIST" ] && [ "$FORCE" = false ]; then
    log "Web app already built at $WEB_DIST"
    log "  Use --force to rebuild"
else
    if [ ! -d "$WEB_DIR" ]; then
        echo "ERROR: Web directory not found at $WEB_DIR"
        exit 1
    fi

    cd "$WEB_DIR"

    if [ ! -f "package.json" ]; then
        echo "ERROR: package.json not found in $WEB_DIR"
        exit 1
    fi

    log "Installing npm dependencies..."
    npm install

    log "Building web app..."
    npm run build

    if [ ! -d "$WEB_DIST" ]; then
        echo "ERROR: Web app build failed — dist directory not created."
        exit 1
    fi

    WEB_SIZE=$(du -sh "$WEB_DIST" | cut -f1)
    log "Web app built successfully: $WEB_DIST ($WEB_SIZE)"
fi

# --- Generate config ---

log_section "Generating configuration"

CONFIG_FILE="$DATA_DIR/voice-multiplexer.env"

# Auto-detect GPU device by platform
if [ "$(uname)" = "Darwin" ]; then
    DETECTED_DEVICE="mps"
else
    DETECTED_DEVICE="auto"
fi

if [ ! -f "$CONFIG_FILE" ] || [ "$FORCE" = true ]; then
    cat > "$CONFIG_FILE" << EOF
# Claude Voice Multiplexer Configuration
# Generated by install.sh on $(date +%Y-%m-%d)
#
# Uncomment and modify settings as needed.
# This is the single source of truth for all service configuration.

# --- Whisper STT ---
VMUX_WHISPER_PORT=8100
VMUX_WHISPER_MODEL=${WHISPER_MODEL}
VMUX_WHISPER_THREADS=auto

# --- Kokoro TTS ---
VMUX_KOKORO_PORT=8101
VMUX_KOKORO_DEVICE=${DETECTED_DEVICE}

# --- Server ---
# RELAY_HOST=0.0.0.0
# RELAY_PORT=3100
# WEB_PORT=5173

# --- Dev mode (starts Vite web dev server with HMR) ---
# DEV_MODE=false

# --- STT / TTS Service URLs ---
# These are derived from VMUX_WHISPER_PORT and VMUX_KOKORO_PORT by default.
# Override only if running your own Whisper/Kokoro instances elsewhere.
# WHISPER_URL=http://127.0.0.1:8100/v1
# KOKORO_URL=http://127.0.0.1:8101/v1

# --- LiveKit ---
# Rooms are created automatically per session (vmux_{session_name}).
# LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")
LIVEKIT_API_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")

# --- Session Registry ---
# SESSION_TIMEOUT=60

# --- Audio / TTS ---
# KOKORO_VOICE=af_heart
# KOKORO_MODEL=tts-1
# STT_SAMPLE_RATE=16000
# TTS_SAMPLE_RATE=24000

# --- VAD (Voice Activity Detection) ---
# Lower aggressiveness = less sensitive (fewer false positives from background noise)
# Range: 0 (most permissive) to 3 (most aggressive/sensitive)
VAD_AGGRESSIVENESS=2

# How long silence must last (ms) before an utterance is considered finished
SILENCE_THRESHOLD_MS=2500

# Minimum speech duration (seconds) before silence can end an utterance
MIN_SPEECH_DURATION_S=0.5

# Seconds to ignore mic input after TTS finishes (echo suppression)
# ECHO_COOLDOWN_S=0.8

# Energy threshold for fallback VAD (higher = less sensitive to quiet sounds)
# ENERGY_THRESHOLD=500

# Max recording duration in seconds
# MAX_RECORDING_S=180

# --- Authentication ---
# Secret key for JWT token signing (auto-generated during install).
# If empty, authentication is disabled and all clients can connect freely.
AUTH_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")

# How long device authorization tokens last (in days)
# AUTH_TOKEN_TTL_DAYS=90
EOF
    log "Config written to $CONFIG_FILE"
else
    log "Config already exists at $CONFIG_FILE (not overwriting)"
    # Ensure AUTH_SECRET exists in existing config (added in later version)
    if ! grep -q "^AUTH_SECRET=" "$CONFIG_FILE" 2>/dev/null; then
        log "Adding AUTH_SECRET to existing config..."
        AUTH_SECRET_VAL=$(python3 -c "import secrets; print(secrets.token_hex(32))")
        echo "" >> "$CONFIG_FILE"
        echo "# --- Authentication ---" >> "$CONFIG_FILE"
        echo "AUTH_SECRET=${AUTH_SECRET_VAL}" >> "$CONFIG_FILE"
        log "AUTH_SECRET added."
    fi
fi

# --- Summary ---

log_section "Installation complete"

WHISPER_SIZE=$(du -sh "$WHISPER_DIR" 2>/dev/null | cut -f1)
KOKORO_SIZE=$(du -sh "$KOKORO_DIR" 2>/dev/null | cut -f1)
WEB_SIZE=$(du -sh "$WEB_DIST" 2>/dev/null | cut -f1)
TOTAL_SIZE=$(du -sh "$DATA_DIR" 2>/dev/null | cut -f1)

log "Data directory: $DATA_DIR"
log "  Whisper: $WHISPER_SIZE (model: ggml-${WHISPER_MODEL}.bin)"
log "  Kokoro:  $KOKORO_SIZE"
log "  Total:   $TOTAL_SIZE"
log ""
log "Web app: $WEB_SIZE (built in $WEB_DIR/dist)"
echo ""
log "Next steps:"
log "  1. Start services: ./scripts/start.sh"
log "  2. Enter standby:  /voice-multiplexer:relay-standby"
echo ""
