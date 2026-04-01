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
import resource
import secrets
import signal
import sys
import time
from pathlib import Path
from typing import Optional

# Raise file descriptor limit for daemon and all child services.
# launchd defaults to 256 which is too low for managing multiple services.
try:
    _soft, _hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    _target = min(_hard, 65536) if _hard != resource.RLIM_INFINITY else 65536
    if _soft < _target:
        resource.setrlimit(resource.RLIMIT_NOFILE, (_target, _hard))
except (ValueError, OSError):
    pass

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

# Kokoro memory watchdog settings
KOKORO_MAX_RSS_MB = int(os.environ.get("KOKORO_MAX_RSS_MB", "5120"))
KOKORO_WATCHDOG_INTERVAL = 30  # seconds between RSS checks
KOKORO_WATCHDOG_COOLDOWN = 300  # minimum seconds between memory-triggered restarts


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
    livekit_rtc_port = os.environ.get("LIVEKIT_RTC_PORT", "")
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

    log_dir = str(LOG_DIR)

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
            cwd=str(DATA_DIR),  # whisper-server calls getcwd() at startup; avoid inheriting a deleted CWD
            log_dir=log_dir,
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
            log_dir=log_dir,
            startup_grace_s=90.0,
        ),
        ServiceConfig(
            name="livekit",
            cmd=[
                "livekit-server",
                "--bind", "0.0.0.0",
                "--keys", f"{livekit_api_key}: {livekit_api_secret}",
            ] + ([
                "--udp-port", livekit_rtc_port,
                "--rtc.tcp_port", livekit_rtc_port,
            ] if livekit_rtc_port else []),
            health_url=f"http://127.0.0.1:{livekit_port}/",
            cwd=str(DATA_DIR),
            log_dir=log_dir,
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
                "--with", "webrtcvad-wheels>=2.0.10",
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
            log_dir=log_dir,
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
        self._watchdog_task: Optional[asyncio.Task] = None
        self._last_kokoro_memory_restart: float = 0.0  # monotonic timestamp

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
        self._watchdog_task = asyncio.create_task(self._memory_watchdog_loop())

        # Set up signal handlers
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, lambda: self._shutdown_event.set())

        logger.info("vmuxd ready — listening on /tmp/vmuxd.sock")
        await self._shutdown_event.wait()
        await self._shutdown()

    async def _shutdown(self):
        logger.info("vmuxd shutting down...")

        for task in (self._update_task, self._state_task, self._watchdog_task):
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
                session_name = request.get("session_name", "")
                return await self._session_manager.spawn(cwd, session_name=session_name)
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
            elif cmd == "clear-context":
                session_id = request.get("session_id", "")
                ok = await self._session_manager.clear_context(session_id)
                return {"ok": ok}
            elif cmd == "compact":
                session_id = request.get("session_id", "")
                ok = await self._session_manager.compact_context(session_id)
                return {"ok": ok}
            elif cmd == "change-model":
                session_id = request.get("session_id", "")
                model = request.get("model", "")
                if not model:
                    return {"ok": False, "error": "model is required"}
                ok = await self._session_manager.change_model(session_id, model)
                return {"ok": ok}
            elif cmd == "context-usage":
                session_id = request.get("session_id", "")
                usage = await self._session_manager.get_context_usage(session_id)
                if usage:
                    return {"ok": True, **usage}
                return {"ok": False, "error": "Context usage not available"}
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
            elif cmd == "capture-terminal-ansi":
                session_id = request.get("session_id", "")
                lines = int(request.get("lines", 50))
                content = await self._session_manager.capture_terminal_ansi(
                    session_id, int(lines)
                )
                return {"ok": True, "content": content}
            elif cmd == "send-keys":
                session_id = request.get("session_id", "")
                keys = request.get("keys", "")
                special = request.get("special_key", "")
                if not session_id:
                    return {"ok": False, "error": "session_id is required"}
                if special:
                    ok = await self._session_manager.send_special_key(session_id, special)
                elif keys:
                    ok = await self._session_manager.send_keys(session_id, keys)
                else:
                    return {"ok": False, "error": "keys or special_key is required"}
                return {"ok": ok, "error": None if ok else "Session not found or send failed"}
            elif cmd == "send-message":
                session_id = request.get("session_id", "")
                text = request.get("text", "")
                if not session_id:
                    return {"ok": False, "error": "session_id is required"}
                if not text:
                    return {"ok": False, "error": "text is required"}
                return await self._cmd_send_message(session_id, text)
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
        # Run live health checks to catch silently-broken services
        health = await self._service_manager.health_check_all()
        for name in services:
            if services[name] == "running" and not health.get(name, True):
                services[name] = "unhealthy"
        sessions = await self._session_manager.list_sessions()
        return {
            "ok": True,
            "daemon_pid": os.getpid(),
            "version": _read_installed_version(),
            "services": services,
            "sessions": sessions,
        }

    async def _cmd_send_message(self, session_id: str, text: str) -> dict:
        """Send a text message to a session via the relay server."""
        from service_manager import _get_health_client
        try:
            client = await _get_health_client()
            resp = await client.post(
                f"{RELAY_URL}/api/sessions/{session_id}/message",
                json={"text": text},
                headers={"X-Daemon-Secret": self._daemon_secret},
                timeout=10.0,
            )
            if resp.status_code == 200:
                return {"ok": True}
            data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
            return {"ok": False, "error": data.get("error", f"Relay returned {resp.status_code}")}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def _cmd_auth_code(self) -> dict:
        """Generate a pairing code via the relay server."""
        from service_manager import _get_health_client
        try:
            client = await _get_health_client()
            resp = await client.post(
                f"{RELAY_URL}/api/auth/session-code",
                timeout=5.0,
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
                    logger.info("[update] auto-update applied — forcing restart via launchd")
                    self._shutdown_event.set()
                    # Watchdog: if graceful shutdown stalls, force-kill after 15s
                    await asyncio.sleep(15)
                    logger.warning("[update] graceful shutdown timed out — forcing exit")
                    os._exit(0)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"[update] check failed: {e}")

    async def _cmd_update_if_newer(self) -> dict:
        """Check plugin cache for newer version and apply if found."""
        installed_version = _read_installed_version()
        logger.info(f"[update] check: installed={installed_version}, cache={PLUGIN_CACHE_DIR}")

        if not PLUGIN_CACHE_DIR.exists():
            logger.info(f"[update] plugin cache dir not found")
            return {"ok": True, "updated": False, "reason": "plugin cache not found"}

        cache_versions = []
        for entry in PLUGIN_CACHE_DIR.iterdir():
            if not entry.is_dir():
                continue
            ver = _detect_cache_version(entry)
            if ver and _parse_version(ver) != (0, 0, 0):
                cache_versions.append((ver, entry))
            else:
                logger.debug(f"[update] skipping cache entry: {entry.name}")

        if not cache_versions:
            logger.info(f"[update] no valid versions found in cache")
            return {"ok": True, "updated": False, "reason": "no versions in cache"}

        cache_versions.sort(key=lambda x: _parse_version(x[0]), reverse=True)
        latest_version, latest_dir = cache_versions[0]
        logger.info(f"[update] latest in cache: {latest_version} (dir={latest_dir.name})")

        if not _is_newer(latest_version, installed_version):
            return {"ok": True, "updated": False, "current": installed_version, "latest": latest_version}

        logger.info(f"[update] upgrading {installed_version} → {latest_version}")

        src_daemon_dir = latest_dir / "daemon"
        if not src_daemon_dir.exists():
            logger.error(f"[update] daemon/ not found in {latest_dir}")
            return {"ok": False, "error": "daemon/ directory not found in cache"}

        try:
            import shutil
            import subprocess
            import tempfile

            # 1. Daemon files — clean replace, preserving the vmuxd wrapper
            #    The vmuxd wrapper is generated by install.sh and not part of
            #    the source tree, so we must preserve it across updates.
            logger.info("[update] replacing daemon/ files")
            vmuxd_wrapper = DAEMON_DIR / "vmuxd"
            saved_wrapper = None
            if vmuxd_wrapper.exists():
                saved_wrapper = vmuxd_wrapper.read_bytes()
            if DAEMON_DIR.exists():
                shutil.rmtree(DAEMON_DIR)
            shutil.copytree(str(src_daemon_dir), str(DAEMON_DIR))
            # Restore the wrapper (or regenerate if it was missing)
            if saved_wrapper:
                vmuxd_wrapper.write_bytes(saved_wrapper)
                vmuxd_wrapper.chmod(0o755)
                logger.info("[update] restored vmuxd wrapper")
            elif not vmuxd_wrapper.exists():
                uv_path = shutil.which("uv") or str(Path.home() / ".local" / "bin" / "uv")
                vmuxd_wrapper.write_text(
                    f"#!/bin/bash\n"
                    f'cd "{DAEMON_DIR}"\n'
                    f'exec "{uv_path}" run "{DAEMON_DIR / "vmuxd.py"}" "$@"\n'
                )
                vmuxd_wrapper.chmod(0o755)
                logger.info("[update] regenerated vmuxd wrapper")

            # 2. Relay-server files — clean replace
            src_relay = latest_dir / "relay-server"
            dst_relay = DATA_DIR / "relay-server"
            if src_relay.exists():
                logger.info("[update] replacing relay-server/ files")
                if dst_relay.exists():
                    shutil.rmtree(dst_relay)
                shutil.copytree(str(src_relay), str(dst_relay))

            # 3. Web dist — prefer pre-built, else build in temp dir
            src_web_dist = latest_dir / "web" / "dist"
            dst_web_dist = DATA_DIR / "web" / "dist"
            dst_web_dist.parent.mkdir(parents=True, exist_ok=True)

            if src_web_dist.exists():
                logger.info("[update] copying pre-built web dist")
                if dst_web_dist.exists():
                    shutil.rmtree(dst_web_dist)
                shutil.copytree(str(src_web_dist), str(dst_web_dist))
            else:
                src_web = latest_dir / "web"
                if src_web.exists() and (src_web / "package.json").exists():
                    logger.info("[update] building web app from source")
                    with tempfile.TemporaryDirectory() as tmp:
                        build_dir = Path(tmp) / "web"
                        shutil.copytree(str(src_web), str(build_dir))
                        r = subprocess.run(
                            ["npm", "ci", "--prefer-offline"],
                            cwd=str(build_dir),
                            capture_output=True,
                            timeout=120,
                        )
                        if r.returncode != 0:
                            logger.warning(f"[update] npm ci failed: {r.stderr.decode()[:300]}")
                        else:
                            r = subprocess.run(
                                ["npm", "run", "build"],
                                cwd=str(build_dir),
                                capture_output=True,
                                timeout=120,
                            )
                            if r.returncode == 0 and (build_dir / "dist").exists():
                                if dst_web_dist.exists():
                                    shutil.rmtree(dst_web_dist)
                                shutil.copytree(str(build_dir / "dist"), str(dst_web_dist))
                                logger.info("[update] web app built and installed")
                            else:
                                logger.warning(f"[update] npm build failed: {r.stderr.decode()[:300]}")
                else:
                    logger.warning("[update] no web source found in cache — web UI not updated")

            # 4. Update init service VMUX_PLUGIN_DIR
            if sys.platform == "darwin":
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
                        logger.info(f"[update] plist updated: VMUX_PLUGIN_DIR → {latest_dir}")
                    except Exception as e:
                        logger.warning(f"[update] plist update failed: {e}")
            else:
                import re as _re
                unit_path = Path.home() / ".config" / "systemd" / "user" / "vmuxd.service"
                if unit_path.exists():
                    try:
                        content = unit_path.read_text()
                        content = _re.sub(
                            r'Environment=VMUX_PLUGIN_DIR=.*',
                            f'Environment=VMUX_PLUGIN_DIR={latest_dir}',
                            content,
                        )
                        unit_path.write_text(content)
                        await asyncio.create_subprocess_exec(
                            "systemctl", "--user", "daemon-reload"
                        )
                        logger.info(f"[update] systemd unit updated: VMUX_PLUGIN_DIR → {latest_dir}")
                    except Exception as e:
                        logger.warning(f"[update] systemd unit update failed: {e}")

            # 5. Verify
            actual = _read_installed_version()
            if actual != latest_version:
                logger.error(f"[update] verification failed: expected {latest_version}, got {actual}")
                return {"ok": False, "error": f"version mismatch after copy: {actual} != {latest_version}"}

            logger.info(f"[update] complete: {installed_version} → {latest_version}")
            return {"ok": True, "updated": True, "version": latest_version}
        except Exception as e:
            logger.error(f"[update] failed: {e}")
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

    async def _memory_watchdog_loop(self):
        """Monitor kokoro process memory and restart when exceeding threshold.

        The kokoro TTS service (using MPS Metal GPU) has an intractable native
        memory leak from the C-level MPS allocator that cannot be fixed in our code.

        Uses macOS `footprint` for kokoro (captures MPS GPU memory).
        Also logs relay server RSS for observability (no auto-restart).
        """
        logger.info(
            f"[watchdog] memory watchdog started "
            f"(kokoro={KOKORO_MAX_RSS_MB}MB, "
            f"interval={KOKORO_WATCHDOG_INTERVAL}s)"
        )
        while True:
            try:
                await asyncio.sleep(KOKORO_WATCHDOG_INTERVAL)

                pids = self._service_manager.get_pids()

                # --- Kokoro watchdog ---
                kokoro_pid = pids.get("kokoro")
                if kokoro_pid:
                    footprint_mb = await self._get_process_tree_footprint(kokoro_pid)
                    if footprint_mb is not None:
                        logger.info(f"[watchdog] kokoro footprint={footprint_mb:.0f}MB")

                        if footprint_mb > KOKORO_MAX_RSS_MB:
                            now = time.monotonic()
                            elapsed = now - self._last_kokoro_memory_restart
                            if elapsed < KOKORO_WATCHDOG_COOLDOWN:
                                remaining = int(KOKORO_WATCHDOG_COOLDOWN - elapsed)
                                logger.warning(
                                    f"[watchdog] kokoro footprint={footprint_mb:.0f}MB exceeds "
                                    f"{KOKORO_MAX_RSS_MB}MB but cooldown active "
                                    f"({remaining}s remaining) — skipping restart"
                                )
                            else:
                                logger.warning(
                                    f"[watchdog] kokoro footprint={footprint_mb:.0f}MB exceeds "
                                    f"{KOKORO_MAX_RSS_MB}MB threshold — restarting"
                                )
                                self._last_kokoro_memory_restart = now
                                ok = await self._service_manager.restart("kokoro")
                                if ok:
                                    logger.info("[watchdog] kokoro restarted successfully")
                                else:
                                    logger.error("[watchdog] kokoro restart failed")

                # --- Relay server RSS logging (observability only, no auto-restart) ---
                relay_pid = pids.get("relay")
                if relay_pid:
                    relay_rss_mb = await self._get_process_tree_rss(relay_pid)
                    if relay_rss_mb is not None:
                        logger.info(f"[watchdog] relay RSS={relay_rss_mb:.0f}MB")

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"[watchdog] error: {e}")

    @staticmethod
    async def _get_process_tree_footprint(root_pid: int) -> Optional[float]:
        """Get total dirty memory footprint in MB for a process tree.

        On macOS: uses the `footprint --pid` command which reports actual dirty
        memory including MPS GPU allocations and malloc regions.

        On Linux: delegates to _get_process_tree_rss which reads /proc smaps_rollup.

        Walks the process tree (root + descendants) and sums footprints.
        """
        import re

        if sys.platform != "darwin":
            return await VmuxDaemon._get_process_tree_rss(root_pid)

        try:
            # First, find all PIDs in the process tree via ps
            proc = await asyncio.create_subprocess_exec(
                "ps", "-eo", "pid=,ppid=",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await proc.communicate()
            if proc.returncode != 0:
                return None

            # Parse ps output into a dict: pid -> ppid
            children: dict[int, int] = {}
            for line in stdout.decode().strip().splitlines():
                parts = line.split()
                if len(parts) != 2:
                    continue
                try:
                    pid, ppid = int(parts[0]), int(parts[1])
                    children[pid] = ppid
                except ValueError:
                    continue

            if root_pid not in children:
                return None

            # BFS to find all descendants
            tree_pids = {root_pid}
            frontier = [root_pid]
            while frontier:
                parent = frontier.pop()
                for pid, ppid in children.items():
                    if ppid == parent and pid not in tree_pids:
                        tree_pids.add(pid)
                        frontier.append(pid)

            # Run footprint on each PID in the tree and sum
            total_mb = 0.0
            footprint_re = re.compile(r"Footprint:\s+([\d.]+)\s+(MB|GB|KB)", re.MULTILINE)

            for pid in tree_pids:
                try:
                    fp_proc = await asyncio.create_subprocess_exec(
                        "footprint", "--pid", str(pid),
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.DEVNULL,
                    )
                    fp_stdout, _ = await fp_proc.communicate()
                    if fp_proc.returncode != 0:
                        continue
                    match = footprint_re.search(fp_stdout.decode())
                    if match:
                        value = float(match.group(1))
                        unit = match.group(2)
                        if unit == "GB":
                            value *= 1024
                        elif unit == "KB":
                            value /= 1024
                        total_mb += value
                except Exception:
                    continue

            return total_mb if total_mb > 0 else None
        except Exception:
            return None


    @staticmethod
    async def _get_process_tree_rss(root_pid: int) -> Optional[float]:
        """Get total RSS in MB for a process tree using `ps`.

        Simpler and more reliable than `footprint` (which may need root).
        Walks the process tree and sums RSS for all descendants.
        """
        try:
            proc = await asyncio.create_subprocess_exec(
                "ps", "-eo", "pid=,ppid=,rss=",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await proc.communicate()
            if proc.returncode != 0:
                return None

            # Parse ps output: pid, ppid, rss (in KB)
            children: dict[int, int] = {}
            rss_map: dict[int, int] = {}
            for line in stdout.decode().strip().splitlines():
                parts = line.split()
                if len(parts) != 3:
                    continue
                try:
                    pid, ppid, rss = int(parts[0]), int(parts[1]), int(parts[2])
                    children[pid] = ppid
                    rss_map[pid] = rss
                except ValueError:
                    continue

            if root_pid not in children:
                return None

            # BFS to find all descendants
            tree_pids = {root_pid}
            frontier = [root_pid]
            while frontier:
                parent = frontier.pop()
                for pid, ppid in children.items():
                    if ppid == parent and pid not in tree_pids:
                        tree_pids.add(pid)
                        frontier.append(pid)

            total_kb = sum(rss_map.get(pid, 0) for pid in tree_pids)
            return total_kb / 1024.0 if total_kb > 0 else None
        except Exception:
            return None


def _detect_cache_version(cache_entry: Path) -> str:
    """Extract version from a plugin cache directory.

    Checks (in order):
    1. .claude-plugin/plugin.json → version field
    2. plugin.json at root → version field (legacy)
    3. Directory name if it parses as a version
    """
    for json_path in [
        cache_entry / ".claude-plugin" / "plugin.json",
        cache_entry / "plugin.json",
    ]:
        if json_path.exists():
            try:
                data = json.loads(json_path.read_text())
                ver = data.get("version", "")
                if ver:
                    return ver
            except Exception:
                continue
    # Fall back to directory name
    name = cache_entry.name
    if _parse_version(name) != (0, 0, 0):
        return name
    return ""


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
