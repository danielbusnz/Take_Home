# Assumptions

What the carrier code assumes, and how it degrades.

## How we know login succeeded

No API tells us. We drive the real portal and read the resulting page: an error banner
means bad credentials, an MFA input means MFA is needed, the dashboard means we are in,
a captcha or block page means anti-bot, nothing in N seconds means timeout. Detection is
bespoke per carrier and sealed inside each `Carrier`; the server only sees
`{ mfaRequired }` or a typed `CarrierError`.

## Allstate (validated end to end on a real account)

- Login via the Email tab (`#emailAddress` + visible password). User-ID-only accounts
  would need the other tab.
- MFA via SMS (`#pinCode`). Trusted-device (no MFA) is handled; email-only delivery is
  untested.
- One policy per account. Multiple or none, and first-login interstitials, are untested.
- No captcha appeared. Anti-bot is probabilistic; a flagged IP could trigger one, and
  there is no captcha handling.

These are the accounts we could test against. The code detects state rather than
assuming it: it races the login outcomes (dashboard / MFA / error / captcha) and maps
anything unknown to a typed `CarrierError` so it fails cleanly.

## Session reuse

The kept-alive session assumes the authenticated session (and Akamai `_abck`) stays
valid for the reuse TTL (8 min). If it expires sooner, the reuse refetch fails and
`/login` falls back to a fresh login, so a stale session degrades to slower, not broken.
