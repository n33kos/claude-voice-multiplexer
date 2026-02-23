#!/usr/bin/env python3
"""vmuxd — Claude Voice Multiplexer daemon.

Manages infrastructure services (Whisper, Kokoro, LiveKit, relay server)
and Claude session spawning. Exposes a Unix socket IPC interface at /tmp/vmuxd.sock.

Install location: ~/.claude/voice-multiplexer/daemon/vmuxd.py
launchd plist:    ~/Library/LaunchAgents/com.vmux.daemon.plist
"""

import asyncio
import json
import logging
import os
import secrets
import signal
import sys
import time
from pathlib import Path
from typing import Optional

# Try to set process title for Activity Monitor visibility
try:
    import setproctitle
    setproctitle.setproctitle("vmuxd")
except ImportError:
    pass

DATA_DIR = Path.home() / ".claude" / "voice-multiplexer"
LOG_DIR = DATA_DIR / "logs"
DAEMON_DIR = DATA_DIR / "daemon"
DAEMON_SECRET_FILE = DATA_DIR / "daemon.secret"
DAEMON_STATE_FILE = DATA_DIR / "daemon.state"
VERSION_FILE = DAEMON_DIR / "VERSION"

# Plugin cache path (n33kos marketplace)
PLUGIN_CACHE_DIR = Path.home() / ".claude" / "plugins" / "cache" / "n33kos" / "voice-multiplexer"

RELAY_URL = "http://127.0.0.1:3100"
AUTO_UPDATE_INTERVAL = 60  # seconds between version checks

# Configure logging before imports
LOG_DIR.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / "daemon.log"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("vmuxd")


def _load_env():
    """Load voice-multiplexer.env into environment."""
    env_path = DATA_DIR / "voice-multiplexer.env"
    if not env_path.exists():
        return
    try:
        from dotenv import load_dotenv
        load_dotenv(env_path)
    except ImportError:
        # Manual parsing fallback
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, val = line.partition("=")
                os.environ.setdefault(key.strip(), val.strip())


def _load_or_create_daemon_secret() -> str:
    """Load daemon secret from file, creating it if absent."""
    DAEMON_SECRET_FILE.parent.mkdir(parents=True, exist_ok=True)
    if DAEMON_SECRET_FILE.exists():
        secret = DAEMON_SECRET_FILE.read_text().strip()
        if secret:
            return secret
    secret = secrets.token_hex(32)
    DAEMON_SECRET_FILE.write_text(secret)
    DAEMON_SECRET_FILE.chmod(0o600)
    return secret


def _write_state(service_pids: dict, session_data: list):
    """Write daemon.state — lets external tools find and kill all managed processes."""
    state = {
        "daemon_pid": os.getpid(),
        "updated_at": time.time(),
        "service_pids": service_pids,
        "sessions": session_data,
    }
    DAEMON_STATE_FILE.write_text(json.dumps(state, indent=2))


def _cleanup_stale_processes():
    """Kill orphaned service processes left behind by a previous daemon crash.

    Reads daemon.state written by the previous run.  For each recorded service
    PID it attempts to kill the entire process group (covers `start_new_session`
    children) and then the individual PID as a fallback.  This runs *before*
    any new services are started so ports are freed.
    """
    if not DAEMON_STATE_FILE.exists():
        return

    try:
        state = json.loads(DAEMON_STATE_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return

    old_daemon_pid = state.get("daemon_pid")
    if old_daemon_pid == os.getpid():
        return  # same daemon — nothing to clean up

    # Check if the old daemon is truly gone
    if old_daemon_pid:
        try:
            os.kill(old_daemon_pid, 0)  # probe, don't actually signal
            # Old daemon still alive — don't interfere
            return
        except (ProcessLookupError, OSError):
            pass

    service_pids = state.get("service_pids", {})
    if not service_pids:
        return

    killed = []
    for name, pid in service_pids.items():
        if pid is None:
            continue
        # Try process group kill first (handles start_new_session children)
        try:
            pgid = os.getpgid(pid)
            os.killpg(pgid, signal.SIGTERM)
            killed.append(f"{name}(pgid={pgid})")
        except (ProcessLookupError, OSError):
            pass
        # Fallback: kill the individual PID
        try:
            os.kill(pid, signal.SIGTERM)
            if f"{name}(pgid=" not in str(killed):
                killed.append(f"{name}(pid={pid})")
        except (ProcessLookupError, OSError):
            pass

    if killed:
        logger.info(f"[startup] cleaned up stale processes: {', '.join(killed)}")
        # Give processes a moment to exit, then SIGKILL stragglers
        import time as _time
        _time.sleep(1)
        for name, pid in service_pids.items():
            if pid is None:
                continue
            try:
                pgid = os.getpgid(pid)
                os.killpg(pgid, signal.SIGKILL)
            except (ProcessLookupError, OSError):
                pass
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, OSError):
                pass


def _build_service_configs():
    """Build ServiceConfig objects from environment variables."""
    from service_manager import ServiceConfig

    whisper_port = int(os.environ.get("VMUX_WHISPER_PORT", "8100"))
    whisper_model = os.environ.get("VMUX_WHISPER_MODEL", "base")
    whisper_threads = os.environ.get("VMUX_WHISPER_THREADS", "auto")
    kokoro_port = int(os.environ.get("VMUX_KOKORO_PORT", "8101"))
    kokoro_device = os.environ.get("VMUX_KOKORO_DEVICE", "mps" if sys.platform == "darwin" else "cpu")
    livekit_port = int(os.environ.get("LIVEKIT_PORT", "7880"))
    relay_port = int(os.environ.get("RELAY_PORT", "3100"))
    livekit_api_key = os.environ.get("LIVEKIT_API_KEY", "devkey")
    livekit_api_secret = os.environ.get("LIVEKIT_API_SECRET", "secret")

    whisper_binary = DATA_DIR / "whisper" / "whisper.cpp" / "build" / "bin" / "whisper-server"
    whisper_model_path = DATA_DIR / "whisper" / "models" / f"ggml-{whisper_model}.bin"
    kokoro_repo = DATA_DIR / "kokoro" / "kokoro-fastapi"

    # Resolve thread count
    if whisper_threads == "auto":
        import os as _os
        try:
            whisper_threads = str(_os.cpu_count() or 4)
        except Exception:
            whisper_threads = "4"

    # Resolve relay-server path. Priority order:
    # 1. DATA_DIR/relay-server — managed copy updated by auto-updates
    # 2. VMUX_PLUGIN_DIR/relay-server — initial install / plugin cache
    # 3. __file__-relative — dev / running from source tree
    relay_server_managed = DATA_DIR / "relay-server"
    plugin_dir = os.environ.get("VMUX_PLUGIN_DIR", "")
    if relay_server_managed.exists():
        relay_server_dir = relay_server_managed
    elif plugin_dir:
        relay_server_dir = Path(plugin_dir) / "relay-server"
    else:
        relay_server_dir = Path(__file__).parent.parent / "relay-server"

    if not relay_server_dir.exists():
        logger.error("relay-server not found at %s", relay_server_dir)

    configs = [
        ServiceConfig(
            name="whisper",
            cmd=[
                str(whisper_binary),
                "--host", "127.0.0.1",
                "--port", str(whisper_port),
                "--model", str(whisper_model_path),
                "--inference-path", "/v1/audio/transcriptions",
                "--threads", whisper_threads,
            ],
            health_url=f"http://127.0.0.1:{whisper_port}/",
            startup_grace_s=20.0,
        ),
        ServiceConfig(
            name="kokoro",
            cmd=[
                "uv", "run",
                "--no-sync",  # use the existing venv created by install.sh
                "uvicorn", "api.src.main:app",
                "--host", "127.0.0.1",
                "--port", str(kokoro_port),
            ],
            env={
                "USE_GPU": "true",
                "USE_ONNX": "false",
                "PYTHONPATH": f"{kokoro_repo}:{kokoro_repo}/api",
                "MODEL_DIR": "src/models",
                "VOICES_DIR": "src/voices/v1_0",
                "DEVICE_TYPE": kokoro_device,
                "PYTORCH_ENABLE_MPS_FALLBACK": "1",
            },
            cwd=str(kokoro_repo),
            health_url=f"http://127.0.0.1:{kokoro_port}/health",
            startup_grace_s=90.0,
        ),
        ServiceConfig(
            name="livekit",
            cmd=[
                "livekit-server",
                "--bind", "0.0.0.0",
                "--keys", f"{livekit_api_key}: {livekit_api_secret}",
            ],
            startup_grace_s=10.0,
        ),
        ServiceConfig(
            name="relay",
            cmd=[
                "uv", "run",
                "--python", "3.12",
                "--with", "fastapi>=0.110",
                "--with", "uvicorn>=0.27",
                "--with", "websockets>=12.0",
                "--with", "httpx>=0.27",
                "--with", "python-dotenv>=1.0",
                "--with", "livekit-api>=0.7",
                "--with", "livekit>=1.0",
                "--with", "numpy>=1.24",
                "--with", "scipy>=1.10",
                "--with", "webrtcvad>=2.0.10",
                "--with", "setuptools",
                "--with", "fastmcp>=2.0",
                "--with", "PyJWT>=2.8",
                "--with", "setproctitle>=1.3",
                "server.py",
            ],
            env={
                "WHISPER_URL": f"http://127.0.0.1:{whisper_port}/v1",
                "KOKORO_URL": f"http://127.0.0.1:{kokoro_port}/v1",
                "VMUX_DAEMON_SECRET": _load_or_create_daemon_secret(),
                # Point relay server to the managed web dist so auto-updates take effect.
                "VMUX_WEB_DIST": str(DATA_DIR / "web" / "dist"),
            },
            cwd=str(relay_server_dir),
            health_url=f"http://127.0.0.1:{relay_port}/api/health",
            health_headers={"X-Daemon-Secret": _load_or_create_daemon_secret()},
            startup_grace_s=30.0,
        ),
    ]
    return configs


class VmuxDaemon:
    def __init__(self):
        self._service_manager = None
        self._session_manager = None
        self._ipc_server = None
        self._daemon_secret: str = ""
        self._shutdown_event: Optional[asyncio.Event] = None  # created in run() on the correct loop
        self._update_task: Optional[asyncio.Task] = None
        self._state_task: Optional[asyncio.Task] = None

    async def run(self):
        # Create Event inside the coroutine so it binds to asyncio.run()'s loop.
        # Creating it in __init__ causes "Future attached to a different loop" on Python 3.9.
        self._shutdown_event = asyncio.Event()
        logger.info(f"vmuxd starting (pid={os.getpid()})")
        _load_env()
        self._daemon_secret = _load_or_create_daemon_secret()

        # Import here after sys.path is set up
        from service_manager import ServiceManager
        from session_manager import SessionManager
        from ipc_server import IpcServer

        # Build and start service manager
        self._service_manager = ServiceManager()
        for cfg in _build_service_configs():
            self._service_manager.add(cfg)

        plugin_dir = os.environ.get("VMUX_PLUGIN_DIR", str(DAEMON_DIR.parent.parent))
        self._session_manager = SessionManager(
            relay_base_url=RELAY_URL,
            plugin_dir=plugin_dir,
            daemon_secret=self._daemon_secret,
        )

        self._ipc_server = IpcServer(self._handle_ipc)

        # Kill orphaned processes from a previous daemon crash before binding ports
        _cleanup_stale_processes()

        # Start all components
        logger.info("Starting infrastructure services...")
        await self._service_manager.start_all()
        logger.info("All services started.")

        logger.info("Starting session manager...")
        await self._session_manager.start()

        logger.info("Starting IPC server...")
        await self._ipc_server.start()

        # Background tasks
        self._update_task = asyncio.create_task(self._auto_update_loop())
        self._state_task = asyncio.create_task(self._state_writer_loop())

        # Set up signal handlers
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, lambda: self._shutdown_event.set())

        logger.info("vmuxd ready — listening on /tmp/vmuxd.sock")
        await self._shutdown_event.wait()
        await self._shutdown()

    async def _shutdown(self):
        logger.info("vmuxd shutting down...")

        for task in (self._update_task, self._state_task):
            if task and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        if self._ipc_server:
            await self._ipc_server.stop()

        if self._session_manager:
            await self._session_manager.stop()

        if self._service_manager:
            await self._service_manager.stop_all(timeout=8.0)

        DAEMON_STATE_FILE.unlink(missing_ok=True)
        logger.info("vmuxd stopped.")

    async def _handle_ipc(self, request: dict) -> dict:
        cmd = request.get("cmd", "")
        try:
            if cmd == "status":
                return await self._cmd_status()
            elif cmd == "spawn":
                cwd = request.get("cwd", "")
                if not cwd:
                    return {"ok": False, "error": "cwd is required"}
                return await self._session_manager.spawn(cwd)
            elif cmd == "kill":
                session_id = request.get("session_id", "")
                if not session_id:
                    return {"ok": False, "error": "session_id is required"}
                ok = await self._session_manager.kill(session_id)
                return {"ok": ok, "error": None if ok else "Session not found"}
            elif cmd == "list":
                sessions = await self._session_manager.list_sessions()
                return {"ok": True, "sessions": sessions}
            elif cmd == "interrupt":
                session_id = request.get("session_id", "")
                ok = await self._session_manager.interrupt(session_id)
                return {"ok": ok}
            elif cmd == "hard-interrupt":
                session_id = request.get("session_id", "")
                ok = await self._session_manager.hard_interrupt(session_id)
                return {"ok": ok}
            elif cmd == "restart-session":
                session_id = request.get("session_id", "")
                return await self._session_manager.restart_session(session_id)
            elif cmd == "reconnect-session":
                session_id = request.get("session_id", "")
                cwd = request.get("cwd", "")
                return await self._session_manager.reconnect_session(session_id=session_id, cwd=cwd)
            elif cmd == "restart":
                service = request.get("service", "")
                ok = await self._service_manager.restart(service)
                return {"ok": ok, "error": None if ok else f"Service not found: {service}"}
            elif cmd == "attach-info":
                session_id = request.get("session_id", "")
                info = await self._session_manager.get_attach_info(session_id)
                if info:
                    return {"ok": True, **info}
                return {"ok": False, "error": "Session not found"}
            elif cmd == "capture-terminal":
                session_id = request.get("session_id", "")
                lines = int(request.get("lines", 50))
                output = await self._session_manager.capture_terminal(session_id, lines)
                if output is None:
                    return {"ok": False, "error": "Session not found or tmux capture failed"}
                return {"ok": True, "output": output}
            elif cmd == "auth-code":
                return await self._cmd_auth_code()
            elif cmd == "update-if-newer":
                return await self._cmd_update_if_newer()
            elif cmd == "shutdown":
                self._shutdown_event.set()
                return {"ok": True}
            else:
                return {"ok": False, "error": f"Unknown command: {cmd}"}
        except Exception as e:
            logger.error(f"IPC handler error for cmd={cmd}: {e}")
            return {"ok": False, "error": str(e)}

    async def _cmd_status(self) -> dict:
        services = self._service_manager.get_status()
        sessions = await self._session_manager.list_sessions()
        return {
            "ok": True,
            "daemon_pid": os.getpid(),
            "services": services,
            "sessions": sessions,
        }

    async def _cmd_auth_code(self) -> dict:
        """Generate a pairing code via the relay server."""
        import httpx
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.post(
                    f"{RELAY_URL}/api/auth/session-code",
                )
                if resp.status_code == 200:
                    data = resp.json()
                    return {"ok": True, "code": data.get("code"), "expires_in": data.get("expires_in")}
                return {"ok": False, "error": f"Relay returned {resp.status_code}"}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def _auto_update_loop(self):
        """Poll plugin cache every 60s and self-update if a newer version is available."""
        while True:
            try:
                await asyncio.sleep(AUTO_UPDATE_INTERVAL)
                result = await self._cmd_update_if_newer()
                if result.get("updated"):
                    logger.info("Auto-update applied — restarting via launchd...")
                    # launchd KeepAlive will restart us
                    self._shutdown_event.set()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.debug(f"Auto-update check failed: {e}")

    async def _cmd_update_if_newer(self) -> dict:
        """Check plugin cache for newer version and apply if found."""
        installed_version = _read_installed_version()

        # Find latest cache directory
        if not PLUGIN_CACHE_DIR.exists():
            return {"ok": True, "updated": False, "reason": "plugin cache not found"}

        cache_versions = []
        for entry in PLUGIN_CACHE_DIR.iterdir():
            if not entry.is_dir():
                continue
            plugin_json = entry / "plugin.json"
            if not plugin_json.exists():
                continue
            try:
                data = json.loads(plugin_json.read_text())
                ver = data.get("version", "")
                if ver:
                    cache_versions.append((ver, entry))
            except Exception:
                continue

        if not cache_versions:
            return {"ok": True, "updated": False, "reason": "no versions in cache"}

        # Sort by version
        cache_versions.sort(key=lambda x: _parse_version(x[0]), reverse=True)
        latest_version, latest_dir = cache_versions[0]

        if not _is_newer(latest_version, installed_version):
            return {"ok": True, "updated": False, "current": installed_version, "latest": latest_version}

        logger.info(f"Updating daemon from {installed_version} → {latest_version}")

        # Copy daemon files from cache to install location
        src_daemon_dir = latest_dir / "daemon"
        if not src_daemon_dir.exists():
            return {"ok": False, "error": "daemon/ directory not found in cache"}

        try:
            import shutil
            # 1. Copy daemon files
            shutil.copytree(str(src_daemon_dir), str(DAEMON_DIR), dirs_exist_ok=True)
            VERSION_FILE.write_text(latest_version)
            logger.info(f"Daemon files updated to {latest_version}")

            # 2. Copy relay-server files
            src_relay = latest_dir / "relay-server"
            dst_relay = DATA_DIR / "relay-server"
            if src_relay.exists():
                shutil.copytree(str(src_relay), str(dst_relay), dirs_exist_ok=True)
                logger.info("relay-server files updated")

            # 3. Update web dist — prefer pre-built dist in cache, fall back to npm build
            src_web_dist = latest_dir / "web" / "dist"
            dst_web_dist = DATA_DIR / "web" / "dist"
            dst_web_dist.parent.mkdir(parents=True, exist_ok=True)
            if src_web_dist.exists():
                shutil.copytree(str(src_web_dist), str(dst_web_dist), dirs_exist_ok=True)
                logger.info("web dist updated from cache")
            else:
                # No pre-built dist — try to build from source
                src_web = latest_dir / "web"
                if src_web.exists() and (src_web / "package.json").exists():
                    import subprocess
                    logger.info("Building web app from source...")
                    r = subprocess.run(
                        ["npm", "run", "build"],
                        cwd=str(src_web),
                        capture_output=True,
                        timeout=120,
                    )
                    if r.returncode == 0 and (src_web / "dist").exists():
                        shutil.copytree(str(src_web / "dist"), str(dst_web_dist), dirs_exist_ok=True)
                        logger.info("web app rebuilt and updated")
                    else:
                        logger.warning(f"web app build failed: {r.stderr.decode()[:200]}")

            # 4. Update the launchd plist so VMUX_PLUGIN_DIR points to the new
            #    version. This ensures any future installs or fallback paths use
            #    the correct cache directory.
            plist_path = Path.home() / "Library" / "LaunchAgents" / "com.vmux.daemon.plist"
            if plist_path.exists():
                try:
                    import plistlib
                    with open(plist_path, "rb") as f:
                        plist = plistlib.load(f)
                    env_vars = plist.get("EnvironmentVariables", {})
                    env_vars["VMUX_PLUGIN_DIR"] = str(latest_dir)
                    plist["EnvironmentVariables"] = env_vars
                    with open(plist_path, "wb") as f:
                        plistlib.dump(plist, f)
                    logger.info(f"Plist updated: VMUX_PLUGIN_DIR → {latest_dir}")
                except Exception as e:
                    logger.warning(f"Failed to update plist: {e}")

            logger.info(f"Update complete: {installed_version} → {latest_version}")
            return {"ok": True, "updated": True, "version": latest_version}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def _state_writer_loop(self):
        """Periodically write daemon.state for external process management."""
        while True:
            try:
                await asyncio.sleep(10)
                pids = self._service_manager.get_pids()
                sessions = await self._session_manager.list_sessions()
                _write_state(pids, sessions)
            except asyncio.CancelledError:
                break
            except Exception:
                pass


def _read_installed_version() -> str:
    try:
        return VERSION_FILE.read_text().strip()
    except Exception:
        return "0.0.0"


def _parse_version(v: str) -> tuple:
    try:
        return tuple(int(x) for x in v.split("."))
    except Exception:
        return (0, 0, 0)


def _is_newer(candidate: str, current: str) -> bool:
    return _parse_version(candidate) > _parse_version(current)


if __name__ == "__main__":
    # Add daemon directory to sys.path so local imports work
    daemon_dir = os.path.dirname(os.path.abspath(__file__))
    if daemon_dir not in sys.path:
        sys.path.insert(0, daemon_dir)

    asyncio.run(VmuxDaemon().run())
