"""Audio pipeline: Whisper STT and Kokoro TTS via OpenAI-compatible APIs."""

import io
from collections.abc import AsyncGenerator
from typing import Optional

import httpx

import config
from config import WHISPER_URL, KOKORO_URL, WHISPER_MODEL, KOKORO_MODEL

# Shared HTTP client — set by server.py at startup via set_http_client().
# Falls back to creating a per-request client if not set (e.g. standalone usage).
_http_client: Optional[httpx.AsyncClient] = None


def set_http_client(client: httpx.AsyncClient) -> None:
    """Set the shared httpx client (called by server.py at startup)."""
    global _http_client
    _http_client = client


def _get_client() -> httpx.AsyncClient:
    """Get the shared client, or raise if not initialized."""
    if _http_client is None:
        raise RuntimeError("HTTP client not initialized — call set_http_client() first")
    return _http_client


async def transcribe(audio_data: bytes, audio_format: str = "webm") -> Optional[str]:
    """Transcribe audio using Whisper via OpenAI-compatible API.

    Args:
        audio_data: Raw audio bytes
        audio_format: Audio format (webm, wav, mp3, etc.)

    Returns:
        Transcribed text or None on failure
    """
    url = f"{WHISPER_URL}/audio/transcriptions"
    client = _get_client()

    files = {
        "file": (f"audio.{audio_format}", io.BytesIO(audio_data), f"audio/{audio_format}"),
    }
    data = {
        "model": WHISPER_MODEL,
    }

    try:
        response = await client.post(url, files=files, data=data, timeout=30.0)
        response.raise_for_status()
        result = response.json()
        return result.get("text", "").strip()
    except Exception as e:
        print(f"STT error: {e}")
        return None


async def synthesize(text: str, voice: Optional[str] = None, response_format: str = "opus") -> Optional[bytes]:
    """Synthesize speech using Kokoro via OpenAI-compatible API.

    Args:
        text: Text to synthesize
        voice: Voice to use (defaults to configured voice)
        response_format: Audio format (opus, pcm, wav, mp3)

    Returns:
        Audio bytes or None on failure
    """
    url = f"{KOKORO_URL}/audio/speech"
    client = _get_client()

    payload = {
        "model": KOKORO_MODEL,
        "input": text,
        "voice": voice or config.get_setting("kokoro_voice"),
        "response_format": response_format,
        "speed": config.get_setting("kokoro_speed"),
    }

    try:
        response = await client.post(url, json=payload, timeout=30.0)
        response.raise_for_status()
        return response.content
    except Exception as e:
        print(f"TTS error: {e}")
        return None


async def synthesize_pcm(text: str, voice: Optional[str] = None) -> Optional[bytes]:
    """Synthesize speech as raw PCM (16-bit mono, 24kHz) for LiveKit publishing."""
    return await synthesize(text, voice, response_format="pcm")


async def synthesize_pcm_stream(
    text: str, voice: Optional[str] = None, chunk_size: int = 4800
) -> AsyncGenerator[bytes, None]:
    """Stream PCM audio chunks from Kokoro as they're generated.

    Args:
        text: Text to synthesize
        voice: Voice to use (defaults to configured voice)
        chunk_size: Bytes per yielded chunk (default 4800 = 100ms at 24kHz 16-bit mono)

    Yields:
        PCM byte chunks (16-bit mono, 24kHz)
    """
    url = f"{KOKORO_URL}/audio/speech"
    payload = {
        "model": KOKORO_MODEL,
        "input": text,
        "voice": voice or config.get_setting("kokoro_voice"),
        "response_format": "pcm",
        "speed": config.get_setting("kokoro_speed"),
        "stream": True,
    }

    client = _get_client()
    try:
        async with client.stream("POST", url, json=payload, timeout=60.0) as response:
            response.raise_for_status()
            buffer = bytearray()
            async for raw_chunk in response.aiter_bytes():
                buffer.extend(raw_chunk)
                while len(buffer) >= chunk_size:
                    yield bytes(buffer[:chunk_size])
                    del buffer[:chunk_size]
            # Yield any remaining bytes
            if buffer:
                yield bytes(buffer)
    except Exception as e:
        print(f"TTS stream error: {e}")
        return
