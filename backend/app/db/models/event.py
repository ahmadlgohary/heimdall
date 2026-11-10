import uuid

from sqlalchemy import ForeignKey, Index, Integer, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, CreatedAt, UUIDPrimaryKey
from app.db.models.endpoint import Endpoint


class EventStatus:
    QUEUED = "queued"
    DELIVERING = "delivering"
    RETRYING = "retrying"
    DELIVERED = "delivered"
    FAILED = "failed"

    ALL = (QUEUED, DELIVERING, RETRYING, DELIVERED, FAILED)
    SETTLED = (DELIVERED, FAILED)


class EventSource:
    LIVE = "live"
    # Sample history created by the seed script. Its delivery attempts were simulated,
    # never sent; the UI labels these so they can't pass for real processing.
    DEMO_FIXTURE = "demo_fixture"


class Event(UUIDPrimaryKey, CreatedAt, Base):
    __tablename__ = "events"
    __table_args__ = (
        Index("idx_events_endpoint_created", "endpoint_id", text("created_at DESC")),
        Index("idx_events_status", "status"),
        Index(
            "uq_events_endpoint_idempotency",
            "endpoint_id",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
    )

    endpoint_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("endpoints.id", ondelete="CASCADE"))
    event_type: Mapped[str] = mapped_column(String(150))
    payload_key: Mapped[str] = mapped_column(Text)
    payload_size: Mapped[int] = mapped_column(Integer)
    # SHA-256 of the submitted request, to tell an idempotent retry from a conflicting reuse of a key.
    payload_hash: Mapped[str] = mapped_column(String(64))
    idempotency_key: Mapped[str | None] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(30), default=EventStatus.QUEUED)
    source: Mapped[str] = mapped_column(String(20), default=EventSource.LIVE, server_default=EventSource.LIVE)

    endpoint: Mapped[Endpoint] = relationship(lazy="raise", passive_deletes=True)
