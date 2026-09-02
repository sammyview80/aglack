# workspace-image

Dockerfile for the per-workspace container: upstream Hermes WebUI + the
FastAPI wrapper (`backend/wrapper`), both **baked in at build time**.

## The staleness trap (read before shipping wrapper changes)

A running container serves the wrapper source that existed when the
image was **built**, not what is in `backend/wrapper` now. If you add or
change wrapper routes and skip the rebuild, requests to the new routes
fall through the wrapper's catch-all proxy to the upstream WebUI and
come back as its 404 (`server: uvicorn` in the response headers is the
tell — the Rust gateway never sets that header). This exact failure
shipped once: agent-history routes 404'd on every workspace because all
containers ran an image built before the feature existed.

After ANY change under `backend/wrapper` or `backend/seeder*`:

```bash
# from the repo root — the build context MUST be the repo root,
# not backend/ (the Dockerfile COPYs backend/... paths):
docker build -t hermes-workspace:dev -f backend/workspace-image/Dockerfile .
```

Then either recreate workspaces (new containers pick up the new image;
DELETE + POST loses that workspace's data) or hot-patch running dev
containers without data loss:

```bash
docker cp backend/wrapper/src/hermes_webui_wrapper/<changed files> \
  <container>:/opt/hermes-webui/wrapper/src/hermes_webui_wrapper/<...>
docker restart <container>
```

Verify against a REAL fresh container, not just unit tests (see
`checkpoints/CHECKPOINT5.md` for why): `POST /workspaces` a throwaway
workspace, curl the new route through the gateway, expect the gateway's
`{ok:...}` envelope (not a uvicorn 404), then DELETE it.

## Files

- `Dockerfile` — the image; wrapper installed into the agent's venv.
- `patch_kasmvnc_lastactiveat.py` + `e2e_test_kasmvnc_lastactiveat.py` —
  KasmVNC patch and its live test.
- `test_dockerfile_seeder_content.py` — asserts seeder content is baked
  into the image (`python3 -m pytest backend/workspace-image`).
