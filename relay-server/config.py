"""Relay server configuration.

All settings can be overridden via environment variables.
Use a .env file in the project root for local development.
"""

import os
from pathlib import Path

# Load .env from project root if python-dotenv is available
_env_path = Path(__file__).resolve().parent.parent / ".env"
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
LIVEKIT_ROOM = os.environ.get("LIVEKIT_ROOM", "voice_relay")

# --- Session registry ---
SESSION_TIMEOUT = int(os.environ.get("SESSION_TIMEOUT", "60"))

# --- Audio / TTS ---
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "whisper-1")
KOKORO_VOICE = os.environ.get("KOKORO_VOICE", "af_default")
KOKORO_MODEL = os.environ.get("KOKORO_MODEL", "tts-1")
SAMPLE_RATE = int(os.environ.get("SAMPLE_RATE", "24000"))

# --- VAD (Voice Activity Detection) ---
VAD_AGGRESSIVENESS = int(os.environ.get("VAD_AGGRESSIVENESS", "1"))  # 0=permissive, 3=strict
SILENCE_THRESHOLD_MS = int(os.environ.get("SILENCE_THRESHOLD_MS", "2000"))
MIN_SPEECH_DURATION_S = float(os.environ.get("MIN_SPEECH_DURATION_S", "0.5"))
ECHO_COOLDOWN_S = float(os.environ.get("ECHO_COOLDOWN_S", "0.8"))
ENERGY_THRESHOLD = int(os.environ.get("ENERGY_THRESHOLD", "500"))
