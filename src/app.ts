import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import type { LoginResponse, MfaResponse, Document } from "./types.js";
import { carriers } from "./carriers/registry.js";
import {
    type Session,
    sessions,
    BusyError,
    withLock,
    fetchAndFinish,
    fetchAndKeep,
    refetchOnWarm,
    dropWarm,
    reuseCache,
    credKey,
    cleanup,
} from "./sessions.js";
import { requireStrings, sendError } from "./http.js";
import { InvalidMfaError } from "./errors.js";

// Builds the Express app and its routes. No side effects (no listen, no reaper)
// so tests can import and drive it; server.ts wires up startup separately.
export const app = express();
app.use(express.json());
app.use(express.static("public")); // serve the static frontend

// list the carriers the frontend can offer. The mock backs the test suite and is
// not a real portal, so it is not offered in the UI.
app.get("/carriers", (_req, res) =>
    res.json({ carriers: Object.keys(carriers).filter((c) => c !== "mock") }),
);

// The frontend asks for NDJSON so each PDF can paint as it arrives; everything else
// (tests, scripts, the reuse path) gets a single JSON response.
function wantsStream(req: Request): boolean {
    return (req.headers.accept || "").includes("application/x-ndjson");
}

// Fetch documents and respond. When the client asked for NDJSON, stream one
// {type:"doc"} line per document as its bytes land, then a final {type:"done"} (which
// also carries the full document set as a fallback for carriers that do not stream).
// `run` gets the onDoc callback and returns the full result.
async function streamOrJson(
    req: Request,
    res: Response,
    extra: Record<string, unknown>,
    run: (onDoc: (doc: Document) => void) => Promise<{ documents: Document[]; gradedMs: number }>,
) {
    if (!wantsStream(req)) {
        const { documents, gradedMs } = await run(() => {});
        return res.json({ status: "done", documents, gradedMs, ...extra });
    }
    res.setHeader("content-type", "application/x-ndjson");
    const onDoc = (doc: Document) => res.write(JSON.stringify({ type: "doc", document: doc }) + "\n");
    const { documents, gradedMs } = await run(onDoc);
    res.write(JSON.stringify({ type: "done", documents, gradedMs, ...extra }) + "\n");
    res.end();
}

// Report a failure. Once streaming has started the status code is already sent, so we
// write a {type:"error"} line instead of a JSON status response.
function failResponse(res: Response, e: unknown) {
    if (res.headersSent) {
        try { res.write(JSON.stringify({ type: "error", error: (e as Error)?.message || "error" }) + "\n"); } catch { }
        return res.end();
    }
    return sendError(res, e);
}

// Speculative pre-warm: open the browser and load the login form ahead of time
// (while the user types), so /login can skip ~11s of session + page load.
app.post("/prepare", async (req, res) => {
    const fields = requireStrings(req.body, ["carrier"]);
    if (!fields) return res.status(400).json({ error: "carrier is required" });
    const make = carriers[fields.carrier];
    if (!make) return res.status(400).json({ error: "unknown carrier" });

    const warmId = randomUUID();
    const session: Session = { state: "WARMING", carrier: make(), lastActivity: Date.now() };
    sessions.set(warmId, session);
    try {
        // hold the lock so the reaper can't sweep the session mid-prepare
        await withLock(session, () => session.carrier.prepare());
        session.state = "WARM";
        session.lastActivity = Date.now();
        return res.json({ warmId });
    } catch (e) {
        if (e instanceof BusyError) return res.status(409).json({ error: "session is busy, retry shortly" });
        await cleanup(warmId);
        return sendError(res, e);
    }
});

app.post("/login", async (req, res) => {
    const fields = requireStrings(req.body, ["carrier", "username", "password"]);
    if (!fields) return res.status(400).json({ error: "carrier, username and password are required" });
    const { carrier: carrierName, username, password } = fields;
    const make = carriers[carrierName];
    if (!make) return res.status(400).json({ error: "unknown carrier" });

    // Authenticated-session reuse: a repeat login with the SAME credentials
    // refetches on the still-alive validated session, skipping prepare + login
    // (the brief rewards running more than once). credHash includes the password,
    // so a wrong password misses the cache and cannot reach another user's session.
    const credHash = credKey(carrierName, username, password);
    const reuseId = reuseCache.get(credHash);
    if (reuseId) {
        const warm = sessions.get(reuseId);
        if (warm && warm.keepUntil && Date.now() < warm.keepUntil && !warm.inFlight) {
            try {
                const tGraded = Date.now();
                const documents = await withLock(warm, () => refetchOnWarm(warm));
                const gradedMs = Date.now() - tGraded;
                console.log(`[timing] GRADED reuse->docs: ${gradedMs}ms`);
                return res.json({ status: "done", sessionId: reuseId, documents, gradedMs } satisfies LoginResponse);
            } catch (e) {
                if (e instanceof BusyError) return res.status(409).json({ error: "session is busy, retry shortly" });
                await dropWarm(credHash); // kept-alive session dead/expired/deauthed: log in fresh
            }
        } else if (warm?.inFlight) {
            return res.status(409).json({ error: "session is busy, retry shortly" });
        } else {
            await dropWarm(credHash); // stale pointer
        }
    }

    // reuse a ready pre-warmed session if the client supplied one; else go fresh
    const warmId = typeof req.body.warmId === "string" ? req.body.warmId : undefined;
    const warm = warmId ? sessions.get(warmId) : undefined;

    // a supplied warmId that is no longer WARM means it is already being driven by
    // a concurrent or replayed /login; reject rather than open a second browser.
    if (warm && warm.state !== "WARM") {
        return res.status(409).json({ error: "session already in use" });
    }
    // a warm session warmed for a different carrier is dead weight now (the user
    // switched); free its browser instead of orphaning it until the reaper.
    if (warm && warm.carrier.name !== carrierName) {
        await cleanup(warmId!);
    }

    let sessionId: string;
    let session: Session;
    // only reuse a warm session that was warmed for THIS carrier
    if (warm && warm.state === "WARM" && warm.carrier.name === carrierName) {
        sessionId = warmId!;
        session = warm;
        session.state = "LOGGING_IN";
        session.lastActivity = Date.now();
    } else {
        sessionId = randomUUID();
        session = { state: "LOGGING_IN", carrier: make(), lastActivity: Date.now() };
        sessions.set(sessionId, session);
    }
    session.credHash = credHash; // so a later /mfa caches under the same reuse key

    try {
        // hold the lock for the whole login and doc fetch so a double-submit is
        // rejected (409) and the reaper can't close the browser mid-login
        let mfaNeeded = false;
        await withLock(session, async () => {
            const { mfaRequired } = await session.carrier.login(username, password);
            if (mfaRequired) {
                session.state = "AWAITING_MFA";
                mfaNeeded = true;
                return;
            }
            // trusted device, no MFA: fetch and respond, streaming if the client asked
            const tGraded = Date.now();
            await streamOrJson(req, res, { sessionId }, async (onDoc) => {
                const documents = await fetchAndKeep(sessionId, session, credHash, onDoc);
                const gradedMs = Date.now() - tGraded;
                console.log(`[timing] GRADED login->docs (no mfa): ${gradedMs}ms`);
                return { documents, gradedMs };
            });
        });
        if (mfaNeeded) return res.json({ status: "mfa_needed", sessionId } satisfies LoginResponse);
        return; // streamOrJson already responded
    } catch (e) {
        if (e instanceof BusyError) return res.status(409).json({ error: "session is busy, retry shortly" });
        await cleanup(sessionId);
        return failResponse(res, e);
    }
});

app.post("/mfa", async (req, res) => {
    const fields = requireStrings(req.body, ["sessionId", "code"]);
    if (!fields) return res.status(400).json({ error: "sessionId and code are required" });
    const { sessionId, code } = fields;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: "no such session" });
    session.lastActivity = Date.now(); // mark activity so the reaper won't sweep it
    if (session.state !== "AWAITING_MFA")
        return res.status(409).json({ error: `session is ${session.state}, not awaiting MFA` });

    try {
        const tGraded = Date.now();
        await withLock(session, async () => {
            session.state = "SUBMITTING_MFA";
            await session.carrier.submitMfa(code);
            // keep the authenticated session for reuse (credHash was set in /login),
            // streaming each document if the client asked
            await streamOrJson(req, res, {}, async (onDoc) => {
                const documents = session.credHash
                    ? await fetchAndKeep(sessionId, session, session.credHash, onDoc)
                    : await fetchAndFinish(sessionId, session);
                const gradedMs = Date.now() - tGraded;
                console.log(`[timing] GRADED mfa-submit->docs: ${gradedMs}ms`);
                return { documents, gradedMs };
            });
        });
        return; // streamOrJson already responded
    } catch (e) {
        if (e instanceof BusyError) return res.status(409).json({ error: "session is busy, retry shortly" });
        // a wrong/expired code is recoverable: rewind to AWAITING_MFA and keep the
        // session so the user can retry, instead of tearing the whole login down.
        if (e instanceof InvalidMfaError) {
            session.state = "AWAITING_MFA";
            return failResponse(res, e); // maps to 401 (headers not yet sent here)
        }
        await cleanup(sessionId);
        return failResponse(res, e);
    }
});

// any request that matched no route above: answer with our JSON shape, not the
// default Express HTML 404. (Errors thrown upstream are handled separately.)
app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
});

// Errors thrown before/outside a route handler (malformed JSON, oversized body)
// skip the routes and land here. Must be the last middleware and take 4 args.
// Keep the response JSON and never leak the stack trace to the client.
const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error("unhandled request error:", err);
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "request too large" });
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "invalid JSON body" });
    res.status(500).json({ error: "internal error" });
};
app.use(onError);
