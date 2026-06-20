# Policy Puller

Pulls a user's insurance policy documents from carrier portals through browser
automation. Pick a carrier, enter portal credentials, pass MFA, and the app
returns the policy PDFs.

Live: https://take-home-policy-puller.fly.dev/

## Carriers

- **Allstate** (custom login + SMS MFA, documents pulled from the portal's JSON API)
- **Assurant** (Okta login + SMS MFA, Confirmation of Coverage PDF)

Both run behind one `Carrier` interface, so adding a third is a single file.

## Flow

1. Open the page, pick a carrier. The backend pre-warms a browser session immediately.
2. Enter the portal username and password, submit.
3. The backend logs in on a cloud browser. If the carrier asks for MFA, the UI shows a code field.
4. Enter the SMS code. The app fetches the policy documents and renders the PDFs.

## Stack

- TypeScript throughout.
- Express, long-running, because the backend holds the live browser across the MFA
  pause. Not serverless.
- Playwright driving a Browserbase cloud browser on a residential proxy.
- In-memory session `Map`, no database.
- One static HTML page served by Express. No build step.
- Deployed on Fly (`iad`), co-located with the Browserbase `us-east-1` session.

## Hosting and anti-bot

The thing that matters is not where the browser runs (compute), it is the IP the
carrier sees (egress). A datacenter IP gets flagged on sight, which is why running
Playwright on a cheap VM fails even though it works on a laptop. So the browser
runs on Browserbase with a residential proxy and a Verified fingerprint (a real
Windows/Chrome profile).

Allstate runs Akamai Bot Manager plus F5. With the residential proxy, the Verified
fingerprint, and real trusted input, Akamai's `_abck` cookie validates to status 0:
the session passes the sensor, it does not merely ride unenforced endpoints. Once
authenticated, documents come from the portal's own JSON API rather than scraping
the rendered page, which is both faster and a smaller surface.

The latency-vs-detection tradeoff is decided per carrier: Allstate gates `/api/secured`
on the validated session cookie, not per-request IP, so the document calls ride that
session; Assurant sits behind Cloudflare, which re-scores every request, so its calls
stay in-page on the residential IP. Full detail and the probe evidence are in
[`latency.md`](latency.md).

## Latency

Two numbers, measured on prod:

- **Graded span** (the brief's metric, MFA submission to document on screen, which on a
  trusted device is the document fetch): **~6 to 8s.**
- **Repeat run** (same credentials within the session-reuse window): **~3s.** The
  authenticated browser is kept alive and the second run skips login entirely.
- Full login-click to documents on screen, including the credential login that cannot
  be pre-warmed, is ~10 to 13s on a first run.

The login-page load is pre-warmed the instant the page loads, so it overlaps the user
typing instead of sitting in the critical path. Breakdown and the optimization work are
in [`latency.md`](latency.md).

## Session reuse

After a successful run the validated browser session is kept alive, keyed by a one-way
hash of the credentials (`sha256(carrier, username, password)`). A repeat login with the
same credentials refetches on that live session, skipping the browser open and the login.
The key is a hash that includes the password, so a wrong password cannot reach another
session and no credential is stored.

## Run locally

```sh
npm install
# .env needs BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID
npm run dev
```

Open http://localhost:3000.

## Test

```sh
npm test          # endpoint + helper tests, driven by a mock carrier (no Browserbase)
npx tsc --noEmit  # typecheck
```

CI (GitHub Actions) runs the typecheck and the mock-driven suite on every push. The real
carriers need live credentials and are verified manually.

## Deploy

```sh
fly deploy        # single long-running machine in iad, Dockerfile build
```

## Known limitations

Tracked honestly in [`known-issues.md`](known-issues.md) and [`assumptions.md`](assumptions.md).
The main one: a single cold login against a live anti-bot portal is not 100% reliable by
nature, and there is no per-operation deadline yet, so a hung login can take up to the
step timeouts to surface.
