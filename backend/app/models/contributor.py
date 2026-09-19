import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

class Contributor(Base):
    __tablename__ = "contributors"

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
        nullable=False
    )

    username: Mapped[str] = mapped_column(
        Text,
        nullable=False
    )

    avatar_url: Mapped[str | None] = mapped_column(
        Text
    )

    contributions: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0
    )

    last_synced_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False
    )