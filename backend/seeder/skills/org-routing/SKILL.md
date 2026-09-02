---
name: org-routing
description: Run this FIRST on every incoming request, before any other org skill. Decides whether the request is actually your remit or belongs to another lead (CEO/CFO/PM/Builder/Persona/Librarian) or a department head. If it's not yours, ask via `clarify` whether to mediate (relay via org_trigger_agent_async and report back here) or go ask that lead directly in its own chat. Never guess an answer that belongs to another lead's domain, and never silently relay without asking first.
---

# Org Routing — is this actually mine to answer?

You are one of six org-wide leads (CEO/CFO/PM/Builder/Persona/Librarian).
Leads route to each other; department heads and workers do not use this
skill — routing across leads is a lead-only concern, they stay scoped to
their own department's dispatched work.

Run this check on every new request before doing anything else — before
any of your other own-remit skills. Those skills assume the request is
already confirmed to be yours; this skill is what confirms that.

## 1. Self-check: is this actually your remit?

See your own `skills/org-remit/SKILL.md` for the exact remit description
and the routing table for step 2 below — this skill only covers the
shared mechanic (steps below), not what's actually in your own remit or
where a request outside it goes.

If the request is inside your remit — answer it yourself using your own
in-remit skill(s). Stop here; the rest of this skill doesn't apply.

If the request is outside it, go to step 2.

## 2. Match the request to its real owner

Never guess or answer from assumption on another lead's domain — even if
you think you know the answer, the other lead's data is the source of
truth, not your memory of it. Use your own `skills/org-remit/SKILL.md`'s
routing table to find the real owner.

If more than one plausibly fits, or the request names no clear domain, ask
one direct question to disambiguate — never pick a default silently.

## 3. Ask — mediate or go direct

Once you know the real owner, don't relay automatically and don't just
answer anyway. Use the `clarify` tool to ask directly:

```text
This is <Lead name>'s domain (<one-line reason, e.g. "financial figures">).
Want me to ask <Lead name> and relay the answer back here, or would you
rather open <Lead name>'s own chat and ask directly?
```

Offer exactly two options: **mediate** or **go direct**. Wait for the
answer — never assume which one is wanted.

- **Mediate picked**: call
  `org_trigger_agent_async(target_agent_id='<lead>',
  message=..., caller_session_id=...)` with the request rephrased as a
  direct, self-contained ask (the target has no visibility into this
  conversation). Tell whoever asked, in this same turn, that it's been
  sent and is running in the background. Relay the real reply, attributed
  to that lead, once it's delivered into your own session later — never
  present it as your own knowledge. See `skills/org-communication/SKILL.md`
  (CEO's copy) or your own equivalent for the full mechanics if you have
  one.
- **Go direct picked**: acknowledge which lead to talk to and stop — do
  not call `org_trigger_agent_async` yourself. Whoever asked will open
  that agent's own session; you have no tool to switch it for them.

Never re-ask the same question twice in one turn once it's been answered.
Respect whichever option was picked; don't fall back to the other one
without being asked again.

## 4. What this skill does NOT cover

- If the request is a mix — part your remit, part another lead's — answer
  your part directly and route only the other part through steps 2-3.
- Any exception specific to your own role (e.g. an inbound escalation, a
  mandatory handoff step that isn't "routing" in this skill's sense) is
  documented in your own `skills/org-remit/SKILL.md`, not here.
</content>
