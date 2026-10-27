import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createNwcReceiver } from '../src/nwc-receiver.js';
import { createStore } from '../src/store.js';

if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  throw new Error('TLS certificate validation must remain enabled.');
}
if (process.env.PAYMENT_ENVIRONMENT !== 'signet' || process.env.LIGHTNING_PROVIDER !== 'nwc' ||
    !process.env.NWC_RECEIVER_CONNECTION_SECRET) {
  throw new Error('A private Signet NWC receiver is required.');
}

const dataDir = resolve(process.env.DATA_DIR || 'data/mutinynet');
const evidenceFiles = (await readdir(dataDir)).filter(name => /^invoice-[0-9a-f-]+\.json$/i.test(name));
if (evidenceFiles.length !== 1) throw new Error('Expected exactly one private Mutinynet invoice evidence file.');
const invoice = JSON.parse(await readFile(join(dataDir, evidenceFiles[0]), 'utf8'));
if (invoice.environment !== 'signet' || invoice.memberId !== 'awa' || invoice.amountSats !== 100) {
  throw new Error('Private invoice evidence does not match the approved test plan.');
}

let receiver;
try {
  receiver = await createNwcReceiver({ connectionSecret: process.env.NWC_RECEIVER_CONNECTION_SECRET, expectedNetwork: 'signet' });
  const payment = await receiver.checkPayment({ paymentHash: invoice.paymentHash,
    paymentRequest: invoice.paymentRequest, amountSats: invoice.amountSats, checkingId: invoice.paymentHash });
  if (!payment.settled) {
    console.log(JSON.stringify({ result: payment.failed ? 'expired' : 'pending',
      contributionId: invoice.contributionId, paymentHash: invoice.paymentHash, credited: false }));
    process.exitCode = 2;
  } else {
    const base = `http://127.0.0.1:${Number(process.env.PORT || 3102)}`;
    async function group() {
      const response = await fetch(`${base}/api/group`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`CircleSats returned HTTP ${response.status}.`);
      return response.json();
    }
    const first = await group();
    const file = join(dataDir, 'circlesats.json');
    const reloaded = createStore(file);
    await reloaded.load();
    const record = reloaded.all().find(item => item.id === invoice.contributionId);
    const sameHash = reloaded.all().filter(item => item.paymentHash === invoice.paymentHash);
    if (first.environment !== 'signet' || first.network !== 'signet' ||
        record?.status !== 'paid' || record.groupId !== invoice.groupId ||
        record.roundId !== invoice.roundId || record.memberId !== 'awa' ||
        record.amountSats !== 100 || record.paymentHash !== invoice.paymentHash ||
        sameHash.length !== 1 || reloaded.round().confirmedSats !== 100) {
      throw new Error('CircleSats receipt or durable round accounting does not match the receiving wallet.');
    }
    const beforeRevision = JSON.parse(await readFile(file, 'utf8')).revision;
    const second = await group();
    const afterRevision = JSON.parse(await readFile(file, 'utf8')).revision;
    if (second.round.confirmedSats !== 100 || beforeRevision !== afterRevision) {
      throw new Error('Repeated settlement lookup changed the ledger or round total.');
    }
    const evidence = { network: 'Mutinynet', environment: 'signet', contributionId: record.id,
      memberId: record.memberId, amountSats: record.amountSats, paymentHash: record.paymentHash,
      provider: record.provider, receiverStatus: 'settled', payerStatus: 'verify separately',
      preimageVerified: payment.preimageVerified, settledAt: payment.settledAt,
      paidAt: record.paidAt, attribution: record.attribution || 'unverified',
      ledgerRevision: afterRevision, confirmedSats: second.round.confirmedSats,
      duplicateLookupStable: true, persistedReload: true, checkedAt: new Date().toISOString() };
    const output = join(dataDir, 'settlement-evidence.json');
    await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ result: 'settled', ...evidence, privateEvidenceFile: output }));
  }
} finally {
  receiver?.close();
}
