import { NWCClient } from '@getalby/sdk';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const wallets = JSON.parse(await readFile(resolve(root, 'data/alby-sandbox-wallets.json'), 'utf8'));
const receiver = NWCClient.parseWalletConnectUrl(wallets.receiver);
const payer = NWCClient.parseWalletConnectUrl(wallets.payer);
if (!receiver.walletPubkey || !payer.walletPubkey || receiver.walletPubkey === payer.walletPubkey) {
  throw new Error('Two distinct sandbox wallets are required.');
}
const configuration = [
  'PORT=3101',
  'LIGHTNING_PROVIDER=nwc',
  'PAYMENT_ENVIRONMENT=alby-sandbox',
  'LNBITS_NETWORK=mainnet',
  'ALLOW_SANDBOX_RECEIVER_SPEND_PERMISSION=1',
  `NWC_RECEIVER_CONNECTION_SECRET=${wallets.receiver}`,
  `SANDBOX_PAYER_WALLET_PUBKEY=${payer.walletPubkey}`,
  'DATA_FILE=./data/sandbox-ui-ledger.json',
  'AUTH_FILE=./data/sandbox-ui-auth.json'
].join('\n') + '\n';
await writeFile(resolve(root, '.env.sandbox'), configuration, { mode: 0o600 });
console.log('Created ignored .env.sandbox for local fake-sat testing. Run npm run start:sandbox.');
