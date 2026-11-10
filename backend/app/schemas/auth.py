import re
import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.schemas.common import ORMModel


def check_password_strength(v: str) -> str:
    if len(v) < 12:
        raise ValueError("Password must be at least 12 characters.")
    if len(v) > 128:
        raise ValueError("Password must be 128 characters or fewer.")
    if not (re.search(r"[a-z]", v) and re.search(r"[A-Z]", v) and re.search(r"\d", v)):
        raise ValueError("Password must include upper and lowercase letters and a number.")
    return v


class RegisterRequest(BaseModel):
    email: EmailStr = Field(max_length=255)
    password: str

    @field_validator("email")
    @classmethod
    def _lower(cls, v: str) -> str:
        return v.strip().lower()

    @field_validator("password")
    @classmethod
    def _strength(cls, v: str) -> str:
        return check_password_strength(v)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)

    @field_validator("email")
    @classmethod
    def _lower(cls, v: str) -> str:
        return v.strip().lower()


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str

    @field_validator("new_password")
    @classmethod
    def _strength(cls, v: str) -> str:
        return check_password_strength(v)


class UserOut(ORMModel):
    id: uuid.UUID
    email: str
    created_at: datetime
    # the shared demo account: the UI labels sample data and locks the password
    is_demo: bool = False


class TokenResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"  # noqa: S105
    expires_in: int


class AuthResponse(TokenResponse):
    user: UserOut
