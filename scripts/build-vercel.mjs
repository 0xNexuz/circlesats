import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const output = 'vercel-public';
await mkdir(output, { recursive: true });
await cp('public', output, { recursive: true, force: true });

// The browser demo uses the same cycle state machine, without its Node-only
// disk adapter. Production Lightning receiving still requires the Node host.
const source = await readFile('src/store.js', 'utf8');
const browserStore = source
  .replace(/^import \{ randomUUID \} from 'node:crypto';\r?\n/, 'const randomUUID = () => globalThis.crypto.randomUUID();\n')
  .replace(/^import \{ readFile, stat \} from 'node:fs\/promises';\r?\n/m, '')
  .replace(/^import \{ decodeLedger, writeLedger \} from '\.\/durable-json\.js';\r?\n/m, '')
  .replace('    await writeLedger(file, { version: 4, revision, group, records, wallets, cycles, activeCycleId });',
    "    throw new Error('Disk persistence is unavailable in the browser demo.');")
  .replace('      try {\n        const parsed = decodeLedger(await readFile(file, \'utf8\'));',
    "      try {\n        throw new Error('Disk loading is unavailable in the browser demo.');")
  .replace('await stat(`${file}.bak`)', 'Promise.reject(new Error(\'Disk loading is unavailable in the browser demo.\'))');
if (browserStore.includes("from 'node:") || browserStore.includes('writeLedger(') || browserStore.includes('readFile(')) {
  throw new Error('Browser store transformation is incomplete.');
}
await writeFile(join(output, 'store-browser.js'), browserStore);
await cp('src/browser-demo.js', join(output, 'browser-demo.js'));
// Per-visitor Alby sandbox wallets run in the visitor's tab; these modules have
// no Node-only imports and carry no secrets.
for (const file of ['sandbox-lightning.js', 'guest-sandbox.js', 'practice-client.js']) {
  const source = await readFile(join('src', file), 'utf8');
  if (/from ['"]node:|require\(/.test(source)) throw new Error(`${file} must stay browser-compatible.`);
  await writeFile(join(output, file), source);
}

const index = await readFile(join(output, 'index.html'), 'utf8');
const tagged = index
  .replace('<script type="module" src="/app.js"></script>', '<script type="module" src="/browser-demo.js"></script>')
  .replace('Try a private simulation, or sign in with the access code from your circle organizer.', 'Start a private practice circle in this browser. No account is needed.')
  .replace('Use the built-in simulated wallet, or connect an external wallet when Lightning is configured.', 'Pay a real Lightning invoice from your own wallet (scan, or connect it with Nostr Wallet Connect), or use free Mutinynet test coins. If neither is available, the demo says so and simulates.')
  .replace('Receipts show whether the payment arrived and whether a signed-in member supplied payment proof.', 'Each receipt names its network and shows the payment hash and preimage, so anyone can verify the payment. Approvals and payouts follow the group rules.');
if (tagged === index) throw new Error('Could not install the browser demo entry point.');
await writeFile(join(output, 'index.html'), tagged);
