# CLAUDE.md

Project-specific guidance. Global rules (communication, git, credentials) live in `~/.claude/CLAUDE.md` and are not repeated here. Design rationale lives in `playwright.md`; this file is the operational "what and how."

## Project

Web app that pulls a user's insurance policy documents from carrier portals via browser automation. Take-home for Infer (Forward Deployed Engineer), 48h deadline. Two carriers minimum, working end to end, hosted off the local machine, login to document render under ~8s.

## Commands

To be filled in once scaffolded.

- Server (dev): TBD
- Web (dev): TBD
- Tests: TBD

## Architecture invariants

Do not break these without a deliberate decision:

- Backend is long-running. It holds the live browser session across the MFA pause. Not serverless.
- No database. Session state lives in an in-memory `Map` keyed by sessionId.
- Credentials are never logged or persisted. In memory only, discarded after use.
- Every carrier implements one `Carrier` interface. Scraping is bespoke per carrier; output is normalized to `{ name, bytes }`.
- A browser session is a single resource. Serialize operations against it with a busy lock.
- Real carriers run on Browserbase. Residential proxies are paid and needed to beat anti-bot.
- Latency target: ~8s machine time, login to documents, excluding human MFA entry. Instrument step timings.

## Stack

- TypeScript throughout
- Express backend (long-running)
- Vite + React frontend (kept ugly per spec, functionality over polish)
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

- GEICO renters is underwritten by Homesite, so the policy may live on a separate portal, not geico.com.
- Allstate's login form is in shadow DOM. Playwright locators pierce it; plain `querySelectorAll` will not see the inputs.
- The credentialed login POST gets anti-bot blocked from a datacenter IP. Residential proxies are required.
- dotenv values that start with `#` must be wrapped in quotes or they parse as empty.
