"""Keep credentials out of the relay's logs.

uvicorn logs full request paths, and the LiveKit client puts its JWT in the
WebSocket URL (`/livekit/rtc?access_token=…`), so the access log would hold
live room tokens.  This filter masks token-like query parameters.
"""

import logging
import re

_SECRET_PARAM = re.compile(r"((?:access_token|token)=)[^&\s\"']+", re.IGNORECASE)


def redact(text: str) -> str:
    return _SECRET_PARAM.sub(r"\1[redacted]", text)


class RedactSecretsFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:
            return True
        if "token=" in msg.lower():
            record.msg = redact(msg)
            record.args = ()
        return True


def install(logger_names=("uvicorn.access", "uvicorn.error", "uvicorn")) -> None:
    """Attach the filter to uvicorn's loggers and their handlers (idempotent)."""
    for name in logger_names:
        logger = logging.getLogger(name)
        for target in [logger, *logger.handlers]:
            if not any(isinstance(f, RedactSecretsFilter) for f in target.filters):
                target.addFilter(RedactSecretsFilter())
