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
        // navigate the way the UI does: Policies dropdown -> Documents.
        // (a direct goto to the docs URL redirects back to the dashboard.)
        const tNav = Date.now();
        await page
            .getByRole("link", { name: /policies/i })
            .or(page.getByRole("button", { name: /policies/i }))
            .first()
            .click();
        await page.getByRole("button", { name: /Documents for .*policy/i }).first().click();

        // document titles are anchors inside the documents table
        const titles = page.locator("table a:visible");
        await titles.first().waitFor({ timeout: STEP_TIMEOUT });
        const names = (await titles.allTextContents()).map((n) => n.trim());
        console.log(`[timing] nav-docs: ${Date.now() - tNav}ms`);

        // Clicking a title downloads its PDF into Browserbase's storage (via a
        // popup). Capture the filename each click produces so we can pair the
        // synced files back to their titles (filenames are opaque GUIDs).
        const tClicks = Date.now();
        // Click each doc and capture its popup (sequential clicks keep the
        // popup-to-title pairing right), but await the downloads in PARALLEL so
        // each popup fetching its PDF overlaps instead of stacking.
        const filePromises: Promise<string>[] = [];
        for (let i = 0; i < names.length; i++) {
            const popupPromise = page.waitForEvent("popup", { timeout: STEP_TIMEOUT });
            await titles.nth(i).click();
            const popup = await popupPromise;
            filePromises[i] = popup
                .waitForEvent("download", { timeout: STEP_TIMEOUT })
                .then((d) => d.suggestedFilename())
                .catch(() => "");
        }
        const files = await Promise.all(filePromises);
        console.log(`[timing] trigger-downloads: ${Date.now() - tClicks}ms`);

        // pair each captured filename to its title, then collect the bytes
        const items = names.map((name, i) => ({ name, filename: files[i] }));
        const docs = await session.collectDocuments(items);
        return validateDocuments(this.name, docs);
    }

    async close(): Promise<void> {
        await this.session?.close();
    }
}
