import { NWCClient } from '@getalby/sdk';
import { createNwcReceiver } from '../src/nwc-receiver.js';

if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  throw new Error('TLS certificate validation must remain enabled.');
}

const result = {
  network: 'Mutinynet (Signet)', receiver: 'blocked', payer: 'external/manual payer unverified',
  incomingLiquidity: 'unverified', outgoingLiquidity: 'unverified',
  payerBalanceSats: null, provider: 'blocked', readyForInvoice: false, readyForPayment: false
};
let receiver;
let payer;

function requireSecureRelays(connectionSecret) {
  const parsed = NWCClient.parseWalletConnectUrl(connectionSecret);
  if (!parsed.relayUrls.length || parsed.relayUrls.some(url => new URL(url).protocol !== 'wss:')) {
    throw new Error('NWC connections must use WSS relays.');
  }
  return parsed.relayUrls;
}

try {
  const receiverSecret = process.env.NWC_RECEIVER_CONNECTION_SECRET;
  const payerSecret = process.env.NWC_PAYER_CONNECTION_SECRET;
  if (!receiverSecret) throw new Error('A private receiver NWC connection is required.');
  requireSecureRelays(receiverSecret);

  receiver = await createNwcReceiver({ connectionSecret: receiverSecret, expectedNetwork: 'signet' });
  result.receiver = 'connected';
  result.provider = 'configured';
  result.readyForInvoice = true;
  if (payerSecret) for (const relay of requireSecureRelays(payerSecret)) {
    const candidate = new NWCClient({ nostrWalletConnectUrl: payerSecret, relayUrls: [relay] });
    try {
      const info = await candidate.getInfo();
      if (info.network !== 'signet' || !info.methods?.includes('pay_invoice') ||
          candidate.walletPubkey === receiver.walletPubkey) {
        throw new Error('The payer must be a distinct Signet wallet with pay_invoice permission.');
      }
      payer = candidate;
      result.payer = 'connected';
      if (info.methods.includes('get_balance')) {
        const balance = await payer.getBalance();
        if (Number.isSafeInteger(balance?.balance) && balance.balance >= 0) {
          result.payerBalanceSats = balance.balance / 1000;
        }
      }
      break;
    } catch {
      candidate.close();
    }
  }
  if (payerSecret && !payer) throw new Error('The payer connection is unavailable or does not meet the Signet requirements.');
} catch (error) {
  result.error = error.message === 'A private receiver NWC connection is required.' ? error.message : 'Wallet connection or network verification failed.';
  process.exitCode = 1;
} finally {
  payer?.close();
  receiver?.close();
  console.log(JSON.stringify(result));
}
