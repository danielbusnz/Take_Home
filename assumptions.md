# Assumptions and error handling TODO

Core assumptions the code currently makes, and what each needs before it is production ready.

| # | Assumption | Needs |
|---|------------|-------|
| 1 | Login always succeeds | Detect bad creds, throw `InvalidCredentialsError` → 401 |
| 2 | MFA is always required | Handle trusted-device path (login goes straight to docs) |
| 3 | The MFA code is always correct | Detect bad/expired code, throw `InvalidMfaError` → 401 |
| 4 | The session always exists on `/mfa` | Handle missing/expired sessionId → 404 |
| 5 | The carrier name is valid | Reject unknown carrier → 400 |
| 6 | The portal never blocks or times out | `AntiBotError` → 503, `CarrierTimeoutError` → 504 |
| 7 | One operation per session at a time | Busy-lock so concurrent calls cannot collide |
| 8 | Documents are PDFs | Done. We carry real `contentType` and log non-PDFs. |
| 9 | Empty result == no docs | Ambiguous: scrape failure also returns `[]`. Disambiguate in `fetchDocuments`: confirm we reached the docs page (anchor element), then empty list = truly none (return `[]`), page not reached = throw `DocumentsUnavailableError` (retryable). Only retry the throw, never the empty. |

## How we know login succeeded

No API. We drive the real portal in a browser and read the resulting page:

- error banner → bad creds
- MFA input → MFA needed
- dashboard → logged in, no MFA
- captcha/block page → anti-bot
- nothing in N seconds → timeout

Detection is bespoke per carrier and sealed inside each `Carrier`. The server only
sees `{ mfaRequired }` or a thrown `CarrierError`.

## Error model

Carriers throw typed errors (`errors.ts`). The server catches and maps to a status code.
Happy-path return types stay clean.

## Allstate (validated 2026-06-19)

Validated end to end once: a real account on a Browserbase residential proxy, login
→ MFA → authenticated dashboard. This is a feasibility proof (n=1), not a reliability
guarantee. We can only test against the accounts we have.

Tested, works:
- Login via the **Email** tab: `#emailAddress` + `input[type=password]:visible`, submit `button[name=frmButton]:visible`.
- Credentialed login reached MFA from both a datacenter IP and a residential proxy. Not blocked.
- MFA: delivery-method page, SMS option, code field `#pinCode` (tel), submit → `/secured/home`.

Assumed, not tested (likely to vary per user):
- User logs in by email, not a User ID. User-ID-only accounts need the other tab.
- MFA is always required and SMS is offered. Trusted-device (no MFA) and email-only delivery untested.
- Account has exactly one policy. Multiple/none, and first-login interstitials, untested.
- No captcha appeared. Anti-bot is probabilistic; a flagged proxy IP could trigger one. No captcha handling yet.
- Documents location: under the Policies nav, not yet mapped.

How the real carrier copes: detect state, do not assume. Race the login outcomes
(dashboard / MFA / error / captcha) and read the MFA options offered rather than
hardcoding SMS. Map anything unknown to a typed `CarrierError` so it fails cleanly.

## Session reuse

The kept-alive session assumes the carrier's authenticated session (and Akamai `_abck`)
stays valid for the reuse TTL (8 min). If it expires sooner, the reuse refetch fails and
`/login` falls back to a fresh login, so a stale session degrades to slower, not broken.
The reuse key is a one-way hash that includes the password, so a wrong password cannot
reach another user's cached session.
