"""HMAC-SHA256 webhook signatures (plan §3.5).

The signed message is `{timestamp}.{raw_body}` over the exact bytes sent —
never a re-serialised JSON object.
"""

import hashlib
import hmac
import time

SIGNATURE_VERSION = "v1"
DEFAULT_TOLERANCE_SECONDS = 300


def compute_signature(secret: str, timestamp: int, body: bytes) -> str:
    signed = f"{timestamp}.".encode() + body
    return hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()


def signature_header(secret: str, timestamp: int, body: bytes) -> str:
    return f"{SIGNATURE_VERSION}={compute_signature(secret, timestamp, body)}"


def verify_signature(
    secret: str,
    timestamp: int | str,
    body: bytes,
    header: str,
    *,
    tolerance: int = DEFAULT_TOLERANCE_SECONDS,
    now: float | None = None,
) -> bool:
    """Receiver-side check. Rejects tampered bodies, wrong secrets and stale timestamps."""
    try:
        ts = int(timestamp)
    except TypeError, ValueError:
        return False
    current = time.time() if now is None else now
    if abs(current - ts) > tolerance:
        return False
    expected = compute_signature(secret, ts, body)
    # header may carry several signatures during secret rotation: "v1=abc v1=def"
    for part in header.replace(",", " ").split():
        version, _, value = part.partition("=")
        if version == SIGNATURE_VERSION and hmac.compare_digest(value, expected):
            return True
    return False
