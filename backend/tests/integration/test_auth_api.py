import time
import uuid

import jwt
from sqlalchemy import select

from app.db.models import RefreshToken, User
from tests.conftest import PASSWORD, register

REFRESH = "whh_refresh"


async def test_registration_creates_user_with_hashed_password(client, db):
    res = await client.post("/api/v1/auth/register", json={"email": "New@Example.com", "password": PASSWORD})
    assert res.status_code == 201
    body = res.json()
    assert body["user"]["email"] == "new@example.com"
    assert body["token_type"] == "bearer" and body["access_token"]
    cookie = res.cookies.get(REFRESH)
    assert cookie
    set_cookie = res.headers["set-cookie"].lower()
    assert "httponly" in set_cookie and "path=/api/v1/auth" in set_cookie

    user = await db.scalar(select(User).where(User.email == "new@example.com"))
    assert user is not None
    assert user.password_hash.startswith("$argon2id$") and PASSWORD not in user.password_hash


async def test_duplicate_email_rejected(client):
    await register(client, "dup@example.com")
    res = await client.post("/api/v1/auth/register", json={"email": "DUP@example.com", "password": PASSWORD})
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "EMAIL_TAKEN"


async def test_weak_password_and_bad_email_rejected(client):
    res = await client.post("/api/v1/auth/register", json={"email": "a@example.com", "password": "short"})
    assert res.status_code == 422
    err = res.json()["error"]
    assert err["code"] == "VALIDATION_ERROR" and err["details"][0]["field"] == "password"
    res = await client.post("/api/v1/auth/register", json={"email": "not-an-email", "password": PASSWORD})
    assert res.status_code == 422


async def test_login_success_and_failure(client):
    await register(client, "login@example.com")
    ok = await client.post("/api/v1/auth/login", json={"email": "login@example.com", "password": PASSWORD})
    assert ok.status_code == 200 and ok.json()["user"]["email"] == "login@example.com"
    bad = await client.post(
        "/api/v1/auth/login", json={"email": "login@example.com", "password": "Wrong42Password"}
    )
    assert bad.status_code == 401 and bad.json()["error"]["code"] == "INVALID_CREDENTIALS"
    nobody = await client.post(
        "/api/v1/auth/login", json={"email": "ghost@example.com", "password": PASSWORD}
    )
    assert nobody.status_code == 401 and nobody.json()["error"]["message"] == bad.json()["error"]["message"]


async def test_private_routes_require_authentication(client):
    for method, path in [
        ("GET", "/api/v1/auth/me"),
        ("GET", "/api/v1/endpoints"),
        ("GET", "/api/v1/events"),
        ("GET", "/api/v1/dashboard/stats"),
        ("GET", "/api/v1/api-keys"),
    ]:
        res = await client.request(method, path)
        assert res.status_code == 401, path
        assert res.json()["error"]["code"] == "UNAUTHORIZED"


async def test_me_and_expired_token(client, settings):
    account = await register(client, "me@example.com")
    res = await client.get("/api/v1/auth/me", headers=account.headers)
    assert res.status_code == 200 and res.json()["email"] == "me@example.com"

    now = int(time.time())
    expired = jwt.encode(
        {"sub": account.id, "type": "access", "iat": now - 3600, "exp": now - 1}, settings.jwt_secret, "HS256"
    )
    res = await client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {expired}"})
    assert res.status_code == 401 and res.json()["error"]["code"] == "TOKEN_EXPIRED"

    ghost = jwt.encode(
        {"sub": str(uuid.uuid4()), "type": "access", "iat": now, "exp": now + 60},
        settings.jwt_secret,
        "HS256",
    )
    assert (
        await client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {ghost}"})
    ).status_code == 401


async def test_refresh_rotates_token_and_detects_reuse(client, db):
    await register(client, "rot@example.com")
    first = client.cookies.get(REFRESH)

    res = await client.post("/api/v1/auth/refresh")
    assert res.status_code == 200 and res.json()["access_token"]
    second = client.cookies.get(REFRESH)
    assert second and second != first

    # replaying the rotated (revoked) token is rejected and revokes the whole family
    client.cookies.set(REFRESH, first, path="/api/v1/auth")
    reused = await client.post("/api/v1/auth/refresh")
    assert reused.status_code == 401 and reused.json()["error"]["code"] == "REFRESH_REUSED"

    client.cookies.set(REFRESH, second, path="/api/v1/auth")
    after = await client.post("/api/v1/auth/refresh")
    assert after.status_code == 401
    tokens = (await db.scalars(select(RefreshToken))).all()
    assert tokens and all(t.revoked_at is not None for t in tokens)


async def test_refresh_without_cookie_is_rejected(client):
    res = await client.post("/api/v1/auth/refresh")
    assert res.status_code == 401 and res.json()["error"]["code"] == "REFRESH_INVALID"


async def test_logout_revokes_refresh_token(client):
    account = await register(client, "out@example.com")
    token = client.cookies.get(REFRESH)
    res = await client.post("/api/v1/auth/logout", headers=account.headers)
    assert res.status_code == 204
    client.cookies.set(REFRESH, token, path="/api/v1/auth")
    assert (await client.post("/api/v1/auth/refresh")).status_code == 401


async def test_change_password(client):
    account = await register(client, "pw@example.com")
    wrong = await client.post(
        "/api/v1/auth/change-password",
        json={"current_password": "Nope12345678", "new_password": "BrandNew42Password"},
        headers=account.headers,
    )
    assert wrong.status_code == 400 and wrong.json()["error"]["code"] == "INVALID_PASSWORD"
    ok = await client.post(
        "/api/v1/auth/change-password",
        json={"current_password": PASSWORD, "new_password": "BrandNew42Password"},
        headers=account.headers,
    )
    assert ok.status_code == 204
    login = await client.post(
        "/api/v1/auth/login", json={"email": "pw@example.com", "password": "BrandNew42Password"}
    )
    assert login.status_code == 200
    # the session that changed the password stays signed in
    assert (await client.post("/api/v1/auth/refresh")).status_code == 200


async def test_auth_endpoints_are_rate_limited(client, settings):
    statuses = []
    for _ in range(settings.auth_rate_limit_per_minute + 2):
        res = await client.post(
            "/api/v1/auth/login", json={"email": "x@example.com", "password": "Whatever123"}
        )
        statuses.append(res.status_code)
    assert statuses[-1] == 429
    assert "retry-after" in res.headers


async def test_refresh_has_its_own_rate_limit(client, settings):
    """Using up the login budget must not sign people out on their next page load."""
    await register(client, "budget@example.com")
    for _ in range(settings.auth_rate_limit_per_minute + 2):
        await client.post("/api/v1/auth/login", json={"email": "x@example.com", "password": "Whatever123"})
    assert (
        await client.post("/api/v1/auth/login", json={"email": "x@example.com", "password": "x"})
    ).status_code == 429
    assert (await client.post("/api/v1/auth/refresh")).status_code == 200
