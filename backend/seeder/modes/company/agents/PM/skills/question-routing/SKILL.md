---
name: question-routing
description: Use when a user asks a standalone QUESTION that needs another agent's domain knowledge (financials, org structure, company knowledge, another agent's own identity) rather than a goal that needs work done. Route to the one agent who actually knows via org_trigger_agent_async, tell the user it's been asked, and relay the real answer — attributed to that agent — once it arrives. Not for task dispatch — see kanban-orchestrator for that.
---

# Question Routing

Some things a user asks you are not a goal to decompose into kanban work —
they're a question that a specific other agent already knows the answer to.
Don't answer from guesswork, and don't silently answer on another agent's
behalf. Route the question, relay the real answer, say who it came from.

## When this applies

Applies when the ask is a question expecting an answer, not a deliverable:
"what's our current burn rate," "what departments exist," "what does the
Librarian know about project X," "what's Builder's SOUL.md say," "is Brain
healthy." Does not apply to anything that produces work (code, docs, org
structure, a new task) — that's `kanban-orchestrator`/`company-creation`, not
this skill. If a message mixes both, split it: answer the question part here,
dispatch the work part per the normal goal workflow.

## 1. Pick exactly one target agent

Call `org_get_graph` first, always — never route from
memory or assumption. `org_get_graph` returns each agent's `id`, `role`,
`label`, `department_slug`, and `parent_id`, but NOT its profile description
— it does not hand you a ready-made routing table. Match the question to a
target using the fixed remits below plus the graph's actual department/agent
names for anything outside these singleton roles:

| Question is about | Route to (`target_agent_id`) |
| --- | --- |
| Cost, revenue, budget, invoice status, financial risk | `cfo` |
| Org priority, weekly strategic decisions, MD-level tradeoffs | `ceo` |
| Departments, heads, workers, reporting lines, org structure | `builder` |
| Company knowledge, project wikis, durable research, digests | `librarian` |
| Another agent's own SOUL.md/AGENTS.md/persona | `persona` |
| A specific department's own domain work (not financial/org/knowledge) | that department's head agent, found via `org_get_graph` |

If more than one agent could plausibly answer, or the question names no
clear domain, ask the user one direct question to disambiguate — never guess
silently and never pick an arbitrary default.

## 2. Ask the target directly

Call `org_trigger_agent_async(target_agent_id, message,
caller_session_id)` with the user's question (rephrased as a direct,
self-contained ask — the target has no visibility into this conversation).
This does NOT block — it starts the target's turn and returns immediately.
Requires `caller_session_id`, your own current session id. Never trigger
yourself. Never answer on the target's behalf from what you already assume
its domain data looks like.

Tag the message per `skills/org-comm-protocol/SKILL.md`:
`@<target_agent_id> [status: dispatched]` followed by the question. If the
target's turn is already busy, follow that skill's retry procedure (wait
30s, retry up to 3 times total) before reporting failure to the user.

**Immediately tell the user, in this same turn**, that you've asked the
target agent and will relay the real answer once it comes back — never go
silent just because there's no reply yet. Something like:

```text
I've asked <agent name> — I'll relay the answer here as soon as it comes back.
```

If the target gets stuck on a clarify/approval question while you wait, see
`skills/org-communication/SKILL.md`'s `org_trigger_check_pending` /
`org_trigger_respond` section — and tell the user about that too.

For more than one question needing more than one agent's input in the same
turn, use `org_trigger_agents_parallel(targets=[...])`
instead of calling `org_trigger_agent_async` repeatedly — max 10 targets,
all run concurrently, but note this ONE tool still blocks until every
target finishes (the only trigger tool that does) — decide whether that
wait is acceptable for this question before choosing it over async.

## 3. Relay the answer, attributed, when it arrives

The reply lands later in your own session (as an `[IMPORTANT: ...]`
message), not in the turn that sent the question. Never present a routed
answer as your own knowledge or drop the source. The target's reply should
itself be tagged `@<its-own-id> [status: success]` or `[status: failed]`
per `org-comm-protocol` — that tag is what tells you the thread is closed
and safe to relay without re-triggering. Relay it to the user in this
shape, in whichever turn it actually arrives:

```text
<agent name> answered your earlier question:

<the target's reply, unedited in substance>
```

Use the agent's real name/role (e.g. "CFO", "Builder", "Librarian"), not its
raw `target_agent_id` if a friendlier label is available from `org_get_graph`.
If you used `org_trigger_agents_parallel` and combined replies from more than
one agent, attribute each reply to its own agent separately — never merge
them into one unattributed paragraph.

## 4. Failure handling

If a delivered reply's wrapper indicates the target's turn timed out or
produced no reply, relay the real reason to the user plainly — never
fabricate an answer standing in for the agent that didn't respond, and never
retry blindly. Say so exactly as delivered, including the session id if
given, so the user knows the answer may still arrive rather than having
failed outright.

## 5. Never let this replace dispatch

`org_trigger_agent_async` here is for getting an answer, not getting work
done. If the "question" actually implies the user wants something built,
changed, or tracked, don't stop at relaying an answer — go through the
normal goal workflow (Phase A discovery, Phase B one-shot chain) instead, or
route org structure requests through `company-creation` and financial data
requests to CFO's own domain, per the existing tool boundaries. This skill
only covers the read-only, single-answer case.
