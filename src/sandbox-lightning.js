// Per-visitor Lightning practice wallets from the public Alby NWC faucet.
//
// Every guest demo gets its own freshly created pair of Alby Developer Sandbox
// wallets: one receives the contribution invoice, the other pays it. Invoices
// are genuine BOLT11 requests paid over Nostr Wallet Connect, but the sats are
// sandbox test sats with no value, and nothing is routed over the public
// Lightning network. The pair belongs to one visitor, so nobody else's wallets,
// ledger or rounds are touched.
//
// This file has no Node-only imports: the server and the browser-only Vercel
// preview both use it, passing in their own NWCClient class and fetch.

export const SANDBOX_FAUCET_URL = 'https://faucet.nwc.dev';
export const SANDBOX_ENVIRONMENT = 'alby-sandbox';
export const SANDBOX_INVOICE_EXPIRY_SECONDS = 1800;

const HEX64 = /^[a-f0-9]{64}$/i;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class SandboxError extends Error {
  constructor(message) { super(message); this.name = 'SandboxError'; this.status = 502; }
}

function connectionFrom(text) {
  const match = /nostr\+walletconnect:\/\/[^\s"'<>]+/.exec(String(text || ''));
  return match ? match[0] : null;
}

function walletNameOf(secret) {
  try {
    const lud16 = new URL(secret.replace(/^nostr\+walletconnect:\/\//, 'https://nwc/')).searchParams.get('lud16') || '';
    const name = lud16.split('@')[0];
    return /^[a-z0-9_-]{1,64}$/i.test(name) ? name : null;
  } catch { return null; }
}

async function sha256Hex(hex) {
  const bytes = new Uint8Array(hex.match(/../g).map(byte => parseInt(byte, 16)));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createSandboxProvisioner({ NWCClient, fetchImpl = globalThis.fetch, faucetUrl = SANDBOX_FAUCET_URL,
  requestTimeoutMs = 20_000, openTimeoutMs = 25_000, pollIntervalMs = 500, pollAttempts = 20 } = {}) {
  if (typeof NWCClient !== 'function') throw new Error('An NWCClient class is required.');
  const faucet = faucetUrl.replace(/\/$/, '');

  async function faucetPost(path) {
    let response;
    try { response = await fetchImpl(`${faucet}${path}`, { method: 'POST', signal: AbortSignal.timeout(requestTimeoutMs) }); }
    catch { throw new SandboxError('The Lightning sandbox is unreachable right now.'); }
    const text = await response.text();
    if (!response.ok) throw new SandboxError('The Lightning sandbox did not accept the request.');
    return text;
  }

  async function connect(secret) {
    let relays;
    try { relays = NWCClient.parseWalletConnectUrl(secret).relayUrls; }
    catch { throw new SandboxError('The sandbox returned an invalid wallet connection.'); }
    for (const relay of relays) {
      const client = new NWCClient({ nostrWalletConnectUrl: secret, relayUrls: [relay] });
      try { return { client, info: await client.getInfo() }; }
      catch { client.close(); }
    }
    throw new SandboxError('No sandbox wallet relay responded.');
  }

  async function createWallet() {
    const secret = connectionFrom(await faucetPost('/'));
    const name = secret && walletNameOf(secret);
    if (!secret || !name) throw new SandboxError('The sandbox returned no usable wallet.');
    return { secret, name };
  }

  // Creates one isolated receiver/payer pair within openTimeoutMs, so a slow
  // network falls back to the simulation quickly. Secrets stay inside the
  // returned object and are never included in any of its results.
  return async function openSandboxPair() {
    let abandoned = false;
    let timer;
    const work = openPair(() => abandoned);
    try {
      return await Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new SandboxError('The Lightning sandbox took too long to respond.')), openTimeoutMs);
      })]);
    } catch (error) {
      abandoned = true;
      work.then(pair => pair.close(), () => {});
      throw error;
    } finally { clearTimeout(timer); }
  };

  async function openPair(isAbandoned) {
    const opened = [];
    try {
      const [receiverWallet, payerWallet] = await Promise.all([createWallet(), createWallet()]);
      if (receiverWallet.secret === payerWallet.secret) throw new SandboxError('The sandbox returned the same wallet twice.');
      const receiver = await connect(receiverWallet.secret); opened.push(receiver.client);
      if (isAbandoned()) throw new SandboxError('Wallet creation was abandoned.');
      const payer = await connect(payerWallet.secret); opened.push(payer.client);
      if (isAbandoned()) throw new SandboxError('Wallet creation was abandoned.');
      const has = (info, methods) => methods.every(method => info.methods?.includes(method));
      if (!has(receiver.info, ['make_invoice', 'lookup_invoice']) || !has(payer.info, ['pay_invoice', 'get_balance'])) {
        throw new SandboxError('The sandbox wallets are missing required permissions.');
      }
      if (!receiver.info.network || receiver.info.network !== payer.info.network ||
          receiver.client.walletPubkey === payer.client.walletPubkey) {
        throw new SandboxError('The sandbox wallets do not form a valid pair.');
      }
      return pairApi({ receiver: receiver.client, payer: payer.client, payerName: payerWallet.name, network: receiver.info.network });
    } catch (error) {
      for (const client of opened) client.close();
      throw error instanceof SandboxError ? error : new SandboxError('The Lightning sandbox could not create your wallets.');
    }
  }

  function pairApi({ receiver, payer, payerName, network }) {
    let closed = false;

    async function balanceSats() {
      let result;
      try { result = await payer.getBalance(); }
      catch { throw new SandboxError('Could not read your sandbox wallet balance.'); }
      if (!Number.isSafeInteger(result?.balance) || result.balance < 0) throw new SandboxError('The sandbox wallet returned an invalid balance.');
      return Math.floor(result.balance / 1000);
    }

    async function lookup(record) {
      let tx;
      try { tx = await receiver.lookupInvoice({ payment_hash: record.paymentHash }); }
      catch { return null; }
      if (!tx) return null;
      if (tx.type !== 'incoming' || String(tx.payment_hash).toLowerCase() !== record.paymentHash.toLowerCase() ||
          tx.invoice !== record.paymentRequest || tx.amount !== record.amountSats * 1000) {
        throw new SandboxError('The sandbox receipt does not match this contribution.');
      }
      return tx;
    }

    async function settledReceipt(record, preimage) {
      for (let attempt = 0; attempt < pollAttempts; attempt++) {
        const tx = await lookup(record);
        if (tx?.state === 'settled') {
          if (tx.preimage && tx.preimage.toLowerCase() !== preimage.toLowerCase()) {
            throw new SandboxError('The sandbox receiver reported a different payment proof.');
          }
          return { settledAt: Number.isSafeInteger(tx.settled_at) ? new Date(tx.settled_at * 1000).toISOString() : new Date().toISOString() };
        }
        if (tx && tx.state !== 'pending') throw new SandboxError('The sandbox invoice is no longer payable.');
        await sleep(pollIntervalMs);
      }
      throw new SandboxError('The payment was sent but the receiving wallet has not confirmed it yet. Try again in a moment.');
    }

    return {
      environment: SANDBOX_ENVIRONMENT,
      network,
      provider: SANDBOX_ENVIRONMENT,
      balanceSats,
      async topUp(amountSats) {
        if (!Number.isSafeInteger(amountSats) || amountSats < 1 || amountSats > 10_000) throw new SandboxError('Invalid sandbox top-up amount.');
        const before = await balanceSats();
        await faucetPost(`/wallets/${encodeURIComponent(payerName)}/topup?amount=${amountSats}`);
        for (let attempt = 0; attempt < pollAttempts; attempt++) {
          const now = await balanceSats();
          if (now >= before + amountSats) return now;
          await sleep(pollIntervalMs);
        }
        throw new SandboxError('The sandbox top-up has not arrived yet. Try again in a moment.');
      },
      async createInvoice({ amountSats, memo }) {
        let tx;
        try {
          tx = await receiver.makeInvoice({ amount: amountSats * 1000, description: memo, expiry: SANDBOX_INVOICE_EXPIRY_SECONDS });
        } catch { throw new SandboxError('The sandbox receiver could not create an invoice.'); }
        if (typeof tx?.invoice !== 'string' || !/^ln[a-z0-9]+$/i.test(tx.invoice) || !HEX64.test(tx.payment_hash || '') ||
            tx.amount !== amountSats * 1000) {
          throw new SandboxError('The sandbox receiver returned an incomplete invoice.');
        }
        const expiresAt = Number.isSafeInteger(tx.expires_at) ? tx.expires_at * 1000 : Date.now() + SANDBOX_INVOICE_EXPIRY_SECONDS * 1000;
        return { paymentRequest: tx.invoice, paymentHash: tx.payment_hash.toLowerCase(), checkingId: tx.payment_hash.toLowerCase(),
          expiresAt: new Date(expiresAt).toISOString() };
      },
      // Pays a stored contribution invoice from this visitor's payer wallet, then
      // independently confirms it on the receiving wallet. Safe to retry: an
      // invoice the receiver already reports as settled is never paid twice.
      async pay(record) {
        if (!HEX64.test(record.paymentHash || '') || typeof record.paymentRequest !== 'string') throw new SandboxError('This contribution has no sandbox invoice.');
        const existing = await lookup(record);
        if (existing?.state === 'settled' && HEX64.test(existing.preimage || '') &&
            await sha256Hex(existing.preimage) === record.paymentHash.toLowerCase()) {
          return { preimage: existing.preimage.toLowerCase(), ...(await settledReceipt(record, existing.preimage)) };
        }
        let payment;
        try { payment = await payer.payInvoice({ invoice: record.paymentRequest }); }
        catch { throw new SandboxError('Your sandbox wallet could not pay this invoice. Check its balance and try again.'); }
        const preimage = String(payment?.preimage || '');
        if (!HEX64.test(preimage) || await sha256Hex(preimage) !== record.paymentHash.toLowerCase()) {
          throw new SandboxError('The sandbox payment returned no valid proof of payment.');
        }
        return { preimage: preimage.toLowerCase(), ...(await settledReceipt(record, preimage)) };
      },
      close() {
        if (closed) return; closed = true;
        receiver.close(); payer.close();
      }
    };
  }
}
