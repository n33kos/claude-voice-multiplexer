# Investigation: `relay_code_block` / `relay_image` vs raw markdown

**Ticket**: ws-075 (chain item, scope-setter for ws-013 collapse logic)
**Date**: 2026-05-15
**Status**: Closed — recommend **keep both MCP tools**, with notes for ws-013.

---

## TL;DR

- **Code parity is already 99% there via markdown** — `Transcript.tsx:517–524` routes fenced
  code blocks through the same `CodeBlock` component used by `relay_code_block`. Syntax
  highlighting, copy button, scroll behavior, inline-vs-block detection: all identical.
- **The one thing markdown can't do**: pass a `filename`, which enables the
  `vscode://file/...` click-to-open affordance (`Transcript.tsx:137–141`). Fenced
  code blocks only carry a `language` hint.
- **Images: keep `relay_image`.** Markdown `![](data:image/png;base64,...)` works visually
  but inlines the base64 payload into Claude's assistant message, which then gets re-read
  on every subsequent turn. Token cost is prohibitive; `relay_image` reads from disk path
  and keeps the binary out of Claude's context entirely.

## Evidence

1. `web/src/components/Transcript/Transcript.tsx:517–524` — when Claude's message is
   rendered via `ReactMarkdown`, the `code` component override forwards any fenced or
   multiline block to `<CodeBlock code={text} language={match?.[1]} cwd={cwd} />`. Same
   component, same styling, same copy button. No second implementation.
2. `Transcript.tsx:471` — the `code` / `file` entry-type branch renders
   `<CodeBlock code={entry.text} filename={entry.filename} language={entry.language} cwd={cwd} />`.
   The **only** prop the MCP-tool path adds is `filename`.
3. `Transcript.tsx:132–141` — `filename` → `resolveFilePath` → `vscode://file/...` link.
   No filename, no link.
4. `relay-server/mcp_tools.py:251–278` — `relay_code_block(code, filename, language)`
   passes all three through to `notify_transcript("code", ...)`.
5. `relay-server/mcp_tools.py:333–369` — `relay_image(file_path)` reads bytes from disk,
   base64-encodes them server-side, broadcasts as an `image` entry. Claude's message
   payload itself stays small (just the tool call args: a path string).

## Decision

**Keep both MCP tools.** Rationale:

- `relay_code_block` earns its keep specifically when a `filename` is involved — the
  click-to-open-in-VSCode affordance is real value and there's no clean way to express
  filename in a markdown fence info string today. For filename-less code (output, JSON
  dumps, ad-hoc snippets), markdown is strictly equivalent — Claude can use either.
- `relay_image` is a token-cost win, not just an ergonomic one. Don't deprecate.

## Recommendation for ws-013 (collapse logic)

The original plan asked: does ws-013 only collapse `activity` entries, or does it also
need to handle `code` / `file` / `image`?

Since we're keeping the MCP tools, **ws-013 should treat `code`, `file`, and `image` as
collapsible entry types alongside `activity`** — they interleave with activity badges
during dense tool use (e.g., Claude shows a file, runs a command, shows a diff, runs
another command) and a collapse group that only folds activity will leave the transcript
visually noisy. Group adjacent non-prose entries into a single collapsible block.

## Optional follow-up (not in scope for ws-075)

If we later want to fully retire `relay_code_block`, the path is: extend the fence
info-string parser in the `ReactMarkdown` `code` override to accept
` ```ts path/to/file.ts ` (or a `// path/to/file.ts` first-line convention) and forward
`filename` to `CodeBlock`. Then Claude pastes markdown and gets the VSCode link for free.
Worth maybe an hour; not urgent.
