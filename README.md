# Policy Puller

Pulls a user's insurance policy documents from carrier portals via browser
automation. Pick a carrier, enter credentials, pass MFA, and the app returns the
policy PDFs.

Live: https://take-home-policy-puller.fly.dev/

## Carriers

- **Allstate** (custom login + SMS MFA)
- **Assurant** (Okta login + SMS MFA)

## Stack

TypeScript, Express (long-running, holds the browser across the MFA pause),
Playwright + Browserbase (cloud browser on a residential proxy). Session state is
an in-memory Map, no database. Single static HTML frontend.

## Run locally

```sh
npm install
# .env needs BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID
npm run dev
```

Open http://localhost:3000.

## Test

```sh
npm test          # pure helpers + mock-driven endpoint tests
npx tsc --noEmit  # typecheck
```

Real carriers need live credentials and are verified manually; CI runs the
mock-driven suite.

## Notes

More detail (architecture, decisions, assumptions, latency) to come.
