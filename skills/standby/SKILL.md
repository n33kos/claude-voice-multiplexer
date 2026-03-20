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

### Tiered Task Execution

**While in standby, you MUST stay responsive to voice input.** Use the right execution tier for each task:

**Tier 1 — Inline (do synchronously, <15 seconds):**
- Simple conversational answers (no tool calls needed)
- Reading a single short file for immediate context
- Quick one-line commands where the result is needed for the response
- Single focused edits to one file
- Quick git operations (status, add, commit)

**Tier 2 — Foreground Agent (user waits, 15-60 seconds):**
- Focused code edits across 2-3 files
- Targeted codebase searches with analysis
- Running a single test or build command
- Any task where accuracy matters more than speed

Tell the user "Working on that now, give me a moment" via `relay_respond`, then launch a **foreground** agent (default, NOT `run_in_background`). The parent blocks but gets the full result, enabling informed verification before responding.

**Tier 3 — Background Agent (parallel work, >60 seconds):**
- Multi-file refactors or large implementations
- Research tasks requiring multiple web searches
- Running long builds or test suites
- Tasks the user explicitly asks to be backgrounded

Use this tier sparingly. Background agents have known reliability issues with result retrieval.

### Background Agent Pattern

When running background work (Tier 3 only), follow this pattern:

1. Tell the user what you're starting via `relay_respond`
2. Launch the background task with `Agent(run_in_background=True, ...)`
3. **In your Agent prompt, include these MCP tool instructions:**
   > "As you work, call the `relay_activity` MCP tool with short status updates. Pass `source='<task-name>'` so the status is labeled. Example: `relay_activity(activity='Found 3 matching files, analyzing...', source='code-search')`"
   >
   > "When you are FINISHED with your task, call `relay_notify` with a DETAILED summary of what you did — include files changed, key decisions, and any concerns. This wakes up the parent session. Example: `relay_notify(message='Completed: edited auth.py lines 50-80 to add token validation, also updated tests in test_auth.py. Note: the existing mock may need updating for the new param.')`"
4. Immediately call `relay_standby` to keep listening for voice input
5. **When `relay_standby` returns a `[Notify]` message from a background agent, VERIFY before confirming:**
   - Run `git diff` to see actual changes (if code was modified)
   - Read key files that were changed
   - Only THEN respond to the user with an informed summary
   - Be honest about confidence: say "the agent reports X, and I've verified Y" rather than just "done!"
6. If a voice message arrives before the background task finishes, handle it conversationally — the agent will notify you when it completes

**Important:** Background agents must NOT use `relay_respond` — only the parent session speaks to the user. Agents use `relay_activity` for progress updates and `relay_notify` once at completion to wake up the parent.

**NEVER say "it's done" based solely on a relay_notify message without verifying.** The relay_notify is a signal to start verification, not a confirmation to relay.

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
