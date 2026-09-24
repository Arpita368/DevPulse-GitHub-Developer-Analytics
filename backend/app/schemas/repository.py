from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class RepositoryResponse(BaseModel):
    id: UUID
    github_id: int
    name: str
    full_name: str
    description: str | None
    url: str
    default_branch: str
    is_private: bool
    created_at: datetime
    updated_at: datetime
    synced_at: datetime | None

    # Filled from what has been synced so far (0 until the first full sync).
    commit_count: int = 0
    pull_request_count: int = 0
    issue_count: int = 0
    contributor_count: int = 0

    model_config = {"from_attributes": True}


class RepositoryImportResponse(BaseModel):
    job_id: UUID
    status: str
    imported: int
