from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.db.database import get_db
from app.models.profile import Profile
from app.schemas.profile import ProfileResponse


router = APIRouter(
    prefix="/profile",
    tags=["Profile"]
)


@router.post("/sync", response_model=ProfileResponse)
def sync_profile(
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    user_id = current_user["id"]

    profile = db.query(Profile).filter(
        Profile.id == user_id
    ).first()

    if profile:
        return profile

    profile = Profile(
        id=user_id
    )

    db.add(profile)
    db.commit()
    db.refresh(profile)

    return profile