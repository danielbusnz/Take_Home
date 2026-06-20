# Frontend

One static HTML file, vanilla JS, served by Express. No build, no framework. Ugly on purpose.

## States

One section visible at a time. `ERROR` returns to the previous state so the user can retry.

| State | Shows | Button |
|-------|-------|--------|
| IDLE | carrier dropdown, username, password | enabled |
| LOGGING_IN | same form | disabled, status "Logging in... (6s)" |
| MFA_NEEDED | code input, "Code sent to ***9605" | enabled |
| MFA_SUBMITTING | code input | disabled, status "Verifying..." |
| DONE | document list (PDF preview + download) + timing line | re-enabled for another run |
| ERROR | back to prior state | re-enabled |

Transitions: `IDLE -> LOGGING_IN -> (MFA_NEEDED | DONE)`, `MFA_NEEDED -> MFA_SUBMITTING -> DONE`.

## Decisions

1. **Auto-pick SMS.** UI just says "Code sent to ***9605". No delivery-method picker.
2. **Inline preview via blob URLs.** `data:` PDFs in an iframe are blocked in Chrome 112+, but blob URLs are not, so each doc renders in an `<iframe>` plus a download link. Show name, content type, and size per doc.

## Pre-warm and timing

- **Pre-warm on page load.** `/prepare` fires the instant the page loads (not on submit), so the ~10s browser open overlaps the user typing. The status line shows "Preparing a secure session..." then "Ready."
- **Timing on screen.** On finish the status line shows the graded fetch span (`documents fetched X.Xs`, the brief's metric) next to the full login-click number.

## Loading

So it never looks frozen during the multi-second waits:

- Disable the button on click (first line), prevents double submit.
- Status line pulses and counts seconds: "Logging in... (6s)".

## Errors

Map the backend status to plain text, show the raw `error` in small grey under it, no `alert()`:

- 401: wrong credentials or bad/expired code
- 503: anti-bot block, wait and retry
- 504: portal timed out, retry
- 502: logged in but document fetch failed, refresh

On a bad MFA code, clear and focus the code field.

## Reuse

Reuse is automatic on the backend: a repeat login with the same credentials refetches on the
kept-alive validated session and returns in ~3s (keyed by a one-way credential hash, see
`sessions.ts`). The login button re-enables after a run, so submitting the same credentials
again is the live demo moment. No separate refresh/forget buttons.

## Accessibility (all cheap)

- `<label>` on every input (not just placeholder).
- `disabled` attribute on buttons while loading.
- Focus the code input when the MFA section appears.
- Status line: `role="status" aria-live="polite"`.
- `inert` on hidden sections.
- `.trim()` inputs, `autocomplete="off"` on password, numeric MFA input.

## Skip (over-engineering)

No progress polling or WebSocket. No localStorage. No PDF.js. No retry backoff. No client-side validation. No CSS beyond red errors and the loading pulse.
