import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

class SyncJob(Base):
    __tablename__ = "sync_jobs"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True,
        default=uuid.uuid4
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("profiles.id", ondelete="CASCADE"),
        nullable=False
    )

    repository_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("repositories.id", ondelete="CASCADE")
    )

    job_type: Mapped[str] = mapped_column(
        Text,
        nullable=False
    )

    status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="pending"
    )

    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )

    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )

    error_message: Mapped[str | None] = mapped_column(
        Text
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False
    )