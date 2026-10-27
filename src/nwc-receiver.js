import { NWCClient, Nip47NetworkError, Nip47TimeoutError } from '@getalby/sdk';
import { createHash } from 'node:crypto';
import { LightningError } from './lnbits.js';

// The receiving connection stays on the server. Spending permission is rejected
// except when explicitly enabled for fake-sat sandbox testing.
export async function createNwcReceiver({ connectionSecret, expectedNetwork, allowSpendingPermission = false, clientFactory = null }) {
  if (!connectionSecret) return null;
  let relays;
  try { relays = clientFactory ? [null] : NWCClient.parseWalletConnectUrl(connectionSecret).relayUrls; }
  catch { throw new LightningError('Invalid NWC receiver connection.'); }
  let client;
  let pinnedNetwork = expectedNetwork;
  let pinnedPubkey;
  let reconnecting;
  async function connect() {
    let candidate;
    let info;
    for (const relay of clientFactory ? relays : [...relays, ...relays]) {
      candidate = clientFactory ? clientFactory(connectionSecret) : new NWCClient({ nostrWalletConnectUrl: connectionSecret, relayUrls: [relay] });
      try { info = await candidate.getInfo(); break; }
      catch { candidate.close(); candidate = null; }
    }
    if (!info) throw new LightningError('The NWC receiver could not connect to a wallet relay.');
    if (!info.methods?.includes('make_invoice') || !info.methods?.includes('lookup_invoice')) {
      candidate.close();
      throw new Error('The receiver connection needs make_invoice and lookup_invoice permissions.');
    }
    if (info.methods.includes('pay_invoice') && !allowSpendingPermission) {
      candidate.close();
      throw new Error('The receiver connection can spend funds. Use a receive-only connection.');
    }
    if (!info.network || (pinnedNetwork && info.network !== pinnedNetwork) ||
        (pinnedPubkey && candidate.walletPubkey !== pinnedPubkey)) {
      candidate.close();
      throw new Error('The receiver network does not match the configured network.');
    }
    return { candidate, info };
  }
  const initial = await connect();
  client = initial.candidate;
  const info = initial.info;
  pinnedNetwork = info.network;
  pinnedPubkey = client.walletPubkey;
  const retryable = error => error instanceof Nip47NetworkError || error instanceof Nip47TimeoutError;
  async function invoke(method, input) {
    const active = client;
    try { return await active[method](input); }
    catch (error) {
      if (!retryable(error)) throw error;
      if (client === active) {
        reconnecting ||= connect().then(replacement => {
          client = replacement.candidate;
          active.close();
        }).finally(() => { reconnecting = null; });
        await reconnecting;
      } else if (reconnecting) {
        await reconnecting;
      }
      return client[method](input);
    }
  }
  return {
      network: info.network,
      methods: info.methods,
      walletPubkey: client.walletPubkey,
      provider: 'nwc',
      async createInvoice({ amount, memo }) {
        let tx;
        try { tx = await invoke('makeInvoice', { amount: amount * 1000, description: memo, expiry: 1800 }); }
        catch { throw new LightningError('The NWC receiver could not create an invoice.'); }
        if (typeof tx?.invoice !== 'string' || !tx.invoice || !/^[a-f0-9]{64}$/i.test(tx.payment_hash) || tx.amount !== amount * 1000) {
          throw new LightningError('The NWC receiver returned an incomplete or mismatched invoice.');
        }
        return { paymentRequest: tx.invoice, checkingId: tx.payment_hash,
          paymentHash: tx.payment_hash };
      },
      async checkPayment(record) {
        let tx;
        try { tx = await invoke('lookupInvoice', { payment_hash: record.paymentHash }); }
        catch { throw new LightningError('The NWC receiver could not check this invoice.'); }
        if (!tx) return { settled: false };
        if (tx.type !== 'incoming' || tx.payment_hash?.toLowerCase() !== record.paymentHash.toLowerCase() ||
            tx.invoice !== record.paymentRequest || tx.amount !== record.amountSats * 1000) {
          throw new LightningError('NWC settlement details do not match this contribution.');
        }
        if (tx.state === 'pending') return { settled: false };
        if (tx.state === 'expired') return { settled: false, failed: true };
        if (tx.state !== 'settled') throw new LightningError('The NWC receiver returned an unsupported invoice state.');
        let preimageVerified = null;
        if (tx.preimage) {
          if (!/^[a-f0-9]{64}$/i.test(tx.preimage) ||
              createHash('sha256').update(Buffer.from(tx.preimage, 'hex')).digest('hex') !== record.paymentHash.toLowerCase()) {
            throw new LightningError('The NWC receiver preimage does not match the payment hash.');
          }
          preimageVerified = true;
        }
        return { settled: true, checkingId: record.checkingId, paymentHash: record.paymentHash,
          amountSats: record.amountSats, preimageVerified,
          settledAt: Number.isSafeInteger(tx.settled_at) ? new Date(tx.settled_at * 1000).toISOString() : null };
      },
      close() { client.close(); }
    };
}
