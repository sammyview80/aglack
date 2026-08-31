"""Loads pinned upstream request-handling symbols once, and dispatches a
single request through them exactly as upstream's server.py Handler does.

No business logic lives here: dispatch() is a line-for-line mirror of
upstream/server.py's do_GET / _handle_write / do_OPTIONS (lines ~374-447),
retargeted at the FakeHandler adapter instead of a real socket handler.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from hermes_webui_wrapper.upstream import UpstreamInfo, bootstrap_upstream

from .handler import FakeHandler


@dataclass(frozen=True)
class UpstreamBindings:
    info: UpstreamInfo
    check_auth: Callable
    reset_trusted_auth_request_state: Callable
    j: Callable
    get_profile_cookie: Callable
    client_disconnect_errors: tuple
    set_request_profile: Callable
    clear_request_profile: Callable
    apply_cors_preflight_headers: Callable
    method_handlers: dict


def load_bindings(settings) -> UpstreamBindings:
    """Bootstrap upstream (if not already) and resolve the exact symbols
    upstream's server.py Handler uses, once per process."""
    info = bootstrap_upstream(settings)

    from api.auth import check_auth, reset_trusted_auth_request_state
    from api.helpers import _CLIENT_DISCONNECT_ERRORS, get_profile_cookie, j
    from api.profiles import clear_request_profile, set_request_profile
    from api.routes import (
        apply_cors_preflight_headers,
        handle_delete,
        handle_get,
        handle_patch,
        handle_post,
        handle_put,
    )

    return UpstreamBindings(
        info=info,
        check_auth=check_auth,
        reset_trusted_auth_request_state=reset_trusted_auth_request_state,
        j=j,
        get_profile_cookie=get_profile_cookie,
        client_disconnect_errors=tuple(_CLIENT_DISCONNECT_ERRORS),
        set_request_profile=set_request_profile,
        clear_request_profile=clear_request_profile,
        apply_cors_preflight_headers=apply_cors_preflight_headers,
        method_handlers={
            "GET": handle_get,
            "POST": handle_post,
            "PUT": handle_put,
            "PATCH": handle_patch,
            "DELETE": handle_delete,
        },
    )


def dispatch(handler: FakeHandler, parsed, method: str, bindings: UpstreamBindings) -> None:
    """Mirror upstream/server.py Handler.do_GET / _handle_write / do_OPTIONS.

    Always calls handler.finish() before returning, so the ASGI side of the
    adapter is never left blocked regardless of how dispatch ends.
    """
    try:
        if method == "OPTIONS":
            handler.send_response(200)
            bindings.apply_cors_preflight_headers(handler)
            handler.send_header("Content-Length", "0")
            handler.end_headers()
            return

        bindings.reset_trusted_auth_request_state(handler)
        cookie_profile = bindings.get_profile_cookie(handler)
        if cookie_profile:
            bindings.set_request_profile(cookie_profile)

        try:
            is_csp_report_post = (
                parsed.path == "/api/csp-report" and method == "POST"
            )
            if method == "GET":
                if not bindings.check_auth(handler, parsed):
                    return
                result = bindings.method_handlers["GET"](handler, parsed)
            else:
                route_func = bindings.method_handlers[method]
                if not is_csp_report_post and not bindings.check_auth(handler, parsed):
                    return
                result = route_func(handler, parsed)

            if result is False:
                bindings.j(handler, {"error": "not found"}, status=404)
        except bindings.client_disconnect_errors:
            # Expected disconnect path; do not convert it into a misleading 500.
            return
        except Exception:
            import traceback

            handler._safe_webui_print(
                f"[webui] ERROR {handler.command} {handler.path}\n" + traceback.format_exc()
            )
            try:
                bindings.j(handler, {"error": "Internal server error"}, status=500)
            except bindings.client_disconnect_errors:
                pass
            except Exception:
                handler._safe_webui_print(traceback.format_exc())
        finally:
            bindings.clear_request_profile()
    finally:
        handler.finish()
