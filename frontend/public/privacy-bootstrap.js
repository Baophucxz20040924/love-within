/* Run before the application bundle; a new document never inherits an open hidden space. */
(() => {
  const root = document.documentElement;
  const state = { epoch: 0, active: true, locked: true };
  window.__lwPrivacy = state;
  function conceal() {
    state.epoch += 1;
    if (!state.active) { window.dispatchEvent(new Event('lw:privacy-lock')); return; }
    state.locked = true;
    root.setAttribute('data-privacy-shield', '');
    document.title = 'Love Within';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = '#faf7f8';
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.querySelectorAll('video,audio').forEach(media => media.pause());
    window.dispatchEvent(new Event('lw:privacy-lock'));
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') conceal();
  });
  window.addEventListener('pagehide', conceal);
  window.addEventListener('pageshow', event => { if (event.persisted) conceal(); });
})();
