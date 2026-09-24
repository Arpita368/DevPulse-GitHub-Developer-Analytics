import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.db.database import get_db
from app.models.github_account import GithubAccount
from app.schemas.github import (
    GithubAccountResponse,
    GithubCallbackRequest,
    GithubConnectResponse,
    GithubLoginLinkRequest,
    GithubStatusResponse,
)
from app.services import github_service


router = APIRouter(
    prefix="/github",
    tags=["GitHub"]
)


def _user_id(current_user: dict) -> uuid.UUID:
    try:
        return uuid.UUID(current_user["id"])
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token"
        )


def _status(account: GithubAccount | None) -> GithubStatusResponse:
    if account is None:
        return GithubStatusResponse(connected=False, account=None)

    return GithubStatusResponse(
        connected=True,
        account=GithubAccountResponse.model_validate(account)
    )


@router.get("/account", response_model=GithubStatusResponse)
def get_github_account(
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Is a GitHub account connected, and which one?"""

    account = github_service.get_account_for_user(db, _user_id(current_user))

    return _status(account)


@router.post("/connect", response_model=GithubConnectResponse)
def start_github_connect(
    current_user: dict = Depends(get_current_user)
):
    """Step 1 of "Connect GitHub": returns the GitHub authorization URL."""

    authorize_url, state = github_service.build_authorize_url(
        _user_id(current_user)
    )

    return GithubConnectResponse(authorize_url=authorize_url, state=state)


@router.post("/callback", response_model=GithubStatusResponse)
def finish_github_connect(
    payload: GithubCallbackRequest,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Step 2: exchange the OAuth code GitHub sent back and store the account."""

    account = github_service.connect_with_code(
        db,
        _user_id(current_user),
        code=payload.code,
        state=payload.state
    )

    return _status(account)


@router.post("/link-from-login", response_model=GithubStatusResponse)
def link_github_from_login(
    payload: GithubLoginLinkRequest,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Auto-connect GitHub for users who just logged in / registered with GitHub."""

    account = github_service.connect_with_provider_token(
        db,
        _user_id(current_user),
        provider_token=payload.provider_token
    )

    return _status(account)


@router.delete("/account", response_model=GithubStatusResponse)
def disconnect_github_account(
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Unlink the connected GitHub account (safe to call when none is linked)."""

    github_service.disconnect(db, _user_id(current_user))

    return _status(None)
