# Real Lightning test: invoice issued, awaiting payment authorization

Updated 27 October 2026. **Result: PARTIAL; genuine 100-sat Signet invoice pending, payment not authorized or attempted.** CircleSats connected to the user's receive-only Alby Hub NWC wallet and stored Awa's invoice in a dedicated ledger. Independent receiver lookup returned pending. No settlement, preimage, or real-payment receipt exists yet. The four Alby Developer Sandbox contributions are fake-sat service transactions and are documented separately in [ALBY_SANDBOX_EVIDENCE.md](ALBY_SANDBOX_EVIDENCE.md).

## Verified implementation

- CircleSats uses `@getalby/sdk` 8.1.1 for a server-held NWC receiver. It requires `make_invoice` and `lookup_invoice`, rejects `pay_invoice` outside the fake-sat sandbox, pins the wallet key and Signet network across relay reconnects, and checks incoming settlement against the exact invoice, 64-character payment hash, and amount in millisats. LNbits remains an alternative receiver.
- A Signet BOLT11 invoice is now decoded with `@getalby/lightning-tools` 9.0.2 before storage. CircleSats requires the `lntbs` network prefix, exact 100-sat amount, matching payment hash, and a nonexpired timestamp. It stores the provider invoice's expiry and the contribution environment. This parser verifies Bech32 structure/checksum and fields; the paying wallet must additionally inspect and accept the real provider-signed invoice. The synthetic parser fixture in tests is **not** a spendable invoice.
- The server refuses a ledger containing simulated records or Lightning records from another or unknown environment, and its settlement reconciliation processes only records for the active provider and environment. Use a fresh ignored `data/mutinynet` ledger. A pending invoice in an old ledger without environment metadata needs manual review; it is not silently migrated or credited.
- The read-only `npm run check:mutinynet-wallets` command checks two private NWC connections, Signet network, receiver/payer separation, receiver scope, payer `pay_invoice`, WSS relay URLs, and payer balance if `get_balance` is allowed. It does not create invoices, pay, or infer Lightning channel liquidity from wallet balance.

## Infrastructure inspection

The user reported that their existing Mutinynet-enabled Alby Hub has an online faucet LND channel, 92,340 sats outgoing, 5,000 sats incoming, and prior successful outgoing Mutinynet payments. These balance and channel figures are **operator-reported**, not independently read through CircleSats. The new receive-only NWC connection was then saved in ignored `.env.mutinynet`; CircleSats' read-only check confirmed the wallet reports `signet`, supports `make_invoice` and `lookup_invoice`, rejects spending permission, and uses a WSS relay. Its chain-data source is not exposed by NWC, so Mutinynet identity beyond Signet is based on the user's node configuration report.

The receiver is operational. The user has no second wallet. The [official Mutinynet faucet](https://faucet.mutinynet.com/) offers a separate node that pays BOLT11 invoices after sign-in, so it is the proposed independent payer service for this first receive test. Its available liquidity and payment-result details must be checked at payment time. A faucet payment can prove independent Lightning settlement but does not bind the payer to Awa's legal identity or replace a controlled second-wallet test. [TESTNET_SETUP.md](TESTNET_SETUP.md) records the exact current checkpoint.

## Payment runbook after wallet setup

1. **Done for receiver.** Its NWC `get_info` reports `signet` and receive-only invoice/lookup methods. The user reports an online channel and 5,000 sats incoming capacity. The proposed external payer is the Mutinynet faucet; it has not been authenticated or tested for this invoice.
2. **Done.** CircleSats on port 3102 created one 100-sat invoice for Awa in `data/mutinynet`. Its `lntbs` prefix, decoded amount, hash, expiry, group, member, and round matched the persisted record. Independent NWC lookup returned pending and the round remained at zero confirmed sats. The hash and private invoice reference are in [the evidence record](LIGHTNING_PAYMENT_EVIDENCE.md).
3. Inspect the same invoice in the independent payer wallet. Confirm Signet, 100 sats, destination, maximum routing fee, and sufficient outgoing balance. Present those exact non-secret details for **separate payment authorization**. Do not invoke `pay_invoice`, faucet payment, or an in-app pay action before authorization. Do not automatically retry an ambiguous result.
4. After authorization, pay once. Record the payer's actual result and query the receiving wallet independently by payment hash. Confirm incoming settled status, exact invoice/hash/100, and settlement timestamp. If a preimage is exposed, verify SHA-256(preimage) equals the hash; otherwise mark preimage unavailable.
5. Reconcile CircleSats and confirm one paid Awa receipt and exactly 100 sats credited to the intended round. Reload the browser, restart the backend, and query the same invoice twice; receipt count and round total must remain unchanged. Preserve a sanitized record in [LIGHTNING_PAYMENT_EVIDENCE.md](LIGHTNING_PAYMENT_EVIDENCE.md).
6. Create an unpaid invoice and verify no credit. Let an invoice expire and confirm no credit; do not replace it while the provider result is uncertain. Disconnect/reconnect the NWC relay without altering prior receipts. Wrong-network and wrong-amount cases are covered by controlled negative tests; do not spend test sats solely to generate failures.

## Current test results

| Check | Result |
| --- | --- |
| `npm test` | 25/25 passed, including four simulated rounds, payment-hash uniqueness, delayed settlement, relay reconnect, optional preimage verification, Signet invoice parser, environment isolation, and amount/hash/network failures |
| `npm run test:sandbox` | Passed: four **fake-sat** 100-sat payments, 400-sat funded round, duplicate block, payer reconnect, durable reload, three approvals |
| `npm run build` | Passed |
| `npm run check:secrets` | Passed; private Mutinynet NWC URI is in ignored `.env.mutinynet` and absent from Git candidates |
| `npm audit --omit=dev --audit-level=moderate` | Passed: zero reported vulnerabilities with TLS validation enabled |
| `npm run check:mutinynet-wallets` | Receiver connected on `signet`, scoped to receive; external payer and liquidity remain unverified by this script |
| `npm run check:ledger` on dedicated Mutinynet data | Passed: version 4, revision 1, one pending contribution |
| Genuine Mutinynet invoice | Issued through CircleSats, 100 sats, pending; expires `2026-10-27T13:38:25Z` |
| Genuine Mutinynet payment | **Not authorized or attempted** |

No outgoing Lightning payout has been executed or independently verified. Current payout approval remains a distinct application state.
