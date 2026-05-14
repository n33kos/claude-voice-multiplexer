"""Unit tests for text_pipeline.

Run with: python3 -m unittest relay-server/test_text_pipeline.py
"""

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from text_pipeline import (  # noqa: E402
    INBOUND_RULES,
    OUTBOUND_RULES,
    Rule,
    apply_inbound,
    apply_outbound,
    apply_rules,
)


class BtwPrefixRule(unittest.TestCase):
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

    def test_extra_internal_whitespace(self):
        self.assertEqual(apply_inbound("by  the   way   hello"), "/btw hello")

    def test_prefix_only_no_mid_sentence(self):
        # "by the way" appearing mid-utterance must NOT trigger the rule.
        text = "I was thinking, by the way, what about lunch"
        self.assertEqual(apply_inbound(text), text)

    def test_unrelated_text_unchanged(self):
        text = "hello world"
        self.assertEqual(apply_inbound(text), text)

    def test_empty_input(self):
        self.assertEqual(apply_inbound(""), "")

    def test_idempotent(self):
        once = apply_inbound("by the way hello")
        twice = apply_inbound(once)
        self.assertEqual(once, twice)

    def test_does_not_match_byway(self):
        # Word-boundary on "way" prevents matching e.g. "by the wayside".
        text = "by the wayside, things are fine"
        self.assertEqual(apply_inbound(text), text)


class OutboundPipeline(unittest.TestCase):
    def test_empty_ruleset_passthrough(self):
        # v1 ships with no outbound rules — pipeline is a no-op until ticket
        # 1.2 (code-block stripping) is folded in.
        self.assertEqual(OUTBOUND_RULES, [])
        self.assertEqual(apply_outbound("Hello world."), "Hello world.")
        self.assertEqual(apply_outbound(""), "")


class RuleEngine(unittest.TestCase):
    def test_short_circuit_stops_pipeline(self):
        r1 = Rule(
            "first",
            re.compile(r"^foo"),
            "FOO",
            scope="prefix",
            short_circuit=True,
        )
        r2 = Rule("second", re.compile(r"FOO"), "BAR")
        self.assertEqual(apply_rules("foo bar", [r1, r2]), "FOO bar")

    def test_non_short_circuit_chains(self):
        r1 = Rule("first", re.compile(r"foo"), "baz")
        r2 = Rule("second", re.compile(r"baz"), "qux")
        self.assertEqual(apply_rules("foo bar", [r1, r2]), "qux bar")

    def test_anywhere_scope_replaces_all_occurrences(self):
        r = Rule("repl", re.compile(r"cat"), "dog")
        self.assertEqual(
            apply_rules("the cat sat on the cat", [r]),
            "the dog sat on the dog",
        )

    def test_prefix_scope_ignores_mid_string(self):
        r = Rule("greet", re.compile(r"^hi\b"), "hello", scope="prefix")
        self.assertEqual(apply_rules("hi there", [r]), "hello there")
        self.assertEqual(apply_rules("say hi there", [r]), "say hi there")

    def test_callable_replacement(self):
        r = Rule(
            "upper",
            re.compile(r"\b(\w+)\b"),
            lambda m: m.group(1).upper(),
        )
        self.assertEqual(apply_rules("hello world", [r]), "HELLO WORLD")

    def test_empty_text_short_circuits(self):
        r = Rule("noop", re.compile(r".*"), "x")
        self.assertEqual(apply_rules("", [r]), "")


class InboundRuleConfig(unittest.TestCase):
    def test_btw_rule_is_present_and_short_circuits(self):
        names = [r.name for r in INBOUND_RULES]
        self.assertIn("btw_prefix", names)
        btw = next(r for r in INBOUND_RULES if r.name == "btw_prefix")
        self.assertTrue(btw.short_circuit)
        self.assertEqual(btw.scope, "prefix")


if __name__ == "__main__":
    unittest.main()
