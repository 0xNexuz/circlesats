import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createLnbits } from './lnbits.js';
import { createNwcReceiver } from './nwc-receiver.js';
import { createStore } from './store.js';
import { createAuth } from './auth.js';
import { assertLedgerEnvironment, resolveRuntimeConfig } from './runtime-config.js';
import { acquireInstanceLock } from './instance-lock.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = resolveRuntimeConfig(process.env, root);
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  throw new Error('TLS certificate validation is disabled. Remove NODE_TLS_REJECT_UNAUTHORIZED=0 before starting CircleSats.');
}
const releaseLock = config.production ? await acquireInstanceLock(config.dataFile) : null;
try {
  const store = createStore(config.dataFile);
  await store.load();
  const environment = process.env.PAYMENT_ENVIRONMENT || 'simulated';
  assertLedgerEnvironment(store.all(), environment);
  const auth = await createAuth(config.authFile, { requireExisting: config.production });
  const provider = config.provider;
  if (provider === 'nwc' && !process.env.NWC_RECEIVER_CONNECTION_SECRET) throw new Error('NWC_RECEIVER_CONNECTION_SECRET is required for the NWC receiver.');
  const lightning = provider === 'nwc'
    ? await createNwcReceiver({ connectionSecret: process.env.NWC_RECEIVER_CONNECTION_SECRET, expectedNetwork: process.env.LNBITS_NETWORK,
      allowSpendingPermission: process.env.PAYMENT_ENVIRONMENT === 'alby-sandbox' && process.env.ALLOW_SANDBOX_RECEIVER_SPEND_PERMISSION === '1' })
    : createLnbits({ baseUrl: process.env.LNBITS_URL, invoiceKey: process.env.LNBITS_INVOICE_KEY });
  if (process.env.PAYMENT_ENVIRONMENT === 'alby-sandbox' &&
      (!/^[a-f0-9]{64}$/i.test(process.env.SANDBOX_PAYER_WALLET_PUBKEY || '') ||
        process.env.SANDBOX_PAYER_WALLET_PUBKEY === lightning.walletPubkey)) {
    throw new Error('Set a distinct SANDBOX_PAYER_WALLET_PUBKEY for sandbox payments.');
  }
  const app = createApp({ store, lightning, auth, publicDir: resolve(root, 'public'),
    paymentEnvironment: process.env.PAYMENT_ENVIRONMENT || (lightning ? 'unspecified' : 'simulated'),
    sandboxPayerWalletPubkey: process.env.SANDBOX_PAYER_WALLET_PUBKEY || null, trustProxy: config.production });
  app.listen(config.port, config.host, () => {
    console.log(`CircleSats listening on ${config.host}:${config.port}`);
    console.log(lightning ? `${provider.toUpperCase()} ${process.env.PAYMENT_ENVIRONMENT} receiver configured: invoices enabled.` : 'Lightning receiver not configured: simulated demo wallet enabled.');
  });
  async function shutdown() {
    app.close(async () => {
      lightning?.close?.();
      await releaseLock?.();
      process.exit(0);
    });
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  app.once('error', async error => {
    console.error('CircleSats could not listen', { code: error.code || null });
    lightning?.close?.();
    await releaseLock?.();
    process.exitCode = 1;
  });
} catch (error) {
  await releaseLock?.();
  throw error;
}
