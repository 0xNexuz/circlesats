# Deployment and submission readiness

Status on 27 October 2026: **public repository and Vercel simulated demo deployed**. The public site is [circlesats-two.vercel.app](https://circlesats-two.vercel.app/), linked to [0xNexuz/circlesats](https://github.com/0xNexuz/circlesats). It runs the savings-cycle engine in one browser tab with no persistent shared ledger, member access, or Lightning receiving. The full Node app is still local. The [Devpost rules](https://dakar-bitcoin-hack-2026.devpost.com/rules) require a presentation, public GitHub repository, and an internet-accessible MVP **or** demo video by 20 November 2026. A presentation, demo video, and submission have not been made. The operator setup for the full Node app is in [deployment handoff](DEPLOYMENT_HANDOFF.md).

## Available demonstration paths

- **Public guided demo:** Run without receiver secrets. Visitors can start independent simulated four-round cycles; every contribution and payout is marked simulated. This is the lowest-friction judge path. Verify the server can accept concurrent guests and that the page works over HTTPS before making it public.
- **Private Alby Sandbox demonstration:** Use `npm run test:sandbox` and, locally, `npm run configure:sandbox` plus `npm run start:sandbox`. This proves fake-sat receiving and member approvals. The sandbox NWC API reports `mainnet` even for fake sats; the UI identifies them as test sats and pins the designated payer public key. Do not expose the private wallet URLs in a public demo.
- **Signet or LNbits demonstration:** Supported by adapter code and local stand-ins, but no live settlement has been verified. Use a receive-only connection or LNbits invoice key and separately funded payer before advertising this path.

## Production-like hosting requirements

1. Node.js 24+, `npm ci`, `npm run build`, and `npm start`; configure loopback `HOST`, `PORT`, a single-process supervisor, a persistent absolute `DATA_DIR` outside the source tree, and a reverse proxy with valid HTTPS that overwrites `X-Real-IP`. Set `NODE_ENV=production`, `PUBLIC_HTTPS=1`, and `TRUST_PROXY=1` only behind that proxy.
2. Keep `.env`, `.env.sandbox`, NWC URLs, access codes, and `data/` off the public repository and static asset path. Use the host's secret manager for a receiver. Never disable TLS verification; use a trusted CA. The sandbox local launcher uses the Windows system CA store.
3. Run `npm run provision:members` once before production startup; it writes codes to a private file, avoiding server-log leakage. Use one server process with persistent writable storage. Version-4 ledger writes are flushed, checksummed, backed up one revision, and protected by an instance lock. Keep encrypted off-host backups and run `npm run check:ledger` after recovery. Current sessions and guest demo stores are in memory, so a restart loses them. Multi-instance hosting requires a transactional store and shared session layer.
4. Check outbound WebSocket access to the selected NWC relay. Alby relay connections timed out intermittently in local checks; the receiver startup now tries both advertised relays twice. If no relay responds, startup fails rather than claiming a working wallet.
5. Keep real payout execution disabled. Approval records authorization; it is not transfer evidence. The manual transfer reference remains an unverified claim.

## Evidence and remaining blockers

- Automated tests: 22 passing on 27 October, including the four-round guided simulation, expiry and delayed settlement, reconnect, authorization, proxy identity, provisioning, and security headers. Production build completed. Dependency audit found zero moderate-or-higher vulnerabilities; Git-candidate secret scan passed.
- Live sandbox: four 100 sat fake-sat incoming payments with invoice/hash/amount checks, preimage proof, payer disconnection/reconnection before first payment, duplicate rejection, durable reload, and three approvals. The sanitized local evidence is `data/alby-sandbox-evidence.json`; one sandbox payer paid all four invoices. No outgoing payout was verified.
- Browser: 375 px mobile, 615 px tablet, and 1440 px desktop checks showed working navigation and no horizontal overflow. The preloader showed, released scrolling, and revealed the page at each width; the 375 px browser flow created a demo wallet, obtained simulated sats, and recorded a labeled receipt. Physical-device and public-network checks remain.
- Local production startup: with private member provisioning and a temporary external `DATA_DIR`, `GET /api/group` returned 200, missing proxy identity rejected guest creation with 503, a valid `X-Real-IP` allowed it, HSTS/CSP/Secure cookie headers were present, and the instance lock existed. This was a loopback smoke test, not a public HTTPS deployment.
- **Submission P0:** presentation and final Devpost submission remain. The public GitHub repository and accessible simulated MVP are available; the full Lightning receiving app has not been deployed.
- **Real-payment P0:** an actual signet or LNbits settlement, scoped receiver credentials, and independent payout verification would be needed before claiming a live savings product. The Alby Sandbox check is an integration demo using fake sats.

No Bitcoin Core, LDK, BTCPay Server, Docker node, USSD, mobile money, or production custody infrastructure is needed for the current hackathon demonstration.
