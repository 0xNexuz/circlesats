import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export function decodeLedger(text) {
  const document = JSON.parse(text);
  if (!document || !Array.isArray(document.records) || !document.group || !Array.isArray(document.cycles || [])) {
    throw new Error('Invalid ledger snapshot.');
  }
  if (document.version >= 4) {
    const { integrity, ...payload } = document;
    const expected = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    if (typeof integrity !== 'string' || integrity !== expected) throw new Error('Ledger integrity check failed.');
    if (!Number.isSafeInteger(document.revision) || document.revision < 0) throw new Error('Invalid ledger revision.');
  }
  return document;
}

function encodeLedger(payload) {
  const integrity = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return JSON.stringify({ ...payload, integrity }, null, 2);
}

async function replaceFlushed(path, content) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

export async function writeLedger(file, payload) {
  await mkdir(dirname(file), { recursive: true });
  let previous;
  try { previous = await readFile(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous !== undefined) {
    decodeLedger(previous);
    await replaceFlushed(`${file}.bak`, previous);
  }
  await replaceFlushed(file, encodeLedger(payload));
  // Directory fsync is unavailable on some platforms, including Windows.
  // The file itself has been flushed before the final rename.
  try {
    const directory = await open(dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (!['EACCES', 'EPERM', 'EINVAL', 'EISDIR', 'ENOTSUP'].includes(error.code)) {
      console.warn('Ledger directory sync unavailable after committed rename.');
    }
  }
}
