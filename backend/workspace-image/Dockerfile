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
RUN mkdir -p /opt/hermes-webui
COPY backend/upstream /opt/hermes-webui/upstream
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
# the wrapper package itself, not a second copy of its dependency tree.
# `_default_upstream_root()` in the wrapper's own config.py resolves
# `<wrapper-package-root>/../upstream` — installing FROM
# `/opt/hermes-webui/wrapper` (sibling of `/opt/hermes-webui/upstream`,
# the exact layout already in this tree) keeps that default resolution
# correct with zero extra config.
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
#                            needed.
RUN apk add --no-cache \
    chromium \
    xdg-utils \
    git \
    curl \
    python3

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
