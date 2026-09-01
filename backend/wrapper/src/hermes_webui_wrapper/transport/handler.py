"""FakeHandler: bridges the stdlib BaseHTTPRequestHandler-shaped interface
that upstream's api/routes.py and api/helpers.py expect onto an ASGI
request/response cycle, so the pinned upstream handler functions
(handle_get, handle_post, handle_put, handle_patch, handle_delete,
check_auth, j(), the SSE helpers, etc.) can run completely UNMODIFIED
under this wrapper's ASGI app.

This module is adapted from ``api_adapter.py`` in the umbrella checkout
(MIT License, Copyright (c) the Hermes WebUI project and contributors).
None of upstream's ``api/*.py`` is changed by this adaptation; this module
only imitates the parts of ``http.server.BaseHTTPRequestHandler`` that
those functions touch:

    .path, .command, .headers (case-insensitive .get()), .rfile (readable),
    .wfile (writable + flush), .client_address, .connection.settimeout(),
    .send_response(code), .send_header(k, v), .end_headers(),
    plus arbitrary dynamic attributes (_pending_set_cookies,
    _csp_extra_connect_src, _trusted_auth_session_cookie_value, etc.) which
    work automatically since FakeHandler is a plain object.

Because the real handler functions are synchronous and blocking (and, for
SSE, long-lived and streaming), each request's dispatch runs on its own
worker thread. Bytes written to `.wfile` and the "headers are complete"
moment are bridged back to the ASGI/async world via an asyncio.Queue and an
asyncio.Future, both mutated safely from the worker thread with
`loop.call_soon_threadsafe`.

IMPORTANT: this module cannot import upstream's `api` package at module
import time -- bootstrap_upstream() (see ``transport/dispatcher.py`` and
``runtime.py``) must run first to put the pinned upstream checkout on
sys.path. `_build_csp_report_only_policy` is therefore imported lazily,
inside `end_headers()`, after bootstrap has already happened.

Header utilities live in `headers.py`, the loopback-proxy Origin/Host
alignment fix lives in `origin_alignment.py`, and the stdlib-shape stubs
(`TLSStub`/`NullConnection`/`AsyncBridgeWriter`) live in `stdlib_stubs.py`
-- all re-exported here so `app.py` and every existing test keep importing
from this one module.
"""
from __future__ import annotations

import asyncio
import email.message
import io
import threading
import time
from typing import Optional

from .headers import headers_from_raw, normalize_buffered_body_headers
from .origin_alignment import align_loopback_proxy_host
from .stdlib_stubs import EOF as _EOF
from .stdlib_stubs import AsyncBridgeWriter as _AsyncBridgeWriter
from .stdlib_stubs import NullConnection as _NullConnection
from .stdlib_stubs import TLSStub as _TLSStub

__all__ = [
    "FakeHandler",
    "align_loopback_proxy_host",
    "drain",
    "headers_from_raw",
    "normalize_buffered_body_headers",
]

_CSP_REPORT_TO = '{"group":"csp-endpoint","max_age":10886400,"endpoints":[{"url":"/api/csp-report"}]}'


class FakeHandler:
    """Stand-in for upstream server.py's Handler (a BaseHTTPRequestHandler
    subclass). One instance per request. Plain object -> arbitrary attribute
    assignment (`handler._pending_set_cookies = [...]`, etc.) just works,
    matching how upstream's api/auth.py and api/helpers.py stash per-request
    state on the handler.
    """

    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        method: str,
        path: str,
        headers: email.message.Message,
        body: bytes,
        client_address: tuple,
        scheme: str = "http",
    ):
        self.command = method
        self.path = path
        self.headers = headers
        self.rfile = io.BytesIO(body or b"")
        self.client_address = client_address
        self.connection = _NullConnection()
        self.request = _TLSStub() if scheme == "https" else None
        self.request_version = "HTTP/1.1"
        self.close_connection = False

        self._loop = loop
        self._status_code: Optional[int] = None
        self._headers_list: list[tuple[str, str]] = []
        self._headers_done = False
        self._headers_future: asyncio.Future = loop.create_future()
        self._chunk_queue: "asyncio.Queue" = asyncio.Queue()
        self._closed_event = threading.Event()
        self.wfile = _AsyncBridgeWriter(loop, self._chunk_queue, self._closed_event)
        self._req_t0 = time.time()

    # -- BaseHTTPRequestHandler-compatible API -----------------------------

    def send_response(self, code: int, message: str | None = None) -> None:
        self._status_code = code

    def send_response_only(self, code: int, message: str | None = None) -> None:
        self._status_code = code

    def send_header(self, key: str, value: str) -> None:
        # Intentionally NOT deduped: real Set-Cookie handling relies on being
        # able to send this header multiple times per response.
        self._headers_list.append((key, str(value)))

    def end_headers(self) -> None:
        if self._headers_done:
            return
        # Lazy import: upstream's api.helpers is only importable after
        # bootstrap_upstream() has put the pinned checkout on sys.path.
        from api.helpers import _build_csp_report_only_policy

        extra_connect_src = getattr(self, "_csp_extra_connect_src", None)
        extra_frame_src = getattr(self, "_csp_extra_frame_src", None)
        self._headers_list.append((
            "Content-Security-Policy-Report-Only",
            _build_csp_report_only_policy(extra_connect_src, extra_frame_src),
        ))
        self._headers_list.append(("Report-To", _CSP_REPORT_TO))
        if self._status_code is None:
            self._status_code = 200
        self._headers_done = True
        self._loop.call_soon_threadsafe(self._safe_set_headers_done)

    def _safe_set_headers_done(self) -> None:
        if not self._headers_future.done():
            self._headers_future.set_result(None)

    def log_message(self, fmt, *args) -> None:
        pass

    @staticmethod
    def _safe_webui_print(message: str) -> None:
        """Match upstream server.Handler's response-safe diagnostic logger."""
        try:
            print(message, flush=True)
        except Exception:
            pass

    # -- adapter-only lifecycle helper --------------------------------------

    def finish(self) -> None:
        """Called once from the worker thread after dispatch fully returns
        (success, handled exception, or fallback). Guarantees the ASGI side
        is always unblocked, even if the handler crashed before ever calling
        end_headers()."""
        if not self._headers_done:
            if self._status_code is None:
                self._status_code = 500
            self._headers_list.append(("Content-Type", "application/json"))
            self._headers_done = True
            self._loop.call_soon_threadsafe(self._safe_set_headers_done)
        if self._closed_event.is_set():
            return
        try:
            self._loop.call_soon_threadsafe(self._chunk_queue.put_nowait, _EOF)
        except RuntimeError:
            pass

    def close_transport(self) -> None:
        """Mark the transport closed. Safe to call from either the worker
        thread (via wfile.close()) or the event loop (StreamingResponse
        generator teardown/cancellation). Idempotent."""
        self._closed_event.set()


async def drain(handler: "FakeHandler"):
    """Async generator that yields body chunks written via handler.wfile
    until the worker thread signals completion. Always closes the transport
    on exit (normal completion, client disconnect, or generator
    cancellation) so any later handler.wfile.write() fails fast instead of
    queuing forever into an unbounded queue nobody is draining."""
    try:
        while True:
            chunk = await handler._chunk_queue.get()
            if chunk is _EOF:
                break
            yield chunk
    finally:
        handler.close_transport()
