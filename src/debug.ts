// Opt-in carrier instrumentation, enabled with ALLSTATE_DEBUG=1. Off by default.
// Used to profile the live full-API doc fetch from prod: a redacted network sniff
// of the document phase plus per-call timing. Secrets are never logged: request
// headers (cookie / xsrf) are skipped entirely, and bodies are redacted.
import type { Page } from "playwright";

export const DEBUG = !!process.env.ALLSTATE_DEBUG;

// Best-effort redaction for anything we print. On prod the Allstate creds arrive
// in the request body (not env), so the password regex is the backstop; we also
// collapse long token/base64 blobs and long digit runs (policy numbers).
const ENV_SECRETS = [process.env.ALLSTATE_PASSWORD, process.env.ALLSTATE_USER].filter(Boolean) as string[];
export function redact(s: string): string {
  let out = s;
  for (const sec of ENV_SECRETS) out = out.split(sec).join("[REDACTED]");
  out = out.replace(/("?password"?\s*[:=]\s*"?)[^"&,}\s]+/gi, "$1[REDACTED]");
  out = out.replace(/[A-Za-z0-9+/=_-]{60,}/g, (m) => `<blob ${m.length}b>`);
  out = out.replace(/\b\d{8,}\b/g, "<num>");
  return out;
}

export function dlog(...args: unknown[]): void {
  if (DEBUG) console.log("[allstate-debug]", ...args);
}

// Time an async step; transparent (no overhead, no logging) when DEBUG is off.
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!DEBUG) return fn();
  const t = Date.now();
  try {
    return await fn();
  } finally {
    console.log(`[allstate-debug] STEP ${label.padEnd(34)} ${Date.now() - t}ms`);
  }
}

// Redacted request/response logger for allstate.com traffic. Call it at the start
// of the document phase (after login) so the password never passes through here.
export function installNetSniff(page: Page): void {
  if (!DEBUG) return;
  const API = /\/api\/secured\//;
  page.on("request", (req) => {
    const u = req.url();
    if (!u.includes("allstate.com")) return;
    if (API.test(u)) {
      console.log(`[net] >>> ${req.method()} ${u}`);
      const pd = req.postData();
      if (pd) console.log(`[net]     body: ${redact(pd).slice(0, 300)}`);
    } else {
      console.log(`[net] >>> ${req.method()} ${new URL(u).pathname}`);
    }
  });
  page.on("response", async (r) => {
    const u = r.url();
    if (!u.includes("allstate.com")) return;
    if (API.test(u)) {
      const ct = r.headers()["content-type"] || "";
      let body = "";
      if (/json/i.test(ct)) {
        try {
          body = redact(await r.text()).slice(0, 500);
        } catch {}
      }
      console.log(`[net] <<< ${r.status()} ${u} ct=${ct.slice(0, 30)} body=${body}`);
    } else {
      console.log(`[net] <<< ${r.status()} ${new URL(u).pathname}`);
    }
  });
}
