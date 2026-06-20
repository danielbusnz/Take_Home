// Full Assurant run with the HARDENED config (Verified + MA proxy + hw override),
// instrumented to pinpoint where Cloudflare + Okta fingerprint us. Logs:
//  - WHAT WE SHOW: the client-readable fingerprint surface (navigator/webgl/canvas/...).
//  - WHERE THEY ATTACK: categorized network traffic — Cloudflare challenge/bot JS +
//    beacons, Okta device-fingerprint/auth calls, any telemetry/sensor beacons, and
//    the bot/device cookies (tokens) they plant + from which domain.
// Secrets (creds, Okta/Bearer tokens, cookie values) are redacted.
//   ! node --env-file=.env --import tsx scripts/assurant-fp-attack-probe.ts
import { BrowserbaseSession } from "../src/browserbase.js";
import { existsSync, readFileSync, rmSync } from "node:fs";

const LOGIN_URL = process.env.ASSURANT_LOGIN_URL ?? "https://manage.myassurantpolicy.com/app/login";
const SECRETS = [process.env.ASSURANT_PASSWORD, process.env.ASSURANT_USER].filter(Boolean) as string[];
function redact(s: string): string {
  let out = s;
  for (const sec of SECRETS) out = out.split(sec).join("[REDACTED]");
  out = out.replace(/("?(password|answer|token|sessionToken|stateToken|access_token|id_token|deviceToken)"?\s*[:=]\s*"?)[^"&,}\s]+/gi, "$1[REDACTED]");
  out = out.replace(/[A-Za-z0-9+/=_-]{60,}/g, (m) => `<blob ${m.length}b>`);
  return out;
}

const T0 = Date.now();
const rel = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;

// categorize a URL by what bot/fingerprint machinery it belongs to
const CF = /cdn-cgi\/(challenge|rum|bm|beacon|zaraz)|challenges\.cloudflare\.com|turnstile/i;
const OKTA = /okta\.com/i;
const FP = /fingerprint|fpjs|deviceprint|device-?print|\/collect|telemetry|sensor|botman|\/rum\b|\/beacon|imperva|distil|perimeterx|datadome|signalsciences/i;
const NOISE = /\.(png|jpg|jpeg|gif|svg|webp|woff2?|ttf|eot|ico)(\?|$)|google-analytics|googletagmanager|doubleclick|gstatic/i;

const seenCF = new Set<string>();
const seenOkta = new Set<string>();
const seenFP = new Set<string>();

async function run() {
  const session = await BrowserbaseSession.open();
  console.log("replay:", "https://browserbase.com/sessions/" + session.id);
  const page = session.page;
  const context = page.context();

  page.on("request", (req) => {
    const u = req.url();
    if (NOISE.test(u)) return;
    const tag = CF.test(u) ? "CF-BOT" : OKTA.test(u) ? "OKTA" : FP.test(u) ? "FINGERPRINT" : null;
    if (!tag) return;
    (tag === "CF-BOT" ? seenCF : tag === "OKTA" ? seenOkta : seenFP).add(`${req.method()} ${u.split("?")[0]}`);
    const pd = req.postData();
    console.log(`[${tag} ${rel()}] ${req.method()} ${u.split("?")[0]}${pd ? `  body(${pd.length}b): ${redact(pd).slice(0, 160)}` : ""}`);
  });
  page.on("response", (r) => {
    const u = r.url();
    if (NOISE.test(u)) return;
    const h = r.headers();
    const flags = ["cf-mitigated", "cf-chl-bypass", "x-okta-request-id"].filter((k) => h[k]);
    if ((CF.test(u) || OKTA.test(u)) && (flags.length || r.status() >= 400))
      console.log(`[resp ${rel()}] ${r.status()} ${u.split("?")[0]} ${flags.map((k) => `${k}=${h[k]}`).join(" ")}`);
  });

  // snapshot which bot/device cookies (tokens) are planted, and by whom
  async function dumpTokens(label: string) {
    const TOK = /__cf_bm|cf_clearance|_cfuvid|^DT$|^sid$|JSESSIONID|deviceToken|^t$|proximity|okta/i;
    const cookies = (await context.cookies()).filter((c) => TOK.test(c.name));
    console.log(`\n[BOT/DEVICE COOKIES @ ${label}]`);
    for (const c of cookies) console.log(`  ${c.domain}  ${c.name} = <${c.value.length} chars>  ${c.httpOnly ? "httpOnly " : ""}${c.secure ? "secure" : ""}`);
  }

  // WHAT WE SHOW: the client-readable fingerprint surface (string expr -> no esbuild __name)
  async function dumpSurface(label: string) {
    const expr = `({
      ua: navigator.userAgent, platform: navigator.platform, vendor: navigator.vendor,
      languages: navigator.languages, webdriver: navigator.webdriver,
      hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory,
      plugins: navigator.plugins.length, maxTouchPoints: navigator.maxTouchPoints,
      chrome: !!window.chrome,
      screen: { w: screen.width, h: screen.height, availH: screen.availHeight, depth: screen.colorDepth, dpr: window.devicePixelRatio },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: Intl.DateTimeFormat().resolvedOptions().locale,
      webgl: (function(){try{var gl=document.createElement('canvas').getContext('webgl');var e=gl.getExtension('WEBGL_debug_renderer_info');return gl.getParameter(e.UNMASKED_VENDOR_WEBGL)+' | '+gl.getParameter(e.UNMASKED_RENDERER_WEBGL);}catch(x){return 'n/a';}})(),
      canvasHash: (function(){try{var c=document.createElement('canvas');var x=c.getContext('2d');x.textBaseline='top';x.font="14px 'Arial'";x.fillText('BrowserLeaks,com <canvas> 1.0',2,2);return c.toDataURL().slice(-24);}catch(e){return 'n/a';}})()
    })`;
    console.log(`\n[WHAT WE SHOW @ ${label}]`);
    console.log(JSON.stringify(await page.evaluate(expr), null, 1));
  }

  // ---- LOGIN PAGE: where Cloudflare + Okta widget fingerprint on load ----
  console.log("\n========== LOAD LOGIN PAGE (CF + Okta widget fingerprinting) ==========");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.locator("#okta-signin-username").waitFor({ timeout: 25000 });
  await page.waitForTimeout(2500); // let CF challenge JS + Okta widget telemetry fire
  await dumpSurface("login page");
  await dumpTokens("login page");

  // ---- AUTH: Okta device fingerprint travels with /api/v1/authn ----
  console.log("\n========== SUBMIT LOGIN (Okta device fingerprint) ==========");
  await page.locator("#okta-signin-username").fill(process.env.ASSURANT_USER!);
  await page.locator("#okta-signin-password").fill(process.env.ASSURANT_PASSWORD!);
  await page.locator("#okta-signin-submit").click();
  const outcome = await Promise.race([
    page.locator('input[name="answer"]').waitFor({ timeout: 30000 }).then(() => "mfa"),
    page.waitForURL(/\/app\/policy\//, { timeout: 30000 }).then(() => "dashboard"),
  ]).catch(() => "neither");
  console.log(">>> after submit:", outcome);
  if (outcome === "mfa") {
    await page.getByRole("link", { name: /send code/i }).or(page.getByRole("button", { name: /send code/i })).first().click().catch(() => {});
    console.log(">>> drop SMS code into scripts/assurant-mfa.txt");
    let code = "";
    for (let i = 0; i < 150; i++) {
      if (existsSync("scripts/assurant-mfa.txt")) { code = readFileSync("scripts/assurant-mfa.txt", "utf8").trim(); rmSync("scripts/assurant-mfa.txt"); break; }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!code) { console.log("no code"); await session.close(); return; }
    await page.locator('input[name="answer"]').fill(code);
    await page.getByRole("button", { name: /verify|submit/i }).first().click();
    await page.waitForURL(/\/app\/policy\//, { timeout: 30000 });
  } else if (outcome === "neither") { await session.close(); return; }

  // ---- POST-AUTH: snapshot + the doc API phase (should be clean authed traffic) ----
  console.log("\n========== POST-AUTH (snapshot + doc API) ==========");
  if (/selection/i.test(page.url())) {
    await page.getByText(/REN\d+/i).first().click();
    await page.waitForURL(/snapshot/, { timeout: 30000 }).catch(() => {});
  }
  await page.waitForTimeout(2500);
  await dumpSurface("post-auth");
  await dumpTokens("post-auth");

  console.log("\n========== SUMMARY: where they fingerprint us ==========");
  console.log("Cloudflare bot endpoints hit:", seenCF.size);
  for (const u of seenCF) console.log("  " + u);
  console.log("Okta endpoints hit:", seenOkta.size);
  for (const u of seenOkta) console.log("  " + u);
  console.log("Other fingerprint/telemetry beacons:", seenFP.size);
  for (const u of seenFP) console.log("  " + u);

  console.log("\ndone.");
  await session.close();
}
await run();
process.exit(0);
