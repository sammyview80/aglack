---
name: org-browser-use
description: how to use a real web browser from this agent — call open_browser/browser_task/close_browser, never browser_exec or any other browser tool; load before ANY task that needs to view, navigate, click, fill, or extract from a live web page.
---

# Browser access — use your own dedicated browser, not browser_exec

This workspace gives you a REAL, per-agent, persistent Chromium browser
through three tools: `open_browser`, `browser_task`, `close_browser`. These
are the ONLY browser tools to use. Do not use `browser_exec` or any other
browser-automation tool that may also appear in your tool list — those are
unrelated, unsupported in this environment, and known broken here (their
own diagnostic reports `chrome-not-running`/`daemon didn't come up` even
when your real browser is fine).

## The three tools

- **`open_browser`** — takes no arguments. Starts your OWN dedicated
  Chromium instance (or confirms one is already running) and returns a
  `cdp_url`. Your browser identity (cookies, logins, saved sessions) is
  tied to YOU specifically and persists across calls — a second
  `open_browser` call reuses the same saved session, never a fresh one.
  You do not need to call this before `browser_task` — it starts the
  browser for you automatically if it isn't already running. Call it
  directly only if you specifically need the raw `cdp_url` for something
  else, or want to confirm the browser is up before a longer task.
- **`browser_task`** — takes one argument, `task` (plain language, e.g.
  `"Open github.com/anthropics/claude-code and report the star count"`).
  This is the tool for ANY real browsing work — it runs your task inside
  your own browser, using your own configured model to decide what to
  click/read/fill, and returns the final result as text. Prefer this over
  trying to drive the browser step-by-step yourself; describe the outcome
  you want, not individual clicks.
- **`close_browser`** — takes no arguments. Stops your browser PROCESS
  only — your saved session/cookies/logins are NOT deleted, they persist
  for your next `open_browser`/`browser_task` call, even across a
  restart. Call this when you're done with browser work for now to free
  resources; it is optional, not required before ending a turn.

## The rule

Any task that needs you to view, navigate, click, fill a form, log in, or
extract information from a live web page: call `browser_task` with a
clear description of the outcome you want. Do not reach for
`browser_exec`, a raw HTTP fetch, or any other method as your first
choice for something that genuinely requires a real, rendered browser
(JavaScript-heavy pages, login-gated content, anything you'd need to
click through). A plain HTTP fetch/read-only tool is still the right,
faster choice for a task that's really just "read this URL's raw
content" and doesn't need real browser interaction — use judgment, don't
reach for `browser_task` for something a simple fetch already solves.

## Why not `browser_exec`

`browser_exec` (and any tool built on `browser-harness`) is a SEPARATE,
unrelated mechanism in this environment — it tries to launch and manage
its own independent browser process/daemon, distinct from the one
`open_browser`/`browser_task` manage for you. It is currently broken in
this environment (confirmed: its own `--doctor` diagnostic reports
`daemon alive: FAIL` even when a real Chromium instance is genuinely
running and reachable). Do not attempt to work around this by adjusting
`browser_exec`'s own flags/config — use `browser_task` instead, which
does not depend on `browser-harness`'s daemon at all.
