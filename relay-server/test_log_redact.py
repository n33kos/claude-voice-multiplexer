"""Unit tests for log redaction.  Run with: python3 -m pytest relay-server/test_log_redact.py"""

import logging
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

import log_redact  # noqa: E402


class RedactTests(unittest.TestCase):
    def test_masks_token_params(self):
        line = '127.0.0.1:1 - "WebSocket /livekit/rtc/v1?access_token=eyJhbGc.abc.def&join_request=x" [accepted]'
        out = log_redact.redact(line)
        self.assertNotIn("eyJhbGc", out)
        self.assertIn("access_token=[redacted]&join_request=x", out)
        self.assertEqual(log_redact.redact("/api/token?room=vmux_x"), "/api/token?room=vmux_x")
        self.assertIn("token=[redacted]", log_redact.redact("GET /x?token=abc HTTP/1.1"))

    def test_filter_rewrites_formatted_records(self):
        logger = logging.getLogger("test.redact")
        records = []

        class Capture(logging.Handler):
            def emit(self, record):
                records.append(record.getMessage())

        logger.addHandler(Capture())
        logger.setLevel(logging.INFO)
        logger.propagate = False
        log_redact.install(("test.redact",))
        log_redact.install(("test.redact",))  # idempotent
        logger.info('%s - "%s %s" %s', "127.0.0.1", "WebSocket", "/livekit/rtc?access_token=SECRET", "[accepted]")
        self.assertEqual(records, ['127.0.0.1 - "WebSocket /livekit/rtc?access_token=[redacted]" [accepted]'])
        self.assertEqual(sum(isinstance(f, log_redact.RedactSecretsFilter) for f in logger.filters), 1)


if __name__ == "__main__":
    unittest.main()
