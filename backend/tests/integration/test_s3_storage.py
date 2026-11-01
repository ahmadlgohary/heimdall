"""Ingestion → replay → payload API against S3 (moto's in-process S3, real boto3 requests)."""

import json

import boto3
import httpx
import pytest
from moto import mock_aws

from app.main import create_app
from app.services.storage_service import S3Storage
from tests.conftest import create_api_key, create_endpoint, ingest, register

BUCKET = "heimdall-payloads-test"


@pytest.fixture
def s3_settings(settings):
    return settings.model_copy(
        update={
            "storage_backend": "s3",
            "s3_bucket_name": BUCKET,
            "aws_region": "eu-central-1",
            "aws_access_key_id": "test",
            "aws_secret_access_key": "test",
        }
    )


@pytest.fixture
async def s3_client_app(s3_settings, session_factory, db):
    with mock_aws():
        raw = boto3.client("s3", region_name="eu-central-1")
        raw.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": "eu-central-1"})
        storage = S3Storage(s3_settings)
        app = create_app(s3_settings, storage=storage)
        app.state.session_factory = session_factory
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            yield client, raw


async def test_ingested_payload_lands_in_s3_and_is_served_back(s3_client_app):
    client, raw = s3_client_app
    account = await register(client)
    endpoint = await create_endpoint(client, account)
    key = await create_api_key(client, account)

    res = await ingest(client, endpoint["id"], key)
    assert res.status_code == 202, res.text
    event_id = res.json()["event_id"]

    object_key = f"events/{account.id}/{endpoint['id']}/{event_id}.json"
    obj = raw.get_object(Bucket=BUCKET, Key=object_key)
    assert obj["ContentType"] == "application/json"
    assert obj["ServerSideEncryption"] == "AES256"
    stored = json.loads(obj["Body"].read())
    assert stored["id"] == event_id and stored["data"]["order_id"] == "ORD-1001"

    payload = await client.get(f"/api/v1/events/{event_id}/payload", headers=account.headers)
    assert payload.status_code == 200 and payload.json() == stored


async def test_missing_bucket_rejects_ingestion_cleanly(s3_client_app):
    client, raw = s3_client_app
    account = await register(client)
    endpoint = await create_endpoint(client, account)
    key = await create_api_key(client, account)
    raw.delete_bucket(Bucket=BUCKET)

    res = await ingest(client, endpoint["id"], key)
    assert res.status_code == 502 and res.json()["error"]["code"] == "STORAGE_UNAVAILABLE"
    events = await client.get("/api/v1/events", headers=account.headers)
    assert events.json()["pagination"]["total"] == 0
