import { decodeInvoice } from '@getalby/lightning-tools/bolt11';
import { LightningError } from './lnbits.js';

// This guard applies to genuine Signet invoices. The Alby Developer Sandbox
// reports mainnet and is deliberately kept on its separate fake-sat path.
export function validateSignetInvoice({ paymentRequest, paymentHash, amountSats }, now = Date.now()) {
  if (typeof paymentRequest !== 'string' || !/^lntbs(?:\d+[munp]?)?1/i.test(paymentRequest)) {
    throw new LightningError('The receiving wallet returned a non-Signet invoice.');
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
