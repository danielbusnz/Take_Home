// Passive anti-bot fingerprint: ONE residential page load per carrier, observe
// what they serve every visitor (cookies, headers, script hosts, JS globals).
// No interaction, no provocation.
//   ! node --env-file=.env --import tsx scripts/antibot-probe.ts <loginUrl>
import { chromium } from "playwright";
import Browserbase from "@browserbasehq/sdk";

const url = process.argv[2];
if (!url) throw new Error("pass the login URL as the first arg");

// cookie-name -> vendor
const COOKIE_SIGS: [RegExp, string][] = [
  [/^_abck$|^bm_sz$|^ak_bmsc$|^bm_mi$|^bm_sv$/, "Akamai Bot Manager"],
  [/^datadome$/, "DataDome"],
  [/^_px|^_pxhd$|^_pxvid$/, "PerimeterX / HUMAN"],
  [/^KP_UIDz/, "Kasada"],
  [/^__cf_bm$|^cf_clearance$/, "Cloudflare Bot Mgmt"],
  [/^incap_ses|^visid_incap/, "Imperva / Incapsula"],
];
// request-host substring -> vendor
const HOST_SIGS: [RegExp, string][] = [
  [/datadome\.co/, "DataDome"],
  [/perimeterx|px-cdn|\/px\//, "PerimeterX / HUMAN"],
  [/kasada/, "Kasada"],
  [/hcaptcha\.com/, "hCaptcha (challenge)"],
  [/recaptcha|gstatic\.com\/recaptcha/, "reCAPTCHA (challenge)"],
  [/imperva|incapsula/, "Imperva"],
];

const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY! });
const session = await bb.sessions.create({
  projectId: process.env.BROWSERBASE_PROJECT_ID!,
  proxies: true,
  region: "us-east-1",
  timeout: 120,
});
const browser = await chromium.connectOverCDP(session.connectUrl);
const ctx = browser.contexts()[0];
const page = ctx.pages()[0];

const hosts = new Set<string>();
page.on("request", (r) => {
  try {
    hosts.add(new URL(r.url()).host);
  } catch {}
});
let docHeaders: Record<string, string> = {};
page.on("response", (r) => {
  if (r.url().split("?")[0] === url.split("?")[0]) docHeaders = r.headers();
});

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000); // let sensor scripts load + set cookies

// 1. cookies
const cookies = await ctx.cookies();
const cookieNames = cookies.map((c) => c.name);
console.log("\n=== COOKIES (" + cookieNames.length + ") ===");
console.log(cookieNames.join(", "));

// 2. document response headers of interest
console.log("\n=== DOC HEADERS (security-ish) ===");
for (const [k, v] of Object.entries(docHeaders)) {
  if (/server|akamai|datadome|kpsdk|cf-|x-frame|content-security|set-cookie|via/i.test(k)) {
    console.log(`  ${k}: ${v.slice(0, 120)}`);
  }
}

// 3. read-only JS globals that vendors expose
const globals = await page.evaluate(() => {
  const w = window as any;
  return {
    bmak: typeof w.bmak !== "undefined", // Akamai
    _px: Object.keys(w).filter((k) => /^_px/i.test(k)),
    datadome: typeof w.DataDome !== "undefined" || typeof w.dd !== "undefined",
    kpsdk: typeof w.KPSDK !== "undefined" || typeof w.kpsdk !== "undefined",
    reCaptcha: typeof w.grecaptcha !== "undefined",
    hcaptcha: typeof w.hcaptcha !== "undefined",
  };
});
console.log("\n=== JS GLOBALS ===");
console.log(globals);

// 4. third-party hosts
console.log("\n=== REQUEST HOSTS (" + hosts.size + ") ===");
console.log([...hosts].sort().join("\n"));

// 5. verdict
const hits = new Set<string>();
for (const c of cookieNames) for (const [re, v] of COOKIE_SIGS) if (re.test(c)) hits.add(v + " (cookie " + c + ")");
for (const h of hosts) for (const [re, v] of HOST_SIGS) if (re.test(h)) hits.add(v + " (host " + h + ")");
if (globals.bmak) hits.add("Akamai Bot Manager (window.bmak)");
console.log("\n=== VENDOR SIGNALS ===");
console.log(hits.size ? [...hits].join("\n") : "no known signatures matched (could be Shape/F5 or first-party)");

await browser.close();
process.exit(0);
