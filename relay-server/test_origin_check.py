"""Unit tests for the origin check.

Run with: python3 -m unittest relay-server/test_origin_check.py
"""

import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from origin_check import OriginCheckMiddleware, origin_allowed, parse_allowed_origins  # noqa: E402

HOSTS = ("localhost:3100", None)


class OriginAllowedTests(unittest.TestCase):
    def test_no_origin_is_allowed(self):
        self.assertTrue(origin_allowed(None, HOSTS))

    def test_same_origin_is_allowed(self):
        self.assertTrue(origin_allowed("http://localhost:3100", HOSTS))
        self.assertTrue(origin_allowed("https://LOCALHOST:3100/", HOSTS))

    def test_same_origin_via_lan_ip_or_tunnel(self):
        self.assertTrue(origin_allowed("http://192.168.1.5:3100", ("192.168.1.5:3100", None)))
        self.assertTrue(origin_allowed("https://abc.ngrok.app", ("localhost:3100", "abc.ngrok.app")))

    def test_other_localhost_port_is_rejected(self):
        self.assertFalse(origin_allowed("http://localhost:5173", HOSTS))

    def test_loopback_alias_is_rejected(self):
        self.assertFalse(origin_allowed("http://127.0.0.1:3100", HOSTS))

    def test_foreign_site_is_rejected(self):
        self.assertFalse(origin_allowed("https://evil.example", HOSTS))

    def test_null_and_malformed_are_rejected(self):
        self.assertFalse(origin_allowed("null", HOSTS))
        self.assertFalse(origin_allowed("", HOSTS))
        self.assertFalse(origin_allowed("localhost:3100", HOSTS))

    def test_allowlist(self):
        allowed = parse_allowed_origins(" http://localhost:5173/ , glass-app://calcifer ")
        self.assertTrue(origin_allowed("http://localhost:5173", HOSTS, allowed))
        self.assertTrue(origin_allowed("glass-app://calcifer", HOSTS, allowed))
        self.assertFalse(origin_allowed("http://localhost:5174", HOSTS, allowed))

    def test_parse_ignores_empty(self):
        self.assertEqual(parse_allowed_origins(""), frozenset())
        self.assertEqual(parse_allowed_origins(" , "), frozenset())


def _run(scope, allowed=frozenset()):
    """Drive the middleware with a fake ASGI exchange; return (inner_called, sent)."""
    called = []
    sent = []

    async def inner(scope, receive, send):
        called.append(scope["type"])

    async def receive():
        return {"type": "websocket.connect"}

    async def send(msg):
        sent.append(msg)

    asyncio.run(OriginCheckMiddleware(inner, allowed)(scope, receive, send))
    return called, sent


def _scope(kind, origin=None, host="localhost:3100"):
    headers = [(b"host", host.encode())]
    if origin is not None:
        headers.append((b"origin", origin.encode()))
    return {"type": kind, "path": "/ws/client", "headers": headers}


class MiddlewareTests(unittest.TestCase):
    def test_passes_allowed_http_and_ws(self):
        self.assertEqual(_run(_scope("http", "http://localhost:3100"))[0], ["http"])
        self.assertEqual(_run(_scope("websocket"))[0], ["websocket"])

    def test_rejects_cross_site_websocket(self):
        called, sent = _run(_scope("websocket", "http://localhost:5173"))
        self.assertEqual(called, [])
        self.assertEqual(sent, [{"type": "websocket.close", "code": 4003}])

    def test_rejects_cross_site_http_with_403(self):
        called, sent = _run(_scope("http", "https://evil.example"))
        self.assertEqual(called, [])
        self.assertEqual(sent[0]["status"], 403)

    def test_lifespan_passes_through(self):
        self.assertEqual(_run({"type": "lifespan"})[0], ["lifespan"])


if __name__ == "__main__":
    unittest.main()


class ExplicitTokenTests(unittest.TestCase):
    def _run_capture(self, scope):
        seen = []

        async def inner(scope, receive, send):
            seen.append(scope)

        async def receive():
            return {"type": "websocket.connect"}

        sent = []

        async def send(msg):
            sent.append(msg)

        asyncio.run(OriginCheckMiddleware(inner)(scope, receive, send))
        return seen, sent

    def test_foreign_origin_with_subprotocol_token_passes_without_cookies(self):
        scope = {"type": "websocket", "path": "/ws/client", "headers": [
            (b"host", b"localhost:3100"), (b"origin", b"null"),
            (b"cookie", b"vmux_token=full"), (b"sec-websocket-protocol", b"vmux-token.abc"),
        ]}
        seen, sent = self._run_capture(scope)
        self.assertEqual(sent, [])
        names = [k for k, _ in seen[0]["headers"]]
        self.assertNotIn(b"cookie", names)
        self.assertIn(b"sec-websocket-protocol", names)

    def test_foreign_origin_with_bearer_passes(self):
        scope = {"type": "http", "path": "/api/sessions", "headers": [
            (b"host", b"localhost:3100"), (b"origin", b"glass-app://calcifer"), (b"authorization", b"Bearer abc"),
        ]}
        seen, _ = self._run_capture(scope)
        self.assertEqual(len(seen), 1)

    def test_foreign_origin_with_only_a_cookie_is_rejected(self):
        scope = {"type": "websocket", "path": "/ws/client", "headers": [
            (b"host", b"localhost:3100"), (b"origin", b"null"), (b"cookie", b"vmux_token=full"),
        ]}
        seen, sent = self._run_capture(scope)
        self.assertEqual(seen, [])
        self.assertEqual(sent[-1]["code"], 4003)
