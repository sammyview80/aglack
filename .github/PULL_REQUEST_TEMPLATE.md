# Summary

<!-- What changed and why, in a sentence or two. -->

## Component(s) touched

- [ ] `rust_gateway`
- [ ] `backend/wrapper`
- [ ] `backend/seeder_kit`
- [ ] `backend/workspace-image`
- [ ] `frontend`
- [ ] Docs / CI / tooling only

## Verification

Tick the suites you actually ran, and paste the result. Leave a box unticked
rather than guessing — "not run" is useful information; a wrong tick is not.

- [ ] `(cd rust_gateway && cargo test)`
- [ ] `(cd backend/wrapper && python -m pytest)` — requires
      `./backend/bootstrap-upstream.sh` first on a fresh clone
- [ ] `(cd backend/seeder_kit && python -m pytest)`
- [ ] `(cd frontend && npm run build)`

Also, if relevant:

- [ ] `(cd frontend && npm test)` / `npm run lint`
- [ ] `(cd backend/workspace-image && python -m pytest)`
- [ ] `(cd rust_gateway && cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings)`

<details>
<summary>Output</summary>

```
paste the relevant output here
```

</details>

### Not verified

<!-- Anything you could not check, and why. Be explicit — this is the most
     useful section of the template. -->

## Tests

- [ ] A test fails before this change and passes after it.
- [ ] Behavior change with no new test — explained below.

<!-- `rust_gateway` is test-driven: failing test first. Unit tests fake the
     Docker boundary (`FakeLauncher`), so anything touching the container boot
     script, env vars, directory ownership, or mounts ALSO needs a real
     `docker build` + `POST /workspaces` + `docker exec` check. A fully green
     unit suite has already missed a real container-permissions bug once. -->

## Conventions

- [ ] I read the component's `AGENTS.md` before editing it.
- [ ] For a `rust_gateway` feature: the matching `rust_gateway/docs/*-plan.md`
      exists and I read it (new feature → add the plan doc in this PR).
- [ ] No hardcoded host/port/URL — gateway config goes through `config.rs`
      env vars; frontend reads `VITE_*` only in `src/lib/env.ts`.
- [ ] One logical change; unrelated refactors split out.
- [ ] Docs updated if setup, runtime behavior, architecture, or testing
      guidance changed.
- [ ] I did **not** hand-edit a CHANGELOG/CHECKPOINT file (the release process
      owns those — put release-note wording in this description instead).
- [ ] No secrets, credentials, tokens, or personal data in the diff.

## For UI changes

<!-- Before/after images at desktop and narrow widths. -->

---

By opening this PR you agree your contribution is licensed under the
[PolyForm Noncommercial License 1.0.0](../LICENSE). This project is
source-available, not open source.
