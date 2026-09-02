---
name: org-tools-reference
description: Quick lookup for every org tool CEO actually has — org/project reads, Brain reads/writes, the proposal-only priority tool, and which tools are explicitly withheld. Use whenever unsure which tool answers a question, or to check a tool's real argument/return shape before calling it, instead of guessing or re-deriving from AGENTS.md prose each session.
---

# CEO Org Tools — Quick Reference

Every tool here is called directly by its bare name with its documented
arguments. If a name or argument shape is genuinely uncertain, say so
rather than guessing. This file is a lookup, not a substitute for
`skills/weekly-review/SKILL.md` (the full review procedure) or
`skills/org-communication/SKILL.md` (agent-to-agent tools).

## "I need to know X" → tool to call

| You need to know... | Call | Arguments |
|---|---|---|
| Org chart shape, departments, agents, roles | `org_get_graph` | `{}` |
| Every project's priority + financial record | `org_get_projects` | `{}` |
| Headcount by role/department, provisioning gaps | `org_agent_stats` | `{}` |
| Whether something durable is already known | `brain_search` | `{"query": "...", "limit": 20}` |
| Full content of a known Brain doc | `brain_read` | `{"path": "..."}` |
| How many drafts you've logged since last rollup | `brain_agent_hotness` | `{"agent_id": "ceo"}` |

## "I need to change X" → tool to call

| You want to... | Call | Notes |
|---|---|---|
| Propose a project priority change | `project_set_priority` | Proposal-only — see below, never a real write |
| Log a durable decision/finding | `brain_create_draft` | Path convention: `agents/ceo/decisions/<date>-<short-title>.md` |
| Reset your own hotness counter | `brain_mark_agent_rollup` | Only AFTER the curated-memory.md write actually succeeds |
| Reach ONE other agent (default — does not block) | `org_trigger_agent_async` | Reply delivered later into your own session; requires `caller_session_id`. See `skills/org-communication/SKILL.md` |
| Reach several agents at once (blocks until all finish) | `org_trigger_agents_parallel` | Only tool here that still blocks — see `skills/org-communication/SKILL.md` |
| Check/answer a triggered agent's clarify/approval | `org_trigger_check_pending` / `org_trigger_respond` | Scoped to your own trigger chain (direct + transitive) — no target session id needed |
| Check on a task's progress at any time | `org_trigger_task_status` | Cheap running/idle status only — no message content |
| Spawn a helper under yourself | `org_add_sub_agent` | `parent_agent_id` must be your own id |

## Read tools — real return shapes

`org_get_graph` — `{}` in, returns the live org graph (departments, agents,
roles, parentage). Always call before assuming any agent id or department
shape; never invent one.

`org_get_projects` — `{}` in, returns:
```json
{"projects": [{"slug": "...", "priority": <int>, "budget": ..., "spend_to_date": ..., "revenue_projected": ..., "revenue_actual": ..., "invoice_status": "...", "cost_risk_level": "..."}, ...]}
```
`priority` is an integer whose scale is whatever this deployment's existing
convention already is — read current values across projects before
proposing a new number, never assume "lower is more important" or vice
versa without checking.

`org_agent_stats` — `{}` in, returns:
```json
{"total_agents": <int>, "total_departments": <int>, "by_role": {"<role>": <int>, ...}, "agents_missing_profile": ["<agent_id>", ...]}
```
`agents_missing_profile` is a provisioning gap worth flagging in a weekly
review, not just a raw dump to ignore.

`brain_search` — `{"query": "...", "limit": <1-100>}` in (`query` required),
returns matching paths + lines. Always search before assuming something
isn't already known.

`brain_read` — `{"path": "..."}` in, returns full content + revision of one
doc. Use the exact path `brain_search` returned.

`brain_agent_hotness` — `{"agent_id": "ceo"}` (or omit `agent_id` for every
agent's counters), returns
`{"count": <int>, "last_draft_at": <ts>, "rollup_at": <ts or absent>}`. See
`skills/brain-memory-hygiene/SKILL.md` for the full rollup procedure
this counter drives.

## `project_set_priority` — the one tool that looks like a write but isn't

```json
// call
{"slug": "growth-onboarding", "priority": 1}

// return
{"slug": "growth-onboarding", "before": 3, "after": 1, "written": false,
 "reason": "proposal only — the MD confirms and applies the change through a separate UI/API confirmation endpoint"}
```

- `written` is always `false` from this tool — there is no argument that
  makes it write. Calling it again with the same inputs will not "confirm"
  anything; the actual write happens through a separate human-driven
  endpoint the MD triggers directly, outside this tool and outside this
  conversation.
- One `slug` + one `priority` per call — no batch form. Reordering several
  projects means several calls, each reported to the MD as its own diff.
- CEO-only tool — no other role can call it.

## `brain_create_draft` — writing durable knowledge

```json
{"path": "agents/ceo/decisions/2025-03-10-priority-shift.md", "content": "---\nstatus: draft\n---\n\n...", "expected_revision": "<only when replacing an existing draft>"}
```
Content needs YAML frontmatter with `status: draft`. Pass `expected_revision`
only when overwriting a draft you already read (a fresh path never has one).
Not every decision earns a draft — see `skills/brain-memory-hygiene/SKILL.md`
for the durability bar.

## Explicitly withheld — do not attempt

`org_create_department`, `org_add_worker`, `org_create_project`, any kanban
write tool, `project_set_financials` (CFO's), `pm_set_task_priority` (PM's),
code/build/terminal/browser/image/video tools, and any tool not
assigned to the `ceo` role. These are enforced at the config level — the
call fails, this isn't just a style rule. If a request needs one of these,
route it: org structure and dispatch → PM (`org_trigger_agent_async`);
financial writes → CFO knows its own tools, not CEO's job to attempt.

## When this reference isn't enough

- Full weekly review procedure, worked Decision log examples, options-not-
  recommendation phrasing → `skills/weekly-review/SKILL.md`.
- Choosing between `org_trigger_agent_async`/`_parallel`/`org_add_sub_agent`,
  message shape for handing PM a decision → `skills/org-communication/SKILL.md`.
- Starting a company/team from scratch → `skills/company-brainstorm-handoff/SKILL.md`.
- Hotness/rollup discipline in full → `skills/brain-memory-hygiene/SKILL.md`.
- An inbound priority-conflict escalation from PM → `skills/escalation-handling/SKILL.md`.
