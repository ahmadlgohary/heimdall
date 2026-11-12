from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Annotated

import jwt
from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.exceptions import Unauthorized
from app.core.rate_limit import limiter
from app.core.security import decode_access_token
from app.db.models import User
from app.repositories.user_repository import UserRepository
from app.services.storage_service import PayloadStorage

bearer = HTTPBearer(auto_error=False)


def get_settings_dep(request: Request) -> Settings:
    return request.app.state.settings


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    async with request.app.state.session_factory() as session:
        yield session


def get_storage(request: Request) -> PayloadStorage:
    return request.app.state.storage


SettingsDep = Annotated[Settings, Depends(get_settings_dep)]
SessionDep = Annotated[AsyncSession, Depends(get_session)]
StorageDep = Annotated[PayloadStorage, Depends(get_storage)]


async def get_current_user(
    session: SessionDep,
    settings: SettingsDep,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
) -> User:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise Unauthorized()
    try:
        user_id = decode_access_token(credentials.credentials, settings)
    except jwt.ExpiredSignatureError as exc:
        raise Unauthorized("Your session has expired.", code="TOKEN_EXPIRED") from exc
    except jwt.PyJWTError as exc:
        raise Unauthorized("Invalid access token.", code="TOKEN_INVALID") from exc
    user = await UserRepository(session).get(user_id)
    if user is None:
        raise Unauthorized("Invalid access token.", code="TOKEN_INVALID")
    if user.demo_expires_at is not None and user.demo_expires_at <= datetime.now(UTC):
        raise Unauthorized("This demo has ended. Start a new one from the sign-in page.", code="DEMO_EXPIRED")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def auth_rate_limit(request: Request, settings: SettingsDep) -> None:
    limiter.check(f"auth:{client_ip(request)}", settings.auth_rate_limit_per_minute)


def refresh_rate_limit(request: Request, settings: SettingsDep) -> None:
    limiter.check(f"refresh:{client_ip(request)}", settings.refresh_rate_limit_per_minute)
