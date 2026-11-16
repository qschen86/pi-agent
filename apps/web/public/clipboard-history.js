/* Device-local clipboard link history. Only http(s) URLs are kept, newest first, at most 50 for 7 days. */
(() => {
  'use strict';
  const KEY = 'pi-agent:clipboard-history:v1';
  const MAX = 50;
  const TTL = 7 * 86400000;
  const MAX_URL = 8192;
  const FAVICON = /^data:image\/(?:png|jpeg|webp|svg\+xml|x-icon|vnd\.microsoft\.icon|gif);base64,[A-Za-z0-9+/=]+$/;
  let cache = null;

  function normalize(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > MAX_URL) return null;
    if (/[\\\u0000-\u001f]/u.test(raw) || /\s/u.test(raw)) return null;
    try {
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
      return url.href;
    } catch { return null; }
  }
  const hostOf = raw => { try { return new URL(raw).hostname; } catch { return ''; } };
  const pathOf = raw => {
    try {
      const url = new URL(raw);
      return (url.pathname || '/') + (url.search || '');
    } catch { return ''; }
  };
  const titleOf = value => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, 240) : '';
  const faviconOf = value => typeof value === 'string' && value.length < 100000 && FAVICON.test(value) ? value : '';
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function clean(raw) {
    if (!Array.isArray(raw)) return [];
    const now = Date.now();
    const rows = [];
    for (const row of raw) {
      if (!row || typeof row !== 'object') continue;
      const url = normalize(row.url);
      const at = Number(row.at);
      if (!url || !Number.isFinite(at) || at <= 0 || now - at > TTL || at - now > 86400000) continue;
      rows.push({
        id: typeof row.id === 'string' && row.id && row.id.length <= 40 ? row.id : newId(),
        url,
        host: hostOf(url),
        at,
        title: titleOf(row.title),
        favicon: faviconOf(row.favicon),
      });
    }
    rows.sort((a, b) => b.at - a.at);
    const seenUrls = new Set(), seenIds = new Set(), output = [];
    for (const row of rows) {
      if (seenUrls.has(row.url) || seenIds.has(row.id)) continue;
      seenUrls.add(row.url); seenIds.add(row.id); output.push(row);
      if (output.length >= MAX) break;
    }
    return output;
  }

  function load() {
    if (cache) return cache;
    try { cache = clean(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { cache = []; }
    return cache;
  }

  function save(items) {
    cache = clean(items);
    try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* Keep the in-memory list for this page. */ }
  }

  const emit = () => window.dispatchEvent(new Event('pi-clipboard-history-change'));

  function record(raw, extra) {
    const url = normalize(raw);
    if (!url) return null;
    const current = load();
    const previous = current.find(row => row.url === url);
    const item = {
      id: previous?.id || newId(),
      url,
      host: hostOf(url),
      at: Date.now(),
      title: titleOf(extra?.title ?? previous?.title),
      favicon: faviconOf(extra?.favicon ?? previous?.favicon),
    };
    save([item, ...current.filter(row => row.url !== url)]);
    emit();
    return item;
  }

  function update(raw, patch) {
    const url = normalize(raw);
    if (!url || !patch || typeof patch !== 'object') return null;
    const current = load();
    const index = current.findIndex(row => row.url === url);
    if (index < 0) return null;
    const item = { ...current[index] };
    if ('title' in patch) item.title = titleOf(patch.title);
    if ('favicon' in patch) item.favicon = faviconOf(patch.favicon);
    const next = current.slice();
    next[index] = item;
    save(next);
    emit();
    return item;
  }

  function remove(id) {
    const current = load();
    const next = current.filter(row => row.id !== id);
    if (next.length === current.length) return false;
    save(next); emit();
    return true;
  }

  function removeUrl(raw) {
    const url = normalize(raw);
    if (!url) return false;
    const current = load();
    const next = current.filter(row => row.url !== url);
    if (next.length === current.length) return false;
    save(next); emit();
    return true;
  }

  function clear() {
    if (!load().length) return false;
    save([]); emit();
    return true;
  }

  // All visible times are Beijing time, independent of the device time zone.
  const dayKey = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  function formatTime(value, reference = Date.now()) {
    const date = new Date(Number(value));
    if (Number.isNaN(date.getTime())) return '';
    const key = dayKey(date);
    const time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
    if (key === dayKey(new Date(reference))) return `今天 ${time}`;
    if (key === dayKey(new Date(reference - 86400000))) return `昨天 ${time}`;
    return `${key.slice(5)} ${time}`;
  }
  function formatFull(value) {
    const date = new Date(Number(value));
    if (Number.isNaN(date.getTime())) return '';
    const stamp = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
    return `${stamp} 北京时间`;
  }

  window.piClipboardHistory = Object.freeze({
    record, update, remove, removeUrl, clear,
    list: () => load().map(row => ({ ...row })),
    latest: () => { const row = load()[0]; return row ? { ...row } : null; },
    hostOf, pathOf, formatTime, formatFull,
    max: MAX, ttl: TTL,
  });
})();
