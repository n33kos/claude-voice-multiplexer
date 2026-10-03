"""Speech events for clients: what Claude is saying, word timings, and audio.

Each TTS utterance (one queued response) produces, for clients connected to
the session:

    {type: "speech_start", session_id, utterance_id, message_id, text, sample_rate}
    {type: "speech_chunk", session_id, utterance_id, seq, offset_s, duration_s, words}
    {type: "speech_end",   session_id, utterance_id, cancelled, duration_s}

`words` are [{word, start, end}] in seconds from the start of the utterance,
so a client that knows when the utterance's first sample played can place
every word exactly.  `message_id` ties the utterance to the streamed
transcript entry it was spoken from (null for other TTS sources).

Clients that send {type: "audio_subscribe", enabled: true} also receive the
PCM itself as binary WebSocket frames (see encode_audio_frame), so they can
play it with sample-accurate timing instead of through LiveKit.
"""

import json
import struct
import uuid
from typing import Awaitable, Callable, Optional

AUDIO_FRAME_MAGIC = b"VMXA"
AUDIO_FRAME_VERSION = 1
SAMPLE_RATE = 24_000  # Kokoro PCM: 16-bit mono
BYTES_PER_SAMPLE = 2

NotifyEvent = Callable[[str, dict], Awaitable[None]]
NotifyAudio = Callable[[str, bytes], Awaitable[None]]


def encode_audio_frame(header: dict, pcm: bytes) -> bytes:
    """Binary audio frame: b"VMXA", u8 version, u32be header length, JSON header, s16le PCM."""
    head = json.dumps(header, separators=(",", ":")).encode()
    return AUDIO_FRAME_MAGIC + struct.pack(">BI", AUDIO_FRAME_VERSION, len(head)) + head + pcm


def decode_audio_frame(frame: bytes) -> tuple[dict, bytes]:
    """Inverse of encode_audio_frame (used by tests and Python clients)."""
    if frame[:4] != AUDIO_FRAME_MAGIC:
        raise ValueError("not a vmux audio frame")
    version, head_len = struct.unpack(">BI", frame[4:9])
    if version != AUDIO_FRAME_VERSION:
        raise ValueError(f"unsupported audio frame version {version}")
    header = json.loads(frame[9:9 + head_len])
    return header, frame[9 + head_len:]


def normalize_words(raw: list[dict]) -> list[dict]:
    """Kokoro {word, start_time, end_time} → {word, start, end}, clamped to >= 0."""
    out = []
    for w in raw or []:
        try:
            start = max(0.0, float(w["start_time"]))
            end = max(start, float(w["end_time"]))
        except (KeyError, TypeError, ValueError):
            continue
        out.append({"word": str(w.get("word", "")), "start": round(start, 4), "end": round(end, 4)})
    return out


class SpeechEmitter:
    """Emits the speech_* events (and audio frames) for one utterance."""

    def __init__(
        self,
        session_id: str,
        notify_event: Optional[NotifyEvent],
        notify_audio: Optional[NotifyAudio] = None,
    ):
        self.session_id = session_id
        self._notify_event = notify_event
        self._notify_audio = notify_audio
        self.utterance_id = uuid.uuid4().hex[:12]
        self._seq = 0
        self._samples = 0
        self._ended = False

    @property
    def duration_s(self) -> float:
        return self._samples / SAMPLE_RATE

    async def _event(self, payload: dict):
        if self._notify_event:
            try:
                await self._notify_event(self.session_id, payload)
            except Exception as e:
                print(f"[speech] event send failed: {e}")

    async def start(self, text: str, message_id: Optional[str] = None):
        await self._event({
            "type": "speech_start",
            "session_id": self.session_id,
            "utterance_id": self.utterance_id,
            "message_id": message_id,
            "text": text,
            "sample_rate": SAMPLE_RATE,
        })

    async def chunk(self, pcm: bytes, words: list[dict]):
        """Announce one synthesized chunk (and send its audio to subscribers)."""
        n = len(pcm) // BYTES_PER_SAMPLE
        offset = self._samples
        seq = self._seq
        self._seq += 1
        self._samples += n
        await self._event({
            "type": "speech_chunk",
            "session_id": self.session_id,
            "utterance_id": self.utterance_id,
            "seq": seq,
            "offset_s": round(offset / SAMPLE_RATE, 4),
            "duration_s": round(n / SAMPLE_RATE, 4),
            "words": words,
        })
        if self._notify_audio and pcm:
            frame = encode_audio_frame({
                "session_id": self.session_id,
                "utterance_id": self.utterance_id,
                "seq": seq,
                "offset_samples": offset,
                "sample_rate": SAMPLE_RATE,
                "channels": 1,
                "format": "s16le",
            }, pcm)
            try:
                await self._notify_audio(self.session_id, frame)
            except Exception as e:
                print(f"[speech] audio send failed: {e}")

    async def end(self, cancelled: bool = False):
        """Close the utterance.  Idempotent: only the first call is sent."""
        if self._ended:
            return
        self._ended = True
        await self._event({
            "type": "speech_end",
            "session_id": self.session_id,
            "utterance_id": self.utterance_id,
            "cancelled": cancelled,
            "duration_s": round(self.duration_s, 4),
        })
