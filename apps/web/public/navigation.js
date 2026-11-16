"use strict";
/* Display-only bounded GET cache. Writes never enter this cache or retry path. */
const navigationReads = { cache: new Map(), flights: new Map(), bytes: 0, epoch: new Map(), maxEntries: 128, maxBytes: 16 * 1024 * 1024 };
function readCacheStats() { return { entries: navigationReads.cache.size, bytes: navigationReads.bytes, inFlight: navigationReads.flights.size, versionTokens: navigationReads.epoch.size }; }
function dropRead(key) {
  const entry = navigationReads.cache.get(key);
  if (entry) { navigationReads.bytes -= entry.bytes; navigationReads.cache.delete(key); }
}
function invalidateReads(predicate = () => true) {
  for (const key of new Set([...navigationReads.cache.keys(), ...navigationReads.flights.keys()])) {
    if (predicate(key)) { dropRead(key); if (navigationReads.flights.has(key)) navigationReads.epoch.set(key, (navigationReads.epoch.get(key) || 0) + 1); else navigationReads.epoch.delete(key); }
  }
}
function peekRead(path) {
  const entry = navigationReads.cache.get(path);
  if (!entry) return null;
  navigationReads.cache.delete(path); navigationReads.cache.set(path, entry);
  return { value: entry.value, stale: entry.expires <= Date.now() };
}
function shareRead(path, loader) {
  const running = navigationReads.flights.get(path);
  if (running) return running;
  const promise = Promise.resolve().then(loader).finally(() => {
    if (navigationReads.flights.get(path) === promise) navigationReads.flights.delete(path);
    // Keep invalidation token through readResource's continuation, then release it.
    setTimeout(() => { if (!navigationReads.flights.has(path)) navigationReads.epoch.delete(path); }, 0);
  });
  navigationReads.flights.set(path, promise);
  return promise;
}
async function readResource(path, { force = false, ttl = 30000, timeoutMs } = {}) {
  const hit = peekRead(path);
  if (!force && hit && !hit.stale) return hit.value;
  const epoch = navigationReads.epoch.get(path) || 0;
  const value = await api(path, timeoutMs ? { readTimeoutMs: timeoutMs } : {});
  if ((navigationReads.epoch.get(path) || 0) !== epoch) return value;
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes <= navigationReads.maxBytes) {
    dropRead(path);
    navigationReads.cache.set(path, { value, bytes, expires: Date.now() + ttl }); navigationReads.bytes += bytes;
    while (navigationReads.cache.size > navigationReads.maxEntries || navigationReads.bytes > navigationReads.maxBytes) dropRead(navigationReads.cache.keys().next().value);
  }
  return value;
}
// Opt-in, bounded and content-free: no object IDs, query parameters or payloads.
const navigationMetrics = [];
function navigationMark(stage, extra = {}) {
  if (!window.PI_AGENT_PERF) return;
  navigationMetrics.push({ stage, at: performance.now(), view: ui.view, generation: ui.routeGeneration || 0, ...extra });
  if (navigationMetrics.length > 600) navigationMetrics.shift();
}

/* V3.6: detached reading snapshots share one budget; GET cache never stores transcripts. */
const sessionSnapshots = { cache: new Map(), bytes: 0, maxEntries: 12, maxBytes: 10 * 1024 * 1024 };
function sessionSnapshotDrop(key) {
  const old = sessionSnapshots.cache.get(key);
  if (old) { sessionSnapshots.bytes -= old.bytes; sessionSnapshots.cache.delete(key); }
}
function sessionSnapshotPut(key, value) {
  sessionSnapshotDrop(key);
  try {
    const text = JSON.stringify(value), bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > sessionSnapshots.maxBytes) return;
    sessionSnapshots.cache.set(key, { value: JSON.parse(text), bytes, at: Date.now() }); sessionSnapshots.bytes += bytes;
    while (sessionSnapshots.cache.size > sessionSnapshots.maxEntries || sessionSnapshots.bytes > sessionSnapshots.maxBytes) sessionSnapshotDrop(sessionSnapshots.cache.keys().next().value);
  } catch { /* Snapshot failure must not prevent navigation or delete a draft. */ }
}
function sessionSnapshotGet(key) {
  const entry = sessionSnapshots.cache.get(key);
  if (!entry) return null;
  sessionSnapshots.cache.delete(key); sessionSnapshots.cache.set(key, entry);
  return entry.value;
}
function sessionSnapshotStats() { return { entries: sessionSnapshots.cache.size, bytes: sessionSnapshots.bytes }; }
function sessionCachesClear(storageAlreadyInvalidated = false) {
  void window.imageIntake?.invalidate();
  if (typeof noteOperationsInvalidate === 'function') noteOperationsInvalidate();
  if (typeof sessionSyncInvalidate === 'function') sessionSyncInvalidate();
  if (!storageAlreadyInvalidated && typeof sessionPersistenceInvalidate === 'function') void sessionPersistenceInvalidate();
  if (ui.rt) { ui.rt.diskDisplay = null; ui.rt.diskAuthorized = false; }
  if (ui.room) { ui.room.diskDisplay = null; ui.room.diskAuthorized = false; }
  sessionSnapshots.cache.clear(); sessionSnapshots.bytes = 0; invalidateReads();
  if (ui.rt) { rtStop(); ui.rt.gen++; ui.rt.view = null; ui.rt.events = []; ui.rt.messagesFor = null; ui.rt.statusConfirmed = false; }
  if (ui.room) { roomStop(); ui.room.generation++; ui.room.view = null; ui.room.statusConfirmed = false; ui.room.error = '访问状态已变化，请重新读取'; }
  if (ui.rt) ui.rt.viewError = '访问状态已变化，请重新读取';
  if (ui.view === 'rt' || ui.view === 'rt-room') {
    // Authentication invalidation also clears visible private DOM, including during IME composition.
    document.getElementById('main')?.replaceChildren(h('p', {class:'field-error',role:'alert'}, '访问状态已变化，请重新读取'));
    if (typeof renderMain === 'function') renderMain();
  }
}
function sessionResourceClear(resource) {
  if(typeof sessionSyncInvalidate==='function')sessionSyncInvalidate(resource);
  sessionSnapshotDrop(`${resource.kind}:${resource.id}`);
  invalidateReads(path=>path.startsWith((resource.kind==='rt'?'/api/runtime-sessions/':'/api/rooms/')+encodeURIComponent(resource.id)));
  const state=resource.kind==='rt'?ui.rt:ui.room;
  if(!state||state.id!==resource.id)return;
  state.diskDisplay=null;state.diskAuthorized=false;state.view=null;state.statusConfirmed=false;
  if(resource.kind==='rt'){rtStop();state.gen++;state.events=[];state.messagesFor=null;state.viewError='访问状态已变化，请重新读取';}
  else {roomStop();state.generation++;state.error='访问状态已变化，请重新读取';}
  if(ui.view===(resource.kind==='rt'?'rt':'rt-room')){
    document.getElementById('main')?.replaceChildren(h('p',{class:'field-error',role:'alert'},'访问状态已变化，请重新读取'));
    if(typeof renderMain==='function')renderMain();
  }
}
const sessionRefreshes = new Map();
function sessionRefreshOnce(key, work) {
  const old = sessionRefreshes.get(key);
  if (old) { old.next = work; return old.promise; }
  const entry = { next: null, promise: null };
  entry.promise = (async () => {
    let task = work;
    do { entry.next = null; await task(); task = entry.next; } while (task);
  })().finally(() => { if (sessionRefreshes.get(key) === entry) sessionRefreshes.delete(key); });
  sessionRefreshes.set(key, entry); return entry.promise;
}
function sessionReadingCapture(box, atBottom) {
  if (!box) return { atBottom, top: 0 };
  const rows = [...box.querySelectorAll('[data-room-seq], [data-ev-seq]')];
  const top = box.getBoundingClientRect().top;
  const row = rows.find(x => x.getBoundingClientRect().bottom > top);
  return { atBottom, top: box.scrollTop, seq: row ? Number(row.dataset.roomSeq || row.dataset.evSeq) : null, offset: row ? row.getBoundingClientRect().top - top : 0 };
}
function sessionReadingRestore(box, reading) {
  if (!box || !reading) return;
  if (reading.atBottom) { box.scrollTop = box.scrollHeight; return; }
  if (reading.seq == null) { box.scrollTop = reading.top || 0; return; }
  const rows = [...box.querySelectorAll('[data-room-seq], [data-ev-seq]')];
  const row = rows.find(x => Number(x.dataset.roomSeq || x.dataset.evSeq) === reading.seq) || rows.find(x => Number(x.dataset.roomSeq || x.dataset.evSeq) > reading.seq);
  if (row) box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top - (reading.offset || 0);
  else box.scrollTop = reading.top || 0;
}
function sessionReadingWatch(box, reading) {
  sessionReadingRestore(box, reading);
  let anchor = sessionReadingCapture(box, reading?.atBottom ?? true);
  box.addEventListener('scroll', () => {
    anchor = sessionReadingCapture(box, box.scrollHeight - box.scrollTop - box.clientHeight < 40);
    if (typeof sessionPersistenceReading === 'function') {
      const room = ui.view === 'rt-room', state = room ? ui.room : ui.rt;
      if (state?.id) sessionPersistenceReading({kind:room?'room':'rt',id:state.id},anchor,room?state.expanded:state.openFolds);
    }
  });
  // Images and lazily expanded replies can grow after the initial layout.
  const observer = new ResizeObserver(() => {
    if (!box.isConnected) { observer.disconnect(); return; }
    sessionReadingRestore(box, anchor);
  });
  for (const row of box.children) if (!row.classList.contains('session-pull')) observer.observe(row);
  requestAnimationFrame(() => { if (box.isConnected) sessionReadingRestore(box, anchor); });
}
/**
 * 消息区的下拉加载：列表已经滚到顶端、手指继续往下拖时提示「松开加载更早的消息」，
 * 松手超过阈值就调用 onLoad 取更早的一页。
 * PC 上用同一套提示和阈值：鼠标滚轮／触控板在顶端继续向上滚时同样撑开提示，
 * 滚动静止片刻等同于松手（滚轮没有抬手事件，用短延时判定手势结束）。
 * 提示在流内从 0 撑开（把消息往下推），不是浮在内容上的胶囊，不会盖住第一条消息。
 * 同时把浏览器的整页下拉刷新挡在消息区之外——不然在会话详情里下拉会刷新整个页面。
 * hasMore 只在「还有更早记录」时给提示；没有更早记录时也拦掉下拉刷新，但什么都不做。
 */
function sessionPullEarlier(box, opts) {
  const onLoad = opts && opts.onLoad;
  if (!box || typeof onLoad !== 'function') return box;
  const hasMore = () => (typeof opts.hasMore === 'function' ? !!opts.hasMore() : !!opts.hasMore);
  const THRESHOLD = 56, MAX = 46;
  const text = h('span', { class: 'session-pull-text' }, opts.idle || '下拉加载更早的消息');
  const hint = h('div', { class: 'session-pull', 'aria-hidden': 'true' },
    h('span', { class: 'session-pull-label' },
      h('span', { class: 'session-pull-arrow' }, '↓'),
      h('span', { class: 'session-pull-spinner' }), text));
  box.prepend(hint);
  let startY = null, dy = 0, pulling = false, busy = false;
  let wheelDy = 0, wheelTimer = null, wheelOn = false;
  const canLoad = () => !busy && hasMore();
  const setHeight = (px) => { hint.style.height = px > 0 ? `${px}px` : ''; };
  const setState = (state) => {
    const active = state !== 'idle' && hasMore();
    hint.classList.toggle('active', active);
    hint.classList.toggle('ready', active && state === 'ready');
    hint.classList.toggle('loading', active && state === 'loading');
    text.textContent = state === 'ready' ? (opts.ready || '松开加载更早的消息')
      : state === 'loading' ? (opts.loading || '正在加载更早的消息')
      : (opts.idle || '下拉加载更早的消息');
  };
  const atTop = () => box.scrollTop <= 1;
  // 触摸和滚轮不会同时进行；只有两边都没有手势时才收起提示，避免互相清掉。
  const settle = () => { if (startY === null && !wheelOn) { setHeight(0); setState('idle'); } };
  const load = () => {
    busy = true; setState('loading'); setHeight(MAX);
    Promise.resolve(onLoad()).catch(() => {}).finally(() => {
      busy = false; wheelOn = false; wheelDy = 0; clearTimeout(wheelTimer); wheelTimer = null;
      startY = null; dy = 0; pulling = false; setHeight(0); setState('idle');
    });
  };
  // 只有手势从顶端开始时才挂非 passive 的 touchmove：普通滚动仍然交给浏览器异步合成。
  const detach = () => { box.removeEventListener('touchmove', onMove); box.removeEventListener('touchend', onEnd); box.removeEventListener('touchcancel', onCancel); };
  const idle = () => { startY = null; dy = 0; pulling = false; settle(); };
  const onMove = (ev) => {
    if (ev.touches.length !== 1) { detach(); idle(); return; }
    dy = ev.touches[0].clientY - startY;
    if (dy <= 0 || !atTop()) { detach(); idle(); return; }
    // 已经在顶端还往下拖：拦下浏览器整页下拉刷新／橡皮筋，只由消息区处理。
    pulling = true;
    const can = canLoad();
    setHeight(can ? Math.min(dy, MAX) : 0);
    setState(can ? (dy >= THRESHOLD ? 'ready' : 'active') : 'idle');
    if (ev.cancelable) ev.preventDefault();
  };
  const onEnd = () => {
    const ready = pulling && dy >= THRESHOLD && canLoad();
    detach();
    if (!ready) { idle(); return; }
    idle(); load();
  };
  const onCancel = () => { detach(); idle(); };
  box.addEventListener('touchstart', (ev) => {
    if (busy || ev.touches.length !== 1 || !atTop()) return;
    startY = ev.touches[0].clientY; dy = 0; pulling = false;
    box.addEventListener('touchmove', onMove, { passive: false });
    box.addEventListener('touchend', onEnd);
    box.addEventListener('touchcancel', onCancel);
  }, { passive: true });
  // PC：已经在顶端还继续向上滚（deltaY < 0），累积到阈值后等滚动静止再加载，等同手机松手。
  const wheelIdle = () => { clearTimeout(wheelTimer); wheelTimer = null; wheelOn = false; wheelDy = 0; settle(); };
  const onWheel = (ev) => {
    if (busy) return;
    if (!atTop() || ev.deltaY >= 0) { if (wheelOn) wheelIdle(); return; }
    if (!canLoad()) return;
    wheelOn = true;
    const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? box.clientHeight : 1;
    wheelDy += -ev.deltaY * unit;
    setHeight(Math.min(wheelDy, MAX));
    setState(wheelDy >= THRESHOLD ? 'ready' : 'active');
    if (ev.cancelable) ev.preventDefault();
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      wheelTimer = null;
      if (wheelOn && wheelDy >= THRESHOLD && canLoad()) load(); else wheelIdle();
    }, 160);
  };
  box.addEventListener('wheel', onWheel, { passive: false });
  return box;
}
function sessionSyncNote(state, retry, id) {
  const failed = !!state.syncError;
  return h('p', { id, class: 'rt-banner warn', role: 'status', hidden: !state.syncing && !failed },
    failed ? '更新失败，当前为上次内容：' + state.syncError : state.syncing ? '正在同步…' : '',
    failed ? h('button', { class: 'btn small', onclick: retry }, '重试更新') : null);
}

let sessionAuthPrincipal;
function sessionAuthObserve(auth) {
  if (!auth || !Object.prototype.hasOwnProperty.call(auth, 'current')) return;
  const principal = auth.current || (auth.public ? 'public-anonymous' : 'local');
  if (sessionAuthPrincipal !== undefined && sessionAuthPrincipal !== principal) sessionCachesClear();
  sessionAuthPrincipal = principal;
}
window.addEventListener('pageshow', event => { if (event.persisted) sessionCachesClear(); });
