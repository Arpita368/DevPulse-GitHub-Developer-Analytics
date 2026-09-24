"""Thin HTTP client for the GitHub REST (data) API.

Distinct from `app.services.github_service`, which owns the OAuth /
"Connect GitHub" concern. This client is only about calling GitHub's data
endpoints (repos, commits, pulls, issues, reviews, contributors) with a
user's already-decrypted access token.

Callers should treat every method as capable of raising one of the
`Github*Error` types below; `sync_service` converts those into `SyncError`
for the HTTP layer.
"""

from __future__ import annotations

import logging
from typing import Any, Iterator

import httpx

logger = logging.getLogger(__name__)

GITHUB_API_URL = "https://api.github.com"
GITHUB_API_VERSION = "2022-11-28"

# Stop syncing once fewer than this many requests remain in the hour, even on
# an otherwise-successful call, so a big sync never burns the whole quota.
RATE_LIMIT_FLOOR = 50

HTTP_TIMEOUT = httpx.Timeout(30.0)


class GithubClientError(Exception):
    """Base class for errors talking to the GitHub data API."""

    def __init__(self, detail: str, status_code: int = 502):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


class GithubTokenInvalid(GithubClientError):
    """The stored access token was rejected by GitHub (401)."""

    def __init__(self, detail: str = "GitHub token is no longer valid. Reconnect GitHub."):
        super().__init__(detail, status_code=409)


class GithubRateLimited(GithubClientError):
    """Out of (or nearly out of) API rate limit (403/429, or remaining < floor)."""

    def __init__(self, detail: str):
        super().__init__(detail, status_code=429)


class GithubNotFound(GithubClientError):
    """The requested repo/resource doesn't exist or isn't accessible (404)."""

    def __init__(self, detail: str = "The GitHub resource was not found."):
        super().__init__(detail, status_code=404)


class GithubForbidden(GithubClientError):
    """403 that is not a rate limit: missing `repo` scope, SAML SSO, blocked repo."""

    def __init__(self, detail: str = (
        "GitHub denied access to this resource. Disconnect and reconnect GitHub, "
        "grant the 'repo' permission, and authorize any SSO-protected organizations."
    )):
        super().__init__(detail, status_code=403)


class GithubEmptyRepository(GithubClientError):
    """GitHub's 409 "Git Repository is empty" response on /commits."""

    def __init__(self):
        super().__init__("Git Repository is empty", status_code=200)


class GithubApiError(GithubClientError):
    """Any other unexpected response from GitHub."""

    def __init__(self, detail: str = "GitHub returned an unexpected response.", status_code: int = 502):
        super().__init__(detail, status_code=status_code)


def _format_reset(reset_header: str | None) -> str:
    if not reset_header:
        return "shortly"
    try:
        from datetime import datetime, timezone
        reset_at = datetime.fromtimestamp(int(reset_header), tz=timezone.utc)
        return reset_at.strftime("%H:%M:%S UTC")
    except (ValueError, OSError):
        return "shortly"


class GithubClient:
    """A GitHub API client scoped to a single user's access token."""

    def __init__(self, token: str):
        self._client = httpx.Client(
            timeout=HTTP_TIMEOUT,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": GITHUB_API_VERSION,
                "User-Agent": "DevPulse",
            },
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "GithubClient":
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()

    # ----------------------------------------------------------------
    # Low-level request
    # ----------------------------------------------------------------

    def _check_rate_limit(self, response: httpx.Response) -> None:
        remaining = response.headers.get("x-ratelimit-remaining")
        reset = response.headers.get("x-ratelimit-reset")
        retry_after = response.headers.get("retry-after")

        if response.status_code in (403, 429) and (remaining == "0" or retry_after):
            raise GithubRateLimited(
                f"GitHub rate limit exceeded. It resets at {_format_reset(reset)}."
            )

        if remaining is not None:
            try:
                if int(remaining) < RATE_LIMIT_FLOOR:
                    raise GithubRateLimited(
                        "Approaching the GitHub rate limit, so the sync stopped early. "
                        f"It resets at {_format_reset(reset)}."
                    )
            except ValueError:
                pass

    def get(self, path_or_url: str, params: dict[str, Any] | None = None) -> httpx.Response:
        url = path_or_url if path_or_url.startswith("http") else f"{GITHUB_API_URL}{path_or_url}"

        try:
            response = self._client.get(url, params=params)
        except httpx.HTTPError as exc:
            logger.warning("GitHub request failed (network): %s", exc)
            raise GithubApiError("Could not reach GitHub. Please try again.") from exc

        self._check_rate_limit(response)

        if response.status_code == 401:
            raise GithubTokenInvalid()

        if response.status_code == 403:
            raise GithubForbidden()

        if response.status_code == 404:
            raise GithubNotFound()

        if response.status_code == 409:
            # Only meaningful on /commits (empty repo). Other 409s are rare;
            # callers that don't expect one will surface it as a mapper/service bug.
            raise GithubEmptyRepository()

        if response.status_code >= 400:
            logger.error("GitHub API returned HTTP %s for %s", response.status_code, url)
            raise GithubApiError()

        return response

    # ----------------------------------------------------------------
    # Pagination
    # ----------------------------------------------------------------

    def paginate(
        self,
        path: str,
        params: dict[str, Any] | None = None,
        max_pages: int = 10,
    ) -> Iterator[dict]:
        """Yield JSON items across GitHub's `Link`-header pagination.

        Stops after `max_pages`, when there's no `next` link, or when the
        caller's generator is closed early (e.g. via a `break`, which is how
        PR/issue syncing stops once it reaches already-synced items).
        """

        url = f"{GITHUB_API_URL}{path}"
        request_params: dict[str, Any] | None = {"per_page": 100, **(params or {})}

        for _ in range(max_pages):
            response = self.get(url, params=request_params)

            # Some endpoints (e.g. contributors on an empty repo) return 204
            # with no body instead of an empty JSON array.
            if response.status_code == 204 or not response.content:
                return

            data = response.json()
            if isinstance(data, list):
                yield from data

            next_link = response.links.get("next")
            if not next_link:
                return

            url, request_params = next_link["url"], None
