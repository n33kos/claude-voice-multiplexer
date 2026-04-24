"""Session manager — spawns and tracks Claude sessions via tmux."""

import asyncio
import hashlib
import json
import logging
import os
import signal
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger("vmuxd.sessions")

# Shared HTTP client for relay API calls — lazy-initialized.
_session_http_client = None


async def _get_session_client():
    """Get or create the shared httpx client for session manager relay calls."""
    global _session_http_client
    if _session_http_client is None:
        import httpx
        _session_http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(5.0, connect=3.0),
            limits=httpx.Limits(max_connections=5, max_keepalive_connections=2),
        )
    return _session_http_client

SPAWN_POLL_INTERVAL = 2.0   # seconds between relay polling attempts
SPAWN_TIMEOUT = 120.0        # max seconds to wait for session to register
HEALTH_CHECK_INTERVAL = 30  # seconds between health checks
ZOMBIE_THRESHOLD = 90.0     # seconds without heartbeat = zombie
CAFFEINATE_REAP_INTERVAL = 60  # seconds between caffeinate reaper runs


def _make_session_id(cwd: str) -> str:
    """Generate a deterministic session ID from a working directory path.

    Mirrors the MCP plugin's algorithm (relay-server/mcp_tools.py) so the
    daemon can resolve relay session IDs without relying on dir_name matching.
    """
    return hashlib.sha256(cwd.encode()).hexdigest()[:12]


@dataclass
class SpawnedSession:
    daemon_id: str
    tmux_session: str
    cwd: str
    session_name: str = ""
    relay_session_id: Optional[str] = None
    pid: Optional[int] = None
    status: str = "spawning"  # spawning, standby, active, zombie, dead, spawn_failed
    spawned_at: float = field(default_factory=time.time)
    last_relay_heartbeat: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {
            "daemon_id": self.daemon_id,
            "tmux_session": self.tmux_session,
            "cwd": self.cwd,
            "session_name": self.session_name,
            "relay_session_id": self.relay_session_id,
            "pid": self.pid,
            "status": self.status,
        }


class SessionManager:
    def __init__(self, relay_base_url: str, plugin_dir: str, daemon_secret: str):
        self._sessions: dict[str, SpawnedSession] = {}  # daemon_id → session
        self._relay_url = relay_base_url.rstrip("/")
        self._plugin_dir = plugin_dir
        self._daemon_secret = daemon_secret
        self._lock = asyncio.Lock()
        self._health_task: Optional[asyncio.Task] = None
        self._last_reap: float = 0.0

    async def start(self):
        await self.reconcile_orphans()
        self._health_task = asyncio.create_task(self._health_monitor())

    async def stop(self):
        if self._health_task and not self._health_task.done():
            self._health_task.cancel()
            try:
                await self._health_task
            except asyncio.CancelledError:
                pass

    async def spawn(self, cwd: str, session_name: str = "") -> dict:
        """Spawn a new Claude session in the given directory.

        If a managed session already exists for this CWD, it is killed first
        to prevent relay session ID collisions (the relay ID is a deterministic
        hash of the CWD, so two sessions with the same CWD would share the
        same relay ID and cause tracking/kill bugs).
        """
        cwd = os.path.expanduser(cwd)
        if not os.path.isdir(cwd):
            return {"ok": False, "error": f"Directory not found: {cwd}"}

        # Kill any existing managed session for this CWD to avoid relay ID collisions
        kill_old = False
        async with self._lock:
            existing = self._find_session_by_cwd(cwd)
            if existing and existing.status not in ("spawn_failed", "dead"):
                logger.info(f"[sessions] killing existing session for {cwd} before respawn: {existing.tmux_session}")
                daemon_id_old = existing.daemon_id
                tmux_old = existing.tmux_session
                existing.status = "dead"
                kill_old = True
        if kill_old:
            await self._tmux_kill_session(tmux_old)
            async with self._lock:
                self._sessions.pop(daemon_id_old, None)

        daemon_id = uuid.uuid4().hex[:8]
        # Use custom name if provided, otherwise fall back to directory basename
        display_name = session_name or os.path.basename(os.path.abspath(cwd)) or "home"
        # Sanitize for tmux session names (no dots, colons, etc.)
        display_name = "".join(c if c.isalnum() or c in "-_" else "-" for c in display_name)[:20]
        tmux_session = f"vmux-{display_name}-{daemon_id}"

        session = SpawnedSession(
            daemon_id=daemon_id,
            tmux_session=tmux_session,
            cwd=cwd,
            session_name=session_name,
        )

        async with self._lock:
            self._sessions[daemon_id] = session

        try:
            # Create tmux session with a login shell so the user's full profile
            # (.zprofile, .zshrc, etc.) is loaded.  Without this, sessions spawned
            # by the daemon inherit the daemon's stripped-down environment, and
            # Claude Code fails to load user-scoped plugins (the MCP servers
            # registered in ~/.claude/settings.json won't appear).
            user_shell = os.environ.get("SHELL", "/bin/zsh")
            await self._run([
                "tmux", "new-session", "-d", "-s", tmux_session, "-c", cwd,
                user_shell, "-l",  # -l = login shell
            ])
            logger.info(f"[sessions] created tmux session {tmux_session} in {cwd} (login shell: {user_shell})")

            # Launch Claude — try --continue first, fall back to fresh session.
            # Do NOT pass the standby skill as a startup prompt — the MCP plugin
            # needs time to establish the SSE connection first.  Instead, start
            # Claude, wait for it to initialize, reconnect the MCP plugin, then
            # send the standby command as a separate step (same pattern as
            # hard_interrupt and reconnect_session).
            claude_cmd = (
                f"claude --continue --dangerously-skip-permissions || "
                f"claude --dangerously-skip-permissions"
            )
            await self._run(["tmux", "send-keys", "-t", tmux_session, "-l", claude_cmd])
            await asyncio.sleep(0.3)
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])

            # Wait for Claude Code's input UI to be fully ready before sending
            # commands.  A blind sleep is unreliable — Claude may still be
            # loading MCP servers, resuming a session, etc.  We capture the
            # tmux pane and look for the horizontal separator (────) that frames
            # the input field, which is more reliable than ❯ (appears in history).
            if await self._wait_for_claude_prompt(tmux_session, timeout=30.0):
                # Grace period: the prompt character may render before input
                # event handlers are fully attached in Claude's TUI.
                await asyncio.sleep(1.5)
            else:
                logger.warning(f"[sessions] Claude prompt not detected in {tmux_session} after 30s — continuing anyway")

            # Voice registration happens automatically via the SessionStart
            # hook fired by Claude Code itself — no need to inject a slash
            # command here.  Give the hook a moment to POST to /register.
            await asyncio.sleep(2.0)

            # Compute expected relay session ID from CWD (same algorithm as
            # the MCP plugin) and poll for that specific ID to avoid picking up
            # unrelated sessions that happen to register during the spawn window.
            expected_relay_id = _make_session_id(cwd)
            logger.info(f"[sessions] waiting for {tmux_session} to register as {expected_relay_id}...")
            relay_session_id = await self._poll_relay_for_session(
                expected_id=expected_relay_id, timeout=SPAWN_TIMEOUT,
            )

            if relay_session_id:
                async with self._lock:
                    session.relay_session_id = relay_session_id
                    session.status = "standby"
                logger.info(f"[sessions] {tmux_session} registered as {relay_session_id}")

                # Set custom display name on the relay if provided
                if session_name:
                    await self._set_relay_session_name(relay_session_id, session_name)

                return {
                    "ok": True,
                    "daemon_id": daemon_id,
                    "session_id": relay_session_id,
                    "tmux_session": tmux_session,
                }
            else:
                await self._tmux_kill_session(tmux_session)
                async with self._lock:
                    session.status = "spawn_failed"
                    del self._sessions[daemon_id]
                return {"ok": False, "error": "Session did not register within timeout — check Claude logs"}

        except Exception as e:
            logger.error(f"[sessions] spawn failed: {e}")
            await self._tmux_kill_session(tmux_session)
            async with self._lock:
                self._sessions.pop(daemon_id, None)
            return {"ok": False, "error": str(e)}

    async def kill(self, session_id: str) -> bool:
        """Kill a session by relay session ID or daemon ID."""
        async with self._lock:
            session = self._find_session(session_id)
            if not session:
                return False
            daemon_id = session.daemon_id
            tmux_session = session.tmux_session
            session.status = "dead"

        await self._tmux_kill_session(tmux_session)
        async with self._lock:
            self._sessions.pop(daemon_id, None)
        return True

    async def interrupt(self, session_id: str) -> bool:
        """Send Ctrl-C to a session's tmux pane."""
        async with self._lock:
            session = self._find_session(session_id)
            if not session:
                return False
            tmux_session = session.tmux_session
        try:
            # send-keys with C-c
            proc = await asyncio.create_subprocess_exec(
                "tmux", "send-keys", "-t", tmux_session, "C-c", "",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await proc.wait()
            return True
        except Exception as e:
            logger.error(f"[sessions] interrupt failed: {e}")
            return False

    async def hard_interrupt(self, session_id: str) -> bool:
        """Send Ctrl-C + MCP reconnect to the tmux session."""
        async with self._lock:
            session = self._find_session(session_id)
            if not session:
                return False
            tmux_session = session.tmux_session
        try:
            await self.interrupt(session_id)
            await asyncio.sleep(1.0)
            # MCP reconnect — slash command needs two Enters (autocomplete select + submit)
            await self._run(["tmux", "send-keys", "-t", tmux_session,
                             "-l", "/mcp reconnect plugin:voice-multiplexer:voice-multiplexer"])
            await asyncio.sleep(0.3)
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])
            await asyncio.sleep(0.5)
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])
            return True
        except Exception as e:
            logger.error(f"[sessions] hard_interrupt failed: {e}")
            return False

    async def clear_context(self, session_id: str) -> bool:
        """Send /clear to a Claude session to reset its conversation context.

        Performs a hard interrupt first (Ctrl-C + Escape) to break Claude out
        of any current operation, then sends /clear and reconnects the MCP
        plugin.
        """
        async with self._lock:
            session = self._find_session(session_id)
            if not session:
                return False
            tmux_session = session.tmux_session
        try:
            # Step 1: Hard interrupt — Ctrl-C to cancel, then Escape to dismiss
            # any prompts or autocomplete menus that may be open.
            await self.interrupt(session_id)
            await asyncio.sleep(0.5)
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Escape", ""])
            await asyncio.sleep(0.5)
            # Second Ctrl-C in case the first was absorbed by a confirmation prompt
            await self.interrupt(session_id)
            await asyncio.sleep(1.0)

            # Step 2: Send /clear slash command — two Enters (autocomplete select + submit)
            await self._run(["tmux", "send-keys", "-t", tmux_session,
                             "-l", "/clear"])
            await asyncio.sleep(0.3)
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])
            await asyncio.sleep(0.5)
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])
            await asyncio.sleep(2.0)

            # Step 3: Reconnect MCP plugin (clearing stale session state)
            await self._run(["tmux", "send-keys", "-t", tmux_session,
                             "-l", "/mcp reconnect plugin:voice-multiplexer:voice-multiplexer"])
            await asyncio.sleep(0.3)
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])
            await asyncio.sleep(0.5)
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])
            return True
        except Exception as e:
            logger.error(f"[sessions] clear_context failed: {e}")
            return False

    async def compact_context(self, session_id: str) -> bool:
        """Send /compact to a Claude session to compact its conversation context.

        Performs a hard interrupt first (Ctrl-C + Escape) to break Claude out
        of any current operation, then sends /compact and reconnects the MCP
        plugin.
        """
        async with self._lock:
            session = self._find_session(session_id)
            if not session:
                return False
            tmux_session = session.tmux_session
        try:
            # Step 1: Hard interrupt — Ctrl-C to cancel, then Escape to dismiss
            # any prompts or autocomplete menus that may be open.
            await self.interrupt(session_id)
            await asyncio.sleep(0.5)
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Escape", ""])
            await asyncio.sleep(0.5)
            # Second Ctrl-C in case the first was absorbed by a confirmation prompt
            await self.interrupt(session_id)
            await asyncio.sleep(1.0)

            # Step 2: Send /compact slash command — two Enters (autocomplete select + submit)
            await self._run(["tmux", "send-keys", "-t", tmux_session,
                             "-l", "/compact"])
            await asyncio.sleep(0.3)
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])
            await asyncio.sleep(0.5)
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])
            await asyncio.sleep(2.0)

            # Step 3: Reconnect MCP plugin (clearing stale session state)
            await self._run(["tmux", "send-keys", "-t", tmux_session,
                             "-l", "/mcp reconnect plugin:voice-multiplexer:voice-multiplexer"])
            await asyncio.sleep(0.3)
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])
            await asyncio.sleep(0.5)
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])
            return True
        except Exception as e:
            logger.error(f"[sessions] compact_context failed: {e}")
            return False

    async def change_model(self, session_id: str, model: str) -> bool:
        """Switch the Claude model in a session via /model <name>.

        Performs a hard interrupt first (Ctrl-C + Escape) to break Claude out
        of any current operation, then sends `/model <name>` as a single
        command (which switches immediately without an interactive picker)
        and reconnects the MCP plugin.
        """
        # Map full model IDs to short names accepted by /model
        MODEL_NAMES = {
            "claude-opus-4-6": "opus",
            "claude-sonnet-4-6": "sonnet",
            "claude-haiku-4-5": "haiku",
        }
        model_name = MODEL_NAMES.get(model, model)

        async with self._lock:
            session = self._find_session(session_id)
            if not session:
                return False
            tmux_session = session.tmux_session
        try:
            # Step 1: Hard interrupt
            await self.interrupt(session_id)
            await asyncio.sleep(0.5)
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Escape", ""])
            await asyncio.sleep(0.5)
            await self.interrupt(session_id)
            await asyncio.sleep(1.0)

            # Step 2: Send /model <name> as a single command (no interactive picker)
            await self._run(["tmux", "send-keys", "-t", tmux_session,
                             "-l", f"/model {model_name}"])
            await asyncio.sleep(0.3)
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])
            await asyncio.sleep(2.0)

            # Step 3: Reconnect MCP plugin
            await self._run(["tmux", "send-keys", "-t", tmux_session,
                             "-l", "/mcp reconnect plugin:voice-multiplexer:voice-multiplexer"])
            await asyncio.sleep(0.3)
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])
            await asyncio.sleep(0.5)
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])
            return True
        except Exception as e:
            logger.error(f"[sessions] change_model failed: {e}")
            return False

    async def restart_session(self, session_id: str) -> dict:
        """Kill and respawn a session in the same directory."""
        async with self._lock:
            session = self._find_session(session_id)
            if not session:
                return {"ok": False, "error": "Session not found"}
            cwd = session.cwd
            daemon_id = session.daemon_id
            tmux_session = session.tmux_session

        await self._tmux_kill_session(tmux_session)
        async with self._lock:
            self._sessions.pop(daemon_id, None)
        return await self.spawn(cwd)

    async def reconnect_session(self, session_id: str = "", cwd: str = "") -> dict:
        """Clear stale MCP state by reconnecting the plugin in the tmux pane.

        Accepts session_id (preferred) or cwd (fallback) to locate the session.
        """
        async with self._lock:
            session = None
            if session_id:
                session = self._find_session(session_id)
            if not session and cwd:
                session = self._find_session_by_cwd(cwd)
            if not session:
                return {"ok": False, "error": "Session not found"}
            tmux_session = session.tmux_session
        try:
            # Reconnect MCP plugin to clear stale session state.
            # Slash commands need two Enters (autocomplete select + submit).
            await self._run(["tmux", "send-keys", "-t", tmux_session,
                             "-l", "/mcp reconnect plugin:voice-multiplexer:voice-multiplexer"])
            await asyncio.sleep(0.3)
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])
            await asyncio.sleep(0.5)
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])
            return {"ok": True}
        except Exception as e:
            logger.error(f"[sessions] reconnect failed: {e}")
            return {"ok": False, "error": str(e)}

    async def send_keys(self, session_id: str, keys: str) -> bool:
        """Send literal keystrokes to a session's tmux pane.

        The text is sent with -l (literal) so tmux doesn't interpret
        any special key sequences.
        """
        async with self._lock:
            session = self._find_session(session_id)
            if not session:
                return False
            tmux_session = session.tmux_session
        try:
            proc = await asyncio.create_subprocess_exec(
                "tmux", "send-keys", "-t", tmux_session, "-l", keys,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await proc.wait()
            return proc.returncode == 0
        except Exception as e:
            logger.error(f"[sessions] send_keys failed: {e}")
            return False

    async def send_special_key(self, session_id: str, key: str) -> bool:
        """Send a special key (Enter, C-c, Escape, Tab, etc) to a session."""
        ALLOWED_SPECIAL = {
            "Enter", "C-c", "Escape", "Tab", "BSpace",
            "Up", "Down", "Left", "Right",
            "C-l", "C-d", "C-z", "C-a", "C-e",
        }
        if key not in ALLOWED_SPECIAL:
            return False
        async with self._lock:
            session = self._find_session(session_id)
            if not session:
                return False
            tmux_session = session.tmux_session
        try:
            # Empty string after key name is required for tmux send-keys
            # with special keys to terminate the key name sequence.
            proc = await asyncio.create_subprocess_exec(
                "tmux", "send-keys", "-t", tmux_session, key, "",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await proc.wait()
            return proc.returncode == 0
        except Exception as e:
            logger.error(f"[sessions] send_special_key failed: {e}")
            return False

    async def inject_text(self, session_id: str, text: str) -> bool:
        """Inject text as typed input into a session's tmux pane and submit.

        This is the primary voice-in mechanism in the post-standby world.
        Transcribed speech arrives here, gets sent as literal keystrokes
        (just like a human typing), and is submitted with Enter.

        Newlines in the input are flattened to spaces so multi-line
        transcriptions do not prematurely submit the turn.  The trailing
        Enter is sent separately to submit the whole turn atomically.
        Spaces (rather than semicolons) avoid corrupting dictated code.
        """
        async with self._lock:
            session = self._find_session(session_id)
            if not session:
                return False
            tmux_session = session.tmux_session
        try:
            safe_text = text.replace("\r\n", " ").replace("\n", " ").replace("\r", " ")
            # Stage 1: send literal text
            p1 = await asyncio.create_subprocess_exec(
                "tmux", "send-keys", "-t", tmux_session, "-l", safe_text,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await p1.wait()
            if p1.returncode != 0:
                return False
            # Stage 2: press Enter to submit
            p2 = await asyncio.create_subprocess_exec(
                "tmux", "send-keys", "-t", tmux_session, "Enter", "",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await p2.wait()
            return p2.returncode == 0
        except Exception as e:
            logger.error(f"[sessions] inject_text failed: {e}")
            return False

    async def get_attach_info(self, session_id: str) -> Optional[dict]:
        async with self._lock:
            session = self._find_session(session_id)
            if not session:
                return None
            return {"tmux_session": session.tmux_session, "cwd": session.cwd}

    async def capture_terminal(self, session_id: str, lines: int = 50) -> Optional[str]:
        """Capture recent terminal output from a session's tmux pane."""
        async with self._lock:
            session = self._find_session(session_id)
            if not session:
                return None
            tmux_session = session.tmux_session
        try:
            output = await self._run_output([
                "tmux", "capture-pane", "-t", tmux_session, "-p", "-S", f"-{lines}"
            ])
            return output
        except Exception as e:
            logger.error(f"[sessions] capture_terminal failed: {e}")
            return None

    async def capture_terminal_ansi(self, session_id: str, lines: int = 50) -> str:
        """Capture terminal with ANSI escape sequences preserved."""
        async with self._lock:
            session = self._find_session(session_id)
            if not session:
                return ""
            tmux_session = session.tmux_session
        try:
            output = await self._run_output([
                "tmux", "capture-pane", "-t", tmux_session, "-p", "-e", "-S", f"-{lines}"
            ])
            return output
        except Exception as e:
            logger.error(f"[sessions] capture_terminal_ansi failed: {e}")
            return ""

    async def list_sessions(self) -> list[dict]:
        async with self._lock:
            return [s.to_dict() for s in self._sessions.values()]

    # --- Statusline data directory ---
    _STATUSLINE_DIR = Path.home() / ".claude" / "voice-multiplexer" / "sessions"

    async def get_context_usage(self, session_id: str) -> Optional[dict]:
        """Read usage data from the statusline-written per-session JSON file."""
        async with self._lock:
            session = self._find_session(session_id)
            if not session:
                return None
            tmux_session = session.tmux_session

        try:
            # Find the Claude PID to get its session_id (which is the filename)
            pane_pid_str = await self._run_output([
                "tmux", "list-panes", "-t", tmux_session, "-F", "#{pane_pid}"
            ])
            pane_pid = pane_pid_str.strip().splitlines()[0].strip()
            if not pane_pid.isdigit():
                return None

            claude_pid = await self._find_claude_pid(int(pane_pid))
            if not claude_pid:
                return None

            # Read Claude's own session file to get its session ID
            session_file = Path.home() / ".claude" / "sessions" / f"{claude_pid}.json"
            if not session_file.exists():
                return None

            session_data = json.loads(session_file.read_text())
            claude_session_id = session_data.get("sessionId")
            if not claude_session_id:
                return None

            # Now look for our statusline-written file
            statusline_file = self._STATUSLINE_DIR / f"{claude_session_id}.json"
            if not statusline_file.exists():
                return None

            data = json.loads(statusline_file.read_text())

            # Extract from the full Claude JSON payload
            model_info = data.get("model") or {}
            ctx = data.get("context_window") or {}
            cost = data.get("cost") or {}
            current = ctx.get("current_usage") or {}

            model = model_info.get("id", "")
            context_window = ctx.get("context_window_size", 200_000) or 200_000

            # Claude always reports 200k as the base window size.
            # When exceeds_200k_tokens is True the session has been extended
            # to the full 1M context window.
            exceeds_200k = data.get("exceeds_200k_tokens", False)
            if exceeds_200k:
                context_window = 1_000_000

            # Current context usage — sum all token types in current_usage
            # (NOT total_input/output which are cumulative session totals)
            used_tokens = (
                (current.get("input_tokens", 0) or 0)
                + (current.get("output_tokens", 0) or 0)
                + (current.get("cache_creation_input_tokens", 0) or 0)
                + (current.get("cache_read_input_tokens", 0) or 0)
            )

            # Recalculate percentage with corrected context window
            percentage = round((used_tokens / context_window) * 100, 1) if context_window > 0 else 0

            # Rate limit info — not yet in statusline JSON but expected
            # format is {five_hour: {utilization: 0-100}, seven_day: {...}}
            # Also handle alternate key names defensively.
            rate_limits = data.get("rate_limits") or {}
            five_hour = rate_limits.get("five_hour") or {}
            seven_day = rate_limits.get("seven_day") or {}

            def _pct(obj: dict) -> float | None:
                """Extract percentage from a rate limit object, handling key variants."""
                for key in ("utilization", "used_percentage"):
                    val = obj.get(key)
                    if val is not None:
                        try:
                            return float(val)
                        except (TypeError, ValueError):
                            pass
                return None

            return {
                "model": model,
                "model_name": model_info.get("display_name", ""),
                "input_tokens": current.get("input_tokens", 0) or 0,
                "output_tokens": current.get("output_tokens", 0) or 0,
                "cache_creation_input_tokens": current.get("cache_creation_input_tokens", 0) or 0,
                "cache_read_input_tokens": current.get("cache_read_input_tokens", 0) or 0,
                "context_window": context_window,
                "used_tokens": used_tokens,
                "percentage": percentage,
                "cost_usd": cost.get("total_cost_usd"),
                "cost_duration_ms": cost.get("total_duration_ms"),
                "cwd": data.get("cwd", ""),
                "rate_limit_5h": _pct(five_hour),
                "rate_limit_7d": _pct(seven_day),
                "source": "statusline",
            }

        except Exception as e:
            logger.debug(f"[sessions] statusline read failed: {e}")
            return None

    async def _find_claude_pid(self, pane_pid: int) -> Optional[int]:
        """Walk the process tree from pane_pid to find a 'claude' process."""
        try:
            output = await self._run_output(["ps", "-eo", "pid,ppid,comm"])
            children: dict[int, list[tuple[int, str]]] = {}
            for line in output.strip().splitlines()[1:]:
                parts = line.split()
                if len(parts) < 3:
                    continue
                try:
                    pid = int(parts[0])
                    ppid = int(parts[1])
                    comm = parts[2]
                    children.setdefault(ppid, []).append((pid, comm))
                except ValueError:
                    continue

            # BFS from pane_pid looking for a process named 'claude'
            queue = [pane_pid]
            visited = set()
            while queue:
                current = queue.pop(0)
                if current in visited:
                    continue
                visited.add(current)
                for child_pid, comm in children.get(current, []):
                    if "claude" in comm.lower():
                        return child_pid
                    queue.append(child_pid)

            return None
        except Exception:
            return None

    async def reconcile_orphans(self):
        """On daemon startup: re-register tmux sessions from a previous daemon instance."""
        try:
            result = await self._run_output(["tmux", "list-sessions", "-F", "#{session_name}"])
        except Exception:
            return

        vmux_sessions = [s.strip() for s in result.splitlines() if s.strip().startswith("vmux-")]
        if not vmux_sessions:
            return

        logger.info(f"[sessions] found {len(vmux_sessions)} orphaned vmux tmux session(s): {vmux_sessions}")

        for tmux_session in vmux_sessions:
            parts = tmux_session.split("-")
            if len(parts) < 3:
                continue
            daemon_id = parts[-1]
            try:
                cwd = await self._run_output(
                    ["tmux", "display-message", "-t", tmux_session, "-p", "#{pane_current_path}"]
                )
                cwd = cwd.strip()
            except Exception:
                cwd = ""

            # Compute relay_session_id deterministically from cwd using the same
            # algorithm as the MCP plugin (SHA256 hash). This replaces the fragile
            # dir_name matching that could collide when multiple projects share the
            # same directory basename.
            relay_session_id = _make_session_id(cwd) if cwd else None

            session = SpawnedSession(
                daemon_id=daemon_id,
                tmux_session=tmux_session,
                cwd=cwd,
                relay_session_id=relay_session_id,
                status="standby",
            )
            async with self._lock:
                self._sessions[daemon_id] = session
            logger.info(f"[sessions] re-registered orphan: {tmux_session} (relay_session_id={relay_session_id})")

    async def _health_monitor(self):
        while True:
            try:
                await asyncio.sleep(HEALTH_CHECK_INTERVAL)
                await self._check_health()
                # Run caffeinate reaper less frequently than health checks
                if time.time() - self._last_reap >= CAFFEINATE_REAP_INTERVAL:
                    await self._reap_caffeinate()
                    self._last_reap = time.time()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"[sessions] health monitor error: {e}")

    async def _check_health(self):
        async with self._lock:
            sessions = list(self._sessions.values())

        try:
            client = await _get_session_client()
            resp = await client.get(
                f"{self._relay_url}/api/sessions",
                headers={"X-Daemon-Secret": self._daemon_secret},
            )
            relay_sessions = {}
            if resp.status_code == 200:
                for s in resp.json().get("sessions", []):
                    relay_sessions[s["session_id"]] = s
        except Exception:
            return

        for session in sessions:
            if session.status in ("spawn_failed", "dead"):
                continue

            # Check if tmux session still exists
            if not await self._tmux_has_session(session.tmux_session):
                logger.warning(f"[sessions] tmux session gone: {session.tmux_session}")
                async with self._lock:
                    session.status = "dead"
                continue

            # Resolve a pending relay_session_id deterministically from cwd
            if session.relay_session_id is None and session.cwd:
                computed_id = _make_session_id(session.cwd)
                async with self._lock:
                    session.relay_session_id = computed_id
                logger.info(f"[sessions] resolved pending relay_session_id: {session.tmux_session} -> {computed_id}")

            # Track relay heartbeat for status display only.  We no longer
            # take disruptive action on "zombie" sessions — the old hard_interrupt
            # recovery was a workaround for MCP-standby SSE drops that don't
            # apply now that voice routes through send-keys + hooks.
            if session.relay_session_id and session.relay_session_id in relay_sessions:
                session.last_relay_heartbeat = time.time()
                if session.status not in ("active",):
                    session.status = "standby"

    async def _reap_caffeinate(self):
        """Kill excess caffeinate processes spawned by managed Claude sessions.

        Claude Code automatically spawns `caffeinate -i -t 300` to prevent
        macOS sleep.  It respawns a new one before the previous expires, so
        multiple caffeinate processes accumulate per session.  During crash /
        reconnect cycles the overlap can grow unbounded and eventually hit the
        system process limit.

        This reaper identifies caffeinate processes that are direct children of
        Claude processes running inside our managed tmux sessions and kills all
        but the newest one per Claude parent.  Caffeinate processes belonging to
        other applications are never touched.
        """
        async with self._lock:
            sessions = list(self._sessions.values())

        if not sessions:
            return

        # Step 1: Collect PIDs of Claude processes in our managed tmux panes
        managed_pane_pids: set[int] = set()
        for session in sessions:
            if session.status in ("spawn_failed", "dead"):
                continue
            try:
                output = await self._run_output([
                    "tmux", "list-panes", "-t", session.tmux_session,
                    "-F", "#{pane_pid}",
                ])
                for line in output.strip().splitlines():
                    line = line.strip()
                    if line.isdigit():
                        managed_pane_pids.add(int(line))
            except Exception:
                continue

        if not managed_pane_pids:
            return

        # Step 2: Find all caffeinate processes and group by parent PID
        # Only consider caffeinate processes whose parent is a managed pane PID
        # or whose grandparent is (Claude spawns caffeinate as a child of its
        # Node.js process which is a child of the tmux pane shell).
        try:
            output = await self._run_output([
                "ps", "-eo", "pid,ppid,lstart,args",
            ])
        except Exception:
            return

        # Build a ppid lookup for all processes (to resolve grandparents)
        pid_to_ppid: dict[int, int] = {}
        caffeinate_entries: list[tuple[int, int, str]] = []  # (pid, ppid, lstart)

        for line in output.strip().splitlines()[1:]:  # skip header
            parts = line.split()
            if len(parts) < 4:
                continue
            try:
                pid = int(parts[0])
                ppid = int(parts[1])
            except ValueError:
                continue
            pid_to_ppid[pid] = ppid

            # Check if this is a caffeinate process
            args = " ".join(parts[6:])  # lstart takes 5 fields (Day Mon DD HH:MM:SS YYYY)
            if "caffeinate" in args and "-i" in args:
                lstart = " ".join(parts[2:7])
                caffeinate_entries.append((pid, ppid, lstart))

        # Step 3: Filter to only caffeinate processes belonging to our sessions.
        # A caffeinate belongs to us if its parent OR grandparent is a managed
        # pane PID (covers both direct child and child-of-claude-child cases).
        managed_caffeinate: dict[int, list[tuple[int, str]]] = {}  # parent → [(pid, lstart)]

        for caff_pid, caff_ppid, lstart in caffeinate_entries:
            grandparent = pid_to_ppid.get(caff_ppid, -1)
            if caff_ppid in managed_pane_pids or grandparent in managed_pane_pids:
                parent_key = caff_ppid
                managed_caffeinate.setdefault(parent_key, []).append((caff_pid, lstart))

        # Step 4: For each parent, keep the newest caffeinate and kill the rest
        reaped = 0
        for parent_pid, entries in managed_caffeinate.items():
            if len(entries) <= 1:
                continue
            # Sort by PID descending — higher PID = newer process
            entries.sort(key=lambda e: e[0], reverse=True)
            # Keep the first (newest), kill the rest
            for caff_pid, lstart in entries[1:]:
                try:
                    os.kill(caff_pid, signal.SIGTERM)
                    reaped += 1
                except ProcessLookupError:
                    pass  # already exited
                except PermissionError:
                    logger.warning(f"[reaper] no permission to kill caffeinate PID {caff_pid}")

        if reaped > 0:
            logger.info(f"[reaper] killed {reaped} excess caffeinate process(es)")

    async def _poll_relay_for_session(
        self, timeout: float, expected_id: Optional[str] = None,
    ) -> Optional[str]:
        """Poll relay until the spawned session registers.

        If *expected_id* is provided (preferred), polls until that specific
        session ID appears.  This avoids mis-identifying an unrelated session
        that happens to register during the same window.

        Falls back to the legacy "any new session" heuristic when
        *expected_id* is None (shouldn't happen in normal operation).
        """
        initial_ids: set[str] = set()
        client = await _get_session_client()
        if not expected_id:
            # Legacy fallback: snapshot current sessions so we can detect new ones
            try:
                resp = await client.get(
                    f"{self._relay_url}/api/sessions",
                    headers={"X-Daemon-Secret": self._daemon_secret},
                )
                if resp.status_code == 200:
                    initial_ids = {s["session_id"] for s in resp.json().get("sessions", [])}
            except Exception:
                pass

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            await asyncio.sleep(SPAWN_POLL_INTERVAL)
            try:
                resp = await client.get(
                    f"{self._relay_url}/api/sessions",
                    headers={"X-Daemon-Secret": self._daemon_secret},
                )
                if resp.status_code == 200:
                    session_ids = {s["session_id"] for s in resp.json().get("sessions", [])}
                    if expected_id:
                        if expected_id in session_ids:
                            return expected_id
                    else:
                        for sid in session_ids:
                            if sid not in initial_ids:
                                return sid
            except Exception:
                pass
        return None

    async def _set_relay_session_name(self, session_id: str, name: str):
        """Update a session's display name on the relay server."""
        try:
            client = await _get_session_client()
            resp = await client.patch(
                f"{self._relay_url}/api/sessions/{session_id}/name",
                json={"name": name},
                headers={"X-Daemon-Secret": self._daemon_secret},
            )
            if resp.status_code == 200:
                logger.info(f"[sessions] set relay display name: {session_id} → {name}")
            else:
                logger.warning(f"[sessions] failed to set relay name: {resp.status_code}")
        except Exception as e:
            logger.warning(f"[sessions] failed to set relay name: {e}")

    def _find_session(self, session_id: str) -> Optional[SpawnedSession]:
        """Find by relay_session_id or daemon_id. Must be called with lock held."""
        for s in self._sessions.values():
            if s.relay_session_id == session_id:
                return s
        return self._sessions.get(session_id)

    def _find_session_by_cwd(self, cwd: str) -> Optional[SpawnedSession]:
        """Find a session by its working directory. Must be called with lock held."""
        for s in self._sessions.values():
            if s.cwd == cwd:
                return s
        return None

    async def _wait_for_claude_prompt(self, tmux_session: str, timeout: float = 30.0) -> bool:
        """Wait for Claude Code's input UI to be fully ready.

        Looks for the horizontal separator line (────) that frames the input
        field in Claude Code's TUI.  This is more reliable than looking for ❯
        because ❯ also appears in conversation history when using --continue,
        which would cause premature detection while the TUI is still loading.

        Returns True if the prompt was detected within the timeout, False otherwise.
        Polls every 2 seconds by capturing the tmux pane content.
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            await asyncio.sleep(2.0)
            try:
                output = await self._run_output([
                    "tmux", "capture-pane", "-t", tmux_session, "-p", "-S", "-10"
                ])
                # The ──── separator only appears in Claude Code's input frame,
                # never in conversation history.  Four chars is enough to match.
                if "────" in output:
                    logger.info(f"[sessions] Claude prompt detected in {tmux_session}")
                    return True
            except Exception:
                pass
        return False

    async def _tmux_has_session(self, name: str) -> bool:
        try:
            proc = await asyncio.create_subprocess_exec(
                "tmux", "has-session", "-t", name,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await proc.wait()
            return proc.returncode == 0
        except Exception:
            return False

    async def _tmux_kill_session(self, name: str):
        try:
            proc = await asyncio.create_subprocess_exec(
                "tmux", "kill-session", "-t", name,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await proc.wait()
        except Exception:
            pass

    async def _run(self, cmd: list[str]):
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()
        if proc.returncode != 0:
            raise RuntimeError(f"Command failed (exit {proc.returncode}): {' '.join(cmd)}")

    async def _run_output(self, cmd: list[str]) -> str:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(f"Command failed (exit {proc.returncode}): {' '.join(cmd)}")
        return stdout.decode()
