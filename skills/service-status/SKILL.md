---
name: voice-multiplexer:service-status
description: Check the status of all Voice Multiplexer services
---

# Voice Multiplexer Service Status

Check the status of the vmuxd daemon, infrastructure services, and active Claude sessions.

## Instructions

1. Run the status script:
   ```
   Run: "${CLAUDE_PLUGIN_ROOT}/scripts/status.sh"
   ```

2. Report the output conversationally to the user.

In v2.0+, this delegates to `vmux status` which shows the daemon status, each infrastructure service (Whisper, Kokoro, LiveKit, relay server), and any active spawned Claude sessions.

If the daemon is not running, suggest: `launchctl start com.vmux.daemon`
