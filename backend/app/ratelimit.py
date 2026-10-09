"""In-process sliding-window limiter; the app runs as a single uvicorn worker."""
import time
from collections import defaultdict, deque
from threading import Lock

from fastapi import HTTPException

class RateLimit:
    def __init__(self, limit: int, seconds: float):
        self.limit, self.seconds = limit, seconds
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = Lock()

    def hit(self, key: str) -> None:
        now = time.monotonic()
        with self._lock:
            if len(self._hits) > 5000:  # forget idle clients instead of growing forever
                for stale in [k for k, q in self._hits.items() if not q or now - q[-1] > self.seconds]:
                    del self._hits[stale]
            hits = self._hits[key]
            while hits and now - hits[0] > self.seconds:
                hits.popleft()
            if len(hits) >= self.limit:
                raise HTTPException(429, "Demasiados intentos seguidos. Espera unos minutos.")
            hits.append(now)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()
