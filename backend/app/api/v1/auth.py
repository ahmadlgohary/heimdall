from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, Response, status

from app.api.dependencies import (
    CurrentUser,
    SessionDep,
    SettingsDep,
    StorageDep,
    auth_rate_limit,
    refresh_rate_limit,
)
from app.core.config import Settings
from app.core.exceptions import Conflict, Forbidden, Unauthorized
from app.db.models import User
from app.schemas.auth import (
    AuthResponse,
    ChangePasswordRequest,
    LoginRequest,
    RegisterRequest,
    TokenResponse,
    UserOut,
)
from app.services.auth_service import AuthService, Session
from app.services.demo_service import delete_sandboxes

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE = "whh_refresh"
COOKIE_PATH = "/api/v1/auth"


def _set_refresh_cookie(response: Response, session: Session, settings: Settings) -> None:
    response.set_cookie(
        REFRESH_COOKIE,
        session.refresh_token,
        max_age=settings.refresh_token_expire_days * 86400,
        path=COOKIE_PATH,
        httponly=True,
        secure=settings.secure_cookies,
        samesite=settings.cookie_samesite,
    )


def _clear_refresh_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(
        REFRESH_COOKIE,
        path=COOKIE_PATH,
        httponly=True,
        secure=settings.secure_cookies,
        samesite=settings.cookie_samesite,
    )


def user_out(user, settings: Settings) -> UserOut:
    return UserOut.model_validate(user).model_copy(update={"is_demo": user.demo_expires_at is not None})


def _auth_response(session: Session, settings: Settings) -> AuthResponse:
    return AuthResponse(
        user=user_out(session.user, settings),
        access_token=session.access.token,
        expires_in=settings.jwt_access_token_expire_minutes * 60,
    )


RefreshCookie = Annotated[str | None, Cookie(alias=REFRESH_COOKIE)]


@router.post("/register", status_code=status.HTTP_201_CREATED, dependencies=[Depends(auth_rate_limit)])
async def register(
    body: RegisterRequest, response: Response, db: SessionDep, settings: SettingsDep
) -> AuthResponse:
    if settings.is_demo_email(body.email):
        raise Conflict("This address is reserved for the demo account.", code="EMAIL_TAKEN")
    session = await AuthService(db, settings).register(body.email, body.password)
    _set_refresh_cookie(response, session, settings)
    return _auth_response(session, settings)


@router.post("/login", dependencies=[Depends(auth_rate_limit)])
async def login(
    body: LoginRequest, response: Response, db: SessionDep, settings: SettingsDep
) -> AuthResponse:
    session = await AuthService(db, settings).login(body.email, body.password)
    _set_refresh_cookie(response, session, settings)
    return _auth_response(session, settings)


@router.post("/refresh", dependencies=[Depends(refresh_rate_limit)])
async def refresh(
    response: Response, db: SessionDep, settings: SettingsDep, token: RefreshCookie = None
) -> TokenResponse:
    try:
        session = await AuthService(db, settings).refresh(token)
    except Unauthorized as exc:
        # make sure a dead cookie doesn't keep coming back
        cleared = Response()
        _clear_refresh_cookie(cleared, settings)
        exc.headers = {**(exc.headers or {}), "set-cookie": cleared.headers["set-cookie"]}
        raise
    _set_refresh_cookie(response, session, settings)
    return TokenResponse(
        access_token=session.access.token, expires_in=settings.jwt_access_token_expire_minutes * 60
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    response: Response,
    db: SessionDep,
    settings: SettingsDep,
    storage: StorageDep,
    token: RefreshCookie = None,
) -> None:
    owner = await AuthService(db, settings).logout(token)
    if owner is not None:
        user = await db.get(User, owner)
        if user is not None and user.demo_expires_at is not None:
            await delete_sandboxes(db, storage, [user.id])  # signing out of a demo copy deletes it
    _clear_refresh_cookie(response, settings)


@router.get("/me")
async def me(user: CurrentUser, settings: SettingsDep) -> UserOut:
    return user_out(user, settings)


@router.post(
    "/change-password", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(auth_rate_limit)]
)
async def change_password(
    body: ChangePasswordRequest,
    user: CurrentUser,
    db: SessionDep,
    settings: SettingsDep,
    token: RefreshCookie = None,
) -> None:
    if user.demo_expires_at is not None:
        raise Forbidden(
            "Demo copies don’t have a password. Create your own account to try this.", code="DEMO_ACCOUNT"
        )
    await AuthService(db, settings).change_password(user, body.current_password, body.new_password, token)
