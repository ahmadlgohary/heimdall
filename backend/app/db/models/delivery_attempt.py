import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, Index, Integer, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, JsonB, UUIDPrimaryKey, utcnow
from app.db.models.delivery import Delivery


class DeliveryAttempt(UUIDPrimaryKey, Base):
    __tablename__ = "delivery_attempts"
    __table_args__ = (
        # Enforces at-most-once recording per scheduled attempt, even with duplicate queue messages.
        # Its index also serves the (delivery_id, attempt_number) lookups the spec asks for.
        UniqueConstraint("delivery_id", "attempt_number", name="uq_delivery_attempts_delivery_attempt"),
        Index("idx_attempts_attempted_at", "attempted_at"),
    )

    delivery_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("deliveries.id", ondelete="CASCADE"))
    attempt_number: Mapped[int] = mapped_column(Integer)
    http_status: Mapped[int | None] = mapped_column(Integer)
    response_body: Mapped[str | None] = mapped_column(Text)
    response_headers: Mapped[dict | None] = mapped_column(JsonB)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    error_message: Mapped[str | None] = mapped_column(Text)
    attempted_at: Mapped[datetime] = mapped_column(default=utcnow)

    delivery: Mapped[Delivery] = relationship(lazy="raise", passive_deletes=True)
