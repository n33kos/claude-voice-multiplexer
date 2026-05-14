"""Unit tests for text_pipeline.

Run with: python3 -m unittest relay-server/test_text_pipeline.py
"""

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

# Ensure env-var overrides from the developer shell don't leak into the
# default-behavior tests. Tests that exercise env loading set vars locally
# and call reload_rules().
os.environ.pop("VMUX_INBOUND_RULES", None)
os.environ.pop("VMUX_OUTBOUND_RULES", None)

import text_pipeline  # noqa: E402
from text_pipeline import (  # noqa: E402
    INBOUND_RULES,
    OUTBOUND_RULES,
    Rule,
    apply_inbound,
    apply_outbound,
    apply_rules,
    parse_rules_json,
    reload_rules,
)

# After clearing env vars, reload so module-level lists reflect defaults
# regardless of import-time environment state.
reload_rules()


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
        names = [r.name for r in text_pipeline.INBOUND_RULES]
        self.assertIn("btw_prefix", names)
        btw = next(r for r in text_pipeline.INBOUND_RULES if r.name == "btw_prefix")
        self.assertTrue(btw.short_circuit)
        self.assertEqual(btw.scope, "prefix")


class ParseRulesJson(unittest.TestCase):
    def test_basic_parse(self):
        blob = (
            '[{"name":"foo","pattern":"^foo","replacement":"FOO",'
            '"scope":"prefix","short_circuit":true,"flags":"i"}]'
        )
        rules = parse_rules_json(blob, "test")
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0].name, "foo")
        self.assertEqual(rules[0].replacement, "FOO")
        self.assertEqual(rules[0].scope, "prefix")
        self.assertTrue(rules[0].short_circuit)
        # Case-insensitive flag applied
        self.assertTrue(rules[0].pattern.match("FOO"))

    def test_empty_array(self):
        self.assertEqual(parse_rules_json("[]", "test"), [])

    def test_invalid_json_returns_none(self):
        self.assertIsNone(parse_rules_json("not json", "test"))
        self.assertIsNone(parse_rules_json("{}", "test"))  # object, not array

    def test_skips_malformed_entries(self):
        blob = (
            '['
            '"not an object",'                              # skipped
            '{"name":"missing_pattern"},'                   # skipped
            '{"name":"bad_regex","pattern":"["},'           # skipped (regex error)
            '{"name":"good","pattern":"x","replacement":"y"}'
            ']'
        )
        rules = parse_rules_json(blob, "test")
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0].name, "good")

    def test_unknown_scope_falls_back_to_anywhere(self):
        blob = '[{"name":"f","pattern":"x","replacement":"y","scope":"galaxy"}]'
        rules = parse_rules_json(blob, "test")
        self.assertEqual(rules[0].scope, "anywhere")

    def test_default_scope_and_short_circuit(self):
        blob = '[{"name":"f","pattern":"x","replacement":"y"}]'
        rules = parse_rules_json(blob, "test")
        self.assertEqual(rules[0].scope, "anywhere")
        self.assertFalse(rules[0].short_circuit)

    def test_multiple_flags(self):
        blob = '[{"name":"f","pattern":"^foo","replacement":"y","flags":"im"}]'
        rules = parse_rules_json(blob, "test")
        # IGNORECASE + MULTILINE should both be set
        self.assertTrue(rules[0].pattern.flags & re.IGNORECASE)
        self.assertTrue(rules[0].pattern.flags & re.MULTILINE)


class EnvVarLoading(unittest.TestCase):
    def setUp(self):
        self._saved = {
            "VMUX_INBOUND_RULES": os.environ.get("VMUX_INBOUND_RULES"),
            "VMUX_OUTBOUND_RULES": os.environ.get("VMUX_OUTBOUND_RULES"),
        }

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        reload_rules()

    def test_unset_env_uses_defaults(self):
        os.environ.pop("VMUX_INBOUND_RULES", None)
        os.environ.pop("VMUX_OUTBOUND_RULES", None)
        reload_rules()
        names = [r.name for r in text_pipeline.INBOUND_RULES]
        self.assertIn("btw_prefix", names)
        self.assertEqual(text_pipeline.OUTBOUND_RULES, [])

    def test_explicit_empty_disables(self):
        os.environ["VMUX_INBOUND_RULES"] = "[]"
        reload_rules()
        self.assertEqual(text_pipeline.INBOUND_RULES, [])
        # apply_inbound becomes a passthrough
        self.assertEqual(apply_inbound("by the way hello"), "by the way hello")

    def test_custom_inbound_rule_from_env(self):
        os.environ["VMUX_INBOUND_RULES"] = (
            '[{"name":"hi","pattern":"^hi\\\\b","replacement":"hello",'
            '"scope":"prefix","short_circuit":true}]'
        )
        reload_rules()
        self.assertEqual(apply_inbound("hi there"), "hello there")
        # Default /btw rule has been replaced — no longer fires
        self.assertEqual(apply_inbound("by the way hi"), "by the way hi")

    def test_malformed_env_falls_back_to_defaults(self):
        os.environ["VMUX_INBOUND_RULES"] = "not valid json"
        reload_rules()
        names = [r.name for r in text_pipeline.INBOUND_RULES]
        self.assertIn("btw_prefix", names)


if __name__ == "__main__":
    unittest.main()
