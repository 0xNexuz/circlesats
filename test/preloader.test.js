import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../public/preloader.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const boot = await readFile(new URL('../public/preloader-bootstrap.js', import.meta.url), 'utf8');

test('full page loads activate the preloader even after a prior visit', () => {
  assert.match(html, /src="\/preloader-bootstrap\.js"/);
  for (let visit = 0; visit < 2; visit++) {
    const classes = new Set();
    const document = { documentElement: { classList: { add: name => classes.add(name) } } };
    runInNewContext(boot, { document, window: {}, setTimeout: () => 1,
      sessionStorage: { getItem: () => '1' } });
    assert.equal(classes.has('preload-active'), true);
  }
});

function start({ reducedMotion, appReady, stalled = false }) {
  const classes = new Set(['preload-active']);
  const attributes = {};
  const timers = new Map();
  const nodes = {
    'preloader-percent': { textContent: '0%' },
    'preloader-progress': { setAttribute: (name, value) => { attributes[name] = value; } },
    'preloader-fill': { style: {} },
    'preloader-status': { textContent: 'Preparing your circle' }
  };
  let removed = false;
  let injectedScripts = 0;
  const logo = { decode: () => stalled ? new Promise(() => {}) : Promise.resolve() };
  const layer = { querySelectorAll: () => [logo], remove: () => { removed = true; } };
  const document = {
    documentElement: { classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: (...names) => names.forEach(name => classes.delete(name)) } },
    getElementById: id => id === 'preloader' ? layer : nodes[id],
    querySelectorAll: () => [logo],
    fonts: { load: () => stalled ? new Promise(() => {}) : Promise.resolve([{}]) },
    createElement: () => ({ src: '', onload: null, onerror: null }),
    head: { append: () => { injectedScripts++; } }
  };
  const window = {
    matchMedia: () => ({ matches: reducedMotion }),
    __circleCriticalReady: appReady,
    addEventListener: () => {},
    __circlePreloaderRescue: null
  };
  const setTimeout = (callback, ms) => { timers.set(ms, callback); return ms; };
  const clearTimeout = ms => { timers.delete(ms); };
  runInNewContext(source, { document, window, setTimeout, clearTimeout, AbortController });
  return { classes, nodes, attributes, timers, get removed() { return removed; }, get injectedScripts() { return injectedScripts; } };
}

test('reduced motion completes real readiness checks and reveals without loading GSAP', async () => {
  const page = start({ reducedMotion: true, appReady: { ok: true } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.removed, true);
  assert.equal(page.nodes['preloader-percent'].textContent, '100%');
  assert.equal(page.attributes['aria-valuenow'], '100');
  assert.equal(page.injectedScripts, 0);
  assert.equal(page.classes.has('preload-active'), false);
});

test('stalled assets release the page at the fallback instead of trapping it', async () => {
  const page = start({ reducedMotion: false, stalled: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.removed, false);
  page.timers.get(4000)();
  assert.equal(page.removed, true);
  assert.equal(page.nodes['preloader-percent'].textContent, '100%');
  assert.equal(page.nodes['preloader-status'].textContent, 'Opening with available assets');
  assert.equal(page.classes.has('preload-active'), false);
});
