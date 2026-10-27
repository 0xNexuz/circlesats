import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { decodeLedger } from '../src/durable-json.js';

const directory = process.env.DATA_DIR;
if (!directory || !isAbsolute(directory)) throw new Error('Set DATA_DIR to the absolute persistent-volume path.');
const file = join(directory, 'circlesats.json');
const primary = decodeLedger(await readFile(file, 'utf8'));
if (primary.version !== 4) throw new Error('Ledger is not at version 4. Migrate a private copy before deployment.');
let backupRevision = null;
try { backupRevision = decodeLedger(await readFile(`${file}.bak`, 'utf8')).revision ?? 0; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (backupRevision !== null && backupRevision >= primary.revision) throw new Error('Backup revision must precede the primary ledger revision.');
console.log(JSON.stringify({ status: 'valid', version: primary.version, revision: primary.revision ?? 0,
  backupRevision, contributionCount: primary.records.length, cycleCount: primary.cycles?.length || 0 }));
