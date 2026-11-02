import json
import uuid
from datetime import datetime

from pydantic import BaseModel


class DeliveryJob(BaseModel):
    """Body of a RabbitMQ delivery message. `delivery_id` + `attempt_number` is the idempotency key."""

    delivery_id: uuid.UUID
    attempt_number: int
    not_before: datetime | None = None

    def encode(self) -> bytes:
        return self.model_dump_json().encode()

    @classmethod
    def decode(cls, body: bytes) -> DeliveryJob:
        return cls.model_validate(json.loads(body))
