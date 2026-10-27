import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/app.js';
import { createAuth } from '../src/auth.js';
import { createLnbits } from '../src/lnbits.js';
import { createStore } from '../src/store.js';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function setup(t, lightning = null) {
  const dir = await mkdtemp(join(tmpdir(), 'circlesats-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let invites = '';
  const auth = await createAuth(join(dir, 'auth.json'), { announce: value => { invites = value; } });
  const awaCode = /Awa: (\S+)/.exec(invites)[1];
  const mamadouCode = /Mamadou: (\S+)/.exec(invites)[1];
  const store = createStore(join(dir, 'data.json')); await store.load();
  const app = createApp({ store, lightning, auth, publicDir: resolve('public') });
  const url = await listen(app); t.after(() => app.close());
  async function login(memberId = 'awa', code = awaCode) {
    const response = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memberId, code }) });
    const data = await response.json();
    return { response, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function post(path, account, data = {}) {
    return fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: account.cookie || '', 'X-CSRF-Token': account.data.csrf || '' }, body: JSON.stringify(data) });
  }
  return { dir, store, url, login, post, mamadouCode };
}

test('member access and simulated wallet contribution are bound to one account', async t => {
  const app = await setup(t);
  assert.equal((await app.login('awa', 'wrong')).response.status, 401);
  assert.equal((await fetch(`${app.url}/api/invoices`, { method: 'POST' })).status, 401);
  const awa = await app.login();
  assert.equal(awa.response.status, 200);
  assert.equal((await fetch(`${app.url}/api/wallet/create`, { method: 'POST', headers: { Cookie: awa.cookie } })).status, 403);
  assert.equal((await app.post('/api/wallet/create', awa)).status, 201);
  assert.equal((await app.post('/api/wallet/claim-demo', awa)).status, 200);
  assert.equal((await app.post('/api/wallet/claim-demo', awa)).status, 409);
  let response = await app.post('/api/invoices', awa, { memberId: 'mamadou' });
  assert.equal(response.status, 201);
  let record = (await response.json()).record;
  assert.equal(record.memberId, 'awa');
  assert.equal(record.status, 'pending');
  assert.match(record.paymentRequest, /^demo:/);
  assert.equal((await app.post('/api/invoices', awa)).status, 200);
  const mamadou = await app.login('mamadou', app.mamadouCode);
  assert.equal((await app.post('/api/wallet/pay-demo', mamadou)).status, 409);
  response = await app.post('/api/wallet/pay-demo', awa);
  assert.equal(response.status, 200);
  record = (await response.json()).record;
  assert.equal(record.status, 'paid');
  assert.equal(record.attribution, 'demo-wallet');
  assert.equal((await app.post('/api/invoices', awa)).status, 409);
  const me = await (await fetch(`${app.url}/api/me`, { headers: { Cookie: awa.cookie } })).json();
  assert.equal(me.wallet.balanceSats, 100);
  const reloaded = createStore(join(app.dir, 'data.json')); await reloaded.load();
  assert.equal(reloaded.latestFor('awa').status, 'paid');
  assert.equal(reloaded.walletFor('awa').balanceSats, 100);
});

test('guest practice round is usable and isolated from the shared ledger', async t => {
  const app = await setup(t);
  const start = await fetch(`${app.url}/api/auth/demo`, { method: 'POST' });
  assert.equal(start.status, 200);
  const guest = { response: start, data: await start.json(), cookie: start.headers.get('set-cookie')?.split(';')[0] };
  assert.equal(guest.data.kind, 'guest-demo');
  assert.equal((await app.post('/api/wallet/create', guest)).status, 201);
  assert.equal((await app.post('/api/wallet/claim-demo', guest)).status, 200);
  assert.equal((await app.post('/api/invoices', guest)).status, 201);
  const paid = await app.post('/api/wallet/pay-demo', guest);
  assert.equal(paid.status, 200);
  assert.equal((await paid.json()).record.attribution, 'demo-wallet');
  const privateGroup = await (await fetch(`${app.url}/api/group`, { headers: { Cookie: guest.cookie } })).json();
  const sharedGroup = await (await fetch(`${app.url}/api/group`)).json();
  assert.equal(privateGroup.records.length, 1);
  assert.equal(sharedGroup.records.length, 0);
  assert.equal(app.store.all().length, 0);
  const secondGuest = await fetch(`${app.url}/api/auth/demo`, { method: 'POST' });
  const freshGroup = await (await fetch(`${app.url}/api/group`, { headers: { Cookie: secondGuest.headers.get('set-cookie')?.split(';')[0] } })).json();
  assert.equal(freshGroup.records.length, 0);
});

test('Lightning receipt and member payment proof remain distinct', async t => {
  let paid = false;
  let invoiceCalls = 0;
  const preimage = '11'.repeat(32);
  const hash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
  const wallet = createServer(async (req, res) => {
    assert.equal(req.headers['x-api-key'], 'invoice-key');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/v1/payments') {
      invoiceCalls++;
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      assert.deepEqual({ out: body.out, amount: body.amount, expiry: body.expiry }, { out: false, amount: 100, expiry: 1800 });
      return res.end(JSON.stringify({ payment_request: 'lnbc1test', checking_id: 'check123', payment_hash: hash }));
    }
    if (req.method === 'GET' && req.url === '/api/v1/payments/check123') return res.end(JSON.stringify({ paid,
      details: paid ? { checking_id: 'check123', payment_hash: hash, bolt11: 'lnbc1test', amount: 100000, status: 'success', time: 1793000000 } : undefined }));
    res.statusCode = 404; res.end('{}');
  });
  const walletUrl = await listen(wallet); t.after(() => wallet.close());
  const app = await setup(t, createLnbits({ baseUrl: walletUrl, invoiceKey: 'invoice-key' }));
  const demoStart = await fetch(`${app.url}/api/auth/demo`, { method: 'POST' });
  assert.equal(demoStart.status, 200);
  const guest = { data: await demoStart.json(), cookie: demoStart.headers.get('set-cookie')?.split(';')[0] };
  assert.equal((await (await fetch(`${app.url}/api/group`, { headers: { Cookie: guest.cookie } })).json()).mode, 'demo');
  assert.equal((await app.post('/api/wallet/create', guest)).status, 201);
  assert.equal((await app.post('/api/wallet/claim-demo', guest)).status, 200);
  assert.equal((await app.post('/api/invoices', guest)).status, 201);
  assert.equal((await app.post('/api/wallet/pay-demo', guest)).status, 200);
  assert.equal(invoiceCalls, 0);
  assert.equal(app.store.all().length, 0);
  const awa = await app.login();
  assert.equal((await app.post('/api/wallet/create', awa)).status, 409);
  let response = await app.post('/api/invoices', awa);
  assert.equal(response.status, 201);
  const issued = (await response.json()).record;
  assert.equal(issued.attribution, 'unverified');
  const publicGroup = await (await fetch(`${app.url}/api/group`)).json();
  assert.equal(publicGroup.records[0].paymentRequest, null);
  const memberGroup = await (await fetch(`${app.url}/api/group`, { headers: { Cookie: awa.cookie } })).json();
  assert.equal(memberGroup.records[0].paymentRequest, 'lnbc1test');
  assert.equal((await fetch(`${app.url}/api/invoice-qr?id=${issued.id}`)).status, 401);
  const otherMember = await app.login('mamadou', app.mamadouCode);
  assert.equal((await fetch(`${app.url}/api/invoice-qr?id=${issued.id}`, { headers: { Cookie: otherMember.cookie } })).status, 404);
  const qr = await fetch(`${app.url}/api/invoice-qr?id=${issued.id}`, { headers: { Cookie: awa.cookie } });
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await qr.text(), /<svg/);
  assert.equal((await app.post('/api/proofs', awa, { preimage })).status, 409);
  paid = true;
  let group = await (await fetch(`${app.url}/api/group`)).json();
  assert.equal(group.records[0].status, 'paid');
  assert.equal(group.records[0].attribution, 'unverified');
  assert.equal((await app.post('/api/proofs', awa, { preimage: '22'.repeat(32) })).status, 400);
  response = await app.post('/api/proofs', awa, { preimage });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).record.attribution, 'member-proof');
  assert.equal((await app.post('/api/invoices', awa)).status, 409);
  assert.equal(invoiceCalls, 1);
});
