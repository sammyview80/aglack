# Hermes WebUI — Chat Wire Contract

**Scope:** `/Users/saman/Documents/personal/hermano/revamp/backend/upstream`
**Sources read:** `api/routes.py` (29390 lines), `api/streaming.py` (13389), `api/clarify.py` (255, read in full), `api/route_approvals.py`, `api/todo_state.py`, `api/background_process.py`, `api/profiles.py`, `api/auth.py`, `api/run_journal.py`, `server.py`, `static/messages.js` (9328).
**Nothing was modified.** Every claim below carries a `file:line` citation. Claims I could not verify are marked **NOT CONFIRMED**.

---

## Summary for implementers

### Minimum endpoint sequence to send one message and render a streamed reply

1. **`POST /api/session/new`** → `{"session": {...}}`; take `session.session_id`. Pass `profile` explicitly (`api/routes.py:15343`).
2. **`POST /api/chat/start`** with `{session_id, message}` (rest optional) → 200 `{stream_id, session_id, pending_started_at, turn_id, title}` (`api/routes.py:23211-23217`).
3. **`GET /api/chat/stream?stream_id=<stream_id>`** — EventSource. `stream_id` comes from step 2's **top-level** `stream_id` field.
4. Append `d.text` on each `token` event (`static/messages.js:5722`).
5. Stop on `done` + `stream_end` (normal), `cancel` (cancelled), or `apperror`/`error` (failure).

Optional side channels, both keyed by `session_id` (not `stream_id`): `GET /api/approval/stream?session_id=…` and `GET /api/clarify/stream?session_id=…`. Approvals/clarifies **also** arrive inline on the chat stream, so a minimal client can ignore both side channels.

### Top 3 gotchas

1. **The stream is a one-shot queue, not a replayable log — an EventSource auto-reconnect silently loses tokens.** The long comment at `static/messages.js:5704-5717` exists specifically to correct a wrong assumption: the server "replays buffered token events" is **NOT** how it works. `api/routes.py:18835` reads a `queue.Queue` delivering each event to exactly one consumer. On browser auto-reconnect you receive only events produced *during the outage* — everything emitted before it is gone forever. You must **not** reset your accumulator on reconnect (that is a data-loss regression), and you must send the replay cursor (`&replay=1&after_seq=N&after_event_id=…`, `static/messages.js:5345`) to recover journal events. The vanilla client never relies on EventSource's own reconnect: on `error` it closes the source and re-opens with explicit replay params (`static/messages.js:6702-6730`, `7190-7194`).

2. **Four of the events on your list do not exist, and terminal-event semantics are counterintuitive.** `thinking-related` and `cancelled` are **not SSE events** (see §2.3) — cancellation arrives as event `cancel` whose *payload* contains `"type": "cancelled"` (`api/streaming.py:229-233`). Worse: **`done` does not close the stream.** The server's close set is exactly `{"stream_end", "cancel", "apperror", "error"}` (`api/run_journal.py:45`). A normal turn emits `done` **then** `stream_end`, and a background title thread can delay `stream_end` (`api/streaming.py:12296-12308`). Treat `done` as "content final", `stream_end` as "connection over".

3. **Per-agent chat requires a `hermes_profile` cookie; the `profile` body field will not select a profile.** In `_handle_chat_start`, `body["profile"]` is only a *validation/retag guard* — it is compared against the ambient active profile and never used to choose the runtime (`api/routes.py:24115-24141`); it is not in `start_run_kwargs` (`api/routes.py:24276-24288`). The real switch is a **thread-local** set per-request from the `hermes_profile` cookie (`api/profiles.py:467-480`, `server.py:376-378`). See §6 — this works for concurrent per-agent chat, but only via that cookie, and there is a documented worker-thread caveat.

---

## 1. Starting a turn

### 1.1 `POST /api/chat/start` — request body

Handler: `_handle_chat_start`, `api/routes.py:24018`. Dispatch: `api/routes.py:16383-16384`.

**Required**

| Field | Notes |
|---|---|
| `session_id` | `require(body, "session_id")` → 400 on absence (`api/routes.py:24022-24024`) |
| `message` | Required *unless* `regenerate: true`. Trimmed; empty → 400 `"message is required"` (`api/routes.py:24161-24163`) |

**Optional**

| Field | Type | Behavior |
|---|---|---|
| `workspace` | string | Explicit path wins; else recovered from session (`api/routes.py:24180-24189`, `24337-24354`) |
| `model` | string | Falls back to `s.model` (`api/routes.py:24190`) |
| `model_provider` | string | **Presence-sensitive**: `"model_provider" in body` distinguishes explicit `null` from absent (`api/routes.py:24191-24195`) |
| `profile` | string | **Validation guard only** — see §6. Validated against `_PROFILE_ID_RE` unless `"default"`; invalid → 400 `"invalid profile"` (`api/routes.py:24115-24124`) |
| `explicit_model_pick` | bool | Stamps a model signature (`api/routes.py:24197`, `24228-24230`) |
| `attachments` | array | Capped at 20; accepts filename strings or `{name,path,mime,size?,is_image?}` (`api/routes.py:24166`, normalizer `24368-24395`) |
| `moa_config` | truthy | 409 on gateway-backed sessions (`api/routes.py:24201-24203`) |
| `regenerate` | `true` | Mutually exclusive with `message`/`attachments`/`keep_count`/`prompt`/`prompt_index` (`api/routes.py:24143-24145`) |
| `regeneration_revision` | string | Required when `regenerate: true` (`api/routes.py:24146-24147`) |

### 1.2 Success response — where `stream_id` lives

Built at `api/routes.py:23211-23217`, returned via `j(handler, response, status=status)` at `api/routes.py:24330`:

```json
{
  "stream_id": "<uuid4().hex>",
  "session_id": "...",
  "pending_started_at": 1234567890.0,
  "turn_id": "...",
  "title": "...",
  "effective_model": "...",
  "effective_model_provider": "..."
}
```

- **`stream_id` is a top-level field** — this is the identifier used to open the stream. Generated by `uuid.uuid4().hex` (`api/routes.py:23125`).
- `effective_model` only present when the model was normalized (`api/routes.py:23218-23219`); `effective_model_provider` only when a provider resolved (`23220-23221`).
- `turn_id` comes from the journal event and **may be `None`** if journaling failed (`api/routes.py:23215`, non-fatal at `23173-23174`).
- Client usage confirms the top-level read: `const streamId=response&&response.stream_id` (`static/messages.js:1978`).
- Under the runtime-adapter path the response is filtered to this same allowlist (`api/routes.py:23242-23263`), with `stream_id`/`session_id` defaulted from the result object (`23261-23262`).

**Special 200 (not an error):** a message of exactly `"[SILENT]"` returns `{"status":"suppressed","reason":"silent_control_message"}` with **no `stream_id`** (`api/routes.py:24025-24030`, sentinel at `24006-24015`).

### 1.3 Error paths

| Status | Body | Trigger |
|---|---|---|
| 400 | `{"error":"session_id is required"}` (via `require`) | missing `session_id` (`24022-24024`) |
| 400 | `{"error":"message is required"}` | empty message (`24162-24163`) |
| 400 | `{"error":"invalid profile"}` | profile fails `_PROFILE_ID_RE` (`24121-24122`) |
| 400 | `{"error":"regeneration accepts only regeneration_revision","code":"invalid_regeneration_request"}` | extra keys with `regenerate` (`24144-24145`) |
| 403 | `{"error":"session is read-only in its foreign store; cannot be claimed writeable in WebUI"}` | foreign non-claimable session. **Deliberately 403 not 404** so the client does not self-heal-and-wipe (`24067-24083`) |
| 403 | `{"error":"Read-only imported sessions cannot be continued from WebUI"}` | `PermissionError` (`24112-24113`) |
| 404 | `{"error":"Session not found"}` | unknown session, or invisible to active profile (`24066`, `24141`) |
| 409 | `{"error":"session already has an active stream","active_stream_id":"..."}` | **busy session** (`23063-23067`, `23095-23099`, `23105-23109`, `23144-23148`) |
| 409 | `{"error":"...","code":"stale_regeneration_revision"}` | missing/mismatched revision (`24147`; raised `api/session_ops.py:126`, `448`) |
| 409 | `{"error":"...","code":"session_active"}` | regeneration while active (`api/session_ops.py:450`, `452`) |
| 409 | `{"error":"...","code":"unsupported_regeneration_backend"}` | runner backend (`24035-24038`, `23322`) |
| 409 | `{"error":"...","type":"agent_runtime_stale","retryable":true}` | stale runtime barrier (`24042-24044`; shape `23020-23024`) |
| 409 | `{"error":"...","type":"compression_recovery_required","recommended_recovery_action":…,"compression_recovery":…,"session_id":…}` | exhausted compression + generic continuation (`24167-24179`) |
| 400 | `{"code":"no_regenerable_turn"}` | `api/session_ops.py:480`, `485`, `510` |
| 403 | `{"code":"regeneration_read_only"}` | `api/session_ops.py:488` |
| 409 | `{"error":"MoA override is unavailable on gateway-backed sessions"}` | `24203`, `24264` |
| 500 | `{"error":"failed to claim session: …"}` | sidecar persist failure; paths sanitized (`24097-24101`) |
| 501 | `{"error":"..."}` | no runtime adapter (`24319-24323`, `23362-23363`) |
| 503 | MoA resolution `RuntimeError` | `24208-24209`, `24270-24271` |

Note the two distinct `code` families: regeneration codes (`stale_regeneration_revision`, `session_active`, `no_regenerable_turn`, `regeneration_read_only`, `invalid_regeneration_request`, `unsupported_regeneration_backend`) and the `type`-keyed ones (`agent_runtime_stale`, `compression_recovery_required`). The busy-session 409 carries **no `code`** — the vanilla client string-matches `/session already has an active stream/i` (`static/messages.js:1842`), which is fragile; prefer matching on status 409 + presence of `active_stream_id`.

### 1.4 Is there a non-streaming `POST /api/chat`?

**Yes.** Dispatch `api/routes.py:16386-16387` → `_handle_chat_sync` (`api/routes.py:24398`). Its own docstring says: *"Fallback synchronous chat endpoint (POST /api/chat). **Not used by frontend.**"* (`api/routes.py:24399`).

It runs the agent inline under a global `CHAT_LOCK` (`api/routes.py:24440`) and mutates `os.environ` under `_ENV_LOCK` (`24430-24436`). **Recommendation: do not use it for a React frontend** — it is process-serialized, has no incremental output, no approval/clarify surface, and no cancel. It exists for non-browser/no-SSE callers. It also rejects subagent sessions with 400 (`24403-24404`).

---

## 2. Consuming the stream

### 2.1 `GET /api/chat/stream` — query parameters

Dispatch `api/routes.py:14385-14386` → `_handle_sse_stream` (`api/routes.py:18756`).

| Param | Meaning |
|---|---|
| `stream_id` | **Required in practice**; `qs.get("stream_id",[""])[0]` (`18758`) |
| `replay` | Marks resume intent; presence alone counts (`18286`) |
| `after_seq` | Same-run cursor seq (`18282`) |
| `after_event_id` | Run-aware cursor, guards against seq restart (`18285`) |
| `cursor` | Opaque runner-backend cursor only (`18779`) |

Client construction (`static/messages.js:5345`):
```js
`&replay=1&after_seq=${_runJournalReplayAfterSeq()}&after_event_id=${_lastRunJournalEventId||''}`
```
Full URL at `static/messages.js:7194`, `2663`, `6748`, `6753`; sent with `{withCredentials:true}`.

**Precedence (`api/routes.py:18270-18281`):** explicit query params win *by presence, not by parsing*; `Last-Event-ID` is consulted only when no explicit cursor was supplied — so a header can never silently override and skip events. An unusable cursor (malformed/foreign/ahead-of-stream) replays from the start rather than skipping (`18264-18268`, `18800-18801`).

If the stream id has no live worker, the server serves a **journal replay** instead and returns 404 `{"error":"stream not found"}` only when no journal exists either (`18769-18812`).

Response headers: `text/event-stream; charset=utf-8`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`, `Connection: close` (`18818-18823`). Wire format is standard `event:` + `data:` JSON (`api/streaming.py:7735-7739`). Heartbeat comment `: heartbeat` (`18837`).

> ⚠️ `Connection: close` on this endpoint is flagged elsewhere in the same codebase as causing "EventSource reconnect storms in browsers on long-lived SSE" (`api/routes.py:18890-18891`) — that comment explains why a *sibling* endpoint omits it. The chat stream still sends it.

### 2.2 Event catalogue

All payloads below are read from the `put(...)` emit sites in `api/streaming.py`.

| Event | Payload fields | UI behavior |
|---|---|---|
| `token` | `{text}` (`9588`) | **Appends**: `assistantText+=d.text` (`messages.js:5722`) |
| `interim_assistant` | `{text, already_streamed, reasoning_echo?}` (`9645-9659`) | Separate visible block; `already_streamed` → segment boundary only (`5743-5786`) |
| `reasoning` | `{text}` (`9487`, `9632`, `9746`) | **Incremental** delta; coalesced server-side to ≥0.1s (`9629-9632`). Thinking card |
| `tool` | `{event_type, name, preview, args}` (`9783-9788`, `9902`) | Live tool card (`5849`) |
| `tool_complete` | `{event_type, name, preview, args, duration, is_error}` (`9840-9847`, `9938`) | Completes card (`5885`) |
| `done` | `{session, usage, terminal_state?, terminal_reason?}` (`12277-12279`); ephemeral adds `{ephemeral:true, answer}` (`10790-10795`) | Finalizes content; **does not close** (`6101`) |
| `stream_end` | `{session_id}` (`12308`, `12603`) | Closes stream (`6416`) |
| `error` | — | **Native `EventSource` transport error, not a server event.** Triggers reconnect/replay (`6702`) |
| `apperror` | `{type, message, hint?, details?, session_id?, old_session_id?, new_session_id?, continuation_session_id?, terminal_state?, terminal_reason?}` (`11260`, `11430`, `12765`; assembled `11251-11259`) | Terminal error (`6557`) |
| `warning` | `{type, message}` — `type` includes `"fallback"`, `approval_gateway_unsupported`, `approval_gateway_offline` (`9121`) | Non-fatal notice (`6684`) |
| `cancel` | `{message, type:"cancelled", status:"cancelled", session?, session_id?}` (`api/streaming.py:229-236`) | Terminal cancel (`6819`) |
| `approval` | See §3.2 | Approval card (`5964`) |
| `clarify` | `{question, choices_offered, session_id, kind:"clarify", requested_at, timeout_seconds, expires_at, clarify_id}` (`9423`; built `9430-9437`; `clarify_id` injected `api/clarify.py:168`; timeouts `86-99`) | Clarify card (`5972`) |
| `compressing` | `{session_id, message}` (`9112-9115`) | Progress (`6472`) |
| `compressed` | `{session_id, old_session_id, new_session_id, continuation_session_id, message, usage}` (`11511-11518`) | **Can rotate session id** (`6502`) |
| `context_status` | `{session_id, prefill}` (`10077-10080`) | Context indicator (`6011`) |
| `goal` | `{session_id, state, message, message_key, message_args?, decision?}` — `state` ∈ `evaluating`/`continuing`/`idle` (`12233-12237`, `12248-12255`) | Goal status (`6039`) |
| `goal_continue` | `{session_id, continuation_prompt, text, message, message_key, message_args, decision}` (`12262-12270`) | Queues next turn (`6057`) |
| `metering` | `{session_id, usage, tps?, tps_available?, estimated?, …}` (`9042`, `9501`, `12285-12288`) | TPS/context; ignored unless `tps_available===true && !estimated` (`6537-6553`) |
| `pending_steer_leftover` | `{session_id, text}` (`12199-12202`) | Re-queues unused steer (`6447`) |
| `state_saved` | `{session_id, kind, action, name?}` — `kind` ∈ `memory`/`skill` (`11922-11933`) | Toast (`5980`) |
| `title` | `{session_id, title}` (`4765`, `4843`) | Updates title (`5989`) |
| `title_status` | `{session_id, status, reason?, title?, raw_preview?}` (`4574-4582`) | Title progress (`5996`) |
| `todo_state` | `{session_id, stream_id, source, ts, **snapshot}` where snapshot = `{todos, summary}` (`api/todo_state.py:280-286`) | Todos panel; drops older `ts` (`5931`) |
| `bg_task_complete` | `{session_id, task_id, completed_at, event_id, summary?}` (`api/background_process.py:595-625`) | Live-view only (`6095`) |

### 2.3 Events on your list that are NOT distinct events

Verified by enumerating every `addEventListener` inside `_wireSSE` (`static/messages.js:5697-6900`) — 25 listeners, exhaustively:

- **`thinking-related` — does not exist.** No `thinking` SSE event or listener. Thinking UI is driven by `reasoning`. "thinking" appears only as an internal render role (e.g. `messages.js:2978`, `3109`, `4229`).
- **`cancelled` — not an event.** It is the *value* of `type`/`status` inside the `cancel` payload (`api/streaming.py:231-232`), read at `messages.js:6841`. Also appears as an `apperror` `type` (`6610`).
- **`error` — not a server-sent SSE event.** It is `EventSource`'s native transport-error callback; the code comments confirm it is "distinct from the SSE network 'error' event" (`messages.js:6571-6572`). Server-originated failures come as `apperror`. (Caveat: `"error"` *is* in the server's close set at `api/run_journal.py:45`, so a relay may forward an upstream event by that name; I found no `put('error', …)` site in `api/streaming.py` — **NOT CONFIRMED** that the server ever emits one directly.)
- **`compressing`/`compressed`** are two genuinely distinct events (`9112`, `11511`).
- **`goal`/`goal_continue`** are distinct (`12233`, `12262`).

### 2.4 Terminating events; distinguishing completion / cancel / error

Server close set (`api/run_journal.py:45`):
```python
SSE_RELAY_CLOSE_EVENTS = frozenset({"stream_end", "cancel", "apperror", "error"})
```
The drain loop breaks on these (`api/routes.py:18857-18858`).

- **Normal completion** → `done` then `stream_end`. **`done` is deliberately absent from the close set**; content is final at `done`, but the socket closes at `stream_end` (`api/streaming.py:12279` → `12308`). A background title thread can delay `stream_end` (`12296-12308`).
- **Cancellation** → `cancel`, payload `type`/`status` = `"cancelled"` (`api/streaming.py:229-236`).
- **Error** → `apperror` with a `type` field. Note `apperror` with `type: "cancelled"`/`"interrupted"` is mapped by the client to a *cancel* lifecycle, not an error (`messages.js:6579`).

Practical client rule: treat `done` as content-final and set a finalized flag; treat `stream_end`/`cancel`/`apperror` as connection-final; treat native `error` as *transient* → reconnect with replay params. The vanilla client keeps both `_streamFinalized` and `_terminalStateReached` flags and gates every terminal handler on them (`5720`, `6101-6111`, `6416-6419`) — because `stream_end` can legitimately arrive without a preceding `done` on replay/journal paths (`6432-6436`).

### 2.5 `token` — cumulative or incremental?

**Incremental. The client appends.**

```js
assistantText+=d.text;
```
— `static/messages.js:5722`.

Server-side confirms delta semantics: it also appends to a shared mirror, `STREAM_PARTIAL_TEXT[stream_id] += str(text)` (`api/streaming.py:9586`), immediately before `put('token', {'text': text})` (`9588`).

`reasoning` is likewise incremental (`api/streaming.py:9632`, mirror `+=` at `9630`). By contrast `todo_state` sends a **full snapshot** each time and is idempotent under replay (`api/todo_state.py:267-270`).

### 2.6 Reconnection semantics — the warning near the top of `_wireSSE`

The comment at `static/messages.js:5704-5717` corrects an explicitly-named wrong assumption. Paraphrased, with its own emphasis:

> The original PR description stated the server "replays buffered token events" on reconnect, and proposed resetting the accumulators so re-sent tokens wouldn't double the prefix. **That is NOT how the server actually works** — `api/routes._handle_sse_stream` reads a **one-shot `queue.Queue()` that delivers each event to exactly one consumer**; a reconnect picks up from the current queue position and gets **only events produced during the outage**. Resetting the accumulators would wipe already-displayed content and restart the response from the first post-reconnect token — **a real data-loss regression.**

Server code confirms it: `subscriber.get(timeout=…)` on a per-subscriber queue (`api/routes.py:18835`), subscribed at `18813-18817`, unsubscribed in `finally` at `18861-18866`.

**Consequences for a React client:**
1. **Never clear your accumulated text on reconnect.**
2. Do not rely on EventSource's built-in reconnect. The vanilla client closes the source on `error` and re-opens with explicit replay params (`6702-6730`, `7190-7194`), first probing `/api/chat/stream/status` (`api/routes.py:14322-14335`, which returns `{active, stream_id, replay_available, journal?}`) to decide replay-only vs live.
3. Journal replay is the *only* real recovery path, and it is gap-checked (`api/routes.py:18827-18832`) with a `replay_cutoff_seq` that suppresses duplicate live events (`18851-18852`).
4. Advance your cursor from the SSE `id:` field, emitted as `stream_id:seq` (`api/routes.py:18845-18854`); without it a mid-stream error→replay arrives with `after_seq=0` and double-renders everything.

---

## 3. Approval flow

### 3.1 Endpoints

- `GET /api/approval/pending` — dispatch `api/routes.py:14419-14420`, handler `20969`.
  Query: `session_id` (`20970`). Response: `{"pending": {...}, "pending_count": N}` or `{"pending": null, "pending_count": 0}` (`20993-20995`).
- `GET /api/approval/stream` — dispatch `14422-14423`, handler `20998`.
  Query: `session_id`, **required** → 400 `"session_id is required"` (`21005-21007`). SSE. Emits event **`initial`** immediately with `{"pending":…,"pending_count":…}` (`21040`), then event **`approval`** per update (`21053`), keepalive `: keepalive` (`21048`).
- `POST /api/approval/respond` — dispatch `16532-16533`, handler `26335`.
- `GET /api/approval/inject_test` — loopback-only test hook, 404 for remote clients (`14425-14429`).

### 3.2 `approval` SSE payload

Emitted on the chat stream at `api/streaming.py:9408` (`put('approval', approval_data)`), and via a polling fallback at `9810`.

**Honest limitation:** the payload is constructed by `tools.approval` (imported at `api/streaming.py:9391-9394`), which is **outside this checkout** — `tools/` does not exist here and `import tools` fails. So the authoritative producer-side field list is **NOT CONFIRMED**. What *is* confirmed:

- `pending_count` is added by the WebUI layer: `{**(head or approval_data), "pending_count": total}` (`api/streaming.py:9403`; also `9815`).
- Fields the WebUI/consumer demonstrably rely on:
  - `approval_id` — identity, may be synthesized as `gwrun:<run_id>:<token>` or `gwlocal:<token>` (`api/route_approvals.py:266-274`, `358`)
  - `run_id`, `_gateway_mirror_token` — gateway relay (`route_approvals.py:355-362`)
  - `description`, `command`, `pattern_key`, `pattern_keys` — rendered by the client (`static/messages.js:7615-7617`); the same four appear in the test injector (`api/routes.py:21069-21074`)
- Client reads: `d.pending_count || 1` and `d.description` (`static/messages.js:5964-5970`).

### 3.3 `POST /api/approval/respond` — request body

Handler `api/routes.py:26335-26345`:

| Field | Required | Notes |
|---|---|---|
| `session_id` | **yes** | 400 `"session_id is required"` (`26337-26338`) |
| `choice` | defaults `"deny"` | **Exactly `"once"`, `"session"`, `"always"`, `"deny"`** (`26340`); anything else → 400 `f"Invalid choice: {choice}"` (`26341`) |
| `approval_id` | no | Identifies the approval (`26342`) |
| `yolo` | no | `body.get("yolo") is True` → enable session YOLO and release pending (`26343`, `26347-26356`) |
| `run_id` | no | Gateway relay (`26344`) |
| `mirror_token` | no | Gateway relay (`26345`) |

**Note the decision vocabulary is not approve/deny.** It is `once` / `session` / `always` / `deny` (`api/routes.py:26340`) — `once` = approve this time, `session` = approve for this session, `always` = persist, `deny` = refuse.

Gateway rule: if either `run_id` or `mirror_token` is supplied, **all three** of `approval_id`+`run_id`+`mirror_token` are required, else 409 `code: "gateway_run_unavailable"` (`26358-26368`); an unmatched mirror also 409s (`26375-26384`).

Exact success-response shape for the local (non-gateway) path is produced further down past line 26445 and I did not read it to the end — **NOT CONFIRMED**. The gateway paths return `(payload, status)` from `_gateway_approval_failure`/`_relay_gateway_run_approval` (`26360-26391`).

### 3.4 How the client learns an approval was resolved

Three mechanisms, all confirmed:

1. **Push:** resolution re-notifies subscribers with the new head — `{"pending": <next|null>, "pending_count": N}`. The clarify analogue is explicit at `api/clarify.py:217`/`220`; the approval SSE loop forwards whatever payload is queued (`api/routes.py:21053`). A `pending: null` / `pending_count: 0` means "cleared".
2. **Terminal events clear it locally:** `_clearApprovalForOwner()` runs on `apperror` (`messages.js:6576`) and on `cancel` (`6835`).
3. **Polling fallback:** `GET /api/approval/pending`; the client has `stopApprovalPolling()` (`messages.js:1828`).

Client dedupe keys on `approval_id` (`messages.js:7613`, `7631`), so include it.

---

## 4. Clarify flow

`api/clarify.py` read in full (255 lines).

### 4.1 Endpoints

- `GET /api/clarify/pending` — dispatch `api/routes.py:14431-14432`, handler `21080`. Query `session_id` (`21081`). Response: **`{"pending": {...}}` or `{"pending": null}`** — note this endpoint returns **no `pending_count`**, unlike its approval sibling (`21083-21085`).
- `GET /api/clarify/stream` — dispatch `14434-14435`, handler `21088`. Query `session_id` required → 400 (`21099-21100`); 400 `"clarify SSE not available"` if the module is missing (`21095-21096`). Emits `initial` with `{"pending":…,"pending_count":…}` (`21142`), then `clarify` events.
- `POST /api/clarify/respond` — dispatch `16536-16537`, handler `26644`.
- `GET /api/clarify/inject_test` — loopback-only (`14440-14444`).

### 4.2 `clarify` SSE payload

Two shapes — **this asymmetry is a real trap**:

**(a) On the chat stream** (`api/streaming.py:9423`), the payload is the clarify data object itself, built at `9430-9437`:
```json
{
  "question": "...",
  "choices_offered": ["..."],
  "session_id": "...",
  "kind": "clarify",
  "requested_at": 1234567890.0,
  "timeout_seconds": 120,
  "expires_at": 1234568010.0,
  "clarify_id": "<12 hex chars>"
}
```
`expires_at`/`timeout_seconds` normalized at `api/clarify.py:86-99`; `timeout_seconds <= 0` means unlimited, `expires_at: 0` (`93-97`). Default 120s (`api/clarify.py:18`). `clarify_id` = `uuid.uuid4().hex[:12]`, injected into the serialized data at `api/clarify.py:37`, `168`.

**(b) On `/api/clarify/stream`** the payload is **wrapped**: `{"pending": {...}|null, "pending_count": N}` (`api/clarify.py:102-104`).

Client reads `d.question` (`messages.js:5976`).

### 4.3 `POST /api/clarify/respond` — request body

Handler `api/routes.py:26644-26656`:

| Field | Required | Notes |
|---|---|---|
| `session_id` | **yes** | 400 `"session_id is required"` (`26646-26647`) |
| `response` | **yes** (one of three aliases) | Falls back to `answer`, then `choice`, in that order (`26648-26652`) |
| `clarify_id` | no | Targets a specific prompt (`26656`) |

**Answer shape: free-form string.** Coerced `str(response or "").strip()`; empty → 400 `"response is required"` (`26653-26655`). `choices_offered` is advisory only — nothing validates the answer against it (`api/clarify.py:207-227` stores the string verbatim as `entry.result`).

Responses:
- **200** `{"ok": true, "response": "<echoed>"}` (`26676`)
- **409** `{"ok": false, "error": "Clarification prompt expired or not found. The agent may have already proceeded.", "stale": true}` (`26670-26674`)

With `clarify_id` → `resolve_clarify_by_id` (`api/clarify.py:230-255`, returns bool). Without → `resolve_clarify` resolves the **oldest** entry (`207-227`).

### 4.4 How the client knows it was resolved

- Push notify on resolution: next head + count, or `{"pending": null, "pending_count": 0}` when the queue empties (`api/clarify.py:217`, `220`, `245`, `248`).
- `clear_pending()` explicitly emits `pending=None,total=0` — added because a silent timeout previously left the browser with a stuck card and a composer that 409'd on submit (`api/clarify.py:63-83`, esp. the `#4504` note at `68-71`).
- Terminal chat events clear locally with a reason string: `_clearClarifyForOwner('terminal')` on `apperror` (`messages.js:6577`), `'cancelled'` on `cancel` (`6836`).
- Duplicate suppression: identical `question` + `choices_offered` reuses the existing entry and its original `clarify_id` (`api/clarify.py:140-164`).

---

## 5. Stop / steer

### 5.1 `POST /api/chat/cancel`

⚠️ **Despite the `POST` framing, parameters are read from the query string, not the body.** Dispatch is in the **GET** handler at `api/routes.py:14337`, and it reads `parse_qs(parsed.query)` (`14338`). Call it as `/api/chat/cancel?stream_id=…`. Whether a POST to this path also routes here is **NOT CONFIRMED** — I only located the GET-side dispatch.

- Missing `stream_id` → 400 `"stream_id required"` (`14339-14340`).
- Success: `{"ok": true, "cancelled": <bool>, "stream_id": "..."}` (`14383`). `cancelled` is False when no live work was found.
- Gateway stop failure: **502** `{"ok": false, "cancelled": false, "stream_id": "...", "error": "Gateway stop failed"}` (`14364-14374`).
- Keyed by **`stream_id`**.

### 5.2 `POST /api/chat/steer`

Dispatch `api/routes.py:16389-16391` → `api/streaming.py:12889`. A genuine POST with a JSON body.

Body: `{session_id, text}` — both required, each 400 on absence (`12917-12922`). Keyed by **`session_id`**.

Response is always 200 (`12911-12912`):
```json
{"accepted": true|false, "fallback": null|"<reason>", "stream_id": "..."|null}
```
`fallback` values: `gateway_steer_queued` (`12956`), `no_cached_agent` (`12967`), `agent_lacks_steer` (`12972`), `session_not_found` (`12981`), `not_running` (`12985`), `stream_dead` (`12991`), `steer_error` (`12998`).

### 5.3 Semantic difference

| | cancel | steer |
|---|---|---|
| Key | `stream_id` | `session_id` |
| Effect | **Terminates** the turn | **Injects guidance into the running turn** |
| Stream | Emits terminal `cancel` | **Not interrupted** (`api/streaming.py:12902-12903`) |
| Timing | Immediate | Applied at the next tool-result boundary (`12896-12901`) |

Steer stashes text in `_pending_steer`; the agent appends it to the last tool result with a marker so the model sees it as tool output on its next iteration (`12899-12902`). If the turn ends before any tool boundary fires, the leftover surfaces as the `pending_steer_leftover` SSE event (`12199-12202`) and the client re-queues it as a next-turn message (`messages.js:6447`).

The docstring is explicit that a failed steer must **not** cancel the run: *"Steer is active-run guidance, not implicit permission to Queue, Interrupt, or Stop-and-send"* (`12905-12909`).

---

## 6. Session + profile scoping

### 6.1 Session creation

`POST /api/session/new` — dispatch `api/routes.py:15223`. **`/api/sessions/new` (plural) — NOT CONFIRMED**; I found only the singular route in the dispatch chain.

**`profile` IS an explicit accepted request field:**
```python
s = new_session(
    workspace=workspace,
    model=model,
    model_provider=model_provider,
    profile=body.get("profile") or None,
    ...
)
```
— `api/routes.py:15339-15347`, assignment at `15343`.

The fallback is process-global: in `new_session`, `if profile is None:` → `get_active_profile_name()` (`api/models.py:5056-5060`). The rationale is documented: the client sends the profile *"so that two tabs on different profiles never clobber each other via the process-level global"* (`api/routes.py:15283-15284`; `api/models.py:5050-5053`).

**Verdict:** session creation is properly per-request — pass `profile` explicitly and no global is consulted.

### 6.2 The active-profile mechanism

`api/profiles.py:467-480`:
```python
def get_active_profile_name() -> str:
    """
    Priority:
      1. Isolated-profile deployment name from the configured HERMES_HOME path
      2. Thread-local (set per-request from hermes_profile cookie) — issue #798
      3. Process-level default (_active_profile)
    """
    if _is_isolated_profile_mode():
        return _isolated_profile_name()
    tls_name = getattr(_tls, 'profile', None)
    if tls_name is not None:
        return tls_name
    return _active_profile
```

**There IS a per-request override, and it is a cookie: `hermes_profile`** (`api/helpers.py:1279`: `PROFILE_COOKIE_NAME = 'hermes_profile'`).

Plumbing in `server.py`, on both read and write paths:
```python
cookie_profile = get_profile_cookie(self)
if cookie_profile:
    set_request_profile(cookie_profile)
try:
    ...
finally:
    clear_request_profile()
```
— `server.py:375-378` + `397` (GET); `401-403` + `425` (writes).

`set_request_profile` writes `_tls.profile` (`api/profiles.py:483-490`); `clear_request_profile` nulls it (`493-499`). So it is a **thread-local scoped to one HTTP request**, not a process-global mutation — concurrent requests on different threads do not interfere.

**Security note:** the cookie is not blindly trusted. `api/helpers.py:1317` states the value is validated against the current auth session *"so clients cannot forge `hermes_profile`"*, and `api/auth.py:947` warns about exactly this bypass vector. There is also a trusted-header→profile binding path (`api/auth.py:878-880`) and a group→profile map env var (`api/auth.py:106`).

No `X-Hermes-Profile` header exists — **NOT CONFIRMED / not found**; the only profile-bearing request artifact I located is the cookie.

### 6.3 What `profile` does in `_handle_chat_start`

`api/routes.py:24115-24141`:
```python
requested_profile = str(body.get("profile") or "").strip()
active_profile = _get_active_profile_name()
...
if not _session_visible_to_active_profile(session_profile, handler):
    if (requested_profile
        and _profiles_match(requested_profile, active_profile)
        and not has_persisted_turns):
        s.profile = requested_profile          # retag empty placeholder only
    else:
        return bad(handler, "Session not found", 404)
```

**It is a validation / retagging guard, NOT a selector.** Evidence:
1. It is only consulted inside the `not _session_visible_to_active_profile(...)` branch (`24131`).
2. Retagging requires `_profiles_match(requested_profile, active_profile)` — it must **already equal** the ambient profile, so it cannot switch anything (`24134`).
3. Retagging additionally requires `not has_persisted_turns` — empty placeholders only (`24126-24130`, `24135`).
4. **`profile` is absent from `start_run_kwargs`** (`api/routes.py:24276-24288`). The runtime never receives it.

The runtime profile comes from the **session record**: `profile=getattr(s, "profile", None)` (`api/routes.py:23355`).

### 6.4 The worker thread

The turn executes on a daemon `threading.Thread` (`api/routes.py:23193-23198`) that **does not inherit the request's thread-local**. The code says so explicitly (`api/streaming.py:9249-9257`):

> *"...that function reads thread-local storage (`_tls.profile`) set by `set_request_profile()` on the HTTP handler thread. **The streaming thread is a separate `threading.Thread` and does not inherit TLS.** At compression time, `get_active_profile_name()` would fall back to the process-global `_active_profile`, **which may belong to a different concurrent tab.**"*

The mitigation is to resolve from the session first (`api/streaming.py:9258-9264`):
```python
_resolved_profile_name = getattr(s, 'profile', None)
if not _resolved_profile_name:
    _resolved_profile_name = get_active_profile_name()   # global fallback
```
The worker then resolves a profile home *"use the session's own profile (stamped at `new_session()` time from the client's `S.activeProfile`) so that two concurrent tabs on different profiles don't clobber each other via the process-level active-profile global"* (`api/streaming.py:10778-10782`), and applies it via thread-scoped env (`_set_thread_env`, `_set_streaming_hermes_home_override`, `api/streaming.py:9265-9270`). Detached workers use `profile_scope_for_detached_worker` (`api/routes.py:23413-23418`).

### 6.5 The answer

**Yes — you can run turns for profile B while the process-global active profile is A, without mutating global state.** But the mechanism is specific and easy to get wrong:

- **The lever is the `hermes_profile` cookie**, which sets a **per-request thread-local** (`api/profiles.py:477-479`, `server.py:376-378`). This is *not* a process-global mutation and is safe under concurrency.
- **The durable binding is `session.profile`**, set from the explicit `profile` field at `/api/session/new` (`api/routes.py:15343`). The worker thread reads *this*, not the ambient profile (`api/streaming.py:9258`, `10778-10782`).
- **The `profile` field on `/api/chat/start` will not do it** — validation guard only (§6.3), and never forwarded to the runtime (`24276-24288`).

**Recommended pattern for per-agent React chat:**
1. Create each agent's session with an explicit `profile` in the `/api/session/new` body.
2. Send the matching `hermes_profile` cookie on every subsequent request for that agent, so visibility checks (`_session_visible_to_active_profile`, `24131`) pass and the session isn't 404'd.
3. Keep sending `profile` on `/api/chat/start` for consistency with the vanilla client (`messages.js:1806`), understanding it is only a guard.

**Caveats to design around:**
- A cookie is browser-global per host, so N simultaneous agents in one tab cannot each carry a different cookie on concurrent requests. `fetch` cannot override `Cookie`. **How to drive multiple profiles concurrently from one browser origin is NOT CONFIRMED** — I found no header-based alternative. Options to investigate: per-agent requests serialized behind a cookie swap (racy), separate origins/ports (`HERMES_WEBUI_COOKIE_NAME` exists for exactly this multi-instance case, `api/auth.py:73-77`), or a backend proxy that injects the cookie per request. The last is the only clean one.
- **`EventSource` cannot set headers at all**, so SSE endpoints must rely on cookies regardless (`withCredentials:true`, `messages.js:7194`).
- If `session.profile` is ever empty, the worker silently falls back to the process-global, which *"may belong to a different concurrent tab"* (`api/streaming.py:9249-9257`). Always set it explicitly.
- Isolated-profile deployment mode overrides everything (`api/profiles.py:475-476`).

---

## 7. Auth

Single gate: `check_auth(handler, parsed)` (`api/auth.py:1075`), called before routing on GET (`server.py:381`) and writes (`server.py:409`).

### 7.1 When no password is configured — everything is open

```python
def check_auth(handler, parsed) -> bool:
    if not is_auth_enabled():
        return True
```
— `api/auth.py:1078-1079`.

```python
def is_auth_enabled() -> bool:
    """True if password auth, passkeys, OIDC login, or trusted-header auth is configured."""
    return (is_password_auth_enabled() or are_passkeys_enabled()
            or is_oidc_auth_enabled() or is_trusted_auth_enabled())
```
— `api/auth.py:563-570`.

**So with no password, no passkeys, no OIDC and no trusted header, every endpoint — chat, stream, approval, clarify — is completely unauthenticated.** Treat any such deployment as trusted-network-only.

### 7.2 When auth IS enabled

None of `/api/chat/*`, `/api/approval/*`, `/api/clarify/*` appear in `PUBLIC_PATHS` (`api/auth.py:51-59`) and none match the public prefixes `/share/`, `/api/share/`, `/static/`, `/session/static/` (`1083-1090`). **All of them require authentication.**

- **Cookie: `hermes_session`** (`api/auth.py:61`), overridable via `HERMES_WEBUI_COOKIE_NAME` for multi-instance hosts (`70-88`).
- Validation: `parse_cookie(handler)` + `verify_session(cookie_val)` (`1092-1093`).
- Unauthenticated `/api/*` → **401** `{"error":"Authentication required"}` (`1121-1127`). Non-API → 302 to login (`1128-1129`).
- Profile-forbidden → **403** `{"error":"Profile access forbidden"}` (`1106-1110`).
- CSRF header exists: `X-Hermes-CSRF-Token` (`api/auth.py:62`). Where it is enforced is **NOT CONFIRMED** — I did not trace its validation sites; check before assuming POSTs need it.
- One narrow exception: `POST /api/csp-report` bypasses `check_auth` (`server.py:405-409`).

**For a React client:** requests must send credentials (`fetch(..., {credentials:'include'})`, `EventSource(..., {withCredentials:true})` as the vanilla client does at `messages.js:7194`). Cross-origin dev servers will need CORS + `SameSite` cookie handling — **CORS configuration was NOT examined**.

---

## Explicitly not confirmed

1. `tools/approval` is **outside this checkout** (`import tools` fails; `api/streaming.py:9391-9394`) — the producer-side field list of the `approval` payload is unverified beyond the consumer-observed fields.
2. Success-response shape of the local `POST /api/approval/respond` path (past `api/routes.py:26445`).
3. Whether the server ever emits a server-side SSE event literally named `error` (it is in the close set at `api/run_journal.py:45`, but no `put('error', …)` site exists in `api/streaming.py`).
4. Whether `POST` (as opposed to GET) to `/api/chat/cancel` is routed; only the GET-side dispatch was located (`api/routes.py:14337`).
5. Existence of a `/api/sessions/new` (plural) route.
6. Enforcement sites for `X-Hermes-CSRF-Token`.
7. CORS configuration for cross-origin React dev servers.
8. How to drive multiple different profiles **concurrently** from a single browser origin, given the cookie-only mechanism.
