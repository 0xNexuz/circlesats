import { isAbsolute, join, relative, resolve } from 'node:path';

export function assertLedgerEnvironment(records, environment) {
  if (records.some(record =>
    environment === 'simulated'
      ? record.provider !== 'demo'
      : record.provider === 'demo' || record.environment !== environment)) {
    throw new Error('Ledger contains contributions from another or unknown environment. Use a separate DATA_DIR or DATA_FILE.');
  }
}

export function resolveRuntimeConfig(env, root) {
  const production = env.NODE_ENV === 'production';
  const port = Number(env.PORT || 3100);
  const host = env.HOST || '127.0.0.1';
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535.');
  if (!['127.0.0.1', '0.0.0.0', '::1'].includes(host)) throw new Error('HOST must be an explicit loopback or all-interface address.');
  if (production && (!env.DATA_DIR || !isAbsolute(env.DATA_DIR) || env.DATA_FILE || env.AUTH_FILE)) {
    throw new Error('Production requires an absolute DATA_DIR on a persistent volume; do not set DATA_FILE or AUTH_FILE.');
  }
  if (production && env.PUBLIC_HTTPS !== '1') throw new Error('Production requires HTTPS termination and PUBLIC_HTTPS=1.');
  if (production && !['127.0.0.1', '::1'].includes(host)) throw new Error('Production must bind to loopback behind its HTTPS reverse proxy.');
  if (production && env.TRUST_PROXY !== '1') throw new Error('Production requires TRUST_PROXY=1 and a proxy that overwrites X-Real-IP.');
  const dataDir = env.DATA_DIR ? resolve(env.DATA_DIR) : join(root, 'data');
  const projectRelative = relative(root, dataDir);
  if (production && projectRelative !== '..' && !projectRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      !isAbsolute(projectRelative)) throw new Error('Production DATA_DIR must be outside the source repository.');
  const dataFile = env.DATA_FILE ? resolve(env.DATA_FILE) : join(dataDir, 'circlesats.json');
  const authFile = env.AUTH_FILE ? resolve(env.AUTH_FILE) : join(dataDir, 'member-auth.json');
  const provider = env.LIGHTNING_PROVIDER || 'lnbits';
  if (!['lnbits', 'nwc'].includes(provider)) throw new Error('LIGHTNING_PROVIDER must be lnbits or nwc.');
  const receiverConfigured = provider === 'nwc' || Boolean(env.LNBITS_URL && env.LNBITS_INVOICE_KEY);
  if (receiverConfigured && !env.LNBITS_NETWORK) throw new Error('LNBITS_NETWORK is required for a Lightning receiver.');
  if (receiverConfigured && !env.PAYMENT_ENVIRONMENT) throw new Error('PAYMENT_ENVIRONMENT is required for a Lightning receiver.');
  if (env.PAYMENT_ENVIRONMENT === 'mainnet') throw new Error('Real mainnet payments are outside this MVP.');
  if (env.PAYMENT_ENVIRONMENT === 'alby-sandbox') {
    if (provider !== 'nwc' || env.LNBITS_NETWORK !== 'mainnet') throw new Error('Alby sandbox requires NWC and its reported mainnet network.');
  } else if (receiverConfigured && env.PAYMENT_ENVIRONMENT !== env.LNBITS_NETWORK) {
    throw new Error('PAYMENT_ENVIRONMENT must match LNBITS_NETWORK outside the Alby sandbox.');
  }
  return { production, port, host, dataDir, dataFile, authFile, provider, receiverConfigured };
}
