---
name: hermes-org-builder
description: How Builder actually creates org structure end to end — a full worked example from graph read through department/worker/sub-agent creation, what idempotency actually means for each create call, real error text for a bad parent ID, when to also create Discord scaffolding, and how nesting under a worker (not just a head) really works. Use when a user asks to build a team, create a department, add a worker, or add an agent under an existing Hermes agent.
---

# Hermes Org Builder — worked procedure

`AGENTS.md` states the policy (which tools exist, which fields are
required, ask-then-create discipline). This skill is the concrete how-to,
including three things policy alone doesn't cover: what each create call
actually does when the target already exists, the real error text for an
invalid parent, and when Discord scaffolding belongs alongside a new
department.

## Tools used in this skill

Every step below calls one of these by its real, fully-qualified name —
never a shortened form, never wrapped in `tool_call`/`tool_search`:

- `org_get_graph`
- `org_create_department`
- `org_add_worker`
- `org_add_sub_agent`
- `org_discord_create_category`
- `org_discord_create_channel`
- `org_discord_create_thread`
- `org_trigger_agent_async` — the mandatory persona handoff (final step)
- `org_trigger_check_pending` / `org_trigger_respond` — if persona's turn gets stuck on a clarify/approval question

## 1. Gather requirements

Identify the operation, ask one direct question at a time for whatever's
missing (never re-ask for something already given):

| Request | Required fields |
| --- | --- |
| New department | Department name and head-agent name |
| New worker | Department slug or name and worker name |
| New sub-agent | Parent agent ID and new agent name |
| Bulk team | Department name, head name, and worker names or a count |

For a count-only bulk request, ask for real names or explicit confirmation
that generic names (`Worker 1`, `Worker 2`) are acceptable.

## 2. Read the graph before creating anything

Call `org_get_graph` first, always. This matters more
than a simple "check for collisions" step: **`org_create_department` and
`org_add_sub_agent` are both idempotent** — calling either again with a
matching key returns the *existing* department/head or sibling agent
instead of erroring or creating a duplicate. The tool itself will not stop
you or warn you if you accidentally "recreate" something that already
exists; it will silently hand back the existing one. So the graph read
isn't just collision detection — it's how you decide, before calling
anything, whether the user actually wants to reuse what's there or truly
wants something new under a different name.

- `org_create_department` is idempotent on the department's **slug**
  (derived from name) — same name in, same department+head out, every time.
- `org_add_sub_agent` is idempotent on **(parent_agent_id, name)**, compared
  case-fold — same parent and same name in, same existing agent out.
- `org_add_worker` has no independent idempotency of its own — it's a shim
  that calls `create_sub_agent` against the department's head as parent, so
  it inherits the same (parent, name) idempotency transitively.

If the graph read shows a department/agent with the same name already
exists and the user's intent is ambiguous, ask: reuse it, rename the new
one, or abort. Don't silently proceed either way.

## 3. Create — worked example, start to finish

A user asks: "Set up a Growth department with Alex as head, and add Jamie
and Sam as workers."

**Step 1 — check first:**
```json
// call org_get_graph (no arguments)
// inspect returned nodes for a department named "Growth"
```

**Step 2 — create the department + head:**
```json
// call org_create_department
{"name": "Growth", "head_name": "Alex"}

// real return shape
{
  "department": {"id": "department:growth", "type": "department", "label": "Growth", "slug": "growth", "head_agent_id": "agt_...", "agent_count": 1, ...},
  "head": {"id": "agt_...", "role": "head", "label": "Alex", "department_slug": "growth", ...}
}
```
Note the returned `slug` (`"growth"`) — use it verbatim for the worker
calls next, don't re-derive it yourself.

**Step 3 — add each worker, one call at a time:**
```json
// call org_add_worker
{"department_slug": "growth", "name": "Jamie"}
// inspect result, then:
{"department_slug": "growth", "name": "Sam"}
```
There is no bulk-create call — for a bulk team, call `org_add_worker` once
per worker name, sequentially, inspecting each result before the next call.

**Step 4 — summarize:**
"Created department **Growth** (slug `growth`) with head **Alex**, workers
**Jamie** and **Sam**."

## 4. Sub-agents — including nesting under a worker, not just a head

`org_add_sub_agent` is the general primitive — it can attach a new agent
under ANY existing agent (the builder itself, a department head, or a
worker at any depth), not only under a department head. `org_add_worker` is
just a convenience shim that always targets the department's head as
parent. **If the user wants to nest an agent under an existing worker**
(not the head), you must use `org_add_sub_agent` directly with that
worker's own `agent_id` as `parent_agent_id` — `org_add_worker` cannot do
this, it only ever attaches to the head.

```json
// call org_add_sub_agent
{"parent_agent_id": "<worker's own agent id from org_get_graph>", "name": "<new agent name>"}
```

### Invalid parent — real error text

If `parent_agent_id` doesn't match any existing agent, the tool returns an
error whose exact reason is:

```text
agent '<the id you passed>' does not exist
```

Relay this exact reason to the user (don't paraphrase it into something
vaguer) and stop — don't retry with a guessed ID. Re-run `org_get_graph` and
ask the user to confirm the correct agent, or pick from the graph yourself
if there's exactly one plausible match and say which one you picked.

## 5. Discord scaffolding — when to create it

Builder-only tools `org_discord_create_category`, `org_discord_create_channel`,
`org_discord_create_thread` are separate from org-structure creation — creating
a department does NOT automatically create Discord scaffolding. Create Discord
structure only when the user asks for it (e.g. "set up a Discord channel for
this team too"), not by default alongside every department. All three are
idempotent by lookup (name, or name+parent) — calling again with the same
identifying fields returns the existing category/channel/thread rather than
duplicating:

```json
// category first
{"name": "Growth"}
// -> returns {"id": "<category_id>", ...} — existing or newly created

// channel needs the category_id from above
{"name": "growth-general", "category_id": "<category_id from prior call>"}
// -> returns {"id": "<channel_id>", ...}

// thread needs the channel_id from above
{"channel_id": "<channel_id from prior call>", "name": "kickoff"}
```
Create in that order — category, then channel (needs `category_id`), then
thread (needs `channel_id`) — since each later call depends on an ID the
earlier one returns.

## 6. Failures and completion

If any result has an `error` field, relay its actual reason exactly as
returned and stop that operation — don't retry blindly, don't invent a
workaround, don't proceed to the next step in a multi-step request (e.g.
skip creating workers if the department call itself failed).

When successful, summarize the resulting hierarchy as department → head →
workers, including any nested sub-agents and any Discord scaffolding
created. If nothing was created, state exactly which required information
is still missing.

## Final step — persona tunes every new agent (mandatory)

Creation is not done at the create call. Every new agent starts with
generic identity files; the persona agent is the one that makes them real.
After all create calls succeed:

1. Collect the new agent ids from the create results (each result's
   `next_step` field also reminds you of this step).
2. Send ONE `org_trigger_agent_async` message (with your
   own current `caller_session_id`) to `target_agent_id='persona'` in this
   shape:

   ```text
   Tune newly created agents. For each, write a tailored SOUL.md,
   AGENTS.md and profile description:
   - <agent_id>: <name> — <role/purpose in one sentence>
   - <agent_id>: <name> — <role/purpose in one sentence>
   ```

   This returns immediately — it does not wait for persona's turn to
   finish. **Tell whoever asked, in THIS turn**, that the structure exists
   but persona tuning is still running in the background, and that you'll
   confirm once it's done. Do not report the structure fully complete yet.
3. Persona's reply is delivered into YOUR OWN session automatically once
   its turn finishes — in a LATER turn, not this one. When it arrives,
   check it confirms each agent was tuned. If persona's turn gets stuck on
   a clarify/approval question first, use `org_trigger_check_pending` /
   `org_trigger_respond` (you triggered persona, so only you can answer it).
4. Only once persona's delivered confirmation has actually arrived and been
   checked, report the structure complete, including persona's confirmation
   in your report. If persona's trigger call itself errored, or its
   delivered reply reports a failure, report that the agents exist but are
   NOT yet tuned — never claim otherwise, and never claim tuning is done
   just because the async trigger call itself returned successfully (that
   only means the message was sent, not that persona finished).
