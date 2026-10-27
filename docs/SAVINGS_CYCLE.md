# Savings-cycle rules

The seeded Dakar Market Circle contributes **100 sats × 4 members = 400 sats per round**. Rotation is fixed when a cycle starts: Awa → Mamadou → Fatou → Ibrahima. Each member receives one scheduled turn. Custom private demo groups support 2–8 members, weekly or monthly intervals, an amount in integer sats, a start date, and the member order entered by the facilitator. Rules cannot change after the first contribution.

Each round starts `scheduled`, except the active `open` round. A contribution is counted only once when its demo debit or independent receiver check makes it `paid`. The server derives paid count, confirmed sats, remaining sats, and pending member IDs from these records. When everyone pays, the round becomes `funded`. The recipient cannot approve their own payout; every other member must approve. `approved` still means **transfer not confirmed**.

In demo mode, an explicit **Simulate payout** action records a simulated settlement, marks the round completed, and opens the next round. After the final turn, the cycle becomes completed and a new cycle can be started without erasing history. Repeated settlement or new-cycle requests fail state checks. In Lightning mode, the organizer can enter a transfer reference, which moves the round to `settlement_pending` with `claimed_unverified` status. That action cannot complete or advance the real round.

Round deadlines derive from the group start date and frequency. The UI shows overdue and pending members; the app adds no automatic penalty. A round cannot advance while underfunded, unapproved, or merely claimed. Approvals, claims, demo contributions, simulated settlements, and cycle transitions are recorded in the audit trail with actor, time, round, and action.

The current shared group is seeded rather than editable. Joining is through organizer-issued member access codes; there is no public registration or invite-management UI. The custom group creator is intentionally limited to private simulation, so visitors cannot alter the shared circle.
