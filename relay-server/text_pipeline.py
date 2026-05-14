"""Bidirectional rule-driven text replacement pipeline.

Applies an ordered list of regex rules in two directions:

  * Inbound  — STT transcription → Claude input  (post-Whisper, pre-Claude)
  * Outbound — Claude response   → TTS input     (post-Claude, pre-Kokoro)

Building the abstraction once turns every future "voice mode wants X
different" request into a config change instead of a code change.

Rules are loaded from the ``VMUX_INBOUND_RULES`` / ``VMUX_OUTBOUND_RULES``
environment variables (JSON arrays). When a variable is unset, the
hardcoded defaults below are used; explicitly setting it to ``[]``
disables that direction. The first inbound default rewrites
"by the way, …" → "/btw …" so dictated side-chat can be routed through
the ``/btw`` slash command.

Rule JSON schema (one object per rule)::

    {
      "name": "btw_prefix",          # for logging
      "pattern": "^\\s*by\\s+the\\s+way\\b[\\s,]*",
      "replacement": "/btw ",        # literal string
      "scope": "prefix",             # "prefix" | "anywhere" | "line"
      "short_circuit": true,         # stop pipeline after this fires
      "flags": "i"                   # any of "imsx"
    }
"""

import json
import logging
import os
import re
from dataclasses import dataclass
from typing import Callable, List, Optional, Pattern, Tuple, Union

# Import config for its side effect of loading the dotenv file before we
# read VMUX_*_RULES below. Safe-guarded so the module still imports cleanly
# in environments where config.py is unavailable (e.g. isolated test runs).
try:
    import config  # noqa: F401
except Exception:
    pass

_log = logging.getLogger("relay.text_pipeline")

Replacement = Union[str, Callable[[re.Match], str]]


@dataclass(frozen=True)
class Rule:
    """One text-replacement rule."""

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
    # "anywhere" and "line" both substitute every non-overlapping match;
    # the distinction is just authorial intent (line-anchored regex or not).
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


# --- Hardcoded defaults ----------------------------------------------------
#
# These mirror what scripts/env.template ships with on fresh installs.
# They are the fallback when VMUX_*_RULES is unset (e.g. an upgrade that
# hasn't refreshed its env file). To explicitly disable a direction, set
# the env var to "[]".

_BTW_PREFIX_RE = re.compile(r"^\s*by\s+the\s+way\b[\s,]*", re.IGNORECASE)

_DEFAULT_INBOUND_RULES: List[Rule] = [
    Rule(
        name="btw_prefix",
        pattern=_BTW_PREFIX_RE,
        replacement="/btw ",
        scope="prefix",
        short_circuit=True,
    ),
]
_DEFAULT_OUTBOUND_RULES: List[Rule] = []


# --- Env-var loading -------------------------------------------------------

_FLAG_CHARS = {
    "i": re.IGNORECASE,
    "m": re.MULTILINE,
    "s": re.DOTALL,
    "x": re.VERBOSE,
}
_VALID_SCOPES = ("prefix", "anywhere", "line")


def _compile_flags(flags: str) -> int:
    out = 0
    for ch in flags:
        flag = _FLAG_CHARS.get(ch.lower())
        if flag is None:
            _log.warning("text_pipeline: unknown regex flag %r — ignoring", ch)
            continue
        out |= flag
    return out


def parse_rules_json(blob: str, direction: str) -> Optional[List[Rule]]:
    """Parse a JSON array of rule entries.

    Returns the parsed rule list, or ``None`` if the JSON is malformed.
    Individual malformed rules are skipped with a warning; a wholly invalid
    blob yields ``None`` so callers can fall back to defaults.
    """
    try:
        data = json.loads(blob)
    except json.JSONDecodeError as e:
        _log.error("text_pipeline: failed to parse %s rules JSON: %s", direction, e)
        return None
    if not isinstance(data, list):
        _log.error("text_pipeline: %s rules must be a JSON array", direction)
        return None

    rules: List[Rule] = []
    for i, entry in enumerate(data):
        if not isinstance(entry, dict):
            _log.warning("text_pipeline: %s rule #%d skipped (not an object)", direction, i)
            continue
        name = entry.get("name") or f"{direction}_{i}"
        pattern_str = entry.get("pattern")
        if not isinstance(pattern_str, str) or not pattern_str:
            _log.warning("text_pipeline: %s rule %r skipped (missing pattern)", direction, name)
            continue
        replacement = entry.get("replacement", "")
        if not isinstance(replacement, str):
            _log.warning(
                "text_pipeline: %s rule %r skipped (replacement must be a string)",
                direction, name,
            )
            continue
        scope = entry.get("scope", "anywhere")
        if scope not in _VALID_SCOPES:
            _log.warning(
                "text_pipeline: %s rule %r unknown scope %r — using 'anywhere'",
                direction, name, scope,
            )
            scope = "anywhere"
        short_circuit = bool(entry.get("short_circuit", False))
        flags = _compile_flags(str(entry.get("flags", "")))
        try:
            pattern = re.compile(pattern_str, flags)
        except re.error as e:
            _log.error(
                "text_pipeline: %s rule %r skipped — invalid regex %r (%s)",
                direction, name, pattern_str, e,
            )
            continue
        rules.append(
            Rule(
                name=name,
                pattern=pattern,
                replacement=replacement,
                scope=scope,
                short_circuit=short_circuit,
            )
        )
    return rules


def _load_ruleset(env_var: str, defaults: List[Rule], direction: str) -> List[Rule]:
    """Read ``env_var`` and parse it into a rule list, falling back to defaults.

    Empty / unset → defaults. Malformed JSON → defaults (logged). Explicit
    ``[]`` → empty list (intentional disable).
    """
    blob = (os.environ.get(env_var) or "").strip()
    if not blob:
        return list(defaults)
    parsed = parse_rules_json(blob, direction)
    if parsed is None:
        return list(defaults)
    return parsed


def load_rules() -> Tuple[List[Rule], List[Rule]]:
    """Read both rule sets from the environment. Called at module import,
    and re-callable from tests via :func:`reload_rules`.
    """
    inbound = _load_ruleset(
        "VMUX_INBOUND_RULES", _DEFAULT_INBOUND_RULES, "inbound"
    )
    outbound = _load_ruleset(
        "VMUX_OUTBOUND_RULES", _DEFAULT_OUTBOUND_RULES, "outbound"
    )
    return inbound, outbound


INBOUND_RULES: List[Rule]
OUTBOUND_RULES: List[Rule]
INBOUND_RULES, OUTBOUND_RULES = load_rules()


def reload_rules() -> None:
    """Re-read the env vars and replace the module-level rule lists.

    Useful for tests and for any future "settings changed, reload" hook.
    """
    global INBOUND_RULES, OUTBOUND_RULES
    INBOUND_RULES, OUTBOUND_RULES = load_rules()


def apply_inbound(text: str) -> str:
    """Apply inbound rules to a transcription before it reaches Claude."""
    return apply_rules(text, INBOUND_RULES)


def apply_outbound(text: str) -> str:
    """Apply outbound rules to a Claude response before TTS."""
    return apply_rules(text, OUTBOUND_RULES)
