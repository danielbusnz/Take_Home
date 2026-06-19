import type { Carrier, Document } from "../types.js";
import { validateDocuments } from "../documents.js";
import { InvalidCredentialsError, InvalidMfaError } from "../errors.js";

// Fake carrier for building and testing the full flow without a real portal.
// It can't read a page, so it picks the outcome from the username:
//   "baduser" -> bad credentials
//   "nomfa"   -> logs in with no MFA step
//   anything else -> needs MFA, accepts code "123456"
const VALID_CODE = "123456";

const SAMPLE_PDF = "JVBERi0xLjAKJcK1"; // tiny base64 stub, stands in for a real PDF

export class MockCarrier implements Carrier {
  readonly name = "mock";
  private loggedIn = false;

  async login(username: string, _password: string): Promise<{ mfaRequired: boolean }> {
    if (username === "baduser") throw new InvalidCredentialsError("bad username or password");
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
    const docs: Document[] = [
      { name: "declarations.pdf", contentType: "application/pdf", bytes: SAMPLE_PDF },
    ];
    return validateDocuments(this.name, docs);
  }

  async close(): Promise<void> {
    this.loggedIn = false;
  }
}
