"""Shared fixtures.

Integration tests use a real PostgreSQL (TEST_DATABASE_URL) and, for broker
tests, a real RabbitMQ (TEST_RABBITMQ_URL). They are skipped if unreachable.
External HTTP destinations are always mocked.
"""

import asyncio
import ipaddress
import os
import socket
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from urllib.parse import urlsplit

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+asyncpg://heimdall:heimdall@127.0.0.1:5432/heimdall_test"
)
TEST_RABBITMQ_URL = os.environ.get("TEST_RABBITMQ_URL", "amqp://guest:guest@127.0.0.1:5672/")

# Tests must not depend on the developer's environment: neither a local .env nor variables
# already set in the shell or container (e.g. ENCRYPTION_KEY from docker compose).
from app.core import config as _config  # noqa: E402

for _field in _config.Settings.model_fields:
    os.environ.pop(_field.upper(), None)
_config.Settings.model_config["env_file"] = None

os.environ.update(
    {
        "APP_ENV": "test",
        "DATABASE_URL": TEST_DATABASE_URL,
        "RABBITMQ_URL": TEST_RABBITMQ_URL,
        "STORAGE_BACKEND": "memory",
        "JWT_SECRET": "test-secret-that-is-long-enough-for-hs256-0123456789",
        "COOKIE_SECURE": "false",
        "JSON_LOGS": "false",
        "LOG_LEVEL": "WARNING",
        "WORKER_SHARED_SECRET": "test-worker-secret",
        "ALLOW_PRIVATE_DESTINATIONS": "false",
        "FRONTEND_URL": "http://localhost:5173",
    }
)

_config.get_settings.cache_clear()

import httpx  # noqa: E402
import pytest  # noqa: E402
from alembic.config import Config  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: E402

from alembic import command  # noqa: E402
from app.core.config import Settings  # noqa: E402
from app.core.rate_limit import limiter  # noqa: E402
from app.db.session import create_session_factory  # noqa: E402
from app.main import create_app  # noqa: E402
from app.services.storage_service import MemoryStorage  # noqa: E402
from app.utils import validators  # noqa: E402

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TABLES = [
    "outbox_messages",
    "delivery_attempts",
    "deliveries",
    "events",
    "api_keys",
    "endpoints",
    "refresh_tokens",
    "worker_heartbeats",
    "users",
]


def _reachable(url: str, default_port: int) -> bool:
    parts = urlsplit(url.replace("+asyncpg", ""))
    try:
        with socket.create_connection((parts.hostname or "localhost", parts.port or default_port), timeout=1):
            return True
    except OSError:
        return False


DB_AVAILABLE = _reachable(TEST_DATABASE_URL, 5432)
BROKER_AVAILABLE = _reachable(TEST_RABBITMQ_URL, 5672)


def pytest_sessionstart(session):
    # In CI and `make test`, a missing service is a failure, not a reason to skip.
    if os.environ.get("CI_REQUIRE_SERVICES"):
        missing = [
            name for name, ok in (("PostgreSQL", DB_AVAILABLE), ("RabbitMQ", BROKER_AVAILABLE)) if not ok
        ]
        if missing:
            raise pytest.UsageError(f"CI_REQUIRE_SERVICES is set but {', '.join(missing)} is unreachable")


def pytest_collection_modifyitems(config, items):
    skip_db = pytest.mark.skip(reason=f"PostgreSQL not reachable at {TEST_DATABASE_URL}")
    skip_mq = pytest.mark.skip(reason=f"RabbitMQ not reachable at {TEST_RABBITMQ_URL}")
    for item in items:
        if "integration" in item.nodeid:
            item.add_marker(pytest.mark.integration)
            if not DB_AVAILABLE:
                item.add_marker(skip_db)
            elif "rabbitmq" in item.nodeid and not BROKER_AVAILABLE:
                item.add_marker(skip_mq)


# ---------- settings & DNS ----------


@pytest.fixture(scope="session")
def settings() -> Settings:
    return Settings()


# Test hosts: *.internal-dns.test resolves to a private IP (DNS-rebinding style),
# everything else to a public documentation-range-free address.
PUBLIC_IP = ipaddress.ip_address("93.184.216.34")
PRIVATE_IP = ipaddress.ip_address("10.0.0.5")


async def fake_resolver(host: str, port: int):
    if host.endswith("internal-dns.test"):
        return [PRIVATE_IP]
    if host.endswith("nxdomain.test"):
        raise socket.gaierror("Name or service not known")
    return [PUBLIC_IP]


@pytest.fixture(autouse=True)
def _fake_dns():
    validators.set_resolver(fake_resolver)
    yield
    validators.set_resolver(None)


@pytest.fixture(autouse=True)
def _reset_rate_limits():
    limiter.reset()
    yield
    limiter.reset()


# ---------- database ----------


def _upgrade(url: str) -> None:
    cfg = Config(os.path.join(BACKEND_DIR, "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(BACKEND_DIR, "alembic"))
    cfg.attributes["database_url"] = url
    cfg.attributes["skip_logging"] = True
    command.upgrade(cfg, "head")


@pytest.fixture(scope="session")
async def engine():
    if not DB_AVAILABLE:
        pytest.skip("PostgreSQL not reachable")
    eng = create_async_engine(TEST_DATABASE_URL)
    async with eng.begin() as conn:
        await conn.execute(text("DROP SCHEMA public CASCADE"))
        await conn.execute(text("CREATE SCHEMA public"))
    # run the real migrations (also proves they work); alembic runs its own event loop
    await asyncio.to_thread(_upgrade, TEST_DATABASE_URL)
    yield eng
    await eng.dispose()


@pytest.fixture(scope="session")
def session_factory(engine) -> async_sessionmaker[AsyncSession]:
    return create_session_factory(engine)


@pytest.fixture
async def db(engine, session_factory) -> AsyncIterator[AsyncSession]:
    async with engine.begin() as conn:
        await conn.execute(text(f"TRUNCATE {', '.join(TABLES)} RESTART IDENTITY CASCADE"))
    async with session_factory() as session:
        yield session


# ---------- app & client ----------


@pytest.fixture
def storage() -> MemoryStorage:
    return MemoryStorage()


@pytest.fixture
def app_factory(settings, session_factory, storage, db) -> Callable:
    def make(**overrides):
        s = settings.model_copy(update=overrides) if overrides else settings
        app = create_app(s, storage=storage)
        # ASGITransport doesn't run lifespan; share the test engine instead
        app.state.session_factory = session_factory
        return app

    return make


@pytest.fixture
async def client(app_factory) -> AsyncIterator[httpx.AsyncClient]:
    app = app_factory()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        yield c


# ---------- helpers ----------

PASSWORD = "CorrectHorse42Battery"


@dataclass
class Account:
    id: str
    email: str
    headers: dict[str, str]


async def register(client: httpx.AsyncClient, email: str = "dev@example.com") -> Account:
    res = await client.post("/api/v1/auth/register", json={"email": email, "password": PASSWORD})
    assert res.status_code == 201, res.text
    body = res.json()
    return Account(body["user"]["id"], email, {"Authorization": f"Bearer {body['access_token']}"})


async def create_endpoint(
    client: httpx.AsyncClient, account: Account, url: str = "https://hooks.example.com/orders", **extra
) -> dict:
    res = await client.post(
        "/api/v1/endpoints", json={"name": "Orders", "url": url, **extra}, headers=account.headers
    )
    assert res.status_code == 201, res.text
    return res.json()


async def create_api_key(client: httpx.AsyncClient, account: Account) -> str:
    res = await client.post("/api/v1/api-keys", json={"name": "test"}, headers=account.headers)
    assert res.status_code == 201, res.text
    return res.json()["key"]


async def ingest(
    client: httpx.AsyncClient,
    endpoint_id: str,
    key: str,
    body: dict | None = None,
    *,
    idempotency_key: str | None = None,
) -> httpx.Response:
    headers = {"Authorization": f"Bearer {key}"}
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    return await client.post(
        f"/api/v1/ingest/{endpoint_id}",
        json=body or {"event_type": "order.created", "data": {"order_id": "ORD-1001", "amount": 129.99}},
        headers=headers,
    )


@dataclass
class Setup:
    account: Account
    endpoint: dict
    key: str


@pytest.fixture
async def ready(client) -> Setup:
    """A registered user with one endpoint and an API key."""
    account = await register(client)
    endpoint = await create_endpoint(client, account)
    key = await create_api_key(client, account)
    return Setup(account, endpoint, key)
