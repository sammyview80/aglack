---
name: financial-review
description: How CFO actually runs a financial review end to end — reading/self-seeding PLAN.md, pulling financial fields, computing variance with a worked example, deciding when a figure needs verification from another agent, writing only verified figures, and closing out PLAN.md. Use whenever the CEO/MD requests a financial review, or a tracking pass surfaces something worth reporting.
---

# Financial Review — worked procedure

`AGENTS.md` states the policy (own-domain write only, never touch priority,
never send invoices). This skill is the concrete how-to, including two gaps
that policy alone doesn't resolve: what `PLAN.md` actually looks like in
CFO's own workspace on a brand-new deployment, and what "ask the source"
concretely means when a figure looks wrong.

Triggered by an explicit request — CFO has no fixed cadence in this
rollout. Run this whenever the CEO/MD asks for a review, or PM/another
agent asks CFO to confirm a figure.

## 1. Read `PLAN.md` — and self-seed it if it doesn't exist yet

CFO's own workspace has its own `PLAN.md`, separate from CEO's. On a
brand-new deployment this file may not exist yet in CFO's workspace. If it's
missing: **don't error and don't skip this step** — create it yourself with
the same six sections CEO's uses (North Star, Top 3, Active bets, Risks, MD
questions, Decision log), all blank, then continue as if it were freshly
seeded. This keeps a durable financial-question log alive across sessions
even before that gap in the seeding path is fixed. If it already exists,
read every section for continuity on prior financial findings before
calling any tool.

## 2. Pull financial fields for every project in scope

Call `org_get_projects`. Don't guess at any figure. Each
project carries `budget`, `spend_to_date`, `revenue_projected`,
`revenue_actual`, `invoice_status`, `cost_risk_level` — read all six for
every project the review covers, not just the ones that seem relevant.

## 3. Reconcile — worked example

Compute variance for both pairs, amount and percent:

```text
Project: growth-onboarding
  Budget: $50,000        Spend to date: $61,500
  Variance: +$11,500 (+23%) over budget

  Revenue projected: $80,000   Revenue actual: $52,000
  Variance: -$28,000 (-35%) under projection
```

Do this per project. Don't average or roll multiple projects into one
number unless the MD specifically asked for a portfolio-level view.

## 4. Check `cost_risk_level` and flag drift

Compare the stored `cost_risk_level` against what the variance in step 3
actually implies. If spend is 20%+ over budget or revenue is materially
under projection but `cost_risk_level` still reads unchanged from last
review, that's a flag: name it explicitly in the report rather than quietly
updating the field yourself without discussion (a variance CFO just
computed is a verified figure CFO can write via
`project_set_financials` — see step 7 — but do the
reconciliation and reporting narrative first so the write isn't the first
anyone hears of it).

## 5. Report format

One block per project, plain numbers, no narrative spin either direction:

```text
<project>: budget $X vs actual $Y (variance $Z, W%)
  revenue projected $A vs actual $B (variance $C, D%)
  invoice status: <not_started/drafted/sent/paid>
  risk flag: <unchanged/upgraded/downgraded — reason>
```

## 6. If a figure looks wrong — ask the source, concretely

"Ask the source" means: identify who actually owns or last touched this
number, then use
`org_trigger_agent_async(target_agent_id, message, caller_session_id)`
to ask them directly rather than guessing or silently adjusting the figure.
This does not block — it starts the target's turn and returns immediately;
requires your own current `caller_session_id`. Concretely:

- If the discrepancy is about org priority or a strategic bet's scope, the
  source is CEO — `org_trigger_agent_async(target_agent_id='ceo', message='...', caller_session_id='...')`.
- If it's about task/work status that could explain a spend jump (e.g. more
  work than planned actually shipped), the source is PM —
  `org_trigger_agent_async(target_agent_id='pm', message='...', caller_session_id='...')`.
- Call `org_get_graph` first if unsure which agent ID to
  target.
- State the exact figure in question and what looks wrong about it (e.g.
  "spend_to_date jumped from $40k to $61.5k since last review with no
  matching Decision log entry — can you confirm this is real spend and not
  a data entry error?").
- Never report a corrected or estimated number in the figure's place before
  getting an answer. Report it as "unverified — confirming with X" in THIS
  report; the source's reply arrives later, in a separate turn, and step 7's
  write happens only once it actually lands — never write speculatively
  because you assume the answer will confirm the figure.

## 7. Write only verified figures

Every write goes through `project_set_financials` and
only for `budget`, `spend_to_date`, `revenue_projected`, `revenue_actual`
(numeric), `invoice_status`, `cost_risk_level` (string) — its only
accepted fields. Only write a figure once verified either directly from
`org_get_projects` or confirmed by the source you asked in step 6. Never
call `project_set_priority` — that tool is CEO-exclusive
and CFO has no access to it regardless.

## 8. Close out `PLAN.md`

Log every resolved financial question from this session to the Decision
log (date, finding/decision, who confirmed it, any follow-up), and carry
forward anything still open (e.g. still waiting on CEO/PM confirmation from
step 6) rather than letting it silently drop between sessions.

## 9. Log durable findings to Brain

If a financial decision or risk finding is durable enough to matter beyond
this one report (a real budget overrun pattern, a lasting risk-level
change, not routine in-range numbers), request one
`brain_create_draft` under a path like
`agents/cfo/findings/<date>-<short-title>.md`. Routine "still within
budget, nothing changed" reviews don't need a Brain draft.

## 10. Roll durable findings into your own curated-memory.md

Every draft written under `agents/cfo/...` (except `curated-memory.md`
itself) bumps CFO's own hot-draft counter — same mechanism Librarian
already uses per-project. Before ending a session where you wrote at least
one finding in step 9:

1. Call `brain_agent_hotness(agent_id='cfo')`. Real
   return shape: `{"count": <int>, "last_draft_at": <timestamp>, "rollup_at": <timestamp or absent>}`.
2. If `count` is 5 or more: read the current `agents/cfo/curated-memory.md`
   (for its `revision`), then write an updated version via
   `brain_create_draft` that appends a dated summary of
   the durable financial findings written since the last rollup — search
   `agents/cfo/` for what's actually there, don't summarize from memory of
   this conversation alone.
3. Call `brain_mark_agent_rollup(agent_id='cfo')` only
   after that write succeeds — this resets the counter. Marking rollup
   before writing would silently lose track of findings never actually
   summarized.
4. If `count` is under 5, do nothing further this session.

This is what actually populates `curated-memory.md` — it's seeded empty and
stays empty unless this rollup step runs, so anyone reading CFO's history
(Librarian, CEO) has a real, current summary instead of a permanent stub.
