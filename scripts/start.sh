#!/usr/bin/env bash
#
# Start Claude Voice Multiplexer services
#
# Usage: ./scripts/start.sh
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "Starting Claude Voice Multiplexer..."

# Check if Whisper is running
if curl -s http://127.0.0.1:2022/v1/models > /dev/null 2>&1; then
    echo "  Whisper: running on :2022"
else
    echo "  Whisper: NOT running (start with 'voice-mode service whisper start')"
fi

# Check if Kokoro is running
if curl -s http://127.0.0.1:8880/v1/models > /dev/null 2>&1; then
    echo "  Kokoro: running on :8880"
else
    echo "  Kokoro: NOT running (start with 'voice-mode service kokoro start')"
fi

# Check if LiveKit is running
if curl -s http://127.0.0.1:7880 > /dev/null 2>&1; then
    echo "  LiveKit: running on :7880"
else
    echo "  LiveKit: NOT running"
    echo "  Starting LiveKit server..."
    livekit-server --dev --bind 0.0.0.0 > /dev/null 2>&1 &
    echo "  LiveKit: started on :7880"
fi

# Start relay server
echo "  Starting relay server on :3100..."
cd "$PROJECT_DIR/relay-server"
python3 server.py
