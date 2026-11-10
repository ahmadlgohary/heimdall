from fastapi import APIRouter
from pydantic import BaseModel

from app.api.dependencies import SettingsDep

router = APIRouter(prefix="/demo", tags=["demo"])


class DemoInfo(BaseModel):
    enabled: bool
    email: str | None = None
    password: str | None = None


@router.get("")
async def demo_info(settings: SettingsDep) -> DemoInfo:
    """Public demo credentials for the sign-in page (plan §14.3). Empty when the demo is off."""
    if not settings.demo_enabled:
        return DemoInfo(enabled=False)
    return DemoInfo(enabled=True, email=settings.demo_email, password=settings.demo_password)
