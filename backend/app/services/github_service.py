"""GitHub account connection: OAuth flow, storage, and unlinking.

Two ways a GitHub account can become connected to a DevPulse user:

1. "Connect GitHub" button (any user, however they log in) -> the OAuth
   authorization-code flow against DevPulse's GitHub OAuth App.
2. Logging in / registering *with* GitHub through Supabase -> the frontend
   forwards the GitHub token Supabase hands back, and it is verified with
   GitHub before being stored.

Both end up in `link_account()`, so the rules (one GitHub account per user,
one user per GitHub account, encrypted tokens) live in exactly one place.
"""

import logging
import uuid
from datetime import datetime, timezone
from urllib.parse import urlencode

import httpx
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import (
    InvalidOAuthStateError,
    create_oauth_state,
    decrypt_token,
    encrypt_token,
    verify_oauth_state,
)
from app.models.github_account import GithubAccount
from app.models.profile import Profile

logger = logging.getLogger(__name__)

GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
GITHUB_API_URL = "https://api.github.com"

HTTP_TIMEOUT = httpx.Timeout(10.0)


class GithubServiceError(Exception):
    """A problem that should be reported to the client as an HTTP error."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _new_client() -> httpx.Client:
    return httpx.Client(
        timeout=HTTP_TIMEOUT,
        headers={"User-Agent": "DevPulse"},
    )


# --------------------------------------------------------------------------
# OAuth flow
# --------------------------------------------------------------------------

def build_authorize_url(user_id: uuid.UUID) -> tuple[str, str]:
    """Return (authorize_url, state) for the given DevPulse user."""

    state = create_oauth_state(str(user_id))

    query = urlencode({
        "client_id": settings.GITHUB_CLIENT_ID,
        "redirect_uri": settings.GITHUB_REDIRECT_URI,
        "scope": settings.GITHUB_OAUTH_SCOPES,
        "state": state,
        "allow_signup": "true",
    })

    return f"{GITHUB_AUTHORIZE_URL}?{query}", state


def _exchange_code_for_token(code: str) -> str:
    try:
        with _new_client() as client:
            response = client.post(
                GITHUB_TOKEN_URL,
                data={
                    "client_id": settings.GITHUB_CLIENT_ID,
                    "client_secret": settings.GITHUB_CLIENT_SECRET,
                    "code": code,
                    "redirect_uri": settings.GITHUB_REDIRECT_URI,
                },
                headers={"Accept": "application/json"},
            )
    except httpx.HTTPError:
        logger.exception("GitHub token exchange failed (network)")
        raise GithubServiceError(502, "Could not reach GitHub. Please try again.")

    if response.status_code != 200:
        logger.error("GitHub token exchange returned HTTP %s", response.status_code)
        raise GithubServiceError(502, "GitHub returned an unexpected response.")

    try:
        payload = response.json()
    except ValueError:
        raise GithubServiceError(502, "GitHub returned an unexpected response.")

    # GitHub reports OAuth errors with HTTP 200 and an `error` field.
    error = payload.get("error")

    if error:
        logger.warning("GitHub token exchange rejected: %s", error)

        if error == "bad_verification_code":
            raise GithubServiceError(
                400,
                "The GitHub authorization has expired or was already used. "
                "Please click Connect GitHub again."
            )

        raise GithubServiceError(400, "GitHub authorization failed. Please try again.")

    access_token = payload.get("access_token")

    if not access_token:
        raise GithubServiceError(502, "GitHub did not return an access token.")

    return access_token


def _fetch_github_user(access_token: str) -> dict:
    try:
        with _new_client() as client:
            response = client.get(
                f"{GITHUB_API_URL}/user",
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )
    except httpx.HTTPError:
        logger.exception("GitHub /user request failed (network)")
        raise GithubServiceError(502, "Could not reach GitHub. Please try again.")

    if response.status_code == 401:
        raise GithubServiceError(
            400, "GitHub rejected the access token. It may have been revoked."
        )

    if response.status_code != 200:
        logger.error("GitHub /user returned HTTP %s", response.status_code)
        raise GithubServiceError(502, "GitHub returned an unexpected response.")

    try:
        data = response.json()
        github_id = int(data["id"])
        login = str(data["login"])
    except (ValueError, KeyError, TypeError):
        raise GithubServiceError(502, "GitHub returned an unexpected response.")

    return {
        "id": github_id,
        "login": login,
        "avatar_url": data.get("avatar_url"),
    }


def _revoke_token_best_effort(encrypted_token: str) -> None:
    """Remove DevPulse's grant from the user's GitHub 'Authorized OAuth Apps'.

    Best effort only: tokens that came from another OAuth App (for example the
    one configured in Supabase for GitHub login) will simply 404 here, and
    that must never stop the user from disconnecting.
    """

    try:
        token = decrypt_token(encrypted_token)

        with _new_client() as client:
            response = client.request(
                "DELETE",
                f"{GITHUB_API_URL}/applications/{settings.GITHUB_CLIENT_ID}/token",
                auth=(settings.GITHUB_CLIENT_ID, settings.GITHUB_CLIENT_SECRET),
                json={"access_token": token},
                headers={
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )

        if response.status_code not in (204, 404, 422):
            logger.warning("GitHub token revocation returned HTTP %s", response.status_code)

    except Exception:
        logger.warning("Could not revoke GitHub token", exc_info=True)


# --------------------------------------------------------------------------
# Persistence
# --------------------------------------------------------------------------

def get_account_for_user(db: Session, user_id: uuid.UUID) -> GithubAccount | None:
    return db.scalar(
        select(GithubAccount).where(GithubAccount.user_id == user_id)
    )


def get_access_token(account: GithubAccount) -> str:
    """Plaintext GitHub token for API calls (e.g. the future sync workers)."""

    return decrypt_token(account.access_token)


def _ensure_profile(db: Session, user_id: uuid.UUID) -> None:
    """github_accounts.user_id references profiles.id, so make sure it exists."""

    if db.get(Profile, user_id) is not None:
        return

    db.add(Profile(id=user_id))

    try:
        db.commit()
    except IntegrityError:
        # Another request created it first (e.g. /profile/sync) - that's fine.
        db.rollback()


def _link_once(
    db: Session,
    user_id: uuid.UUID,
    github_user: dict,
    access_token: str,
) -> GithubAccount:
    github_id = github_user["id"]
    now = datetime.now(timezone.utc)

    owner = db.scalar(
        select(GithubAccount).where(GithubAccount.github_id == github_id)
    )

    if owner is not None and owner.user_id != user_id:
        raise GithubServiceError(
            409,
            "This GitHub account is already connected to a different DevPulse account."
        )

    account = get_account_for_user(db, user_id)

    if account is not None and account.github_id != github_id:
        raise GithubServiceError(
            409,
            f"Your DevPulse account is already connected to GitHub user "
            f"@{account.github_username}. Disconnect it first to connect a "
            f"different GitHub account."
        )

    if account is None:
        account = GithubAccount(
            user_id=user_id,
            github_id=github_id,
            created_at=now,
        )
        db.add(account)

    account.github_username = github_user["login"]
    account.avatar_url = github_user["avatar_url"]
    account.access_token = encrypt_token(access_token)
    account.updated_at = now

    db.commit()
    db.refresh(account)

    return account


def link_account(
    db: Session,
    user_id: uuid.UUID,
    github_user: dict,
    access_token: str,
) -> GithubAccount:
    """Create or refresh the user's GitHub connection (idempotent)."""

    _ensure_profile(db, user_id)

    for attempt in (1, 2):
        try:
            return _link_once(db, user_id, github_user, access_token)

        except IntegrityError:
            # Lost a race with a concurrent request. Retrying re-reads the
            # row that just appeared, so the second pass takes the update path
            # (or reports a proper conflict).
            db.rollback()

            if attempt == 2:
                raise GithubServiceError(
                    409, "Could not connect GitHub right now. Please try again."
                )


# --------------------------------------------------------------------------
# Public operations used by the routes
# --------------------------------------------------------------------------

def connect_with_code(
    db: Session,
    user_id: uuid.UUID,
    code: str,
    state: str,
) -> GithubAccount:
    try:
        verify_oauth_state(state, expected_user_id=str(user_id))
    except InvalidOAuthStateError as exc:
        logger.warning("Rejected GitHub OAuth callback: %s", exc)
        raise GithubServiceError(
            400,
            "This GitHub connection request is invalid or has expired. "
            "Please click Connect GitHub again."
        )

    access_token = _exchange_code_for_token(code)
    github_user = _fetch_github_user(access_token)

    return link_account(db, user_id, github_user, access_token)


def connect_with_provider_token(
    db: Session,
    user_id: uuid.UUID,
    provider_token: str,
) -> GithubAccount:
    """Auto-connect after the user logged in / registered with GitHub."""

    github_user = _fetch_github_user(provider_token)

    return link_account(db, user_id, github_user, provider_token)


def disconnect(db: Session, user_id: uuid.UUID) -> bool:
    """Unlink the user's GitHub account. Returns False if nothing was linked.

    Deleting the row cascades (at the database level) to the repositories
    imported through this account and everything hanging off them.
    """

    account = get_account_for_user(db, user_id)

    if account is None:
        return False

    encrypted_token = account.access_token

    db.delete(account)
    db.commit()

    # After the commit: unlinking succeeds even if GitHub is unreachable.
    _revoke_token_best_effort(encrypted_token)

    return True
