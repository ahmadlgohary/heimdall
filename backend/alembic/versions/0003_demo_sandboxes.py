"""demo sandboxes: users.demo_expires_at

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-12
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("demo_expires_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index(op.f("ix_users_demo_expires_at"), "users", ["demo_expires_at"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_users_demo_expires_at"), table_name="users")
    op.drop_column("users", "demo_expires_at")
