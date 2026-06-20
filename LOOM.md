# Loom script (2-3 min)

Target ~3:00. Two columns: **SAY** (read aloud, your voice) / **DO** (screen).
Keep both carrier windows pre-warmed before you hit record so the graded span is the only wait.

## Pre-flight (before recording)
- [ ] Redeploy `main` to Fly. Prod is behind `main`; without it the live Allstate run is the slow ~12s UI path, not the ~5s full-API path.
- [ ] Open the live URL twice (two tabs): one Allstate, one Assurant.
- [ ] Have both phones/inboxes ready for the MFA codes.
- [ ] Hit `/prepare` for both (or just have the page loaded) so the session + login page are warm.
- [ ] Terminal open showing the `[timing] GRADED ...` log line, or the Browserbase live view, so the latency number is visible on screen.
- [ ] Editor open to `src/app.ts` and `src/carriers/allstate.ts`.

---

## 0:00 - 0:15  Intro
**SAY:** "This is Policy Puller. Pick a carrier, enter portal credentials, pass MFA, and it pulls your real policy PDFs. Two carriers, Allstate and Assurant, both working end to end. It's hosted on Fly, not my laptop. Let me run it live first, then show how it's built."
**DO:** Show the live Fly URL in the browser. Cursor on the carrier dropdown.

## 0:15 - 1:00  Live run, Allstate
**SAY:** "Allstate. Real account. I enter the email and password, hit get documents. The backend opens a cloud browser, logs in, and because this is a trusted device it often skips straight to documents. Here are the real PDFs rendered in the page." (If it prompts MFA: "It's asking for the SMS code, I type it, submit.")
**DO:** Fill creds, submit, let docs render. Point at the timing log: "MFA-submit to document on screen, the graded number, is about five seconds here. Under the eight second target."

## 1:00 - 1:35  Live run, Assurant
**SAY:** "Second carrier, Assurant, completely different portal: Okta login plus SMS MFA. Same flow, same interface on my side. Login, the UI surfaces the MFA field, I type the code, and the Confirmation of Coverage PDF renders. That one lands around seven and a half seconds graded."
**DO:** Switch tab, run Assurant end to end, show the PDF and the timing.

## 1:35 - 2:20  Anti-bot (the part they care about most)
**SAY:** "The thing I spent the most time on is anti-bot, and the key insight is separating two things people fuse: compute, where the browser runs, versus egress, the IP the carrier actually sees. Egress is the whole game. A datacenter IP gets flagged instantly. So I run the browser on Browserbase with a residential proxy and their Verified fingerprint, a real Windows Chrome profile. Allstate runs Akamai Bot Manager plus F5. I probed it: with Verified plus the residential proxy plus real trusted input, the Akamai `_abck` cookie validates to status zero. We pass the sensor, we're not just riding unenforced endpoints. That's in `latency.md` with the probe script."
**DO:** Show `latency.md` anti-bot section, scroll the `_abck status=0` line and the probe script name.

## 2:20 - 2:45  The latency vs anti-bot tradeoff
**SAY:** "Once logged in, I skip the UI and call the carrier's own document JSON API. That's the big latency win, twelve seconds down to five. The tradeoff is per carrier: Allstate's Akamai gates on the validated session cookie, not per request IP, so the fast path is still legitimate. Assurant runs Cloudflare which re-scores every request, so there I keep the fetch inside the page on the residential IP. I documented both, and kept the slower fully human UI path on a branch as a fallback."
**DO:** Show `latency.md` Decision section.

## 2:45 - 3:00  Code shape + honesty
**SAY:** "Architecture: long-running Express, no serverless, because the backend holds the live browser across the MFA pause. Session state is an in-memory Map with a state machine and a busy-lock so one browser is never driven twice. Every carrier is one interface, so adding a third is just one file. It's deployed on Fly in us-east-1, co-located with the browser. Known tradeoffs I'd harden for production are in known-issues: a per-operation timeout, and the request cadence still looks a bit botty on parallel fetches. Repo and Claude session links are in the description. Thanks."
**DO:** Flash `src/app.ts` (the /login -> mfa_needed -> /mfa pause) and `src/carriers/registry.ts`, then end.

---

## If you only have time for ONE live carrier on screen
Run Allstate fully live. For Assurant, show a 10-second pre-recorded clip or the Browserbase session replay so you still prove two carriers without burning a second live MFA wait.

## Numbers to say correctly
- Allstate graded (no-MFA): ~5s. Allstate doc-stage full-API: ~5.3s.
- Assurant graded: ~7.8s. Both under 8s.
- Anti-bot: Akamai Bot Manager + F5; `_abck` status=0 under Browserbase Verified + residential.
- Don't claim you beat detection at scale. This is one real user, low volume; say that, it's a strength.
