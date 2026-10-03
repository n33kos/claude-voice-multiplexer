#!/usr/bin/env bash
#
# test.sh — run every test suite: relay unit + contract tests, web app, client SDK.
#
#   ./scripts/test.sh
#
# Contract tests run under uv with the relay's real dependencies and a temp
# HOME, so they never touch ~/.claude/voice-multiplexer.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
status=0

echo "== relay: unit + contract tests"
(cd "$ROOT/relay-server" && uv run -q --python 3.12 --with-requirements requirements.txt --with pytest \
    pytest -q -W ignore::Warning .) || status=1

echo "== web + client SDK (web/sdk)"
(cd "$ROOT/web" && npx vitest run) || status=1

exit $status
