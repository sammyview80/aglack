---
name: weekly-review
description: How CEO actually runs a review session end to end — reading PLAN.md, pulling org/project state, proposing a priority diff with a worked example, writing a Decision log row, and closing out PLAN.md. Use this whenever running a scheduled weekly review or an ad-hoc MD question in the same session shape.
---

# Weekly Review — worked procedure

`AGENTS.md` states the policy (read-only role, proposal-only priority tool,
escalate to PM, never dispatch). This skill is the concrete how-to: what to
actually type, call, and write at each step, including a scheduled weekly
review or a single ad-hoc MD question that doesn't wait for the weekly
cadence.

Two mechanics before anything else (details in `AGENTS.md`):

- Every tool below is called directly by its bare name with its documented
  arguments.
- `PLAN.md` always means the file at the root of YOUR workspace folder, by
  absolute path. Never a `PLAN.md` at the shared org root.

## 0. Is this a full review or a one-off question?

Not every CEO session is the full weekly cycle. Two shapes:

- **Full weekly review** — MD asks for the regular check-in, or enough time
  has passed that `PLAN.md`'s Top 3/Active bets/Risks look stale. Run every
  step below in order.
- **Ad-hoc MD question** ("what's the status on X," "should we reprioritize
  Y") — skip straight to the relevant step (state pull, or priority diff),
  but still read `PLAN.md` first for continuity and still log any resulting
  decision to the Decision log before the session ends. Don't run the full
  cycle just because one question came in.

## 1. Read `PLAN.md` in full

Read every section — North Star, Top 3, Active bets, Risks, MD questions,
Decision log — before calling any tool. This file is CEO's only continuity
across sessions; nothing else remembers what was decided last time.

If `PLAN.md` is essentially empty (brand-new workspace, all sections blank):
say so plainly, and treat this session as seeding the plan rather than
reviewing drift from a prior one — ask the MD for the North Star and Top 3
before going further, don't invent them.

## 2. Pull current state

Call `org_agent_stats` and `org_get_projects`.
Don't guess at either. `org_get_projects` returns each project's `slug` and
current `priority` (an integer — lower or higher meaning is whatever this
deployment's convention already is; read existing values before proposing a
new one, never assume a scale).

## 3. Summarize plainly

State: what changed since the last Decision log entry, which Top 3 items are
on/off track, which Active bets are due for their stated review date. This
is a narrative summary for the MD, not a raw tool dump.

## 4. Walk MD questions from `PLAN.md`

For each open question in the MD questions section: either resolve it now
(record the resolution as a Decision log row, see step 6) or explicitly
carry it forward unresolved. Never let a question silently disappear —
every question either gets a decision or stays visibly open.

## 5. Surface priority conflicts as options, not a recommendation

When Active bets or projects compete for the same resources, or agent stats
show one department overloaded while working on a lower-priority project,
name it as a tradeoff, not a foregone conclusion. Use this shape so it's
consistent session to session:

```text
Option A: keep <project X> at priority <N> — tradeoff: <department> stays
overloaded on lower-priority work; <effect on Y>.
Option B: raise <project Y> to priority <M> — tradeoff: <project X> slips;
<effect>.
```

Let the MD pick. Don't default to a side.

## 6. Propose a priority change — worked example

`project_set_priority` takes exactly one `slug` and one
integer `priority` per call, and only ever returns a proposal — it never
writes, regardless of any flag passed:

```json
// call
{"slug": "growth-onboarding", "priority": 1}

// real return shape
{
  "slug": "growth-onboarding",
  "before": 3,
  "after": 1,
  "written": false,
  "reason": "proposal only — this tool never writes; the MD confirms and applies the change through the (separate) UI/API confirmation endpoint"
}
```

To reorder more than one project, call it once per `slug` — there is no
batch form. Present each diff to the MD as:

```text
Proposed: <project> priority <before> → <after>.
Decision needed: <what changes because of this>.
Owner: <who executes if confirmed>.
Reversible experiment: <smallest safe next step, not a full commitment>.
```

Then **stop** — do not call the tool again expecting a different result, and
do not treat the JSON response as a write. The MD confirms and applies the
actual change through a separate UI/API step that isn't triggered by this
tool or by anything CEO says in-session. If the MD confirms verbally, log
the decision (step 6 below) and tell the MD the confirmation step is theirs
to complete outside this conversation — don't imply the diff call already
did it.

## 7. Escalation-only interaction with PM

CEO doesn't dispatch, and doesn't tell PM *how* to execute — CEO hands PM a
decision (from the Decision log) and PM works out the task breakdown. If a
decision requires PM action, say so plainly in the Decision log's owner
field (e.g. `owner: PM`) rather than separately messaging PM through
`org_trigger_agent_async` unless the MD needs PM's input before the decision
can even be made (a side-channel, per `AGENTS.md` — not the normal path; the
reply still arrives asynchronously, not inline, so don't treat sending the
message as having the answer in hand yet).

## 8. Write the Decision log row

Every decision reached this session — resolved MD question, priority change
proposal, risk call — becomes one `PLAN.md` Decision log row. Concrete
worked example of the row shape (adapt to whatever table/list format
`PLAN.md` already uses):

```text
- 2025-03-10 — Decision: raise growth-onboarding to priority 1.
  Owner: PM. Reversible experiment: reassess after 2 weeks of dev time
  reallocated; revert priority if onboarding conversion doesn't move.
  Outcome: pending.
```

Fill `Outcome` in on a later session once it's known — don't leave old rows
with a stale or missing outcome when the answer is actually available.

## 9. Close out `PLAN.md`

Move every MD question that got resolved this session into the Decision
log (don't leave a resolved question sitting in the MD questions section).
Refresh Top 3 / Active bets / Risks only if they actually changed — don't
rewrite sections that are still accurate just to touch the file.

## 10. Log durable outcomes to Brain, and roll up if hot

If a decision is durable enough to matter beyond this session (a strategic
pivot, a lasting risk finding, not routine bookkeeping), log it to Brain and
run the hotness/rollup check before ending the session — full mechanics,
the durability bar, and the exact `brain_create_draft` /
`brain_agent_hotness` / `brain_mark_agent_rollup` call shapes are in
`skills/brain-memory-hygiene/SKILL.md`. Don't skip this just because the
session already produced a `PLAN.md` Decision log row — Brain is the
separate, durable, org-wide store other agents can search; `PLAN.md` alone
isn't visible to them.
