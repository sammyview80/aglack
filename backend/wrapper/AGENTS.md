# AGENTS.md — hermes-webui-wrapper

FastAPI wrapper around the pinned upstream Hermes Web UI (see
`../UPSTREAM.md`). Two request paths exist side by side — know which one
any change belongs to before writing code:

1. **Proxied catch-all** (`app.py`'s `/{full_path:path}` route +
   `transport/`) — every upstream endpoint not natively reimplemented here.
   Replays upstream's raw stdlib `server.py` dispatch through a
   `FakeHandler` adapter, one worker thread per request. Correct for
   anything not worth reimplementing, but carries that thread + handler-
   emulation overhead on every call.
2. **Native routes** (`api/v1/*.py` + `features/*/service.py`) — a small,
   growing set of endpoints that call upstream's `api.*` functions
   *directly* (no `FakeHandler`, no per-request thread, no stdlib dispatch
   replay), wrapped in FastAPI's own request/response handling and the
   shared JSON envelope (`api/envelope.py`). Build a feature here instead
   of relying on the catch-all when the upstream function you need is a
   plain `dict -> dict` function (not one written directly against
   `BaseHTTPRequestHandler`) — `features/onboarding/` is the reference
   example; read it before adding a second feature.

**Before implementing any feature, check whether upstream already exposes
it as a plain function in `../upstream/api/*.py`.** If it does, wrap that
function (see "Adding a native feature" below) rather than reimplementing
its logic — the wrapper must never duplicate upstream's business logic
(config.yaml/.env writes, provider catalogs, OAuth flows, ...), only expose
it faster.

## Rules

1. **Never import upstream at module import time outside the bootstrap
   path.** Every `api.*` / `hermes_cli.*` symbol is resolved lazily, inside
   a function body, after `bootstrap_upstream()` has already run for this
   process — exactly as `transport/dispatcher.py` and every
   `features/*/service.py` already do. Importing upstream at module level
   anywhere else breaks the "wrapper is independently packageable" property
   `README.md` documents.
2. **No hardcoded host/port/URL/state-path anywhere.** Every address and
   state directory comes from `config.py`'s `Settings.from_env()` or the
   `HERMES_*` / `HERMES_WEBUI_*` env vars already documented in
   `.env.example`. **Browser CORS for native `/api/wrapper/v1/*` routes**
   uses required `HERMES_FRONTEND_ORIGIN` (Vite origin, same value as
   rust_gateway's `FRONTEND_ORIGIN`). Catch-all proxied OPTIONS still uses
   upstream's own CORS helper in `transport/dispatcher.py`. Test isolation
   (tmp `HERMES_HOME`, etc.) happens in `tests/conftest.py`, never by
   hardcoding a path in a test module.
3. **Test-driven.** A failing test before the fix/feature; make it pass;
   keep it. Prefer `fastapi.testclient.TestClient` calling the app exactly
   as `tests/test_app.py` and `tests/v1/test_onboarding.py` already do —
   real upstream, real (isolated) state, not upstream mocks. Mocking is
   acceptable only for things genuinely outside this repo's control (a
   third-party OAuth provider's network response, say) — never for
   upstream's own `api.*` functions themselves.
4. **A native feature route must map errors the same way the proxied
   route already did.** Check `../upstream/api/routes.py`'s handler for the
   equivalent endpoint before writing a feature's error mapping — copy its
   exception-type -> HTTP-status mapping (see `features/onboarding/service.py`'s
   `_wrap()` for the pattern: upstream's plain `ValueError`/`RuntimeError`/
   `KeyError` mapped to 400/500/404, matching `api/routes.py`'s own
   `ValueError -> bad(handler, str(e))` / `RuntimeError -> ... , 500)`
   convention for that same endpoint) rather than inventing a new mapping.
5. **Every native route response uses the shared envelope**
   (`api/envelope.py`'s `success()`/`error()`): `{ok: true, data}` /
   `{ok: false, error: {code, message}}`. This matches `rust_gateway`'s own
   `src/response.rs` exactly, on purpose — the frontend's
   `src/lib/api.ts` (`apiFetch`/`ApiError`) is one generic parser for both
   backends. Do not invent a different shape for a new feature; do not
   apply this envelope to the catch-all proxy route (that body is
   upstream's own, unwrapped, verbatim).
6. **Blocking upstream calls run in a threadpool, never awaited directly.**
   Upstream's plain functions do real file I/O, YAML parsing, and
   sometimes a live outbound HTTP probe — call them via
   `fastapi.concurrency.run_in_threadpool` from an `async def` route (see
   every handler in `api/v1/onboarding.py`), so one slow call never blocks
   the event loop for other tenants'/requests' native routes.

## Structure

```
src/hermes_webui_wrapper/
├── app.py                  create_app(): wrapper router first, catch-all proxy last
├── config.py                Settings.from_env() — the ONE place env vars are read
├── upstream.py               bootstrap_upstream(): validates + imports pinned upstream `api`
├── runtime.py                 best-effort start_runtime()/stop_runtime() parity layer
├── transport/                 FakeHandler + dispatch() — the PROXIED path only
│   ├── handler.py
│   └── dispatcher.py
├── api/
│   ├── router.py              mounts every api/v1/*.py router under /api/wrapper/v1
│   ├── envelope.py            shared {ok,data}/{ok,error} JSON envelope (rule 5)
│   └── v1/
│       ├── system.py          wrapper's own /health — no upstream call at all
│       └── onboarding.py      NATIVE feature router — the reference example
└── features/                  one subpackage per business capability, independent
    │                           of any api/ version — a future v2 or non-HTTP
    │                           transport reuses these without duplicating logic
    └── onboarding/
        ├── service.py          thin sync functions calling upstream api.onboarding/
        │                       api.oauth directly; OnboardingError + status mapping
        └── schemas.py          pydantic request/response models for this feature only

tests/
├── conftest.py                 isolated tmp HERMES_HOME/state dirs, runtime disabled
├── test_app.py                 catch-all + wrapper-route-precedence behavior
├── test_transport.py, test_upstream.py
└── v1/
    └── test_onboarding.py       native onboarding route tests (real upstream, no mocks)
```

New env var -> `config.py`. New PROXIED behavior change -> `transport/`
(keep `dispatch()` a faithful mirror of upstream's `server.py` Handler; see
`README.md`'s "Extension rules"). New NATIVE feature -> a new
`features/<name>/` package + a new `api/v1/<name>.py` router mounted from
`api/router.py`, following the steps below. No empty placeholder folders —
`features/` gets a new subpackage only once a feature actually needs one.

There is deliberately no `features/image/`, `features/video/`,
`features/web_search/`, or `features/gateway/` yet (as of this writing,
this repo's chat-model onboarding is `features/onboarding/`; those four
would be *sibling* concerns — image-generation, video-generation,
web-search, and chat-platform-bridge provider onboarding — not part of
`features/onboarding/` itself): none of the four have any consumer
anywhere in upstream Hermes agent/WebUI today (confirmed by grep — no
`image_provider`/`video_provider`/`web_search`/equivalent config concept
exists), so there is nowhere real to persist their credentials yet either.
Design that storage question deliberately (don't silently reuse
upstream's `.env`/`config.yaml`, which nothing reads these keys from) the
day one of these actually needs a home — see this file's git history/PR
discussion for the storage-options tradeoff already considered once.

## Adding a native feature (the `features/onboarding/` pattern)

1. Confirm the upstream function you need is a plain function taking/
   returning plain data (dict/str/bool), not something written directly
   against a `BaseHTTPRequestHandler` — if it isn't, it belongs behind the
   proxied catch-all instead, not a native route.
2. `features/<name>/service.py` — one thin function per upstream call,
   lazily importing the upstream symbol inside the function body (rule 1).
   Define a `<Name>Error` exception carrying `code`/`message`/`status_code`,
   and a `_wrap()`-style helper that maps upstream's plain exceptions to it
   using the SAME status codes `api/routes.py` already used for that
   endpoint (rule 4).
3. `features/<name>/schemas.py` — pydantic models for the HTTP-facing
   request/response shapes. Prefer permissive `dict[str, Any]` for large
   nested payloads upstream owns the shape of (avoids re-duplicating a
   shape that changes independently of this wrapper) over re-typing every
   field.
4. `api/v1/<name>.py` — `build_router()` returning an `APIRouter`; every
   handler is `async def`, calls `service.*` via `run_in_threadpool` (rule
   6), catches the feature's error type, and returns `envelope.success()` /
   `envelope.error()` (rule 5).
5. Mount it in `api/router.py`.
6. `tests/v1/test_<name>.py` — real upstream, isolated state (rule 3). At
   minimum: one success case, one upstream-`ValueError` case, one
   not-proxied-through-`dispatch()` case (mirrors
   `test_status_is_native_not_proxied_through_dispatch`).

## Known current gap — no auth gate on native onboarding routes

Upstream's own onboarding mutation endpoints (`setup`, `oauth/start`,
`complete`, `probe`) are protected by `_onboarding_gate_allows` — allowed
unauthenticated only from a local/private network origin (checked against
the raw, unspoofable socket peer), or unconditionally once real auth is
enabled. **The native routes in `api/v1/onboarding.py` have no equivalent
gate today** — this wrapper has no session/login layer yet at all (see
`rust_gateway`'s own "no auth... yet" checkpoint note), so porting
upstream's local-network exception here would be a false sense of
security, not a real one; and upstream's exact IP-based gate does not
obviously translate to a tenant sitting behind this project's own Rust
gateway/reverse proxy in the first place. Add real authentication in front
of this service before this gap matters in anything but local dev — do not
paper over it with IP-based logic that doesn't fit this project's actual
deployment shape.

## Testing

```bash
cd backend/wrapper
python3.11 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
PYTHONPATH=src python -m pytest -q
```

Requires a pinned `../upstream` checkout on disk (see `../UPSTREAM.md`) —
tests bootstrap and exercise the REAL upstream `api.*` functions against an
isolated tmp `HERMES_HOME` (`tests/conftest.py`), not mocks.

## Boundary

`rust_gateway` (Rust/axum) is a separate process, reached over HTTP only,
if/when this wrapper ever needs to be reached through it. No code
dependency either direction. `../upstream` is a read-only vendored
checkout — see `../UPSTREAM.md`; this wrapper only imports its `api.*`
symbols, never edits it.
