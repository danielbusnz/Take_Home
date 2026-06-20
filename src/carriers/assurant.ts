import type { Carrier, Document } from "../types.js";
import { InvalidCredentialsError, InvalidMfaError, DocumentsUnavailableError } from "../errors.js";
import { validateDocuments } from "../documents.js";
import { BrowserbaseSession, step, requireSession } from "../browserbase.js";

const LOGIN_URL = process.env.ASSURANT_LOGIN_URL ?? "https://manage.myassurantpolicy.com/app/login";
const STEP_TIMEOUT = 30_000;

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
