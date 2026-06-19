import { chromium, type Browser, type Page } from "playwright";
import Browserbase from "@browserbasehq/sdk";
import { CarrierError, DocumentsUnavailableError } from "./errors.js";

// A Browserbase cloud browser on a residential proxy, plus its downloads API.
// This is the part every real carrier shares; carriers compose one of these and
// add their own page-driving logic (login, MFA, document navigation) on top.

export type BbDownload = { id: string; filename: string; mimeType: string; size: number };

const API_KEY = process.env.BROWSERBASE_API_KEY!;
const bb = new Browserbase({ apiKey: API_KEY });

export class BrowserbaseSession {
    private constructor(
        private readonly browser: Browser,
        readonly page: Page,
        readonly id: string,
    ) {}

    // Open a session, connect over CDP, and enable downloads to BB cloud storage.
    static async open(): Promise<BrowserbaseSession> {
        const tCreate = Date.now();
        const session = await bb.sessions.create({
            projectId: process.env.BROWSERBASE_PROJECT_ID!,
            proxies: true, // residential egress, beats datacenter-IP anti-bot
            region: "us-east-1", // co-locate near our compute; CDP RTT dominates per-action cost
            timeout: 1800, // seconds: covers the human MFA pause
        });
        console.log(`[timing] session-create: ${Date.now() - tCreate}ms`);
        const tConnect = Date.now();
        const browser = await chromium.connectOverCDP(session.connectUrl);
        const context = browser.contexts()[0];
        const page = context.pages()[0]; // Browserbase hands us the page
        // required so Browserbase syncs downloaded files to its cloud storage
        const cdp = await context.newCDPSession(page);
        await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "downloads", eventsEnabled: true });
        console.log(`[timing] cdp-connect+config: ${Date.now() - tConnect}ms`);
        return new BrowserbaseSession(browser, page, session.id);
    }

    // Poll the downloads list until at least `min` files have synced from the browser.
    async waitForDownloads(min: number): Promise<BbDownload[]> {
        for (let i = 0; i < 15; i++) {
            const r = await fetch(`https://api.browserbase.com/v1/downloads?sessionId=${this.id}`, {
                headers: { "x-bb-api-key": API_KEY },
            });
            const data = (await r.json()) as { downloads?: BbDownload[] };
            if ((data.downloads?.length ?? 0) >= min) return data.downloads!;
            await new Promise((res) => setTimeout(res, 1500));
        }
        throw new DocumentsUnavailableError("documents did not sync from the browser in time");
    }

    // Fetch one download's bytes from Browserbase as base64.
    async fetchBytes(id: string): Promise<string> {
        const r = await fetch(`https://api.browserbase.com/v1/downloads/${id}`, {
            headers: { "x-bb-api-key": API_KEY, Accept: "application/octet-stream" },
        });
        return Buffer.from(await r.arrayBuffer()).toString("base64");
    }

    async close(): Promise<void> {
        await this.browser.close();
    }
}

// Wrap a fragile browser step: let our own typed errors through, but turn an
// unexpected failure (e.g. a changed selector) into a clean CarrierError plus a
// saved screenshot for debugging, instead of a raw crash.
export async function step<T>(page: Page, name: string, fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (e) {
        if (e instanceof CarrierError) throw e; // intentional errors pass through
        console.error(`${name} failed:`, e);
        await page.screenshot({ path: `/tmp/carrier-fail-${name.replace(/\W+/g, "-")}.png` }).catch(() => {});
        throw new CarrierError(`${name} failed`);
    }
}
