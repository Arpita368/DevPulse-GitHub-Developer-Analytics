from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.db.database import get_db
from app.models.profile import Profile
from app.schemas.profile import ProfileResponse, ProfileUpdate


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

    profile = Profile(id=user_id)

    db.add(profile)

    try:
        db.commit()
    except IntegrityError:
        db.rollback()

        profile = db.query(Profile).filter(
            Profile.id == user_id
        ).first()

        if profile:
            return profile

        raise

    db.refresh(profile)

    return profile


@router.get("", response_model=ProfileResponse)
def get_profile(
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    user_id = current_user["id"]

    profile = db.query(Profile).filter(
        Profile.id == user_id
    ).first()

    if not profile:
        raise HTTPException(
            status_code=404,
            detail="Profile not found"
        )

    return profile


@router.put("", response_model=ProfileResponse)
def update_profile(
    profile_data: ProfileUpdate,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    user_id = current_user["id"]

    profile = db.query(Profile).filter(
        Profile.id == user_id
    ).first()

    if not profile:
        raise HTTPException(
            status_code=404,
            detail="Profile not found"
        )

    if profile_data.username is not None:
        username = profile_data.username.strip()

        if not username:
            raise HTTPException(
                status_code=400,
                detail="Username cannot be empty"
            )

        existing_profile = (
            db.query(Profile)
            .filter(
                Profile.username == username,
                Profile.id != user_id
            )
            .first()
        )

        if existing_profile:
            raise HTTPException(
                status_code=409,
                detail="Username is already taken"
            )

        profile.username = username

    if profile_data.full_name is not None:
        full_name = profile_data.full_name.strip()
        profile.full_name = full_name or None

    if profile_data.avatar_url is not None:
        profile.avatar_url = profile_data.avatar_url

    try:
        db.commit()
    except IntegrityError:
        db.rollback()

        raise HTTPException(
            status_code=409,
            detail="Username is already taken"
        )

    db.refresh(profile)

    return profile