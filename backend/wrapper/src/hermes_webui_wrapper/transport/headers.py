"""Pure header utilities shared by the FakeHandler adapter path."""
from __future__ import annotations

import email.message


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
