"""Bidirectional text replacement pipeline.

Applies an ordered list of regex replacements in two directions:

  * Inbound  — STT transcription → Claude input  (post-Whisper, pre-Claude)
  * Outbound — Claude response   → TTS input     (post-Claude, pre-Kokoro)

Replacements live in a JSON file (``~/.claude/voice-multiplexer/replacements.json``
by default; override with the ``VMUX_REPLACEMENTS_FILE`` env var)::

    {
      "inbound":  [{"name": "...", "pattern": "...", "replacement": "..."}, ...],
      "outbound": [...]
    }

Use inline regex flags (``(?i)`` for case-insensitive, ``(?m)`` for multiline,
etc.) inside ``pattern`` — there is no separate flags field. Anchor with
``^`` or ``$`` for prefix/suffix-only matching; otherwise every occurrence
in the text is replaced. If the file is missing or malformed the
hardcoded defaults below are used so behavior never silently disappears.
"""

import json
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import List, Pattern, Tuple

# Side-effect: load .env if config.py is importable. Safe in non-relay
# contexts (e.g. unit tests) where config.py may not be present.
try:
    import config  # noqa: F401
except Exception:
    pass

_log = logging.getLogger("relay.replacements")

DEFAULT_REPLACEMENTS_PATH = (
    Path.home() / ".claude" / "voice-multiplexer" / "replacements.json"
)


@dataclass(frozen=True)
class Replacement:
    """One regex replacement applied to text in one direction."""

    name: str
    pattern: Pattern[str]
    replacement: str


# Hardcoded fallback used when the JSON file is missing or malformed.
# Mirrors scripts/replacements.json so behavior is consistent regardless.
_DEFAULT_INBOUND: List[Replacement] = [
    Replacement(
        name="btw_prefix",
        pattern=re.compile(r"(?i)^\s*by\s+the\s+way\b[\s,]*"),
        replacement="/btw ",
    ),
]
_DEFAULT_OUTBOUND: List[Replacement] = []


def _parse_entries(entries, direction: str) -> List[Replacement]:
    out: List[Replacement] = []
    if not isinstance(entries, list):
        _log.warning(
            "replacements: %s must be a JSON array — got %s",
            direction, type(entries).__name__,
        )
        return out
    for i, entry in enumerate(entries):
        if not isinstance(entry, dict):
            _log.warning("replacements: %s entry #%d skipped (not an object)", direction, i)
            continue
        name = entry.get("name") or f"{direction}_{i}"
        pattern_src = entry.get("pattern")
        replacement = entry.get("replacement", "")
        if not isinstance(pattern_src, str) or not pattern_src:
            _log.warning(
                "replacements: %s entry %r skipped (missing pattern)", direction, name,
            )
            continue
        if not isinstance(replacement, str):
            _log.warning(
                "replacements: %s entry %r skipped (replacement must be a string)",
                direction, name,
            )
            continue
        try:
            pattern = re.compile(pattern_src)
        except re.error as e:
            _log.error(
                "replacements: %s entry %r skipped — invalid regex %r (%s)",
                direction, name, pattern_src, e,
            )
            continue
        out.append(Replacement(name=name, pattern=pattern, replacement=replacement))
    return out


def _resolve_path() -> Path:
    override = (os.environ.get("VMUX_REPLACEMENTS_FILE") or "").strip()
    if override:
        return Path(os.path.expanduser(override))
    return DEFAULT_REPLACEMENTS_PATH


def load_replacements() -> Tuple[List[Replacement], List[Replacement]]:
    """Read both replacement lists from the JSON file.

    Returns hardcoded defaults if the file is missing or malformed so the
    relay never silently stops applying the /btw rule on a typo.
    """
    path = _resolve_path()
    if not path.exists():
        _log.debug("replacements: %s not found — using built-in defaults", path)
        return list(_DEFAULT_INBOUND), list(_DEFAULT_OUTBOUND)
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as e:
        _log.error(
            "replacements: failed to load %s (%s) — using built-in defaults", path, e,
        )
        return list(_DEFAULT_INBOUND), list(_DEFAULT_OUTBOUND)
    if not isinstance(data, dict):
        _log.error(
            "replacements: %s must be a JSON object — using built-in defaults", path,
        )
        return list(_DEFAULT_INBOUND), list(_DEFAULT_OUTBOUND)
    inbound = _parse_entries(data.get("inbound", []), "inbound")
    outbound = _parse_entries(data.get("outbound", []), "outbound")
    return inbound, outbound


INBOUND_REPLACEMENTS: List[Replacement]
OUTBOUND_REPLACEMENTS: List[Replacement]
INBOUND_REPLACEMENTS, OUTBOUND_REPLACEMENTS = load_replacements()


def reload() -> None:
    """Re-read the JSON file and replace the module-level lists.

    Used by tests and any future "settings changed" callback.
    """
    global INBOUND_REPLACEMENTS, OUTBOUND_REPLACEMENTS
    INBOUND_REPLACEMENTS, OUTBOUND_REPLACEMENTS = load_replacements()


def _apply(text: str, rules: List[Replacement]) -> str:
    if not text:
        return text
    for r in rules:
        text = r.pattern.sub(r.replacement, text)
    return text


def apply_inbound(text: str) -> str:
    """Apply inbound replacements to a transcription before it reaches Claude."""
    return _apply(text, INBOUND_REPLACEMENTS)


def apply_outbound(text: str) -> str:
    """Apply outbound replacements to a Claude response before TTS."""
    return _apply(text, OUTBOUND_REPLACEMENTS)
