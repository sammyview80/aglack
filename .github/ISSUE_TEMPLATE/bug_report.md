---
name: Bug report
about: Something behaves incorrectly in the gateway, wrapper, seeder kit, or frontend
title: ''
labels: bug
assignees: ''
---

## Which component?

<!-- Pick one. If you are not sure, say which URL/command you were using. -->

- [ ] `rust_gateway` (Rust control plane / workspace orchestration)
- [ ] `backend/wrapper` (FastAPI sidecar over the pinned upstream)
- [ ] `backend/seeder_kit` (seeder tree / MCP tool library)
- [ ] `backend/workspace-image` (Dockerfile + patch scripts)
- [ ] `frontend` (React UI)
- [ ] Not sure / spans several

## What happened

<!-- Observed behavior, and the exact error text if there is one. -->

## What you expected

## Steps to reproduce

1.
2.
3.

## Verification commands you ran

<!-- Paste the command and its relevant output. Which of these did you run,
     and did they pass? This tells us whether the bug is already covered by a
     suite or is invisible to CI. -->

```
(cd rust_gateway && cargo test)
(cd backend/wrapper && python -m pytest)
(cd backend/seeder_kit && python -m pytest)
(cd frontend && npm run build)
```

## Environment

- OS / architecture:
- Rust (`rustc --version`), if the gateway is involved:
- Python (`python --version`), if a Python package is involved:
- Node (`node --version`), if the frontend is involved:
- Did you run `./backend/bootstrap-upstream.sh`, and does
  `git -C backend/upstream rev-parse HEAD` match the SHA in
  `backend/UPSTREAM.md`?

## Anything else

<!-- Logs, screenshots, related plan doc in rust_gateway/docs/*-plan.md.

     Please do not paste secrets: API keys, tokens, cookies, full .env or
     auth.json files, or password hashes. Redact them first. -->
