# Roadmap

## Built locally

- Seeded four-member savings group and private 2–8 member demo creator.
- Four-round deterministic rotation, deadlines, contribution accounting, nonrecipient approvals, simulated settlement, history, and audit.
- LNbits and receive-only NWC receiver adapters; external and connected NWC payer UI; preimage-to-account attribution.
- Responsive branded interface, preloader, tests, and documentation.

## Verified sandbox milestone, 26 October 2026

Two Alby Developer Sandbox wallets completed four fake-sat NWC contributions to CircleSats. Receiver status, amount/hash/invoice matching, preimage attribution, duplicate rejection, durable ledger reload, 400 sat funding, and three approvals passed. The same payer wallet paid all four invoices. The sandbox reports `mainnet` through NWC, but no real Bitcoin was moved. Its faucet receiver has spending permission, so it is allowed only with explicit sandbox-only configuration; real receiving credentials remain receive-only. Local relay startup was intermittent.

## Next verification milestone

1. Obtain a scoped receive-only signet NWC connection, or a signet-backed LNbits invoice key, and a separate funded signet payer. Verify a real testnet payment without disabling TLS.
2. If the hackathon demo will show the sandbox path, record a short, sanitized browser walkthrough and show the fake-sat label. If it will show the guided simulation, retain explicit simulation labels.
3. Verify 375 px and physical mobile layouts, external access, HTTPS, and persistent data on the proposed host.
4. Prepare the public GitHub repository, presentation, and accessible MVP or demo video for the user's approval. The [official rules](https://dakar-bitcoin-hack-2026.devpost.com/rules) set 20 November 2026 as the deadline.

No real wallet credentials, public deployment, repository push, or submission are present. Fake-sat sandbox credentials are held only in ignored local files. Publishing and submission require the user's authorization.

## After the MVP

- Independent proof of real payout settlement, fee reconciliation, and a safe mechanism for advancing real rounds.
- Transactional database, backup/restore, multi-group membership and invites, stronger identity and account recovery.
- Security review, operational monitoring, localization, accessibility/device testing, and custody/legal assessment before real savings use.
- Automated Lightning payouts only with explicit authorization, bounded spending policy, and separate controls.
