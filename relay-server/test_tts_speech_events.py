"""SessionRoom TTS → speech_* events and audio frames (no LiveKit server needed).

Needs the relay's dependencies (livekit), so run through uv; see
test_server_contract.py for the command.  Skipped otherwise.
"""

import asyncio
import os
import sys

import pytest

pytest.importorskip("livekit")
sys.path.insert(0, os.path.dirname(__file__))

import livekit_agent  # noqa: E402
from speech_stream import decode_audio_frame  # noqa: E402

PCM_1S = b"\x00\x01" * 24_000


def _room(events, frames):
    async def notify_status(*args, **kwargs):
        pass

    async def notify_transcript(*args, **kwargs):
        pass

    async def notify_event(sid, payload):
        events.append(payload)

    async def notify_audio(sid, frame):
        frames.append(frame)

    return livekit_agent.SessionRoom(
        session_id="s1",
        room_name="vmux_s1",
        registry=None,
        notify_status_fn=notify_status,
        notify_transcript_fn=notify_transcript,
        notify_client_event_fn=notify_event,
        notify_client_audio_fn=notify_audio,
    )


def _fake_stream(chunks, on_yield=None):
    async def gen(text, voice=None):
        for i, chunk in enumerate(chunks):
            yield chunk
            if on_yield:
                on_yield(i)
    return gen


def test_utterance_events_and_frames(monkeypatch):
    events, frames = [], []
    room = _room(events, frames)
    monkeypatch.setattr(livekit_agent.audio_pipeline, "synthesize_speech_stream", _fake_stream([
        (PCM_1S, [{"word": "Hello", "start": 0.0, "end": 0.4}]),
        (PCM_1S, [{"word": "again", "start": 1.0, "end": 1.4}]),
    ]))
    asyncio.run(room._play_tts_response("Hello again.", "m1"))

    assert [e["type"] for e in events] == ["speech_start", "speech_chunk", "speech_chunk", "speech_end"]
    start, c0, c1, end = events
    assert start["message_id"] == "m1" and start["text"] == "Hello again."
    assert (c0["offset_s"], c1["offset_s"]) == (0.0, 1.0)
    assert c1["words"] == [{"word": "again", "start": 1.0, "end": 1.4}]
    assert end["cancelled"] is False and end["duration_s"] == 2.0
    assert [decode_audio_frame(f)[0]["offset_samples"] for f in frames] == [0, 24_000]


def test_cancel_mid_utterance_ends_immediately(monkeypatch):
    events, frames = [], []
    room = _room(events, frames)

    def cancel_after_first(i):
        if i == 0:
            room._tts_cancel_event.set()

    monkeypatch.setattr(livekit_agent.audio_pipeline, "synthesize_speech_stream", _fake_stream(
        [(PCM_1S, []), (PCM_1S, [])], on_yield=cancel_after_first,
    ))
    asyncio.run(room._play_tts_response("Hello again.", None))

    types = [e["type"] for e in events]
    assert types.count("speech_end") == 1
    end = next(e for e in events if e["type"] == "speech_end")
    assert end["cancelled"] is True
    assert sum(1 for e in events if e["type"] == "speech_chunk") <= 1


def test_message_id_flows_through_the_response_queue(monkeypatch):
    events, frames = [], []
    room = _room(events, frames)
    monkeypatch.setattr(livekit_agent.audio_pipeline, "synthesize_speech_stream", _fake_stream([(PCM_1S, [])]))

    async def go():
        room._running = True
        worker = asyncio.create_task(room._response_worker())
        await room.handle_claude_response("First.", "m1")
        await room.handle_claude_response("Second.")
        for _ in range(200):
            if sum(1 for e in events if e["type"] == "speech_end") == 2:
                break
            await asyncio.sleep(0.02)
        room._running = False
        worker.cancel()

    asyncio.run(go())
    starts = [e for e in events if e["type"] == "speech_start"]
    assert [(s["text"], s["message_id"]) for s in starts] == [("First.", "m1"), ("Second.", None)]


def test_empty_after_sanitize_emits_nothing(monkeypatch):
    events, frames = [], []
    room = _room(events, frames)
    monkeypatch.setattr(livekit_agent.audio_pipeline, "synthesize_speech_stream", _fake_stream([(PCM_1S, [])]))
    asyncio.run(room._play_tts_response("   \n  ", "m1"))
    assert events == [] and frames == []
