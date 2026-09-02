---
name: escalation-handling
description: How to handle an inbound priority-conflict escalation that reaches CEO — either a task Hermes' kanban dispatcher assigned directly to CEO (title starts "ESCALATION:"), or PM reaching CEO via org_trigger_agent_async. Use this when a session starts with an escalation task/message already in front of CEO, as distinct from CEO-initiated weekly-review sessions.
---

# Escalation Handling — when PM (or Hermes) hands CEO a stuck conflict

`weekly-review` and `company-brainstorm-handoff` both cover sessions CEO
itself initiates or decides to run. This skill covers the other direction:
a session that starts because something already landed in front of CEO —
PM escalated a priority conflict it couldn't resolve, or Hermes' own
block-recurrence loop-breaker routed a repeatedly-stuck task straight to
CEO.

## Recognize the two real inbound shapes

1. **A dispatched kanban task assigned to CEO**, titled
   `ESCALATION: <original task title> stuck in triage`. This happens when
   PM (or anyone) calls `kanban_retry_or_escalate` with `escalate_to='ceo'`
   on a task that already auto-routed to `triage` after repeated same-kind
   re-blocks. Hermes' dispatcher starts this as a real turn in CEO's own
   session automatically — CEO does not poll a kanban tool for it (CEO has
   no kanban tools at all), it simply appears as the session's task/message.
   The task body states: the original task id/title, how many times it
   re-blocked, the `block_kind`, and the reason from the last retry attempt.
2. **PM reaching CEO**, via `org_trigger_agent_async(target_agent_id='ceo', ...)`,
   when a conflict crosses CEO's strategic-priority line (per PM's own
   escalation criterion: it would change which project/bet matters more,
   not just task ordering within one project). This arrives as a normal
   message into CEO's session, naming the conflict, the affected task
   ids, and why it's above PM's tactical authority.

Either shape is a priority conflict CEO needs to resolve, not new
implementation work — CEO still never manages tasks or writes code.

## 1. Read `PLAN.md` first, even for an inbound escalation

Same rule as any session: `PLAN.md`, absolute path, read
before acting. An escalation might already relate to something in Active
bets or Risks — don't reason about it in isolation from what CEO already
knows.

## 2. Understand what's actually stuck, using real state — not the escalation text alone

Pull current org/project truth before deciding anything:

- `org_get_projects` — current priorities of the projects in conflict.
- `org_agent_stats` — is the relevant department overloaded, which would
  explain (not excuse) why work kept re-blocking.
- `brain_search` for anything already known about this project/conflict.

Don't take the escalation body as the full picture — it tells you the
symptom (a task stuck in triage, or PM's stated conflict), not necessarily
the underlying resourcing/priority tension.

## 3. Frame it as options, same as weekly-review step 5

Even for an urgent inbound escalation, don't jump straight to a fix. Name
the tradeoff:

```text
Option A: keep <project X> at its current priority — tradeoff: <task/effect
stays stuck>; recurrence risk: <likely to re-block again the same way>.
Option B: reprioritize <project Y> — tradeoff: <what slips instead>.
```

## 4. Propose the priority change through the normal tool — never bypass the confirm step because it's urgent

Urgency does not unlock a write path. Use `project_set_priority` exactly as
in `weekly-review` step 6 — it still only returns a before/after diff, still
never writes, and the MD still confirms through the separate UI/API step.
An escalation is not a reason to treat the proposal as auto-confirmed.

## 5. Respond to the actual inbound channel

- **If this was a dispatched kanban task**: you have no kanban tool to
  "complete" or "comment" on it directly — report your decision (option
  chosen, priority proposal, owner, reversible experiment) as your turn's
  final reply/output; the task's own completion is driven by whatever
  process is watching that board, not a CEO-side kanban write. Also log the
  decision per steps 6-7 below so it isn't lost even though CEO didn't
  "close" the task itself in the kanban sense.
- **If this was an `org_trigger_agent_async` message from PM**: your turn's
  final reply IS the answer PM eventually receives (delivered into PM's own
  session automatically once your turn finishes — PM's own call already
  returned immediately, so PM is not literally blocked waiting, but IS
  expecting this specific answer) — make sure it explicitly states the
  decision, owner, and reversible experiment, not just analysis, since
  that's what PM needs to act on once it arrives.

## 6. Write the Decision log row

Same shape as `weekly-review` step 8 — one `PLAN.md` Decision log row per
resolved escalation, including outcome-pending if the resolution needs a
later check-in.

## 7. Log to Brain if it clears the durability bar

An escalation that revealed a real recurring resourcing problem (not just a
one-off stuck task) is exactly the kind of lasting finding
`skills/brain-memory-hygiene/SKILL.md` says to log — follow that
skill's full draft + hotness/rollup procedure rather than skipping it
because the session started reactively.

## What NOT to do

- Don't try to "fix" the stuck task yourself (no kanban tools, no task
  management — that's still never CEO's job even under escalation).
- Don't treat urgency as license to skip the MD confirm step on
  `project_set_priority` — see step 4.
- Don't silently resolve the conflict without a Decision log row just
  because the session felt reactive rather than a scheduled review — the
  same continuity requirement applies.
- Don't confuse this with `company-brainstorm-handoff` — an escalation is
  about an existing org's stuck conflict, not a from-scratch kickoff.
