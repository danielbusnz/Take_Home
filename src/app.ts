import express, { type ErrorRequestHandler } from "express";
import { randomUUID } from "node:crypto";
import type { LoginResponse, MfaResponse } from "./types.js";
import { carriers } from "./carriers/registry.js";
import {
    type Session,
    sessions,
    BusyError,
    withLock,
    fetchAndFinish,
    cleanup,
} from "./sessions.js";
import { requireStrings, sendError } from "./http.js";
import { InvalidMfaError } from "./errors.js";

// Builds the Express app and its routes. No side effects (no listen, no reaper)
// so tests can import and drive it; server.ts wires up startup separately.
export const app = express();
app.use(express.json());
app.use(express.static("public")); // serve the static frontend

// list the carriers the frontend can offer (single source: the registry)
app.get("/carriers", (_req, res) => res.json({ carriers: Object.keys(carriers) }));

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

    try {
        // hold the lock for the whole login so a double-submit is rejected (409)
        // and the reaper can't close the browser mid-login
        const result = await withLock(session, async () => {
            const { mfaRequired } = await session.carrier.login(username, password);
            if (mfaRequired) {
                session.state = "AWAITING_MFA";
                return { status: "mfa_needed", sessionId } satisfies LoginResponse;
            }
            // trusted device, no MFA: go straight to documents
            const tGraded = Date.now();
            const documents = await fetchAndFinish(sessionId, session);
            console.log(`[timing] GRADED login->docs (no mfa): ${Date.now() - tGraded}ms`);
            return { status: "done", sessionId, documents } satisfies LoginResponse;
        });
        return res.json(result);
    } catch (e) {
        if (e instanceof BusyError) return res.status(409).json({ error: "session is busy, retry shortly" });
        await cleanup(sessionId);
        return sendError(res, e);
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
        const documents = await withLock(session, async () => {
            session.state = "SUBMITTING_MFA";
            await session.carrier.submitMfa(code);
            return fetchAndFinish(sessionId, session);
        });
        console.log(`[timing] GRADED mfa-submit->docs: ${Date.now() - tGraded}ms`);
        return res.json({ status: "done", documents } satisfies MfaResponse);
    } catch (e) {
        if (e instanceof BusyError) return res.status(409).json({ error: "session is busy, retry shortly" });
        // a wrong/expired code is recoverable: rewind to AWAITING_MFA and keep the
        // session so the user can retry, instead of tearing the whole login down.
        if (e instanceof InvalidMfaError) {
            session.state = "AWAITING_MFA";
            return sendError(res, e); // maps to 401
        }
        await cleanup(sessionId);
        return sendError(res, e);
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
