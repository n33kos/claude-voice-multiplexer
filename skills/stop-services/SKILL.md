---
name: voice-multiplexer:stop-services
description: Stop the Claude Voice Multiplexer relay server and all supporting services
---

# Stop Voice Multiplexer Services

Stop all running Voice Multiplexer services (Whisper, Kokoro, LiveKit, relay server, dev server).

## Instructions

1. Run the stop script:
   ```
   Run: "${CLAUDE_PLUGIN_ROOT}/scripts/stop.sh"
   ```

2. Report the result to the user.

## Notes

- The stop script uses a two-pass strategy: checks PID file first, then falls back to process name search
- Sends SIGTERM first for graceful shutdown, then SIGKILL after 5 seconds if needed
- Also kills processes by port as a final fallback for orphaned subshell children
