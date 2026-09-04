---
name: org-integrations
description: check whether a third-party provider (GitHub, Gmail, Slack, Notion, etc) is connected via OpenConnector before doing that work any other way; load before any task that touches an external provider's data or API.
---

# Connected providers — check first, fall back if not connected

This workspace may have third-party providers connected through
OpenConnector (a self-hosted broker, reached via this session's MCP
tools — `list_connections`, `find_action`, `execute_action`; these three
are the ONLY integration tools actually available to you here — there is
no separately-callable `search_actions` or `get_action_guide` tool in
this environment, even though those names appear in some general
documentation about how the underlying broker works). A connected
provider is already authenticated for this workspace, so using it is
faster and safer than any other method.

## The rule

Before doing ANY task that involves a provider OpenConnector can reach
(GitHub, Gmail, Slack, Notion, and others — the exact list changes over
time, never hardcode it):

1. Call `list_connections` first to check if that provider is connected
   for this workspace.
2. If connected, ALWAYS call `find_action(service, query)` first to get a
   verified action id and its real input schema — NEVER call
   `execute_action` with a guessed id. `find_action` returns everything
   `execute_action` needs in one round trip: the real id (exactly as the
   broker returns it — never reconstruct or guess this string yourself),
   name, description, and input schema for the best-matching action(s)
   for your query. If the first `find_action` call doesn't return what
   you need, call it again with a different/narrower query — do not fall
   back to guessing.

   This is not optional guidance — treat it the same as "search before
   execute" is treated everywhere this pattern exists (e.g. Composio's
   own CLI states this as its one documented flow, no shortcuts). NEVER
   call `execute_action` with an `action_id` you have not just gotten
   back from `find_action` in THIS turn — not from memory, not from a
   pattern that worked on a different provider, not a guess at the id
   format (there is no `search_repositories`, `github.search.repositories`,
   `searchRepos`, or `repos.search` — every real id is verified
   `<service>.<action_name>`, e.g. `github.search_repositories`, always
   with the service prefix). If `execute_action` ever returns
   `unknown_action`, that means `find_action` was skipped or an id was
   misremembered — call `find_action` again, do not guess a second id.
3. If NOT connected: fall back to your normal process for that task
   (raw `curl`/API call with a token you already have some other way,
   a CLI tool, whatever you'd otherwise do). Don't block on OpenConnector
   for a provider it doesn't have connected — that's expected, not an
   error.

## Why check first rather than assume

The set of connected providers differs per workspace and changes over
time (a user can connect/disconnect anytime), and the catalog of
actions a connected provider supports also changes — so this skill
deliberately contains no fixed list of providers or actions. Checking
live via `list_connections` is the only way to know what's actually
available right now.
