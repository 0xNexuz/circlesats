// Attack and regression tests for the Lightning paths, from the 27 October 2026
// adversarial review: forged or altered invoices and proofs, double spending
// of the shared faucet allowance, forged client addresses, ambiguous amounts,
// and receipts that must stay verifiable after payment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/app.js';
import { createAuth } from '../src/auth.js';
import { createBlinkReceiver } from '../src/blink-receiver.js';
import { ENVIRONMENT_NETWORKS, invoiceNetwork, validateLightningInvoice } from '../src/invoice-validation.js';
import { createLnbits } from '../src/lnbits.js';
import { createLndReceiver } from '../src/lnd-receiver.js';
import { createPracticeOpener } from '../src/practice-client.js';
import { createPracticeHandler, createPracticeService } from '../src/practice-lightning.js';
import { createStore } from '../src/store.js';
import { makeSignetInvoice } from './support/bolt11-fixture.js';
import { fakeBlink } from './support/fake-blink.js';
import { fakeLnd } from './support/fake-lnd.js';
import { fakeMutinynetFaucet, fakeTreasurer, practiceEnv } from './support/fake-mutinynet.js';

const sha = hex => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
const newHash = () => sha(randomBytes(32).toString('hex'));
const nowSeconds = () => Math.floor(Date.now() / 1000);

// Re-encodes a fixture invoice under another network prefix, with a valid checksum.
function withPrefix(invoice, from, to) {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const poly = v => { let c = 1; for (const x of v) { const t = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((t >>> i) & 1) c ^= G[i]; } return c; };
  const expand = h => [...[...h].map(c => c.charCodeAt(0) >> 5), 0, ...[...h].map(c => c.charCodeAt(0) & 31)];
  const sep = invoice.lastIndexOf('1');
  const data = [...invoice.slice(sep + 1, -6)].map(c => CHARSET.indexOf(c));
  const hrp = invoice.slice(0, sep).replace(from, to);
  const mod = poly([...expand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  return `${hrp}1${[...data, ...Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31)].map(w => CHARSET[w]).join('')}`;
}

test('the invoice guard rejects other networks, amounts, hashes, times and tampering', () => {
  const hash = newHash();
  const good = makeSignetInvoice({ paymentHash: hash });
  const check = (paymentRequest, network = 'signet', paymentHash = hash) => validateLightningInvoice({ paymentRequest, paymentHash, amountSats: 100, network });
  assert.ok(check(good));
  assert.throws(() => check(makeSignetInvoice({ paymentHash: hash, network: 'mainnet' })), /non-Signet/);
  assert.throws(() => check(withPrefix(good, 'lntbs', 'lntb')), /non-Signet/);
  assert.throws(() => check(withPrefix(good, 'lntbs1000n', 'lntbs')), /hash or amount/, 'no amount');
  assert.throws(() => check(makeSignetInvoice({ paymentHash: hash, amountSats: 101 })), /hash or amount/);
  assert.throws(() => check(good, 'signet', newHash()), /hash or amount/);
  assert.throws(() => check(makeSignetInvoice({ paymentHash: hash, timestamp: nowSeconds() - 4000 })), /expired/);
  assert.throws(() => check(makeSignetInvoice({ paymentHash: hash, timestamp: nowSeconds() + 600 })), /expired/, 'issued in the future');
  assert.throws(() => check(good.slice(0, 40) + (good[40] === 'q' ? 'p' : 'q') + good.slice(41)), /hash or amount/, 'tampered');
  const mainnet = makeSignetInvoice({ paymentHash: hash, network: 'mainnet' });
  assert.throws(() => check(withPrefix(mainnet, 'lnbc', 'lnbcrt'), 'mainnet'), /another network/, 'regtest is not mainnet');
  // The Node app now checks testnet and regtest invoices too.
  assert.ok(check(withPrefix(good, 'lntbs', 'lntb'), 'testnet'));
  assert.ok(check(withPrefix(mainnet, 'lnbc', 'lnbcrt'), 'regtest'));
  assert.deepEqual(Object.keys(ENVIRONMENT_NETWORKS).sort(), ['regtest', 'signet', 'testnet']);
  assert.equal(invoiceNetwork(withPrefix(good, 'lntbs', 'lntb')), 'testnet');
});

function practice({ faucetMode } = {}) {
  const treasurer = fakeTreasurer();
  const faucet = fakeMutinynetFaucet(treasurer, { mode: faucetMode });
  const service = createPracticeService({ env: practiceEnv, connectReceiver: async () => treasurer, fetchImpl: faucet.fetchImpl,
    faucetUrl: faucet.origin, settlePollMs: 1, settleAttempts: 3 });
  return { service, treasurer, faucet };
}

test('the faucet is never asked to pay a swapped hash, another amount or an expired invoice', async () => {
  const { service, treasurer, faucet } = practice();
  const invoice = await service.createInvoice({ network: 'signet' });
  await assert.rejects(service.pay({ paymentRequest: invoice.paymentRequest, paymentHash: newHash() }), error => error.status === 400);
  await assert.rejects(service.pay(await treasurer.createInvoice({ amount: 5000 })), error => error.status === 400);
  const old = newHash();
  treasurer.invoices.set(old, { paymentRequest: makeSignetInvoice({ paymentHash: old, timestamp: nowSeconds() - 3600 }), preimage: '00', amountSats: 100, state: 'pending' });
  await assert.rejects(service.pay({ paymentRequest: treasurer.invoices.get(old).paymentRequest, paymentHash: old }), error => [400, 409].includes(error.status));
  assert.equal(faucet.calls.offers, 0);
  const pending = await service.status(invoice);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.preimage, undefined);
});

test('simultaneous pay requests for one invoice share a single faucet payment', async () => {
  const { service, faucet } = practice();
  const invoice = await service.createInvoice({ network: 'signet' });
  const results = await Promise.all([service.pay(invoice), service.pay(invoice), service.pay(invoice)]);
  assert.ok(results.every(result => result.status === 'settled'));
  assert.equal(faucet.calls.offers, 1);
  assert.equal(faucet.calls.payments.length, 1);
  // After it finishes, a retry reports the settlement without paying again.
  assert.equal((await service.pay(invoice)).status, 'settled');
  assert.equal(faucet.calls.payments.length, 1);
});

async function serveHandler(t, handle) {
  const server = createServer((req, res) => handle(req, res, new URL(req.url, 'http://x').pathname.split('/').pop()));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/api/practice`;
}

test('one visitor cannot use up the shared test-coin allowance', async t => {
  const { service, faucet } = practice();
  let clock = Date.now();
  const base = await serveHandler(t, createPracticeHandler(service, { now: () => clock }));
  const payOne = async () => {
    const invoice = await (await fetch(`${base}/invoice`, { method: 'POST', body: JSON.stringify({ network: 'signet' }) })).json();
    return fetch(`${base}/pay`, { method: 'POST', body: JSON.stringify(invoice) });
  };
  const statuses = [];
  for (let i = 0; i < 10; i++) statuses.push((await payOne()).status);
  assert.deepEqual(statuses, [...Array(8).fill(200), 429, 429], 'eight payments an hour');
  assert.equal(faucet.calls.payments.length, 8);
  clock += 61 * 60_000;
  const later = [];
  for (let i = 0; i < 6; i++) later.push((await payOne()).status);
  assert.deepEqual(later, [200, 200, 200, 200, 429, 429], 'twelve payments a day');
  assert.equal(faucet.calls.payments.length, 12);
  clock += 24 * 60 * 60_000;
  assert.equal((await payOne()).status, 200, 'the allowance renews');
});

test('forwarded client addresses are trusted only on Vercel', async t => {
  const send = async (base, i) => (await fetch(`${base}/invoice`, { method: 'POST', headers: { 'X-Forwarded-For': `203.0.113.${i}` }, body: '{}' })).status;
  const local = await serveHandler(t, createPracticeHandler(practice().service, { trustProxyHeaders: false }));
  const forged = [];
  for (let i = 0; i < 31; i++) forged.push(await send(local, i));
  assert.equal(forged.at(-1), 429, 'forged headers do not reset the limit');
  const vercel = await serveHandler(t, createPracticeHandler(practice().service, { trustProxyHeaders: true }));
  const distinct = [];
  for (let i = 0; i < 31; i++) distinct.push(await send(vercel, i));
  assert.ok(distinct.every(status => status === 201), 'on Vercel each client address has its own limit');
});

async function forgingServer(t, responses) {
  const server = createServer(async (req, res) => {
    const reply = await responses[new URL(req.url, 'http://x').pathname.split('/').pop()]?.();
    res.writeHead(reply ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply || { error: 'no' }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/api/practice`;
}

test('the browser rejects forged settlements from a compromised practice server', async t => {
  const hash = newHash();
  const invoice = { paymentRequest: makeSignetInvoice({ paymentHash: hash }), paymentHash: hash, amountSats: 100, expiresAt: new Date(Date.now() + 1800_000).toISOString() };
  const info = () => ({ available: true, amountSats: 100, rails: { signet: { available: true } } });
  const forgeries = [
    { status: 'settled', network: 'signet', paymentHash: hash, preimage: randomBytes(32).toString('hex') },
    { status: 'settled', network: 'signet', paymentHash: hash, preimage: null },
    { status: 'settled', network: 'mainnet', paymentHash: hash, preimage: null },
    { status: 'settled', network: 'signet', paymentHash: newHash(), preimage: null }
  ];
  for (const forged of forgeries) {
    const base = await forgingServer(t, { info, invoice: () => invoice, pay: () => forged, status: () => forged });
    const wallet = await createPracticeOpener({ base })({ amountSats: 100, networks: ['signet'] });
    await wallet.topUp(200);
    const created = await wallet.createInvoice({ amountSats: 100 });
    await assert.rejects(wallet.pay({ ...created, amountSats: 100 }), /did not match/);
  }
  const otherNetwork = await forgingServer(t, { info, invoice: () => ({ ...invoice, paymentRequest: makeSignetInvoice({ paymentHash: hash, network: 'mainnet' }) }) });
  await assert.rejects((await createPracticeOpener({ base: otherNetwork })({ amountSats: 100, networks: ['signet'] })).createInvoice({ amountSats: 100 }), /incomplete invoice/);
});

test('receivers refuse mismatched, partial or ambiguous settlements', async () => {
  const blink = fakeBlink();
  const blinkReceiver = await createBlinkReceiver({ apiKey: 'test-receive-key', fetchImpl: blink.fetchImpl });
  const blinkInvoice = await blinkReceiver.createInvoice({ amount: 100, memo: 'x' });
  blink.payExternally(blinkInvoice.paymentRequest);
  blink.invoices.get(blinkInvoice.paymentHash).preimage = randomBytes(32).toString('hex');
  await assert.rejects(blinkReceiver.checkPayment({ ...blinkInvoice, amountSats: 100 }), /does not match/);

  const lnd = fakeLnd();
  const node = await createLndReceiver({ restUrl: lnd.host, macaroon: lnd.macaroon, fetchImpl: lnd.fetchImpl });
  const open = await node.createInvoice({ amount: 100 });
  assert.deepEqual(await node.checkPayment({ ...open, amountSats: 100 }), { settled: false }, 'no preimage before settlement');
  lnd.settle(open.paymentRequest);
  const underpaid = (url, options) => lnd.fetchImpl(url, options).then(async response => /\/v1\/invoice\//.test(url)
    ? Response.json({ ...(await response.json()), amt_paid_sat: '50', amt_paid_msat: '50000' }) : response);
  const partial = await createLndReceiver({ restUrl: lnd.host, macaroon: lnd.macaroon, fetchImpl: underpaid });
  await assert.rejects(partial.checkPayment({ ...open, amountSats: 100 }), /do not match/);

  // LNbits reports millisatoshis; a figure equal to the sat amount is not accepted.
  const record = { checkingId: 'c1', paymentHash: open.paymentHash, amountSats: 100, paymentRequest: open.paymentRequest };
  const lnbitsWith = amount => createLnbits({ baseUrl: 'https://lnbits.test', invoiceKey: 'k', fetchImpl: async () => Response.json(
    { paid: true, details: { checking_id: 'c1', amount, payment_hash: open.paymentHash, bolt11: open.paymentRequest, status: 'success' } }) });
  await assert.rejects(lnbitsWith(100).checkPayment(record), /do not match/);
  assert.equal((await lnbitsWith(100_000).checkPayment(record)).settled, true);
});

test('a paid receipt keeps its invoice for the owner only, and other networks are refused at issue', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'circlesats-lightning-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const start = async (paymentEnvironment, lightning) => {
    let invites = '';
    const auth = await createAuth(join(dir, `${paymentEnvironment}-auth.json`), { announce: message => { invites = message; } });
    const store = createStore(join(dir, `${paymentEnvironment}-ledger.json`)); await store.load();
    const app = createApp({ store, auth, lightning, publicDir: resolve('public'), paymentEnvironment });
    await new Promise(done => app.listen(0, '127.0.0.1', done));
    t.after(() => app.close());
    const base = `http://127.0.0.1:${app.address().port}`;
    const login = async member => {
      const code = new RegExp(`${member}: (\\S+)`).exec(invites)[1];
      const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memberId: member.toLowerCase(), code }) });
      return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: (await response.json()).csrf };
    };
    const post = (path, user) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: user.cookie, 'X-CSRF-Token': user.csrf }, body: '{}' });
    const group = async user => (await fetch(`${base}/api/group`, { headers: user ? { Cookie: user.cookie } : {} })).json();
    return { login, post, group };
  };
  let settled = false;
  const preimage = randomBytes(32).toString('hex');
  const paymentHash = sha(preimage);
  const paymentRequest = makeSignetInvoice({ paymentHash });
  const signet = await start('signet', { provider: 'nwc', network: 'signet',
    async createInvoice() { return { paymentRequest, paymentHash, checkingId: paymentHash }; },
    async checkPayment() { return settled ? { settled: true, settledAt: new Date().toISOString() } : { settled: false }; } });
  const awa = await signet.login('Awa');
  assert.equal((await signet.post('/api/invoices', awa)).status, 201);
  settled = true;
  const own = (await signet.group(awa)).records[0];
  assert.equal(own.status, 'paid');
  assert.equal(own.paymentRequest, paymentRequest, 'the owner keeps the paid invoice');
  assert.equal(own.paymentHash, paymentHash);
  const mamadou = await signet.login('Mamadou');
  assert.equal((await signet.group(mamadou)).records[0].paymentRequest, null, 'other members do not see it');
  assert.equal((await signet.group()).records[0].paymentRequest, null, 'nor does the public');

  // A testnet circle refuses a receiver invoice for another network.
  const testnet = await start('testnet', { provider: 'nwc', network: 'testnet',
    async createInvoice() { const hash = newHash(); return { paymentRequest: makeSignetInvoice({ paymentHash: hash }), paymentHash: hash, checkingId: hash }; },
    async checkPayment() { return { settled: false }; } });
  const fatou = await testnet.login('Fatou');
  assert.equal((await testnet.post('/api/invoices', fatou)).status, 502);
  assert.equal((await testnet.group(fatou)).records.length, 0);
});
