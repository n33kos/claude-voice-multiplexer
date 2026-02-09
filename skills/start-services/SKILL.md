---
name: voice-multiplexer:start-services
description: Start the Claude Voice Multiplexer relay server and all supporting services
---

# Start Voice Multiplexer Services

Start Whisper (STT), Kokoro (TTS), LiveKit, the relay server, and all supporting services needed for voice multiplexing.

## Instructions

1. Check if `~/.claude/voice-multiplexer/` exists. If not, run `"${CLAUDE_PLUGIN_ROOT}/scripts/install.sh"` first. This is a one-time setup.

2. Check if the services are already running:
   ```
   Run: "${CLAUDE_PLUGIN_ROOT}/scripts/status.sh" --quiet
   ```
   If exit code is 0, tell the user "Voice Multiplexer services are already running." and stop.

3. If not running, start the services in the background:
   ```
   Run: nohup "${CLAUDE_PLUGIN_ROOT}/scripts/start.sh" > /tmp/vmux-start.log 2>&1 &
   ```

4. Wait up to 90 seconds (Kokoro model loading takes ~60s), then check status:
   ```
   Run: "${CLAUDE_PLUGIN_ROOT}/scripts/status.sh"
   ```

5. Report the result to the user. If the relay server is responding, services are ready.

## Notes

- The start script handles duplicate-instance protection via PID file
- Whisper and Kokoro are started automatically from the installed data directory
- LiveKit is auto-started if not already running
- Use `/voice-multiplexer:stop-services` to stop everything
