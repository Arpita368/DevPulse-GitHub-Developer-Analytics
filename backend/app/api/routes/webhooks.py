import json
import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.services import webhook_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/webhooks", tags=["Webhooks"])


@router.post("/github")
async def github_webhook(
    request: Request,
    x_github_event: str | None = Header(default=None),
    x_hub_signature_256: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    body = await request.body()

    if not webhook_service.verify_signature(body, x_hub_signature_256):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    try:
        payload = json.loads(body)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    try:
        return webhook_service.handle_event(db, x_github_event or "", payload)
    except Exception:
        db.rollback()
        logger.exception("Webhook handling failed for event %s", x_github_event)
        # 200 so GitHub doesn't hammer us with retries; the error is logged.
        return {"handled": "error"}
