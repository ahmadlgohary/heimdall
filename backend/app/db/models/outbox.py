import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, Index, Integer, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, CreatedAt, JsonB, UUIDPrimaryKey
from app.db.models.delivery import Delivery
from app.db.models.event import Event


class MessageType:
    DELIVERY_DISPATCH = "delivery.dispatch"


class OutboxMessage(UUIDPrimaryKey, CreatedAt, Base):
    """Written in the same transaction as the state change it announces (transactional outbox)."""

    __tablename__ = "outbox_messages"
    __table_args__ = (
        Index("idx_outbox_unpublished", "created_at", postgresql_where=text("published_at IS NULL")),
        Index("idx_outbox_delivery", "delivery_id"),
    )

    event_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"))
    delivery_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("deliveries.id", ondelete="CASCADE"))
    message_type: Mapped[str] = mapped_column(String(50))
    payload: Mapped[dict] = mapped_column(JsonB)
    published_at: Mapped[datetime | None]
    publish_attempts: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    last_error: Mapped[str | None] = mapped_column(Text)

    event: Mapped[Event] = relationship(lazy="raise", passive_deletes=True)
    delivery: Mapped[Delivery] = relationship(lazy="raise", passive_deletes=True)
