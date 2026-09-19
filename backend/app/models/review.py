import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Text, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

class Review(Base):
    __tablename__ = "reviews"

    __table_args__ = (
        Index(
            "idx_reviews_pull_request",
            "pull_request_id"
        ),
        Index(
            "idx_reviews_submitted_at",
            "submitted_at"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True,
        default=uuid.uuid4
    )

    pull_request_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("pull_requests.id", ondelete="CASCADE"),
        nullable=False
    )

    github_id: Mapped[int] = mapped_column(
        BigInteger,
        nullable=False,
        unique=True
    )

    reviewer_username: Mapped[str | None] = mapped_column(
        Text
    )

    state: Mapped[str] = mapped_column(
        Text,
        nullable=False
    )

    submitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False
    )

    url: Mapped[str | None] = mapped_column(
        Text
    )