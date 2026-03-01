# Voice Multiplexer v3.0 — Implementation Plan

## Overview

Three major features targeting a hands-free, fully remote workflow:

1. **CLI Inter-Session Messaging** — Let external processes (orchestrators, other AI sessions) send text messages to any session via the relay
2. **Interactive Terminal** — Transform the read-only terminal snapshot into a bidirectional terminal in the web app
3. **Keystroke Bug Audit** — Fix the Enter/newline issue affecting spawn and ensure clean keystroke delivery for the interactive terminal

---

## Feature 1: CLI Inter-Session Messaging (`vmux send`)

### Goal

Allow any CLI process to send a text message to a session, just like the web UI's text input does. This enables orchestrator patterns where one AI instance manages multiple sessions.

### Current Text Message Flow (Web UI)

```
Web App → WS {type: "text_message", text} → server.py client_ws handler
  → session.voice_queue.put(f"[Voice from {client_id}]: {text}")
  → _notify_client_transcript(session_id, "user", text)
  → agent.handle_text_message() (sets thinking state)
```

The voice_queue message is what relay_standby picks up. The key insight: we need to replicate this exact flow from the CLI.

### Implementation

#### 1a. New Daemon IPC Command: `send-message`

**File: `daemon/session_manager.py`**

No changes needed in session_manager — message delivery goes through the relay server, not tmux.

**File: `daemon/vmuxd.py`** — Add IPC handler:

```python
elif cmd == "send-message":
    session_id = request.get("session_id", "")
    text = request.get("text", "")
    if not session_id:
        return {"ok": False, "error": "session_id is required"}
    if not text:
        return {"ok": False, "error": "text is required"}
    return await self._cmd_send_message(session_id, text)
```

New method `_cmd_send_message`:

```python
async def _cmd_send_message(self, session_id: str, text: str) -> dict:
    """Send a text message to a session via the relay server."""
    from service_manager import _get_health_client
    try:
        client = await _get_health_client()
        resp = await client.post(
            f"{RELAY_URL}/api/sessions/{session_id}/message",
            json={"text": text},
            headers={"X-Daemon-Secret": self._daemon_secret},
            timeout=10.0,
        )
        if resp.status_code == 200:
            return {"ok": True}
        return {"ok": False, "error": f"Relay returned {resp.status_code}: {resp.text}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}
```

#### 1b. New Relay API Endpoint: `POST /api/sessions/{session_id}/message`

**File: `relay-server/server.py`**

```python
@app.post("/api/sessions/{session_id}/message")
async def send_message_to_session(session_id: str, request: Request):
    """Send a text message to a session's voice queue (like the web UI text input)."""
    device = _require_auth(request)
    body = await request.json()
    text = body.get("text", "").strip()
    if not text:
        return JSONResponse({"error": "text is required"}, status_code=400)

    session = await registry.get(session_id)
    if not session:
        return JSONResponse({"error": "Session not found"}, status_code=404)

    if session.is_stale:
        return JSONResponse({"error": "Session is stale (Claude Code disconnected)"}, status_code=410)

    # Identify the caller
    caller = device.get("device_name", "cli")
    msg = f"[Voice from {caller}]: {text}"
    await session.voice_queue.put(msg)

    # Set agent to thinking state
    if _agent:
        asyncio.create_task(_agent.handle_text_message(session_id, text, caller))

    # Broadcast transcript
    await _notify_client_transcript(session_id, "user", text)

    return JSONResponse({"ok": True})
```

#### 1c. CLI Command: `vmux send`

**File: `daemon/vmux`**

```python
def cmd_send(session_id: str, text: str):
    r = _send({"cmd": "send-message", "session_id": session_id, "text": text})
    if _ok(r):
        print(f"Message sent to {session_id}.")
```

Usage:
```bash
vmux send <session-id> "Do something specific"
vmux send <session-id> -  # read from stdin (for piping)
```

Also add stdin support for piping:
```python
elif sub == "send":
    if len(sys.argv) < 4:
        _die("Usage: vmux send <session-id> <text>")
    session_id = sys.argv[2]
    text = sys.argv[3]
    if text == "-":
        text = sys.stdin.read().strip()
    cmd_send(session_id, text)
```

#### 1d. Optional: `vmux send --cwd <path>` shorthand

Since the session_id is a SHA256 hash of the cwd, we can compute it locally:

```python
def cmd_send(target: str, text: str):
    # If target looks like a path, compute session_id from it
    if os.path.sep in target or target.startswith("~"):
        import hashlib
        cwd = os.path.abspath(os.path.expanduser(target))
        target = hashlib.sha256(cwd.encode()).hexdigest()[:12]
    r = _send({"cmd": "send-message", "session_id": target, "text": text})
    if _ok(r):
        print(f"Message sent to {target}.")
```

This enables:
```bash
vmux send /path/to/project "Do something"
# equivalent to computing the session hash and sending
```

### Testing Checklist

- [ ] `vmux send <session-id> "hello"` delivers message to relay_standby
- [ ] Message appears in web app transcript as "user" entry
- [ ] Agent status changes to "thinking" in web app
- [ ] Works when called from another Claude Code session (orchestrator pattern)
- [ ] `vmux send <path> "hello"` computes session_id and works
- [ ] Error handling: nonexistent session, stale session, empty text

---

## Feature 2: Interactive Terminal

### Goal

Transform the current read-only terminal snapshot overlay into a bidirectional terminal where the user can view live output and send keystrokes/commands directly to the Claude Code TUI — eliminating the need to `tmux attach`.

### Current Terminal Architecture

```
Web App → WS {type: "capture_terminal", lines: 50}
  → server.py → daemon IPC {cmd: "capture-terminal"}
  → session_manager.capture_terminal() → tmux capture-pane
  → response back through chain → terminal_snapshot WS message
```

This is poll-based: the TerminalOverlay auto-refreshes every 2 seconds. There's no input capability.

### Approach: Hybrid Push/Keystroke Model

Rather than building a full xterm.js WebSocket-to-PTY bridge (which would require multiplexing the PTY output, dealing with terminal encoding, and piping raw PTY I/O), we'll take an incremental approach:

**Phase A: Keystroke Input (Minimum Viable)**
- Add a command input bar to the terminal overlay
- Send keystrokes to the tmux session via the existing daemon IPC
- Keep the 2-second refresh for output (already works well)

**Phase B: Live Terminal Stream (Full Interactive)**
- Stream tmux pane output changes via WebSocket push
- Use xterm.js for proper terminal rendering with ANSI support
- True bidirectional I/O with sub-second latency

We should implement Phase A first — it's simpler, builds on existing infrastructure, and delivers 80% of the value. Phase B can follow as a refinement.

### Phase A: Keystroke Input

#### 2a-1. New Daemon IPC Command: `send-keys`

**File: `daemon/session_manager.py`**

```python
async def send_keys(self, session_id: str, keys: str) -> bool:
    """Send arbitrary keystrokes to a session's tmux pane.

    The `keys` string is passed directly to `tmux send-keys`.
    Special keys like Enter, C-c, Escape etc are supported natively by tmux.
    For literal text that should NOT be interpreted as special keys, callers
    should use the `-l` (literal) flag.
    """
    async with self._lock:
        session = self._find_session(session_id)
        if not session:
            return False
        tmux_session = session.tmux_session
    try:
        proc = await asyncio.create_subprocess_exec(
            "tmux", "send-keys", "-t", tmux_session, "-l", keys,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()
        return proc.returncode == 0
    except Exception as e:
        logger.error(f"[sessions] send_keys failed: {e}")
        return False

async def send_special_key(self, session_id: str, key: str) -> bool:
    """Send a special key (Enter, C-c, Escape, Tab, etc) to a session."""
    ALLOWED_SPECIAL = {"Enter", "C-c", "Escape", "Tab", "BSpace", "Up", "Down", "Left", "Right", "C-l", "C-d", "C-z"}
    if key not in ALLOWED_SPECIAL:
        return False
    async with self._lock:
        session = self._find_session(session_id)
        if not session:
            return False
        tmux_session = session.tmux_session
    try:
        # Empty string after key name is required for tmux send-keys with special keys
        proc = await asyncio.create_subprocess_exec(
            "tmux", "send-keys", "-t", tmux_session, key, "",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()
        return proc.returncode == 0
    except Exception as e:
        logger.error(f"[sessions] send_special_key failed: {e}")
        return False
```

**File: `daemon/vmuxd.py`** — Add IPC handlers:

```python
elif cmd == "send-keys":
    session_id = request.get("session_id", "")
    keys = request.get("keys", "")
    special = request.get("special_key", "")
    if special:
        ok = await self._session_manager.send_special_key(session_id, special)
    elif keys:
        ok = await self._session_manager.send_keys(session_id, keys)
    else:
        return {"ok": False, "error": "keys or special_key required"}
    return {"ok": ok, "error": None if ok else "Session not found or send failed"}
```

#### 2a-2. Relay Server: Terminal Input Handler

**File: `relay-server/server.py`** — Add to client_ws handler:

```python
elif msg_type == "terminal_input":
    # Send keystrokes to the connected session's tmux pane
    if connected_session_id:
        keys = data.get("keys", "")
        special_key = data.get("special_key", "")
        result = await _daemon_ipc({
            "cmd": "send-keys",
            "session_id": connected_session_id,
            "keys": keys,
            "special_key": special_key,
        })
        # Immediately trigger a terminal capture so UI updates fast
        if result.get("ok"):
            capture = await _daemon_ipc({
                "cmd": "capture-terminal",
                "session_id": connected_session_id,
                "lines": 50,
            })
            if capture.get("ok"):
                await ws.send_text(json.dumps({
                    "type": "terminal_snapshot",
                    "session_id": connected_session_id,
                    "content": capture["output"],
                    "timestamp": time.time(),
                }))
```

#### 2a-3. Web App: Terminal Input UI

**File: `web/src/components/TerminalOverlay/TerminalOverlay.tsx`**

Add a command input bar at the bottom of the terminal overlay:

```tsx
interface TerminalOverlayProps {
  snapshot: TerminalSnapshot | null;
  loading: boolean;
  onRefresh: () => void;
  onClose: () => void;
  onSendKeys?: (keys: string) => void;        // literal text
  onSendSpecialKey?: (key: string) => void;    // Enter, C-c, etc
}
```

The input bar should:
- Have a text input for typing commands
- Enter key sends the text as literal keys + "Enter" special key
- Have quick-action buttons: Ctrl+C, Escape, Tab, Up/Down arrows
- Input stays focused so you can keep typing

**File: `web/src/hooks/useRelay.ts`**

```typescript
const sendTerminalKeys = useCallback((keys: string) => {
  wsRef.current?.send(JSON.stringify({ type: "terminal_input", keys }));
}, []);

const sendTerminalSpecialKey = useCallback((key: string) => {
  wsRef.current?.send(JSON.stringify({ type: "terminal_input", special_key: key }));
}, []);
```

**File: `web/src/App.tsx`** — Pass new props to TerminalOverlay:

```tsx
<TerminalOverlay
  snapshot={relay.terminalSnapshot}
  loading={relay.terminalSnapshotLoading}
  onRefresh={relay.requestTerminalCapture}
  onClose={relay.dismissTerminalSnapshot}
  onSendKeys={relay.sendTerminalKeys}
  onSendSpecialKey={relay.sendTerminalSpecialKey}
/>
```

#### 2a-4. CLI Command: `vmux send-keys`

**File: `daemon/vmux`**

```python
def cmd_send_keys(session_id: str, keys: str):
    r = _send({"cmd": "send-keys", "session_id": session_id, "keys": keys})
    if not _ok(r):
        return

def cmd_send_key(session_id: str, key: str):
    r = _send({"cmd": "send-keys", "session_id": session_id, "special_key": key})
    if not _ok(r):
        return
```

Usage:
```bash
vmux send-keys <session-id> "some text"
vmux send-key <session-id> Enter
vmux send-key <session-id> C-c
```

### Phase B: Live Terminal Stream (Future)

Phase B is documented here for planning but should be implemented after Phase A is validated.

#### Architecture

```
tmux pane → daemon watches for changes → pushes diffs via relay WS → xterm.js renders
```

**Daemon side:** Use `tmux pipe-pane` to stream the PTY output to a Unix pipe. The daemon reads from this pipe and forwards output events to the relay server via a new WebSocket endpoint.

**Relay side:** New WS endpoint `/ws/terminal/{session_id}` that bridges daemon output to web client input and vice versa.

**Web side:** Replace the `<pre>` terminal content with xterm.js. Connect it to the terminal WebSocket for bidirectional I/O.

Key complexity: terminal state management. `tmux pipe-pane` only sends new output, not the current screen state. Options:
1. Send an initial `capture-pane` snapshot, then stream deltas — simpler, some visual glitches possible
2. Use `tmux control mode` (`tmux -CC`) which provides structured output — more complex but cleaner
3. Use a PTY proxy that captures the full terminal state — most complex, best result

Recommendation: Option 1 for Phase B, evaluate options 2-3 for Phase C if needed.

### Testing Checklist

- [ ] Terminal overlay shows input bar when opened
- [ ] Typing text and pressing Enter sends it as literal keys + Enter
- [ ] Ctrl+C button sends C-c to tmux
- [ ] Terminal refreshes immediately after input
- [ ] Quick action buttons work (Escape, Tab, arrows)
- [ ] Multiple sequential inputs work correctly
- [ ] Input doesn't interfere with auto-refresh
- [ ] Works on mobile (touch keyboard + buttons)

---

## Feature 3: Keystroke Bug Audit

### The Problem

When spawning sessions, the `/voice-multiplexer:standby` command followed by Enter is sometimes interpreted as a newline (Shift+Enter) instead of a submit (Enter) in Claude Code's TUI.

### Current Spawn Keystroke Sequence

```python
# session_manager.py lines 155-168
await self._run(["tmux", "send-keys", "-t", tmux_session, claude_cmd, "Enter"])
# ... wait for prompt ...
await self._run(["tmux", "send-keys", "-t", tmux_session, "/voice-multiplexer:standby"])
await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])
```

### Known Working Patterns

`hard_interrupt` and `reconnect_session` use the SAME split pattern and work reliably:

```python
# hard_interrupt (lines 249-255)
await self._run(["tmux", "send-keys", "-t", tmux_session,
                 "/mcp reconnect plugin:voice-multiplexer:voice-multiplexer"])
await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])
await asyncio.sleep(2.0)
await self._run(["tmux", "send-keys", "-t", tmux_session,
                 "/voice-multiplexer:standby"])
await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])
```

### Analysis

The difference between spawn (unreliable) and hard_interrupt/reconnect (reliable):

1. **hard_interrupt/reconnect** target an EXISTING Claude session that's already initialized and in its idle prompt state
2. **spawn** targets a FRESHLY STARTED Claude session that may still be initializing

The prompt-wait fix (v2.2.4) addresses the most common failure mode (sending before Claude is ready). But there may be a secondary timing issue:

**Hypothesis 1**: Claude's TUI may need a small delay between receiving text and receiving Enter. When the text arrives, the TUI processes it character by character. If Enter arrives before all characters are processed, the input might be incomplete or misinterpreted.

**Hypothesis 2**: The `❯` prompt character appears before the TUI is fully ready to accept slashcommand input. The prompt might render before input event handlers are attached.

### Investigation Plan

1. **Add timing instrumentation to spawn**:
   ```python
   logger.info(f"[sessions] prompt detected, sending standby command...")
   await self._run(["tmux", "send-keys", "-t", tmux_session,
                    "/voice-multiplexer:standby"])
   logger.info(f"[sessions] text sent, waiting before Enter...")
   await asyncio.sleep(0.5)  # Small delay between text and Enter
   await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])
   logger.info(f"[sessions] Enter sent")
   ```

2. **Add post-prompt grace period**:
   After detecting `❯`, wait an additional 1-2 seconds before sending anything. The TUI may still be attaching input handlers.
   ```python
   if await self._wait_for_claude_prompt(tmux_session, timeout=30.0):
       await asyncio.sleep(1.5)  # Grace period after prompt appears
   ```

3. **Verify with tmux capture**: After sending the standby command + Enter, capture the pane to see what Claude actually received:
   ```python
   await asyncio.sleep(3.0)
   output = await self._run_output([
       "tmux", "capture-pane", "-t", tmux_session, "-p", "-S", "-5"
   ])
   logger.info(f"[sessions] post-enter pane content: {repr(output)}")
   ```

4. **Test with `-l` flag**: tmux `send-keys -l` sends keys literally (no special key interpretation). Currently the slash command is sent WITHOUT `-l`, which means tmux interprets it as key names. This shouldn't cause issues for regular text, but worth testing:
   ```python
   # Currently: text goes as key names
   await self._run(["tmux", "send-keys", "-t", tmux_session, "/voice-multiplexer:standby"])
   # Alternative: text goes as literal characters
   await self._run(["tmux", "send-keys", "-t", tmux_session, "-l", "/voice-multiplexer:standby"])
   ```

### Recommended Fix

Implement all timing fixes conservatively:

```python
# After prompt detection
if await self._wait_for_claude_prompt(tmux_session, timeout=30.0):
    await asyncio.sleep(1.5)  # Grace period for TUI initialization
else:
    logger.warning(f"[sessions] prompt not detected — sending standby anyway")

# Send text literally (not as key names)
await self._run(["tmux", "send-keys", "-t", tmux_session, "-l", "/voice-multiplexer:standby"])
await asyncio.sleep(0.3)  # Brief pause between text and Enter
await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])

# Post-verification
await asyncio.sleep(3.0)
output = await self._run_output([
    "tmux", "capture-pane", "-t", tmux_session, "-p", "-S", "-5"
])
logger.info(f"[sessions] pane after standby command: {repr(output[-200:])}")
```

Also apply the same `-l` flag to ALL text sends across the codebase:
- `hard_interrupt`: MCP reconnect command and standby command
- `reconnect_session`: same
- `spawn`: claude_cmd and standby command

The `-l` flag is the most important change — it ensures tmux treats the text as literal characters rather than potentially interpreting special character sequences.

### Impact on Interactive Terminal

The keystroke audit directly informs Feature 2. The `send_keys` method for the interactive terminal should:
- Use `-l` for literal text input (commands the user types)
- Use regular `send-keys` (without `-l`) for special keys (Enter, C-c, Tab, etc)
- This is already the design in the Phase A implementation above

### Testing Checklist

- [ ] Spawn with timing fixes succeeds reliably (5+ consecutive spawns)
- [ ] Post-spawn verification log shows `/voice-multiplexer:standby` was received
- [ ] hard_interrupt still works with `-l` flag
- [ ] reconnect still works with `-l` flag
- [ ] No regressions in existing functionality

---

## Implementation Order

### Phase 1: Keystroke Bug Fix (Feature 3)
- Apply `-l` flag, timing fixes, and post-verification logging
- Test spawn reliability
- This unblocks Feature 2

### Phase 2: CLI Messaging (Feature 1)
- Add relay API endpoint
- Add daemon IPC handler
- Add vmux CLI command
- Test orchestrator pattern

### Phase 3: Interactive Terminal (Feature 2, Phase A)
- Add send-keys daemon IPC
- Add terminal_input WS handler
- Add input UI to TerminalOverlay
- Test on mobile

### Phase 4 (Future): Live Terminal Stream (Feature 2, Phase B)
- tmux pipe-pane streaming
- xterm.js integration
- Full bidirectional terminal

---

## Version Bumps

- Phase 1 → v2.3.0 (bug fix + foundation)
- Phase 2 → v2.4.0 (CLI messaging)
- Phase 3 → v3.0.0 (interactive terminal — breaking UX change)
