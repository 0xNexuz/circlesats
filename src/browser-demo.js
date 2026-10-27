import { createStore } from './store-browser.js';
import { createSandboxProvisioner } from './sandbox-lightning.js';
import { PRACTICE_PROVIDERS, claimGuestSats, createGuestInvoice, openGuestWallet, payGuestInvoice } from './guest-sandbox.js';
import { createMutinynetOpener } from './practice-client.js';

// Vercel hosts only the guided demo. This facade keeps the same UI and cycle
// engine running in one browser tab without server secrets or shared state.
// A visitor's demo wallet prefers real Mutinynet Lightning payments (invoices
// from the circle treasurer node, paid by the Mutinynet faucet through this
// site's /api/practice functions), then a private Alby sandbox wallet pair
// created in this tab (test sats), then the original simulation.
window.__CIRCLESATS_STATIC_DEMO = true;
const seed = createStore();
let session = null;
const networkFetch = window.fetch.bind(window);
let provisioner = null;
async function openSandboxPair() {
  if (!provisioner) {
    const { NWCClient } = await import('/nwc.bundle.js');
    provisioner = createSandboxProvisioner({ NWCClient, fetchImpl: networkFetch });
  }
  return provisioner();
}
const openMutinynet = createMutinynetOpener({ fetchImpl: networkFetch });
async function openPracticeWallet(options) {
  try { return await openMutinynet(options); }
  catch { return openSandboxPair(); }
}
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});
const failed = (message, status = 409) => json({ error: message }, status);
const publicRecord = (record, viewerId) => ({
  id: record.id, groupId: record.groupId, cycleId: record.cycleId, roundId: record.roundId,
  memberId: record.memberId, amountSats: record.amountSats, provider: PRACTICE_PROVIDERS.has(record.provider) ? record.provider : 'demo',
  environment: PRACTICE_PROVIDERS.has(record.provider) ? record.provider : 'simulated', status: record.status, createdAt: record.createdAt,
  expiresAt: record.expiresAt, paidAt: record.paidAt || null,
  paymentHash: record.status === 'paid' && viewerId ? record.paymentHash : null,
  paymentRequest: record.status === 'pending' && viewerId === record.memberId ? record.paymentRequest : null,
  preimage: record.status === 'paid' && viewerId === record.memberId ? record.proofPreimage ?? null : null,
  attribution: record.attribution || 'unverified'
});
function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}
window.fetch = async (resource, options = {}) => {
  const path = new URL(typeof resource === 'string' ? resource : resource.url, location.href).pathname;
  if (!path.startsWith('/api/')) return networkFetch(resource, options);
  const method = options.method || 'GET';
  try {
    if (method === 'GET' && path === '/api/me') return json({
      memberId: session?.memberId || null, kind: session ? 'guest-demo' : null,
      csrf: session?.csrf || null, wallet: session ? session.store.walletFor(session.memberId) : null
    });
    if (method === 'GET' && path === '/api/group') {
      const ledger = session?.store || seed;
      return json({ group: ledger.group(), cycle: ledger.cycle(), cycles: ledger.cycles(), round: ledger.round(),
        walletConnected: false, mode: 'demo', network: 'simulated', environment: 'simulated',
        sandboxPayerWalletPubkey: null, records: ledger.all().map(record => publicRecord(record, session?.memberId)) });
    }
    if (method === 'POST' && path === '/api/auth/login') return failed('Member sign-in needs the separately hosted CircleSats app. Explore this guided demo instead.', 403);
    if (method === 'POST' && path === '/api/auth/demo') {
      if (session) return failed('Leave the current demo before starting a new one.');
      session = { memberId: 'awa', csrf: randomHex(24), store: createStore() };
      return json({ memberId: session.memberId, kind: 'guest-demo', csrf: session.csrf });
    }
    if (method !== 'POST') return failed('Not found.', 404);
    if (!session) return failed('Start the guided demo first.', 401);
    if (options.headers?.['X-CSRF-Token'] !== session.csrf) return failed('Refresh and try again.', 403);
    const input = options.body ? JSON.parse(options.body) : {};
    const ledger = session.store;
    const actor = session.memberId;
    if (path === '/api/auth/logout') { session.sandbox?.close(); session = null; return json({ ok: true }); }
    if (path === '/api/demo/group') {
      const group = await ledger.createDemoGroup(actor, input);
      session.memberId = group.members[0].id;
      session.sandbox?.close(); session.sandbox = null;
      return json({ group }, 201);
    }
    if (path === '/api/demo/contribute') return json({ record: publicRecord(await ledger.simulateContribution(input.memberId, actor), actor) }, 201);
    if (path === '/api/round/approve') return json({ round: await ledger.approvePayout(actor, input.memberId) });
    if (path === '/api/round/settle-demo') return json({ cycle: await ledger.settleDemo(actor) });
    if (path === '/api/cycle/new') return json({ cycle: await ledger.newCycle(actor) }, 201);
    if (path === '/api/wallet/create') {
      if (session.walletOpening) return failed('Your wallet is already being created.');
      session.walletOpening = true;
      try {
        const { pair, wallet, created } = await openGuestWallet(ledger, actor, openPracticeWallet);
        if (created) { session.sandbox?.close(); session.sandbox = pair; }
        return json({ wallet }, 201);
      } finally { session.walletOpening = false; }
    }
    if (path === '/api/wallet/claim-demo') {
      const wallet = await claimGuestSats(ledger, session.sandbox || null, actor);
      return wallet ? json({ wallet }) : failed('Create a demo wallet first, or your one-time claim was used.');
    }
    if (path === '/api/wallet/pay-demo') {
      const record = ledger.latestFor(actor);
      if (!record || record.status !== 'pending') return failed('Create a pending contribution first.');
      if (PRACTICE_PROVIDERS.has(record.provider)) return json({ record: publicRecord(await payGuestInvoice(ledger, session.sandbox || null, actor), actor) });
      const paid = await ledger.payDemo(actor, record.id, ledger.group().amountSats);
      return paid ? json({ record: publicRecord(paid, actor) }) : failed('Create a wallet and claim enough demo sats first.');
    }
    if (path === '/api/invoices') {
      const group = ledger.group();
      const round = ledger.round();
      if (!round || round.phase !== 'open') return failed('This round is not open for contributions.');
      if (session.sandbox) {
        const result = await createGuestInvoice(ledger, session.sandbox, actor);
        return json({ record: publicRecord(result.record, actor) }, result.created ? 201 : 200);
      }
      const existing = ledger.latestFor(actor);
      if (existing?.status === 'paid') return failed('This member already contributed.');
      if (existing?.status === 'pending') return json({ record: publicRecord(existing, actor) });
      const record = { id: crypto.randomUUID(), groupId: group.id, cycleId: round.cycleId, roundId: round.id,
        memberId: actor, amountSats: group.amountSats, provider: 'demo', environment: 'simulated', status: 'pending',
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1800_000).toISOString(),
        paymentRequest: `demo:${crypto.randomUUID()}`, checkingId: crypto.randomUUID(), paymentHash: randomHex(32) };
      await ledger.add(record);
      return json({ record: publicRecord(record, actor) }, 201);
    }
    return failed('This public preview supports only simulated actions.', 404);
  } catch (error) {
    return failed(error.message || 'Unable to complete the demo action.', error.status || 500);
  }
};

await import('./app.js');
