import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, Text, UniqueConstraint, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

class PullRequest(Base):
    __tablename__ = "pull_requests"

    __table_args__ = (
        UniqueConstraint(
            "repository_id",
            "number",
            name="pull_requests_repository_id_number_key"
        ),
        Index(
            "idx_pull_requests_created_at",
            "created_at"
        ),
        Index(
            "idx_pull_requests_merged_at",
            "merged_at"
        ),
        Index(  
            "idx_pull_requests_repository",
            "repository_id"
        ),
    )
    
    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True,
        default=uuid.uuid4
    )

    repository_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("repositories.id", ondelete="CASCADE"),
        nullable=False
    )

    github_id: Mapped[int] = mapped_column(
        BigInteger,
        nullable=False,
        unique=True
    )

    number: Mapped[int] = mapped_column(
        Integer,
        nullable=False
    )

    title: Mapped[str] = mapped_column(
        Text,
        nullable=False
    )

    state: Mapped[str] = mapped_column(
        Text,
        nullable=False
    )

    author_username: Mapped[str | None] = mapped_column(
        Text
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False
    )

    closed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
    )

    merged_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
    )

    url: Mapped[str | None] = mapped_column(
        Text
    )