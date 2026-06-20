# CLAUDE.md

Project-specific guidance. Global rules (communication, git, credentials) live in `~/.claude/CLAUDE.md` and are not repeated here. Design rationale lives in `playwright.md`; this file is the operational "what and how."

## Project

Web app that pulls a user's insurance policy documents from carrier portals via browser automation. Take-home for Infer (Forward Deployed Engineer), 48h deadline. Two carriers minimum, working end to end, hosted off the local machine, login to document render under ~8s.

## Commands

- Dev (watch): `npm run dev`
- Start: `npm start`
- Tests: `npm test` (Node test runner over `tests/**`)
- Typecheck: `npx tsc --noEmit`

Server runs on http://localhost:3000 and serves the frontend at `/`. `start`/`dev` load
`.env` via `--env-file-if-exists`. Needs `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`,
and for live Allstate `ALLSTATE_USER` / `ALLSTATE_PASSWORD` / `ALLSTATE_LOGIN_URL`.
Endpoints: `GET /carriers`, `POST /prepare`, `POST /login`, `POST /mfa`.

## Progress (2026-06-19)

Done:
- **Two carriers end to end** (spec gate met): `AllstateCarrier` (email login, SMS MFA or
  trusted-device, real PDFs) and `AssurantCarrier` (Okta login + SMS MFA, Confirmation of
  Coverage PDF). Both via Browserbase residential proxy, behind the `Carrier` interface.
- Backend: `/login`, `/mfa`, `/carriers`, `/prepare`. In-memory session Map, state machine,
  typed errors -> HTTP, 400 guards, busy-lock (on /login, /prepare, /mfa), reaper. Split into
  `server`/`app`/`sessions`/`http`/`carriers/registry` + shared `browserbase.ts`.
- `BrowserbaseSession` helper (open, waitForDownloads, fetchBytes, collectDocuments, step,
  requireSession); both real carriers compose it. Removed dead `contextId`/`contexts` plumbing.
- **Deployed live: https://take-home-policy-puller.fly.dev** (Fly, single machine, `iad`/us-east-1,
  Dockerfile). Off-machine, not serverless, no DB.
- **CI** (GitHub Actions): `tsc --noEmit` + mock-driven endpoint tests, green on push/PR.
- Pre-warm (`/prepare` + `warmId`); frontend full login->MFA->render (blob-URL PDFs), now with
  network-error handling, button reset, blob-URL cleanup.
- **Hardened from a chaos/QA break-it pass:** JSON error responses (no HTML stack-trace leaks),
  MFA retry keeps the session, empty doc result -> 502, in-use/mismatched `warmId` handled,
  `fetchAndFinish` closes the browser on throw, `r.ok` checks on Browserbase fetches, `requireSession` guards.
- Tests: `documents`, `http`, `sessions` (+ fetchAndFinish), `server` (endpoint integration via mock). 32 green.
- **Latency: see `latency.md`.** Assurant ~7.8s (meets ~8s target). Allstate UI ~12s; a working
  **full-API path on branch `allstate-api-experiment` is ~6-7s and reliable** (direct JSON endpoints).
- Exports 1-5 in `~/Infer_notes` (this session = export-6). Deferred items in `known-issues.md`.

Graded latency = "MFA submission -> document on screen" (`submitMfa` + `fetchDocuments`). Measure on
prod (co-located). Allstate often skips MFA, so its graded span is mostly `fetchDocuments`.

Next:
- **Decide Allstate doc-fetch for `main`:** full-API (~6-7s, branch) vs hybrid vs current UI (~12s).
  See `latency.md`; verify `page.request` source-IP on prod first.
- **Redeploy `main` to prod** (prod is several commits behind `main`).
- Deferred resilience: no request/operation timeout (`known-issues.md` #2).
- README full version + Loom (remaining deliverables).
- Smaller chaos/QA items: rate-limit `/prepare`, wire/throw `AntiBotError`/`CarrierTimeoutError`,
  reaper-vs-MFA-pause TTL, multi-policy.

## Architecture invariants

Do not break these without a deliberate decision:

- Backend is long-running. It holds the live browser session across the MFA pause. Not serverless.
- No database. Session state lives in an in-memory `Map` keyed by sessionId.
- Credentials are never logged or persisted. In memory only, discarded after use.
- Every carrier implements one `Carrier` interface. Scraping is bespoke per carrier; output is normalized to `{ name, contentType, bytes }`.
- A browser session is a single resource. Serialize operations against it with a busy lock.
- Real carriers run on Browserbase. Residential proxies are paid and needed to beat anti-bot.
- Latency target: ~8s machine time, login to documents, excluding human MFA entry. Instrument step timings.

## Stack

- TypeScript throughout
- Express backend (long-running)
- Single static HTML page (`public/index.html`) served by Express, vanilla JS, no build step. Kept ugly per spec.
- Playwright + Browserbase for browser automation

## Agents to consult when building

Use these specialized agents for the work they fit. Prefer them over writing blind.

- typescript-pro: default for writing app code. The whole stack is TypeScript.
- backend-developer: long-running Express server, in-memory session Map, MFA-pause state machine, busy-lock. The core of the project.
- frontend-developer: the ugly Vite + React UI (carrier dropdown, creds form, MFA prompt, doc viewer).
- performance-engineer: the ~8s latency budget. Instrument step timings, tune the login to docs path.
- security-auditor: credential-handling pass. Enforce that creds are never logged or persisted. Run before submit.
- deployment-engineer: hosting off the machine. Deploy the long-running backend (not serverless) plus the frontend.
- code-reviewer: review pass before the final submit and Loom.

## Dev workflow

- Build and test against the mock carrier. It implements the same `Carrier` interface and simulates login, MFA, and document return.
- Real carrier implementations need provisioned credentials, swap them in behind the same interface.

## Gotchas

- Allstate login selectors: email tab `#UserIDdisplay`, `#emailAddress`, `input[type=password]:visible`,
  submit `button[name=frmButton]:visible`. It's an SPA: wait for elements, not load events.
- A direct `goto` to the docs URL (`/secured/documents/policy-documents`) redirects to the dashboard.
  Navigate via the Policies dropdown -> the `Documents for ... policy` button instead.
- Docs download as a blob via a popup. `download.saveAs()` / `page.evaluate` do NOT get the bytes
  on Browserbase (remote file). Use CDP `Browser.setDownloadBehavior({downloadPath:"downloads"})`,
  then the Browserbase Downloads API (`GET /v1/downloads?sessionId`, then `GET /v1/downloads/{id}`).
- Per-action latency is dominated by CDP round-trip distance. Set the session `region` near the
  compute (us-east-1) and deploy the app in the SAME region. Roughly 2x on form actions.
- Render PDFs with blob URLs, not `data:` (data: in an iframe is blocked in Chrome 112+).
- Allstate MFA is intermittent (often goes straight to dashboard). Don't assume MFA; the carrier
  races dashboard-vs-verification. Hard to force MFA, so the live MFA path is under-verified.
- `.env` values starting with `#` must be quoted or `--env-file` reads them empty (the Allstate
  password starts with `#`).
- Anti-bot is priority #1: keep the residential proxy on; avoid `evaluate`-based fills
  (isTrusted:false -> Akamai flag) and aggressive parallelism.
- Allstate's internal document JSON API works in-browser and is the big latency lever (~12s -> ~6-7s).
  Cracked on branch `allstate-api-experiment`; full details + gotchas (CSRF must be
  `decodeURIComponent(XSRF-TOKEN)`, the `GetDocumentsForPolicies` context primer, JSON-string body)
  in `latency.md`. It is NOT anti-bot-gated (Akamai `_abck=-1` but `/api/secured` returns 200).
