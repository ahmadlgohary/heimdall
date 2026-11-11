"""Passwords, JWTs, opaque tokens, API keys and secret encryption."""

import hashlib
import hmac
import secrets
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt
from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from pwdlib import PasswordHash
from pwdlib.hashers.argon2 import Argon2Hasher

from app.core.config import Settings

# Argon2id (plan §3.1). Hashing is CPU-bound; callers run it in a thread.
_password_hash = PasswordHash((Argon2Hasher(),))

API_KEY_PREFIX = "wh_live_"
SIGNING_SECRET_PREFIX = "whsec_"  # noqa: S105


def hash_password(password: str) -> str:
    return _password_hash.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _password_hash.verify(password, password_hash)
    except Exception:
        return False


# A real hash to verify against when the user doesn't exist, so timing doesn't reveal accounts.
DUMMY_PASSWORD_HASH = hash_password(secrets.token_urlsafe(16))


@dataclass(frozen=True)
class AccessToken:
    token: str
    expires_at: datetime


def create_access_token(user_id: uuid.UUID, settings: Settings) -> AccessToken:
    now = datetime.now(UTC)
    expires = now + timedelta(minutes=settings.jwt_access_token_expire_minutes)
    claims = {
        "sub": str(user_id),
        "type": "access",
        "iat": int(now.timestamp()),
        "exp": int(expires.timestamp()),
        "jti": secrets.token_hex(8),
    }
    return AccessToken(jwt.encode(claims, settings.jwt_secret, algorithm=settings.jwt_algorithm), expires)


def decode_access_token(token: str, settings: Settings) -> uuid.UUID:
    """Return the user id, or raise jwt.PyJWTError for any invalid/expired token."""
    claims = jwt.decode(
        token,
        settings.jwt_secret,
        algorithms=[settings.jwt_algorithm],
        options={"require": ["exp", "iat", "sub", "type"]},
    )
    if claims.get("type") != "access":
        raise jwt.InvalidTokenError("not an access token")
    try:
        return uuid.UUID(claims["sub"])
    except ValueError as exc:
        raise jwt.InvalidTokenError("bad subject") from exc


def create_demo_refresh_token(user_id: uuid.UUID, settings: Settings) -> AccessToken:
    """Refresh token for the read-only demo account. Self-contained (a signed JWT) so
    demo sessions never write to the database; opaque tokens never contain dots."""
    now = datetime.now(UTC)
    expires = now + timedelta(days=settings.refresh_token_expire_days)
    claims = {
        "sub": str(user_id),
        "type": "demo_refresh",
        "iat": int(now.timestamp()),
        "exp": int(expires.timestamp()),
        "jti": secrets.token_hex(8),
    }
    return AccessToken(jwt.encode(claims, settings.jwt_secret, algorithm=settings.jwt_algorithm), expires)


def decode_demo_refresh_token(token: str, settings: Settings) -> uuid.UUID:
    claims = jwt.decode(
        token,
        settings.jwt_secret,
        algorithms=[settings.jwt_algorithm],
        options={"require": ["exp", "iat", "sub", "type"]},
    )
    if claims.get("type") != "demo_refresh":
        raise jwt.InvalidTokenError("not a demo refresh token")
    return uuid.UUID(claims["sub"])


def is_jwt_shaped(token: str) -> bool:
    return token.count(".") == 2


def generate_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def hash_token(token: str) -> str:
    """SHA-256 for high-entropy tokens (refresh tokens, API keys). Not for passwords."""
    return hashlib.sha256(token.encode()).hexdigest()


def constant_time_equals(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


@dataclass(frozen=True)
class GeneratedApiKey:
    raw: str
    prefix: str
    hash: str


def generate_api_key() -> GeneratedApiKey:
    raw = API_KEY_PREFIX + secrets.token_urlsafe(32)
    return GeneratedApiKey(raw=raw, prefix=raw[:12], hash=hash_token(raw))


def generate_signing_secret() -> str:
    return SIGNING_SECRET_PREFIX + secrets.token_urlsafe(32)


class SecretBox:
    """Symmetric encryption for secrets stored at rest (endpoint signing secrets).

    Accepts several keys for rotation: the first encrypts, every key can decrypt.
    """

    def __init__(self, keys: bytes | Sequence[bytes]) -> None:
        key_list = [keys] if isinstance(keys, bytes) else list(keys)
        if not key_list:
            raise ValueError("at least one encryption key is required")
        self._fernet = MultiFernet([Fernet(k) for k in key_list])

    def encrypt(self, plaintext: str) -> str:
        return self._fernet.encrypt(plaintext.encode()).decode()

    def decrypt(self, ciphertext: str) -> str:
        try:
            return self._fernet.decrypt(ciphertext.encode()).decode()
        except InvalidToken as exc:
            raise ValueError("secret could not be decrypted; check ENCRYPTION_KEY") from exc
