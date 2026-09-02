---
name: company-brainstorm-handoff
description: The exact procedure for a "start/build/create a company/agency/team" request, including when phrased as urgent ("don't ask me anything, just go"). Brainstorm North Star and first bets, write PLAN.md, hand the whole plan to PM in one message, then stop — never build, dispatch, or generate files yourself. Use this whenever the MD asks CEO to start something from scratch, not for routine priority/status work (see weekly-review for that).
---

# Company Brainstorm → PM Handoff

`AGENTS.md` and `SOUL.md` both state the rule: when asked to start a company/
agency/team from scratch, CEO's job is to decide fast and hand off — never to
build. This skill is the worked step-by-step, including the exact PM message
shape, so the handoff actually happens in one turn instead of drifting into
CEO doing implementation work to "show progress."

## Recognize this situation

Triggers: "start a company," "build an agency," "create a team," "set up
[org] for X" — especially when phrased urgently ("don't ask me anything,
just go," "just do it," "I don't have time to answer questions"). That
urgency is a signal to brainstorm fast and decide fast, not to skip the
decision and start generating artifacts (a logo, a landing page, a deck)
that only look like progress.

If the request is instead "review priorities," "how's X doing," or an
already-existing org — that's `skills/weekly-review/SKILL.md`, not this
skill.

## 1. Brainstorm the actual decision, in this same turn

Think through, out loud if useful, before writing anything:

- **Purpose** — what is this company/team actually for, in one line (this
  becomes PLAN.md's North Star).
- **Shape** — what departments/roles plausibly make sense given the purpose
  (e.g. a SaaS company needs product/eng/growth; a services agency needs
  delivery/sales). You are proposing shape for PM/Builder to execute, not
  building it yourself.
- **First 1–3 bets** — the first concrete initiatives worth pursuing, framed
  as reversible experiments, not permanent commitments.
- **Genuine ambiguities** — anything materially unclear enough that guessing
  wrong would waste real Builder/PM/CFO effort. Don't invent an answer to
  something the MD needs to actually decide; queue it instead (see step 2).

This is the real decision being asked for. Spend your effort here, not on
producing a file that merely looks like the company already exists.

## 2. Write the plan into `PLAN.md`

`PLAN.md` always means `PLAN.md` — your own workspace
root, never a shared org-root PLAN.md. Fill in, from step 1:

- **North Star** — the one-line purpose.
- **Top 3** — the first 1–3 bets, each as a decision/owner/date row (owner
  will usually be PM at this stage, since PM hasn't dispatched yet).
- **MD questions** — one row per genuine ambiguity from step 1, so it isn't
  lost even though you're proceeding without waiting on it.

Don't leave this only in the conversation — if the session ends here, the
brainstorm needs to survive in `PLAN.md` for the next session.

## 3. Hand the WHOLE plan to PM in ONE message

Use `org_trigger_agent_async(target_agent_id='pm', message=..., caller_session_id=...)`
— see `skills/org-communication/SKILL.md` for the tool mechanics. One
message, not a multi-step conversation, and not a separate message per
department. Shape it like this worked example:

```text
New company kickoff — MD requested "<original ask, one line>."

North Star: <purpose, one line>.

Proposed shape (for Builder to create, your call on exact structure):
- <Department 1> — <what it owns>
- <Department 2> — <what it owns>
(add/omit departments as the purpose actually warrants — this is a proposal,
not a spec Builder must follow verbatim)

First bets (Top 3, track these):
1. <bet 1> — reversible experiment: <smallest safe next step>
2. <bet 2> — reversible experiment: <smallest safe next step>
3. <bet 3> — reversible experiment: <smallest safe next step>

Financial baseline: <flag for CFO to set up, or "none specified — ask MD" if
genuinely unknown>.

Open questions (MD hasn't resolved these — surface if they block you, don't
guess): <list from PLAN.md's MD questions, or "none">.

This is CEO's decision handoff — routing to Builder/CFO/your own tracking is
your call to make, not mine to pre-solve.
```

PM decides how to route this (Builder for structure, CFO for financial
baseline, its own task chain for tracking) — that routing is explicitly PM's
job per PM's own `company-kickoff` skill, not something CEO pre-solves or
double-checks step by step.

## 4. Report back to the MD — and stop

Tell the MD what you decided (North Star, Top 3, any open questions), that
PM is running with it, and that the handoff was sent in the background —
`org_trigger_agent_async` does not wait for PM's turn to finish, so say so
plainly rather than implying PM has already confirmed anything. PM's actual
reply will be delivered into your own session automatically once its turn
finishes; relay that confirmation to the MD then, in a later turn, rather
than promising it now.

**Never say the company is "created"** — only PM, via Builder's confirmed
graph, can say that's actually done. If asked "is it done yet," check
`org_get_graph` for the real current state rather than assuming your handoff
already finished the work.

## What NOT to do (the actual failure mode this skill prevents)

- Do not generate a logo, brand name, deck, landing page, or any other file
  yourself as a stand-in for the decision — that is real implementation work
  belonging to whichever agent PM dispatches it to, never CEO. You have no
  code, terminal, browser, image, or video tools at all; this isn't just a
  style rule, those calls fail.
- Do not call `org_create_department`/`org_add_worker` yourself — you don't
  have them. `org_add_sub_agent` under your own id is not a substitute for
  real department/worker structure.
- Do not run the full `weekly-review` procedure as a substitute for this flow
  — a from-scratch kickoff is this skill; routine review of an existing org
  is `weekly-review`.
- Do not let brainstorm quality slide because the request was phrased as
  urgent — "go fast" means decide fast, not skip the thinking in step 1.
