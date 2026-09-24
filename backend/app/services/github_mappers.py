"""Pure functions that turn GitHub API JSON into row dicts for our tables.

Kept free of any DB/HTTP dependency so each one is trivial to unit test:
feed it a saved JSON sample, assert on the returned dict.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any


def parse_github_timestamp(value: str | None) -> datetime | None:
    """Parse a GitHub ISO-8601 timestamp like '2026-09-24T10:00:00Z'."""

    if not value:
        return None

    # datetime.fromisoformat() accepts a trailing 'Z' on Python 3.11+, but we
    # normalize it ourselves so this also works on older interpreters.
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def map_repo(item: dict[str, Any], github_account_id: uuid.UUID) -> dict[str, Any]:
    return {
        "id": uuid.uuid4(),
        "github_id": item["id"],
        "github_account_id": github_account_id,
        "name": item["name"],
        "full_name": item["full_name"],
        "description": item.get("description"),
        "url": item["html_url"],
        "default_branch": item.get("default_branch") or "main",
        "is_private": bool(item.get("private", False)),
        "created_at": parse_github_timestamp(item["created_at"]),
        "updated_at": parse_github_timestamp(item["updated_at"]),
    }


def map_commit(item: dict[str, Any], repository_id: uuid.UUID) -> dict[str, Any]:
    commit = item.get("commit", {})
    author = item.get("author") or {}
    commit_author = commit.get("author") or {}

    return {
        "id": uuid.uuid4(),
        "repository_id": repository_id,
        "github_sha": item["sha"],
        # `author` is null when the commit's email isn't linked to a GitHub user.
        "author_username": author.get("login"),
        "author_email": commit_author.get("email"),
        "message": commit.get("message", ""),
        "committed_at": parse_github_timestamp(
            commit.get("committer", {}).get("date")
        ),
        "url": item.get("html_url"),
    }


def map_pr(item: dict[str, Any], repository_id: uuid.UUID) -> dict[str, Any]:
    user = item.get("user") or {}

    return {
        "id": uuid.uuid4(),
        "repository_id": repository_id,
        "github_id": item["id"],
        "number": item["number"],
        "title": item.get("title", ""),
        "state": item["state"],
        "author_username": user.get("login"),
        "created_at": parse_github_timestamp(item["created_at"]),
        "updated_at": parse_github_timestamp(item["updated_at"]),
        "closed_at": parse_github_timestamp(item.get("closed_at")),
        "merged_at": parse_github_timestamp(item.get("merged_at")),
        "url": item.get("html_url"),
    }


def map_issue(item: dict[str, Any], repository_id: uuid.UUID) -> dict[str, Any] | None:
    # The /issues endpoint also returns pull requests; skip those so issue
    # counts stay accurate. Callers should check this before inserting.
    if "pull_request" in item:
        return None

    user = item.get("user") or {}

    return {
        "id": uuid.uuid4(),
        "repository_id": repository_id,
        "github_id": item["id"],
        "number": item["number"],
        "title": item.get("title", ""),
        "state": item["state"],
        "author_username": user.get("login"),
        "created_at": parse_github_timestamp(item["created_at"]),
        "updated_at": parse_github_timestamp(item["updated_at"]),
        "closed_at": parse_github_timestamp(item.get("closed_at")),
        "url": item.get("html_url"),
    }


def map_review(item: dict[str, Any], pull_request_id: uuid.UUID) -> dict[str, Any] | None:
    # PENDING reviews have a null submitted_at, and our column is NOT NULL.
    submitted_at = parse_github_timestamp(item.get("submitted_at"))
    if submitted_at is None:
        return None

    user = item.get("user") or {}

    return {
        "id": uuid.uuid4(),
        "pull_request_id": pull_request_id,
        "github_id": item["id"],
        "reviewer_username": user.get("login"),
        "state": item["state"],
        "submitted_at": submitted_at,
        "url": item.get("html_url"),
    }


def map_contributor(item: dict[str, Any], repository_id: uuid.UUID, now: datetime) -> dict[str, Any]:
    return {
        "id": uuid.uuid4(),
        "repository_id": repository_id,
        "github_id": item["id"],
        "username": item["login"],
        "avatar_url": item.get("avatar_url"),
        "contributions": item.get("contributions", 0),
        "last_synced_at": now,
    }
