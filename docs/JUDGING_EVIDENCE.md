# Judging evidence

| Criterion | Demonstrable evidence | Boundary |
| --- | --- | --- |
| Usefulness and local impact | A familiar rotating savings circle with a visible 100-sat obligation, 400-sat target, named recipient, deadlines, and missing members | The scenario is illustrative; no user interviews or adoption data are claimed |
| Security by design | Access-code/CSRF checks, incoming settled invoice and exact hash/amount verification, unique hashes, nonrecipient approvals, audit trail, normally receive-only NWC receiver | Sandbox faucet receiver has spending permission for fake sats; no production custody or independent real payout verification |
| UX quality | Responsive forest/gold interface, clear wallet paths, persistent mobile navigation, readable cycle timeline and receipts, reduced-motion preloader | Device and bandwidth testing is limited to local browser checks |
| Working MVP | Automated four-round guest journey: 16 simulated contributions, 12 approvals, four simulated payouts, retained history, new cycle; separate Alby Sandbox integration: four fake-sat NWC settlements, durable ledger, three approvals | No real Bitcoin/signet or LNbits settlement, and no outgoing Lightning payout |
| Clear pitch | [Three-minute walkthrough](DEMO_WALKTHROUGH.md), [architecture](ARCHITECTURE.md), [security](SECURITY.md), and [setup](TESTNET_SETUP.md) | No public URL, submitted entry, or video yet |

Latest local verification on 27 October 2026: `npm test` passed 22 tests, `npm run build` succeeded, `npm audit --omit=dev --audit-level=moderate` reported zero vulnerabilities, and `npm run check:secrets` found no private sandbox wallet connections among 53 Git candidate files. The live Alby Sandbox check passed again and wrote sanitized local evidence to ignored `data/alby-sandbox-evidence.json`: four 100-sat fake-sat payments, 400-sat funded round, duplicate rejection, persisted ledger, and three approvals. Browser checks at 375 px, 615 px, and 1440 px showed no horizontal overflow, working navigation, and a preloader that released scrolling. At 375 px, a private guest created a simulated wallet, received demo sats, paid 100 sats, and saw a labeled receipt and 100/400-sat progress. Physical-device and public access checks remain. No deployment evidence exists.

[Official Devpost rules](https://dakar-bitcoin-hack-2026.devpost.com/rules) require a presentation, public GitHub repository, and an internet-accessible MVP **or** demo video by 20 November 2026. These submission artifacts are not yet public or submitted.
