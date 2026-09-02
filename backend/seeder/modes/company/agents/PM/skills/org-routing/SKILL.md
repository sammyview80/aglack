---
name: org-routing
description: Run this FIRST on every incoming request, before Phase A/B or question-routing. Decides whether the request is actually PM's remit (kanban dispatch, task status, project creation/status) or belongs to another lead (CEO/CFO/Builder/Persona/Librarian) or a department head. PM already has `question-routing` for standalone questions outside its remit — this skill is the front door that sends you there, plus the mediate-or-direct choice that skill doesn't cover on its own.
---

# Org Routing — is this actually mine to answer?

PM is one of six org-wide leads (CEO/CFO/PM/Builder/Persona/Librarian).
Leads route to each other; department heads and workers do not use this
skill — routing across leads is a lead-only concern, they stay scoped to
their own department's dispatched work.

Run this check on every new request before doing anything else — before
Phase A/B dispatch, before `company-kickoff`, before `kanban-orchestrator`.

## 1. Self-check: is this actually PM's remit?

PM's real remit (per `AGENTS.md`): the real day-to-day entrypoint — route
every user goal to the right agent(s), assign/track kanban tasks, create
new projects (`org_create_project`), report status, reprioritize
tactically within CEO's strategic ranking. PM never implements work
itself, never changes org structure, never writes financial data.

If the request is a GOAL to dispatch (build/change/track something) or is
about kanban tasks, task status, or project creation/status — that's
yours. Answer it yourself via the normal Phase A/B workflow (or
`company-kickoff` for a from-scratch org). Stop here; the rest of this
skill doesn't apply.

If the request is instead a standalone QUESTION expecting an answer (not a
deliverable) and it names a domain outside your own — go to step 2. This
is exactly what `skills/question-routing/SKILL.md` already covers in
full detail (its routing table, its message-sending mechanics); this
section only adds the mediate-or-direct choice on top before you trigger
anything.

## 2. Match the request to its real owner, then ask before mediating

Use `question-routing`'s own table to pick exactly one target agent —
don't re-derive it here:

| Question is about | Route to |
| --- | --- |
| Cost, revenue, budget, invoice status, financial risk | `cfo` |
| Org priority, weekly strategic decisions, MD-level tradeoffs | `ceo` |
| Departments, heads, workers, reporting lines, org structure | `builder` |
| Company knowledge, project wikis, durable research, digests | `librarian` |
| Another agent's own SOUL.md/AGENTS.md/persona | `persona` |
| A specific department's own domain work | that department's head, via `org_get_graph` |

`question-routing` (written before this skill existed) goes straight to
triggering the target once it picks one. This skill adds one step before
that: ask the user first via `clarify`, since PM is also a lead and the
user may prefer to ask that lead directly instead of going through you.

```text
This is <Lead name>'s domain (<one-line reason, e.g. "financial figures">).
Want me to ask <Lead name> and relay the answer back here, or would you
rather open <Lead name>'s own chat and ask directly?
```

Offer exactly two options: **mediate** or **go direct**.

- **User picks mediate**: proceed exactly as `question-routing` describes
  — `org_trigger_agent_async`, tell the user it's running, relay the
  attributed answer once delivered.
- **User picks go direct**: acknowledge which lead to talk to and stop —
  do not trigger anything. The user opens that agent's own session
  themselves; you have no tool to switch it for them.

Never re-ask the same question twice in one turn once the user has chosen.

## 3. What this skill does NOT cover

- Org-structure relay to Builder (new department/company request) already
  has its own required procedure in `AGENTS.md` and
  `skills/company-creation/SKILL.md` — this routing check doesn't
  replace that, it just confirms the request really is an org-structure
  ask before you follow it.
- A goal that mixes a question and dispatchable work: answer/route the
  question part per this skill, and handle the work part through the
  normal Phase A/B flow — don't let one subsume the other.
