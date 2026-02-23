"""Session manager — spawns and tracks Claude sessions via tmux."""

import asyncio
import hashlib
import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

import httpx

logger = logging.getLogger("vmuxd.sessions")

SPAWN_POLL_INTERVAL = 2.0   # seconds between relay polling attempts
SPAWN_TIMEOUT = 120.0        # max seconds to wait for session to register
HEALTH_CHECK_INTERVAL = 30  # seconds between health checks
ZOMBIE_THRESHOLD = 90.0     # seconds without heartbeat = zombie


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

    async def spawn(self, cwd: str) -> dict:
        """Spawn a new Claude session in the given directory."""
        cwd = os.path.expanduser(cwd)
        if not os.path.isdir(cwd):
            return {"ok": False, "error": f"Directory not found: {cwd}"}

        daemon_id = uuid.uuid4().hex[:8]
        basename = os.path.basename(os.path.abspath(cwd)) or "home"
        # Sanitize basename for tmux session names (no dots, colons, etc.)
        basename = "".join(c if c.isalnum() or c in "-_" else "-" for c in basename)[:20]
        tmux_session = f"vmux-{basename}-{daemon_id}"

        session = SpawnedSession(
            daemon_id=daemon_id,
            tmux_session=tmux_session,
            cwd=cwd,
        )

        async with self._lock:
            self._sessions[daemon_id] = session

        try:
            # Create tmux session
            await self._run(["tmux", "new-session", "-d", "-s", tmux_session, "-c", cwd])
            logger.info(f"[sessions] created tmux session {tmux_session} in {cwd}")

            # Launch Claude — try --continue first, fall back to fresh session
            claude_cmd = (
                f"claude --continue --dangerously-skip-permissions '/voice-multiplexer:standby' || "
                f"claude --dangerously-skip-permissions '/voice-multiplexer:standby'"
            )
            await self._run(["tmux", "send-keys", "-t", tmux_session, claude_cmd, "Enter"])

            logger.info(f"[sessions] waiting for {tmux_session} to register with relay...")
            relay_session_id = await self._poll_relay_for_session(timeout=SPAWN_TIMEOUT)

            if relay_session_id:
                async with self._lock:
                    session.relay_session_id = relay_session_id
                    session.status = "standby"
                logger.info(f"[sessions] {tmux_session} registered as {relay_session_id}")
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
        """Send Ctrl-C + MCP reconnect + re-enter standby in the tmux session."""
        async with self._lock:
            session = self._find_session(session_id)
            if not session:
                return False
            tmux_session = session.tmux_session
        try:
            await self.interrupt(session_id)
            await asyncio.sleep(1.0)
            await self._run(["tmux", "send-keys", "-t", tmux_session,
                             "/mcp reconnect plugin:voice-multiplexer:voice-multiplexer"])
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])
            await asyncio.sleep(2.0)
            await self._run(["tmux", "send-keys", "-t", tmux_session,
                             "/voice-multiplexer:standby"])
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])
            return True
        except Exception as e:
            logger.error(f"[sessions] hard_interrupt failed: {e}")
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
        """Attempt to reconnect to a session's tmux pane by re-entering standby.

        First reconnects the MCP plugin to get a fresh connection to the relay
        server (clears stale session state from previous relay instance), then
        re-enters voice standby.

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
            # Reconnect MCP plugin first to clear stale session state
            await self._run(["tmux", "send-keys", "-t", tmux_session,
                             "/mcp reconnect plugin:voice-multiplexer:voice-multiplexer"])
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])
            await asyncio.sleep(2.0)
            # Then re-enter voice standby
            await self._run(["tmux", "send-keys", "-t", tmux_session,
                             "/voice-multiplexer:standby"])
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])
            return {"ok": True}
        except Exception as e:
            logger.error(f"[sessions] reconnect failed: {e}")
            return {"ok": False, "error": str(e)}

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

    async def list_sessions(self) -> list[dict]:
        async with self._lock:
            return [s.to_dict() for s in self._sessions.values()]

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
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"[sessions] health monitor error: {e}")

    async def _check_health(self):
        async with self._lock:
            sessions = list(self._sessions.values())

        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
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

            # Check relay heartbeat for zombie detection
            if session.relay_session_id:
                if session.relay_session_id in relay_sessions:
                    session.last_relay_heartbeat = time.time()
                    if session.status not in ("active",):
                        session.status = "standby"
                else:
                    age = time.time() - session.last_relay_heartbeat
                    if age > ZOMBIE_THRESHOLD:
                        if session.status != "zombie":
                            logger.warning(f"[sessions] zombie detected: {session.tmux_session}")
                            async with self._lock:
                                session.status = "zombie"
                            await self.interrupt(session.relay_session_id)

    async def _poll_relay_for_session(self, timeout: float) -> Optional[str]:
        """Poll relay until a new session appears that wasn't there before spawning."""
        initial_ids: set[str] = set()
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
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
                async with httpx.AsyncClient(timeout=5.0) as client:
                    resp = await client.get(
                        f"{self._relay_url}/api/sessions",
                        headers={"X-Daemon-Secret": self._daemon_secret},
                    )
                    if resp.status_code == 200:
                        for s in resp.json().get("sessions", []):
                            if s["session_id"] not in initial_ids:
                                return s["session_id"]
            except Exception:
                pass
        return None

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
