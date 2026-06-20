# Latency

Graded metric: "MFA submission to document on screen" = `submitMfa` + `fetchDocuments`
(logged as `GRADED mfa-submit->docs`; for the no-MFA path, `GRADED login->docs`). Target ~8s.
Measure on prod (Fly `iad`, co-located with the Browserbase `us-east-1` session); local runs
slower for CDP-heavy steps but identical for browser->carrier work.

## Where it stands

- **Assurant: ~7.8s graded.** Meets the target. Single download (Confirmation of Coverage),
  Cloudflare edge in Newark (close to us-east-1).
- **Allstate (current `main`, full-API): ~5.3s doc stage** (local run, 3 docs). The UI-navigation
  version (~12s) is preserved on branch `allstate-ui-fallback`. Often skips MFA on a trusted
  device, so its graded span is mostly `fetchDocuments`.

### Allstate full-API doc-stage breakdown (local run, MFA skipped, 3 docs)
| step | time | note |
|---|---|---|
| GetUserData + primer (parallel) | ~0.8s | the two independent GETs, fired together (was ~2.3s sequential) |
| GetPolicySpecificDocsList | ~0.2s | the doc list |
| GetUdpRetrieveDocument (parallel) | ~2.8s | one POST per doc, all overlapped; gated by the slowest single doc (server-side render variance, NOT size: a 9KB doc took 2.8s while a 1.24MB doc took 1.0s) |
| **full `fetchDocuments`** | **~5.3s** | local; prod (Fly `iad`) should be similar or faster for the API round trips |

### Allstate doc-stage breakdown (prod, UI nav, 3 docs)
| step | time | note |
|---|---|---|
| nav-docs | ~6.4s | Policies dropdown -> Documents -> wait for table; `wait-table` alone ~3.3s (server fetch + render). Pure browser->carrier; co-location doesn't help. |
| trigger-downloads | ~4.2s | one popup + PDF download per doc, clicked sequentially; the downloads overlap (~0.4s), the clicks serialize |
| retrieve-list | ~0.3-2s | poll the Browserbase Downloads API |
| fetch-bytes | ~0.7s | pull each PDF's base64 (already parallel) |

## Already done
- **Co-location** (Browserbase `us-east-1` + Fly `iad`). The big CDP-round-trip win.
- **Pre-warm** (`/prepare`): session create + login page load happen before the graded span.
- **Killed CSS animations** (addInitScript) so click "stability" waits don't burn time.
- **Parallelized `fetch-bytes`** (`collectDocuments`, Promise.all).

## Tried and reverted
- Parallelizing the trigger-download clicks (`noWaitAfter` + popup listener): only the first
  click sped up; the rest re-serialize on the page settling after each popup. No net win.

## The big win (now on `main`): full-API document fetch
Fetch documents straight from Allstate's JSON API in-browser via `page.request`, skipping the
UI nav, popups, and Browserbase download storage entirely. **Doc stage ~5.3s.** The UI-navigation
version is kept on branch `allstate-ui-fallback` as a fallback (most human-like footprint, ~12s).

Endpoints (host `myaccountrwd.allstate.com`), all authenticated by the session cookies:
1. `GET /api/secured/GetUserData` -> `policies[0].policyImage.number` (policy number).
2. `GET /api/secured/document/GetDocumentsForPolicies` -> **context primer**. Its own body is
   empty (`policyDocs:null`) but calling it scopes the session to the policy's documents. WITHOUT
   this call, step 3 returns an empty list. This was the whole blocker.
3. `POST /api/secured/document/GetPolicySpecificDocsList` body
   `{policyNumber, contentId:null, yearFilter}` -> `[{title, contentId, docYear}]`.
4. `POST /api/secured/document/GetUdpRetrieveDocument` body `{policyNumber, contentId, yearFilter}`
   -> `documentData.{data (base64 PDF), mimeType, fileName}`. Fire these in parallel.

Two gotchas that cost hours:
- **CSRF:** `x-xsrf-token` must be `decodeURIComponent(XSRF-TOKEN cookie)`. The raw (URL-encoded)
  cookie value 500s ("Unsuccessful service call"); the decoded value matches what Angular sends.
- **POST body** must be a JSON string (`JSON.stringify(...)`), not a Playwright `data` object,
  or the server receives a null body.
- Required headers: `app-name: MYA`, `x-efm: true`, `content-type: application/json`, plus the
  decoded `x-xsrf-token`. The `x-sid/x-vid/x-iid/x-tid` headers are telemetry only (they go to
  analytics hosts, not the API) and are NOT needed.

Important findings from the probe:
- **It is NOT anti-bot.** Akamai's `_abck` cookie stays `~-1~` (unvalidated) the whole time, yet
  the authenticated `/api/secured` calls return 200. The failures were app-level 500s from a bad
  CSRF token, not a bot wall.
- **Caveat to verify:** `page.request` for a CDP (Browserbase) browser likely executes from our
  Node process, not through the residential proxy, so the API calls go out from our server IP
  carrying the session cookies. Allstate accepts this (the endpoints check session + CSRF, not IP).
  Confirm on prod before relying on it.

## Decision (done)
Allstate uses the **full-API** path on `main` (~5.3s). The `GetUserData` + primer parallelization
is applied (~1.5s saved). Alternatives kept for reference:
- **UI-only** (branch `allstate-ui-fallback`): ~12s, most human-like footprint, no source-IP question.
- **hybrid**: keep the human UI nav, then API-fetch only the PDFs; ~7-8s. Not implemented.

Still open: verify the `page.request` **source IP** on prod (Fly datacenter IP, not the residential
proxy). The API calls worked from a residential IP locally; confirm Allstate accepts the datacenter
IP before relying on full-API in production. If it ever gets IP-walled, fall back to `allstate-ui-fallback`.
