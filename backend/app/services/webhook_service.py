"""GitHub webhook handling: signature check, event -> DB upsert, live push."""

from __future__ import annotations

import hashlib
import hmac
import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.clients.github_client import GithubClient, GithubClientError
from app.core.config import settings
from app.models.commit import Commit
from app.models.github_account import GithubAccount
from app.models.issue import Issue
from app.models.pull_request import PullRequest
from app.models.repository import Repository
from app.models.review import Review
from app.services import event_bus, github_mappers, github_service

logger = logging.getLogger(__name__)


def verify_signature(body: bytes, signature_header: str | None) -> bool:
    if not settings.GITHUB_WEBHOOK_SECRET or not signature_header:
        return False

    expected = "sha256=" + hmac.new(
        settings.GITHUB_WEBHOOK_SECRET.encode(), body, hashlib.sha256
    ).hexdigest()

    return hmac.compare_digest(expected, signature_header)


def _repo_and_user(db: Session, payload: dict):
    github_id = (payload.get("repository") or {}).get("id")
    if github_id is None:
        return None, None

    row = db.execute(
        select(Repository, GithubAccount.user_id)
        .join(GithubAccount, Repository.github_account_id == GithubAccount.id)
        .where(Repository.github_id == github_id)
    ).first()

    return (row[0], row[1]) if row else (None, None)


def handle_event(db: Session, event: str, payload: dict) -> dict:
    """Returns a small summary dict (also what the browser receives)."""

    if event == "ping":
        return {"handled": "ping"}

    repo, user_id = _repo_and_user(db, payload)
    if repo is None:
        return {"handled": "ignored", "reason": "repository not imported"}

    summary: dict | None = None

    if event == "push":
        summary = _on_push(db, repo, payload)
    elif event == "pull_request":
        summary = _on_pull_request(db, repo, payload)
    elif event == "issues":
        summary = _on_issue(db, repo, payload)
    elif event == "pull_request_review":
        summary = _on_review(db, repo, payload)

    if summary is None:
        return {"handled": "ignored", "reason": f"event '{event}' not tracked"}

    db.commit()

    event_bus.publish(
        user_id,
        {
            "type": event,
            "repository_id": str(repo.id),
            "repository": repo.full_name,
            **summary,
        },
    )
    return {"handled": event}


def _on_push(db: Session, repo: Repository, payload: dict) -> dict | None:
    commits = payload.get("commits") or []
    if not commits:
        return None

    rows = []
    for item in commits:
        author = item.get("author") or {}
        rows.append(
            {
                "id": uuid.uuid4(),
                "repository_id": repo.id,
                "github_sha": item["id"],
                "author_username": author.get("username"),
                "author_email": author.get("email"),
                "message": item.get("message", ""),
                "committed_at": github_mappers.parse_github_timestamp(item.get("timestamp"))
                or datetime.now(timezone.utc),
                "url": item.get("url"),
            }
        )

    stmt = pg_insert(Commit).values(rows).on_conflict_do_nothing(
        index_elements=[Commit.repository_id, Commit.github_sha]
    )
    db.execute(stmt)

    latest = rows[-1]
    return {
        "count": len(rows),
        "message": latest["message"].splitlines()[0][:120] if latest["message"] else "",
        "author": latest["author_username"] or (payload.get("pusher") or {}).get("name"),
        "ref": payload.get("ref"),
    }


def _on_pull_request(db: Session, repo: Repository, payload: dict) -> dict | None:
    item = payload.get("pull_request")
    if not item:
        return None

    row = github_mappers.map_pr(item, repo.id)
    stmt = pg_insert(PullRequest).values([row])
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

    return {
        "action": payload.get("action"),
        "number": row["number"],
        "message": row["title"],
        "author": row["author_username"],
    }


def _on_issue(db: Session, repo: Repository, payload: dict) -> dict | None:
    item = payload.get("issue")
    row = github_mappers.map_issue(item, repo.id) if item else None
    if row is None:
        return None

    stmt = pg_insert(Issue).values([row])
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

    return {
        "action": payload.get("action"),
        "number": row["number"],
        "message": row["title"],
        "author": row["author_username"],
    }


def _on_review(db: Session, repo: Repository, payload: dict) -> dict | None:
    review = payload.get("review")
    pr_item = payload.get("pull_request")
    if not review or not pr_item:
        return None

    pr = db.scalar(
        select(PullRequest).where(PullRequest.github_id == pr_item["id"])
    )
    if pr is None:
        return None  # PR not synced yet; the next webhook/sync will cover it

    row = github_mappers.map_review(review, pr.id)
    if row is None:
        return None

    stmt = pg_insert(Review).values([row])
    stmt = stmt.on_conflict_do_update(
        index_elements=[Review.github_id],
        set_={
            "state": stmt.excluded.state,
            "submitted_at": stmt.excluded.submitted_at,
            "url": stmt.excluded.url,
        },
    )
    db.execute(stmt)

    return {
        "action": payload.get("action"),
        "number": pr.number,
        "message": f"Review ({row['state']}) on #{pr.number}",
        "author": row["reviewer_username"],
    }


# --------------------------------------------------------------------------
# Auto-registering the webhook on a repo
# --------------------------------------------------------------------------

def ensure_webhook(db: Session, account: GithubAccount, repo: Repository) -> str:
    """Create the repo webhook if it doesn't exist. Never raises.

    Returns "created", "exists", "skipped" or "failed:<reason>".
    """

    if not settings.WEBHOOK_PUBLIC_URL or not settings.GITHUB_WEBHOOK_SECRET:
        return "skipped"

    target = settings.WEBHOOK_PUBLIC_URL.rstrip("/") + "/webhooks/github"
    owner, name = repo.full_name.split("/", 1)

    try:
        with GithubClient(github_service.get_access_token(account)) as client:
            for hook in client.paginate(f"/repos/{owner}/{name}/hooks", max_pages=2):
                if (hook.get("config") or {}).get("url") == target:
                    return "exists"

            client.post(
                f"/repos/{owner}/{name}/hooks",
                json={
                    "name": "web",
                    "active": True,
                    "events": ["push", "pull_request", "issues", "pull_request_review"],
                    "config": {
                        "url": target,
                        "content_type": "json",
                        "secret": settings.GITHUB_WEBHOOK_SECRET,
                        "insecure_ssl": "0",
                    },
                },
            )
            return "created"
    except GithubClientError as exc:
        logger.warning("Could not register webhook for %s: %s", repo.full_name, exc.detail)
        return f"failed:{exc.detail}"
    except Exception:  # pragma: no cover
        logger.exception("Webhook registration crashed for %s", repo.full_name)
        return "failed:unexpected"
