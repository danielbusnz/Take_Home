// Allstate fingerprint-attack probe (HARDENED config: Verified + MA proxy).
// Pinpoints where Akamai Bot Manager + F5 fingerprint us and, crucially, tests
// whether the Akamai _abck cookie ever VALIDATES (flips off ~-1~) when we feed it
// real trusted interaction. Pre-auth/sensor focused (anonymous, low risk); the
// login submit is best-effort and does NOT require MFA.
//   ! node --env-file=.env --import tsx scripts/allstate-fp-attack-probe.ts
import { BrowserbaseSession } from "../src/browserbase.js";

const LOGIN_URL = process.env.ALLSTATE_LOGIN_URL ?? "https://myaccountrwd.allstate.com/anon/account/login";
const SECRETS = [process.env.ALLSTATE_PASSWORD, process.env.ALLSTATE_USER].filter(Boolean) as string[];
function redact(s: string): string {
  let out = s;
  for (const sec of SECRETS) out = out.split(sec).join("[REDACTED]");
  out = out.replace(/("?(password|pwd|emailAddress)"?\s*[:=]\s*"?)[^"&,}\s]+/gi, "$1[REDACTED]");
  out = out.replace(/[A-Za-z0-9+/=_-]{60,}/g, (m) => `<blob ${m.length}b>`);
  return out;
}
const T0 = Date.now();
const rel = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;

// Akamai sensor endpoints (obfuscated path + the /akam/ pixel), F5, auth.
const AKAMAI = /\/cwnbKR\/|\/akam\/|sensor_data|\/_sec\//i;
const F5 = /TSPD|BIGipServer|\/TSbd|\/TSPD/i;
const AUTH = /apiauthsvc|allstateauth|\/api\/secured|\/login|verification/i;
const NOISE = /\.(png|jpg|jpeg|gif|svg|webp|woff2?|ttf|ico)(\?|$)|datadog|demdex|omtrdc|qualtrics|adobedtm|google|gstatic|nr-data|newrelic/i;
const seenAkamai = new Set<string>();

async function run() {
  const session = await BrowserbaseSession.open();
  console.log("replay:", "https://browserbase.com/sessions/" + session.id);
  const page = session.page;
  const context = page.context();

  page.on("request", (req) => {
    const u = req.url();
    if (NOISE.test(u) || !u.includes("allstate.com")) return;
    const tag = AKAMAI.test(u) ? "AKAMAI" : AUTH.test(u) ? "AUTH" : null;
    if (!tag) return;
    if (tag === "AKAMAI") seenAkamai.add(`${req.method()} ${u.split("?")[0].replace(/\/cwnbKR\/.*/, "/cwnbKR/<obf>")}`);
    const pd = req.postData();
    console.log(`[${tag} ${rel()}] ${req.method()} ${u.split("?")[0].slice(0, 80)}${pd ? `  POST body ${pd.length}b (sensor payload)` : ""}`);
  });
  page.on("response", (r) => {
    const u = r.url();
    if (!u.includes("allstate.com") || NOISE.test(u)) return;
    const h = r.headers();
    const flags = ["server", "akamai-grn", "x-akamai-transformed", "set-cookie"].filter((k) => h[k]);
    if (AKAMAI.test(u) || /apiauthsvc|account\/login/.test(u))
      console.log(`[resp ${rel()}] ${r.status()} ${u.split("?")[0].slice(0, 70)} ${flags.filter((k) => k !== "set-cookie").map((k) => `${k}=${h[k]}`).join(" ")}`);
  });

  // Akamai/F5 cookie state, especially the _abck validation marker.
  async function botCookies(label: string) {
    const cs = await context.cookies();
    const abck = cs.find((c) => c.name === "_abck");
    const status = abck ? abck.value.split("~")[1] ?? "?" : "absent";
    const names = cs.filter((c) => /_abck|bm_sz|ak_bmsc|bm_sv|TS[0-9a-f]+|BIGip/i.test(c.name)).map((c) => c.name);
    console.log(`[BOT COOKIES @ ${label}] _abck status=${status}  (-1=UNVALIDATED, 0=validated)  | present: ${names.join(", ")}`);
  }

  async function surface(label: string) {
    const expr = `({ ua: navigator.userAgent, platform: navigator.platform, webdriver: navigator.webdriver,
      hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory,
      screen: screen.width+'x'+screen.height, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      webgl: (function(){try{var gl=document.createElement('canvas').getContext('webgl');var e=gl.getExtension('WEBGL_debug_renderer_info');return gl.getParameter(e.UNMASKED_RENDERER_WEBGL);}catch(x){return 'n/a';}})() })`;
    console.log(`\n[FINGERPRINT @ ${label}] ${JSON.stringify(await page.evaluate(expr))}`);
  }

  console.log("\n========== LOAD LOGIN PAGE (Akamai sensor fires) ==========");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.locator("#UserIDdisplay").waitFor({ timeout: 25000 });
  await page.waitForTimeout(3000);
  await surface("login page");
  await botCookies("initial load");

  console.log("\n========== FEED THE SENSOR: real trusted mouse/scroll/typing ==========");
  // Playwright input is isTrusted:true, so Akamai's sensor should accept it. This
  // is the test: does _abck validate once we generate human-like behavior?
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(200 + Math.random() * 800, 150 + Math.random() * 500, { steps: 5 });
    await page.waitForTimeout(120 + Math.random() * 200);
  }
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(500);
  await page.mouse.wheel(0, -200);
  await page.locator("#UserIDdisplay").click().catch(() => {});
  await page.waitForTimeout(400);
  await page.locator("#emailAddress").click().catch(() => {});
  await page.locator("#emailAddress").type("test@example.com", { delay: 90 }).catch(() => {});
  await page.waitForTimeout(2500); // give the sensor time to POST sensor_data
  await botCookies("after interaction");

  console.log("\n========== BEST-EFFORT LOGIN (auth-phase Akamai; no MFA) ==========");
  await page.locator("#emailAddress").fill(process.env.ALLSTATE_USER!).catch(() => {});
  await page.locator("input[type=password]:visible").fill(process.env.ALLSTATE_PASSWORD!).catch(() => {});
  await page.locator("button[name=frmButton]:visible").click().catch(() => {});
  const outcome = await Promise.race([
    page.waitForURL(/verification/, { timeout: 25000 }).then(() => "mfa"),
    page.waitForURL(/\/secured\//, { timeout: 25000 }).then(() => "dashboard"),
  ]).catch(() => "neither/error");
  console.log(">>> login outcome:", outcome, "| url:", page.url());
  await page.waitForTimeout(1500);
  await botCookies("post-submit");
  await page.screenshot({ path: "/tmp/allstate-fp.png" }).catch(() => {});

  console.log("\n========== SUMMARY ==========");
  console.log("Akamai sensor endpoints hit:", seenAkamai.size);
  for (const u of seenAkamai) console.log("  " + u);
  const srvHeader = "see [resp] lines for server/akamai headers";
  console.log("F5/server:", srvHeader);

  console.log("\ndone.");
  await session.close();
}
await run();
process.exit(0);
