"""Agent-history feature service — read-only per-agent chat history.

In this project an "agent" IS a Hermes profile (the agent-seeder creates
one profile per agent — see `../agent_seeder/service.py`). This feature
exposes three read paths over upstream's own `api.profiles`/`api.models`
data, projected down to only what the frontend renders, instead of
proxying the full upstream session/message shape (40+ fields per session)
through the catch-all.

`list_agents` enumerates profiles from the filesystem (the `profiles/`
subdirectory under the base Hermes home) rather than trusting
`list_profiles_api()` as the source of truth — same reasoning
`features/agent_config/service.py::_require_known_profile` already
documents: when `hermes_cli` is not importable, `list_profiles_api()`
silently falls back to returning only a synthetic default-profile row
(`except ImportError: return [_default_profile_dict()]` in
`api/profiles.py`), hiding every real named profile. The filesystem is the
real invariant.

Pure reads only: no route here calls `set_request_profile`,
`switch_profile`, or otherwise mutates process/thread-global state.
Sessions are attributed to an agent using upstream's own
`api.profiles._profiles_match(row_profile, active_profile)` helper — the
same helper upstream itself uses to reconcile the literal `"default"` tag,
a renamed root profile, and legacy untagged rows (backfilled to
`"default"` by `all_sessions()` itself) — rather than a naive string
compare, which would silently miss/leak rows for a renamed root profile.

As with every other feature in this wrapper, no upstream symbol is
imported at module import time — every function below imports
`api.profiles`/`api.models` lazily, after `bootstrap_upstream()` has
already run for this process (see `upstream.py`, rule 1 in AGENTS.md).
"""
from __future__ import annotations

from typing import Any

from hermes_webui_wrapper.features.errors import FeatureError

DEFAULT_LIMIT = 50
MAX_LIMIT = 200


class AgentHistoryError(FeatureError):
    """This feature's `FeatureError` — see `features/errors.py`. Mapping
    convention (mirrors `features/agent_config/service.py`'s own note):
    bad pagination params -> 400 (this endpoint's own equivalent of
    upstream `routes.py`'s ValueError -> 400 convention), unknown profile
    or unknown/foreign session -> 404."""


def _require_known_profile(name: str) -> None:
    """Fail closed (404) on a profile name that doesn't exist.

    The name is validated against upstream's own `_PROFILE_ID_RE` BEFORE any
    home-directory lookup. `get_hermes_home_for_profile()` deliberately falls
    back to the BASE Hermes home for any name that isn't a valid profile id
    (see its docstring — this is how it rejects path-traversal-shaped input),
    so calling `home.is_dir()` on an invalid name would resolve to the root
    profile's home, which always exists, and incorrectly accept the name.
    Same filesystem-existence check `features/agent_config/service.py`
    already uses for a *valid* name, so a not-yet-created agent behaves
    identically across both features. Delegates the actual lookup to
    `features.profile_lookup.known_profile_home` (shared with
    `agent_config`), which does this same name-shape-then-existence
    check."""
    from hermes_webui_wrapper.features.profile_lookup import known_profile_home

    if known_profile_home(name) is None:
        raise AgentHistoryError(
            "agent_history_profile_not_found", f"Profile '{name}' does not exist.", 404
        )


# If a second feature needs pagination, move `_parse_int_param` and
# `_validate_pagination` here (or to a shared module) instead of
# reimplementing them — they have no agent-history-specific logic.
def _parse_int_param(value: str | int | None, default: int, label: str) -> int:
    """Parse a raw query-string value into an int, raising this feature's
    400 error instead of letting FastAPI's own query-param typing produce a
    raw (non-enveloped) 422 — see api/v1/agent_history.py, which accepts
    `limit`/`offset` as raw strings for exactly this reason."""
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        raise AgentHistoryError(
            f"agent_history_invalid_{label}", f"{label} must be an integer.", 400
        ) from None


def _validate_pagination(
    limit: str | int | None, offset: str | int | None
) -> tuple[int, int]:
    limit_val = _parse_int_param(limit, DEFAULT_LIMIT, "limit")
    offset_val = _parse_int_param(offset, 0, "offset")
    if limit_val < 0:
        raise AgentHistoryError(
            "agent_history_invalid_limit", "limit must not be negative.", 400
        )
    if offset_val < 0:
        raise AgentHistoryError(
            "agent_history_invalid_offset", "offset must not be negative.", 400
        )
    return min(limit_val, MAX_LIMIT), offset_val


def list_agents() -> dict[str, Any]:
    from api.profiles import get_hermes_home_for_profile

    base_home = get_hermes_home_for_profile("default")
    profiles_dir = base_home / "profiles"

    names = {"default"}
    if profiles_dir.is_dir():
        for entry in profiles_dir.iterdir():
            if entry.is_dir() and not entry.name.startswith("."):
                names.add(entry.name)

    ordered = ["default"] + sorted(names - {"default"})
    working = _profiles_with_a_streaming_session(ordered)
    agents = [{"name": name, "is_working": name in working} for name in ordered]
    return {"agents": agents}


def _profiles_with_a_streaming_session(names: list[str]) -> set[str]:
    """Which of `names` currently own at least one actively-streaming
    session — reuses the one place upstream computes `is_streaming`
    (`all_sessions()` -> `_is_streaming_session()` against the live
    `STREAMS`/`ACTIVE_RUNS` state in `api/models.py`) instead of a second,
    possibly-drifting definition of "busy", and the same
    `_profiles_match()` `list_sessions()` below already uses for
    profile/session attribution. One `all_sessions()` scan covers every
    profile — `list_agents()` is on the sidebar-refresh path, and profile
    count and session count are both unbounded here, so this must not be
    one upstream call per profile.
    """
    from api.models import all_sessions
    from api.profiles import _profiles_match

    working: set[str] = set()
    remaining = set(names)
    if not remaining:
        return working
    for row in all_sessions():
        if not row.get("is_streaming"):
            continue
        row_profile = row.get("profile")
        for name in list(remaining):
            if _profiles_match(row_profile, name):
                working.add(name)
                remaining.discard(name)
        if not remaining:
            break
    return working


_SESSION_PROJECTION_KEYS = (
    "session_id",
    "title",
    "message_count",
    "updated_at",
    "last_message_at",
)


def list_sessions(
    name: str, limit: str | int | None = None, offset: str | int | None = None
) -> dict[str, Any]:
    _require_known_profile(name)
    limit, offset = _validate_pagination(limit, offset)

    from api.models import all_sessions
    from api.profiles import _profiles_match

    # Do NOT pass include_lineage_metadata=False here — benchmarked slower
    # at every size tested (100/300/800/2400 sessions: 0.60x-0.79x speedup,
    # i.e. -0.7ms to -21.2ms per call). False takes an uncapped state.db
    # read over all rows; default True caps lineage enrichment at top-300.
    all_rows = all_sessions()
    rows = [row for row in all_rows if _profiles_match(row.get("profile"), name)]
    rows.sort(
        key=lambda row: row.get("last_message_at") or row.get("updated_at") or 0,
        reverse=True,
    )
    page = rows[offset : offset + limit]
    sessions = [{key: row.get(key) for key in _SESSION_PROJECTION_KEYS} for row in page]
    return {"sessions": sessions, "limit": limit, "offset": offset}


def _project_content(content: Any) -> str:
    """Upstream message `content` may already be a plain string or a list
    of typed parts (e.g. `{"type": "text", "text": "..."}`, possibly mixed
    with tool-call/thinking parts). Join only the text parts so the
    frontend always gets a plain string; never raise on an unexpected
    shape."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                text = part.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)
    return ""


_ATTACHMENT_PROJECTION_KEYS = ("name", "path", "mime", "size", "is_image")


def _project_attachments(raw_attachments: Any) -> list[dict[str, Any]] | None:
    """Project a message's `attachments` list (written by upstream's own
    `_checkpoint_user_message_for_eager_session_save` -> `user_msg["attachments"]
    = list(attachments)`, `backend/upstream/api/routes.py:22499`, using the
    normalized shape `_normalize_chat_attachments` builds at
    `backend/upstream/api/routes.py:24368` — exactly `{name,path,mime,size?,
    is_image?}` per item) down to only the keys the frontend needs to render
    a chip/thumbnail.

    Returns `None` (not `[]`) when the source message has no attachments at
    all, so the frontend can distinguish "no attachments" from "empty list"
    the same way `list_messages` already treats `total`/pagination absence
    as meaningful — an empty list is a valid (if unusual) value upstream
    could theoretically write, whereas `None` means the key was never
    present on the raw message. A non-list value (defensive: never trust
    upstream's raw dict shape blindly) also projects to `None` rather than
    raising, matching `_project_content`'s own "never raise on unexpected
    shape" rule."""
    if not isinstance(raw_attachments, list):
        return None
    projected = []
    for item in raw_attachments:
        if not isinstance(item, dict):
            continue
        entry = {key: item[key] for key in _ATTACHMENT_PROJECTION_KEYS if key in item}
        if entry:
            projected.append(entry)
    return projected or None


def list_messages(
    name: str,
    session_id: str,
    limit: str | int | None = None,
    offset: str | int | None = None,
) -> dict[str, Any]:
    _require_known_profile(name)
    offset_unset = offset is None
    limit, offset = _validate_pagination(limit, offset)

    from api.models import Session
    from api.profiles import _profiles_match

    session = Session.load(session_id)
    if session is None or not _profiles_match(getattr(session, "profile", None), name):
        raise AgentHistoryError(
            "agent_history_session_not_found",
            f"Session '{session_id}' does not exist for agent '{name}'.",
            404,
        )

    all_messages = session.messages or []
    if offset_unset:
        # No caller ever passes offset today (grepped frontend/src) — default
        # to the newest page (the live tail) instead of offset=0's oldest
        # page. An explicit offset (even "0") keeps the from-the-start
        # contract for a future "load older messages" page.
        offset = max(0, len(all_messages) - limit)
    page = all_messages[offset : offset + limit]
    messages = []
    for message in page:
        if not isinstance(message, dict):
            continue
        projected = {
            "role": message.get("role"),
            "content": _project_content(message.get("content")),
            "timestamp": message.get("timestamp"),
        }
        attachments = _project_attachments(message.get("attachments"))
        if attachments is not None:
            projected["attachments"] = attachments
        messages.append(projected)
    return {
        "messages": messages,
        "limit": limit,
        "offset": offset,
        "total": len(all_messages),
    }
