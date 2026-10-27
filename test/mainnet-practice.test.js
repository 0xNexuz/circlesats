import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createBlinkReceiver } from '../src/blink-receiver.js';
import { createPracticeHandler, createPracticeService } from '../src/practice-lightning.js';
import { createPracticeOpener } from '../src/practice-client.js';
import { claimGuestSats, createGuestInvoice, openGuestWallet, payGuestInvoice, switchGuestPractice } from '../src/guest-sandbox.js';
import { createStore } from '../src/store.js';
import { makeSignetInvoice } from './support/bolt11-fixture.js';
import { fakeBlink } from './support/fake-blink.js';
import { fakeMutinynetFaucet, fakeTreasurer, practiceEnv } from './support/fake-mutinynet.js';

const sha = hex => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
const blinkEnv = { BLINK_RECEIVE_API_KEY: 'test-receive-key' };

test('the Blink receiver accepts only a read-and-receive key on mainnet', async () => {
  const connect = blink => createBlinkReceiver({ apiKey: 'test-receive-key', fetchImpl: blink.fetchImpl });
  await assert.rejects(connect(fakeBlink({ scopes: ['READ', 'RECEIVE', 'WRITE'] })), /can spend funds/);
  await assert.rejects(connect(fakeBlink({ scopes: ['READ'] })), /Read and Receive/);
  await assert.rejects(connect(fakeBlink({ network: 'signet' })), /network does not match/);
  assert.equal(await createBlinkReceiver({ apiKey: '' }), null);

  const blink = fakeBlink();
  const receiver = await connect(blink);
  const invoice = await receiver.createInvoice({ amount: 100, memo: 'Awa' });
  assert.match(invoice.paymentRequest, /^lnbc1000n1/);
  const record = { ...invoice, amountSats: 100 };
  assert.deepEqual(await receiver.checkPayment(record), { settled: false });
  blink.payExternally(invoice.paymentRequest);
  const paid = await receiver.checkPayment(record);
  assert.equal(paid.settled, true);
  assert.equal(paid.preimageVerified, true);
  assert.equal(sha(paid.preimage), invoice.paymentHash);
  await assert.rejects(receiver.checkPayment({ ...record, amountSats: 101 }), /do not match/);
  const foreign = randomBytes(32).toString('hex');
  await assert.rejects(receiver.checkPayment({ paymentHash: foreign, paymentRequest: 'lnbc1', amountSats: 100 }), /no such invoice/);
  assert.ok(blink.calls.every(call => call.apiKey === 'test-receive-key'));
});

function service(options = {}) {
  const blink = fakeBlink(options.blink);
  const treasurer = fakeTreasurer();
  const faucet = fakeMutinynetFaucet(treasurer);
  const practice = createPracticeService({ env: { ...practiceEnv, ...blinkEnv, ...options.env }, fetchImpl: faucet.fetchImpl, faucetUrl: faucet.origin,
    connectReceiver: async () => treasurer,
    connectMainnet: settings => createBlinkReceiver({ ...settings, fetchImpl: blink.fetchImpl }),
    settlePollMs: 1, settleAttempts: 3 });
  return { practice, blink, treasurer, faucet };
}

test('the mainnet rail issues real invoices, never pays them, and confirms the visitor payment', async () => {
  const { practice, blink, faucet } = service();
  const info = await practice.info();
  assert.equal(info.rails.mainnet.available, true);
  assert.equal(info.rails.signet.available, true);
  const invoice = await practice.createInvoice({ memo: 'Awa' });
  assert.equal(invoice.network, 'mainnet');
  assert.match(invoice.paymentRequest, /^lnbc/);
  await assert.rejects(practice.pay(invoice), /own Lightning wallet/);
  assert.equal(faucet.calls.offers, 0);
  assert.equal((await practice.status(invoice)).status, 'pending');
  blink.payExternally(invoice.paymentRequest);
  const settled = await practice.status(invoice);
  assert.equal(settled.status, 'settled');
  assert.equal(settled.network, 'mainnet');
  assert.equal(sha(settled.preimage), invoice.paymentHash);
  // A mainnet invoice the treasurer did not issue is rejected.
  const foreignHash = randomBytes(32).toString('hex');
  await assert.rejects(practice.status({ paymentRequest: makeSignetInvoice({ paymentHash: foreignHash, network: 'mainnet' }), paymentHash: foreignHash }), error => error.status === 409);
  // Test coins stay available on request.
  assert.equal((await practice.createInvoice({ network: 'signet' })).network, 'signet');
});

test('mainnet stays off without the key, and a missing preimage is reported honestly', async () => {
  const off = createPracticeService({ env: practiceEnv, connectReceiver: async () => fakeTreasurer() });
  assert.equal((await off.info()).rails.mainnet.available, false);
  await assert.rejects(off.createInvoice({ network: 'mainnet' }), error => error.status === 503);
  const { practice, blink } = service({ blink: { hidePreimage: true } });
  const invoice = await practice.createInvoice();
  blink.payExternally(invoice.paymentRequest);
  const settled = await practice.status(invoice);
  assert.equal(settled.status, 'settled');
  assert.equal(settled.preimage, null);
});

async function serve(t, practice) {
  const handle = createPracticeHandler(practice);
  const server = createServer((req, res) => handle(req, res, new URL(req.url, 'http://x').pathname.split('/').pop()));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/api/practice`;
}

test('a guest pays real sats from their own wallet, or switches to free test coins', async t => {
  const { practice, blink, faucet } = service();
  const base = await serve(t, practice);
  const open = createPracticeOpener({ base });

  // Judge with a wallet: real mainnet invoice, auto-checked until paid.
  const judge = createStore();
  const { pair, wallet } = await openGuestWallet(judge, 'awa', open);
  assert.equal(wallet.kind, 'mainnet');
  await claimGuestSats(judge, pair, 'awa');
  const { record } = await createGuestInvoice(judge, pair, 'awa');
  assert.equal(record.provider, 'mainnet');
  await assert.rejects(payGuestInvoice(judge, pair, 'awa'), /Not paid yet/);
  assert.equal(judge.latestFor('awa').status, 'pending');
  blink.payExternally(record.paymentRequest);
  const paid = await payGuestInvoice(judge, pair, 'awa');
  assert.equal(paid.status, 'paid');
  assert.equal(paid.attribution, 'own-wallet-lightning-proof');
  assert.equal(sha(paid.proofPreimage), paid.paymentHash);
  assert.equal(judge.round().confirmedSats, 100);
  assert.equal(faucet.calls.payments.length, 0);

  // Judge without a wallet: switches to Mutinynet test coins, the faucet pays.
  const other = createStore();
  const first = await openGuestWallet(other, 'awa', open);
  await claimGuestSats(other, first.pair, 'awa');
  const unpaid = (await createGuestInvoice(other, first.pair, 'awa')).record;
  const testCoins = await open({ amountSats: 100, networks: ['signet'] });
  const switched = await switchGuestPractice(other, first.pair, testCoins, 'awa');
  assert.equal(switched.switched, true);
  assert.equal(switched.record.provider, 'mutinynet');
  assert.equal(other.all().find(item => item.id === unpaid.id).status, 'failed');
  assert.equal(other.walletFor('awa').kind, 'mutinynet');
  assert.equal(other.walletFor('awa').balanceSats, 200);
  const testPaid = await payGuestInvoice(other, testCoins, 'awa');
  assert.equal(testPaid.attribution, 'faucet-lightning-proof');
  assert.equal(other.round().confirmedSats, 100);

  // A real payment that lands just before switching is credited, not discarded.
  const late = createStore();
  const lateWallet = await openGuestWallet(late, 'awa', open);
  const lateInvoice = (await createGuestInvoice(late, lateWallet.pair, 'awa')).record;
  blink.payExternally(lateInvoice.paymentRequest);
  const kept = await switchGuestPractice(late, lateWallet.pair, await open({ amountSats: 100, networks: ['signet'] }), 'awa');
  assert.equal(kept.switched, false);
  assert.equal(kept.record.status, 'paid');
  assert.equal(late.walletFor('awa').kind, 'mainnet');
});

test('the QR endpoint renders only Lightning invoices', async t => {
  const { practice } = service();
  const base = await serve(t, practice);
  const invoice = await practice.createInvoice();
  const ok = await fetch(`${base}/qr?invoice=${encodeURIComponent(invoice.paymentRequest)}`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await ok.text(), /<svg/);
  assert.equal((await fetch(`${base}/qr?invoice=${encodeURIComponent('<script>')}`)).status, 400);
  assert.equal((await fetch(`${base}/qr?invoice=https%3A%2F%2Fevil.test`)).status, 400);
});
