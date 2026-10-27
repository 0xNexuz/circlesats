import { access, mkdir, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuth } from '../src/auth.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const input = process.env.DATA_DIR;
if (!input || !isAbsolute(input)) throw new Error('Set DATA_DIR to an absolute, private persistent-volume path.');
const directory = resolve(input);
const withinProject = relative(root, directory);
if (withinProject === '' || (withinProject !== '..' && !withinProject.startsWith(`..${sep}`) && !isAbsolute(withinProject))) {
  throw new Error('DATA_DIR must be outside the source repository.');
}
const authFile = join(directory, 'member-auth.json');
const invitesFile = join(directory, 'member-invites.txt');
try { await access(authFile); throw new Error('Member access is already provisioned. Do not overwrite it.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(directory, { recursive: true, mode: 0o700 });
await createAuth(authFile, { announce: async message => {
  const handle = await open(invitesFile, 'wx', 0o600);
  try { await handle.writeFile(`${message}\n`); await handle.sync(); }
  finally { await handle.close(); }
} });
console.log(`Member access provisioned. Deliver codes privately from ${invitesFile}; do not put that file in the web root or logs.`);
