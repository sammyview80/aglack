# Troubleshooting — recurring dev-environment errors

Generic fixes for errors that keep coming back across sessions because
they are environment/config drift, not application bugs. Add a new
section here the next time an error class recurs more than once —
narrating it in a `CHECKPOINT*.md` once is fine, but a checkpoint is
history, not a fix; this file is where the durable fix and the durable
"how to recognize it" both live.

## Cross-origin (CORS) mismatch — "reverse proxy headers" / browser CORS error

**Symptom:** A browser network request to `rust_gateway` fails with a CORS
error (console message mentioning `Access-Control-Allow-Origin`,
`Access-Control-Allow-Credentials`, "CORS policy", "reverse proxy
headers", or similar) even though the exact same request works fine via
`curl`. The gateway process itself is up and healthy; `curl` against it
returns normal responses. Only the browser is affected.

**Why this looks confusing:** CORS is enforced entirely by the *browser*,
never the server. The gateway can be 100% correct and still produce a
browser CORS error, because the actual cause is almost always that the
browser's address bar origin does not exactly match what the gateway was
told to allow — not a code bug in either the frontend or the gateway.

**Root cause, in order of likelihood:**

1. **Port drift.** Vite's dev server walks to the next free port
   (5173 → 5174 → 5175 → …) if the configured one is already taken by a
   stale/leftover process, but `rust_gateway`'s `FRONTEND_ORIGIN` is one
   fixed string, matched exactly (scheme + host + port, no wildcard, no
   partial match). If the browser is open at `http://localhost:5176` but
   the gateway only allows `http://localhost:5173`, every request from
   that tab is blocked — this exact failure has recurred multiple times
   in this project's history (see `CHECKPOINT.md`, `CHECKPOINT1.md`).
   **Fixed at the source**: `frontend/vite.config.ts` now pins
   `server.port = 5173` with `strictPort: true` — Vite refuses to start
   rather than silently drifting to a different, CORS-mismatched port.
   If you see `Error: Port 5173 is already in use`, that is the fix
   working as intended: find and stop whatever else is holding 5173
   (`ps aux | grep vite`, or any other dev server) instead of letting the
   port drift.
2. **`127.0.0.1` vs `localhost`.** These are different origins to a
   browser even though they resolve to the same machine. Whichever one is
   in your browser's address bar must be the same one configured in
   `rust_gateway/.env`'s `FRONTEND_ORIGIN`. This project's convention is
   `localhost` (see `rust_gateway/.env.example`'s own comment on
   `FRONTEND_ORIGIN` — Vite's dev server binds `localhost` by default).
3. **`http` vs `https`.** Same rule — scheme is part of the origin.
4. **Stale gateway process.** You fixed `FRONTEND_ORIGIN` (or a CORS
   header bug in the gateway itself) but a still-running OLD gateway
   process is what's actually answering the port — the fix never took
   effect because nothing was restarted. See "Restarting the stack
   cleanly" below.
5. **Missing `Access-Control-Allow-Credentials`.** Distinct from the
   above: if the failing call uses `fetch(..., { credentials: 'include' })`
   (the chat proxy does, for its `hermes_profile` cookie — see
   `frontend/src/features/chat/api.ts`), the origin can match exactly and
   the request will *still* fail unless the gateway's CORS layer also
   sends `Access-Control-Allow-Credentials: true`. This was a real gap,
   fixed in `rust_gateway/src/app.rs`'s `CorsLayer`
   (`.allow_credentials(true)`) — if you see this exact symptom again on
   a *different* proxy route, check whether that route's frontend client
   also uses `credentials: 'include'` and whether the CORS layer covers
   it (there is only one shared `CorsLayer` for the whole router, so this
   should not recur, but a future per-route CORS override could
   reintroduce it).

**How to diagnose fast (30 seconds, no code reading required):**

1. Look at the gateway's own startup log line — it now prints the exact
   allowed origin on every boot:
   ```
   CORS: only http://localhost:5173 may make browser (fetch/XHR) requests here — ...
   ```
   Compare that string, character for character, against your browser's
   actual address bar origin (scheme + host + port). Any difference is
   the bug.
2. Reproduce with `curl` using the browser's ACTUAL origin, not the
   expected one:
   ```bash
   curl -sS -i -X OPTIONS "http://127.0.0.1:8080/workspaces/<id>/chat/api/session/new" \
     -H "Origin: <exact browser origin>" \
     -H "Access-Control-Request-Method: POST" \
     -H "Access-Control-Request-Headers: content-type"
   ```
   If the response has no `access-control-allow-origin` header (or it
   names a different origin than what you sent), the gateway is rejecting
   that exact origin — go fix `FRONTEND_ORIGIN` or the browser tab's URL,
   whichever is actually wrong. If `access-control-allow-origin` IS
   correct but `access-control-allow-credentials` is missing and the
   real call uses `credentials: 'include'`, that's cause #5 above.

**Restarting the stack cleanly** (needed for cause #4, and safest after
any gateway code change):

```bash
# Find anything already listening on the gateway's port/frontend port
ps aux | grep -E "target/debug/rust_gateway|target/debug/test_backend|vite"

# Kill the specific stale pids found above, then restart clean
kill <pid> <pid> ...
./run.sh          # or: aglack up
```

A rebuilt gateway binary with a genuine fix does nothing until the OLD
running process is actually killed and a new one started — `cargo build`
alone does not restart anything.

## See also

- `checkpoints/CHECKPOINT5.md` — a different class of "test suite all
  green, real thing still broken" bug (container filesystem permissions,
  not CORS) with the same underlying lesson: a browser/real-container
  boundary can hide a bug that no unit test, and no `curl`, exercises.
- `docs/desktop-websocket-connection-postmortem.md` — another
  environment-boundary postmortem, for the desktop/KasmVNC proxy.
</content>
