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
- `patch_kasmvnc_hide_control_bar.py` + `test_kasmvnc_hide_control_bar_patch.py` —
  patches `/kclient/public/index.html` (the EJS shell
  `/workspaces/:id/desktop/` actually serves) so its embedded KasmVNC
  iframe defaults to a hidden control bar. Fail-closed byte match, same
  pattern as the lastActiveAt patch above — see its own module doc for
  why the value must be an EMPTY string (not the literal text `false`,
  which is truthy once read by KasmVNC's own `getConfigVar()`) and why a
  caller-side `show_control_bar` URL param (`desktopUrl()` in
  `frontend/src/features/workspace/api.ts`) cannot do this on its own.
- `patch_kasmvnc_hide_lsbar.py` + `test_kasmvnc_hide_lsbar_patch.py` —
  patches `/kclient/public/js/kclient.js` so the same shell's separate
  File-Manager/Enable-Audio/Enable-Microphone bar (`#lsbar`) never
  auto-opens either — see its own module doc for the real trigger
  (KasmVNC's `ui.js` unconditionally postMessage-ing `control_open` to
  its parent frame on every connect).
- `assets/wallpaper.png` + `test_dockerfile_wallpaper.py` — default
  IceWM desktop wallpaper, baked in via `/etc/icewm/prefoverride`
  (verified live via `icewm --directories`: this is the ONLY config file
  that wins over both a workspace's own `/config/.icewm` user override
  and whatever theme prefs the base image's `/usr/share/icewm/preferences`
  defaults resolve to — see the test's own module doc).
- `test_dockerfile_seeder_content.py` — asserts seeder content is baked
  into the image (`python3 -m pytest backend/workspace-image`).
