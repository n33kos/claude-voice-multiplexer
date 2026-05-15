"""Sanitize Claude response text before TTS synthesis.

Code blocks, file paths, and markdown markup read aloud as gibberish.
Replace them with short spoken-friendly placeholders rather than deleting,
so the surrounding prose stays coherent.

This will eventually fold into the outbound side of a bidirectional
text-replacement pipeline (ticket 4.4); for now it ships standalone.
"""

import re

_FENCED_CODE_RE = re.compile(r"```[\s\S]*?```", re.MULTILINE)
_INDENTED_CODE_RE = re.compile(r"(?:^|\n)((?: {4,}|\t)[^\n]+(?:\n(?: {4,}|\t)[^\n]+)*)")
_INLINE_CODE_RE = re.compile(r"`([^`\n]+)`")
_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_LINK_RE = re.compile(r"(?<!!)\[([^\]]+)\]\(([^)]+)\)")
_BARE_URL_RE = re.compile(r"\bhttps?://\S+")
_HEADING_RE = re.compile(r"^(#{1,6})\s+", re.MULTILINE)
_BOLD_RE = re.compile(r"\*\*([^*\n]+)\*\*")
_ITALIC_RE = re.compile(r"(?<!\*)\*([^*\n]+)\*(?!\*)")
_STRIKE_RE = re.compile(r"~~([^~\n]+)~~")
# Match POSIX-style paths with at least two segments (so "and/or" doesn't trip it).
# Allows leading ~, ./, ../, or /, and segments of word chars / dots / dashes.
_FILE_PATH_RE = re.compile(
    r"(?<![\w/])(?:~|\.\.?)?(?:/[\w.\-]+){2,}/?"
    r"|(?<![\w/])[\w.\-]+(?:/[\w.\-]+){2,}/?"
)

CODE_BLOCK_PLACEHOLDER = "code block"
INLINE_CODE_PLACEHOLDER = "code"
PATH_PLACEHOLDER = "this file"
LINK_PLACEHOLDER = "link"


def _replace_inline_code(match: re.Match) -> str:
    # Speak inline code verbatim — single-backtick spans are short by nature
    # and usually carry meaning the listener needs (identifiers, filenames,
    # flags).  Only fenced blocks get summarized to a placeholder.
    return match.group(1).strip()


def _replace_link(match: re.Match) -> str:
    text = match.group(1).strip()
    return text if text else LINK_PLACEHOLDER


def _replace_image(match: re.Match) -> str:
    alt = match.group(1).strip()
    return alt if alt else "image"


def _replace_path(match: re.Match) -> str:
    return PATH_PLACEHOLDER


def _collapse_whitespace(text: str) -> str:
    # Collapse runs of blank lines into a single newline pair, then normalize
    # trailing spaces. Keep paragraph breaks so prosody stays natural.
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def sanitize_for_tts(text: str) -> str:
    """Return a spoken-friendly version of ``text`` for Kokoro.

    Transformations (in order):
      1. Fenced code blocks → "code block"
      2. Markdown images → alt text (or "image")
      3. Markdown links → link text only
      4. Bare URLs → "link"
      5. Long file paths → "this file"
      6. Inline code → "code" (or the bare identifier when trivial)
      7. Headings (``##`` etc.) → strip the marker, keep the text
      8. Bold / italic / strikethrough → keep the inner text
      9. Collapse extra whitespace
    """
    if not text:
        return text

    out = _FENCED_CODE_RE.sub(CODE_BLOCK_PLACEHOLDER, text)
    # Inline code before paths/links so backticked content gets a single
    # replacement instead of nested replacements (e.g. `app/foo.py` → "code"
    # rather than "`this file`").
    out = _INLINE_CODE_RE.sub(_replace_inline_code, out)
    out = _IMAGE_RE.sub(_replace_image, out)
    out = _LINK_RE.sub(_replace_link, out)
    out = _BARE_URL_RE.sub(LINK_PLACEHOLDER, out)
    out = _FILE_PATH_RE.sub(_replace_path, out)
    out = _HEADING_RE.sub("", out)
    out = _BOLD_RE.sub(r"\1", out)
    out = _ITALIC_RE.sub(r"\1", out)
    out = _STRIKE_RE.sub(r"\1", out)
    out = _collapse_whitespace(out)
    return out
