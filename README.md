# Policy Puller

Pulls a user's insurance policy PDFs from carrier portals by automating a cloud
browser. Pick a carrier, enter credentials, pass MFA, get the documents.

Live: https://take-home-policy-puller.fly.dev/

## Carriers

- **Allstate** (custom login + SMS MFA, documents from the portal's JSON API)
- **Geico** renters (Okta login + SMS MFA, serviced via Assurant's portal)

Both implement one `Carrier` interface, so a third is one file.

## Run

```sh
npm install        # .env needs BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID
npm run dev        # http://localhost:3000
npm test           # mock-driven endpoint tests, no Browserbase
fly deploy         # one long-running machine in iad
```

## How it works

Long-running Express backend, because it holds the browser across the MFA pause
(not serverless). The browser runs on Browserbase with a residential proxy, off your
machine. Session state is an in-memory Map. One static HTML page, no build step.

Flow: `/prepare` opens the browser on page load (pre-warm), `/login` submits
credentials, if MFA the UI shows a code field, `/mfa` submits it, documents render.

## Anti-bot

What matters is egress (the IP the carrier sees), not compute (where the browser runs).
A datacenter IP is flagged on sight, which is why local Playwright works but a VM does
not. So the browser runs on Browserbase with a residential proxy and a Verified
fingerprint.

Allstate runs Akamai plus F5. With the residential proxy, Verified, and real input,
Akamai's `_abck` validates to status 0, so the session passes the sensor instead of
riding unenforced endpoints. Documents then come from the portal's JSON API. The
per-carrier tradeoff and the probe evidence are in [`latency.md`](latency.md).

## Latency

Measured on prod. The brief grades MFA submission to document on screen, which on a
trusted device is the document fetch:

- Graded fetch: **~6 to 8s**
- Repeat run (session reuse): **~3s**
- Full login-click to on screen: ~10 to 13s, including the ~4s login that cannot be pre-warmed

The login page is pre-warmed on page load so it overlaps typing, and the UI shows the
graded span on screen.

## Session reuse

After a successful run the validated browser is kept alive, keyed by
`sha256(carrier, username, password)`. A repeat login with the same credentials
refetches on the live session and skips login. The key is a hash, so a wrong password
cannot reach another session and no credential is stored.

## Limitations

- A single cold login against a live anti-bot portal is not 100% reliable; under heavy
  velocity the carrier slow-walks the login. Reuse means that fragile step runs once per
  session window, not every time.
- No per-operation timeout yet, so a hung login surfaces slowly.
- Login success is read from the page, not an API, and is bespoke per carrier. See
  [`assumptions.md`](assumptions.md).
