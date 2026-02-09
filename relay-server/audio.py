"""Audio pipeline: Whisper STT and Kokoro TTS via OpenAI-compatible APIs."""

import io
from collections.abc import AsyncGenerator

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


async def synthesize(text: str, voice: str | None = None, response_format: str = "opus") -> bytes | None:
    """Synthesize speech using Kokoro via OpenAI-compatible API.

    Args:
        text: Text to synthesize
        voice: Voice to use (defaults to configured voice)
        response_format: Audio format (opus, pcm, wav, mp3)

    Returns:
        Audio bytes or None on failure
    """
    url = f"{KOKORO_URL}/audio/speech"

    async with httpx.AsyncClient(timeout=30.0) as client:
        payload = {
            "model": KOKORO_MODEL,
            "input": text,
            "voice": voice or KOKORO_VOICE,
            "response_format": response_format,
        }

        try:
            response = await client.post(url, json=payload)
            response.raise_for_status()
            return response.content
        except Exception as e:
            print(f"TTS error: {e}")
            return None


async def synthesize_pcm(text: str, voice: str | None = None) -> bytes | None:
    """Synthesize speech as raw PCM (16-bit mono, 24kHz) for LiveKit publishing."""
    return await synthesize(text, voice, response_format="pcm")


async def synthesize_pcm_stream(
    text: str, voice: str | None = None, chunk_size: int = 4800
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
        "voice": voice or KOKORO_VOICE,
        "response_format": "pcm",
        "stream": True,
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            async with client.stream("POST", url, json=payload) as response:
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
