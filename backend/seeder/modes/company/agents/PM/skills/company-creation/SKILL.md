---
name: company-creation
description: Use when a user or CEO asks PM to create a new department, company, or team of agents (department + head + workers). PM cannot create org structure itself — this skill covers gathering requirements and relaying them to Builder.
---

# Company Creation (via Builder)

Org-structure tools (`org_create_department`, `org_add_worker`,
`org_add_sub_agent`) are Builder-only. You never call them directly. Your
job is: gather full requirements, relay them to Builder in one message, tell
the requester it's running, then — once Builder's confirmation actually
arrives — verify the graph actually changed before reporting done.

## 1. Gather requirements

Collect the same required fields Builder's own `create-department-and-agents`
skill requires, before relaying anything:

- Department name (and a slug idea if the user has one)
- Head agent name
- List of worker agent names

Ask one direct question at a time for whatever required field is missing.
Worker description/role is optional — a nice-to-have Builder writes into the
worker's profile if given, not a blocker. If the user gives descriptions,
include them; if not, relay with names only. Do not withhold or delay
relaying over a missing description.

## 2. Relay to Builder

Call `org_trigger_agent_async(target_agent_id='builder',
message=..., caller_session_id=...)` with one structured message containing
the whole spec. This call does NOT block — it starts Builder's turn and
returns immediately. Requires `caller_session_id`, your own current session
id.

**Tell the requester now**, in this same turn, that the request was sent to
Builder and is running in the background — don't imply it's done, and don't
go silent waiting for it. Builder's reply will be delivered into your own
session automatically once its turn finishes; you finish verifying (steps
3-4) in whichever later turn that reply actually arrives.

Example message:

```text
Create a new department:
- Department name: Growth
- Head agent name: Growth Lead
- Workers:
  - Name: SEO Analyst (description optional — e.g. owns organic search performance and content gap analysis)
  - Name: Lifecycle Marketer
```

If Builder gets stuck on a clarify/approval question before finishing, see
`skills/org-communication/SKILL.md`'s `org_trigger_check_pending` /
`org_trigger_respond` section (same tools, same scoping — you triggered
Builder, so you're the one who can discover and answer it) — and tell the
requester about that too if it happens.

## 3. Verify persona tuning happened (once Builder's reply arrives)

Builder's own procedure ends with a mandatory persona handoff: persona
writes each new agent's tailored SOUL.md, AGENTS.md, and profile
description. Builder's reply must include persona's confirmation. If it
doesn't, send Builder one follow-up asking for the persona step — or
trigger persona yourself with the new agent ids and their roles — before
moving on. An agent with only generic identity files is NOT a finished
agent.

## 4. Verify before reporting done

Don't take Builder's delivered reply on faith:

1. Check the reply itself for an error — if present, relay the exact
   reason to the requester and stop. Do not retry blindly.
2. Call `org_get_graph` again and confirm the new
   department/head/workers actually appear with the names given.
3. Only then tell the requester it's done, summarizing department → head →
   workers as Builder created them.

Never fabricate or assume a department/agent name Builder didn't confirm
creating — report exactly what the graph shows, not what was requested.
