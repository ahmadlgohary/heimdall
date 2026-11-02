from datetime import UTC, datetime

import aio_pika
from aio_pika.abc import AbstractExchange

from app.messaging.messages import DeliveryJob
from app.messaging.topology import routing_key_for_delay


class JobPublisher:
    """Publishes delivery jobs as persistent messages and waits for broker confirmation."""

    def __init__(self, exchange: AbstractExchange) -> None:
        self.exchange = exchange

    async def publish(self, job: DeliveryJob, *, now: datetime | None = None) -> str:
        now = now or datetime.now(UTC)
        delay = (job.not_before - now).total_seconds() if job.not_before else 0
        routing_key = routing_key_for_delay(delay)
        message = aio_pika.Message(
            body=job.encode(),
            content_type="application/json",
            delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
            message_id=f"{job.delivery_id}:{job.attempt_number}",
            timestamp=now,
        )
        await self.exchange.publish(message, routing_key=routing_key, mandatory=True)
        return routing_key
