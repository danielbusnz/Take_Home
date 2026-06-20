# Playwright / Approach Notes

Take-home: web app that pulls a user's policy documents from carrier portals.
Two carriers minimum, working end to end, hosted off my machine, login → docs under 8s.

## The three hard parts

1. **Anti-bot + hosting** — run a browser somewhere that isn't my laptop without getting blocked.
2. **The MFA pause** — backend stops mid-login, asks the UI for a code, resumes the same session.
3. **Per-carrier scripting** — each portal's login + docs flow is different.

Everything else is a basic web form.

## Anti-bot (decided)

Two separate things I kept fusing:
- **Compute** = where the browser runs. Doesn't matter much.
- **Egress** = the IP the carrier actually sees. This is the whole game.

A datacenter IP (AWS, DigitalOcean, GitHub Actions) gets flagged. The fix is residential
egress, which is independent of where the code runs.

Detection layers, in general: IP reputation, TLS/JA3, browser fingerprint, behavioral,
rate limiting, account/device reputation, captcha.

Why it's tractable here: this is **one real user, real credentials, low volume**, not
scraping at scale. That kills rate-limiting, velocity, and credential-stuffing signals.
What's left to fight is IP + fingerprint (layers 1–3), which is exactly what a managed
cloud browser covers.

**Decision: buy the anti-bot layer via a managed cloud browser (Browserbase).**
- Write normal Playwright, connect over websocket instead of launching local Chrome.
- Gives me: hosted off my machine, stealth fingerprint, residential egress, session
  persistence (the MFA-pause hook), live view + recording (good for the Loom).
- Alternatives in same category: Steel.dev, Hyperbrowser, Bright Data Scraping Browser.

Tradeoff to write up: bought the anti-bot layer. Pro: reliable, off my machine, ships in
the time box. Con: vendor dependency + cost, didn't hand-tune fingerprints myself.

Residual risks (both handled by carrier choice):
- Carrier that hard-gates every login on captcha → pick a different carrier.
- "New device" step-up on login → that's just more MFA, already in the flow.

## Stack (decided)

- **All TypeScript, one repo.** Express (long-running) serving one static HTML page.
  Not Next.js/serverless: the backend must hold a live browser across the MFA pause.
- No Python (throwaway spikes only). No Go (no concurrency need).
- Reason: stealth ecosystem and cloud-browser SDKs are JS-first; one language = less to wire.

## MFA flow (the shape)

```
user submits creds
  → backend opens cloud browser session, logs in
  → carrier shows MFA
  → backend returns {status: "mfa_needed", sessionId}, LEAVES session alive
frontend shows MFA input
user submits code
  → backend reconnects to same sessionId, types code, navigates to docs, pulls PDFs
  → returns docs
```

Session store: in-memory `Map` keyed by sessionId. Good enough for a take-home, no Redis.

## Per-carrier state machine

`navigate → submit creds → wait for MFA → submit MFA → fetch docs`

Write carrier one fully, then carrier two, THEN extract what's shared. Don't abstract at n=1.

## Status: shipped

- [x] Browserbase: login + MFA + dashboard end to end (Allstate, residential proxy)
- [x] Backend: /login, /mfa, /carriers, /prepare, session Map, typed errors
- [x] AllstateCarrier: real login / MFA / full-API fetchDocuments behind the Carrier interface
- [x] Second carrier (Assurant)
- [x] Frontend: dropdown, pre-warm on load, login / MFA / doc render, graded-span display
- [x] Session reuse: kept-alive validated session keyed by a credential hash (not BB Contexts)
- [x] Latency instrumentation: per-step timings + graded span; ~6-8s graded, ~3s on reuse
- [x] Deployed off the machine: Fly (iad), long-running, not serverless
- [x] README done (Loom + Claude session links are the final deliverables)
