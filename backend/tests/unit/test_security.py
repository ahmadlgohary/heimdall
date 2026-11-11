import time
import uuid

import jwt
import pytest

from app.core.config import Settings
from app.core.security import (
    SecretBox,
    create_access_token,
    decode_access_token,
    generate_api_key,
    hash_password,
    hash_token,
    verify_password,
)


@pytest.fixture
def cfg() -> Settings:
    return Settings(jwt_secret="x" * 40)


def test_passwords_are_hashed_with_argon2id():
    h = hash_password("CorrectHorse42Battery")
    assert h.startswith("$argon2id$")
    assert "CorrectHorse42Battery" not in h
    assert verify_password("CorrectHorse42Battery", h)
    assert not verify_password("wrong", h)
    assert not verify_password("x", "not-a-hash")


def test_access_token_roundtrip(cfg):
    uid = uuid.uuid4()
    assert decode_access_token(create_access_token(uid, cfg).token, cfg) == uid


def test_expired_token_rejected(cfg):
    now = int(time.time())
    token = jwt.encode(
        {"sub": str(uuid.uuid4()), "type": "access", "iat": now - 3600, "exp": now - 60},
        cfg.jwt_secret,
        "HS256",
    )
    with pytest.raises(jwt.ExpiredSignatureError):
        decode_access_token(token, cfg)


def test_tampered_or_foreign_tokens_rejected(cfg):
    token = create_access_token(uuid.uuid4(), cfg).token
    with pytest.raises(jwt.PyJWTError):
        decode_access_token(token, Settings(jwt_secret="y" * 40))
    now = int(time.time())
    refresh_like = jwt.encode(
        {"sub": str(uuid.uuid4()), "type": "refresh", "iat": now, "exp": now + 60}, cfg.jwt_secret, "HS256"
    )
    with pytest.raises(jwt.PyJWTError):
        decode_access_token(refresh_like, cfg)
    none_alg = jwt.encode(
        {"sub": str(uuid.uuid4()), "type": "access", "iat": now, "exp": now + 60}, None, "none"
    )
    with pytest.raises(jwt.PyJWTError):
        decode_access_token(none_alg, cfg)


def test_api_keys_are_random_and_stored_hashed():
    a, b = generate_api_key(), generate_api_key()
    assert a.raw != b.raw
    assert a.raw.startswith("wh_live_") and a.prefix == a.raw[:12]
    assert a.hash == hash_token(a.raw) and a.raw not in a.hash


def test_secret_box_roundtrip_and_wrong_key(cfg):
    box = SecretBox(cfg.fernet_key)
    ct = box.encrypt("whsec_abc")
    assert ct != "whsec_abc" and box.decrypt(ct) == "whsec_abc"
    with pytest.raises(ValueError):
        SecretBox(Settings(jwt_secret="z" * 40).fernet_key).decrypt(ct)


def test_production_requires_real_secrets():
    with pytest.raises(ValueError):
        Settings(app_env="production", jwt_secret="short", encryption_key="")
    with pytest.raises(ValueError):
        Settings(
            app_env="production", jwt_secret="k" * 40, encryption_key="x", allow_private_destinations=True
        )


def test_secret_box_supports_key_rotation():
    from cryptography.fernet import Fernet

    old, new = Fernet.generate_key(), Fernet.generate_key()
    legacy = SecretBox(old).encrypt("whsec_old")
    rotated = SecretBox(Settings(encryption_key=f"{new.decode()}, {old.decode()}").fernet_key)
    assert rotated.decrypt(legacy) == "whsec_old"  # old data still readable
    fresh = rotated.encrypt("whsec_new")
    assert SecretBox(new).decrypt(fresh) == "whsec_new"  # new data uses the first key
    with pytest.raises(ValueError):
        SecretBox(old).decrypt(fresh)
