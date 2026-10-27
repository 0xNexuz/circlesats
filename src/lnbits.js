export class LightningError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'LightningError';
    this.status = status;
  }
}

export function createLnbits({ baseUrl, invoiceKey, fetchImpl = fetch }) {
  if (!baseUrl || !invoiceKey) return null;
  const url = new URL(baseUrl);
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('LNBITS_URL must use HTTPS, except for localhost development.');
  }
  const root = url.href.replace(/\/$/, '');

  async function request(path, options = {}) {
    let response;
    try {
      response = await fetchImpl(`${root}/api/v1/${path}`, {
        ...options,
        headers: {
          'X-Api-Key': invoiceKey,
          'Content-Type': 'application/json',
          ...(options.headers || {})
        },
        signal: AbortSignal.timeout(8000)
      });
    } catch {
      throw new LightningError('Lightning wallet is unreachable. Try again shortly.');
    }
    if (!response.ok) {
      throw new LightningError(`Lightning wallet returned HTTP ${response.status}.`);
    }
    try {
      return await response.json();
    } catch {
      throw new LightningError('Lightning wallet returned an invalid response.');
    }
  }

  return {
    async createInvoice({ amount, memo }) {
      const result = await request('payments', {
        method: 'POST',
        body: JSON.stringify({ out: false, amount, memo, expiry: 1800 })
      });
      if (typeof result.payment_request !== 'string' || !result.payment_request ||
          !result.checking_id || !/^[a-f0-9]{64}$/i.test(String(result.payment_hash))) {
        throw new LightningError('Lightning wallet did not return a complete invoice.');
      }
      return {
        paymentRequest: result.payment_request,
        checkingId: String(result.checking_id),
        paymentHash: String(result.payment_hash)
      };
    },
    async checkPayment(record) {
      const { checkingId, paymentHash, amountSats, paymentRequest } = record;
      const result = await request(`payments/${encodeURIComponent(checkingId)}`);
      if (typeof result.paid !== 'boolean') {
        throw new LightningError('Lightning wallet returned an invalid payment status.');
      }
      if (!result.paid) {
        const details = result.details;
        if (details?.status === 'expired' && String(details.checking_id) === checkingId &&
            String(details.payment_hash).toLowerCase() === paymentHash.toLowerCase() && details.bolt11 === paymentRequest) {
          return { settled: false, failed: true };
        }
        return { settled: false };
      }
      const details = result.details;
      // LNbits reports payment amounts in millisatoshis.
      if (!details || String(details.checking_id) !== checkingId || !Number.isSafeInteger(details.amount) ||
          details.amount !== amountSats * 1000 ||
          String(details.payment_hash).toLowerCase() !== paymentHash.toLowerCase() ||
          details.bolt11 !== paymentRequest ||
          (details.status && !['success','settled'].includes(details.status))) {
        throw new LightningError('Lightning wallet settlement details do not match this invoice.');
      }
      return { settled: true, checkingId, paymentHash, amountSats,
        settledAt: Number.isSafeInteger(details.time) ? new Date(details.time * 1000).toISOString() : null };
    }
  };
}
