import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { decodeLedger, writeLedger } from './durable-json.js';

export const GROUP = Object.freeze({
  id: 'dakar-market-circle', name: 'Dakar Market Circle',
  description: 'A four-member market savings circle.', cycle: 'November contribution',
  amountSats: 100, frequency: 'weekly', startDate: '2026-11-02', deadlineDays: 7,
  organizerId: 'awa', members: [
    { id: 'awa', name: 'Awa' }, { id: 'mamadou', name: 'Mamadou' },
    { id: 'fatou', name: 'Fatou' }, { id: 'ibrahima', name: 'Ibrahima' }
  ]
});

const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const problem = (message, status = 409) => Object.assign(new Error(message), { status });

function deadlineFor(group, index, cycleNumber) {
  const date = new Date(`${group.startDate || new Date().toISOString().slice(0, 10)}T12:00:00Z`);
  const offset = index + (cycleNumber - 1) * group.members.length;
  if (group.frequency === 'monthly') date.setUTCMonth(date.getUTCMonth() + offset);
  else date.setUTCDate(date.getUTCDate() + offset * 7);
  date.setUTCDate(date.getUTCDate() + (group.deadlineDays || 7));
  return date.toISOString();
}

function makeCycle(group, number) {
  return {
    id: randomUUID(), number, groupId: group.id, status: 'active', createdAt: now(),
    completedAt: null, activeRoundNumber: 1,
    rounds: group.members.map((member, index) => ({
      id: randomUUID(), number: index + 1, recipientId: member.id,
      phase: index === 0 ? 'open' : 'scheduled', deadlineAt: deadlineFor(group, index, number),
      approvals: [], settlement: { status: 'not_requested' }, completedAt: null
    })), audit: []
  };
}

export function createStore(file = null, { initialGroup = GROUP } = {}) {
  let group = clone(initialGroup);
  let records = [];
  let wallets = {};
  let cycles = [makeCycle(group, 1)];
  let activeCycleId = cycles[0].id;
  let revision = 0;
  let queue = Promise.resolve();
  const activeCycle = () => cycles.find(item => item.id === activeCycleId);
  const activeRound = () => activeCycle()?.rounds.find(item => item.number === activeCycle().activeRoundNumber) || null;
  const audit = (cycle, action, actorId, roundId, detail = {}) => cycle.audit.push({ id: randomUUID(), at: now(), action, actorId, roundId, detail });

  async function persist() {
    if (!file) return;
    await writeLedger(file, { version: 4, revision, group, records, wallets, cycles, activeCycleId });
  }

  function mutate(fn) {
    const work = queue.then(async () => {
      const before = clone({ group, records, wallets, cycles, activeCycleId, revision });
      try {
        const result = fn();
        revision++;
        await persist();
        return clone(result);
      } catch (error) {
        ({ group, records, wallets, cycles, activeCycleId, revision } = before);
        throw error;
      }
    });
    queue = work.catch(() => {});
    return work;
  }

  function roundSummary(cycle, round) {
    const contributions = records.filter(record => record.roundId === round.id && record.status === 'paid');
    const paidMembers = new Set(contributions.map(record => record.memberId));
    const confirmedSats = [...paidMembers].reduce((sum, memberId) =>
      sum + (contributions.find(item => item.memberId === memberId).amountSats || group.amountSats), 0);
    const expectedSats = group.amountSats * group.members.length;
    return {
      id: round.id, cycleId: cycle.id, number: round.number, recipientId: round.recipientId,
      recipientName: group.members.find(member => member.id === round.recipientId)?.name || 'Member',
      phase: round.phase, deadlineAt: round.deadlineAt, paidCount: paidMembers.size,
      memberCount: group.members.length, expectedSats, confirmedSats,
      remainingSats: Math.max(0, expectedSats - confirmedSats),
      pendingMemberIds: group.members.filter(member => !paidMembers.has(member.id)).map(member => member.id),
      approvals: clone(round.approvals), approvalsRequired: Math.max(1, group.members.length - 1),
      settlement: clone(round.settlement), completedAt: round.completedAt
    };
  }
  function cycleSummary(cycle) {
    return {
      id: cycle.id, number: cycle.number, groupId: cycle.groupId, status: cycle.status,
      activeRoundNumber: cycle.activeRoundNumber, createdAt: cycle.createdAt, completedAt: cycle.completedAt,
      rounds: cycle.rounds.map(round => roundSummary(cycle, round)), audit: clone(cycle.audit)
    };
  }
  function afterPayment(record) {
    const cycle = cycles.find(item => item.id === record.cycleId);
    const round = cycle?.rounds.find(item => item.id === record.roundId);
    if (!round || round.phase !== 'open') return;
    const paid = new Set(records.filter(item => item.roundId === round.id && item.status === 'paid').map(item => item.memberId));
    if (group.members.every(member => paid.has(member.id))) {
      round.phase = 'funded'; round.settlement.status = 'awaiting_approval';
      audit(cycle, 'round_funded', 'system', round.id, { confirmedSats: group.amountSats * group.members.length });
    }
  }

  return {
    async load() {
      if (!file) return;
      try {
        const parsed = decodeLedger(await readFile(file, 'utf8'));
        group = parsed.group || clone(initialGroup); records = parsed.records; wallets = parsed.wallets || {};
        cycles = parsed.cycles || [makeCycle(group, 1)]; activeCycleId = parsed.activeCycleId || cycles[0].id;
        revision = parsed.revision || 0;
        if (!parsed.cycles) {
          const first = cycles[0].rounds[0];
          records = records.map(record => ({ ...record, groupId: group.id, cycleId: cycles[0].id,
            roundId: first.id, amountSats: group.amountSats,
            provider: record.paymentRequest?.startsWith('demo:') ? 'demo' : 'lnbits' }));
          afterPayment({ cycleId: cycles[0].id, roundId: first.id });
          revision++;
          await persist();
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try { await stat(`${file}.bak`); throw new Error('Ledger primary missing while a backup exists; restore manually before starting.'); }
        catch (backupError) { if (backupError.code !== 'ENOENT') throw backupError; }
      }
    },
    group() { return clone(group); }, all() { return clone(records); },
    cycles() { return cycles.map(cycleSummary); }, cycle() { return cycleSummary(activeCycle()); },
    round() { const cycle = activeCycle(); const round = activeRound(); return round ? roundSummary(cycle, round) : null; },
    walletFor(memberId) {
      if (!wallets[memberId]) return null;
      const wallet = clone(wallets[memberId]);
      const roundId = activeRound()?.id;
      wallet.claimed = (wallet.claimedRoundIds || (wallet.claimed ? [cycles[0].rounds[0].id] : [])).includes(roundId);
      return wallet;
    },
    latestFor(memberId, roundId = activeRound()?.id) {
      const record = [...records].reverse().find(item => item.memberId === memberId && item.roundId === roundId);
      return record ? clone(record) : null;
    },
    async createWallet(memberId) { return mutate(() => { wallets[memberId] ||= { balanceSats: 0, claimed: false, claimedRoundIds: [] }; return wallets[memberId]; }); },
    // Records the balance reported by a guest's sandbox wallet and its kind.
    async syncWallet(memberId, { balanceSats, kind } = {}) { return mutate(() => {
      const wallet = wallets[memberId]; if (!wallet) return null;
      if (Number.isSafeInteger(balanceSats) && balanceSats >= 0) wallet.balanceSats = balanceSats;
      if (['alby-sandbox', 'mutinynet', 'mainnet'].includes(kind)) wallet.kind = kind;
      return wallet;
    }); },
    async claimDemo(memberId) { return mutate(() => {
      const wallet = wallets[memberId]; const roundId = activeRound()?.id;
      if (!wallet || !roundId) return null;
      wallet.claimedRoundIds ||= wallet.claimed ? [cycles[0].rounds[0].id] : [];
      if (wallet.claimedRoundIds.includes(roundId)) return null;
      wallet.balanceSats += group.amountSats * 2; wallet.claimedRoundIds.push(roundId);
      wallet.claimed = true; return wallet;
    }); },
    async payDemo(memberId, recordId, amount) { return mutate(() => {
      const wallet = wallets[memberId]; const round = activeRound();
      const record = records.find(item => item.id === recordId && item.memberId === memberId && item.roundId === round?.id);
      if (!wallet || !record || record.status !== 'pending' || round.phase !== 'open' || wallet.balanceSats < amount || record.amountSats !== amount) return null;
      wallet.balanceSats -= amount;
      Object.assign(record, { status: 'paid', paidAt: now(), attribution: 'demo-wallet' });
      afterPayment(record); return record;
    }); },
    async add(record) { return mutate(() => {
      const round = activeRound();
      if (!round || round.phase !== 'open' || record.roundId !== round.id || record.groupId !== group.id || record.cycleId !== activeCycleId) throw problem('This round is not open for contributions.');
      if (!group.members.some(member => member.id === record.memberId)) throw problem('Member is not in this circle.', 403);
      if (records.some(item => item.roundId === round.id && item.memberId === record.memberId && ['pending','paid'].includes(item.status))) throw problem('This member already has a contribution for the round.');
      if (record.provider !== 'demo' && (!/^[a-f0-9]{64}$/i.test(record.paymentHash || '') ||
          records.some(item => item.paymentHash?.toLowerCase() === record.paymentHash.toLowerCase()))) throw problem('Payment hash was already used or invalid.');
      if (record.provider !== 'demo') record = { ...record, paymentHash: record.paymentHash.toLowerCase() };
      records.push(record); return record;
    }); },
    async update(id, changes) { return mutate(() => {
      const record = records.find(item => item.id === id); if (!record) return null;
      if (record.status === 'paid' && changes.status && changes.status !== 'paid') throw problem('A paid contribution cannot be reversed.');
      if (record.status === 'paid' && changes.status === 'paid' && changes.attribution === record.attribution) return record;
      Object.assign(record, changes); if (record.status === 'paid') afterPayment(record); return record;
    }); },
    async simulateContribution(memberId, actorId) { return mutate(() => {
      const cycle = activeCycle(); const round = activeRound();
      if (!round || round.phase !== 'open') throw problem('This round is not accepting contributions.');
      if (!group.members.some(member => member.id === memberId)) throw problem('Member is not in this circle.', 400);
      if (records.some(item => item.roundId === round.id && item.memberId === memberId && item.status === 'paid')) throw problem('This member already contributed.');
      const pending = [...records].reverse().find(item => item.roundId === round.id && item.memberId === memberId && item.status === 'pending');
      const record = pending || { id: randomUUID(), groupId: group.id, cycleId: cycle.id, roundId: round.id,
        memberId, amountSats: group.amountSats, provider: 'demo', status: 'pending', createdAt: now(),
        expiresAt: null, checkingId: randomUUID(), paymentHash: randomUUID().replaceAll('-', ''), paymentRequest: null };
      if (!pending) records.push(record);
      Object.assign(record, { status: 'paid', paidAt: now(), attribution: 'demo-facilitator' });
      audit(cycle, 'demo_contribution', actorId, round.id, { memberId, amountSats: group.amountSats });
      afterPayment(record); return record;
    }); },
    async approvePayout(actorId, approverId = actorId) { return mutate(() => {
      const cycle = activeCycle(); const round = activeRound();
      if (!round || !['funded','approved'].includes(round.phase)) throw problem('All contributions must be confirmed before payout approval.');
      if (round.recipientId === approverId) throw problem('The recipient cannot approve their own payout.', 403);
      if (!group.members.some(member => member.id === approverId)) throw problem('Approver is not in this circle.', 403);
      if (round.approvals.some(item => item.memberId === approverId)) throw problem('This member already approved the payout.');
      round.approvals.push({ memberId: approverId, at: now(), actorId });
      audit(cycle, 'payout_approved_by_member', actorId, round.id, { approverId });
      if (round.approvals.length >= Math.max(1, group.members.length - 1)) {
        round.phase = 'approved'; round.settlement.status = 'approved';
        audit(cycle, 'payout_approved', 'system', round.id, { amountSats: group.amountSats * group.members.length });
      }
      return roundSummary(cycle, round);
    }); },
    async recordSettlementClaim(actorId, { reference, method = 'Lightning' }) { return mutate(() => {
      const cycle = activeCycle(); const round = activeRound();
      if (!round || round.phase !== 'approved') throw problem('Payout must be approved before recording a transfer claim.');
      if (typeof reference !== 'string' || !/^[a-zA-Z0-9:_-]{8,160}$/.test(reference)) throw problem('Enter a payment reference of 8–160 letters, numbers, colons, dashes or underscores.', 400);
      round.phase = 'settlement_pending';
      round.settlement = { status: 'claimed_unverified', method, reference, claimedAt: now(), claimedBy: actorId, amountSats: group.amountSats * group.members.length };
      audit(cycle, 'settlement_claimed_unverified', actorId, round.id, { reference });
      return roundSummary(cycle, round);
    }); },
    async settleDemo(actorId) { return mutate(() => {
      const cycle = activeCycle(); const round = activeRound();
      if (!round || round.phase !== 'approved') throw problem('Payout approval is required before simulated settlement.');
      round.phase = 'completed'; round.completedAt = now();
      round.settlement = { status: 'simulated', method: 'demo', amountSats: group.amountSats * group.members.length, settledAt: round.completedAt };
      audit(cycle, 'simulated_payout_completed', actorId, round.id, { recipientId: round.recipientId });
      if (round.number === cycle.rounds.length) {
        cycle.status = 'completed'; cycle.completedAt = now(); cycle.activeRoundNumber = null;
        audit(cycle, 'cycle_completed', 'system', round.id);
      } else {
        cycle.activeRoundNumber = round.number + 1;
        cycle.rounds[round.number].phase = 'open';
        audit(cycle, 'round_opened', 'system', cycle.rounds[round.number].id);
      }
      return cycleSummary(cycle);
    }); },
    async newCycle(actorId) { return mutate(() => {
      if (activeCycle().status !== 'completed') throw problem('Complete the current cycle first.');
      const next = makeCycle(group, cycles.length + 1); cycles.push(next); activeCycleId = next.id;
      audit(next, 'cycle_started', actorId, next.rounds[0].id); return cycleSummary(next);
    }); },
    async createDemoGroup(actorId, input) { return mutate(() => {
      if (records.length || activeCycle().rounds.some(round => round.approvals.length)) throw problem('Reset the demo before changing group rules.');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw problem('Enter your circle rules.', 400);
      const names = input.members;
      if (!Array.isArray(names) || names.length < 2 || names.length > 8 || names.some(name => typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 40)) throw problem('Choose 2–8 member names, each 2–40 characters.', 400);
      if (new Set(names.map(name => name.trim().toLowerCase())).size !== names.length) throw problem('Member names must be unique.', 400);
      if (!Number.isSafeInteger(input.amountSats) || input.amountSats < 1 || input.amountSats > 1_000_000) throw problem('Contribution must be 1–1,000,000 sats.', 400);
      if (!['weekly','monthly'].includes(input.frequency)) throw problem('Choose weekly or monthly contributions.', 400);
      if (typeof input.name !== 'string' || input.name.trim().length < 3 || input.name.trim().length > 80) throw problem('Group name must be 3–80 characters.', 400);
      const date = input.startDate || new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw problem('Enter a valid start date.', 400);
      group = { id: `demo-${randomUUID()}`, name: input.name.trim(), description: String(input.description || '').trim().slice(0, 240),
        cycle: 'Community savings cycle', amountSats: input.amountSats, frequency: input.frequency,
        startDate: date, deadlineDays: input.frequency === 'weekly' ? 7 : 30,
        organizerId: 'guest', members: names.map((name, index) => ({ id: `member-${index + 1}`, name: name.trim() })) };
      records = []; wallets = {}; cycles = [makeCycle(group, 1)]; activeCycleId = cycles[0].id;
      audit(cycles[0], 'demo_group_created', actorId, cycles[0].rounds[0].id, { memberCount: group.members.length });
      return clone(group);
    }); }
  };
}
