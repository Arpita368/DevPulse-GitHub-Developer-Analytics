"""Small security helpers for the GitHub integration.

* Access tokens are encrypted with Fernet before they touch the database.
* The OAuth ``state`` parameter is a short-lived signed JWT that is bound to
  the DevPulse user who started the flow.
"""

import secrets
import time

import jwt
from cryptography.fernet import Fernet, InvalidToken

from app.core.config import settings

_fernet = Fernet(settings.TOKEN_ENCRYPTION_KEY.encode())

OAUTH_STATE_TTL_SECONDS = 10 * 60
_OAUTH_STATE_PURPOSE = "github_oauth_connect"


# --------------------------------------------------------------------------
# Token encryption
# --------------------------------------------------------------------------

def encrypt_token(plaintext: str) -> str:
    return _fernet.encrypt(plaintext.encode()).decode()


def decrypt_token(ciphertext: str) -> str:
    try:
        return _fernet.decrypt(ciphertext.encode()).decode()
    except InvalidToken as exc:
        raise ValueError(
            "Stored token could not be decrypted (was TOKEN_ENCRYPTION_KEY changed?)"
        ) from exc


# --------------------------------------------------------------------------
# OAuth state
# --------------------------------------------------------------------------

class InvalidOAuthStateError(Exception):
    """The OAuth state is malformed, expired, tampered with, or not ours."""


def create_oauth_state(user_id: str) -> str:
    now = int(time.time())

    return jwt.encode(
        {
            "sub": user_id,
            "purpose": _OAUTH_STATE_PURPOSE,
            "nonce": secrets.token_urlsafe(16),
            "iat": now,
            "exp": now + OAUTH_STATE_TTL_SECONDS,
        },
        settings.GITHUB_STATE_SECRET,
        algorithm="HS256",
    )


def verify_oauth_state(state: str, expected_user_id: str) -> None:
    try:
        payload = jwt.decode(
            state,
            settings.GITHUB_STATE_SECRET,
            algorithms=["HS256"],
            options={"require": ["exp", "iat", "sub"]},
        )
    except jwt.PyJWTError as exc:
        raise InvalidOAuthStateError("Invalid or expired OAuth state") from exc

    if payload.get("purpose") != _OAUTH_STATE_PURPOSE:
        raise InvalidOAuthStateError("OAuth state has the wrong purpose")

    if payload.get("sub") != expected_user_id:
        raise InvalidOAuthStateError("OAuth state belongs to a different user")
