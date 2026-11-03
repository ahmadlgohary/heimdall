import os
import socket
from datetime import UTC, datetime

from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.models import WorkerHeartbeat


def worker_id(kind: str) -> str:
    return f"{kind}@{socket.gethostname()}:{os.getpid()}"


async def beat(factory: async_sessionmaker[AsyncSession], wid: str, kind: str) -> None:
    async with factory() as session:
        now = datetime.now(UTC)
        stmt = insert(WorkerHeartbeat).values(worker_id=wid, kind=kind, last_seen_at=now)
        await session.execute(
            stmt.on_conflict_do_update(index_elements=["worker_id"], set_={"last_seen_at": now})
        )
        await session.commit()
