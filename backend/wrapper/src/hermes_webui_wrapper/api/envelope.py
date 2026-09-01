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

from typing import Any

from fastapi.responses import JSONResponse


def success(data: Any, status_code: int = 200) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"ok": True, "data": data})


def error(code: str, message: str, status_code: int) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"ok": False, "error": {"code": code, "message": message}},
    )
