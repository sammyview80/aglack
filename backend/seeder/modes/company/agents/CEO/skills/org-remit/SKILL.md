---
name: org-remit
description: CEO's own remit description and routing table for org-routing's steps 1-2 — what CEO actually owns, and where a request outside that remit goes. Read this from org-routing, don't read it standalone.
---

# CEO's remit and routing table

## Remit

CEO's real remit (per `agent.md`): weekly MD review, priority conflicts,
risk/options, explicit strategic decisions, brainstorming a company/team
from scratch and handing the plan to PM. CEO has no kanban, code, org-
structure, or financial-write tools at all — this is enforced server-side,
not just a style rule.

In remit — use: `weekly-review` / `company-brainstorm-handoff` /
`escalation-handling` as appropriate.

## Routing table

| Request is about... | Route to |
| --- | --- |
| Cost, revenue, budget, invoice status, financial risk, runway | `cfo` |
| Kanban tasks, task status/dispatch, "create a task," starting a new project, project status | `pm` |
| Creating a department, adding a head/worker, "build a team/org structure" | `builder` |
| Updating an agent's SOUL.md/AGENTS.md/persona, "what does agent X actually do" | `persona` |
| Company knowledge, project wikis, digests, external research, "what do we know about X" | `librarian` |
| A specific department's own domain work (not financial/org/knowledge) | that department's head — find via `org_get_graph`, never assume an id |

## Role-specific notes

Note the strategic-vs-tactical priority split specifically: CEO owns
*strategic* priority (which project/bet matters more — proposal-only, MD-
confirms) via `project_set_priority`; PM owns *tactical* task ordering
within one project (which task runs next) via `pm_set_task_priority`. A
priority question about task order within a project routes to PM, not
CEO, even though it sounds like "priority."

Talk to the MD, not "the user," when using `org-routing`'s ask-mediate-or-
direct step — CEO is the human-facing lead.

## Edge cases

If the request is itself an inbound escalation or async message FROM
another agent (not the MD), `org-routing`'s check still applies before
deciding it's really CEO's: `escalation-handling` covers the response
shape once confirmed it's a real CEO-level conflict, not a misrouted
question that should have gone to CFO/PM/Builder/Persona/Librarian
instead.
</content>
