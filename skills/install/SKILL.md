---
name: voice-multiplexer:install
description: Install or reinstall the Claude Voice Multiplexer (downloads dependencies, builds Whisper, sets up launchd daemon)
---

# Install Voice Multiplexer

Run the full installation script to set up all Voice Multiplexer components.

## Instructions

1. Confirm with the user before proceeding — installation downloads several GB of models and builds from source.

2. Check if already installed:
   ```
   Run: command -v vmux && vmux status --json 2>/dev/null
   ```
   If vmuxd is already running, ask the user if they want to reinstall (use `--force` flag) or just upgrade.

3. Run the install script:
   ```
   Run: "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh"
   ```
   For a forced reinstall (re-downloads dependencies):
   ```
   Run: "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh" --force
   ```

4. The script will:
   - Install Homebrew dependencies (ffmpeg, portaudio, etc.)
   - Build whisper.cpp with Metal GPU support
   - Install Kokoro TTS (kokoro-fastapi)
   - Download and configure LiveKit
   - Install relay server Python deps
   - Build the web app
   - Set up the vmuxd daemon under launchd (`com.vmux.daemon`)
   - Generate an initial device pairing code

5. At the end of installation the script will print a **pairing code**. Share it with the user so they can pair their phone/browser.

6. Report the result to the user, including:
   - Whether installation succeeded
   - The pairing code (if printed)
   - Where to open the web app (the relay server URL shown in the output)

## Notes

- Full install takes 5–15 minutes depending on internet speed and CPU
- Requires macOS (Apple Silicon recommended for Metal GPU acceleration)
- Re-running without `--force` is safe — already-installed components are skipped
- After install, services start automatically via launchd on every login
- Logs: `~/.claude/voice-multiplexer/logs/daemon.log`
