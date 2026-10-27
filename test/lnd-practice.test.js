import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { assertReceiveOnlyMacaroon, createLndReceiver, macaroonPermissions } from '../src/lnd-receiver.js';
import { createPracticeService } from '../src/practice-lightning.js';
import { ADMIN_PERMISSIONS, INVOICE_PERMISSIONS, fakeLnd, makeMacaroon } from './support/fake-lnd.js';
import { fakeMutinynetFaucet, fakeTreasurer, practiceEnv } from './support/fake-mutinynet.js';

const sha = hex => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');

test('only an invoice-only LND macaroon is accepted', () => {
  assert.deepEqual(macaroonPermissions(makeMacaroon()), INVOICE_PERMISSIONS);
  assert.deepEqual(macaroonPermissions(makeMacaroon(INVOICE_PERMISSIONS, { encoding: 'base64' })), INVOICE_PERMISSIONS);
  assert.ok(assertReceiveOnlyMacaroon(makeMacaroon()));
  assert.ok(assertReceiveOnlyMacaroon(makeMacaroon(['uri:/lnrpc.Lightning/AddInvoice', 'uri:/lnrpc.Lightning/LookupInvoice'])));
  assert.throws(() => assertReceiveOnlyMacaroon(makeMacaroon(ADMIN_PERMISSIONS)), /can spend funds/);
  assert.throws(() => assertReceiveOnlyMacaroon(makeMacaroon([...INVOICE_PERMISSIONS, 'offchain:write'])), /can spend funds/);
  assert.throws(() => assertReceiveOnlyMacaroon(makeMacaroon([...INVOICE_PERMISSIONS, 'uri:/lnrpc.Lightning/SendPaymentSync'])), /can spend funds/);
  assert.throws(() => assertReceiveOnlyMacaroon(makeMacaroon(['invoices:read', 'info:read', 'offchain:read'])), /read and write/);
  assert.throws(() => assertReceiveOnlyMacaroon('not a macaroon!'), /could not be read/);
  assert.throws(() => assertReceiveOnlyMacaroon(randomBytes(40).toString('hex')), /could not be read/);
});

test('the LND receiver issues Mutinynet invoices and confirms them with a verified preimage', async () => {
  const lnd = fakeLnd();
  const connect = (options = {}) => createLndReceiver({ restUrl: lnd.host, macaroon: lnd.macaroon, fetchImpl: lnd.fetchImpl, ...options });
  assert.equal(await createLndReceiver({ restUrl: '', macaroon: lnd.macaroon }), null);
  await assert.rejects(connect({ restUrl: 'http://node.lnd.test:8080' }), /must use https/);
  await assert.rejects(connect({ macaroon: makeMacaroon(ADMIN_PERMISSIONS) }), /can spend funds/);
  await assert.rejects(connect({ macaroon: makeMacaroon() }), /refused the invoice macaroon|rejected the request/);
  assert.equal(lnd.calls.filter(call => call.macaroon && call.macaroon !== Buffer.from(lnd.macaroon, 'hex').toString('hex')).length, 1, 'an admin macaroon is refused before any request');

  const receiver = await connect({ restUrl: 'node.lnd.test:8080/' });
  const invoice = await receiver.createInvoice({ amount: 100, memo: 'Awa' });
  assert.match(invoice.paymentRequest, /^lntbs1000n1/);
  const record = { ...invoice, amountSats: 100 };
  assert.deepEqual(await receiver.checkPayment(record), { settled: false });
  lnd.settle(invoice.paymentRequest);
  const paid = await receiver.checkPayment(record);
  assert.equal(paid.settled, true);
  assert.equal(paid.preimageVerified, true);
  assert.equal(sha(paid.preimage), invoice.paymentHash);
  assert.match(paid.settledAt, /^\d{4}-/);
  await assert.rejects(receiver.checkPayment({ ...record, amountSats: 101 }), /do not match/);
  const foreign = randomBytes(32).toString('hex');
  await assert.rejects(receiver.checkPayment({ paymentHash: foreign, paymentRequest: 'lntbs1', amountSats: 100 }), /no such invoice/);

  const second = await receiver.createInvoice({ amount: 100 });
  lnd.cancel(second.paymentRequest);
  assert.deepEqual(await receiver.checkPayment({ ...second, amountSats: 100 }), { settled: false, failed: true });

  const numeric = fakeLnd({ numericState: true });
  const numericReceiver = await createLndReceiver({ restUrl: numeric.host, macaroon: numeric.macaroon, fetchImpl: numeric.fetchImpl });
  const third = await numericReceiver.createInvoice({ amount: 100 });
  numeric.settle(third.paymentRequest);
  assert.equal((await numericReceiver.checkPayment({ ...third, amountSats: 100 })).settled, true);
});

function lndService({ env = {}, faucetMode } = {}) {
  const lnd = fakeLnd();
  const faucet = fakeMutinynetFaucet(lnd, { mode: faucetMode });
  const lndOrigin = new URL(lnd.host).origin;
  const sent = [];
  const fetchImpl = (url, options = {}) => {
    sent.push({ origin: new URL(url).origin, macaroon: options.headers?.['Grpc-Metadata-macaroon'] });
    return new URL(url).origin === lndOrigin ? lnd.fetchImpl(url, options) : faucet.fetchImpl(url, options);
  };
  let nwcConnects = 0;
  const practice = createPracticeService({ env: { LND_REST_URL: lnd.host, LND_INVOICE_MACAROON: lnd.macaroon, ...env }, fetchImpl, faucetUrl: faucet.origin,
    connectReceiver: async () => { nwcConnects++; return fakeTreasurer(); }, settlePollMs: 1, settleAttempts: 3 });
  return { practice, lnd, faucet, sent, nwcConnects: () => nwcConnects };
}

test('test coins run on the hosted LND node, paid by the Mutinynet faucet', async () => {
  const { practice, lnd, faucet, sent, nwcConnects } = lndService({ env: practiceEnv });
  const info = await practice.info();
  assert.equal(info.rails.signet.available, true);
  assert.equal(info.rails.mainnet.available, false);
  const invoice = await practice.createInvoice({ memo: 'Awa', network: 'signet' });
  assert.equal(invoice.network, 'signet');
  assert.match(invoice.paymentRequest, /^lntbs/);
  assert.equal((await practice.status(invoice)).status, 'pending');
  const paid = await practice.pay(invoice);
  assert.equal(paid.status, 'settled');
  assert.equal(sha(paid.preimage), invoice.paymentHash);
  assert.equal(faucet.calls.payments.length, 1);
  // Paying again reports the settled invoice instead of asking the faucet twice.
  assert.equal((await practice.pay(invoice)).status, 'settled');
  assert.equal(faucet.calls.payments.length, 1);
  // The LND node is preferred over the Alby Hub connection when both are set,
  // and the macaroon only ever goes to the LND node.
  assert.equal(nwcConnects(), 0);
  assert.ok(sent.filter(call => call.macaroon).every(call => call.origin === new URL(lnd.host).origin));
  // An invoice from another node is refused before the faucet is asked.
  const otherHash = randomBytes(32).toString('hex');
  const { makeSignetInvoice } = await import('./support/bolt11-fixture.js');
  await assert.rejects(practice.pay({ paymentRequest: makeSignetInvoice({ paymentHash: otherHash }), paymentHash: otherHash }), error => error.status === 409);
  assert.equal(faucet.calls.payments.length, 1);
});

test('the test-coin rail reports unavailable when the LND credential is unsafe or unreachable', async () => {
  const unsafe = createPracticeService({ env: { LND_REST_URL: 'https://node.lnd.test:8080', LND_INVOICE_MACAROON: makeMacaroon(ADMIN_PERMISSIONS) },
    fetchImpl: () => { throw new Error('must not be called'); } });
  assert.equal((await unsafe.info()).rails.signet.available, false);
  const offline = createPracticeService({ env: { LND_REST_URL: 'https://node.lnd.test:8080', LND_INVOICE_MACAROON: makeMacaroon() },
    fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.equal((await offline.info()).available, false);
  const off = createPracticeService({ env: { LND_REST_URL: 'https://node.lnd.test:8080', LND_INVOICE_MACAROON: makeMacaroon(), PRACTICE_LIGHTNING: '0' } });
  assert.equal(off.enabled, false);
});
