# Product Marketing Context

*Last updated: 2026-09-04*

## Product Overview

**One-liner:** aglack is a self-hostable control plane for running isolated AI-agent workspaces.

**What it does:** aglack creates one Docker-backed workspace per tenant, with a Hermes WebUI agent environment, Python wrapper, browser desktop, integrations, and chat. A Rust gateway manages workspace lifecycle, authentication, routing, health checks, and per-workspace access; a React frontend provides the user interface.

**Product category:** Self-hosted AI-agent platform / multi-tenant agent workspace infrastructure.

**Product type:** Open-source-oriented developer infrastructure (currently source-available under PolyForm Noncommercial 1.0.0).

**Business model:** Not defined yet.

## Target Audience

**Target companies:** Developers, startups, internal platform teams, and organizations that need controlled AI-agent environments.

**Decision-makers:** Engineering leads, platform engineers, security-conscious founders, and developer-tool teams.

**Primary use case:** Provision a separate, browser-accessible AI-agent workspace for each user or tenant without sharing agent state or files.

**Jobs to be done:**

- Launch and manage isolated agent environments.
- Give agents chat, browser, desktop, integrations, and seeded skills in one workspace.
- Keep tenant state, credentials, and containers separated behind one gateway.

**Use cases:** Personal agent workspaces, internal AI tooling, multi-user agent products, and local or private deployments.

## Problems & Pain Points

**Core problem:** Building a reliable, isolated, browser-accessible agent environment requires stitching together container orchestration, authentication, proxying, agent configuration, browser automation, and frontend state management.

**Why alternatives fall short:** A collection of scripts or a single shared agent process makes lifecycle management, tenant isolation, recovery, and user access harder to operate consistently.

**What it costs them:** Engineering time, operational complexity, accidental cross-tenant exposure, and fragile agent setup.

**Emotional tension:** Teams want the flexibility of AI agents without giving up control over data, infrastructure, or user boundaries.

## Competitive Landscape

**Direct:** Self-built agent platforms — require substantial work to combine isolation, lifecycle management, browser access, and agent configuration.

**Secondary:** Hosted AI-agent workspaces — simpler to start, but may provide less control over deployment, data location, runtime behavior, or customization.

**Indirect:** Running one agent locally or sharing one server process — low setup cost, but weak isolation and limited multi-user lifecycle control.

## Differentiation

**Key differentiators:**

- One workspace, one container, one agent model.
- Rust gateway with SQLite-backed workspace registry and Docker orchestration.
- Browser-visible desktop and per-agent browser automation.
- Extensible wrapper, integrations, skills, and agent seeding pipeline.
- Self-hostable architecture with explicit control over runtime and data.

**How we do it differently:** The gateway treats the agent workspace as the primary unit of isolation and routes every workspace operation through a tenant-aware control plane.

**Why that’s better:** It gives teams a consistent place to enforce identity, ownership, lifecycle, health, and proxy boundaries.

**Why customers choose us:** They need more control and isolation than a shared agent service provides, without building the entire platform from scratch.

## Objections

| Objection | Response |
|-----------|----------|
| “Is it production-ready?” | It is under active development; production use requires reviewing deployment, secrets, backups, monitoring, and the current security guidance. |
| “Does it support my provider or integration?” | Provider and integration support is configuration-driven and can be extended through the gateway and wrapper layers. |
| “Is it truly open source?” | The project is being prepared for an open-source license; the current repository license is PolyForm Noncommercial 1.0.0. |

**Anti-persona:** Teams wanting a fully managed SaaS with zero infrastructure ownership or teams that do not need isolated agent environments.

## Customer Language

**Words to use:** isolated workspace, self-hosted, agent environment, tenant isolation, browser-accessible, Docker-backed, control plane.

**Words to avoid:** guaranteed secure, zero-risk, fully managed, production-ready, autonomous without qualification.

**Glossary:**

| Term | Meaning |
|------|---------|
| Workspace | An isolated agent environment and its lifecycle-managed container. |
| Gateway | The Rust control plane that authenticates, routes, and manages workspaces. |
| Wrapper | The FastAPI sidecar exposing onboarding, configuration, seeding, and related APIs. |
| Seeder | The pipeline that applies agent profiles, skills, souls, and tools. |

## Brand Voice

**Tone:** Clear, practical, technical, and security-conscious.

**Style:** Direct and implementation-aware; explain tradeoffs without hype.

**Personality:** Trustworthy, capable, transparent, builder-focused.

## Proof Points

**Metrics:** Not yet defined.

**Customers:** Not yet defined.

**Testimonials:** Not yet defined.

**Value themes:**

| Theme | Proof |
|-------|-------|
| Isolation | Each workspace is represented by its own Docker container and owner relationship. |
| Control | The stack is self-hostable and exposes gateway, wrapper, frontend, and image layers. |
| Extensibility | Agent seeding, integrations, browser automation, and proxy namespaces are separate modules. |

## Goals

**Business goal:** Make private, isolated AI-agent workspaces easy to deploy and extend.

**Conversion action:** Clone the repository, run the development stack, and create a workspace.

**Current metrics:** Not yet defined.
