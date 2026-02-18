"""Relay server configuration.

All settings can be overridden via environment variables.
Configuration is loaded from ~/.claude/voice-multiplexer/voice-multiplexer.env.
"""

import os
from pathlib import Path

# Load voice-multiplexer.env from the data directory
_env_path = Path.home() / ".claude" / "voice-multiplexer" / "voice-multiplexer.env"
try:
    from dotenv import load_dotenv
    load_dotenv(_env_path)
except ImportError:
    pass

# --- Server ---
RELAY_HOST = os.environ.get("RELAY_HOST", "0.0.0.0")
RELAY_PORT = int(os.environ.get("RELAY_PORT", "3100"))

# --- External services ---
WHISPER_URL = os.environ.get("WHISPER_URL", "http://127.0.0.1:8100/v1")
KOKORO_URL = os.environ.get("KOKORO_URL", "http://127.0.0.1:8101/v1")

# --- LiveKit ---
LIVEKIT_URL = os.environ.get("LIVEKIT_URL", "ws://localhost:7880")
LIVEKIT_API_KEY = os.environ.get("LIVEKIT_API_KEY", "")
LIVEKIT_API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "")

# --- Session registry ---
SESSION_TIMEOUT = int(os.environ.get("SESSION_TIMEOUT", "600"))

# --- Audio / TTS ---
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "whisper-1")
KOKORO_VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
KOKORO_MODEL = os.environ.get("KOKORO_MODEL", "tts-1")
KOKORO_SPEED = float(os.environ.get("KOKORO_SPEED", "1.0"))
STT_SAMPLE_RATE = int(os.environ.get("STT_SAMPLE_RATE", "16000"))  # Incoming audio (capture/VAD/Whisper)
TTS_SAMPLE_RATE = int(os.environ.get("TTS_SAMPLE_RATE", "24000"))  # Outgoing audio (Kokoro TTS)

# --- Authentication ---
AUTH_SECRET = os.environ.get("AUTH_SECRET", "")
AUTH_TOKEN_TTL_DAYS = int(os.environ.get("AUTH_TOKEN_TTL_DAYS", "90"))
AUTH_ENABLED = bool(AUTH_SECRET)

# --- VAD (Voice Activity Detection) ---
VAD_AGGRESSIVENESS = int(os.environ.get("VAD_AGGRESSIVENESS", "2"))  # 0=permissive, 3=strict
SILENCE_THRESHOLD_MS = int(os.environ.get("SILENCE_THRESHOLD_MS", "2500"))
MIN_SPEECH_DURATION_S = float(os.environ.get("MIN_SPEECH_DURATION_S", "0.5"))
ECHO_COOLDOWN_S = float(os.environ.get("ECHO_COOLDOWN_S", "0.8"))
ENERGY_THRESHOLD = int(os.environ.get("ENERGY_THRESHOLD", "500"))
MAX_RECORDING_S = float(os.environ.get("MAX_RECORDING_S", "180"))  # 3 minutes
