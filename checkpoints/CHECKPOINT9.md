# Checkpoint 9 — read this first in a new session

Continues from `CHECKPOINT8.md`. This session took the chat feature from
"streams real tokens" to genuinely usable: readable markdown, a
collapsible thinking/tool trace instead of noise or raw JSON, a session
that survives a page reload (including reconnecting to a still-running
turn), one single URL-driven source of truth for which agent/session the
chat shows, and a "New chat" action. Read `CHECKPOINT.md` → `3` → `4` →
`5` → `6` → `7` → `8` first; this file only adds what changed since.

## Working alongside a second agent in the same checkout

This session ran with **Cursor's own agent active in the same working
tree at the same time** (confirmed by `Co-authored-by: Cursor
<cursoragent@cursor.com>` on real commits, e.g. `6d3b197`). In practice
this meant files this session had just written were repeatedly found
reverted back to an earlier state mid-session — not corruption, just an
uncoordinated second writer. Everything documented below was re-verified
against the actual working tree content at the end of the session, not
assumed from earlier in the conversation — several early "done" states in
this session's own history turned out to have been silently reverted
later and had to be rebuilt from scratch. If a future session hits the
same "my last edit vanished" symptom, check `git log --format='%an %s'`
for a second author before assuming self-inflicted damage.

## Repository state

Committed (`58128e5` = end of checkpoint 8):

```
7ec91b2 feat(frontend): sync workspace chat agent and session via URL
6d3b197 refactor(frontend): agent history panel lists sessions only
7fbbddb feat(frontend): render markdown, thinking trace, and tool activity in chat
07060e7 feat(frontend): persist chat sessions and reconnect in-flight turns on reload
bf2bf27 chore(frontend): add react-markdown and remark-gfm for chat rendering
6b94945 feat(gateway): auto localhost/127.0.0.1 CORS sibling + CORS_ENABLED toggle
feae107 style(frontend): chat card fills available height, composer row-aligned
79b9e86 fix(wrapper): neutralize Sec-Fetch-Site cross-site in loopback CSRF alignment
71898ae style(frontend): tighter vertical padding on CHAT agent rows (8px to 5px)
f891af8 fix(cors): pin dev port + log allowed origin, generic fix for recurring mismatch
39c2270 feat(frontend): unique deterministic avatar per agent
e8d2e3a fix(gateway): allow credentials in CORS so chat cookie calls work
0efac6d style(frontend): fix avatar-name gap and capitalize agent names in CHAT list
```

`79b9e86` (wrapper CSRF) is not this session's own work and was not
independently re-verified here — noted for completeness only.

Still **uncommitted** at end of session (small, both from the very last
turn — a header redesign's matching CSS, and the tests proving it):

```
 M frontend/src/features/chat/components/workspace-chat.test.tsx
 M frontend/src/styles/threads-app.css
```

Still uncommitted and untested, unchanged across five sessions now: the
Company-mode seeder tree (`backend/seeder/modes/company/`,
`backend/seeder/skills/org-*`).

**Deliberately NOT re-added this session, on direct instruction**: a
backend (`agent_history/service.py`) filter that excluded raw `role:
"tool"` history rows from the wrapper's own API response. It was built,
then explicitly reverted by direct instruction ("this is frontend the
frontend should handle this not backend") — the equivalent filter now
lives client-side only (`use-chat.ts`'s `isDisplayableHistoryMessage`),
described in section 3 below. Do not re-add the backend-side filter
without asking first.

## 1. CORS: fixed for real, not just documented

Two real, live-reproduced CORS bugs, both fixed with tests, not
workarounds:

- **Missing `Access-Control-Allow-Credentials`.** The chat proxy's
  browser client sends `credentials: 'include'` (needed for the
  `hermes_profile` cookie), but the gateway's `CorsLayer` never sent
  `Access-Control-Allow-Credentials: true`. A browser silently rejects a
  credentialed fetch without it, even with the origin matched exactly —
  curl/server-to-server calls looked completely fine, which is why this
  slipped through unit tests. Fixed: `.allow_credentials(true)` on the
  existing `CorsLayer`.
- **`localhost` vs `127.0.0.1` mismatch, recurring across this project's
  history.** Vite's dev server silently walks to the next free port when
  the configured one is taken, and separately, a browser tab open at
  `127.0.0.1:5173` is a genuinely different origin from
  `FRONTEND_ORIGIN=http://localhost:5173` even though they're the same
  machine. Fixed at the root: `frontend/vite.config.ts` now pins
  `server.port = 5173` + `strictPort: true` (Vite refuses to start rather
  than silently drifting to a mismatched port), and
  `rust_gateway/src/app.rs` gained `browser_allowed_origins()` — derives
  BOTH spellings of the same scheme+port automatically whenever
  `FRONTEND_ORIGIN` is exactly `localhost` or `127.0.0.1` (never a
  wildcard — `tower_http` refuses to pair `*` with
  `allow_credentials(true)` anyway, and a real wildcard would break every
  credentialed chat call). A strict host-boundary check stops this from
  over-matching a different real host that happens to share a string
  prefix (`127.0.0.11`, `localhost.evil.com`).
- New durable doc: `docs/troubleshooting.md`'s "Cross-origin (CORS)
  mismatch" entry — a 30-second diagnosis recipe plus why a wildcard was
  considered and rejected. Linked from the root `README.md`.
- The gateway now logs its exact allowed origin(s) on every startup
  (`CORS: only http://localhost:5173 or http://127.0.0.1:5173 may make
  browser requests here — ...`) so a future CORS error is a 5-second diff
  against the browser's address bar, not a code-reading exercise.

`rust_gateway`: 93 → 119 tests from this work alone (127 total now, with
the parallel `CORS_ENABLED` toggle commit on top).

## 2. Markdown rendering + collapsible Thinking/Tool cards

Message text was raw `<p>{text}</p>` — a real screenshot showed literal
`**nvidia/nemotron-3-super-120b-a12b:free**` unrendered in a live chat.
Fixed with `react-markdown` + `remark-gfm` (`markdown-content.tsx`) — AST
walked into React elements, never `dangerouslySetInnerHTML`, so this is
XSS-safe by construction, not by an added sanitizer step.

Separately, reasoning and tool-call activity were only ever shown while a
turn was actively streaming, then **permanently discarded** the instant
it settled — a real information loss, not just a display gap.
`ChatTurn` (`use-chat.ts`) now carries optional `reasoning`/`tools`,
snapshotted from the live stream at settle time. Two new components
render them **collapsed by default** on a completed turn (matches
upstream Hermes' own "Thinking" card convention — lightbulb icon, chevron
toggle, collapsed by default — see `backend/upstream/static/ui.js`'s
`thinking-card` template):

- `thinking-card.tsx` — reasoning trace
- `tool-activity.tsx`'s new `ToolActivitySummary` — tool-call trace,
  wraps the existing always-expanded `ToolActivityList` for the
  still-streaming case (collapsing an in-progress trace would hide
  genuinely useful "what is it doing right now" signal — only a
  *completed* turn's trace collapses)

## 3. Raw tool-result JSON no longer renders as a fake chat message

Real bug, seen live on reload: a `role: "tool"` history row's `content`
(a raw tool-execution result, often JSON-shaped —
`{"output": "...", "exit_code": 0, "error": null}`) was displayed
verbatim as if the agent had said it. Root cause: Hermes' own storage
tags a tool-result distinctly from `user`/`assistant`
(confirmed against upstream's own `role === 'tool'` handling throughout
`static/messages.js`), but nothing on the read path filtered it out.

**Fixed frontend-only, by direct instruction** (an equivalent backend fix
was built and explicitly reverted — see the note at the top of this
file): `use-chat.ts`'s `isDisplayableHistoryMessage()` excludes
`role: "tool"` rows and empty-content `assistant` placeholders (Hermes
writes an empty placeholder while a tool call is in flight, immediately
superseded by the turn's real eventual answer) from the seeded
transcript. Applies to every session-history read path, not just one
screen, since it lives in the one shared seeding function.

## 4. Session survives reload; an in-flight turn reconnects

Two real, separate gaps, both closed:

- **A hard reload silently created a brand-new session**, orphaning
  whatever was active — upstream's own `POST /api/session/new` always
  mints a new session id, it never returns an existing one, so nothing
  but explicit client-side persistence recovers this. Fixed: the
  resolved session id is persisted to `localStorage`, keyed by
  `workspaceId`+`agent` (`use-chat.ts`'s
  `readPersistedSessionId`/`writePersistedSessionId`, wrapped
  defensively — private-browsing storage failures degrade to
  "no persistence", never a crash).
- **A still-running turn vanished from the UI on reload** until its
  result showed up in history on the *next* reload — the UI looked idle
  while the agent was, in fact, still working. Fixed using an endpoint
  upstream already had and this project already proxied —
  `GET /api/session/status` (`api/session_ops.py::session_status`,
  already liveness-checked against a crashed-process ghost stream by
  upstream itself, not something this session had to build). New
  `getSessionStatus()` (`chat/api.ts`) backs a one-shot reconnect check in
  `use-chat.ts`: if the bound session has a genuinely active stream,
  `streamId` is set directly and the existing SSE hook reconnects to it
  — no new turn started, no message re-sent.

## 5. One single source of truth for "which agent/session is this chat on"

Before this session, THREE different pieces of UI could each show a
different agent: the CHAT sidebar list, the AUDIENCE panel, and this
screen's own agent-picker dropdown — none of them synced with each
other, and none synced with the URL, so a reload always fell back to the
first agent's default session regardless of what was on screen.

Now `WorkspaceChat` reads/writes `?agent=<name>&session=<id>` via
`useSearchParams` as the ONE state everything else is a controlled view
of:

- `ThreadsShell` gained optional `selectedAgent`/`onSelectAgent`
  (mirrors `AgentHistoryPanel`'s own pre-existing external-selection
  pattern) — the sidebar CHAT list and the AUDIENCE panel's own agent
  selection both derive from this prop when the caller controls it,
  instead of owning independent internal state. A sidebar click now
  updates the real chat's URL, not only the AUDIENCE panel's own
  selection (this was the literal bug reported: clicking "Builder" in
  the sidebar changed AUDIENCE but the visible chat never moved).
- `AgentHistoryPanel` gained `onSelectSession(agentName, session)` —
  clicking a session loads it into the real, sendable chat pane. This
  panel itself no longer shows a transcript of its own at all (see next
  section) — a click reports outward and nothing else.
- Documented, deliberate edge case: closing/backing out of the AUDIENCE
  panel while the URL still names an agent does NOT clear the chat's
  agent — `historyAgent` is *derived* from the controlling prop, so the
  panel snaps back open showing that same agent on the very next render.
  Collapsing a side panel is not the same action as navigating the chat
  away from an agent.

## 6. AUDIENCE panel is sessions-list-only now

A real screenshot showed the panel's own separate read-only message
viewer rendering raw unrendered markdown — reported as "don't show
session on right side, show only history/session." Removed entirely:
`MessagesList` (and its now-dead `messages-skeleton.tsx`, and the
now-dead `.audience-messages*` CSS) are gone. Clicking a session now only
fires `onSelectSession` (section 5) and the panel stays on the sessions
list — no second view to navigate into, no risk of it ever getting out
of sync with the real chat since it no longer duplicates that data at
all.

## 7. Same avatar identity everywhere

Chat message bubbles used a completely different avatar system
(`PixelAvatar`, a small fixed-palette CSS placeholder) than the sidebar
and AUDIENCE panel (`RandomAvatar`, a generative SVG keyed
deterministically by agent name) — same agent, two different pictures
depending on which screen you were looking at. `chat-message-list.tsx`
now uses `RandomAvatar` with the same `agent` seed everywhere an agent
identity renders; the human "You" bubble is untouched (`PixelAvatar
seed="you"`, a different identity, already consistent with this app's
other "you" icons).

## 8. Chat console width + header redesign; "New chat"

- The chat pane's card was capped at `max-width:700px` (a rule meant for
  readable text posts, applied to the live chat console too) even though
  its containing column was already flexible. Fixed with a single
  chat-only override (`max-width:none` on
  `.thread-card:has(.chat-composer)`) — regular thread/post views keep
  their reading-width cap.
- The header's agent-picker dropdown was removed — genuinely redundant
  once section 5 made the sidebar/AUDIENCE the real, single agent
  selector; a second dropdown showing the same choice was duplicate UI,
  not a second real control. Replaced with plain identity (avatar +
  name, not clickable) plus a live status line (`"Streaming…"` / real
  message count / `"No messages yet"`).
- New **New chat** button: `use-chat.ts`'s `newChat()` clears the
  persisted `localStorage` session id, invalidates/removes the cached
  session query, and resets local turn/stream state, so the very next
  `send()` creates a genuinely new, separate session — the old one is
  never deleted, still fully visible via AUDIENCE, just no longer
  active. Refuses while a turn is actively streaming (abandoning a live
  session mid-turn would orphan it server-side with nothing left
  tracking it). `WorkspaceChat`'s own `newChat()` wrapper additionally
  clears the URL's `?session=` — required, since an explicit
  `options.sessionId` binds at higher priority than anything the hook
  clears internally.

  Caught by testing my own test, not just the feature: a first version
  of the "clears persisted storage" test passed even against a
  no-op-stubbed `newChat()`, because clearing the URL alone already
  triggered enough of the hook's existing agent/session-reset effect to
  satisfy the (too-weak) assertions. Rewritten to isolate the claim by
  making `createSession` never resolve during that specific test — it
  now genuinely fails against the stub and passes against the real
  implementation.

## Test counts (all real, all green at end of session)

- `frontend`: **43/43** vitest + clean build + clean `tsc -b`.
- `rust_gateway`: **127/127** (93 at start of this session's CORS work;
  115 after it; 127 now including the parallel `CORS_ENABLED` commit).
- `backend/wrapper`: **98 passed, 1 skipped** (the skip is the same
  honest, pre-existing one from checkpoint 8 — needs `hermes_cli`, only
  ships in the Docker image).
- `backend/seeder_kit`: not re-run this session; no seeder_kit code was
  touched.

## Known gaps / not done this session

- Same standing gaps as `CHECKPOINT8.md`: no auth gate on
  `agent-config`/`agent-seeder`, Creator/Company modes have no backend
  content, `base_url` still not persisted by `POST /onboarding/setup`,
  approval/clarify still has no live (real-tool-triggered) exercise.
- **No browser has verified any of this session's UI work directly** —
  everything above is verified by real automated tests (unit +
  integration, with genuine test-first proof captured for the riskier
  claims) and live `curl` verification of the CORS fixes against a real
  running gateway, but nobody has clicked through the actual rendered
  page for the markdown/thinking-card/avatar/new-chat changes in this
  session. Worth doing before calling any of this fully done.
- The Company-mode seeder tree is still untracked and untested after
  five sessions now. Either verify and commit it, or delete it.
- This session's very last two files
  (`workspace-chat.test.tsx`, `threads-app.css`) are uncommitted — small,
  but real; commit them (or let the parallel Cursor session pick them up)
  before assuming the "New chat" header work is durably saved.
</content>
