import logging

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jwt import PyJWKClient, PyJWKClientConnectionError

from app.core.config import settings

logger = logging.getLogger(__name__)

security = HTTPBearer()

# Supabase publishes its public signing keys here. PyJWKClient caches them, so
# the network is only hit on the first request and when keys rotate.
_jwks_client = PyJWKClient(
    f"{settings.SUPABASE_URL.rstrip('/')}/auth/v1/.well-known/jwks.json",
    cache_jwk_set=True,
    lifespan=3600,
    timeout=10,
)

_ASYMMETRIC_ALGORITHMS = {"ES256", "RS256"}


def _decode_supabase_token(token: str) -> dict:
    """Verify a Supabase access token (signature, expiry, audience)."""

    algorithm = jwt.get_unverified_header(token).get("alg")

    if algorithm == "HS256":
        # Legacy projects: tokens are signed with the shared JWT secret.
        if not settings.SUPABASE_JWT_SECRET:
            logger.error(
                "Received an HS256 token but SUPABASE_JWT_SECRET is not set. "
                "Add it to backend/.env (Supabase > Project Settings > API > JWT Secret)."
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Authentication is not configured correctly on the server"
            )

        key = settings.SUPABASE_JWT_SECRET

    elif algorithm in _ASYMMETRIC_ALGORITHMS:
        key = _jwks_client.get_signing_key_from_jwt(token).key

    else:
        raise jwt.InvalidAlgorithmError("Unsupported token algorithm")

    return jwt.decode(
        token,
        key,
        algorithms=[algorithm],
        audience="authenticated",
        options={"require": ["exp", "sub"]},
    )


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security)
):
    token = credentials.credentials

    try:
        payload = _decode_supabase_token(token)

    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication token has expired"
        )

    except PyJWKClientConnectionError:
        logger.exception("Could not fetch Supabase signing keys")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to verify authentication token right now"
        )

    except jwt.PyJWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token"
        )

    user_id = payload.get("sub")

    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token"
        )

    return {
        "id": user_id,
        "email": payload.get("email"),
        "user_metadata": payload.get("user_metadata", {})
    }
