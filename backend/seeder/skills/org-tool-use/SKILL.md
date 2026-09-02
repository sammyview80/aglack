---
name: org-tool-use
description: when and how to call the org tools — naming rules and each role's hard restrictions; load before the FIRST org tool call of a session or when unsure which tool/permission applies.
---

# Org tool use — naming and restrictions

This is the ONE canonical copy of the mechanics every org-mode role needs.
Read it before your FIRST org tool call in a session. It replaces the
duplicated "how to call your tools" block that used to live at the top of
every role's own `agent.md`.

## 1. How to call org tools

Every tool named in your `agent.md` (e.g. `org_get_graph`, `kanban_create`,
`brain_search`) is a plain tool by its bare name — call it directly with
its documented arguments (use `{}` when it takes none). There is no
`mcp__hermes_webui__`-style prefix in this system; use the exact name
written in your `agent.md`, nothing shortened or altered.

If a name or argument shape is genuinely uncertain, say so rather than
guessing — never invent a tool name that isn't written in your own
`agent.md`.

## 2. Cross-agent naming

When directing ANOTHER agent to use a tool (e.g. inside an
`org_trigger_agent_async` message), refer to it by its bare name
(`org_create_department`, `brain_search`) — every role uses the same
plain names, so no per-profile prefix translation is needed here (unlike
the old upstream `mcp__hermes_webui__` scheme this project deliberately
does not carry forward).

## 3. When org tools are allowed

Org tools exist to run company operations — nothing else. They cover:
- org structure/agents (departments, heads, workers, sub-agents)
- kanban/dispatch (task chains, board reads/writes)
- projects (creation, financials, priority)
- Company Brain (durable knowledge search/read/draft)
- agent management (identity edits, tuning)
- machine-delivered work orders (kanban wake-up, an `org_trigger_agent`
  brief, a task-chain handoff, a scheduled org prompt)

Everything else — greetings, small talk, general/technical questions, tool
installs, coding help, brainstorming — is answered as a plain assistant,
with zero org tool calls. A machine-delivered work order is ALWAYS org
work regardless of how it's worded; a human's plain question is org work
only when it actually concerns one of the categories above.

## 4. Role restrictions

Each row is a hard rule for that role. "Config-enforced" means the
restriction is meant to be backed by real tool/toolset gating wherever
this deployment implements one; until that gating exists here, treat every
row as policy-only and follow it as a hard rule anyway. "Policy-only" rows
below are written guidance with no server-side backstop even in the
original design — violating one is a prompt bug to fix, not something a
runtime already blocks.

| Role | Rule |
| --- | --- |
| CEO | NEVER manage tasks, touch code/build/media tools, or create org structure when asked to build/ship something; instead hand the work to PM (tasks) or Builder (structure) and stay in the weekly-review/priority-proposal lane. No kanban write tools, no `org_create_department`/`org_add_worker`/`org_create_project`. |
| CFO | NEVER set priority, manage tasks, touch code/build tools, create org structure, or send invoices; instead relay to CEO (priority), PM (tasks), Builder (structure) — invoicing itself is tracked, never sent, by design. No `project_set_priority`, no kanban write tools, no `org_create_department`/`org_add_worker`. |
| PM | NEVER implement work, touch code/build/shell tools, write financial data, or create org structure; instead dispatch to the right department head, relay financial questions to CFO, and relay structure requests to Builder. No `org_create_department`/`org_add_worker`, no financial write tools. |
| Builder | NEVER use native filesystem/shell/code/media tools for anything, and NEVER manage existing departments/agents unless explicitly asked; instead do every org-structure read/write through the org tools in its own `agent.md`. |
| Persona | NEVER use native filesystem/shell tools even for its own identity files, and NEVER create/modify `IDENTITY.md`/`USER.md`/`TOOLS.md`/`MEMORY.md`/`HEARTBEAT.md`; instead write soul/agent-instructions/profile description only through `org_set_agent_soul`/`org_set_agent_instructions`/`org_set_agent_profile`. |
| Librarian | NEVER change policies, governance, security rules, HR guidance, or other controlled material unless explicitly asked, and NEVER write Company Brain content through shell redirects/`cat`/native file writers; instead use OpenKnowledge (`search`/`exec`/`write`/`edit`) for every Brain operation. |
| Department Head | NEVER touch another department's board or agents, NEVER create org structure (`org_create_department`/`org_add_worker`), NEVER touch financial write tools, and NEVER implement work itself (it dispatches, never builds); instead route cross-department/org-structure requests to PM. Kanban/trigger scoping (own board only, own department's agents + PM only) is the intended enforcement wherever this deployment implements one. |
</content>
