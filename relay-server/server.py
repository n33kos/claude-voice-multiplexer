#!/usr/bin/env python3
"""Claude Voice Multiplexer - Relay Server

Bridges web clients (phone/browser) with Claude Code sessions via:
- WebSocket for MCP plugin session registration and text relay
- WebSocket for web client events and session switching
- REST API for session listing and LiveKit token generation
- Audio pipeline for Whisper STT and Kokoro TTS
"""

import asyncio
import json
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from config import RELAY_HOST, RELAY_PORT, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
from registry import SessionRegistry
import audio

app = FastAPI(title="Claude Voice Multiplexer")
registry = SessionRegistry()

# Track connected web clients
_clients: dict[str, WebSocket] = {}


# --- REST API ---

@app.get("/api/sessions")
async def list_sessions():
    """List all registered Claude Code sessions."""
    sessions = await registry.list_sessions()
    return JSONResponse({"sessions": sessions})


@app.get("/api/token")
async def get_token(room: str = "multiplexer", identity: str = ""):
    """Generate a LiveKit JWT for client connection."""
    try:
        from livekit.api import AccessToken, VideoGrants
    except ImportError:
        return JSONResponse(
            {"error": "livekit-api not installed"},
            status_code=500,
        )

    if not identity:
        identity = f"client-{uuid.uuid4().hex[:6]}"

    token = AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
    token.identity = identity
    token.add_grant(VideoGrants(
        room_join=True,
        room=room,
    ))

    return JSONResponse({
        "token": token.to_jwt(),
        "url": LIVEKIT_URL,
        "room": room,
        "identity": identity,
    })


# --- WebSocket: MCP Plugin Sessions ---

@app.websocket("/ws/session")
async def session_ws(ws: WebSocket):
    """WebSocket endpoint for MCP plugin connections.

    Protocol:
    - Plugin sends: {type: "register", session_id, name, cwd, dir_name}
    - Server sends: {type: "registered"}
    - Plugin sends: {type: "heartbeat", session_id, timestamp}
    - Server sends: {type: "voice_message", text, caller}
    - Plugin sends: {type: "response", session_id, text}
    """
    await ws.accept()
    session_id = None

    try:
        while True:
            raw = await ws.receive_text()
            data = json.loads(raw)
            msg_type = data.get("type")

            if msg_type == "register":
                session_id = data["session_id"]
                session = await registry.register(
                    session_id=session_id,
                    name=data.get("name", "unnamed"),
                    cwd=data.get("cwd", ""),
                    dir_name=data.get("dir_name", ""),
                    ws=ws,
                )
                await ws.send_text(json.dumps({"type": "registered", "session_id": session_id}))
                print(f"Session registered: {session.name} ({session_id})")

                # Notify all clients of session list change
                await _broadcast_sessions()

            elif msg_type == "heartbeat":
                sid = data.get("session_id", session_id)
                if sid:
                    await registry.heartbeat(sid)

            elif msg_type == "response":
                # Claude's text response — synthesize and relay to connected client
                text = data.get("text", "")
                sid = data.get("session_id", session_id)

                if text and sid:
                    session = await registry.get(sid)
                    if session and session.connected_client:
                        client_ws = _clients.get(session.connected_client)
                        if client_ws:
                            # Send text to client immediately
                            await client_ws.send_text(json.dumps({
                                "type": "transcript",
                                "speaker": "claude",
                                "text": text,
                                "session_id": sid,
                            }))

                            # Synthesize TTS and send audio reference
                            audio_data = await audio.synthesize(text)
                            if audio_data:
                                await client_ws.send_text(json.dumps({
                                    "type": "tts_ready",
                                    "session_id": sid,
                                    "audio_size": len(audio_data),
                                }))
                                await client_ws.send_bytes(audio_data)

            elif msg_type == "pong":
                pass

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"Session WebSocket error: {e}")
    finally:
        if session_id:
            await registry.unregister(session_id)
            print(f"Session unregistered: {session_id}")
            await _broadcast_sessions()


# --- WebSocket: Web Clients ---

@app.websocket("/ws/client")
async def client_ws(ws: WebSocket):
    """WebSocket endpoint for web client connections.

    Protocol:
    - Client sends: {type: "connect_session", session_id}
    - Client sends: {type: "disconnect_session"}
    - Client sends: {type: "voice_input", audio (base64), format}
    - Server sends: {type: "sessions", sessions: [...]}
    - Server sends: {type: "transcript", speaker, text, session_id}
    - Server sends: {type: "tts_ready", session_id, audio_size}
    - Server sends: <binary audio data>
    """
    await ws.accept()
    client_id = f"client-{uuid.uuid4().hex[:6]}"
    _clients[client_id] = ws
    connected_session_id = None

    try:
        # Send current session list on connect
        sessions = await registry.list_sessions()
        await ws.send_text(json.dumps({"type": "sessions", "sessions": sessions}))

        while True:
            raw = await ws.receive_text()
            data = json.loads(raw)
            msg_type = data.get("type")

            if msg_type == "connect_session":
                # Disconnect from current session if any
                if connected_session_id:
                    await registry.disconnect_client(connected_session_id)

                session_id = data["session_id"]
                success = await registry.connect_client(session_id, client_id)
                connected_session_id = session_id if success else None

                await ws.send_text(json.dumps({
                    "type": "session_connected" if success else "session_not_found",
                    "session_id": session_id,
                }))
                await _broadcast_sessions()

            elif msg_type == "disconnect_session":
                if connected_session_id:
                    await registry.disconnect_client(connected_session_id)
                    connected_session_id = None
                    await _broadcast_sessions()

            elif msg_type == "voice_input":
                # Client sent audio — transcribe and forward to connected session
                if not connected_session_id:
                    await ws.send_text(json.dumps({
                        "type": "error",
                        "message": "No session connected",
                    }))
                    continue

                import base64
                audio_b64 = data.get("audio", "")
                audio_format = data.get("format", "webm")
                audio_bytes = base64.b64decode(audio_b64)

                # Transcribe with Whisper
                text = await audio.transcribe(audio_bytes, audio_format)

                if text:
                    # Send transcript to client
                    await ws.send_text(json.dumps({
                        "type": "transcript",
                        "speaker": "user",
                        "text": text,
                        "session_id": connected_session_id,
                    }))

                    # Forward to Claude session
                    session = await registry.get(connected_session_id)
                    if session and session.ws:
                        await session.ws.send_text(json.dumps({
                            "type": "voice_message",
                            "text": text,
                            "caller": client_id,
                            "timestamp": time.time(),
                        }))
                else:
                    await ws.send_text(json.dumps({
                        "type": "error",
                        "message": "Could not transcribe audio",
                    }))

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"Client WebSocket error: {e}")
    finally:
        if connected_session_id:
            await registry.disconnect_client(connected_session_id)
        _clients.pop(client_id, None)
        await _broadcast_sessions()


async def _broadcast_sessions():
    """Send updated session list to all connected web clients."""
    sessions = await registry.list_sessions()
    msg = json.dumps({"type": "sessions", "sessions": sessions})
    for client_ws in list(_clients.values()):
        try:
            await client_ws.send_text(msg)
        except Exception:
            pass


# --- Static file serving (React web app) ---

web_dist = Path(__file__).parent.parent / "web" / "dist"
if web_dist.exists():
    app.mount("/", StaticFiles(directory=str(web_dist), html=True), name="web")
else:
    @app.get("/")
    async def index():
        return JSONResponse({
            "status": "running",
            "message": "Claude Voice Multiplexer relay server. Web app not built yet — run 'npm run build' in web/.",
        })


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=RELAY_HOST, port=RELAY_PORT)
