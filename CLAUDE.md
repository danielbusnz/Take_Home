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
- Backend: `/login`, `/mfa`, `/carriers`, `/prepare`. In-memory session Map, state machine,
  typed errors -> HTTP codes, 400 input guards, busy-lock (one op per session), reaper for
  idle sessions (env `SESSION_TTL_MS` / `SWEEP_MS`). Split into `server`/`sessions`/`http`/`carriers/registry`.
- `AllstateCarrier` working end to end on the LIVE portal via Browserbase (residential proxy):
  email-tab login, MFA (SMS + `#pinCode`) or trusted-device no-MFA, and real PDF download.
  Returns base64 PDFs behind the `Carrier` interface. Verified: 3 real PDFs.
- Pre-warm: `prepare()` (open + load form, no creds) + `/prepare`; `/login` reuses a warm
  session by `warmId`. Frontend fires `/prepare` on carrier select.
- Frontend: full login -> MFA -> render; PDFs shown inline via blob URLs + download links;
  client-side submit->on-screen timing.
- Latency: per-step `[timing]` logs + optimizations (region us-east-1, killed CSS animations,
  parallel-ish downloads, tab-click moved into pre-warm). No-MFA total ~27s (local dev).
- Tests: `documents`, `http` (requireStrings), `sessions` (withLock). Exports 1-4 in `~/Infer_notes`.

Graded latency = "MFA submission -> document on screen" (= `submitMfa` + `fetchDocuments`, ~12-15s),
NOT full login. Biggest remaining: `nav-docs` (~5.8s), downloads (~4.8s).

Next:
- SECOND carrier (spec needs 2; Allstate alone = auto-reject).
- Cut nav-docs/downloads latency (internal `GetUdpRetrieveDocument` JSON API is the big lever,
  CSRF risk, deferred); parallelize `fetch-bytes`.
- Deploy off the machine in us-east-1 (same region as the Browserbase session); not serverless.
- Verify the MFA path live (Allstate keeps skipping MFA). Wire `contextId` into `openSession`
  to make Context reuse actually live (currently plumbed but unused). Defensive hardening
  (Identity Restoration modal, multi-policy). README + Loom.

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
  (isTrusted:false -> Akamai flag) and aggressive parallelism. The internal `GetUdpRetrieveDocument`
  JSON API backs the doc download (big latency lever, but likely CSRF-guarded; deferred).
