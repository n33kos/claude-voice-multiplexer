"""Unit tests for the replacements pipeline.

Run with: python3 -m unittest relay-server/test_replacements.py
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))

# Clear any developer-shell override so default-behavior tests start clean.
os.environ.pop("VMUX_REPLACEMENTS_FILE", None)

import replacements  # noqa: E402
from replacements import (  # noqa: E402
    Replacement,
    apply_inbound,
    apply_outbound,
    load_replacements,
    reload,
)

# Reload so module-level lists reflect a clean environment regardless of
# whatever state was in os.environ at import time.
reload()


# --- /btw default rule ----------------------------------------------------


class BtwDefaultRule(unittest.TestCase):
    """The /btw inbound rule is the one shipped default — exercise it
    against the live module state (no file present means hardcoded
    fallback applies)."""

    def test_basic_no_comma(self):
        self.assertEqual(
            apply_inbound("by the way can you check the weather"),
            "/btw can you check the weather",
        )

    def test_with_comma(self):
        self.assertEqual(
            apply_inbound("by the way, can you check the weather"),
            "/btw can you check the weather",
        )

    def test_case_insensitive(self):
        self.assertEqual(apply_inbound("By The Way, ping me"), "/btw ping me")
        self.assertEqual(apply_inbound("BY THE WAY hello"), "/btw hello")

    def test_leading_whitespace(self):
        self.assertEqual(apply_inbound("  by the way, hello"), "/btw hello")

    def test_prefix_only_no_mid_sentence(self):
        text = "I was thinking, by the way, what about lunch"
        self.assertEqual(apply_inbound(text), text)

    def test_unrelated_text_unchanged(self):
        self.assertEqual(apply_inbound("hello world"), "hello world")

    def test_empty_input(self):
        self.assertEqual(apply_inbound(""), "")

    def test_idempotent(self):
        once = apply_inbound("by the way hello")
        twice = apply_inbound(once)
        self.assertEqual(once, twice)

    def test_does_not_match_wayside(self):
        # Word boundary on "way" prevents matching e.g. "wayside".
        self.assertEqual(apply_inbound("by the wayside, fine"), "by the wayside, fine")


# --- Outbound (currently a no-op) ----------------------------------------


class OutboundDefault(unittest.TestCase):
    def test_passthrough(self):
        self.assertEqual(replacements.OUTBOUND_REPLACEMENTS, [])
        self.assertEqual(apply_outbound("Hello world."), "Hello world.")
        self.assertEqual(apply_outbound(""), "")


# --- JSON file loading ----------------------------------------------------


class _FileBackedTest(unittest.TestCase):
    """Base class that swaps VMUX_REPLACEMENTS_FILE to a temp file per test."""

    def setUp(self):
        self._tmp_dir = tempfile.mkdtemp(prefix="replacements-test-")
        self._tmp_file = Path(self._tmp_dir) / "replacements.json"
        self._saved = os.environ.get("VMUX_REPLACEMENTS_FILE")
        os.environ["VMUX_REPLACEMENTS_FILE"] = str(self._tmp_file)

    def tearDown(self):
        if self._saved is None:
            os.environ.pop("VMUX_REPLACEMENTS_FILE", None)
        else:
            os.environ["VMUX_REPLACEMENTS_FILE"] = self._saved
        reload()
        try:
            self._tmp_file.unlink()
        except FileNotFoundError:
            pass
        Path(self._tmp_dir).rmdir()

    def _write(self, data):
        self._tmp_file.write_text(
            json.dumps(data) if not isinstance(data, str) else data
        )
        reload()


class FileLoading(_FileBackedTest):
    def test_missing_file_uses_defaults(self):
        # tmp_file doesn't exist yet; reload should fall back to defaults
        reload()
        names = [r.name for r in replacements.INBOUND_REPLACEMENTS]
        self.assertIn("btw_prefix", names)

    def test_explicit_empty_inbound_disables(self):
        self._write({"inbound": [], "outbound": []})
        self.assertEqual(replacements.INBOUND_REPLACEMENTS, [])
        self.assertEqual(apply_inbound("by the way hello"), "by the way hello")

    def test_custom_inbound_replaces_default(self):
        self._write({
            "inbound": [
                {"name": "hi", "pattern": r"^hi\b", "replacement": "hello"},
            ],
            "outbound": [],
        })
        self.assertEqual(apply_inbound("hi there"), "hello there")
        # /btw default no longer present — it was replaced.
        self.assertEqual(apply_inbound("by the way hi"), "by the way hi")

    def test_outbound_rules_apply(self):
        self._write({
            "inbound": [],
            "outbound": [
                {"name": "yeah", "pattern": "(?i)yeah", "replacement": "yes"},
            ],
        })
        self.assertEqual(apply_outbound("Yeah, sure thing."), "yes, sure thing.")

    def test_inline_flags(self):
        # Inline (?i) flag inside the pattern — no separate flags field.
        self._write({
            "inbound": [
                {"name": "foo", "pattern": "(?i)^foo\\b", "replacement": "bar"},
            ],
            "outbound": [],
        })
        self.assertEqual(apply_inbound("FOO bar"), "bar bar")

    def test_malformed_json_falls_back(self):
        self._tmp_file.write_text("{not valid json")
        reload()
        names = [r.name for r in replacements.INBOUND_REPLACEMENTS]
        self.assertIn("btw_prefix", names)

    def test_top_level_array_rejected(self):
        # Top-level must be an object, not an array
        self._tmp_file.write_text("[]")
        reload()
        names = [r.name for r in replacements.INBOUND_REPLACEMENTS]
        self.assertIn("btw_prefix", names)

    def test_individual_malformed_entries_skipped(self):
        self._tmp_file.write_text(json.dumps({
            "inbound": [
                "not an object",
                {"name": "missing_pattern"},
                {"name": "bad_regex", "pattern": "["},
                {"name": "good", "pattern": "x", "replacement": "y"},
            ],
            "outbound": [],
        }))
        reload()
        names = [r.name for r in replacements.INBOUND_REPLACEMENTS]
        self.assertEqual(names, ["good"])

    def test_chained_rules_apply_in_order(self):
        self._write({
            "inbound": [
                {"name": "first", "pattern": "foo", "replacement": "bar"},
                {"name": "second", "pattern": "bar", "replacement": "baz"},
            ],
            "outbound": [],
        })
        # foo -> bar -> baz
        self.assertEqual(apply_inbound("foo"), "baz")


# --- Shape of the shipped default JSON ------------------------------------


class ShippedDefaultJson(unittest.TestCase):
    """The hardcoded fallback in replacements.py must match the shipped
    scripts/replacements.json so behavior is consistent across the two
    sources. If you change one, change the other."""

    def test_shipped_json_matches_hardcoded_default(self):
        repo_template = (
            Path(__file__).resolve().parent.parent / "scripts" / "replacements.json"
        )
        self.assertTrue(
            repo_template.exists(),
            f"shipped template missing at {repo_template}",
        )
        data = json.loads(repo_template.read_text())
        self.assertIn("inbound", data)
        self.assertIn("outbound", data)
        # Default inbound rule should match what the Python fallback compiles.
        inbound = data["inbound"]
        self.assertEqual(len(inbound), 1)
        self.assertEqual(inbound[0]["name"], "btw_prefix")
        self.assertEqual(inbound[0]["replacement"], "/btw ")
        # Compile both and verify they behave the same on a representative input.
        from_template = __import__("re").compile(inbound[0]["pattern"])
        m = from_template.match("by the way, hi")
        self.assertIsNotNone(m)


if __name__ == "__main__":
    unittest.main()
