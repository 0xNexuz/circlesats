import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { LightningError } from './lnbits.js';
import { validateSignetInvoice } from './invoice-validation.js';

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' wss:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
};

function send(res, status, value, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...securityHeaders,
    ...(process.env.PUBLIC_HTTPS === '1' ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    ...headers
  });
  res.end(JSON.stringify(value));
}

async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 2048) throw Object.assign(new Error('Request is too large.'), { status: 413 });
  }
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

function publicRecord(record, viewerId = null) {
  return {
    id: record.id,
    groupId: record.groupId,
    cycleId: record.cycleId,
    roundId: record.roundId,
    memberId: record.memberId,
    amountSats: record.amountSats,
    provider: record.provider,
    environment: record.environment || (record.provider === 'demo' ? 'simulated' : 'unverified'),
    status: record.status,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    paidAt: record.paidAt ?? null,
    paymentHash: record.status === 'paid' && viewerId ? record.paymentHash : null,
    paymentRequest: record.status === 'pending' && viewerId === record.memberId ? record.paymentRequest : null,
    attribution: record.attribution || 'unverified'
  };
}

export function createApp({ store, lightning, auth, publicDir, paymentEnvironment = lightning ? 'unspecified' : 'simulated', sandboxPayerWalletPubkey = null, trustProxy = false }) {
  const creating = new Map();
  const mode = lightning ? 'lightning' : 'demo';
  const cookie = req => /(?:^|; )circlesats_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  const session = req => auth?.get(cookie(req));
  const activeStore = req => session(req)?.demoStore || store;
  const activeMode = req => session(req)?.kind === 'guest-demo' ? 'demo' : mode;
  const secure = req => req.socket.encrypted || process.env.PUBLIC_HTTPS === '1';
  const clientAddress = req => {
    if (!trustProxy) return req.socket.remoteAddress;
    const direct = req.socket.remoteAddress;
    const forwarded = req.headers['x-real-ip'];
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(direct) || typeof forwarded !== 'string' || !isIP(forwarded)) return null;
    return forwarded;
  };
  const sessionCookie = (token, req) => `circlesats_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure(req) ? '; Secure' : ''}`;
  const requireMember = (req, res) => {
    const current = session(req);
    if (!current) { send(res, 401, { error: 'Sign in with your member access code.' }); return null; }
    if (req.headers['x-csrf-token'] !== current.csrf) { send(res, 403, { error: 'Refresh and try again.' }); return null; }
    return current.memberId;
  };
  const memberSession = (req, res) => {
    const memberId = requireMember(req, res);
    return memberId ? session(req) : null;
  };

  async function reconcile() {
    if (!lightning) return;
    const pending = store.all().filter(item => ['pending', 'expired'].includes(item.status) &&
      item.provider === (lightning.provider || 'lnbits') &&
      (paymentEnvironment === 'unspecified' || item.environment === paymentEnvironment));
    await Promise.all(pending.map(async record => {
      try {
        const result = await lightning.checkPayment(record);
        if (result.settled) {
          await store.update(record.id, { status: 'paid', paidAt: result.settledAt || new Date().toISOString() });
        } else if (result.failed) {
          await store.update(record.id, { status: 'failed' });
        } else if (record.status === 'pending' && Date.now() >= Date.parse(record.expiresAt)) {
          await store.update(record.id, { status: 'expired' });
        }
      } catch { /* Keep the last verified status when LNbits is unavailable. */ }
    }));
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const address = clientAddress(req);
        if (!address) return send(res, 503, { error: 'The HTTPS proxy is not configured for member access.' });
        const input = await body(req);
        const result = auth.login(input.memberId, input.code, address);
        if (!result) return send(res, 401, { error: 'Invalid access code or too many attempts. Try again later.' });
        return send(res, 200, { memberId: result.session.memberId, csrf: result.session.csrf }, { 'Set-Cookie': sessionCookie(result.token, req) });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/demo') {
        const address = clientAddress(req);
        if (!address) return send(res, 503, { error: 'The HTTPS proxy is not configured for guest access.' });
        if (session(req)) return send(res, 409, { error: 'Sign out before starting a new demo.' });
        const result = auth.startDemo(address);
        if (!result) return send(res, 429, { error: 'The guest demo is busy. Please try again later.' });
        return send(res, 200, { memberId: result.session.memberId, kind: result.session.kind, csrf: result.session.csrf },
          { 'Set-Cookie': sessionCookie(result.token, req) });
      }
      if (req.method === 'GET' && url.pathname === '/api/me') {
        const current = session(req);
        return send(res, 200, { memberId: current?.memberId || null, kind: current?.kind || null, csrf: current?.csrf || null,
          wallet: current ? activeStore(req).walletFor(current.memberId) : null });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        if (!requireMember(req, res)) return;
        auth.logout(cookie(req));
        return send(res, 200, { ok: true }, { 'Set-Cookie': 'circlesats_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }
      if (req.method === 'GET' && url.pathname === '/api/group') {
        await reconcile();
        const ledger = activeStore(req);
        return send(res, 200, {
          group: ledger.group(), cycle: ledger.cycle(), cycles: ledger.cycles(), round: ledger.round(),
          walletConnected: activeMode(req) === 'lightning',
          mode: activeMode(req),
          network: activeMode(req) === 'lightning' ? (lightning.network || process.env.LNBITS_NETWORK || 'unknown') : 'simulated',
          environment: activeMode(req) === 'lightning' ? paymentEnvironment : 'simulated',
          sandboxPayerWalletPubkey: activeMode(req) === 'lightning' && paymentEnvironment === 'alby-sandbox' ? sandboxPayerWalletPubkey : null,
          records: ledger.all().map(item => publicRecord(item, session(req)?.memberId))
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/invoice-qr') {
        const current = session(req);
        if (!current) return send(res, 401, { error: 'Sign in to view this invoice.' });
        const record = activeStore(req).all().find(item => item.id === url.searchParams.get('id'));
        if (!record || record.memberId !== current.memberId || record.status !== 'pending' || record.provider === 'demo')
          return send(res, 404, { error: 'Invoice unavailable.' });
        const svg = await QRCode.toString(`lightning:${record.paymentRequest}`, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 256 });
        res.writeHead(200, { ...securityHeaders, ...(process.env.PUBLIC_HTTPS === '1' ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
          'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
        return res.end(svg);
      }
      if (req.method === 'POST' && url.pathname === '/api/demo/group') {
        const current = memberSession(req, res); if (!current) return;
        if (current.kind !== 'guest-demo') return send(res, 403, { error: 'Custom groups are available in the private demo.' });
        const group = await current.demoStore.createDemoGroup(current.memberId, await body(req));
        current.memberId = group.members[0].id;
        return send(res, 201, { group });
      }
      if (req.method === 'POST' && url.pathname === '/api/demo/contribute') {
        const current = memberSession(req, res); if (!current) return;
        if (current.kind !== 'guest-demo') return send(res, 403, { error: 'This action is only for the private demo.' });
        const input = await body(req);
        const record = await current.demoStore.simulateContribution(input.memberId, current.memberId);
        return send(res, 201, { record: publicRecord(record, current.memberId) });
      }
      if (req.method === 'POST' && url.pathname === '/api/round/approve') {
        const current = memberSession(req, res); if (!current) return;
        const input = await body(req);
        const ledger = activeStore(req);
        const approverId = current.kind === 'guest-demo' ? input.memberId : current.memberId;
        const round = await ledger.approvePayout(current.memberId, approverId);
        return send(res, 200, { round });
      }
      if (req.method === 'POST' && url.pathname === '/api/round/settlement-claim') {
        const current = memberSession(req, res); if (!current) return;
        const ledger = activeStore(req);
        if (current.kind !== 'guest-demo' && current.memberId !== ledger.group().organizerId) return send(res, 403, { error: 'Only the organizer can record a payout claim.' });
        const round = await ledger.recordSettlementClaim(current.memberId, await body(req));
        return send(res, 200, { round });
      }
      if (req.method === 'POST' && url.pathname === '/api/round/settle-demo') {
        const current = memberSession(req, res); if (!current) return;
        const ledger = activeStore(req);
        if (activeMode(req) !== 'demo' || (current.kind !== 'guest-demo' && current.memberId !== ledger.group().organizerId)) return send(res, 403, { error: 'Simulated settlement is available only to demo facilitators.' });
        const cycle = await ledger.settleDemo(current.memberId);
        return send(res, 200, { cycle });
      }
      if (req.method === 'POST' && url.pathname === '/api/cycle/new') {
        const current = memberSession(req, res); if (!current) return;
        const ledger = activeStore(req);
        if (current.kind !== 'guest-demo' && current.memberId !== ledger.group().organizerId) return send(res, 403, { error: 'Only the organizer can start a new cycle.' });
        const cycle = await ledger.newCycle(current.memberId);
        return send(res, 201, { cycle });
      }
      if (req.method === 'POST' && url.pathname === '/api/wallet/create') {
        const memberId = requireMember(req, res); if (!memberId) return;
        if (activeMode(req) !== 'demo') return send(res, 409, { error: 'Built-in demo wallets are available only in demo mode.' });
        return send(res, 201, { wallet: await activeStore(req).createWallet(memberId) });
      }
      if (req.method === 'POST' && url.pathname === '/api/wallet/claim-demo') {
        const memberId = requireMember(req, res); if (!memberId) return;
        if (activeMode(req) !== 'demo') return send(res, 409, { error: 'Simulated sats are unavailable in Lightning mode.' });
        const wallet = await activeStore(req).claimDemo(memberId);
        return wallet ? send(res, 200, { wallet }) : send(res, 409, { error: 'Create a demo wallet first, or your one-time claim was used.' });
      }
      if (req.method === 'POST' && url.pathname === '/api/wallet/pay-demo') {
        const memberId = requireMember(req, res); if (!memberId) return;
        if (activeMode(req) !== 'demo') return send(res, 409, { error: 'Demo payments are unavailable in Lightning mode.' });
        const ledger = activeStore(req);
        const record = ledger.latestFor(memberId);
        if (!record || record.status !== 'pending') return send(res, 409, { error: 'Create a pending contribution first.' });
        const paid = await ledger.payDemo(memberId, record.id, ledger.group().amountSats);
        return paid ? send(res, 200, { record: publicRecord(paid, memberId) }) : send(res, 409, { error: 'Create a wallet and claim enough demo sats first.' });
      }
      if (req.method === 'POST' && url.pathname === '/api/proofs') {
        const memberId = requireMember(req, res); if (!memberId) return;
        if (activeMode(req) !== 'lightning') return send(res, 409, { error: 'Payment proof is for Lightning mode.' });
        const input = await body(req);
        if (typeof input.preimage !== 'string' || !/^[a-f0-9]{64}$/i.test(input.preimage)) return send(res, 400, { error: 'Invalid payment preimage.' });
        const record = store.latestFor(memberId);
        if (!record) return send(res, 404, { error: 'No contribution found.' });
        const digest = createHash('sha256').update(Buffer.from(input.preimage, 'hex')).digest();
        const expected = Buffer.from(record.paymentHash, 'hex');
        if (expected.length !== 32 || !timingSafeEqual(digest, expected)) return send(res, 400, { error: 'Proof does not match this contribution.' });
        if (record.status !== 'paid' && !(await lightning.checkPayment(record)).settled) return send(res, 409, { error: 'The receiving wallet has not confirmed payment.' });
        const updated = await store.update(record.id, { status: 'paid', paidAt: record.paidAt || new Date().toISOString(), attribution: 'member-proof' });
        return send(res, 200, { record: publicRecord(updated, memberId) });
      }
      if (req.method === 'POST' && url.pathname === '/api/invoices') {
        const memberId = requireMember(req, res); if (!memberId) return;
        const ledger = activeStore(req);
        const group = ledger.group();
        const round = ledger.round();
        const member = group.members.find(item => item.id === memberId);
        if (!member) return send(res, 403, { error: 'You are not a member of this circle.' });
        if (!round || round.phase !== 'open') return send(res, 409, { error: 'This round is not open for contributions.' });
        const creationKey = `${session(req).kind === 'guest-demo' ? cookie(req) : member.id}:${round.id}`;
        if (creating.has(creationKey)) return send(res, 409, { error: 'Invoice creation already in progress.' });
        const work = (async () => {
          await reconcile();
          const existing = ledger.latestFor(member.id);
          if (existing?.status === 'paid') return { status: 409, error: 'This member already contributed.' };
          if (existing?.status === 'pending') return { status: 200, record: publicRecord(existing, memberId) };
          if (existing?.status === 'expired') return { status: 409, error: 'The previous invoice expired but its wallet status is not final. Check again before requesting another invoice.' };
          const invoice = activeMode(req) === 'lightning' ? await lightning.createInvoice({ amount: group.amountSats,
            memo: `${group.name}: round ${round.number} - ${member.name}` }) : {
            paymentRequest: `demo:${randomUUID()}`,
            checkingId: randomUUID(),
            paymentHash: randomBytes(32).toString('hex')
          };
          const expiresAt = activeMode(req) === 'lightning' && paymentEnvironment === 'signet'
            ? validateSignetInvoice({ ...invoice, amountSats: group.amountSats })
            : new Date(Date.now() + 1800_000).toISOString();
          const record = {
            id: randomUUID(), groupId: group.id, cycleId: round.cycleId, roundId: round.id,
            memberId: member.id, amountSats: group.amountSats, provider: activeMode(req) === 'lightning' ? (lightning.provider || 'lnbits') : 'demo',
            environment: activeMode(req) === 'lightning' ? paymentEnvironment : 'simulated', status: 'pending',
            createdAt: new Date().toISOString(),
            expiresAt,
            ...invoice
          };
          await ledger.add(record);
          return { status: 201, record: publicRecord(record, memberId) };
        })();
        creating.set(creationKey, work);
        try {
          const result = await work;
          return send(res, result.status, result.record ? { record: result.record } : { error: result.error });
        } finally { creating.delete(creationKey); }
      }
      if (req.method === 'GET' && ['/','/index.html','/styles.css','/app.js','/preloader.js','/preloader-bootstrap.js','/gsap.min.js','/nwc.bundle.js','/logo.svg','/favicon.svg'].includes(url.pathname)) {
        const path = url.pathname === '/' ? '/index.html' : url.pathname;
        const content = await readFile(join(publicDir, path.slice(1)));
        res.writeHead(200, { ...securityHeaders, 'Content-Type': types[extname(path)], 'Cache-Control': path === '/index.html' ? 'no-store' : 'no-cache',
          ...(process.env.PUBLIC_HTTPS === '1' ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}) });
        return res.end(content);
      }
      send(res, 404, { error: 'Not found.' });
    } catch (error) {
      const status = error.status || (error instanceof LightningError ? 502 : 500);
      if (status >= 500) console.error('CircleSats request failed', { status, name: error.name, code: error.code || null });
      send(res, status, { error: status >= 500 ? 'Unable to complete the request.' : error.message });
    }
  });
}
