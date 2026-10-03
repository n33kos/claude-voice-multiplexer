"""Unit tests for speech events, audio frames, and the Kokoro speech stream.

Run with: python3 -m pytest relay-server/test_speech_stream.py
(the Kokoro stream tests need httpx and skip without it)
"""

import asyncio
import base64
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from speech_stream import (  # noqa: E402
    SAMPLE_RATE,
    SpeechEmitter,
    decode_audio_frame,
    encode_audio_frame,
    normalize_words,
)


class AudioFrameTests(unittest.TestCase):
    def test_roundtrip(self):
        header = {"utterance_id": "u1", "seq": 2, "offset_samples": 48000}
        pcm = bytes(range(10))
        frame = encode_audio_frame(header, pcm)
        self.assertEqual(frame[:4], b"VMXA")
        self.assertEqual(decode_audio_frame(frame), (header, pcm))

    def test_rejects_foreign_frames(self):
        with self.assertRaises(ValueError):
            decode_audio_frame(b"RIFF....")


class NormalizeWordsTests(unittest.TestCase):
    def test_renames_and_clamps(self):
        raw = [
            {"word": "Hi", "start_time": -0.003, "end_time": 0.2},
            {"word": "there", "start_time": 0.2, "end_time": 0.1},
            {"word": "bad"},
        ]
        self.assertEqual(normalize_words(raw), [
            {"word": "Hi", "start": 0.0, "end": 0.2},
            {"word": "there", "start": 0.2, "end": 0.2},
        ])

    def test_empty(self):
        self.assertEqual(normalize_words(None), [])


class SpeechEmitterTests(unittest.TestCase):
    def _run(self, coro):
        return asyncio.run(coro)

    def test_event_sequence_and_offsets(self):
        events, frames = [], []

        async def ev(sid, payload):
            events.append((sid, payload))

        async def au(sid, frame):
            frames.append((sid, frame))

        async def go():
            e = SpeechEmitter("s1", ev, au)
            await e.start("Hello there.", "m1")
            await e.chunk(b"\x00\x00" * SAMPLE_RATE, [{"word": "Hello", "start": 0.0, "end": 0.4}])
            await e.chunk(b"\x00\x00" * (SAMPLE_RATE // 2), [])
            await e.end()
            await e.end(cancelled=True)  # idempotent
            return e

        e = self._run(go())
        types = [p["type"] for _, p in events]
        self.assertEqual(types, ["speech_start", "speech_chunk", "speech_chunk", "speech_end"])
        self.assertTrue(all(sid == "s1" for sid, _ in events))
        start, c0, c1, end = (p for _, p in events)
        self.assertEqual(start["message_id"], "m1")
        self.assertEqual(start["sample_rate"], SAMPLE_RATE)
        self.assertEqual({p["utterance_id"] for p in (start, c0, c1, end)}, {e.utterance_id})
        self.assertEqual((c0["seq"], c0["offset_s"], c0["duration_s"]), (0, 0.0, 1.0))
        self.assertEqual((c1["seq"], c1["offset_s"], c1["duration_s"]), (1, 1.0, 0.5))
        self.assertEqual(end, {**end, "cancelled": False, "duration_s": 1.5})

        self.assertEqual(len(frames), 2)
        h1, pcm1 = decode_audio_frame(frames[1][1])
        self.assertEqual((h1["seq"], h1["offset_samples"], len(pcm1)), (1, SAMPLE_RATE, SAMPLE_RATE))

    def test_no_audio_without_subscriber_fn_and_survives_send_errors(self):
        async def boom(sid, payload):
            raise RuntimeError("socket gone")

        async def go():
            e = SpeechEmitter("s1", boom, None)
            await e.start("x")
            await e.chunk(b"\x00\x00", [])
            await e.end()

        self._run(go())  # must not raise


try:
    import httpx  # noqa: F401
    HAVE_HTTPX = True
except ImportError:
    HAVE_HTTPX = False


@unittest.skipUnless(HAVE_HTTPX, "needs httpx")
class SynthesizeSpeechStreamTests(unittest.TestCase):
    def _collect(self, handler):
        import httpx

        import audio

        async def go():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                audio.set_http_client(client)
                return [item async for item in audio.synthesize_speech_stream("Hello there.")]

        return asyncio.run(go())

    def test_captioned_lines_become_pcm_and_words(self):
        lines = [
            {"audio": base64.b64encode(b"\x01\x00" * 4).decode(), "timestamps": [{"word": "Hello", "start_time": 0.0, "end_time": 0.3}]},
            {"audio": base64.b64encode(b"\x02\x00" * 2).decode(), "timestamps": [{"word": "there", "start_time": 0.3, "end_time": 0.5}]},
        ]
        seen = []

        def handler(request):
            seen.append(request.url.path)
            body = "\n".join(json.dumps(line) for line in lines) + "\n"
            return httpx.Response(200, text=body)

        out = self._collect(handler)
        self.assertEqual(seen, ["/dev/captioned_speech"])
        self.assertEqual(out, [
            (b"\x01\x00" * 4, [{"word": "Hello", "start": 0.0, "end": 0.3}]),
            (b"\x02\x00" * 2, [{"word": "there", "start": 0.3, "end": 0.5}]),
        ])

    def test_falls_back_to_plain_stream_when_captioned_missing(self):
        seen = []

        def handler(request):
            seen.append(request.url.path)
            if request.url.path == "/dev/captioned_speech":
                return httpx.Response(404)
            return httpx.Response(200, content=b"\x03\x00" * 3)

        out = self._collect(handler)
        self.assertEqual(seen, ["/dev/captioned_speech", "/v1/audio/speech"])
        self.assertEqual(out, [(b"\x03\x00" * 3, [])])


if __name__ == "__main__":
    unittest.main()
