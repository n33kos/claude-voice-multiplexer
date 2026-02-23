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
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Response, Cookie, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from config import RELAY_HOST, RELAY_PORT, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, AUTH_ENABLED, WHISPER_URL, KOKORO_URL, DAEMON_SECRET
import auth
from registry import SessionRegistry
from livekit_agent import RelayAgent
import mcp_tools

registry = SessionRegistry()

# --- Dynamic Kokoro voice loading ---
# Fetches available voices from Kokoro's API and derives metadata (name, language,
# gender) from the voice ID prefix convention. Cached with a TTL to avoid hitting
# Kokoro on every settings request.

_VOICE_PREFIX_MAP = {
    "a": ("en-US", {
        "f": "F", "m": "M",
    }),
    "b": ("en-GB", {
        "f": "F", "m": "M",
    }),
    "e": ("es", {
        "f": "F", "m": "M",
    }),
    "f": ("fr", {
        "f": "F",
    }),
    "h": ("hi", {
        "f": "F", "m": "M",
    }),
    "i": ("it", {
        "f": "F", "m": "M",
    }),
    "j": ("ja", {
        "f": "F", "m": "M",
    }),
    "p": ("pt", {
        "f": "F", "m": "M",
    }),
    "z": ("zh", {
        "f": "F", "m": "M",
    }),
}

# Known custom voices that don't follow standard naming — override display names
_CUSTOM_VOICE_NAMES = {
    "af_kate_reading": "Kate Reading",
    "am_michael_kramer": "Michael Kramer",
}

_voices_cache: list[dict] | None = None
_voices_cache_ts: float = 0.0
_VOICES_CACHE_TTL = 300  # 5 minutes


def _parse_voice_id(voice_id: str) -> dict | None:
    """Parse a Kokoro voice ID into a structured dict.

    Voice IDs follow the convention: {lang_prefix}{gender_prefix}_{name}
    e.g. af_bella → American English, Female, "Bella"

    Returns None for unrecognized or legacy (v0) voices.
    """
    # Skip legacy v0 voices
    if "_v0" in voice_id:
        return None

    if len(voice_id) < 3 or voice_id[2] != "_":
        return None

    lang_char = voice_id[0]
    gender_char = voice_id[1]
    raw_name = voice_id[3:]

    lang_info = _VOICE_PREFIX_MAP.get(lang_char)
    if not lang_info:
        return None

    lang, genders = lang_info
    gender = genders.get(gender_char)
    if not gender:
        return None

    # Use custom display name if available, otherwise derive from ID
    if voice_id in _CUSTOM_VOICE_NAMES:
        display_name = _CUSTOM_VOICE_NAMES[voice_id]
    else:
        display_name = raw_name.replace("_", " ").title()

    return {"id": voice_id, "name": display_name, "lang": lang, "gender": gender}


async def _fetch_kokoro_voices() -> list[dict]:
    """Fetch and parse available voices from Kokoro's API with caching."""
    global _voices_cache, _voices_cache_ts

    now = time.time()
    if _voices_cache is not None and (now - _voices_cache_ts) < _VOICES_CACHE_TTL:
        return _voices_cache

    import httpx
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{KOKORO_URL}/audio/voices")
            resp.raise_for_status()
            raw_ids = resp.json().get("voices", [])
    except Exception as e:
        print(f"[server] Failed to fetch Kokoro voices: {e}")
        # Return cached data if available, even if stale
        if _voices_cache is not None:
            return _voices_cache
        return []

    voices = []
    for vid in raw_ids:
        parsed = _parse_voice_id(vid)
        if parsed:
            voices.append(parsed)

    _voices_cache = voices
    _voices_cache_ts = now
    print(f"[server] Loaded {len(voices)} voices from Kokoro (filtered from {len(raw_ids)} total)")
    return voices

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

def _is_daemon_request(request: Request) -> bool:
    """Check if request is from the vmux daemon (X-Daemon-Secret header)."""
    if not DAEMON_SECRET:
        return False
    return request.headers.get("X-Daemon-Secret") == DAEMON_SECRET


def _get_device(request: Request) -> Optional[dict]:
    """Extract and validate device from JWT.

    Checks (in order):
    1. Daemon secret header — grants full access, no device record needed
    2. Authorization: Bearer <jwt> header
    3. vmux_token cookie (legacy / WebSocket upgrade fallback)
    """
    if not AUTH_ENABLED:
        return {"device_id": "anonymous", "device_name": "anonymous"}
    if _is_daemon_request(request):
        return {"device_id": "daemon", "device_name": "vmuxd"}
    # Bearer header
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:].strip()
        if token:
            payload = auth.validate_token(token)
            if payload:
                return payload
    # Cookie fallback (backwards compat)
    token = request.cookies.get(auth.COOKIE_NAME)
    if not token:
        return None
    return auth.validate_token(token)


def _require_auth(request: Request) -> dict:
    """FastAPI-style auth check. Raises 401 if not authenticated."""
    device = _get_device(request)
    if not device:
        raise HTTPException(status_code=401, detail="Authentication required")
    if device["device_id"] not in ("anonymous", "daemon"):
        auth.update_last_seen(device["device_id"])
    return device


def _get_ws_device(ws: WebSocket) -> Optional[dict]:
    """Extract device from WebSocket upgrade.

    Checks (in order):
    1. vmux_token cookie (browser auto-sends cookies on WS upgrade)
    2. Sec-WebSocket-Protocol header used as token carrier (non-standard workaround)
    """
    if not AUTH_ENABLED:
        return {"device_id": "anonymous", "device_name": "anonymous"}
    token = ws.cookies.get(auth.COOKIE_NAME)
    if token:
        return auth.validate_token(token)
    # Subprotocol token trick — client sends "vmux-token.<jwt>" as a subprotocol
    for proto in ws.headers.get("sec-websocket-protocol", "").split(","):
        proto = proto.strip()
        if proto.startswith("vmux-token."):
            token = proto[len("vmux-token."):]
            payload = auth.validate_token(token)
            if payload:
                return payload
    return None


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

# Mount MCP SSE app for Claude Code sessions, wrapped with ASGI error
# resilience to prevent fastmcp SSE disconnection errors from crashing
# the entire server (known fastmcp issue: jlowin/fastmcp#671).
class _MCPErrorGuard:
    """ASGI middleware that catches RuntimeError from fastmcp SSE disconnects."""

    def __init__(self, app):
        self._app = app

    async def __call__(self, scope, receive, send):
        try:
            await self._app(scope, receive, send)
        except RuntimeError as e:
            if "Expected ASGI message" in str(e) or "Unexpected ASGI message" in str(e):
                import logging
                logging.getLogger("relay.mcp").warning(
                    f"Suppressed fastmcp SSE disconnect error: {e}"
                )
            else:
                raise

app.mount("/mcp", _MCPErrorGuard(mcp_tools.create_mcp_app()))


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

    # Return token in body so web app can store it for Authorization: Bearer header.
    # Also set cookie for WebSocket handshake auth (browsers auto-send cookies).
    response = JSONResponse({
        "success": True,
        "device_id": device_id,
        "device_name": device_name,
        "token": token,
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


@app.get("/api/settings")
async def get_settings(request: Request):
    """Get current configurable settings."""
    _require_auth(request)
    from config import get_setting
    voices = await _fetch_kokoro_voices()
    return JSONResponse({
        "kokoro_voice": get_setting("kokoro_voice"),
        "kokoro_speed": get_setting("kokoro_speed"),
        "available_voices": voices,
    })


@app.patch("/api/settings")
async def update_settings(request: Request):
    """Update settings. Changes take effect immediately and are persisted to env file."""
    _require_auth(request)
    body = await request.json()
    from config import update_setting, get_setting, _persist_settings

    updated = {}
    if "kokoro_voice" in body:
        update_setting("kokoro_voice", body["kokoro_voice"])
        updated["kokoro_voice"] = body["kokoro_voice"]
    if "kokoro_speed" in body:
        speed = float(body["kokoro_speed"])
        update_setting("kokoro_speed", speed)
        updated["kokoro_speed"] = speed

    if updated:
        _persist_settings()

    return JSONResponse({"ok": True, "updated": updated})


@app.get("/api/services")
async def list_services(request: Request):
    """List managed services and their status via daemon IPC."""
    _require_auth(request)
    result = await _daemon_ipc({"cmd": "status"})
    return JSONResponse({"services": result.get("services", {})})


@app.post("/api/services/{name}/restart")
async def restart_service(name: str, request: Request):
    """Restart a managed service via daemon IPC."""
    _require_auth(request)
    result = await _daemon_ipc({"cmd": "restart", "service": name})
    if result.get("ok"):
        return JSONResponse({"ok": True})
    return JSONResponse({"error": result.get("error", "Restart failed")}, status_code=500)


@app.get("/api/sessions")
async def list_sessions(request: Request):
    """List all registered Claude Code sessions."""
    _require_auth(request)
    sessions = await registry.list_sessions()
    return JSONResponse({"sessions": sessions})


async def _daemon_ipc(cmd: dict) -> dict:
    """Send a command to vmuxd via Unix socket. Returns response dict."""
    import asyncio as _asyncio
    SOCKET_PATH = "/tmp/vmuxd.sock"
    try:
        reader, writer = await _asyncio.wait_for(
            _asyncio.open_unix_connection(SOCKET_PATH), timeout=5.0
        )
        writer.write((json.dumps(cmd) + "\n").encode())
        await writer.drain()
        line = await _asyncio.wait_for(reader.readline(), timeout=10.0)
        writer.close()
        await writer.wait_closed()
        return json.loads(line.decode().strip())
    except FileNotFoundError:
        return {"ok": False, "error": "vmuxd is not running"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/api/sessions/spawn")
async def spawn_session(request: Request):
    """Spawn a new Claude session in a given directory (requires daemon)."""
    _require_auth(request)
    body = await request.json()
    cwd = body.get("cwd", "").strip()
    if not cwd:
        return JSONResponse({"error": "cwd is required"}, status_code=400)
    result = await _daemon_ipc({"cmd": "spawn", "cwd": cwd})
    if result.get("ok"):
        return JSONResponse(result)
    return JSONResponse({"error": result.get("error", "Spawn failed")}, status_code=500)


@app.delete("/api/sessions/{session_id}")
async def kill_session(session_id: str, request: Request):
    """Kill a spawned Claude session (requires daemon)."""
    _require_auth(request)
    result = await _daemon_ipc({"cmd": "kill", "session_id": session_id})
    if result.get("ok"):
        # Also unregister from the relay registry
        await registry.unregister(session_id)
        await _broadcast_sessions()
        return JSONResponse({"success": True})
    return JSONResponse({"error": result.get("error", "Kill failed")}, status_code=500)


@app.post("/api/sessions/{session_id}/interrupt")
async def interrupt_session(session_id: str, request: Request):
    """Send hard interrupt to a session via daemon (Ctrl-C + re-enter standby)."""
    _require_auth(request)
    result = await _daemon_ipc({"cmd": "hard-interrupt", "session_id": session_id})
    if result.get("ok"):
        return JSONResponse({"success": True})
    return JSONResponse({"error": result.get("error", "Interrupt failed")}, status_code=500)


@app.post("/api/sessions/{session_id}/restart")
async def restart_session_endpoint(session_id: str, request: Request):
    """Kill + respawn a session via daemon."""
    _require_auth(request)
    result = await _daemon_ipc({"cmd": "restart-session", "session_id": session_id})
    if result.get("ok"):
        return JSONResponse(result)
    return JSONResponse({"error": result.get("error", "Restart failed")}, status_code=500)

@app.post("/api/sessions/reconnect")
async def reconnect_session_endpoint(request: Request):
    """Send reconnect attempt to a session via daemon.

    Accepts session_id (preferred) or cwd (fallback) to identify the session.
    """
    _require_auth(request)
    body = await request.json()
    session_id = body.get("session_id", "").strip()
    cwd = body.get("cwd", "").strip()
    if not session_id and not cwd:
        return JSONResponse({"error": "session_id or cwd is required"}, status_code=400)
    result = await _daemon_ipc({"cmd": "reconnect-session", "session_id": session_id, "cwd": cwd})
    if result.get("ok"):
        return JSONResponse(result)
    return JSONResponse({"error": result.get("error", "Reconnect failed")}, status_code=500)

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
    # Use wss when behind a TLS-terminating proxy (e.g. ngrok)
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

            elif msg_type == "capture_terminal":
                # Capture terminal snapshot from daemon — bypasses Claude entirely
                if connected_session_id:
                    lines = int(data.get("lines", 50))
                    result = await _daemon_ipc({
                        "cmd": "capture-terminal",
                        "session_id": connected_session_id,
                        "lines": lines,
                    })
                    if result.get("ok"):
                        await ws.send_text(json.dumps({
                            "type": "terminal_snapshot",
                            "session_id": connected_session_id,
                            "content": result["output"],
                            "timestamp": time.time(),
                        }))
                    else:
                        await ws.send_text(json.dumps({
                            "type": "terminal_snapshot",
                            "session_id": connected_session_id,
                            "content": None,
                            "error": result.get("error", "Capture failed"),
                            "timestamp": time.time(),
                        }))

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


async def _get_daemon_session_health() -> dict[str, str]:
    """Fetch session health info from the daemon. Returns {relay_session_id: health_status}."""
    try:
        result = await _daemon_ipc({"cmd": "list"})
        if result.get("ok"):
            return {
                s["relay_session_id"]: s["status"]
                for s in result.get("sessions", [])
                if s.get("relay_session_id")
            }
    except Exception:
        pass
    return {}


async def _broadcast_sessions():
    """Send updated session list to all connected web clients."""
    sessions = await registry.list_sessions()
    # Augment with daemon health info if available
    try:
        health_map = await _get_daemon_session_health()
        if health_map:
            for s in sessions:
                sid = s.get("session_id")
                if sid in health_map:
                    s["health"] = health_map[sid]
                    s["daemon_managed"] = True
    except Exception:
        pass
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
            resp = await client.request(
                method=request.method,
                url=target,
                content=await request.body(),
                headers={k: v for k, v in request.headers.items() if k.lower() not in ("host", "transfer-encoding")},
            )
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
    """StaticFiles with concurrency limiting and cache control headers."""

    async def __call__(self, scope, receive, send):
        async def send_with_cache(message):
            if message.get("type") == "http.response.start":
                path = scope.get("path", "")
                headers = dict(message.get("headers", []))
                # Hashed assets (e.g. /assets/index-abc123.js) can be cached forever
                if "/assets/" in path:
                    message["headers"] = list(message.get("headers", [])) + [
                        (b"cache-control", b"public, max-age=31536000, immutable"),
                    ]
                else:
                    # HTML and other files: always revalidate
                    message["headers"] = list(message.get("headers", [])) + [
                        (b"cache-control", b"no-cache"),
                    ]
            await send(message)

        async with _static_file_semaphore:
            await super().__call__(scope, receive, send_with_cache)

# VMUX_WEB_DIST lets the daemon point to a managed path that auto-updates can replace.
# Falls back to the path relative to this file (dev / source-tree installs).
_web_dist_env = os.environ.get("VMUX_WEB_DIST", "")
web_dist = Path(_web_dist_env) if _web_dist_env else Path(__file__).parent.parent / "web" / "dist"
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
    import uvicorn
    uvicorn.run(app, host=RELAY_HOST, port=RELAY_PORT)
