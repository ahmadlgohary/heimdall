from datetime import UTC, datetime

import pytest

from app.utils.retry import backoff_delay, decide_retry, is_retryable, parse_retry_after


def test_backoff_schedule_matches_spec():
    # delay = min(30 * 4^(attempt-2), 1800)
    assert backoff_delay(1) == 0
    assert backoff_delay(2) == 30
    assert backoff_delay(3) == 120
    assert backoff_delay(4) == 480  # min(30 * 4^2, 1800)
    assert backoff_delay(5) == 1800
    assert backoff_delay(9) == 1800  # capped


def test_first_failure_schedules_retry_after_30s():
    d = decide_retry(1, 500, max_attempts=5)
    assert d.retry and d.delay_seconds == 30


def test_maximum_attempts_is_respected():
    assert not decide_retry(5, 500, max_attempts=5).retry
    assert decide_retry(4, 500, max_attempts=5).retry


@pytest.mark.parametrize("status", [500, 502, 503, 504, 408, 425, 429, None])
def test_retryable_statuses(status):
    assert is_retryable(status)
    assert decide_retry(1, status, max_attempts=5).retry


@pytest.mark.parametrize("status", [400, 401, 403, 404, 410, 422, 301])
def test_client_errors_are_not_retried(status):
    assert not decide_retry(1, status, max_attempts=5).retry


def test_success_terminates_retries():
    assert not decide_retry(1, 200, max_attempts=5).retry
    assert not decide_retry(3, 204, max_attempts=5).retry


def test_429_respects_retry_after():
    assert decide_retry(1, 429, max_attempts=5, retry_after=90).delay_seconds == 90
    # never shorter than our own backoff, never above the ceiling
    assert decide_retry(1, 429, max_attempts=5, retry_after=5).delay_seconds == 30
    assert decide_retry(1, 429, max_attempts=5, retry_after=99999).delay_seconds == 1800
    # Retry-After only applies to 429
    assert decide_retry(1, 503, max_attempts=5, retry_after=900).delay_seconds == 30


def test_parse_retry_after_forms():
    now = datetime(2026, 11, 10, 12, 0, 0, tzinfo=UTC)
    assert parse_retry_after("120") == 120
    assert parse_retry_after("Tue, 10 Nov 2026 12:01:30 GMT", now=now) == 90
    assert parse_retry_after("garbage") is None
    assert parse_retry_after(None) is None
