// Local stand-in for the Vercel deployment: serves vercel-public/ with the
// headers from vercel.json and runs the /api/practice functions. With a private
// .env.mutinynet present (receive-only NWC for your Mutinynet node), the
// preview makes the same real Mutinynet practice payments as the deployed site.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const root = join(process.cwd(), 'vercel-public');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const config = JSON.parse(await readFile('vercel.json', 'utf8'));
const headers = Object.fromEntries((config.headers?.[0]?.headers || []).map(header => [header.key, header.value]));
const actions = new Set(['info', 'invoice', 'pay', 'status', 'qr']);
let practice = null;

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const api = /^\/api\/practice\/([a-z]+)$/.exec(path);
  if (api && actions.has(api[1])) {
    practice ||= (await import('../src/practice-endpoint.js')).practiceHandler;
    return practice(req, res, api[1]);
  }
  if (!/^\/[a-zA-Z0-9.-]*$/.test(path) || path.startsWith('/api/')) {
    res.writeHead(404, headers); res.end(); return;
  }
  try {
    const name = path === '/' ? 'index.html' : path.slice(1);
    const content = await readFile(join(root, name));
    res.writeHead(200, { ...headers, 'Content-Type': types[extname(name)] || 'application/octet-stream' });
    res.end(content);
  } catch { res.writeHead(404, headers); res.end(); }
}).listen(3200, '127.0.0.1', () => {
  console.log('Vercel preview: http://127.0.0.1:3200');
  console.log(process.env.NWC_RECEIVER_CONNECTION_SECRET && process.env.PAYMENT_ENVIRONMENT === 'signet'
    ? 'Real Mutinynet practice payments: enabled (receiver from .env.mutinynet).' + (process.env.BLINK_RECEIVE_API_KEY ? ' Real-sats (Blink) payments: enabled.' : '')
    : 'Real Mutinynet practice payments: not configured; guests use the Alby sandbox or simulation.');
});
