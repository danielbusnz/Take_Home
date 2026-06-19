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
| DONE | document list + Refresh + Forget | n/a |
| ERROR | back to prior state | re-enabled |

Transitions: `IDLE -> LOGGING_IN -> (MFA_NEEDED | DONE)`, `MFA_NEEDED -> MFA_SUBMITTING -> DONE`.

## Decisions

1. **Auto-pick SMS.** UI just says "Code sent to ***9605". No delivery-method picker.
2. **Download links, no inline preview.** `data:` PDFs in an iframe are blocked in Chrome 112+. Use `<a download>`. Show name, content type, and size per doc.

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

On the results screen:

- **Refresh documents**: re-runs `/login` with the saved creds, reuses the session, back in ~2s. The live demo moment.
- **Forget saved session**: clears state back to IDLE.

## Accessibility (all cheap)

- `<label>` on every input (not just placeholder).
- `disabled` attribute on buttons while loading.
- Focus the code input when the MFA section appears.
- Status line: `role="status" aria-live="polite"`.
- `inert` on hidden sections.
- `.trim()` inputs, `autocomplete="off"` on password, numeric MFA input.

## Skip (over-engineering)

No progress polling or WebSocket. No localStorage. No PDF.js. No retry backoff. No client-side validation. No CSS beyond red errors and the loading pulse.
