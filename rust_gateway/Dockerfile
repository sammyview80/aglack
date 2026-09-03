# rust_gateway container image: multi-stage build producing a slim runtime
# image for the `rust_gateway` binary (see Cargo.toml — routes/proxies
# HTTP, SSE, and WebSocket requests to per-workspace backend containers).
#
# Why multi-stage: the `builder` stage needs the full Rust toolchain plus
# build-time headers for `sqlx`'s sqlite backend (see below); none of that
# belongs in the image that actually runs in production.
#
# sqlite linkage (checked against rust_gateway/Cargo.lock, not assumed):
# `libsqlite3-sys` here depends only on `cc`/`pkg-config`/`vcpkg` — no
# `bundled` feature is enabled (that would pull in `cc` to compile a
# VENDORED sqlite3.c; this crate's dependency list has no such extra
# feature-gated source dep). So this build LINKS THE SYSTEM SQLite via
# pkg-config: `libsqlite3-dev` + `pkg-config` are required in the builder
# stage, and the matching runtime shared lib `libsqlite3-0` is required in
# the final stage. If Cargo.toml/Cargo.lock ever switch sqlx's sqlite
# feature to `sqlite-unbundled`->`bundled`, both of these apt-get lines
# can be deleted.
#
# Compile-time DB checks: grepped `src/` for `sqlx::query!`/`query_as!`/
# `query_scalar!` — zero hits (this crate only uses runtime-checked
# `sqlx::query()`/`sqlx::query_scalar()`, see src/workspaces/store.rs's own
# comment on this choice). So no live database, `SQLX_OFFLINE`, or
# `.sqlx`/`sqlx-data.json` cache is needed at build time.
#
# Migrations: `sqlx::migrate!("./migrations")` (src/db/mod.rs) embeds the
# migration SQL into the binary AT COMPILE TIME (sqlx's macro, not a
# runtime directory scan) — so migrations/ is not strictly required in the
# final image for this call to work. Copied in anyway (cheap, and matches
# the relative-path convention `./migrations` documents) in case that ever
# changes to a runtime `Migrator::new(path)` call instead.
#
# providers.yaml: rust_gateway/.env.example's INTEGRATIONS_PROVIDERS_PATH
# default (`../backend/integrations/providers.yaml`) assumes a dev
# checkout layout with backend/ as a sibling of rust_gateway/, which does
# not exist inside this image. docker-compose.yml's gateway service has no
# volume mount for this file and deploy/.env.example defers the decision
# to "whatever the Dockerfile at ../rust_gateway does" — so this image
# bakes the real backend/integrations/providers.yaml in at a fixed path
# and INTEGRATIONS_PROVIDERS_PATH must be set to that path (see
# deploy/.env.example) when running this image.
#
# Build (context MUST be repo root `revamp/`, matching
# deploy/docker-compose.yml's gateway service `build.context: ../rust_gateway`
# — that context resolves relative to deploy/docker-compose.yml, i.e. also
# revamp/rust_gateway/, but this Dockerfile additionally COPYs
# backend/integrations/providers.yaml, which is OUTSIDE that context; run a
# manual verification build from the repo root instead, matching the
# COPY paths below):
#   cd revamp/
#   docker build -f rust_gateway/Dockerfile -t rust_gateway:test .

# ---- Stage 1: builder ----
# rust-version = "1.75" (Cargo.toml) is a MSRV FLOOR, not a ceiling — a
# newer compiler is fine, and here two things push past it:
#   1. Cargo.lock is lockfile format `version = 4`, requiring cargo >= 1.78
#      ("lock file version `4` was found, but this version of Cargo does
#      not understand this lock file" — hit here on a plain 1.75 image).
#   2. A transitive dependency (idna_adapter, pulled in via reqwest/url)
#      requires Cargo's `edition2024` feature, stabilized only in 1.85
#      ("feature `edition2024` is required ... not stabilized in this
#      version of Cargo (1.82.0)" — hit here on 1.82).
#   3. Several transitive deps resolved into Cargo.lock (icu_collections,
#      icu_locale_core, icu_normalizer(+_data), icu_properties(+_data),
#      icu_provider, time, time-core, time-macros — all pulled in via
#      reqwest/url's unicode/TLS/time chain) declare `rust-version = 1.88`
#      in THEIR OWN Cargo.toml. This crate's own `rust-version = "1.75"`
#      is a floor on THIS crate; it does not, and cannot, cap what a newer
#      version of an indirect dependency itself requires once
#      Cargo.lock resolves to that version. Hit as: "icu_collections@2.3.0
#      requires rustc 1.88" (and five siblings) on a 1.85 image.
# 1.88 clears all three. Debian bookworm (glibc) matches the
# debian:bookworm-slim runtime base below.
FROM rust:1.88-slim-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# ── Dependency-only layer, cached across source-only changes ───────────────
# Copy just the manifests plus dummy sources for both declared [[bin]]
# targets and the [lib] target, so `cargo build --release` compiles every
# dependency once and caches it in a Docker layer that source edits below
# do not invalidate.
COPY rust_gateway/Cargo.toml rust_gateway/Cargo.lock ./
RUN mkdir -p src/bin \
    && echo "fn main() {}" > src/bin/rust_gateway.rs \
    && echo "fn main() {}" > src/bin/test_backend.rs \
    && echo "" > src/lib.rs \
    && cargo build --release --bin rust_gateway \
    && rm -rf src

# ── Real source, real build ─────────────────────────────────────────────────
COPY rust_gateway/src ./src
COPY rust_gateway/migrations ./migrations
# Touch the binary entry points so cargo does not reuse the dummy-source
# build artifacts from the cache-warming layer above (mtime-based rebuild
# detection would otherwise skip recompiling them).
RUN touch src/lib.rs src/bin/rust_gateway.rs && \
    cargo build --release --bin rust_gateway

# ---- Stage 2: runtime ----
FROM debian:bookworm-slim

# libsqlite3-0: required at runtime because this build links the SYSTEM
# sqlite3 (see the builder-stage comment above — no `bundled` feature is
# enabled in Cargo.lock). ca-certificates: `reqwest` (rustls-tls) still
# needs the system CA bundle to validate outbound HTTPS (OpenConnector /
# backend calls).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsqlite3-0 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /build/target/release/rust_gateway ./rust_gateway
# `sqlx::migrate!("./migrations")` resolves relative to this WORKDIR at
# runtime if it ever falls back to a filesystem scan (see comment above —
# compile-time embedding means this is currently belt-and-suspenders).
COPY --from=builder /build/migrations ./migrations
# Fixed image-baked path for the provider catalog — see the top-of-file
# comment on INTEGRATIONS_PROVIDERS_PATH. Run this image with
# INTEGRATIONS_PROVIDERS_PATH=/app/providers.yaml.
COPY backend/integrations/providers.yaml ./providers.yaml

# Documentation only — the real host<->container port mapping is compose's
# own `ports: ["${GATEWAY_PORT}:${GATEWAY_PORT}"]` (deploy/docker-compose.yml).
# GATEWAY_PORT has no fixed default in this repo (env-supplied), so this
# documents the variable's role rather than a literal port number.
EXPOSE 8080

ENTRYPOINT ["/app/rust_gateway"]
