import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const root = join(process.cwd(), 'vercel-public');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (!/^\/[a-zA-Z0-9.-]*$/.test(path) || path.startsWith('/api/')) {
    res.writeHead(404); res.end(); return;
  }
  try {
    const name = path === '/' ? 'index.html' : path.slice(1);
    const content = await readFile(join(root, name));
    res.writeHead(200, { 'Content-Type': types[extname(name)] || 'application/octet-stream' });
    res.end(content);
  } catch { res.writeHead(404); res.end(); }
}).listen(3200, '127.0.0.1', () => console.log('Vercel preview: http://127.0.0.1:3200'));
