"""In-process pub/sub that fans events out to each user's open browser tabs.

Webhook handlers run in FastAPI's threadpool while SSE streams run on the
event loop, so publish() hops onto the loop with call_soon_threadsafe.
Single-process only: if you later run several workers, swap this for Redis
pub/sub (same publish/subscribe interface).
"""

from __future__ import annotations

import asyncio
import uuid
from collections import defaultdict

_subscribers: dict[uuid.UUID, set[asyncio.Queue]] = defaultdict(set)
_loop: asyncio.AbstractEventLoop | None = None


def subscribe(user_id: uuid.UUID) -> asyncio.Queue:
    global _loop
    _loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue(maxsize=100)
    _subscribers[user_id].add(queue)
    return queue


def unsubscribe(user_id: uuid.UUID, queue: asyncio.Queue) -> None:
    _subscribers[user_id].discard(queue)
    if not _subscribers[user_id]:
        _subscribers.pop(user_id, None)


def publish(user_id: uuid.UUID, event: dict) -> None:
    """Safe to call from any thread."""

    if _loop is None:
        return

    def _put() -> None:
        for queue in list(_subscribers.get(user_id, ())):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                pass  # slow client; it will catch up on its next refetch

    _loop.call_soon_threadsafe(_put)
