import type { Response } from "express";
import {
    CarrierError,
    InvalidCredentialsError,
    InvalidMfaError,
    AntiBotError,
    CarrierTimeoutError,
    DocumentsUnavailableError,
} from "./errors.js";

// Pull required string fields off an untyped body. Returns null if any are
// missing or not a non-empty string, so handlers can answer 400 cleanly.
export function requireStrings<K extends string>(body: unknown, keys: readonly K[]): Record<K, string> | null {
    if (typeof body !== "object" || body === null) return null;
    const out = {} as Record<K, string>;
    for (const k of keys) {
        const v = (body as Record<string, unknown>)[k];
        if (typeof v !== "string" || v.trim() === "") return null;
        out[k] = v;
    }
    return out;
}

// Map a thrown error to a status code. Unknown errors are a 500.
export function sendError(res: Response, e: unknown) {
    if (e instanceof InvalidCredentialsError || e instanceof InvalidMfaError)
        return res.status(401).json({ error: e.message });
    if (e instanceof AntiBotError) return res.status(503).json({ error: e.message });
    if (e instanceof CarrierTimeoutError) return res.status(504).json({ error: e.message });
    if (e instanceof DocumentsUnavailableError) return res.status(502).json({ error: e.message });
    if (e instanceof CarrierError) return res.status(500).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: "internal error" });
}
