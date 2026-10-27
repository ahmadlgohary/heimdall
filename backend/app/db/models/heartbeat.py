from datetime import datetime

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, utcnow


class WorkerHeartbeat(Base):
    """Liveness for background processes, reported by /ready."""

    __tablename__ = "worker_heartbeats"

    worker_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    kind: Mapped[str] = mapped_column(String(30))
    last_seen_at: Mapped[datetime] = mapped_column(default=utcnow)
