"""Service manager — starts, monitors, and auto-restarts infrastructure services."""

import asyncio
import logging
import os
import signal
import time
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger("vmuxd.services")


@dataclass
class ServiceConfig:
    name: str
    cmd: list[str]
    env: dict[str, str] = field(default_factory=dict)
    cwd: Optional[str] = None
    health_url: Optional[str] = None
    health_headers: dict[str, str] = field(default_factory=dict)
    max_restarts: int = 5
    restart_backoff_base: float = 2.0
    restart_backoff_max: float = 60.0
    startup_grace_s: float = 30.0


class ManagedService:
    def __init__(self, config: ServiceConfig):
        self.config = config
        self.process: Optional[asyncio.subprocess.Process] = None
        self.pid: Optional[int] = None
        self.status: str = "stopped"
        self._restart_count = 0
        self._stop_requested = False
        self._monitor_task: Optional[asyncio.Task] = None

    async def start(self) -> bool:
        self._stop_requested = False
        self._restart_count = 0
        return await self._launch()

    async def stop(self, timeout: float = 5.0):
        self._stop_requested = True
        if self._monitor_task and not self._monitor_task.done():
            self._monitor_task.cancel()
            try:
                await self._monitor_task
            except asyncio.CancelledError:
                pass
        if self.process and self.process.returncode is None:
            try:
                # Kill the entire process group so child processes (e.g. the
                # Python process spawned by `uv run`) are also terminated.
                pgid = os.getpgid(self.process.pid)
                os.killpg(pgid, signal.SIGTERM)
                try:
                    await asyncio.wait_for(self.process.wait(), timeout=timeout)
                except asyncio.TimeoutError:
                    os.killpg(pgid, signal.SIGKILL)
                    await self.process.wait()
            except (ProcessLookupError, OSError):
                # Process or group already gone
                pass
        self.process = None
        self.pid = None
        self.status = "stopped"

    def reset_restart_count(self):
        self._restart_count = 0

    async def _launch(self) -> bool:
        try:
            env = {**os.environ, **self.config.env}
            proc = await asyncio.create_subprocess_exec(
                *self.config.cmd,
                env=env,
                cwd=self.config.cwd,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True,  # new process group so we can kill children
            )
            self.process = proc
            self.pid = proc.pid
            self.status = "starting"
            logger.info(f"[{self.config.name}] started (pid={self.pid})")

            if self.config.health_url:
                healthy = await self._wait_healthy(timeout=self.config.startup_grace_s)
                if not healthy:
                    logger.warning(f"[{self.config.name}] health check timed out; assuming running")
                self.status = "running"
            else:
                await asyncio.sleep(1.0)
                if self.process.returncode is None:
                    self.status = "running"
                else:
                    self.status = "failed"
                    return False

            if self._monitor_task is None or self._monitor_task.done():
                self._monitor_task = asyncio.create_task(self._monitor())
            return True
        except Exception as e:
            logger.error(f"[{self.config.name}] failed to start: {e}")
            self.status = "failed"
            return False

    async def _monitor(self):
        while not self._stop_requested:
            if self.process:
                await self.process.wait()
                if self._stop_requested:
                    break
                code = self.process.returncode
                logger.warning(f"[{self.config.name}] exited (code={code})")
                self.status = "failed"

                if self._restart_count >= self.config.max_restarts:
                    logger.error(f"[{self.config.name}] max restarts ({self.config.max_restarts}) reached — giving up")
                    break

                backoff = min(
                    self.config.restart_backoff_base ** self._restart_count,
                    self.config.restart_backoff_max,
                )
                logger.info(f"[{self.config.name}] restarting in {backoff:.1f}s (attempt {self._restart_count + 1})")
                await asyncio.sleep(backoff)
                self._restart_count += 1
                await self._launch()
            else:
                await asyncio.sleep(1.0)

    async def _wait_healthy(self, timeout: float) -> bool:
        import httpx
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                async with httpx.AsyncClient(timeout=2.0) as client:
                    resp = await client.get(
                        self.config.health_url,
                        headers=self.config.health_headers,
                    )
                    if resp.status_code == 200:
                        return True
            except Exception:
                pass
            await asyncio.sleep(2.0)
        return False

    async def health_check(self) -> bool:
        if self.process is None or self.process.returncode is not None:
            return False
        if not self.config.health_url:
            return self.status == "running"
        import httpx
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                resp = await client.get(
                    self.config.health_url,
                    headers=self.config.health_headers,
                )
                return resp.status_code == 200
        except Exception:
            return False


class ServiceManager:
    def __init__(self):
        self._services: dict[str, ManagedService] = {}

    def add(self, config: ServiceConfig):
        self._services[config.name] = ManagedService(config)

    async def start_all(self):
        for svc in self._services.values():
            await svc.start()

    async def stop_all(self, timeout: float = 5.0):
        await asyncio.gather(
            *[svc.stop(timeout) for svc in self._services.values()],
            return_exceptions=True,
        )

    async def restart(self, name: str) -> bool:
        svc = self._services.get(name)
        if not svc:
            return False
        await svc.stop()
        svc.reset_restart_count()
        return await svc.start()

    def get_status(self) -> dict[str, str]:
        return {name: svc.status for name, svc in self._services.items()}

    def get_pids(self) -> dict[str, Optional[int]]:
        return {name: svc.pid for name, svc in self._services.items()}

    async def health_check_all(self) -> dict[str, bool]:
        results = {}
        for name, svc in self._services.items():
            results[name] = await svc.health_check()
        return results
