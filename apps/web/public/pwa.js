// Worker recovery never reloads a page or removes registrations/caches used by Push.
(() => {
  const state = { phase: 'idle', failure: 0 }, watched = new WeakSet();
  // After a failure the manager heals itself with a few bounded, delayed attempts, so a
  // transient error resolves without the user having to notice or click. A restored network
  // retries at once; once the budget is spent the explicit retry button remains the only path.
  // 预算要盖住一次后端重启：10-24 一次重启 503 了约 40 秒，旧预算（5+10+20=35 秒）刚好耗尽，
  // 左下角就留下了「离线重试」。现在共约 110 秒；自动重试还没用完时不显示按钮。
  const AUTO_DELAYS = [5000, 15000, 30000, 60000];
  let pending = null, epoch = 0, deadline, trackedWorker, autoTimer = null, autoStep = 0, background = false, readyAt = 0;
  // 同一次故障里「刚 ready 又失败」（新 worker 安装被拒时，旧 worker 仍在，会先报 ready）不算恢复，
  // 不重置预算；ready 稳定超过这个时长后的失败才算新的一次故障。
  const INCIDENT_GAP_MS = 120000;
  const publish = (phase, quiet) => { if (phase === 'failed' && state.phase !== 'failed' && !quiet) state.failure++; state.phase = phase; window.dispatchEvent(new Event('pi-pwa-worker')); };
  const cancelAuto = () => { clearTimeout(autoTimer); autoTimer = null; };
  function scheduleAuto() {
    cancelAuto();
    if (state.phase !== 'failed' || autoStep >= AUTO_DELAYS.length) return;
    // Offline recovery is event-driven; don't spend the budget on attempts that cannot reach the network.
    if (navigator.onLine === false) return;
    autoTimer = setTimeout(() => { autoTimer = null; if (state.phase === 'failed') void retry(true); }, AUTO_DELAYS[autoStep++]);
  }
  const failed = quiet => {
    clearTimeout(deadline);
    if (state.phase === 'failed') return; // one failure per attempt: never double-spend the budget
    if (!quiet || (readyAt && Date.now() - readyAt > INCIDENT_GAP_MS)) autoStep = 0;
    publish('failed', quiet);
    scheduleAuto();
    window.dispatchEvent(new Event('pi-pwa-worker')); // 自动重试排上/用完后再画一次
  };
  const ready = () => { clearTimeout(deadline); cancelAuto(); readyAt = Date.now(); publish('ready', true); };
  function observe(registration) {
    if (!watched.has(registration)) {
      watched.add(registration);
      registration.addEventListener('updatefound', () => follow(registration));
    }
    follow(registration);
  }
  // Chromium 偶发把装好的新 worker 一直挂在 waiting：sw 已在 install 里 skipWaiting，这里再显式要求一次。
  // 这样离线功能自己恢复，不必等 30 秒判失败、再由用户点「重试离线功能」。
  const nudged = new WeakSet();
  function nudgeWaiting(worker, registration) {
    if (nudged.has(worker)) return;
    nudged.add(worker);
    setTimeout(() => {
      if (trackedWorker !== worker || worker.state === 'activated' || worker.state === 'redundant') return;
      if (registration.waiting !== worker && registration.installing !== worker) return;
      try { worker.postMessage('pi-skip-waiting'); } catch { /* 换了新 worker：下一轮 follow 会再判断 */ }
    }, 2000);
  }
  function follow(registration) {
    const worker = registration.installing || registration.waiting || (registration.active?.state === 'activating' ? registration.active : null);
    if (!worker) { if (registration.active?.state === 'activated') { trackedWorker = null; ready(); } return; }
    if (trackedWorker === worker) return;
    trackedWorker = worker;
    publish('working', true); clearTimeout(deadline);
    deadline = setTimeout(() => failed(background), 30000);
    const changed = () => {
      if (trackedWorker !== worker) return;
      if (worker.state === 'redundant') failed(background);
      else if (worker.state === 'activated') ready();
      else if (worker.state === 'installed') nudgeWaiting(worker, registration);
    };
    worker.addEventListener('statechange', changed); changed();
  }
  function retry(isBackground = false) {
    if (!('serviceWorker' in navigator)) { publish('unsupported'); return Promise.resolve(false); }
    if (pending) return pending;
    background = isBackground;
    if (!isBackground) { cancelAuto(); autoStep = 0; }
    const attempt = ++epoch; publish('working', isBackground);
    clearTimeout(deadline); deadline = setTimeout(() => failed(isBackground), 30000);
    pending = (async () => {
      let timeout;
      try {
        const work = (async () => {
          const registration = await navigator.serviceWorker.register("/sw.js");
          if (attempt !== epoch) return;
          observe(registration);
          await registration.update();
          if (attempt === epoch) observe(registration);
        })();
        await Promise.race([work, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('worker timeout')), 30000); })]);
        return state.phase !== 'failed';
      } catch { if (attempt === epoch) { epoch++; failed(isBackground); } return false; }
      finally { clearTimeout(timeout); pending = null; if (state.phase === 'failed') window.dispatchEvent(new Event('pi-pwa-worker')); }
    })();
    return pending;
  }
  // Waits for an in-flight install/activation so a refresh never races the worker handover.
  async function settle(ms) {
    try {
      const registration = await navigator.serviceWorker?.getRegistration?.();
      const worker = registration && (registration.installing || registration.waiting || (registration.active?.state === 'activating' ? registration.active : null));
      if (!worker) return true;
      return await new Promise(resolve => {
        const done = ok => { clearTimeout(timer); worker.removeEventListener('statechange', changed); resolve(ok); };
        const changed = () => { if (worker.state === 'activated' || worker.state === 'redundant') done(true); };
        const timer = setTimeout(() => done(false), ms);
        worker.addEventListener('statechange', changed); changed();
      });
    } catch { return false; }
  }
  // exhausted: 自动重试用完且没有排队中的重试——这时才值得让用户看到「离线重试」。
  window.piPwaWorker = { retry, settle, state: () => ({ ...state, auto: autoStep, pending: !!autoTimer || !!pending, exhausted: autoStep >= AUTO_DELAYS.length && !autoTimer && !pending }) };
  window.addEventListener('load', () => void retry(), { once: true });
  // A network that comes back is a fresh chance: restart the budget and try now instead of waiting.
  window.addEventListener('online', () => { if (state.phase === 'failed') { cancelAuto(); autoStep = 0; void retry(true); } });
  // 回到页面时，用完预算的失败再悄悄试一次（不重置预算：仍失败就照旧显示按钮）。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.phase === 'failed' && !autoTimer && autoStep >= AUTO_DELAYS.length) void retry(true);
  });
})();

// Refresh belongs to this document. Other tabs receive version identifiers only.
(() => {
  const current = document.querySelector('meta[name="pi-web-release"]')?.content;
  if (!/^[a-f0-9]{64}$/.test(current || '')) return;
  const UPDATED_KEY = 'pi-pwa-updated', STALL_MS = 12000, WORKER_WAIT_MS = 5000;
  // applying: '' | confirming | preparing | worker | reloading | stalled
  // candidate: 服务器上比当前页面新的版本（只有版本信息，代码要等用户点「更新页面」才下载）
  let candidate = null, checking = false, applying = '', note = '', dismissed = null, lastCheck = 0, channel, composing = false, dismissedWorker = 0, workerRetried = false, stallTimer;
  // 原生壳（Android WebView）里不等用户点「更新页面」：新版本在后台自己下好，
  // 等下次切换前端模块（路由变化）或从后台回来时再用新代码刷新，并用一条 Tip 告诉用户有更新。
  const native = !!window.piAndroidShell?.available;
  // 静默升级默认开启（原生壳固定开启）。浏览器里可以用 localStorage['pi-pwa-silent-update']='off' 退回「点了才下载」的手动流程。
  const silent = native || (() => { try { return localStorage.getItem('pi-pwa-silent-update') !== 'off'; } catch { return true; } })();
  // latest: 最近一次从服务器查到的 release 及时间；inspecting: 打开面板时的实时查询；job: 点「更新页面」后的进度
  let latest = null, inspecting = false, inspectFailed = false, upToDate = false, job = null, switched = false;
  const valid = release => /^[a-f0-9]{64}$/.test(release || '');

  /* ---------- What prevents a refresh, and where the user can resolve it ---------- */
  const title = id => { try { return typeof rtDirEntry === 'function' ? rtDirEntry(id)?.title || '' : ''; } catch { return ''; } };
  const sessionTarget = id => id === 'new' ? { label: '新建会话', hash: '#/rt/new' } : { label: title(id) || '会话', hash: '#/rt/' + encodeURIComponent(id) };
  const roomTarget = id => id === 'new' ? { label: '新建群聊', hash: '#/rt/room/new' } : { label: title(id) || '群聊', hash: '#/rt/room/' + encodeURIComponent(id) };
  function blockers() {
    if (composing) return { reason: '正在输入，请完成后更新', targets: [] };
    const s = typeof ui === 'undefined' ? {} : ui, drafts = typeof rtImageDrafts === 'undefined' ? {} : rtImageDrafts, outboxSid = s.rt?.outboxEdit?.sid;
    const targets = [], seen = new Set(), add = t => { if (t && !seen.has(t.hash)) { seen.add(t.hash); targets.push(t); } };
    const draftTarget = key => key.startsWith('outbox:') ? (outboxSid ? sessionTarget(outboxSid) : null) : sessionTarget(key);
    const result = reason => ({ reason, targets });
    const pendingImages = Object.entries(drafts).filter(([, d]) => d?.pending);
    const unaccepted = Object.entries(s.rt?.outgoing || {}).filter(([, v]) => !v?.accepted);
    if (window.piPwaWrites || s.actionPending || s.notesBusy || s.room?.busy || s.rt?.outboxBusy || unaccepted.length || pendingImages.length) {
      unaccepted.forEach(([id]) => add(sessionTarget(id))); pendingImages.forEach(([k]) => add(draftTarget(k)));
      return result('正在提交或等待确认，请完成后更新');
    }
    const uploading = Object.entries(drafts).filter(([, d]) => d?.images?.some(i => i.state === 'uploading'));
    if (uploading.length || s.notesImages?.some(i => i.state === 'uploading')) {
      uploading.forEach(([k]) => add(draftTarget(k))); if (s.notesImages?.length) add({ label: '待办', hash: '#/notes' });
      return result('图片正在上传，请完成后更新');
    }
    for (const [id, v] of Object.entries(s.rt?.drafts || {})) if (String(v).trim()) add(sessionTarget(id));
    for (const [k, d] of Object.entries(drafts)) if (d?.text?.trim() || d?.images?.length) add(draftTarget(k));
    if (s.rt?.form?.prompt?.trim()) add(sessionTarget('new'));
    if (s.rt?.outboxEdit) add(outboxSid ? sessionTarget(outboxSid) : null);
    let unlocated = !!(s.rt?.outboxEdit && !outboxSid) || Object.keys(drafts).some(k => k.startsWith('outbox:') && !outboxSid && (drafts[k]?.text?.trim() || drafts[k]?.images?.length));
    if (s.room?.draft?.text?.trim() || s.room?.draft?.quotes?.length) { if (s.room.id) add(roomTarget(s.room.id)); else unlocated = true; }
    if (s.room?.new?.prompt?.trim()) add(roomTarget('new'));
    if (s.notesDraft?.trim() || s.notesImages?.length || s.notesEdit) add({ label: '待办', hash: '#/notes' });
    let rooms = false;
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i); if (!key?.startsWith('pi-room-draft:')) continue;
        const d = JSON.parse(sessionStorage.getItem(key)); if (d?.text?.trim() || d?.quotes?.length) { rooms = true; add(roomTarget(key.slice('pi-room-draft:'.length))); }
      }
    } catch { return result('无法核对草稿，请处理后手动刷新'); }
    // Edits that cannot be located (no session/room id) still block.
    if (!targets.length && !unlocated) return result('');
    if (rooms && targets.every(t => t.hash.startsWith('#/rt/room/'))) return result('有群聊草稿，请先发送或清空');
    return result(targets.length ? `有 ${targets.length} 处未发送的草稿或编辑，请先发送或清空` : '有未处理的草稿或编辑，请先完成或清空');
  }
  const protection = () => blockers().reason;
  /* ---------- 后台静默升级：后台下载 + 下次切换页面 / 回到前台时生效（原生壳和浏览器一样） ---------- */
  let nativePrep = '', lastTip = '', lastTipAt = 0;
  function tip(text, tone) {
    // 同一条提示一分钟内不重复：定期检查每次都会走到这里，别把提示刷成噪音。
    if (text === lastTip && Date.now() - lastTipAt < 60000) return;
    lastTip = text; lastTipAt = Date.now();
    window.piToast(text, { tone });
  }
  // 当前页面已经在用的文件（内容地址相同）不用再下：只有真正变化的文件才需要下载并核对。
  const downloaded = m => !!m && m.assets.every(u => ownAssets.has(u) || verifiedAssets.has(u));
  // 已经下好、但当前页面有未发送的内容：这时才需要用户看一眼（面板里能直接前往草稿位置）。
  // 静默升级顺利时不出现任何入口；被草稿挡住、或后台没下成（要让人能手动点更新）才露出「有更新」。
  const needsAttention = () => !!candidate && candidate.release !== dismissed && !applying && (!silent || !!protection() || (!downloaded(candidate) && nativePrep !== candidate.release));
  // 后台把代码下完并逐个核对；失败就等下一轮检查再说，不打扰用户。
  async function prepareInBackground(m) {
    if (!silent || !m || nativePrep === m.release || downloaded(m)) return;
    nativePrep = m.release;
    tip(`有最新更新，正在后台下载（${fmtVersion(m.version) || '新版本'}）`);
    try {
      if (await prepare(m)) tip('有最新更新，已准备好，切换页面后生效');
    } catch (error) {
      failure(error, '');
      tip('有最新更新，后台下载没完成，稍后会再试', 'warn');
    } finally { if (!downloaded(candidate)) nativePrep = ''; settleView(); }
  }
  // 下一次「刷新这个前端模块」的机会：切换路由或从后台回到前台。有草稿 / 提交中就先不动。
  function applyOnNextModule() {
    if (!silent || applying || !candidate || !downloaded(candidate)) return false;
    const blocked = protection();
    if (blocked) { tip(blocked + '；处理完切换页面时就会用上新版本', 'warn'); return false; }
    void apply(); return true;
  }

  /* ---------- Panel ---------- */
  const make = (tag, text, cls) => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
  const button = (text, cls) => { const b = make('button', text, cls); b.type = 'button'; return b; };
  const trigger = button('有更新', 'btn small pwa-update-trigger'); trigger.hidden = true;
  trigger.setAttribute('aria-label', '有新版本，查看更新'); trigger.setAttribute('popovertarget', 'pwa-update-panel');
  const panel = make('aside', '', 'pwa-update-panel'); panel.id = 'pwa-update-panel'; panel.setAttribute('popover', 'auto'); panel.setAttribute('aria-label', '页面更新');
  const heading = make('strong', '页面更新');
  const status = make('p'); status.setAttribute('role', 'status');
  const where = make('div', '', 'pwa-update-targets');
  // 版本与大小（打开面板时实时查询），以及点更新后的进度条 + 剩余时间
  const facts = make('dl', '', 'pwa-update-facts');
  const fact = label => { const row = make('div'), value = make('dd'); row.append(make('dt', label), value); facts.append(row); return value; };
  const versionValue = fact('新版本'), currentValue = fact('当前页面'), sizeValue = fact('更新大小'), etaValue = fact('预计用时');
  const versionName = make('span'), verdict = make('span', '', 'pwa-update-verdict');
  versionValue.append(versionName, verdict);
  const checkedNote = make('p', '', 'pwa-update-checked');
  const progressBox = make('div', '', 'pwa-update-progress');
  const bar = make('progress'); bar.max = 100; bar.value = 0; bar.setAttribute('aria-label', '更新进度');
  const progressText = make('p', '', 'pwa-update-progress-text'); progressText.setAttribute('aria-live', 'polite');
  progressBox.append(bar, progressText);
  const update = button('更新页面', 'btn primary'), later = button('稍后', 'btn');
  const actions = make('div', '', 'pwa-update-actions');
  const offline = make('div', '', 'pwa-update-offline');
  const workerStatus = make('p'); workerStatus.setAttribute('role', 'status');
  const retryWorker = button('重试离线功能', 'btn');
  retryWorker.addEventListener('click', () => { workerRetried = true; void window.piPwaWorker.retry(); render(); });
  offline.append(workerStatus, retryWorker);
  actions.append(update, later);
  panel.append(heading, status, facts, checkedNote, progressBox, where, actions, offline);
  const close = () => { panel.hidePopover?.(); if (!panel.showPopover) panel.hidden = true; };
  const isOpen = () => { try { return panel.matches(':popover-open'); } catch { return !panel.hidden; } };
  let shownTargets = '';
  function renderTargets(list) {
    const key = list.map(t => t.hash + '\u0000' + t.label).join('\u0001');
    if (key === shownTargets) return; shownTargets = key; where.replaceChildren();
    for (const t of list.slice(0, 4)) {
      const b = button('前往：' + t.label, 'btn small pwa-update-target'); b.title = t.label;
      b.addEventListener('click', () => { close(); if (location.hash !== t.hash) location.hash = t.hash; });
      where.append(b);
    }
    if (list.length > 4) where.append(make('span', `另有 ${list.length - 4} 处`, 'muted small'));
  }

  /* ---------- Size, speed and remaining time ---------- */
  // 当前页面已经用着的代码文件：新版本里内容相同的文件（同一个内容地址）不用再下载。
  const ownAssets = new Set();
  const own = value => { try { const u = new URL(value, location.href); if (u.origin === location.origin && u.pathname.startsWith('/assets/')) ownAssets.add(u.pathname); } catch {} };
  const collectOwn = () => {
    for (const e of document.querySelectorAll('script[src]')) own(e.getAttribute('src'));
    for (const e of document.querySelectorAll('link[href]')) own(e.getAttribute('href'));
    for (const e of document.getElementById('route-modules')?.content?.querySelectorAll('script[src]') || []) own(e.getAttribute('src'));
  };
  const validSize = v => v && Number.isSafeInteger(v.bytes) && Number.isSafeInteger(v.transfer) && v.bytes >= 0 && v.transfer >= 0 ? v : null;
  const sizeOf = (m, url) => validSize(m?.sizes?.[url]);
  const partials = new Map(); // 正在下载的文件 → 已经下了多少（可以同时下几个）
  const speed = { bytes: 0, ms: 0 }; // 本页实测下载速度（传输字节 / 毫秒）
  function plan(m) {
    const changed = m.assets.filter(u => !ownAssets.has(u));
    let total = 0, done = 0, cached = 0, known = true;
    // 服务器没给大小时按每个文件 50 KB 估时间（界面上不显示字节数）。
    for (const u of changed) {
      const t = sizeOf(m, u)?.transfer ?? (known = false, 51200);
      total += t;
      if (verifiedAssets.has(u)) { done += t; cached++; } else if (partials.has(u)) done += t * partials.get(u);
    }
    const doc = validSize(m.document)?.transfer ?? 20480;
    return { files: changed.length, cached, total, done, doc, known: known && !!validSize(m.document) };
  }
  // 字节/毫秒：优先本页实测，其次浏览器报告的带宽，最后按 2 Mbps 保守估计。
  const rate = () => speed.ms >= 150 && speed.bytes > 0 ? speed.bytes / speed.ms : navigator.connection?.downlink > 0 ? navigator.connection.downlink * 125 : 250;
  const BOOT_MS = 900; // 刷新后新页面启动到可用的大致时间
  // 剩余时间（毫秒）：未下载的代码 + 后台准备 + 刷新时下载页面本身并启动。
  function remainingMs(p, stage, now = performance.now()) {
    const r = rate(), worker = window.piPwaWorker.state().phase === 'working';
    let ms = 0;
    if (stage === 'idle' || stage === 'confirming') ms += 300;
    if (stage !== 'worker' && stage !== 'reloading') ms += Math.max(0, p.total - p.done) / r + (worker ? 1500 : 150);
    if (stage === 'worker') ms += Math.max(300, Math.min(worker ? 1500 : 300, WORKER_WAIT_MS - (now - (job?.stageAt ?? now))));
    const refresh = p.doc / r + BOOT_MS;
    ms += stage === 'reloading' ? Math.max(0, refresh - (now - (job?.stageAt ?? now))) : refresh;
    return ms;
  }
  const fmtBytes = n => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
  const fmtTime = ms => ms < 1000 ? '不到 1 秒' : ms < 60000 ? `约 ${Math.ceil(ms / 1000)} 秒` : `约 ${Math.ceil(ms / 60000)} 分钟`;
  const fmtVersion = v => {
    const at = v?.committedAt ? new Date(v.committedAt) : null, pad = n => String(n).padStart(2, '0');
    const when = at && !Number.isNaN(at.getTime()) ? `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}` : '';
    const commit = /^[a-f0-9]{40}$/.test(v?.commit || '') ? v.commit.slice(0, 7) : '';
    return [when, commit].filter(Boolean).join(' · ');
  };
  const agoText = at => { const s = Math.round((Date.now() - at) / 1000); return s < 10 ? '刚刚' : s < 60 ? `${s} 秒前` : `${Math.round(s / 60)} 分钟前`; };
  const target = () => candidate;
  function factsView() {
    const m = target(); if (!m) return null;
    const p = plan(m);
    const [verdictText, tone] = inspecting ? ['正在核对是不是最新版本…', 'busy']
      : inspectFailed ? ['暂时查不到服务器上的最新版本', 'warn']
      : latest?.fresh ? [switched ? '已核对：服务器刚发了更新的版本，已换成最新的' : '已核对：是服务器上的最新版本', 'ok'] : ['', ''];
    const prev = m.previousRelease === current ? fmtVersion(m.previousVersion) : '';
    const all = p.total + p.doc;
    let size;
    if (!p.known) size = p.files ? `${p.files} 个代码文件有变化，大小未知` : '代码没有变化，只需刷新页面';
    else if (!p.files) size = `${fmtBytes(all)}（代码没有变化，只需刷新页面）`;
    else if (p.cached === p.files) size = `${fmtBytes(all)}（${p.files} 个文件有变化，代码已下载）`;
    else if (!p.cached) size = `${fmtBytes(all)}（${p.files} 个文件有变化，点更新后下载）`;
    else size = `${fmtBytes(all)}（${p.files} 个文件有变化），还需下载 ${fmtBytes(Math.round(p.total - p.done + p.doc))}`;
    return {
      version: fmtVersion(m.version) || '已准备', verdict: verdictText, tone,
      current: m.previousRelease === current ? prev || '上一个版本' : '更早的版本（跨过了不止一个版本）',
      size, eta: fmtTime(remainingMs(p, 'idle')),
      checked: latest ? (inspectFailed ? `上次核对：${agoText(latest.at)}` : `核对时间：${agoText(latest.at)}`) : ''
    };
  }
  function progressView() {
    if (!job) return null;
    const m = job.m || target(); if (!m) return null;
    const p = plan(m), now = performance.now(), stage = applying || 'idle';
    const left = remainingMs(p, stage, now);
    // 百分比跟着字节走：代码 + 页面本身按字节占 0–95%，后台准备 96%，刷新中 97–99%；只增不减，真正换页前最多 99%。
    const work = p.total + p.doc;
    let percent = work > 0 ? Math.floor(95 * p.done / work) : 95;
    if (stage === 'worker') percent = 96;
    if (stage === 'reloading') { const spent = now - job.stageAt; percent = 97 + Math.min(2, Math.floor(2 * spent / Math.max(spent + left, 1))); }
    job.percent = Math.max(job.percent || 0, Math.min(99, percent));
    const parts = [`${job.percent}%`];
    if (p.files && p.known) parts.push(p.done >= p.total ? `代码 ${fmtBytes(p.total)} 已就绪` : `已下载 ${fmtBytes(Math.round(p.done))} / ${fmtBytes(p.total)}`);
    parts.push(applying === 'reloading' && left <= 0 ? '马上就好' : `剩余${fmtTime(left)}`);
    return { percent: job.percent, text: parts.join(' · ') };
  }
  function updateText(block) {
    switch (applying) {
      case 'confirming': return '正在确认新版本…';
      case 'preparing': return '正在下载新版本…';
      case 'worker': return '正在完成后台准备…';
      case 'reloading': return '正在更新，页面即将刷新…';
      case 'stalled': return '刷新还没有完成。可以再试一次；仍无反应时请关闭应用后重新打开。';
    }
    if (block) return block;
    if (!silent) return note || '服务器上有新版本。点「更新页面」后才开始下载，下载完自动刷新';
    return note || (downloaded(candidate) ? '服务器上有新版本：已自动下载，下次切换页面时自动生效；也可以现在点「更新页面」' : nativePrep === candidate?.release ? '服务器上有新版本，正在后台下载；下载完下次切换页面时自动生效' : '服务器上有新版本，后台下载没完成。可以点「更新页面」手动更新');
  }
  // The release went away (rolled back, signed out): an open panel would only show leftovers.
  const settleView = () => { render(); if (!candidate && !upToDate && !workerRetried && window.piPwaWorker.state().phase !== 'failed' && isOpen()) close(); };
  function render() {
    const worker = window.piPwaWorker.state(), failed = worker.phase === 'failed';
    // 离线功能（启动缓存）失败不影响联网使用：自动重试还在进行时不打扰，用完才给按钮；面板开着时照常显示结果。
    const offerWorker = failed && worker.failure !== dismissedWorker && (worker.exhausted || isOpen());
    // 原生壳里「有更新」用 Tip 通知就够了；只有被草稿挡住、或面板开着时才留一个入口，让人知道要处理什么。
    trigger.hidden = !(isOpen() || needsAttention() || (!!candidate && !!applying) || offerWorker);
    const progress = candidate && job ? progressView() : null;
    trigger.textContent = progress ? `更新中 ${progress.percent}%` : candidate ? '有更新' : '离线重试';
    trigger.setAttribute('aria-label', candidate ? '有新版本，查看更新' : '离线功能需要重试');
    trigger.title = candidate ? '' : '离线启动缓存多次更新失败（常见于服务器重启时），联网使用不受影响';
    heading.textContent = candidate || upToDate ? '页面更新' : '离线功能';
    const { reason, targets } = candidate && !applying ? blockers() : { reason: '', targets: [] };
    status.hidden = !candidate && !upToDate; update.hidden = !candidate;
    status.textContent = candidate ? updateText(reason) : upToDate ? '当前页面已是最新版本，无需更新' : '';
    const info = candidate && !job ? factsView() : null;
    facts.hidden = !info; checkedNote.hidden = !info?.checked;
    if (info) {
      versionName.textContent = info.version; verdict.textContent = info.verdict; verdict.hidden = !info.verdict; verdict.dataset.tone = info.tone;
      currentValue.textContent = info.current; sizeValue.textContent = info.size; etaValue.textContent = info.eta; checkedNote.textContent = info.checked;
    }
    const shown = progress;
    progressBox.hidden = !shown;
    if (shown) { bar.value = shown.percent; bar.setAttribute('aria-valuetext', shown.text); progressText.textContent = shown.text; }
    status.classList.toggle('pwa-update-busy', !!candidate && ['confirming', 'preparing', 'worker', 'reloading'].includes(applying));
    renderTargets(candidate ? targets : []);
    update.textContent = applying === 'stalled' ? '重新刷新' : applying ? '正在更新…' : '更新页面';
    update.disabled = (!!applying && applying !== 'stalled') || !!reason;
    later.hidden = applying === 'reloading';
    later.textContent = upToDate && !candidate ? '关闭' : '稍后';
    // Worker state only appears when it needs attention or the user asked for a retry here.
    offline.hidden = !(failed || (workerRetried && ['working', 'ready'].includes(worker.phase)));
    workerStatus.textContent = failed ? '离线功能准备失败，页面仍可联网使用。可以重试，不会刷新页面或清空草稿。' : worker.phase === 'ready' ? '离线功能已准备好' : '正在准备离线功能…';
    retryWorker.hidden = !['failed', 'working'].includes(worker.phase);
    retryWorker.disabled = !failed;
  }

  // 自动的版本检查让出首屏/当前页面读取；显式检查不受影响。
  let deferredCheck;
  const deferCheck = () => {
    if (deferredCheck || applying || document.visibilityState === 'hidden' || navigator.onLine === false) return;
    deferredCheck = setTimeout(() => { deferredCheck = null; void check(); }, 2000);
  };
  const readsBusy = () => {
    if (navigator.onLine === false || document.visibilityState === 'hidden') return true;
    if (window.piReadBusy?.()) return true;
    const state = typeof ui === 'undefined' ? window.ui : ui;
    return !!(state?.view === 'rt' && state.rt?.id && !state.rt.statusConfirmed || state?.view === 'rt-room' && state.room?.id && !state.room.statusConfirmed);
  };
  const verifiedAssets = new Set();

  /* ---------- Preparing a release ---------- */
  async function metadata() {
    const r = await fetch('/api/web-release', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(8000) });
    if (!r.ok || r.redirected) { const error = new Error('release unavailable'); error.status = r.status; throw error; }
    const m = await r.json();
    if (m.schema !== 1 || !valid(m.release) || (m.previousRelease !== null && !valid(m.previousRelease)) || !Array.isArray(m.assets) || !m.assets.length || m.assets.length > 96 || new Set(m.assets).size !== m.assets.length || m.assets.some(u => !/^\/assets\/[a-f0-9]{64}\/[a-z][a-z0-9-]*\.(js|css)$/.test(u))) throw new Error('invalid release');
    latest = { m, at: Date.now(), fresh: !!latest?.fresh && latest.m.release === m.release };
    return m;
  }
  // 下载时边读边数字节，进度条和剩余时间都按真实字节走；同时记下实测速度。
  let progressFrame = 0;
  const progressed = () => { if (!progressFrame) progressFrame = setTimeout(() => { progressFrame = 0; render(); }, 150); };
  // started = 发请求的时刻：实测速度把每个文件的往返延迟也算进去，剩余时间才不偏乐观。
  async function download(m, url, r, started, idle) {
    const size = sizeOf(m, url), reader = r.body?.getReader?.();
    if (!reader) return new Uint8Array(await r.arrayBuffer());
    const chunks = []; let received = 0;
    partials.set(url, 0);
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        chunks.push(value); received += value.byteLength; idle?.();
        if (size?.bytes) { partials.set(url, Math.min(1, received / size.bytes)); progressed(); }
      }
    } finally { partials.delete(url); }
    const elapsed = performance.now() - started;
    speed.bytes += size?.transfer ?? (Number(r.headers.get('content-length')) || received); speed.ms += Math.max(elapsed, 1);
    const body = new Uint8Array(received); let offset = 0;
    for (const c of chunks) { body.set(c, offset); offset += c.byteLength; }
    return body;
  }
  const PREPARE_PARALLEL = 3, FILE_TRIES = 3, FILE_IDLE_MS = 20000;
  // 安卓壳走局域网 http://<ip>:端口 时页面不是安全上下文，没有 crypto.subtle：用纯 JS 兜底，校验照做（不能因此跳过校验）。
  function sha256Fallback(bytes) {
    const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
    const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const n = bytes.length, total = Math.ceil((n + 9) / 64) * 64, buf = new Uint8Array(total);
    buf.set(bytes); buf[n] = 0x80;
    const view = new DataView(buf.buffer); view.setUint32(total - 8, Math.floor(n / 0x20000000)); view.setUint32(total - 4, (n * 8) >>> 0);
    const W = new Uint32Array(64), rotr = (x, k) => (x >>> k) | (x << (32 - k));
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) { const a = W[i - 15], b = W[i - 2]; W[i] = W[i - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + W[i - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)); }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    return Array.from(H, x => x.toString(16).padStart(8, "0")).join("");
  }
  async function sha256Hex(bytes) {
    if (globalThis.crypto?.subtle) return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    return sha256Fallback(bytes);
  }
  const fileName = url => url.split('/').pop();
  // 一个文件：下完核对内容摘要；网络抖动 / 超时 / 5xx / 内容不对都重试几次（超时按「多久没收到数据」算，不是总时长）。
  async function fetchVerified(m, url) {
    let last;
    for (let attempt = 1; attempt <= FILE_TRIES; attempt++) {
      const controller = new AbortController(); let timer, timedOut = false;
      const idle = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; controller.abort(); }, FILE_IDLE_MS); };
      try {
        idle();
        const requested = performance.now();
        const r = await fetch(url, { priority: 'low', cache: 'reload', credentials: 'same-origin', signal: controller.signal });
        const types = url.endsWith('.css') ? ['text/css'] : ['text/javascript', 'application/javascript'];
        if (r.status !== 200) { const e = new Error('HTTP ' + r.status); e.status = r.status; e.detail = 'HTTP ' + r.status; throw e; }
        if (r.redirected) { const e = new Error('redirected'); e.final = true; e.detail = '被重定向（可能要重新登录）'; throw e; }
        const type = r.headers.get('content-type')?.split(';')[0];
        if (!types.includes(type)) { const e = new Error('invalid type'); e.final = true; e.detail = '类型异常 ' + (type || '空'); throw e; }
        if (!r.headers.get('cache-control')?.includes('immutable')) { const e = new Error('invalid cache'); e.final = true; e.detail = '缺少缓存头（网络中间层改写了响应？）'; throw e; }
        const digest = await sha256Hex(await download(m, url, r, requested, idle));
        if (digest !== url.split('/')[2]) { const e = new Error('code mismatch'); e.final = true; e.detail = '内容校验不一致（下载被截断或改写）'; throw e; }
        verifiedAssets.add(url); progressed(); return;
      } catch (error) {
        last = error;
        if (!error.detail) error.detail = timedOut ? `${FILE_IDLE_MS / 1000} 秒没收到数据` : error.name === 'AbortError' ? '已取消' : /fetch|network|load failed|terminated|aborted/i.test(error.message || '') ? '网络中断' : '下载或校验出错：' + (error.message || error.name);
        error.file = fileName(url);
        // 服务器明确答错了（登录失效 / 找不到 / 类型或内容不对）重试也没用；网络中断、超时、5xx 才重试。
        if (error.final || (error.status && error.status < 500)) throw error;
      } finally { clearTimeout(timer); }
      if (attempt < FILE_TRIES) await new Promise(resolve => setTimeout(resolve, 600 * attempt));
    }
    throw last;
  }
  // 用户确认更新后才调用：下载并核对变化的代码文件；下载期间又发了版本就跟上最新的（有上限）。
  async function prepare(m) {
    for (let attempt = 0; attempt < 3; attempt++) {
      // 文件按内容寻址：换了 release 也只丢掉新版本不再需要的，已核对的同名文件不重复下载。
      for (const url of verifiedAssets) if (!m.assets.includes(url)) verifiedAssets.delete(url);
      candidate = m; if (job) job.m = m; render();
      // 只下变化的文件，几个一起下；任何一个失败都带着「哪个文件、什么原因」报出去。
      const todo = m.assets.filter(u => !ownAssets.has(u) && !verifiedAssets.has(u));
      let next = 0, failed = null;
      const worker = async () => {
        while (!failed && next < todo.length) {
          const url = todo[next++];
          try { await fetchVerified(m, url); } catch (error) { failed = failed || error; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(PREPARE_PARALLEL, todo.length) }, worker));
      if (failed) throw failed;
      const newest = await metadata();
      if (newest.release === current) { candidate = null; return false; }
      if (newest.release === m.release) { channel?.postMessage({ type: 'release-ready', release: m.release }); return true; }
      m = newest;
    }
    throw new Error('release keeps changing');
  }
  const failure = (error, message) => {
    if ([401, 403, 404].includes(error?.status)) { candidate = null; note = ''; return; }
    note = message;
  };
  async function check(force = false) {
    if (checking || applying || document.visibilityState === 'hidden' || (!force && Date.now() - lastCheck < 30000)) return false;
    if (!force && readsBusy()) { deferCheck(); return false; }
    clearTimeout(deferredCheck); deferredCheck = null;
    checking = true; lastCheck = Date.now(); note = ''; render();
    // 只问服务器有没有新版本（版本信息和大小），不下载代码。
    try {
      let m;
      // A transient metadata failure keeps the known new version; auth/missing clears it.
      try { m = await metadata(); } catch (error) { if ([401, 403, 404].includes(error.status)) failure(error, ''); return !!candidate; }
      if (applying) return !!candidate;
      if (m.release === current) { candidate = null; upToDate = isOpen(); return false; }
      if (candidate?.release !== m.release) { candidate = m; note = ''; } else candidate = m;
      // 代码在后台自己下好，下次切换页面 / 回到前台时直接生效；用户只需要一条 Tip。
      if (silent && !downloaded(m)) void prepareInBackground(m);
      return true;
    }
    finally { checking = false; settleView(); }
  }

  /* ---------- Opening the panel: ask the server right now ---------- */
  // 按钮可能是几分钟前亮的：打开面板时实时查一次，换成服务器上最新的版本，并按它算大小。
  async function inspect() {
    if (inspecting || applying || !candidate) return;
    inspecting = true; inspectFailed = false; switched = false; render();
    try {
      const m = await metadata();
      latest.fresh = true;
      if (applying) return;
      if (m.release === current) { candidate = null; upToDate = true; }
      else { switched = m.release !== candidate?.release; candidate = m; }
    } catch (error) {
      if ([401, 403, 404].includes(error?.status)) failure(error, ''); else inspectFailed = true;
    } finally { inspecting = false; settleView(); }
  }

  /* ---------- Applying ---------- */
  let ticker;
  function startJob(kind, m) {
    const now = performance.now();
    job = { kind, m, started: now, stageAt: now, percent: 0 };
    clearInterval(ticker); ticker = setInterval(render, 250); // 剩余时间按秒走
  }
  const endJob = () => { job = null; clearInterval(ticker); ticker = undefined; };
  function stage(name) { applying = name; if (job) job.stageAt = performance.now(); render(); }
  function reload() {
    clearTimeout(stallTimer);
    if (!job) startJob('apply', target());
    stage('reloading');
    // If the page is still here after the refresh should have finished, offer a manual retry.
    stallTimer = setTimeout(() => { if (applying === 'reloading') { applying = 'stalled'; endJob(); render(); } }, STALL_MS);
    location.reload();
  }
  async function apply() {
    if (applying === 'stalled') { if (protection()) { applying = ''; render(); return false; } reload(); return true; }
    if (!candidate || applying || protection()) { render(); return false; }
    note = ''; startJob('apply', candidate); stage('confirming');
    try {
      let m;
      try { m = await metadata(); }
      catch (error) {
        if ([401, 403, 404].includes(error.status)) failure(error, '');
        else note = '暂时连不上服务器（可能正在部署），请稍后再点更新';
        return false;
      }
      if (m.release === current) { candidate = null; upToDate = true; return false; }
      // 确认后才下载：始终下载点击这一刻服务器上最新的版本。
      candidate = m; job.m = m; stage('preparing');
      try { if (!await prepare(m)) return false; }
      catch (error) { failure(error, '新版本下载失败' + (error?.file ? `（${error.file}：${error.detail}）` : '') + '，可以再点一次「更新页面」'); return false; }
      if (protection()) return false;
      stage('worker');
      await window.piPwaWorker.settle(WORKER_WAIT_MS);
      if (protection()) return false;
      try { sessionStorage.setItem(UPDATED_KEY, JSON.stringify({ from: current, to: candidate.release, at: Date.now() })); } catch {}
      reload(); return true;
    } finally { if (applying !== 'reloading') { applying = ''; endJob(); } settleView(); }
  }

  /* ---------- After a refresh: say what happened ---------- */
  function announce() {
    let record;
    try { record = JSON.parse(sessionStorage.getItem(UPDATED_KEY) || 'null'); sessionStorage.removeItem(UPDATED_KEY); } catch { return; }
    if (!record || !(Date.now() - record.at < 120000) || !valid(record.from)) return;
    const updated = current !== record.from;
    window.piToast(updated ? '已更新到新版本' : '页面已刷新，但仍是原来的版本，稍后会再次检查', { tone: updated ? '' : 'warn' });
    if (!updated) lastCheck = 0;
  }

  // 关上面板后，下次打开重新核对；「已是最新」只在这次打开里显示。
  const closed = () => { upToDate = false; if (latest) latest.fresh = false; };
  function start() {
    document.querySelector('.topbar')?.append(trigger); document.body.append(panel);
    collectOwn();
    if (!panel.showPopover) { panel.hidden = true; trigger.addEventListener('click', () => { panel.hidden = !panel.hidden; if (panel.hidden) closed(); else void inspect(); render(); }); }
    update.addEventListener('click', () => void apply());
    later.addEventListener('click', () => { dismissed = candidate?.release; dismissedWorker = window.piPwaWorker.state().failure; close(); render(); });
    panel.addEventListener('beforetoggle', e => { if (e.newState === 'closed') { workerRetried = false; closed(); } else void inspect(); render(); });
    panel.addEventListener('toggle', render);
    window.addEventListener('pi-pwa-worker', render);
    window.addEventListener('pageshow', e => { if (e.persisted && applying) { clearTimeout(stallTimer); applying = ''; endJob(); render(); } });
    render(); announce();
    try { sessionStorage.setItem('pi-pwa-tab-release', current); } catch {}
    try { channel = new BroadcastChannel('pi-pwa-release-v1'); channel.onmessage = e => {
      if (e.data?.type === 'release-ready' && valid(e.data.release) && e.data.release !== current) void check();
    }; } catch {}
    window.addEventListener('online', () => void check());
    window.addEventListener('pi-native-resume', () => { void check(); applyOnNextModule(); });
    // 「下次刷新对应的前端模块」就是切路由：那一下直接用新版本重新载入，位置和草稿都还在。
    window.addEventListener('hashchange', () => { applyOnNextModule(); });
    window.addEventListener('focus', () => void check()); document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { void check(); applyOnNextModule(); } });
    document.addEventListener('compositionstart', () => { composing = true; render(); }); document.addEventListener('compositionend', () => { composing = false; render(); });
    document.addEventListener('input', render); document.addEventListener('change', render);
    const poll = setInterval(() => { render(); void check(); }, 300000), guardTimer = setInterval(() => { if (candidate && document.visibilityState !== 'hidden') render(); }, 1000);
    window.addEventListener('pagehide', e => { if (!e.persisted) { clearTimeout(deferredCheck); clearInterval(poll); clearInterval(guardTimer); channel?.close(); } });
    setTimeout(() => void check(), 5000);
  }
  window.piPwa = { current, check, apply, inspect, protection, blockers, state: () => ({ downloaded: downloaded(candidate), checking, applying, inspecting, upToDate, native, candidate: candidate?.release ?? null, latest: latest?.m.release ?? null, percent: job?.percent ?? null }) };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();

// 一次启动报一行：走没走 app shell、首屏多少毫秒。诊断日志原来只记 /api 的慢请求，
// 每次「杀掉 PWA 再打开」都是空白；这条上报把「手机冷启动到底多快」变成可统计的量。
// 没有 release 的页面（本地直读 public/）不上报。
(() => {
  const release = document.querySelector('meta[name="pi-web-release"]')?.content;
  if (!/^[a-f0-9]{64}$/.test(release || '')) return;
  // 首屏时间：优先 first-contentful-paint，退到 first-paint（老引擎、被隐藏的页面可能只有后者）。
  const firstPaintMs = () => {
    const entry = name => performance.getEntriesByName(name)[0];
    const paint = entry('first-contentful-paint') || entry('first-paint');
    return paint ? Math.round(paint.startTime) : null;
  };
  let sent = false, attempts = 0, fallback;
  function report() {
    if (sent) return;
    // 首帧可能比 load 晚一点：没有绘制记录时再等一次，别把这次启动记成「没有首屏」。
    const fcpMs = firstPaintMs();
    if (fcpMs === null && attempts++ < 2) { setTimeout(report, 400); return; }
    sent = true; clearTimeout(fallback);
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      const connection = navigator.connection || {};
      const body = {
        release,
        ...(window.piStartup?.id ? { pageInstanceId: window.piStartup.id } : {}),
        shell: document.documentElement.dataset.piShell || null,
        ttfbMs: Math.round(nav ? nav.responseStart : 0),
        fcpMs,
        dclMs: Math.round(nav ? nav.domContentLoadedEventEnd : performance.now()),
        online: navigator.onLine !== false,
        effectiveType: connection.effectiveType || null,
        saveData: connection.saveData === true
      };
      fetch('/api/launch-timing', {
        method: 'POST', cache: 'no-store', credentials: 'same-origin', keepalive: true,
        headers: { 'content-type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify(body)
      }).catch(() => {});
    } catch { /* 上报失败不影响使用 */ }
  }
  if (document.readyState === 'complete') report();
  else {
    window.addEventListener('load', report, { once: true });
    // 有资源卡住时 load 可能很久不触发：到点也报，别让这次启动在日志里消失。
    fallback = setTimeout(report, 8000);
  }
})();
