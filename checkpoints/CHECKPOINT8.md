# Checkpoint 8 — read this first in a new session

Continues from `CHECKPOINT7.md`. This session built **streaming per-agent
chat**: a real send → SSE token stream → render pipeline, agent switching,
approval/clarify surfaces, and stop. It also fixed a gateway bug that made
streaming impossible at all. Read `CHECKPOINT.md` → `3` → `4` → `5` → `6`
→ `7` first; this file only adds what changed since.

## Repository state — now actually committed

Unlike checkpoints 6 and 7 (which left everything uncommitted), this
session committed its work:

```
0412eec feat(chat): streaming per-agent chat replacing the placeholder
1fa24aa feat(gateway): chat proxy namespace with per-agent profile cookie injection
6d566cc docs: checkpoints 6 and 7 (agent history, React Query migration)
da250cf fix(gateway): stream response bodies instead of buffering them
4345478 feat(frontend): TanStack Query for all server state, prefetch, skeletons, tests
fe0e9af feat(agent-history): read-only per-agent chat history end to end
```

Still uncommitted and still **untested**: the Company-mode seeder tree
(`backend/seeder/modes/company/`, `backend/seeder/skills/org-*`). Left
alone deliberately across four sessions now — it is somebody's in-flight
work that no suite covers.

## 1. The blocker: the gateway buffered every response

Before any chat work was possible, `forward_to` had to be fixed. It ended
with `upstream_response.bytes().await`, which waits for the ENTIRE upstream
body before sending anything downstream. For SSE — which never ends — that
means nothing ever reaches the browser.

Proven, not assumed. Against a real SSE backend emitting 1 event/second:

| | event arrival times |
| --- | --- |
| direct to backend | 33.30, 34.33, 35.48, 36.63, 37.77 |
| through the gateway (before) | 44.66, 44.67, 44.68, 44.69, 44.69 — all at once |
| through the gateway (after) | 44.38, 45.47, 46.61, 47.76, 48.91 |

Then confirmed against a real container: SSE keepalives from Hermes arrived
5s apart through gateway → wrapper → upstream.

The wrapper was already correct (`StreamingResponse` + a `drain()` async
generator); only the gateway was broken. Because every proxy namespace
shares `forward_to`, this silently degraded onboarding, agent-seeder,
agent-history, hermes-webui and desktop too.

The regression test asserts **timing** — the first chunk must arrive well
inside the backend's gap — so the old implementation fails on the deadline
rather than incidentally on chunk boundaries. Verified by mutation: putting
`.bytes().await` back fails the test at 1.01s; reverting restores green.

Review also caught that hop-by-hop headers (`Connection`, `Upgrade`, …)
were being relayed across the proxy boundary, contrary to RFC 9110. Fixed;
the WebSocket desktop proxy dials its own connection and does not go
through `forward_to`, so nothing there broke.

## 2. Understanding Hermes' chat protocol before writing code

A delegated deep-read of upstream produced
`rust_gateway/docs/hermes-chat-wire-contract.md` — a citation-backed
contract (every claim carries `file:line`, and unverifiable claims are
marked NOT CONFIRMED rather than guessed). It corrected four assumptions I
had already written into an implementation prompt:

- **`done` does NOT close the stream.** The close set is exactly
  `{stream_end, cancel, apperror, error}`. `done` means content is final;
  `stream_end` means the connection is over. Two separate states are
  required — upstream keeps `_streamFinalized` and `_terminalStateReached`
  for exactly this reason.
- **`cancelled` is not an event.** Cancellation arrives as event `cancel`
  whose payload contains `type: "cancelled"`. Likewise `thinking-related`
  is not an event (thinking is driven by `reasoning`), and `error` is
  EventSource's native transport callback, not a server event.
- **The stream is a one-shot queue, not a replayable log.** On reconnect
  you get only events produced during the outage. Resetting accumulated
  text on reconnect is a data-loss regression upstream explicitly warns
  against.
- **Approval decisions are `once` / `session` / `always` / `deny`** — not
  approve/deny.

## 3. Per-agent chat: the cookie problem, and why the gateway solves it

An agent is a Hermes profile. A session is durably bound to a profile at
creation (`POST /api/session/new` with an explicit `profile`), but starting
a turn on that session requires a matching `hermes_profile` cookie.
Measured live on a session created with `profile: "pm"`:

- `POST /api/chat/start` with no cookie → `{"error": "Session not found"}`
- with `Cookie: hermes_profile=pm` → `{"stream_id": "88a0219c…", …}`

The browser cannot solve this: a cookie is origin-global, so N agents in
one tab cannot each send a different one, and **`EventSource` cannot set
headers at all** — disqualifying, since the chat stream is SSE. The wire
contract concludes a backend proxy injecting the cookie per request is the
only clean option. This gateway already is that proxy.

New namespace `ANY /workspaces/:id/chat/*path` forwards to Hermes' native
API and translates `?agent=<name>` into the cookie. The agent name is
validated against a conservative charset — an unvalidated value here is a
header-injection vector. Verified live: CRLF (`pm%0d%0aX-Evil:%201`),
semicolon and space attempts all return 400; valid agents pass; and
`?agent=default` against a `pm` session is correctly rejected, so
cross-agent isolation holds at the transport layer too.

## 4. The chat feature

`workspace-chat.tsx` rendered hardcoded fake messages (Courtney/Rosalee)
with a local-only composer. It now streams real turns: agent picker (reusing
`useAgents`, no duplicate fetch), live token rendering, tool activity,
approval and clarify prompts, stop, and a retry when the connection drops.

Review found 6 issues including 2 Critical, all fixed:

- **Critical:** session creation read a top-level `session_id`, but Hermes
  returns it nested (`{"session":{"session_id":…}}`) — every send would
  have failed with a 400 for a missing session id.
- **Critical:** `done` indirectly tore down the EventSource (the parent
  cleared `streamId`, whose cleanup closed the source), violating the
  contract and letting a second send start before the connection was final.
- Transport errors abandoned a live turn silently; now the accumulated text
  is preserved and an explicit retry is offered, with a
  `TODO(stream-replay)` naming the real fix.
- An agent switch mid-send could bind agent A's stream id to agent B's
  session; now guarded and the orphaned backend turn is cancelled.
- Dead code removed.

Two guards were mutation-tested: reintroducing top-level session parsing
fails 2 tests; letting `done` close the stream fails 1. Both green after
reverting, with files diffed byte-for-byte to confirm no residue.

## 5. Honest gap: no real model tokens were streamed

Everything above is verified, but I could not complete the last mile —
watching real model tokens render — because **no LLM provider credentials
are available in this environment**.

I got as far as standing up a fake OpenAI-compatible streaming server and
pointing a workspace at it. The turn then failed with *"Provider 'openai'
is set in config.yaml but no API key was found"*, and I confirmed the cause:
the key is written to `/config/.hermes/.env` (and the per-profile `.env`)
but is **not present in any running process's environment** (`grep -c
OPENAI_API_KEY /proc/<pid>/environ` → 0 for every Hermes process).

Two findings worth recording, both **pre-existing and unrelated to this
session's code**:

1. This reproduces on the **default** profile through the supported
   onboarding flow, not just on a seeded agent — so it is not caused by the
   per-agent work.
2. `POST /onboarding/setup` accepted a `base_url` but did not persist it;
   `config.yaml` kept `https://api.openai.com/v1`. Worth a look separately.
3. ~~A seeded agent's profile has **no model section at all**~~ — **FIXED
   this session** (commit `41774a1`). The seeder called `create_profile_api`
   with only the agent slug, ignoring its `clone_from`/`clone_config`
   parameters. New agent profiles now clone the root profile's
   `config.yaml`/`.env`, so an agent inherits the provider and credentials
   onboarding already configured. Verified on a real container:
   `profiles/pm/config.yaml` now carries the inherited model section, and
   both `.env` files stay `0600`.

   Review caught a latent bug in the same change: `clone_config` also copies
   `SOUL.md`, so any agent *without* its own `soul.md` would silently adopt
   the root's "You are Hermes Agent…" identity. Invisible today because
   every Simple-mode agent defines a soul, so the inherited file is now
   removed for a freshly created soul-less agent rather than waiting for
   someone to add one and wonder why their agent has the wrong persona.
   Mutation-tested: neutralising the removal fails the new test.

What this means: the transport is proven end-to-end (real SSE, real
container, correct events, correct per-agent routing), and the client
correctly renders the `context_status` and `apperror` events it actually
received. The token-rendering path is covered by tests but has not been
watched against a live model.

## Test counts (all green)

- `rust_gateway`: **114/114** (103 → 105 streaming → 114 chat proxy).
- `frontend`: **26/26** vitest (18 → 26; 8 new chat tests) + clean build.
- `backend/wrapper`: **89/89** (85 → 88 seeder model inheritance → 89 the
  SOUL.md guard). `backend/seeder_kit`: **38/38**.

## Next

1. **Get a real provider key in and watch tokens render.** Everything else
   is in place; this is the one unproven link, and it needs a credential
   this environment does not have.
2. Investigate the `.env`-not-in-process-environment behavior (gap 1) and
   the dropped `base_url` (gap 2). Gap 1 is the reason the fake-provider
   test could not complete, and it reproduces on the default profile
   through the supported onboarding flow — so it is worth understanding
   before blaming anything in this session's code.
3. Approval/clarify have no live exercise yet — they are implemented and
   unit-tested, but no real tool-approval round trip has been observed.
4. The Company-mode seeder tree is still untracked and untested after four
   sessions. Either verify and commit it, or delete it — leaving it in the
   working tree indefinitely is the worst of both.
</content>
