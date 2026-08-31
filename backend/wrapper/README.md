# hermes-webui-wrapper

FastAPI ASGI wrapper around the pinned upstream Hermes Web UI (a stdlib
`http.server` app). The wrapper never modifies upstream source; it imports
upstream's `api/*.py` request-handling functions unchanged and drives them
through a `FakeHandler` adapter that imitates the parts of
`BaseHTTPRequestHandler` those functions touch.

## Architecture

- `config.py` — `Settings.from_env()`. Resolves the upstream checkout root
  (`HERMES_WEBUI_UPSTREAM`, default `../upstream` relative to this project),
  and the runtime-parity toggle (`HERMES_WRAPPER_RUNTIME_ENABLED`).
- `upstream.py` — `bootstrap_upstream(settings)`. Validates the upstream
  checkout has the expected files, puts it on `sys.path`, imports `api` and
  pins it for the process. Raises if a conflicting `api` module (from a
  different root) is already imported, or if a second, different root is
  bootstrapped later in the same process.
- `runtime.py` — best-effort `start_runtime()` / `stop_runtime()`. Mirrors
  upstream's background services (state dirs, credential permissions,
  gateway watcher, drain thread, session reaper, plugin loading) with each
  step isolated so one failing subsystem never blocks the rest.
- `transport/handler.py` — `FakeHandler`. Bridges one HTTP request to
  upstream's handler-shaped interface. Runs upstream's blocking, and for SSE
  long-lived, functions on a worker thread; bytes written to `.wfile` and the
  "headers are complete" moment cross back into the asyncio world via a
  thread-safe queue and future.
- `transport/dispatcher.py` — `load_bindings(settings)` resolves the exact
  upstream symbols the real `server.py` `Handler` uses (once per process);
  `dispatch(...)` is a line-for-line mirror of upstream's `do_GET` /
  `_handle_write` / `do_OPTIONS`, retargeted at `FakeHandler`.
- `api/v1/system.py`, `api/router.py` — the wrapper's own
  `/api/wrapper/v1/health` endpoint, reporting wrapper status, service name,
  and pinned upstream owner/revision only. No upstream request state.
- `app.py` — `create_app(settings=None, runtime_enabled=None)`. Resolves
  settings, loads bindings once, registers the wrapper's own router, then a
  catch-all route (`GET POST PUT PATCH DELETE OPTIONS` on `/{full_path:path}`)
  that proxies everything else into upstream unmodified via the transport
  adapter. Module-level `app = create_app()` is the ASGI entry point.

## Untouched sibling upstream

This wrapper lives at `<umbrella>/wrapper`, alongside an untouched sibling
checkout at `<umbrella>/upstream`. The wrapper's own package
(`hermes_webui_wrapper`) never edits, patches, or monkeypatches anything
under `upstream/`; it only imports `api.*` symbols. See `../UPSTREAM.md` for
how the pinned upstream checkout is updated.

## Install

This wrapper is independently packageable (`pip install hermes-webui-wrapper`
pulls in only this package's own declared dependencies — FastAPI and
uvicorn — from `pyproject.toml`). It does **not** pull in upstream Hermes
WebUI's own runtime dependencies (PyYAML, cryptography, etc.), and it is
**not standalone runnable**: it imports upstream's `api/*.py` at bootstrap
time and needs BOTH a compatible, separately managed upstream checkout on
disk (pinned to the exact commit in `../UPSTREAM.md`) AND that checkout's
own dependencies installed separately (see `upstream/requirements.txt`).
Installing the wrapper package does not vendor, fetch, or dependency-install
that checkout for you. The actual deployable unit for production is a
container image that bakes in both the pinned upstream checkout and this
wrapper together with both sets of dependencies — not the wrapper wheel
alone.

```bash
# 1. Provide a pinned upstream checkout yourself (see ../UPSTREAM.md),
#    then point the wrapper at it explicitly unless you're using the
#    source/editable umbrella layout (sibling ../upstream):
export HERMES_WEBUI_UPSTREAM=/path/to/pinned/upstream/checkout

# 2. This wrapper package, editable, with dev/test extras:
pip install -e ".[dev]"
```

## Isolated state

Point these at scratch directories, never a real user home, in dev and test:

- `HERMES_HOME` — upstream state root.
- `HERMES_WEBUI_STATE_DIR`, `HERMES_WEBUI_SESSION_DIR`,
  `HERMES_WEBUI_DEFAULT_WORKSPACE` — used by `runtime.py`'s best-effort
  directory creation when the runtime-parity layer is enabled.

See `.env.example` for the full list.

## Run / test

```bash
cp .env.example .env   # edit paths as needed
set -a; source .env; set +a   # export the vars into your shell (no dotenv dependency)
python -m hermes_webui_wrapper           # or: hermes-webui-wrapper
pytest
```

The default `HERMES_WEBUI_UPSTREAM` (`../upstream` relative to this
project) assumes the source/editable umbrella layout — this wrapper
checked out next to a sibling `upstream/`. Installed deployments should
set `HERMES_WEBUI_UPSTREAM` explicitly rather than relying on that
relative default.

## Extension rules

- Add wrapper-only endpoints under `api/v1/`, mounted from `api/router.py`
  under the `/api/wrapper/v1` prefix. Never add routes that shadow upstream
  paths — the catch-all must remain the last route registered.
- Never import upstream's `api` package at module import time outside the
  bootstrap path; every upstream symbol must be resolved lazily, after
  `bootstrap_upstream()` has run, exactly as `transport/dispatcher.py` and
  `transport/handler.py` already do.
- Keep `dispatch()` a faithful mirror of upstream's `server.py` Handler.
  If upstream's dispatch logic changes, update `dispatch()` to match rather
  than special-casing behavior in the adapter.

## Runtime toggle

`HERMES_WRAPPER_RUNTIME_ENABLED` (env) or the `runtime_enabled` argument to
`create_app()` (which always overrides the env/settings value when given
explicitly) controls whether `start_runtime()` / `stop_runtime()` run during
the FastAPI lifespan. Tests always pass `runtime_enabled=False` to keep runs
hermetic.

## Streaming / security

- SSE and other long-lived responses stream through unmodified: the worker
  thread writes to `FakeHandler.wfile`, which pushes chunks onto an
  `asyncio.Queue` drained by a `StreamingResponse` generator on the event
  loop.
- Response headers are forwarded via `raw_headers`, preserving duplicate
  headers (e.g. multiple `Set-Cookie`) exactly as upstream emitted them.
- `align_loopback_proxy_host` only rewrites `Host` when both `Origin` and
  `Host` are loopback addresses and the origin is present in
  `HERMES_WEBUI_ALLOWED_ORIGINS` — never for public hosts.
- Never log or persist request bodies, headers, or credentials in wrapper
  code beyond what upstream's own handlers already do.

## Updating upstream

See `../UPSTREAM.md` for the process to update the pinned upstream checkout.
This wrapper must never be used to patch upstream source directly.
