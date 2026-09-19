from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class ProfileUpdate(BaseModel):
    username: str | None = None
    full_name: str | None = None
    avatar_url: str | None = None


class ProfileResponse(BaseModel):
    id: UUID
    username: str | None
    full_name: str | None
    avatar_url: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}