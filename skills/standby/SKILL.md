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
5. **Verify MCP tools are reachable**: Call `relay_status` as a connectivity check. If it fails with a tool error (not a content error), the MCP connection hasn't been established yet. Wait 5 seconds and retry up to 3 times. If still failing after retries, print: `"MCP connection not established. Run /mcp in the terminal to connect, then try /voice-multiplexer:standby again."` and stop.

## Show Connection URL and Pairing Code

After services are confirmed running, print the web app URL and a fresh pairing code so the user can connect immediately.

1. Get the local network IP by running: `ipconfig getifaddr en0 2>/dev/null || echo localhost`
2. Call the `generate_auth_code` MCP tool to get a one-time pairing code
3. Print everything together in a single block like:

```
Voice Multiplexer ready — open on your phone:
  http://<local-ip>:3100    ← phone/tablet (same network)
  http://localhost:3100     ← this machine

Pairing code: <CODE>  (expires in 60s)
```

Use `RELAY_PORT` (default 3100) for both URLs. If `DEV_MODE=true`, show the Vite dev server port instead for the local URL.
If the auth code tool returns an error (e.g. auth not enabled), skip the pairing code line silently — just show the URLs.

## Instructions

When invoked, use the `relay_standby` MCP tool to register this session with the relay server. The server automatically detects your working directory via MCP roots — no parameters needed.

Then enter a continuous conversation loop:

1. Call `relay_standby` — it blocks until a voice message arrives
2. Read the transcribed voice message
3. Formulate a response — be conversational, concise, and natural (as if speaking out loud)
4. Call `relay_respond` with your response text
5. Immediately call `relay_standby` again to listen for the next message
6. Repeat steps 2-5 until the user says goodbye or asks you to disconnect

**Note:** No session identifiers or working directory paths need to be passed to any tool. The server auto-detects your session from the MCP connection.

### Background Agent Tasks

When you need to do long-running work while staying in standby (e.g. searching a large codebase, running tests, spawning a research agent), use this pattern:

1. Tell the user what you're starting via `relay_respond`
2. Launch the background task with `Task(run_in_background=True, ...)`
3. **In your Task prompt, instruct the agent to call `relay_notify` when finished**, e.g.:
   > "When your work is complete, call the `relay_notify` MCP tool with a concise summary of what you found. Pass `source='<task-name>'` so the notification is labeled."
4. Immediately call `relay_standby` — it will block until either a voice message OR the background agent's `relay_notify` call arrives
5. When `relay_standby` returns a message starting with `[Background agent`:
   - It's a completion notification from the background task
   - Call `relay_respond` with a spoken summary of the results
   - Then re-enter `relay_standby` as normal
6. If a voice message arrives before the background task finishes, handle it conversationally — the background agent will still notify when done

Background agents can also call `relay_activity(activity="...", source="task-name")` during their work to show progress in the UI.

### MCP Reconnection During Standby

If `relay_standby` fails with a **tool error** (the MCP connection dropped, not a content-level `[System]` message), follow this recovery loop:

1. Wait 5 seconds
2. Try calling `relay_status` to test if the MCP connection is back
3. If `relay_status` succeeds, immediately call `relay_standby` again — the connection recovered
4. If `relay_status` also fails, wait another 10 seconds and try again (repeat up to 5 times total)
5. If the MCP connection does not recover after ~60 seconds of retries, print to terminal: `"MCP connection lost. Run /mcp in the terminal to reconnect."` and stop the loop

This handles the case where the relay server restarts and the MCP SSE connection drops temporarily.

## Critical Rules

- **Do NOT output any text to the terminal between voice exchanges.** No "listening", no "standby active", no status messages. The user is on a phone — they cannot see your terminal output. Every unnecessary message wastes time.
- **Do NOT announce that you are re-entering standby.** Just silently call `relay_standby` again.
- If `relay_standby` returns a `[Standby]` timeout message, silently call it again — do not output anything.
- If `relay_standby` returns a `[System]` message containing "error" or "disconnect", try `relay_respond` with a brief spoken acknowledgment if possible, then attempt to re-enter standby. Only stop the loop if the error is unrecoverable (e.g., explicit shutdown).
- If `relay_standby` **throws a tool error** (MCP disconnected), follow the **MCP Reconnection During Standby** steps above — do NOT stop the loop immediately.
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
