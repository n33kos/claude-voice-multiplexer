"""Unit tests for the transcript replay buffer.

Run with: python3 -m unittest relay-server/test_transcript_buffer.py
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

import transcript_buffer  # noqa: E402
from transcript_buffer import MAX_TRANSCRIPT_BUFFER, buffer_entry  # noqa: E402


def _entry(text, message_id=None, speaker="claude", ts=0.0):
    e = {"type": "transcript", "speaker": speaker, "text": text, "ts": ts}
    if message_id:
        e["message_id"] = message_id
    return e


class BufferEntryTests(unittest.TestCase):
    def test_entries_without_message_id_append(self):
        buf = []
        buf = buffer_entry(buf, _entry("a"))
        buf = buffer_entry(buf, _entry("a"))
        self.assertEqual([e["text"] for e in buf], ["a", "a"])

    def test_deltas_with_same_message_id_merge_in_place(self):
        buf = []
        buf = buffer_entry(buf, _entry("Intro:\n\n", "m1", ts=1.0))
        buf = buffer_entry(buf, _entry("- one\n- two\n\n", "m1", ts=2.0))
        buf = buffer_entry(buf, _entry("Done.", "m1", ts=3.0))
        self.assertEqual(len(buf), 1)
        self.assertEqual(buf[0]["text"], "Intro:\n\n- one\n- two\n\nDone.")
        self.assertEqual(buf[0]["ts"], 1.0)  # keeps the first delta's timestamp

    def test_merge_keeps_position_among_other_entries(self):
        buf = []
        buf = buffer_entry(buf, _entry("hi", speaker="user"))
        buf = buffer_entry(buf, _entry("A", "m1"))
        buf = buffer_entry(buf, _entry("tool", speaker="activity"))
        buf = buffer_entry(buf, _entry("B", "m1"))
        self.assertEqual([e["text"] for e in buf], ["hi", "AB", "tool"])

    def test_different_message_ids_stay_separate(self):
        buf = []
        buf = buffer_entry(buf, _entry("A", "m1"))
        buf = buffer_entry(buf, _entry("B", "m2"))
        self.assertEqual([e["text"] for e in buf], ["A", "B"])

    def test_merge_does_not_mutate_broadcast_entry(self):
        first = _entry("A", "m1")
        buf = buffer_entry([], first)
        buffer_entry(buf, _entry("B", "m1"))
        self.assertEqual(first["text"], "A")

    def test_buffer_is_trimmed(self):
        buf = []
        for i in range(MAX_TRANSCRIPT_BUFFER + 5):
            buf = buffer_entry(buf, _entry(str(i)))
        self.assertEqual(len(buf), MAX_TRANSCRIPT_BUFFER)
        self.assertEqual(buf[0]["text"], "5")

    def test_merged_entry_is_truncated_and_stops_growing(self):
        orig = transcript_buffer.MAX_TRANSCRIPT_ENTRY_SIZE
        transcript_buffer.MAX_TRANSCRIPT_ENTRY_SIZE = 10
        try:
            buf = buffer_entry([], _entry("12345678", "m1"))
            buf = buffer_entry(buf, _entry("90abc", "m1"))
            self.assertEqual(buf[0]["text"], "1234567890... [truncated]")
            buf = buffer_entry(buf, _entry("more", "m1"))
            self.assertEqual(buf[0]["text"], "1234567890... [truncated]")
            self.assertEqual(len(buf), 1)
        finally:
            transcript_buffer.MAX_TRANSCRIPT_ENTRY_SIZE = orig


if __name__ == "__main__":
    unittest.main()
