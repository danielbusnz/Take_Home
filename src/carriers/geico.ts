import type { Carrier, Document } from "../types.js";
import { InvalidCredentialsError, InvalidMfaError, DocumentsUnavailableError } from "../errors.js";
import { validateDocuments } from "../documents.js";
import { BrowserbaseSession, step, requireSession, jitter } from "../browserbase.js";

const LOGIN_URL = process.env.GEICO_LOGIN_URL ?? "https://manage.myassurantpolicy.com/app/login";
// Derive the API origin from the login URL so the fast-path API calls track the
// same host as the rest of the carrier (e.g. a staging GEICO_LOGIN_URL points
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

// Floored stagger for the parallel doc fetches. The shared jitter() returns a
// delay in [0, max), so two concurrent fetches can still both draw a near-0ms
// delay and land in the same millisecond — a same-instant authenticated-XHR
// burst is exactly the unhuman cadence we are trying to avoid. This guarantees
// each fetch waits at least `floorMs` before firing, so every parallel request
// has a real, non-zero offset while the batch stays gated by floorMs + rangeMs.
function stagger(floorMs: number, rangeMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, floorMs + Math.random() * rangeMs));
}

// Full REN is "REN" + 11 digits (e.g. REN12345678901). The short 7-digit form
// (REN1234567, shown as selection-page text) is not what the document API uses;
// we require >= 10 digits after the prefix to keep only the full form.
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
                    // Could be "REN12345678901" or "12345678901" (bare digits)
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

    // 3. Last-ditch regex pass: find a standalone bare-digit run of full-REN length
    //    and prefix it. Scoped tightly to avoid matching a >=10-digit run that is
    //    part of a larger alphanumeric token (a DocId, a base64 chunk, etc.): the
    //    run must be flanked by a non-alphanumeric boundary on BOTH sides, not just
    //    a word boundary (which \d already satisfies against adjacent letters).
    //    Pass 1 (literal REN<digits>) wins on this endpoint in practice; this is a
    //    defensive fallback only.
    const bareMatch = raw.match(/(?<![A-Za-z0-9])(\d{10,})(?![A-Za-z0-9])/);
    if (bareMatch) {
        const candidate = `REN${bareMatch[1]}`;
        if (FULL_REN_RE.test(candidate)) return candidate;
    }

    return null;
}

// Shape of each item in the /api/Policies/{ren}/Documents?lob=RI response array.
// DocId is the token source for per-doc download URLs (no crypto, no extra render).
// The list JSON is untrusted, so every field except the DocId we read is marked
// optional to match the defensive runtime handling below (name falls back through
// DocumentTitle -> DocumentType -> "Document").
interface GeicoDocumentItem {
    DocId: string;
    DocumentTitle?: string;
    DocumentType?: string;
    MimeType?: string;
    ContentSize?: number;
}

// Geico renters insurance, serviced through Assurant's portal
// (manage.myassurantpolicy.com). Auth is an embedded Okta widget:
// inputs #okta-signin-username / #okta-signin-password, submit #okta-signin-submit.
// MFA is an Okta SMS code into input[name=answer]. After login the account lands
// on /app/policy/selection; documents live on the server-rendered /Policy/Documents.
// Shared Browserbase plumbing (session + downloads) lives in BrowserbaseSession.
export class GeicoCarrier implements Carrier {
    readonly name = "geico";
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
        await step(page, "geico login-form", () =>
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

    async fetchDocuments(onDoc?: (doc: Document) => void): Promise<Document[]> {
        const session = requireSession(this.session);
        const page = session.page;

        // ------------------------------------------------------------------ //
        // FAST PATH                                                            //
        //                                                                      //
        // All traffic goes through session.fetchInPage so requests ride the   //
        // browser's residential-proxy IP, real Chrome TLS, and live cookies   //
        // instead of going out as datacenter Node.js requests that Cloudflare //
        // would score differently.                                             //
        //                                                                      //
        // Happy path (no networkidle waits):                                   //
        //   1. GET /api/PolicyId -> full REN                                   //
        //   2. GET /api/Policies/{ren}/Documents?lob=RI -> doc list            //
        //   3. Parallel: one GET per listed doc (documentToken=DocId)          //
        //                                                                      //
        // Conditional activate: only click the policy row and wait for the     //
        // snapshot URL when step 1 or 2 fails/returns empty. Keeps the happy  //
        // path from paying the ~1s activate cost unnecessarily.                //
        // ------------------------------------------------------------------ //

        const tFastPath = Date.now();

        // ---- Step 1: fetch /api/PolicyId to get the full REN. ----
        // Try from the current page first (may already be active on /snapshot,
        // or on a single-policy account that auto-activates).
        const tPolicyId = Date.now();
        let ren: string | null = null;

        const tryPolicyId = async (): Promise<void> => {
            try {
                const res = await session.fetchInPage(`${ORIGIN}/api/PolicyId`, {
                    headers: { referer: page.url() },
                });
                const body = Buffer.from(res.base64, "base64").toString("utf8");
                console.log(`[timing] policyid: ${Date.now() - tPolicyId}ms (status=${res.status})`);
                if (res.status < 400) ren = extractRen(body);
                if (!ren) console.log(`[timing] policyid-no-ren: could not extract full REN`);
            } catch (e) {
                console.log(`[timing] policyid-error: ${(e as Error).message}`);
            }
        };

        await tryPolicyId();

        // ---- Conditional activate: only when the first PolicyId call gave no REN. ----
        // Navigate selection -> snapshot so the server marks the policy active.
        // No networkidle: waitForURL is enough to know the SPA has transitioned.
        if (!ren && /selection/i.test(page.url())) {
            console.log(`[timing] fast-path-activate: clicking policy row`);
            try {
                await page.getByText(/REN\d+/i).first().click();
                await page.waitForURL(/snapshot/, { timeout: STEP_TIMEOUT });
            } catch (e) {
                console.log(`[timing] fast-path-activate-error: ${(e as Error).message}`);
            }
            // retry after activate
            await jitter(300);
            await tryPolicyId();
        }

        // ---- Step 2: fetch the document list. ----
        // The list JSON lives under the "Documents" key; each item carries DocId
        // (the token source), DocumentTitle, MimeType, etc.
        let docItems: GeicoDocumentItem[] = [];
        if (ren) {
            const tList = Date.now();
            try {
                const listRes = await session.fetchInPage(
                    `${ORIGIN}/api/Policies/${ren}/Documents?lob=RI`,
                    { headers: { referer: page.url() } },
                );
                const listBody = Buffer.from(listRes.base64, "base64").toString("utf8");
                console.log(`[timing] list: ${Date.now() - tList}ms (status=${listRes.status})`);
                if (listRes.status < 400) {
                    const parsed: unknown = JSON.parse(listBody);
                    if (parsed && typeof parsed === "object" && "Documents" in parsed) {
                        const raw = (parsed as Record<string, unknown>)["Documents"];
                        if (Array.isArray(raw)) docItems = raw as GeicoDocumentItem[];
                    }
                }
                console.log(`[timing] list-count: ${docItems.length} item(s)`);
            } catch (e) {
                console.log(`[timing] list-error: ${(e as Error).message}`);
            }
        }

        // ---- Step 3: parallel fetch of all listed documents. ----
        // Each fetch is preceded by a floored, per-index stagger (see stagger())
        // so parallel authenticated XHRs never share a start instant (a same-
        // millisecond burst is an unhuman cadence). The batch is still gated by
        // the slowest fetch plus the largest stagger offset (low, ~hundreds of ms).
        if (ren) {
            // Capture ren as a const so TypeScript narrows it to `string` inside
            // async closures (the outer `let ren` is still `string | null` to the
            // compiler even after the if-guard).
            const activeRen: string = ren;
            const tDocsFetch = Date.now();
            const currentUrl = page.url();

            // Build one promise per listed document (documentToken = encodeURIComponent(DocId)).
            // Each index gets a guaranteed-distinct minimum offset (i * floor) on top
            // of a random tail, so even concurrent fetches never share a start instant.
            const listedFetches = docItems.map(async (item, i): Promise<Document | null> => {
                // Skip a malformed list entry with no DocId: it cannot produce a token.
                if (!item || typeof item.DocId !== "string" || !item.DocId) {
                    console.log(`[timing] doc-skip: list item ${i} missing DocId`);
                    return null;
                }
                await stagger(80 * i, 220);
                const url =
                    `${ORIGIN}/api/Policies/${activeRen}/Document` +
                    `?documentToken=${encodeURIComponent(item.DocId)}&lob=RI`;
                try {
                    const res = await session.fetchInPage(url, {
                        headers: { accept: "application/pdf,*/*", referer: currentUrl },
                    });
                    if (res.status >= 400 || !/pdf|octet-stream/i.test(res.contentType)) {
                        console.log(`[timing] doc-skip: "${item.DocumentTitle}" status=${res.status} ct="${res.contentType}"`);
                        return null;
                    }
                    const doc = {
                        name: item.DocumentTitle || item.DocumentType || "Document",
                        contentType: res.contentType,
                        bytes: res.base64,
                    } satisfies Document;
                    onDoc?.(doc); // stream this PDF the moment its bytes land
                    return doc;
                } catch (e) {
                    console.log(`[timing] doc-error: "${item.DocumentTitle}" ${(e as Error).message}`);
                    return null;
                }
            });

            const results = await Promise.all(listedFetches);
            console.log(`[timing] docs-fetch (parallel): ${Date.now() - tDocsFetch}ms`);

            const docs = results.filter((d): d is Document => d !== null);
            console.log(`[timing] fast-path total: ${Date.now() - tFastPath}ms (${docs.length} doc(s))`);

            if (docs.length > 0) {
                return validateDocuments(this.name, docs);
            }
        }

        console.log(`[timing] fast-path-miss: ${Date.now() - tFastPath}ms — falling back to download path`);

        // ------------------------------------------------------------------ //
        // FALLBACK: full nav -> trigger downloads -> collectDocuments          //
        //                                                                      //
        // Reaches the documents page and clicks the policy-document controls.  //
        // We target the documents-list entries only: the "Declarations Page"   //
        // rows carry a 'documentToken' href, which the old /download/i         //
        // selector silently skipped. The Confirmation of Coverage is a         //
        // separate proof-of-coverage letter, not a policy document, so it is   //
        // intentionally not pulled.                                            //
        // ------------------------------------------------------------------ //

        const tNav = Date.now();
        // we land on the policy-selection list; open the policy to set it active
        // server-side (the snapshot is what /Policy/Documents resolves against).
        if (/selection/i.test(page.url())) {
            await page.getByText(/REN\d+/i).first().click();
            await page.waitForURL(/snapshot/, { timeout: STEP_TIMEOUT }).catch(() => {});
        }
        // reach documents the way the UI does: the snapshot's "view policy
        // documents" card. Wait for the "Policy Documents" HEADING, not the URL —
        // the portal's SPA renders the docs view without the URL matching
        // /Policy/Documents, so a URL wait times out even though the page loaded fine.
        await step(page, "geico nav-docs", async () => {
            await page.getByText(/view policy documents|need proof of insurance/i).first().click();
            await page.getByRole("heading", { name: /policy documents/i }).waitFor({ timeout: STEP_TIMEOUT });
        });
        console.log(`[timing] nav-docs: ${Date.now() - tNav}ms`);

        // Target the policy-document controls (the documents-list entries):
        //   - anchors whose href contains 'documentToken' (the doc table rows,
        //     labeled "Declarations Page" or similar)
        //   - links whose text matches /declaration|policy document/i
        const tClicks = Date.now();
        const triggers = page
            .locator('a[href*="documentToken"]')
            .or(page.getByRole("link", { name: /declaration|policy document/i }));

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
        for (const doc of docs) onDoc?.(doc); // stream the fallback docs too
        return validateDocuments(this.name, docs);
    }

    async close(): Promise<void> {
        await this.session?.close();
    }
}
