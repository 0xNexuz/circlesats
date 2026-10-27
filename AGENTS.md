# CircleSats project recovery

- Read `docs/PROJECT_CONTEXT.md` before continuing work.
- Preserve the difference between tests against the local LNbits stand-in and a verified real Lightning payment.
- Never commit `.env`, wallet keys, or data files.
- Do not claim pooled custody, automated real payouts, or independently verified payout settlements. Nonrecipient approvals and simulated payout completion are implemented.
- Run `npm test` after changes to the payment or ledger flow.
