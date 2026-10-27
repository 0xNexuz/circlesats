// Test-only stand-in for an LND node's REST API (the calls CircleSats makes)
// and a builder for LND-format macaroons (binary v2, identifier version 3 with a
// MacaroonId protobuf), so permission checks run against the real layout.
import { createHash, randomBytes } from 'node:crypto';
import { makeSignetInvoice } from './bolt11-fixture.js';

const varint = value => { const out = []; while (value > 127) { out.push((value & 127) | 128); value = Math.floor(value / 128); } out.push(value); return Buffer.from(out); };
const field = (number, data) => Buffer.concat([varint(number * 8 + 2), varint(data.length), Buffer.from(data)]);
const macField = (type, data) => Buffer.concat([varint(type), varint(data.length), Buffer.from(data)]);

export const INVOICE_PERMISSIONS = ['invoices:read', 'invoices:write', 'address:read', 'address:write', 'onchain:read'];
export const ADMIN_PERMISSIONS = [...INVOICE_PERMISSIONS, 'offchain:read', 'offchain:write', 'onchain:write', 'info:read', 'peers:write', 'signer:generate', 'macaroon:generate'];

export function makeMacaroon(permissions = INVOICE_PERMISSIONS, { encoding = 'hex' } = {}) {
  const grouped = new Map();
  for (const permission of permissions) {
    const [entity, ...action] = permission.split(':');
    grouped.set(entity, [...(grouped.get(entity) || []), action.join(':')]);
  }
  const ops = [...grouped].map(([entity, actions]) => field(3, Buffer.concat([field(1, entity), ...actions.map(action => field(2, action))])));
  const identifier = Buffer.concat([Buffer.from([3]), field(1, randomBytes(16)), field(2, '0'), ...ops]);
  const bytes = Buffer.concat([Buffer.from([2]), macField(1, 'lnd'), macField(2, identifier), Buffer.from([0]),
    macField(2, 'time-before 2099-01-01T00:00:00Z'), Buffer.from([0]), Buffer.from([0]), macField(6, randomBytes(32))]);
  return encoding === 'base64' ? bytes.toString('base64') : bytes.toString('hex');
}

export function fakeLnd({ host = 'https://node.lnd.test:8080', macaroon = makeMacaroon(), network = 'signet', numericState = false } = {}) {
  const invoices = new Map();
  const calls = [];
  const b64 = hex => Buffer.from(hex, 'hex').toString('base64');
  async function fetchImpl(url, options = {}) {
    const target = new URL(url);
    calls.push({ method: options.method || 'GET', path: target.pathname, macaroon: options.headers?.['Grpc-Metadata-macaroon'] });
    if (target.origin !== new URL(host).origin) return new Response('not found', { status: 404 });
    if (options.headers?.['Grpc-Metadata-macaroon'] !== Buffer.from(macaroon, /^[0-9a-f]+$/i.test(macaroon) ? 'hex' : 'base64').toString('hex')) {
      return Response.json({ code: 2, message: 'verification failed: signature mismatch after caveat verification' }, { status: 500 });
    }
    if (target.pathname === '/v1/invoices' && (options.method || 'GET') === 'GET') return Response.json({ invoices: [] });
    if (target.pathname === '/v1/invoices' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      const preimage = randomBytes(32).toString('hex');
      const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
      const paymentRequest = makeSignetInvoice({ paymentHash, amountSats: Number(body.value), expiry: Number(body.expiry), network });
      invoices.set(paymentHash, { paymentRequest, preimage, value: Number(body.value), state: 'OPEN', creation: Math.floor(Date.now() / 1000), expiry: Number(body.expiry), settleDate: 0 });
      return Response.json({ r_hash: b64(paymentHash), payment_request: paymentRequest, add_index: String(invoices.size), payment_addr: b64(randomBytes(32).toString('hex')) });
    }
    const lookup = /^\/v1\/invoice\/([0-9a-f]{64})$/.exec(target.pathname);
    if (lookup) {
      const entry = invoices.get(lookup[1]);
      if (!entry) return Response.json({ code: 5, message: 'unable to locate invoice' }, { status: 404 });
      const codes = { OPEN: 0, SETTLED: 1, CANCELED: 2, ACCEPTED: 3 };
      return Response.json({ memo: '', r_preimage: b64(entry.preimage), r_hash: b64(lookup[1]), value: String(entry.value), value_msat: String(entry.value * 1000),
        settled: entry.state === 'SETTLED', creation_date: String(entry.creation), settle_date: String(entry.settleDate), payment_request: entry.paymentRequest,
        expiry: String(entry.expiry), state: numericState ? codes[entry.state] : entry.state,
        amt_paid_sat: entry.state === 'SETTLED' ? String(entry.value) : '0', amt_paid_msat: entry.state === 'SETTLED' ? String(entry.value * 1000) : '0' });
    }
    return Response.json({ code: 12, message: 'Not Implemented' }, { status: 501 });
  }
  return {
    host, macaroon, fetchImpl, invoices, calls,
    // Plays a routed payment arriving (e.g. from the Mutinynet faucet's node).
    settle(paymentRequest) {
      const entry = [...invoices.values()].find(item => item.paymentRequest === paymentRequest);
      if (!entry || entry.state !== 'OPEN') return false;
      entry.state = 'SETTLED'; entry.settleDate = Math.floor(Date.now() / 1000);
      return true;
    },
    cancel(paymentRequest) {
      const entry = [...invoices.values()].find(item => item.paymentRequest === paymentRequest);
      if (entry) entry.state = 'CANCELED';
    }
  };
}
