from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class SyncJobResponse(BaseModel):
    id: UUID
    job_type: str
    status: str
    repository_id: UUID | None
    started_at: datetime | None
    completed_at: datetime | None
    error_message: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class SyncResultResponse(BaseModel):
    job_id: UUID
    status: str
    duration_ms: int
    counts: dict[str, int]
