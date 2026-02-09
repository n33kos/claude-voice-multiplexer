#!/usr/bin/env bash
#
# claude-voice-multiplexer:uninstall
#
# Remove all installed Whisper and Kokoro data.
#
# Usage:
#   ./scripts/uninstall.sh               # Remove everything
#   ./scripts/uninstall.sh --keep-models  # Keep downloaded models
#

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$HOME/.claude/voice-multiplexer"

KEEP_MODELS=false
if [ "$1" = "--keep-models" ]; then
    KEEP_MODELS=true
fi

if [ ! -d "$DATA_DIR" ]; then
    echo "Nothing to uninstall. $DATA_DIR does not exist."
    exit 0
fi

# Stop services if running
if [ -f "$PROJECT_DIR/scripts/stop.sh" ]; then
    "$PROJECT_DIR/scripts/stop.sh" 2>/dev/null || true
fi

# Show what we're removing
TOTAL_SIZE=$(du -sh "$DATA_DIR" 2>/dev/null | cut -f1)
echo "Uninstalling Voice Multiplexer services..."
echo "  Data directory: $DATA_DIR ($TOTAL_SIZE)"

if [ "$KEEP_MODELS" = true ]; then
    echo "  Keeping models (--keep-models)"
    echo ""

    # Remove everything except models
    rm -rf "$DATA_DIR/whisper/whisper.cpp"
    rm -rf "$DATA_DIR/kokoro"
    rm -rf "$DATA_DIR/logs"
    rm -f "$DATA_DIR/voice-multiplexer.env"

    REMAINING_SIZE=$(du -sh "$DATA_DIR" 2>/dev/null | cut -f1)
    echo "Uninstalled. Models retained ($REMAINING_SIZE)."
    echo "  Next install will reuse existing models."
else
    rm -rf "$DATA_DIR"
    echo ""
    echo "Uninstalled. Freed $TOTAL_SIZE."
fi
