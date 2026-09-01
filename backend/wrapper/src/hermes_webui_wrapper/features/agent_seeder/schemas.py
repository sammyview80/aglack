"""Response model glue for the agent-seeder feature. No request body is
needed for either route — `apply_all`/`apply_one` take no input beyond the
`seeder/` tree on disk and a path parameter."""
from __future__ import annotations
