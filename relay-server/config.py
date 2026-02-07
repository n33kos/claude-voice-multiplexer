"""Relay server configuration."""

import os

RELAY_HOST = os.environ.get("RELAY_HOST", "0.0.0.0")
RELAY_PORT = int(os.environ.get("RELAY_PORT", "3100"))

WHISPER_URL = os.environ.get("WHISPER_URL", "http://127.0.0.1:2022/v1")
KOKORO_URL = os.environ.get("KOKORO_URL", "http://127.0.0.1:8880/v1")

LIVEKIT_URL = os.environ.get("LIVEKIT_URL", "ws://localhost:7880")
LIVEKIT_API_KEY = os.environ.get("LIVEKIT_API_KEY", "devkey")
LIVEKIT_API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "secret")

# Session registry
SESSION_TIMEOUT = 60  # seconds without heartbeat before session is removed

# Audio
WHISPER_MODEL = "whisper-1"
KOKORO_VOICE = os.environ.get("KOKORO_VOICE", "am_adam(0.3)+hm_omega(0.7)")
KOKORO_MODEL = "tts-1"
SAMPLE_RATE = 24000
