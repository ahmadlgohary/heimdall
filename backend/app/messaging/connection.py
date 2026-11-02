import aio_pika
from aio_pika.abc import AbstractRobustChannel, AbstractRobustConnection


async def connect(url: str) -> AbstractRobustConnection:
    return await aio_pika.connect_robust(url, client_properties={"connection_name": "heimdall"})


async def open_channel(
    connection: AbstractRobustConnection, *, prefetch: int | None = None
) -> AbstractRobustChannel:
    # publisher confirms are on by default; unroutable messages raise instead of vanishing
    channel = await connection.channel(publisher_confirms=True, on_return_raises=True)
    if prefetch:
        await channel.set_qos(prefetch_count=prefetch)
    return channel  # type: ignore[return-value]
