"""Tests for the per-session metadata store (voice overrides + migration)."""

import asyncio
import sqlite3

from metadata_store import MetadataStore


def _run(coro):
    return asyncio.run(coro)


def test_voice_override_set_and_clear(tmp_path):
    store = MetadataStore(tmp_path / "meta.db")
    assert _run(store.get_voice("abc")) is None

    _run(store.set("abc", voice_override="bm_george"))
    assert _run(store.get_voice("abc")) == "bm_george"

    # Updating another field leaves the voice alone
    _run(store.set("abc", display_name="Proj"))
    assert _run(store.get_voice("abc")) == "bm_george"

    # Passing None explicitly clears it
    _run(store.set("abc", voice_override=None))
    assert _run(store.get_voice("abc")) is None
    assert _run(store.get("abc"))["display_name"] == "Proj"


def test_migrates_old_schema(tmp_path):
    path = tmp_path / "meta.db"
    db = sqlite3.connect(str(path))
    db.execute(
        "CREATE TABLE session_metadata (session_id TEXT PRIMARY KEY, display_name TEXT, "
        "hue_override INTEGER, updated_at REAL NOT NULL)"
    )
    db.execute("INSERT INTO session_metadata VALUES ('old', 'Old', 120, 1.0)")
    db.commit()
    db.close()

    store = MetadataStore(path)
    row = _run(store.get("old"))
    assert row["hue_override"] == 120
    assert row["voice_override"] is None
    _run(store.set("old", voice_override="af_bella"))
    assert _run(store.get_voice("old")) == "af_bella"
