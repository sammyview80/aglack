# PM — Agent Instructions

Technical/tooling instructions for the PM agent's workspace.

This file becomes `AGENTS.md` inside PM's configured WORKSPACE directory,
not its profile home — this checkout's Hermes Agent scans `AGENTS.md` from
its current working directory, not from a per-profile identity file (see
`wrapper/src/hermes_webui_wrapper/features/agent_config/service.py`'s
module docstring for why). PM's workspace must be configured
(`workspace` or `default_workspace` in its `config.yaml`) before the
seeder can write this file — the seeder does not invent a workspace path.

Replace this content to change PM's working instructions.
