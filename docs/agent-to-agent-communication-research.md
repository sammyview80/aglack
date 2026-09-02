# Agent-to-agent communication & group chat — research notes

How Grok (xAI) and other platforms make agents talk to each other, and
how multi-agent group chats decide who speaks. Researched with crawl4ai
(headless crawl of the sources listed at the end); summaries verified
against the crawled page content.

## 1. Grok / xAI

Official surface (docs.x.ai, "Realtime Multi-agent Research", **beta**):

- Model `grok-4.20-multi-agent`, only via the **Responses API**
  (`POST https://api.x.ai/v1/responses`) or xAI SDK. Chat Completions
  not supported; `max_tokens` not supported.
- Per request, several agents "discuss and collaborate"; a designated
  **leader agent** synthesizes the final answer. The inter-agent
  mechanism is deliberately opaque — sub-agent reasoning/tool state is
  **encrypted**, returned only with `use_encrypted_content=True` so it
  can be replayed for multi-turn continuity (`previous_response_id`).
- Agent count is fixed at **4 or 16**: xAI SDK `agent_count=4|16`;
  OpenAI-SDK/REST mapping `reasoning.effort` `low|medium` → 4,
  `high|xhigh` → 16.
- Tools: server-side only (`web_search`, `x_search`, `code_execution`,
  `collections_search`, remote MCP). No client-side function calling.
  Works with zero tools (pure collective reasoning).
- Billing covers leader + all sub-agents (`usage`,
  `server_side_tool_usage`).
- **No group-chat or agent-conversation API is exposed** — collaboration
  is internal. Grokipedia adds unverified claims (Grok 4 Heavy = parallel
  hypothesis exploration + cross-checking; a "4-agent system" with named
  agents Grok/Harper/Benjamin/Lucas) that official docs do not
  corroborate — treat as secondhand.

Takeaway: xAI's answer to agent-to-agent is *closed collective
inference* (parallel test-time compute + leader aggregation), not an
open messaging protocol.

## 2. Open protocol: A2A (Agent2Agent, Google → Linux Foundation)

The only real cross-vendor *protocol* in this space; complements MCP
(MCP = agent↔tools, A2A = agent↔agent as peers).

- **Transport:** three equivalent bindings — JSON-RPC 2.0 over HTTP
  (+SSE streaming), gRPC (`spec/a2a.proto` is normative), REST
  (`POST /message:send`, `/message:stream`, `GET /tasks/{id}`,
  `/tasks/{id}:cancel`, `/tasks/{id}:subscribe`). Version negotiated via
  `A2A-Version` header.
- **Discovery:** JSON **Agent Card** at
  `https://{domain}/.well-known/agent-card.json` — `name`, `version`,
  `supportedInterfaces`, `capabilities` (`streaming`,
  `pushNotifications`, …), `securitySchemes`, `skills[]` (id, name,
  description, tags, examples, input/output modes), JWS `signatures`.
- **Task lifecycle:** `SUBMITTED → WORKING →`
  `COMPLETED|FAILED|CANCELED|REJECTED`, plus interrupt states
  `INPUT_REQUIRED` and `AUTH_REQUIRED` (in-task auth can chain across
  agent hops).
- **Messages:** `Message{messageId, role USER|AGENT, parts[], contextId,
  taskId, referenceTaskIds}`; `Part` = exactly one of
  text|raw|url|data; task outputs go in `Artifact`s, not messages.
- **Multi-turn:** server-generated opaque `contextId` groups tasks into
  a conversation; resend with same `taskId` to continue (e.g. after
  `input-required`).
- **Updates:** polling, SSE streams (`TaskStatusUpdateEvent` /
  `TaskArtifactUpdateEvent`, identical order across concurrent
  subscribers), or webhooks (at-least-once).
- **Group chat:** none as a primitive — multi-agent systems are composed
  from pairwise client/remote relationships (orchestrator delegates to
  specialists).

## 3. Group chat orchestration in frameworks

How "who speaks next" actually works:

- **AutoGen (0.2) GroupChat** — the classic: all messages broadcast via
  a `GroupChatManager`; `speaker_selection_method` =
  `auto` (LLM picks next speaker) | `manual` | `random` | `round_robin`
  | custom callable `(last_speaker, groupchat) -> Agent|method|None`
  (None terminates). `allowed_speaker_transitions_dict` constrains the
  speaker graph; `max_round` caps; FSM-style "StateFlow" recommended for
  deterministic flows.
- **OpenAI Agents SDK** — two official patterns:
  1. **Handoffs**: exposed to the LLM as tools named
     `transfer_to_<agent_name>`; control moves to the specialist. Config:
     `tool_name_override`, `on_handoff` callback, typed `input_type`,
     `input_filter` (rewrites `HandoffInputData` — the new agent sees
     full history by default; `remove_all_tools` prebuilt filter),
     `prompt_with_handoff_instructions()` convention.
  2. **Agents-as-tools** (`agent.as_tool()`): manager keeps ownership,
     specialist does a bounded task. Official guidance: "start with one
     agent whenever you can"; split only for capability/policy isolation.
- **Microsoft Agent Framework** — star topology: orchestrator
  **broadcasts every response to all members** so each agent's session
  stays in sync; `RoundRobinGroupChatManager` + `MaximumIterationCount`,
  or custom `SelectNextAgent`/`ShouldTerminate` (Python:
  `GroupChatBuilder(selection_func | orchestrator_agent,
  termination_condition)`).
- **Semantic Kernel** — `GroupChatOrchestration(members, manager)`;
  custom `GroupChatManager` overrides, called in order each round:
  `ShouldRequestUserInput` (human-in-the-loop) → `ShouldTerminate` →
  `FilterResults` (final answer) → `SelectNextAgent`.

## 4. Production group-chat design patterns (practitioner sources)

Routing topologies (thread-transfer.com):

- **Broadcaster** — fan same prompt to N workers in parallel, merge in a
  synthesis step; workers never talk to each other; cheapest.
- **Supervisor** — workers speak only when addressed;
  worker-to-worker forbidden (LangGraph default); speaker selection
  O(1) not O(N).
- **Contract Net** — supervisor announces task, workers *bid*
  (cost/capability), one wins; needs a reputation score against bid
  gaming.
- **Free-for-all** — "demos, never production" (20–60 turns, 80K+
  tokens).

Turn-taking ladder (amorlink.ai, consumer AI group chat), cheapest rule
first, first match wins:

1. Exact **@mention** of one member (Unicode word-boundary match).
2. Group address ("you two") → all reply, least-recent speaker first.
3. Short follow-up (<25 chars) → last speaker continues.
4. **LLM director micro-call** (≈30 tokens, temp 0, 5s timeout)
   returning `{"responder": "...", "chimeIn": bool}`; `chimeIn` lets a
   second agent butt in ~1 in 3 messages.
5. Fallback round-robin (least-recent speaker). Every decision logged
   with a `decidedBy` tag.

Reliability rules that recur across sources:

- Replies are generated **sequentially**, each later speaker seeing the
  earlier reply (parallel generation = agents ignoring each other).
- Each agent gets a **private transcript view**: own lines as
  `assistant`, everyone else's as name-prefixed `user`, plus a "never
  write the other agent's dialogue" prompt rule.
- Termination is layered: task-complete check (never trust an agent's
  own "we're done"), hard turn/token caps, and loop detection (hash or
  embedding-similarity of recent outputs → force speaker change or
  halt).
- Prevent duplicate work with **role contracts** (schema-validated
  scope/inputs/outputs/termination) and **claim locks** (TTL'd KV lock
  per subtask).
- The supervisor should read a **structured state object** (pending
  subtasks, claims, artifacts), not the full transcript.

## 5. Relevance to this repo

- The seeder's org skills (`backend/seeder/skills/org-comm-protocol`,
  `org-routing`) are prompt-level versions of §4's mention-routing and
  supervisor patterns; the ladder + `decidedBy` logging and layered
  termination are the proven next steps if aglack builds real
  agent-to-agent chat.
- A2A is the interoperability story if workspaces' agents should talk
  ACROSS containers/tenants: each workspace could publish an Agent Card
  through the gateway and accept `message:send` — the gateway's
  wrapper-namespace proxy pattern fits this as a new namespace.
- Grok's model (opaque parallel agents + leader) is a *model capability*,
  not a protocol — relevant only if aglack adopts xAI's Responses API
  as a backend.

## Sources (crawled with crawl4ai)

- xAI multi-agent docs: https://docs.x.ai/developers/model-capabilities/text/multi-agent
- Grokipedia Grok 4 (secondhand): https://grokipedia.com/page/Grok_4
- A2A spec: https://a2a-protocol.org/latest/specification/
- A2A announcement: https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/
- AutoGen speaker selection: https://microsoft.github.io/autogen/0.2/docs/topics/groupchat/customized_speaker_selection/
- OpenAI handoffs: https://openai.github.io/openai-agents-python/handoffs/
- OpenAI orchestration guide: https://developers.openai.com/api/docs/guides/agents/orchestration
- MS Agent Framework group chat: https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/group-chat
- Semantic Kernel group chat: https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/group-chat
- Group chat routing design: https://thread-transfer.com/blog/2026-06-17-multi-agent-group-chat-routing-design/
- Turn-taking ladder: https://www.amorlink.ai/blog/ai-group-chat-turn-taking
