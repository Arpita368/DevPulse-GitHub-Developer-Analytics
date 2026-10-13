import asyncio
import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse

from app.core.auth import get_current_user
from app.services import event_bus

router = APIRouter(prefix="/events", tags=["Events"])

KEEPALIVE_SECONDS = 20


@router.get("/stream")
async def stream_events(current_user: dict = Depends(get_current_user)):
    """Server-Sent Events: one message per GitHub event for this user."""

    try:
        user_id = uuid.UUID(current_user["id"])
    except (ValueError, TypeError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid authentication token")

    queue = event_bus.subscribe(user_id)

    async def generator():
        try:
            yield "retry: 3000\n\n"
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=KEEPALIVE_SECONDS)
                    yield f"data: {json.dumps(event)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            event_bus.unsubscribe(user_id, queue)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
