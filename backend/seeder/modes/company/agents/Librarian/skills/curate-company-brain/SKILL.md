---
name: curate-company-brain
description: How Librarian actually answers, curates, researches, refreshes wikis, and runs digests — a worked citation example, the concrete hot-project rollup trigger (with real counter shape), and the wiki-refresh decision tree already in AGENTS.md restated as one lookup table. Use for questions about the company, projects, tasks, decisions, teams, codebases, company brain, or managerial context; for capturing durable operational information; for researching company-relevant topics; and for explicitly requested wiki refreshes or digests.
---

# Company Librarian — worked procedure

`AGENTS.md` already states the full policy for answering, curating,
researching, and refreshing wikis — read it first; this skill doesn't
repeat that policy, it adds the pieces policy alone doesn't resolve: what a
grounded answer actually looks like, the concrete hot-project rollup
trigger with its real data shape, and a compact lookup version of the
wiki-refresh decision tree for quick reference mid-task.

## Answering — worked example of a grounded reply

"Distinguish confirmed facts from inference, cite the supporting material"
is the rule in `AGENTS.md`. Concretely, a grounded answer looks like this:

```text
Confirmed: the growth-onboarding project has a $50,000 budget and is
currently at $61,500 spend (source: projects/growth-onboarding/rollup.md,
last updated 2025-03-08).

Inference: at the current burn rate, budget will be fully consumed before
the projected launch date — this isn't stated directly anywhere in the
Brain, it's a projection from the spend trend above.

Gap: I found no note confirming whether the MD already approved the budget
increase discussed in the CEO's last Decision log entry — worth confirming
with CEO directly if this matters for your question.
```

Never collapse "confirmed" and "inference" into one undifferentiated
paragraph — the user needs to know which parts are sourced and which are
your own reasoning.

## Curating — the hot-project rollup trigger, concretely

`AGENTS.md` says: check `brain_project_hotness` before finishing a
project-scoped draft, and roll up once it crosses 5 drafts. Concretely:

1. After writing/editing a note under `projects/<slug>/...`, call
   `brain_project_hotness` with that `slug`.
2. Real return shape: `{"count": <int>, "last_draft_at": <timestamp>, "rollup_at": <timestamp or absent>}`.
   `count` is the number of drafts written under that project since the
   last rollup (or ever, if never rolled up) — it resets to 0 automatically
   the moment you call step 4 below, so you're always reading the count
   since the last actual rollup, not a lifetime total.
3. If `count` is 5 or more: write `projects/<slug>/rollup.md` summarizing
   that project's drafts (search scoped to `projects/<slug>/` first — don't
   summarize from memory of the conversation, pull the real notes).
4. Call `brain_mark_project_rollup` for that `slug` —
   this resets its counter to 0 and stamps `rollup_at`. Do this only after
   `rollup.md` is actually written; marking rollup before writing it would
   silently lose track of drafts that never got summarized.
5. If `count` is under 5, do nothing further — this is the normal case for
   most single-draft updates.

## Wiki refresh — quick lookup table

`AGENTS.md` has the full reasoning for each case (why `.git` may not exist,
why the wiki lives centrally and never inside `/workspace/projects/<slug>/`,
the git-lock collision this avoids). Once you've read that once, use this
table mid-task instead of re-reading the full paragraph every time:

| Wiki state | `.git` state | `source_commit`/`HEAD` resolve? | Action |
| --- | --- | --- | --- |
| No wiki yet | either | n/a | Bounded survey of real code, write initial `OVERVIEW.md` (omit `source_commit` if no real `HEAD`), only warranted section pages, initial `log.md` entry |
| Wiki exists | No `.git` | n/a | Nothing to diff — fresh bounded survey, update pages vs. what wiki currently says |
| Wiki exists | `.git` exists | Both resolve | `git diff --name-status <source_commit>..HEAD`, update only pages tied to changed modules/flows/concepts |
| Wiki exists | `.git` exists | Either doesn't resolve (empty repo, stale/missing `source_commit`) | Nothing to diff — fresh bounded survey, same as "no wiki yet" case |

After any refresh: set `source_commit` to verified `HEAD` only when it
actually resolves, append a dated `log.md` entry, run the OpenKnowledge
audit/links check on the changed scope, and create a Brain draft
summarizing the refresh. Never rewrite all wiki pages wholesale, never edit
the project's real product code, never promote research to canonical
status merely to perform a refresh.

## Daily digest

Call `brain_write_digest` with no arguments (defaults to
yesterday). Report the digest's date, entry count, and path — say plainly
if it reports no activity. Never back-fill or rewrite a past digest.

## Agent hotness — backstop for agents that haven't rolled up their own memory

CEO, CFO, and PM each check their own `brain_agent_hotness`
and roll durable drafts into their own `agents/<id>/curated-memory.md` as
part of their own workflows (see their skills). Since you're the one agent
whose job is keeping the whole Brain current, treat this as a backstop, not
your primary job: if you notice (while answering a question or doing any
other Brain work) that an agent's `curated-memory.md` still reads as the
empty seeded stub while `agents/<id>/...` clearly has real drafts under it,
you can roll it up yourself the same way:

1. Call `brain_agent_hotness(agent_id='<id>')`.
2. If `count` is 5 or more (or the file is stale relative to what's actually
   under `agents/<id>/`), search that agent's folder, write an updated
   `agents/<id>/curated-memory.md` summarizing what's there since the last
   rollup, then call `brain_mark_agent_rollup(agent_id='<id>')`.
3. Never rewrite another agent's `curated-memory.md` to change its
   substance or correct its judgment calls — only to summarize what that
   agent itself already wrote as durable drafts.
