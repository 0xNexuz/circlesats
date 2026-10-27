// Real Lightning practice payments on Mutinynet (a public signet test network).
//
// A visitor's contribution invoice is created by the circle's treasurer node
// through its receive-only NWC connection. When the visitor pays, the public
// Mutinynet faucet's node is asked, through its LNURL-withdraw endpoint, to
// pay that invoice. The payment is a genuine Lightning payment routed over a
// real channel to the treasurer node, using test coins with no market value.
// It counts only after the treasurer node itself reports it settled with the
// exact invoice, hash and amount and a preimage that hashes to the payment hash.
//
// Stateless by design so it can run as Vercel functions: it pays only invoices
// that this treasurer node issued for the fixed practice amount and that are
// still pending, so it cannot be used to spend faucet coins on anything else.
import { createNwcReceiver } from './nwc-receiver.js';
import { LightningError } from './lnbits.js';
import { validateSignetInvoice } from './invoice-validation.js';
import { decodeInvoice } from '@getalby/lightning-tools/bolt11';

export const PRACTICE_AMOUNT_SATS = 100;
export const MUTINYNET_FAUCET_URL = 'https://faucet.mutinynet.com';
const HEX64 = /^[a-f0-9]{64}$/i;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class PracticeError extends Error {
  constructor(message, status = 502) { super(message); this.name = 'PracticeError'; this.status = status; }
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new PracticeError(message, 504)), ms); })])
    .finally(() => clearTimeout(timer));
}

export function createPracticeService({ env = process.env, connectReceiver = null, fetchImpl = globalThis.fetch,
  faucetUrl = MUTINYNET_FAUCET_URL, connectTimeoutMs = 12_000, faucetTimeoutMs = 70_000,
  settlePollMs = 1_000, settleAttempts = 15, now = () => Date.now() } = {}) {
  const secret = env.NWC_RECEIVER_CONNECTION_SECRET;
  const enabled = Boolean(secret) && env.PAYMENT_ENVIRONMENT === 'signet' && env.LNBITS_NETWORK === 'signet' &&
    env.PRACTICE_LIGHTNING !== '0';
  const faucet = faucetUrl.replace(/\/$/, '');
  let receiverPromise = null;

  // One receive-only connection per warm process, re-created after a failure.
  async function receiver() {
    if (!enabled) throw new PracticeError('Real Lightning practice payments are not configured.', 503);
    receiverPromise ||= withTimeout((connectReceiver || createNwcReceiver)({ connectionSecret: secret, expectedNetwork: 'signet' }),
      connectTimeoutMs, 'The treasurer Lightning node did not respond.');
    try { return await receiverPromise; }
    catch (error) {
      receiverPromise.then(client => client?.close?.(), () => {});
      receiverPromise = null;
      throw error instanceof PracticeError ? error : new PracticeError('The treasurer Lightning node is unavailable.', 503);
    }
  }

  // The invoice must be one this treasurer node issued for the practice amount.
  async function ownedInvoice({ paymentRequest, paymentHash }, { allowExpired = false } = {}) {
    if (typeof paymentRequest !== 'string' || paymentRequest.length > 2000 || !HEX64.test(paymentHash || '')) {
      throw new PracticeError('Invalid practice invoice.', 400);
    }
    const issuedAt = (decodeInvoice(paymentRequest)?.timestamp ?? 0) * 1000;
    let expiresAt;
    try { expiresAt = validateSignetInvoice({ paymentRequest, paymentHash, amountSats: PRACTICE_AMOUNT_SATS }, allowExpired ? issuedAt : now()); }
    catch { throw new PracticeError('This is not a current Mutinynet practice invoice.', 400); }
    const record = { paymentRequest, paymentHash: paymentHash.toLowerCase(), checkingId: paymentHash.toLowerCase(), amountSats: PRACTICE_AMOUNT_SATS };
    const node = await receiver();
    let status;
    try { status = await node.checkPayment(record); }
    catch (error) {
      // A foreign or altered invoice fails here, and so does a temporarily unreachable node.
      throw new PracticeError(/do not match/.test(error?.message || '')
        ? 'This invoice was not issued by the circle treasurer node.'
        : 'The circle treasurer node could not confirm this invoice right now.', 409);
    }
    return { record, status, expiresAt };
  }

  function settledResult(record, status) {
    if (!status.preimage || !status.preimageVerified) throw new PracticeError('The treasurer node did not return a verifiable payment proof.');
    return { status: 'settled', network: 'signet', paymentHash: record.paymentHash, amountSats: record.amountSats,
      preimage: status.preimage, settledAt: status.settledAt || new Date(now()).toISOString() };
  }

  async function faucetPay(paymentRequest) {
    const request = async url => {
      let response;
      try { response = await fetchImpl(url, { signal: AbortSignal.timeout(faucetTimeoutMs), headers: { Accept: 'application/json' } }); }
      catch { throw new PracticeError('The Mutinynet faucet is unreachable right now.'); }
      let data = null;
      try { data = await response.json(); } catch { /* handled below */ }
      return { ok: response.ok, data };
    };
    const offer = await request(`${faucet}/api/lnurlw`);
    if (!offer.ok || offer.data?.tag !== 'withdrawRequest') {
      console.warn(JSON.stringify({ practice: 'faucet-no-offer', ok: offer.ok, error: String(offer.data?.error || offer.data?.reason || '').slice(0, 300) }));
    }
    if (!offer.ok || offer.data?.tag !== 'withdrawRequest' || typeof offer.data.k1 !== 'string' || typeof offer.data.callback !== 'string') {
      throw new PracticeError(offer.data?.error === 'Too many requests'
        ? 'The Mutinynet faucet daily limit is reached. Try again later.' : 'The Mutinynet faucet did not offer a payment.');
    }
    let callback;
    try { callback = new URL(offer.data.callback); } catch { throw new PracticeError('The Mutinynet faucet returned an invalid payment link.'); }
    if (callback.origin !== new URL(faucet).origin) throw new PracticeError('The Mutinynet faucet returned an unexpected payment link.');
    if (Number.isSafeInteger(offer.data.maxWithdrawable) && offer.data.maxWithdrawable < PRACTICE_AMOUNT_SATS * 1000) {
      throw new PracticeError('The Mutinynet faucet cannot pay this amount right now.');
    }
    callback.searchParams.set('k1', offer.data.k1);
    callback.searchParams.set('pr', paymentRequest);
    const paid = await request(callback.href);
    if (paid.data?.status !== 'OK') {
      const reason = String(paid.data?.reason || '');
      console.warn(JSON.stringify({ practice: 'faucet-refused', reason: reason.slice(0, 300) }));
      throw new PracticeError(/too many payments/i.test(reason) ? 'The Mutinynet faucet daily limit is reached. Try again later.'
        : /route/i.test(reason) ? 'The faucet could not find a route to the treasurer node. It may be offline or short of incoming capacity.'
          : 'The Mutinynet faucet could not complete this payment.');
    }
  }

  return {
    enabled,
    async info() {
      const node = await receiver();
      return { available: true, network: node.network, amountSats: PRACTICE_AMOUNT_SATS, payer: 'Mutinynet faucet' };
    },
    async createInvoice({ memo } = {}) {
      const node = await receiver();
      const description = `CircleSats practice contribution${typeof memo === 'string' ? `: ${memo.slice(0, 80)}` : ''}`;
      let invoice;
      try { invoice = await node.createInvoice({ amount: PRACTICE_AMOUNT_SATS, memo: description }); }
      catch { throw new PracticeError('The treasurer node could not create an invoice.'); }
      let expiresAt;
      try { expiresAt = validateSignetInvoice({ ...invoice, amountSats: PRACTICE_AMOUNT_SATS }, now()); }
      catch { throw new PracticeError('The treasurer node returned an invoice that is not a valid Mutinynet invoice.'); }
      return { paymentRequest: invoice.paymentRequest, paymentHash: invoice.paymentHash.toLowerCase(), amountSats: PRACTICE_AMOUNT_SATS, expiresAt };
    },
    async status(input) {
      const { record, status } = await ownedInvoice(input, { allowExpired: true });
      if (status.settled) return settledResult(record, status);
      return { status: status.failed ? 'expired' : 'pending', network: 'signet', paymentHash: record.paymentHash };
    },
    // Safe to retry: an invoice already settled is reported, never paid again.
    async pay(input) {
      const { record, status, expiresAt } = await ownedInvoice(input);
      if (status.settled) return settledResult(record, status);
      if (status.failed || Date.parse(expiresAt) <= now()) throw new PracticeError('This invoice has expired. Create a new contribution.', 409);
      await faucetPay(record.paymentRequest);
      const node = await receiver();
      for (let attempt = 0; attempt < settleAttempts; attempt++) {
        let current;
        try { current = await node.checkPayment(record); } catch { current = { settled: false }; }
        if (current.settled) return settledResult(record, current);
        await sleep(settlePollMs);
      }
      throw new PracticeError('The faucet reported the payment, but the treasurer node has not confirmed it yet. Check again in a moment.', 504);
    }
  };
}

// Shared HTTP handler used by the Vercel functions and the local preview server.
export function createPracticeHandler(service) {
  const hits = new Map();
  function limited(address) {
    const nowMs = Date.now();
    const recent = (hits.get(address) || []).filter(at => nowMs - at < 10 * 60_000);
    recent.push(nowMs); hits.set(address, recent);
    if (hits.size > 5_000) hits.clear();
    return recent.length > 30;
  }
  async function readJson(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
    let text = '';
    for await (const chunk of req) { text += chunk; if (text.length > 4096) throw new PracticeError('Request is too large.', 413); }
    return JSON.parse(text || '{}');
  }
  function send(res, status, value) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(JSON.stringify(value));
  }
  return async function handle(req, res, action) {
    const started = Date.now();
    const finish = res.end.bind(res);
    // One log line per request, without secrets, invoices or addresses.
    res.end = (...args) => {
      let detail = {};
      try { const body = JSON.parse(String(args[0] || '{}')); detail = { result: body.status || (body.available === undefined ? undefined : `available:${body.available}`), error: body.error, hash: String(body.paymentHash || '').slice(0, 12) || undefined }; } catch { /* not JSON */ }
      console.log(JSON.stringify({ practice: action, method: req.method, status: res.statusCode, ms: Date.now() - started, ...detail }));
      return finish(...args);
    };
    try {
      if (action === 'info') {
        if (req.method !== 'GET') return send(res, 405, { error: 'Use GET.' });
        if (!service.enabled) return send(res, 200, { available: false });
        return send(res, 200, await service.info());
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
      const address = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
      if (limited(address)) return send(res, 429, { error: 'Too many practice requests. Try again in a few minutes.' });
      let input;
      try { input = await readJson(req); } catch (error) { return send(res, error.status || 400, { error: 'Invalid JSON.' }); }
      if (action === 'invoice') return send(res, 201, await service.createInvoice(input));
      if (action === 'pay') return send(res, 200, await service.pay(input));
      if (action === 'status') return send(res, 200, await service.status(input));
      return send(res, 404, { error: 'Not found.' });
    } catch (error) {
      const known = error instanceof PracticeError || error instanceof LightningError;
      if (!known) console.error('Practice payment request failed', { name: error?.name, message: String(error?.message || '').replace(/nostr\+walletconnect:\/\/\S+/gi, '[redacted]').slice(0, 200) });
      return send(res, known ? (error.status || 502) : 500, { error: known ? error.message : 'Unable to complete the request.' });
    }
  };
}
