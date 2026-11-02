from datetime import UTC, datetime, timedelta

from app.messaging.messages import DeliveryJob
from app.messaging.topology import DELIVER_KEY, routing_key_for_delay


def test_routing_picks_largest_tier_not_exceeding_delay():
    assert routing_key_for_delay(0) == DELIVER_KEY
    assert routing_key_for_delay(0.5) == DELIVER_KEY
    assert routing_key_for_delay(3) == "delay.5s"
    assert routing_key_for_delay(30) == "delay.30s"
    assert routing_key_for_delay(29.6) == "delay.30s"  # scheduling-to-publish lag
    assert routing_key_for_delay(100) == "delay.30s"
    assert routing_key_for_delay(119.4) == "delay.120s"
    assert routing_key_for_delay(479) == "delay.480s"  # every backoff step is one hop
    assert routing_key_for_delay(1799) == "delay.1800s"
    assert routing_key_for_delay(5000) == "delay.1800s"


def test_job_roundtrip():
    job = DeliveryJob(
        delivery_id="2b1f8f4e-1d1a-4a51-9c39-0b5f3c0d2f11",
        attempt_number=2,
        not_before=datetime.now(UTC) + timedelta(seconds=30),
    )
    assert DeliveryJob.decode(job.encode()) == job
