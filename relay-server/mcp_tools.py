"""MCP tools for Claude Voice Multiplexer.

Provides voice relay tools that Claude Code sessions use to interact with
the relay server. Mounted as an SSE endpoint on the relay server so all
Claude sessions share a single server process.

Session tracking: each SSE connection gets a unique MCP session_id from
FastMCP. The working directory is auto-detected via MCP roots (provided
by Claude Code). All tool calls automatically resolve their session —
no session parameters needed.
"""

import asyncio
import hashlib
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse, unquote

from fastmcp import FastMCP, Context

import auth
from config import AUTH_ENABLED

# Background task set — prevents fire-and-forget tasks from being GC'd
_bg_tasks: set[asyncio.Task] = set()


def _bg(coro) -> asyncio.Task:
    """Create a managed background task."""
    task = asyncio.create_task(coro)
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)
    return task

mcp = FastMCP("voice-multiplexer")


def _make_session_id(cwd: str) -> str:
    """Generate a deterministic session ID from a working directory path."""
    return hashlib.sha256(cwd.encode()).hexdigest()[:12]


def _file_uri_to_path(uri: str) -> str:
    """Convert a file:// URI to a filesystem path."""
    parsed = urlparse(str(uri))
    return unquote(parsed.path)


# --- Per-connection session mapping ---
# Maps FastMCP session_id → (relay_session_id, cwd)
_connection_map: dict[str, tuple[str, str]] = {}
# Throttle relay_activity: maps relay session_id → (last_time, last_activity)
_ACTIVITY_MIN_INTERVAL = 3.0  # seconds
_last_activity: dict[str, tuple[float, str]] = {}


async def _resolve_session(ctx: Context) -> tuple[Optional[str], Optional[str]]:
    """Get the relay session_id for this SSE connection.

    Auto-registers the session on first call using MCP roots.
    Returns (session_id, error_message).
    """
    mcp_sid = ctx.session_id
    entry = _connection_map.get(mcp_sid)
    if entry:
        session_id, _cwd = entry
        # Fast path — verify session still exists in registry.
        registry = _app["registry"]
        if await registry.get(session_id):
            return session_id, None
        # Session was pruned — clear stale mapping and fall through to re-registration.
        _connection_map.pop(mcp_sid, None)

    # First call from this connection (or session was pruned) — detect cwd via MCP roots
    cwd = await _detect_cwd(ctx)
    if not cwd:
        return None, "No working directory detected."

    session_id = _make_session_id(cwd)

    # Register the session in the relay registry
    registry = _app["registry"]
    if not registry:
        return None, "Registry unavailable."

    session, is_reconnect = await registry.register(
        session_id=session_id,
        name=cwd,
        cwd=cwd,
        dir_name=Path(cwd).name,
    )
    label = "reconnected" if is_reconnect else "registered"
    print(f"[mcp] Session {label}: {cwd} ({session_id}) → room {session.room_name}")

    # Cache the mapping only after successful registration
    _connection_map[mcp_sid] = (session_id, cwd)

    # Manage LiveKit room
    agent = _app["get_agent"]()
    if agent:
        if is_reconnect:
            try:
                await agent.remove_session(session_id)
            except Exception as e:
                print(f"[mcp] Error removing old room (continuing): {e}")
        try:
            await agent.add_session(session_id, session.room_name)
        except Exception as e:
            print(f"[mcp] Failed to create room for session: {e}")

    if _app["broadcast_sessions"]:
        await _app["broadcast_sessions"]()

    return session_id, None


async def _detect_cwd(ctx: Context) -> Optional[str]:
    """Detect the client's working directory from MCP roots."""
    try:
        roots = await ctx.list_roots()
        if roots:
            return _file_uri_to_path(roots[0].uri)
    except Exception as e:
        print(f"[mcp] list_roots failed: {e}")
    return None


# --- App state (set by server.py at startup) ---

_app = {
    "registry": None,
    "get_agent": None,
    "notify_transcript": None,
    "notify_status": None,
    "broadcast_sessions": None,
}


def init(registry, get_agent, notify_transcript, notify_status, broadcast_sessions):
    """Initialize MCP tools with relay server dependencies."""
    _app["registry"] = registry
    _app["get_agent"] = get_agent
    _app["notify_transcript"] = notify_transcript
    _app["notify_status"] = notify_status
    _app["broadcast_sessions"] = broadcast_sessions


@mcp.tool()
async def relay_notify(ctx: Context, message: str, source: str = "") -> str:
    """Post a background agent completion notice to the session transcript.

    Args:
        message: Notification text shown in the web transcript
        source: Optional agent label
    """
    session_id, err = await _resolve_session(ctx)
    if err:
        return err

    registry = _app["registry"]
    session = await registry.get(session_id)
    if not session:
        return "Session not found."

    prefix = f"[Background agent{': ' + source if source else ''}]"
    full_message = f"{prefix} {message}"

    # Broadcast to web transcript so the notification is visible in real time.
    # The parent session will discover completion on its next turn — we no
    # longer wake it via a queue because the standby loop has been removed.
    if _app["notify_transcript"]:
        await _app["notify_transcript"](session_id, "system", full_message)

    return "Sent."


@mcp.tool()
async def relay_activity(ctx: Context, activity: str, source: str = "") -> str:
    """Show the remote user what you're working on. Call before significant operations.

    Args:
        activity: Short status, e.g. "Reading files..."
        source: Optional agent label
    """
    session_id, err = await _resolve_session(ctx)
    if err:
        return err

    # Keep session alive by touching the heartbeat on every tool call
    registry = _app["registry"]
    if registry:
        await registry.heartbeat(session_id)

    labeled = f"[{source}] {activity}" if source else activity

    # Throttle: skip if same activity within min interval
    import time as _time
    now = _time.monotonic()
    prev = _last_activity.get(session_id)
    if prev:
        prev_time, prev_text = prev
        if labeled == prev_text and (now - prev_time) < _ACTIVITY_MIN_INTERVAL:
            return "OK"
    _last_activity[session_id] = (now, labeled)

    agent = _app["get_agent"]()
    if agent and labeled:
        _bg(agent.handle_status_update(session_id, labeled))

    return "OK"


@mcp.tool()
async def relay_respond(ctx: Context, text: str) -> str:
    """Send a spoken response to the remote user via TTS.

    Args:
        text: Response text to synthesize as speech
    """
    session_id, err = await _resolve_session(ctx)
    if err:
        return err

    # Keep session alive by touching the heartbeat on every tool call
    registry = _app["registry"]
    if registry:
        await registry.heartbeat(session_id)

    if not text:
        return "No text provided."

    agent = _app["get_agent"]()
    if agent:
        _bg(agent.handle_claude_response(session_id, text))

    # Broadcast transcript
    if _app["notify_transcript"]:
        await _app["notify_transcript"](session_id, "claude", text)

    return "OK"


@mcp.tool()
async def relay_code_block(ctx: Context, code: str, filename: str = "", language: str = "") -> str:
    """Display code, diffs, tables, or structured content in the web transcript. Use when the user asks to see or show something.

    Args:
        code: Content to display (code, diff, markdown table, JSON, logs, etc.)
        filename: Optional filename for context
        language: Optional language hint for syntax highlighting
    """
    session_id, err = await _resolve_session(ctx)
    if err:
        return err

    # Keep session alive by touching the heartbeat on every tool call
    registry = _app["registry"]
    if registry:
        await registry.heartbeat(session_id)

    if not code:
        return "No code provided."

    if _app["notify_transcript"]:
        await _app["notify_transcript"](
            session_id, "code", code,
            filename=filename,
            language=language,
        )

    return "OK"


@mcp.tool()
async def relay_disconnect(ctx: Context) -> str:
    """Disconnect from the voice relay and exit standby."""
    session_id, err = await _resolve_session(ctx)
    if err:
        return err

    registry = _app["registry"]
    agent = _app["get_agent"]()

    if agent:
        try:
            await agent.remove_session(session_id)
        except Exception as e:
            print(f"[mcp] Error removing room: {e}")

    await registry.unregister(session_id)

    # Clean up connection mapping
    mcp_sid = ctx.session_id
    _connection_map.pop(mcp_sid, None)

    if _app["broadcast_sessions"]:
        await _app["broadcast_sessions"]()

    return "Disconnected."


@mcp.tool()
async def relay_status(ctx: Context) -> str:
    """Show relay connection status."""
    registry = _app["registry"]
    if not registry:
        return "Not initialized."

    session_id, err = await _resolve_session(ctx)
    if not err and session_id:
        session = await registry.get(session_id)
        if session:
            return f"Connected: {session.name} ({session_id})"

    sessions = await registry.list_sessions()
    if not sessions:
        return "Not connected. No sessions."

    lines = ["Not connected. Sessions:"]
    for s in sessions:
        lines.append(f"- {s['name']} ({s['session_id']})")
    return "\n".join(lines)


@mcp.tool()
async def relay_image(ctx: Context, file_path: str) -> str:
    """Send a local image to the web transcript (JPEG, PNG, GIF, WebP, SVG, BMP).

    Args:
        file_path: Path to the image file
    """
    session_id, err = await _resolve_session(ctx)
    if err:
        return err

    # Keep session alive by touching the heartbeat on every tool call
    registry = _app["registry"]
    if registry:
        await registry.heartbeat(session_id)

    # Resolve path
    try:
        p = Path(file_path).expanduser().resolve()
        if not p.exists():
            return f"File not found: {file_path}"
        if not p.is_file():
            return f"Not a file: {file_path}"
    except Exception as e:
        return f"Invalid path: {e}"

    # Detect MIME type from extension
    suffix = p.suffix.lower()
    mime_map = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".png": "image/png", ".gif": "image/gif",
        ".webp": "image/webp", ".svg": "image/svg+xml",
        ".bmp": "image/bmp", ".ico": "image/x-icon",
    }
    mime_type = mime_map.get(suffix)
    if not mime_type:
        return f"Unsupported format: {suffix}"

    # Read and base64 encode
    try:
        import base64
        data = p.read_bytes()
        b64 = base64.b64encode(data).decode("ascii")
    except Exception as e:
        return f"Failed to read image: {e}"

    # Send to transcript as image type (not buffered server-side to avoid memory bloat)
    if _app["notify_transcript"]:
        await _app["notify_transcript"](
            session_id, "image", b64,
            filename=p.name,
            mime_type=mime_type,
        )

    return f"OK: {p.name}"


@mcp.tool()
async def relay_file(ctx: Context, file_path: str, read_aloud: bool = False) -> str:
    """Send a file's contents to the web transcript with syntax highlighting. Bypasses Claude to save tokens.

    Args:
        file_path: Path to the file
        read_aloud: Also synthesize as speech (default: false)
    """
    session_id, err = await _resolve_session(ctx)
    if err:
        return err

    # Keep session alive by touching the heartbeat on every tool call
    registry = _app["registry"]
    if registry:
        await registry.heartbeat(session_id)

    # Resolve path
    try:
        p = Path(file_path).expanduser().resolve()
        if not p.exists():
            return f"File not found: {file_path}"
        if not p.is_file():
            return f"Not a file: {file_path}"
    except Exception as e:
        return f"Invalid path: {e}"

    # Read file
    try:
        content = p.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return f"Failed to read file: {e}"

    # Detect language for syntax highlighting
    suffix = p.suffix.lower()
    language_map = {
        ".py": "python", ".js": "javascript", ".ts": "typescript",
        ".tsx": "typescript", ".jsx": "javascript", ".json": "json",
        ".md": "markdown", ".yaml": "yaml", ".yml": "yaml",
        ".xml": "xml", ".html": "html", ".css": "css",
        ".java": "java", ".go": "go", ".rs": "rust",
        ".rb": "ruby", ".php": "php", ".sh": "bash",
        ".c": "c", ".cpp": "cpp", ".sql": "sql",
    }
    language = language_map.get(suffix, "")

    # Read aloud via TTS if requested
    if read_aloud:
        agent = _app["get_agent"]()
        if agent:
            _bg(agent.handle_claude_response(session_id, content))

    # Send to transcript
    if _app["notify_transcript"]:
        await _app["notify_transcript"](
            session_id, "file", content,
            filename=p.name,
            language=language,
        )

    return f"OK: {p.name}"


@mcp.tool()
async def generate_auth_code() -> str:
    """Generate a one-time device pairing code (valid 60s)."""
    if not AUTH_ENABLED:
        return "Auth disabled."

    try:
        code = auth.generate_pair_code()
        return f"Code: {code} (expires {auth.CODE_TTL_S}s)"
    except Exception as e:
        return f"Error: {e}"


def cleanup_stale_connections(active_session_ids: set[str]) -> int:
    """Remove stale MCP connection mappings for sessions that no longer exist.

    Called periodically by the server's memory cleanup loop.
    Returns the number of stale mappings removed.
    """
    removed = 0

    # Find MCP session IDs that map to dead relay sessions
    stale_mcp_sids = [
        mcp_sid for mcp_sid, (relay_sid, _cwd) in _connection_map.items()
        if relay_sid not in active_session_ids
    ]
    for mcp_sid in stale_mcp_sids:
        _connection_map.pop(mcp_sid, None)
        removed += 1

    # Clean up activity throttle entries for dead sessions
    for sid in list(_last_activity):
        if sid not in active_session_ids:
            _last_activity.pop(sid, None)

    return removed


def create_mcp_app():
    """Create the FastMCP SSE Starlette app for mounting on the relay server."""
    return mcp.http_app(transport="sse")
