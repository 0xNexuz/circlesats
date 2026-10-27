(() => {
  const root = document.documentElement;
  const layer = document.getElementById('preloader');
  if (!root.classList.contains('preload-active') || !layer) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const percent = document.getElementById('preloader-percent');
  const progress = document.getElementById('preloader-progress');
  const fill = document.getElementById('preloader-fill');
  const status = document.getElementById('preloader-status');
  const displayed = { value: 0 };
  const completed = new Set();
  const listener = new AbortController();
  const startedAt = Date.now();
  let actual = 0;
  let exiting = false;
  let degraded = false;
  let dwellTimer;
  let introPromise = Promise.resolve();

  function paint() {
    const value = Math.min(100, Math.round(displayed.value));
    percent.textContent = `${value}%`;
    progress.setAttribute('aria-valuenow', String(value));
    fill.style.transform = `scaleX(${value / 100})`;
  }

  function finish() {
    clearTimeout(fallback);
    clearTimeout(dwellTimer);
    clearTimeout(window.__circlePreloaderRescue);
    listener.abort();
    root.classList.remove('preload-active', 'preload-exiting');
    layer.remove();
  }

  function exit() {
    if (exiting) return;
    exiting = true;
    status.textContent = degraded ? 'Opening with available assets' : 'Ready to move together';
    root.classList.add('preload-exiting');
    if (reducedMotion || !window.gsap) return finish();

    window.gsap.timeline({ onComplete: finish })
      .to('.preloader-crest', { autoAlpha: 0, scale: 0.92, duration: 0.26, ease: 'power2.in' }, 0)
      .to('.preloader-center-label, .preloader-wordmark, .preloader-tagline', { autoAlpha: 0, y: -15, duration: 0.24, stagger: 0.025, ease: 'power2.in' }, 0.04)
      .to('.preloader-topline, .preloader-bottom', { autoAlpha: 0, duration: 0.18, ease: 'power2.in' }, 0.12)
      .to(layer, { yPercent: -101, duration: 0.6, ease: 'power3.inOut' }, 0.18);
  }

  function readyToExit() {
    if (degraded || reducedMotion) return exit();
    status.textContent = 'Ready to move together';
    // A fast cached reload still gets one readable brand moment; slow loads add no extra wait.
    const remaining = Math.max(0, 1100 - (Date.now() - startedAt));
    const afterIntro = () => introPromise.then(() => { if (!exiting) exit(); });
    if (remaining) dwellTimer = setTimeout(afterIntro, remaining);
    else afterIntro();
  }

  function showActualProgress() {
    if (window.gsap && !reducedMotion) {
      window.gsap.to(displayed, {
        value: actual, duration: 0.22, ease: 'power2.out', overwrite: true,
        onUpdate: paint,
        onComplete: () => { if (actual === 100) readyToExit(); }
      });
    } else {
      displayed.value = actual;
      paint();
      if (actual === 100) readyToExit();
    }
  }

  function settle(id, weight, failed = false) {
    if (completed.has(id) || exiting) return;
    completed.add(id);
    actual += weight;
    degraded ||= failed;
    showActualProgress();
  }

  const tasks = [
    ['document', 10, () => Promise.resolve()],
    ['logo', 20, () => Promise.all([...layer.querySelectorAll('img'), ...document.querySelectorAll('.brand img')].map(image => image.decode?.() || Promise.resolve()))],
    ['fonts', 20, () => document.fonts ? Promise.all([
      document.fonts.load('800 24px Manrope'),
      document.fonts.load('500 16px "DM Sans"')
    ]).then(faces => { if (faces.some(group => group.length === 0)) throw new Error('Brand fonts unavailable.'); }) : Promise.resolve()],
    ['motion', 15, () => reducedMotion ? Promise.resolve() : new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/gsap.min.js';
      script.onload = () => {
        if (!window.gsap) return reject(new Error('Motion unavailable.'));
        if (!exiting) introPromise = new Promise(done => window.gsap.timeline({ onComplete: done })
          .from('.preloader-point', { autoAlpha: 0, scale: 0.2, duration: 0.34, stagger: 0.045, ease: 'back.out(1.7)' }, 0)
          .from('.preloader-mark-wrap', { autoAlpha: 0, scale: 0.82, rotation: -8, duration: 0.46, ease: 'power3.out' }, 0.09)
          .from('.preloader-center-label, .preloader-wordmark, .preloader-tagline', { y: 12, duration: 0.4, stagger: 0.06, ease: 'power2.out' }, 0.23));
        resolve();
      };
      script.onerror = () => reject(new Error('Motion unavailable.'));
      document.head.append(script);
    })],
    ['circle', 35, () => window.__circleCriticalReady ? Promise.resolve(window.__circleCriticalReady) : new Promise(resolve => {
      window.addEventListener('circlesats:critical-ready', event => resolve(event.detail), { once: true, signal: listener.signal });
    })]
  ];

  const fallback = setTimeout(() => {
    degraded = true;
    for (const [id, weight] of tasks) settle(id, weight, true);
  }, 4000);

  for (const [id, weight, run] of tasks) {
    Promise.resolve().then(run)
      .then(result => settle(id, weight, id === 'circle' && result?.ok === false))
      .catch(() => settle(id, weight, true));
  }
})();
