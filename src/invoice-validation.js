import { decodeInvoice } from '@getalby/lightning-tools/bolt11';
import { LightningError } from './lnbits.js';

// BOLT11 human-readable prefixes for the networks CircleSats accepts.
// Mainnet is used only by the practice payments on the public demo.
const PREFIXES = { signet: /^lntbs(?:\d+[munp]?)?1/i, mainnet: /^lnbc(?!rt)(?:\d+[munp]?)?1/i,
  testnet: /^lntb(?!s)(?:\d+[munp]?)?1/i, regtest: /^lnbcrt(?:\d+[munp]?)?1/i };
// The invoice network expected for each real-network PAYMENT_ENVIRONMENT of the
// Node app. The Alby sandbox (fake sats) stays on its separate checked path.
export const ENVIRONMENT_NETWORKS = { signet: 'signet', testnet: 'testnet', regtest: 'regtest' };

// Checks a provider invoice before storing it: network prefix, checksum-parsed
// fields, exact amount, payment hash and a current expiry. Returns the expiry.
export function validateLightningInvoice({ paymentRequest, paymentHash, amountSats, network }, now = Date.now()) {
  const prefix = PREFIXES[network];
  if (!prefix) throw new LightningError('Unsupported Lightning network.');
  if (typeof paymentRequest !== 'string' || !prefix.test(paymentRequest)) {
    throw new LightningError(network === 'signet' ? 'The receiving wallet returned a non-Signet invoice.' : 'The receiving wallet returned an invoice for another network.');
  }
  const decoded = decodeInvoice(paymentRequest);
  if (!decoded || !/^[a-f0-9]{64}$/i.test(decoded.paymentHash || '') ||
      decoded.paymentHash.toLowerCase() !== String(paymentHash).toLowerCase() ||
      !Number.isSafeInteger(amountSats) || decoded.millisatoshi !== amountSats * 1000) {
    throw new LightningError('The receiving wallet invoice hash or amount does not match this contribution.');
  }
  const expiresAtMs = (decoded.timestamp + (decoded.expiry ?? 3600)) * 1000;
  if (!Number.isSafeInteger(expiresAtMs) || decoded.timestamp * 1000 > now + 300_000 || expiresAtMs <= now) {
    throw new LightningError('The receiving wallet returned an expired invoice.');
  }
  return new Date(expiresAtMs).toISOString();
}

// This guard applies to genuine Signet invoices. The Alby Developer Sandbox
// reports mainnet and is deliberately kept on its separate fake-sat path.
export function validateSignetInvoice(input, now = Date.now()) {
  return validateLightningInvoice({ ...input, network: 'signet' }, now);
}

export function invoiceNetwork(paymentRequest) {
  return Object.entries(PREFIXES).find(([, prefix]) => prefix.test(String(paymentRequest || '')))?.[0] || null;
}
