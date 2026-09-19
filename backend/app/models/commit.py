import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

class Commit(Base):
    __tablename__ = "commits"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True,
        default=uuid.uuid4
    )

    repository_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("repositories.id", ondelete="CASCADE"),
        nullable=False
    )

    github_sha: Mapped[str] = mapped_column(
        Text,
        nullable=False
    )

    author_username: Mapped[str | None] = mapped_column(
        Text
    )

    author_email: Mapped[str | None] = mapped_column(
        Text
    )

    message: Mapped[str] = mapped_column(
        Text,
        nullable=False
    )

    commited_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False
    )

    url: Mapped[str | None] = mapped_column(
        Text
    )