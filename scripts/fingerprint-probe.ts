// Fingerprint / anti-bot surface probe. Through the same residential-proxy
// Browserbase browser we use in prod, capture: egress IP + geo, TLS/JA3/JA4
// (browser vs page.request), automation signals, a bot-test verdict screenshot,
// and the WAF headers/cookies on both carriers' login pages. No login needed.
//   ! node --env-file=.env --import tsx scripts/fingerprint-probe.ts
// Uses BrowserbaseSession.open() so it profiles the EXACT config the carriers use
// (Verified fingerprint + MA residential proxy), not a vanilla session.
import { BrowserbaseSession } from "../src/browserbase.js";

const session = await BrowserbaseSession.open();
console.log("replay:", "https://browserbase.com/sessions/" + session.id);
const page = session.page;
const context = page.context();

// read a JSON endpoint through the BROWSER (rides the residential proxy)
async function browserJson(url: string): Promise<any> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const txt = (await page.evaluate("document.body.innerText")) as string;
    return JSON.parse(txt);
  } catch (e) {
    return { error: (e as Error).message };
  }
}
// read a JSON endpoint through page.request (rides OUR process: local now, Fly on prod)
async function requestJson(url: string): Promise<any> {
  try {
    const r = await page.request.get(url, { timeout: 30000 });
    return JSON.parse(await r.text());
  } catch (e) {
    return { error: (e as Error).message };
  }
}

console.log("\n===== EGRESS IP =====");
const bIp = await browserJson("https://ipinfo.io/json");
console.log("browser (proxy) egress:", JSON.stringify({ ip: bIp.ip, org: bIp.org, city: bIp.city, region: bIp.region, country: bIp.country }));
const rIp = await requestJson("https://ipinfo.io/json");
console.log("page.request egress (LOCAL here; FLY on prod):", JSON.stringify({ ip: rIp.ip, org: rIp.org, city: rIp.city, country: rIp.country }));

console.log("\n===== TLS / HTTP2 FINGERPRINT =====");
const bTls = await browserJson("https://tls.peet.ws/api/all");
console.log("browser:", JSON.stringify({ ja3_hash: bTls?.tls?.ja3_hash, ja4: bTls?.tls?.ja4, akamai: bTls?.http2?.akamai_fingerprint_hash, ua: bTls?.user_agent }));
const rTls = await requestJson("https://tls.peet.ws/api/all");
console.log("page.request:", JSON.stringify({ ja3_hash: rTls?.tls?.ja3_hash, ja4: rTls?.tls?.ja4, ua: rTls?.user_agent }));

console.log("\n===== AUTOMATION SIGNALS (navigator) =====");
await page.goto("about:blank").catch(() => {});
// pass as a STRING expression so tsx/esbuild doesn't inject its __name helper
// (which isn't defined in the page context) into the evaluated function.
const navExpr = `({
  webdriver: navigator.webdriver,
  ua: navigator.userAgent,
  languages: navigator.languages,
  platform: navigator.platform,
  hardwareConcurrency: navigator.hardwareConcurrency,
  deviceMemory: navigator.deviceMemory,
  plugins: navigator.plugins.length,
  hasChrome: !!window.chrome,
  webglVendor: (function(){try{var gl=document.createElement('canvas').getContext('webgl');var e=gl.getExtension('WEBGL_debug_renderer_info');return gl.getParameter(e.UNMASKED_VENDOR_WEBGL);}catch(x){return 'n/a';}})(),
  webglRenderer: (function(){try{var gl=document.createElement('canvas').getContext('webgl');var e=gl.getExtension('WEBGL_debug_renderer_info');return gl.getParameter(e.UNMASKED_RENDERER_WEBGL);}catch(x){return 'n/a';}})()
})`;
const nav = await page.evaluate(navExpr);
console.log(JSON.stringify(nav, null, 1));

console.log("\n===== BOT-DETECTION TEST (sannysoft) =====");
await page.goto("https://bot.sannysoft.com/", { waitUntil: "networkidle", timeout: 40000 }).catch((e) => console.log("nav err:", (e as Error).message));
await page.screenshot({ path: "/tmp/fp-sannysoft.png", fullPage: true }).catch(() => {});
console.log("screenshot -> /tmp/fp-sannysoft.png");

// WAF headers + cookies on each carrier's login page
async function wafCheck(label: string, url: string, cookieRe: RegExp): Promise<void> {
  console.log(`\n===== WAF: ${label} =====`);
  let topHeaders: Record<string, string> = {};
  const onResp = (r: { url(): string; headers(): Record<string, string> }) => {
    if (r.url() === url || r.url().replace(/\/$/, "") === url.replace(/\/$/, "")) topHeaders = r.headers();
  };
  page.on("response", onResp);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 }).catch((e) => console.log("nav err:", (e as Error).message));
  await page.waitForTimeout(2500);
  page.off("response", onResp);
  const interesting = Object.fromEntries(
    Object.entries(topHeaders).filter(([k]) => /server|cf-|akamai|x-akamai|via|x-cache|set-cookie|x-frame|strict-transport|cf-ray|cf-mitigated/i.test(k)),
  );
  console.log("response headers:", JSON.stringify(interesting));
  const cookies = (await context.cookies()).filter((c) => cookieRe.test(c.name));
  console.log("bot cookies:", cookies.map((c) => `${c.name}=${c.value.slice(0, 10)}…(${c.value.length})`).join(", ") || "none");
}
await wafCheck("Allstate (Akamai)", "https://myaccountrwd.allstate.com/anon/account/login", /_abck|bm_sz|ak_bmsc|bm_sv/i);
await wafCheck("Assurant (Cloudflare)", process.env.ASSURANT_LOGIN_URL ?? "https://manage.myassurantpolicy.com/app/login", /__cf_bm|_cfuvid|cf_clearance/i);

console.log("\ndone.");
await session.close();
process.exit(0);
