# CircleSats

**Save together. Pay instantly. Rotate fairly. Track every sat.** CircleSats is a hackathon MVP for small community savings circles. Members contribute an agreed amount each round; a scheduled member receives the pool after group approval and settlement. The seeded Dakar Market Circle has Awa, Mamadou, Fatou, and Ibrahima contributing 100 sats each across four rounds.

**Public guided demo:** [circlesats-two.vercel.app](https://circlesats-two.vercel.app/) — a private practice circle in your browser where your own contribution is a **real Lightning payment**. With a Lightning wallet you pay a real Bitcoin invoice (100 sats); without one, the Mutinynet faucet pays a test-coin invoice for you over a real Lightning channel. There is no shared member ledger.

### Judge quick test (about one minute, no sign-up)

1. Open the demo, choose **Start guided demo**, then **Create demo wallet** and **Get 200 demo sats for this round**.
2. **Go to my contribution** → **Create demo contribution**.
3. **With a Lightning wallet** (header **BITCOIN LIGHTNING · REAL SATS**): scan the QR code or copy the `lnbc…` invoice and pay 100 sats from any wallet. The invoice is issued by the circle's demo treasurer wallet (receive-only). CircleSats detects the payment automatically. This is a real Bitcoin payment and is not refunded.
4. **Without a wallet:** click **No Lightning wallet? Use free test coins** (or, if the header already shows **MUTINYNET LIGHTNING · TEST COINS**), then **Pay with demo wallet**. The Mutinynet faucet's node pays a Mutinynet invoice from the treasurer's node over Lightning (up to a minute).
5. Check the proof: the receipt shows the **payment hash** and **preimage**. SHA-256 of the preimage (hex bytes) equals the payment hash, and only a settled payment reveals it. A contribution counts only after the treasurer wallet itself reports the exact invoice, hash and amount as settled.
6. Use **Simulate … payment** for the other three members, then approve and simulate the payout in **The savings cycle**.

Every visitor gets a separate circle and separate invoices, so judges never see or affect each other's payments. If neither real rail is available, the same buttons fall back to a private [Alby Developer Sandbox](https://github.com/getAlby/nwc-faucet) wallet pair (**ALBY SANDBOX · TEST SATS**, not routed over a Lightning network) and then to the original **SIMULATED SATS** demo. Each mode is labelled on screen and on the receipt.

### Operator setup for real payments

**Real sats (mainnet):** create a free [Blink](https://dev.blink.sv/api/auth) account and, at dashboard.blink.sv → API Keys, a key with only **Read** and **Receive** (CircleSats refuses a key with Write). Add it to the Vercel project as the sensitive variable `BLINK_RECEIVE_API_KEY` (Production and Preview) and redeploy. `/api/practice/info` then reports `rails.mainnet.available: true`. Set `PRACTICE_MAINNET=0` to turn real-sat invoices off. Blink is hosted, so this rail does not depend on your PC being online.

**Test coins (Mutinynet), always online (recommended):** use a hosted LND node on Mutinynet, for example on [Voltage](https://voltage.cloud)'s free Essentials plan, so the treasurer does not depend on your PC.

1. Create a Mutinynet LND node and finish Voltage's setup prompts.
2. Give it incoming capacity: at [faucet.mutinynet.com](https://faucet.mutinynet.com), open a Lightning channel **to** the node (paste its `pubkey@host:9735` connection address). 100,000 sats covers about 1,000 payments. Mutinynet blocks are about 30 seconds, so the channel is usable within minutes.
3. Copy the node's REST API address (`https://…`) and its **invoice** macaroon in hex. Never use the admin macaroon: CircleSats reads the macaroon's permissions and refuses one that could pay, send coins or manage the node.
4. In the Vercel project's environment variables, add `LND_REST_URL` and the sensitive `LND_INVOICE_MACAROON` (Production and Preview), then redeploy. If the node asks for an API IP allowlist, allow all addresses: Vercel has no fixed address, and the invoice macaroon cannot spend.

**Test coins with your own Alby Hub (alternative):** set `NWC_RECEIVER_CONNECTION_SECRET` to the Hub's **receive-only** NWC connection (`make_invoice` and `lookup_invoice`, no `pay_invoice`; startup refuses spending permission), plus `PAYMENT_ENVIRONMENT=signet` and `LNBITS_NETWORK=signet`. The Hub must stay online with incoming capacity (each payment needs 100 sats). When both are set, the LND node is used.

For either: `/api/practice/info` then reports `rails.signet.available: true`. Set `PRACTICE_LIGHTNING=0` to turn test-coin payments off. If the node is unreachable, judges automatically get the labelled Alby sandbox or simulation instead.

- The faucet allows about 60 withdraw requests and 1,000,000 sats per server address per day.
- The `/api/practice` functions ask the faucet to pay only pending, unexpired 100-sat invoices that the treasurer node itself issued, so they cannot be used to send faucet coins anywhere else. They hold no spending key.
- Test locally before deploying: with your private `.env.mutinynet` in place, run `npm run build:vercel` then `npm run preview:vercel` and open http://127.0.0.1:3200. The local preview loads the same receiver connection and calls the faucet from your own internet address.

### How CircleSats meets the hackathon requirements

| Requirement | Where to see it |
| --- | --- |
| Bitcoin / Lightning solution for a local need | Rotating savings circles (*tontines*, *natt*) on Lightning; seeded Dakar Market Circle; [presentation](docs/PRESENTATION.md) |
| Nostr | Nostr Wallet Connect (NIP-47): the treasurer node receives over NWC, and judges can connect their own wallet over NWC and pay in the demo |
| At least a Bitcoin/Lightning wallet implementation | Lightning invoices (receive), in-app NWC payment (send), practice wallets with balances; [first verified payment](docs/LIGHTNING_PAYMENT_EVIDENCE.md) |
| Presentation (text or video) | [docs/PRESENTATION.md](docs/PRESENTATION.md); Devpost text in [docs/DEVPOST_SUBMISSION.md](docs/DEVPOST_SUBMISSION.md) |
| Prototype / MVP | [circlesats-two.vercel.app](https://circlesats-two.vercel.app/) (no sign-up) and the Node app below |
| AI | Not used; the brief's examples show Bitcoin-only solutions also qualify |

The app is for organizers and members who need a visible contribution record and a predictable rotation. It is not an escrow, a bank, or an automated payout service.

## Try the full cycle

The Vercel site is a **browser-only guided demo**. It runs the same savings-cycle rules locally in each visitor's tab, so visitors can try contributions, approvals, and four rotating payouts without bringing a wallet. The visitor's own contribution uses the practice payments described above; other members, approvals, and payouts are simulated. The preview resets on reload and keeps no shared receipts. The Node app gives guest demos the same private sandbox wallets server-side; set `GUEST_LIGHTNING_SANDBOX=0` to keep guests fully simulated. The full Node app below is required for member access and NWC/LNbits receiving; it needs one persistent host and must not be run with Vercel's temporary filesystem. Build the static preview with `npm run build:vercel` and inspect it with `npm run preview:vercel`. Vercel uses [vercel.json](vercel.json) to publish `vercel-public/` and the `/api/practice` functions; its only private variable is the treasurer node's receive-only NWC connection.

Run locally with Node.js 24+:

```powershell
npm install
npm start
```

Open [localhost:3100](http://localhost:3100), choose **Start guided demo**, and open **The savings cycle**. Simulate each member's contribution, record the three approvals from members other than the recipient, then select **Simulate payout & open next round**. Repeat for all four recipients. The final screen preserves each round's receipts, approvals, and simulated settlement; **Start another cycle** keeps the history. A private guest can also configure a 2–8 member weekly or monthly group before its first contribution. The guest ledger lives only in that server session and never changes the shared group.

Members of the shared group sign in with organizer-issued access codes. Local development prints codes once; production requires `npm run provision:members`, which writes them to a private file outside the source tree and keeps them out of server logs. Only salted hashes are kept for login. Demo mode also offers an in-app wallet and a per-round allotment of **simulated** sats. Those sats cannot leave CircleSats.

## Lightning architecture

The server can receive contribution invoices through either **LNbits** or a **receive-only Nostr Wallet Connect (NWC)** connection. Both adapters create an invoice and independently check settlement, amount, and invoice identity before crediting a member's round. The receiver secret stays on the server. A member can copy an invoice to a compatible Lightning wallet, or connect a separate, small-budget NWC **payer** in their browser. Payment from that connected wallet may provide a preimage; CircleSats checks its hash to link the payment to the signed-in account. A receiver-confirmed payment without that proof remains **payer unverified**. An access code and preimage do not establish a person's legal identity.

The seeded group records confirmed contributions, payout eligibility, approvals by every nonrecipient member, and a manual transfer reference. A reference is explicitly **unverified**. Real Lightning mode does not execute or independently verify payouts, so a real round cannot be marked complete from a treasurer's claim alone. The full rotation completion action is available only in the clearly marked simulation.

To configure a receiver, copy `.env.example` to local `.env` and choose one provider:

```dotenv
LIGHTNING_PROVIDER=lnbits
PAYMENT_ENVIRONMENT=signet
LNBITS_URL=https://your-instance.example
LNBITS_INVOICE_KEY=your-receive-only-invoice-key
LNBITS_NETWORK=signet
```

or:

```dotenv
LIGHTNING_PROVIDER=nwc
PAYMENT_ENVIRONMENT=signet
NWC_RECEIVER_CONNECTION_SECRET=nostr+walletconnect://your-receive-only-connection
LNBITS_NETWORK=signet
```

The NWC receiver requires `get_info`, `make_invoice`, and `lookup_invoice` and normally rejects `pay_invoice`. Do not use a spending/admin key for receiving. The payer wallet needs `pay_invoice` and a small budget. The payer's NWC URI is entered into the browser at runtime, stays in that tab's memory, and can be disconnected; no wallet URI is bundled into public assets. Keep both secrets out of Git, screenshots, and chat. Restart the app after changing `.env`. The private guided demo remains available with a receiver configured. See [testnet setup](docs/TESTNET_SETUP.md) and [Lightning integration](docs/LIGHTNING_INTEGRATION.md).

For a **real Mutinynet acceptance test**, use a separate ignored `.env.mutinynet` ledger and the read-only `npm run check:mutinynet-wallets` check. Keep any payer connection in ignored `.env.mutinynet-payer` or use an external payer service; do not put a spending URI in server configuration or public assets. `npm run start:mutinynet` starts the receiver after its wallet is configured. CircleSats decodes Signet invoices and rejects a wrong network, amount, hash, or expiry before storing a real contribution. On 27 October it issued one genuine 100-sat invoice for Awa through the connected receiver; independent lookup shows **pending** and zero sats credited. See the [real Lightning test status and runbook](docs/REAL_LIGHTNING_TEST.md). No real payment has been made.

## Alby Developer Sandbox verification

The sandbox uses **fake test sats** even though its NWC `getInfo` response reports `mainnet`. The browser labels this mode clearly and accepts only the configured sandbox payer wallet's public key. It must not be treated as a signet or real Bitcoin settlement. The sandbox faucet currently gives the receiving connection spending permission, so CircleSats allows that credential only with an explicit **sandbox-only** opt-in; use a receive-only connection for any real wallet.

After `npm install`, run the isolated integration check with certificate validation enabled:

```powershell
$env:NODE_TLS_REJECT_UNAUTHORIZED='1'
$env:NODE_OPTIONS='--use-system-ca'
npm run test:sandbox
```

The script creates or reuses two sandbox wallets, pays four member invoices from the second wallet, verifies receiving status and preimages, blocks repeat contributions, reloads the ledger, and records three nonrecipient approvals. It stores private wallet URLs only in ignored `data/alby-sandbox-wallets.json` and writes sanitized results to `data/alby-sandbox-evidence.json`. If the Alby relay is temporarily unavailable, rerun the check; a timeout is not a payment result. To inspect the local sandbox UI, run `npm run configure:sandbox` followed by `npm run start:sandbox` and use the one-time test member codes printed at first start. The generated `.env.sandbox` is ignored by Git. **Do not connect a real mainnet wallet to this sandbox.**

## Verify

```powershell
npm test
npm run build
npm run check:secrets
npm audit --omit=dev --audit-level=moderate
npm run test:guest-sandbox   # live: two guests pay real sandbox invoices (needs internet)
npm run preview:vercel       # with .env.mutinynet: real Mutinynet practice payments at 127.0.0.1:3200
```

On 27 October 2026, on branch `claude/judge-lightning-sandbox`, 40 tests passed (Node 22, with locked dependencies rebuilt from their upstream sources because the npm registry was unreachable; rerun with `npm ci` on Node 24 before release). They include the Mutinynet practice service and the guest sandbox flow, tested against in-memory stand-ins for the treasurer node, the Mutinynet faucet and the Alby faucet. Chromium runs of the built Vercel site, with the production Content Security Policy, completed: two isolated judges paying Mutinynet practice invoices through the real `/api/practice` handler (preimage on each receipt hashed to its payment hash), the Alby sandbox fallback, and the simulated fallback. **Not yet run against live services:** a Mutinynet payment from the real faucet to the real treasurer node, `npm run test:guest-sandbox`, and the deployed Vercel functions.

On 27 October 2026, 25 tests passed. They cover access control, the four-round API journey, durable cycle history, guest isolation, LNbits and NWC stand-ins, delayed and expired payments, reconnects, duplicate prevention, Signet invoice parsing, optional preimage verification, environment isolation, proxy identity, production provisioning, and preloader readiness. A separate live Alby Developer Sandbox check passed four fake-sat payments and three approvals again. The production build and dependency audit passed. No CircleSats LNbits, signet, or real-Bitcoin settlement has been verified.

## Project documents

- [Architecture](docs/ARCHITECTURE.md) and [savings-cycle rules](docs/SAVINGS_CYCLE.md)
- [Security boundaries](docs/SECURITY.md) and [testnet setup](docs/TESTNET_SETUP.md)
- [Deployment and submission readiness](docs/DEPLOYMENT_READINESS.md) and [operator handoff](docs/DEPLOYMENT_HANDOFF.md)
- [Sanitized Alby Sandbox payment evidence](docs/ALBY_SANDBOX_EVIDENCE.md)
- [Real Lightning test runbook](docs/REAL_LIGHTNING_TEST.md) and [pending evidence](docs/LIGHTNING_PAYMENT_EVIDENCE.md)
- [Three-minute demo](docs/DEMO_WALKTHROUGH.md), [judging evidence](docs/JUDGING_EVIDENCE.md), and [roadmap](docs/ROADMAP.md)
- [Durable project context](docs/PROJECT_CONTEXT.md)

Technology: Node.js HTTP server, static HTML/CSS/JavaScript, JSON file persistence, official Alby JavaScript SDK, and GSAP for the preloader. The Vercel preview is deliberately simulated and browser-local; the Node host is the path for genuine Lightning tests.
