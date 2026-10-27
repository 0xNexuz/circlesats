import { NWCClient } from '@getalby/sdk';

export async function connectNwc(uri) {
  const relays = NWCClient.parseWalletConnectUrl(uri).relayUrls;
  for (const relay of relays) {
    const client = new NWCClient({ nostrWalletConnectUrl: uri, relayUrls: [relay] });
    try {
      const info = await client.getInfo();
      if (!info.methods?.includes('pay_invoice')) throw new Error('This wallet connection cannot pay invoices.');
      return { client, network: info.network, walletPubkey: client.walletPubkey,
        alias: info.alias || 'Connected wallet' };
    } catch (error) {
      client.close();
      if (error.message === 'This wallet connection cannot pay invoices.') throw error;
    }
  }
  throw new Error('Could not connect to this wallet relay. Check the connection and try again.');
}
