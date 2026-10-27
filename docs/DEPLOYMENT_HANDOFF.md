# CircleSats operator handoff — 27 October 2026

## Intended hosting shape

Use one Node.js 24+ process on a VM/VPS with a persistent **local** disk, an HTTPS reverse proxy, and firewall access limited to that proxy. Bind Node to `127.0.0.1`. Do not use ephemeral/serverless storage, shared network filesystem, or more than one app process with this JSON ledger. The production lock rejects a second process. Guest demo sessions and login sessions are in memory and end on restart; the shared ledger and salted member hashes persist.

## Environment variables

Keep values in the host's secret manager or a private `.env` outside Git. `.env.example` contains safe local defaults. Set the following on the host:

| Variable | Public demo | Signet NWC | Signet LNbits | Meaning |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | `production` | `production` | `production` | Enables production checks and the instance lock |
| `DATA_DIR` | required | required | required | Absolute persistent path **outside** source repository; contains ledger, backup, lock, and member hashes |
| `PUBLIC_HTTPS` | `1` | `1` | `1` | Only after trusted HTTPS reverse proxy is active; sets Secure cookies and HSTS |
| `TRUST_PROXY` | `1` | `1` | `1` | Requires the local reverse proxy to **overwrite** `X-Real-IP` with the actual client IP; used for sign-in and guest rate limits |
| `HOST` | `127.0.0.1` | same | same | Local bind behind proxy |
| `PORT` | e.g. `3100` | same | same | Local listener |
| `LIGHTNING_PROVIDER` | omit | `nwc` | `lnbits` | Receiving adapter; omitting with no receiver credentials keeps simulated mode |
| `PAYMENT_ENVIRONMENT` | omit | `signet` | `signet` | Must match the real receiver network |
| `LNBITS_NETWORK` | omit | `signet` | `signet` | Receiver-reported network; name retained for both adapters |
| `NWC_RECEIVER_CONNECTION_SECRET` | omit | required | omit | Receive-only NWC URI, without `pay_invoice` |
| `LNBITS_URL` / `LNBITS_INVOICE_KEY` | omit | omit | required | HTTPS endpoint and invoice/read key, never admin key |

`GUEST_LIGHTNING_SANDBOX` (all columns: omit, or `0` to disable) controls guest-demo wallets. By default each guest demo opens its own Alby Developer Sandbox wallet pair from `faucet.nwc.dev` (test sats; at most 50 open at once, closed when the session ends) and falls back to simulation if the faucet or relay is unreachable within 25 seconds. The host therefore needs outbound HTTPS to `faucet.nwc.dev` and WSS to its relay; these wallets never touch the shared ledger or the real receiver.

**Vercel (public demo):** besides the static site, Vercel runs `api/practice/{info,invoice,pay,status}.js`. Set `NWC_RECEIVER_CONNECTION_SECRET` (treasurer's receive-only Mutinynet NWC), `PAYMENT_ENVIRONMENT=signet` and `LNBITS_NETWORK=signet` in the Vercel project's environment variables; `PRACTICE_LIGHTNING=0` disables real practice payments. Without them, the demo uses the Alby sandbox or simulation. The treasurer node must stay online with incoming capacity during judging.

Leave `DATA_FILE` and `AUTH_FILE` unset in production. Leave `ALLOW_SANDBOX_RECEIVER_SPEND_PERMISSION` and `SANDBOX_PAYER_WALLET_PUBKEY` unset for signet. The Alby fake-sat sandbox uses `PAYMENT_ENVIRONMENT=alby-sandbox`, `LIGHTNING_PROVIDER=nwc`, `LNBITS_NETWORK=mainnet` (its API label), `SANDBOX_PAYER_WALLET_PUBKEY`, and a sandbox-only permission opt-in. Never mix its credentials with signet or real mainnet. CircleSats rejects `PAYMENT_ENVIRONMENT=mainnet`.

`NODE_OPTIONS=--use-system-ca` is optional when the operating system trust store is needed. Keep TLS validation enabled. The standard launcher strips an inherited `NODE_TLS_REJECT_UNAUTHORIZED=0`; direct server startup refuses it.

## First boot

1. Create a private persistent directory outside the source checkout. Restrict OS access to the service account, and keep it out of the reverse proxy's web root. Set `DATA_DIR` to its absolute path.
2. Run `npm ci`, `npm test`, `npm run build`, `npm run check:secrets`, and `npm audit --omit=dev --audit-level=moderate` from the project directory.
3. Run `npm run provision:members` **once**. This creates `member-auth.json` and `member-invites.txt` in `DATA_DIR` with restrictive file modes. The command logs only the invite-file path. Give each access code privately to its member; do not put invite contents in screenshots or public logs. Production startup refuses to create or print new codes. Preserve the hash file during redeploys.
4. Configure TLS on the reverse proxy and route only to the loopback listener. Have the proxy **overwrite** the inbound `X-Real-IP` header with its own observed client address; do not forward a client-supplied value. Verify HTTP redirects to HTTPS, the certificate chain is valid, WebSockets can reach the chosen NWC relay, and the host firewall does not expose port 3100 directly. Then set `PUBLIC_HTTPS=1`, `TRUST_PROXY=1`, and run `npm start` under a supervisor configured for **one** process. Login and guest creation fail closed if the proxy IP header is missing or invalid. No in-app reverse-proxy or certificate provisioning is included.
5. Verify the page, `GET /api/group`, Secure session cookie, CSP/HSTS/security headers, and a guest simulated cycle before giving the URL to testers. For a real receiving adapter, verify startup capability/network checks and a genuine provider status lookup before advertising payments.

## Data and recovery

The shared `circlesats.json` is version 4 with a SHA-256 integrity field and monotonic revision. Writes flush a new file, preserve one previously validated `.bak`, and atomically rename the new snapshot. `npm run check:ledger` validates primary and backup without changing either. The checksum detects accidental corruption; it is not an authenticated signature against a malicious host administrator.

Make encrypted off-host backups of `circlesats.json`, `.bak`, and `member-auth.json` using a stopped-process copy or consistent filesystem snapshot. Practice restoring to a separate directory before launch. Do not rely on `.bak` as the only backup. On corrupt ledger startup, keep the app stopped, preserve both files, inspect `check:ledger` output and provider payment history, then restore a verified copy and reconcile recent invoices before reopening payments. The app never silently falls back to an older backup. After an unclean exit, confirm the prior process is gone and inspect the ledger before removing a stale `.lock`; never remove a live lock.

## Payment labels and proof

| Mode | What a receipt proves | Payout state |
| --- | --- | --- |
| Simulated demo | Local scripted contribution only; no Lightning value moved | Simulated rotation can complete |
| Alby Developer Sandbox | Two live sandbox wallets exchanged **fake sats**; the NWC API reports `mainnet` despite fake value | Three approval records; no outgoing payout verified |
| Real signet Lightning | Adapter is configured; **no actual CircleSats signet settlement has yet been observed** | An approval or manually typed reference is unverified |
| Mainnet | Disabled for this MVP; no CircleSats mainnet transaction | None |

## Remaining external gates

- **Public submission:** the repository and browser-only simulated demo are published. A presentation, demo video, and Devpost submission remain. The public demo has no real receiving wallet or shared ledger.
- **Real Lightning claim:** a separate, funded signet payer and scoped receiving wallet; one authorized 100-sat test; independent receiver lookup and sanitized evidence. LNbits has only stand-in tests. See [testnet plan](TESTNET_SETUP.md).
- **Live payout claim:** independent outgoing transaction and recipient receipt verification. CircleSats currently cannot mark a real round complete from a typed treasurer reference.
- **Broader use:** migration to transactional storage and durable sessions before multi-instance hosting, plus custody/legal review if the product ever holds or directs real pooled funds.

For a short judge demo, use the fully isolated simulated path. Show the separate sandbox evidence as fake-sat integration proof. See [three-minute walkthrough](DEMO_WALKTHROUGH.md) and [judging evidence](JUDGING_EVIDENCE.md).
