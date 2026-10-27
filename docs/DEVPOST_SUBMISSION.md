# Devpost submission text (ready to paste)

Copy each section into the matching Devpost field. Lines in [square brackets] are notes for you; delete them before submitting.

---

## Project name

CircleSats

## Tagline

Save together. Pay instantly. Rotate fairly. Track every sat. Rotating savings circles on Bitcoin Lightning.

## Inspiration

In Senegal and across West Africa, many people save through rotating savings circles: *tontines*, or *natt* in Wolof. Every member pays the same amount each week or month, and one member takes the whole pot each turn. They work because people trust each other, but the bookkeeping is fragile: nobody has one clear record of who has paid, shortfalls are found late, payouts get argued over, and members abroad find it hard to pay in. We wanted to keep the circle exactly as people already run it and give it a shared, verifiable record and instant payments.

## What it does

- **Contribute over Lightning.** Each member gets a unique Lightning invoice for the round. A contribution counts only when the treasurer's wallet confirms it, and the receipt shows the payment hash and preimage so anyone can check it.
- **See the round at a glance:** who has paid, who is due or late, the target and the deadline.
- **Approve the payout together.** Every member except the recipient approves, and the recipient cannot approve their own payout. Every action is in an audit trail.
- **Rotate fairly.** The order is fixed in advance and history is kept across cycles.
- **Never hold the pot.** CircleSats has receive-only access to the treasurer's wallet and cannot spend from it.

## Try it (one minute, no sign-up)

Open https://circlesats-two.vercel.app → **Start guided demo** → **Create demo wallet** → **Get 200 demo sats** → **Go to my contribution** → **Create demo contribution**. Then:

- **With a Lightning wallet:** scan the real Bitcoin invoice (100 sats), or connect your wallet with Nostr Wallet Connect and pay inside the page. The app detects the payment by itself.
- **Without a wallet:** tap **No Lightning wallet? Use free test coins**. The Mutinynet faucet pays a test-coin invoice over Lightning for you.

Then simulate the other three members, approve, and watch the payout rotate through four rounds. Each visitor gets a private circle, so judges never affect each other.

[If the real-Bitcoin invoice does not appear yet, the Blink key is not set; the demo then starts with test coins. Remove this note once it is set.]

## How we built it

- **Bitcoin / Lightning:** BOLT11 invoices on mainnet through a Blink wallet (API key with Read and Receive only) and on Mutinynet through the treasurer's node. Every invoice is decoded and checked for network, amount, hash and expiry before it is stored, and a payment counts only when the receiving wallet reports that exact invoice settled. The preimage is checked against the payment hash on the server and again in the browser.
- **Nostr:** Nostr Wallet Connect (NIP-47) lets members pay from their own wallet inside the app, and can connect the app to a treasurer node such as Alby Hub for receiving only.
- **App:** Node.js with a small versioned JSON ledger and a state machine for rounds, approvals and payouts. The public demo runs the same state machine in the browser, with Vercel serverless functions for the Lightning calls.
- **Security:** receive-only credentials checked at startup (spending permission is refused), exact invoice/hash/amount matching, unique payment hashes, CSRF-protected sessions, a strict Content Security Policy, rate limits, and no secrets in the browser.

## Challenges we ran into

- Making a real Lightning payment testable by any judge, with or without a wallet, without letting the server spend money. We ended up with three paths: the judge's own wallet pays a real invoice, the public Mutinynet faucet pays a test-coin invoice, or a labelled sandbox when neither is reachable.
- Keeping each judge's circle private while sharing one treasurer wallet.
- Being honest on screen: every receipt names its network (real sats, test coins, sandbox or simulated), so a simulation is never shown as a real payment.

## Accomplishments that we're proud of

- A real Lightning payment through the live demo on 27 October 2026: the Mutinynet faucet paid a 100-sat invoice from the treasurer's node, the node confirmed it, and SHA-256 of the preimage matches the payment hash. The evidence is in the repository (docs/LIGHTNING_PAYMENT_EVIDENCE.md).
- [If you pay one real-Bitcoin invoice before submitting, add: "and a real-Bitcoin (mainnet) payment on <date>, payment hash <first 12 characters>…".]
- 50 automated tests covering the four-round cycle, payment matching, replay and mismatch cases, and every payment path.
- The app cannot spend the circle's money, by design.

## What we learned

Lightning payments have no per-payment on-chain transaction; the proof is the preimage, which only the payee can reveal after being paid. Designing receipts around that made verification simple for anyone. We also learned how much trust in a savings circle depends on everyone seeing the same record.

## What's next for CircleSats

1. Pilot with two or three real circles in Dakar and validate the problem with them.
2. French and Wolof interface, and amounts shown in CFA francs.
3. Verified payouts: pay the recipient from the treasurer's wallet within a spending budget the group approves, and record the proof.
4. Member sign-in with Nostr Wallet Connect instead of access codes.
5. A persistent hosted ledger for real groups.

## Built with

javascript, node.js, bitcoin, lightning-network, nostr, nostr-wallet-connect, blink, alby, lnd, mutinynet, vercel

## Links

- Live demo: https://circlesats-two.vercel.app
- Code: https://github.com/0xNexuz/circlesats
- Presentation: https://github.com/0xNexuz/circlesats/blob/master/docs/PRESENTATION.md
