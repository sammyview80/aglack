# Streaming response bodies through `forward_to` — plan (plain language)

Status: **fix, documented after the fact** — the bug was proven live
before this doc was written; this records why the fix works the way it
does.

## What was broken

`forward_to` (`proxy/forward.rs`) is the one function every proxy route
in this gateway shares — the fixed backend, and every per-workspace
route (onboarding, agent-seeder, hermes-webui, desktop, agent-history).
It used to finish like this: wait for `upstream_response.bytes().await`
to collect the ENTIRE upstream body into memory, then hand that whole
blob to axum as the outgoing response.

For an ordinary JSON or static-file response that's wasteful but
harmless — the body is finite and usually small, so "wait for all of it"
costs a few extra milliseconds. For a Server-Sent Events stream it is
fatal: an SSE response is not supposed to have an end. The connection
stays open and the backend pushes events as they happen. "Wait for the
whole body" therefore means "wait forever" — nothing reaches the browser
until the backend closes the connection, at which point every event
arrives at once, all its useful real-time behavior gone.

This was measured against a real SSE backend emitting one event per
second:

- direct to the backend: events arrived roughly 1 second apart —
  `t=33.30, 34.33, 35.48, 36.63, 37.77`
- through this gateway (before the fix): all five events arrived
  together at `t=44.66`

Because every proxy namespace funnels through `forward_to`, this wasn't
a bug in one route — it silently broke streaming for all of them at
once, and blocked streaming chat entirely.

## The fix

`forward_to` now converts the upstream `reqwest::Response` into an axum
`Body` via `Body::from_stream(upstream_response.bytes_stream())` instead
of buffering it with `.bytes().await`. Each chunk the backend sends is
handed straight to the outgoing response as it arrives — the gateway no
longer waits for the backend to finish before it starts replying.

This only changes how the RESPONSE body is handled. The REQUEST body is
still read fully with `to_bytes` before being sent upstream — request
bodies in this gateway are ordinary POST payloads (JSON, form data),
not something a caller needs streamed out, so there was no matching bug
on that side.

The response-header relay (which headers are copied from upstream, and
the deliberate skip of `Content-Length`/`Transfer-Encoding` — see the
comment in `forward_to`) is unchanged. Streaming the body doesn't change
which headers are correct to forward; it changes when the body's bytes
move.

## The tradeoff this introduces

Before the fix, if the upstream connection died partway through, the
gateway could still return a clean `502 backend unreachable` — nothing
had been sent to the caller yet, because everything was buffered first.

After the fix, that's no longer always true. Headers and the first
chunks of the body may already be on their way to the caller by the
time a later chunk fails to arrive. If the upstream connection breaks
mid-stream, the gateway cannot retroactively turn an already-started
`200 OK` response into a `502` — the response has already begun. The
connection simply ends early instead. This is a direct, unavoidable
consequence of not buffering the whole body first, and is considered an
acceptable tradeoff: the alternative (buffer everything, so failures can
always downgrade to a clean 502) is exactly the behavior that broke SSE
in the first place.

The existing `Err(err)` arm — used when the upstream can't be reached
AT ALL, before any response starts — is untouched; that case still
produces a clean `502 backend unreachable`.
