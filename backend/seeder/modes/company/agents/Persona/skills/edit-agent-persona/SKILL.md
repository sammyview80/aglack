---
name: edit-agent-persona
description: "Safely review and update the identity of an existing Hermes agent: its SOUL.md personality, AGENTS.md operating rules, and profile description. Use when a user asks to change, refine, or inspect an agent's persona, tone, identity, profile, or operating instructions."
---

# Edit Agent Persona

Edit an existing Hermes agent's identity collaboratively. Preserve what the agent already is unless the user explicitly asks to replace it. Apply changes surgically, avoid duplicate rules, and keep personality separate from operations.

## Hermes identity map

| Requested change | Hermes target | Write tool |
| --- | --- | --- |
| Tone, personality, values, boundaries | `SOUL.md` | `org_set_agent_soul` |
| Job, tools, procedures, safety constraints | `AGENTS.md` | `org_set_agent_instructions` |
| Concise statement of the agent's role | Profile description | `org_set_agent_profile` |

Do not create or edit OpenClaw-specific files such as `IDENTITY.md`, `USER.md`, `TOOLS.md`, `MEMORY.md`, or `HEARTBEAT.md`. Translate their relevant intent into one of the three Hermes targets only when the user explicitly requests it.

## 1. Identify one target agent

Require exactly one target agent ID before inspecting or changing anything.

- If the user gives an ID, call `org_get_graph` and confirm that ID exists.
- If the user gives a name, inspect `org_get_graph`'s `nodes`. Ask the user to disambiguate if more than one agent matches.
- If neither is provided, ask which agent this is about. Do not guess.

## 2. Review the current identity

Read the target node data returned by `org_get_graph`; use its agent-detail capability if one is available and needed. Retrieve the current SOUL.md, AGENTS.md, and profile description.

If the agent already has a SOUL.md or AGENTS.md, summarize the relevant current content before proposing edits. Treat this as an identity edit, not a default replacement.

## 3. Gather and draft the requested changes

Keep the conversation natural and ask only for missing details that matter:

- **SOUL.md:** personality, tone, values, boundaries, and relationship with users or other agents.
- **Profile description:** one or two sentences describing what the agent is and does.
- **AGENTS.md:** job-specific tools, constraints, and operating rules.

Do not invent requirements the user did not request. Before drafting, check for duplication or conflict with the existing content. Prefer revising an existing rule over adding a near-duplicate.

Keep each concern in its primary location: personality belongs in SOUL.md; actionable procedures and tool constraints belong in AGENTS.md; the short role statement belongs in the profile. For larger or multi-file changes, explain the proposed allocation and tradeoffs, then draft complete content for every requested file and obtain explicit confirmation before writing.

## 4. Check for server-enforced roles before writing an AGENTS.md change

If the target agent's role is `ceo`, `cfo`, `pm`, **or `head`** (a
department head), its real tool access is locked server-side
(`CEO_ALLOWED_TOOLS`/`CFO_ALLOWED_TOOLS`/`PM_ALLOWED_TOOLS`/
`HEAD_ALLOWED_TOOLS` in `mcp_server.py`), not just documentation
convention. For a `head`, this also includes automatic board scoping (a
head's kanban calls are always scoped to its own department's board,
regardless of what AGENTS.md says) and trigger-target scoping (a head can
only `org_trigger_agent`/`_async` its own department's agents). Before
writing an AGENTS.md change that claims a new tool, a different board, or
a different trigger scope for one of these four roles specifically:

- Tell the user this role's real tool access/scoping is enforced
  server-side, so editing AGENTS.md text alone will not grant the new
  capability or change the scoping.
- Tell the user that actually changing it requires a code change to that
  role's allowed-tools set (or scoping helper) in `mcp_server.py` — a
  separate engineering task Persona cannot perform.
- If the user still confirms the doc edit after understanding this,
  proceed anyway — disclose the limitation, don't block the edit.

This check does not apply to Builder, Persona, Librarian, or a plain
worker/sub-agent — those roles aren't in a server-side allowlist, so an
AGENTS.md edit for them takes effect exactly as written.

## 5. Apply only confirmed changes

Use `force: true` on every identity write — not as a style preference, but
because it's the only way an edit actually happens: each write tool is a
no-op that returns `{"skipped": true, "reason": "..."}` if the target file
already exists and `force` isn't `true` (this is deliberate — it protects a
brand-new agent's first-ever identity write from being silently
overwritten by an unrelated caller). Since Persona's whole job is editing
agents that already have an identity, omitting `force` here would make the
edit silently do nothing. Confirm the response has `"ok": true` (or
inspect its `path`), not just the absence of an `error` field, before
telling the user the write happened. Omit calls for files the user did not
ask to change.

Call `org_set_agent_soul`:

```json
{"agent_id":"<id>","content":"<full SOUL.md markdown>","force":true}
```

Call `org_set_agent_profile`:

```json
{"agent_id":"<id>","description":"<one or two sentences>","force":true}
```

Call `org_set_agent_instructions`:

```json
{"agent_id":"<id>","content":"<full AGENTS.md markdown>","force":true}
```

## 6. Handle failures and report outcomes

If a tool response includes an `error` field, explain the actual reason (for example, the agent was not found or lacks a Hermes profile). If it instead includes `"skipped": true`, that's not an error but also not a completed write — tell the user the file already existed and nothing changed (this shouldn't happen if `force: true` was set correctly; treat it as a signal to double-check the call). Do not retry blindly.

After successful writes, state exactly which agent changed, which identity files changed, and a short summary of the new content.

## Tuning newly created agents (Builder handoff)

When Builder (or PM) sends a message like "Tune newly created agents"
listing agent ids with role/purpose lines, this is the automated
post-creation handoff — a batch job, not a human conversation.

**Read what's already there first — it's real, not a blank seed.** Unlike
before, a freshly created agent's identity files are NOT generic
placeholders:

- A freshly created department **head** already has a real, tailored
  `SOUL.md`/`AGENTS.md` (seeded from `api/head_defaults/` via
  `_seed_head_profile`) documenting its actual server-enforced tool
  access, board scoping, dispatch workflow, and escalation rules — see
  section 4 above.
- A freshly created **worker/sub-agent** already has a "your department
  head is `<head-id>`" section stamped into its `AGENTS.md` (via
  `_stamp_head_reference`) naming its real resolved head and the
  escalate-to-your-head-first rule — do not remove or contradict this
  section; it's load-bearing for the org's dispatch model, not
  boilerplate to replace.

So for this handoff, REVIEW the existing seeded content first (via
`org_get_graph` and, if available, an agent-detail read)
before drafting — you are refining a real baseline, not filling a blank
file. Preserve the head-reference section and (for heads) the tool-access/
board-scoping documentation verbatim; add or adjust tone, personality, and
role-specific detail around it.

1. Call `org_get_graph` once and confirm every listed id
   exists. Report any id that doesn't; continue with the rest.
2. For EACH agent, using the provided role/purpose (do not ask follow-up
   questions — the requester is another agent, not the user):
   - Write a tailored `SOUL.md` via `org_set_agent_soul`:
     personality, tone, values, and boundaries that fit the stated role.
   - Write a tailored `AGENTS.md` via `org_set_agent_instructions`:
     the job, its concrete responsibilities, what it must never do, how it
     reports back (to its department head or PM), and — unless the role is
     explicitly forbidden from reaching other agents — the standard
     "Reaching other agents" section below, verbatim except for filling in
     the bracketed placeholders. Every newly created agent gets this
     section by default; a role with a genuine reason to be cut off from
     other agents is the exception, not the norm, and that exception should
     be a deliberate call, not an omission. The same applies to the
     standard "Handing back files and folders" section below: every newly
     created agent gets it by default, included verbatim, skipped only
     with a genuine documented reason. And for any agent whose role might
     start a local dev/preview server, also include the standard "Sharing
     a running preview server" section below by default, on the same
     included-by-default, skip-only-with-a-genuine-reason basis. For a
     worker/sub-agent, preserve its existing head-reference section (see
     above) unchanged inside the new AGENTS.md content you write.
   - Set the profile description via `org_set_agent_profile`:
     one or two sentences stating what the agent is and does.
   The confirmation-before-writing rule in section 3 applies to HUMAN edit
   requests on existing identities; for this handoff, write directly
   without asking the requester (another agent) for confirmation — but
   still base the new content on the real seeded baseline you read in
   step 1, not a blank slate. Use `force:true` since the target already
   has real seeded content, not an empty file.
3. Reply with one line per agent: id, which of the three files were
   written (or skipped and why). This reply is the tuning confirmation the
   requester is waiting on — make it explicit.

### The standard "Reaching other agents" section (include by default)

Every new agent's `AGENTS.md` should include this section — copy it
verbatim, filling in `<agent's own mcp prefix>` (always
``, same for every agent/profile) and, if the new agent
reports to a specific department head or PM by convention, name that
default reporting target in place of "the appropriate agent." This is the
SAME async-first pattern already standard in every existing singleton
agent's own `AGENTS.md` (CEO/CFO/PM/Builder/Persona/Librarian) — a new
agent should never default to an older/blocking pattern that doesn't exist
in this system anymore.

```markdown
## Reaching other agents

`org_trigger_agent_async(target_agent_id, message,
caller_session_id)` sends a message into another agent's own persistent
session and returns IMMEDIATELY — it does NOT wait for that agent's turn to
finish. Requires your own current `caller_session_id`. Use
`org_get_graph` first to find the right
`target_agent_id`. **Immediately after calling this, say so** — tell
whoever you're reporting to that the message was sent and is running in
the background, and that you'll relay the reply once it arrives. Never go
silent just because there's no reply inline.

The eventual reply is delivered into YOUR OWN session automatically once
the target's turn finishes, in a LATER turn — not returned by this call.
If the target gets stuck on a clarify/approval question first, use
`org_trigger_check_pending()` (no arguments — lists
every agent YOU triggered, directly or through a chain YOU started, that
is currently waiting on you) and
`org_trigger_respond(target_agent_id, kind, ...)` to
discover and answer it — you do not need that agent's own session id for
either call.

Never trigger yourself; never call it in a tight loop.
```

If the new agent's role genuinely has no legitimate reason to reach other
agents (rare — most roles at least need to report completion or escalate
something), it is fine to omit this section, but treat that as a deliberate
exception you can justify, not a default.

### The standard "Handing back files and folders" section (include by default)

Every new agent's `AGENTS.md` should include this section by default —
copy it verbatim. Like "Reaching other agents" above, this is included by
default; skip it only with a genuine documented reason (for example, a
role that never produces or touches files).

```markdown
## Handing back files and folders

Never report a raw filesystem path in your reply as if the user or
another agent could click or open it — a path like
`/workspace/pm/lumina_design.excalidraw` is meaningless outside your own
container. Use the tokens below instead; the chat UI turns them into
real, working links.

**A single file:** include `MEDIA:<path>` literally in your reply text.
For example: "I've exported the report:
MEDIA:/workspace/reports/q3_summary.pdf" or "Screenshot attached:
MEDIA:/workspace/screenshots/dashboard.png".

Prefer the real absolute path on disk. Only use a relative path if you
are certain of the exact resolution root it will be resolved against —
when in doubt, use the absolute path.

**A whole folder:** include `MEDIA_FOLDER:<absolute-path>` literally in
your reply text. For example: "All the generated assets are here:
MEDIA_FOLDER:/workspace/pm/exports".

This becomes a clickable link that opens the workspace file browser
already navigated to that folder, where it can be browsed or downloaded
as a zip via the browser's own download button. Do not manually zip or
tar the folder yourself and then hand back a `MEDIA:` link to the
archive unless explicitly asked to — that's a redundant copy that wastes
disk and can go stale.

**Closing rule:** never claim a deliverable is "ready to access" or
"available for download" without including a working `MEDIA:` token (for
a single file) or a working `MEDIA_FOLDER:` token (for a folder) in the
SAME reply — promising a link in a later message is not acceptable. If
the file or folder doesn't exist yet, say so plainly instead of
promising a link that isn't there yet.
```

### The standard "Sharing a running preview server" section (include by default for agents that may start a dev/preview server)

Every new agent whose role might start a local dev or preview server
(building or serving a frontend, running a static site, anything bound
to a port) should get this section in its `AGENTS.md` by default — copy
it verbatim. Skip it only with a genuine documented reason, such as a
role that never runs a server of its own.

```markdown
## Sharing a running preview server

If you start a local dev or preview server inside your own container —
a build tool's preview command, a static file server, anything bound to
a port — the host machine cannot reach that port directly; only your
container's own WebUI port is ever exposed outside it. Never report a
`localhost:<port>` or `127.0.0.1:<port>` URL as if the user could open
it — it will not work.

Instead, include `MEDIA_PREVIEW:<port>` literally in your reply text —
for example `MEDIA_PREVIEW:4173`. The chat UI turns this into a real
clickable link that opens the preview (proxied through
`/api/preview/<port>/`) in a new tab. You don't know your own
workspace/install id from inside your own tool-execution context, so you
cannot and should not try to construct a full URL yourself — the token
is all you need to emit.

The proxy only accepts ports in the range 1024-65535, and rejects two
ports reserved for the WebUI's own internal listener and API server
(8642 and 8643 by default — an operator may have reconfigured these, so
treat them as defaults, not guaranteed values). Most dev-server tools
already default well within the valid range (Vite, Create React App,
and most Node tooling default somewhere in 3000-9000), so this is rarely
something you need to act on — but if you can choose the port, prefer
one in the valid range.

This proxies plain HTTP requests and responses only — a dev server's
live-reload/HMR WebSocket will not work through it, so a proxied
preview page's browser console may show a broken HMR connection even
though the actual page content and assets load correctly. That's
expected; it doesn't mean the preview is broken.

The rendered preview link only ever shows the bare port number, not a
description — so always describe what the preview actually is (for
example, "the flagship animated demo" or "the API docs preview") in the
SAME reply as the `MEDIA_PREVIEW:` token, just as a deliverable must
never be claimed ready without a working token in the same reply.
```
