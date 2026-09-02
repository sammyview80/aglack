---
name: company-kickoff
description: Use when a user (or CEO, handing off a brainstormed plan) asks to start/build/create a company, agency, department, or team of agents from scratch — not routing work to an EXISTING department (that's the normal goal workflow), and not a single department-only request with no financial/tracking follow-up (that's company-creation alone). This skill runs the full sequence — org structure first, then financial baseline and a tracked kickoff task chain — because nothing else in the org exists to work with until Builder confirms it.
---

# Company Kickoff — orchestrating Builder + CFO + your own tracking

A "start a company" goal is NOT a single department-creation request and
NOT normal work-on-existing-structure. It has a real ordering constraint:
nothing else (a tracked task, a financial baseline) can exist until Builder
confirms the department/head/workers are real. Sequence matters here in a
way `company-creation` alone doesn't cover.

## 0. Where this goal usually comes from

Two entry points, same procedure either way:
- Directly from a user: "start a product design agency, just go."
- Handed off from CEO after a brainstorm: CEO sends you its plan (purpose,
  department/role shape, first bets) via
  `org_trigger_agent_async` and stops — building was
  never CEO's to do. Treat CEO's plan as the starting spec, not something to
  re-derive from scratch, but still run Phase A discovery below before
  acting on it (CEO's plan may be stale relative to the live org graph).

## 1. Phase A discovery (same mandatory step as any goal)

`org_get_graph` — confirm the department genuinely
doesn't exist yet (never assume from the request alone; a same-named
department could already exist from an earlier attempt). `org_agent_stats`
for overall load context. If CEO handed off a plan, treat missing pieces
(no worker names given, no first-bet detail) as gaps to fill via one direct
question to the user — never invent department names, head names, or bets
CEO/the user didn't actually give you.

## 2. Org structure first — relay to Builder, wait for its reply, verify

Do not skip this or run it in parallel with anything else — every later
step needs Builder's real output (agent IDs, department slug) to reference.
Follow `skills/company-creation/SKILL.md`'s full gather → relay → verify
procedure:

1. Gather department name, head name, worker names (ask one direct
   question for whatever's missing; never withhold on optional detail
   like worker descriptions).
2. `org_trigger_agent_async(target_agent_id='builder', message=..., caller_session_id=...)`
   with the whole structured spec in one message. This returns immediately
   — tell whoever asked that Builder is working on it, then STOP this
   step's work here.
3. **This is a hard sequence point**: Builder's reply is delivered into your
   own session later, in a separate turn, not inline. Do not proceed to
   step 3 (financial baseline) or step 4 (task chain) in THIS turn — those
   need Builder's real output (agent IDs, department slug), which does not
   exist yet. Resume the kickoff once Builder's delivered reply actually
   arrives: verify via `org_get_graph` that the
   department/head/workers actually appear with the names given. If
   Builder's reply had an error, relay the exact reason and stop the whole
   kickoff here — don't proceed to financial setup or task creation against
   a department that doesn't actually exist. If Builder gets stuck on a
   clarify/approval question first, see `skills/org-communication/SKILL.md`'s
   `org_trigger_check_pending` / `org_trigger_respond` section.

## 3. Financial baseline — relay to CFO, only if there's a real number to set

Only reachable once step 2's verify has actually confirmed the department
exists (a later turn, not this one). If the user/CEO gave a budget, or a
financial baseline genuinely matters for this company (not every kickoff
needs one — a two-person internal team usually doesn't), relay it to CFO
the same way:

```text
org_trigger_agent_async(target_agent_id='cfo', caller_session_id='<your own session id>', message='
New project/department "<name>" was just created (department slug: <slug>,
confirmed via org_get_graph). Please set its initial budget baseline:
budget=<amount>, spend_to_date=0.
')
```

This also returns immediately — tell whoever asked that CFO is setting the
baseline, and don't block the rest of the kickoff waiting on CFO's
confirmation; the task chain in step 4 doesn't depend on it. CFO writes
this itself via its own `project_set_financials` — you never call that
tool, it isn't yours. Skip this step entirely if no budget figure was
given; don't invent one to make the kickoff feel more complete.

## 4. Tracked kickoff chain — one `org_create_task_chain` call

Once Builder has confirmed the structure exists, create the actual
first-bet tasks as one chain, same discipline as `kanban-orchestrator`:

```json
{
  "idempotency_key": "pm:kickoff-<department-slug>",
  "tasks": [
    {
      "key": "brief",
      "assignee_id": "<new head's agent id from org_get_graph>",
      "body": "Objective: turn the kickoff brief into a concrete first deliverable plan.\nContext/constraints: <purpose, first bets from CEO/user>\nAcceptance: a named first deliverable with a rough scope.\nHandoff: hand the chosen deliverable to the worker(s) below for execution."
    },
    {
      "key": "first-deliverable",
      "assignee_id": "<a worker's agent id>",
      "depends_on": ["brief"],
      "body": "Objective: produce the first deliverable the head scoped in `brief`.\nContext/constraints: <from brief's output>\nAcceptance: <observable check>.\nArtifacts: <workspace path>."
    }
  ]
}
```

One assignee per task, real agent IDs from step 2's `org_get_graph` verify
— never invented. Any task with a dependant needs a real `Handoff:` line;
the tool itself rejects one that's missing it. This is deliberately a
SMALL first chain (brief → one deliverable), not the whole company's
roadmap in one call — track progress and chain further work as it
actually materializes, same as any other goal.

## 5. Report back

Summarize to whoever asked (user, or if this came from CEO's handoff,
report back to CEO too via `org_trigger_agent_async(target_agent_id='ceo', ...)`
if CEO is still expecting to hear back): department created (name, slug,
head, workers — as Builder confirmed, not as requested), financial baseline
set if applicable, and the kickoff chain's task IDs and current status.
Never say "company created" before Builder's confirmation in step 2
actually landed.

## 6. Never skip straight to tasks without structure existing

If for any reason step 2 fails or is skipped, do not create the kickoff
chain against agent IDs that don't exist — `org_create_task_chain` would
either error or, worse, silently misassign to whatever ID happens to
partially match. Stop and report the structure failure instead.
