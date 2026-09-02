---
name: brain-memory-hygiene
description: When and how to log durable decisions to Brain, and the hotness/rollup discipline that keeps agents/ceo/curated-memory.md actually current — brain_create_draft, brain_agent_hotness, brain_mark_agent_rollup. Use this any time CEO reaches a decision worth remembering beyond this session, whether during a full weekly review, an ad-hoc MD question, or a priority escalation from PM — not just at the end of a scheduled review.
---

# Brain Memory Hygiene — logging durable decisions

`PLAN.md`'s Decision log is CEO's own session-to-session memory. Brain is
different: it's the org-wide durable knowledge store other agents (Librarian,
the MD, PM) can search. Not every decision belongs there — this skill is the
bar for what does, and the mechanics for keeping `agents/ceo/curated-memory.md`
from silently going stale.

This procedure applies whenever CEO reaches a decision worth remembering,
regardless of which skill's session produced it — a full `weekly-review`, an
ad-hoc MD question mid-review, or an inbound `escalation-handling` case.
Don't skip it just because the decision didn't come from a scheduled review.

## 1. Decide if this decision clears the durability bar

Ask: would this matter to someone reading CEO's history next month, not just
this week? Clears the bar:

- A strategic pivot (North Star change, a Top 3 item added/dropped/reordered
  for a real reason).
- A lasting risk finding (something that will keep mattering, not a
  transient blip).
- A resolved priority conflict with real reasoning behind the resolution
  (not just "priority X → Y" with no context — the diff itself already
  lives in `PLAN.md`'s Decision log; Brain is for the *why*).

Does NOT clear the bar — skip the draft, the Decision log row in `PLAN.md`
is enough:

- Routine "carried forward, still pending" rows.
- A question that got asked and simply wasn't ready to resolve yet.
- Anything already fully captured by a `project_set_priority` diff with no
  extra reasoning beyond the numbers.

When genuinely unsure, err toward writing the draft — a redundant draft
costs little; a missing one means a real decision is unsearchable later.

## 2. Write the draft

```json
// brain_create_draft
{
  "path": "agents/ceo/decisions/2025-03-10-onboarding-priority-shift.md",
  "content": "---\nstatus: draft\n---\n\n# Onboarding priority shift\n\nRaised growth-onboarding to priority 1. Reasoning: agent_stats showed growth\ndept underloaded while onboarding conversion kept slipping; PM confirmed\ncapacity to absorb the shift. Reversible experiment: reassess after 2 weeks,\nrevert if conversion doesn't move.\n"
}
```

- Path convention: `agents/ceo/decisions/<date>-<short-title>.md` — keep the
  date and a short kebab-case title so Librarian/MD can scan the directory.
- Content needs YAML frontmatter with `status: draft` — this is a hard
  requirement of the tool, not a style suggestion.
- If you're replacing an existing draft (rare — most decisions are new
  files), read it first for its `revision` and pass `expected_revision`.
  A brand-new path never has one.

## 3. Check your hotness counter

Every draft written under `agents/ceo/...` (except `curated-memory.md`
itself) increments a counter — the same mechanism Librarian uses per-project.
Before ending any session where you wrote at least one draft:

```json
// brain_agent_hotness
{"agent_id": "ceo"}

// real return shape
{"count": 3, "last_draft_at": 1710000000, "rollup_at": 1709000000}
```

## 4. Roll up if count >= 5

If `count` is 5 or more:

1. Read the current `agents/ceo/curated-memory.md` via `brain_read` (you
   need its `revision` to replace it, and its existing content so you append
   rather than overwrite history).
2. Search `agents/ceo/` (via `brain_search`) for what's actually there since
   the last `rollup_at` — don't summarize from this conversation's memory
   alone; other sessions may have written drafts you don't remember.
3. Write an updated `curated-memory.md` via `brain_create_draft` that appends
   a dated summary of the durable decisions/findings written since the last
   rollup, with `expected_revision` set to the revision you just read.
4. Only after that write succeeds, call:

```json
// brain_mark_agent_rollup
{"agent_id": "ceo"}
```

**Order matters**: mark-rollup resets the counter. Calling it before the
curated-memory.md write actually lands would silently lose track of drafts
that were never really summarized — always write first, mark second.

If `count` is under 5, do nothing further this session — don't force a
rollup early just because a session happens to be ending.

## Why this matters

`curated-memory.md` is seeded empty and stays empty forever unless this
rollup step actually runs. Anyone reading CEO's history — Librarian
producing an org-wide digest, the MD asking "what has CEO decided lately" —
depends on this file being a real, current summary, not a permanent stub.
Skipping steps 3–4 doesn't just lose a rollup; it makes every future rollup
attempt guess at what changed since an increasingly stale `rollup_at`.

## Relationship to other skills

This is the deep-dive version of `weekly-review`'s steps 10–11 — that skill
still tells you WHEN in the weekly review flow to run this (end of session,
after Decision log updates); this skill is the full HOW, usable from any
session shape, not just the scheduled review.
