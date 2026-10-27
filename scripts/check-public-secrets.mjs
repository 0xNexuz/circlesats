import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  .toString('utf8').split('\0').filter(Boolean);
let privateWallets = null;
try { privateWallets = JSON.parse(await readFile('data/alby-sandbox-wallets.json', 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}
const sandboxSecrets = strings(privateWallets).filter(value => value.startsWith('nostr+walletconnect://') && value.length > 50);
const realSecrets = [];
for (const privateFile of ['.env.mutinynet', '.env.mutinynet-payer']) {
  let text;
  try { text = await readFile(privateFile, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; continue; }
  if (files.includes(privateFile)) throw new Error('A private Mutinynet environment file is a Git candidate.');
  for (const match of text.matchAll(/^(?:NWC_RECEIVER_CONNECTION_SECRET|NWC_PAYER_CONNECTION_SECRET)=(nostr\+walletconnect:\/\/\S+)/gm)) {
    realSecrets.push(match[1]);
  }
}
const secrets = [...sandboxSecrets, ...realSecrets];
let scanned = 0;
for (const file of files) {
  const bytes = await readFile(file);
  if (bytes.includes(0)) continue;
  scanned++;
  const content = bytes.toString('utf8');
  if (secrets.some(secret => content.includes(secret))) throw new Error(`Private wallet connection appears in a Git candidate: ${file}`);
  if (/NWC_RECEIVER_CONNECTION_SECRET\s*=\s*nostr\+walletconnect:\/\/[^\s#]*(?:secret=|[?&]secret=)/i.test(content)) {
    throw new Error(`Possible receiver credential appears in a Git candidate: ${file}`);
  }
}
console.log(JSON.stringify({ status: 'passed', gitCandidateFiles: files.length, textFilesScanned: scanned,
  sandboxWalletConnectionsChecked: sandboxSecrets.length, mutinynetWalletConnectionsChecked: realSecrets.length }));
