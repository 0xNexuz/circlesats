(() => {
  document.documentElement.classList.add('preload-active');
  window.__circlePreloaderRescue = setTimeout(() => {
    document.documentElement.classList.remove('preload-active');
    document.getElementById('preloader')?.remove();
  }, 6500);
})();
