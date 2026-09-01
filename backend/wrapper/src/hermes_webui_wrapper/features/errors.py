"""The one error shape every native feature's service layer raises.

Each feature defines its own subclass (`OnboardingError`, `AgentConfigError`,
`AgentSeederError`, ...) so callers and tests can still catch that feature's
failures specifically — but the shape (`code`/`message`/`status_code`) and
the route-layer handling (`api.envelope.service_call` catches this base and
maps it to the shared error envelope) live in exactly one place instead of
being re-declared per feature.

`status_code` conventions mirror upstream `api/routes.py`'s own mapping for
the equivalent endpoints (ValueError -> 400, KeyError -> 404,
RuntimeError -> 500) — see each feature's service module for the specific
mapping it applies.
"""
from __future__ import annotations


class FeatureError(Exception):
    def __init__(self, code: str, message: str, status_code: int):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
