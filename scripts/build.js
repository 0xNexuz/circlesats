import { readFile, writeFile } from 'node:fs/promises';

// The SDK publishes a standalone browser ESM file with no external imports.
const vendor = (await readFile('node_modules/@getalby/sdk/dist/esm/nwc.js', 'utf8'))
  .replace(/\/\/# sourceMappingURL=nwc\.js\.map\s*$/, '');
const adapter = (await readFile('src/client/nwc.js', 'utf8'))
  .replace(/^import \{ NWCClient \} from '@getalby\/sdk';\s*/, '');
await writeFile('public/nwc.bundle.js', `${vendor}\n${adapter}\n`);

// Keep the first-visit motion library local and load it only when needed.
await writeFile('public/gsap.min.js', await readFile('node_modules/gsap/dist/gsap.min.js'));
