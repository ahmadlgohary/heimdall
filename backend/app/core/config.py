"""Application settings, loaded from environment variables (and `.env` in development)."""

import base64
import hashlib
from functools import lru_cache
from typing import Literal
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

INSECURE_DEFAULT = "change-me-in-production"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        # Later files win: backend/.env overrides the repo-root .env (used by docker compose).
        env_file=("../.env", ".env"),
        env_file_encoding="utf-8",
        # A blank `DATABASE_URL=` (e.g. a production-only placeholder) must not wipe out a value.
        env_ignore_empty=True,
        extra="ignore",
        case_sensitive=False,
    )

    app_env: Literal["development", "test", "production"] = "development"
    app_name: str = "Heimdall"
    log_level: str = "INFO"
    json_logs: bool = True

    database_url: str = "postgresql+asyncpg://heimdall:heimdall@localhost:5432/heimdall"
    database_pool_size: int = 10
    # Optional direct (non-pooled) URL for Alembic. Neon recommends running migrations
    # against the direct host rather than the "-pooler" one. Falls back to DATABASE_URL.
    rabbitmq_url: str = "amqp://guest:guest@localhost:5672/"

    jwt_secret: str = INSECURE_DEFAULT
    jwt_algorithm: Literal["HS256", "HS384", "HS512"] = "HS256"
    jwt_access_token_expire_minutes: int = 15
    refresh_token_expire_days: int = 14

    # Fernet key used to encrypt endpoint signing secrets at rest.
    encryption_key: str = ""

    # Event payload storage: "s3" in production; "local" (disk) or "memory" for dev/tests.
    storage_backend: Literal["s3", "local", "memory"] = "local"
    local_storage_path: str = ".storage"

    # S3 or any S3-compatible store (e.g. Neon object storage). The variable names are the
    # standard AWS SDK ones that Neon provides: AWS_ENDPOINT_URL_S3, AWS_ACCESS_KEY_ID,
    # AWS_SECRET_ACCESS_KEY, AWS_REGION.
    s3_bucket_name: str = ""
    aws_endpoint_url_s3: str = ""  # empty = Amazon S3 itself
    aws_access_key_id: str = ""  # leave both keys empty to use the AWS default credential chain
    aws_secret_access_key: str = ""
    aws_region: str = "us-east-1"
    # Optional tuning:
    s3_force_path_style: bool = False
    # AES256 | aws:kms | "" (none). Unset: AES256 on Amazon S3, omitted on custom endpoints,
    # since many S3-compatible services reject the encryption header.
    s3_server_side_encryption: Literal["AES256", "aws:kms", ""] | None = None
    s3_kms_key_id: str = ""

    # PgBouncer-style poolers (e.g. Neon's "-pooler" hosts) can't keep prepared statements.
    # None = detect from the host name.
    database_uses_pooler: bool | None = None

    # Shared secret between the Cloudflare Worker and /internal/ingest. Unset disables the route.
    worker_shared_secret: str = ""

    frontend_url: str = "http://localhost:5173"
    api_url: str = "http://localhost:8000"

    cookie_secure: bool | None = None  # defaults to True in production
    cookie_samesite: Literal["lax", "strict", "none"] = "lax"

    # Delivery
    max_payload_bytes: int = 256 * 1024
    max_attempts: int = Field(default=5, ge=1, le=10)
    delivery_connect_timeout: float = 5.0
    delivery_timeout: float = 10.0
    max_response_body_bytes: int = 16 * 1024
    worker_concurrency: int = 16
    # Allow private/loopback destinations. Development only — refused in production.
    allow_private_destinations: bool = False

    # Run the outbox publisher and retry sweeper inside the API process (single-container MVP).
    run_publisher_in_api: bool = False
    outbox_poll_interval: float = 0.5

    # Demo environment (plan §14.3). The demo credentials are public by design: they're shown
    # on the sign-in page. `python -m app.scripts.seed` creates and resets the account.
    demo_enabled: bool = False
    demo_email: str = "demo@heimdall.dev"
    demo_password: str = "DemoPassword123"  # noqa: S105 (public by design)
    # Serve the built-in test receiver at /demo-receiver so demo endpoints have a public,
    # always-on destination. DEMO_RECEIVER_URL is how the *worker* reaches it
    # (defaults to API_URL + /demo-receiver; in docker compose, the internal service URL).
    demo_receiver_enabled: bool = False
    demo_receiver_url: str = ""

    # Login/register/password: slows down guessing.
    auth_rate_limit_per_minute: int = 20
    # Session refresh runs on every page load and its token can't be guessed, so it gets
    # its own, looser budget: users behind one NAT IP shouldn't be signed out by reloads.
    refresh_rate_limit_per_minute: int = 120
    ingest_rate_limit_per_minute: int = 600

    @field_validator("database_url")
    @classmethod
    def _async_driver(cls, v: str) -> str:
        return normalize_database_url(v) if v else v

    @model_validator(mode="after")
    def _production_guards(self) -> Settings:
        if self.app_env == "production":
            if self.jwt_secret == INSECURE_DEFAULT or len(self.jwt_secret) < 32:
                raise ValueError("JWT_SECRET must be set to a random value of at least 32 characters")
            if not self.encryption_key:
                raise ValueError("ENCRYPTION_KEY must be set in production")
            if self.allow_private_destinations:
                raise ValueError("ALLOW_PRIVATE_DESTINATIONS cannot be enabled in production")
            if self.storage_backend == "memory":
                raise ValueError("STORAGE_BACKEND=memory loses payloads on restart; use s3 in production")
        if self.storage_backend == "s3" and not self.s3_bucket_name:
            raise ValueError("S3_BUCKET_NAME must be set when STORAGE_BACKEND=s3")
        if bool(self.aws_access_key_id) != bool(self.aws_secret_access_key):
            raise ValueError("Set both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or neither")
        return self

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @property
    def demo_receiver_base(self) -> str:
        return (self.demo_receiver_url or f"{self.api_url.rstrip('/')}/demo-receiver").rstrip("/")

    def is_demo_email(self, email: str) -> bool:
        return self.demo_enabled and email.lower() == self.demo_email.lower()

    @property
    def s3_encryption(self) -> str:
        if self.s3_server_side_encryption is not None:
            return self.s3_server_side_encryption
        return "" if self.aws_endpoint_url_s3 else "AES256"

    @property
    def uses_connection_pooler(self) -> bool:
        if self.database_uses_pooler is not None:
            return self.database_uses_pooler
        return "-pooler." in (urlsplit(self.database_url).hostname or "")

    @property
    def secure_cookies(self) -> bool:
        return self.is_production if self.cookie_secure is None else self.cookie_secure

    @property
    def require_https_destinations(self) -> bool:
        return self.is_production

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip().rstrip("/") for o in self.frontend_url.split(",") if o.strip()]

    @property
    def fernet_key(self) -> bytes:
        if self.encryption_key:
            return self.encryption_key.encode()
        # Development convenience: derive a stable key from the JWT secret.
        return base64.urlsafe_b64encode(hashlib.sha256(self.jwt_secret.encode()).digest())


# libpq options asyncpg doesn't understand. sslmode is translated to asyncpg's `ssl`;
# channel_binding (sent by Neon) is negotiated automatically by asyncpg's SCRAM auth.
_LIBPQ_ONLY = {"sslmode", "channel_binding", "sslrootcert", "sslcert", "sslkey", "target_session_attrs"}


def normalize_database_url(url: str) -> str:
    """Accept the URLs hosting providers hand out (postgres://, Neon's ?sslmode=require)
    and turn them into something SQLAlchemy + asyncpg can use."""
    if url.startswith("postgres://"):
        url = "postgresql://" + url.removeprefix("postgres://")
    if url.startswith("postgresql://"):
        url = "postgresql+asyncpg://" + url.removeprefix("postgresql://")
    if not url.startswith("postgresql+asyncpg://"):
        return url
    parts = urlsplit(url)
    params = parse_qsl(parts.query, keep_blank_values=True)
    sslmode = next((v for k, v in params if k == "sslmode"), None)
    kept = [(k, v) for k, v in params if k not in _LIBPQ_ONLY]
    if sslmode and sslmode != "disable" and not any(k == "ssl" for k, _ in kept):
        kept.append(("ssl", sslmode))  # asyncpg accepts require / verify-ca / verify-full / prefer
    return urlunsplit(parts._replace(query=urlencode(kept)))


@lru_cache
def get_settings() -> Settings:
    return Settings()
