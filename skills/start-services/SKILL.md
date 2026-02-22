---
name: voice-multiplexer:start-services
description: Start the Claude Voice Multiplexer relay server and all supporting services
---

# Start Voice Multiplexer Services

Start the vmuxd daemon and all supporting services (Whisper, Kokoro, LiveKit, relay server).

## Instructions

In v2.0+, services are managed by the vmuxd daemon which auto-starts on login via launchd.

1. Check if services are already running:
   ```
   Run: "${CLAUDE_PLUGIN_ROOT}/scripts/status.sh" --quiet
   ```
   If exit code is 0, tell the user services are already running and stop.

2. If not running, start the daemon:
   ```
   Run: launchctl start com.vmux.daemon
   ```

3. Wait up to 90 seconds (Kokoro model loading takes ~60s), checking status every 10s:
   ```
   Run: "${CLAUDE_PLUGIN_ROOT}/scripts/status.sh"
   ```

4. Report the result to the user.

## Notes

- If `vmux` is not installed, prompt the user to run `./scripts/install.sh` first
- Services are supervised by launchd and auto-restart on crash
- Use `/voice-multiplexer:stop-services` to stop everything (calls `vmux shutdown`)
- Logs: `~/.claude/voice-multiplexer/logs/daemon.log`
