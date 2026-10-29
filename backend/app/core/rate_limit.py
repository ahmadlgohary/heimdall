"""In-process sliding-window rate limiter.

Per-process by design for the MVP: limits apply per API replica. Swap for a
Redis-backed limiter when the API scales horizontally.
"""

import time
from collections import defaultdict, deque

from app.core.exceptions import RateLimited


class SlidingWindowLimiter:
    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def check(self, key: str, limit: int, window_seconds: float = 60.0) -> None:
        now = time.monotonic()
        hits = self._hits[key]
        while hits and hits[0] <= now - window_seconds:
            hits.popleft()
        if len(hits) >= limit:
            retry_after = max(1, int(hits[0] + window_seconds - now) + 1)
            raise RateLimited(
                "Too many requests. Try again shortly.",
                details={"retry_after": retry_after},
                headers={"Retry-After": str(retry_after)},
            )
        hits.append(now)
        if len(self._hits) > 50_000:  # bound memory under key churn
            self._hits = defaultdict(
                deque, {k: v for k, v in self._hits.items() if v and v[-1] > now - window_seconds}
            )

    def reset(self) -> None:
        self._hits.clear()


limiter = SlidingWindowLimiter()
