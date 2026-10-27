// Guest-demo wallet actions backed by a private practice wallet.
//
// A practice wallet is either a real Mutinynet one (invoices from the circle's
// treasurer node, paid by the Mutinynet faucet over the Mutinynet Lightning
// network) or an Alby sandbox pair (wallet-to-wallet NWC payments with test
// sats). Used by the Node server (guest sessions) and the browser-only Vercel
// preview. Each function works on one guest's own in-memory store and wallet,
// so a guest can never affect the shared ledger or another guest. Without a
// practice wallet, callers keep the original simulated behaviour.
import { SandboxError } from './sandbox-lightning.js';

export const PRACTICE_PROVIDERS = new Set(['mutinynet', 'alby-sandbox']);
export const SANDBOX_MAX_CONTRIBUTION_SATS = 5_000;
const problem = (message, status = 409) => Object.assign(new Error(message), { status });
const busy = new WeakSet();

// Creates the guest's demo wallet. Returns the opened practice wallet, or null
// when none is available and the wallet stays simulated.
export async function openGuestWallet(store, memberId, openPair) {
  const existing = store.walletFor(memberId);
  if (existing) return { pair: null, wallet: existing, created: false };
  const amountSats = store.group().amountSats;
  let pair = null;
  if (openPair && amountSats <= SANDBOX_MAX_CONTRIBUTION_SATS) {
    try { pair = await openPair({ amountSats }); } catch { pair = null; }
  }
  if (pair && !PRACTICE_PROVIDERS.has(pair.environment)) { pair.close(); pair = null; }
  let balanceSats = null;
  if (pair) {
    try { balanceSats = await pair.balanceSats(); }
    catch { pair.close(); pair = null; }
  }
  await store.createWallet(memberId);
  if (!pair) return { pair: null, wallet: store.walletFor(memberId), created: true };
  await store.syncWallet(memberId, { balanceSats, kind: pair.environment });
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
    if (!PRACTICE_PROVIDERS.has(existing.provider) || Date.now() < Date.parse(existing.expiresAt)) return { record: existing, created: false };
    await store.update(existing.id, { status: 'failed' });
  }
  const member = group.members.find(item => item.id === memberId);
  const invoice = await pair.createInvoice({ amountSats: group.amountSats,
    memo: `${group.name}: round ${round.number} - ${member?.name || 'Member'}` });
  const record = {
    id: globalThis.crypto.randomUUID(), groupId: group.id, cycleId: round.cycleId, roundId: round.id,
    memberId, amountSats: group.amountSats, provider: pair.environment, environment: pair.environment,
    status: 'pending', createdAt: new Date().toISOString(), ...invoice
  };
  return { record: await store.add(record), created: true };
}

// Pays the guest's pending practice invoice. Only a receiver-confirmed
// settlement with a matching preimage marks it paid.
export async function payGuestInvoice(store, pair, memberId) {
  const record = store.latestFor(memberId);
  const round = store.round();
  if (!record || record.status !== 'pending' || !PRACTICE_PROVIDERS.has(record.provider)) throw problem('Create a pending contribution first.');
  if (!round || round.phase !== 'open' || record.roundId !== round.id) throw problem('This round is not accepting contributions.');
  if (!pair || pair.environment !== record.provider) throw problem('Your practice wallet is no longer connected. Replay the demo to start again.');
  if (Date.now() >= Date.parse(record.expiresAt)) {
    await store.update(record.id, { status: 'failed' });
    throw problem('This invoice expired before payment. Create a new contribution.');
  }
  if (busy.has(pair)) throw problem('A payment is already in progress.');
  busy.add(pair);
  try {
    const result = await pair.pay(record);
    const paid = await store.update(record.id, { status: 'paid', paidAt: result.settledAt, proofPreimage: result.preimage,
      attribution: record.provider === 'mutinynet' ? 'faucet-lightning-proof' : 'sandbox-wallet-proof' });
    try { await store.syncWallet(memberId, { balanceSats: await pair.balanceSats() }); } catch { /* balance refreshes later */ }
    return paid;
  } finally { busy.delete(pair); }
}

export function isSandboxError(error) { return error instanceof SandboxError || error?.name === 'PracticeClientError'; }
