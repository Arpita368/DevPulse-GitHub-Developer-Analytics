import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.db.database import get_db
from app.schemas.repository import RepositoryImportResponse, RepositoryResponse
from app.schemas.sync import SyncResultResponse
from app.services import sync_service

router = APIRouter(
    prefix="/repositories",
    tags=["Repositories"]
)


def _user_id(current_user: dict) -> uuid.UUID:
    try:
        return uuid.UUID(current_user["id"])
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token"
        )


def _duration_ms(job) -> int:
    if job.started_at is None or job.completed_at is None:
        return 0
    return int((job.completed_at - job.started_at).total_seconds() * 1000)


# NOTE: this must be declared before /{repository_id} or FastAPI will try to
# parse "import" as a repository_id.
@router.post("/import", response_model=RepositoryImportResponse)
def import_repositories(
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Fetch the user's owned GitHub repos and upsert them."""

    job, imported = sync_service.import_repositories(db, _user_id(current_user))

    return RepositoryImportResponse(job_id=job.id, status=job.status, imported=imported)


@router.get("", response_model=list[RepositoryResponse])
def list_repositories(
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    return sync_service.list_repositories(db, _user_id(current_user))


@router.get("/{repository_id}", response_model=RepositoryResponse)
def get_repository(
    repository_id: uuid.UUID,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    return sync_service.get_owned_repository(db, _user_id(current_user), repository_id)


@router.post("/{repository_id}/sync", response_model=SyncResultResponse)
def sync_repository(
    repository_id: uuid.UUID,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Full sync of one repo. Blocks until done (Week 4 makes this a 202)."""

    job, counts = sync_service.sync_repository(db, _user_id(current_user), repository_id)

    return SyncResultResponse(
        job_id=job.id,
        status=job.status,
        duration_ms=_duration_ms(job),
        counts=counts,
    )
