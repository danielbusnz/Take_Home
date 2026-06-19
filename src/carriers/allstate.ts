import { chromium, type Browser, type Page } from "playwright";
import Browserbase from "@browserbasehq/sdk";
import type { Carrier, Document } from "../types.js";
import { CarrierError, InvalidMfaError, DocumentsUnavailableError } from "../errors.js";
import { validateDocuments } from "../documents.js";

const LOGIN_URL =
    process.env.ALLSTATE_LOGIN_URL ?? "https://myaccountrwd.allstate.com/anon/account/login";
const STEP_TIMEOUT = 30_000;

type BbDownload = { id: string; filename: string; mimeType: string; size: number };

// Real Allstate portal automation. Selectors confirmed against the live login:
// email tab #UserIDdisplay, inputs #emailAddress + visible password, submit
// button[name=frmButton]:visible. Login lands on /anon/verification (MFA).
export class AllstateCarrier implements Carrier {
    readonly name = "allstate";
    // mutable: set to the context we created during login, or the one passed in
    contextId: string | undefined;
    private bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY! });
    private browser?: Browser;
    private page?: Page;
    private sessionId?: string;

    constructor(contextId?: string) {
        this.contextId = contextId;
    }

    // Open a Browserbase cloud browser on a residential proxy and grab its page.
    private async openSession(): Promise<Page> {
        const tCreate = Date.now();
        const session = await this.bb.sessions.create({
            projectId: process.env.BROWSERBASE_PROJECT_ID!,
            proxies: true, // residential egress, beats datacenter-IP anti-bot
            region: "us-east-1", // co-locate the browser near our compute; CDP RTT dominates per-action cost
            timeout: 1800, // seconds: covers the human MFA pause
        });
        this.sessionId = session.id;
        console.log(`[timing] session-create: ${Date.now() - tCreate}ms`);
        const tConnect = Date.now();
        this.browser = await chromium.connectOverCDP(session.connectUrl);
        const context = this.browser.contexts()[0];
        this.page = context.pages()[0]; // Browserbase hands us the page
        // required so Browserbase syncs downloaded files to its cloud storage
        const cdp = await context.newCDPSession(this.page);
        await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "downloads", eventsEnabled: true });
        console.log(`[timing] cdp-connect+config: ${Date.now() - tConnect}ms`);
        return this.page;
    }

    // Wrap a fragile browser step: let our own typed errors through, but turn an
    // unexpected failure (e.g. a changed selector) into a clean error plus a saved
    // screenshot for debugging, instead of a raw crash. Refine error types later.
    private async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
        try {
            return await fn();
        } catch (e) {
            if (e instanceof CarrierError) throw e; // our intentional errors pass through
            console.error(`allstate ${name} failed:`, e);
            await this.page?.screenshot({ path: `/tmp/allstate-fail-${name}.png` }).catch(() => {});
            throw new CarrierError(`allstate ${name} failed`);
        }
    }

    // Open the browser and load the login form. No credentials needed, so this
    // can run ahead of login() to pre-warm while the user is still typing.
    async prepare(): Promise<void> {
        const page = await this.openSession();
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
        await this.step("login-form", () => page.locator("#UserIDdisplay").waitFor({ timeout: STEP_TIMEOUT }));
        console.log(`[timing] form-hydrate: ${Date.now() - tForm}ms`);
        // open the Email tab now (no credentials needed) so login() only types + submits
        await page.locator("#UserIDdisplay").click();
        await page.locator("#emailAddress").waitFor({ timeout: STEP_TIMEOUT });
    }

    async login(username: string, password: string): Promise<{ mfaRequired: boolean }> {
        if (!this.page) await this.prepare(); // not pre-warmed: open + load the form now
        const page = this.page!;

        const tSubmit = Date.now();
        // Email tab already opened in prepare(); just type the creds and submit.
        // (assumption: user logs in by email, see assumptions.md)
        await page.locator("#emailAddress").fill(username);
        await page.locator("input[type=password]:visible").fill(password);
        await page.locator("button[name=frmButton]:visible").click();
        console.log(`[timing]   form-actions: ${Date.now() - tSubmit}ms`);

        // read the page: MFA prompt, or straight to the dashboard?
        const tNav = Date.now();
        const outcome = await Promise.race([
            page.waitForURL(/verification/, { timeout: STEP_TIMEOUT }).then(() => "mfa" as const),
            page.waitForURL(/\/secured\//, { timeout: STEP_TIMEOUT }).then(() => "dashboard" as const),
        ]);
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
        const page = this.page!;
        await page.locator("#pinCode").fill(code);
        await page.getByRole("button", { name: /continue|verify|submit/i }).first().click();
        try {
            await page.waitForURL(/\/secured\//, { timeout: STEP_TIMEOUT });
        } catch {
            throw new InvalidMfaError("MFA code was rejected or expired");
        }
    }

    async fetchDocuments(): Promise<Document[]> {
        const page = this.page!;
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

        // pull the synced files out of Browserbase and pair them to the titles
        const tList = Date.now();
        const downloads = await this.retrieveDownloads(names.length);
        console.log(`[timing] retrieve-list: ${Date.now() - tList}ms`);
        const byName = new Map(downloads.map((d) => [d.filename, d]));
        const tBytes = Date.now();
        const docs: Document[] = [];
        for (let i = 0; i < names.length; i++) {
            const meta = byName.get(files[i]);
            if (!meta) continue;
            docs.push({
                name: names[i],
                contentType: meta.mimeType || "application/pdf",
                bytes: await this.fetchDownloadBytes(meta.id),
            });
        }
        console.log(`[timing] fetch-bytes: ${Date.now() - tBytes}ms`);
        return validateDocuments(this.name, docs);
    }

    // List the session's downloads from Browserbase, retrying until they sync.
    private async retrieveDownloads(min: number): Promise<BbDownload[]> {
        const key = process.env.BROWSERBASE_API_KEY!;
        for (let i = 0; i < 15; i++) {
            const r = await fetch(`https://api.browserbase.com/v1/downloads?sessionId=${this.sessionId}`, {
                headers: { "x-bb-api-key": key },
            });
            const data = (await r.json()) as { downloads?: BbDownload[] };
            if ((data.downloads?.length ?? 0) >= min) return data.downloads!;
            await new Promise((res) => setTimeout(res, 1500));
        }
        throw new DocumentsUnavailableError("documents did not sync from the browser in time");
    }

    // Fetch one download's bytes from Browserbase as base64.
    private async fetchDownloadBytes(id: string): Promise<string> {
        const key = process.env.BROWSERBASE_API_KEY!;
        const r = await fetch(`https://api.browserbase.com/v1/downloads/${id}`, {
            headers: { "x-bb-api-key": key, Accept: "application/octet-stream" },
        });
        return Buffer.from(await r.arrayBuffer()).toString("base64");
    }

    async close(): Promise<void> {
        await this.browser?.close();
    }
}
