"""Behavioral tests for the transport adapter: FakeHandler header/body
plumbing and dispatch() against injected UpstreamBindings (no real upstream
auth involved)."""
from __future__ import annotations

import asyncio
import json
from urllib.parse import urlparse

import pytest

from hermes_webui_wrapper.transport.dispatcher import UpstreamBindings, dispatch
from hermes_webui_wrapper.transport.handler import (
    FakeHandler,
    align_loopback_proxy_host,
    drain,
    headers_from_raw,
    normalize_buffered_body_headers,
)
from hermes_webui_wrapper.upstream import UpstreamInfo


def _run(coro):
    return asyncio.run(coro)


def _make_handler(*, method="GET", path="/x", body=b"", headers=None) -> FakeHandler:
    loop = asyncio.get_event_loop()
    return FakeHandler(
        loop=loop,
        method=method,
        path=path,
        headers=headers_from_raw(headers or []),
        body=body,
        client_address=("127.0.0.1", 12345),
    )


def test_duplicate_set_cookie_headers_are_both_retained() -> None:
    async def scenario():
        handler = _make_handler()
        handler.send_response(200)
        handler.send_header("Set-Cookie", "a=1; Path=/")
        handler.send_header("Set-Cookie", "b=2; Path=/")
        handler.end_headers()
        handler.finish()

        await handler._headers_future
        chunks = [chunk async for chunk in drain(handler)]

        return handler, chunks

    handler, chunks = _run(scenario())

    assert handler._status_code == 200
    set_cookie_headers = [v for k, v in handler._headers_list if k == "Set-Cookie"]
    assert set_cookie_headers == ["a=1; Path=/", "b=2; Path=/"]
    assert chunks == []


def _fake_bindings(*, method_handlers, apply_cors=None) -> UpstreamBindings:
    return UpstreamBindings(
        info=UpstreamInfo(owner="test-owner", revision="deadbeef"),
        check_auth=lambda handler, parsed: True,
        reset_trusted_auth_request_state=lambda handler: None,
        j=lambda handler, payload, status=200: (
            handler.send_response(status),
            handler.send_header("Content-Type", "application/json"),
            handler.end_headers(),
            handler.wfile.write(json.dumps(payload).encode()),
        ),
        get_profile_cookie=lambda handler: None,
        client_disconnect_errors=(),
        set_request_profile=lambda profile: None,
        clear_request_profile=lambda: None,
        apply_cors_preflight_headers=apply_cors or (lambda handler: None),
        method_handlers=method_handlers,
    )


def test_dispatch_post_handler_reads_body_and_query() -> None:
    captured = {}

    def fake_post(handler, parsed):
        captured["query"] = parsed.query
        length = int(handler.headers.get("Content-Length", "0"))
        captured["body"] = handler.rfile.read(length)
        handler.send_response(201)
        handler.send_header("Content-Type", "application/json")
        handler.end_headers()
        return True

    bindings = _fake_bindings(method_handlers={"POST": fake_post})

    async def scenario():
        handler = _make_handler(
            method="POST",
            path="/api/thing?foo=bar",
            body=b'{"k":"v"}',
            headers=[(b"Content-Length", str(len(b'{"k":"v"}')).encode())],
        )
        parsed = urlparse(handler.path)

        def _run_dispatch():
            dispatch(handler, parsed, "POST", bindings)

        import threading

        thread = threading.Thread(target=_run_dispatch, daemon=True)
        thread.start()
        await handler._headers_future
        [chunk async for chunk in drain(handler)]
        thread.join(timeout=2)
        return handler

    handler = _run(scenario())

    assert captured["query"] == "foo=bar"
    assert captured["body"] == b'{"k":"v"}'
    assert handler._status_code == 201


def test_dispatch_unknown_route_returns_404_via_j() -> None:
    def fake_get(handler, parsed):
        return False

    bindings = _fake_bindings(method_handlers={"GET": fake_get})

    async def scenario():
        handler = _make_handler(method="GET", path="/nope")
        parsed = urlparse(handler.path)
        dispatch(handler, parsed, "GET", bindings)
        await handler._headers_future
        chunks = [chunk async for chunk in drain(handler)]
        return handler, chunks

    handler, chunks = _run(scenario())

    assert handler._status_code == 404
    body = b"".join(chunks)
    assert json.loads(body) == {"error": "not found"}


def test_normalize_buffered_body_headers_strips_chunked_and_stale_length() -> None:
    body = b'{"k":"v"}'
    headers_msg = headers_from_raw([
        (b"Transfer-Encoding", b"chunked"),
        (b"Content-Length", b"1"),
        (b"Content-Length", b"999"),
    ])

    normalize_buffered_body_headers(headers_msg, body)

    assert "Transfer-Encoding" not in headers_msg
    assert headers_msg.get_all("Content-Length") == [str(len(body))]

    def fake_get(handler, parsed):
        length = int(handler.headers.get("Content-Length", "0"))
        read_body = handler.rfile.read(length)
        handler.send_response(200)
        handler.send_header("Content-Type", "application/json")
        handler.end_headers()
        handler.wfile.write(read_body)
        return True

    bindings = _fake_bindings(method_handlers={"GET": fake_get})

    async def scenario():
        handler = FakeHandler(
            loop=asyncio.get_event_loop(),
            method="GET",
            path="/x",
            headers=headers_msg,
            body=body,
            client_address=("127.0.0.1", 12345),
        )
        parsed = urlparse(handler.path)
        dispatch(handler, parsed, "GET", bindings)
        await handler._headers_future
        chunks = [chunk async for chunk in drain(handler)]
        return handler, chunks

    handler, chunks = _run(scenario())

    assert handler._status_code == 200
    assert b"".join(chunks) == body


def test_drain_cancellation_closes_transport_and_fails_later_writes() -> None:
    async def scenario():
        handler = _make_handler()
        handler.send_response(200)
        handler.end_headers()

        gen = drain(handler)
        # Prime the generator so it's parked awaiting the queue.
        started = asyncio.create_task(gen.__anext__())
        await asyncio.sleep(0)
        # No chunk was ever pushed, so started is still pending; cancel drain
        # via aclose() the way a StreamingResponse teardown would.
        started.cancel()
        with pytest.raises(asyncio.CancelledError):
            await started
        await gen.aclose()
        return handler

    handler = _run(scenario())

    assert handler.wfile.closed is True
    with pytest.raises(BrokenPipeError):
        handler.wfile.write(b"late")


def test_wfile_close_unblocks_drain() -> None:
    async def scenario():
        handler = _make_handler()
        handler.send_response(200)
        handler.end_headers()

        collected = []

        async def _collect():
            async for chunk in drain(handler):
                collected.append(chunk)

        task = asyncio.create_task(_collect())
        await asyncio.sleep(0)
        handler.wfile.close()
        await asyncio.wait_for(task, timeout=2)
        return handler, collected

    handler, collected = _run(scenario())

    assert collected == []
    assert handler.wfile.closed is True


# -- align_loopback_proxy_host ------------------------------------------
#
# Real live bug this guards against: rust_gateway's forward_to() strips the
# incoming Host header (reqwest sets the real target) but forwards Origin
# unchanged, so a request reaching this wrapper through the gateway/a
# container's published port carries Origin=http://localhost:5173 (the
# browser's real origin) against a Host naming the actual target address.
# Upstream's CSRF check (api/routes.py:_check_same_origin_browser_request)
# then rejects a legitimate same-machine browser session with 403
# "Cross-origin mismatch - check reverse proxy headers".
# align_loopback_proxy_host() exists to align Host with Origin before that
# check runs — but only when explicitly allowlisted via
# HERMES_WEBUI_ALLOWED_ORIGINS, and only for loopback-to-loopback requests.
# Before this test existed, only the always-empty-allowlist (early-return)
# path had any coverage at all — the actual rewrite this function exists
# for had never been exercised by a test.


def _headers_msg(pairs: dict[str, str]):
    return headers_from_raw([(k.encode(), v.encode()) for k, pairs_v in pairs.items() for v in [pairs_v]])


def test_align_loopback_proxy_host_rewrites_when_origin_allowlisted(monkeypatch) -> None:
    monkeypatch.setenv("HERMES_WEBUI_ALLOWED_ORIGINS", "http://localhost:5173")
    headers = _headers_msg({"Origin": "http://localhost:5173", "Host": "127.0.0.1:8787"})

    align_loopback_proxy_host(headers)

    assert headers["Host"] == "localhost:5173"


def test_align_loopback_proxy_host_leaves_host_when_origin_not_allowlisted(monkeypatch) -> None:
    monkeypatch.delenv("HERMES_WEBUI_ALLOWED_ORIGINS", raising=False)
    headers = _headers_msg({"Origin": "http://localhost:5173", "Host": "127.0.0.1:8787"})

    align_loopback_proxy_host(headers)

    assert headers["Host"] == "127.0.0.1:8787"


def test_align_loopback_proxy_host_never_rewrites_for_public_host(monkeypatch) -> None:
    monkeypatch.setenv("HERMES_WEBUI_ALLOWED_ORIGINS", "https://example.com")
    headers = _headers_msg({"Origin": "https://example.com", "Host": "tenant.example.com"})

    align_loopback_proxy_host(headers)

    assert headers["Host"] == "tenant.example.com"


def test_align_loopback_proxy_host_noop_when_host_already_matches_origin(monkeypatch) -> None:
    monkeypatch.setenv("HERMES_WEBUI_ALLOWED_ORIGINS", "http://localhost:5173")
    headers = _headers_msg({"Origin": "http://localhost:5173", "Host": "localhost:5173"})

    align_loopback_proxy_host(headers)

    assert headers["Host"] == "localhost:5173"
