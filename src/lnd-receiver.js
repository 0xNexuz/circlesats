// Receive-only adapter for an LND node's REST API, for example a hosted
// Mutinynet node from Voltage. It exposes the same createInvoice/checkPayment
// shape as the NWC and Blink receivers.
//
// The credential must be LND's invoice macaroon (or one with fewer rights). Its
// permissions are read from the macaroon itself before any request is made, and
// a macaroon that could pay, send coins or manage the node is refused, so
// CircleSats can create and check invoices but never spend.
import { createHash } from 'node:crypto';
import { decodeInvoice } from '@getalby/lightning-tools/bolt11';
import { LightningError } from './lnbits.js';

const HEX64 = /^[a-f0-9]{64}$/i;
// Write rights an invoice-only credential may hold. Every other write is refused.
const ALLOWED_WRITES = new Set(['invoices:write', 'address:write']);
const ALLOWED_URIS = new Set(['/lnrpc.Lightning/AddInvoice', '/lnrpc.Lightning/LookupInvoice',
  '/lnrpc.Lightning/ListInvoices', '/invoicesrpc.Invoices/LookupInvoiceV2']);

function macaroonBytes(value) {
  const text = String(value || '').trim();
  if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) return Buffer.from(text, 'hex');
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  throw new Error('The LND macaroon is not hex or base64.');
}

function reader(bytes) {
  let offset = 0;
  return {
    get done() { return offset >= bytes.length; },
    byte() { if (offset >= bytes.length) throw new Error('truncated'); return bytes[offset++]; },
    varint() {
      let value = 0;
      for (let shift = 0; shift < 35; shift += 7) {
        const byte = this.byte();
        value += (byte & 0x7f) * 2 ** shift;
        if (!(byte & 0x80)) return value;
      }
      throw new Error('varint too long');
    },
    take(length) {
      if (offset + length > bytes.length) throw new Error('truncated');
      const slice = bytes.subarray(offset, offset + length); offset += length; return slice;
    }
  };
}

// Protobuf fields of one message, as [fieldNumber, bytes] for length-delimited
// fields. Other wire types are skipped.
function protobufFields(bytes) {
  const input = reader(bytes);
  const fields = [];
  while (!input.done) {
    const key = input.varint();
    const wireType = key & 7;
    if (wireType === 2) fields.push([Math.floor(key / 8), input.take(input.varint())]);
    else if (wireType === 0) input.varint();
    else if (wireType === 1) input.take(8);
    else if (wireType === 5) input.take(4);
    else throw new Error('unsupported wire type');
  }
  return fields;
}

// Reads the permissions of an LND macaroon (binary format v2; identifier is
// version 3 followed by a MacaroonId protobuf), as LND's `lncli printmacaroon`
// does. Returns ['invoices:read', ...].
export function macaroonPermissions(value) {
  const input = reader(macaroonBytes(value));
  if (input.byte() !== 2) throw new Error('Unsupported macaroon format.');
  let identifier = null;
  while (identifier === null) {
    const type = input.varint();
    if (type === 0) throw new Error('The macaroon has no identifier.');
    const data = input.take(input.varint());
    if (type === 2) identifier = data;
  }
  if (identifier[0] !== 3) throw new Error('Unsupported macaroon identifier.');
  const permissions = [];
  for (const [field, op] of protobufFields(identifier.subarray(1))) {
    if (field !== 3) continue;
    let entity = '';
    const actions = [];
    for (const [opField, data] of protobufFields(op)) {
      if (opField === 1) entity = data.toString('utf8');
      if (opField === 2) actions.push(data.toString('utf8'));
    }
    for (const action of actions) permissions.push(`${entity}:${action}`);
  }
  if (!permissions.length) throw new Error('The macaroon lists no permissions.');
  return permissions;
}

export function assertReceiveOnlyMacaroon(value) {
  let permissions;
  try { permissions = macaroonPermissions(value); }
  catch { throw new Error('The LND macaroon could not be read. Use the node\'s invoice macaroon in hex.'); }
  const unsafe = permissions.filter(permission => {
    const [entity, ...rest] = permission.split(':');
    const action = rest.join(':');
    if (entity === 'uri') return !ALLOWED_URIS.has(action);
    return action !== 'read' && !ALLOWED_WRITES.has(permission);
  });
  if (unsafe.length) throw new Error('The LND macaroon can spend funds or manage the node. Use the invoice macaroon.');
  const can = permission => permissions.includes(permission);
  if (!(can('invoices:read') || can('uri:/lnrpc.Lightning/LookupInvoice')) ||
      !(can('invoices:write') || can('uri:/lnrpc.Lightning/AddInvoice'))) {
    throw new Error('The LND macaroon needs invoice read and write permissions.');
  }
  return permissions;
}

function restBase(value) {
  let text = String(value || '').trim().replace(/\/+$/, '');
  if (!/^[a-z]+:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try { url = new URL(text); } catch { throw new Error('The LND REST address is not a valid URL.'); }
  if (url.protocol !== 'https:') throw new Error('The LND REST address must use https.');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

const toHex = value => {
  const text = String(value || '');
  if (HEX64.test(text)) return text.toLowerCase();
  try { return Buffer.from(text, 'base64').toString('hex'); } catch { return ''; }
};
const STATES = { 0: 'OPEN', 1: 'SETTLED', 2: 'CANCELED', 3: 'ACCEPTED' };

export async function createLndReceiver({ restUrl, macaroon, fetchImpl = globalThis.fetch, expectedNetwork = 'signet', timeoutMs = 10_000 }) {
  if (!restUrl || !macaroon) return null;
  assertReceiveOnlyMacaroon(macaroon);
  const base = restBase(restUrl);
  const macaroonHex = macaroonBytes(macaroon).toString('hex');

  async function call(path, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, { method, signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Grpc-Metadata-macaroon': macaroonHex, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    } catch { throw new LightningError('The LND node is unreachable. Try again shortly.'); }
    let data = null;
    try { data = await response.json(); } catch { /* handled below */ }
    if (!response.ok) {
      const message = String(data?.message || data?.error || '');
      if (response.status === 404 || /unable to locate invoice|not found/i.test(message)) throw new LightningError('The LND node has no such invoice.');
      if (/permission denied|verification failed/i.test(message)) throw new LightningError('The LND node refused the invoice macaroon.');
      throw new LightningError('The LND node rejected the request.');
    }
    return data;
  }

  // Confirms the address and macaroon work. The invoice macaroon cannot read
  // node info, so the network is enforced on every invoice's prefix instead.
  await call('/v1/invoices?num_max_invoices=1&reversed=true');

  return {
    provider: 'lnd',
    network: expectedNetwork,
    async createInvoice({ amount, memo, expiryMinutes = 30 }) {
      const data = await call('/v1/invoices', { method: 'POST',
        body: { value: String(amount), memo: String(memo || '').slice(0, 120), expiry: String(expiryMinutes * 60), private: true } });
      const paymentRequest = data?.payment_request;
      const decoded = typeof paymentRequest === 'string' ? decodeInvoice(paymentRequest) : null;
      const paymentHash = String(decoded?.paymentHash || '').toLowerCase();
      if (!HEX64.test(paymentHash) || toHex(data?.r_hash) !== paymentHash || decoded.millisatoshi !== amount * 1000) {
        throw new LightningError('The LND node returned an incomplete or mismatched invoice.');
      }
      return { paymentRequest, paymentHash, checkingId: paymentHash };
    },
    async checkPayment(record) {
      const hash = String(record.paymentHash).toLowerCase();
      if (!HEX64.test(hash)) throw new LightningError('The LND node has no such invoice.');
      const invoice = await call(`/v1/invoice/${hash}`);
      const valueMsat = Number(invoice?.value_msat ?? Number(invoice?.value) * 1000);
      if (toHex(invoice?.r_hash) !== hash || invoice.payment_request !== record.paymentRequest || valueMsat !== record.amountSats * 1000) {
        throw new LightningError('LND settlement details do not match this contribution.');
      }
      const state = STATES[invoice.state] || invoice.state;
      if (state === 'ACCEPTED') return { settled: false };
      if (state === 'OPEN') {
        const expiresAt = (Number(invoice.creation_date) + Number(invoice.expiry || 86_400)) * 1000;
        return Number.isFinite(expiresAt) && expiresAt <= Date.now() ? { settled: false, failed: true } : { settled: false };
      }
      if (state === 'CANCELED') return { settled: false, failed: true };
      if (state !== 'SETTLED') throw new LightningError('The LND node returned an unsupported invoice state.');
      if (Number(invoice.amt_paid_msat ?? Number(invoice.amt_paid_sat) * 1000) < record.amountSats * 1000) {
        throw new LightningError('LND settlement details do not match this contribution.');
      }
      // LND knows the preimage of every invoice it issued, so only a settled
      // invoice's preimage is ever returned.
      const preimage = toHex(invoice.r_preimage);
      if (!HEX64.test(preimage) || createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex') !== hash) {
        throw new LightningError('The LND payment proof does not match the payment hash.');
      }
      const settleDate = Number(invoice.settle_date);
      return { settled: true, checkingId: hash, paymentHash: hash, amountSats: record.amountSats, preimageVerified: true, preimage,
        settledAt: settleDate > 0 ? new Date(settleDate * 1000).toISOString() : null };
    },
    close() {}
  };
}
