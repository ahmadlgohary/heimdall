import pytest

from app.services.storage_service import LocalStorage, MemoryStorage, StorageError, payload_key


async def test_local_storage_roundtrip(tmp_path):
    store = LocalStorage(str(tmp_path))
    key = "events/u/e/evt.json"
    await store.put(key, b'{"a":1}')
    assert await store.get(key) == b'{"a":1}'
    await store.delete(key)
    with pytest.raises(StorageError):
        await store.get(key)


async def test_local_storage_rejects_path_traversal(tmp_path):
    store = LocalStorage(str(tmp_path / "root"))
    with pytest.raises(ValueError):
        await store.put("../escape.json", b"x")


async def test_memory_storage_outage():
    store = MemoryStorage()
    store.fail = True
    with pytest.raises(StorageError):
        await store.put("k", b"x")


def test_payload_key_layout():
    assert payload_key("u", "e", "v") == "events/u/e/v.json"


# ---------- S3 (botocore Stubber: exercises real request validation, no network) ----------

import io  # noqa: E402

import boto3  # noqa: E402
from botocore.response import StreamingBody  # noqa: E402
from botocore.stub import ANY, Stubber  # noqa: E402

from app.core.config import Settings  # noqa: E402
from app.services.storage_service import S3Storage, build_storage  # noqa: E402


def _s3(**overrides) -> tuple[S3Storage, Stubber]:
    settings = Settings(
        storage_backend="s3", s3_bucket_name="heimdall-payloads", aws_region="eu-central-1", **overrides
    )
    client = boto3.client(
        "s3", region_name="eu-central-1", aws_access_key_id="test", aws_secret_access_key="test"
    )
    return S3Storage(settings, client=client), Stubber(client)


async def test_s3_put_is_private_typed_and_encrypted():
    store, stub = _s3()
    stub.add_response(
        "put_object",
        {},
        {
            "Bucket": "heimdall-payloads",
            "Key": "events/u/e/v.json",
            "Body": b'{"a":1}',
            "ContentType": "application/json",
            "ServerSideEncryption": "AES256",
        },
    )
    with stub:
        await store.put("events/u/e/v.json", b'{"a":1}')
    stub.assert_no_pending_responses()


async def test_s3_kms_and_disabled_encryption():
    store, stub = _s3(s3_server_side_encryption="aws:kms", s3_kms_key_id="alias/heimdall")
    stub.add_response(
        "put_object",
        {},
        {
            "Bucket": ANY,
            "Key": ANY,
            "Body": ANY,
            "ContentType": ANY,
            "ServerSideEncryption": "aws:kms",
            "SSEKMSKeyId": "alias/heimdall",
        },
    )
    with stub:
        await store.put("k", b"x")

    plain, stub = _s3(s3_server_side_encryption="")
    stub.add_response("put_object", {}, {"Bucket": ANY, "Key": ANY, "Body": ANY, "ContentType": ANY})
    with stub:
        await plain.put("k", b"x")


async def test_s3_get_and_delete():
    store, stub = _s3()
    body = StreamingBody(io.BytesIO(b'{"ok":true}'), len(b'{"ok":true}'))
    stub.add_response("get_object", {"Body": body}, {"Bucket": "heimdall-payloads", "Key": "k"})
    stub.add_response("delete_object", {}, {"Bucket": "heimdall-payloads", "Key": "k"})
    with stub:
        assert await store.get("k") == b'{"ok":true}'
        await store.delete("k")


async def test_s3_errors_become_storage_errors():
    store, stub = _s3()
    stub.add_client_error("put_object", service_error_code="AccessDenied", http_status_code=403)
    stub.add_client_error("get_object", service_error_code="NoSuchKey", http_status_code=404)
    stub.add_client_error("delete_object", service_error_code="AccessDenied", http_status_code=403)
    with stub:
        with pytest.raises(StorageError):
            await store.put("k", b"x")
        with pytest.raises(StorageError):
            await store.get("k")
        await store.delete("k")  # best effort: logged, not raised


def test_s3_client_configuration():
    custom = S3Storage(
        Settings(
            storage_backend="s3",
            s3_bucket_name="b",
            aws_region="eu-west-1",
            aws_endpoint_url_s3="http://localhost:9000",
            s3_force_path_style=True,
            aws_access_key_id="minio",
            aws_secret_access_key="minio-secret",
        )
    )
    assert custom.client.meta.endpoint_url == "http://localhost:9000"
    assert custom.client.meta.region_name == "eu-west-1"
    assert custom.client.meta.config.s3["addressing_style"] == "path"

    aws = build_storage(Settings(storage_backend="s3", s3_bucket_name="b", aws_region="us-west-2"))
    assert isinstance(aws, S3Storage)
    assert aws.client.meta.endpoint_url == "https://s3.us-west-2.amazonaws.com"
