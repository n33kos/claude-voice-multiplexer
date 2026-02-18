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

mcp = FastMCP("voice-multiplexer")

STANDBY_LISTEN_TIMEOUT = 86400  # 24 hours
HEARTBEAT_INTERVAL = 30  # seconds — keep session alive during long standby waits


async def _heartbeat_loop(session_id: str):
    """Background task that sends periodic heartbeats to prevent session pruning.

    Runs while relay_standby is blocking on voice_queue.get(). Without this,
    the session would be pruned after SESSION_TIMEOUT (120s) of no tool calls.
    """
    registry = _app["registry"]
    while registry:
        await asyncio.sleep(HEARTBEAT_INTERVAL)
        session = await registry.get(session_id)
        if not session:
            break
        await registry.heartbeat(session_id)


def _make_session_id(cwd: str) -> str:
    """Generate a deterministic session ID from a working directory path."""
    return hashlib.sha256(cwd.encode()).hexdigest()[:12]


def _file_uri_to_path(uri: str) -> str:
    """Convert a file:// URI to a filesystem path."""
    parsed = urlparse(str(uri))
    return unquote(parsed.path)


# --- Per-connection session mapping ---
# Maps FastMCP session_id (unique per SSE connection) → relay session_id
_connection_map: dict[str, str] = {}
# Maps FastMCP session_id → working directory path (for display)
_connection_cwd: dict[str, str] = {}
# Maps relay session_id → persistent heartbeat task (runs for entire MCP connection lifetime)
_session_heartbeats: dict[str, "asyncio.Task[None]"] = {}


async def _resolve_session(ctx: Context) -> tuple[Optional[str], Optional[str]]:
    """Get the relay session_id for this SSE connection.

    Auto-registers the session on first call using MCP roots.
    Returns (session_id, error_message).
    """
    mcp_sid = ctx.session_id
    session_id = _connection_map.get(mcp_sid)
    if session_id:
        # Fast path — verify session still exists in registry.
        # If it was pruned while Claude was processing, we must re-register
        # rather than silently returning a dead session_id.
        registry = _app["registry"]
        if registry and await registry.get(session_id):
            # Session is alive — ensure the persistent heartbeat is still running.
            hb = _session_heartbeats.get(session_id)
            if not hb or hb.done():
                _session_heartbeats[session_id] = asyncio.create_task(_heartbeat_loop(session_id))
            return session_id, None
        # Session was pruned — clear stale mapping and fall through to re-registration.
        _connection_map.pop(mcp_sid, None)
        _connection_cwd.pop(mcp_sid, None)

    # First call from this connection (or session was pruned) — detect cwd via MCP roots
    cwd = await _detect_cwd(ctx)
    if not cwd:
        return None, "Could not detect working directory from MCP roots."

    session_id = _make_session_id(cwd)

    # Register the session in the relay registry
    registry = _app["registry"]
    if not registry:
        return None, "Relay server not initialized. Registry unavailable."

    session, is_reconnect = await registry.register(
        session_id=session_id,
        name=cwd,
        cwd=cwd,
        dir_name=Path(cwd).name,
    )
    label = "reconnected" if is_reconnect else "registered"
    print(f"[mcp] Session {label}: {cwd} ({session_id}) → room {session.room_name}")

    # Cache the mapping only after successful registration
    _connection_map[mcp_sid] = session_id
    _connection_cwd[mcp_sid] = cwd

    # Start (or restart) a persistent per-session heartbeat that keeps the session
    # alive for the entire MCP connection lifetime — including while Claude is
    # actively processing between relay_standby calls (bash commands, file reads,
    # etc.) when no relay tools are being called.
    old_hb = _session_heartbeats.get(session_id)
    if old_hb and not old_hb.done():
        old_hb.cancel()
    _session_heartbeats[session_id] = asyncio.create_task(_heartbeat_loop(session_id))

    # Manage LiveKit room
    agent = _app["get_agent"]()
    if agent:
        try:
            if is_reconnect:
                await agent.remove_session(session_id)
            await agent.add_session(session_id, session.room_name)
        except Exception as e:
            print(f"[mcp] Failed to manage room for session: {e}")

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
async def relay_standby(ctx: Context, session_name: str = "") -> str:
    """Register this Claude session with the voice relay server and enter standby mode.

    The session becomes available for remote voice interaction through the
    web client. Voice input is transcribed and delivered as text messages.
    Respond conversationally to each message.

    Args:
        session_name: Optional friendly name for this session (defaults to directory name)
    """
    registry = _app["registry"]
    if not registry:
        return "Relay server not initialized."

    session_id, err = await _resolve_session(ctx)
    if err:
        return err

    # Override display name if provided
    if session_name:
        session = await registry.get(session_id)
        if session:
            session.name = session_name

    # Update heartbeat
    await registry.heartbeat(session_id)

    # Signal that Claude is listening
    agent = _app["get_agent"]()
    if agent:
        asyncio.create_task(agent.handle_claude_listening(session_id))

    # Block waiting for a voice message.
    # The persistent per-session heartbeat (started in _resolve_session) keeps
    # the session alive during both this wait AND during Claude's processing
    # between standby calls — no separate per-standby heartbeat needed.
    session = await registry.get(session_id)
    if not session:
        return "Session not found in registry."

    try:
        msg = await asyncio.wait_for(
            session.voice_queue.get(),
            timeout=STANDBY_LISTEN_TIMEOUT,
        )
        await registry.heartbeat(session_id)
        return msg
    except asyncio.TimeoutError:
        return "[Standby]: No voice input received. Still listening."
    except asyncio.CancelledError:
        print(f"[mcp] Session cancelled (SSE disconnect): {session_id}")
        # Clean up the stale MCP connection mapping so the next SSE connection
        # from Claude Code starts fresh and re-registers properly.
        mcp_sid = ctx.session_id
        _connection_map.pop(mcp_sid, None)
        _connection_cwd.pop(mcp_sid, None)
        # Keep the per-session heartbeat running — it holds the session alive
        # in the registry during the reconnect window.
        raise
    except Exception as e:
        return f"[Standby error]: {e}"


@mcp.tool()
async def relay_activity(ctx: Context, activity: str) -> str:
    """Update the voice relay with Claude's current activity.

    Call this before significant operations so the remote user
    can see what you're working on (e.g. "Reading files...",
    "Running tests...", "Searching codebase...").

    Args:
        activity: Short description of current activity
    """
    session_id, err = await _resolve_session(ctx)
    if err:
        return err

    # Keep session alive during processing between relay_standby calls
    registry = _app["registry"]
    if registry:
        await registry.heartbeat(session_id)

    agent = _app["get_agent"]()
    if agent and activity:
        asyncio.create_task(agent.handle_status_update(session_id, activity))

    return "Status updated."


@mcp.tool()
async def relay_respond(ctx: Context, text: str) -> str:
    """Send a response back to the relay server for TTS synthesis.

    After receiving a voice message via relay_standby, use this tool to send
    your conversational response back. The relay server will synthesize it
    as speech and play it to the remote user.

    Args:
        text: Your conversational response to be spoken aloud
    """
    session_id, err = await _resolve_session(ctx)
    if err:
        return err

    # Keep session alive during processing between relay_standby calls
    registry = _app["registry"]
    if registry:
        await registry.heartbeat(session_id)

    if not text:
        return "No text provided."

    agent = _app["get_agent"]()
    if agent:
        asyncio.create_task(agent.handle_claude_response(session_id, text))

    # Broadcast transcript
    if _app["notify_transcript"]:
        await _app["notify_transcript"](session_id, "claude", text)

    return "Response sent."


@mcp.tool()
async def relay_code_block(ctx: Context, code: str, filename: str = "", language: str = "") -> str:
    """Push a code snippet or diff into the voice relay transcript.

    Use this to show the remote user code changes, file contents, or diffs
    in the transcript with syntax highlighting. Call it after editing files
    or when the user asks to see code.

    IMPORTANT: When in voice relay mode, the user is viewing a chat-style
    transcript on their phone/browser. Use this tool whenever the user asks
    you to show, display, or output structured content — including:
    - Code snippets or file contents
    - Diffs or patches
    - Tables (use markdown table syntax, language="markdown")
    - Structured data (JSON, YAML, etc.)
    - Command output or logs
    - Any content that benefits from monospace formatting

    If the user asks to "see" something, "show" something, or requests
    output that would be hard to read as spoken text, use this tool to
    surface it visually in the transcript.

    Args:
        code: The code snippet, diff, or file content to display
        filename: Optional filename for context (e.g. "src/App.tsx")
        language: Optional language hint for syntax highlighting (e.g. "typescript", "python", "diff")
    """
    session_id, err = await _resolve_session(ctx)
    if err:
        return err

    # Keep session alive during processing between relay_standby calls
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

    return "Code block sent."


@mcp.tool()
async def relay_disconnect(ctx: Context) -> str:
    """Disconnect from the voice relay server and exit standby mode."""
    session_id, err = await _resolve_session(ctx)
    if err:
        return err

    # Cancel the persistent per-session heartbeat
    hb = _session_heartbeats.pop(session_id, None)
    if hb and not hb.done():
        hb.cancel()

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
    _connection_cwd.pop(mcp_sid, None)

    if _app["broadcast_sessions"]:
        await _app["broadcast_sessions"]()

    return "Disconnected from relay. Standby ended."


@mcp.tool()
async def relay_status(ctx: Context) -> str:
    """Show current voice relay connection status."""
    registry = _app["registry"]
    if not registry:
        return "Relay server not initialized."

    session_id, err = await _resolve_session(ctx)
    if not err and session_id:
        session = await registry.get(session_id)
        if session:
            queued = session.voice_queue.qsize()
            return (
                f"Connected to relay server\n"
                f"  Session: {session.name}\n"
                f"  Session ID: {session_id}\n"
                f"  Queued messages: {queued}"
            )

    # Not connected or session resolution failed — list all sessions
    sessions = await registry.list_sessions()
    if not sessions:
        return "Not connected. No active sessions."

    lines = ["Not connected. Active sessions:"]
    for s in sessions:
        lines.append(f"  - {s['name']} ({s['session_id']})")
    return "\n".join(lines)


@mcp.tool()
async def relay_file(ctx: Context, file_path: str, read_aloud: bool = False) -> str:
    """Relay a file directly to the web app without passing through Claude.

    Reads a file and sends its contents directly to the relay server,
    bypassing Claude entirely. This saves tokens when you want to show
    large files to the web client.

    Args:
        file_path: Path to the file to relay (relative or absolute)
        read_aloud: Whether to read the file aloud as well (default: false).

    Returns:
        Confirmation message or error
    """
    session_id, err = await _resolve_session(ctx)
    if err:
        return err

    # Keep session alive during processing between relay_standby calls
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
            asyncio.create_task(agent.handle_claude_response(session_id, content))

    # Send to transcript
    if _app["notify_transcript"]:
        await _app["notify_transcript"](
            session_id, "file", content,
            filename=p.name,
            language=language,
        )

    return f"File relayed: {p.name} ({len(content)} chars)"


@mcp.tool()
async def generate_auth_code() -> str:
    """Generate a one-time pairing code for authorizing a new device.

    The code is valid for 60 seconds. Enter it on the web app's pairing
    screen to authorize the device for voice interaction.

    Requires an active connection to the relay server (call relay_standby first).
    """
    if not AUTH_ENABLED:
        return "Authentication is not enabled."

    try:
        code = auth.generate_pair_code()
        return (
            f"Pairing code: {code}\n"
            f"Enter this code on the web app to authorize the device.\n"
            f"Code expires in {auth.CODE_TTL_S} seconds."
        )
    except Exception as e:
        return f"Failed to generate auth code: {e}"


def create_mcp_app():
    """Create the FastMCP SSE Starlette app for mounting on the relay server."""
    return mcp.http_app(transport="sse")
