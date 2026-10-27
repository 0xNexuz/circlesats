import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApp } from '../src/app.js';
import { createAuth } from '../src/auth.js';
import { decodeLedger } from '../src/durable-json.js';
import { LightningError } from '../src/lnbits.js';
import { resolveRuntimeConfig } from '../src/runtime-config.js';
import { acquireInstanceLock } from '../src/instance-lock.js';
import { createStore } from '../src/store.js';

const hash = 'ab'.repeat(32);

async function fixture(t, lightning, trustProxy = false) {
  const dir = await mkdtemp(join(tmpdir(), 'circlesats-hardening-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let invites = '';
  const auth = await createAuth(join(dir, 'auth.json'), { announce: message => { invites = message; } });
  const store = createStore(join(dir, 'ledger.json')); await store.load();
  const app = createApp({ store, auth, lightning, publicDir: resolve('public'), paymentEnvironment: 'signet', trustProxy });
  await new Promise(done => app.listen(0, '127.0.0.1', done));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}`;
  const account = async member => {
    const code = new RegExp(`${member}: (\\S+)`).exec(invites)[1];
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: member.toLowerCase(), code }) });
    assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: (await response.json()).csrf };
  };
  const post = (path, user, body = {}) => fetch(`${base}${path}`, { method: 'POST', headers: {
    'Content-Type': 'application/json', Cookie: user?.cookie || '', 'X-CSRF-Token': user?.csrf || ''
  }, body: JSON.stringify(body) });
  const group = async () => (await (await fetch(`${base}/api/group`)).json());
  return { dir, store, app, base, account, post, group };
}

test('flushed ledger keeps a verified prior snapshot and fails closed on corruption', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'circlesats-ledger-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.json');
  const store = createStore(path); await store.load();
  await store.createWallet('awa');
  await store.claimDemo('awa');
  const current = decodeLedger(await readFile(path, 'utf8'));
  const backup = decodeLedger(await readFile(`${path}.bak`, 'utf8'));
  assert.equal(current.version, 4);
  assert.equal(current.revision, backup.revision + 1);
  assert.equal(current.wallets.awa.balanceSats, 200);
  assert.equal(backup.wallets.awa.balanceSats, 0);
  await writeFile(path, '{"version":4,"records":[]}');
  await assert.rejects(createStore(path).load(), /integrity|Invalid ledger/);
  assert.equal(decodeLedger(await readFile(`${path}.bak`, 'utf8')).revision, backup.revision);
});

test('expired invoice stays under verification and delayed settlement is credited once', async t => {
  let connected = false;
  let settled = false;
  const lightning = { provider: 'nwc', network: 'signet',
    async checkPayment() {
      if (!connected) throw new LightningError('Receiver disconnected');
      await new Promise(done => setTimeout(done, 20));
      return { settled };
    },
    async createInvoice() { throw new Error('An uncertain invoice must not be replaced.'); } };
  const app = await fixture(t, lightning);
  const awa = await app.account('Awa');
  const round = app.store.round();
  await app.store.add({ id: 'late', groupId: app.store.group().id, cycleId: round.cycleId, roundId: round.id,
    memberId: 'awa', amountSats: 100, provider: 'nwc', environment: 'signet', paymentHash: hash, checkingId: hash,
    paymentRequest: 'lnbc1late', status: 'pending', expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await app.group()).records[0].status, 'pending');
  connected = true;
  assert.equal((await app.group()).records[0].status, 'expired');
  assert.equal((await app.post('/api/invoices', awa)).status, 409);
  settled = true;
  const [first, second] = await Promise.all([app.group(), app.group()]);
  assert.equal(first.records[0].status, 'paid');
  assert.equal(second.records[0].status, 'paid');
  assert.equal(app.store.round().confirmedSats, 100);
  assert.equal(app.store.all().length, 1);
});

test('real-mode approvals use the signed-in member and payout claims stay unverified', async t => {
  const lightning = { provider: 'nwc', network: 'signet', async checkPayment() { return { settled: false }; } };
  const app = await fixture(t, lightning);
  const group = app.store.group();
  const round = app.store.round();
  for (const [index, member] of group.members.entries()) {
    const record = { id: String(index), groupId: group.id, cycleId: round.cycleId, roundId: round.id,
      memberId: member.id, amountSats: 100, provider: 'nwc', environment: 'signet', paymentHash: index.toString(16).padStart(64, '0'),
      paymentRequest: `lnbc1${index}`, status: 'pending', expiresAt: new Date(Date.now() + 60000).toISOString() };
    await app.store.add(record);
    await app.store.update(record.id, { status: 'paid', paidAt: new Date().toISOString() });
  }
  const [awa, mamadou, fatou, ibrahima] = await Promise.all(['Awa', 'Mamadou', 'Fatou', 'Ibrahima'].map(app.account));
  assert.equal((await app.post('/api/round/approve', null)).status, 401);
  assert.equal((await fetch(`${app.base}/api/round/approve`, { method: 'POST', headers: { Cookie: mamadou.cookie,
    'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await app.post('/api/round/approve', awa)).status, 403);
  assert.equal((await app.post('/api/round/approve', mamadou, { memberId: 'fatou' })).status, 200);
  assert.deepEqual(app.store.round().approvals.map(item => item.memberId), ['mamadou']);
  assert.equal((await app.post('/api/round/approve', mamadou)).status, 409);
  assert.equal((await app.post('/api/round/approve', fatou)).status, 200);
  assert.equal((await app.post('/api/round/approve', ibrahima)).status, 200);
  assert.equal(app.store.round().phase, 'approved');
  assert.equal((await app.post('/api/round/settlement-claim', mamadou, { reference: 'invoice123' })).status, 403);
  assert.equal((await app.post('/api/round/settle-demo', awa)).status, 403);
  assert.equal((await app.post('/api/round/settlement-claim', awa, { reference: 'invoice123' })).status, 200);
  assert.equal(app.store.round().settlement.status, 'claimed_unverified');
});

test('production configuration requires a persistent volume and HTTPS', () => {
  const root = resolve('.');
  assert.throws(() => resolveRuntimeConfig({ NODE_ENV: 'production' }, root), /DATA_DIR/);
  assert.throws(() => resolveRuntimeConfig({ NODE_ENV: 'production', DATA_DIR: root }, root), /HTTPS/);
  assert.throws(() => resolveRuntimeConfig({ PAYMENT_ENVIRONMENT: 'mainnet' }, root), /mainnet/);
  assert.throws(() => resolveRuntimeConfig({ LIGHTNING_PROVIDER: 'nwc', PAYMENT_ENVIRONMENT: 'signet', LNBITS_NETWORK: 'mainnet' }, root), /match/);
  assert.throws(() => resolveRuntimeConfig({ NODE_ENV: 'production', DATA_DIR: root, PUBLIC_HTTPS: '1', TRUST_PROXY: '1' }, root), /outside/);
  assert.throws(() => resolveRuntimeConfig({ NODE_ENV: 'production', DATA_DIR: tmpdir(), PUBLIC_HTTPS: '1' }, root), /TRUST_PROXY/);
  assert.throws(() => resolveRuntimeConfig({ NODE_ENV: 'production', DATA_DIR: tmpdir(), PUBLIC_HTTPS: '1', TRUST_PROXY: '1', HOST: '0.0.0.0' }, root), /loopback/);
  const config = resolveRuntimeConfig({ NODE_ENV: 'production', DATA_DIR: tmpdir(), PUBLIC_HTTPS: '1', TRUST_PROXY: '1' }, root);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.dataFile, join(tmpdir(), 'circlesats.json'));
});

test('production proxy identity is required and scopes guest limits per address', async t => {
  const app = await fixture(t, null, true);
  const start = address => fetch(`${app.base}/api/auth/demo`, { method: 'POST', headers: address ? { 'X-Real-IP': address } : {} });
  assert.equal((await start()).status, 503);
  assert.equal((await start('not-an-ip')).status, 503);
  for (let i = 0; i < 5; i++) assert.equal((await start('203.0.113.4')).status, 200);
  assert.equal((await start('203.0.113.4')).status, 429);
  assert.equal((await start('203.0.113.5')).status, 200);
});

test('a second production process cannot claim the same ledger', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'circlesats-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = join(dir, 'ledger.json');
  const release = await acquireInstanceLock(ledger);
  await assert.rejects(acquireInstanceLock(ledger), /Another CircleSats instance/);
  await release();
  const next = await acquireInstanceLock(ledger);
  await next();
});

test('production member provisioning keeps access codes out of startup logs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'circlesats-provision-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(createAuth(join(dir, 'member-auth.json'), { requireExisting: true }), /provision:members/);
  const refused = spawnSync(process.execPath, ['scripts/start.js'], { cwd: resolve('.'),
    env: { ...process.env, DATA_DIR: dir, NODE_ENV: 'production', PUBLIC_HTTPS: '1', TRUST_PROXY: '1', NODE_TLS_REJECT_UNAUTHORIZED: '1' }, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.doesNotMatch(refused.stdout, /Awa:/);
  await assert.rejects(readFile(join(dir, 'circlesats.json.lock')), /ENOENT/);
  const result = spawnSync(process.execPath, ['scripts/provision-members.mjs'], { cwd: resolve('.'),
    env: { ...process.env, DATA_DIR: dir, NODE_TLS_REJECT_UNAUTHORIZED: '1' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Awa:/);
  const invites = await readFile(join(dir, 'member-invites.txt'), 'utf8');
  const hashed = await readFile(join(dir, 'member-auth.json'), 'utf8');
  assert.match(invites, /Awa: /);
  assert.doesNotMatch(hashed, new RegExp(invites.match(/Awa: (\S+)/)[1]));
  await createAuth(join(dir, 'member-auth.json'), { requireExisting: true, announce: () => { throw new Error('codes unexpectedly regenerated'); } });
  const repeated = spawnSync(process.execPath, ['scripts/provision-members.mjs'], { cwd: resolve('.'),
    env: { ...process.env, DATA_DIR: dir, NODE_TLS_REJECT_UNAUTHORIZED: '1' }, encoding: 'utf8' });
  assert.notEqual(repeated.status, 0);
});

test('public responses set security headers and use an external preloader script', async t => {
  const app = await fixture(t, null);
  const response = await fetch(app.base);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(response.headers.get('content-security-policy'), /script-src[^;]*unsafe-inline/);
  const html = await response.text();
  assert.match(html, /src="\/preloader-bootstrap\.js"/);
});
