"""Contract tests: drive the real relay app (HTTP + /ws/client) in-process.

Needs the relay's dependencies, so run it through uv:

    cd relay-server && uv run --python 3.12 --with-requirements requirements.txt \\
        --with pytest pytest test_server_contract.py

Plain `pytest` without those dependencies skips this file.  HOME points at a
temp dir before the relay is imported, so tests never touch the real
~/.claude/voice-multiplexer (paired devices, metadata DB, env file).
"""

import json
import os
import sys
import tempfile

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("livekit")

_TMP_HOME = tempfile.mkdtemp(prefix="vmux-test-home-")
os.environ["HOME"] = _TMP_HOME
os.environ["AUTH_SECRET"] = "test-auth-secret"
os.environ["DAEMON_SECRET"] = "test-daemon-secret"
os.environ["VMUX_WEB_DIST"] = os.path.join(_TMP_HOME, "no-web-dist")
os.environ["VMUX_ALLOWED_ORIGINS"] = "http://localhost:5173"
sys.path.insert(0, os.path.dirname(__file__))

# Other test modules may have imported config/auth already (reading the real
# HOME's env file); reload so they see the temp HOME and the env above.
import importlib  # noqa: E402

for _mod in ("config", "auth"):
    if _mod in sys.modules:
        importlib.reload(sys.modules[_mod])
assert "server" not in sys.modules, "server must be imported after the env is set"

from starlette.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

import auth  # noqa: E402
import server  # noqa: E402
from registry import Session  # noqa: E402

DAEMON = {"X-Daemon-Secret": "test-daemon-secret"}
SID = "abc123def456"


@pytest.fixture()
def client():
    server.registry._sessions.clear()
    server._transcript_buffers.clear()
    server._open_streams.clear()
    server.registry._sessions[SID] = Session(session_id=SID, name="proj", cwd="/p/proj", dir_name="proj")
    return TestClient(server.app, base_url="http://localhost:3100")


@pytest.fixture()
def token():
    auth.register_device("dev-test", "test device")
    return auth.issue_token("dev-test", "test device")


def _recv_until(ws, msg_type, limit=20):
    for _ in range(limit):
        msg = json.loads(ws.receive_text())
        if msg.get("type") == msg_type:
            return msg
    raise AssertionError(f"no {msg_type} message")


# --- auth / origin ---------------------------------------------------------


def test_ws_requires_auth(client):
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/ws/client") as ws:
            ws.receive_text()
    assert exc.value.code == 4001


def test_ws_with_cookie_gets_session_list(client, token):
    client.cookies.set("vmux_token", token)
    with client.websocket_connect("/ws/client") as ws:
        msg = json.loads(ws.receive_text())
        assert msg["type"] == "sessions"
        assert [s["session_id"] for s in msg["sessions"]] == [SID]


def test_ws_rejects_foreign_origin_even_with_valid_cookie(client, token):
    client.cookies.set("vmux_token", token)
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/ws/client", headers={"Origin": "http://localhost:9999"}) as ws:
            ws.receive_text()
    assert exc.value.code == 4003


def test_ws_accepts_same_and_allowlisted_origins(client, token):
    client.cookies.set("vmux_token", token)
    for origin in ("http://localhost:3100", "http://localhost:5173"):
        # Full URL: TestClient otherwise sends Host "testserver" for websockets.
        with client.websocket_connect("ws://localhost:3100/ws/client", headers={"Origin": origin}) as ws:
            assert json.loads(ws.receive_text())["type"] == "sessions"


def test_rest_rejects_foreign_origin(client, token):
    r = client.get("/api/sessions", headers={"Authorization": f"Bearer {token}", "Origin": "https://evil.example"})
    assert r.status_code == 403


def test_revoked_device_cannot_connect(client, token):
    auth.revoke_device("dev-test")
    client.cookies.set("vmux_token", token)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/client") as ws:
            ws.receive_text()


# --- sessions --------------------------------------------------------------


def test_connect_session_and_not_found(client, token):
    client.cookies.set("vmux_token", token)
    with client.websocket_connect("/ws/client") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"type": "connect_session", "session_id": SID}))
        msg = _recv_until(ws, "session_connected")
        assert msg == {"type": "session_connected", "session_id": SID, "session_name": "proj"}
        ws.send_text(json.dumps({"type": "connect_session", "session_id": "nope"}))
        assert _recv_until(ws, "session_not_found")["session_id"] == "nope"


def test_ping_is_answered_by_client_pong_without_error(client, token):
    client.cookies.set("vmux_token", token)
    with client.websocket_connect("/ws/client") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"type": "pong"}))
        ws.send_text(json.dumps({"type": "connect_session", "session_id": SID}))
        _recv_until(ws, "session_connected")


# --- streamed messages -------------------------------------------------------


def test_stream_broadcasts_deltas_with_message_id_and_replays_merged(client, token):
    client.cookies.set("vmux_token", token)
    deltas = ["Intro:\n\n", "- a\n- b\n\n", "Done."]
    with client.websocket_connect("/ws/client") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"type": "connect_session", "session_id": SID}))
        _recv_until(ws, "session_connected")
        for i, d in enumerate(deltas):
            r = client.post(
                f"/api/sessions/{SID}/stream",
                headers=DAEMON,
                json={"message_id": "m1", "index": i, "final": i == len(deltas) - 1, "delta": d},
            )
            assert r.status_code == 200
            msg = _recv_until(ws, "transcript")
            assert (msg["speaker"], msg["text"], msg["message_id"]) == ("claude", d, "m1")

    with client.websocket_connect("/ws/client") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"type": "connect_session", "session_id": SID}))
        sync = _recv_until(ws, "transcript_sync")
        merged = [e for e in sync["entries"] if e.get("message_id") == "m1"]
        assert len(merged) == 1
        assert merged[0]["text"] == "".join(deltas)


def test_stream_requires_auth(client):
    r = client.post(f"/api/sessions/{SID}/stream", json={"message_id": "m1", "delta": "x"})
    assert r.status_code == 401


# --- speech audio ------------------------------------------------------------


def test_audio_frames_go_only_to_subscribed_clients(client, token):
    from speech_stream import decode_audio_frame, encode_audio_frame

    client.cookies.set("vmux_token", token)
    frame = encode_audio_frame({"utterance_id": "u1", "seq": 0, "offset_samples": 0}, b"\x00\x01" * 4)
    with client.websocket_connect("/ws/client") as sub, client.websocket_connect("/ws/client") as plain:
        for ws in (sub, plain):
            ws.receive_text()
            ws.send_text(json.dumps({"type": "connect_session", "session_id": SID}))
            _recv_until(ws, "session_connected")
        sub.send_text(json.dumps({"type": "audio_subscribe", "enabled": True}))
        # Round-trip a message so the subscribe is processed before sending audio.
        sub.send_text(json.dumps({"type": "connect_session", "session_id": SID}))
        _recv_until(sub, "session_connected")

        sub.portal.call(server._notify_client_audio, SID, frame)
        sub.portal.call(server._notify_client_event, SID, {"type": "speech_end", "utterance_id": "u1"})

        msg = sub.receive()
        while msg.get("bytes") is None:  # skip interleaved JSON (session broadcasts)
            msg = sub.receive()
        assert decode_audio_frame(msg["bytes"])[0]["utterance_id"] == "u1"
        assert _recv_until(sub, "speech_end")["utterance_id"] == "u1"
        # The unsubscribed client sees the JSON event but never the audio.
        msg = plain.receive()
        while "text" in msg and json.loads(msg["text"])["type"] != "speech_end":
            msg = plain.receive()
        assert "bytes" not in msg or msg.get("bytes") is None
