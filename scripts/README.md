# Anti-bot probes

The recon scripts behind the anti-bot claims in [`../latency.md`](../latency.md). They
run through the same residential-proxy Browserbase config the carriers use, so they
profile the exact session that runs in prod, not a vanilla browser. Credentials and
tokens are redacted in their output.

Run any of them with your `.env` in place:

```sh
node --env-file=.env --import tsx scripts/<name>.ts
```

| Script | What it answers |
|---|---|
| `antibot-probe.ts` | Which vendor each portal runs. Detects Akamai, Cloudflare, DataDome, PerimeterX, Kasada, Imperva by their cookies and script hosts. Pass a login URL as the arg. |
| `fingerprint-probe.ts` | What our session looks like from the outside: egress IP and geo, TLS/JA3/JA4, automation signals, and the WAF headers/cookies both carriers serve. |
| `allstate-fp-attack-probe.ts` | The key proof for Allstate. Tests whether Akamai's `_abck` cookie validates to status 0 (sensor passed) rather than `-1` (flagged). Pre-auth, low risk, no MFA. |
| `assurant-fp-attack-probe.ts` | The Geico side (serviced via Assurant). Pinpoints where Cloudflare and Okta fingerprint us, and which device/bot tokens they plant. |

This folder also holds the rest of the dev spikes used while building. They are gitignored
on purpose; these four are kept as the evidence trail.
