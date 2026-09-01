"""Minimal stand-ins for the parts of a real socket/connection object
upstream's handler functions touch, so FakeHandler never needs a real
socket underneath it.
"""
from __future__ import annotations

import asyncio
import threading

# Sentinel pushed into the chunk queue to signal "no more body bytes".
EOF = object()


class TLSStub:
    """Minimal stand-in for an ssl.SSLSocket, used only so
    `getattr(handler.request, 'getpeercert', None)` in api/auth.py's
    _is_secure_context() resolves truthy when the ASGI server terminated
    TLS itself."""

    def getpeercert(self, *_a, **_kw):
        return {}


class NullConnection:
    """Stub for handler.connection. Only .settimeout() is ever called on the
    write path we exercise (SSE write-deadline); everything else no-ops."""

    def settimeout(self, *_a, **_kw):
        return None

    def __getattr__(self, _name):
        def _noop(*_a, **_kw):
            return None
        return _noop


class AsyncBridgeWriter:
    """Drop-in replacement for handler.wfile.

    write()/flush() are called synchronously from the worker thread; each
    write schedules a thread-safe put onto the asyncio.Queue that the ASGI
    StreamingResponse generator drains on the event loop.

    `closed_event` is shared with the owning FakeHandler: once the ASGI side
    tears down the transport (client disconnect, generator cancellation),
    further writes must fail fast instead of queuing forever into an
    unbounded queue nobody is draining.
    """

    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        queue: "asyncio.Queue",
        closed_event: threading.Event,
    ):
        self._loop = loop
        self._queue = queue
        self._closed_event = closed_event

    @property
    def closed(self) -> bool:
        return self._closed_event.is_set()

    def write(self, data) -> int:
        if self._closed_event.is_set():
            raise BrokenPipeError("transport closed")
        if not data:
            return 0
        payload = bytes(data)
        try:
            self._loop.call_soon_threadsafe(self._queue.put_nowait, payload)
        except RuntimeError as exc:
            raise BrokenPipeError("transport closed") from exc
        return len(payload)

    def flush(self) -> None:
        pass

    def close(self) -> None:
        # Some SSE code paths wrap/replace handler.wfile and call this close()
        # directly (e.g. upstream closing its own wfile handle) without ever
        # reaching FakeHandler.finish()/close_transport(). Best-effort enqueue
        # the EOF sentinel so an in-progress drain() is never left waiting
        # forever on a queue nobody else will push to.
        if self._closed_event.is_set():
            return
        self._closed_event.set()
        try:
            self._loop.call_soon_threadsafe(self._queue.put_nowait, EOF)
        except RuntimeError:
            pass
