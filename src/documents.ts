import type { Document } from "./types.js";

export const EXPECTED_CONTENT_TYPE = "application/pdf";

export type DocumentWarning = { name: string; reason: string };

// Returns a warning if the doc looks off, else null. Never throws: a malformed
// but present document beats failing the whole fetch.
export function inspectDocument(doc: Document): DocumentWarning | null {
    if (!doc.bytes) {
        return { name: doc.name, reason: "empty body" };
    }
    if (!doc.contentType.startsWith(EXPECTED_CONTENT_TYPE)) {
        return { name: doc.name, reason: `unexpected contentType "${doc.contentType}"` };
    }
    return null;
}

// Logs suspicious docs, returns them unchanged, so scrape problems show in logs.
// Empty result is ambiguous (scrape failed vs no docs); real check is upstream
// in fetchDocuments. See assumptions.md row 9.
export function validateDocuments(carrier: string, docs: Document[]): Document[] {
    if (docs.length === 0) {
        console.warn(`[${carrier}] fetchDocuments returned 0 documents`);
    }
    for (const doc of docs) {
        const warning = inspectDocument(doc);
        if (warning) console.warn(`[${carrier}] "${warning.name}": ${warning.reason}`);
    }
    return docs;
}
