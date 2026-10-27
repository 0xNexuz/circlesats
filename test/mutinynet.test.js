import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSignetInvoice } from '../src/invoice-validation.js';
import { assertLedgerEnvironment } from '../src/runtime-config.js';

// Synthetic checksum-valid BOLT11 fixture for parser tests only; its signature
// is not a wallet signature and it must never be used as payment evidence.
const invoice = 'lntbs1000n1p4wp8qgpp54w46h2at4w46h2at4w46h2at4w46h2at4w46h2at4w46h2at4w4sdqcgd5hycmvv4fkzarnyp6x2um5qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqz3u8s4';
const paymentHash = 'ab'.repeat(32);
const issuedAt = 1793104904_000;

test('Signet invoice guard checks network, amount, hash, and expiry', () => {
  const input = { paymentRequest: invoice, paymentHash, amountSats: 100 };
  assert.equal(validateSignetInvoice(input, issuedAt), new Date(issuedAt + 3600_000).toISOString());
  assert.throws(() => validateSignetInvoice(input, issuedAt + 3600_000), /expired/);
  assert.throws(() => validateSignetInvoice(input, issuedAt - 301_000), /expired/);
  assert.throws(() => validateSignetInvoice({ ...input, amountSats: 101 }, issuedAt), /hash or amount/);
  assert.throws(() => validateSignetInvoice({ ...input, paymentHash: 'cd'.repeat(32) }, issuedAt), /hash or amount/);
  assert.throws(() => validateSignetInvoice({ ...input, paymentRequest: invoice.replace('lntbs', 'lnbc') }, issuedAt), /non-Signet/);
  assert.throws(() => validateSignetInvoice({ ...input, paymentRequest: invoice.slice(0, -1) + 'q' }, issuedAt), /hash or amount/);
});

test('real and simulated contribution ledgers cannot be reused across environments', () => {
  assert.doesNotThrow(() => assertLedgerEnvironment([{ provider: 'nwc', environment: 'signet' }], 'signet'));
  assert.throws(() => assertLedgerEnvironment([{ provider: 'demo', environment: 'simulated' }], 'signet'), /another or unknown/);
  assert.throws(() => assertLedgerEnvironment([{ provider: 'nwc', environment: 'alby-sandbox' }], 'signet'), /another or unknown/);
  assert.throws(() => assertLedgerEnvironment([{ provider: 'nwc' }], 'signet'), /another or unknown/);
  assert.throws(() => assertLedgerEnvironment([{ provider: 'nwc', environment: 'signet' }], 'simulated'), /another or unknown/);
});
