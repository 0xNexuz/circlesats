// Real Lightning practice payments for visitors to the public demo.
//
// Two rails, each backed by the circle treasurer's own receive-only wallet:
// - mainnet: a real Bitcoin invoice from the treasurer's Blink wallet (API key
//   with Read + Receive only). The visitor pays it from their own Lightning
//   wallet; CircleSats only checks it.
// - signet: a Mutinynet invoice from the treasurer's always-online LND node
//   (for example a free hosted Voltage node, invoice macaroon only) or, when
//   that is not configured, from a receive-only NWC node such as Alby Hub. The
//   public Mutinynet faucet's node pays it on request through its
//   LNURL-withdraw endpoint (test coins with no market value).
// A payment counts only after the treasurer wallet itself reports the exact
// invoice, hash and amount as settled; preimages are checked against the hash.
//
// Stateless by design so it can run as Vercel functions. It pays (signet only)
// just invoices this treasurer issued for the fixed practice amount that are
// still pending, so it cannot be used to spend faucet coins on anything else.
import { createNwcReceiver } from './nwc-receiver.js';
import { createBlinkReceiver } from './blink-receiver.js';
import { createLndReceiver } from './lnd-receiver.js';
import { LightningError } from './lnbits.js';
import { invoiceNetwork, validateLightningInvoice } from './invoice-validation.js';
import { decodeInvoice } from '@getalby/lightning-tools/bolt11';
import QRCode from 'qrcode';

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

export function createPracticeService({ env = process.env, connectReceiver = null, connectMainnet = null, connectLnd = null, fetchImpl = globalThis.fetch,
  faucetUrl = MUTINYNET_FAUCET_URL, connectTimeoutMs = 8_000, failureCooldownMs = 60_000, faucetTimeoutMs = 70_000,
  settlePollMs = 1_000, settleAttempts = 15, now = () => Date.now() } = {}) {
  // A hosted LND node is preferred for test coins because it stays online.
  const lnd = Boolean(env.LND_REST_URL && env.LND_INVOICE_MACAROON);
  const rails = {
    mainnet: {
      enabled: Boolean(env.BLINK_RECEIVE_API_KEY) && env.PRACTICE_MAINNET !== '0',
      payer: 'your own Lightning wallet', label: 'Bitcoin Lightning (mainnet)',
      connect: () => (connectMainnet || createBlinkReceiver)({ apiKey: env.BLINK_RECEIVE_API_KEY, fetchImpl, expectedNetwork: 'mainnet' })
    },
    signet: {
      enabled: env.PRACTICE_LIGHTNING !== '0' && (lnd || (Boolean(env.NWC_RECEIVER_CONNECTION_SECRET) &&
        env.PAYMENT_ENVIRONMENT === 'signet' && env.LNBITS_NETWORK === 'signet')),
      payer: 'Mutinynet faucet', label: 'Mutinynet Lightning (test coins)',
      connect: () => lnd
        ? (connectLnd || createLndReceiver)({ restUrl: env.LND_REST_URL, macaroon: env.LND_INVOICE_MACAROON, fetchImpl, expectedNetwork: 'signet' })
        : (connectReceiver || createNwcReceiver)({ connectionSecret: env.NWC_RECEIVER_CONNECTION_SECRET, expectedNetwork: 'signet' })
    }
  };
  const faucet = faucetUrl.replace(/\/$/, '');
  const connections = {};
  const failedAt = {};

  // One receive-only connection per rail and warm process, re-created after a
  // failure. After a failed connection (for example the treasurer's PC is off)
  // the rail reports unavailable at once for a minute, so visitors fall back to
  // the sandbox quickly instead of each waiting for the connection timeout.
  async function receiver(network) {
    const rail = rails[network];
    if (!rail?.enabled) throw new PracticeError('This kind of practice payment is not configured.', 503);
    if (!connections[network] && now() - (failedAt[network] ?? -Infinity) < failureCooldownMs) {
      throw new PracticeError('The treasurer wallet is unavailable.', 503);
    }
    if (!connections[network]) {
      const attempt = Promise.resolve().then(() => rail.connect());
      connections[network] = withTimeout(attempt, connectTimeoutMs, 'The treasurer wallet did not respond.');
      // A connection that completes after the timeout is closed, not leaked.
      connections[network].catch(() => attempt.then(client => client?.close?.(), () => {}));
    }
    const pending = connections[network];
    try {
      const client = await pending;
      delete failedAt[network];
      return client;
    } catch (error) {
      if (connections[network] === pending) { delete connections[network]; failedAt[network] = now(); }
      if (!(error instanceof PracticeError)) console.warn(JSON.stringify({ practice: 'receiver-unavailable', network, reason: String(error?.message || '').replace(/[0-9a-f]{80,}/gi, '[redacted]').slice(0, 200) }));
      throw error instanceof PracticeError ? error : new PracticeError('The treasurer wallet is unavailable.', 503);
    }
  }

  // The invoice must be one this treasurer issued for the practice amount.
  async function ownedInvoice({ paymentRequest, paymentHash }, { allowExpired = false } = {}) {
    if (typeof paymentRequest !== 'string' || paymentRequest.length > 2000 || !HEX64.test(paymentHash || '')) {
      throw new PracticeError('Invalid practice invoice.', 400);
    }
    const network = invoiceNetwork(paymentRequest);
    if (!rails[network]?.enabled) throw new PracticeError('This is not a practice invoice for this circle.', 400);
    const issuedAt = (decodeInvoice(paymentRequest)?.timestamp ?? 0) * 1000;
    let expiresAt;
    try { expiresAt = validateLightningInvoice({ paymentRequest, paymentHash, amountSats: PRACTICE_AMOUNT_SATS, network }, allowExpired ? issuedAt : now()); }
    catch { throw new PracticeError('This is not a current practice invoice.', 400); }
    const record = { paymentRequest, paymentHash: paymentHash.toLowerCase(), checkingId: paymentHash.toLowerCase(), amountSats: PRACTICE_AMOUNT_SATS };
    const node = await receiver(network);
    let status;
    try { status = await node.checkPayment(record); }
    catch (error) {
      // A foreign or altered invoice fails here, and so does a temporarily unreachable wallet.
      throw new PracticeError(/do not match|no such invoice/.test(error?.message || '')
        ? 'This invoice was not issued by the circle treasurer.'
        : 'The circle treasurer could not confirm this invoice right now.', 409);
    }
    return { record, status, expiresAt, network };
  }

  function settledResult(record, status, network) {
    // Mutinynet proofs come from our own node and are required. A mainnet
    // wallet may omit the preimage; the receipt then says it is unavailable.
    if (network === 'signet' && (!status.preimage || !status.preimageVerified)) {
      throw new PracticeError('The treasurer node did not return a verifiable payment proof.');
    }
    return { status: 'settled', network, paymentHash: record.paymentHash, amountSats: record.amountSats,
      preimage: status.preimageVerified ? status.preimage : null, settledAt: status.settledAt || new Date(now()).toISOString() };
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

  const paying = new Map();
  const service = {
    get enabled() { return Object.values(rails).some(rail => rail.enabled); },
    async info() {
      const result = {};
      await Promise.all(Object.entries(rails).map(async ([network, rail]) => {
        if (!rail.enabled) { result[network] = { available: false }; return; }
        try { await receiver(network); result[network] = { available: true, payer: rail.payer, label: rail.label }; }
        catch { result[network] = { available: false }; }
      }));
      return { available: Object.values(result).some(rail => rail.available), amountSats: PRACTICE_AMOUNT_SATS, rails: result };
    },
    async createInvoice({ memo, network } = {}) {
      const chosen = network || (rails.mainnet.enabled ? 'mainnet' : 'signet');
      if (!['mainnet', 'signet'].includes(chosen)) throw new PracticeError('Unknown practice network.', 400);
      const node = await receiver(chosen);
      const description = `CircleSats practice contribution${typeof memo === 'string' ? `: ${memo.slice(0, 80)}` : ''}`;
      let invoice;
      try { invoice = await node.createInvoice({ amount: PRACTICE_AMOUNT_SATS, memo: description }); }
      catch { throw new PracticeError('The treasurer wallet could not create an invoice.'); }
      let expiresAt;
      try { expiresAt = validateLightningInvoice({ ...invoice, amountSats: PRACTICE_AMOUNT_SATS, network: chosen }, now()); }
      catch { throw new PracticeError('The treasurer wallet returned an invoice for the wrong network or amount.'); }
      return { paymentRequest: invoice.paymentRequest, paymentHash: invoice.paymentHash.toLowerCase(), amountSats: PRACTICE_AMOUNT_SATS, expiresAt, network: chosen };
    },
    async status(input) {
      const { record, status, network } = await ownedInvoice(input, { allowExpired: true });
      if (status.settled) return settledResult(record, status, network);
      return { status: status.failed ? 'expired' : 'pending', network, paymentHash: record.paymentHash };
    },
    // Signet only, and safe to retry: an invoice already settled is reported,
    // never paid again. Simultaneous requests for one invoice share a single
    // faucet payment instead of each spending faucet allowance.
    pay(input) {
      const key = String(input?.paymentHash || '').toLowerCase();
      if (HEX64.test(key) && paying.has(key)) return paying.get(key);
      const work = payOnce(input);
      if (HEX64.test(key)) {
        paying.set(key, work);
        work.finally(() => paying.delete(key)).catch(() => {});
      }
      return work;
    }
  };

  async function payOnce(input) {
    const { record, status, expiresAt, network } = await ownedInvoice(input);
    if (status.settled) return settledResult(record, status, network);
    if (network !== 'signet') throw new PracticeError('Pay this invoice from your own Lightning wallet, then check again.', 400);
    if (status.failed || Date.parse(expiresAt) <= now()) throw new PracticeError('This invoice has expired. Create a new contribution.', 409);
    await faucetPay(record.paymentRequest);
    const node = await receiver(network);
    for (let attempt = 0; attempt < settleAttempts; attempt++) {
      let current;
      try { current = await node.checkPayment(record); } catch { current = { settled: false }; }
      if (current.settled) return settledResult(record, current, network);
      await sleep(settlePollMs);
    }
    throw new PracticeError('The faucet reported the payment, but the treasurer node has not confirmed it yet. Check again in a moment.', 504);
  }
  return service;
}

// Shared HTTP handler used by the Vercel functions and the local preview server.
// Client addresses come from forwarding headers only on Vercel, which sets
// them itself; anywhere else a client could forge them, so the socket address
// is used.
export function createPracticeHandler(service, { trustProxyHeaders = process.env.VERCEL === '1', now = () => Date.now() } = {}) {
  const hits = new Map();
  const MINUTE = 60_000;
  // [limit, window] rules per address, action and warm instance. Status is
  // polled while a visitor pays from their own wallet, so it gets a larger
  // budget. Each pay asks the shared Mutinynet faucet for coins, which allows
  // this server roughly 30 payments a day, so one address gets enough to
  // replay the four-round demo but cannot use up the day's coins for everyone.
  const LIMITS = { invoice: [[30, 10 * MINUTE]], pay: [[8, 60 * MINUTE], [12, 24 * 60 * MINUTE]],
    status: [[240, 10 * MINUTE]], qr: [[120, 10 * MINUTE]] };
  function limited(address, action) {
    const rules = LIMITS[action] || [[30, 10 * MINUTE]];
    const longest = Math.max(...rules.map(([, window]) => window));
    const key = `${action}:${address}`;
    const nowMs = now();
    const recent = (hits.get(key) || []).filter(at => nowMs - at < longest);
    if (rules.some(([limit, window]) => recent.filter(at => nowMs - at < window).length >= limit)) {
      hits.set(key, recent);
      return true;
    }
    recent.push(nowMs); hits.set(key, recent);
    if (hits.size > 10_000) hits.clear();
    return false;
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
      const forwarded = trustProxyHeaders ? String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
      const address = forwarded || req.socket?.remoteAddress || 'unknown';
      if (action === 'qr') {
        if (req.method !== 'GET') return send(res, 405, { error: 'Use GET.' });
        if (limited(address, action)) return send(res, 429, { error: 'Too many requests.' });
        const invoice = new URL(req.url || '/', 'http://localhost').searchParams.get('invoice') || '';
        if (invoice.length > 2000 || !invoiceNetwork(invoice) || !/^ln[a-z0-9]+$/i.test(invoice)) return send(res, 400, { error: 'Invalid invoice.' });
        const svg = await QRCode.toString(`lightning:${invoice.toLowerCase()}`, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 256 });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.end(svg);
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
      if (limited(address, action)) return send(res, 429, { error: 'Too many practice requests. Try again in a few minutes.' });
      let input;
      try { input = await readJson(req); } catch (error) { return send(res, error.status || 400, { error: 'Invalid JSON.' }); }
      if (action === 'invoice') return send(res, 201, await service.createInvoice(input));
      if (action === 'pay') return send(res, 200, await service.pay(input));
      if (action === 'status') return send(res, 200, await service.status(input));
      return send(res, 404, { error: 'Not found.' });
    } catch (error) {
      const known = error instanceof PracticeError || error instanceof LightningError;
      if (!known) console.error('Practice payment request failed', { name: error?.name, message: String(error?.message || '').replace(/nostr\+walletconnect:\/\/\S+/gi, '[redacted]').replace(/[0-9a-f]{80,}/gi, '[redacted]').slice(0, 200) });
      return send(res, known ? (error.status || 502) : 500, { error: known ? error.message : 'Unable to complete the request.' });
    }
  };
}
