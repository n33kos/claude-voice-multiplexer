"""Unix socket IPC server — handles vmux CLI commands."""

import asyncio
import json
import logging
import os
from typing import Callable, Awaitable, Optional

logger = logging.getLogger("vmuxd.ipc")
SOCKET_PATH = "/tmp/vmuxd.sock"


class IpcServer:
    def __init__(self, handler: Callable[[dict], Awaitable[dict]]):
        self._handler = handler
        self._server: Optional[asyncio.Server] = None

    async def start(self):
        try:
            os.unlink(SOCKET_PATH)
        except FileNotFoundError:
            pass

        self._server = await asyncio.start_unix_server(
            self._handle_client,
            SOCKET_PATH,
        )
        os.chmod(SOCKET_PATH, 0o600)
        logger.info(f"IPC listening on {SOCKET_PATH}")

    async def stop(self):
        if self._server:
            self._server.close()
            await self._server.wait_closed()
        try:
            os.unlink(SOCKET_PATH)
        except FileNotFoundError:
            pass

    async def _handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=10.0)
            if not line:
                return
            try:
                request = json.loads(line.decode().strip())
            except json.JSONDecodeError:
                writer.write(json.dumps({"ok": False, "error": "Invalid JSON"}).encode() + b"\n")
                await writer.drain()
                return

            response = await self._handler(request)
            writer.write(json.dumps(response).encode() + b"\n")
            await writer.drain()
        except asyncio.TimeoutError:
            pass
        except Exception as e:
            logger.warning(f"IPC client error: {e}")
            try:
                writer.write(json.dumps({"ok": False, "error": str(e)}).encode() + b"\n")
                await writer.drain()
            except Exception:
                pass
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass
