"""Session registry for tracking active Claude Code sessions."""

import asyncio
import time
from dataclasses import dataclass, field

from config import SESSION_TIMEOUT


@dataclass
class Session:
    session_id: str
    name: str
    cwd: str
    dir_name: str
    ws: object  # WebSocket connection
    last_heartbeat: float = field(default_factory=time.time)
    connected_client: str | None = None  # client ID currently connected to this session

    @property
    def is_stale(self) -> bool:
        return time.time() - self.last_heartbeat > SESSION_TIMEOUT

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "name": self.name,
            "cwd": self.cwd,
            "dir_name": self.dir_name,
            "connected_client": self.connected_client,
            "last_heartbeat": self.last_heartbeat,
        }


class SessionRegistry:
    def __init__(self):
        self._sessions: dict[str, Session] = {}
        self._lock = asyncio.Lock()

    async def register(self, session_id: str, name: str, cwd: str, dir_name: str, ws) -> Session:
        async with self._lock:
            session = Session(
                session_id=session_id,
                name=name,
                cwd=cwd,
                dir_name=dir_name,
                ws=ws,
            )
            self._sessions[session_id] = session
            return session

    async def unregister(self, session_id: str):
        async with self._lock:
            self._sessions.pop(session_id, None)

    async def heartbeat(self, session_id: str):
        async with self._lock:
            if session_id in self._sessions:
                self._sessions[session_id].last_heartbeat = time.time()

    async def get(self, session_id: str) -> Session | None:
        return self._sessions.get(session_id)

    async def list_sessions(self) -> list[dict]:
        await self._prune_stale()
        return [s.to_dict() for s in self._sessions.values()]

    async def connect_client(self, session_id: str, client_id: str) -> bool:
        async with self._lock:
            session = self._sessions.get(session_id)
            if session:
                session.connected_client = client_id
                return True
            return False

    async def disconnect_client(self, session_id: str):
        async with self._lock:
            session = self._sessions.get(session_id)
            if session:
                session.connected_client = None

    async def _prune_stale(self):
        async with self._lock:
            stale = [sid for sid, s in self._sessions.items() if s.is_stale]
            for sid in stale:
                del self._sessions[sid]
