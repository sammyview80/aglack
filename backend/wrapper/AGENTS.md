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

**`features/agent_seeder/` is a special case: mechanics vs. glue.** The
actual MCP-tool-discovery, seeder-tree-parsing, and skill-copying logic
lives in `../seeder_kit/` — a separate, framework-agnostic, independently
installable/testable Python package with ZERO Hermes/upstream knowledge
(see `../seeder_kit/README.md`). `features/agent_seeder/service.py` is
only the thin Hermes-specific glue that calls `seeder_kit`'s functions and
then calls `api.profiles`/`features.agent_config`. If you're adding
mechanics that don't need to know what a Hermes profile is (a new
discovery rule, a new tree-parsing field, a new skill-copy option), it
belongs in `../seeder_kit/`, not here — keep the same split when extending
this feature.

## Runtime environment — this program runs in Docker

**Never inspect, reference, or reason about any host-machine Hermes
install** (e.g. a developer's local `~/.hermes`, a locally `pip install`-ed
`hermes_cli`, or any other machine-specific checkout). This program's real
runtime is a Docker container; the only legitimate source of truth for
upstream's shape is the pinned, read-only checkout at `../upstream/` (see
`../UPSTREAM.md`) and its own vendored `hermes_cli` dependency as declared
in that checkout's own `requirements*.txt`/`pyproject.toml` — not whatever
happens to be installed on the machine running the agent. If you need to
confirm a `hermes_cli` function's exact signature or behavior and it is not
vendored inside `../upstream/`, say so explicitly rather than reading it
from the host machine.

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
│   ├── handler.py               FakeHandler + drain() only; re-exports the
│   │                             three files below so app.py/tests keep one
│   │                             import line — do not import those three
│   │                             directly from outside transport/
│   ├── headers.py                headers_from_raw / normalize_buffered_body_headers
│   ├── origin_alignment.py       align_loopback_proxy_host (loopback reverse-
│   │                             proxy Origin/Host CSRF fix — see its own
│   │                             docstring before touching)
│   ├── stdlib_stubs.py           TLSStub / NullConnection / AsyncBridgeWriter
│   └── dispatcher.py
├── api/
│   ├── router.py              mounts every api/v1/*.py router under /api/wrapper/v1
│   ├── envelope.py            shared {ok,data}/{ok,error} JSON envelope (rule 5)
│   │                           + service_call(): the ONE threadpool +
│   │                           FeatureError->error-envelope helper every
│   │                           native route handler uses — never re-declare
│   │                           a per-feature copy of that try/except
│   └── v1/
│       ├── system.py          wrapper's own /health — no upstream call at all
│       ├── onboarding.py      NATIVE feature router — the reference example
│       ├── agent_config.py    NATIVE feature router — update a named profile's
│       │                       SOUL.md + workspace AGENTS.md (GET/PUT
│       │                       .../{name}/soul, .../{name}/agents-md)
│       ├── agent_seeder.py    NATIVE feature router — apply the ../../seeder/
│       │                       tree, scoped by mode (GET .../modes,
│       │                       POST .../{mode}/apply, .../{mode}/apply/{name})
│       └── agent_history.py   NATIVE feature router — read-only per-agent
│                               chat history (GET .../agents, .../agents/{name}/
│                               sessions, .../agents/{name}/sessions/{session_id}/messages)
└── features/                  one subpackage per business capability, independent
    │                           of any api/ version — a future v2 or non-HTTP
    │                           transport reuses these without duplicating logic
    ├── errors.py               FeatureError — the shared code/message/status_code
    │                           base every feature's service error subclasses
    │                           (OnboardingError/AgentConfigError/AgentSeederError);
    │                           api/envelope.py's service_call catches this base
    ├── profile_yaml.py         load_profile_config/save_profile_config — the one
    │                           read/write path for a profile's config.yaml
    │                           (raises plain ValueError/OSError; each caller
    │                           translates to its own feature error code)
    ├── onboarding/
    │   ├── service.py          thin sync functions calling upstream api.onboarding/
    │   │                       api.oauth directly; OnboardingError + status mapping
    │   └── schemas.py          pydantic request/response models for this feature only
    ├── agent_config/
    │   ├── service.py          get_soul/update_soul + get_agent_instructions/
    │   │                       update_agent_instructions calling upstream
    │   │                       api.profiles.get_hermes_home_for_profile directly;
    │   │                       AgentConfigError + 404-on-unknown-profile mapping.
    │   │                       See its own module docstring for why AGENTS.md is
    │   │                       workspace-level here, not profile-level (no
    │   │                       per-profile AGENTS.md or writable profile.yaml
    │   │                       description exist in this pinned upstream checkout)
    │   └── schemas.py          pydantic request models for this feature only
    ├── agent_seeder/           THIN GLUE ONLY — mechanics live in ../../../../seeder_kit/
    │   ├── service.py          parses ../../../../seeder/ via seeder_kit.parse_tree
    │   │                       (mode-scoped — see that module's own docstring for why
    │   │                       per-agent content is mode-scoped but global tools/skills
    │   │                       are not), then applies it via create_profile_api
    │   │                       (new profiles clone the root profile's config.yaml/
    │   │                       .env via clone_from/clone_config=True, so a seeded
    │   │                       agent inherits model provider + API key; root name
    │   │                       resolved via list_profiles_api()'s is_default row,
    │   │                       never hardcoded "default"; soft no-op if root has
    │   │                       no model yet; never re-applied to an existing
    │   │                       profile) + _ensure_agent_workspace (creates a real
    │   │                       <agent-workspaces-root>/<slug>/ dir + writes it into
    │   │                       config.yaml as `workspace`, only if none is set yet —
    │   │                       config.resolve_agent_workspaces_root() derives the root
    │   │                       from HERMES_WEBUI_DEFAULT_WORKSPACE's own parent) +
    │   │                       features.agent_config + seeder_kit.copy_skill_dirs +
    │   │                       seeder_kit.discover_tools_in_dirs +
    │   │                       seeder_kit.build_mcp_server_entry (one mcp_servers
    │   │                       config.yaml entry per agent). list_modes() wraps
    │   │                       seeder_kit.available_modes()
    │   └── schemas.py          no request body needed for any route
    └── agent_history/          READ-ONLY — never calls set_request_profile/
        └── service.py          switch_profile, no global/thread state mutation.
                                No schemas.py: every route is a GET with no
                                request body. list_agents() enumerates the
                                profiles directory from the FILESYSTEM, not
                                list_profiles_api() (that function silently
                                falls back to a default-only row when
                                hermes_cli is not importable — same trap
                                features/agent_config/service.py documents).
                                Sessions attributed via upstream
                                api.profiles._profiles_match (handles default/
                                renamed-root aliasing + legacy untagged rows).
                                Loading a session whose profile tag does not
                                match the requested agent -> 404 (cross-agent
                                isolation: one agent cannot read another's
                                transcript by guessing a session id).
                                Pagination limit default 50 / hard cap 200;
                                negative or non-integer limit/offset -> 400 in
                                the shared envelope (routes take limit/offset
                                as raw strings so FastAPI never emits a raw
                                non-enveloped 422)

tests/
├── conftest.py                 isolated tmp HERMES_HOME/state dirs, runtime disabled
├── test_app.py                 catch-all + wrapper-route-precedence behavior
├── test_transport.py, test_upstream.py
└── v1/
    ├── test_onboarding.py       native onboarding route tests (real upstream, no mocks)
    ├── test_agent_config.py     native agent-config route tests (real upstream, no mocks)
    ├── test_agent_seeder.py     native agent-seeder route tests (real upstream, synthetic
    │                             seeder/ tree — see that file's own docstring for why)
    └── test_agent_history.py    native agent-history route tests (real upstream, isolated
                                  tmp state, no mocks)
```

`../seeder_kit/` (sibling of `upstream/` and this wrapper) is its own
installable package with its own `tests/` — see
`../seeder_kit/README.md` for its module map and design principles.

New agent/tool/skill CONTENT -> `../seeder/` (see `../seeder/README.md`),
never invented ad hoc inside `wrapper/`. New host-agnostic MECHANICS
(discovery rules, tree-parsing fields, skill-copy options) -> `../seeder_kit/`.
New WRAPPER capability the seeder or agent-config needs (e.g. a real
per-profile `AGENTS.md` once a future upstream pin adds one) ->
`features/agent_config/` or a new `features/<name>/`, following "Adding a
native feature" below — the seeder's own `service.py` calls those, it does
not reimplement them.

New env var -> `config.py`. New PROXIED behavior change -> `transport/`
(keep `dispatch()` a faithful mirror of upstream's `server.py` Handler; see
`README.md`'s "Extension rules") — put it in the file matching its concern
(header handling -> `headers.py`, Origin/Host/CSRF -> `origin_alignment.py`,
a new stdlib-shape stub -> `stdlib_stubs.py`, FakeHandler's own request/
response lifecycle -> `handler.py`), not inline in `handler.py` regardless
of concern. New NATIVE feature -> a new
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
   Define a `<Name>Error` subclassing `features/errors.py`'s `FeatureError`
   (never a from-scratch exception — the shared base is what
   `api/envelope.py`'s `service_call` catches), and a `_wrap()`-style
   helper that maps upstream's plain exceptions to it using the SAME
   status codes `api/routes.py` already used for that endpoint (rule 4).
   Reading/writing a profile's config.yaml goes through
   `features/profile_yaml.py`, translating its plain ValueError/OSError to
   your feature's own error codes.
3. `features/<name>/schemas.py` — pydantic models for the HTTP-facing
   request/response shapes. Prefer permissive `dict[str, Any]` for large
   nested payloads upstream owns the shape of (avoids re-duplicating a
   shape that changes independently of this wrapper) over re-typing every
   field.
4. `api/v1/<name>.py` — `build_router()` returning an `APIRouter`; every
   handler is `async def` and returns
   `await envelope.service_call(service.fn, args...)` (rules 5+6 in one
   call — threadpool hop + FeatureError mapping; do NOT re-declare a
   per-feature `_call` copy). Hand-write a handler only for a service
   function that never raises and whose returned dict IS the result (see
   onboarding's `probe`).
5. Mount it in `api/router.py`.
6. `tests/v1/test_<name>.py` — real upstream, isolated state (rule 3). At
   minimum: one success case, one upstream-`ValueError` case, one
   not-proxied-through-`dispatch()` case (mirrors
   `test_status_is_native_not_proxied_through_dispatch`).

## Known current gap — no auth gate on native onboarding/agent-config/agent-seeder/agent-history routes

Upstream's own onboarding mutation endpoints (`setup`, `oauth/start`,
`complete`, `probe`) are protected by `_onboarding_gate_allows` — allowed
unauthenticated only from a local/private network origin (checked against
the raw, unspoofable socket peer), or unconditionally once real auth is
enabled. **The native routes in `api/v1/onboarding.py`,
`api/v1/agent_config.py`, `api/v1/agent_seeder.py`, and
`api/v1/agent_history.py` have no equivalent gate today** — this wrapper
has no session/login layer yet at all (see
`rust_gateway`'s own "no auth... yet" checkpoint note), so porting
upstream's local-network exception here would be a false sense of
security, not a real one; and upstream's exact IP-based gate does not
obviously translate to a tenant sitting behind this project's own Rust
gateway/reverse proxy in the first place. `agent-seeder` in particular can
create profiles and rewrite `config.yaml`/`SOUL.md`/`AGENTS.md` for every
agent in a mode's `seeder/modes/<mode>/agents/` in one call — treat it as
at least as sensitive as onboarding's own mutation endpoints. It now has a
real UI caller too: `frontend`'s `/mode/:workspaceId` screen (Simple mode,
see `frontend/AGENTS.md`'s "Agent seeder" rule) calls
`POST /workspaces/:id/agent-seeder/simple/apply` on `rust_gateway`
(`agent_seeder_proxy.rs`), which forwards here — this is no longer a
theoretical exposure. `agent-history` is READ-ONLY — it never mutates
`config.yaml`/`SOUL.md`/`AGENTS.md` or any profile state, unlike the three
above — but without a gate any caller can still read every agent's chat
transcripts for a workspace, which is its own exposure. Add real
authentication in front of this service before any of this matters in
anything but local dev — do not paper over it with IP-based logic that
doesn't fit this project's actual deployment shape.

## Testing

```bash
cd backend/wrapper
python3.11 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"       # also installs seeder-kit from ../seeder_kit (pyproject.toml dependency)
PYTHONPATH=src python -m pytest -q
```

Requires a pinned `../upstream` checkout on disk (see `../UPSTREAM.md`) —
tests bootstrap and exercise the REAL upstream `api.*` functions against an
isolated tmp `HERMES_HOME` (`tests/conftest.py`), not mocks.

`../seeder_kit/` has its own independent test suite (no upstream/wrapper
dependency at all):

```bash
cd backend/seeder_kit
python3.11 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
python -m pytest -q
```

## Boundary

`rust_gateway` (Rust/axum) is a separate process, reached over HTTP only,
if/when this wrapper ever needs to be reached through it. No code
dependency either direction. `../upstream` is a read-only vendored
checkout — see `../UPSTREAM.md`; this wrapper only imports its `api.*`
symbols, never edits it.
