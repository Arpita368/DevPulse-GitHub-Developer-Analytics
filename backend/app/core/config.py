from cryptography.fernet import Fernet
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    DATABASE_URL: str
    SUPABASE_URL: str

    # Only needed if your Supabase project still signs tokens with the legacy
    # shared secret (HS256). Projects on asymmetric signing keys (ES256/RS256)
    # are verified through the public JWKS endpoint and don't need it.
    SUPABASE_JWT_SECRET: str | None = None

    # ---- GitHub OAuth App used by the "Connect GitHub" flow ----------------
    GITHUB_CLIENT_ID: str
    GITHUB_CLIENT_SECRET: str
    # Must exactly match the "Authorization callback URL" of the OAuth App.
    # It points at the React app, which forwards the code to this API.
    GITHUB_REDIRECT_URI: str = "http://localhost:5173/github/callback"
    # Keep in sync with GITHUB_LOGIN_SCOPES in frontend/src/lib/github.js
    GITHUB_OAUTH_SCOPES: str = "read:user user:email repo"

    # Signs the short-lived OAuth `state` value (CSRF protection).
    GITHUB_STATE_SECRET: str
    # Fernet key used to encrypt GitHub access tokens before they are stored.
    TOKEN_ENCRYPTION_KEY: str

    model_config = SettingsConfigDict(
        env_file=".env",
        extra="ignore"
    )

    @field_validator("GITHUB_STATE_SECRET")
    @classmethod
    def _state_secret_is_long_enough(cls, value: str) -> str:
        if len(value) < 32:
            raise ValueError(
                "GITHUB_STATE_SECRET must be at least 32 characters. Generate one "
                "with: python -c \"import secrets; print(secrets.token_urlsafe(48))\""
            )
        return value

    @field_validator("TOKEN_ENCRYPTION_KEY")
    @classmethod
    def _encryption_key_is_valid(cls, value: str) -> str:
        try:
            Fernet(value.encode())
        except (ValueError, TypeError) as exc:
            raise ValueError(
                "TOKEN_ENCRYPTION_KEY is not a valid Fernet key. Generate one with: "
                "python -c \"from cryptography.fernet import Fernet; "
                "print(Fernet.generate_key().decode())\""
            ) from exc
        return value


settings = Settings()
