"use strict";
/*
 * Local-first layer. The session list and saved session bodies are shown from this device first;
 * the network only verifies and applies what changed. Nothing here grants access: every snapshot is
 * bound to the last login partition the server confirmed, is dropped on logout / revocation / any
 * 401 or 403, and is replaced as soon as the real server answer arrives.
 */
const LOCAL_FIRST_DB = 'pi-agent-local-first';
const LOCAL_FIRST_PARTITION = 'pi-agent:session-display:last-partition';
const LOCAL_FIRST_MAX_AGE = 30 * 86400000;
const LOCAL_FIRST_MAX_BYTES = 2 * 1024 * 1024;

/* ------------------------- P0: how long does "open" take? ------------------------- */
window.piOpenTiming = (() => {
  const KEY = 'pi-agent:open-timing', KEEP = 30;
  let current = null, timer = 0, hiddenAt = 0;
  function begin(kind) {
    flush();
    current = { at: Date.now(), kind, base: kind === 'cold' ? 0 : performance.now(), android: !!window.PiAndroid, marks: {} };
  }
  function read() { try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
  function flush() {
    clearTimeout(timer); timer = 0;
    if (!current || !Object.keys(current.marks).length) return;
    const rows = read().filter(r => r.at !== current.at);
    rows.push({ at: current.at, kind: current.kind, android: current.android, marks: current.marks });
    try { localStorage.setItem(KEY, JSON.stringify(rows.slice(-KEEP))); } catch { /* diagnostics only */ }
  }
  function mark(name) {
    if (!current) begin('cold');
    if (name in current.marks) return;
    current.marks[name] = Math.max(0, Math.round(performance.now() - current.base));
    clearTimeout(timer); timer = setTimeout(flush, 3000);
  }
  const median = values => { const s = values.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  function summary() {
    const rows = read(), out = {};
    for (const kind of ['cold', 'resume']) {
      const mine = rows.filter(r => r.kind === kind);
      out[kind] = { count: mine.length };
      for (const name of ['dir-cache', 'dir-net', 'body-cache', 'body-net']) out[kind][name] = median(mine.map(r => r.marks[name]).filter(Number.isFinite));
    }
    return out;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); flush(); }
    else if (hiddenAt && Date.now() - hiddenAt > 5000) { hiddenAt = 0; begin('resume'); }
  });
  addEventListener('pagehide', flush);
  begin('cold');
  return { mark, summary, rows: read, flush };
})();

/* --------------------- P1: the session list lives on this device --------------------- */
let localFirstDb = null, localFirstOpening = null;
function localFirstOpen() {
  if (localFirstDb) return Promise.resolve(localFirstDb);
  if (localFirstOpening) return localFirstOpening;
  localFirstOpening = new Promise(resolve => {
    let settled = false, request;
    const finish = db => { if (settled) { db?.close(); return; } settled = true; clearTimeout(timer); resolve(db); };
    const timer = setTimeout(() => finish(null), 1500);
    try {
      request = indexedDB.open(LOCAL_FIRST_DB, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('directory'); };
      request.onblocked = request.onerror = () => finish(null);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); if (localFirstDb === db) localFirstDb = null; };
        if (!settled) localFirstDb = db;
        finish(db);
      };
    } catch { finish(null); }
  }).finally(() => { localFirstOpening = null; });
  return localFirstOpening;
}
function localFirstTransaction(mode, work) {
  return localFirstOpen().then(db => !db ? null : new Promise(resolve => {
    let result = null;
    try {
      const tx = db.transaction('directory', mode);
      tx.oncomplete = () => resolve(result); tx.onerror = tx.onabort = () => resolve(null);
      work(tx.objectStore('directory'), value => { result = value; });
    } catch { resolve(null); }
  }));
}
function localFirstPartition() { try { return localStorage.getItem(LOCAL_FIRST_PARTITION) || null; } catch { return null; } }
function localFirstRememberPartition(partition) {
  try {
    if (typeof partition === 'string' && partition) localStorage.setItem(LOCAL_FIRST_PARTITION, partition);
    else localStorage.removeItem(LOCAL_FIRST_PARTITION);
  } catch { /* no storage: every open verifies first */ }
}
/**
 * Persisted authorization hints only: which login partition and which resources this device had
 * confirmed. Capability flags and control fields never reach the disk; every restore still asks the
 * server, and a different partition or a denial still takes the display away.
 */
function localFirstCacheAccess(value) {
  if (!value || value.schema !== 1 || typeof value.partition !== 'string' || !value.partition || value.partition.length > 200 || !Array.isArray(value.resources) || value.resources.length > 500) return null;
  const resources = [];
  for (const item of value.resources) {
    if (!item || !['rt', 'room'].includes(item.kind) || typeof item.id !== 'string' || !item.id || item.id.length > 100) return null;
    if (!resources.some(x => x.kind === item.kind && x.id === item.id)) resources.push({ kind: item.kind, id: item.id });
  }
  return { schema: 1, partition: value.partition, resources };
}
/** Display data of the unfiltered directory only; capability / authorization fields never reach the disk. */
function localFirstDirectoryProjection(dir) {
  if (!dir || !Array.isArray(dir.entries) || dir.nextCursor || dir.restricted) return null;
  const { cacheAccess, ...rest } = dir;
  const access = localFirstCacheAccess(cacheAccess);
  return access ? { ...rest, cacheAccess: access } : rest;
}
/*
 * The unfiltered list is read as a change feed: `cursor` is the server position this device holds and
 * `byId` the server-confirmed entries at that position (never the optimistic local edits on ui.rt.dir).
 * A delta only carries what changed plus the complete ordering, so a quiet list costs a few bytes.
 */
const localFirstFeed = { cursor: null, byId: new Map(), order: [], disabled: false };
function localFirstFeedReset() { localFirstFeed.cursor = null; localFirstFeed.byId = new Map(); localFirstFeed.order = []; }
const localFirstClone = value => (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)));
/** The base keeps its own copies: page code edits list entries in place, and that must never leak into what the server confirmed. */
function localFirstFeedAdopt(cursor, entries) {
  localFirstFeed.cursor = typeof cursor === 'string' && cursor ? cursor : null;
  localFirstFeed.byId = new Map(entries.map(e => [e.id, localFirstClone(e)]));
  localFirstFeed.order = entries.map(e => e.id);
}
function localFirstApplyFeed(r) {
  if (r?.plain) { localFirstFeedReset(); return r.plain; }
  if (!r || r.protocolVersion !== 1 || typeof r.cursor !== 'string' || !['snapshot', 'delta', 'unchanged'].includes(r.mode)) return null;
  const byId = r.mode === 'snapshot' ? new Map() : new Map(localFirstFeed.byId);
  for (const entry of r.changed || []) if (entry && typeof entry.id === 'string') byId.set(entry.id, entry);
  const order = r.order ?? localFirstFeed.order;
  if (!Array.isArray(order) || (r.mode !== 'snapshot' && !localFirstFeed.cursor)) return null;
  const entries = order.map(id => byId.get(id));
  if (entries.some(e => !e)) return null;
  localFirstFeedAdopt(r.cursor, entries);
  // The page gets its own copies, separate from the base kept above.
  return { ...(r.meta || {}), entries: entries.map(localFirstClone), ...(r.cacheAccess ? { cacheAccess: r.cacheAccess } : {}) };
}
/** Same result as the plain directory read; any trouble with the feed falls back to the plain read. */
async function localFirstReadDirectory(plainPath) {
  if (localFirstFeed.disabled) return api(plainPath);
  const qs = new URLSearchParams();
  if (plainPath.includes('cacheAccess=1')) qs.set('cacheAccess', '1');
  if (localFirstFeed.cursor) qs.set('cursor', localFirstFeed.cursor);
  let response;
  try { response = await api(`/api/session-directory/feed?${qs}`); }
  catch (e) {
    if (e?.status === 404) { localFirstFeed.disabled = true; return api(plainPath); }
    throw e;
  }
  const dir = localFirstApplyFeed(response);
  if (dir) return dir;
  localFirstFeedReset();
  return api(plainPath);
}
let localFirstSaveTimer = 0, localFirstPending = null;
function localFirstSaveDirectory(dir) {
  const partition = dir?.cacheAccess?.partition;
  const value = localFirstDirectoryProjection(dir);
  if (!partition || !value || typeof sessionDisk === 'undefined' || !sessionDisk.enabled) return;
  localFirstRememberPartition(partition);
  // Copied now: the page may edit its entries before the delayed write happens.
  localFirstPending = { partition, savedAt: Date.now(), dir: localFirstClone(value), feedCursor: localFirstFeed.cursor };
  clearTimeout(localFirstSaveTimer);
  localFirstSaveTimer = setTimeout(() => {
    const record = localFirstPending; localFirstPending = null;
    if (!record || JSON.stringify(record).length > LOCAL_FIRST_MAX_BYTES) return;
    void localFirstTransaction('readwrite', store => store.put(record, 'main'));
  }, 300);
}
/** The list the Android shell kept current while the app was closed (null in a browser or when none is saved). */
async function localFirstNativeSnapshot() {
  const shell = window.piAndroidShell;
  if (!shell?.call) return null;
  try {
    const result = await Promise.race([shell.call('sync.snapshot'), new Promise(resolve => setTimeout(() => resolve(null), 1200))]);
    if (!result || result.empty || !Number.isFinite(result.savedAt) || !localFirstDirectoryProjection(result.dir)) return null;
    return { savedAt: result.savedAt, dir: result.dir, feedCursor: typeof result.cursor === 'string' ? result.cursor : null };
  } catch { return null; }
}
async function localFirstLoadDirectory() {
  if (typeof sessionDisk === 'undefined' || !sessionDisk.enabled) return null;
  const partition = localFirstPartition();
  if (!partition) return null;
  const [saved, native] = await Promise.all([
    localFirstTransaction('readonly', (store, done) => { const r = store.get('main'); r.onsuccess = () => done(r.result); }),
    localFirstNativeSnapshot()
  ]);
  // The shell may have synced in the background since this page last saved; whichever is newer wins.
  // The authorization hints are the page's own (the shell never sees them), so keep the saved ones
  // when the newer list comes from the shell.
  const newer = native && (!saved || native.savedAt > saved.savedAt);
  const record = newer
    ? { ...native, partition, ...(saved?.partition === partition && saved?.dir?.cacheAccess ? { dir: { ...native.dir, cacheAccess: saved.dir.cacheAccess } } : {}) }
    : saved;
  if (!record || record.partition !== partition || !Number.isFinite(record.savedAt) || Date.now() - record.savedAt > LOCAL_FIRST_MAX_AGE) return null;
  return localFirstDirectoryProjection(record.dir) ? record : null;
}
function localFirstClear() {
  clearTimeout(localFirstSaveTimer); localFirstPending = null; localFirstFeedReset();
  localFirstRememberPartition(null);
  return localFirstTransaction('readwrite', store => store.clear());
}
/**
 * Show the saved list immediately. It is only a placeholder: `dirAt` stays 0 so every existing
 * freshness rule still reloads from the server, and the real answer replaces it.
 */
async function localFirstSeedDirectory(isCurrent) {
  const record = await localFirstLoadDirectory();
  if (!record || (isCurrent && !isCurrent()) || ui.rt.dir) return false;
  if (Array.isArray(record.dir.entries)) localFirstFeedAdopt(record.feedCursor, record.dir.entries);
  ui.rt.dir = record.dir; ui.rt.dirQuery = ''; ui.rt.dirRuntime = ''; ui.rt.dirAt = 0; ui.rt.dirFromLocal = true; ui.rt.dirError = '';
  if (Array.isArray(record.dir.entries)) { ui.rt.notifications = record.dir.entries; ui.rt.notificationsAt = record.dir.badgeObservedAt || record.savedAt; ui.rt.notificationsComplete = false; }
  window.piOpenTiming?.mark('dir-cache');
  if (typeof rtRenderListOnly === 'function') rtRenderListOnly();
  // Warm the saved bodies for exactly the resources this snapshot names, under the partition this
  // device already had confirmed. Provisional: no epoch move, and any different server answer wins.
  if (record.dir.cacheAccess && typeof sessionWarmDirectory === 'function') void sessionWarmDirectory(record.dir, () => true, { provisional: true }).catch(() => {});
  return true;
}
/**
 * The tail the Android shell kept current for one session while the app was closed, or null.
 * Only an address hint: the body is shown as unconfirmed and the server's restore still decides.
 */
async function localFirstNativeTail(resource) {
  const shell = window.piAndroidShell;
  if (!shell?.call || resource.kind !== 'rt') return null;
  let result;
  try { result = await Promise.race([shell.call('sync.tail', { sessionId: resource.id }), new Promise(resolve => setTimeout(() => resolve(null), 800))]); }
  catch { return null; }
  return localFirstNativeTailDisplay(resource, result);
}
function localFirstNativeTailDisplay(resource, result) {
  if (!result || result.found !== true) return null;
  if (typeof result.cursor !== 'string' || !result.cursor || result.cursor.length > 4096) return null;
  if (typeof result.epoch !== 'string' || !result.epoch || result.epoch.length > 200) return null;
  if (!Array.isArray(result.items) || result.items.length > 50) return null;
  const items = [];
  for (const item of result.items) {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 256 || !Number.isFinite(item.seq) || !Number.isSafeInteger(item.revision) || item.revision < 0 || !item.value || typeof item.value !== 'object') return null;
    items.push({ id: item.id, seq: item.seq, revision: item.revision, value: item.value });
  }
  const window = result.window && typeof result.window === 'object' && !Array.isArray(result.window) ? result.window : {};
  const summary = result.summary && typeof result.summary === 'object' ? result.summary : {};
  const projected = sessionDisplayProjection(resource, { items: items.map(x => x.value) });
  return {
    partition: null,
    fromNative: true,
    savedAt: Number.isFinite(result.savedAt) ? result.savedAt : 0,
    display: {
      items: projected.items,
      summary: { id: resource.id, title: typeof summary.title === 'string' ? summary.title : '', runtimeKind: typeof summary.runtimeKind === 'string' ? summary.runtimeKind : '' },
      window: { ...sessionDisplayFields(window, 'total firstSeq lastSeq hasMoreBefore hasMore coverage'), scope: 'latest' },
      reading: { atBottom: true }, expanded: {},
      sync: { resource: { kind: 'rt', id: resource.id }, epoch: result.epoch, cursor: result.cursor, queryWindow: { limit: 50 }, items, window }
    }
  };
}
