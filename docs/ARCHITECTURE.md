# Architecture

```text
Member browser (access code, optional payer NWC)
  → Node HTTP app (session and CSRF checks)
  → savings-cycle store (group, rounds, contributions, approvals, audit)
  → LNbits or normally receive-only NWC adapter (invoice and settlement lookup)
  → verified contribution → funded round → member approvals
  → simulated settlement OR unverified real transfer claim
```

`src/app.js` owns routes and authorization. `src/store.js` owns the cycle state machine and serializes mutations. `src/durable-json.js` writes version-4 snapshots with a SHA-256 integrity check, file flush, atomic rename, and one validated prior `.bak` snapshot. `src/instance-lock.js` prevents a second production process from opening the same ledger. `src/lnbits.js` and `src/nwc-receiver.js` implement the receiver boundary; the latter reconnects to relays and rechecks the wallet identity and network. `src/auth.js` holds short-lived sessions and hashed access codes. `public/app.js` renders server-derived totals in the dashboard, ledger, receipts, and rotation timeline. Browser NWC payer code is bundled separately by `scripts/build.js`.

The default group has four members and a four-turn rotation. A private guest session owns an in-memory store so demo contributions cannot enter the shared ledger. Both demo and Lightning modes use the same cycle rules. Guest controls can stand in for each member only within that clearly labelled simulation.

The contribution pool is held by the configured treasurer wallet, outside CircleSats. An approval authorizes a proposed payout inside the app; it does not move money. A manually supplied reference remains an unverified claim. CircleSats does not calculate spendable wallet balance, reserve fees, hold funds in escrow, execute real payouts, or verify that a recipient received funds.

The chosen public-demo deployment is one Node process on a VM/VPS with a local persistent volume outside the source repository, an HTTPS reverse proxy, and private periodic off-host backups. `DATA_DIR` and `PUBLIC_HTTPS=1` are mandatory in production. The lock is deliberately fail-closed after an unclean exit; verify the old process is stopped and inspect the ledger before removing a stale lock. `npm run check:ledger` checks primary and backup integrity without changing data. JSON remains unsuitable for horizontally scaled or serverless replicas and is not a substitute for off-host backups. Production custody or multi-instance operation would require a transactional database, durable shared sessions, account lifecycle, independent payout proof, and specialist review.
