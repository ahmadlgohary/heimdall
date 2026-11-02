"""RabbitMQ topology.

  heimdall.deliveries (direct)
    ├─ "deliver"     → heimdall.deliveries              (worker consumes)
    └─ "delay.{n}s"  → heimdall.deliveries.delay.{n}s   (TTL n s, then dead-letters back to "deliver";
                                                         n in 5, 30, 120, 480, 1800)
  heimdall.dead-letter (direct)
    └─ "dead"        → heimdall.deliveries.dead         (poison / unprocessable messages, for inspection)

Retries wait in TTL queues instead of `sleep()`, so workers never block (plan §3.6).
Fixed-TTL tiers avoid the head-of-line blocking of per-message TTLs.
"""

import aio_pika
from aio_pika.abc import AbstractChannel, AbstractExchange, AbstractQueue

EXCHANGE = "heimdall.deliveries"
DEAD_LETTER_EXCHANGE = "heimdall.dead-letter"
DELIVERY_QUEUE = "heimdall.deliveries"
DEAD_LETTER_QUEUE = "heimdall.deliveries.dead"
DELIVER_KEY = "deliver"
DEAD_KEY = "dead"
# Matches the backoff schedule (30 s, 2 min, 8 min, 30 min) so normal retries take one hop.
DELAY_TIERS = (5, 30, 120, 480, 1800)


def delay_queue(seconds: int) -> str:
    return f"{DELIVERY_QUEUE}.delay.{seconds}s"


def delay_key(seconds: int) -> str:
    return f"delay.{seconds}s"


def routing_key_for_delay(seconds: float) -> str:
    """Largest tier that doesn't overshoot by more than a small tolerance.

    The tolerance absorbs the time between scheduling and publishing (a 30 s retry
    published 300 ms later still goes to the 30 s tier). A job that arrives early
    is re-delayed by the worker; one that arrives a little late is fine.
    """
    if seconds < 1:
        return DELIVER_KEY
    allowance = seconds + max(2.0, seconds * 0.05)
    fitting = [t for t in DELAY_TIERS if t <= allowance]
    return delay_key(fitting[-1] if fitting else DELAY_TIERS[0])


async def declare_topology(channel: AbstractChannel) -> tuple[AbstractExchange, AbstractQueue]:
    exchange = await channel.declare_exchange(EXCHANGE, aio_pika.ExchangeType.DIRECT, durable=True)
    dlx = await channel.declare_exchange(DEAD_LETTER_EXCHANGE, aio_pika.ExchangeType.DIRECT, durable=True)

    dead = await channel.declare_queue(DEAD_LETTER_QUEUE, durable=True)
    await dead.bind(dlx, DEAD_KEY)

    queue = await channel.declare_queue(
        DELIVERY_QUEUE,
        durable=True,
        arguments={"x-dead-letter-exchange": DEAD_LETTER_EXCHANGE, "x-dead-letter-routing-key": DEAD_KEY},
    )
    await queue.bind(exchange, DELIVER_KEY)

    for seconds in DELAY_TIERS:
        q = await channel.declare_queue(
            delay_queue(seconds),
            durable=True,
            arguments={
                "x-message-ttl": seconds * 1000,
                "x-dead-letter-exchange": EXCHANGE,
                "x-dead-letter-routing-key": DELIVER_KEY,
            },
        )
        await q.bind(exchange, delay_key(seconds))
    return exchange, queue
