// An in-memory stand-in for the Alby NWC faucet and its sandbox wallets, used
// only by tests. It mimics the faucet's HTTP API and the NWC client methods
// CircleSats calls, settling payments between wallets it created.
import { createHash, randomBytes } from 'node:crypto';

export function fakeSandbox({ offline = false, network = 'mainnet', tamper = null, slowInfoMs = 0 } = {}) {
  const wallets = new Map();
  const invoices = new Map();
  const clients = [];
  let count = 0;
  const byName = name => [...wallets.values()].find(wallet => wallet.name === name);

  async function fetchImpl(url, options = {}) {
    if (offline) throw new TypeError('fetch failed');
    const target = new URL(url);
    if (options.method !== 'POST') return new Response('method', { status: 405 });
    if (target.pathname === '/') {
      count++;
      const pubkey = createHash('sha256').update(`wallet-${count}`).digest('hex');
      const name = `nwc${1000 + count}`;
      wallets.set(pubkey, { pubkey, name, balanceMsat: 0 });
      return new Response(`nostr+walletconnect://${pubkey}?relay=wss://relay.test/v1&secret=${randomBytes(32).toString('hex')}&lud16=${name}@getalby.com`);
    }
    const topup = /^\/wallets\/([^/]+)\/topup$/.exec(target.pathname);
    if (topup) {
      const wallet = byName(decodeURIComponent(topup[1]));
      const amount = Number(target.searchParams.get('amount'));
      if (!wallet || !Number.isSafeInteger(amount) || amount < 1) return Response.json({ error: 'bad' }, { status: 500 });
      wallet.balanceMsat += amount * 1000;
      return Response.json({ message: 'Payment successful', amount });
    }
    return new Response('not found', { status: 404 });
  }

  class FakeNWCClient {
    static parseWalletConnectUrl(secret) {
      const parsed = new URL(secret.replace(/^nostr\+walletconnect:\/\//, 'https://'));
      return { walletPubkey: parsed.hostname, relayUrls: parsed.searchParams.getAll('relay') };
    }
    constructor({ nostrWalletConnectUrl }) {
      this.walletPubkey = FakeNWCClient.parseWalletConnectUrl(nostrWalletConnectUrl).walletPubkey;
      this.closed = false;
      clients.push(this);
    }
    get wallet() {
      if (this.closed) throw new Error('closed');
      const wallet = wallets.get(this.walletPubkey);
      if (!wallet) throw new Error('unknown wallet');
      return wallet;
    }
    async getInfo() { if (slowInfoMs) await new Promise(done => setTimeout(done, slowInfoMs)); this.wallet; return { network, methods: ['get_info', 'get_balance', 'pay_invoice', 'make_invoice', 'lookup_invoice'] }; }
    async getBalance() { return { balance: this.wallet.balanceMsat }; }
    async makeInvoice({ amount, expiry }) {
      const preimage = randomBytes(32).toString('hex');
      const hash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
      const invoice = `lnbc${amount / 1000}n1${hash.slice(0, 40)}`;
      const record = { receiver: this.wallet.pubkey, invoice, hash, preimage, amount, state: 'pending',
        expires_at: Math.floor(Date.now() / 1000) + expiry, settled_at: null };
      invoices.set(hash, record);
      return { type: 'incoming', state: 'pending', invoice, payment_hash: hash, amount, expires_at: record.expires_at };
    }
    async payInvoice({ invoice }) {
      const record = [...invoices.values()].find(item => item.invoice === invoice);
      if (!record || record.state !== 'pending') throw new Error('invoice not payable');
      const payer = this.wallet;
      if (payer.balanceMsat < record.amount) throw new Error('insufficient balance');
      payer.balanceMsat -= record.amount;
      wallets.get(record.receiver).balanceMsat += record.amount;
      record.state = 'settled'; record.settled_at = Math.floor(Date.now() / 1000);
      return { preimage: tamper === 'preimage' ? randomBytes(32).toString('hex') : record.preimage, fees_paid: 0 };
    }
    async lookupInvoice({ payment_hash }) {
      const record = invoices.get(payment_hash);
      if (!record || record.receiver !== this.wallet.pubkey) throw new Error('not found');
      return { type: 'incoming', state: record.state, invoice: record.invoice, payment_hash: record.hash,
        amount: tamper === 'amount' ? record.amount + 1000 : record.amount,
        preimage: record.state === 'settled' ? record.preimage : '', settled_at: record.settled_at, expires_at: record.expires_at };
    }
    close() { this.closed = true; }
  }

  return { fetchImpl, NWCClient: FakeNWCClient, wallets, invoices, clients };
}
