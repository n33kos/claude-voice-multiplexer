---
name: voice-multiplexer:standby
description: Put this Claude session into voice standby mode for remote voice access
---

# Voice Relay Standby

Put this session into standby mode so it can receive remote voice input through the Claude Voice Multiplexer relay server.

## Pre-flight Check

Before entering standby, verify services are installed and running:

1. Check if `~/.claude/voice-multiplexer/` exists. If not, run `"${CLAUDE_PLUGIN_ROOT}/scripts/install.sh"` and wait for it to complete. This is a one-time setup that compiles Whisper and installs Kokoro (~2-5 minutes).
2. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/status.sh" --quiet`
3. If exit code is non-zero (services not running), run `nohup "${CLAUDE_PLUGIN_ROOT}/scripts/start.sh" > /tmp/vmux-start.log 2>&1 &` and wait up to 90 seconds for Kokoro to finish loading.
4. If the relay server still isn't responding after starting, inform the user and stop.

## Show Connection URL and Pairing Code

After services are confirmed running, print the web app URL and a fresh pairing code so the user can connect immediately.

1. Get the local network IP by running: `ipconfig getifaddr en0 2>/dev/null || echo localhost`
2. Call the `generate_auth_code` MCP tool to get a one-time pairing code
3. Print everything together in a single block like:

```
Voice Multiplexer ready — open on your phone:
  http://<local-ip>:3100
  (or http://localhost:3100 from this machine)

Pairing code: <CODE>  (expires in 60s)
```

Use the `RELAY_PORT` from the config (default 3100). If `DEV_MODE=true`, show `:5173` for the Vite dev server instead.
If the auth code tool returns an error (e.g. auth not enabled), skip the pairing code line silently — just show the URL.

## Instructions

When invoked, use the `relay_standby` MCP tool to register this session with the relay server. Then enter a continuous conversation loop:

1. Call `relay_standby` — it blocks until a voice message arrives
2. Read the transcribed voice message
3. Formulate a response — be conversational, concise, and natural (as if speaking out loud)
4. Call `relay_respond` with your response text
5. Immediately call `relay_standby` again to listen for the next message
6. Repeat steps 2-5 until the user says goodbye or asks you to disconnect

## Critical Rules

- **Do NOT output any text to the terminal between voice exchanges.** No "listening", no "standby active", no status messages. The user is on a phone — they cannot see your terminal output. Every unnecessary message wastes time.
- **Do NOT announce that you are re-entering standby.** Just silently call `relay_standby` again.
- If `relay_standby` returns a `[Standby]` timeout message, silently call it again — do not output anything.
- If `relay_standby` returns a `[System]` error or disconnect message, inform the user and stop the loop.
- Keep responses short and spoken-word friendly. Avoid markdown, bullet lists, or code blocks in your `relay_respond` text.
- You can still use all your normal tools while in standby (read files, run commands, etc.) — just relay the results conversationally.
- **Use `relay_file` to send large files directly to the web app without token cost.** This bypasses Claude entirely — the file goes straight to the relay server. Good for logs, reports, generated output, or anything large you want to show without burning tokens. Call with `read_aloud=True` to have it read aloud as well.
- **NEVER use `AskUserQuestion` or `EnterPlanMode` while in standby.** These tools block the CLI waiting for terminal input, which freezes the voice relay — the user won't hear a response and messages will pile up. Instead:
  - If you need to clarify something, ask the question conversationally via `relay_respond` and wait for the answer on the next `relay_standby` call.
  - If a task would normally warrant planning, describe your approach via `relay_respond` and ask for verbal confirmation before proceeding.
  - Bypass permission prompts where possible (e.g., proceed with safe defaults rather than asking for confirmation).

## Activity Updates

Before performing significant operations, call `relay_activity` with a
short description so the remote user can see what you're doing:

- Before reading files: `relay_activity("Reading files...")`
- Before running commands: `relay_activity("Running command...")`
- Before complex reasoning: `relay_activity("Thinking about approach...")`
- Before searching code: `relay_activity("Searching codebase...")`
- Before making edits: `relay_activity("Editing code...")`

This updates the web client UI in real time so the user knows what's happening.

## Relaying Files Without Token Cost

While in standby, you can relay files directly to the web app without passing through Claude:

```python
# Display file in web app (no voice, no tokens)
await relay_file("path/to/file.txt")

# Display file AND read it aloud
await relay_file("path/to/output.json", read_aloud=True)
```

Use this for:

- Large files (logs, reports, generated output)
- Code you want to show visually (with syntax highlighting)
- Any content where displaying > discussing
- Reading documents aloud while keeping them visible

The file bypasses Claude entirely — zero token cost for relay-only, TTS cost only if `read_aloud=True`.

## Behavior While in Standby

- Respond as if you are speaking out loud — be conversational, concise, and natural
- Summarize technical details rather than reading raw output
- Remember the full context of your current session and work
- When asked about your work, describe what you've been doing in plain language
- Use `relay_file()` for large files you don't want to burn tokens on
