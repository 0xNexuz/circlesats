// Receive-only Blink (https://blink.sv) wallet adapter for real Bitcoin
// Lightning payments. It exposes the same createInvoice/checkPayment shape as
// the NWC receiver. The API key must carry the Read and Receive scopes and must
// NOT carry Write, so CircleSats can create invoices and check them but can
// never spend from the treasurer's wallet. Schema checked against
// blinkbitcoin/blink core/api/src/graphql/public/schema.graphql.
import { createHash } from 'node:crypto';
import { LightningError } from './lnbits.js';

export const BLINK_MAINNET_URL = 'https://api.blink.sv/graphql';
const HEX64 = /^[a-f0-9]{64}$/i;

export async function createBlinkReceiver({ apiKey, endpoint = BLINK_MAINNET_URL, fetchImpl = globalThis.fetch,
  expectedNetwork = 'mainnet', timeoutMs = 10_000 }) {
  if (!apiKey) return null;
  async function gql(query, variables = {}) {
    let response;
    try {
      response = await fetchImpl(endpoint, { method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey }, body: JSON.stringify({ query, variables }) });
    } catch { throw new LightningError('The Blink wallet is unreachable. Try again shortly.'); }
    let body;
    try { body = await response.json(); } catch { throw new LightningError('The Blink wallet returned an invalid response.'); }
    if (!response.ok || body?.errors?.length) {
      const message = String(body?.errors?.[0]?.message || `HTTP ${response.status}`);
      throw new LightningError(/not ?found/i.test(message) ? 'The Blink wallet has no such invoice.' : 'The Blink wallet rejected the request.');
    }
    return body.data;
  }

  const setup = await gql(`query CircleSatsReceiverSetup {
    authorization { scopes }
    globals { network }
    me { defaultAccount { wallets { id walletCurrency } } }
  }`);
  const scopes = setup?.authorization?.scopes || [];
  if (scopes.includes('WRITE')) throw new Error('The Blink API key can spend funds. Create a key with only Read and Receive.');
  if (!scopes.includes('READ') || !scopes.includes('RECEIVE')) throw new Error('The Blink API key needs the Read and Receive scopes.');
  if (setup?.globals?.network !== expectedNetwork) throw new Error('The Blink wallet network does not match the configured network.');
  const walletId = setup?.me?.defaultAccount?.wallets?.find(wallet => wallet.walletCurrency === 'BTC')?.id;
  if (!walletId) throw new Error('The Blink account has no BTC wallet.');

  return {
    provider: 'blink',
    network: expectedNetwork,
    async createInvoice({ amount, memo, expiryMinutes = 30 }) {
      const data = await gql(`mutation CircleSatsInvoice($input: LnInvoiceCreateInput!) {
        lnInvoiceCreate(input: $input) { errors { message } invoice { paymentRequest paymentHash satoshis } }
      }`, { input: { walletId, amount, memo: String(memo || '').slice(0, 120), expiresIn: expiryMinutes } });
      const invoice = data?.lnInvoiceCreate?.invoice;
      if (data?.lnInvoiceCreate?.errors?.length || typeof invoice?.paymentRequest !== 'string' ||
          !HEX64.test(invoice.paymentHash || '') || invoice.satoshis !== amount) {
        throw new LightningError('The Blink wallet returned an incomplete invoice.');
      }
      return { paymentRequest: invoice.paymentRequest, paymentHash: invoice.paymentHash.toLowerCase(), checkingId: invoice.paymentHash.toLowerCase() };
    },
    // The invoice must belong to this account's BTC wallet and match exactly.
    async checkPayment(record) {
      const hash = String(record.paymentHash).toLowerCase();
      const data = await gql(`query CircleSatsInvoiceStatus($walletId: WalletId!, $paymentHash: PaymentHash!) {
        me { defaultAccount { walletById(walletId: $walletId) {
          invoiceByPaymentHash(paymentHash: $paymentHash) { paymentHash paymentRequest paymentStatus ... on LnInvoice { satoshis } }
        } } }
      }`, { walletId, paymentHash: hash });
      const invoice = data?.me?.defaultAccount?.walletById?.invoiceByPaymentHash;
      if (!invoice) throw new LightningError('The Blink wallet has no such invoice.');
      if (String(invoice.paymentHash).toLowerCase() !== hash || invoice.paymentRequest !== record.paymentRequest ||
          invoice.satoshis !== record.amountSats) {
        throw new LightningError('Blink settlement details do not match this contribution.');
      }
      if (invoice.paymentStatus === 'PENDING') return { settled: false };
      if (invoice.paymentStatus === 'EXPIRED') return { settled: false, failed: true };
      if (invoice.paymentStatus !== 'PAID') throw new LightningError('The Blink wallet returned an unsupported invoice state.');
      const proof = await gql(`query CircleSatsPreimage($input: LnInvoicePaymentStatusByHashInput!) {
        lnInvoicePaymentStatusByHash(input: $input) { status paymentPreimage }
      }`, { input: { paymentHash: hash } });
      const preimage = String(proof?.lnInvoicePaymentStatusByHash?.paymentPreimage || '').toLowerCase();
      let preimageVerified = null;
      if (preimage) {
        if (!HEX64.test(preimage) || createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex') !== hash) {
          throw new LightningError('The Blink payment proof does not match the payment hash.');
        }
        preimageVerified = true;
      }
      return { settled: true, checkingId: hash, paymentHash: hash, amountSats: record.amountSats, preimageVerified,
        preimage: preimageVerified ? preimage : null, settledAt: null };
    },
    close() {}
  };
}
