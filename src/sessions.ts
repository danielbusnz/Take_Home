import { createHash } from "node:crypto";
import type { Carrier, Document, SessionState } from "./types.js";

// sessionId -> the live session. This Map is the entire "database".
// inFlight holds the current operation on this session's browser, so a second
// request for the same session can be rejected instead of driving it in parallel.
export type Session = {
    state: SessionState;
    carrier: Carrier;
    inFlight?: Promise<unknown>;
    lastActivity: number;
    // set when an authenticated session is kept alive for reuse: the reaper
    // leaves it until keepUntil, and credHash links it back to its reuseCache key.
    keepUntil?: number;
    credHash?: string;
};

export const sessions = new Map<string, Session>();

// Authenticated-session reuse (the brief rewards "runs more than once"). After a
// successful fetch we keep the validated browser alive and index it here by a
// one-way hash of the credentials, so a repeat login with the SAME credentials
// skips prepare + login-auth and just refetches on the live session. The key is
// a hash that includes the password, so a wrong password cannot reach another
// session and no credential is ever stored.
export const reuseCache = new Map<string, string>(); // credHash -> sessionId
const REUSE_TTL_MS = Number(process.env.REUSE_TTL_MS) || 8 * 60_000;

// One-way key for the reuse cache. Includes the password, so only the exact
// credentials reproduce the key; nothing reversible is kept. NUL-delimited so
// ("ab","c") and ("a","bc") can't collide.
export function credKey(carrier: string, username: string, password: string): string {
    return createHash("sha256").update(`${carrier}\0${username}\0${password}`).digest("hex");
}

// One operation at a time per session. A session owns a single live browser, so
// a second request for the same session is rejected (BusyError) rather than
// driving the browser in parallel. The lock frees on settle, success or failure.
export class BusyError extends Error { }

export function withLock<T>(session: Session, fn: () => Promise<T>): Promise<T> {
    if (session.inFlight) return Promise.reject(new BusyError());
    const op = fn();
    session.inFlight = op;
    return op.finally(() => {
        session.inFlight = undefined;
    });
}

// Fetch docs, close the browser, drop the session. Shared by both endpoints.
export async function fetchAndFinish(sessionId: string, session: Session) {
    try {
        session.state = "FETCHING_DOCS";
        const documents = await session.carrier.fetchDocuments();
        session.state = "DONE";
        return documents;
    } finally {
        // always release the browser + drop the session, even if the fetch threw
        await session.carrier.close();
        sessions.delete(sessionId);
    }
}

// Like fetchAndFinish, but KEEPS the authenticated browser alive and registers
// it for reuse instead of closing it. A repeat login with the same credentials
// (credHash) then refetches on this live session. On a fetch failure we still
// tear down (a broken session must not be cached).
export async function fetchAndKeep(sessionId: string, session: Session, credHash: string, onDoc?: (doc: Document) => void) {
    try {
        session.state = "FETCHING_DOCS";
        const documents = await session.carrier.fetchDocuments(onDoc);
        session.state = "DONE";
        session.credHash = credHash;
        session.keepUntil = Date.now() + REUSE_TTL_MS;
        session.lastActivity = Date.now();
        reuseCache.set(credHash, sessionId);
        return documents;
    } catch (e) {
        try { await session.carrier.close(); } catch { }
        sessions.delete(sessionId);
        if (reuseCache.get(credHash) === sessionId) reuseCache.delete(credHash);
        throw e;
    }
}

// Refetch on an already-authenticated, kept-alive session (reuse path). Extends
// the keep-alive window. The caller holds the lock.
export async function refetchOnWarm(session: Session, onDoc?: (doc: Document) => void) {
    session.state = "FETCHING_DOCS";
    const documents = await session.carrier.fetchDocuments(onDoc);
    session.state = "DONE";
    session.keepUntil = Date.now() + REUSE_TTL_MS;
    session.lastActivity = Date.now();
    return documents;
}

// Evict a reuse-cache entry and close its browser. Never throws.
export async function dropWarm(credHash: string) {
    const id = reuseCache.get(credHash);
    reuseCache.delete(credHash);
    if (id) await cleanup(id);
}

// Close the browser and drop the session after a failure. Never throws.
export async function cleanup(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.state = "FAILED"; // mark before teardown so the state machine is honest
    try {
        await session.carrier.close();
    } catch { }
    sessions.delete(sessionId);
}

// Reaper: close + drop sessions left idle past the TTL, so an abandoned login
// (e.g. the user closes the tab at the MFA prompt) can't leak a billed browser.
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 3 * 60_000;
const SWEEP_MS = Number(process.env.SWEEP_MS) || 30_000;

export function startReaper() {
    setInterval(() => {
        const now = Date.now();
        for (const [id, session] of sessions) {
            if (session.inFlight) continue; // mid-operation, leave it alone
            if (session.keepUntil) {
                if (now < session.keepUntil) continue; // reusable: keep the validated session alive
                if (session.credHash) reuseCache.delete(session.credHash); // expired: drop its cache entry too
                void cleanup(id);
                continue;
            }
            if (now - session.lastActivity < SESSION_TTL_MS) continue; // still fresh
            void cleanup(id); // idle too long: close the browser and drop the session
        }
    }, SWEEP_MS).unref();
}
