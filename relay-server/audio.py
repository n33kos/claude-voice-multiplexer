"""Audio pipeline: Whisper STT and Kokoro TTS via OpenAI-compatible APIs."""

import io
import httpx

from config import WHISPER_URL, KOKORO_URL, WHISPER_MODEL, KOKORO_VOICE, KOKORO_MODEL


async def transcribe(audio_data: bytes, audio_format: str = "webm") -> str | None:
    """Transcribe audio using Whisper via OpenAI-compatible API.

    Args:
        audio_data: Raw audio bytes
        audio_format: Audio format (webm, wav, mp3, etc.)

    Returns:
        Transcribed text or None on failure
    """
    url = f"{WHISPER_URL}/audio/transcriptions"

    async with httpx.AsyncClient(timeout=30.0) as client:
        files = {
            "file": (f"audio.{audio_format}", io.BytesIO(audio_data), f"audio/{audio_format}"),
        }
        data = {
            "model": WHISPER_MODEL,
        }

        try:
            response = await client.post(url, files=files, data=data)
            response.raise_for_status()
            result = response.json()
            return result.get("text", "").strip()
        except Exception as e:
            print(f"STT error: {e}")
            return None


async def synthesize(text: str, voice: str | None = None) -> bytes | None:
    """Synthesize speech using Kokoro via OpenAI-compatible API.

    Args:
        text: Text to synthesize
        voice: Voice to use (defaults to configured voice)

    Returns:
        Audio bytes (opus format) or None on failure
    """
    url = f"{KOKORO_URL}/audio/speech"

    async with httpx.AsyncClient(timeout=30.0) as client:
        payload = {
            "model": KOKORO_MODEL,
            "input": text,
            "voice": voice or KOKORO_VOICE,
            "response_format": "opus",
        }

        try:
            response = await client.post(url, json=payload)
            response.raise_for_status()
            return response.content
        except Exception as e:
            print(f"TTS error: {e}")
            return None
