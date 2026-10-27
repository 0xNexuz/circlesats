import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createLnbits } from '../src/lnbits.js';
import { createNwcReceiver } from '../src/nwc-receiver.js';
import { createStore } from '../src/store.js';
import { Nip47NetworkError } from '@getalby/sdk';
import { createHash } from 'node:crypto';

const hash = 'ab'.repeat(32);
const invoice = 'lnbc100n1test';

test('NWC receiver requires scoped capabilities and matching network', async () => {
  let closed = false;
  const client = { getInfo: async () => ({ network: 'signet', methods: ['make_invoice', 'lookup_invoice'] }), close: () => { closed = true; } };
  await assert.rejects(createNwcReceiver({ connectionSecret: 'test', expectedNetwork: 'bitcoin', clientFactory: () => client }), /network/);
  assert.equal(closed, true);
  await assert.rejects(createNwcReceiver({ connectionSecret: 'test', clientFactory: () => ({ ...client,
    getInfo: async () => ({ network: 'signet', methods: ['make_invoice'] }) }) }), /permissions/);
  await assert.rejects(createNwcReceiver({ connectionSecret: 'test', clientFactory: () => ({ ...client,
    getInfo: async () => ({ network: 'signet', methods: ['make_invoice', 'lookup_invoice', 'pay_invoice'] }) }) }), /can spend funds/);
});

test('NWC receiving credits only matching incoming settled invoices', async () => {
  let transaction = { type: 'incoming', state: 'pending', payment_hash: hash, invoice, amount: 100000 };
  let requestedAmount;
  const client = { getInfo: async () => ({ network: 'signet', methods: ['make_invoice', 'lookup_invoice'] }),
    makeInvoice: async input => { requestedAmount = input.amount; return transaction; },
    lookupInvoice: async ({ payment_hash }) => { assert.equal(payment_hash, hash); return transaction; }, close() {} };
  const receiver = await createNwcReceiver({ connectionSecret: 'test', expectedNetwork: 'signet', clientFactory: () => client });
  const created = await receiver.createInvoice({ amount: 100, memo: 'Round 1' });
  assert.equal(requestedAmount, 100000);
  const record = { ...created, amountSats: 100 };
  assert.equal((await receiver.checkPayment(record)).settled, false);
  transaction = { ...transaction, state: 'settled', settled_at: 1793000000 };
  assert.equal((await receiver.checkPayment(record)).settled, true);
  transaction = { ...transaction, amount: 200000 };
  await assert.rejects(receiver.checkPayment(record), /do not match/);
  transaction = { ...transaction, amount: 100000, type: 'outgoing' };
  await assert.rejects(receiver.checkPayment(record), /do not match/);
  transaction = { ...transaction, type: 'incoming', state: 'expired' };
  assert.deepEqual(await receiver.checkPayment(record), { settled: false, failed: true });
  receiver.close();
});

test('NWC receiver reconnects after relay loss and revalidates the wallet', async () => {
  let connections = 0;
  let closed = 0;
  const transaction = { type: 'incoming', state: 'settled', payment_hash: hash, invoice, amount: 100000 };
  const receiver = await createNwcReceiver({ connectionSecret: 'test', expectedNetwork: 'signet', clientFactory: () => {
    connections++;
    return { walletPubkey: 'cd'.repeat(32), close: () => { closed++; },
      getInfo: async () => ({ network: 'signet', methods: ['make_invoice', 'lookup_invoice'] }),
      lookupInvoice: async () => {
        if (connections === 1) throw new Nip47NetworkError('Relay disconnected', 'OTHER');
        return transaction;
      } };
  } });
  assert.equal((await receiver.checkPayment({ paymentHash: hash, paymentRequest: invoice, amountSats: 100 })).settled, true);
  assert.equal(connections, 2);
  assert.equal(closed, 1);
  receiver.close();
});

test('NWC receiver verifies an exposed incoming preimage before crediting', async () => {
  const preimage = 'cd'.repeat(32);
  const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
  let transaction = { type: 'incoming', state: 'settled', payment_hash: paymentHash,
    invoice, amount: 100000, preimage };
  const client = { walletPubkey: 'ef'.repeat(32),
    getInfo: async () => ({ network: 'signet', methods: ['make_invoice', 'lookup_invoice'] }),
    lookupInvoice: async () => transaction, close() {} };
  const receiver = await createNwcReceiver({ connectionSecret: 'test', expectedNetwork: 'signet', clientFactory: () => client });
  const record = { paymentHash, paymentRequest: invoice, amountSats: 100 };
  assert.equal((await receiver.checkPayment(record)).preimageVerified, true);
  transaction = { ...transaction, preimage: 'ab'.repeat(32) };
  await assert.rejects(receiver.checkPayment(record), /preimage/);
  receiver.close();
});

test('LNbits paid flag alone cannot credit a contribution', async t => {
  let paid = true;
  let details = { checking_id: 'check123', amount: 100000, status: 'success', payment_hash: hash, bolt11: invoice };
  const wallet = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ paid, details }));
  });
  await new Promise(resolve => wallet.listen(0, '127.0.0.1', resolve));
  t.after(() => wallet.close());
  const receiver = createLnbits({ baseUrl: `http://127.0.0.1:${wallet.address().port}`, invoiceKey: 'invoice-key' });
  const record = { checkingId: 'check123', paymentHash: hash, amountSats: 100, paymentRequest: invoice };
  assert.equal((await receiver.checkPayment(record)).settled, true);
  details = { ...details, amount: 200000 };
  await assert.rejects(receiver.checkPayment(record), /do not match/);
  details = { ...details, amount: 100000, checking_id: 'other' };
  await assert.rejects(receiver.checkPayment(record), /do not match/);
  details = { checking_id: 'check123', amount: 100000, status: 'success', bolt11: invoice };
  await assert.rejects(receiver.checkPayment(record), /do not match/);
  details = { checking_id: 'check123', amount: 100000, status: 'success', payment_hash: hash };
  await assert.rejects(receiver.checkPayment(record), /do not match/);
  paid = false;
  details = { checking_id: 'check123', status: 'expired', payment_hash: hash, bolt11: invoice };
  assert.deepEqual(await receiver.checkPayment(record), { settled: false, failed: true });
});

test('one Lightning payment hash cannot fund two members', async () => {
  const store = createStore();
  const group = store.group();
  const round = store.round();
  const first = { id: 'first', groupId: group.id, cycleId: round.cycleId, roundId: round.id,
    memberId: 'awa', amountSats: 100, provider: 'nwc', paymentHash: hash, status: 'pending' };
  await store.add(first);
  await assert.rejects(store.add({ ...first, id: 'second', memberId: 'fatou', paymentHash: hash.toUpperCase() }), /Payment hash was already used/);
  assert.equal(store.all().length, 1);
});
