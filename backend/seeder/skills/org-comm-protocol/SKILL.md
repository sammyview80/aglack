---
name: org-comm-protocol
description: The mandatory message format, retry policy, and loop-termination rule for every org_trigger_agent_async call and every reply you send back — @mention tag, status tag (dispatched/clarification/success/failed), busy-retry procedure, and when to stop re-triggering a thread. Use this every time you call org_trigger_agent_async, org_trigger_agents_parallel, or relay a reply — not just for CEO-specific comms in org-communication.
---

# Org Communication Protocol — tagging, retries, loop termination

This is the shared wire format every lead (CEO/CFO/PM/Builder/Persona/
Librarian) uses on top of the raw `org_trigger_agent_async` /
`org_trigger_agents_parallel` / `org_trigger_check_pending` /
`org_trigger_respond` tools. Those tools move the message; this skill says
what the message text itself must contain so any lead reading a trigger or
a reply can tell, without guessing, who it's from, what kind of event it
is, and whether the thread is actually done.

`skills/org-communication/SKILL.md` covers WHICH tool to call for a
given situation. This skill covers WHAT TO PUT IN the `message` field of
every one of those calls, and how to behave when the target is busy or
when a reply loop could keep going forever. Always apply both.

## 0. The one rule that fails most often: printing is not sending

Narrating, summarizing, or printing a message or clarification into your
own chat/session is NEVER a substitute for actually calling the tool that
delivers it — `org_trigger_agent_async` to send, `org_trigger_respond` to
answer a clarify, or forwarding via your own reply in the triggering turn
per section 4b. If a message needs to reach another agent, the ONLY way it
reaches them is a real tool call. Text you type to yourself is invisible
to everyone else and ends the chain silently — the recipient never
receives it, and no one upstream ever learns the thread happened.

**Scenario 1 — A triggers B with a message.**

- Wrong: B receives `@b [status: dispatched]`, does the work, then just
  writes out "done, result is X" in its own session and stops. Nothing is
  ever sent back to A. A waits forever.
- Right: B does the work, then actually calls the reply/completion path
  (or `org_trigger_respond` if it was a clarify) tagged
  `@b [status: success]` (or `failed`), so A actually receives it.

**Scenario 2 — the 3-hop clarification (ties into section 4b).**

- Wrong: A triggers B, B triggers C, C raises a clarification. B gets the
  `[IMPORTANT: ...]` push, but instead of forwarding it to A, B just
  logs/narrates C's clarification in its own chat/session and stops. The
  chain dies at B; A never learns C had a question.
- Right: B forwards the clarification to A as its reply in the turn A
  triggered, tagged `@c [status: clarification]` per section 4b — the
  forward IS the action, not a description of the action.

## 1. Always async — never block on another lead's turn

`org_trigger_agent_async` is the default for reaching one agent, always —
never wait synchronously for a reply. The only tool here that blocks is
`org_trigger_agents_parallel`, and only because "fire N at once, need all
N answers before continuing" is a genuinely different shape — even then,
it blocks your own turn, not the human. Never invent a synchronous
substitute (e.g. polling `org_trigger_task_status` in a tight loop
pretending to "wait") — that defeats the entire point of the async design
and ties up your own turn exactly as if you'd blocked.

## 2. Every message needs an @mention + a status tag

Every `message` you send via `org_trigger_agent_async` /
`org_trigger_agents_parallel`, and every reply/relay you write back (to the
human, or when your own reply is what completes a triggered turn), starts
with one tag line in this exact shape:

```text
@<agent-id> [status: <tag>]
<the actual message body>
```

- `@<agent-id>` is the RECIPIENT of this message when you are sending
  (e.g. `@pm`, `@cfo`), or the SENDER when you are relaying a reply you
  received (e.g. "`@pm [status: success]` replied: ..."). Always the bare
  agent id from `org_get_graph` — never a display name, never your own
  prefix in the tag itself — there is none in this system.
- `[status: <tag>]` is exactly one of:

| Tag | Meaning | When you use it |
| --- | --- | --- |
| `dispatched` | A new request/question just sent, no answer yet | Every outgoing `org_trigger_agent_async` call's message |
| `clarification` | This message is a question that needs an answer before the thread can finish | An agent asking its caller (or the human) something mid-thread |
| `success` | The request this thread was about is genuinely done | The final reply once real work/decision completed |
| `failed` | The request could not be completed — say why in the body | The final reply when the target could not deliver (error, refusal, genuine blocker) |
| `in_progress` | Still working, this is a status update, not a final answer | Only if you proactively post an interim update; most threads skip straight to success/failed |

Never invent a different tag. Never send a reply with no tag — an
untagged message is treated as `dispatched` by convention, which will
make an upstream lead think the thread is still open even if you meant it
as final; always tag explicitly instead of relying on that fallback.

## 3. Status tag governs what happens next — this is how loops end

The tag is not decoration — it is the signal that tells whoever reads the
message whether to keep the thread open or close it out:

- **`dispatched` / `in_progress` / `clarification`**: thread is still
  open. The recipient may need to answer (via `org_trigger_respond` if it
  was a clarify/approval, or a normal reply if it was a plain question) or
  wait for more.
- **`success` / `failed`**: thread is CLOSED. Whoever sent the original
  request now has its answer. Relay it upstream (to the human, or to
  whichever lead triggered YOU, tagged the same way) and then **stop** —
  do not trigger the same target again about the same request just
  because a reply arrived. A closed thread only reopens if a human or a
  new, genuinely different request starts it again.

### The loop scenario this prevents

CEO triggers PM (`dispatched`). PM triggers Builder for a sub-question
(`dispatched`). Builder needs clarification and asks PM
(`clarification`) — PM answers via `org_trigger_respond`. Builder finishes
and replies to PM tagged `@builder [status: success]`. PM now has its
answer: PM replies to CEO tagged `@pm [status: success]`. **CEO's job at
this point is to relay that `success` upstream to the human and STOP** —
not to re-trigger PM, not to re-trigger Builder, not to treat the arrival
of a `success` reply as a new event that itself needs forwarding back
down the chain. A `success`/`failed` tag flowing upstream terminates that
thread; it never bounces back downstream again on its own. If the human's
next message is a genuinely new ask, that starts a NEW thread (new
`dispatched` tag), not a continuation of the closed one.

If you ever notice yourself about to `org_trigger_agent_async` the exact
same target with substantially the same message you already got a
`success`/`failed` reply for in this session, stop and ask: is this
actually new information, or am I re-triggering a thread that already
closed? Only proceed on genuinely new input.

## 4. A target you triggered needs your input — you are notified, never poll

If a target you reached via `org_trigger_agent_async` raises a
clarify/approval question mid-turn, you do **not** need to check for it —
it is pushed into your own session automatically, the instant it happens,
as an `[IMPORTANT: ...]` message naming the target agent and the actual
question. This is a real, automatic notification, not something you have
to discover by calling `org_trigger_check_pending` on a schedule — never
poll that tool in a loop "just in case"; it exists for the rare case you
want to double-check status for some other reason, not as your primary way
of finding out a target is stuck.

When that `[IMPORTANT: ...]` message arrives, answer it the same turn you
receive it:

```text
org_trigger_respond({"target_agent_id": "<the named agent>", "kind": "clarify",
             "response": "<your answer>"})
```

Tag your own reasoning about it internally with `[status: clarification]`
if you relay the situation to the human first (e.g. the question needs the
human's real answer, not something you can decide yourself) — then answer
`org_trigger_respond` once you have it. This is the ONE case in this
protocol where you react to an inbound push rather than initiating — every
other message you send still follows the `@mention [status: ...]` tagging
rule above.

## 4b. Escalating a clarification beyond your direct caller — bubble it all the way up

Section 4's `[IMPORTANT: ...]` push only reaches the lead that directly
triggered the target raising the clarification — it does not, on its own,
reach anyone further up the chain. That behavior is unchanged.

The gap: if you are a middle hop — you triggered target X via
`org_trigger_agent_async`, X raised a clarification, and you yourself were
triggered by some other lead upstream — the person watching *your* thread
is not the same as the person who can actually answer X's question. If you
only answer within your own thread, the clarification dead-ends at you: an
agent nobody upstream is watching, holding a question meant for the human
or a lead further up.

When this happens, forward the clarification to your own direct caller —
tagged per section 2's relay convention (`@<agent-id>` names the agent the
clarification originally came from, not you and not your caller) — as the
normal reply to the turn your caller triggered in you. This IS how it
becomes visible to whoever is watching that turn; there is no separate
message to send to the same recipient. Relaying this way is not a new
outbound `org_trigger_agent_async` call — you are already inside a turn
your caller started, so replying in that turn is the relay. Because it
isn't a fresh trigger call, it never hits section 5's "already busy" retry
flow — that flow only applies to initiating new `org_trigger_agent_async`
calls, not to replying within one already in progress.

Forwarding means ACTUALLY replying/relaying through that real mechanism.
Do not just log/print the downstream agent's clarification in your own
chat/session and stop — the forward IS the action, not a description of
the action.

Do this at EVERY hop — one forward per hop, tagged the same way each
time — until the clarification reaches the human-facing lead, who relays
it to the human directly the same way (its reply in the turn that
triggered it). A middle-hop agent that answers only within its own thread
without forwarding leaves the question stuck somewhere nobody upstream is
watching — forwarding to your own caller is required at each hop, every
time.

Worked example, 3 hops — CEO triggers PM, PM triggers Builder, Builder
triggers a sub-agent:

- The sub-agent raises a clarification mid-turn.
- Builder gets the `[IMPORTANT: ...]` push (section 4). Builder is a
  middle hop (triggered by PM), so it forwards the clarification to PM
  (the lead that triggered Builder) as its reply in the turn PM triggered,
  tagged `@sub-agent [status: clarification]` — `@sub-agent` because
  that's who the clarification originally came from.
- PM receives Builder's relay. PM is also a middle hop (triggered by CEO),
  so it forwards the same clarification to CEO as its reply in the turn
  CEO triggered, tagged the same way: `@sub-agent [status: clarification]`.
- CEO is the human-facing lead, so CEO relays the clarification to the
  human directly, the same way — propagation stops here, since there is no
  further lead above CEO to bubble it to.

## 5. Target is busy — retry procedure

`org_trigger_agent_async` (and the synchronous `org_trigger_agent`) reject
immediately with an "already busy" error if the target has a confirmed
in-flight turn. This is not a dead end — follow this exact procedure
instead of giving up on the first error or retrying instantly in a tight
loop:

1. On the first "already busy" error, wait **30 seconds**, then retry the
   same `org_trigger_agent_async` call once.
2. If still busy, wait another 30 seconds and retry again.
3. Up to **3 total attempts** (initial + 2 retries, ~60-90 seconds total).
4. If still busy after the 3rd attempt, stop retrying and tell the human
   plainly: which agent is busy, that you tried 3 times over about a
   minute, and that you'll need either their patience (the target's
   current turn will finish on its own) or their decision to try a
   different agent/approach. Never retry silently forever, and never
   fabricate a reply standing in for the busy target.

Use `org_trigger_task_status(target_agent_id)` between retries if you want
to check whether the target's turn is still genuinely running before
spending another attempt — cheap, doesn't count against the retry budget.

## 6. Worked example — full tagged round trip

```text
// CEO -> PM, org_trigger_agent_async message field
@pm [status: dispatched]
MD asked: what's the status of the growth-onboarding task chain?
Please check the board and reply with current state.
```

```text
// PM -> CEO, once PM's triggered turn finishes (delivered via the
// existing wakeup pipeline, read by CEO in a later turn)
@ceo [status: success]
growth-onboarding: 4 of 6 tasks complete, 1 in review, 1 blocked on
design asset (owner: design dept, flagged 2 days ago). No action needed
from you right now.
```

```text
// CEO relays to the human, same tag convention
@pm [status: success] replied: growth-onboarding is 4 of 6 tasks
complete, 1 in review, 1 blocked on a design asset PM already flagged.
Nothing needs your decision right now.
```

Thread closes here. If the human later asks a new question, that's a new
`dispatched` tag, not a continuation of this one.

## Before you consider a turn finished — checklist

- Did I actually call the tool (`org_trigger_agent_async`,
  `org_trigger_respond`, or a real reply in the triggering turn) — not
  just write about calling it?
- If I received a clarification meant for someone upstream, did I forward
  it via section 4b, not just acknowledge or log it?
- Is every outgoing message and every reply tagged `@<agent-id> [status:
  <tag>]` per section 2 — no untagged messages?
- If the thread is closed (`success`/`failed`), did I relay it upstream
  and stop, instead of re-triggering the same target?
- Would a message I just wrote actually be delivered to another agent, or
  did it only land in my own session?
