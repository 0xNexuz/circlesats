# Mutinynet Lightning payment evidence

## Verified: first real Lightning payment through CircleSats — 27 October 2026

**Status: SETTLED.** A genuine Lightning payment on Mutinynet (a public Bitcoin signet test network; test coins) was made through the public demo at circlesats-two.vercel.app. The Mutinynet faucet's node paid an invoice issued by the circle treasurer's Alby Hub, and the Hub confirmed it. This is test-coin evidence, not a real-Bitcoin (mainnet) payment.

| Field | Observed value |
| --- | --- |
| Network | Mutinynet (signet); invoice prefix `lntbs`, amount `1u` = 100 sats |
| Flow | Public demo guest (Awa, round 1) → `/api/practice/invoice` → `/api/practice/pay` (Vercel production, region fra1) |
| Invoice | `lntbs1u1p4wpe6wdrdgd5hycmvv4fkzarnypc8yctrw35kxefqvdhkuarjd9382arfdahr5gzyv94kzu3qf4shy6m9wssyx6tjvdkx2w3qwfhh2mnyyqcjqtfqg9mkznp4qfxr6gzfaq2adxq36ppjw03nad4m8pqde9fydtx9qek0zmeda93d5pp5npuzd0ae028tcxwpxh732l5nhdsdxjley4vxjg0vdh9r5jfxwscssp59ljh2uc3xze5k8xq0heh2vdv9308gfe3hhuqfaglqf7pw9w634gq9qyysgqcqzp2xqrpcgrzjqfr9a4d720gylhnxe9qclu22tu3xwu3czqtkeysjku3w2skurta3hapyqqqqqqzfsqqqqqlgqqqqqqgq2q8p79eu63hw2fzc07qhe3c8nl3q4l2xw6x54d2ec93p0cdcyvyay80xskknnh536z0eyj24zm7lzya7tqx8nxemyq7aehnkgjne8xjpsq6yjv9x` (paid; safe to publish) |
| Decoded | 100 sats; description "CircleSats practice contribution: Dakar Market Circle: round 1 - Awa"; created 2026-10-27T18:02:54Z; expiry 1800 s |
| Payee node (treasurer Alby Hub) | `024c3d2049e815d69811d043273e33eb6bb3840dc95246acc5066cf16f2de962da` |
| Route hint (faucet node) | `02465ed5be53d04fde66c9418ff14a5f2267723810176c9212b722e542dc1afb1b`, channel alias `f424000000004980` (an alias for an unannounced channel, not an on-chain position) |
| Payment hash | `987826bfb97a8ebc19c135fd157e93bb60d34bf925586921ec6dca3a49267431` |
| Preimage | `30dfefeb03f9c9228ef104946cc6601e96a682200a9ca386ddb8d4da4c2e5438` |
| Proof check | SHA-256(preimage) = payment hash; checked by the server, by the browser, and independently afterwards |
| Payer result | Mutinynet faucet LNURL-withdraw callback returned OK; `/api/practice/pay` completed in 3.3 s |
| Receiver result | Treasurer Alby Hub reported the invoice settled with a matching preimage; the operator's Alby Hub shows "Received +100 · CircleSats practice contribution: Dakar Market Circle: round 1" |
| CircleSats receipt | "Confirmed 10/27/2026, 7:03:05 PM" (UTC+1) · Mutinynet Lightning · test coins · payer identity not verified |
| Vercel logs | `invoice` 201 at 18:02:54Z and `pay` 200 `settled` at 18:03:05Z, hash prefix `987826bfb97a` |

### How anyone can verify it

1. Decode the invoice with any BOLT11 decoder: 100 sats, payee `024c3d20…62da`, payment hash `987826bf…7431`.
2. Compute SHA-256 of the preimage bytes (`echo -n 30dfefeb…5438 | xxd -r -p | sha256sum`) and compare it with the payment hash. A preimage is revealed only when a Lightning payment completes.
3. Lightning payments have no per-payment on-chain transaction. Only the channel's funding and closing are on-chain; the funding transaction of the treasurer's channel with the faucet node can be looked up on mutinynet.com once its transaction ID is copied from Alby Hub.

## Earlier pre-payment checkpoint (superseded)

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
