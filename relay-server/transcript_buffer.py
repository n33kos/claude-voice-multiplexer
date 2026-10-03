"""Per-session transcript replay buffer.

Reconnecting clients are sent the buffered entries (`transcript_sync`) so
they can catch up.  Streamed assistant messages arrive as several deltas that
share a `message_id`; the live broadcast sends each delta, but the buffer
keeps one entry per message with the deltas concatenated, so a replay shows
the whole message as a single bubble rather than its fragments.
"""

MAX_TRANSCRIPT_BUFFER = 50
MAX_TRANSCRIPT_ENTRY_SIZE = 50_000  # Truncate individual entries larger than 50KB

_TRUNCATED_SUFFIX = "... [truncated]"


def _truncate(entry: dict) -> dict:
    text = entry.get("text") or ""
    if len(text) > MAX_TRANSCRIPT_ENTRY_SIZE:
        return {**entry, "text": text[:MAX_TRANSCRIPT_ENTRY_SIZE] + _TRUNCATED_SUFFIX}
    return entry


def buffer_entry(buf: list[dict], entry: dict) -> list[dict]:
    """Add a broadcast transcript entry to a session's replay buffer.

    An entry carrying a `message_id` that is already buffered is appended to
    that entry's text (keeping its position and original timestamp) instead
    of being added as a new entry.  Returns the buffer, trimmed to
    MAX_TRANSCRIPT_BUFFER; the caller stores the returned list.
    """
    message_id = entry.get("message_id")
    if message_id:
        for i in range(len(buf) - 1, -1, -1):
            existing = buf[i]
            if existing.get("message_id") != message_id:
                continue
            existing_text = existing.get("text") or ""
            if existing_text.endswith(_TRUNCATED_SUFFIX):
                return buf  # already at the size cap — drop further deltas
            buf[i] = _truncate({**existing, "text": existing_text + (entry.get("text") or "")})
            return buf

    buf.append(_truncate(entry))
    if len(buf) > MAX_TRANSCRIPT_BUFFER:
        buf = buf[-MAX_TRANSCRIPT_BUFFER:]
    return buf
