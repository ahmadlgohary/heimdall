"""Retry policy (plan §3.6): exponential backoff, max 5 attempts.

delay(attempt) = min(30 * 4^(attempt - 2), 1800) seconds, where `attempt` is the
number of the attempt being scheduled (2..5).
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime

BASE_DELAY_SECONDS = 30
MAX_DELAY_SECONDS = 1800
RETRYABLE_STATUSES = frozenset({408, 425, 429})


def backoff_delay(next_attempt: int) -> int:
    if next_attempt <= 1:
        return 0
    return min(BASE_DELAY_SECONDS * 4 ** (next_attempt - 2), MAX_DELAY_SECONDS)


def is_retryable(http_status: int | None) -> bool:
    """None means no HTTP response at all (timeout, connection error): retryable."""
    if http_status is None:
        return True
    return http_status in RETRYABLE_STATUSES or http_status >= 500


def is_success(http_status: int | None) -> bool:
    return http_status is not None and 200 <= http_status < 300


def parse_retry_after(value: str | None, *, now: datetime | None = None) -> int | None:
    """Seconds from a Retry-After header (delta-seconds or HTTP-date)."""
    if not value:
        return None
    value = value.strip()
    if value.isdigit():
        return int(value)
    try:
        when = parsedate_to_datetime(value)
    except TypeError, ValueError:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return max(0, int((when - (now or datetime.now(UTC))).total_seconds()))


@dataclass(frozen=True)
class RetryDecision:
    retry: bool
    delay_seconds: int = 0


def decide_retry(
    attempt_number: int,
    http_status: int | None,
    *,
    max_attempts: int,
    retry_after: int | None = None,
) -> RetryDecision:
    """What to do after `attempt_number` finished with `http_status` (None = no response)."""
    if is_success(http_status) or not is_retryable(http_status) or attempt_number >= max_attempts:
        return RetryDecision(retry=False)
    delay = backoff_delay(attempt_number + 1)
    if http_status == 429 and retry_after is not None:
        # wait at least as long as the receiver asked, within our ceiling
        delay = min(max(delay, retry_after), MAX_DELAY_SECONDS)
    return RetryDecision(retry=True, delay_seconds=delay)
