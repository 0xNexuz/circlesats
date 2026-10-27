// Live check of the judge path: two independent guest demos each create their
// own Alby sandbox wallets through the public faucet, pay a real NWC invoice
// in-app, and see only their own payment. Uses test sats; no real Bitcoin.
// Requires internet access to faucet.nwc.dev and its Nostr relay.
import { NWCClient } from '@getalby/sdk';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/app.js';
import { createAuth } from '../src/auth.js';
import { createStore } from '../src/store.js';
import { createSandboxProvisioner } from '../src/sandbox-lightning.js';

if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('Enable TLS certificate verification before using the sandbox.');
const dir = await mkdtemp(join(tmpdir(), 'circlesats-guest-smoke-'));
let app;
let stage = 'starting';
try {
  const store = createStore(join(dir, 'ledger.json')); await store.load();
  const auth = await createAuth(join(dir, 'auth.json'), { announce() {} });
  app = createApp({ store, auth, lightning: null, publicDir: resolve(import.meta.dirname, '../public'),
    openGuestSandbox: createSandboxProvisioner({ NWCClient }) });
  await new Promise(done => app.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${app.address().port}`;
  async function guest(label) {
    const start = await fetch(`${base}/api/auth/demo`, { method: 'POST' });
    const account = { cookie: start.headers.get('set-cookie').split(';')[0], csrf: (await start.json()).csrf };
    const post = async path => {
      stage = `${label}: ${path}`;
      const response = await fetch(`${base}${path}`, { method: 'POST', body: '{}',
        headers: { Cookie: account.cookie, 'X-CSRF-Token': account.csrf, 'Content-Type': 'application/json' } });
      const data = await response.json();
      if (!response.ok) throw new Error(`${path} returned ${response.status}: ${data.error}`);
      return data;
    };
    const wallet = (await post('/api/wallet/create')).wallet;
    if (wallet.kind !== 'alby-sandbox') throw new Error('The faucet was unreachable, so the demo fell back to simulation.');
    const funded = (await post('/api/wallet/claim-demo')).wallet;
    const invoice = (await post('/api/invoices')).record;
    const started = Date.now();
    const paid = (await post('/api/wallet/pay-demo')).record;
    const group = await (await fetch(`${base}/api/group`, { headers: { Cookie: account.cookie } })).json();
    return { label, fundedSats: funded.balanceSats, invoicePrefix: invoice.paymentRequest.slice(0, 6),
      status: paid.status, attribution: paid.attribution, paymentHash: paid.paymentHash,
      paymentMs: Date.now() - started, roundConfirmedSats: group.round.confirmedSats };
  }
  const first = await guest('judge-1');
  const second = await guest('judge-2');
  const isolated = first.roundConfirmedSats === 100 && second.roundConfirmedSats === 100 &&
    first.paymentHash !== second.paymentHash && store.all().length === 0;
  console.log(JSON.stringify({ result: isolated ? 'passed' : 'failed', environment: 'alby-sandbox (test sats)',
    sharedLedgerRecords: store.all().length, guests: [first, second] }, null, 2));
  if (!isolated) process.exitCode = 1;
} catch (error) {
  console.error(`Guest sandbox smoke failed during ${stage}: ${String(error?.message || error).replace(/nostr\+walletconnect:\/\/\S+/gi, '[redacted]')}`);
  process.exitCode = 1;
} finally {
  if (app) { app.closeAllConnections?.(); await new Promise(done => app.close(done)); }
  await rm(dir, { recursive: true, force: true });
  setTimeout(() => process.exit(), 500).unref();
}
