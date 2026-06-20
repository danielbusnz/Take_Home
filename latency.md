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
Fetch documents straight from Allstate's JSON API from INSIDE the page (`session.fetchInPage`,
which runs `fetch()` via `page.evaluate`), skipping the UI nav, popups, and Browserbase download
storage entirely. **Doc stage ~5.3s.** The UI-navigation version is kept on branch
`allstate-ui-fallback` as a fallback (most human-like footprint, ~12s).

Why in-page `fetch` and not `page.request`: `page.request` is a Node HTTP client, so it egresses
from our process (a Fly datacenter IP) with a Node/undici TLS fingerprint that does not match the
Chrome UA it sends. An in-page `fetch` rides the browser's residential-proxy IP, real Chrome TLS,
and cookies, so the API call looks like the app's own XHR. See the fingerprint notes below.

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
- Load-bearing headers we send: `app-name: MYA`, `x-efm: true`, `content-type: application/json`,
  plus the decoded `x-xsrf-token`. NOTE: the real app's HTTP interceptor also attaches correlation
  IDs (`x-sid/x-vid/x-iid/x-tid`) to these calls; we omit them because the API still answers without
  them, but that means our request header set is a minimal, distinctive subset of the app's, which is
  itself a fingerprint difference. Replaying the full captured header set would be more faithful.

Anti-bot characterization:
- **Allstate = Akamai Bot Manager (the `/cwnbKR/<obf>` + `/akam/13/pixel_*` sensor) + F5 BIG-IP.**
  The sensor JS collects a device + behavioral fingerprint and POSTs encrypted `sensor_data` (we saw
  4 POSTs, ~1.9-4KB, as it gathered signal). F5 `BIGipServer*` cookies are load-balancer affinity,
  not bot detection; `conacc.allstate.com` (IBM Security Access Manager) is the auth backend.
- **Akamai VALIDATES us under the hardened config (`_abck` status=0).** Measured with a fingerprint
  probe (`scripts/allstate-fp-attack-probe.ts`): with Browserbase **Verified** (a real Windows/Chrome
  fingerprint Akamai's partners recognize) + the MA residential proxy + real trusted Playwright input,
  the sensor POSTs return **201** with `x-akamai-transformed: 0 - 0 -` and `_abck` validates to
  `status=0` on first load and stays validated. So the full-API session rides a *validated* Akamai
  session — we pass the sensor, we don't merely ride unenforced endpoints.
- **History:** before the Verified hardening (a vanilla Linux session), `_abck` stayed `~-1~`
  (unvalidated). The fix was Verified + residential + trusted interaction, not a flag. If a future
  session ever shows `_abck` status `-1` again, treat the full-API path as at risk and fall back to
  the UI path. The earlier 500s were app-level (bad CSRF token), not a bot wall.
- **Source IP: resolved.** Because the doc calls now run in-page (`fetchInPage`), they egress from
  the residential proxy IP, not our datacenter IP. (Verified against our own echo server: an in-page
  `fetch` shows the residential IP in `x-forwarded-for`; `page.request` shows our process IP.) Do
  NOT reintroduce a `page.request` path for the carrier APIs — it puts the datacenter IP + Node TLS
  back on the wire.

## Decision (done)
Allstate uses the **full-API** path on `main` (~5.3s), with the doc calls made in-page
(`fetchInPage`, residential IP + Chrome TLS) and the `GetUserData` + primer parallelization (~1.5s).
Alternatives kept for reference:
- **UI-only** (branch `allstate-ui-fallback`): ~12s, most human-like footprint.
- **hybrid**: human UI nav to the documents page (validates the session + makes request ordering /
  referer / sec-fetch match a real user), then in-page API fetch of the PDFs; ~7-8s. Not implemented.

Known residual bot tells (see the pentest notes; acceptable for a demo, would harden for production):
- Parallel burst: all `GetUdpRetrieveDocument` calls fire at once via `Promise.all` (now with a small
  random `jitter`), still an unhuman cadence vs a real user clicking docs. The hybrid + serialized
  fetches would fix it, at a few seconds' latency cost.
- Minimal/curated header set vs the app's full set (above).
- Fingerprint: we run Browserbase **Verified** (real Windows/Chrome profile) and do NOT JS-override
  navigator values — Verified's coherent fingerprint is what validates `_abck` (see above), so masking
  on top would only reintroduce a tell.
RESOLVED (was the main latent risk): `_abck` now validates (status=0) under the hardened config.
If the full-API path ever gets walled, fall back to the **UI** path (`allstate-ui-fallback`), never
to a `page.request` datacenter-IP client.
