#!/usr/bin/env python3
"""
Lightweight HTTP server that:
1. Serves the LiveKit web client (client/index.html) for iPhone access
2. Provides a /token endpoint that generates real LiveKit JWT access tokens

This bypasses two bugs in voicemode's bundled frontend:
- Hardcoded LIVEKIT_URL in the compiled Next.js route
- Dummy token in the Python production server
"""

import json
import os
import sys
import time
import math
import hmac
import hashlib
import base64
import random
import socket
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

# Configuration (matches LiveKit dev mode defaults)
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY", "devkey")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET", "secret")
LIVEKIT_URL = os.getenv("LIVEKIT_URL", "ws://localhost:7880")
ACCESS_PASSWORD = os.getenv("LIVEKIT_ACCESS_PASSWORD", "voicemode123")
HOST = os.getenv("RELAY_HOST", "0.0.0.0")
PORT = int(os.getenv("RELAY_PORT", "3100"))

CLIENT_DIR = Path(__file__).parent / "client"


def base64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def generate_livekit_token(
    identity: str,
    room: str,
    api_key: str = LIVEKIT_API_KEY,
    api_secret: str = LIVEKIT_API_SECRET,
    ttl_seconds: int = 900,
) -> str:
    """Generate a LiveKit access token (JWT) with room join grants.

    Uses manual JWT construction to avoid extra dependencies.
    LiveKit tokens are standard HS256 JWTs with specific claim structure.
    """
    now = int(time.time())

    header = {"alg": "HS256", "typ": "JWT"}

    payload = {
        "iss": api_key,
        "sub": identity,
        "iat": now,
        "nbf": now,
        "exp": now + ttl_seconds,
        "jti": identity,
        "video": {
            "room": room,
            "roomJoin": True,
            "canPublish": True,
            "canPublishData": True,
            "canSubscribe": True,
        },
    }

    header_b64 = base64url_encode(json.dumps(header, separators=(",", ":")).encode())
    payload_b64 = base64url_encode(json.dumps(payload, separators=(",", ":")).encode())

    signing_input = f"{header_b64}.{payload_b64}"
    signature = hmac.new(
        api_secret.encode(), signing_input.encode(), hashlib.sha256
    ).digest()
    signature_b64 = base64url_encode(signature)

    return f"{header_b64}.{payload_b64}.{signature_b64}"


class RelayHandler(SimpleHTTPRequestHandler):
    """HTTP handler for token generation and static file serving."""

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        if path == "/token":
            return self.handle_token(params)
        elif path == "/health":
            return self.handle_health()
        elif path == "/" or path == "/index.html":
            return self.serve_client()
        else:
            # Try to serve static files from client dir
            file_path = CLIENT_DIR / path.lstrip("/")
            if file_path.exists() and file_path.is_file():
                return self.serve_file(file_path)
            self.send_error(404)

    def handle_token(self, params):
        """Generate a LiveKit room token."""
        password = params.get("password", [""])[0]
        if password != ACCESS_PASSWORD:
            self.send_json({"error": "Unauthorized"}, status=401)
            return

        room = params.get("room", [f"relay_room_{random.randint(1000, 9999)}"])[0]
        identity = params.get("identity", [f"phone_user_{random.randint(1000, 9999)}"])[0]

        token = generate_livekit_token(identity=identity, room=room)

        self.send_json({
            "token": token,
            "serverUrl": LIVEKIT_URL,
            "room": room,
            "identity": identity,
        })

    def handle_health(self):
        self.send_json({"status": "ok", "livekit_url": LIVEKIT_URL})

    def serve_client(self):
        index = CLIENT_DIR / "index.html"
        if not index.exists():
            self.send_error(404, "Client not found. Ensure client/index.html exists.")
            return
        self.serve_file(index, content_type="text/html")

    def serve_file(self, file_path, content_type=None):
        try:
            content = file_path.read_bytes()
            if not content_type:
                ext = file_path.suffix.lower()
                content_types = {
                    ".html": "text/html",
                    ".js": "application/javascript",
                    ".css": "text/css",
                    ".json": "application/json",
                    ".png": "image/png",
                    ".svg": "image/svg+xml",
                    ".ico": "image/x-icon",
                }
                content_type = content_types.get(ext, "application/octet-stream")

            self.send_response(200)
            self.send_header("Content-Type", f"{content_type}; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(content)
        except Exception as e:
            self.send_error(500, str(e))

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        """Quieter logging."""
        if "/health" not in (args[0] if args else ""):
            print(f"[relay] {args[0]}" if args else "")


def get_lan_ip():
    """Get the machine's LAN IP address."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "localhost"


def main():
    lan_ip = get_lan_ip()

    print(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"  Claude Voice Relay - Token Server")
    print(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"  Server:    http://{HOST}:{PORT}")
    print(f"  LAN URL:   http://{lan_ip}:{PORT}")
    print(f"  LiveKit:   {LIVEKIT_URL}")
    print(f"  Password:  {ACCESS_PASSWORD}")
    print(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"\n  Open on iPhone: http://{lan_ip}:{PORT}\n")

    server = HTTPServer((HOST, PORT), RelayHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
