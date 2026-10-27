import uuid
from collections.abc import AsyncIterator
from typing import Any

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import Settings


def engine_options(settings: Settings) -> dict[str, Any]:
    options: dict[str, Any] = {"pool_pre_ping": True, "pool_recycle": 300}
    if settings.uses_connection_pooler:
        # PgBouncer in transaction mode (Neon's pooled endpoint) can't keep server-side
        # prepared statements across transactions: disable asyncpg's statement cache and
        # give each statement a unique name so connections never collide.
        options["connect_args"] = {
            "statement_cache_size": 0,
            "prepared_statement_name_func": lambda: f"__asyncpg_{uuid.uuid4()}__",
        }
    return options


def create_engine(settings: Settings) -> AsyncEngine:
    return create_async_engine(
        settings.database_url,
        pool_size=settings.database_pool_size,
        max_overflow=settings.database_pool_size,
        **engine_options(settings),
    )


def create_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False, autoflush=False)


async def session_scope(factory: async_sessionmaker[AsyncSession]) -> AsyncIterator[AsyncSession]:
    async with factory() as session:
        yield session
