import type { Carrier, Document } from "../types.js";
import { validateDocuments } from "../documents.js";
import { InvalidCredentialsError, InvalidMfaError, DocumentsUnavailableError } from "../errors.js";

// Fake carrier for building and testing the full flow without a real portal.
// It can't read a page, so it picks the outcome from the username:
//   "baduser" -> bad credentials
//   "nomfa"   -> logs in with no MFA step
//   "docfail" -> logs in with no MFA, then fails fetching documents
//   anything else -> needs MFA, accepts code "123456"
const VALID_CODE = "123456";

const SAMPLE_PDF = "JVBERi0xLjAKJcK1"; // tiny base64 stub, stands in for a real PDF

export class MockCarrier implements Carrier {
    readonly name = "mock";
    private loggedIn = false;
    private failDocs = false;

    async prepare(): Promise<void> {
        // no real browser to warm
    }

    async login(username: string, _password: string): Promise<{ mfaRequired: boolean }> {
        if (username === "baduser") throw new InvalidCredentialsError("bad username or password");
        if (username === "docfail") {
            this.loggedIn = true;
            this.failDocs = true;
            return { mfaRequired: false };
        }
        if (username === "nomfa") {
            this.loggedIn = true;
            return { mfaRequired: false };
        }
        return { mfaRequired: true };
    }

    async submitMfa(code: string): Promise<void> {
        if (code !== VALID_CODE) throw new InvalidMfaError("wrong or expired code");
        this.loggedIn = true;
    }

    async fetchDocuments(): Promise<Document[]> {
        if (this.failDocs) throw new DocumentsUnavailableError("simulated document fetch failure");
        const docs: Document[] = [
            { name: "declarations.pdf", contentType: "application/pdf", bytes: SAMPLE_PDF },
        ];
        return validateDocuments(this.name, docs);
    }

    async close(): Promise<void> {
        this.loggedIn = false;
    }
}
