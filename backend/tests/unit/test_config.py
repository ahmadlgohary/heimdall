import pytest

from app.core.config import Settings, normalize_database_url
from app.db.session import engine_options

NEON = (
    "postgresql://app:secret@ep-cool-river-a1b2c3d4-pooler.eu-central-1.aws.neon.tech/heimdall"
    "?sslmode=require&channel_binding=require"
)


def test_neon_url_is_made_asyncpg_compatible():
    url = normalize_database_url(NEON)
    assert url.startswith("postgresql+asyncpg://app:secret@ep-cool-river")
    assert url.endswith("/heimdall?ssl=require")
    assert "sslmode" not in url and "channel_binding" not in url


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("postgres://u:p@h/db", "postgresql+asyncpg://u:p@h/db"),
        ("postgresql://u:p@h/db?sslmode=disable", "postgresql+asyncpg://u:p@h/db"),
        (
            "postgresql+asyncpg://u:p@h/db?ssl=verify-full&sslmode=require",
            "postgresql+asyncpg://u:p@h/db?ssl=verify-full",
        ),
        ("postgresql+asyncpg://u:p@h:5433/db", "postgresql+asyncpg://u:p@h:5433/db"),
    ],
)
def test_database_url_normalisation(raw, expected):
    assert normalize_database_url(raw) == expected


def test_pooler_hosts_disable_prepared_statement_cache():
    pooled = Settings(database_url=NEON)
    assert pooled.uses_connection_pooler
    args = engine_options(pooled)["connect_args"]
    assert args["statement_cache_size"] == 0
    assert args["prepared_statement_name_func"]() != args["prepared_statement_name_func"]()

    direct = Settings(database_url=NEON.replace("-pooler", ""))
    assert not direct.uses_connection_pooler and "connect_args" not in engine_options(direct)
    assert Settings(database_url=NEON, database_uses_pooler=False).uses_connection_pooler is False


def test_s3_settings_validation():
    with pytest.raises(ValueError, match="S3_BUCKET_NAME"):
        Settings(storage_backend="s3")
    with pytest.raises(ValueError, match="AWS_ACCESS_KEY_ID"):
        Settings(storage_backend="s3", s3_bucket_name="b", aws_access_key_id="only-one")
    assert Settings(storage_backend="s3", s3_bucket_name="b").aws_access_key_id == ""  # default chain


def test_reads_neon_object_storage_variables(monkeypatch):
    from app.services.storage_service import S3Storage

    monkeypatch.setenv("STORAGE_BACKEND", "s3")
    monkeypatch.setenv("S3_BUCKET_NAME", "heimdall-payloads")
    monkeypatch.setenv("AWS_ENDPOINT_URL_S3", "https://storage.example-neon-endpoint.com")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "neon-key")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "neon-secret")
    monkeypatch.setenv("AWS_REGION", "us-east-2")
    s = Settings()
    assert s.aws_endpoint_url_s3 == "https://storage.example-neon-endpoint.com"
    assert (s.aws_access_key_id, s.aws_secret_access_key, s.aws_region) == (
        "neon-key",
        "neon-secret",
        "us-east-2",
    )

    store = S3Storage(s)
    assert store.client.meta.endpoint_url == "https://storage.example-neon-endpoint.com"
    assert store.client.meta.region_name == "us-east-2"
    # custom endpoint: no encryption header unless asked for
    assert store.put_extra == {}


def test_encryption_defaults():
    assert Settings().s3_encryption == "AES256"  # Amazon S3
    assert Settings(aws_endpoint_url_s3="https://s3.example.com").s3_encryption == ""
    forced = Settings(aws_endpoint_url_s3="https://s3.example.com", s3_server_side_encryption="AES256")
    assert forced.s3_encryption == "AES256"


def test_production_rejects_memory_storage():
    with pytest.raises(ValueError, match="memory"):
        Settings(app_env="production", jwt_secret="k" * 40, encryption_key="x", storage_backend="memory")
