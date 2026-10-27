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

const index = await readFile(join(output, 'index.html'), 'utf8');
const tagged = index.replace('<script type="module" src="/app.js"></script>', '<script type="module" src="/browser-demo.js"></script>');
if (tagged === index) throw new Error('Could not install the browser demo entry point.');
await writeFile(join(output, 'index.html'), tagged);
