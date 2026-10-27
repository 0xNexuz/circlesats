// Test-only stand-in for Blink's GraphQL API (the operations CircleSats uses).
// payExternally() plays the visitor's own wallet paying an invoice.
import { createHash, randomBytes } from 'node:crypto';
import { makeSignetInvoice } from './bolt11-fixture.js';

export function fakeBlink({ scopes = ['READ', 'RECEIVE'], network = 'mainnet', hidePreimage = false } = {}) {
  const walletId = 'btc-wallet-1';
  const invoices = new Map();
  const calls = [];
  const reply = (data, status = 200) => Response.json(data, { status });
  async function fetchImpl(url, options) {
    const { query, variables } = JSON.parse(options.body);
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1];
    calls.push({ op, apiKey: options.headers['X-API-KEY'] });
    if (options.headers['X-API-KEY'] !== 'test-receive-key') return reply({ errors: [{ message: 'Unauthorized' }] }, 401);
    if (op === 'CircleSatsReceiverSetup') {
      return reply({ data: { authorization: { scopes }, globals: { network },
        me: { defaultAccount: { wallets: [{ id: 'usd-wallet', walletCurrency: 'USD' }, { id: walletId, walletCurrency: 'BTC' }] } } } });
    }
    if (op === 'CircleSatsInvoice') {
      const { input } = variables;
      if (input.walletId !== walletId) return reply({ data: { lnInvoiceCreate: { errors: [{ message: 'bad wallet' }], invoice: null } } });
      const preimage = randomBytes(32).toString('hex');
      const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
      const paymentRequest = makeSignetInvoice({ paymentHash, amountSats: input.amount, expiry: input.expiresIn * 60, network: 'mainnet' });
      invoices.set(paymentHash, { paymentRequest, paymentHash, preimage, satoshis: input.amount, status: 'PENDING' });
      return reply({ data: { lnInvoiceCreate: { errors: [], invoice: { paymentRequest, paymentHash, satoshis: input.amount } } } });
    }
    if (op === 'CircleSatsInvoiceStatus') {
      const invoice = invoices.get(variables.paymentHash);
      if (variables.walletId !== walletId || !invoice) return reply({ errors: [{ message: 'Invoice not found' }], data: null });
      return reply({ data: { me: { defaultAccount: { walletById: { invoiceByPaymentHash: {
        paymentHash: invoice.paymentHash, paymentRequest: invoice.paymentRequest, paymentStatus: invoice.status, satoshis: invoice.satoshis } } } } } });
    }
    if (op === 'CircleSatsPreimage') {
      const invoice = invoices.get(variables.input.paymentHash);
      return reply({ data: { lnInvoicePaymentStatusByHash: { status: invoice?.status || 'PENDING',
        paymentPreimage: invoice?.status === 'PAID' && !hidePreimage ? invoice.preimage : null } } });
    }
    return reply({ errors: [{ message: 'unknown operation' }] }, 400);
  }
  return {
    fetchImpl, invoices, calls,
    payExternally(paymentRequest) {
      const invoice = [...invoices.values()].find(item => item.paymentRequest === paymentRequest);
      if (!invoice || invoice.status !== 'PENDING') return false;
      invoice.status = 'PAID';
      return true;
    }
  };
}
