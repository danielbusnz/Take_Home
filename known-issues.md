# Known issues (deferred)

Open items found in the chaos/QA pass that are not yet fixed. Revisit before final submit.

## #2 No request/operation deadline: a hang wedges a session and leaks a browser

Severity: high (resilience). Reasoned from code, not yet reproduced live.

### What it is
The browser steps only have per-step timeouts (`STEP_TIMEOUT = 30s` on the Playwright
`waitFor`/`waitForURL` calls), and `BrowserbaseSession.open()`'s `chromium.connectOverCDP`
has **no timeout at all**. There is no overall per-request deadline and no Express server
timeout. So a single hang has nothing to stop it.

### When it happens
- `connectOverCDP` hangs (Browserbase infra flap, network partition to the CDP
  websocket). The promise never resolves.
- Step timeouts stack: Allstate `fetchDocuments` worst case is
  `titles.waitFor (30s) + popup+download per doc (30s each) + retrieve-list (~22.5s)`,
  which can reach ~350s before any error surfaces.

### Why it is bad
- `withLock` sets `session.inFlight`, and the reaper skips in-flight sessions on every
  sweep (`sessions.ts`), so a wedged session is **never reaped**.
- No Express request timeout, the HTTP connection hangs indefinitely; a client or
  upstream proxy may give up first.
- The Browserbase browser created at session open keeps billing and leaks until its
  own 1800s hard timeout.
- The only recovery is a process restart, which drops **all** other in-memory
  sessions (single instance, in-memory Map).

### Where
- `src/browserbase.ts`: `open()` -> `connectOverCDP` (no timeout); `waitForDownloads`
  poll loop (15 x 1.5s).
- `src/sessions.ts`: reaper skips `session.inFlight`; `withLock`.
- `src/app.ts` / `src/server.ts`: no request timeout / no `server.requestTimeout`.
- carriers: `STEP_TIMEOUT = 30_000` per step.

### Fix approach
1. Wrap `connectOverCDP` (and ideally each carrier operation) in a `Promise.race`
   against an explicit timeout that rejects with `CarrierTimeoutError`.
2. Add an overall per-operation deadline for `/login` and `/mfa` (e.g. 45-60s). On
   expiry, run `cleanup(sessionId)` (closes the browser, drops the session) and
   return `504`. This bounds tail latency and frees the leaked browser.
3. Wire `CarrierTimeoutError` (defined in `errors.ts`, mapped to 504 in `http.ts`,
   but currently never thrown) into the above. Also clears part of the dead-error
   taxonomy (QA #12).
4. Optional backstop: have the reaper also sweep in-flight sessions older than a hard
   max age, so a wedged op cannot live forever even if the deadline logic is missed.

### Acceptance
A hung `connectOverCDP` returns a `504` within the deadline, the Browserbase session
is closed, and the session is removed from the Map. Worst-case `fetchDocuments` cannot
exceed the deadline.

## #3 Cold-login reliability is bounded by the carrier's anti-bot, and failures are slow

Severity: medium. Observed live.

A single cold login against a live anti-bot portal is not 100% reliable by nature. Under
heavy test velocity (many logins per hour from the same residential pool), Allstate began
slow-walking the login: after submitting credentials the page stayed on
`/anon/account/login` instead of advancing. This is environmental (the carrier's defenses
reacting to volume), not a code bug, and it cools off on its own.

Two real gaps it exposes:
- **No clean fast failure.** With no per-operation deadline (see #2), a slow-walked login
  took ~30-60s to surface as a 500 instead of a fast 504. Fix #2 bounds this.
- **No backoff.** Retrying a blocked login immediately makes the block worse and risks an
  account lockout. A real deployment would back off and surface "try again shortly".

Session reuse mitigates the common case: once one login succeeds, repeat runs skip the
login entirely, so the fragile step runs once per session window rather than every time.
