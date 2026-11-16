"use strict";
// One bounded startup per document. Internal targets never leave this closure.
// Existing telemetry batches the milestones; neither readiness nor paint waits for load.
(() => {
  const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
  const id = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  const events = [], seen = new Set();
  let target = null, kind = 'other', hidden = document.visibilityState === 'hidden', ended = false, observer, scheduled = false;
  const root = document.documentElement;
  function mark(stage, extra = {}) {
    if (seen.has(stage)) return;
    seen.add(stage);
    const event = { stage, ms: Math.round(performance.now()), extra: { target_kind: kind, hidden, shell: !!root.dataset.piShell, ...extra } };
    events.push(event);
    window.dispatchEvent(new CustomEvent('pi-startup-stage', { detail: event }));
  }
  function end(outcome) {
    if (ended) return;
    ended = true; observer?.disconnect(); clearTimeout(deadline);
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('hashchange', schedule);
    mark('startup-ended', { outcome });
  }
  function dismiss() {
    root.classList.remove('has-splash');
    document.getElementById('app-splash')?.remove?.();
  }
  function bindTarget(next, nextKind) {
    if (ended) return;
    if (target === null) { target = next; kind = nextKind || kind; return; }
    if (target !== next) { dismiss('navigation'); end('navigation'); }
  }
  function check() {
    if (ended) return;
    let s;
    try { s = window.piStartupRead?.(); } catch { return; }
    if (!s) return;
    bindTarget(s.target, s.kind);
    if (ended) return;
    if (document.visibilityState === 'hidden') { hidden = true; return; }
    if (s.error) { dismiss('error'); end('error'); return; }
    if (!s.display) return;
    if (s.cached) mark('cache-content', { cache_source: s.cacheSource === 'disk' ? 'disk' : 'memory' });
    mark('surface-ready'); dismiss('ready');
    if (s.confirmed) mark('state-confirmed');
    if (s.confirmed && s.send) mark('send-ready');
    if (s.surfaceOnly) end('surface-only');
    else if (s.confirmed && (s.send || s.sendApplicable === false)) end('ready');
  }
  function schedule() {
    if (ended || scheduled) return;
    scheduled = true;
    // Let the committed DOM get a paint opportunity before calling it visible.
    requestAnimationFrame(() => requestAnimationFrame(() => { scheduled = false; check(); }));
  }
  function visibility() { if (document.visibilityState === 'hidden') hidden = true; else schedule(); }
  const deadline = setTimeout(() => end('timeout'), 60000);
  window.piStartup = { id, events, target: bindTarget };
  // The OS owns the only branded splash. Keep telemetry and failure recovery.
  dismiss();
  mark('splash-hidden', { splash_reason: 'not-shown' });
  // This recovery path must work even when app.js (and its h/ui helpers) never ran.
  // Dynamic route modules already provide their own local retry path.
  let scriptFailed = false;
  function showRecovery() {
    const panel = document.getElementById('startup-recovery');
    if (!panel) return;
    panel.hidden = false;
    panel.showModal();
    panel.addEventListener('cancel', event => event.preventDefault());
    panel.focus();
    const retry = panel.querySelector('button');
    retry?.addEventListener('click', () => {
      retry.disabled = true; retry.textContent = '正在重新加载…';
      location.reload(); // explicit reload bypasses the stored shell, preserving the route
    }, { once: true });
  }
  function scriptError(event) {
    const tag = event.target;
    if (scriptFailed || tag?.tagName !== 'SCRIPT' || !tag.src || tag.async || tag.dataset.routeModule) return;
    const url = new URL(tag.src, location.href);
    if (url.origin !== location.origin) return;
    scriptFailed = true; root.classList.add('startup-failed');
    root.classList.remove('has-splash'); document.getElementById('app-splash')?.remove();
    dismiss('error'); end('error');
    if (document.body) showRecovery();
    else document.addEventListener('DOMContentLoaded', showRecovery, { once: true });
  }
  window.addEventListener('error', scriptError, true);
  window.addEventListener('load', () => window.removeEventListener('error', scriptError, true), { once: true });
  function start() {
    dismiss();
    if (ended) return;
    const main = document.getElementById('main');
    if (main) {
      observer = new MutationObserver(schedule);
      observer.observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'data-startup-send-ready'] });
    }
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('hashchange', schedule);
    schedule();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
  window.addEventListener('pagehide', e => { if (!e.persisted) end('closed'); }, { once: true });
})();
