import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/app.js';
import { createAuth } from '../src/auth.js';
import { createStore } from '../src/store.js';
import { createSandboxProvisioner, SandboxError } from '../src/sandbox-lightning.js';
import { fakeSandbox } from './fake-sandbox.js';

const fast = { pollIntervalMs: 1, pollAttempts: 5 };
const sha = hex => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');

test('a sandbox pair funds, invoices, pays and independently confirms one payment', async () => {
  const hub = fakeSandbox();
  const open = createSandboxProvisioner({ NWCClient: hub.NWCClient, fetchImpl: hub.fetchImpl, faucetUrl: 'https://faucet.test', ...fast });
  const pair = await open();
  assert.equal(pair.environment, 'alby-sandbox');
  assert.equal(await pair.balanceSats(), 0);
  assert.equal(await pair.topUp(200), 200);
  const invoice = await pair.createInvoice({ amountSats: 100, memo: 'test' });
  assert.match(invoice.paymentHash, /^[a-f0-9]{64}$/);
  assert.ok(Date.parse(invoice.expiresAt) > Date.now());
  const record = { ...invoice, amountSats: 100 };
  const paid = await pair.pay(record);
  assert.equal(sha(paid.preimage), invoice.paymentHash);
  assert.equal(await pair.balanceSats(), 100);
  // Retrying an already settled invoice confirms it again without paying twice.
  const again = await pair.pay(record);
  assert.equal(again.preimage, paid.preimage);
  assert.equal(await pair.balanceSats(), 100);
  pair.close();
  assert.ok(hub.clients.every(client => client.closed));
  assert.ok(!JSON.stringify({ invoice, paid }).includes('nostr+walletconnect'));
});

test('sandbox payments need a matching preimage and an exact receiver record', async () => {
  for (const tamper of ['preimage', 'amount']) {
    const hub = fakeSandbox({ tamper });
    const pair = await createSandboxProvisioner({ NWCClient: hub.NWCClient, fetchImpl: hub.fetchImpl, ...fast })();
    await pair.topUp(200);
    const invoice = await pair.createInvoice({ amountSats: 100, memo: 'test' });
    await assert.rejects(pair.pay({ ...invoice, amountSats: 100 }), SandboxError);
    pair.close();
  }
  const offline = fakeSandbox({ offline: true });
  await assert.rejects(createSandboxProvisioner({ NWCClient: offline.NWCClient, fetchImpl: offline.fetchImpl, ...fast })(), SandboxError);
});

test('a slow sandbox gives up quickly and closes wallets that connect late', async () => {
  const hub = fakeSandbox({ slowInfoMs: 60 });
  const open = createSandboxProvisioner({ NWCClient: hub.NWCClient, fetchImpl: hub.fetchImpl, openTimeoutMs: 20, ...fast });
  const started = Date.now();
  await assert.rejects(open(), /took too long/);
  assert.ok(Date.now() - started < 50);
  await new Promise(done => setTimeout(done, 200));
  assert.ok(hub.clients.length > 0 && hub.clients.every(client => client.closed));
});

async function setup(t, { openGuestSandbox, maxGuestSandboxes } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'circlesats-sandbox-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createStore(join(dir, 'data.json')); await store.load();
  const auth = await createAuth(join(dir, 'auth.json'), { announce() {} });
  const app = createApp({ store, auth, lightning: null, publicDir: resolve('public'), openGuestSandbox, maxGuestSandboxes });
  await new Promise(done => app.listen(0, '127.0.0.1', done));
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.address().port}`;
  async function guest() {
    const start = await fetch(`${url}/api/auth/demo`, { method: 'POST' });
    const account = { cookie: start.headers.get('set-cookie').split(';')[0], csrf: (await start.json()).csrf };
    const post = async (path, data = {}) => {
      const response = await fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify(data),
        headers: { Cookie: account.cookie, 'X-CSRF-Token': account.csrf, 'Content-Type': 'application/json' } });
      return { status: response.status, data: await response.json() };
    };
    const get = async path => (await fetch(`${url}${path}`, { headers: { Cookie: account.cookie } })).json();
    return { post, get };
  }
  return { dir, store, guest };
}

test('each guest pays a real sandbox invoice in-app without touching others', async t => {
  const hub = fakeSandbox();
  const app = await setup(t, { openGuestSandbox: createSandboxProvisioner({ NWCClient: hub.NWCClient, fetchImpl: hub.fetchImpl, ...fast }) });
  const first = await app.guest();
  const second = await app.guest();

  const created = await first.post('/api/wallet/create');
  assert.equal(created.status, 201);
  assert.equal(created.data.wallet.kind, 'alby-sandbox');
  assert.equal(created.data.wallet.balanceSats, 0);
  const claimed = await first.post('/api/wallet/claim-demo');
  assert.equal(claimed.status, 200);
  assert.equal(claimed.data.wallet.balanceSats, 200);
  assert.equal((await first.post('/api/wallet/claim-demo')).status, 409);

  const invoice = await first.post('/api/invoices');
  assert.equal(invoice.status, 201);
  assert.equal(invoice.data.record.provider, 'alby-sandbox');
  assert.equal(invoice.data.record.environment, 'alby-sandbox');
  assert.match(invoice.data.record.paymentRequest, /^lnbc/);
  assert.equal((await first.post('/api/invoices')).data.record.id, invoice.data.record.id);

  const paid = await first.post('/api/wallet/pay-demo');
  assert.equal(paid.status, 200);
  assert.equal(paid.data.record.status, 'paid');
  assert.equal(paid.data.record.attribution, 'sandbox-wallet-proof');
  assert.match(paid.data.record.paymentHash, /^[a-f0-9]{64}$/);
  assert.equal(hub.invoices.get(paid.data.record.paymentHash).state, 'settled');
  assert.equal((await first.post('/api/wallet/pay-demo')).status, 409);
  assert.equal((await first.post('/api/invoices')).status, 409);

  const firstView = await first.get('/api/group');
  assert.equal(firstView.round.confirmedSats, 100);
  assert.equal((await first.get('/api/me')).wallet.balanceSats, 100);

  // The second visitor and the shared ledger are untouched.
  const secondView = await second.get('/api/group');
  assert.equal(secondView.round.confirmedSats, 0);
  assert.equal(secondView.records.length, 0);
  assert.equal(app.store.all().length, 0);
  assert.equal((await second.post('/api/wallet/create')).data.wallet.kind, 'alby-sandbox');
  assert.equal(hub.wallets.size, 4);

  // The rest of the round still runs, so the full rotation stays demonstrable.
  for (const memberId of ['mamadou', 'fatou', 'ibrahima']) assert.equal((await first.post('/api/demo/contribute', { memberId })).status, 201);
  assert.equal((await first.get('/api/group')).round.phase, 'funded');

  // Leaving the demo closes that visitor's wallet connections.
  const openBefore = hub.clients.filter(client => !client.closed).length;
  assert.equal((await first.post('/api/auth/logout')).status, 200);
  assert.equal(hub.clients.filter(client => !client.closed).length, openBefore - 2);
  const ledgerText = await readFile(join(app.dir, 'data.json'), 'utf8').catch(() => '');
  assert.ok(!ledgerText.includes('nostr+walletconnect'));
});

test('an unreachable sandbox leaves the original simulated demo working', async t => {
  const hub = fakeSandbox({ offline: true });
  const app = await setup(t, { openGuestSandbox: createSandboxProvisioner({ NWCClient: hub.NWCClient, fetchImpl: hub.fetchImpl, ...fast }) });
  const visitor = await app.guest();
  const created = await visitor.post('/api/wallet/create');
  assert.equal(created.status, 201);
  assert.equal(created.data.wallet.kind, undefined);
  assert.equal((await visitor.post('/api/wallet/claim-demo')).data.wallet.balanceSats, 200);
  const invoice = await visitor.post('/api/invoices');
  assert.equal(invoice.data.record.provider, 'demo');
  const paid = await visitor.post('/api/wallet/pay-demo');
  assert.equal(paid.data.record.status, 'paid');
  assert.equal(paid.data.record.attribution, 'demo-wallet');
});

test('a custom circle drops the old sandbox wallets and large amounts stay simulated', async t => {
  const hub = fakeSandbox();
  const app = await setup(t, { openGuestSandbox: createSandboxProvisioner({ NWCClient: hub.NWCClient, fetchImpl: hub.fetchImpl, ...fast }) });
  const visitor = await app.guest();
  assert.equal((await visitor.post('/api/wallet/create')).data.wallet.kind, 'alby-sandbox');
  const custom = await visitor.post('/api/demo/group', { name: 'Big Circle', members: ['Aminata', 'Cheikh'], amountSats: 10_000, frequency: 'weekly' });
  assert.equal(custom.status, 201);
  assert.ok(hub.clients.every(client => client.closed));
  assert.equal((await visitor.post('/api/wallet/create')).data.wallet.kind, undefined);
  assert.equal((await visitor.post('/api/invoices')).data.record.provider, 'demo');
});

test('the sandbox cap falls back to simulation once full', async t => {
  const hub = fakeSandbox();
  const app = await setup(t, { openGuestSandbox: createSandboxProvisioner({ NWCClient: hub.NWCClient, fetchImpl: hub.fetchImpl, ...fast }), maxGuestSandboxes: 1 });
  assert.equal((await (await app.guest()).post('/api/wallet/create')).data.wallet.kind, 'alby-sandbox');
  assert.equal((await (await app.guest()).post('/api/wallet/create')).data.wallet.kind, undefined);
});

test('sandbox modules stay browser-compatible for the static preview', async () => {
  for (const file of ['src/sandbox-lightning.js', 'src/guest-sandbox.js']) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /from ['"]node:|require\(/);
  }
});
