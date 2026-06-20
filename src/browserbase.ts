import { chromium, type Browser, type Page } from "playwright";
import Browserbase from "@browserbasehq/sdk";
import type { Document } from "./types.js";
import { CarrierError, DocumentsUnavailableError } from "./errors.js";

// A Browserbase cloud browser on a residential proxy, plus its downloads API.
// This is the part every real carrier shares; carriers compose one of these and
// add their own page-driving logic (login, MFA, document navigation) on top.

export type BbDownload = { id: string; filename: string; mimeType: string; size: number };

const API_KEY = process.env.BROWSERBASE_API_KEY!;

// Construct the client lazily: importing this module (e.g. in tests, via the
// carrier registry) must not require credentials. Only opening a real session does.
let client: Browserbase | undefined;
function bb(): Browserbase {
    return (client ??= new Browserbase({ apiKey: API_KEY }));
}

export class BrowserbaseSession {
    private constructor(
        private readonly browser: Browser,
        readonly page: Page,
        readonly id: string,
    ) {}

    // Open a session, connect over CDP, and enable downloads to BB cloud storage.
    // Per-carrier config: Allstate passes { verified, geo } (Verified fingerprint
    // validates Akamai's _abck + a region-pinned IP for Okta); Assurant opts out
    // (Cloudflare doesn't need Verified, and the extra weight slows its multi-step
    // UI nav — its original ~7.8s used a plain residential proxy).
    static async open(opts: { verified?: boolean; geo?: { country: string; state: string } } = {}): Promise<BrowserbaseSession> {
        const tCreate = Date.now();
        const session = await bb().sessions.create({
            projectId: process.env.BROWSERBASE_PROJECT_ID!,
            ...(opts.verified ? { browserSettings: { verified: true } } : {}),
            // residential egress beats datacenter-IP anti-bot. With a geo, pin to
            // that region (Okta location consistency); else the default residential
            // pool (lighter/faster for carriers that don't need the pin).
            proxies: opts.geo ? [{ type: "browserbase", geolocation: { country: opts.geo.country, state: opts.geo.state } }] : true,
            region: "us-east-1", // co-locate near our compute; CDP RTT dominates per-action cost
            timeout: 1800, // seconds: covers the human MFA pause
        });
        console.log(`[timing] session-create: ${Date.now() - tCreate}ms`);
        const tConnect = Date.now();
        const browser = await chromium.connectOverCDP(session.connectUrl);
        const context = browser.contexts()[0];
        const page = context.pages()[0]; // Browserbase hands us the page
        // NOTE: we deliberately do NOT JS-override navigator.hardwareConcurrency /
        // deviceMemory. On a Verified browser (real, unspoofed fingerprint) a
        // defineProperty getter is itself detectable (own-property accessor + a
        // getter whose toString isn't [native code]), and nothing in the measured
        // attack surface reads these values. The viewport is set at the Browserbase
        // layer (browserSettings.viewport), which is below JS and not a tell.
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
            // fetch only rejects on network errors, so check the status ourselves
            if (!r.ok) throw new CarrierError(`Browserbase downloads list failed: ${r.status}`);
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
        // don't base64-encode an error page as if it were the PDF
        if (!r.ok) throw new CarrierError(`Browserbase download fetch failed: ${r.status}`);
        return Buffer.from(await r.arrayBuffer()).toString("base64");
    }

    // Fetch a URL from INSIDE the page, so the request rides the browser's
    // residential-proxy IP, real Chrome TLS fingerprint, and cookies, instead of
    // going out as a Node client from our datacenter IP (which anti-bot systems
    // flag). Use this for carriers' internal-API document calls. Returns the body
    // as base64 (works for JSON and binary alike). The page function is passed as
    // a string with args inlined so tsx/esbuild can't inject its `__name` helper
    // (undefined in the page context) into the evaluated function.
    async fetchInPage(
        url: string,
        opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
    ): Promise<{ status: number; contentType: string; base64: string }> {
        const init = {
            method: opts.method ?? "GET",
            headers: opts.headers ?? {},
            body: opts.body, // JSON.stringify drops this key when undefined (GET)
            credentials: "include",
        };
        const expr = `(async () => {
            const r = await fetch(${JSON.stringify(url)}, ${JSON.stringify(init)});
            const bytes = new Uint8Array(await r.arrayBuffer());
            let binary = "";
            for (let i = 0; i < bytes.length; i += 0x8000)
                binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            return { status: r.status, contentType: r.headers.get("content-type") || "", base64: btoa(binary) };
        })()`;
        return this.page.evaluate(expr) as Promise<{ status: number; contentType: string; base64: string }>;
    }

    // Given items a carrier already triggered (each a display name + the filename
    // the download produced), wait for the files to sync, pair them by filename,
    // and fetch every doc's bytes concurrently. Carriers differ in how they
    // trigger downloads; this collection tail is the same for all of them.
    async collectDocuments(items: { name: string; filename: string }[]): Promise<Document[]> {
        const want = items.filter((i) => i.filename).length;
        const tList = Date.now();
        const downloads = await this.waitForDownloads(want);
        console.log(`[timing] retrieve-list: ${Date.now() - tList}ms`);
        const byFilename = new Map(downloads.map((d) => [d.filename, d]));
        const tBytes = Date.now();
        const docs = await Promise.all(
            items.map(async (item) => {
                const meta = byFilename.get(item.filename);
                if (!meta) return null;
                return {
                    name: item.name,
                    contentType: meta.mimeType || "application/pdf",
                    bytes: await this.fetchBytes(meta.id),
                } satisfies Document;
            }),
        );
        console.log(`[timing] fetch-bytes: ${Date.now() - tBytes}ms`);
        return docs.filter((d): d is Document => d !== null);
    }

    async close(): Promise<void> {
        await this.browser.close();
    }
}

// Random delay in [0, maxMs). Used to de-synchronize parallel document fetches:
// firing N identical authenticated requests in the same millisecond is an unhuman
// cadence anti-bot systems score on, so we stagger each start by a random amount.
// Still parallel, so the batch is gated by the slowest fetch plus at most maxMs.
export function jitter(maxMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.random() * maxMs));
}

// Carriers hold an optional session (set by prepare/login). This narrows it to a
// non-optional and throws a clear typed error if a method runs before the browser
// was opened, instead of a raw TypeError from a `!` assertion.
export function requireSession(session: BrowserbaseSession | undefined): BrowserbaseSession {
    if (!session) throw new CarrierError("browser session not open; call prepare() or login() first");
    return session;
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
