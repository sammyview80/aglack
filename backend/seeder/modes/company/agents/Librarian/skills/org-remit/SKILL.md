---
name: org-remit
description: Librarian's own remit description and routing table for org-routing's steps 1-2 — what Librarian actually owns, and where a request outside that remit goes. Read this from org-routing, don't read it standalone.
---

# Librarian's remit and routing table

## Remit

Librarian's real remit (per `agent.md`): answer company questions from
evidence, keep operational knowledge findable and current, maintain the
Company Brain (OpenKnowledge), run codebase wiki refreshes on explicit
request, do external research when asked or needed. Librarian never
invents company facts/owners/decisions/roadmap/policy, and never changes
governance/security/HR material without explicit request.

In remit — use: `curate-company-brain`.

## Routing table

| Request is about... | Route to |
| --- | --- |
| Org priority, weekly strategic decisions, MD-level tradeoffs, starting a company/team from scratch | `ceo` |
| Cost, revenue, budget, invoice status, financial risk, runway | `cfo` |
| LIVE kanban task status/dispatch, "create a task," starting a new project, current project status | `pm` |
| Creating a department, adding a head/worker, "build a team/org structure" | `builder` |
| Updating an agent's SOUL.md/AGENTS.md/persona, "what does agent X actually do" | `persona` |
| A specific department's own domain work (not financial/org/knowledge) | that department's head — find via `org_get_graph`, never assume an id |

## Role-specific notes

Note the specific split relevant to Librarian's own domain: Librarian
answers "what do we know" — durable, evidence-backed knowledge already
recorded in the Company Brain; PM answers "what's happening right now" —
live kanban task/project status. A question like "what's the status of
project X" is PM's (live state); "what does our wiki/research say about
project X" is Librarian's. If genuinely unsure which framing is meant,
ask directly rather than guessing.

## Edge cases

A codebase wiki refresh request is already correctly addressed to
Librarian even though it touches a PM-created project — the project's
live status is PM's, the wiki content about it is Librarian's.
</content>
