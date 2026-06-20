import type { Carrier, Document } from "../types.js";
import { CarrierError, InvalidMfaError } from "../errors.js";
import { validateDocuments } from "../documents.js";
import { BrowserbaseSession, step, requireSession } from "../browserbase.js";

const LOGIN_URL =
    process.env.ALLSTATE_LOGIN_URL ?? "https://myaccountrwd.allstate.com/anon/account/login";
const STEP_TIMEOUT = 30_000;

// Real Allstate portal automation. Selectors confirmed against the live login:
// email tab #UserIDdisplay, inputs #emailAddress + visible password, submit
// button[name=frmButton]:visible. Login lands on /anon/verification (MFA).
// Shared Browserbase plumbing (session + downloads) lives in BrowserbaseSession.
export class AllstateCarrier implements Carrier {
    readonly name = "allstate";
    private session?: BrowserbaseSession;

    // Open the browser and load the login form. No credentials needed, so this
    // can run ahead of login() to pre-warm while the user is still typing.
    async prepare(): Promise<void> {
        this.session = await BrowserbaseSession.open();
        const page = this.session.page;
        // Kill CSS animations/transitions so Playwright's click "stability" waits
        // don't burn time. addInitScript re-applies on every navigation in the flow.
        await page.addInitScript(
            "const s=document.createElement('style');s.textContent='*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}';document.documentElement.appendChild(s);",
        );
        const tGoto = Date.now();
        await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
        console.log(`[timing] goto: ${Date.now() - tGoto}ms`);
        // SPA: wait for the form to actually render, not just the load event
        const tForm = Date.now();
        await step(page, "allstate login-form", () => page.locator("#UserIDdisplay").waitFor({ timeout: STEP_TIMEOUT }));
        console.log(`[timing] form-hydrate: ${Date.now() - tForm}ms`);
        // open the Email tab now (no credentials needed) so login() only types + submits
        await page.locator("#UserIDdisplay").click();
        await page.locator("#emailAddress").waitFor({ timeout: STEP_TIMEOUT });
    }

    async login(username: string, password: string): Promise<{ mfaRequired: boolean }> {
        if (!this.session) await this.prepare(); // not pre-warmed: open + load the form now
        const page = requireSession(this.session).page;

        const tSubmit = Date.now();
        // Email tab already opened in prepare(); just type the creds and submit.
        // (assumption: user logs in by email, see assumptions.md)
        await page.locator("#emailAddress").fill(username);
        await page.locator("input[type=password]:visible").fill(password);
        await page.locator("button[name=frmButton]:visible").click();
        console.log(`[timing]   form-actions: ${Date.now() - tSubmit}ms`);

        // read the page: MFA prompt, or straight to the dashboard?
        const tNav = Date.now();
        let outcome: "mfa" | "dashboard";
        try {
            outcome = await Promise.race([
                page.waitForURL(/verification/, { timeout: STEP_TIMEOUT }).then(() => "mfa" as const),
                page.waitForURL(/\/secured\//, { timeout: STEP_TIMEOUT }).then(() => "dashboard" as const),
            ]);
        } catch {
            // neither expected page showed: capture what Allstate actually served
            await page.screenshot({ path: "/tmp/allstate-unexpected.png" }).catch(() => { });
            throw new CarrierError(`unexpected page after login: ${page.url()}`);
        }
        console.log(`[timing]   auth-nav: ${Date.now() - tNav}ms`);
        console.log(`[timing] submit+detect: ${Date.now() - tSubmit}ms`);
        if (outcome === "dashboard") return { mfaRequired: false }; // trusted device, no MFA

        // MFA: pick SMS delivery and send the code, then wait for the code field.
        // (assumption: SMS is offered; see assumptions.md)
        await page.locator("label").filter({ hasText: /SMS to/i }).click();
        await page.getByRole("button", { name: /continue/i }).click();
        await page.locator("#pinCode").waitFor({ timeout: STEP_TIMEOUT });
        return { mfaRequired: true };
    }

    async submitMfa(code: string): Promise<void> {
        const page = requireSession(this.session).page;
        await page.locator("#pinCode").fill(code);
        await page.getByRole("button", { name: /continue|verify|submit/i }).first().click();
        try {
            await page.waitForURL(/\/secured\//, { timeout: STEP_TIMEOUT });
        } catch {
            throw new InvalidMfaError("MFA code was rejected or expired");
        }
    }

    async fetchDocuments(): Promise<Document[]> {
        const session = requireSession(this.session);
        const page = session.page;
        // Fetch documents straight from Allstate's JSON API, in-browser via
        // page.request (shares the session cookies + fingerprint), skipping the UI
        // nav, popups, and Browserbase download storage entirely. See latency.md.
        const api = page.request;
        const origin = new URL(LOGIN_URL).origin;
        const tNav = Date.now();
        const xsrfCookie = (await page.context().cookies()).find((c) => c.name === "XSRF-TOKEN")?.value ?? "";
        const headers = {
            // Angular URL-decodes the XSRF-TOKEN cookie before sending the header;
            // the raw (encoded) cookie makes the API 500.
            "x-xsrf-token": decodeURIComponent(xsrfCookie),
            "app-name": "MYA",
            "x-efm": "true",
            accept: "application/json, text/plain, */*",
            "content-type": "application/json",
            referer: `${origin}/secured/documents/policy-documents`,
        };

        const year = new Date().getFullYear();
        // GetUserData (→ policy number) and the document-context primer don't depend
        // on each other, so fire them together (saves ~1.5s vs sequential). The
        // primer's body is empty but it scopes the session to the policy's docs;
        // without it the list below comes back empty. The list call needs both done.
        const [ud] = (await Promise.all([
            api.get(`${origin}/api/secured/GetUserData`, { headers }).then((r) => r.json()),
            api.get(`${origin}/api/secured/document/GetDocumentsForPolicies`, { headers }),
        ])) as [{ policies?: { policyImage?: { number?: string } }[] }, unknown];
        const policyNumber = ud.policies?.[0]?.policyImage?.number;
        if (!policyNumber) throw new CarrierError("allstate: could not determine policy number");

        const listResp = await api.post(`${origin}/api/secured/document/GetPolicySpecificDocsList`, {
            headers,
            data: JSON.stringify({ policyNumber, contentId: null, yearFilter: year }),
        });
        const list =
            ((await listResp.json()) as {
                policySpecificDocumentsList?: { title: string; contentId: string; docYear: string }[];
            }).policySpecificDocumentsList ?? [];
        console.log(`[timing] api-list: ${Date.now() - tNav}ms (${list.length} docs)`);

        // fetch every document's bytes in parallel straight from the JSON API
        const tDocs = Date.now();
        const docs = await Promise.all(
            list.map(async (d) => {
                const r = await api.post(`${origin}/api/secured/document/GetUdpRetrieveDocument`, {
                    headers,
                    data: JSON.stringify({ policyNumber, contentId: d.contentId, yearFilter: Number(d.docYear) || year }),
                });
                const dd = ((await r.json()) as { documentData?: { data?: string; mimeType?: string } }).documentData;
                return { name: d.title, contentType: dd?.mimeType || "application/pdf", bytes: dd?.data ?? "" } satisfies Document;
            }),
        );
        console.log(`[timing] api-docs: ${Date.now() - tDocs}ms`);
        return validateDocuments(this.name, docs);
    }

    async close(): Promise<void> {
        await this.session?.close();
    }
}
