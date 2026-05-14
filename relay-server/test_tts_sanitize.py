"""Unit tests for tts_sanitize.sanitize_for_tts.

Run with: python3 -m unittest relay-server/test_tts_sanitize.py
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from tts_sanitize import sanitize_for_tts  # noqa: E402


class FencedCodeBlocks(unittest.TestCase):
    def test_strips_fenced_block(self):
        text = "Here is some code:\n```python\nprint('hi')\n```\nAfter."
        out = sanitize_for_tts(text)
        self.assertIn("code block", out)
        self.assertNotIn("print", out)
        self.assertIn("After.", out)

    def test_strips_fenced_block_without_language(self):
        out = sanitize_for_tts("Try ```ls -la``` then continue.")
        self.assertIn("code block", out)
        self.assertNotIn("ls -la", out)
        self.assertIn("continue", out)

    def test_multiple_fenced_blocks(self):
        text = "First:\n```\na\n```\nSecond:\n```\nb\n```\nDone."
        out = sanitize_for_tts(text)
        self.assertEqual(out.count("code block"), 2)


class InlineCode(unittest.TestCase):
    def test_inline_replaced_with_placeholder(self):
        out = sanitize_for_tts("As I mentioned in `useEffect.cleanup()`, it…")
        # Should not leave broken prose like "in , it"
        self.assertNotIn("in ,", out)
        self.assertIn("code", out)

    def test_inline_identifier_kept_as_word(self):
        # Bare identifiers read fine — keep them
        out = sanitize_for_tts("The `useState` hook returns a tuple.")
        self.assertIn("useState", out)
        self.assertNotIn("`", out)

    def test_inline_short_symbol_replaced(self):
        out = sanitize_for_tts("Use `&&` to chain.")
        self.assertNotIn("`", out)
        self.assertIn("code", out)


class MarkdownLinks(unittest.TestCase):
    def test_link_text_kept_url_dropped(self):
        out = sanitize_for_tts("See [the docs](https://example.com/foo).")
        self.assertIn("the docs", out)
        self.assertNotIn("example.com", out)
        self.assertNotIn("](", out)

    def test_bare_url_replaced(self):
        out = sanitize_for_tts("Check https://example.com/foo for details.")
        self.assertNotIn("example.com", out)
        self.assertIn("link", out)

    def test_link_with_empty_text_uses_placeholder(self):
        out = sanitize_for_tts("See [](https://example.com).")
        self.assertNotIn("example.com", out)
        self.assertIn("link", out)


class MarkdownImages(unittest.TestCase):
    def test_image_alt_kept(self):
        out = sanitize_for_tts("Look: ![a red square](foo.png) here.")
        self.assertIn("a red square", out)
        self.assertNotIn("foo.png", out)
        self.assertNotIn("![", out)

    def test_image_without_alt(self):
        out = sanitize_for_tts("![](foo.png)")
        self.assertIn("image", out)
        self.assertNotIn("foo.png", out)


class FilePaths(unittest.TestCase):
    def test_absolute_path_replaced(self):
        out = sanitize_for_tts("Edit /Users/nick/code/foo/bar.py to fix it.")
        self.assertNotIn("/Users", out)
        self.assertIn("this file", out)

    def test_relative_path_replaced(self):
        out = sanitize_for_tts("Open app/assets/javascripts/heartbeat/index.ts next.")
        self.assertNotIn("heartbeat/index", out)
        self.assertIn("this file", out)

    def test_short_path_unchanged(self):
        # Two segments shouldn't trigger — too noisy otherwise ("and/or", "src/index").
        out = sanitize_for_tts("Try src/index.")
        self.assertIn("src/index", out)

    def test_url_path_not_double_replaced(self):
        # URL handling should consume the URL before path regex sees it.
        out = sanitize_for_tts("Visit https://example.com/a/b/c please.")
        self.assertIn("link", out)
        self.assertNotIn("this file", out)


class Markdown(unittest.TestCase):
    def test_heading_marker_stripped(self):
        out = sanitize_for_tts("## Section title\nBody here.")
        self.assertNotIn("#", out)
        self.assertIn("Section title", out)

    def test_bold_kept(self):
        out = sanitize_for_tts("This is **important** text.")
        self.assertIn("important", out)
        self.assertNotIn("**", out)

    def test_italic_kept(self):
        out = sanitize_for_tts("This is *emphasized* text.")
        self.assertIn("emphasized", out)
        self.assertNotIn("*", out)

    def test_strikethrough_kept(self):
        out = sanitize_for_tts("This is ~~old~~ news.")
        self.assertIn("old", out)
        self.assertNotIn("~~", out)


class Whitespace(unittest.TestCase):
    def test_collapses_blank_lines(self):
        out = sanitize_for_tts("First line.\n\n\n\nSecond line.")
        self.assertEqual(out.count("\n\n"), 1)

    def test_trims_result(self):
        out = sanitize_for_tts("\n\n  Hello.  \n\n")
        self.assertEqual(out, "Hello.")

    def test_empty_input_returns_empty(self):
        self.assertEqual(sanitize_for_tts(""), "")


class Coherence(unittest.TestCase):
    def test_full_response_stays_coherent(self):
        text = (
            "I updated the `handleClick` function in "
            "`app/components/Button/Button.tsx` to fix the bug. "
            "See [the PR](https://github.com/example/repo/pull/1) "
            "for details. Here's the change:\n\n"
            "```ts\nconst x = 1;\n```\n\n"
            "Let me know if you want me to revisit."
        )
        out = sanitize_for_tts(text)
        # Sentence structure preserved
        self.assertIn("I updated", out)
        self.assertIn("to fix the bug", out)
        self.assertIn("the PR", out)
        self.assertIn("Here's the change", out)
        self.assertIn("code block", out)
        self.assertIn("Let me know", out)
        # No raw artifacts
        for artifact in ["```", "github.com", "Button.tsx", "[", "](", "`"]:
            self.assertNotIn(artifact, out)


if __name__ == "__main__":
    unittest.main()
