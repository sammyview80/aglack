# Workspace container image: a full Linux desktop (webtop, Alpine/musl) with
# Hermes Agent's Python source rebuilt fresh for musl, plus our own untouched
# Hermes WebUI (backend/upstream) and wrapper (backend/wrapper) copied in and
# run instead of upstream's own server.py. The wrapper is INSTALLED INTO the
# agent's own venv (/opt/hermes/.venv), not a separate one — see the
# "Install the wrapper INTO the agent's own venv" comment below for why
# (a separate venv can never `from run_agent import AIAgent`, which is what
# caused a real "AIAgent not available" failure this fixes).
#
# THIS IMAGE HAS NO IDENTITY OF ITS OWN. It is a template every workspace
# container is built from; nothing here is unique per tenant/container. All
# per-container uniqueness (container name, published ports, persistent
# volumes, PUID/PGID, a title) is assigned at `docker create`/`docker run`
# time by whatever creates a container from this image (the Rust gateway),
# never baked in here. See the "Unique per-container identity" section
# below and rust_gateway's own docs once written.
#
# Base layer choice (see revamp/backend for the original reference this
# pattern is adapted from — docker/workspace-server/Dockerfile in the
# original, non-revamp project): `lscr.io/linuxserver/webtop:alpine-icewm`
# is the specific webtop tag confirmed (in that original project, via a real
# running container, not assumed) to still run the KasmVNC desktop protocol
# (`/websockify` on port 6901) rather than Selkies, which several other
# webtop tags silently switched to. Re-verify this if you ever change the
# base image tag: `grep location` in the running container's nginx config
# for `/websockify` (KasmVNC) vs a Selkies signature.
#
# Why Hermes Agent is NOT `FROM`'d directly: webtop's base is Alpine/musl.
# `nousresearch/hermes-agent`'s own published image is Debian/glibc, and its
# baked-in Python venv contains compiled `.so` extensions (e.g.
# pydantic-core) tied to glibc that CANNOT run on musl. So Stage 1 below
# only exists to copy hermes-agent's *source* out of that image (pyproject
# .toml, uv.lock, the actual Python packages) — never its compiled venv —
# and Stage 2 rebuilds the venv from scratch natively on Alpine with `uv`.
#
# Build (verified working — the build context MUST be revamp/, the PARENT
# of backend/, not this workspace-image/ directory and not backend/ itself:
# the COPY backend/upstream / COPY backend/wrapper instructions below are
# resolved relative to the build context, so anything else makes Docker
# report "backend/upstream": not found):
#   cd revamp/
#   docker build -t hermes-workspace:dev -f backend/workspace-image/Dockerfile .

# Pinned to the exact digests already verified working in the original,
# non-revamp project's docker/workspace-server/Dockerfile. Re-resolve fresh
# pins with:
#   docker inspect --format='{{index .RepoDigests 0}}' <image:tag>
# after a `docker pull` of the tag you intend to move to, and re-verify the
# KasmVNC-vs-Selkies check above before trusting a new webtop digest.
ARG HERMES_AGENT_IMAGE=nousresearch/hermes-agent@sha256:7bce9bda73d3009afe76ebad3098bb5e502cc7947b40a81b824d86eccfd7a2b9
ARG BASE_IMAGE=lscr.io/linuxserver/webtop@sha256:440aebeafa9b9101d03f633be9a504d75917fcb7d6847842f67aa033c46f06f3

# ---- Stage 1: hermes-agent source only (no venv, no glibc .so files) ----
FROM ${HERMES_AGENT_IMAGE} AS hermes-source

# ---- Stage 2: builder — rebuild the musl venv, nothing else survives to the final image ----
FROM ${BASE_IMAGE} AS builder
USER root

# Build-only toolchain: compiles any Python dependency without a musllinux
# wheel. None of this is copied into the final image.
RUN apk add --no-cache \
    python3 \
    gcc \
    musl-dev \
    python3-dev \
    linux-headers \
    make

RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

RUN mkdir -p /opt/hermes
COPY --from=hermes-source /opt/hermes/pyproject.toml /opt/hermes/uv.lock /opt/hermes/README.md /opt/hermes/

# Install dependencies only first (project itself not copied yet) so this
# layer stays cached across source-only changes. `--locked` (not
# `--frozen`): fail loudly if uv.lock and pyproject.toml have drifted rather
# than silently tolerate a stale lockfile.
WORKDIR /opt/hermes
ENV UV_PYTHON_DOWNLOADS=never
RUN uv venv /opt/hermes/.venv --python "$(command -v python3)" \
    && UV_PROJECT_ENVIRONMENT=/opt/hermes/.venv uv sync --locked --no-dev --no-install-project --python "$(command -v python3)"

# Bring in the application source and finish the sync (dependencies already
# cached above; this only installs the hermes-agent project itself).
COPY --from=hermes-source /opt/hermes/agent /opt/hermes/agent
COPY --from=hermes-source /opt/hermes/gateway /opt/hermes/gateway
COPY --from=hermes-source /opt/hermes/tools /opt/hermes/tools
COPY --from=hermes-source /opt/hermes/hermes_cli /opt/hermes/hermes_cli
COPY --from=hermes-source /opt/hermes/acp_adapter /opt/hermes/acp_adapter
COPY --from=hermes-source /opt/hermes/cron /opt/hermes/cron
COPY --from=hermes-source /opt/hermes/native /opt/hermes/native
COPY --from=hermes-source /opt/hermes/plugins /opt/hermes/plugins
COPY --from=hermes-source /opt/hermes/providers /opt/hermes/providers
COPY --from=hermes-source /opt/hermes/scripts /opt/hermes/scripts
COPY --from=hermes-source /opt/hermes/skills /opt/hermes/skills
COPY --from=hermes-source /opt/hermes/locales /opt/hermes/locales
COPY --from=hermes-source /opt/hermes/cli.py /opt/hermes/hermes_bootstrap.py /opt/hermes/hermes_constants.py /opt/hermes/hermes_logging.py /opt/hermes/hermes_state.py /opt/hermes/hermes_state_common.py /opt/hermes/hermes_state_portability.py /opt/hermes/hermes_state_schema.py /opt/hermes/hermes_state_search.py /opt/hermes/hermes_time.py /opt/hermes/model_tools.py /opt/hermes/registration_lifecycle.py /opt/hermes/run_agent.py /opt/hermes/toolset_distributions.py /opt/hermes/toolsets.py /opt/hermes/trajectory_compressor.py /opt/hermes/utils.py /opt/hermes/mcp_serve.py /opt/hermes/batch_runner.py /opt/hermes/mini_swe_runner.py /opt/hermes/setup.py /opt/hermes/hermes /opt/hermes/

RUN UV_PROJECT_ENVIRONMENT=/opt/hermes/.venv uv sync --locked --no-dev --python "$(command -v python3)"

# Build the FTS5 CJK tokenizer extension from source (C source ships
# upstream, not a prebuilt .so).
RUN chmod +x /opt/hermes/native/fts5_cjk/build.sh
RUN /opt/hermes/native/fts5_cjk/build.sh /opt/hermes/native/fts5_cjk/dist

# ── Our own Hermes WebUI (untouched upstream) + wrapper ─────────────────────
# Copied HERE (builder stage), not just Stage 3, because installing the
# wrapper (below) needs `uv` — only present in this stage, deliberately
# never copied into the final image (Stage 3 has no compiler toolchain and
# no package installer at all: confirmed live, `find / -iname uv` in a
# running container finds nothing). This same `/opt/hermes-webui` tree is
# copied verbatim into Stage 3 below — source only; no separate venv is
# built for it there anymore (see the wrapper install right below).
#
# backend/upstream/ is NEVER modified — see revamp/backend/UPSTREAM.md.
#
# backend/seeder_kit/ (the framework-agnostic tool-discovery/skill-copy
# library, see its own README.md) and backend/seeder/ (the actual seed
# CONTENT — SOUL.md/AGENTS.md/tools/skills per mode, see its own README.md)
# are copied in as the SAME sibling layout the wrapper's own code already
# assumes: `features/agent_seeder/service.py`'s `_default_seeder_root()`
# resolves `<wrapper-root>/../seeder` at RUNTIME — must exist as a real
# directory in the final image, same as upstream/wrapper's sibling
# relationship. `seeder_kit` additionally needs to be INSTALLED (below),
# separately from and BEFORE the wrapper.
#
# Real bug this fixes: without these two COPY lines, a container built
# from this image has no `agent_seeder`/`agent_config` native routes at
# all — the wrapper install below fails outright resolving the missing
# `seeder-kit` dependency, or (on an image built before that dependency
# existed) the wrapper silently has no seeder content to apply, and any
# request to `/api/wrapper/v1/agent-seeder/*` or `/agent-config/*` falls
# through to the proxied catch-all, which replays it through UPSTREAM's
# OWN CSRF check (`_check_csrf`) — producing "Cross-origin mismatch - check
# reverse proxy headers" for a request that was never supposed to go
# anywhere near that code path. Confirmed live: this exact symptom on an
# "Apply mode" click against a container built before this fix.
RUN mkdir -p /opt/hermes-webui
COPY backend/upstream /opt/hermes-webui/upstream
COPY backend/seeder_kit /opt/hermes-webui/seeder_kit
COPY backend/seeder /opt/hermes-webui/seeder
COPY backend/wrapper /opt/hermes-webui/wrapper

# Install the wrapper INTO the agent's own venv — NOT a separate
# `/opt/hermes-webui/.venv` (the previous design; see git history) — so a
# single interpreter can both `from run_agent import AIAgent` (needs the
# agent's own compiled deps, e.g. pydantic-core — a separate WebUI-only
# venv can never see these; this was the real root cause of a live
# "AIAgent not available" failure) AND serve the wrapper's FastAPI app.
# Verified live in a running container: fastapi/uvicorn/pyyaml/cryptography
# (the wrapper's own runtime deps) are ALREADY present in /opt/hermes/.venv
# as hermes-agent's own transitive dependencies — this install only adds
# the wrapper package itself (and seeder-kit, its own small dependency —
# see the seeder_kit/seeder COPY block above), not a second copy of the
# agent's whole dependency tree.
# `_default_upstream_root()` in the wrapper's own config.py resolves
# `<wrapper-package-root>/../upstream` — installing FROM
# `/opt/hermes-webui/wrapper` (sibling of `/opt/hermes-webui/upstream`,
# the exact layout already in this tree) keeps that default resolution
# correct with zero extra config. Same reasoning now applies to
# `/opt/hermes-webui/seeder` for `_default_seeder_root()`.
#
# `seeder-kit` is installed as its OWN separate `-e` step, BEFORE the
# wrapper, and the wrapper's `pyproject.toml` depends on the plain name
# `seeder-kit` (no `file://` URL) — see that file's own comment on this
# dependency for why: `uv pip install -e <dir>` (this exact install mode)
# cannot resolve a RELATIVE `file://../seeder_kit` URL declared inside a
# package's own metadata, and hardcoding an absolute
# `file:///opt/hermes-webui/seeder_kit` path into a manifest meant to also
# work for local dev (a different install root) is the wrong fix. Order
# matters here: this must run AFTER seeder_kit is a real installed
# package in this venv, or the wrapper's dependency resolution fails
# needing something named `seeder-kit` that doesn't exist yet.
RUN UV_PROJECT_ENVIRONMENT=/opt/hermes/.venv uv pip install --python /opt/hermes/.venv/bin/python -e /opt/hermes-webui/seeder_kit
RUN UV_PROJECT_ENVIRONMENT=/opt/hermes/.venv uv pip install --python /opt/hermes/.venv/bin/python -e /opt/hermes-webui/wrapper

# ---- Stage 3: the final image — webtop desktop + built hermes venv + our own WebUI ----
FROM ${BASE_IMAGE}

LABEL description="Hermes workspace: webtop desktop (Alpine/musl) + hermes-agent + Hermes WebUI (upstream + wrapper)"

# LSIO images build their own layers as root; the base image's own
# s6-overlay init drops privilege to PUID/PGID (default 911/abc, remapped
# per-container at boot). Do not create a competing user here — see
# "Unique per-container identity" below for how PUID/PGID gets assigned.
USER root

# Bake in an empty /custom-cont-init.d so a container CREATED (but not yet
# STARTED) from this image has somewhere for a boot hook to be `docker cp`'d
# into — s6-overlay only creates this directory itself at container BOOT
# time, which is too late for `docker cp` targeting a not-yet-started
# container. Confirmed real, base-image-agnostic bug in the original
# reference project; this empty dir is a safe no-op otherwise (equivalent
# to what s6 would create on its own: root-owned, mode 0755).
RUN mkdir -p /custom-cont-init.d

# Runtime-only deps (no compiler toolchain — that stayed in the `builder`
# stage):
#   chromium, xdg-utils  - browser + URL/desktop-file handling for the agent
#   git, curl            - hermes-agent runtime needs (git tool, downloads)
#   python3               - Alpine's python3 satisfies hermes-agent's
#                            requires-python; uv is a static binary, no pip
#                            needed. Also what patch_kasmvnc_lastactiveat.py
#                            (right below) runs under.
RUN apk add --no-cache \
    chromium \
    xdg-utils \
    git \
    curl \
    python3

# Patch a real, confirmed bug in the BASE image's bundled KasmVNC client:
# its idle-keepalive interval reads `UI.rfb.lastActiveAt` with no guard on
# `UI.rfb` being defined, and crashes ("Uncaught TypeError: Cannot read
# properties of undefined (reading 'lastActiveAt')") if the interval tick
# lands after a disconnect clears UI.rfb — reproduced live on real
# workspaces. See patch_kasmvnc_lastactiveat.py's own module doc for the
# full research trail (exact upstream version confirmed, the real
# unreleased upstream fix commit identified and read in full, why this is
# a smaller surgical patch rather than porting that whole commit).
#
# This is a bug in `lscr.io/linuxserver/webtop`'s bundled KasmVNC
# (kasmtech/noVNC v1.3.0), not in anything this repository owns — kasmtech
# has not yet tagged a release containing their own fix (upstream commit
# 402c0c59d62424ff110bad8f14682deec7d4c780, merged 2026-07-16, still
# unreleased as of this writing). Once they do, delete this patch step and
# `docker inspect --format='{{index .RepoDigests 0}}'` a fresh BASE_IMAGE
# pin instead — re-verify the KasmVNC-vs-Selkies check in this file's own
# top comment before trusting a new webtop digest either way.
#
# Fails the BUILD (not silently skips) if the base image's bundled
# main.bundle.js no longer matches byte-for-byte what this patch expects —
# see the script's own fail-closed reasoning. A failed build here means
# "the base image changed this file since this patch was written, go
# re-verify the crash and the exact block to match," not a bug to work
# around by ignoring the exit code.
COPY backend/workspace-image/patch_kasmvnc_lastactiveat.py /tmp/patch_kasmvnc_lastactiveat.py
RUN python3 /tmp/patch_kasmvnc_lastactiveat.py && rm /tmp/patch_kasmvnc_lastactiveat.py

# Patch the BASE image's `kclient` shell (the EJS template
# `/workspaces/:id/desktop/` actually serves — NOT raw KasmVNC directly)
# so its embedded KasmVNC iframe defaults to a HIDDEN control bar instead
# of always-open. See patch_kasmvnc_hide_control_bar.py's own module doc
# for the full trail, INCLUDING a real regression this repo shipped once:
# an earlier version of this patch set the literal string
# `show_control_bar=false`, which is TRUTHY once read by KasmVNC's own
# `WebUtil.getConfigVar()` (raw string, not boolean-parsed) — the correct
# value is an EMPTY string. `desktopUrl()`'s own `show_control_bar` param
# (frontend/src/features/workspace/api.ts) has no effect through this
# gateway path either way — this Dockerfile-time patch on the value
# actually baked into the template is the only lever that works.
#
# Same third-party-base-image reasoning as the patch above: not a bug in
# this repository's own code, applied at image-build time so it survives
# container recreation (a live `docker exec` + `sed` edit does not — see
# this script's own module doc), and fails the BUILD loudly rather than
# silently if the base image's template ever changes this exact line.
COPY backend/workspace-image/patch_kasmvnc_hide_control_bar.py /tmp/patch_kasmvnc_hide_control_bar.py
RUN python3 /tmp/patch_kasmvnc_hide_control_bar.py && rm /tmp/patch_kasmvnc_hide_control_bar.py

# Patch the same `kclient` shell's own client script so its separate
# File-Manager/Enable-Audio/Enable-Microphone bar (`#lsbar`) never
# auto-opens either. See patch_kasmvnc_hide_lsbar.py's own module doc for
# the full trail: `#lsbar` is `display:none` by default (not a hover
# trigger, an earlier wrong assumption) — the real trigger is KasmVNC's
# own `ui.js` unconditionally postMessage-ing `{action:'control_open'}`
# to its parent frame (this exact shell) on every connect, which
# `kclient.js`'s own listener responds to by opening it. No query
# parameter gates the SENDER side of that message, so the only fix is
# making the RECEIVER's handler a no-op.
COPY backend/workspace-image/patch_kasmvnc_hide_lsbar.py /tmp/patch_kasmvnc_hide_lsbar.py
RUN python3 /tmp/patch_kasmvnc_hide_lsbar.py && rm /tmp/patch_kasmvnc_hide_lsbar.py

# ── Default desktop wallpaper (IceWM) ───────────────────────────────────────
# Baked in via `/etc/icewm/prefoverride`, NOT the base image's own
# `/usr/share/icewm/preferences` — verified live against the real
# `icewm` binary (`icewm --directories` inside a built container):
#
#   PrivConfDir=/config/.icewm   (highest priority — per-workspace user
#                                 override; a workspace that already has
#                                 its own /config/.icewm/prefoverride
#                                 keeps whatever wallpaper IT set, this
#                                 default never overrides a real user
#                                 choice)
#   CFGDIR=/etc/icewm            (this file — system default)
#   LIBDIR=/usr/share/icewm      (base image's own bundled defaults,
#                                 confirmed via its `preferences` file:
#                                 DesktopBackgroundImage="" by default)
#
# `prefoverride` specifically (not `preferences`) because IceWM's loader
# reads `preferences`, then a selected THEME's own prefs (which can set
# its own background), then `prefoverride` LAST — confirmed via `strings
# /usr/bin/icewm` containing the literal token `prefoverride` distinct
# from `preferences`/`postpreferences`. Only `prefoverride` is guaranteed
# to win over whatever theme a workspace ends up using.
#
# DesktopBackgroundScaled=1 + DesktopBackgroundCenter=0: fills the
# desktop preserving aspect ratio, per IceWM's own preferences template
# comments for these exact keys.
RUN mkdir -p /usr/share/backgrounds
COPY backend/workspace-image/assets/wallpaper.png /usr/share/backgrounds/hermes-wallpaper.png
RUN mkdir -p /etc/icewm && \
    printf '%s\n' \
        'DesktopBackgroundImage="/usr/share/backgrounds/hermes-wallpaper.png"' \
        'DesktopBackgroundScaled=1' \
        'DesktopBackgroundCenter=0' \
        > /etc/icewm/prefoverride && \
    chmod a+r /usr/share/backgrounds/hermes-wallpaper.png /etc/icewm/prefoverride

# Pull in the fully-built hermes-agent tree (source + musl venv, now WITH
# the wrapper installed into that same venv too — see the builder stage's
# `uv pip install -e /opt/hermes-webui/wrapper` above — + fts5_cjk .so)
# from the builder stage. No compiler toolchain, no uv install script.
COPY --from=builder /opt/hermes /opt/hermes

# hermes-agent (and now the wrapper, installed into the same venv) runs as
# the webtop runtime user (`abc`, PUID/PGID-remapped at boot). abc never
# needs to WRITE under /opt/hermes at runtime (venv is fully prebuilt),
# only read+execute — world-readable perms below cover that for any
# PUID/PGID, avoiding an expensive recursive chown at every container boot.
RUN chmod -R a+rX /opt/hermes
ENV PYTHONDONTWRITEBYTECODE=1
ENV PATH="/opt/hermes/.venv/bin:${PATH}"

# ── Our own Hermes WebUI (untouched upstream) + wrapper — SOURCE only ───────
# The actual installed package + all its runtime deps now live in
# /opt/hermes/.venv (copied above) — this is just the source tree the
# wrapper's own `HERMES_WEBUI_UPSTREAM` default resolution and editable
# install point at (`_default_upstream_root()` in config.py resolves
# `<wrapper-root>/../upstream`, i.e. this exact sibling layout). Copied
# from the BUILDER stage (already has it from the wrapper-install step
# above) rather than a fresh `COPY backend/...` here, so there is exactly
# one place in this Dockerfile that names those two host paths, not two.
#
# backend/upstream/ is NEVER modified — see revamp/backend/UPSTREAM.md.
COPY --from=builder /opt/hermes-webui /opt/hermes-webui

# Also read+execute only at runtime — same reasoning as /opt/hermes above.
RUN chmod -R a+rX /opt/hermes-webui

# ── Unique per-container identity ───────────────────────────────────────────
# NOTHING in this image is unique. Every container created from this image
# must be given, at `docker create`/`docker run` time (never baked in here):
#   - a unique --name (e.g. "hermes-ws-<tenant-id>" or a generated id) —
#     this is the primary handle the Rust gateway uses to map a tenant to
#     its container and to target `docker start`/`stop`/`exec`/`cp` calls.
#   - unique HOST-side published ports for the WebUI (wrapper) port and the
#     webtop desktop (noVNC) port — e.g. `-p 127.0.0.1:<assigned>:8787` and
#     `-p 127.0.0.1:<assigned>:3000` (CONTAINER_DESKTOP_PORT convention from
#     the original reference project; verify this image's actual exposed
#     desktop port live once built: `docker inspect --format
#     '{{json .Config.ExposedPorts}}'`) — the CONTAINER-side ports below
#     stay fixed and identical across every container; only the HOST-side
#     mapping differs per container, which is what makes routing possible.
#   - unique, per-container named volumes for persistent state (never bind
#     mounts to a host path, and never one shared volume across containers)
#     — at minimum one for HERMES_HOME (agent + wrapper state) and one for
#     /workspace.
#   - PUID/PGID (webtop's own remap convention) and a TITLE if the desktop
#     session should display one.
# A --label (e.g. "hermes-workspace-tenant=<tenant-id>") on top of --name is
# recommended so the gateway can also discover containers via `docker ps
# --filter label=...` without depending on --name's exact string format.
#
# The wrapper's own port is fixed at 8787 (its default; see
# backend/wrapper/.env.example HERMES_WRAPPER_PORT) inside every container
# — only the HOST-side mapping varies per container.
ENV HERMES_WRAPPER_HOST=0.0.0.0
ENV HERMES_WRAPPER_PORT=8787
EXPOSE 8787

# No CMD override here: webtop's own s6-overlay `/init` entrypoint runs
# unmodified (same reasoning as the original reference project's server-kind
# image). The wrapper (which runs upstream in-process) is started via a
# `/custom-cont-init.d/` boot hook delivered by whatever creates the
# container from this image (the Rust gateway), NOT baked into this image —
# because HERMES_HOME, PUID/PGID, and other per-container values the boot
# script needs are only known at container-creation time, not at image
# build time. See rust_gateway's own container-creation code once written
# for the exact boot script content (analogous to
# _server_workspace_boot_command in the original reference project).
