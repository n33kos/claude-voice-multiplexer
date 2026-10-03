"""Phonemes for spoken words, from a long-lived g2p_helper.py process.

Optional: if Kokoro's Python isn't where we expect, or the helper is still
loading (~4s at startup), or a request takes too long, words simply go out
without phonemes and clients fall back to spelling-based mouth shapes.  It
never delays speech by more than PHONEMIZE_TIMEOUT_S.
"""

import asyncio
import json
import os
import re
from pathlib import Path
from typing import Optional

PHONEMIZE_TIMEOUT_S = 0.25
_WORDLIKE = re.compile(r"\w")

_DEFAULT_PYTHON = Path.home() / ".claude" / "voice-multiplexer" / "kokoro" / "kokoro-fastapi" / ".venv" / "bin" / "python"
_HELPER = Path(__file__).with_name("g2p_helper.py")


class Phonemizer:
    def __init__(self, python: Optional[str] = None, helper: Path = _HELPER):
        self.python = python or os.environ.get("VMUX_G2P_PYTHON") or str(_DEFAULT_PYTHON)
        self.helper = helper
        self.proc: Optional[asyncio.subprocess.Process] = None
        self.ready = False
        self._next_id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._reader: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()

    @property
    def available(self) -> bool:
        return Path(self.python).exists()

    async def start(self) -> None:
        """Start the helper (returns at once; it becomes ready in the background)."""
        if self.proc or not self.available:
            if not self.available:
                print(f"[phonemes] disabled: no Kokoro python at {self.python}")
            return
        self.proc = await asyncio.create_subprocess_exec(
            self.python, str(self.helper),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        self._reader = asyncio.create_task(self._read_loop())

    async def stop(self) -> None:
        if self._reader:
            self._reader.cancel()
        if self.proc and self.proc.returncode is None:
            self.proc.kill()
            await self.proc.wait()
        self.proc, self.ready = None, False

    async def _read_loop(self) -> None:
        assert self.proc and self.proc.stdout
        try:
            while True:
                line = await self.proc.stdout.readline()
                if not line:
                    break
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if msg.get("ready"):
                    self.ready = True
                    print("[phonemes] helper ready")
                    continue
                fut = self._pending.pop(msg.get("id"), None)
                if fut and not fut.done():
                    fut.set_result(msg.get("phonemes"))
        finally:
            self.ready = False
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_result(None)
            self._pending.clear()
            print("[phonemes] helper exited")

    async def phonemize(self, words: list[str]) -> Optional[list[Optional[str]]]:
        """Phonemes for each word, or None if unavailable right now."""
        if not words or not self.ready or not self.proc or not self.proc.stdin:
            return None
        async with self._lock:
            self._next_id += 1
            rid = self._next_id
            fut = asyncio.get_running_loop().create_future()
            self._pending[rid] = fut
            self.proc.stdin.write((json.dumps({"id": rid, "words": words}, ensure_ascii=False) + "\n").encode())
            await self.proc.stdin.drain()
        try:
            result = await asyncio.wait_for(fut, PHONEMIZE_TIMEOUT_S)
        except asyncio.TimeoutError:
            self._pending.pop(rid, None)
            return None
        if not isinstance(result, list) or len(result) != len(words):
            return None
        return result

    async def annotate(self, words: list[dict]) -> list[dict]:
        """Add `phonemes` to each word-like entry of a speech_chunk word list."""
        idx = [i for i, w in enumerate(words) if _WORDLIKE.search(w.get("word", ""))]
        if not idx:
            return words
        result = await self.phonemize([words[i]["word"] for i in idx])
        if not result:
            return words
        out = [dict(w) for w in words]
        for i, ph in zip(idx, result):
            if ph:
                out[i]["phonemes"] = ph
        return out


# Shared instance used by the TTS pipeline (started by server.py at startup).
phonemizer = Phonemizer()
