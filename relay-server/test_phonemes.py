"""Tests for the phonemizer bridge.  Run: python3 -m pytest relay-server/test_phonemes.py

Uses a fake helper process for the protocol/timeout logic, plus one test
against the real g2p_helper.py when Kokoro's Python is installed.
"""

import asyncio
import os
import sys
import tempfile
import textwrap
import time
from pathlib import Path

import pytest

sys.path.insert(0, os.path.dirname(__file__))

import phonemes  # noqa: E402
from phonemes import Phonemizer  # noqa: E402

FAKE = textwrap.dedent('''
    import json, sys, time
    mode = sys.argv[1] if len(sys.argv) > 1 else "ok"
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        req = json.loads(line)
        if mode == "slow":
            time.sleep(1)
        words = req["words"]
        ph = ["/" + w.lower() + "/" for w in words]
        if mode == "short":
            ph = ph[:-1]
        print(json.dumps({"id": req["id"], "phonemes": ph}), flush=True)
''')


def _fake_helper(mode="ok") -> Path:
    d = Path(tempfile.mkdtemp())
    p = d / "fake_g2p.py"
    p.write_text(FAKE.replace('sys.argv[1] if len(sys.argv) > 1 else "ok"', repr(mode)))
    return p


async def _ready(ph: Phonemizer, timeout=10.0):
    start = time.time()
    while not ph.ready and time.time() - start < timeout:
        await asyncio.sleep(0.02)
    assert ph.ready


def test_annotates_word_like_entries_only():
    async def go():
        ph = Phonemizer(python=sys.executable, helper=_fake_helper())
        assert await ph.phonemize(["x"]) is None  # not started
        await ph.start()
        await _ready(ph)
        words = [{"word": "Hello", "start": 0, "end": 0.3}, {"word": ",", "start": 0.3, "end": 0.4}, {"word": "there", "start": 0.4, "end": 0.7}]
        out = await ph.annotate(words)
        await ph.stop()
        return words, out

    words, out = asyncio.run(go())
    assert out == [
        {"word": "Hello", "start": 0, "end": 0.3, "phonemes": "/hello/"},
        {"word": ",", "start": 0.3, "end": 0.4},
        {"word": "there", "start": 0.4, "end": 0.7, "phonemes": "/there/"},
    ]
    assert "phonemes" not in words[0]  # input untouched


@pytest.mark.parametrize("mode", ["slow", "short"])
def test_gives_up_quietly(mode, monkeypatch):
    monkeypatch.setattr(phonemes, "PHONEMIZE_TIMEOUT_S", 0.2)

    async def go():
        ph = Phonemizer(python=sys.executable, helper=_fake_helper(mode))
        await ph.start()
        await _ready(ph)
        t = time.time()
        out = await ph.annotate([{"word": "Hi", "start": 0, "end": 1}, {"word": "you", "start": 1, "end": 2}])
        took = time.time() - t
        await ph.stop()
        return out, took

    out, took = asyncio.run(go())
    assert out == [{"word": "Hi", "start": 0, "end": 1}, {"word": "you", "start": 1, "end": 2}]
    assert took < 0.6


def test_disabled_without_kokoro_python():
    async def go():
        ph = Phonemizer(python="/nonexistent/python")
        await ph.start()
        return await ph.annotate([{"word": "Hi", "start": 0, "end": 1}])

    assert asyncio.run(go()) == [{"word": "Hi", "start": 0, "end": 1}]


@pytest.mark.skipif(not Path(phonemes._DEFAULT_PYTHON).exists(), reason="Kokoro not installed")
def test_real_helper_one_group_per_normalized_word():
    async def go():
        ph = Phonemizer()
        await ph.start()
        await _ready(ph, timeout=60)
        out = await ph.phonemize(["Hello", "forty-two", "README", "aren't"])
        await ph.stop()
        return out

    out = asyncio.run(go())
    assert out is not None and len(out) == 4
    assert out[0] == "həlˈO"
