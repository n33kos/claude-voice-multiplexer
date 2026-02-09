"""Session registry for tracking active Claude Code sessions."""

import asyncio
import time
from dataclasses import dataclass, field

from config import SESSION_TIMEOUT


def make_room_name(session_name: str) -> str:
    """Derive a LiveKit room name from a session name."""
    import re
    sanitized = re.sub(r'[^a-zA-Z0-9_\-]', '_', session_name)
    return f"vmux_{sanitized}"


@dataclass
class Session:
    session_id: str
    name: str
    cwd: str
    dir_name: str
    ws: object  # WebSocket connection
    created_at: float = field(default_factory=time.time)
    last_heartbeat: float = field(default_factory=time.time)
    connected_clients: dict[str, str] = field(default_factory=dict)  # client_id → device_name

    @property
    def room_name(self) -> str:
        return make_room_name(self.name)

    @property
    def is_stale(self) -> bool:
        return time.time() - self.last_heartbeat > SESSION_TIMEOUT

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "name": self.name,
            "cwd": self.cwd,
            "dir_name": self.dir_name,
            "room_name": self.room_name,
            "connected_clients": [
                {"client_id": cid, "device_name": dname}
                for cid, dname in self.connected_clients.items()
            ],
            "created_at": self.created_at,
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

    async def connect_client(self, session_id: str, client_id: str, device_name: str = "Unknown") -> bool:
        async with self._lock:
            session = self._sessions.get(session_id)
            if session:
                session.connected_clients[client_id] = device_name
                return True
            return False

    async def disconnect_client(self, session_id: str, client_id: str | None = None):
        async with self._lock:
            session = self._sessions.get(session_id)
            if session:
                if client_id:
                    session.connected_clients.pop(client_id, None)
                else:
                    session.connected_clients.clear()

    async def _prune_stale(self):
        async with self._lock:
            stale = [sid for sid, s in self._sessions.items() if s.is_stale]
            for sid in stale:
                del self._sessions[sid]
