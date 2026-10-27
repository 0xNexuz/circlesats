# Alby Developer Sandbox payment evidence

Latest run completed 27 October 2026 at 08:43 UTC (09:43 Lagos time). This was an interaction with two [Alby Developer Sandbox](https://guides.getalby.com/developer-guide/developer-guide/developer-sandbox) wallets through the official Alby JavaScript SDK and NWC. **The sats were fake.** The sandbox NWC response reported `mainnet`, but these hashes do not represent real Bitcoin network settlement. The same sandbox payer wallet paid all four invoices.

| Signed-in member | Amount | Receiver-confirmed incoming payment hash | Member proof |
| --- | ---: | --- | --- |
| Awa | 100 sats | `3514546dbc05469e4c834ea4a7f34e3a63a53b5f1cc65bacccd9a70949144e94` | Matching preimage |
| Mamadou | 100 sats | `7a6d7bbc311b7cad73dd76c40da72c0bf8638e2fc569dc429b326bf2089ee2bd` | Matching preimage |
| Fatou | 100 sats | `6288c1091116db47bc9bdf8c3868d6abbb239704caf24947e34d5e711731df33` | Matching preimage |
| Ibrahima | 100 sats | `42e80649e580017ec4d8c21ae4050747705b1609d86b978e367c809fd78a9f42` | Matching preimage |

CircleSats created each invoice for the current round and member, then checked the receiver's incoming `settled` lookup against the stored invoice, hash, and 100,000 millisat amount. Before the first payment, the payer was disconnected and reconnected; the unpaid invoice remained pending and the round stayed at zero sats. Each member account submitted the preimage returned by the **same** payer wallet. Repeat invoice requests were rejected. A fresh ledger load retained four paid records and a funded 400 sat round. Mamadou, Fatou, and Ibrahima approved Awa's proposed payout; the round ended in `approved`, with **no outgoing payout or settlement proof**.

The local machine retains a sanitized JSON artifact in ignored `data/alby-sandbox-evidence.json`. It contains no NWC URLs. The private wallet URLs stay in ignored `data/alby-sandbox-wallets.json`; the sandbox receiver URL has `pay_invoice` permission because of the faucet, so the app's normal receive-only rule is relaxed only by explicit fake-sat sandbox configuration. Relay connection timeouts occurred on some attempts; this completed run passed. See `scripts/alby-sandbox-smoke.mjs` and [Lightning integration](LIGHTNING_INTEGRATION.md) for the reproducible check.
