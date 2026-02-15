#!/usr/bin/env python3
"""Claude Voice Multiplexer - MCP Server

Provides relay tools for Claude Code sessions to register with
the voice multiplexer relay server for remote voice interaction.
"""

import asyncio
import hashlib
import json
import os
import time
from pathlib import Path

# Load configuration from voice-multiplexer.env
_env_path = Path.home() / ".claude" / "voice-multiplexer" / "voice-multiplexer.env"
try:
    from dotenv import load_dotenv
    load_dotenv(_env_path)
except ImportError:
    pass

try:
    from fastmcp import FastMCP
except ImportError:
    print("fastmcp not installed. Install with: pip install fastmcp")
    raise

try:
    import websockets
except ImportError:
    print("websockets not installed. Install with: pip install websockets")
    raise

mcp = FastMCP("voice-multiplexer")

RELAY_URL = os.environ.get("RELAY_URL", "ws://localhost:3100")

def _make_session_id() -> str:
    """Generate a deterministic session ID from the working directory path.

    Same directory always produces the same ID, so reconnecting in the same
    folder seamlessly takes over the existing session.
    """
    cwd = os.path.realpath(os.getcwd())
    return hashlib.sha256(cwd.encode()).hexdigest()[:12]

SESSION_ID = _make_session_id()
HEARTBEAT_INTERVAL = 30  # seconds
STANDBY_LISTEN_TIMEOUT = 86400  # seconds (24 hr) — how long each relay_standby call waits
RECONNECT_MAX_DELAY = 60  # seconds — max backoff between reconnect attempts
RECONNECT_BASE_DELAY = 2  # seconds — initial backoff

# Derive HTTP URL from WebSocket URL for health checks
_RELAY_HTTP_URL = RELAY_URL.replace("ws://", "http://").replace("wss://", "https://")

# Global state for the active relay connection
_relay_state = {
    "connected": False,
    "ws": None,
    "session_name": None,
    "heartbeat_task": None,
    "listener_task": None,
    "message_queue": None,
}


async def _check_relay_health() -> str | None:
    """Check if the relay server is reachable. Returns error message or None if healthy."""
    try:
        import urllib.request
        req = urllib.request.Request(f"{_RELAY_HTTP_URL}/api/auth/status", method="GET")
        urllib.request.urlopen(req, timeout=3)
        return None
    except Exception:
        return (
            f"Relay server is not reachable at {RELAY_URL}\n"
            f"Start it with: ./scripts/start.sh\n"
            f"Or check RELAY_URL in your .env file."
        )


def _get_dir_name() -> str:
    """Get a unique directory name, accounting for git worktrees.

    For worktrees, appends the branch name to distinguish them from
    the main repo and from each other (e.g. "babylist-web/feature-branch").
    """
    import subprocess

    cwd = os.getcwd()
    dir_name = Path(cwd).name

    try:
        # Check if we're in a git worktree (not the main worktree)
        toplevel = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, cwd=cwd, timeout=3,
        ).stdout.strip()
        common_dir = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            capture_output=True, text=True, cwd=cwd, timeout=3,
        ).stdout.strip()

        if toplevel and common_dir:
            # Resolve both to absolute paths for comparison
            toplevel_path = Path(toplevel).resolve()
            # git-common-dir is relative to cwd; resolve from toplevel
            common_path = (Path(toplevel) / common_dir).resolve()

            # If common_dir points outside the toplevel, we're in a linked worktree
            is_worktree = not str(common_path).startswith(str(toplevel_path))

            if is_worktree:
                # Get the branch name for uniqueness
                branch = subprocess.run(
                    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                    capture_output=True, text=True, cwd=cwd, timeout=3,
                ).stdout.strip()
                if branch and branch != "HEAD":
                    # Use the repo name from the main worktree + branch
                    repo_name = common_path.parent.name
                    return f"{repo_name}/{branch}"
                # Fallback: use the worktree directory name if branch detection fails
                return f"{dir_name} (worktree)"
    except Exception:
        pass

    return dir_name


def _get_session_metadata() -> dict:
    """Gather metadata about the current Claude Code session.

    Name priority: explicit relay_standby arg > CLAUDE_SESSION_NAME env > dir name.
    """
    cwd = os.getcwd()
    dir_name = _get_dir_name()
    claude_name = os.environ.get("CLAUDE_SESSION_NAME", "").strip()
    return {
        "session_id": SESSION_ID,
        "name": _relay_state.get("session_name") or claude_name or dir_name,
        "cwd": cwd,
        "dir_name": dir_name,
        "timestamp": time.time(),
    }


async def _connect_to_relay(session_name: str = "") -> str | None:
    """Connect (or reconnect) to the relay server with exponential backoff.

    Returns an error string if all attempts fail, or None on success.
    """
    metadata = _get_session_metadata()
    if session_name:
        metadata["name"] = session_name
    _relay_state["session_name"] = metadata["name"]

    ws_url = f"{RELAY_URL}/ws/session"
    max_attempts = 10
    delay = RECONNECT_BASE_DELAY

    for attempt in range(1, max_attempts + 1):
        # Check health first (fast fail if server is completely down)
        health_err = await _check_relay_health()
        if health_err:
            if attempt == max_attempts:
                return health_err
            await asyncio.sleep(delay)
            delay = min(delay * 2, RECONNECT_MAX_DELAY)
            continue

        try:
            ws = await websockets.connect(ws_url)
        except Exception as e:
            if attempt == max_attempts:
                return f"Failed to connect after {max_attempts} attempts: {e}"
            await asyncio.sleep(delay)
            delay = min(delay * 2, RECONNECT_MAX_DELAY)
            continue

        _relay_state["ws"] = ws
        _relay_state["connected"] = True

        # Register
        await ws.send(json.dumps({"type": "register", **metadata}))

        try:
            ack = await asyncio.wait_for(ws.recv(), timeout=5.0)
            ack_data = json.loads(ack)
            if ack_data.get("type") != "registered":
                await ws.close()
                _relay_state["connected"] = False
                if attempt == max_attempts:
                    return f"Registration failed: {ack_data}"
                await asyncio.sleep(delay)
                delay = min(delay * 2, RECONNECT_MAX_DELAY)
                continue
        except asyncio.TimeoutError:
            await ws.close()
            _relay_state["connected"] = False
            if attempt == max_attempts:
                return "Registration timed out after all attempts."
            await asyncio.sleep(delay)
            delay = min(delay * 2, RECONNECT_MAX_DELAY)
            continue

        # Success — start background tasks
        _relay_state["message_queue"] = asyncio.Queue()
        _relay_state["heartbeat_task"] = asyncio.create_task(_start_heartbeat(ws))
        _relay_state["listener_task"] = asyncio.create_task(_start_listener(ws))
        return None  # success

    return "Failed to connect to relay server."


async def _start_listener(ws):
    """Background task that reads WebSocket messages into the queue.

    On connection loss, automatically attempts to reconnect with backoff
    instead of terminating. Only gives up after repeated failures.
    """
    queue = _relay_state["message_queue"]
    while _relay_state["connected"]:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=HEARTBEAT_INTERVAL * 3)
            data = json.loads(raw)

            if data.get("type") == "voice_message":
                text = data.get("text", "")
                caller = data.get("caller", "remote user")
                if text:
                    await queue.put(f"[Voice from {caller}]: {text}")
            elif data.get("type") == "ping":
                await ws.send(json.dumps({"type": "pong"}))
            elif data.get("type") == "disconnect":
                await queue.put("[System]: Relay server requested disconnect.")
                await _cleanup()
                return
        except asyncio.TimeoutError:
            continue
        except (websockets.ConnectionClosed, Exception):
            # Connection lost — attempt auto-reconnect
            new_ws = await _attempt_reconnect()
            if new_ws:
                ws = new_ws  # swap to new connection and keep listening
            else:
                await queue.put("[System]: Connection to relay server lost. Reconnect failed.")
                await _cleanup()
                return


async def _attempt_reconnect() -> object | None:
    """Try to re-establish the WebSocket connection with backoff.

    Returns the new WebSocket on success, or None after all attempts fail.
    Preserves the existing message queue so no messages are lost.
    """
    # Cancel the old heartbeat (it's using the dead ws)
    old_hb = _relay_state.get("heartbeat_task")
    if old_hb:
        old_hb.cancel()
        _relay_state["heartbeat_task"] = None

    if _relay_state["ws"]:
        try:
            await _relay_state["ws"].close()
        except Exception:
            pass
        _relay_state["ws"] = None

    ws_url = f"{RELAY_URL}/ws/session"
    delay = RECONNECT_BASE_DELAY
    max_attempts = 10

    for attempt in range(1, max_attempts + 1):
        await asyncio.sleep(delay)

        health_err = await _check_relay_health()
        if health_err:
            delay = min(delay * 2, RECONNECT_MAX_DELAY)
            continue

        try:
            ws = await websockets.connect(ws_url)
        except Exception:
            delay = min(delay * 2, RECONNECT_MAX_DELAY)
            continue

        # Re-register with same session metadata
        metadata = _get_session_metadata()
        await ws.send(json.dumps({"type": "register", **metadata}))

        try:
            ack = await asyncio.wait_for(ws.recv(), timeout=5.0)
            ack_data = json.loads(ack)
            if ack_data.get("type") != "registered":
                await ws.close()
                delay = min(delay * 2, RECONNECT_MAX_DELAY)
                continue
        except (asyncio.TimeoutError, Exception):
            try:
                await ws.close()
            except Exception:
                pass
            delay = min(delay * 2, RECONNECT_MAX_DELAY)
            continue

        # Success — update state and restart heartbeat
        _relay_state["ws"] = ws
        _relay_state["connected"] = True
        _relay_state["heartbeat_task"] = asyncio.create_task(_start_heartbeat(ws))
        return ws

    return None


async def _start_heartbeat(ws):
    """Background task that sends periodic heartbeats."""
    while _relay_state["connected"]:
        try:
            await ws.send(json.dumps({
                "type": "heartbeat",
                "session_id": SESSION_ID,
                "timestamp": time.time(),
            }))
            await asyncio.sleep(HEARTBEAT_INTERVAL)
        except Exception:
            break


@mcp.tool()
async def relay_standby(session_name: str = "") -> str:
    """Register this Claude session with the voice relay server and enter standby mode.

    The session becomes available for remote voice interaction through the
    web client. Voice input is transcribed and delivered as text messages.
    Respond conversationally to each message.

    Args:
        session_name: Optional friendly name for this session (defaults to directory name)
    """
    # If connected, signal readiness and wait for next message
    if _relay_state["connected"] and _relay_state["message_queue"]:
        # Tell the relay server Claude is listening again
        try:
            await _relay_state["ws"].send(json.dumps({
                "type": "listening",
                "session_id": SESSION_ID,
            }))
        except Exception:
            # Send failed — connection may be dead, but the listener
            # task will handle reconnection. Fall through to wait on queue.
            pass

        try:
            msg = await asyncio.wait_for(
                _relay_state["message_queue"].get(),
                timeout=STANDBY_LISTEN_TIMEOUT,
            )
            # If we got a system reconnect-failure message, try a fresh connect
            if msg.startswith("[System]:") and "Reconnect failed" in msg:
                err = await _connect_to_relay(session_name or _relay_state.get("session_name", ""))
                if err:
                    return err
                return "[Standby]: Reconnected after connection loss. Still listening."
            return msg
        except asyncio.TimeoutError:
            return "[Standby]: No voice input received. Still listening."
        except Exception as e:
            return f"[Standby error]: {e}"

    # Not connected — attempt to connect (or reconnect) with backoff
    err = await _connect_to_relay(session_name)
    if err:
        return err

    # Wait for first voice message
    try:
        msg = await asyncio.wait_for(
            _relay_state["message_queue"].get(),
            timeout=STANDBY_LISTEN_TIMEOUT,
        )
        return msg
    except asyncio.TimeoutError:
        name = _relay_state.get("session_name", "unnamed")
        return f"[Standby]: Registered as '{name}'. No voice input yet. Still listening."


@mcp.tool()
async def relay_activity(activity: str) -> str:
    """Update the voice relay with Claude's current activity.

    Call this before significant operations so the remote user
    can see what you're working on (e.g. "Reading files...",
    "Running tests...", "Searching codebase...").

    Args:
        activity: Short description of current activity
    """
    if not _relay_state["connected"] or not _relay_state["ws"]:
        return "Not connected to relay. Use relay_standby first."

    try:
        await _relay_state["ws"].send(json.dumps({
            "type": "status_update",
            "session_id": SESSION_ID,
            "activity": activity,
        }))
        return "Status updated."
    except Exception as e:
        return f"Failed to update status: {e}"


@mcp.tool()
async def relay_respond(text: str) -> str:
    """Send a response back to the relay server for TTS synthesis.

    After receiving a voice message via relay_standby, use this tool to send
    your conversational response back. The relay server will synthesize it
    as speech and play it to the remote user.

    Args:
        text: Your conversational response to be spoken aloud
    """
    if not _relay_state["connected"] or not _relay_state["ws"]:
        return "Not connected to relay. Use relay_standby first."

    try:
        await _relay_state["ws"].send(json.dumps({
            "type": "response",
            "session_id": SESSION_ID,
            "text": text,
            "timestamp": time.time(),
        }))
        return "Response sent."
    except Exception as e:
        return f"Failed to send response: {e}"


@mcp.tool()
async def relay_code_block(code: str, filename: str = "", language: str = "") -> str:
    """Push a code snippet or diff into the voice relay transcript.

    Use this to show the remote user code changes, file contents, or diffs
    in the transcript with syntax highlighting. Call it after editing files
    or when the user asks to see code.

    IMPORTANT: When in voice relay mode, the user is viewing a chat-style
    transcript on their phone/browser. Use this tool whenever the user asks
    you to show, display, or output structured content — including:
    - Code snippets or file contents
    - Diffs or patches
    - Tables (use markdown table syntax, language="markdown")
    - Structured data (JSON, YAML, etc.)
    - Command output or logs
    - Any content that benefits from monospace formatting

    If the user asks to "see" something, "show" something, or requests
    output that would be hard to read as spoken text, use this tool to
    surface it visually in the transcript.

    Args:
        code: The code snippet, diff, or file content to display
        filename: Optional filename for context (e.g. "src/App.tsx")
        language: Optional language hint for syntax highlighting (e.g. "typescript", "python", "diff")
    """
    if not _relay_state["connected"] or not _relay_state["ws"]:
        return "Not connected to relay. Use relay_standby first."

    try:
        await _relay_state["ws"].send(json.dumps({
            "type": "code_block",
            "session_id": SESSION_ID,
            "code": code,
            "filename": filename,
            "language": language,
            "timestamp": time.time(),
        }))
        return "Code block sent."
    except Exception as e:
        return f"Failed to send code block: {e}"


@mcp.tool()
async def relay_disconnect() -> str:
    """Disconnect from the voice relay server and exit standby mode."""
    if not _relay_state["connected"]:
        return "Not in standby mode."

    await _cleanup()
    return "Disconnected from relay. Standby ended."


@mcp.tool()
async def relay_status() -> str:
    """Show current voice relay connection status."""
    if _relay_state["connected"]:
        queued = _relay_state["message_queue"].qsize() if _relay_state["message_queue"] else 0
        return (
            f"Connected to relay server\n"
            f"  Session: {_relay_state['session_name']}\n"
            f"  Session ID: {SESSION_ID}\n"
            f"  Relay URL: {RELAY_URL}\n"
            f"  Queued messages: {queued}"
        )
    health_err = await _check_relay_health()
    if health_err:
        return f"Not connected. {health_err}"
    return f"Not connected. Relay server is running at {RELAY_URL}. Use relay_standby to connect."


@mcp.tool()
async def relay_file(file_path: str, read_aloud: bool = False) -> str:
    """Relay a file directly to the web app without passing through Claude.

    Reads a file and sends its contents directly to the relay server,
    bypassing Claude entirely. This saves tokens when you want to show
    large files to the web client.

    Args:
        file_path: Path to the file to relay (relative or absolute)
        read_aloud: Whether to read the file aloud as well (default: false).

    Returns:
        Confirmation message or error
    """
    if not _relay_state["connected"] or not _relay_state["ws"]:
        return "Not connected to relay. Use relay_standby first."

    # Resolve path
    try:
        from pathlib import Path
        p = Path(file_path).expanduser().resolve()
        if not p.exists():
            return f"File not found: {file_path}"
        if not p.is_file():
            return f"Not a file: {file_path}"
    except Exception as e:
        return f"Invalid path: {e}"

    # Read file
    try:
        content = p.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return f"Failed to read file: {e}"

    # Detect language for syntax highlighting
    suffix = p.suffix.lower()
    language_map = {
        ".py": "python",
        ".js": "javascript",
        ".ts": "typescript",
        ".tsx": "typescript",
        ".jsx": "javascript",
        ".json": "json",
        ".md": "markdown",
        ".yaml": "yaml",
        ".yml": "yaml",
        ".xml": "xml",
        ".html": "html",
        ".css": "css",
        ".java": "java",
        ".go": "go",
        ".rs": "rust",
        ".rb": "ruby",
        ".php": "php",
        ".sh": "bash",
        ".c": "c",
        ".cpp": "cpp",
        ".sql": "sql",
    }
    language = language_map.get(suffix, "")

    # Send to relay server
    try:
        await _relay_state["ws"].send(json.dumps({
            "type": "relay_file",
            "session_id": SESSION_ID,
            "filename": p.name,
            "filepath": str(p),
            "content": content,
            "read_aloud": read_aloud,
            "language": language,
            "timestamp": time.time(),
        }))
        return f"File relayed: {p.name} ({len(content)} chars)"
    except Exception as e:
        return f"Failed to relay file: {e}"


@mcp.tool()
async def generate_auth_code() -> str:
    """Generate a one-time pairing code for authorizing a new device.

    The code is valid for 60 seconds. Enter it on the web app's pairing
    screen to authorize the device for voice interaction.

    Requires an active connection to the relay server (call relay_standby first).
    """
    try:
        import urllib.request
        req = urllib.request.Request(
            f"{_RELAY_HTTP_URL}/api/auth/session-code",
            method="POST",
            headers={"Content-Type": "application/json"},
            data=b"{}",
        )
        resp = urllib.request.urlopen(req, timeout=5)
        data = json.loads(resp.read())

        if "code" in data:
            code = data["code"]
            expires_in = data.get("expires_in", 60)
            return (
                f"Pairing code: {code}\n"
                f"Enter this code on the web app to authorize the device.\n"
                f"Code expires in {expires_in} seconds."
            )
        elif "error" in data:
            return data["error"]
        return "Unexpected response from relay server."
    except Exception as e:
        # Check if relay is reachable at all
        health_err = await _check_relay_health()
        if health_err:
            return health_err
        return f"Failed to generate auth code: {e}"


async def _cleanup():
    """Clean up relay connection state."""
    _relay_state["connected"] = False
    for task_key in ("heartbeat_task", "listener_task"):
        task = _relay_state.get(task_key)
        if task:
            task.cancel()
            _relay_state[task_key] = None
    if _relay_state["ws"]:
        try:
            await _relay_state["ws"].close()
        except Exception:
            pass
        _relay_state["ws"] = None
    _relay_state["message_queue"] = None


if __name__ == "__main__":
    mcp.run(transport="stdio")
