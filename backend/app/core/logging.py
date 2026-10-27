"""Structured JSON logging with secret redaction (plan §13)."""

import json
import logging
import sys
from datetime import UTC, datetime
from typing import Any

REDACTED = "[redacted]"
SENSITIVE_KEYS = ("password", "token", "secret", "authorization", "api_key", "cookie", "signature")
_STANDARD = set(logging.LogRecord("", 0, "", 0, "", None, None).__dict__) | {"message", "asctime", "taskName"}


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            k: REDACTED if any(s in str(k).lower() for s in SENSITIVE_KEYS) else redact(v)
            for k, v in value.items()
        }
    if isinstance(value, list | tuple):
        return [redact(v) for v in value]
    return value


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
        }
        extra = {k: v for k, v in record.__dict__.items() if k not in _STANDARD}
        payload.update(redact(extra))
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


class PlainFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        base = super().format(record)
        extra = {k: v for k, v in record.__dict__.items() if k not in _STANDARD}
        return f"{base} {json.dumps(redact(extra), default=str)}" if extra else base


def configure_logging(level: str = "INFO", json_logs: bool = True) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        JsonFormatter() if json_logs else PlainFormatter("%(asctime)s %(levelname)-5s %(name)s: %(message)s")
    )
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    for noisy in ("aiormq", "aio_pika", "httpx", "httpcore", "botocore", "boto3", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    # uvicorn's access log echoes query strings; keep it but at warning by default in JSON mode
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING if json_logs else logging.INFO)
