(() => {
  const root = document.documentElement;
  const state = { protected: true, epoch: 0 };
  window.__lwAppLock = state;
  function conceal() {
    state.epoch += 1;
    if (state.protected) {
      root.setAttribute('data-app-shield', '');
      document.title = 'Love Within';
      delete root.dataset.theme;
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = '#faf7f8';
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      document.querySelectorAll('video,audio').forEach(media => media.pause());
    }
    window.dispatchEvent(new Event('lw:app-lock'));
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') conceal(); });
  window.addEventListener('pagehide', conceal);
  window.addEventListener('pageshow', event => { if (event.persisted) conceal(); });
})();
