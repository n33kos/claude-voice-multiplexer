"""Device authentication: JWT tokens, pairing codes, and device management."""

import json
import random
import time
import uuid
from pathlib import Path
from typing import Optional

import jwt

from config import AUTH_SECRET, AUTH_TOKEN_TTL_DAYS, AUTH_ENABLED

DEVICES_FILE = Path.home() / ".claude" / "voice-multiplexer" / "devices.json"
CODE_TTL_S = 60
COOKIE_NAME = "vmux_token"

# In-memory store for pending pairing codes: {code: {expires_at}}
_pending_codes: dict[str, dict] = {}

# Rate limiting for pairing attempts: {ip: [timestamps]}
_pair_attempts: dict[str, list[float]] = {}
PAIR_RATE_LIMIT = 5  # max attempts per window
PAIR_RATE_WINDOW = 60  # window in seconds


def _load_devices() -> list[dict]:
    try:
        if DEVICES_FILE.exists():
            return json.loads(DEVICES_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        pass
    return []


def _save_devices(devices: list[dict]):
    DEVICES_FILE.parent.mkdir(parents=True, exist_ok=True)
    DEVICES_FILE.write_text(json.dumps(devices, indent=2))


def _device_ids() -> set[str]:
    return {d["device_id"] for d in _load_devices()}


def generate_pair_code() -> str:
    """Generate a 6-digit pairing code valid for CODE_TTL_S seconds."""
    # Clean up expired codes
    now = time.time()
    expired = [c for c, v in _pending_codes.items() if v["expires_at"] < now]
    for c in expired:
        del _pending_codes[c]

    code = f"{random.randint(0, 999999):06d}"
    _pending_codes[code] = {"expires_at": now + CODE_TTL_S}
    return code


def check_pair_rate_limit(client_ip: str) -> bool:
    """Check if a client IP has exceeded the pairing attempt rate limit.

    Returns True if the request is allowed, False if rate-limited.
    """
    now = time.time()
    attempts = _pair_attempts.get(client_ip, [])
    # Prune old attempts outside the window
    attempts = [t for t in attempts if now - t < PAIR_RATE_WINDOW]
    _pair_attempts[client_ip] = attempts
    if len(attempts) >= PAIR_RATE_LIMIT:
        return False
    attempts.append(now)
    return True


def validate_pair_code(code: str) -> bool:
    """Validate and consume a pairing code. Returns True if valid."""
    entry = _pending_codes.pop(code, None)
    if not entry:
        return False
    return entry["expires_at"] >= time.time()


def issue_token(device_id: str, device_name: str) -> str:
    """Issue a JWT for an authorized device."""
    payload = {
        "device_id": device_id,
        "device_name": device_name,
        "iat": int(time.time()),
        "exp": int(time.time()) + AUTH_TOKEN_TTL_DAYS * 86400,
    }
    return jwt.encode(payload, AUTH_SECRET, algorithm="HS256")


def validate_token(token: str) -> Optional[dict]:
    """Decode and validate a JWT. Returns payload dict or None."""
    if not AUTH_ENABLED:
        return None
    try:
        payload = jwt.decode(token, AUTH_SECRET, algorithms=["HS256"])
    except (jwt.ExpiredSignatureError, jwt.InvalidTokenError):
        return None

    # Check device is still authorized
    if payload.get("device_id") not in _device_ids():
        return None

    return payload


def register_device(device_id: str, device_name: str):
    """Add a device to the authorized devices list."""
    devices = _load_devices()
    # Don't duplicate
    if any(d["device_id"] == device_id for d in devices):
        return
    devices.append({
        "device_id": device_id,
        "device_name": device_name,
        "paired_at": time.time(),
        "last_seen": time.time(),
    })
    _save_devices(devices)


def list_devices() -> list[dict]:
    """Return all authorized devices."""
    return _load_devices()


def revoke_device(device_id: str) -> bool:
    """Remove a device from the authorized list. Returns True if found."""
    devices = _load_devices()
    filtered = [d for d in devices if d["device_id"] != device_id]
    if len(filtered) == len(devices):
        return False
    _save_devices(filtered)
    return True


def update_last_seen(device_id: str):
    """Update the last_seen timestamp for a device."""
    devices = _load_devices()
    for d in devices:
        if d["device_id"] == device_id:
            d["last_seen"] = time.time()
            _save_devices(devices)
            return
