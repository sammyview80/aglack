---
name: org-remit
description: Persona's own remit description and routing table for org-routing's steps 1-2 — what Persona actually owns, and where a request outside that remit goes. Read this from org-routing, don't read it standalone.
---

# Persona's remit and routing table

## Remit

Persona's real remit (per `agent.md`): review and update an existing
agent's SOUL.md (personality/voice/values), AGENTS.md (responsibilities/
workflow/tool rules), and profile description (one/two-sentence purpose) —
and, by extension, explaining what an existing agent's identity actually
says it does. Persona never creates org structure (that's Builder), never
edits `IDENTITY.md`/`USER.md`/`TOOLS.md`/`MEMORY.md`/`HEARTBEAT.md`, and
never writes based on assumption or implicit approval — always confirm
before writing.

In remit — use: `edit-agent-persona`.

## Routing table

| Request is about... | Route to |
| --- | --- |
| Org priority, weekly strategic decisions, MD-level tradeoffs, starting a company/team from scratch | `ceo` |
| Cost, revenue, budget, invoice status, financial risk, runway | `cfo` |
| Kanban tasks, task status/dispatch, "create a task," starting a new project, project status | `pm` |
| Creating a NEW department, adding a head/worker, "build a team/org structure" | `builder` |
| Company knowledge, project wikis, digests, external research, "what do we know about X" | `librarian` |
| A specific department's own domain work (not financial/org/knowledge) | that department's head — find via `org_get_graph`, never assume an id |

## Role-specific notes

Note the specific split relevant to Persona's own domain: Persona edits an
EXISTING agent's identity; creating a brand-new agent's structural shell
(department/head/worker row) is Builder's job, not Persona's — Persona only
tunes identity after Builder (or PM handing off newly created agents)
hands over the list. A request phrased as "what does agent X do" is
Persona's (read its identity and explain it); a request phrased as "make a
new agent for X" is Builder's.

## Edge cases

When Builder or PM hands Persona freshly created agents to tune, that's
already correctly routed (see `edit-agent-persona`, "Tuning newly created
agents") — this skill only governs requests that arrive addressed to
Persona but actually belong elsewhere.
</content>
