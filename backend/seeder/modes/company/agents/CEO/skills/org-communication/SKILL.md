---
name: org-communication
description: How CEO reaches other agents — org_trigger_agent_async (one target, does NOT block — reply arrives later in your own session; the default for reaching one agent), org_trigger_agents_parallel (up to 10 targets, blocks until all finish), and org_add_sub_agent (spawn under yourself). Also covers org_trigger_check_pending / org_trigger_respond for a triggered agent (or one further down your trigger chain) that is stuck on a clarify/approval question, and org_trigger_task_status for a general "what's going on with that task" check at any time. Use whenever a CEO session needs to hand work to PM, ask another agent a question, or get status from more than one agent at once.
---

# Org Communication — choosing the right tool

CEO has tools for reaching other agents. They are not interchangeable —
each has a different blocking behavior and a different scope. Picking the
wrong one either wastes a turn waiting on the wrong thing or silently does
something CEO isn't allowed to do (dispatch, build org structure).

This skill covers WHICH tool to call. For the mandatory `@mention` +
status-tag message format, the busy-retry procedure, and the rule for
when a reply thread is actually closed (so replies don't loop forever),
see `skills/org-comm-protocol/SKILL.md` — apply both every time you
trigger another agent or relay a reply.

Two mechanics before anything else (full detail in `AGENTS.md`):

- Every tool below is called directly by its bare name with its documented
  arguments.
- Inside the `message` you send to another agent, use that agent's own
  tool names (`org_create_department`, `brain_search`) — every role uses
  the same plain names in this system, so there is no per-profile prefix
  to translate.

## Decision: which tool for this situation

1. **Reaching ONE agent for anything** (handing PM a decision, asking a
   specific agent a question, relaying a request to Builder) →
   `org_trigger_agent_async(target_agent_id=..., message=..., caller_session_id=...)`.
   This is the default — it never blocks your own turn. See
   "`org_trigger_agent_async` — the default way to reach one agent" below.
2. **You need status/input from several agents at once, same session** (e.g.
   checking with three department heads before a priority call) →
   `org_trigger_agents_parallel(targets=[...])`, not repeated
   `org_trigger_agent_async` calls.
3. **You need a standing helper under yourself** for genuinely independent,
   high-volume recurring work that belongs to CEO specifically (not routing,
   not building) → `org_add_sub_agent(parent_agent_id=<your own agent id>, ...)`.
   This is the ONLY org-structure tool CEO may call, and only under its own
   id — never on another agent's id, never for departments/workers (that's
   Builder's job, relayed via `org_trigger_agent_async` to Builder if you
   genuinely need Builder's own answer first).

## `org_trigger_agent_async` — the default way to reach one agent

```json
// call
{
  "target_agent_id": "pm",
  "message": "Decision from this week's review: raise growth-onboarding to priority 1 (MD confirmed). Owner: PM. Reversible experiment: reassess after 2 weeks; revert if onboarding conversion doesn't move.",
  "caller_session_id": "<your own current session id>",
  "timeout_seconds": 900
}
```

- Opens (or reuses) a session under the target's own Hermes profile, sends
  `message` as a turn, and **returns immediately** with `{status: "pending"}`
  — it never waits for the target's turn to finish, so your own turn is
  never blocked.
- **Immediately after calling this, tell the human** (in your own words)
  that the message was sent and is running in the background, and that
  you'll let them know as soon as it's done or if it needs their input.
  Don't leave them assuming nothing happened just because there's no reply
  inline.
- The eventual reply is delivered automatically into YOUR OWN session later
  (as an `[IMPORTANT: ...]` message) once the target's turn finishes — you
  don't need to poll or ask again. Relay it to the human when it arrives,
  attributed to that agent.
- Requires `caller_session_id` — your own current session id. Without a
  correct value here the reply has nowhere to be delivered.
- `timeout_seconds` is a background safety cap (default 300, max 1800), not
  something you wait on — raise it only if the target's work is genuinely
  expected to take a while.
- Find `target_agent_id` from `org_get_graph` first —
  never guess an id.
- Never target yourself. Never call it in a tight loop (e.g. retry-until-a-
  different-answer) — one call, one reply, then decide what's next.
- If the target gets stuck on a clarify/approval question while you wait,
  see "`org_trigger_check_pending` / `org_trigger_respond`" below — and tell
  the human about that too, in the moment it happens.

## `org_trigger_check_pending` / `org_trigger_respond` — when a triggered agent needs YOUR input

If an agent you triggered goes quiet, it may be blocked on a clarify
question or a tool-approval decision — not actually stuck or slow.

```json
// call org_trigger_check_pending (no arguments)
{}
```

Returns every agent you have triggered that currently has a pending
clarify/approval, e.g.
`{"triggers": [{"target_agent_id": "pm", "has_pending_clarify": true, ...}]}`.
Empty list means nothing you triggered is stuck.

```json
// call org_trigger_respond
{
  "target_agent_id": "pm",
  "kind": "clarify",
  "response": "Use the staging environment, not production."
}
```

- `kind` is `"approval"` (choice: `once`/`session`/`always`/`deny`) or
  `"clarify"` (free-text `response`).
- You do **not** need that agent's own session id — this is scoped to
  YOUR OWN trigger chain: `target_agent_id` can be an agent you triggered
  directly, OR one triggered by an agent you triggered (transitively, any
  number of hops). It fails if `target_agent_id` is not reachable from
  your own chain at all.
- This is the ONLY way to unblock a triggered agent's clarify/approval from
  here — you cannot answer it by opening that agent's own session (you
  don't have a tool for that, and shouldn't need one).
- Chain example: if you triggered agent B and B itself triggered agent C,
  and C is the one asking the question, YOU can see and answer it directly
  via these same two tools — `org_trigger_check_pending` reports C too, not
  just B, because C is in your subtree. You don't need to route through B.

## `org_trigger_task_status` — "what's going on with the task I handed to X"

```json
// call
{
  "target_agent_id": "pm"
}
```

Returns a cheap status snapshot for any agent in your own trigger chain
(direct or transitive, same scoping as `org_trigger_check_pending`) —
answerable at ANY time, not only while the target is stuck on a
clarify/approval:

```json
{
  "found": true,
  "target_agent_id": "pm",
  "status": "running",
  "direct_caller_agent_id": "ceo",
  "started_at": "2026-08-21T12:00:00Z",
  "updated_at": "2026-08-21T12:03:15Z"
}
```

- `status` is `"running"` (its turn hasn't finished yet) or `"idle"` (its
  last triggered turn finished).
- `direct_caller_agent_id` shows who actually triggered this specific
  agent — useful when you're checking on a transitive target (e.g. C,
  triggered by B, not you) so you can tell how deep in the chain it is.
- This does NOT return the target's actual conversation content — no
  message text, no transcript, just status and timestamps. If you need to
  know what it's actually SAID, wait for its reply to arrive in your own
  session (the normal `org_trigger_agent_async` delivery), or check with it
  via `org_trigger_check_pending` if you suspect it's stuck.
- `found: false` (404) means either the target doesn't exist, or it's
  genuinely outside your own trigger chain — indistinguishable, by design.

## `org_trigger_agents_parallel` — up to 10 targets, blocks until ALL finish

```json
// call
{
  "targets": [
    {"target_agent_id": "pm", "message": "Status on the onboarding revamp task chain?"},
    {"target_agent_id": "cfo", "message": "Current burn rate and runway as of this week?"}
  ],
  "timeout_seconds": 300
}
```

- Unlike `org_trigger_agent_async`, this one still **blocks your own turn**
  until every target finishes (or times out) — the only tool here with that
  behavior, kept because "fire N at once and wait for all of them together"
  is a genuinely different shape than "fire one and move on."
- Returns one result per target, **in the same order as the input `targets`
  list** — a slow or failing target produces an error entry in its own slot
  without aborting the others' results.
- Use `timeout_seconds` at the top level as the shared default; a per-target
  `timeout_seconds` overrides it for that one entry only.
- Max 10 targets per call — if you genuinely need more, split into a second
  call rather than assuming it silently truncates.
- Don't reach for this when you only have one target — that's
  `org_trigger_agent_async`; parallel exists for the concurrent-multi-target
  case specifically, and it still blocks, so don't default to it out of
  habit.

## `org_add_sub_agent` — spawn under yourself only

```json
// call
{
  "parent_agent_id": "ceo",
  "name": "Priority Watch",
  "description": "Standing sub-agent that monitors project_set_priority proposal history for CEO."
}
```

- `parent_agent_id` must be **your own** agent id — using any other id is
  building org structure under someone else, which is Builder's job, not
  yours. Confirm your own id via `org_get_graph` if unsure.
- Use this only when a piece of work is genuinely independent and
  high-volume enough to run as its own standing agent — not as a substitute
  for a normal decision inside your own turn, and not as a way to avoid
  handing dispatch work to PM (dispatch is still never yours to do, even via
  a sub-agent).
- Creating anything else in the org (departments, workers, another agent's
  sub-agent) is Builder's job. Relay those via
  `org_trigger_agent_async(target_agent_id='builder', message=..., caller_session_id=...)`
  — never call `org_create_department`/`org_add_worker` yourself; you don't
  have them.

## Handing off a decision — the message shape

Whenever a decision needs PM to execute (the common case), send ONE
`org_trigger_agent_async` message shaped like the Decision log row you just
wrote (see `skills/weekly-review/SKILL.md` step 8), not a vague summary:

```text
Decision: <what was decided>.
Owner: PM.
Reversible experiment: <the smallest safe next step, not a full commitment>.
Context: <one or two lines PM needs to act — e.g. which project/slug, what
changed, what NOT to do (e.g. "priority write itself is already MD-confirmed,
you don't need to re-confirm; just execute the resourcing shift">.
```

Then stop — don't tell PM *how* to break the work down into tasks; that's
PM's own job (Phase A/B in PM's own workflow). Your job ends at handing over
a clear decision + owner + reversible experiment, and telling the human it's
been sent.

## What NOT to do with these tools

- Don't use `org_trigger_agent_async` as a way to check routine org/project
  state — that's `org_get_graph`/`org_get_projects`/`org_agent_stats` (no
  target agent needed, no message to send, no reply to wait for).
- Don't call any of these tools to make an org-structure change yourself
  (department, worker, another agent's sub-agent) — you don't have those
  tools; relay via PM/Builder instead.
- Don't retry a triggered agent expecting a different answer — if the reply
  is wrong or incomplete, that's new information for your own decision, not
  a reason to re-trigger the same target repeatedly.
- Don't call `org_trigger_agent_async` and then say nothing to the human —
  always tell them it's running in the background, in that same turn.
