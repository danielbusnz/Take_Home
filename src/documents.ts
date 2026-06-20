import type { Document } from "./types.js";
import { DocumentsUnavailableError } from "./errors.js";

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

// Throws if the scrape produced nothing: these carriers always have >=1 document,
// so an empty result means the fetch broke, not that the user has none. A silent
// empty "success" is the worst failure for a tool whose job is pulling documents.
// Otherwise logs suspicious-but-present docs and returns them.
export function validateDocuments(carrier: string, docs: Document[]): Document[] {
    if (docs.length === 0) {
        throw new DocumentsUnavailableError(`${carrier}: no documents were retrieved`);
    }
    for (const doc of docs) {
        const warning = inspectDocument(doc);
        if (warning) console.warn(`[${carrier}] "${warning.name}": ${warning.reason}`);
    }
    return docs;
}
