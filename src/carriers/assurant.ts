import type { Carrier, Document } from "../types.js";
import { InvalidCredentialsError, InvalidMfaError, DocumentsUnavailableError } from "../errors.js";
import { validateDocuments } from "../documents.js";
import { BrowserbaseSession, step, requireSession, jitter } from "../browserbase.js";

const LOGIN_URL = process.env.ASSURANT_LOGIN_URL ?? "https://manage.myassurantpolicy.com/app/login";
// Derive the API origin from the login URL so the fast-path API calls track the
// same host as the rest of the carrier (e.g. a staging ASSURANT_LOGIN_URL points
// both the page nav AND the in-page API fetches at the same place). Falls back to
// prod if the env value is somehow unparseable.
const ORIGIN = (() => {
    try {
        return new URL(LOGIN_URL).origin;
    } catch {
        return "https://manage.myassurantpolicy.com";
    }
})();
const STEP_TIMEOUT = 30_000;

// Full REN is "REN" + 11 digits (e.g. REN66501720005). The short 7-digit form
// (REN6650172) hits the POI endpoint but returns an HTML error page, not a PDF.
// We require >= 10 digits after the prefix to distinguish the two forms.
const FULL_REN_RE = /REN\d{10,}/i;

// Try every reasonable extraction path against the raw /api/PolicyId response body.
// Returns the full-form REN string, or null if none is found.
function extractRen(raw: string): string | null {
    // 1. Look for the literal "REN<digits>" pattern directly in the text (covers
    //    both JSON string values and any plain-text response body).
    const directMatch = raw.match(FULL_REN_RE);
    if (directMatch) return directMatch[0].toUpperCase();

    // 2. Try JSON parse: look in the most likely field names for a bare numeric id
    //    that we can prefix. Carriers sometimes return the id without the "REN" prefix.
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
            const obj = parsed as Record<string, unknown>;
            for (const key of ["PolicyId", "policyId", "policyNumber", "id", "Id", "renNumber"]) {
                const val = obj[key];
                if (typeof val === "string") {
                    // Could be "REN66501720005" or "66501720005" (bare digits)
                    const withPrefix = /^REN/i.test(val) ? val.toUpperCase() : `REN${val}`;
                    if (FULL_REN_RE.test(withPrefix)) return withPrefix;
                }
                if (typeof val === "number") {
                    const withPrefix = `REN${val}`;
                    if (FULL_REN_RE.test(withPrefix)) return withPrefix;
                }
            }
        }
    } catch {
        // not JSON — fall through to regex pass on raw text
    }

    // 3. Regex pass: find a bare-digit run of the accepted full-REN length anywhere
    //    and prefix it. Matched length (>= 10) is aligned with FULL_REN_RE so any
    //    bare run the validator would accept is also caught here.
    const bareMatch = raw.match(/\b(\d{10,})\b/);
    if (bareMatch) {
        const candidate = `REN${bareMatch[1]}`;
        if (FULL_REN_RE.test(candidate)) return candidate;
    }

    return null;
}

// Real Assurant (renters) portal automation. Auth is an embedded Okta widget:
// inputs #okta-signin-username / #okta-signin-password, submit #okta-signin-submit.
// MFA is an Okta SMS code into input[name=answer]. After login the account lands
// on /app/policy/selection; documents live on the server-rendered /Policy/Documents.
// Shared Browserbase plumbing (session + downloads) lives in BrowserbaseSession.
export class AssurantCarrier implements Carrier {
    readonly name = "assurant";
    private session?: BrowserbaseSession;

    // Open the browser and load the Okta login form. No credentials needed, so
    // this can run ahead of login() to pre-warm while the user is still typing.
    async prepare(): Promise<void> {
        this.session = await BrowserbaseSession.open();
        const page = this.session.page;
        const tGoto = Date.now();
        await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
        console.log(`[timing] goto: ${Date.now() - tGoto}ms`);
        // the Okta widget renders client-side: wait for the username field
        const tForm = Date.now();
        await step(page, "assurant login-form", () =>
            page.locator("#okta-signin-username").waitFor({ timeout: STEP_TIMEOUT }),
        );
        console.log(`[timing] form-hydrate: ${Date.now() - tForm}ms`);
    }

    async login(username: string, password: string): Promise<{ mfaRequired: boolean }> {
        if (!this.session) await this.prepare(); // not pre-warmed: open + load the form now
        const page = requireSession(this.session).page;

        const tSubmit = Date.now();
        await page.locator("#okta-signin-username").fill(username);
        await page.locator("#okta-signin-password").fill(password);
        await page.locator("#okta-signin-submit").click();
        console.log(`[timing]   form-actions: ${Date.now() - tSubmit}ms`);

        // read the page: Okta code challenge, or straight into the account?
        const tNav = Date.now();
        let outcome: "mfa" | "dashboard";
        try {
            outcome = await Promise.race([
                page.locator('input[name="answer"]').waitFor({ timeout: STEP_TIMEOUT }).then(() => "mfa" as const),
                page.waitForURL(/\/app\/policy\//, { timeout: STEP_TIMEOUT }).then(() => "dashboard" as const),
            ]);
        } catch {
            // neither the code field nor the account appeared: almost always bad
            // credentials (Okta re-renders the form with an error). Surface a 401.
            throw new InvalidCredentialsError("login failed (check email and password)");
        }
        console.log(`[timing]   auth-nav: ${Date.now() - tNav}ms`);
        console.log(`[timing] submit+detect: ${Date.now() - tSubmit}ms`);
        if (outcome === "dashboard") return { mfaRequired: false }; // trusted device, no MFA

        // MFA: tell Okta to send the SMS code; the code field is already rendered.
        await page
            .getByRole("link", { name: /send code/i })
            .or(page.getByRole("button", { name: /send code/i }))
            .first()
            .click();
        return { mfaRequired: true };
    }

    async submitMfa(code: string): Promise<void> {
        const page = requireSession(this.session).page;
        await page.locator('input[name="answer"]').fill(code);
        // the Okta submit is an <input type=submit> whose accessible name is its
        // aria-label ("Submit button"), so match on /submit/, not the "Verify" value.
        await page.getByRole("button", { name: /verify|submit/i }).first().click();
        try {
            await page.waitForURL(/\/app\/policy\//, { timeout: STEP_TIMEOUT });
        } catch {
            throw new InvalidMfaError("MFA code was rejected or expired");
        }
    }

    async fetchDocuments(): Promise<Document[]> {
        const session = requireSession(this.session);
        const page = session.page;

        // ------------------------------------------------------------------ //
        // FAST PATH: settle -> activate -> /api/PolicyId -> full REN -> POI    //
        // All traffic stays in-page (residential proxy + Chrome TLS/cookies). //
        // The fast path mirrors the real app's post-MFA flow so Cloudflare    //
        // sees organic, settled, same-origin XHRs rather than cold early hits.//
        // Any failure here falls through to the unchanged full download path. //
        // ------------------------------------------------------------------ //

        const tFastPath = Date.now();

        // Step 0: let the post-MFA page settle before issuing any XHR. The real app
        // fires /api/SetOktaUserIdAndToken (0ms) and /api/ResetBlitzPolicyView (247ms)
        // before /api/PolicyId (~1802ms). Waiting for networkidle lets those
        // session-state calls land first, so our PolicyId fetch matches the app's
        // natural cadence instead of being a cold, out-of-order same-origin XHR.
        await page
            .waitForLoadState("networkidle", { timeout: STEP_TIMEOUT })
            .catch(() => {}); // best effort: a busy SPA may never go fully idle

        // Step 1: activate the policy. POI requires the policy to be "active"
        // server-side, which the recon confirmed happens after the selection ->
        // snapshot nav. We do the cheap activate click UNCONDITIONALLY when on
        // /selection (not only when REN extraction fails): it makes the policy
        // active AND it gives us a real snapshot navigation so the POI Referer we
        // claim below matches the session's actual browsing history. This is far
        // cheaper (~1s) than the full nav-docs path and keeps the request shape
        // consistent for the per-request bot scorer.
        if (/selection/i.test(page.url())) {
            console.log(`[timing] fast-path-activate: clicking policy row to reach snapshot`);
            try {
                await page.getByText(/REN\d+/i).first().click();
                await page.waitForURL(/snapshot/, { timeout: STEP_TIMEOUT }).catch(() => {});
                // let the snapshot's own XHRs settle before we add ours
                await page
                    .waitForLoadState("networkidle", { timeout: STEP_TIMEOUT })
                    .catch(() => {});
            } catch (e) {
                console.log(`[timing] fast-path-activate-error: ${(e as Error).message}`);
            }
        }

        // Step 2: fetch /api/PolicyId from inside the browser to learn the full REN.
        // Pass a referer of the page's actual current URL so this is not a
        // referer-less XHR. Parse the body tolerantly (JSON fields or regex).
        const tPolicyId = Date.now();
        let ren: string | null = null;
        try {
            const policyIdRes = await session.fetchInPage(`${ORIGIN}/api/PolicyId`, {
                headers: { referer: page.url() },
            });
            const rawBody = Buffer.from(policyIdRes.base64, "base64").toString("utf8");
            console.log(`[timing] policyid: ${Date.now() - tPolicyId}ms (status=${policyIdRes.status})`);
            if (policyIdRes.status < 400) ren = extractRen(rawBody);
            if (!ren) console.log(`[timing] policyid-no-ren: could not extract full REN from response`);
        } catch (e) {
            console.log(`[timing] policyid-error: ${(e as Error).message}`);
        }

        // Step 2b: if no REN yet, retry /api/PolicyId once regardless of URL. The
        // page may already be active (a single-policy account can auto-land on
        // /snapshot, so the activate click above never ran), or session state may
        // just have needed another beat to settle. A small jitter avoids a
        // same-millisecond authenticated-XHR burst (see browserbase.ts jitter()).
        if (!ren) {
            await jitter(300);
            const tRetry = Date.now();
            try {
                const retryRes = await session.fetchInPage(`${ORIGIN}/api/PolicyId`, {
                    headers: { referer: page.url() },
                });
                const retryBody = Buffer.from(retryRes.base64, "base64").toString("utf8");
                console.log(`[timing] policyid-retry: ${Date.now() - tRetry}ms (status=${retryRes.status})`);
                if (retryRes.status < 400) ren = extractRen(retryBody);
            } catch (e) {
                console.log(`[timing] policyid-retry-error: ${(e as Error).message}`);
            }
        }

        // Step 3: with the full REN, fetch the COC PDF directly via in-page fetch.
        // The Referer is the page's ACTUAL current URL (not a hardcoded /snapshot),
        // so the claimed referer matches the real navigation history the origin
        // sees. A small jitter spaces this from the preceding PolicyId XHR so we
        // don't fire a tight authenticated-XHR burst.
        if (ren) {
            await jitter(300);
            const tPoi = Date.now();
            try {
                const poiUrl = `${ORIGIN}/api/v2/Policies/${ren}/POI/ConfirmationOfCoverage?outputMode=file`;
                const poiRes = await session.fetchInPage(poiUrl, {
                    headers: {
                        accept: "application/pdf,*/*",
                        referer: page.url(),
                    },
                });
                console.log(`[timing] poi: ${Date.now() - tPoi}ms (status=${poiRes.status}, contentType="${poiRes.contentType}")`);

                if (poiRes.status < 400 && /pdf|octet-stream/i.test(poiRes.contentType)) {
                    console.log(`[timing] fast-path total: ${Date.now() - tFastPath}ms`);
                    const doc: Document = {
                        name: "ConfirmationOfCoverage",
                        contentType: poiRes.contentType,
                        bytes: poiRes.base64,
                    };
                    return validateDocuments(this.name, [doc]);
                }

                // POI returned something unexpected — fall through to full nav path.
                console.log(`[timing] poi-not-pdf: falling back to download path`);
            } catch (e) {
                console.log(`[timing] poi-error: ${(e as Error).message} — falling back`);
            }
        }

        console.log(`[timing] fast-path-miss: ${Date.now() - tFastPath}ms — falling back to download path`);

        // ------------------------------------------------------------------ //
        // FALLBACK: full nav -> trigger downloads -> collectDocuments          //
        // Preserved exactly as the original carrier. Never removed.           //
        // The fast path may have already navigated to /snapshot (the activate  //
        // click above); the /selection guard below is a no-op in that case.   //
        // ------------------------------------------------------------------ //

        const tNav = Date.now();
        // we land on the policy-selection list; open the policy to set it active
        // server-side (the snapshot is what /Policy/Documents resolves against).
        if (/selection/i.test(page.url())) {
            await page.getByText(/REN\d+/i).first().click();
            await page.waitForURL(/snapshot/, { timeout: STEP_TIMEOUT }).catch(() => {});
        }
        // reach documents the way the UI does: the snapshot's "view policy
        // documents" card. (A direct goto can land back on selection.) Wait for the
        // "Policy Documents" HEADING, not the URL — Assurant's SPA renders the docs
        // view without the URL matching /Policy/Documents, so a URL wait times out
        // even though the page loaded fine.
        await step(page, "assurant nav-docs", async () => {
            await page.getByText(/view policy documents|need proof of insurance/i).first().click();
            await page.getByRole("heading", { name: /policy documents/i }).waitFor({ timeout: STEP_TIMEOUT });
        });
        console.log(`[timing] nav-docs: ${Date.now() - tNav}ms`);

        // Every "Download" control on the page: the Confirmation of Coverage card
        // (always available) plus the Current Documents table rows once the policy
        // finishes processing. Each click downloads a PDF into Browserbase storage.
        const tClicks = Date.now();
        const triggers = page
            .getByRole("button", { name: /download/i })
            .or(page.getByRole("link", { name: /download/i }));
        const count = await triggers.count();
        if (count === 0)
            throw new DocumentsUnavailableError("no documents available yet (policy may still be processing)");

        const filePromises: Promise<string>[] = [];
        for (let i = 0; i < count; i++) {
            const waitDownload = page.waitForEvent("download", { timeout: STEP_TIMEOUT });
            await triggers.nth(i).click();
            filePromises[i] = waitDownload.then((d) => d.suggestedFilename()).catch(() => "");
        }
        const files = await Promise.all(filePromises);
        console.log(`[timing] trigger-downloads: ${Date.now() - tClicks}ms`);

        // name each doc by its (opaque) filename, then collect the bytes
        const items = files
            .filter(Boolean)
            .map((filename) => ({ name: filename.replace(/\.pdf$/i, ""), filename }));
        const docs = await session.collectDocuments(items);
        return validateDocuments(this.name, docs);
    }

    async close(): Promise<void> {
        await this.session?.close();
    }
}
