// Browser side of real Mutinynet practice payments. Presents the same wallet
// interface as the Alby sandbox pair, but every invoice comes from the circle's
// treasurer node and is paid by the Mutinynet faucet's node over the Mutinynet
// Lightning network, through the site's /api/practice functions. The visitor's
// "demo sats" here are only an allowance of faucet payments, not a balance
// they hold. No Node-only imports: this runs in the browser-only preview.
export const MUTINYNET_ENVIRONMENT = 'mutinynet';
const HEX64 = /^[a-f0-9]{64}$/i;

export class PracticeClientError extends Error {
  constructor(message, status = 502) { super(message); this.name = 'PracticeClientError'; this.status = status; }
}

async function sha256Hex(hex) {
  const bytes = new Uint8Array(hex.match(/../g).map(byte => parseInt(byte, 16)));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createMutinynetOpener({ fetchImpl = globalThis.fetch, base = '/api/practice', infoTimeoutMs = 15_000, payTimeoutMs = 90_000 } = {}) {
  async function call(path, { method = 'POST', body, timeoutMs = 30_000 } = {}) {
    let response;
    try {
      response = await fetchImpl(`${base}/${path}`, { method, signal: AbortSignal.timeout(timeoutMs),
        headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    } catch { throw new PracticeClientError('The Mutinynet practice service did not respond. Try again in a moment.'); }
    let data = null;
    try { data = await response.json(); } catch { /* handled below */ }
    if (!response.ok) throw new PracticeClientError(data?.error || 'The Mutinynet practice service is unavailable.', response.status === 409 ? 409 : 502);
    return data;
  }

  return async function openMutinynetWallet({ amountSats } = {}) {
    const info = await call('info', { method: 'GET', timeoutMs: infoTimeoutMs });
    if (!info?.available || info.network !== 'signet' || info.amountSats !== amountSats) {
      throw new PracticeClientError('Real Mutinynet practice payments are not available for this circle.', 503);
    }
    let allowance = 0;
    return {
      environment: MUTINYNET_ENVIRONMENT,
      provider: MUTINYNET_ENVIRONMENT,
      network: 'signet',
      async balanceSats() { return allowance; },
      async topUp(sats) { allowance += sats; return allowance; },
      async createInvoice({ amountSats: amount, memo }) {
        const invoice = await call('invoice', { body: { memo } });
        if (typeof invoice?.paymentRequest !== 'string' || !/^lntbs/i.test(invoice.paymentRequest) ||
            !HEX64.test(invoice.paymentHash || '') || invoice.amountSats !== amount || Number.isNaN(Date.parse(invoice.expiresAt))) {
          throw new PracticeClientError('The treasurer node returned an incomplete invoice.');
        }
        return { paymentRequest: invoice.paymentRequest, paymentHash: invoice.paymentHash.toLowerCase(),
          checkingId: invoice.paymentHash.toLowerCase(), expiresAt: invoice.expiresAt };
      },
      // The server pays only after checking the invoice is the treasurer's own;
      // the browser then checks the preimage itself before showing a receipt.
      async pay(record) {
        if (allowance < record.amountSats) throw new PracticeClientError('Get demo sats for this round before paying.', 409);
        const body = { paymentRequest: record.paymentRequest, paymentHash: record.paymentHash };
        let result;
        try { result = await call('pay', { body, timeoutMs: payTimeoutMs }); }
        catch (error) {
          // A slow confirmation may still have settled; ask the treasurer node once more.
          const status = await call('status', { body }).catch(() => null);
          if (status?.status !== 'settled') throw error;
          result = status;
        }
        if (result?.status !== 'settled' || result.paymentHash !== record.paymentHash.toLowerCase() ||
            !HEX64.test(result.preimage || '') || await sha256Hex(result.preimage) !== record.paymentHash.toLowerCase()) {
          throw new PracticeClientError('The payment proof did not match this invoice.');
        }
        allowance = Math.max(0, allowance - record.amountSats);
        return { preimage: result.preimage.toLowerCase(), settledAt: result.settledAt };
      },
      close() {}
    };
  };
}
