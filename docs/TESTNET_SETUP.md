# Getting real test sats and a wallet

## Current Mutinynet checkpoint (27 October 2026)

The user's Alby Hub is now operational on Mutinynet. The user reports an online faucet LND channel, 92,340 test sats outgoing, 5,000 sats incoming, and successful outgoing Mutinynet payments. Those capacity figures are operator-reported. CircleSats independently confirmed that the dedicated receive-only NWC connection reports `signet` and supports invoice creation and lookup without spending permission. Its NWC URI is held only in ignored `.env.mutinynet` as `NWC_RECEIVER_CONNECTION_SECRET`.

CircleSats is running locally at `http://127.0.0.1:3102/` with a dedicated `data/mutinynet` ledger. On 27 October at 13:08:26 UTC it created Awa's genuine 100-sat Signet invoice. The `lntbs` invoice, 100,000-msat amount, hash, and expiry were checked before storage. Independent receiving-wallet lookup returned pending, and the ledger shows zero confirmed sats. The invoice expires at **13:38:25 UTC (14:38:25 Lagos time)**. Full invoice text is kept in the ignored private file identified in [payment evidence](LIGHTNING_PAYMENT_EVIDENCE.md); do not publish it in Git.

```text
NETWORK: Mutinynet (operator-reported); NWC and BOLT11 Signet verified
RECEIVING WALLET: Connected
PAYING WALLET: Official Mutinynet faucet proposed; sign-in/payment not yet verified
INCOMING LIQUIDITY: 5,000 sats (operator-reported)
OUTGOING LIQUIDITY: Faucet capacity not yet verified
CIRCLESATS PROVIDER: Configured
READY FOR TEST PAYMENT: NO — explicit authorization and payer check pending
```

The user has only this Alby Hub. The [official Mutinynet faucet](https://faucet.mutinynet.com/) says it pays BOLT11 invoices from its separate node; it requires sign-in. That can establish an independent payer for this one receipt test. It cannot prove that Awa personally supplied the sats, so CircleSats will retain payer attribution as unverified. If the faucet cannot provide a clear payment result, obtain a second controlled Mutinynet wallet for the full two-wallet acceptance test. Never pay from the receiving Alby Hub to itself as substitute evidence.

**Next action:** inspect the 100-sat invoice, destination and any displayed fee at the faucet, then obtain the user's explicit authorization before submitting payment. After a successful payer result, run `npm run verify:mutinynet-payment` with TLS validation enabled and compare the receiver settlement and CircleSats receipt. If the invoice expires first, do not pay it; confirm the provider's terminal expired status before issuing a new invoice. No payment or funding action was executed by this work.

The official Alby Hub archive extracted earlier into a separate private folder was not used for the connected receiver, and the currently running Hub's data was not modified by CircleSats setup.
CircleSats starts in **simulation**. Its built-in wallet and sats are fictional. The Alby Developer Sandbox has now been verified end to end with two fake-sat wallets; it is separate from a real signet test. A real signet test requires two separate Lightning roles on the **same network**: an organizer-controlled receiving wallet and a member-controlled paying wallet. No real signet or mainnet CircleSats payment has been verified as of 27 October 2026.

## Fast fake-sat integration check

Run `npm run test:sandbox` as shown in the [README](../README.md). It creates two [Alby Developer Sandbox](https://guides.getalby.com/developer-guide/developer-guide/developer-sandbox) wallets without Docker, Bitcoin Core, or custody infrastructure and runs the payment-to-approval flow. Keep the ignored `data/alby-sandbox-wallets.json` private. The sandbox NWC network field says `mainnet` despite the sats being fake. Do not connect a real mainnet payer. Run `npm run configure:sandbox` and `npm run start:sandbox` for the local browser view; the app requires the designated sandbox payer public key. A browser payer needs its NWC URL from that private wallet file and should be used only on the local test instance.

## For a fresh test environment

1. Open the [Alby Hub desktop guide](https://guides.getalby.com/user-guide/alby-hub/alby-hub-flavors/desktop) and use its [official release page](https://github.com/getAlby/hub/releases) to download the Windows app. Configure a signet/Mutinynet wallet **before funding**; Alby's [network configuration](https://github.com/getAlby/hub#ldk-network-configuration) describes `NETWORK=signet` and Mutinynet endpoints. Save recovery material privately. A default wallet may be mainnet.
2. Obtain test coins using the [Mutinynet faucet](https://faucet.mutinynet.com/) and arrange outgoing Lightning capacity for the paying wallet. Check the wallet reports signet. Test coins have no mainnet value.
3. Use a separate receiving wallet with incoming capacity. It must support either receive-only NWC methods (`get_info`, `make_invoice`, `lookup_invoice`) or LNbits backed by the same network. The [Voltage development sandbox](https://docs.voltage.cloud/development-sandbox) may help with a test backend, but its staging Payments API key is **not** an LNbits invoice key. Confirm capabilities and any costs before provisioning.

## Connect CircleSats to the receiver

Choose one server-side path in a local `.env`:

```dotenv
LIGHTNING_PROVIDER=nwc
PAYMENT_ENVIRONMENT=signet
NWC_RECEIVER_CONNECTION_SECRET=nostr+walletconnect://receive-only-secret
LNBITS_NETWORK=signet
```

For this path, create a connection for the receiving wallet with invoice and lookup permissions only. It must **not** grant `pay_invoice`.

Or use [LNbits](https://docs.lnbits.com/guide/installation/first-setup) on a compatible backend:

```dotenv
LIGHTNING_PROVIDER=lnbits
PAYMENT_ENVIRONMENT=signet
LNBITS_URL=https://your-lnbits-instance.example
LNBITS_INVOICE_KEY=your-invoice-key
LNBITS_NETWORK=signet
```

Use the LNbits **invoice key**, never the admin/spending key. This PC did not have Docker installed at the last check; a Docker-based LNbits setup would require Docker Desktop or another host. `.env` is ignored by Git. Restart CircleSats after editing it and confirm the banner reports signet Lightning rather than simulated sats.

The LNbits adapter now credits only a paid status whose details echo the exact stored checking ID, payment hash, invoice, and amount. Validate this response shape against the chosen live LNbits instance before using it; a provider that omits those fields will remain uncredited rather than silently weakening receipt checks.

## Pay and verify

1. Sign in with a member access code and create a 100-sat invoice for the active round. Copy it to a compatible external wallet or scan its QR code. The [Mutinynet faucet](https://faucet.mutinynet.com/) may also offer invoice payment for an initial receiver check.
2. Verify the receiver reports settlement. CircleSats must display the correct member, round, amount, provider, payment hash, and paid time. A copied invoice proves **receipt**, not which person paid it.
3. To test in-app payment and account attribution, create a **separate** small-budget NWC app connection on the payer wallet with `pay_invoice`, connect it in CircleSats, and explicitly approve the payment in the wallet. CircleSats checks matching network and preimage. A valid preimage links the transaction to the signed-in account, not to legal identity.
4. Record the test environment, payment hash, amount, receiver status, date, and any failure. Keep keys, recovery phrases, and unredacted NWC URIs out of screenshots and documents.

The private guided demo remains usable even with a real receiver configured. Real payout execution and independent payout settlement verification are **not** implemented; use the labelled simulation for the full four-round presentation.

## Real signet acceptance test, after the operator provisions wallets

1. Confirm both wallet APIs report **signet**, and use a receiving wallet connection with only `get_info`, `make_invoice`, and `lookup_invoice`. Confirm the payer has a separate bounded `pay_invoice` connection. Leave `ALLOW_SANDBOX_RECEIVER_SPEND_PERMISSION` unset, and never reuse the fake-sat sandbox wallet.
2. Use a fresh private ledger and sign in as Awa. Create one 100-sat invoice. Record its network, amount, invoice, and payment hash without exposing secrets. Before paying, confirm CircleSats still shows pending after a status check.
3. With explicit authorization to spend test coins, pay from the separate signet payer. Confirm receipt using the receiver's independent lookup. Compare exact invoice, hash, and 100-sat amount. If using in-app NWC, verify the preimage hash and account attribution; if using QR or copy, expect payer identity to remain unverified.
4. Retry status checks and page reloads. Confirm exactly one durable receipt and 100 sats credited. Disconnect and reconnect the payer, simulate a relay interruption, and verify no duplicate credit. Wait for a deliberately unpaid invoice to expire; do not reissue while the provider result is uncertain.
5. Export a sanitized evidence record: provider, signet network, date, amount, invoice hash, receiving-wallet settled status, receipt ID, and ledger revision. Exclude all NWC URIs, keys, recovery phrases, and unredacted environment files. Test outgoing payout separately; approval and a typed reference are not settlement proof.
