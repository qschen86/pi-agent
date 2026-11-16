"use strict";
/*
 * 故障诊断前端采集（docs/requirements/autonomous-diagnostics，V1.4 §3.3、§4）。
 *
 * - 事件：报错、请求失败、三个关键操作的开始 / 终态、生命周期。先进内存队列并镜像到 IndexedDB，
 *   每 10 秒发一批；页面隐藏时再用 keepalive 尽量发一次。服务端逐条确认后才删除，不确认就留着重发。
 * - 环形缓冲：最近 3 分钟、最多 300 条，每 5 秒落盘；出错、点上报、页面隐藏时立即落盘。
 *   刷新后 10 分钟内能读到上一页的缓冲，用来「报告上一页的问题」。
 * - 证据包：任意报错自动打包（同一指纹每分钟 1 个、每天 5 个），或用户点「刚才卡住了」手动打包。
 * - 不采集正文、标题、令牌、请求 / 响应体；URL 只留路由模板，错误文字先脱敏再截短。
 * 采集本身出任何问题都只是不记，不影响页面。localStorage「pi-telemetry」=off 可关闭。
 */
(() => {
  if (window.piTelemetry) return;
  const store = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const OFF = store(() => localStorage.getItem('pi-telemetry') === 'off', false);
  const RING_MS = 180_000, PREV_PAGE_MS = 600_000, RING_MAX = 300, Q_MAX = 200, Q_BYTES = 512 * 1024, Q_TTL = 86_400_000;
  const BATCH_MAX = 50, BATCH_BYTES = 60 * 1024, FLUSH_MS = 10_000, PERSIST_MS = 5_000, GAP_MS = 3_000;
  // 「一直没完成」的阈值必须长于正常读取链路：普通读取 15 秒、弱网 30 秒才放弃一次，
  // 会话列表这类读取超时后还会静默重试一次，排队时间也计入活跃时间。
  // 阈值太短会把「慢但最终加载出来」的读取误报成卡死，所以在读取预算之外再留一次重试和排队余量。
  const OP_TIMEOUT_MIN_MS = 45_000, OP_TIMEOUT_MAX_MS = 120_000;
  function opTimeoutMs() {
    const override = Number(window.PI_TELEMETRY_OP_TIMEOUT_MS);
    if (override > 0) return override;
    const link = store(() => window.piReadLink?.(), null);
    const explicit = Number(window.PI_AGENT_READ_TIMEOUT_MS);
    // 自校正后的弱网判定也算数：预算涨到 30 秒时，看门狗不能还用快网的阈值判「卡死」。
    const linkSlow = link?.slow === true || link?.observedSlow === true;
    const read = explicit > 0 ? explicit : linkSlow ? 30_000 : 15_000;
    return Math.min(OP_TIMEOUT_MAX_MS, Math.max(OP_TIMEOUT_MIN_MS, read * 2 + 10_000));
  }
  const BUNDLE_BYTES = 250 * 1024;
  const SUCCESS_CLASS = new Set(['op_start', 'op_success', 'request_slow', 'app_visibility_changed', 'app_resumed', 'page_ready', 'startup_stage', 'sw_update_detected', 'sw_controller_changed', 'report_opened', 'network_window']);
  const ENV = window.PI_TELEMETRY_ENV === 'test' ? 'test' : 'prod';

  const rid = () => {
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const nowIso = () => new Date().toISOString();
  const release = () => { const v = document.querySelector('meta[name="pi-web-release"]')?.content || ''; return /^[a-f0-9]{64}$/.test(v) ? v : null; };
  const sessionId = store(() => {
    let v = sessionStorage.getItem('pi-telemetry-session');
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(v || '')) { v = rid(); sessionStorage.setItem('pi-telemetry-session', v); }
    return v;
  }, rid());
  const pageId = window.piStartup?.id || rid();

  /* ------------------------------- 脱敏 ------------------------------- */
  function redact(text, max = 300) {
    let s = String(text ?? '');
    s = s.replace(/(https?:\/\/[^\s?#"']+|\/[\w\-./]*)[?#][^\s"')]*/g, '$1?…');
    s = s.replace(/\b(Bearer|Basic)(\s+)[^\s,;"']+/gi, '$1$2[redacted]');
    s = s.replace(/\b(token|apikey|api_key|access_token|refresh_token|password|passwd|secret|cookie|session|authorization)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi, '$1$2[redacted]');
    s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
    s = s.replace(/\b(?=[A-Za-z0-9_\-+/=]*\d)(?=[A-Za-z0-9_\-+/=]*[A-Za-z])[A-Za-z0-9_\-+/=]{24,}\b/g, '[id]');
    s = s.replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  // 栈只去掉查询串和邮箱：资源路径里的 digest 要留着，服务端靠它对上 release 的源码
  const redactStack = (stack) => String(stack || '').split('\n').slice(0, 14)
    .map(l => l.replace(/(https?:\/\/[^\s?#"')]+)[?#][^\s"':)]*/g, '$1').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]').slice(0, 240)).join('\n').slice(0, 2400);
  const shape = (path) => String(path || '').split(/[?#]/)[0].split('/').map(p => (p && (/^(?=.*\d)[A-Za-z0-9_-]{12,}$/.test(p) || /^[A-Za-z0-9_-]{24,}$/.test(p)) ? ':id' : p)).join('/').slice(0, 80);
  const routeNow = () => { const h = location.hash || '#/'; return '#' + shape(h.slice(1)); };
  const apiRoute = (path) => { const p = String(path || '').split('?')[0]; return p.startsWith('/api/') ? shape(p) : null; };

  function context() {
    const ua = navigator.userAgent || '', c = navigator.connection || {};
    const m = /(Edg|Chrome|CriOS|Firefox|FxiOS|Version)\/(\d+)/.exec(ua);
    const browser = m ? `${{ Edg: 'Edge', CriOS: 'Chrome', FxiOS: 'Firefox', Version: 'Safari' }[m[1]] || m[1]} ${m[2]}` : 'unknown';
    const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'unknown';
    const net = c.effectiveType || (c.type && ['wifi', 'cellular', 'ethernet'].includes(c.type) ? c.type : 'unknown');
    return {
      browser, os, net,
      entry: pageEntry(),
      standalone: store(() => matchMedia('(display-mode: standalone)').matches, false) || navigator.standalone === true,
      visible: document.visibilityState === 'visible', online: navigator.onLine !== false,
      viewport: innerWidth <= 760 ? 's' : innerWidth <= 1200 ? 'm' : 'l'
    };
  }

  /* ------------------------------- 状态 ------------------------------- */
  const T = {
    queue: [], ring: [], ops: new Map(), failed: [], vis: [], outbox: [],
    swRelease: null, paused: false, disabled: OFF, inflight: false, nextAt: 0, backoff: 0,
    dropped: 0, dirty: false, persistedAt: null, prev: null, fpSeen: new Map(), visible: document.visibilityState === 'visible',
    db: null, ready: null
  };
  const sizeOf = (x) => { try { return JSON.stringify(x).length; } catch { return 0; } };

  function emit(name, fields = {}) {
    const e = {
      schema: 'client-event@1', event_id: rid(), event_name: name, occurred_at: nowIso(),
      telemetry_session_id: sessionId, page_instance_id: pageId, page_release: release(), sw_release: T.swRelease,
      route_template: routeNow(), environment: ENV, context: context(), ...fields
    };
    for (const k of Object.keys(e)) if (e[k] === undefined || e[k] === null || e[k] === '') delete e[k];
    T.ring.push(e);
    const cutoff = Date.now() - RING_MS;
    while (T.ring.length > RING_MAX || (T.ring[0] && Date.parse(T.ring[0].occurred_at) < cutoff)) T.ring.shift();
    if (!T.disabled) { T.queue.push(e); trimQueue(); }
    T.dirty = true;
    return e;
  }
  function trimQueue() {
    let bytes = T.queue.reduce((n, e) => n + sizeOf(e), 0);
    while (T.queue.length > Q_MAX || bytes > Q_BYTES) {
      // 先淘汰成功类明细，没有了再淘汰最旧的
      let i = T.queue.findIndex(e => SUCCESS_CLASS.has(e.event_name));
      if (i < 0) i = 0;
      bytes -= sizeOf(T.queue[i]); T.queue.splice(i, 1); T.dropped++;
    }
  }

  /* ----------------------------- 持久化 ----------------------------- */
  function openDb() {
    if (T.ready) return T.ready;
    T.ready = new Promise((resolve) => {
      if (!window.indexedDB) return resolve(null);
      const req = store(() => indexedDB.open('pi-telemetry', 1), null);
      if (!req) return resolve(null);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => { T.db = req.result; resolve(T.db); };
      req.onerror = req.onblocked = () => resolve(null);
    });
    return T.ready;
  }
  function tx(mode, run) {
    return openDb().then(db => db ? new Promise((resolve) => {
      try {
        const t = db.transaction('kv', mode), s = t.objectStore('kv'), out = run(s);
        t.oncomplete = () => resolve(out?.result ?? true); t.onerror = t.onabort = () => resolve(null);
      } catch { resolve(null); }
    }) : null);
  }
  function persist(force = false, closed = false) {
    if (!force && !T.dirty) return Promise.resolve();
    T.dirty = false; const at = Date.now();
    const page = { pageInstance: pageId, savedAt: at, closed, release: release(), route: routeNow(), ring: T.ring.slice(-RING_MAX), state: snapshotState(), lastEventAt: T.ring.at(-1)?.occurred_at || null };
    return tx('readwrite', s => {
      s.put({ savedAt: at, closed, events: T.queue }, 'q:' + pageId);
      s.put(page, 'p:' + pageId);
      for (const b of T.outbox) { const { sending, ...copy } = b; s.put(copy, 'b:' + b.bundle_id); }
    }).then(ok => { if (ok) T.persistedAt = new Date(at).toISOString(); });
  }
  /* 启动：收养已经关掉的页面留下的队列与未发出的证据包；记下最近一个已关闭页面的缓冲（上一页）。 */
  // pagehide 时同步记下「这个页面已关闭」：卸载期间 IndexedDB 写入不一定能完成，localStorage 是同步的
  const CLOSED_KEY = 'pi-telemetry-closed';
  const closedPages = () => new Set(store(() => JSON.parse(localStorage.getItem(CLOSED_KEY) || '[]'), []));
  const markClosed = (closed) => store(() => {
    const ids = [...closedPages()].filter(id => id !== pageId).slice(-9);
    if (closed) ids.push(pageId);
    localStorage.setItem(CLOSED_KEY, JSON.stringify(ids));
  });
  function adopt() {
    const closed = closedPages();
    return tx('readwrite', s => {
      const req = s.openCursor(), stale = Date.now() - 20_000;
      req.onsuccess = () => {
        const cur = req.result; if (!cur) return;
        const key = String(cur.key), v = cur.value || {};
        // 已关闭（pagehide 时标记）或 20 秒没更新的页面才算不在了；活着的标签页每 5 秒更新一次
        const gone = v.closed || closed.has(v.pageInstance || key.slice(2)) || (v.savedAt || 0) < stale;
        if (key.startsWith('q:') && key !== 'q:' + pageId && gone) {
          const known = new Set(T.queue.map(e => e.event_id));
          for (const e of (v.events || [])) if (!known.has(e.event_id) && Date.now() - Date.parse(e.occurred_at) < Q_TTL) T.queue.unshift(e);
          cur.delete();
        } else if (key.startsWith('p:') && key !== 'p:' + pageId) {
          if ((v.savedAt || 0) < Date.now() - 86_400_000) cur.delete();
          else if (gone && Date.now() - v.savedAt < PREV_PAGE_MS && (!T.prev || v.savedAt > T.prev.savedAt)) T.prev = v;
        } else if (key.startsWith('b:') && !T.outbox.some(b => 'b:' + b.bundle_id === key)) T.outbox.push({ ...v, sending: false });
        cur.continue();
      };
    }).then(() => { trimQueue(); T.dirty = true; });
  }
  function clearAll() {
    networkReset();
    T.queue = []; T.outbox = []; T.ring = []; T.prev = null;
    return tx('readwrite', s => s.clear());
  }

  /* ------------------------------- 发送 ------------------------------- */
  const post = (path, body, keepalive) => fetch(path, { method: 'POST', keepalive: !!keepalive, cache: 'no-store', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body });
  function flush(keepalive = false) {
    if (T.disabled || T.paused || T.inflight) return Promise.resolve();
    if (!keepalive && Date.now() < T.nextAt) return Promise.resolve();
    T.queue = T.queue.filter(e => Date.now() - Date.parse(e.occurred_at) < Q_TTL);
    if (T.dropped) { const n = T.dropped; T.dropped = 0; emit('telemetry_dropped', { extra: { count: n } }); }
    const batch = []; let bytes = 20;
    for (const e of T.queue) { const n = sizeOf(e) + 1; if (batch.length >= BATCH_MAX || bytes + n > BATCH_BYTES) break; batch.push(e); bytes += n; }
    const work = [];
    if (batch.length) {
      T.inflight = true;
      work.push(post('/api/client-events', JSON.stringify({ events: batch }), keepalive).then(async res => {
        if (res.status === 401 || res.status === 403) { T.paused = true; return; }
        if (res.status === 404) { T.disabled = true; return; }
        if (res.status === 429) { T.nextAt = Date.now() + (Number(res.headers.get('retry-after')) || 60) * 1000; return; }
        if (res.status === 413) { const drop = new Set(batch.slice(0, Math.ceil(batch.length / 2)).map(e => e.event_id)); T.queue = T.queue.filter(e => !drop.has(e.event_id)); return; }
        if (!res.ok) throw new Error(String(res.status));
        const ack = new Set((await res.json()).accepted || []);
        T.queue = T.queue.filter(e => !ack.has(e.event_id)); T.backoff = 0; T.nextAt = 0; T.dirty = true;
      }).catch(() => { T.backoff = Math.min(300_000, (T.backoff || 5_000) * 2); T.nextAt = Date.now() + T.backoff * (0.5 + Math.random()); })
        .finally(() => { T.inflight = false; }));
    }
    for (const b of T.outbox.slice(0, keepalive ? 1 : 3)) if (!b.sending && (!keepalive || sizeOf(b) < 60_000)) work.push(sendBundle(b, keepalive));
    return Promise.all(work);
  }
  function sendBundle(b, keepalive = false) {
    if (T.disabled || T.paused) return Promise.resolve({ ok: false, reason: 'paused' });
    b.sending = true;
    const { sending, ...body } = b;
    return post('/api/client-events/bundle', JSON.stringify({ bundle: body }), keepalive).then(async res => {
      if (res.status === 401 || res.status === 403) { T.paused = true; return { ok: false, reason: 'auth' }; }
      if (res.status === 404) { T.disabled = true; return { ok: false, reason: 'off' }; }
      if (res.status === 413 || res.status === 400) { forgetBundle(b); return { ok: false, reason: 'invalid' }; }
      if (!res.ok) throw new Error(String(res.status));
      const r = await res.json();
      // 服务端已处理（存下、限流、不是触发事件）都删掉本地副本；只有手动包放不下时保留结果给页面提示
      forgetBundle(b);
      return r;
    }).catch(() => ({ ok: false, reason: 'network', queued: true })).finally(() => { b.sending = false; });
  }
  function forgetBundle(b) { T.outbox = T.outbox.filter(x => x !== b); void tx('readwrite', s => s.delete('b:' + b.bundle_id)); }

  /* ------------------------------ 证据包 ------------------------------ */
  function snapshotState() {
    return {
      route_template: routeNow(), page_release: release(), sw_release: T.swRelease,
      sw_controlled: !!navigator.serviceWorker?.controller, online: navigator.onLine !== false, visible: document.visibilityState === 'visible',
      ops: [...T.ops.values()].map(o => ({ component_id: o.component, attempt_id: o.attempt, active_ms: Math.round(o.active), wall_ms: Date.now() - o.startedAt, timed_out: o.timedOut })),
      failed_requests: T.failed.slice(-20), visibility: T.vis.slice(-20),
      read_budget: store(() => window.piReadBudget?.(), null), pending_writes: Number(window.piPwaWrites) || 0,
      // 读取各阶段用时（毫秒，全是有界数字，不带路径）：超时时能分清是卡在等响应头、正文传输，
      // 还是服务端处理（serverMs 来自响应的 Server-Timing）。故障 fd55cd4e2a9f76719 只有 totalMs，
      // 分不出"服务端慢"还是"正文没传完"，只能靠推测。
      read_timings: store(() => {
        const ms = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 86_400_000 ? Math.round(v) : null);
        return (window.piReadTimings?.() || []).slice(-20).map(r => ({
          kind: r.kind, status: r.status, queueMs: ms(r.queueMs) ?? 0, totalMs: ms(r.totalMs) ?? 0,
          timeoutMs: ms(r.timeoutMs), headersMs: ms(r.headersMs), bodyMs: ms(r.bodyMs), serverMs: ms(r.serverMs),
          link: r.link === 'slow' ? 'slow' : 'fast', timedOut: !!r.timedOut, aborted: !!r.aborted
        }));
      }, [])
    };
  }
  const localFp = (e) => [e?.component_id || '-', e?.error_type || e?.event_name || '-', (String(e?.stack || '').split('\n')[0] || '').replace(/\?[^:]*/, '').replace(/:\d+\)?$/, '') || e?.api_route || e?.route_template || '-'].join('|');
  function allowAuto(fp) {
    const last = T.fpSeen.get(fp);
    if (last && Date.now() - last < 60_000) return false;
    T.fpSeen.set(fp, Date.now());
    const key = 'pi-telemetry-fp:' + new Date().toISOString().slice(0, 10);
    const counts = store(() => JSON.parse(localStorage.getItem(key) || '{}'), {});
    if ((counts[fp] || 0) >= 5) return false;
    counts[fp] = (counts[fp] || 0) + 1;
    store(() => { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith('pi-telemetry-fp:') && k !== key) localStorage.removeItem(k); } localStorage.setItem(key, JSON.stringify(counts)); });
    return true;
  }
  // 只带出事前 RING_MS 内的记录（缓冲只在新事件进来时修剪，空闲一阵后可能还留着更早的）
  const recent = (ring, ref) => (ring || []).filter(e => !(Date.parse(e.occurred_at) < ref - RING_MS)).slice(-RING_MAX);
  function buildBundle(kind, trigger, opts = {}) {
    const src = opts.previous ? T.prev : null;
    const b = {
      schema: 'bundle@1', bundle_id: rid(), created_at: nowIso(), trigger: { kind, event_id: trigger?.event_id || null },
      note: opts.note ? redact(opts.note, 500) : undefined, page_source: src ? 'previous' : 'current',
      telemetry_session_id: sessionId, page_instance_id: src ? src.pageInstance : pageId,
      page_release: src ? src.release : release(), route_template: src ? src.route : routeNow(),
      events: recent(src ? src.ring : T.ring, src ? src.savedAt : Date.now()), state: src ? src.state : snapshotState(),
      completeness: src
        ? { persisted_at: new Date(src.savedAt).toISOString(), last_event_at: src.lastEventAt, partial: true, reason: 'previous-page' }
        : { persisted_at: T.persistedAt, partial: T.dropped > 0, dropped: T.dropped }
    };
    while (sizeOf(b) > BUNDLE_BYTES && b.events.length > 20) b.events = b.events.slice(Math.ceil(b.events.length / 4));
    return b;
  }
  function bundle(kind, trigger, opts = {}) {
    if (T.disabled) return Promise.resolve({ ok: false, reason: 'off' });
    if (kind === 'auto' && (ENV === 'test' || !allowAuto(localFp(trigger)))) return Promise.resolve({ ok: false, reason: 'rate-limited' });
    const b = buildBundle(kind, trigger, opts);
    // 先占住「发送中」：落盘期间定时 flush 不能抢先再发一次（服务端虽按 bundle_id 去重，也别重复上传）
    b.sending = true; T.outbox.push(b); T.dirty = true;
    return persist(true).then(() => { b.sending = false; return sendBundle(b); });
  }

  /* ------------------------------ 关键操作 ------------------------------ */
  let ticker = null;
  function tick(o, visible) {
    const t = performance.now(), d = t - o.lastTick; o.lastTick = t;
    if (visible && d <= GAP_MS) o.active += d;
  }
  // 只在有进行中的操作时每秒看一次（自我续约的 setTimeout，没有操作就不留任何定时器）
  function ensureTicker() {
    if (ticker || !T.ops.size) return;
    ticker = setTimeout(() => {
      ticker = null;
      for (const o of T.ops.values()) {
        tick(o, T.visible);
        if (!o.timedOut && o.active >= opTimeoutMs()) {
          o.timedOut = true;
          const e = emit('op_timeout', { component_id: o.component, operation_id: o.operation, attempt_id: o.attempt, result: 'timeout', error_type: 'timeout', active_ms: Math.round(o.active), wall_ms: Date.now() - o.startedAt });
          void persist(true); void bundle('auto', e); chip('加载一直没完成，已自动记录现场', '补充上报', () => openReport(), 'op-timeout');
        }
      }
      ensureTicker();
    }, 1000);
  }
  function op(component, opts = {}) {
    const o = { component, attempt: rid(), operation: opts.operationId || rid(), startedAt: Date.now(), active: 0, lastTick: performance.now(), timedOut: false, done: false };
    if (T.disabled) return { attempt: o.attempt, operation: o.operation, success() {}, failure() {}, cancel() {}, retry: () => op(component, { operationId: o.operation }) };
    T.ops.set(o.attempt, o);
    emit('op_start', { component_id: component, operation_id: o.operation, attempt_id: o.attempt });
    ensureTicker();
    const end = (name, result, fields = {}) => {
      if (o.done) return null; o.done = true; T.ops.delete(o.attempt); tick(o, T.visible);
      if (!T.ops.size && ticker) { clearTimeout(ticker); ticker = null; }
      // 超时提示只在还卡着的时候有意义：任何终态（成功恢复、失败、切走）都收掉，别让已经加载出来的页面继续显示「一直没完成」。
      if (o.timedOut) clearChip('op-timeout');
      return emit(name, { component_id: component, operation_id: o.operation, attempt_id: o.attempt, result, active_ms: Math.round(o.active), wall_ms: Date.now() - o.startedAt, ...fields });
    };
    return {
      attempt: o.attempt, operation: o.operation,
      success() { o.timedOut ? end('op_recovered', 'recovered') : end('op_success', 'success'); },
      failure(error, status) {
        const type = classify(status, error);
        if (type === 'abort') { end('op_cancelled', 'cancelled', { reason: 'abort' }); return; }
        const e = end('op_failure', 'failure', { error_type: type, status: status || undefined, error_detail: redact(error?.message || error || ''), stack: error?.stack ? redactStack(error.stack) : undefined });
        // 4xx（冲突、校验不过）、登录失效、离线是预期内的状态，只记事件不打包
        if (e && !['auth', 'offline', 'http_4xx'].includes(type)) { void persist(true); void bundle('auto', e); chip('出错了，已自动记录现场', '补充上报', () => openReport()); }
      },
      cancel(reason = 'navigate') { end('op_cancelled', 'cancelled', { reason: /^[a-z][a-z0-9-]{0,31}$/.test(reason) ? reason : 'other' }); },
      retry: () => op(component, { operationId: o.operation })
    };
  }
  function classify(status, error) {
    if (error?.name === 'AbortError') return 'abort';
    if (status === 401 || status === 403) return 'auth';
    if (status === 408 || /超时|timeout/i.test(error?.message || '')) return 'timeout';
    if (status >= 500) return 'http_5xx';
    if (status >= 400) return 'http_4xx';
    if (!status && navigator.onLine === false) return 'offline';
    if (!status && error) return error instanceof TypeError ? 'network' : 'js';
    return 'unknown';
  }

  /* ------------------------------ 请求 ------------------------------ */
  const slowReads={since:0,count:0,routes:new Set()};
  /** Successful slow GETs are sampled separately from failures, without bundles. */
  function sampleSlowRead(r){
    if(r.method!=='GET'||r.error||!Number.isFinite(r.ms)||r.ms<3000||document.visibilityState!=='visible'||navigator.onLine===false)return;
    const route=apiRoute(r.path);if(!route)return;
    const now=Date.now();
    if(now-slowReads.since>=60000){slowReads.since=now;slowReads.count=0;slowReads.routes.clear();}
    if(slowReads.count>=6||slowReads.routes.has(route))return;
    slowReads.count++;slowReads.routes.add(route);
    const timings={};
    for(const key of ['queue_ms','headers_ms','body_ms','decode_ms','server_ms','timeout_ms']){
      const value=r.timings?.[key];
      if(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=86400000)timings[key]=Math.round(value);
    }
    // A background read may finish during a foreground operation; don't infer
    // an operation association from the shared component name.
    emit('request_slow',{request_id:r.requestId,api_route:route,method:r.method,status:r.status,wall_ms:Math.round(r.ms),timings});
  }
  /** app.js calls this after every request. Aborted reads remain unreported. */
  function requestDone(r) {
    if (T.disabled || !r) return;
    if (r.aborted && !r.timedOut) return;
    const status = r.timedOut ? 408 : (r.status || 0);
    if (status && status < 400) { sampleSlowRead(r); return; }
    // 调用方声明为可预期的瞬时状态（如推送存储忙 503 + 短退避重试）：不进 request_failed 指纹与故障包。
    if (r.expected === true) return;
    const type = classify(status, r.error);
    if (type === 'abort') return;
    const e = emit('request_failed', { request_id: r.requestId, api_route: apiRoute(r.path), method: r.method || 'GET', status: status || undefined, error_type: type, wall_ms: Math.round(r.ms || 0), error_detail: redact(r.error?.message || ''), error_code: r.error?.code, error_cause: redact(r.error?.cause?.message || '') });
    T.failed.push({ at: e.occurred_at, request_id: r.requestId, api_route: e.api_route, status: status || null, error_type: type });
    if (T.failed.length > 20) T.failed.shift();
    if (type === 'http_5xx' || ((type === 'network' || type === 'timeout') && navigator.onLine !== false)) { void persist(true); void bundle('auto', e); }
  }

  /* ------------------------------ 网络窗口 ------------------------------ */
  // Completion-window metadata, not a packet trace. ResourceTiming excludes TLS bytes;
  // SSE payload bytes below are decoded data only, never counted again as resource bytes.
  function pageEntry() {
    try {
      const u = new URL(location.href), h = u.hostname.toLowerCase();
      if (['localhost','127.0.0.1','[::1]'].includes(h)) return 'local';
      if (u.origin === 'https://gui.harness.fund') return 'primary';
      if (u.origin === 'https://gui-backup.harness.fund:9443') return 'backup';
    } catch {}
    return 'unknown';
  }
  const NETWORK_WINDOW_MS = 30000;
  const networkKeys = ['api_started','api_dispatched','api_finished','api_failed','api_cancelled','api_timeouts','inflight_start','inflight_end','peak_inflight','network_start','network_end','peak_network','resource_count','zero_transfer_resources','transfer_bytes','encoded_bytes','decoded_bytes','headers_ms','queue_ms','sse_created','sse_opens','sse_reconnects','sse_errors','sse_messages','sse_data_bytes','sse_open','sse_connecting','sse_untracked'];
  let networkEpoch = 0, networkLive = 0, networkActive = 0, networkTimer = null, networkDirty = false, networkSince = Date.now(), networkAfter = 0;
  let networkCounters = Object.fromEntries(networkKeys.map(k => [k,0]));
  let networkStreams = new Set(), networkSeenStreams = new WeakSet();
  const networkEncoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
  function networkAdd(key, value = 1) {
    if (T.disabled || !Number.isFinite(value) || value < 0) return;
    if (!networkDirty && networkTimer === null) networkSince = Date.now();
    networkCounters[key] = Math.min(1e12, networkCounters[key] + Math.round(value));
    networkDirty = true;
    if (networkTimer === null) networkTimer = setTimeout(networkFlush, NETWORK_WINDOW_MS);
  }
  function networkObserved(path) {
    return typeof path === 'string' && path.startsWith('/api/') && !/^\/api\/(client-events|diagnostics)(?:[/?]|$)/.test(path);
  }
  function networkBegin(path) {
    if (T.disabled || !networkObserved(path)) return null;
    networkLive++;networkAdd('api_started');
    networkCounters.peak_inflight = Math.max(networkCounters.peak_inflight,networkLive);
    return {epoch:networkEpoch,done:false,dispatched:false};
  }
  function networkDispatched(token) {
    if (!token || token.done || token.epoch !== networkEpoch || token.dispatched) return;
    token.dispatched = true;networkActive++;networkAdd('api_dispatched');
    networkCounters.peak_network = Math.max(networkCounters.peak_network,networkActive);
  }
  function networkFinish(token, r = {}) {
    if (!token || token.done || token.epoch !== networkEpoch) return;
    token.done = true;networkLive = Math.max(0,networkLive-1);
    if (token.dispatched) networkActive = Math.max(0,networkActive-1);
    networkAdd('api_finished');
    if (r.aborted && !r.timedOut) networkAdd('api_cancelled');
    else if (r.error || r.timedOut || !r.status || r.status >= 400) networkAdd('api_failed');
    if (r.timedOut) networkAdd('api_timeouts');
    for (const key of ['queue_ms','headers_ms']) networkAdd(key,r.timings?.[key] || 0);
  }
  function networkSweepStreams() {
    let open=0,connecting=0;
    for (const r of networkStreams) {
      if (r.es.readyState === 2) networkStreams.delete(r);
      else if (r.es.readyState === 1) open++;
      else connecting++;
    }
    networkCounters.sse_open = open;networkCounters.sse_connecting = connecting;
  }
  function networkStream(es) {
    if (T.disabled || !es || networkSeenStreams.has(es)) return;
    networkSweepStreams();
    if (networkStreams.size >= 32) {networkAdd('sse_untracked');return;}
    networkSeenStreams.add(es);
    const record={es,opens:0,epoch:networkEpoch};networkStreams.add(record);networkAdd('sse_created');
    es.addEventListener('open',()=>{
      if (record.epoch !== networkEpoch) return;
      networkAdd('sse_opens');if (record.opens++) networkAdd('sse_reconnects');
    });
    es.addEventListener('error',()=>{if(record.epoch === networkEpoch)networkAdd('sse_errors');});
    // Do not wake an otherwise idle page solely to report heartbeat traffic.
    for (const name of ['message','ready','update','sync-notice','directory','session','profiles','event','lane-event','approvals','gap','comparison','room-message','member-status','delivery']) es.addEventListener(name,event=>{
      if (record.epoch !== networkEpoch) return;
      networkAdd('sse_messages');
      if (typeof event.data === 'string' && networkEncoder) networkAdd('sse_data_bytes',networkEncoder.encode(event.data).byteLength);
    });
  }
  function networkResources(entries) {
    for (const e of entries) {
      let u;try {u = new URL(e.name,location.href);} catch {continue;}
      if (u.origin !== location.origin || /^\/api\/(client-events|diagnostics)(?:\/|$)/.test(u.pathname) || u.pathname.endsWith('/stream')) continue;
      if (networkAfter && (!Number.isFinite(e.startTime) || !Number.isFinite(performance.timeOrigin) || performance.timeOrigin+e.startTime < networkAfter)) continue;
      networkAdd('resource_count');if (e.transferSize === 0) networkAdd('zero_transfer_resources');
      for (const [key,field] of [['transfer_bytes','transferSize'],['encoded_bytes','encodedBodySize'],['decoded_bytes','decodedBodySize']]) networkAdd(key,e[field] || 0);
    }
  }
  let networkObserver = null;
  try {
    if (typeof PerformanceObserver === 'function' && !T.disabled) {
      networkObserver = new PerformanceObserver(list=>{try{networkResources(list.getEntries());}catch{}});
      networkObserver.observe({type:'resource',buffered:true});
    }
  } catch {try {networkObserver?.disconnect();} catch {} networkObserver = null;}
  function networkFlush() {
    try {networkResources(networkObserver?.takeRecords?.() || []);} catch {}
    if (networkTimer !== null) clearTimeout(networkTimer);networkTimer = null;
    if (T.disabled) return;
    networkSweepStreams();
    if (networkDirty || networkLive) emit('network_window',{extra:{resource_timing:!!networkObserver,window_start:new Date(networkSince).toISOString(),window_ms:Math.max(0,Date.now()-networkSince),...networkCounters,inflight_end:networkLive,network_end:networkActive}});
    networkSince = Date.now();networkDirty = false;
    networkCounters = Object.fromEntries(networkKeys.map(k=>[k,0]));
    networkCounters.inflight_start = networkLive;networkCounters.peak_inflight = networkLive;
    networkCounters.network_start = networkActive;networkCounters.peak_network = networkActive;
    if (networkLive) networkTimer = setTimeout(networkFlush,NETWORK_WINDOW_MS);
  }
  function networkReset() {
    clearTimeout(networkTimer);networkTimer=null;networkEpoch++;networkLive=0;networkActive=0;networkDirty=false;
    networkSince=networkAfter=Date.now();networkCounters=Object.fromEntries(networkKeys.map(k=>[k,0]));
    networkStreams=new Set();networkSeenStreams=new WeakSet();
  }

  /* ------------------------------ 报错与生命周期 ------------------------------ */
  addEventListener('error', (ev) => {
    const t = ev.target;
    if (t && t !== window && (t.tagName === 'SCRIPT' || (t.tagName === 'LINK' && /stylesheet/.test(t.rel || '')))) {
      const url = store(() => new URL(t.src || t.href, location.href), null);
      if (!url || url.origin !== location.origin) return;
      const e = emit('resource_error', { error_type: 'resource', error_detail: `${t.tagName.toLowerCase()} ${shape(url.pathname)}` });
      void persist(true); void bundle('auto', e);
      return;
    }
    if (t && t !== window) return; // 图片等资源失败：用户内容，不算故障
    const msg = String(ev.message || '');
    if (/ResizeObserver loop/.test(msg)) return;
    const external = !ev.filename || (ev.filename && !ev.filename.startsWith(location.origin)) || msg === 'Script error.';
    const e = emit('js_error', { error_type: external ? 'external' : 'js', error_detail: redact(msg), stack: redactStack(ev.error?.stack || `at ${ev.filename || '?'}:${ev.lineno || 0}:${ev.colno || 0}`) });
    void persist(true);
    if (!external) void bundle('auto', e);
  }, true);
  addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason;
    if (r?.name === 'AbortError') return;
    const e = emit('unhandled_rejection', { error_type: 'promise', status: Number.isInteger(r?.status) ? r.status : undefined, error_detail: redact(r?.message || r), stack: r?.stack ? redactStack(r.stack) : undefined });
    void persist(true);
    if (!(r?.status === 401 || r?.status === 403)) void bundle('auto', e);
  });
  document.addEventListener('visibilitychange', () => {
    networkFlush();
    const visible = document.visibilityState === 'visible';
    for (const o of T.ops.values()) { tick(o, T.visible); o.lastTick = performance.now(); }
    T.visible = visible;
    emit('app_visibility_changed', { extra: { visible } });
    T.vis.push({ at: nowIso(), visible }); if (T.vis.length > 20) T.vis.shift();
    if (!visible) { void persist(true); void flush(true); }
  });
  addEventListener('pageshow', (ev) => { if (ev.persisted) emit('app_resumed', { reason: 'bfcache' }); });
  document.addEventListener('resume', () => emit('app_resumed', { reason: 'resume' }));
  addEventListener('pagehide', (ev) => { networkFlush(); if (!ev.persisted) markClosed(true); void persist(true, !ev.persisted); void flush(true); });
  // 从往返缓存恢复：页面还活着，取消「已关闭」标记
  addEventListener('pageshow', (ev) => { if (ev.persisted) { markClosed(false); void persist(true, false); } });
  addEventListener('online', () => { T.nextAt = 0; void flush(); });
  document.addEventListener('gui-auth-required', () => { T.paused = true; });
  document.addEventListener('gui-auth-restored', () => { T.paused = false; T.nextAt = 0; void flush(); });
  addEventListener('load', () => {
    const nav = performance.getEntriesByType?.('navigation')?.[0];
    emit('page_ready', { extra: { dcl_ms: Math.round(nav?.domContentLoadedEventEnd || performance.now()) } });
  }, { once: true });

  // Reuse the existing durable telemetry queue and page ID; no startup request fan-out.
  const startup = detail => emit('startup_stage', { component_id: 'app', route_template: ({single:'#/rt/:id',room:'#/rt/room/:id',list:'#/rt',other:'#/other'})[detail.extra.target_kind] || '#/other', reason: detail.stage, wall_ms: detail.ms, extra: detail.extra });
  for (const detail of window.piStartup?.events || []) startup(detail);
  window.addEventListener('pi-startup-stage', event => startup(event.detail));

  /* Service Worker：取得控制本页的 worker 的 release；更新与控制权变化记成上下文事件。 */
  function swIdentity() {
    const ctl = navigator.serviceWorker?.controller;
    if (!ctl || typeof MessageChannel === 'undefined') { T.swRelease = null; return; }
    const ch = new MessageChannel(), timer = setTimeout(() => { T.swRelease = null; ch.port1.close(); }, 2000);
    ch.port1.onmessage = (ev) => { clearTimeout(timer); const v = ev.data?.release; T.swRelease = /^[a-f0-9]{64}$/.test(v || '') ? v : null; ch.port1.close(); };
    store(() => ctl.postMessage({ type: 'release-identity' }, [ch.port2]));
  }
  if (navigator.serviceWorker) {
    swIdentity();
    navigator.serviceWorker.addEventListener('controllerchange', () => { emit('sw_controller_changed'); swIdentity(); });
    navigator.serviceWorker.getRegistration?.().then(reg => reg?.addEventListener('updatefound', () => emit('sw_update_detected'))).catch(() => {});
  }

  /* ------------------------------ 身份 ------------------------------ */
  /** 登录身份变化时清空旧身份留下的队列与证据包，不用新身份补发（app.js 读到 /api/auth/sessions 时调用）。 */
  function setIdentity(id) {
    if (typeof id !== 'string' || !id) return;
    const prev = store(() => localStorage.getItem('pi-telemetry-owner'), null);
    if (prev && prev !== id) void clearAll();
    store(() => localStorage.setItem('pi-telemetry-owner', id));
  }

  /* ------------------------------ 界面 ------------------------------ */
  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (v === undefined || v === null || v === false) continue; if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : String(v)); }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return n;
  }
  let chipTimer = null;
  function chip(text, actionLabel, action, kind) {
    if (!document.body) return;
    document.querySelector('.pi-telemetry-chip')?.remove(); clearTimeout(chipTimer);
    const box = el('div', { class: 'pi-telemetry-chip', role: 'status', ...(kind ? { 'data-kind': kind } : {}) }, el('span', {}, text),
      actionLabel ? el('button', { type: 'button', class: 'btn small', onclick: () => { box.remove(); action(); } }, actionLabel) : null,
      el('button', { type: 'button', class: 'pi-telemetry-chip-close', 'aria-label': '关闭', onclick: () => box.remove() }, '×'));
    document.body.append(box);
    chipTimer = setTimeout(() => box.remove(), 10_000);
  }
  // 只收自己那类提示：报错提示不会被随之而来的 recovered 顺手关掉。
  function clearChip(kind) {
    const box = document.querySelector('.pi-telemetry-chip');
    if (!box || (kind && box.getAttribute('data-kind') !== kind)) return;
    clearTimeout(chipTimer); box.remove();
  }
  function openReport() {
    if (!document.body) return;
    document.querySelector('.pi-report-dialog')?.remove();
    emit('report_opened');
    const prev = T.prev;
    const prevLabel = prev ? `刷新前的上一页（${new Date(prev.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}）` : null;
    const note = el('textarea', { rows: 3, maxlength: 500, placeholder: '补充说明（可选）：在做什么、卡在哪里' });
    const status = el('p', { class: 'muted small pi-report-status', role: 'status' });
    const choice = prev ? el('fieldset', { class: 'pi-report-source' }, el('legend', {}, '报告哪一页'),
      el('label', {}, el('input', { type: 'radio', name: 'pi-report-src', value: 'current', checked: true }), ' 当前页面'),
      el('label', {}, el('input', { type: 'radio', name: 'pi-report-src', value: 'previous' }), ` ${prevLabel}`)) : null;
    const submit = el('button', { type: 'submit', class: 'btn primary' }, '上报');
    const dlg = el('dialog', { class: 'pi-report-dialog', 'aria-labelledby': 'pi-report-title' },
      el('form', { method: 'dialog', onsubmit: async (ev) => {
        ev.preventDefault(); submit.disabled = true; status.textContent = '正在上报…';
        const previous = !!dlg.querySelector('input[value="previous"]')?.checked;
        const r = await bundle('manual', null, { note: note.value.trim(), previous });
        if (r?.ok) { status.textContent = r.note === 'queued' ? '已上报。AI 分析后会在待办（平台 / debug）里生成一条' : '已上报现场'; setTimeout(() => dlg.close(), 1800); }
        else if (r?.queued) { status.textContent = '网络暂时不通，已保存在本机，联网后自动上报'; setTimeout(() => dlg.close(), 1800); }
        else if (r?.reason === 'capacity') { status.textContent = '诊断存储已满，这次没能保存，请稍后再试'; submit.disabled = false; }
        else { status.textContent = '没能上报（' + (r?.reason || '未知原因') + '）'; submit.disabled = false; }
      } },
      el('h2', { id: 'pi-report-title' }, '刚才卡住了？'),
      el('p', { class: 'muted small' }, '会把最近 3 分钟的页面记录和对应的服务端日志一起打包保存，用来排查问题。不包含聊天内容。'),
      choice, note, status,
      el('div', { class: 'pi-report-actions' }, el('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, '取消'), submit)));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    note.focus();
  }

  /* ------------------------------ 启动 ------------------------------ */
  if (!T.disabled) {
    void adopt().then(() => {
      // 上一页在关掉前有失败、超时或一直没完成的操作：提示可以报告
      const p = T.prev;
      // 缓冲最多落后 5 秒，所以「一直没完成」按活跃 3 秒算
      if (p && ((p.state?.ops || []).some(o => o.active_ms >= 3000) || (p.ring || []).some(e => /^(op_failure|op_timeout|js_error|request_failed)$/.test(e.event_name) && Date.parse(e.occurred_at) > p.savedAt - 120_000))) {
        const show = () => chip('上一页好像出了问题', '报告上一页', () => openReport());
        if (document.body) show(); else addEventListener('DOMContentLoaded', show, { once: true });
      }
      void flush();
    });
    let ticks = 0;
    setInterval(() => { void persist(); if (++ticks % Math.round(FLUSH_MS / PERSIST_MS) === 0) void flush(); }, PERSIST_MS);
  }

  window.piTelemetry = {
    requestBegin: networkBegin, requestDispatched: networkDispatched, requestFinished: networkFinish, trackStream: networkStream,
    op, opTimeoutMs, requestDone, setIdentity, openReport, flush, persist,
    requestId: rid, event: (name, fields) => (SUCCESS_CLASS.has(name) ? emit(name, fields) : null),
    get state() { return T; }
  };
})();
