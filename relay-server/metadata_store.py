"""Server-side persistent session metadata store.

Stores display names and color overrides in a SQLite database so all
clients see the same session customizations regardless of browser.

Uses the built-in sqlite3 module (no external dependencies). Operations
are trivially fast single-row reads/writes, so sync access is fine.
"""

import sqlite3
import time
from pathlib import Path
from typing import Optional

# Default DB path — same directory as other voice-multiplexer persistent data
_DEFAULT_DB_PATH = Path.home() / ".claude" / "voice-multiplexer" / "session_metadata.db"

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS session_metadata (
    session_id   TEXT PRIMARY KEY,
    display_name TEXT,
    hue_override INTEGER,
    updated_at   REAL NOT NULL
)
"""


def _row_to_dict(row: sqlite3.Row) -> dict:
    return {
        "session_id": row["session_id"],
        "display_name": row["display_name"],
        "hue_override": row["hue_override"],
        "updated_at": row["updated_at"],
    }


class MetadataStore:
    def __init__(self, db_path: Optional[Path] = None):
        self._db_path = db_path or _DEFAULT_DB_PATH
        self._db: Optional[sqlite3.Connection] = None

    def _ensure_db(self) -> sqlite3.Connection:
        if self._db is None:
            self._db_path.parent.mkdir(parents=True, exist_ok=True)
            self._db = sqlite3.connect(str(self._db_path))
            self._db.row_factory = sqlite3.Row
            self._db.execute(_CREATE_TABLE)
            self._db.commit()
        return self._db

    async def get(self, session_id: str) -> Optional[dict]:
        """Return metadata for a single session, or None if not found."""
        db = self._ensure_db()
        cursor = db.execute(
            "SELECT session_id, display_name, hue_override, updated_at "
            "FROM session_metadata WHERE session_id = ?",
            (session_id,),
        )
        row = cursor.fetchone()
        if row is None:
            return None
        return _row_to_dict(row)

    async def get_all(self) -> list[dict]:
        """Return metadata for all sessions."""
        db = self._ensure_db()
        cursor = db.execute(
            "SELECT session_id, display_name, hue_override, updated_at "
            "FROM session_metadata"
        )
        return [_row_to_dict(row) for row in cursor.fetchall()]

    async def set(
        self,
        session_id: str,
        display_name: Optional[str] = None,
        hue_override: Optional[int] = None,
    ) -> dict:
        """Upsert metadata for a session. Only provided fields are updated."""
        db = self._ensure_db()
        now = time.time()

        existing = await self.get(session_id)
        if existing is None:
            db.execute(
                "INSERT INTO session_metadata (session_id, display_name, hue_override, updated_at) "
                "VALUES (?, ?, ?, ?)",
                (session_id, display_name, hue_override, now),
            )
        else:
            # Only update fields that were explicitly provided
            new_display = display_name if display_name is not None else existing["display_name"]
            new_hue = hue_override if hue_override is not None else existing["hue_override"]
            db.execute(
                "UPDATE session_metadata SET display_name = ?, hue_override = ?, updated_at = ? "
                "WHERE session_id = ?",
                (new_display, new_hue, now, session_id),
            )
        db.commit()
        return await self.get(session_id)  # type: ignore[return-value]

    async def delete(self, session_id: str) -> bool:
        """Delete metadata for a session. Returns True if a row was deleted."""
        db = self._ensure_db()
        cursor = db.execute(
            "DELETE FROM session_metadata WHERE session_id = ?",
            (session_id,),
        )
        db.commit()
        return cursor.rowcount > 0

    async def close(self):
        """Close the database connection."""
        if self._db:
            self._db.close()
            self._db = None
