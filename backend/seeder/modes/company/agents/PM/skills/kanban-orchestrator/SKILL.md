---
name: kanban-orchestrator
description: Route durable multi-agent work through Hermes Kanban. Use when a PM must decompose a user goal, dispatch department-level briefs to heads, monitor execution across department boards, hand off review, unblock work, or report board progress.
---

# Kanban Orchestrator

Use Kanban for durable cross-agent work. Do not implement task work yourself.

**Dispatch model: PM assigns to department HEADS, not to individual
workers.** `org_create_task_chain` server-side rejects
any task whose `agent_id` is not a department head (the one exception is a
sub-agent PM itself created via `org_add_sub_agent` — everything else must
route through a head). Each task you create in a chain is a **brief to a
head**: scope, acceptance criteria, priority, and — whenever it has
dependants — a `Handoff:` line. The head then researches its own
department context and creates the actual worker-level kanban tasks on its
own department board; you track the head-level brief, not the worker-level
execution tasks underneath it (the head tracks those on its own board —
see its own AGENTS.md for that workflow). Never call
`list_kanban_assignees` expecting individual workers as
valid task-chain targets — that tool lists every registered kanban
assignee across the org for other purposes (attachments, comments,
lookups), not who a task chain may be assigned to.

Call tools directly by their real name.

**Project-first (mandatory before creating any durable task):** A kanban task represents durable, trackable work — it belongs to a real project, not a bare default board. Before calling `org_create_task_chain`/`create_kanban_task`/`kanban_create` for the first time on a new piece of work:
1. Check whether a project already exists for this work via `org_get_projects` (or ask the user if genuinely unclear whether one should exist).
2. If no project exists yet and the work is substantial enough to need durable kanban tracking (not a one-off trivial ask), call `org_create_project` first — this creates the project workspace and its board should be created immediately after (see `AGENTS.md`).
3. Pass that project's board explicitly via the `board` parameter on every subsequent kanban tool call for this work (`list_kanban_boards` will show `project_slug` per board once created this way) — never let a real, project-scoped task silently land on the generic default board. This is PM's own planning/tracking board for head-level briefs — the department heads' own worker-execution tasks live on their own department boards, not this one.

Do not over-apply this: a genuinely tiny, standalone, non-project-scoped task (e.g. a quick one-off the user explicitly says doesn't need its own project) may still use the default board — use judgment, this is about durable project work getting a real home, not bureaucratizing every task.

**Discovery (mandatory, before any kanban tool call):**

1. Call `org_get_graph` then `org_agent_stats` — full org shape plus load/throughput per department. Build the capability map (which department/head fits which part of the goal) before touching any kanban tool — you are choosing a HEAD to brief, not an individual worker to assign.

**Chain creation:**

2. Call `list_kanban_boards` to confirm the project's own board (see Project-first above).
3. Choose the department head whose remit matches each phase, from `org_get_graph`. If title, scope, acceptance criteria, target head, or handoff is materially unknown, ask user before creating cards.
4. For any goal with more than one phase or a dependency between phases, submit the WHOLE chain in ONE `org_create_task_chain` call — a list of tasks with `depends_on` links, each `agent_id` a department head — rather than creating cards one at a time. Reserve `create_kanban_task`/`kanban_create` for a genuinely single, standalone brief to one head with no dependants. Every body states objective, constraints, acceptance checks, workspace/artifact location, and a `Handoff:` line whenever the task has dependants. Use stable goal-scoped idempotency keys.
5. `org_create_task_chain` wires `depends_on` for you (no separate `kanban_link` call needed for chain-created tasks); use `kanban_link` only to connect a standalone card into an existing chain after the fact. Unfinished-parent work stays `blocked`/`todo`, ready work dispatches automatically when parents finish.
6. Use `get_kanban_task` / `kanban_show` for evidence. Use `kanban_comment` for durable coordination. Do not claim completion without tool-confirmed output.
7. Use same-card review lifecycle: implementer (the head, or the head's worker) calls `kanban_request_review`; reviewer calls `kanban_request_changes` or `kanban_complete`. Do not use `kanban_block` for normal review changes.
8. Use `kanban_block` directly only for the first-time block on a task, with a clear reason (`dependency`, `needs_input`, `capability`, `transient`) and the exact unblock condition stated. Any subsequent retry-or-give-up decision on an already-blocked task goes through `kanban_retry_or_escalate` (pass the same `kind`, plus a required `reason` — `escalate_to` optional) — never manual re-judgement. That tool just unblocks for retry; it is Hermes' own block-recurrence loop-breaker, not a PM-managed counter, that decides a task has been re-blocked for the same reason too many times and auto-routes it to `triage`. When `kanban_retry_or_escalate` is called on a `triage` task, its job is only to give that orphaned task a real owner — one linked escalation task, PM by default or CEO via `escalate_to: ceo`.

Task body template:

```text
Objective: <single deliverable>
Context/constraints: <relevant facts>
Acceptance: <observable checks>
Artifacts: <workspace paths or required attachments>
Handoff: <next task/agent and evidence to provide — required whenever this task has dependants, optional for a standalone terminal task>
```

`Handoff:` is REQUIRED, not just implied by "next handoff" wording, on any
task that has dependants: `org_create_task_chain` deterministically rejects
a task with dependants whose body lacks a real `Handoff:` line (content
after the colon, not just the bare word).

Run only a task the user has authorized and whose board, assignee, body, and acceptance criteria are known. Confirm dispatch by reading it after creation; report task ID, status, assignee, dependencies, and blocker if any.

## Live task notifications — the automated attention loop

A worker's blocked/`needs_input`/failed-repeatedly task now wakes its own
department **head** first — the head is the first line of response for its
own department's board, not PM (see the head's own AGENTS.md). PM still
gets pushed a wakeup on task `done` for its own head-level briefs (the
chain entries PM itself created), and as a fallback when a task's assignee
has no resolvable department/head — through the same wakeup pipeline
`org_trigger_agent_async` replies already use. **These wakeups are work
orders, not FYIs**: handle them autonomously in the turn they arrive,
without waiting for a human prompt. Your standing duty for anything that
does reach you is to keep the relevant board flowing — blocked work gets
unblocked so the dispatcher re-runs it, and "done" only counts once the
output is verified achieved. This is best-effort delivery, not guaranteed:
if session resolution fails backend-side, it can degrade silently and
never arrive. Do not treat silence as proof nothing needs attention — fall
back to the normal tracking/verification steps below (`get_kanban_task`/
`kanban_show`, board checks per department) when in doubt. It is still not
polling as a default — don't call `kanban_list`/`get_kanban_board` on a
loop just to watch for these.

On a `needs_input` notice: figure out what's actually needed; if the input must come from the human, ask them directly — never guess an unconfirmed resolution; if it is within your remit, provide it yourself as a `kanban_comment` on the task. Then call `kanban_unblock` (or `kanban_retry_or_escalate` — requires a `reason` argument — if this is a retry-after-re-block, per rule 8 above) to resume it. That call only makes the task ready to run again — no separate dispatch/re-trigger call is needed for that part: the existing recurring Hermes dispatcher tick (not PM-triggered) picks the now-ready task back up on its own schedule and the assignee agent runs it. PM must still track the task afterward and verify its eventual completion via the tracking/verification steps described above (rule 6, and the completion-notice step below).

On a `failed repeatedly` notice (the retry circuit breaker gave up and blocked the task): do NOT just unblock it — the same failure would repeat and the loop-breaker would land it in `triage`. Sequence: (1) diagnose with `kanban_show` — task body, run history, and the last error say why iterations kept failing; (2) fix the cause first: `kanban_comment` corrected instructions or missing context onto the task, narrow the scope, or reassign to an agent that actually has the capability (re-check `org_agent_stats`); split the task if it was too big; (3) only then `kanban_retry_or_escalate` (reason = what you fixed) to return it to `ready` — the dispatcher re-runs it automatically. If the task already sits in `triage`, that same tool creates one owned escalation task instead of a blind retry. (4) Track the retry to a verified completion; a second give-up on the same cause escalates to the human with the diagnosis, never a third blind retry.

On a completion notice: verify the output is ACTUALLY achieved before reporting it done — `get_kanban_task`/`kanban_show`, then check the summary/result/artifacts against the task body's `Acceptance:` checks (read the named workspace artifacts when in doubt). Do not relay the push message as fact — same "Do not claim completion without tool-confirmed output" rule as above. If the acceptance checks are NOT met, do not accept it: `kanban_request_changes` with the concrete gap, or dispatch a follow-up fix task, and track that to completion too.

After ANY of these notices, before returning to other work, sweep the same board once: `kanban_list` with `status: blocked` (plus the `board` argument), and action every other blocked task there by the same rules above — resolve the cause, then unblock so the dispatcher re-runs it. The blocked column must trend toward zero; a blocked task with no PM action recorded on it is your backlog, not the worker's. This is one sweep per wakeup, not a polling loop. When the sweep is done, RESUME the work you were doing before the wakeup — the interrupt never replaces your previous thread of work.
