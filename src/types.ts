// ---- the wire contract (shared by backend and, later, the frontend) ----

// A policy document. Usually a PDF, but not guaranteed, so we carry the real
// contentType (from the download's Content-Type header) and never hardcode it.
export type Document = {
    name: string;
    contentType: string; // MIME, e.g. "application/pdf"
    bytes: string; // base64
};

// what /login returns
export type LoginResponse =
    | { status: "mfa_needed"; sessionId: string }
    | { status: "done"; sessionId: string; documents: Document[] };

// what /mfa returns
export type MfaResponse = { status: "done"; documents: Document[] };

// what any endpoint returns on failure, with a non-2xx status. Failures are
// status codes + this body, not a "failed" field on the success types.
export type ErrorResponse = { error: string };

// ---- internal session state machine ----

export type SessionState =
    | "LOGGING_IN"
    | "AWAITING_MFA"
    | "SUBMITTING_MFA"
    | "FETCHING_DOCS"
    | "DONE"
    | "FAILED";

// ---- the plug every carrier implements ----

export interface Carrier {
    readonly name: string;
    // start the login. returns whether the portal then asks for an MFA code.
    login(username: string, password: string): Promise<{ mfaRequired: boolean }>;
    // type the MFA code the user received.
    submitMfa(code: string): Promise<void>;
    // pull the policy documents once logged in.
    fetchDocuments(): Promise<Document[]>;
    // tear down the browser session.
    close(): Promise<void>;
}
