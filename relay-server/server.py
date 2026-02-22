#!/usr/bin/env python3
"""Claude Voice Multiplexer - Relay Server

Bridges web clients (phone/browser) with Claude Code sessions via:
- WebSocket for MCP plugin session registration and text relay
- WebSocket for web client events and session switching
- REST API for session listing and LiveKit token generation
- LiveKit agent for audio I/O with Whisper STT and Kokoro TTS
"""

import asyncio
import json
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Response, Cookie, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from config import RELAY_HOST, RELAY_PORT, RELAY_TLS_PORT, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, AUTH_ENABLED, WHISPER_URL, KOKORO_URL, TLS_ENABLED, SSL_CERT_FILE, SSL_KEY_FILE
import auth
from registry import SessionRegistry
from livekit_agent import RelayAgent
import mcp_tools

registry = SessionRegistry()

# Track connected web clients
_clients: dict[str, WebSocket] = {}

# LiveKit agent (initialized on startup)
_agent: Optional[RelayAgent] = None

# Transcript buffer per session (keyed by session_id)
# Holds the last N entries so reconnecting clients can catch up.
MAX_TRANSCRIPT_BUFFER = 100
_transcript_buffers: dict[str, list[dict]] = {}  # session_id → [entry, ...]
_transcript_seq: dict[str, int] = {}  # session_id → next sequence number


# --- Auth helpers ---

def _get_device(request: Request) -> Optional[dict]:
    """Extract and validate device from JWT cookie. Returns payload or None."""
    if not AUTH_ENABLED:
        return {"device_id": "anonymous", "device_name": "anonymous"}
    token = request.cookies.get(auth.COOKIE_NAME)
    if not token:
        return None
    return auth.validate_token(token)


def _require_auth(request: Request) -> dict:
    """FastAPI-style auth check. Raises 401 if not authenticated."""
    device = _get_device(request)
    if not device:
        raise HTTPException(status_code=401, detail="Authentication required")
    auth.update_last_seen(device["device_id"])
    return device


def _get_ws_device(ws: WebSocket) -> Optional[dict]:
    """Extract device from WebSocket upgrade cookies."""
    if not AUTH_ENABLED:
        return {"device_id": "anonymous", "device_name": "anonymous"}
    token = ws.cookies.get(auth.COOKIE_NAME)
    if not token:
        return None
    return auth.validate_token(token)


async def _notify_client_status(session_id: str, state: str, activity: Optional[str] = None, *, disable_auto_listen: bool = False):
    """Send agent status update to all web clients connected to a session."""
    session = await registry.get(session_id)
    if session and session.connected_clients:
        payload: dict = {
            "type": "agent_status",
            "state": state,
            "activity": activity,
            "timestamp": time.time(),
        }
        if disable_auto_listen:
            payload["disable_auto_listen"] = True
        msg = json.dumps(payload)
        for client_id in list(session.connected_clients):
            client_ws = _clients.get(client_id)
            if client_ws:
                try:
                    await client_ws.send_text(msg)
                except Exception:
                    pass


async def _notify_client_transcript(session_id: str, speaker: str, text: str, **extra):
    """Send a transcript entry to all connected web clients.

    Transcripts are broadcast so clients can persist them even when
    they're viewing a different session.  Each entry is also buffered
    (up to MAX_TRANSCRIPT_BUFFER) so reconnecting clients can catch up.
    """
    session = await registry.get(session_id)
    if not session:
        return

    # Assign a sequence number and buffer the entry
    seq = _transcript_seq.get(session_id, 0)
    _transcript_seq[session_id] = seq + 1

    entry = {
        "type": "transcript",
        "speaker": speaker,
        "text": text,
        "session_id": session_id,
        "session_name": session.name,
        "seq": seq,
        "ts": time.time(),
        **extra,
    }

    # Don't buffer image entries — base64 data is large and images
    # don't need to be replayed to reconnecting clients.
    if speaker != "image":
        buf = _transcript_buffers.setdefault(session_id, [])
        buf.append(entry)
        if len(buf) > MAX_TRANSCRIPT_BUFFER:
            _transcript_buffers[session_id] = buf[-MAX_TRANSCRIPT_BUFFER:]

    msg = json.dumps(entry)
    print(f"[transcript] {speaker} ({session_id}): {len(text)} chars, msg_len={len(msg)}")
    for client_ws in list(_clients.values()):
        try:
            await client_ws.send_text(msg)
        except Exception:
            pass


async def _warmup_kokoro():
    """Send a tiny TTS request to Kokoro to prime the model, reducing first-response latency."""
    try:
        import audio as audio_pipeline
        await audio_pipeline.synthesize("ready", response_format="pcm")
        print("[server] Kokoro TTS warm-up complete")
    except Exception as e:
        print(f"[server] Kokoro TTS warm-up failed (non-fatal): {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _agent
    _agent = RelayAgent(registry, _broadcast_sessions, _notify_client_status, _notify_client_transcript)
    print("[server] Agent manager initialized (rooms created per session)")

    # Initialize MCP tools with relay server dependencies
    mcp_tools.init(
        registry=registry,
        get_agent=lambda: _agent,
        notify_transcript=_notify_client_transcript,
        notify_status=_notify_client_status,
        broadcast_sessions=_broadcast_sessions,
    )
    print("[server] MCP tools initialized (SSE endpoint at /mcp)")

    if AUTH_ENABLED:
        print("[server] Authentication enabled")
    else:
        print("[server] Authentication disabled (no AUTH_SECRET set)")
    # Warm up Kokoro TTS in the background (non-blocking)
    asyncio.create_task(_warmup_kokoro())
    yield
    if _agent:
        await _agent.stop()


app = FastAPI(title="Claude Voice Multiplexer", lifespan=lifespan)

# Mount MCP SSE app for Claude Code sessions
app.mount("/mcp", mcp_tools.create_mcp_app())


# --- Auth API ---

@app.get("/api/auth/status")
async def auth_status(request: Request):
    """Check if the current client is authenticated."""
    device = _get_device(request)
    return JSONResponse({
        "authenticated": device is not None,
        "auth_enabled": AUTH_ENABLED,
        "device": device,
    })


@app.post("/api/auth/pair")
async def pair_device(request: Request):
    """Pair a new device using a one-time code."""
    if not AUTH_ENABLED:
        return JSONResponse({"error": "Authentication is not enabled"}, status_code=400)

    client_ip = request.client.host if request.client else "unknown"
    if not auth.check_pair_rate_limit(client_ip):
        return JSONResponse({"error": "Too many pairing attempts. Try again later."}, status_code=429)

    body = await request.json()
    code = body.get("code", "").strip()
    device_name = body.get("device_name", "Unknown Device").strip()

    if not code:
        return JSONResponse({"error": "Code is required"}, status_code=400)

    if not auth.validate_pair_code(code):
        return JSONResponse({"error": "Invalid or expired code"}, status_code=403)

    device_id = uuid.uuid4().hex
    auth.register_device(device_id, device_name)
    token = auth.issue_token(device_id, device_name)

    response = JSONResponse({
        "success": True,
        "device_id": device_id,
        "device_name": device_name,
    })
    response.set_cookie(
        key=auth.COOKIE_NAME,
        value=token,
        max_age=auth.AUTH_TOKEN_TTL_DAYS * 86400,
        httponly=True,
        samesite="lax",
    )
    return response


@app.post("/api/auth/code")
async def generate_code(request: Request):
    """Generate a pairing code (requires existing auth)."""
    _require_auth(request)
    code = auth.generate_pair_code()
    return JSONResponse({"code": code, "expires_in": auth.CODE_TTL_S})


@app.post("/api/auth/session-code")
async def generate_session_code(request: Request):
    """Generate a pairing code for MCP sessions (localhost only).

    Restricted to loopback addresses to prevent remote code generation
    when the relay server is exposed via a tunnel.
    """
    if not AUTH_ENABLED:
        return JSONResponse({"error": "Authentication is not enabled"}, status_code=400)
    client_host = request.client.host if request.client else ""
    if client_host not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(status_code=403, detail="Code generation is only available from localhost")
    code = auth.generate_pair_code()
    return JSONResponse({"code": code, "expires_in": auth.CODE_TTL_S})


@app.get("/api/auth/devices")
async def get_devices(request: Request):
    """List all authorized devices."""
    _require_auth(request)
    return JSONResponse({"devices": auth.list_devices()})


@app.delete("/api/auth/devices/{device_id}")
async def delete_device(device_id: str, request: Request):
    """Revoke a device's authorization."""
    _require_auth(request)
    if auth.revoke_device(device_id):
        return JSONResponse({"success": True})
    return JSONResponse({"error": "Device not found"}, status_code=404)


# --- REST API ---

@app.get("/api/health")
async def health_check(request: Request):
    """Check the health of all backend services."""
    _require_auth(request)

    import httpx

    async def check_service(url: str) -> bool:
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                resp = await client.get(url)
                return resp.status_code < 500
        except Exception:
            return False

    # Derive base URLs from config (strip /v1 suffix)
    whisper_base = WHISPER_URL.rsplit("/v1", 1)[0]
    kokoro_base = KOKORO_URL.rsplit("/v1", 1)[0]
    livekit_http = LIVEKIT_URL.replace("ws://", "http://").replace("wss://", "https://")

    whisper_ok, kokoro_ok, livekit_ok = await asyncio.gather(
        check_service(f"{whisper_base}/"),
        check_service(f"{kokoro_base}/health"),
        check_service(livekit_http),
    )

    return JSONResponse({
        "whisper": {"status": "ok" if whisper_ok else "down", "url": whisper_base},
        "kokoro": {"status": "ok" if kokoro_ok else "down", "url": kokoro_base},
        "livekit": {"status": "ok" if livekit_ok else "down", "url": LIVEKIT_URL},
        "relay": {"status": "ok"},
    })


@app.get("/api/sessions")
async def list_sessions(request: Request):
    """List all registered Claude Code sessions."""
    _require_auth(request)
    sessions = await registry.list_sessions()
    return JSONResponse({"sessions": sessions})


@app.get("/api/token")
async def get_token(request: Request, room: str = "multiplexer", identity: str = ""):
    """Generate a LiveKit JWT for client connection."""
    _require_auth(request)

    try:
        from livekit.api import AccessToken, VideoGrants
    except ImportError:
        return JSONResponse(
            {"error": "livekit-api not installed"},
            status_code=500,
        )

    if not identity:
        identity = f"client-{uuid.uuid4().hex[:6]}"

    jwt_token = (
        AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        .with_identity(identity)
        .with_grants(VideoGrants(room_join=True, room=room))
        .to_jwt()
    )

    # Return the relay server's own URL as the LiveKit endpoint.
    # The relay proxies /livekit/* to the local LiveKit server, so remote
    # clients (phones, ngrok tunnels) reach LiveKit through a single port.
    host = request.headers.get("host", f"localhost:{RELAY_PORT}")
    scheme = "wss" if request.headers.get("x-forwarded-proto") == "https" else "ws"
    livekit_url = f"{scheme}://{host}/livekit"

    return JSONResponse({
        "token": jwt_token,
        "url": livekit_url,
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
                session, is_reconnect = await registry.register(
                    session_id=session_id,
                    name=data.get("name", "unnamed"),
                    cwd=data.get("cwd", ""),
                    dir_name=data.get("dir_name", ""),
                    ws=ws,
                )
                await ws.send_text(json.dumps({"type": "registered", "session_id": session_id}))
                label = "reconnected" if is_reconnect else "registered"
                print(f"Session {label}: {session.name} ({session_id}) → room {session.room_name}")

                # Recycle the LiveKit room on reconnect, or create a new one
                if _agent:
                    try:
                        if is_reconnect:
                            await _agent.remove_session(session_id)
                        await _agent.add_session(session_id, session.room_name)
                    except Exception as e:
                        print(f"[server] Failed to manage room for session: {e}")

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
                    # Route through LiveKit agent if available (publishes audio to room)
                    if _agent:
                        asyncio.create_task(_agent.handle_claude_response(sid, text))

                    # Broadcast transcript to all connected web clients
                    await _notify_client_transcript(sid, "claude", text)

            elif msg_type == "listening":
                # Claude called relay_standby again — ready for next message
                sid = data.get("session_id", session_id)
                if sid and _agent:
                    asyncio.create_task(_agent.handle_claude_listening(sid))

            elif msg_type == "code_block":
                # Claude pushing a code snippet into the transcript
                sid = data.get("session_id", session_id)
                code = data.get("code", "")
                if code and sid:
                    await _notify_client_transcript(
                        sid, "code", code,
                        filename=data.get("filename", ""),
                        language=data.get("language", ""),
                    )

            elif msg_type == "status_update":
                # Claude reporting current activity
                sid = data.get("session_id", session_id)
                activity = data.get("activity", "")
                if sid and _agent and activity:
                    asyncio.create_task(_agent.handle_status_update(sid, activity))

            elif msg_type == "relay_file":
                # Claude relaying a file directly
                sid = data.get("session_id", session_id)
                content = data.get("content", "")
                read_aloud = data.get("read_aloud", False)
                
                if content and sid and read_aloud and _agent:
                    asyncio.create_task(_agent.handle_claude_response(sid, content))

                # Route through LiveKit agent if available (publishes audio to room)
                if content and sid:
                    await _notify_client_transcript(
                        sid, "file", content,
                        filename=data.get("filename", ""),
                        language=data.get("language", ""),
                    )

            elif msg_type == "generate_code":
                # MCP plugin requesting a pairing code
                if AUTH_ENABLED:
                    code = auth.generate_pair_code()
                    await ws.send_text(json.dumps({
                        "type": "auth_code",
                        "code": code,
                        "expires_in": auth.CODE_TTL_S,
                    }))
                else:
                    await ws.send_text(json.dumps({
                        "type": "auth_code",
                        "code": None,
                        "message": "Authentication is not enabled",
                    }))

            elif msg_type == "pong":
                pass

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"Session WebSocket error: {e}")
    finally:
        if session_id:
            # Remove the LiveKit room for this session
            if _agent:
                try:
                    await _agent.remove_session(session_id)
                except Exception as e:
                    print(f"[server] Error removing room: {e}")
            await registry.unregister(session_id)
            _transcript_buffers.pop(session_id, None)
            _transcript_seq.pop(session_id, None)
            print(f"Session unregistered: {session_id}")
            await _broadcast_sessions()


# --- WebSocket: Web Clients ---

@app.websocket("/ws/client")
async def client_ws(ws: WebSocket):
    """WebSocket endpoint for web client connections.

    Protocol:
    - Client sends: {type: "connect_session", session_id}
    - Client sends: {type: "disconnect_session"}
    - Server sends: {type: "sessions", sessions: [...]}
    - Server sends: {type: "transcript", speaker, text, session_id}
    - Server sends: {type: "agent_status", state, activity, timestamp}
    """
    # Auth check on WebSocket handshake
    device = _get_ws_device(ws)
    if not device:
        await ws.close(code=4001, reason="Authentication required")
        return

    await ws.accept()
    client_id = f"client-{uuid.uuid4().hex[:6]}"
    device_name = device.get("device_name", "Unknown")
    _clients[client_id] = ws
    connected_session_id = None

    try:
        # Send current session list on connect
        sessions = await registry.list_sessions()
        await ws.send_text(json.dumps({"type": "sessions", "sessions": sessions}))

        while True:
            try:
                raw = await asyncio.wait_for(ws.receive_text(), timeout=30.0)
            except asyncio.TimeoutError:
                # No message for 30s — send keepalive ping to prevent
                # NAT/mobile idle timeout from silently killing connection
                try:
                    await ws.send_text(json.dumps({"type": "ping"}))
                except Exception:
                    break  # Connection dead
                continue

            data = json.loads(raw)
            msg_type = data.get("type")

            if msg_type == "pong":
                continue  # Keepalive response from client

            if msg_type == "connect_session":
                # Disconnect this client from its current session if any
                if connected_session_id:
                    await registry.disconnect_client(connected_session_id, client_id)

                session_id = data["session_id"]
                success = await registry.connect_client(session_id, client_id, device_name)
                connected_session_id = session_id if success else None

                session_data = await registry.get(session_id) if success else None
                msg = {
                    "type": "session_connected" if success else "session_not_found",
                    "session_id": session_id,
                }
                if session_data:
                    msg["session_name"] = session_data.name
                await ws.send_text(json.dumps(msg))
                # Send current agent status so new clients see the real state
                if success and _agent:
                    status = _agent.get_current_status(session_id)
                    await ws.send_text(json.dumps({
                        "type": "agent_status",
                        "state": status.get("state", "idle"),
                        "activity": status.get("activity"),
                        "timestamp": time.time(),
                    }))

                # Send buffered transcripts so reconnecting clients can catch up
                if success and session_id in _transcript_buffers:
                    buf = _transcript_buffers[session_id]
                    if buf:
                        await ws.send_text(json.dumps({
                            "type": "transcript_sync",
                            "session_id": session_id,
                            "session_name": session_data.name if session_data else session_id,
                            "entries": buf,
                        }))
                await _broadcast_sessions()

            elif msg_type == "text_message":
                # User typed a text message — forward to session via voice queue
                text = data.get("text", "").strip()
                if text and connected_session_id:
                    session = await registry.get(connected_session_id)
                    if session:
                        # Check if session is stale (Claude Code disconnected)
                        if session.is_stale:
                            # Session has gone stale — Claude Code must reconnect
                            await ws.send_text(json.dumps({
                                "type": "session_disconnected",
                                "session_id": connected_session_id,
                                "reason": "Claude Code session idle timeout",
                            }))
                            await registry.disconnect_client(connected_session_id, client_id)
                            connected_session_id = None
                        else:
                            try:
                                msg = f"[Voice from {client_id}]: {text}"
                                await session.voice_queue.put(msg)
                                # Set agent to thinking state
                                if _agent:
                                    asyncio.create_task(_agent.handle_text_message(connected_session_id, text, client_id))
                                # Broadcast transcript
                                await _notify_client_transcript(connected_session_id, "user", text)
                            except Exception as e:
                                print(f"Failed to queue message for session {connected_session_id}: {e}")
                                await ws.send_text(json.dumps({
                                    "type": "session_disconnected",
                                    "session_id": connected_session_id,
                                    "reason": "Failed to send message",
                                }))
                                await registry.disconnect_client(connected_session_id, client_id)
                                connected_session_id = None

            elif msg_type == "interrupt":
                # User pressed interrupt — force agent to idle
                if connected_session_id and _agent:
                    asyncio.create_task(_agent.handle_claude_listening(connected_session_id))

            elif msg_type == "disconnect_session":
                if connected_session_id:
                    await registry.disconnect_client(connected_session_id, client_id)
                    connected_session_id = None
                    await _broadcast_sessions()

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"Client WebSocket error: {e}")
    finally:
        if connected_session_id:
            await registry.disconnect_client(connected_session_id, client_id)
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


# --- LiveKit proxy ---
# Proxies WebSocket and HTTP requests from /livekit/* to the local LiveKit
# server so that remote clients (phones, ngrok) can reach LiveKit through the
# relay server's single port.

from urllib.parse import urlparse as _urlparse

_lk_parsed = _urlparse(LIVEKIT_URL)
_LK_HOST = _lk_parsed.hostname or "127.0.0.1"
_LK_PORT = _lk_parsed.port or 7880


@app.websocket("/livekit/{path:path}")
async def livekit_ws_proxy(ws: WebSocket, path: str):
    """Proxy WebSocket connections to the local LiveKit server."""
    await ws.accept()

    import websockets

    # Build target URL with query string
    query = str(ws.scope.get("query_string", b""), "utf-8")
    target = f"ws://{_LK_HOST}:{_LK_PORT}/{path}"
    if query:
        target += f"?{query}"

    lk_ws = None
    try:
        async with websockets.connect(target) as lk_ws:
            async def client_to_lk():
                try:
                    while True:
                        data = await ws.receive()
                        if "text" in data:
                            await lk_ws.send(data["text"])
                        elif "bytes" in data:
                            await lk_ws.send(data["bytes"])
                except Exception:
                    pass

            async def lk_to_client():
                try:
                    async for msg in lk_ws:
                        if isinstance(msg, bytes):
                            await ws.send_bytes(msg)
                        else:
                            await ws.send_text(msg)
                except Exception:
                    pass

            try:
                await asyncio.gather(client_to_lk(), lk_to_client())
            except Exception:
                pass
    except Exception:
        pass
    finally:
        try:
            await ws.close()
        except Exception:
            pass


@app.api_route("/livekit/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def livekit_http_proxy(request: Request, path: str):
    """Proxy HTTP requests (e.g. /validate) to the local LiveKit server."""
    import httpx

    target = f"http://{_LK_HOST}:{_LK_PORT}/{path}"
    query = str(request.url.query)
    if query:
        target += f"?{query}"

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            async with client.stream(
                method=request.method,
                url=target,
                content=await request.body(),
                headers={k: v for k, v in request.headers.items() if k.lower() not in ("host", "transfer-encoding")},
            ) as resp:
                return Response(
                    content=resp.content,
                    status_code=resp.status_code,
                    headers=dict(resp.headers),
                    media_type=resp.headers.get("content-type")
                )
    except Exception as e:
        return Response(content=str(e), status_code=502)


# --- Static file serving (React web app) ---

# Semaphore to limit concurrent static file requests and prevent FD exhaustion
_static_file_semaphore = asyncio.Semaphore(16)

class LimitedStaticFiles(StaticFiles):
    """StaticFiles with concurrency limiting to prevent file descriptor exhaustion."""

    async def __call__(self, scope, receive, send):
        async with _static_file_semaphore:
            await super().__call__(scope, receive, send)

web_dist = Path(__file__).parent.parent / "web" / "dist"
if web_dist.exists():
    app.mount("/", LimitedStaticFiles(directory=str(web_dist), html=True), name="web")
else:
    @app.get("/")
    async def index():
        return JSONResponse({
            "status": "running",
            "message": "Claude Voice Multiplexer relay server. Web app not built yet — run 'npm run build' in web/.",
        })


if __name__ == "__main__":
    import asyncio
    import uvicorn

    if TLS_ENABLED:
        # HTTP on localhost only (for MCP and local browser access — .mcp.json stays unchanged)
        # HTTPS on all interfaces on RELAY_TLS_PORT (for phone/remote browser access with getUserMedia)
        async def _serve_both():
            http_server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=RELAY_PORT))
            https_server = uvicorn.Server(uvicorn.Config(
                app, host=RELAY_HOST, port=RELAY_TLS_PORT,
                ssl_keyfile=SSL_KEY_FILE, ssl_certfile=SSL_CERT_FILE,
            ))
            await asyncio.gather(http_server.serve(), https_server.serve())
        asyncio.run(_serve_both())
    else:
        uvicorn.run(app, host=RELAY_HOST, port=RELAY_PORT)
