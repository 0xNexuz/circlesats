// Test-only stand-ins for the circle treasurer's receive-only NWC node and the
// Mutinynet faucet's LNURL-withdraw API. The treasurer mimics createNwcReceiver
// (createInvoice/checkPayment and its error messages); the faucet "pays" by
// settling the treasurer's invoice, like a routed Lightning payment would.
import { createHash, randomBytes } from 'node:crypto';
import { LightningError } from '../../src/lnbits.js';
import { makeSignetInvoice } from './bolt11-fixture.js';

export function fakeTreasurer({ network = 'signet', hidePreimage = false } = {}) {
  const invoices = new Map();
  const node = {
    network, closed: false, invoices,
    async createInvoice({ amount }) {
      const preimage = randomBytes(32).toString('hex');
      const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
      const paymentRequest = makeSignetInvoice({ paymentHash, amountSats: amount, expiry: 1800 });
      invoices.set(paymentHash, { paymentRequest, preimage, amountSats: amount, state: 'pending', settledAt: null });
      return { paymentRequest, paymentHash, checkingId: paymentHash };
    },
    async checkPayment(record) {
      const entry = invoices.get(record.paymentHash.toLowerCase());
      if (!entry) throw new LightningError('The NWC receiver could not check this invoice.');
      if (entry.paymentRequest !== record.paymentRequest || entry.amountSats !== record.amountSats) {
        throw new LightningError('NWC settlement details do not match this contribution.');
      }
      if (entry.state === 'expired') return { settled: false, failed: true };
      if (entry.state !== 'settled') return { settled: false };
      return { settled: true, preimageVerified: hidePreimage ? null : true, preimage: hidePreimage ? null : entry.preimage,
        settledAt: entry.settledAt, paymentHash: record.paymentHash, amountSats: record.amountSats };
    },
    settle(paymentRequest) {
      const entry = [...invoices.values()].find(item => item.paymentRequest === paymentRequest);
      if (!entry || entry.state !== 'pending') return false;
      entry.state = 'settled'; entry.settledAt = new Date().toISOString();
      return true;
    },
    close() { node.closed = true; }
  };
  return node;
}

export function fakeMutinynetFaucet(treasurer, { mode = 'ok', origin = 'https://faucet.test' } = {}) {
  const challenges = new Set();
  const calls = { offers: 0, payments: [] };
  async function fetchImpl(url) {
    const target = new URL(url);
    if (target.pathname === '/api/lnurlw') {
      calls.offers++;
      if (mode === 'limit') return Response.json({ error: 'Too many requests' }, { status: 500 });
      const k1 = randomBytes(32).toString('hex'); challenges.add(k1);
      const callback = mode === 'foreign' ? 'https://evil.test/steal' : `${origin}/api/lnurlw/callback`;
      return Response.json({ tag: 'withdrawRequest', k1, callback, maxWithdrawable: 1_000_000_000, defaultDescription: 'Mutinynet Faucet' });
    }
    if (target.pathname === '/api/lnurlw/callback') {
      const k1 = target.searchParams.get('k1'); const pr = target.searchParams.get('pr');
      if (!challenges.delete(k1)) return Response.json({ status: 'ERROR', reason: 'Incorrect k1' });
      calls.payments.push(pr);
      if (mode === 'noroute') return Response.json({ status: 'ERROR', reason: 'Payment failed: FAILURE_REASON_NO_ROUTE' });
      if (mode === 'quota') return Response.json({ status: 'ERROR', reason: 'Too many payments' });
      if (mode !== 'unconfirmed' && !treasurer.settle(pr)) return Response.json({ status: 'ERROR', reason: 'Payment failed: invoice not payable' });
      return Response.json({ status: 'OK' });
    }
    return new Response('not found', { status: 404 });
  }
  return { fetchImpl, calls, origin };
}

export const practiceEnv = { NWC_RECEIVER_CONNECTION_SECRET: 'nostr+walletconnect://test-only', PAYMENT_ENVIRONMENT: 'signet', LNBITS_NETWORK: 'signet' };
