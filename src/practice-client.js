// Browser side of real Lightning practice payments, through this site's
// /api/practice functions. It presents the same wallet interface as the Alby
// sandbox pair. Two kinds:
// - 'mainnet': a real Bitcoin invoice from the circle treasurer's wallet that
//   the visitor pays from their own Lightning wallet. pay() never moves money;
//   it asks the treasurer wallet whether the invoice is paid.
// - 'mutinynet': a Mutinynet invoice from the treasurer's node that the
//   Mutinynet faucet's node pays over Lightning (test coins).
// "Demo sats" for these kinds are only an allowance counter, not a balance the
// visitor holds. No Node-only imports: this runs in the browser-only preview.
export const MUTINYNET_ENVIRONMENT = 'mutinynet';
export const MAINNET_ENVIRONMENT = 'mainnet';
const HEX64 = /^[a-f0-9]{64}$/i;
const KINDS = { mainnet: { environment: MAINNET_ENVIRONMENT, prefix: /^lnbc(?!rt)/i }, signet: { environment: MUTINYNET_ENVIRONMENT, prefix: /^lntbs/i } };

export class PracticeClientError extends Error {
  constructor(message, status = 502) { super(message); this.name = 'PracticeClientError'; this.status = status; }
}

async function sha256Hex(hex) {
  const bytes = new Uint8Array(hex.match(/../g).map(byte => parseInt(byte, 16)));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createPracticeOpener({ fetchImpl = globalThis.fetch, base = '/api/practice', infoTimeoutMs = 15_000, payTimeoutMs = 90_000 } = {}) {
  async function call(path, { method = 'POST', body, timeoutMs = 30_000 } = {}) {
    let response;
    try {
      response = await fetchImpl(`${base}/${path}`, { method, signal: AbortSignal.timeout(timeoutMs),
        headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    } catch { throw new PracticeClientError('The practice payment service did not respond. Try again in a moment.'); }
    let data = null;
    try { data = await response.json(); } catch { /* handled below */ }
    if (!response.ok) throw new PracticeClientError(data?.error || 'The practice payment service is unavailable.', [400, 409].includes(response.status) ? 409 : 502);
    return data;
  }

  // networks: preference order, e.g. ['mainnet', 'signet'] or ['signet'].
  return async function openPracticeWallet({ amountSats, networks = ['mainnet', 'signet'] } = {}) {
    const info = await call('info', { method: 'GET', timeoutMs: infoTimeoutMs });
    const network = networks.find(item => info?.rails?.[item]?.available);
    if (!info?.available || !network || info.amountSats !== amountSats) {
      throw new PracticeClientError('Real Lightning practice payments are not available for this circle.', 503);
    }
    const kind = KINDS[network];
    let allowance = 0;
    async function settled(record, result) {
      if (result?.status !== 'settled' || result.paymentHash !== record.paymentHash.toLowerCase() || result.network !== network) {
        throw new PracticeClientError('The payment proof did not match this invoice.');
      }
      if (result.preimage !== null && (!HEX64.test(result.preimage || '') || await sha256Hex(result.preimage) !== record.paymentHash.toLowerCase())) {
        throw new PracticeClientError('The payment proof did not match this invoice.');
      }
      if (network === 'signet' && !result.preimage) throw new PracticeClientError('The payment proof did not match this invoice.');
      allowance = Math.max(0, allowance - record.amountSats);
      return { preimage: result.preimage ? result.preimage.toLowerCase() : null, settledAt: result.settledAt };
    }
    return {
      environment: kind.environment,
      provider: kind.environment,
      network,
      async balanceSats() { return allowance; },
      async topUp(sats) { allowance += sats; return allowance; },
      async createInvoice({ amountSats: amount, memo }) {
        const invoice = await call('invoice', { body: { memo, network } });
        if (typeof invoice?.paymentRequest !== 'string' || !kind.prefix.test(invoice.paymentRequest) ||
            !HEX64.test(invoice.paymentHash || '') || invoice.amountSats !== amount || Number.isNaN(Date.parse(invoice.expiresAt))) {
          throw new PracticeClientError('The treasurer wallet returned an incomplete invoice.');
        }
        return { paymentRequest: invoice.paymentRequest, paymentHash: invoice.paymentHash.toLowerCase(),
          checkingId: invoice.paymentHash.toLowerCase(), expiresAt: invoice.expiresAt };
      },
      // Mainnet: only checks whether the visitor's own wallet has paid.
      // Mutinynet: the server asks the faucet to pay, then the browser checks
      // the preimage itself before showing a receipt.
      async pay(record) {
        const body = { paymentRequest: record.paymentRequest, paymentHash: record.paymentHash };
        if (network === 'mainnet') {
          const status = await call('status', { body });
          if (status?.status === 'expired') throw new PracticeClientError('This invoice expired before payment. Create a new contribution.', 409);
          if (status?.status !== 'settled') throw new PracticeClientError('Not paid yet. Pay the invoice from your Lightning wallet, then check again.', 409);
          return settled(record, status);
        }
        if (allowance < record.amountSats) throw new PracticeClientError('Get demo sats for this round before paying.', 409);
        let result;
        try { result = await call('pay', { body, timeoutMs: payTimeoutMs }); }
        catch (error) {
          // A slow confirmation may still have settled; ask the treasurer node once more.
          const status = await call('status', { body }).catch(() => null);
          if (status?.status !== 'settled') throw error;
          result = status;
        }
        return settled(record, result);
      },
      close() {}
    };
  };
}

// Mutinynet-only opener (kept for callers that want test coins specifically).
export function createMutinynetOpener(options = {}) {
  const open = createPracticeOpener(options);
  return settings => open({ ...settings, networks: ['signet'] });
}
