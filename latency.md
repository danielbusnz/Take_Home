# Latency and anti-bot

Graded metric: MFA submission to document on screen. On a trusted device (no MFA) that
is the document fetch. Target ~8s. Measured on prod (Fly `iad`, co-located with
Browserbase `us-east-1`).

## Numbers (prod, Allstate)

- Graded fetch: **~6 to 8s**
- Repeat run (session reuse): **~3s**
- Full login-click to on screen: ~10 to 13s, including the ~4s credential login that
  cannot be pre-warmed

The document fetch is dominated by the primer (`GetDocumentsForPolicies`, ~4 to 7s of
server-side scoping). The document list is ~0.2s; the per-document fetches run in
parallel, gated by the slowest (~2 to 5s of server-render variance).

## What made it fast

- **Pre-warm on page load.** `/prepare` opens the browser when the page loads, so the
  ~10s login-page open overlaps the user typing. Cold (no pre-warm) measured ~23s.
- **Full-API document fetch.** Once authenticated, documents come from Allstate's JSON
  API, skipping UI navigation and downloads (~12s to ~6s).
- **Session reuse.** A repeat login refetches on the kept-alive validated session, ~3s.
- **Co-location** (Browserbase `us-east-1` + Fly `iad`) cuts the CDP round-trip cost.

## Anti-bot

Allstate = Akamai Bot Manager (the `/cwnbKR/` + `/akam/` sensor) + F5. The login runs
Browserbase Verified (a real Windows/Chrome fingerprint) on a residential proxy with
real trusted input, which validates Akamai's `_abck` to status 0. Confirmed with a
fingerprint probe: the session passes the sensor, it does not merely ride unenforced
endpoints.

The latency-vs-detection tradeoff, decided per carrier:

- **Allstate** fetches documents with `page.request` (a datacenter-IP Node client).
  Akamai gates `/api/secured` on the validated session cookie, not per-request IP, so
  this rides a legitimate session and is fast. The byte-fetch egresses our datacenter
  IP on a validated session, a documented residual.
- **Geico** (serviced via Assurant's portal) stays in-page (`fetch` inside the browser) because Cloudflare re-scores
  every request, so it keeps the residential IP and real Chrome TLS.

Residual tells, acceptable for a demo, would harden for production: a minimal request
header set vs the app's full set, and a parallel document-fetch burst faster than a
human clicking. If the full-API path is ever walled, the fallback is the UI-navigation
path (slower, most human-like).
