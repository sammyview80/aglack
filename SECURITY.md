# Security Policy

`aglack` is source-available software licensed under PolyForm Noncommercial
1.0.0. It is **not** open source, and it is **not** a hardened, production
ready, multi-tenant service. Read this whole file before you run it
anywhere other than a machine you fully control.

---

## ⚠️ There is no authentication on the gateway control plane

**The Rust gateway ships with no authentication, no authorization, and no
rate limiting on any route.** Every route is reachable by any client that
can open a TCP connection to the gateway's listen address. This is a
known, deliberate, pre-1.0 state — not a misconfiguration you can turn
off — and it is stated as such in the project's own docs:

- `README.md` (Known gaps) — "No auth gate yet on gateway routes
  (including `agent-config` / `agent-seeder`) — do not expose publicly
  as-is."
- `rust_gateway/AGENTS.md:8` — "No auth or billing yet — do not assume
  either exists."

### What that concretely means

The gateway's entire route table is registered in
`rust_gateway/src/app.rs:147-189` with no auth layer of any kind — the
only `tower` layer applied is a browser-facing `CorsLayer`
(`rust_gateway/src/app.rs:198-202`). CORS is enforced by browsers, not by
the server, and the gateway's own doc comment says so
(`rust_gateway/src/app.rs:122-124`: "curl/server-to-server calls are
unaffected either way"). **CORS is not an access control.** Any
non-browser client — `curl`, a script, another container — bypasses it
entirely.

So any client that can reach the gateway can, with no credential at all:

- **Create workspaces, which spawns real Docker containers on the host.**
  `POST /workspaces` (`rust_gateway/src/app.rs:148-151`) reaches
  `create_workspace_route`
  (`rust_gateway/src/workspaces/route/create.rs:41`), which performs no
  identity or authorization check whatsoever — it validates only that
  `name` is non-empty (`create.rs:45-52`). That path ends in real
  `docker create` / `docker cp` / `docker start` commands
  (`rust_gateway/src/workspaces/container/docker_launcher.rs:119-147`),
  each publishing two container ports to host ports the gateway picks
  itself (`docker_launcher.rs:113-116`).
- **Destroy workspaces and their containers.** `DELETE /workspaces/:id`
  (`rust_gateway/src/app.rs:152`) reaches `delete_workspace_route`, which
  runs `docker rm -f` on the workspace's container
  (`docker_launcher.rs:156-177`).
- **Enumerate every tenant's workspaces**, including host port numbers.
  `GET /workspaces` (`rust_gateway/src/app.rs:150`).
- **Stop and restart any workspace's container.**
  `POST /workspaces/:id/diagnose` (`rust_gateway/src/app.rs:153`) can
  issue `docker stop` + `docker start` (`docker_launcher.rs:186-198`).
- **Reach every per-workspace proxy namespace as that workspace.** The
  `onboarding`, `agent-seeder`, `hermes-webui`, `desktop`,
  `agent-history`, and `chat` prefixes are all registered as
  unauthenticated wildcard proxies (`rust_gateway/src/app.rs:154-189`).
  Anything the in-container agent, its config, or its seeder can do is
  therefore reachable by any client that knows or guesses a workspace id.

Because container creation is unauthenticated and unmetered, an
unauthenticated client that can reach the gateway has, in practice, the
ability to consume the host's CPU, memory, disk, and port range until the
host stops working.

### The `password` field is not authentication

`POST /workspaces` accepts an optional `password`, and the gateway
**accepts and ignores it**. See
`rust_gateway/src/workspaces/route/create.rs:54-59`, which binds it to
`let _password = request.password;` with the comment "not yet used by
anything — auth for workspace containers is not built yet." Do not treat
supplying a password as protecting a workspace: nothing in the gateway
checks it, and nothing in the container is gated on it.

---

## How to run this safely

There is no supported way to expose this software to a public network or
to untrusted users. The only safe posture today is to keep the gateway
unreachable by anyone you would not hand a root-equivalent shell on the
Docker host.

- **Bind to loopback.** The gateway's listen address comes from
  `GATEWAY_HOST` / `GATEWAY_PORT`, read in
  `rust_gateway/src/config.rs:96-97` and joined in `listen_addr()`
  (`config.rs:120-122`). There is no baked-in default — both variables are
  required and the process fails loudly at startup if either is missing
  (`config.rs:43-49`, `config.rs:91-95`). The shipped template
  `rust_gateway/.env.example:14-15` sets `GATEWAY_HOST=127.0.0.1`, i.e.
  loopback only. **Keep it that way.** Setting `GATEWAY_HOST=0.0.0.0`
  binds every interface and publishes the unauthenticated control plane to
  your entire network.
- **Do not port-forward, reverse-proxy, or tunnel the gateway** to the
  internet, to a shared LAN, or to a VPN populated with users you do not
  trust with the host. Putting a reverse proxy in front does not add
  authentication unless that proxy itself authenticates every request; the
  gateway will happily serve whatever reaches it.
- **Run it on a host whose Docker daemon you are willing to lose.** The
  gateway shells out to the `docker` CLI (`docker info`, `create`, `cp`,
  `start`, `stop`, `rm -f`, `inspect` — see
  `rust_gateway/src/workspaces/container/docker_cli.rs:38-52` and
  `docker_launcher.rs`), so it runs with whatever privileges the gateway
  process's Docker access grants. On a typical setup, access to the Docker
  daemon is equivalent to root on the host. Prefer a disposable VM or a
  dedicated dev machine over a host holding anything you care about.
- **Treat workspace containers as a shared trust domain with the host.**
  Container state does not survive `docker rm`, and no named volumes are
  configured yet (`docker_launcher.rs:46-50`).
- **Do not put real secrets, real customer data, or production
  credentials into a workspace.** Assume anything placed in a workspace is
  reachable by anyone who can reach the gateway.
- **Never commit a real `.env`.** `rust_gateway/.env.example` is a
  template of key names and non-secret local-dev defaults; the real `.env`
  is gitignored (`rust_gateway/.env.example:1-6`).

---

## Supported Versions

This project is **pre-1.0**. There are no released versions, no version
branches, and no backported security fixes.

| Version | Supported |
| --- | --- |
| Latest commit on the default branch | ✅ Yes — fixes land here only |
| Any older commit, tag, fork, or vendored copy | ❌ No |

If you are running anything other than the latest commit on the default
branch, update before reporting an issue. Fixes are applied forward only.

---

## Reporting a Vulnerability

Please **do not open a public issue** for a security problem, and do not
disclose it publicly before it is addressed.

Instead, report privately via a GitHub security advisory on this
repository (**Security** tab → **Report a vulnerability**). That creates a
private channel visible only to the maintainers.

Helpful things to include:

- what you can do that you should not be able to do, and its impact;
- the exact commit you tested;
- the affected route, file, or component;
- minimal reproduction steps (a `curl` invocation is ideal);
- your environment (OS, Docker version) and the relevant non-secret
  config key names.

**Never include secrets, tokens, passwords, connection strings, or
personal data in a report.** Redact them; describe the shape of the value
instead of pasting it.

What to expect: this is a small, best-effort project with no staffed
security team and no guaranteed response window or bounty. Reports are
triaged as maintainer time allows. Please give maintainers a reasonable
opportunity to respond before disclosing publicly.

### Out of scope

The following are already documented above as known, accepted, pre-1.0
gaps rather than new vulnerabilities. Reporting them adds nothing — but a
report showing an impact **beyond** what is described here (for example, a
container escape, or a way to reach the gateway from outside a loopback
bind) is very much in scope:

- "The gateway routes require no authentication."
- "Anyone who can reach the gateway can create or delete containers."
- "The `password` field on `POST /workspaces` is ignored."
- Findings that depend on deliberately exposing the gateway to an
  untrusted network, contrary to this document.

---

## Known security gaps

Each item below was verified by reading the code in this repository at the
referenced location.

1. **No authentication or authorization on any gateway route.** The whole
   route table is registered with no auth layer — CORS only.
   `rust_gateway/src/app.rs:147-202`; confirmed by
   `rust_gateway/AGENTS.md:8` and `README.md`'s Known gaps.
2. **Unauthenticated container creation.** `POST /workspaces` validates
   only that `name` is non-empty and then launches a real container.
   `rust_gateway/src/workspaces/route/create.rs:41-52` →
   `rust_gateway/src/workspaces/container/docker_launcher.rs:119-147`.
3. **Unauthenticated container destruction.** `DELETE /workspaces/:id`
   runs `docker rm -f`. `rust_gateway/src/app.rs:152` →
   `rust_gateway/src/workspaces/container/docker_launcher.rs:156-177`.
4. **Unauthenticated container stop/restart.**
   `POST /workspaces/:id/diagnose`. `rust_gateway/src/app.rs:153` →
   `docker_launcher.rs:186-198`.
5. **Unauthenticated tenant enumeration, including host port numbers.**
   `GET /workspaces`. `rust_gateway/src/app.rs:148-151`.
6. **Unauthenticated per-workspace proxy namespaces.** `onboarding`,
   `agent-seeder`, `hermes-webui`, `desktop`, `agent-history`, and `chat`
   are wildcard-proxied with no caller identity check; access is gated
   only by knowing a workspace id. `rust_gateway/src/app.rs:154-189`,
   `rust_gateway/src/workspaces/proxy/`.
7. **Privileged `docker` CLI surface driven by HTTP input.** Workspace
   lifecycle is implemented by shelling out to `docker`
   (`rust_gateway/src/workspaces/container/docker_cli.rs:38-52`,
   `docker_launcher.rs`). The gateway's Docker access is typically
   root-equivalent on the host.
8. **The `password` on `POST /workspaces` is accepted and ignored.** It
   provides no protection. `rust_gateway/src/workspaces/route/create.rs:54-59`.
9. **No rate limiting or resource quotas.** Nothing in
   `rust_gateway/src/app.rs`'s layer stack bounds request rate, workspace
   count, or per-container resources; `docker create`
   (`docker_launcher.rs:119-134`) sets no CPU or memory limits, so
   repeated creation is an unauthenticated host-resource exhaustion path.
10. **Container state is not durable and not isolated by volume.** No
    named volumes for `HERMES_HOME` / `/workspace` yet — state is lost on
    `docker rm`. `docker_launcher.rs:46-50`.
11. **No transport encryption in the gateway.** The gateway serves plain
    HTTP; nothing in `rust_gateway/src/config.rs` or
    `rust_gateway/src/app.rs` configures TLS. Anything beyond loopback
    would traverse the network in cleartext.
12. **Single-machine SQLite registry, no multi-tenant hardening.** The
    workspace registry is a local SQLite file from `DATABASE_URL`
    (`rust_gateway/src/config.rs:219-233`); there is no billing, quota, or
    tenant-isolation layer. See `README.md`'s Known gaps.

### Not verified / out of the scope of this review

The following were **not** audited and should not be read as either safe
or unsafe on the strength of this document: the FastAPI sidecar wrapper's
own route-level authorization (`backend/wrapper/`), the pinned upstream
Hermes WebUI checkout (`backend/upstream/`), the KasmVNC desktop's own
authentication, the workspace container image's package/CVE posture
(`backend/workspace-image/`), the seeder's handling of agent-supplied
content (`backend/seeder_kit/`, `backend/seeder/`), and dependency supply
chain across the Rust, Python, and npm trees.
