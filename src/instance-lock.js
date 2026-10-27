import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function acquireInstanceLock(ledgerFile) {
  const lockFile = `${ledgerFile}.lock`;
  const token = randomUUID();
  await mkdir(dirname(lockFile), { recursive: true });
  let handle;
  try { handle = await open(lockFile, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another CircleSats instance or stale ledger lock exists. Verify the old process stopped before removing the lock.');
    throw error;
  }
  try { await handle.writeFile(JSON.stringify({ token, pid: process.pid, startedAt: new Date().toISOString() })); await handle.sync(); }
  finally { await handle.close(); }
  let released = false;
  return async () => {
    if (released) return;
    const current = JSON.parse(await readFile(lockFile, 'utf8'));
    if (current.token !== token) throw new Error('Ledger lock owner changed; refusing to remove it.');
    await rm(lockFile);
    released = true;
  };
}
