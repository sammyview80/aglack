---
name: Feature request
about: Propose a new capability or a change in behavior
title: ''
labels: enhancement
assignees: ''
---

## Which component?

- [ ] `rust_gateway` (Rust control plane / workspace orchestration)
- [ ] `backend/wrapper` (FastAPI sidecar over the pinned upstream)
- [ ] `backend/seeder_kit` (seeder tree / MCP tool library)
- [ ] `backend/workspace-image` (Dockerfile + patch scripts)
- [ ] `frontend` (React UI)
- [ ] Spans several / not sure

## The problem

<!-- What can't you do today? Describe the situation, not the solution. -->

## Proposed change

<!-- What should happen instead. -->

## Alternatives considered

## Scope check

- [ ] I read the component's `AGENTS.md` (`rust_gateway/AGENTS.md`,
      `backend/wrapper/AGENTS.md`, or `frontend/AGENTS.md`).
- [ ] For a `rust_gateway` feature: I checked whether a plan doc exists in
      `rust_gateway/docs/*-plan.md`. New features get a short plan doc there
      **before** the code is written.
- [ ] This does not require adding a new runtime dependency, framework, or
      long-lived process — or if it does, I have explained why below, with a
      rollback story.

## How would this be verified?

<!-- Which of the four suites would cover it, and what new test would prove it?
     `rust_gateway` is test-driven: a failing test comes first. -->

## Licensing note

This project is **source-available** under the PolyForm Noncommercial License
1.0.0 — not open source. Contributions are accepted under that same license.
