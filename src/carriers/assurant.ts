import type { Carrier, Document } from "../types.js";
import { CarrierError, InvalidCredentialsError, InvalidMfaError } from "../errors.js";
import { validateDocuments } from "../documents.js";
import { BrowserbaseSession, step, requireSession, jitter } from "../browserbase.js";

const LOGIN_URL = process.env.ASSURANT_LOGIN_URL ?? "https://manage.myassurantpolicy.com/app/login";
const STEP_TIMEOUT = 30_000;

// Real Assurant (renters) portal automation. Auth is an embedded Okta widget:
// inputs #okta-signin-username / #okta-signin-password, submit #okta-signin-submit.
// MFA is an Okta SMS code into input[name=answer]. After login the account lands
// on /app/policy/selection. Documents are then pulled from Assurant's JSON/PDF API
// (in-browser via page.request), not the UI. See latency.md / assurant-probe.
export class AssurantCarrier implements Carrier {
    readonly name = "assurant";
    private session?: BrowserbaseSession;
    // The Assurant document API authenticates with an Okta Bearer JWT (plus app
    // headers like the ui-transaction identity blob) that the Angular HTTP
    // interceptor attaches, not just the session cookie. We capture the FULL
    // header set from the app's own same-origin /api calls and replay all of it on
    // our in-page document fetches, so our requests match the app's exactly.
    private authHeaders: Record<string, string> = {};

    // Open the browser and load the Okta login form. No credentials needed, so
    // this can run ahead of login() to pre-warm while the user is still typing.
    async prepare(): Promise<void> {
        this.session = await BrowserbaseSession.open();
        const page = this.session.page;
        // Capture the interceptor's full header set from the app's same-origin /api
        // calls (fired during snapshot load). Strip headers the browser re-adds on
        // our fetch, and content-type (our doc calls are GETs). Latest wins so the
        // Bearer stays fresh.
        page.on("request", (req) => {
            if (!/myassurantpolicy\.com\/api\//i.test(req.url())) return;
            const h = req.headers();
            if (!h["authorization"]?.startsWith("Bearer")) return;
            const captured: Record<string, string> = {};
            for (const [k, v] of Object.entries(h)) {
                if (/^(host|connection|content-length|content-type|accept-encoding|user-agent|cookie|origin|referer|sec-|:)/i.test(k)) continue;
                captured[k] = v;
            }
            this.authHeaders = captured;
        });
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
        const origin = new URL(LOGIN_URL).origin;
        const LOB = "RI"; // renters line of business (policyDetails.LOB)
        const tNav = Date.now();

        // Activate the policy server-side and read its number for the API calls.
        // The selection list shows REN-format numbers; clicking one sets it active
        // (the session context the document endpoints resolve against) and lands on
        // the snapshot. This is the only non-API step; everything below is JSON/PDF.
        let policyNumber = "";
        if (/selection/i.test(page.url())) {
            const renEl = page.getByText(/REN\d+/i).first();
            await renEl.waitFor({ timeout: STEP_TIMEOUT });
            policyNumber = (await renEl.innerText()).match(/REN\d+/i)?.[0] ?? "";
            await renEl.click();
            await page.waitForURL(/snapshot/, { timeout: STEP_TIMEOUT }).catch(() => {});
        }
        if (!policyNumber) policyNumber = (await page.locator("body").innerText()).match(/REN\d+/i)?.[0] ?? "";
        if (!policyNumber) throw new CarrierError("assurant: could not determine policy number");

        // The selection click above triggers the app's authed API calls; wait
        // briefly for the Bearer token to be captured before we call the API.
        for (let i = 0; i < 25 && !this.authHeaders["authorization"]; i++) await page.waitForTimeout(200);
        const headers: Record<string, string> = { ...this.authHeaders }; // full captured app header set
        if (!headers["authorization"]) throw new CarrierError("assurant: could not capture API auth token");

        // List the policy's stored documents (declarations page, etc.). Fetched
        // from inside the page (session.fetchInPage) so it rides the residential IP
        // + Chrome TLS, not our Node client. See latency.md / fingerprint findings.
        const listRes = await session.fetchInPage(`${origin}/api/Policies/${policyNumber}/Documents?lob=${LOB}`, { headers });
        if (listRes.status >= 400) throw new CarrierError(`assurant: document list failed (${listRes.status})`);
        const list =
            (JSON.parse(Buffer.from(listRes.base64, "base64").toString("utf8")) as {
                Documents?: { DocId: string; DocumentType?: string; DocumentTitle?: string; MimeType?: string }[];
            }).Documents ?? [];
        console.log(`[timing] api-list: ${Date.now() - tNav}ms (${list.length} docs)`);

        // Fetch every PDF in parallel straight from the API (in-page). The per-doc
        // token is just encodeURIComponent(DocId) (see documents-list.component.js
        // line 179); the always-available Confirmation of Coverage has its own URL.
        const tDocs = Date.now();
        const fetchPdf = async (url: string, name: string, fallbackType = "application/pdf"): Promise<Document> => {
            await jitter(700); // stagger starts so the doc fetches aren't a single-ms burst
            const r = await session.fetchInPage(url, { headers });
            if (r.status >= 400) throw new CarrierError(`assurant: document fetch failed (${r.status}) for "${name}"`);
            return { name, contentType: r.contentType || fallbackType, bytes: r.base64 };
        };
        const docs = await Promise.all([
            ...list.map((d) =>
                fetchPdf(
                    `${origin}/api/Policies/${policyNumber}/Document?documentToken=${encodeURIComponent(d.DocId)}&lob=${LOB}`,
                    d.DocumentType?.replace(/^\d+\s*/, "").trim() || d.DocumentTitle || "Policy document",
                    d.MimeType || "application/pdf",
                ),
            ),
            fetchPdf(
                `${origin}/api/v2/Policies/${policyNumber}/POI/ConfirmationOfCoverage?outputMode=file`,
                "Confirmation of Coverage",
            ),
        ]);
        console.log(`[timing] api-docs: ${Date.now() - tDocs}ms`);
        return validateDocuments(this.name, docs);
    }

    async close(): Promise<void> {
        await this.session?.close();
    }
}
