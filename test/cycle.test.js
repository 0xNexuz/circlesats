import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/app.js';
import { createAuth } from '../src/auth.js';
import { createStore } from '../src/store.js';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'circlesats-cycle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createStore(join(dir, 'data.json')); await store.load();
  const auth = await createAuth(join(dir, 'auth.json'), { announce() {} });
  const app = createApp({ store, auth, lightning: null, publicDir: resolve('public') });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.address().port}`;
  const start = await fetch(`${url}/api/auth/demo`, { method: 'POST' });
  const guest = { cookie: start.headers.get('set-cookie').split(';')[0], csrf: (await start.json()).csrf };
  const post = async (path, data = {}, account = guest) => {
    const response = await fetch(`${url}${path}`, { method: 'POST', headers: {
      Cookie: account.cookie, 'X-CSRF-Token': account.csrf, 'Content-Type': 'application/json'
    }, body: JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  };
  const group = async () => (await (await fetch(`${url}/api/group`, { headers: { Cookie: guest.cookie } })).json());
  return { dir, store, url, guest, post, group };
}

test('a guest completes four funded, approved, simulated rounds in rotation', async t => {
  const app = await setup(t);
  assert.equal((await app.post('/api/round/approve', { memberId: 'mamadou' })).status, 409);
  for (const [index, recipient] of ['awa','mamadou','fatou','ibrahima'].entries()) {
    let snapshot = await app.group();
    assert.equal(snapshot.round.number, index + 1);
    assert.equal(snapshot.round.recipientId, recipient);
    for (const member of snapshot.group.members) {
      assert.equal((await app.post('/api/demo/contribute', { memberId: member.id })).status, 201);
    }
    assert.equal((await app.post('/api/demo/contribute', { memberId: 'awa' })).status, 409);
    snapshot = await app.group();
    assert.equal(snapshot.round.phase, 'funded');
    assert.equal(snapshot.round.confirmedSats, 400);
    assert.equal(snapshot.round.paidCount, 4);
    assert.equal((await app.post('/api/round/approve', { memberId: recipient })).status, 403);
    for (const member of snapshot.group.members.filter(item => item.id !== recipient)) {
      assert.equal((await app.post('/api/round/approve', { memberId: member.id })).status, 200);
      assert.equal((await app.post('/api/round/approve', { memberId: member.id })).status, 409);
    }
    snapshot = await app.group();
    assert.equal(snapshot.round.phase, 'approved');
    assert.equal(snapshot.round.settlement.status, 'approved');
    assert.equal((await app.post('/api/round/settle-demo')).status, 200);
    assert.equal((await app.post('/api/round/settle-demo')).status, 409);
  }
  const complete = await app.group();
  assert.equal(complete.cycle.status, 'completed');
  assert.equal(complete.round, null);
  assert.deepEqual(complete.cycle.rounds.map(item => item.recipientId), ['awa','mamadou','fatou','ibrahima']);
  assert.ok(complete.cycle.rounds.every(item => item.phase === 'completed' && item.settlement.status === 'simulated'));
  assert.equal(complete.records.filter(item => item.status === 'paid').length, 16);
  assert.equal((await app.post('/api/cycle/new')).status, 201);
  const next = await app.group();
  assert.equal(next.cycle.number, 2);
  assert.equal(next.cycles.length, 2);
  assert.equal(next.cycles[0].status, 'completed');
  assert.equal(next.round.recipientId, 'awa');
  assert.equal(app.store.all().length, 0);
});

test('private group rules are validated and cannot change after contribution', async t => {
  const app = await setup(t);
  const custom = { name: 'My Market Circle', members: ['Sade','Ngozi','Tunde'], amountSats: 250,
    frequency: 'monthly', startDate: '2026-11-01' };
  assert.equal((await app.post('/api/demo/group', { ...custom, members: ['Sade','sade'] })).status, 400);
  assert.equal((await app.post('/api/demo/group', { ...custom, startDate: '2026-02-30' })).status, 400);
  assert.equal((await app.post('/api/demo/group', custom)).status, 201);
  let snapshot = await app.group();
  assert.equal(snapshot.group.members.length, 3);
  assert.equal(snapshot.round.expectedSats, 750);
  assert.equal(snapshot.cycle.rounds.length, 3);
  assert.equal((await app.post('/api/demo/contribute', { memberId: 'member-1' })).status, 201);
  assert.equal((await app.post('/api/demo/group', custom)).status, 409);
  snapshot = await app.group();
  assert.equal(snapshot.round.confirmedSats, 250);
});

test('cycle accounting and approvals survive a store reload', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'circlesats-persist-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'data.json');
  const store = createStore(path); await store.load();
  for (const member of store.group().members) await store.simulateContribution(member.id, 'test');
  assert.equal(store.round().phase, 'funded');
  await store.approvePayout('mamadou');
  const reloaded = createStore(path); await reloaded.load();
  assert.equal(reloaded.round().confirmedSats, 400);
  assert.equal(reloaded.round().approvals.length, 1);
  assert.equal(reloaded.round().recipientId, 'awa');
  assert.equal(reloaded.all().length, 4);
});
