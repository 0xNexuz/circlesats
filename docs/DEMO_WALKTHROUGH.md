# Three-minute demo walkthrough

**0:00–0:25 — The problem.** Explain a community savings circle: everyone contributes, one member receives the pool each turn. Missed payments and unclear payout status make coordination hard. Avoid claiming interviews or adoption data.

**0:25–0:50 — The product.** Show the CircleSats dashboard: four members, 100 sats each, 400-sat pool, current recipient, and full rotation.

**0:50–1:15 — Onboarding.** Choose **Start guided demo**. Point out that this is private simulation with no real funds. Optionally show the custom group form, then keep the seeded four-member circle for a short demo.

**1:15–1:45 — Contribute.** Create Awa's demo wallet, get demo sats, create the contribution and **Pay with demo wallet**. When the header shows **ALBY SANDBOX · TEST SATS**, this is a real BOLT11 invoice paid over NWC between two private sandbox wallets; show the receipt's payment hash and say "test sats". If it shows **SIMULATED SATS**, the sandbox was unreachable and the payment is simulated. Then use the cycle panel's **Simulate** controls for the other members. Show the ledger reach 4/4 and 400/400 sats. For a separate live-wallet recording, configure a real receiver first, pay an invoice, and show a receiver-confirmed receipt. Do not splice a simulated action into footage as if it were a real payment.

**1:45–2:10 — Approve and settle.** Show Awa as scheduled recipient. Record Mamadou, Fatou, and Ibrahima's approvals. Explain that approval has not transferred money. Click **Simulate payout & open next round** and show Mamadou as next recipient.

**2:10–2:40 — Complete the rotation.** Repeat the guided simulated controls for rounds 2–4. Show the completed history, each recipient's turn, audit entries, and ability to start another cycle without erasing the first.

**2:40–3:00 — Credibility and next step.** Explain that server-side provider checks protect contribution status and that receiving connections are normally receive-only. A separate Alby Developer Sandbox flow verified four fake-sat payments and three approvals; signet, LNbits, and independent real payout verification remain to be done. Do not claim custody, escrow, or production use.

Before recording, start from a fresh private guest session; do not show member access codes, NWC secrets, `.env`, or wallet recovery material.

## Three-minute recording checklist

- [ ] Run `npm test`, `npm run build`, and `npm run check:secrets`; keep the current test counts in speaker notes rather than overlaying unverified claims.
- [ ] Open a fresh private guest session at a desktop width and verify the preloader reveals the page. Have a 375 px mobile view ready for a brief responsive proof if time allows.
- [ ] Rehearse one clean 3:00 take: problem (25 s), dashboard (25 s), private demo entry (25 s), contributions (30 s), approvals (25 s), remaining rotation (30 s), trust boundaries and next step (20 s).
- [ ] Keep the **Simulated demo** label visible when using demo sats and simulated payout. If showing Alby Sandbox evidence separately, label it **fake-sat sandbox** and never narrate it as signet or mainnet.
- [ ] Show the 400/400-sat funded round, three nonrecipient approvals, a simulated payout, and the next recipient. End on retained history after all four rounds.
- [ ] Hide browser autofill, notifications, private tabs, member codes, NWC URIs, `.env`, `DATA_DIR`, and recovery material before capture. Do not record raw terminal provisioning output or private wallet files.
- [ ] Check audio, readable text, and that the final capture is three minutes or less. Confirm every spoken payment and payout claim matches the visible environment label and receipt state.
- [ ] Prepare a presentation, public repo, and accessible MVP or demo video for submission only after the user authorizes publishing.
