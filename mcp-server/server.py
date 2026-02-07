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

# Global state for the active relay connection
_relay_state = {
    "connected": False,
    "ws": None,
    "session_name": None,
    "task": None,
}


def _get_session_metadata() -> dict:
    """Gather metadata about the current Claude Code session."""
    cwd = os.getcwd()
    dir_name = Path(cwd).name
    return {
        "session_id": SESSION_ID,
        "name": _relay_state.get("session_name") or dir_name,
        "cwd": cwd,
        "dir_name": dir_name,
        "timestamp": time.time(),
    }


@mcp.tool()
async def relay_standby(session_name: str = "") -> str:
    """Register this Claude session with the voice relay server and enter standby mode.

    The session becomes available for remote voice interaction through the
    web client. Voice input is transcribed and delivered as text messages.
    Respond conversationally to each message.

    Args:
        session_name: Optional friendly name for this session (defaults to directory name)
    """
    if _relay_state["connected"]:
        return f"Already in standby mode as '{_relay_state['session_name']}'. Use relay_disconnect to stop."

    metadata = _get_session_metadata()
    if session_name:
        metadata["name"] = session_name
    _relay_state["session_name"] = metadata["name"]

    ws_url = f"{RELAY_URL}/ws/session"

    try:
        ws = await websockets.connect(ws_url)
    except Exception as e:
        _relay_state["connected"] = False
        return f"Failed to connect to relay server at {ws_url}: {e}\nMake sure the relay server is running."

    _relay_state["ws"] = ws
    _relay_state["connected"] = True

    # Send registration message
    await ws.send(json.dumps({
        "type": "register",
        **metadata,
    }))

    # Wait for acknowledgment
    try:
        ack = await asyncio.wait_for(ws.recv(), timeout=5.0)
        ack_data = json.loads(ack)
        if ack_data.get("type") != "registered":
            await ws.close()
            _relay_state["connected"] = False
            return f"Registration failed: {ack_data}"
    except asyncio.TimeoutError:
        await ws.close()
        _relay_state["connected"] = False
        return "Registration timed out. Relay server did not acknowledge."

    # Start heartbeat in background
    async def heartbeat():
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

    _relay_state["task"] = asyncio.create_task(heartbeat())

    # Wait for first voice message (blocking the tool call)
    try:
        while _relay_state["connected"]:
            msg = await asyncio.wait_for(ws.recv(), timeout=HEARTBEAT_INTERVAL * 3)
            data = json.loads(msg)

            if data.get("type") == "voice_message":
                # Return the transcribed text so Claude can process it
                text = data.get("text", "")
                caller = data.get("caller", "remote user")
                return f"[Voice from {caller}]: {text}"
            elif data.get("type") == "ping":
                await ws.send(json.dumps({"type": "pong"}))
            elif data.get("type") == "disconnect":
                await _cleanup()
                return "Relay server requested disconnect. Standby ended."

    except asyncio.TimeoutError:
        # No message received in timeout window, return for re-invocation
        return "Standby active — no voice input received yet. Invoke relay_standby again to continue listening."
    except websockets.ConnectionClosed:
        await _cleanup()
        return "Connection to relay server lost. Standby ended."
    except Exception as e:
        await _cleanup()
        return f"Error in standby: {e}"


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
        return "Response sent to relay for speech synthesis."
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
        return (
            f"Connected to relay server\n"
            f"  Session: {_relay_state['session_name']}\n"
            f"  Session ID: {SESSION_ID}\n"
            f"  Relay URL: {RELAY_URL}"
        )
    return f"Not connected. Relay URL configured: {RELAY_URL}"


async def _cleanup():
    """Clean up relay connection state."""
    _relay_state["connected"] = False
    if _relay_state["task"]:
        _relay_state["task"].cancel()
        _relay_state["task"] = None
    if _relay_state["ws"]:
        try:
            await _relay_state["ws"].close()
        except Exception:
            pass
        _relay_state["ws"] = None


if __name__ == "__main__":
    mcp.run(transport="stdio")
