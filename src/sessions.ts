import type { Carrier, SessionState } from "./types.js";

// sessionId -> the live session. This Map is the entire "database".
// inFlight holds the current operation on this session's browser, so a second
// request for the same session can be rejected instead of driving it in parallel.
export type Session = {
    state: SessionState;
    carrier: Carrier;
    inFlight?: Promise<unknown>;
    lastActivity: number;
};

export const sessions = new Map<string, Session>();

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
    session.state = "FETCHING_DOCS";
    const documents = await session.carrier.fetchDocuments();
    session.state = "DONE";
    await session.carrier.close();
    sessions.delete(sessionId);
    return documents;
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
            if (now - session.lastActivity < SESSION_TTL_MS) continue; // still fresh
            void cleanup(id); // idle too long: close the browser and drop the session
        }
    }, SWEEP_MS).unref();
}
