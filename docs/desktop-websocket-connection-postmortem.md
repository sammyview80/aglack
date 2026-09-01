# Postmortem: desktop proxy "stuck on Connecting" / 502 — how it was solved, and how to not repeat it

**Status: fixed and live-verified.** Symptom, root causes, fixes, and the
checklist to run before touching this code again. See also
`CHECKPOINT.md`'s "Desktop 'stuck on Connecting' / crash debugging
trail" for the condensed version and `CHECKPOINT1.md` for the full
session narrative this doc is distilled from.

## Symptom

Opening a workspace's desktop —
`http://<gateway>/workspaces/<id>/desktop/` — either hung forever on
KasmVNC's "Connecting…" screen, or the gateway's own log showed:

```
rust_gateway: desktop websocket dial to ws://127.0.0.1:<port>/websockify failed: HTTP error: 502 Bad Gateway
```

Reproduced across multiple, unrelated real containers — systemic, not
one bad container.

## Root cause 1 — `SUBFOLDER` never set on the container

The container's KasmVNC wrapper (`/kclient/index.js`, LinuxServer.io's
Express/EJS app — **not** KasmVNC's own `www` root, which the desktop's
`location /` actually proxies to) reads `process.env.SUBFOLDER` (default
`/`) and only injects the correct `?path=` query param into its VNC
iframe when `SUBFOLDER != '/'`. `DockerCliLauncher` never set this
env var, so the browser's own VNC WebSocket request went to a bare
`ws://<gateway>/websockify` — missing the entire
`/workspaces/<id>/desktop/` prefix — and that handshake never got a
response at all.

**Found by:** a real headless Chrome session driven directly over the
Chrome DevTools Protocol (`websockets` library, no playwright/puppeteer
in this environment), watching `Network.webSocketCreated` fire with no
matching `webSocketHandshakeResponseReceived` ever following. A bare
`curl`/raw-websocket-client test would not have shown this — the bug is
specifically about what URL a REAL BROWSER's JS constructs, not whether
one arbitrary URL responds.

## Root cause 2 — the gateway's own outbound dial used the wrong path shape

This is the one that bit twice. Once `SUBFOLDER` is set (root cause 1's
fix), the container's nginx **regenerates its own config per container**
with a workspace-specific location block instead of a generic one:

```nginx
# what nginx ACTUALLY has once SUBFOLDER is set — confirmed live,
# reading the config inside several different real containers:
location /workspaces/<id>/desktop/websockify {
    proxy_pass http://127.0.0.1:6901;   # real KasmVNC
}
location / {
    proxy_pass http://127.0.0.1:6900;   # kclient — a DIFFERENT app
}
```

`rust_gateway`'s `desktop_proxy.rs` builds the outbound WebSocket URL it
dials the container with. If that URL uses the bare, stripped
`/websockify` path, it matches **nothing** in the config above — it
silently falls through to the generic `location /` (port 6900, the wrong
app entirely), and that connection gets closed immediately by nginx. The
gateway logs this as a `502 Bad Gateway` on its own outbound dial.

**Found by:** re-checking a fresh bug report against the ALREADY-FIXED
code (root cause 1's fix had already shipped) and finding the exact same
symptom's *log line* had changed shape — from "never got any response"
to "got a real 502." Read the running gateway's own stderr log first,
then the *container's* own `/var/log/nginx/error.log`
(`upstream prematurely closed connection ... upstream:
http://127.0.0.1:6900/websockify`) — that log line is what actually
named the real cause; nothing about it was guessable from `desktop_proxy.rs`'s
source alone.

## The fix

Two coordinated changes, both required, neither sufficient alone:

1. **`container.rs`** — `docker create -e SUBFOLDER=/workspaces/<id>/desktop/`
   (`desktop_subfolder_env_arg`, built from `desktop_subpath`, the single
   source of truth for this string). Once set, kclient's whole Express
   app moves under that prefix, so `wait_for_desktop_ready`/
   `check_desktop_health` (the readiness checks used at container-launch
   time) had to stop hardcoding a bare `/` too — they now build their
   URL from the same `desktop_subpath` helper.
2. **`desktop_proxy.rs`** — BOTH the plain-HTTP branch and the WebSocket
   branch forward `req.uri().path()` **unmodified** — the full, original
   path the browser actually requested — instead of stripping this
   gateway's own `/workspaces/:id/desktop` routing prefix off first. This
   is the *opposite* of what the other two proxy routes
   (`onboarding_proxy.rs`, `hermes_webui_proxy.rs`) correctly do, because
   THEIR backends are mounted at their own root and have no idea a prefix
   exists — the desktop route is a deliberate, documented exception.

Commits, in order:

| Commit | What it fixed |
|---|---|
| [`1654c48`](../../rust_gateway) `fix(gateway): forward upstream response headers, not just body` | Unrelated bug found on the same report (CSS losing `Content-Type`) — not the connection error, included for completeness of the investigation trail. |
| `159815a` `fix(gateway): negotiate binary subprotocol on desktop websocket upgrade` | A real, necessary fix — the browser-facing WS upgrade never sent `Sec-WebSocket-Protocol: binary`. **Presented as resolving "stuck on Connecting" and was wrong to stop here** — see "What went wrong in the process" below. |
| `52cfb07` (reverted `02c2804`, reapplied `ff7b739` — net effect identical to `52cfb07`) `fix(gateway): make the desktop actually reach Connecting -> connected` | Root cause 1: `SUBFOLDER` + the plain-HTTP path-forwarding fix. |
| `66bdef2` `fix(gateway): forward the full unstripped path to the desktop websocket` | Root cause 2: the WebSocket branch's outbound dial URL. |

## What went wrong in the process (the part worth remembering)

Three separate times, a fix that was **correct but incomplete** got
presented as done, and was only caught by *re-verifying it against a
real browser or a real, freshly-relaunched container* — never by
re-reading the code:

1. `159815a`'s subprotocol fix was real and necessary, but was declared
   as resolving "stuck on Connecting" without driving an actual browser
   through the full connect flow first. Doing that immediately surfaced
   root cause 1 (bug 3) — the browser's WebSocket request was going to
   the wrong URL entirely, something the subprotocol fix could never
   have addressed.
2. `52cfb07` (root cause 1) shipped, was verified against one real
   container at the time — but the *next* real bug report, days later,
   turned out to be a **different, second** bug that the exact same
   symptom ("stuck/crash on desktop") was now masking. Nothing about
   `desktop_proxy.rs`'s source would have flagged this; it took reading
   the *container's own* nginx error log on a fresh, independent
   investigation to find it.
3. The E2E test written for a related bug (`7c9fe33`'s `lastActiveAt`
   crash fix) initially used a "click the Disconnect button" trigger and
   PASSED even against a deliberately unpatched image — a false
   positive, caught only by deliberately running that exact negative
   control. (Not this postmortem's bug, but the same investigation arc,
   and the same lesson: a test that always passes proves nothing until
   it's shown capable of failing.)

**The lesson is not any individual fix above — it's this pattern.**
Treat "the fix compiles, the unit tests pass, and I reasoned through why
it should work" as necessary but not sufficient for anything touching
this proxy path. The next section is how to make that concrete.

## Checklist — run this before touching `desktop_proxy.rs`, `container.rs`'s `SUBFOLDER`/`desktop_subpath` code, or the base image's KasmVNC/nginx setup

1. **Read the two dependent files together before writing anything: the
   real container's nginx config AND `desktop_proxy.rs`'s URL
   construction.** They must agree on whether the path is stripped or
   full — right now, both correctly use the FULL unstripped path (see
   the fix above). If you're about to make ONE of them use a different
   shape than the other, stop: that mismatch is exactly what caused
   root cause 2.
   ```bash
   docker exec <container> cat /etc/nginx/http.d/default.conf
   ```
2. **Never trust a fix for this area until a real browser has completed
   a real connection through it.** `curl`/a bare WebSocket client is not
   enough — several of these bugs are specifically about what a real
   browser's own JS does (URL construction, subprotocol negotiation,
   iframe `src`) that a raw protocol client never exercises. Use a real
   headless Chrome driven over the Chrome DevTools Protocol:
   ```bash
   google-chrome --headless=new --remote-debugging-port=<free-port> --remote-allow-origins=* about:blank &
   # then drive it via CDP over websockets (Python's `websockets` lib is
   # what this project used — no playwright/puppeteer installed).
   # Watch for Network.webSocketHandshakeResponseReceived, not just
   # webSocketCreated — the latter fires even when nothing ever answers.
   ```
3. **After ANY fix in this area, relaunch a genuinely fresh workspace and
   test THAT one** — not the container you were debugging against, which
   may have accumulated state, and not just re-running the same curl
   that already passed once. A stale container from before an image
   rebuild will keep failing forever and is not evidence the fix is
   wrong; a stale gateway PROCESS from before a code rebuild will keep
   failing forever and is not evidence either. These are TWO INDEPENDENT
   staleness questions — check both:
   - Was this container's image built after the relevant Dockerfile/
     `patch_kasmvnc_lastactiveat.py` change? (`docker inspect` the
     container's image digest, or compare its `CreatedAt` to the
     commit's date.)
   - Is the gateway process actually serving it running a binary built
     after the relevant `rust_gateway` commit? (A Rust code fix needs a
     gateway *restart*; it does not apply retroactively to already-open
     connections or an already-running process.)
4. **Run a negative control, not just a positive one.** Before trusting
   any fix here as done: revert the code (or rebuild the pre-fix image)
   and confirm the exact same real-browser test **fails the way the
   original report said it would**. If your "proof" only ever ran
   against the fixed version, it has not actually distinguished "this
   fix works" from "this test doesn't test the right thing" — which is
   precisely what happened with the first version of the `lastActiveAt`
   E2E test.
5. **When the SAME symptom is reported again after a fix has already
   shipped, do not assume it's the same bug.** Re-derive root cause from
   scratch: check the gateway's own log for what error is happening NOW
   (its shape may have changed — "no response at all" vs "a real 502"
   are different bugs even though both render as "stuck on Connecting"
   to a user), and check the container's own logs
   (`/var/log/nginx/error.log` inside the container was where root cause
   2 was actually found — not `desktop_proxy.rs`'s source).
6. **If you add or change anything in the plain-HTTP vs. WebSocket
   branches of `desktop_proxy`, change BOTH or explain in writing why
   only one needed it.** They are two independent code paths building
   two independent outbound URLs from the same incoming request; nothing
   enforces they stay consistent with each other except this rule. Root
   cause 2 existed specifically because the plain-HTTP branch was fixed
   (part of `52cfb07`) and the WebSocket branch was not — same file,
   same bug class, missed because there was no test exercising the
   WebSocket branch against a REAL nginx config (its own fixture used a
   raw TCP/axum echo server that accepts any path, so a wrong path never
   failed the test).

## Known remaining gaps (not fixed by any of the above, stated so they aren't mistaken for solved)

- `POST /workspaces/:id/diagnose` cannot detect the *other*, unrelated
  KasmVNC `lastActiveAt` client-JS crash (`7c9fe33`) — it only checks
  HTTP reachability, which stays healthy even while that bug is present.
  Not in scope for this postmortem's two root causes, but easy to
  conflate with them since both render as "the desktop is broken."
- `backend/workspace-image/e2e_test_kasmvnc_lastactiveat.py` talks to a
  container directly via `docker run`, never through `rust_gateway`'s
  own `desktop_proxy` — it structurally could not have caught either
  root cause in this doc, since both live in the gateway's own
  path-rewriting, not the container image. A passing E2E run for that
  test says nothing about this postmortem's bugs, and vice versa.
