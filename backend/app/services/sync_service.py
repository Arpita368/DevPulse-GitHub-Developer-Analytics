"""Orchestrates GitHub -> Postgres syncing.

Two entry points used by the routes:

- `import_repositories` — pulls the user's owned repos and upserts them.
- `sync_repository` — full sync of one repo: commits, PRs, issues,
  contributors, reviews, each committed as its own step so a late failure
  keeps whatever synced before it.

Every entry point wraps its work in a `sync_jobs` row: created as
"running", flipped to "completed" or "failed" (with `error_message`) in a
`finally`-equivalent, so a job never gets stuck on "running".
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.clients.github_client import (
    GithubClient,
    GithubClientError,
    GithubEmptyRepository,
    GithubNotFound,
)
from app.models.commit import Commit
from app.models.contributor import Contributor
from app.models.issue import Issue
from app.models.pull_request import PullRequest
from app.models.repository import Repository
from app.models.review import Review
from app.models.sync_job import SyncJob
from app.services import github_mappers, github_service

logger = logging.getLogger(__name__)

# Bounds from the Week 3 scope decisions: keep one full sync fast and
# predictable rather than exhaustive. Each page is per_page=100.
REPO_IMPORT_MAX_PAGES = 10        # owner repos only, so this is generous
COMMITS_MAX_PAGES = 3             # ~300 commits, last 90 days
PRS_MAX_PAGES = 3                 # ~300 PRs, newest by `updated`
ISSUES_MAX_PAGES = 3              # ~300 issues, newest by `updated`
REVIEWS_MAX_PAGES = 3             # per PR; reviews per PR rarely exceed this
REVIEWS_PR_LIMIT = 50             # only the 50 most recently updated PRs
COMMITS_LOOKBACK_DAYS = 90


class SyncError(Exception):
    """A problem that should be reported to the client as an HTTP error."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _to_github_timestamp(value: datetime) -> str:
    return value.strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------
# Job lifecycle
# --------------------------------------------------------------------------

def _create_job(
    db: Session,
    user_id: uuid.UUID,
    job_type: str,
    repository_id: uuid.UUID | None = None,
) -> SyncJob:
    now = datetime.now(timezone.utc)

    job = SyncJob(
        user_id=user_id,
        repository_id=repository_id,
        job_type=job_type,
        status="running",
        started_at=now,
        created_at=now,
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    return job


def _finish_job(db: Session, job: SyncJob, status: str, error_message: str | None = None) -> None:
    job.status = status
    job.completed_at = datetime.now(timezone.utc)
    job.error_message = error_message
    db.commit()
    db.refresh(job)


# --------------------------------------------------------------------------
# Ownership helper (used by routes too)
# --------------------------------------------------------------------------

def get_owned_repository(db: Session, user_id: uuid.UUID, repository_id: uuid.UUID) -> Repository:
    """Return the repo only if it belongs to this user; 404 otherwise.

    404 (not 403) on a mismatch so we don't leak which repository IDs exist.
    """

    from app.models.github_account import GithubAccount

    repo = db.scalar(
        select(Repository)
        .join(GithubAccount, Repository.github_account_id == GithubAccount.id)
        .where(
            Repository.id == repository_id,
            GithubAccount.user_id == user_id,
        )
    )

    if repo is None:
        raise SyncError(404, "Repository not found.")

    return repo


def list_repositories(db: Session, user_id: uuid.UUID) -> list[Repository]:
    from app.models.github_account import GithubAccount

    return list(
        db.scalars(
            select(Repository)
            .join(GithubAccount, Repository.github_account_id == GithubAccount.id)
            .where(GithubAccount.user_id == user_id)
            .order_by(Repository.updated_at.desc())
        )
    )


def _require_account(db: Session, user_id: uuid.UUID):
    account = github_service.get_account_for_user(db, user_id)

    if account is None:
        raise SyncError(400, "Connect a GitHub account first.")

    return account


# --------------------------------------------------------------------------
# Repository import
# --------------------------------------------------------------------------

def import_repositories(db: Session, user_id: uuid.UUID) -> tuple[SyncJob, int]:
    account = _require_account(db, user_id)
    job = _create_job(db, user_id, job_type="repo_list")

    try:
        token = github_service.get_access_token(account)

        with GithubClient(token) as client:
            items = list(
                client.paginate(
                    "/user/repos",
                    params={"affiliation": "owner", "sort": "updated"},
                    max_pages=REPO_IMPORT_MAX_PAGES,
                )
            )

        rows_by_key = {}
        for item in items:
            row = github_mappers.map_repo(item, account.id)
            rows_by_key[row["github_id"]] = row  # de-dupe a page overlap
        rows = list(rows_by_key.values())

        if rows:
            stmt = pg_insert(Repository).values(rows)
            stmt = stmt.on_conflict_do_update(
                index_elements=[Repository.github_id],
                set_={
                    "name": stmt.excluded.name,
                    "full_name": stmt.excluded.full_name,
                    "description": stmt.excluded.description,
                    "url": stmt.excluded.url,
                    "default_branch": stmt.excluded.default_branch,
                    "is_private": stmt.excluded.is_private,
                    "updated_at": stmt.excluded.updated_at,
                },
            )
            db.execute(stmt)
            db.commit()

        _finish_job(db, job, "completed")
        return job, len(rows)

    except GithubClientError as exc:
        db.rollback()
        _finish_job(db, job, "failed", error_message=exc.detail)
        raise SyncError(exc.status_code, exc.detail) from exc
    except Exception as exc:  # pragma: no cover - safety net
        db.rollback()
        logger.exception("Repository import failed unexpectedly")
        _finish_job(db, job, "failed", error_message=str(exc))
        raise SyncError(502, "Repository import failed unexpectedly.") from exc


# --------------------------------------------------------------------------
# Full repository sync
# --------------------------------------------------------------------------

def sync_repository(db: Session, user_id: uuid.UUID, repository_id: uuid.UUID) -> tuple[SyncJob, dict]:
    account = _require_account(db, user_id)
    repo = get_owned_repository(db, user_id, repository_id)

    job = _create_job(db, user_id, job_type="repository_full", repository_id=repo.id)

    counts = {"commits": 0, "pull_requests": 0, "issues": 0, "reviews": 0, "contributors": 0}

    try:
        token = github_service.get_access_token(account)
        owner, name = repo.full_name.split("/", 1)

        with GithubClient(token) as client:
            counts["commits"] = _sync_commits(db, client, repo, owner, name)
            counts["pull_requests"] = _sync_pull_requests(db, client, repo, owner, name)
            counts["issues"] = _sync_issues(db, client, repo, owner, name)
            counts["contributors"] = _sync_contributors(db, client, repo, owner, name)
            # Reviews look up PRs from the DB, so they must run after the
            # pull-request upsert above has committed.
            counts["reviews"] = _sync_reviews(db, client, repo, owner, name)

        repo.synced_at = datetime.now(timezone.utc)
        db.commit()

        _finish_job(db, job, "completed")
        return job, counts

    except GithubClientError as exc:
        db.rollback()
        _finish_job(db, job, "failed", error_message=exc.detail)
        raise SyncError(exc.status_code, exc.detail) from exc
    except Exception as exc:  # pragma: no cover - safety net
        db.rollback()
        logger.exception("Repository sync failed unexpectedly")
        _finish_job(db, job, "failed", error_message=str(exc))
        raise SyncError(502, "Repository sync failed unexpectedly.") from exc


def _sync_commits(db: Session, client: GithubClient, repo: Repository, owner: str, name: str) -> int:
    since = repo.synced_at or (datetime.now(timezone.utc) - timedelta(days=COMMITS_LOOKBACK_DAYS))

    try:
        items = list(
            client.paginate(
                f"/repos/{owner}/{name}/commits",
                params={"since": _to_github_timestamp(since)},
                max_pages=COMMITS_MAX_PAGES,
            )
        )
    except GithubEmptyRepository:
        return 0

    rows_by_key = {}
    for item in items:
        row = github_mappers.map_commit(item, repo.id)
        rows_by_key[row["github_sha"]] = row  # commits are immutable; last write wins on overlap
    rows = list(rows_by_key.values())

    if not rows:
        return 0

    stmt = pg_insert(Commit).values(rows)
    stmt = stmt.on_conflict_do_nothing(
        index_elements=[Commit.repository_id, Commit.github_sha]
    )
    db.execute(stmt)
    db.commit()

    return len(rows)


def _sync_pull_requests(db: Session, client: GithubClient, repo: Repository, owner: str, name: str) -> int:
    rows_by_key: dict[int, dict] = {}

    for item in client.paginate(
        f"/repos/{owner}/{name}/pulls",
        params={"state": "all", "sort": "updated", "direction": "desc"},
        max_pages=PRS_MAX_PAGES,
    ):
        updated_at = github_mappers.parse_github_timestamp(item["updated_at"])

        # Sorted by `updated` descending, so once we see something older
        # than the last sync we've caught up and can stop paging.
        if repo.synced_at and updated_at and updated_at <= repo.synced_at:
            break

        row = github_mappers.map_pr(item, repo.id)
        rows_by_key[row["github_id"]] = row

    rows = list(rows_by_key.values())

    if rows:
        stmt = pg_insert(PullRequest).values(rows)
        stmt = stmt.on_conflict_do_update(
            index_elements=[PullRequest.github_id],
            set_={
                "title": stmt.excluded.title,
                "state": stmt.excluded.state,
                "updated_at": stmt.excluded.updated_at,
                "closed_at": stmt.excluded.closed_at,
                "merged_at": stmt.excluded.merged_at,
            },
        )
        db.execute(stmt)
        db.commit()

    return len(rows)


def _sync_issues(db: Session, client: GithubClient, repo: Repository, owner: str, name: str) -> int:
    params = {"state": "all", "sort": "updated"}
    if repo.synced_at:
        params["since"] = _to_github_timestamp(repo.synced_at)

    rows_by_key: dict[int, dict] = {}
    for item in client.paginate(f"/repos/{owner}/{name}/issues", params=params, max_pages=ISSUES_MAX_PAGES):
        row = github_mappers.map_issue(item, repo.id)
        if row is None:
            continue  # this "issue" is actually a pull request
        rows_by_key[row["github_id"]] = row

    rows = list(rows_by_key.values())

    if rows:
        stmt = pg_insert(Issue).values(rows)
        stmt = stmt.on_conflict_do_update(
            index_elements=[Issue.github_id],
            set_={
                "title": stmt.excluded.title,
                "state": stmt.excluded.state,
                "updated_at": stmt.excluded.updated_at,
                "closed_at": stmt.excluded.closed_at,
            },
        )
        db.execute(stmt)
        db.commit()

    return len(rows)


def _sync_contributors(db: Session, client: GithubClient, repo: Repository, owner: str, name: str) -> int:
    now = datetime.now(timezone.utc)

    try:
        items = list(client.paginate(f"/repos/{owner}/{name}/contributors", max_pages=3))
    except GithubEmptyRepository:
        return 0

    rows_by_key: dict[int, dict] = {}
    for item in items:
        row = github_mappers.map_contributor(item, repo.id, now)
        rows_by_key[row["github_id"]] = row

    rows = list(rows_by_key.values())

    if rows:
        stmt = pg_insert(Contributor).values(rows)
        stmt = stmt.on_conflict_do_update(
            index_elements=[Contributor.repository_id, Contributor.github_id],
            set_={
                "username": stmt.excluded.username,
                "avatar_url": stmt.excluded.avatar_url,
                "contributions": stmt.excluded.contributions,
                "last_synced_at": stmt.excluded.last_synced_at,
            },
        )
        db.execute(stmt)
        db.commit()

    return len(rows)


def _sync_reviews(db: Session, client: GithubClient, repo: Repository, owner: str, name: str) -> int:
    # Reviews are 1 API call per PR (N+1), so only the most recently updated
    # PRs get reviews synced. Query the DB (not GitHub) for "most recent":
    # the pull-request upsert above already committed, so this reflects it.
    top_prs = db.scalars(
        select(PullRequest)
        .where(PullRequest.repository_id == repo.id)
        .order_by(PullRequest.updated_at.desc())
        .limit(REVIEWS_PR_LIMIT)
    ).all()

    rows_by_key: dict[int, dict] = {}

    for pr in top_prs:
        try:
            items = client.paginate(
                f"/repos/{owner}/{name}/pulls/{pr.number}/reviews",
                max_pages=REVIEWS_MAX_PAGES,
            )
            for item in items:
                row = github_mappers.map_review(item, pr.id)
                if row is None:
                    continue  # PENDING review, no submitted_at yet
                rows_by_key[row["github_id"]] = row
        except GithubNotFound:
            # PR/repo access changed mid-sync; skip rather than fail the job.
            continue

    rows = list(rows_by_key.values())

    if rows:
        stmt = pg_insert(Review).values(rows)
        stmt = stmt.on_conflict_do_update(
            index_elements=[Review.github_id],
            set_={
                "state": stmt.excluded.state,
                "submitted_at": stmt.excluded.submitted_at,
                "url": stmt.excluded.url,
            },
        )
        db.execute(stmt)
        db.commit()

    return len(rows)


# --------------------------------------------------------------------------
# Sync job listing (used by the /sync-jobs routes)
# --------------------------------------------------------------------------

def list_sync_jobs(
    db: Session,
    user_id: uuid.UUID,
    repository_id: uuid.UUID | None = None,
    limit: int = 20,
) -> list[SyncJob]:
    query = select(SyncJob).where(SyncJob.user_id == user_id)

    if repository_id is not None:
        query = query.where(SyncJob.repository_id == repository_id)

    query = query.order_by(SyncJob.created_at.desc()).limit(limit)

    return list(db.scalars(query))


def get_owned_sync_job(db: Session, user_id: uuid.UUID, job_id: uuid.UUID) -> SyncJob:
    job = db.scalar(
        select(SyncJob).where(SyncJob.id == job_id, SyncJob.user_id == user_id)
    )

    if job is None:
        raise SyncError(404, "Sync job not found.")

    return job
