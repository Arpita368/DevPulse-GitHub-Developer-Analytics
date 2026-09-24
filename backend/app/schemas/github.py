from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field, computed_field


class GithubAccountResponse(BaseModel):
    """Public view of a connected GitHub account.

    The access token is deliberately not part of this schema.
    """

    id: UUID
    github_id: int
    github_username: str
    avatar_url: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}

    @computed_field
    @property
    def profile_url(self) -> str:
        return f"https://github.com/{self.github_username}"


class GithubStatusResponse(BaseModel):
    connected: bool
    account: GithubAccountResponse | None = None


class GithubConnectResponse(BaseModel):
    authorize_url: str
    state: str


class GithubCallbackRequest(BaseModel):
    code: str = Field(min_length=1, max_length=512)
    state: str = Field(min_length=1, max_length=2048)


class GithubLoginLinkRequest(BaseModel):
    provider_token: str = Field(min_length=10, max_length=1024)
