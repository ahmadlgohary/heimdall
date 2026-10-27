import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, Index, Integer, String, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, CreatedAt, UUIDPrimaryKey
from app.db.models.event import Event


class TriggerType:
    AUTOMATIC = "automatic"
    MANUAL = "manual"


class Delivery(UUIDPrimaryKey, CreatedAt, Base):
    """One execution of an event: the original delivery, or a manual replay."""

    __tablename__ = "deliveries"
    __table_args__ = (
        UniqueConstraint("event_id", "execution_number", name="uq_deliveries_event_execution"),
        Index("idx_deliveries_event", "event_id", text("created_at DESC")),
        Index("idx_deliveries_retry_due", "next_attempt_at", postgresql_where=text("status = 'retrying'")),
    )

    event_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"))
    execution_number: Mapped[int] = mapped_column(Integer)
    trigger_type: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(30))
    current_attempt: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    max_attempts: Mapped[int] = mapped_column(Integer, default=5, server_default=text("5"))
    next_attempt_at: Mapped[datetime | None]
    # Worker lease: a crashed worker's claim expires so another can take the attempt.
    locked_until: Mapped[datetime | None]
    started_at: Mapped[datetime | None]
    completed_at: Mapped[datetime | None]

    # Declared so the unit of work inserts parents first; never lazy-loaded (async).
    event: Mapped[Event] = relationship(lazy="raise", passive_deletes=True)
