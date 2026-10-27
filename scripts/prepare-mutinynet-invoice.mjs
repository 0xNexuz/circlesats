import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { decodeLedger } from '../src/durable-json.js';
import { validateSignetInvoice } from '../src/invoice-validation.js';

if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  throw new Error('Remove NODE_TLS_REJECT_UNAUTHORIZED=0 before preparing a Lightning invoice.');
}
if (process.env.PAYMENT_ENVIRONMENT !== 'signet' || process.env.LIGHTNING_PROVIDER !== 'nwc' ||
    process.env.LNBITS_NETWORK !== 'signet' || !process.env.NWC_RECEIVER_CONNECTION_SECRET) {
  throw new Error('A configured Signet NWC receiver is required.');
}

const dataDir = resolve(process.env.DATA_DIR || 'data/mutinynet');
const base = `http://127.0.0.1:${Number(process.env.PORT || 3102)}`;
const invites = await readFile(join(dataDir, 'member-invites.txt'), 'utf8');
const code = /^Awa:\s*(\S+)$/m.exec(invites)?.[1];
if (!code) throw new Error('Awa test member code is missing from the private invite file.');

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(10000) });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

const login = await request('/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ memberId: 'awa', code })
});
if (login.status !== 200 || !login.cookie || !login.data.csrf) throw new Error('Awa could not sign in to the private Mutinynet test instance.');
const headers = { Cookie: login.cookie, 'X-CSRF-Token': login.data.csrf, 'Content-Type': 'application/json' };
const created = await request('/api/invoices', { method: 'POST', headers, body: '{}' });
if (![200, 201].includes(created.status) || created.data.record?.status !== 'pending') {
  throw new Error(`CircleSats did not return a pending invoice (HTTP ${created.status}).`);
}
const group = await request('/api/group', { headers: { Cookie: login.cookie } });
if (group.status !== 200 || group.data.environment !== 'signet' || group.data.network !== 'signet' ||
    group.data.mode !== 'lightning' || group.data.round?.confirmedSats !== 0) {
  throw new Error('CircleSats network, mode, or round accounting did not match the test plan.');
}

const ledger = decodeLedger(await readFile(join(dataDir, 'circlesats.json'), 'utf8'));
const record = ledger.records.find(item => item.id === created.data.record.id);
if (!record || record.groupId !== group.data.group.id || record.roundId !== group.data.round.id ||
    record.memberId !== 'awa' || record.amountSats !== 100 || record.provider !== 'nwc' ||
    record.environment !== 'signet' || record.status !== 'pending' ||
    record.paymentRequest !== created.data.record.paymentRequest) {
  throw new Error('The private contribution ledger did not match the CircleSats invoice response.');
}
const expiresAt = validateSignetInvoice(record);
if (record.expiresAt !== expiresAt) throw new Error('Stored invoice expiry does not match BOLT11.');

const evidenceFile = join(dataDir, `invoice-${record.id}.json`);
const evidence = { environment: 'signet', network: 'Mutinynet', provider: 'nwc', groupId: record.groupId,
  roundId: record.roundId, memberId: record.memberId, contributionId: record.id, amountSats: 100,
  paymentHash: record.paymentHash, paymentRequest: record.paymentRequest, expiresAt,
  createdAt: record.createdAt, status: 'pending', ledgerRevision: ledger.revision };
try { await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const prior = JSON.parse(await readFile(evidenceFile, 'utf8'));
  if (prior.paymentHash !== evidence.paymentHash || prior.paymentRequest !== evidence.paymentRequest) {
    throw new Error('Existing private invoice evidence does not match this contribution.');
  }
}
console.log(JSON.stringify({ result: 'pending', network: evidence.network, provider: evidence.provider,
  memberId: evidence.memberId, amountSats: evidence.amountSats, paymentHash: evidence.paymentHash,
  contributionId: evidence.contributionId, roundId: evidence.roundId, expiresAt, ledgerRevision: ledger.revision,
  evidenceFile, paymentExecuted: false }));
