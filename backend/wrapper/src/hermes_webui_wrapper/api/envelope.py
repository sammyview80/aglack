"""One JSON envelope shape shared by every native (non-proxied) route this
wrapper exposes under `/api/wrapper/v1` — mirrors `rust_gateway`'s own
`src/response.rs` exactly, so the frontend has a single generic parser for
both backends (see `frontend/src/lib/api.ts`'s `apiFetch`/`ApiError`).

Success: `{ "ok": true, "data": <T> }`
Error:   `{ "ok": false, "error": { "code": "...", "message": "..." } }`

This does NOT apply to the catch-all proxy route in `app.py`, which relays
an upstream response body verbatim — that body belongs to upstream's own
(unwrapped) JSON convention, not this envelope.
"""
from __future__ import annotations

from typing import Any, Callable

from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from hermes_webui_wrapper.features.errors import FeatureError


def success(data: Any, status_code: int = 200) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"ok": True, "data": data})


def error(code: str, message: str, status_code: int) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"ok": False, "error": {"code": code, "message": message}},
    )


async def service_call(fn: Callable[..., Any], *args: Any) -> JSONResponse:
    """Run one blocking `features/*/service.py` function in a threadpool and
    map the result onto this envelope: a `FeatureError` (the shared base
    every feature's service errors subclass — see `features/errors.py`)
    becomes `error(...)`, anything else becomes `success(data)`.

    Every native route handler whose service function signals failure by
    raising should go through this instead of re-declaring its own
    per-feature copy of the same try/except (which is exactly what each of
    onboarding/agent-config/agent-seeder used to do). The threadpool hop is
    non-optional: every service function does real file I/O (sometimes a
    live HTTP probe) and must never be awaited directly on the event loop —
    see AGENTS.md rule 6.

    NOT for service functions that never raise and whose returned dict IS
    the result (e.g. onboarding's `probe_provider`, whose own `{"ok": bool}`
    payload must not be conflated with this envelope's `ok`) — those
    handlers stay hand-written at the call site, with a comment saying why.
    """
    try:
        data = await run_in_threadpool(fn, *args)
    except FeatureError as exc:
        return error(exc.code, exc.message, exc.status_code)
    return success(data)
