import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.db.database import get_db
from app.schemas.sync import SyncJobResponse
from app.services import sync_service

router = APIRouter(
    prefix="/sync-jobs",
    tags=["Sync Jobs"]
)


def _user_id(current_user: dict) -> uuid.UUID:
    try:
        return uuid.UUID(current_user["id"])
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token"
        )


@router.get("", response_model=list[SyncJobResponse])
def list_sync_jobs(
    repository_id: uuid.UUID | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    return sync_service.list_sync_jobs(
        db,
        _user_id(current_user),
        repository_id=repository_id,
        limit=limit,
    )


@router.get("/{job_id}", response_model=SyncJobResponse)
def get_sync_job(
    job_id: uuid.UUID,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    return sync_service.get_owned_sync_job(db, _user_id(current_user), job_id)
