---
name: voice-multiplexer:stop-services
description: Stop the Claude Voice Multiplexer relay server and all supporting services
---

# Stop Voice Multiplexer Services

Stop all running Voice Multiplexer services via the vmuxd daemon.

## Instructions

1. Run the stop script (which delegates to `vmux shutdown` in v2.0+):
   ```
   Run: "${CLAUDE_PLUGIN_ROOT}/scripts/stop.sh"
   ```

2. Report the result to the user.

## Notes

- In v2.0+, this calls `vmux shutdown` which stops the daemon and all managed child processes
- The daemon gracefully terminates children (SIGTERM → 5s wait → SIGKILL)
- launchd will restart the daemon automatically because `KeepAlive: true` — to permanently stop, use: `launchctl stop com.vmux.daemon`
- To disable auto-start at login: `launchctl unload ~/Library/LaunchAgents/com.vmux.daemon.plist`
