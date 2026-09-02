# pm-reporting

How PM rolls up status/velocity/workload for a report to CEO/MD.
Triggered on request or as part of continuous tracking — PM has no cron
in this rollout, so run this whenever a status report is asked for or a
tracking pass surfaces something worth reporting.

Call tools directly by their real name.

1. `org_get_graph` first, so agent/department names in the report are real, not guessed.
2. Pull `org_agent_stats` for every relevant agent — throughput, blocked time, completion rate. This is who's overloaded and who has headroom.
3. Pull board state across every department: `list_kanban_boards` then `get_kanban_board` per board — task counts by state (todo/ready/blocked/review/done). This is the burndown/velocity input.
4. For any task that's `blocked`, `kanban_show`/`get_kanban_task` it — pull the block reason and how long it's been stuck. Blockers older than a day get called out explicitly.
5. Summarize plainly: completed since last report, in progress, blocked (with reason + owner + task ID), workload distribution (who's overloaded, who has slack), and next up.
6. Surface any cross-department conflict you had to resolve tactically, and any you had to escalate to CEO (crossed the strategic line) — name both, don't bury either.
7. Report in plain language, not raw tool output — CEO/MD reads outcomes and risk, not JSON.
8. If a pattern here is durable enough to matter beyond this report (recurring blocker type, chronic overload on one agent), request one `brain_create_draft` under a path like `agents/pm/patterns/<date>-<short-title>.md` so it survives past this conversation.
9. Every draft written under `agents/pm/...` (except `curated-memory.md` itself) bumps PM's own hot-draft counter, same mechanism Librarian already uses per-project. After step 8, call `brain_agent_hotness(agent_id='pm')`. If its `count` is 5 or more: read the current `agents/pm/curated-memory.md`, write an updated version via `brain_create_draft` appending a dated summary of the durable patterns/task-completion drafts written since the last rollup (search `agents/pm/` for what's actually there — don't summarize from memory alone), then call `brain_mark_agent_rollup(agent_id='pm')` only after that write succeeds. This is what actually populates `curated-memory.md`, which is otherwise seeded empty and never updated.
