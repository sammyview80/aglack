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
"""
from __future__ import annotations

import asyncio
import email.message
import io
import os
import threading
import time
from typing import Optional

_CSP_REPORT_TO = '{"group":"csp-endpoint","max_age":10886400,"endpoints":[{"url":"/api/csp-report"}]}'

# Sentinel pushed into the chunk queue to signal "no more body bytes".
_EOF = object()


def headers_from_raw(raw_headers) -> email.message.Message:
    """Build a case-insensitive header container matching http.client.HTTPMessage.

    `raw_headers` is Starlette's `Headers.raw`: a list[tuple[bytes, bytes]].
    email.message.Message (the base class of http.client.HTTPMessage) performs
    case-insensitive lookups, exactly like the real handler.headers object.
    """
    msg = email.message.Message()
    for k, v in raw_headers:
        msg[k.decode("latin-1")] = v.decode("latin-1")
    return msg


def normalize_buffered_body_headers(headers_msg, body: bytes) -> None:
    """Reconcile transfer-framing headers with the fully-buffered body.

    Starlette's `Request.body()` already de-chunks and fully buffers the
    request body, but the original `Transfer-Encoding: chunked` and/or a
    stale `Content-Length` header may still be present in `headers_msg`.
    Upstream's handler reads exactly `Content-Length` bytes from `.rfile`
    and never de-chunks, so a leftover `Transfer-Encoding` (or a
    `Content-Length` that no longer matches the buffered body) makes it read
    zero/wrong bytes despite the body being fully available. Delete both
    headers case-insensitively, then set exactly one `Content-Length`
    matching the buffered body.
    """
    for name in ("Transfer-Encoding", "Content-Length"):
        while name in headers_msg:
            del headers_msg[name]
    headers_msg["Content-Length"] = str(len(body))


def _is_loopback_host(host: str) -> bool:
    name = (host or "").strip().lower()
    if not name:
        return False
    if name.startswith("["):
        return name.startswith("[::1]")
    hostname = name.rsplit("@", 1)[-1]
    if ":" in hostname and not hostname.count(":") > 1:
        hostname = hostname.rsplit(":", 1)[0]
    return hostname in {"127.0.0.1", "localhost", "::1"}


def align_loopback_proxy_host(headers_msg) -> None:
    """When a local reverse proxy rewrites Host, align it with browser Origin.

    Vite/webpack often forward ``Origin: http://127.0.0.1:5173`` but set
    ``Host: 127.0.0.1:8787``. CSRF then fails with "Cross-origin mismatch".
    Only rewrite when both sides are loopback -- never for public hosts.
    Fully self-contained: reads only the given headers_msg and the
    HERMES_WEBUI_ALLOWED_ORIGINS env var, mutates only headers_msg.
    """
    import re

    origin = (headers_msg.get("Origin") or "").strip()
    host = (headers_msg.get("Host") or "").strip()
    if not origin or not host:
        return
    m = re.match(r"^(https?)://([^/]+)", origin, re.I)
    if not m:
        return
    origin_host = m.group(2).strip()
    if not origin_host or origin_host.lower() == host.lower():
        return
    if not (_is_loopback_host(origin_host) and _is_loopback_host(host)):
        return
    allowed_origins = {
        value.strip().rstrip("/").lower()
        for value in os.getenv("HERMES_WEBUI_ALLOWED_ORIGINS", "").split(",")
        if value.strip()
    }
    if origin.rstrip("/").lower() not in allowed_origins:
        return
    try:
        del headers_msg["Host"]
    except KeyError:
        pass
    headers_msg["Host"] = origin_host


class _TLSStub:
    """Minimal stand-in for an ssl.SSLSocket, used only so
    `getattr(handler.request, 'getpeercert', None)` in api/auth.py's
    _is_secure_context() resolves truthy when the ASGI server terminated
    TLS itself."""

    def getpeercert(self, *_a, **_kw):
        return {}


class _NullConnection:
    """Stub for handler.connection. Only .settimeout() is ever called on the
    write path we exercise (SSE write-deadline); everything else no-ops."""

    def settimeout(self, *_a, **_kw):
        return None

    def __getattr__(self, _name):
        def _noop(*_a, **_kw):
            return None
        return _noop


class _AsyncBridgeWriter:
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
            self._loop.call_soon_threadsafe(self._queue.put_nowait, _EOF)
        except RuntimeError:
            pass


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
