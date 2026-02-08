#!/usr/bin/env python3
"""Claude Voice Multiplexer - MCP Server

Provides relay tools for Claude Code sessions to register with
the voice multiplexer relay server for remote voice interaction.
"""

import asyncio
import json
import os
import time
import uuid
from pathlib import Path

# Load .env from project root
_env_path = Path(__file__).resolve().parent.parent / ".env"
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
SESSION_ID = str(uuid.uuid4())[:8]
HEARTBEAT_INTERVAL = 15  # seconds
STANDBY_LISTEN_TIMEOUT = 120  # seconds — how long each relay_standby call waits
RECONNECT_MAX_DELAY = 30  # seconds — max backoff between reconnect attempts
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
        req = urllib.request.Request(f"{_RELAY_HTTP_URL}/api/sessions", method="GET")
        urllib.request.urlopen(req, timeout=3)
        return None
    except Exception:
        return (
            f"Relay server is not reachable at {RELAY_URL}\n"
            f"Start it with: ./scripts/start.sh\n"
            f"Or check RELAY_URL in your .env file."
        )


def _get_session_metadata() -> dict:
    """Gather metadata about the current Claude Code session.

    Name priority: explicit relay_standby arg > CLAUDE_SESSION_NAME env > dir name.
    """
    cwd = os.getcwd()
    dir_name = Path(cwd).name
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
    max_attempts = 5
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
    """Background task that reads WebSocket messages into the queue."""
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
                break
        except asyncio.TimeoutError:
            # No message within timeout — keep listening
            continue
        except websockets.ConnectionClosed:
            await queue.put("[System]: Connection to relay server lost.")
            await _cleanup()
            break
        except Exception as e:
            await queue.put(f"[System]: Relay error: {e}")
            await _cleanup()
            break


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
    # If already connected, signal that Claude is ready and wait for next message
    if _relay_state["connected"] and _relay_state["message_queue"]:
        # Tell the relay server Claude is listening again
        try:
            await _relay_state["ws"].send(json.dumps({
                "type": "listening",
                "session_id": SESSION_ID,
            }))
        except Exception:
            pass

        try:
            msg = await asyncio.wait_for(
                _relay_state["message_queue"].get(),
                timeout=STANDBY_LISTEN_TIMEOUT,
            )
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
