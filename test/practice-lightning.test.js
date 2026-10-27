import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createPracticeHandler, createPracticeService, PracticeError } from '../src/practice-lightning.js';
import { createMutinynetOpener } from '../src/practice-client.js';
import { claimGuestSats, createGuestInvoice, openGuestWallet, payGuestInvoice } from '../src/guest-sandbox.js';
import { createStore } from '../src/store.js';
import { makeSignetInvoice } from './support/bolt11-fixture.js';
import { fakeMutinynetFaucet, fakeTreasurer, practiceEnv } from './support/fake-mutinynet.js';

const sha = hex => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
function service({ mode, env = practiceEnv, treasurer = fakeTreasurer(), ...options } = {}) {
  const faucet = fakeMutinynetFaucet(treasurer, { mode });
  const practice = createPracticeService({ env, connectReceiver: async () => treasurer, fetchImpl: faucet.fetchImpl,
    faucetUrl: faucet.origin, settlePollMs: 1, settleAttempts: 3, ...options });
  return { practice, treasurer, faucet };
}

test('the faucet pays a treasurer invoice and the treasurer node confirms it once', async () => {
  const { practice, faucet } = service();
  assert.deepEqual(await practice.info(), { available: true, amountSats: 100, rails: { mainnet: { available: false },
    signet: { available: true, payer: 'Mutinynet faucet', label: 'Mutinynet Lightning (test coins)' } } });
  const invoice = await practice.createInvoice({ memo: 'Awa' });
  assert.match(invoice.paymentRequest, /^lntbs1000n1/);
  assert.equal(invoice.amountSats, 100);
  assert.equal((await practice.status(invoice)).status, 'pending');
  const paid = await practice.pay(invoice);
  assert.equal(paid.status, 'settled');
  assert.equal(sha(paid.preimage), invoice.paymentHash);
  assert.deepEqual(faucet.calls.payments, [invoice.paymentRequest]);
  // A retry reports the settled payment without asking the faucet to pay again.
  assert.equal((await practice.pay(invoice)).preimage, paid.preimage);
  assert.equal(faucet.calls.payments.length, 1);
  assert.equal((await practice.status(invoice)).status, 'settled');
});

test('only current invoices issued by the treasurer node can be paid', async () => {
  const { practice, faucet } = service();
  const foreignHash = randomBytes(32).toString('hex');
  const foreign = { paymentRequest: makeSignetInvoice({ paymentHash: foreignHash }), paymentHash: foreignHash };
  await assert.rejects(practice.pay(foreign), error => error instanceof PracticeError && error.status === 409);
  const mine = await practice.createInvoice();
  await assert.rejects(practice.pay({ ...mine, paymentHash: foreignHash }), error => error.status === 400);
  await assert.rejects(practice.pay({ paymentRequest: mine.paymentRequest.replace('lntbs', 'lnbc'), paymentHash: mine.paymentHash }), error => error.status === 400);
  const big = randomBytes(32).toString('hex');
  await assert.rejects(practice.pay({ paymentRequest: makeSignetInvoice({ paymentHash: big, amountSats: 5000 }), paymentHash: big }), error => error.status === 400);
  assert.equal(faucet.calls.payments.length, 0);
});

test('faucet limits, missing routes and odd callbacks are reported without crediting', async () => {
  for (const [mode, message] of [['limit', /daily limit/], ['quota', /daily limit/], ['noroute', /route/], ['foreign', /unexpected payment link/], ['unconfirmed', /not confirmed it yet/]]) {
    const { practice, treasurer, faucet } = service({ mode });
    const invoice = await practice.createInvoice();
    await assert.rejects(practice.pay(invoice), message, mode);
    assert.equal(treasurer.invoices.get(invoice.paymentHash).state, 'pending', mode);
    if (mode === 'foreign') assert.equal(faucet.calls.payments.length, 0);
  }
});

test('expired invoices are refused and a missing proof is never reported as settled', async () => {
  const expired = service();
  const invoice = await expired.practice.createInvoice();
  expired.treasurer.invoices.get(invoice.paymentHash).state = 'expired';
  await assert.rejects(expired.practice.pay(invoice), /expired/);
  assert.equal((await expired.practice.status(invoice)).status, 'expired');
  const hidden = service({ treasurer: fakeTreasurer({ hidePreimage: true }) });
  await assert.rejects(hidden.practice.pay(await hidden.practice.createInvoice()), /verifiable payment proof/);
});

test('the service stays off without a signet receive-only configuration', async () => {
  const off = createPracticeService({ env: {}, connectReceiver: async () => { throw new Error('must not connect'); } });
  assert.equal(off.enabled, false);
  await assert.rejects(off.createInvoice(), error => error.status === 503);
  const wrongNetwork = createPracticeService({ env: { ...practiceEnv, PAYMENT_ENVIRONMENT: 'alby-sandbox' } });
  assert.equal(wrongNetwork.enabled, false);
});

async function serve(t, practice) {
  const handle = createPracticeHandler(practice);
  const server = createServer((req, res) => handle(req, res, new URL(req.url, 'http://x').pathname.split('/').pop()));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/api/practice`;
}

test('a browser-style guest makes a real practice payment through the HTTP functions', async t => {
  const { practice, faucet } = service();
  const base = await serve(t, practice);
  const open = createMutinynetOpener({ base });
  const store = createStore(); const other = createStore();
  const { pair, wallet } = await openGuestWallet(store, 'awa', open);
  assert.equal(wallet.kind, 'mutinynet');
  assert.equal((await claimGuestSats(store, pair, 'awa')).balanceSats, 200);
  const { record } = await createGuestInvoice(store, pair, 'awa');
  assert.equal(record.provider, 'mutinynet');
  assert.match(record.paymentRequest, /^lntbs/);
  const paid = await payGuestInvoice(store, pair, 'awa');
  assert.equal(paid.status, 'paid');
  assert.equal(paid.attribution, 'faucet-lightning-proof');
  assert.equal(sha(paid.proofPreimage), paid.paymentHash);
  assert.equal(store.round().confirmedSats, 100);
  assert.equal(store.walletFor('awa').balanceSats, 100);
  assert.equal(other.round().confirmedSats, 0);
  assert.equal(faucet.calls.payments.length, 1);
  // Over HTTP, malformed and foreign requests are rejected cleanly.
  const bad = await fetch(`${base}/pay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"paymentHash":"x"}' });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${base}/pay`)).status, 405);
});

test('without the practice service the guest wallet falls back, and the API is rate limited', async t => {
  const offBase = await serve(t, createPracticeService({ env: {} }));
  assert.deepEqual(await (await fetch(`${offBase}/info`)).json(), { available: false });
  const store = createStore();
  const { pair, wallet } = await openGuestWallet(store, 'awa', createMutinynetOpener({ base: offBase }));
  assert.equal(pair, null);
  assert.equal(wallet.kind, undefined);
  const { practice } = service();
  const base = await serve(t, practice);
  const statuses = [];
  for (let i = 0; i < 31; i++) statuses.push((await fetch(`${base}/invoice`, { method: 'POST', body: '{}' })).status);
  assert.equal(statuses.at(-1), 429);
  assert.equal(statuses.filter(status => status === 201).length, 30);
});

test('an unreachable treasurer is reported at once for a minute, then retried', async () => {
  let clock = Date.now();
  let connects = 0;
  let online = false;
  const treasurer = fakeTreasurer();
  const practice = createPracticeService({ env: practiceEnv, now: () => clock, connectTimeoutMs: 30, failureCooldownMs: 60_000,
    connectReceiver: () => { connects++; return online ? Promise.resolve(treasurer) : new Promise(() => {}); } });
  const started = Date.now();
  assert.equal((await practice.info()).rails.signet.available, false);
  assert.ok(Date.now() - started >= 25, 'the first check waits for the connection timeout');
  const quick = Date.now();
  assert.equal((await practice.info()).rails.signet.available, false);
  await assert.rejects(practice.createInvoice({ network: 'signet' }), error => error.status === 503);
  assert.ok(Date.now() - quick < 25, 'later checks answer without waiting');
  assert.equal(connects, 1);
  online = true;
  clock += 60_001;
  assert.equal((await practice.info()).rails.signet.available, true);
  assert.equal(connects, 2);
  assert.equal((await practice.createInvoice({ network: 'signet' })).network, 'signet');
  assert.equal(connects, 2);
});
