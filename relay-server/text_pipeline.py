"""Bidirectional rule-driven text replacement pipeline.

Applies an ordered list of regex rules in two directions:

  * Inbound  — STT transcription → Claude input  (post-Whisper, pre-Claude)
  * Outbound — Claude response   → TTS input     (post-Claude, pre-Kokoro)

Building the abstraction once turns every future "voice mode wants X
different" request into a config change instead of a code change. The first
inbound rule rewrites "by the way, …" → "/btw …" so dictated side-chat can
be routed through Claude Code's `/btw` slash command. Outbound rules are
empty for v1; the existing `tts_sanitize.sanitize_for_tts` ships standalone
and will be folded in here as a follow-up.
"""

import re
from dataclasses import dataclass
from typing import Callable, List, Pattern, Tuple, Union

Replacement = Union[str, Callable[[re.Match], str]]


@dataclass(frozen=True)
class Rule:
    """One text-replacement rule.

    Attributes:
        name: short identifier used in logs.
        pattern: compiled regex.
        replacement: literal string or callable taking a Match and returning a string.
        scope: one of "prefix" (match only at the start of the text),
            "anywhere" (every non-overlapping match), or "line" (every match,
            with the regex authored as line-anchored — pattern decides what
            "line" means).
        short_circuit: when True, stop the pipeline after this rule fires.
    """

    name: str
    pattern: Pattern[str]
    replacement: Replacement
    scope: str = "anywhere"
    short_circuit: bool = False


def _apply_rule(text: str, rule: Rule) -> Tuple[str, bool]:
    """Apply a single rule. Returns (new_text, fired)."""
    if rule.scope == "prefix":
        m = rule.pattern.match(text)
        if not m:
            return text, False
        repl = rule.replacement(m) if callable(rule.replacement) else rule.replacement
        return repl + text[m.end():], True
    # "anywhere" and "line" behave the same here — both substitute every
    # non-overlapping match. The distinction is only authorial intent for
    # the rule writer (line-anchored regexes vs. free-floating).
    new_text, n = rule.pattern.subn(rule.replacement, text)
    return new_text, n > 0


def apply_rules(text: str, rules: List[Rule]) -> str:
    """Run ``rules`` against ``text`` in order, honoring ``short_circuit``."""
    if not text:
        return text
    out = text
    for rule in rules:
        out, fired = _apply_rule(out, rule)
        if fired and rule.short_circuit:
            break
    return out


# --- v1 rule sets ---------------------------------------------------------

# Inbound rule: "by the way, …" → "/btw …"
# Case-insensitive, prefix-only, optional trailing comma/whitespace.
_BTW_PREFIX_RE = re.compile(r"^\s*by\s+the\s+way\b[\s,]*", re.IGNORECASE)

INBOUND_RULES: List[Rule] = [
    Rule(
        name="btw_prefix",
        pattern=_BTW_PREFIX_RE,
        replacement="/btw ",
        scope="prefix",
        short_circuit=True,
    ),
]

OUTBOUND_RULES: List[Rule] = []


def apply_inbound(text: str) -> str:
    """Apply inbound rules to a transcription before it reaches Claude."""
    return apply_rules(text, INBOUND_RULES)


def apply_outbound(text: str) -> str:
    """Apply outbound rules to a Claude response before TTS."""
    return apply_rules(text, OUTBOUND_RULES)
