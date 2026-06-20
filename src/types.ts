// ---- the wire contract (shared by backend and, later, the frontend) ----

// A policy document. Usually a PDF, but not guaranteed, so we carry the real
// contentType (from the download's Content-Type header) and never hardcode it.
export type Document = {
    name: string;
    contentType: string; // MIME, e.g. "application/pdf"
    bytes: string; // base64
};

// what /login returns. gradedMs is the server-measured graded span (the document
// fetch, i.e. the MFA-submit->docs equivalent), so the UI can show the real graded
// number rather than the full login-click->screen wall time.
export type LoginResponse =
    | { status: "mfa_needed"; sessionId: string }
    | { status: "done"; sessionId: string; documents: Document[]; gradedMs: number };

// what /mfa returns. gradedMs = machine time from MFA submit to documents.
export type MfaResponse = { status: "done"; documents: Document[]; gradedMs: number };

// what any endpoint returns on failure, with a non-2xx status. Failures are
// status codes + this body, not a "failed" field on the success types.
export type ErrorResponse = { error: string };

// ---- internal session state machine ----

export type SessionState =
    | "WARMING"
    | "WARM"
    | "LOGGING_IN"
    | "AWAITING_MFA"
    | "SUBMITTING_MFA"
    | "FETCHING_DOCS"
    | "DONE"
    | "FAILED";

// ---- the plug every carrier implements ----

export interface Carrier {
    readonly name: string;
    // open the browser and load the login form, no credentials yet. Optional to
    // call ahead of login() to pre-warm while the user is still typing.
    prepare(): Promise<void>;
    // start the login. returns whether the portal then asks for an MFA code.
    login(username: string, password: string): Promise<{ mfaRequired: boolean }>;
    // type the MFA code the user received.
    submitMfa(code: string): Promise<void>;
    // pull the policy documents once logged in. onDoc, if given, is called as each
    // document's bytes arrive, so the server can stream them and the UI can paint the
    // first PDF before the slowest one finishes.
    fetchDocuments(onDoc?: (doc: Document) => void): Promise<Document[]>;
    // tear down the browser session.
    close(): Promise<void>;
}
