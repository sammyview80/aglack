# Hermes WebUI (upstream + wrapper)

This `backend/` directory contains exactly two things:

- `upstream/` — a pinned, read-only nested git clone of the original Hermes
  Web UI (stdlib `http.server`-based). See `UPSTREAM.md` for the pinned
  commit and update procedure. **Never edit anything under `upstream/`.**
- `wrapper/` — a standalone, independently packaged, open-source project:
  a FastAPI application that runs the unmodified upstream request-handling
  code over an ASGI transport instead of raw sockets. See `wrapper/README.md`
  for wrapper-specific docs: architecture, extension rules, install/run
  instructions, and the security boundary.

## Layout

```
backend/
├── upstream/               # pinned upstream clone — READ ONLY, gitignored
├── UPSTREAM.md              # pin + update procedure
├── HERMES_WEBUI_README.md   # this file
└── wrapper/                 # standalone hermes-webui-wrapper project (its own root)
    ├── pyproject.toml
    ├── README.md
    ├── LICENSE
    ├── .env.example
    ├── src/hermes_webui_wrapper/
    └── tests/
```

(The repository-wide `.gitignore` that excludes `backend/upstream/` lives at
the `revamp/` root, not inside `backend/`.)

`wrapper/` is the wrapper project's own root — it is meant to be cloned,
packaged, and published independently of the rest of this repository.
Nothing under `wrapper/` imports anything from `upstream/` except through
the runtime bootstrap in `hermes_webui_wrapper/upstream.py`, which locates
the sibling `upstream/` checkout at run time.

## Extension rule

**New routes go in the wrapper's own `api/v1` package. Never touch
`upstream/`.** If new behavior requires upstream code changes, that must
happen by advancing the pinned upstream commit (see `UPSTREAM.md`), not by
editing the vendored checkout in place.

## Never edit upstream

**Do not edit any file under `backend/upstream/`.** It is a pinned,
disposable, read-only vendored checkout. All wrapper behavior changes
belong in `wrapper/src/hermes_webui_wrapper/`.
