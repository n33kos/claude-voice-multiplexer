---
name: voice-multiplexer:standby
description: Put this Claude session into voice standby mode for remote voice access
---

# Voice Relay Standby

Put this session into standby mode so it can receive remote voice input through the Claude Voice Multiplexer relay server.

## Pre-flight Check

Before entering standby, verify the relay server is reachable:

1. **Verify MCP tools are reachable**: Call `relay_status` as a connectivity check. If it fails with a tool error (MCP connection hasn't established), wait 5 seconds and retry up to 3 times. If still failing, print: `"MCP connection not established. Run /mcp in the terminal to connect, then try /voice-multiplexer:standby again."` and stop.

2. Check if the relay server is running by calling `relay_status`. If it indicates the relay is not reachable, print: `"Relay server is not running. Start it with: launchctl start com.vmux.daemon"` and stop.

> Note: In v2.0+, services are managed by the vmuxd daemon (auto-starts on login via launchd). You no longer need to run start.sh manually.

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

- **Do NOT output any text to the terminal between voice exchanges.** No "listening", no "standby active", no status messages. The user is on a phone — they cannot see your terminal output.
- **Do NOT announce that you are re-entering standby.** Just silently call `relay_standby` again.
- If `relay_standby` returns a `[Standby]` timeout message, silently call it again — do not output anything.
- If `relay_standby` returns a `[System]` message containing "error" or "disconnect", try `relay_respond` with a brief spoken acknowledgment if possible, then attempt to re-enter standby. Only stop the loop if the error is unrecoverable (e.g., explicit shutdown).
- If `relay_standby` **throws a tool error** (MCP disconnected), follow the **MCP Reconnection During Standby** steps above.
- Keep responses short and spoken-word friendly. Avoid markdown, bullet lists, or code blocks in your `relay_respond` text.
- You can still use all your normal tools while in standby (read files, run commands, etc.) — just relay the results conversationally.
- **Use `relay_file` to send large files directly to the web app without token cost.**
- **NEVER use `AskUserQuestion` or `EnterPlanMode` while in standby.** These tools block the CLI waiting for terminal input, which freezes the voice relay. Instead, ask conversationally via `relay_respond`.

## Activity Updates

Before performing significant operations, call `relay_activity` with a short description:

- Before reading files: `relay_activity("Reading files...")`
- Before running commands: `relay_activity("Running command...")`
- Before complex reasoning: `relay_activity("Thinking about approach...")`
- Before searching code: `relay_activity("Searching codebase...")`
- Before making edits: `relay_activity("Editing code...")`

## Relaying Files Without Token Cost

```python
# Display file in web app (no voice, no tokens)
await relay_file("path/to/file.txt")

# Display file AND read it aloud
await relay_file("path/to/output.json", read_aloud=True)
```

## Behavior While in Standby

- Respond as if you are speaking out loud — be conversational, concise, and natural
- Summarize technical details rather than reading raw output
- Remember the full context of your current session and work
- When asked about your work, describe what you've been doing in plain language
