"""Event payload storage (plan §6). Amazon S3 in production; local disk or memory for dev/tests."""

import asyncio
import logging
import uuid
from pathlib import Path
from typing import Protocol

from app.core.config import Settings
from app.core.exceptions import UpstreamError

logger = logging.getLogger(__name__)


class StorageError(UpstreamError):
    code = "STORAGE_UNAVAILABLE"

    def __init__(self, message: str = "Payload storage is unavailable. The event was not accepted.") -> None:
        super().__init__(message)


def payload_key(user_id: uuid.UUID, endpoint_id: uuid.UUID, event_id: uuid.UUID) -> str:
    """events/{user_id}/{endpoint_id}/{event_id}.json — generated server-side only."""
    return f"events/{user_id}/{endpoint_id}/{event_id}.json"


class PayloadStorage(Protocol):
    async def put(self, key: str, data: bytes) -> None: ...
    async def get(self, key: str) -> bytes: ...
    async def delete(self, key: str) -> None: ...


class MemoryStorage:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.fail = False  # tests flip this to simulate an outage

    async def put(self, key: str, data: bytes) -> None:
        if self.fail:
            raise StorageError()
        self.objects[key] = data

    async def get(self, key: str) -> bytes:
        if self.fail:
            raise StorageError("Payload storage is unavailable.")
        try:
            return self.objects[key]
        except KeyError as exc:
            raise StorageError("Payload not found in storage.") from exc

    async def delete(self, key: str) -> None:
        self.objects.pop(key, None)


class LocalStorage:
    def __init__(self, root: str) -> None:
        self.root = Path(root).resolve()

    def _path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if not path.is_relative_to(self.root):
            raise ValueError("invalid storage key")
        return path

    async def put(self, key: str, data: bytes) -> None:
        path = self._path(key)

        def _write() -> None:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(data)
            tmp.replace(path)

        try:
            await asyncio.to_thread(_write)
        except OSError as exc:
            logger.error("local storage write failed", extra={"key": key, "error": str(exc)})
            raise StorageError() from exc

    async def get(self, key: str) -> bytes:
        try:
            return await asyncio.to_thread(self._path(key).read_bytes)
        except OSError as exc:
            raise StorageError("Payload not found in storage.") from exc

    async def delete(self, key: str) -> None:
        await asyncio.to_thread(self._path(key).unlink, missing_ok=True)


class S3Storage:
    """Amazon S3, or any S3-compatible service (Neon object storage, MinIO) via AWS_ENDPOINT_URL_S3.

    The bucket stays private: payloads are read back through the API only, and
    credentials never leave the server (plan §6.3).
    """

    def __init__(self, settings: Settings, client=None) -> None:
        self.bucket = settings.s3_bucket_name
        self.put_extra: dict[str, str] = {}
        if settings.s3_encryption:
            self.put_extra["ServerSideEncryption"] = settings.s3_encryption
            if settings.s3_encryption == "aws:kms" and settings.s3_kms_key_id:
                self.put_extra["SSEKMSKeyId"] = settings.s3_kms_key_id
        self.client = client or self._build_client(settings)

    @staticmethod
    def _build_client(settings: Settings):
        import boto3
        from botocore.config import Config

        kwargs: dict = {
            "region_name": settings.aws_region,
            "config": Config(
                retries={"max_attempts": 3, "mode": "standard"},
                connect_timeout=5,
                read_timeout=10,
                s3={"addressing_style": "path" if settings.s3_force_path_style else "auto"},
            ),
        }
        if settings.aws_endpoint_url_s3:
            kwargs["endpoint_url"] = settings.aws_endpoint_url_s3
        # Explicit keys win; otherwise boto3's default chain (env vars, IAM role, ~/.aws) applies.
        if settings.aws_access_key_id:
            kwargs["aws_access_key_id"] = settings.aws_access_key_id
            kwargs["aws_secret_access_key"] = settings.aws_secret_access_key
        return boto3.client("s3", **kwargs)

    async def put(self, key: str, data: bytes) -> None:
        try:
            await asyncio.to_thread(
                self.client.put_object,
                Bucket=self.bucket,
                Key=key,
                Body=data,
                ContentType="application/json",
                **self.put_extra,
            )
        except Exception as exc:
            logger.error("s3 put failed", extra={"key": key, "error": type(exc).__name__})
            raise StorageError() from exc

    async def get(self, key: str) -> bytes:
        try:
            obj = await asyncio.to_thread(self.client.get_object, Bucket=self.bucket, Key=key)
            return await asyncio.to_thread(obj["Body"].read)
        except Exception as exc:
            logger.error("s3 get failed", extra={"key": key, "error": type(exc).__name__})
            raise StorageError("Payload storage is unavailable.") from exc

    async def delete(self, key: str) -> None:
        try:
            await asyncio.to_thread(self.client.delete_object, Bucket=self.bucket, Key=key)
        except Exception:
            logger.warning("s3 delete failed", extra={"key": key})


def build_storage(settings: Settings) -> PayloadStorage:
    match settings.storage_backend:
        case "s3":
            return S3Storage(settings)
        case "memory":
            return MemoryStorage()
        case _:
            return LocalStorage(settings.local_storage_path)
