"""Session manager — spawns and tracks Claude sessions via tmux."""

import asyncio
import hashlib
import logging
import os
import signal
import time
import uuid
from dataclasses import dataclass, field
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

    async def spawn(self, cwd: str) -> dict:
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
            await self._run(["tmux", "send-keys", "-t", tmux_session, claude_cmd, "Enter"])
            logger.info(f"[sessions] waiting for Claude to initialize in {tmux_session}...")
            await asyncio.sleep(5.0)

            # Reconnect MCP plugin to ensure SSE connection is established
            await self._run(["tmux", "send-keys", "-t", tmux_session,
                             "/mcp reconnect plugin:voice-multiplexer:voice-multiplexer"])
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])
            await asyncio.sleep(3.0)

            # Now enter voice standby
            await self._run(["tmux", "send-keys", "-t", tmux_session,
                             "/voice-multiplexer:standby"])
            await self._run(["tmux", "send-keys", "-t", tmux_session, "Enter"])

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
