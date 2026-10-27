# CircleSats

**Save together. Pay instantly. Rotate fairly. Track every sat.** CircleSats is a hackathon MVP for small community savings circles. Members contribute an agreed amount each round; a scheduled member receives the pool after group approval and settlement. The seeded Dakar Market Circle has Awa, Mamadou, Fatou, and Ibrahima contributing 100 sats each across four rounds.

The app is for organizers and members who need a visible contribution record and a predictable rotation. It is not an escrow, a bank, or an automated payout service.

## Try the full cycle

The Vercel site is a **browser-only guided simulation**. It runs the same savings-cycle rules locally in each visitor's tab, so visitors can simulate contributions, approvals, and four rotating payouts without a wallet connection. The preview resets on reload and does not create Lightning invoices or shared receipts. The full Node app below is required for member access and NWC/LNbits receiving; it needs one persistent host and must not be run with Vercel's temporary filesystem. Build the static preview with `npm run build:vercel` and inspect it with `npm run preview:vercel`. Vercel uses [vercel.json](vercel.json) to publish `vercel-public/` and no private environment variables.

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
```

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
