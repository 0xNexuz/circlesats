import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { GROUP } from './store.js';
import { createDemoStore } from './demo-store.js';

export async function createAuth(file, { announce = console.log, requireExisting = false } = {}) {
  let codes;
  try { codes = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (requireExisting) throw new Error('Member access is not provisioned. Run npm run provision:members against the private DATA_DIR before production startup.');
    codes = {};
    const invites = [];
    for (const member of GROUP.members) {
      const code = randomBytes(9).toString('base64url');
      const salt = randomBytes(16).toString('hex');
      codes[member.id] = { salt, hash: scryptSync(code, salt, 32).toString('hex') };
      invites.push(`${member.name}: ${code}`);
    }
    await mkdir(dirname(file), { recursive: true });
    await announce(`CircleSats one-time member access codes (save privately):\n${invites.join('\n')}`);
    await writeFile(file, JSON.stringify(codes, null, 2), { mode: 0o600, flag: 'wx' });
  }
  const sessions = new Map();
  const failures = new Map();
  // Ending a session also closes a guest's private sandbox wallet connections.
  function drop(token) {
    const session = sessions.get(token);
    sessions.delete(token);
    try { session?.sandbox?.close(); } catch { /* already closed */ }
  }
  const sweep = setInterval(() => {
    for (const [token, current] of sessions) if (current.expires < Date.now()) drop(token);
  }, 10 * 60_000);
  sweep.unref?.();
  function issue(memberId, kind, address = '') {
    const session = { memberId, kind, address, csrf: randomBytes(24).toString('base64url'), expires: Date.now() + 12 * 60 * 60_000 };
    if (kind === 'guest-demo') session.demoStore = createDemoStore();
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, session);
    return { token, session };
  }
  return {
    login(memberId, code, address = '') {
      const key = `${address}:${codes[memberId] ? memberId : 'unknown'}`;
      const attempt = failures.get(key) || { count: 0, until: 0 };
      if (attempt.until > Date.now()) return null;
      const entry = codes[memberId];
      const valid = entry && typeof code === 'string' && code.length <= 100 &&
        timingSafeEqual(scryptSync(code, entry.salt, 32), Buffer.from(entry.hash, 'hex'));
      if (!valid) {
        attempt.count++;
        if (attempt.count >= 5) { attempt.until = Date.now() + 15 * 60_000; attempt.count = 0; }
        failures.set(key, attempt);
        return null;
      }
      failures.delete(key);
      return issue(memberId, 'member', address);
    },
    startDemo(address = '') {
      for (const [token, current] of sessions) if (current.expires < Date.now()) drop(token);
      if ([...sessions.values()].filter(current => current.kind === 'guest-demo').length >= 200) return null;
      if ([...sessions.values()].filter(current => current.kind === 'guest-demo' && current.address === address).length >= 5) return null;
      return issue('awa', 'guest-demo', address);
    },
    get(token) {
      const session = sessions.get(token);
      if (!session) return null;
      if (session.expires < Date.now()) { drop(token); return null; }
      return session;
    },
    logout(token) { drop(token); }
  };
}
