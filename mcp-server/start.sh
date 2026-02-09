#!/usr/bin/env bash
# Wrapper script for the MCP server.
# Resolves its own location so `uv run` can find the server script
# regardless of the working directory.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec uv run \
    --with "fastmcp>=2.0" \
    --with "websockets>=12.0" \
    "$SCRIPT_DIR/server.py"
