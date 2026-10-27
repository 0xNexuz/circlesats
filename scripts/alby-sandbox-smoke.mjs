import { NWCClient } from '@getalby/sdk';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApp } from '../src/app.js';
import { createAuth } from '../src/auth.js';
import { createNwcReceiver } from '../src/nwc-receiver.js';
import { createStore } from '../src/store.js';

const root = resolve(import.meta.dirname, '..');
const dataDir = resolve(root, 'data');
const walletFile = resolve(dataDir, 'alby-sandbox-wallets.json');
const evidenceFile = resolve(dataDir, 'alby-sandbox-evidence.json');
let stage = 'setup';
let receiver;
let payer;
let app;

function connectionFrom(body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = body.trim(); }
  const find = value => {
    if (typeof value === 'string') return value.startsWith('nostr+walletconnect://') ? value : null;
    if (Array.isArray(value)) return value.map(find).find(Boolean);
    if (value && typeof value === 'object') return Object.values(value).map(find).find(Boolean);
    return null;
  };
  return find(parsed);
}

async function createFaucetWallet() {
  const response = await fetch('https://faucet.nwc.dev?balance=10000', {
    method: 'POST', signal: AbortSignal.timeout(20000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Faucet returned HTTP ${response.status}.`);
  const secret = connectionFrom(body);
  if (!secret) throw new Error('Faucet response had no NWC connection string.');
  return secret;
}

async function wallets() {
  try {
    const existing = JSON.parse(await readFile(walletFile, 'utf8'));
    if (existing.receiver?.startsWith('nostr+walletconnect://') && existing.payer?.startsWith('nostr+walletconnect://')) return existing;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  stage = 'creating sandbox wallets';
  const created = { receiver: await createFaucetWallet(), payer: await createFaucetWallet() };
  if (created.receiver === created.payer) throw new Error('Faucet returned the same wallet twice.');
  await mkdir(dataDir, { recursive: true });
  await writeFile(walletFile, JSON.stringify(created), { mode: 0o600, flag: 'wx' });
  return created;
}

async function connectWallet(secret) {
  const relays = NWCClient.parseWalletConnectUrl(secret).relayUrls;
  for (const relay of relays) {
    const client = new NWCClient({ nostrWalletConnectUrl: secret, relayUrls: [relay] });
    try { return { client, info: await client.getInfo() }; }
    catch { client.close(); }
  }
  throw new Error('No sandbox wallet relay responded.');
}

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const data = await response.json();
  return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

try {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('Enable TLS certificate verification before using the sandbox.');
  const secrets = await wallets();
  stage = 'connecting sandbox wallets';
  const payerConnection = await connectWallet(secrets.payer);
  payer = payerConnection.client;
  const payerInfo = payerConnection.info;
  receiver = await createNwcReceiver({ connectionSecret: secrets.receiver, allowSpendingPermission: true });
  const receiverInfo = { network: receiver.network, methods: receiver.methods };
  if (payerInfo.network !== receiverInfo.network || !payerInfo.methods?.includes('pay_invoice')) {
    throw new Error('Sandbox payer network or payment permission does not match the receiver.');
  }

  stage = 'starting isolated CircleSats app';
  const runId = randomUUID();
  const ledgerPath = resolve(dataDir, `sandbox-ledger-${runId}.json`);
  const authPath = resolve(dataDir, `sandbox-auth-${runId}.json`);
  let invites = '';
  const auth = await createAuth(authPath, { announce: text => { invites = text; } });
  const store = createStore(ledgerPath); await store.load();
  app = createApp({ store, auth, lightning: receiver, publicDir: resolve(root, 'public'), paymentEnvironment: 'alby-sandbox' });
  await new Promise(resolveListen => app.listen(0, '127.0.0.1', resolveListen));
  const base = `http://127.0.0.1:${app.address().port}`;
  const members = store.group().members;
  const accounts = new Map();
  const receipts = [];
  for (const [index, member] of members.entries()) {
    stage = `authenticating ${member.name}`;
    const code = new RegExp(`${member.name}: (\\S+)`).exec(invites)?.[1];
    if (!code) throw new Error('Could not create a temporary member code.');
    const login = await request(base, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: member.id, code }) });
    if (login.status !== 200) throw new Error('CircleSats member sign-in failed.');
    const headers = { Cookie: login.cookie, 'X-CSRF-Token': login.data.csrf, 'Content-Type': 'application/json' };
    accounts.set(member.id, headers);

    stage = `creating ${member.name}'s invoice`;
    const created = await request(base, '/api/invoices', { method: 'POST', headers, body: '{}' });
    if (created.status !== 201 || created.data.record?.amountSats !== 100) throw new Error('CircleSats invoice creation failed.');
    const invoice = created.data.record;
    const stored = store.latestFor(member.id);
    if (stored.roundId !== store.round().id || stored.memberId !== member.id ||
        stored.paymentRequest !== invoice.paymentRequest || !/^[a-f0-9]{64}$/i.test(stored.paymentHash)) {
      throw new Error('Invoice was not bound to the member and active round.');
    }

    if (index === 0) {
      stage = 'disconnecting and reconnecting the sandbox payer';
      payer.close(); payer = null;
      const whileDisconnected = await request(base, '/api/group', { headers: { Cookie: login.cookie } });
      if (whileDisconnected.data.records?.find(item => item.id === invoice.id)?.status !== 'pending' || store.round().confirmedSats !== 0) {
        throw new Error('Unpaid invoice was credited while the payer wallet was disconnected.');
      }
      const restored = await connectWallet(secrets.payer);
      if (restored.info.network !== payerInfo.network) { restored.client.close(); throw new Error('Reconnected payer network changed.'); }
      payer = restored.client;
    }

    stage = `paying ${member.name}'s invoice with the sandbox payer`;
    const payment = await payer.payInvoice({ invoice: invoice.paymentRequest });
    const preimage = payment?.preimage;
    if (typeof preimage !== 'string' || !/^[a-f0-9]{64}$/i.test(preimage) ||
        createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex') !== stored.paymentHash.toLowerCase()) {
      throw new Error('Payer returned no matching payment preimage.');
    }

    stage = `checking ${member.name}'s receiver settlement`;
    let snapshot;
    for (let attempt = 0; attempt < 15; attempt++) {
      snapshot = await request(base, '/api/group', { headers: { Cookie: login.cookie } });
      if (snapshot.data.records?.some(item => item.id === invoice.id && item.status === 'paid')) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 1000));
    }
    const paid = snapshot.data.records.find(item => item.id === invoice.id);
    if (paid?.status !== 'paid' || paid.paymentHash !== stored.paymentHash || snapshot.data.round.confirmedSats !== (index + 1) * 100) {
      throw new Error('Receiver did not confirm the expected contribution.');
    }

    stage = `verifying ${member.name}'s receipt`;
    const proof = await request(base, '/api/proofs', { method: 'POST', headers, body: JSON.stringify({ preimage }) });
    if (proof.status !== 200 || proof.data.record.attribution !== 'member-proof') throw new Error('Member payment proof failed.');
    const duplicate = await request(base, '/api/invoices', { method: 'POST', headers, body: '{}' });
    if (duplicate.status !== 409) throw new Error('A duplicate contribution was accepted.');
    receipts.push({ contributionId: stored.id, memberId: member.id, paymentHash: stored.paymentHash,
      amountSats: stored.amountSats, paidAt: proof.data.record.paidAt, attribution: proof.data.record.attribution });
  }

  stage = 'approving funded round';
  if (store.round().phase !== 'funded' || store.round().confirmedSats !== 400) throw new Error('Round did not become funded.');
  for (const member of members.filter(item => item.id !== store.round().recipientId)) {
    const approval = await request(base, '/api/round/approve', { method: 'POST', headers: accounts.get(member.id), body: '{}' });
    if (approval.status !== 200) throw new Error('A required member approval failed.');
  }
  if (store.round().phase !== 'approved' || store.round().settlement.status !== 'approved') {
    throw new Error('Payout was not approved after the required votes.');
  }
  const reloaded = createStore(ledgerPath); await reloaded.load();
  if (reloaded.round().phase !== 'approved' || reloaded.round().confirmedSats !== 400 ||
      members.some(member => reloaded.latestFor(member.id)?.status !== 'paid')) {
    throw new Error('Verified receipts and approvals did not survive ledger reload.');
  }

  const evidence = { at: new Date().toISOString(), environment: 'alby-sandbox', network: receiverInfo.network,
    receiverMethods: receiverInfo.methods, payerMethods: payerInfo.methods,
    receiverSecretHasSpendPermission: receiverInfo.methods.includes('pay_invoice'),
    groupId: store.group().id, cycleId: store.cycle().id, roundId: store.round().id,
    recipientId: store.round().recipientId, contributions: receipts, payerWalletCount: 1,
    duplicateInvoicesBlocked: receipts.length, payerReconnectVerified: true, confirmedSats: reloaded.round().confirmedSats,
    roundPhase: reloaded.round().phase, approvals: reloaded.round().approvals.map(item => item.memberId),
    settlementStatus: reloaded.round().settlement.status, ledgerFile: ledgerPath };
  await writeFile(evidenceFile, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ result: 'passed', environment: evidence.environment, network: evidence.network,
    payments: receipts.length, confirmedSats: evidence.confirmedSats, roundPhase: evidence.roundPhase,
    approvals: evidence.approvals.length, settlementStatus: evidence.settlementStatus,
    duplicateBlocked: true, payerReconnectVerified: true, persisted: true,
    receiverSecretHasSpendPermission: evidence.receiverSecretHasSpendPermission }));
} catch (error) {
  const message = String(error?.message || error).replace(/nostr\+walletconnect:\/\/\S+/gi, '[redacted connection]');
  console.error(`Sandbox smoke failed during ${stage}: ${message}`);
  process.exitCode = 1;
} finally {
  if (app) await new Promise(resolveClose => app.close(resolveClose));
  receiver?.close(); payer?.close();
}
