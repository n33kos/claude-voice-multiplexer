"""Origin check for browser requests (cross-site WebSocket/CSRF protection).

Browsers attach an `Origin` header to WebSocket handshakes and cross-origin
requests, and they send the `vmux_token` cookie (SameSite=Lax) from any page
on the same *site* — e.g. any `localhost:*` dev server.  Without this check a
page the user happens to open could drive a session over `/ws/client`.

Rules:
- No `Origin` header (hooks, CLI, MCP, native clients): allowed here; those
  still have to authenticate (token or daemon secret).
- Same origin as the request's own host (`Host` / `X-Forwarded-Host`):
  allowed, so the web app works however it's reached (localhost, LAN IP,
  tunnel).
- Anything listed in VMUX_ALLOWED_ORIGINS: allowed (embedding apps, SDK UIs).
- Any other origin (including `null`, e.g. sandboxed app frames) only with an
  explicit token (`Authorization: Bearer …` or a `vmux-token.…` WebSocket
  subprotocol), and with its cookies stripped.  Cross-site attacks ride on
  ambient credentials (the cookie); a page can't send a token it doesn't
  have, so explicit-token requests are safe from any origin.
- Everything else: rejected before the app sees it.
"""

from typing import Iterable, Optional
from urllib.parse import urlsplit


def _netloc(origin: str) -> Optional[str]:
    try:
        parts = urlsplit(origin)
    except ValueError:
        return None
    if not parts.scheme or not parts.netloc:
        return None
    return parts.netloc.lower()


def parse_allowed_origins(raw: str) -> frozenset[str]:
    """Parse a comma-separated origin list; trailing slashes and case are ignored."""
    return frozenset(o.strip().rstrip("/").lower() for o in raw.split(",") if o.strip())


def origin_allowed(
    origin: Optional[str],
    hosts: Iterable[Optional[str]],
    allowed: frozenset[str] = frozenset(),
) -> bool:
    if origin is None:
        return True
    origin_norm = origin.strip().rstrip("/").lower()
    if origin_norm in allowed:
        return True
    netloc = _netloc(origin_norm)
    if netloc is None:
        return False  # "null", malformed
    return any(h and netloc == h.strip().lower() for h in hosts)


def has_explicit_token(headers: dict[str, str]) -> bool:
    """A credential the browser doesn't attach on its own (lowercased header dict)."""
    if headers.get("authorization", "").lower().startswith("bearer "):
        return True
    return any(p.strip().startswith("vmux-token.") for p in headers.get("sec-websocket-protocol", "").split(","))


class OriginCheckMiddleware:
    """ASGI middleware applying origin_allowed() to HTTP and WebSocket scopes."""

    def __init__(self, app, allowed: frozenset[str] = frozenset()):
        self._app = app
        self._allowed = allowed

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self._app(scope, receive, send)

        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers") or []}
        origin = headers.get("origin")
        if origin_allowed(origin, (headers.get("host"), headers.get("x-forwarded-host")), self._allowed):
            return await self._app(scope, receive, send)
        if has_explicit_token(headers):
            stripped = [(k, v) for k, v in scope.get("headers") or [] if k.lower() != b"cookie"]
            return await self._app({**scope, "headers": stripped}, receive, send)

        print(f"[origin] rejected {scope['type']} {scope.get('path')} from origin {origin!r}")
        if scope["type"] == "websocket":
            # Closing before accept rejects the handshake (HTTP 403).
            await receive()  # websocket.connect
            await send({"type": "websocket.close", "code": 4003})
            return
        body = b'{"error":"Origin not allowed"}'
        await send({
            "type": "http.response.start",
            "status": 403,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
        })
        await send({"type": "http.response.body", "body": body})
