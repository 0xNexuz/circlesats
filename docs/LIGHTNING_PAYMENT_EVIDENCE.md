# Mutinynet Lightning payment evidence

**Status on 27 October 2026: INVOICE PENDING; PAYMENT NOT AUTHORIZED OR ATTEMPTED.** CircleSats generated a genuine Signet invoice through the connected receive-only NWC wallet. A separate receiver lookup returned pending, and the ledger still credits zero sats. The Alby Developer Sandbox evidence remains [separate](ALBY_SANDBOX_EVIDENCE.md).

| Field | Observed value |
| --- | --- |
| Network | Operator reports Mutinynet; NWC reports `signet`; invoice starts `lntbs` |
| Environment | Genuine Lightning test-network invoice; settlement pending |
| Contribution | Awa, 100 test sats, Dakar Market Circle round `977bb162-d644-4858-a312-1c8bc4e41832` |
| Contribution ID | `3c252ce6-6e7f-4ded-af56-0380603bf85d` |
| Receiving provider | Alby Hub receive-only NWC; connected and network/scopes verified |
| Payer wallet | Not connected; official Mutinynet faucet is the proposed independent payer service |
| Payment hash | `f81b977bca91f074fe91b54682705c4a80dd945939041ed951db3dbcc415293e` |
| Invoice reference | Private ignored `data/mutinynet/invoice-3c252ce6-6e7f-4ded-af56-0380603bf85d.json`; expires `2026-10-27T13:38:25Z` |
| Payer result | Not attempted |
| Receiver result | Independent NWC lookup: pending |
| Preimage verification | Unavailable |
| Settlement | **NOT CONFIRMED** |
| Ledger update | Version-4 ledger revision 1; one pending contribution; zero confirmed sats |
| Duplicate protection | Automated tests passed; real replay not tested |
| Persistence | Pending contribution persisted; read-only `check:ledger` passed. Settled receipt and restart not tested. |
| Test timestamp | Invoice created `2026-10-27T13:08:26.207Z`; no settlement timestamp |

After a real authorized payment, record the exact payment hash, provider and network, payer/receiver statuses, decoded amount, wallet-confirmed settlement time, CircleSats receipt ID and ledger revision, duplicate check, and restart result. Store only a safely redacted invoice reference here. Keep NWC URIs, recovery phrases, app keys, and unredacted environment files out of this public document and screenshots. A normal Lightning payment has no per-payment on-chain transaction ID; a channel-funding transaction can be linked only when independently identified and relevant.
