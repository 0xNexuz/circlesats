// Guest-demo wallet actions backed by a private Alby sandbox wallet pair.
//
// Used by the Node server (for guest sessions) and by the browser-only Vercel
// preview. Each function works on one guest's own in-memory store and one
// wallet pair, so a guest can never affect the shared ledger or another guest.
// When no pair is available, callers keep the original simulated behaviour.
import { SANDBOX_ENVIRONMENT, SandboxError } from './sandbox-lightning.js';

export const SANDBOX_MAX_CONTRIBUTION_SATS = 5_000;
const problem = (message, status = 409) => Object.assign(new Error(message), { status });
const busy = new WeakSet();

// Creates the guest's demo wallet. Returns the opened pair, or null when the
// sandbox is unavailable and the wallet stays simulated.
export async function openGuestWallet(store, memberId, openPair) {
  const existing = store.walletFor(memberId);
  if (existing) return { pair: null, wallet: existing, created: false };
  let pair = null;
  if (openPair && store.group().amountSats <= SANDBOX_MAX_CONTRIBUTION_SATS) {
    try { pair = await openPair(); } catch { pair = null; }
  }
  let balanceSats = null;
  if (pair) {
    try { balanceSats = await pair.balanceSats(); }
    catch { pair.close(); pair = null; }
  }
  await store.createWallet(memberId);
  if (!pair) return { pair: null, wallet: store.walletFor(memberId), created: true };
  await store.syncWallet(memberId, { balanceSats, kind: SANDBOX_ENVIRONMENT });
  return { pair, wallet: store.walletFor(memberId), created: true };
}

export async function claimGuestSats(store, pair, memberId) {
  const wallet = store.walletFor(memberId);
  if (!wallet || wallet.claimed || !store.round()) return null;
  if (!pair) return store.claimDemo(memberId);
  const balanceSats = await pair.topUp(store.group().amountSats * 2);
  if (!(await store.claimDemo(memberId))) return null;
  await store.syncWallet(memberId, { balanceSats });
  return store.walletFor(memberId);
}

export async function createGuestInvoice(store, pair, memberId) {
  const group = store.group();
  const round = store.round();
  if (!round || round.phase !== 'open') throw problem('This round is not open for contributions.');
  const existing = store.latestFor(memberId);
  if (existing?.status === 'paid') throw problem('This member already contributed.');
  if (existing?.status === 'pending') {
    if (existing.provider !== SANDBOX_ENVIRONMENT || Date.now() < Date.parse(existing.expiresAt)) return { record: existing, created: false };
    await store.update(existing.id, { status: 'failed' });
  }
  const member = group.members.find(item => item.id === memberId);
  const invoice = await pair.createInvoice({ amountSats: group.amountSats,
    memo: `${group.name}: round ${round.number} - ${member?.name || 'Member'} (sandbox test sats)` });
  const record = {
    id: globalThis.crypto.randomUUID(), groupId: group.id, cycleId: round.cycleId, roundId: round.id,
    memberId, amountSats: group.amountSats, provider: SANDBOX_ENVIRONMENT, environment: SANDBOX_ENVIRONMENT,
    status: 'pending', createdAt: new Date().toISOString(), ...invoice
  };
  return { record: await store.add(record), created: true };
}

// Pays the guest's pending sandbox invoice from their own payer wallet. Only a
// receiver-confirmed settlement with a matching preimage marks it paid.
export async function payGuestInvoice(store, pair, memberId) {
  const record = store.latestFor(memberId);
  const round = store.round();
  if (!record || record.status !== 'pending' || record.provider !== SANDBOX_ENVIRONMENT) throw problem('Create a pending contribution first.');
  if (!round || round.phase !== 'open' || record.roundId !== round.id) throw problem('This round is not accepting contributions.');
  if (!pair) throw problem('Your sandbox wallet is no longer connected. Replay the demo to start again.');
  if (Date.now() >= Date.parse(record.expiresAt)) {
    await store.update(record.id, { status: 'failed' });
    throw problem('This invoice expired before payment. Create a new contribution.');
  }
  if (busy.has(pair)) throw problem('A payment is already in progress.');
  busy.add(pair);
  try {
    const result = await pair.pay(record);
    const paid = await store.update(record.id, { status: 'paid', paidAt: result.settledAt, attribution: 'sandbox-wallet-proof' });
    try { await store.syncWallet(memberId, { balanceSats: await pair.balanceSats() }); } catch { /* balance refreshes later */ }
    return paid;
  } finally { busy.delete(pair); }
}

export function isSandboxError(error) { return error instanceof SandboxError; }
