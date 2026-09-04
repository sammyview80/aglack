"""_browser_use_llm — shared helper (NOT a tool): build the `browser_use` LLM
wrapper for the CALLING agent's own configured model provider.

Why the leading underscore
--------------------------
`seeder_kit/discovery.py`'s `discover_tools_in_dirs` skips any file whose
name starts with an underscore::

    for py_file in sorted(tool_dir.glob("*.py")):
        if py_file.name.startswith("_"):
            continue

That is this tree's established "shared helper, not a discoverable MCP
tool" convention. This module defines no `TOOL_NAME`/`handle`; it is
imported by `browser_task.py` (a sibling in this directory) and is never
served as a tool itself. Sibling `_browser_gateway.py` follows the same
convention.

Nothing here imports `hermes_cli` or `browser_use` at module import time —
every such import is inside the function body, so merely loading this file
has zero side effects and needs neither package installed.

Which agent's config: `hermes_cli.profiles`, not upstream `api.profiles`
------------------------------------------------------------------------
A tool module runs inside a separate `seeder_kit.runner` subprocess (see
`backend/seeder/README.md`, "Tool file contract") and may import neither
`hermes_webui_wrapper.*` nor upstream's `api.*` (the latter is only on
`sys.path` after the WRAPPER's own `bootstrap_upstream()`). It CAN import
bare `hermes_cli`, which is what the agent runtime itself runs on. So the
profile name (`arguments["_agent_id"]`, i.e. the runner's `--agent-id`) is
resolved with:

- `hermes_cli.profiles.validate_profile_name(name)` — shape check FIRST
  (`^[a-z0-9][a-z0-9_-]{0,63}$` or the special-cased "default"), before any
  filesystem lookup, mirroring the wrapper's `features/profile_lookup.py`
  two-step validate-then-resolve pattern.
- `hermes_cli.profiles.profile_exists(name)` — fail closed on a name with no
  profile directory; never guess a not-yet-created profile's config.
- `hermes_cli.profiles.get_profile_dir(name)` — the profile's real
  HERMES_HOME. Anchored via `hermes_constants.get_default_hermes_root()`,
  which reads the CURRENT process's `HERMES_HOME` to find the root and
  appends `profiles/<name>` (walking up one level when `HERMES_HOME` itself
  is a profile path). So it is called with this subprocess's inherited
  `HERMES_HOME` unmodified, and only THEN is `HERMES_HOME` pointed at the
  resolved profile home.

Temporary `HERMES_HOME` mutation — why, and why it is always restored
--------------------------------------------------------------------
`hermes_cli.runtime_provider.resolve_runtime_provider()` and
`hermes_cli.config.load_config()` take no "which home" argument; they read
`get_hermes_home()`, which reads `HERMES_HOME` fresh on every call (the
`load_config` cache is keyed on the resulting `config.yaml` path, so two
different homes in one process get two independent cache entries). This
module therefore sets `os.environ["HERMES_HOME"]` to the resolved profile
home ONLY around those two calls and restores the previous value (or
removes the key if there was none) in a `finally`, even when they raise.

Each `seeder_kit.runner` subprocess is launched with a FIXED `--agent-id`
for its whole lifetime (`runner.py`'s own docstring;
`mcp_config.build_mcp_server_entry(..., agent_id=agent.slug)` in
`features/agent_seeder/service.py`), so today this function is always
called with the same `agent_id` inside one process and cross-agent leakage
is impossible by construction. Temporary + finally-restored is still the
required practice, not theoretical caution: a mutated env var must never
leak into unrelated code that runs later in the same process (a second,
different tool call), and a future runner design change (one runner
serving several agents) must not silently inherit a latent bug.

Known, deliberate scope boundary — credentials must already be in the env
------------------------------------------------------------------------
`resolve_runtime_provider()` never calls `hermes_cli.env_loader.
load_hermes_dotenv()`; it reads only `os.environ` and `config.yaml`. So
pointing `HERMES_HOME` at a profile does NOT load that profile's own
`<home>/.env` API keys. If an agent's credential lives only in its own
`.env` and is not already exported into this subprocess's environment,
resolution fails with `hermes_cli.auth.AuthError`, which this module
re-raises as `BrowserUseLLMResolutionError` — it fails closed and says so.
This module must NOT call `load_hermes_dotenv()` to "fix" that: it mutates
`os.environ` with `override=True` and has no scoped undo (its cleanup
helper intentionally leaves provider API keys in place), so it would
irreversibly leak one agent's key into any later call in the same process.

Redaction rule
--------------
No error message anywhere in this module ever interpolates the whole
`resolve_runtime_provider()` return dict (it contains `api_key`). Only the
individual `provider` / `api_mode` / `base_url` fields are ever named, and
any exception text that could conceivably echo the key is scrubbed before
it is re-raised.
"""
from __future__ import annotations

import os
from typing import Any

# The full set of `api_mode` values `resolve_runtime_provider()` can return
# (confirmed against the real `hermes_cli` source) is exactly:
# chat_completions, anthropic_messages, bedrock_converse, codex_responses.
# Only the first two have a verified `browser_use` wrapper mapping; the
# other two — and any unrecognized string — fail closed in `_build_llm`.

_REDACTED = "[redacted]"


class BrowserUseLLMResolutionError(RuntimeError):
    """The ONLY exception `resolve_browser_use_llm` raises. Its message is
    safe to surface verbatim to an MCP client: it never contains an API key
    (see module docstring, "Redaction rule")."""


def _scrub(text: str, secret: str | None) -> str:
    if secret and secret in text:
        return text.replace(secret, _REDACTED)
    return text


def _resolve_model_name(config: Any) -> str:
    """`config.yaml`'s `model.default` (the usual dict form) — tolerates a
    bare string `model:` as well, since that is what a hand-edited config
    can legitimately contain."""
    model = (config or {}).get("model") if isinstance(config, dict) else None
    if isinstance(model, str):
        return model.strip()
    if isinstance(model, dict):
        return str(model.get("default") or "").strip()
    return ""


def _build_llm(*, provider: str, api_mode: str, base_url: str, api_key: str, model: str):
    """The decision table. Imports `browser_use` lazily; only mappings whose
    wire shape has been verified are shipped — everything else fails closed."""
    if api_mode == "anthropic_messages":
        from browser_use import ChatAnthropic

        return ChatAnthropic(model=model, api_key=api_key, base_url=base_url or None)

    if api_mode == "chat_completions":
        if provider == "deepseek":
            from browser_use import ChatDeepSeek

            return ChatDeepSeek(
                model=model,
                api_key=api_key,
                base_url=base_url or "https://api.deepseek.com/v1",
            )
        if provider == "openrouter":
            from browser_use import ChatOpenRouter

            return ChatOpenRouter(
                model=model,
                api_key=api_key,
                base_url=base_url or "https://openrouter.ai/api/v1",
            )
        # Generic OpenAI-compatible fallback — covers `custom` (which is also
        # what a requested `ollama` resolves to), `openai-api`/`openai-codex`
        # on a chat_completions override, and every other chat_completions-
        # transport PROVIDER_REGISTRY entry (fireworks, deepinfra, novita,
        # ollama-cloud, minimax, zai, kimi-coding, ...). `ChatOpenAI` takes a
        # real `base_url` override (the standard OpenAI-Python-SDK-compatible-
        # endpoint pattern every provider `determine_api_mode` assigns
        # `chat_completions` to already speaks), and its `api_key`/`base_url`
        # parameter names match `resolve_runtime_provider()`'s own return
        # keys 1:1, so the mapping is mechanical. `ChatLiteLLM` is deliberately
        # NOT used: it needs `provider/model` routing prefixes that
        # `resolve_runtime_provider()` does not supply and that would have to
        # be reconstructed per provider, for no confirmed benefit.
        from browser_use import ChatOpenAI

        return ChatOpenAI(model=model, api_key=api_key, base_url=base_url or None)

    # `bedrock_converse`, `codex_responses`, and anything outside the
    # confirmed set: never silently default to chat_completions.
    raise BrowserUseLLMResolutionError(
        f"unsupported api_mode {api_mode!r} for provider {provider!r}: no browser-use "
        "LLM wrapper mapping has been verified for this transport yet"
    )


def resolve_browser_use_llm(agent_id: str):
    """Return a constructed `browser_use` LLM wrapper instance for
    `agent_id`'s own configured model/provider/credential, or raise
    `BrowserUseLLMResolutionError`. Never raises anything else."""
    if not isinstance(agent_id, str) or not agent_id.strip():
        raise BrowserUseLLMResolutionError("agent id must be a non-empty string")

    from hermes_cli.profiles import get_profile_dir, profile_exists, validate_profile_name

    try:
        validate_profile_name(agent_id)
    except ValueError as exc:
        raise BrowserUseLLMResolutionError(f"invalid agent id {agent_id!r}: {exc}") from exc

    if not profile_exists(agent_id):
        raise BrowserUseLLMResolutionError(
            f"unknown agent id {agent_id!r}: no Hermes profile directory exists for it"
        )
    resolved_home = get_profile_dir(agent_id)

    from hermes_cli.auth import AuthError
    from hermes_cli.config import load_config
    from hermes_cli.runtime_provider import resolve_runtime_provider

    prior = os.environ.get("HERMES_HOME")
    os.environ["HERMES_HOME"] = str(resolved_home)
    try:
        try:
            runtime = resolve_runtime_provider()
        except (ValueError, AuthError) as exc:
            raise BrowserUseLLMResolutionError(
                f"could not resolve a usable model provider for agent {agent_id!r}: {exc}"
            ) from exc
        model = _resolve_model_name(load_config())
    finally:
        if prior is not None:
            os.environ["HERMES_HOME"] = prior
        else:
            os.environ.pop("HERMES_HOME", None)

    # Only ever pull individual fields — never repr/str the whole dict.
    provider = str(runtime.get("provider") or "")
    api_mode = str(runtime.get("api_mode") or "")
    base_url = str(runtime.get("base_url") or "")
    api_key = str(runtime.get("api_key") or "")

    if not model:
        raise BrowserUseLLMResolutionError(
            f"agent {agent_id!r} has no model configured (config.yaml model.default is empty)"
        )

    try:
        return _build_llm(
            provider=provider, api_mode=api_mode, base_url=base_url, api_key=api_key, model=model
        )
    except BrowserUseLLMResolutionError:
        raise
    except Exception as exc:  # constructor failure, missing optional dep, ...
        # `from None`: the original exception's own args may echo the key
        # (e.g. a validation error repr-ing its input), and a chained cause
        # would carry that into any traceback rendering of this error.
        raise BrowserUseLLMResolutionError(
            f"could not construct browser-use LLM for provider {provider!r} "
            f"(api_mode {api_mode!r}): {_scrub(str(exc), api_key)}"
        ) from None
