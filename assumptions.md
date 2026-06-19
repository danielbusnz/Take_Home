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
