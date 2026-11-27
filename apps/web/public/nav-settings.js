"use strict";
/* Navigation preferences never change routes or feature eligibility. */
function initNavSettings() {
  const nav = document.querySelector('.tabs'), more = document.getElementById('nav-more'), moreBtn = document.getElementById('nav-more-btn');
  if (!nav || !more || nav.dataset.customized) return;
  nav.dataset.customized = 'true';
  const key = 'pi-agent:nav:v1';
  const serverPath = '/api/navigation';
  const pendingKey = 'pi-agent:nav:v1:pending';
  const phone = window.matchMedia('(max-width: 760px)');
  const isPhone = () => phone.matches || document.body.classList.contains('rt-phone-list') || document.body.classList.contains('primary-phone');
  // 已下线（data-offline）的项不参与导航设置，始终隐藏
  // 会话（会话区）、产物（产物区固定第一项）不参与置顶；其余带 data-app 的是「产物里的应用」，置顶 = position 'main'。
  const topbar = nav.parentElement;
  const entries = [...topbar.querySelectorAll('.tab[data-view]:not([data-offline])')].map(el => ({ id: el.dataset.view, el, app: el.hasAttribute('data-app'), desc: el.title, name: el.querySelector('.tab-label').textContent, position: el.parentElement === more ? 'more' : 'main', available: !el.hidden }));
  // 最近激活的「未置顶应用」临时出现在产物区末尾，只记在本机；再打开另一个未置顶应用时被替换。
  // recent = { kind: 'app', id } 或 { kind: 'game', id, category, name, emoji }
  const recentKey = 'pi-agent:nav:recent2';
  let recent = null;
  try { recent = JSON.parse(localStorage.getItem(recentKey)); } catch { /* 本机存储不可用就不记 */ }
  if (recent?.kind === 'app' ? !entries.some(e => e.app && e.id === recent.id) : recent?.kind !== 'game' || typeof recent.id !== 'string') recent = null;
  const saveRecent = () => { try { localStorage.setItem(recentKey, JSON.stringify(recent)); } catch { /* 同上 */ } };
  // 从产物里置顶的应用（小游戏等）：{ id, category, name, emoji }，跟内置应用的置顶一起存在服务端导航配置里。
  const cleanPinned = list => (Array.isArray(list) ? list : []).filter((p, i, all) => p && typeof p.id === 'string' && /^[a-z][a-z0-9-]*$/.test(p.category || '') && typeof p.name === 'string' && p.name && all.findIndex(q => q?.id === p.id) === i).slice(0, 12).map(p => ({ id: p.id, category: p.category, name: p.name, emoji: typeof p.emoji === 'string' ? p.emoji : '' }));
  let pinnedGames = [];
  const changeListeners = new Set();
  const notifyChange = () => changeListeners.forEach(fn => { try { fn(); } catch { /* 监听方出错不影响导航 */ } });
  const defaults = () => entries.map(e => ({ id: e.id, label: '', position: e.position }));
  const normalize = raw => {
    if (!raw || raw.version !== 1 || !Array.isArray(raw.items)) return defaults();
    const seen = new Set(), items = [];
    for (const value of raw.items) {
      const e = entries.find(e => e.id === value?.id);
      if (!e || seen.has(e.id)) continue;
      seen.add(e.id);
      const label = typeof value.label === 'string' ? value.label.trim() : '';
      items.push({ id:e.id, label: !/[\r\n]/.test(label) && [...label].length <= 12 ? label : '', position:['main','more','hidden'].includes(value.position) ? value.position : e.position });
    }
    return [...items, ...defaults().filter(e => !seen.has(e.id))];
  };
  // 手机一级页的导航固定在底部标签栏，最右「更多」收其余入口与设置（不再有顶栏导航模式）。
  let saved;
  // 本机缓存只负责首帧和离线；真正的账号级配置在服务端 /api/navigation。
  const readCache = () => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
  const writeCache = raw => { try { localStorage.setItem(key, JSON.stringify(raw)); return true; } catch { return false; } };
  const readPending = () => { try { return localStorage.getItem(pendingKey) === '1'; } catch { return false; } };
  const writePending = on => { try { if (on) localStorage.setItem(pendingKey, '1'); else localStorage.removeItem(pendingKey); } catch { /* 缓存不可用时仍可尝试服务端 */ } };
  const cached = readCache();
  saved = cached ? normalize(cached) : defaults();
  pinnedGames = cleanPinned(cached?.pinned);
  let pending = readPending();
  let serverRevision = 0, serverUpdatedAt = null, serverLoading = null, clientSaving = 0, localEpoch = 0;
  const localDocument = () => ({ version: 1, items: saved, pinned: pinnedGames });
  const hiddenBox = h('div', {hidden:true, 'aria-hidden':'true'}); nav.append(hiddenBox);
  const bottomBar = h('div', {class:'phone-bottom-nav', id:'phone-bottom-nav', hidden:true});
  document.body.append(bottomBar);
  const isBottom = () => isPhone() && document.body.classList.contains('nav-bottom');
  // 底部模式把导航本体搬进底栏（不带 pi logo）；其他模式放回顶栏原位，按钮与事件都是同一份。
  const placeChrome = bottom => {
    if (bottom && nav.parentElement !== bottomBar) bottomBar.append(nav);
    if (!bottom && nav.parentElement !== topbar) topbar.querySelector('.zone-sessions')?.after(nav);
    // 切换布局时「更多」一律先收起。
    if (bottom === bottomBar.hidden) more.hidden = true;
    bottomBar.hidden = !bottom;
  };
  // 底栏「选中气泡」：一颗独立的玻璃气泡，切换标签时滑到新位置。这里只量出当前选中项的位置写成 CSS 变量，
  // 动画写在样式里（第一次定位不做动画，之后才加 ind-ready）。选中项靠 .active 类标记，换页时 app.js 会改它。
  const syncIndicator = () => {
    if (bottomBar.hidden) return;
    // 「更多」展开时，选中气泡滑到「更多」上；收起后回到当前页的标签
    const active = [...nav.children].find(el => el.classList.contains('active') && !el.hidden && el.matches('.tab, .tab-more'));
    if (!active) { bottomBar.style.setProperty('--ind-o', '0'); return; }
    const n = nav.getBoundingClientRect(), a = active.getBoundingClientRect();
    if (!a.width) return;
    bottomBar.style.setProperty('--ind-x', `${Math.round(a.left - n.left)}px`);
    bottomBar.style.setProperty('--ind-w', `${Math.round(a.width)}px`);
    bottomBar.style.setProperty('--ind-o', '1');
    if (!bottomBar.classList.contains('ind-ready')) requestAnimationFrame(() => requestAnimationFrame(() => bottomBar.classList.add('ind-ready')));
  };
  new MutationObserver(syncIndicator).observe(nav, { attributes: true, attributeFilter: ['class', 'hidden'], childList: true, subtree: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(syncIndicator).observe(nav);
  window.addEventListener('resize', syncIndicator);
  // 左右滑切换应用（app-swipe.js）拖动中改写气泡位置，取消 / 结束后用它让气泡回到当前选中项。
  window.navSyncIndicator = syncIndicator;

  /* 底栏随滚动收放：一级页开始向下滚（进入浏览）就收起，向上滚立刻回来。
     会话列表（智力球那一层）不参与——底栏在那里是「来源 / 上推回产物区」的指示，收走会丢掉引导。
     收起时 body 仍按 --bottomnav-h 预留，内容不跳；滚回顶部、换页、键盘弹起都会复位。 */
  const SCROLL_HIDE_MIN = 10;   // 累积位移超过它才切换，手指抖动不算
  const SCROLL_KEEP_TOP = 24;   // 页面顶部这一段始终显示
  let navScrollHidden = false, navScrollLast = null, navScrollAccum = 0, navScrollFrame = 0, navScrollBox = null;
  // 一级页有的靠文档滚（产物 / 待办 / 资源），有的靠 .main 自己滚：哪个容器在动就跟哪个
  const navScrollDoc = () => document.scrollingElement || document.documentElement;
  // 键盘弹起时页面会跟着滚，这时不该把底栏收走（输入区的操作还要能看见）
  const navScrollTyping = () => { const el = document.activeElement; return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)); };
  // 会话列表是「下一层」，浮层打开时页面滚的是浮层自己，两种都不收。
  const navScrollBlocked = () => !isBottom() || bottomBar.hidden || navScrollTyping() ||
    document.body.classList.contains('rt-phone-list') || document.body.classList.contains('settings-mode') ||
    !!document.querySelector('dialog[open], #nav-more:not([hidden]), .rt-auth-overlay, .rt-lightbox, .image-zoom');
  function navScrollReset() {
    navScrollLast = null; navScrollAccum = 0;
    if (!navScrollHidden) return;
    navScrollHidden = false;
    document.body.classList.remove('nav-scroll-hidden');
    bottomBar.removeAttribute('inert');
    syncIndicator();
  }
  function navScrollHide(next) {
    if (next === navScrollHidden || (next && navScrollBlocked())) return;
    navScrollHidden = next;
    document.body.classList.toggle('nav-scroll-hidden', next);
    // 收起后不再能被点到 / 聚焦；回来时恢复（旧内核不认 inert 时只是少一层限制，样式照样收起）。
    if (next) bottomBar.setAttribute('inert', ''); else bottomBar.removeAttribute('inert');
  }
  function navScrollCheck(event) {
    if (navScrollFrame) return;
    const target = event?.target;
    // 文档滚动时事件 target 是 document；元素自己滚时是那个元素。
    const box = target && target.nodeType === 1 ? target : navScrollDoc();
    navScrollFrame = requestAnimationFrame(() => {
      navScrollFrame = 0;
      const at = Math.max(0, Math.round(box.scrollTop || 0));
      // 换了一个滚动容器（或刚复位）：从现在这个位置重新算方向
      if (box !== navScrollBox || navScrollLast === null) { navScrollBox = box; navScrollLast = at; navScrollAccum = 0; return; }
      const delta = at - navScrollLast;
      navScrollLast = at;
      if (!delta) return;
      // 页面顶部这一段始终显示；一往上滑就回来（包括在列表底部往上滑）。
      if (navScrollBlocked() || at <= SCROLL_KEEP_TOP) { navScrollReset(); return; }
      navScrollAccum = Math.sign(delta) === Math.sign(navScrollAccum) ? navScrollAccum + delta : delta;
      if (navScrollAccum >= SCROLL_HIDE_MIN) navScrollHide(true);
      else if (navScrollAccum <= -SCROLL_HIDE_MIN) navScrollHide(false);
    });
  }
  window.navScrollReset = navScrollReset;
  // 捕获阶段监听：滚动事件不冒泡，但元素的 scroll 在 window 的捕获阶段能收到
  window.addEventListener('scroll', navScrollCheck, { passive: true, capture: true });
  window.addEventListener('hashchange', () => navScrollReset());
  const gameTabs = new Map();
  const gameTab = g => {
    let el = gameTabs.get(g.id);
    if (!el) {
      el = h('button', { type: 'button', class: 'tab', 'data-game': g.id, onclick: () => { location.hash = `#/artifacts/${el.dataset.category}/${g.id}`; } },
        h('span', { class: 'tab-icon tab-emoji', 'aria-hidden': 'true' }, h('span', { class: 'tab-emoji-char' })), h('span', { class: 'tab-label' }));
      // 小游戏自己的图标直接上屏；没有或加载失败时退回 emoji
      const box = el.querySelector('.tab-emoji'), art = h('img', { src: `/games/${encodeURIComponent(g.id)}/icon.svg`, alt: '', draggable: 'false' });
      art.addEventListener('load', () => box.classList.add('has-art'));
      art.addEventListener('error', () => art.remove());
      box.append(art);
      gameTabs.set(g.id, el);
    }
    el.dataset.category = g.category;
    el.querySelector('.tab-emoji-char').textContent = g.emoji || '▣';
    el.querySelector('.tab-label').textContent = g.name; el.title = g.name; el.setAttribute('aria-label', g.name);
    return el;
  };
  // 打开了某个置顶 / 最近的小游戏时，亮它而不是「产物」。
  const syncActive = () => {
    const open = typeof ui !== 'undefined' && ui.view === 'artifacts' ? ui.artifactGame?.id : null;
    const hit = open && gameTabs.has(open);
    for (const [id, el] of gameTabs) el.classList.toggle('active', id === open);
    if (hit) nav.querySelector('.tab[data-view="artifacts"]')?.classList.remove('active');
  };
  window.navSyncActive = () => { syncActive(); if (overflowing) apply(); if (typeof syncNavMore === 'function') syncNavMore(); };
  let overflowing = false;
  const apply = () => {
    const bottom = isBottom();
    placeChrome(bottom);
    // 不是一级页（会话详情 / 二级页）时底栏本来就不在，收起状态一并清掉，回一级页时是展开的。
    if (!bottom) navScrollReset();
    // 宽屏时菜单入口可能尚未挂入 DOM；重新展示时读取当前连接状态。
    connection.querySelector('.nav-connection-status').textContent = conn?.querySelector('.conn-text')?.textContent || '连接中…';
    const pinned = id => saved.find(x => x.id === id)?.position === 'main';
    const shown = [];
    for (const item of saved) {
      const e = entries.find(e => e.id === item.id), name = item.label || e.name;
      e.el.querySelector('.tab-label').textContent = name; e.el.title = name; e.el.setAttribute('aria-label',name);
      e.el.toggleAttribute('data-recent', false);
      // 会话在会话区，不进产物区；产物固定在产物区第一位；应用 = 置顶的 + 最近激活的 1 个未置顶的。
      // 手机上会话不占底栏：它是盖在所有应用上方的一层，下拉进入、在列表里上推退出（session-drawer.js）。
      if (item.id === 'rt') { e.el.hidden = false; e.el.toggleAttribute('data-drawer', bottom); continue; }
      const isRecent = e.app && !pinned(item.id) && item.position !== 'hidden' && recent?.kind === 'app' && item.id === recent.id;
      const show = e.available && (item.id === 'artifacts' || (e.app && (pinned(item.id) || isRecent)));
      e.el.hidden = !show;
      e.el.toggleAttribute('data-recent', isRecent);
      if (show) shown.push(e.el); else hiddenBox.append(e.el);
    }
    // 产物区顺序：产物 → 置顶的内置应用 → 置顶的小游戏等 → 最近激活的 1 个（未置顶）。
    const rank = el => el.dataset.view === 'artifacts' ? 0 : el.hasAttribute('data-recent') ? 3 : el.hasAttribute('data-game') ? 2 : 1;
    const wanted = new Set(pinnedGames.map(g => g.id));
    const recentGame = recent?.kind === 'game' && !wanted.has(recent.id) ? recent : null;
    for (const [id, el] of gameTabs) if (!wanted.has(id) && id !== recentGame?.id) { el.remove(); gameTabs.delete(id); }
    for (const g of pinnedGames) { const el = gameTab(g); el.hidden = false; el.toggleAttribute('data-recent', false); shown.push(el); }
    if (recentGame) { const el = gameTab(recentGame); el.hidden = false; el.toggleAttribute('data-recent', true); shown.push(el); }
    shown.sort((x, y) => rank(x) - rank(y));
    for (const el of shown) nav.insertBefore(el, moreBtn);
    syncActive();
    window.piSessionDrawer?.refresh();
    const theme = document.querySelector('.theme-toggle');
    if (bottom) {
      // 底部：直接展示的入口排成标签栏，最右是「更多」；放不下的、配置在更多里的，以及夜间 / 设置 / 连接状态都收在「更多」菜单。
      connection.hidden = false;
      more.append(...(theme ? [theme] : []), settings, connection);
      // 底栏没有「更多」：想看全部去「全部产物」；状态区（夜间 / 设置 / 连接）在会话页头部的按钮里，菜单还是同一份。
      moreBtn.hidden = true;
      const style = getComputedStyle(bottomBar);
      const budget = bottomBar.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      const direct = [...nav.querySelectorAll(':scope > .tab:not([hidden]):not([data-offline])')];
      // 底栏 = 产物区：全部产物固定在第一格，置顶应用按顺序，最近激活的最后；放不下的不显示（从「全部产物」进），
      // 但当前所在的应用一定在底栏上：放不下时顶掉最后一个。
      const slots = Math.max(2, Math.floor(budget / BOTTOM_TAB_MIN));
      const kept = direct.slice(0, slots), current = direct.find(el => el.classList.contains('active'));
      if (current && !kept.includes(current)) kept[kept.length - 1] = current;
      overflowing = kept.length < direct.length;
      for (const el of direct) if (!kept.includes(el)) { el.hidden = true; hiddenBox.append(el); }
      if (typeof syncNavMore === 'function') syncNavMore();
      return;
    }
    if (isPhone()) {
      connection.hidden = false;
      if (theme) more.append(theme);
      if (document.body.classList.contains('primary-phone')) nav.append(settings, connection);
      else more.append(settings, connection);
      moreBtn.hidden = false;
      const bar = nav.parentElement, style = getComputedStyle(bar);
      const gap = parseFloat(getComputedStyle(nav).gap) || 0;
      const budget = bar.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)
        - (bar.querySelector('.brand')?.getBoundingClientRect().width || 0) - conn.getBoundingClientRect().width - 2 * (parseFloat(style.gap) || 0);
      const direct = [...nav.querySelectorAll(':scope > .tab:not([hidden]):not([data-offline])')];
      const conversation = direct.find(el => el.dataset.view === 'rt');
      let used = moreBtn.getBoundingClientRect().width + (conversation ? conversation.getBoundingClientRect().width + gap : 0);
      const overflow = new Set();
      const vertical = document.body.classList.contains('rt-phone-list') || document.body.classList.contains('primary-phone');
      for (const el of direct) {
        if (vertical || el === conversation) continue;
        const width = el.getBoundingClientRect().width + gap;
        if (used + width <= budget) used += width;
        else overflow.add(el.dataset.view);
      }
      // 溢出项与配置中的更多项一起按配置顺序排列。
      for (const item of saved) {
        const e = entries.find(e => e.id === item.id);
        if (overflow.has(item.id) || (item.position === 'more' && item.id !== 'rt')) more.insertBefore(e.el, theme || (settings.parentElement === more ? settings : null));
      }
    } else if (conn) {
      connection.hidden = true;
      conn.before(settings);
      if (theme) settings.before(theme);
    }
    // 电脑上产物区没有「更多」：不置顶的应用从产物页进入。
    moreBtn.hidden = !isPhone();
    if (moreBtn.hidden) more.hidden = true;
    if (typeof syncNavMore === 'function') syncNavMore();
  };
  // 服务端配置应用：先落到本机缓存，再按同一套 apply() 排布，保证多端看到同一份顺序 / 位置 / 名称。
  const applyServer = payload => {
    if (!payload || payload.version !== 1 || !Array.isArray(payload.items)) return false;
    saved = normalize(payload);
    if (Array.isArray(payload.pinned)) pinnedGames = cleanPinned(payload.pinned);
    writeCache(localDocument());
    if (typeof rtSyncChrome === 'function') rtSyncChrome();
    apply();
    notifyChange();
    return true;
  };
  const readServer = async () => {
    const res = await fetch(serverPath, { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' });
    if (!res?.ok) throw new Error(`HTTP ${res?.status ?? 'fetch'}`);
    return await res.json();
  };
  const writeServer = async doc => {
    const res = await fetch(serverPath, { method: 'PUT', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(doc), credentials: 'same-origin', cache: 'no-store' });
    if (!res?.ok) throw new Error(`HTTP ${res?.status ?? 'fetch'}`);
    const body = await res.json();
    if (!body || body.version !== 1) throw new Error('服务端返回的导航配置格式不对');
    serverRevision = Number(body.revision) || 0; serverUpdatedAt = body.updatedAt ?? null;
    pending = false; writePending(false);
    return body;
  };
  // 读取服务端：本机有未同步的保存时先补传；服务端还没配置过时把本机旧偏好迁移上去。
  const syncWithServer = () => {
    if (serverLoading) return serverLoading;
    // 本端正在写服务端：不要用旧响应盖掉刚保存的排布；写完会由自己的 SSE 事件再核对。
    if (clientSaving > 0) return null;
    const epoch = localEpoch;
    serverLoading = (async () => {
      try {
        if (pending) { await writeServer(localDocument()); return; }
        const body = await readServer();
        if (!body || body.version !== 1 || !Array.isArray(body.items)) return;
        // 读取期间本端又保存过（或正在保存）：这份响应可能早于本机配置，不能用它覆盖。
        if (epoch !== localEpoch || clientSaving > 0 || pending) return;
        const nextRevision = Number(body.revision) || 0, nextUpdated = body.updatedAt ?? null;
        if (body.items.length === 0 && !nextUpdated) {
          const local = readCache();
          if (local && local.version === 1 && Array.isArray(local.items) && local.items.length) {
            pending = true; writePending(true);
            await writeServer(localDocument());
          }
          return;
        }
        if (nextRevision === serverRevision && nextUpdated === serverUpdatedAt) return;
        serverRevision = nextRevision; serverUpdatedAt = nextUpdated;
        applyServer(body);
      } catch { /* 断网 / 接口暂不可用：继续用本机缓存，online 或 SSE 会再试 */ }
    })().finally(() => { serverLoading = null; });
    return serverLoading;
  };
  const BOTTOM_TAB_MIN = 56;
  const GROUPS = [['main','置顶','常驻产物区；手机放不下的收在「更多」里'],['more','不置顶','平时不出现，从产物页打开后临时出现在产物区（最近 1 个）'],['hidden','隐藏','不出现在导航里，随时可以放回来']];
  const SHORT = {main:'置顶',more:'不置顶',hidden:'隐藏'};
  const historyKey = 'navSettingsPage';
  let activeSettings = null;

  /**
   * 导航设置编辑器：设置页里的「导航」和旧的独立弹窗共用同一份控件。
   * onSaved 在保存成功后调用；onChange 在草稿变化时调用（清掉「已保存」提示）。
   */
  function createEditor({ onSaved, onChange } = {}) {
    let draft = structuredClone(saved), dragId = null;
    const error = h('p',{class:'field-error nav-settings-error',role:'alert'});
    const list = h('div',{class:'nav-settings-list'});
    const saveBtn = h('button',{type:'button',class:'btn primary'},'保存');
    const resetBtn = h('button',{type:'button',class:'btn nav-settings-reset'},'恢复默认');
    // 和已保存的原样比：超长等不合法的名称也算改动，保存时再提示原因
    const dirty = () => JSON.stringify(draft) !== JSON.stringify(saved);
    const sync = () => { saveBtn.disabled = !dirty(); onChange?.(); };
    // 移到某组的某个位置（beforeId 为空 = 放到组末尾）
    const place = (id, position, beforeId) => {
      const from = draft.findIndex(x=>x.id===id); if (from < 0 || id === beforeId) return;
      const [item] = draft.splice(from,1); item.position = position;
      const at = beforeId ? draft.findIndex(x=>x.id===beforeId) : -1;
      if (at >= 0) draft.splice(at,0,item);
      else { let last = -1; draft.forEach((x,j)=>{ if (x.position===position) last=j; }); draft.splice(last+1,0,item); }
      draw();
    };
    const move = (id, direction) => {
      const item = draft.find(x=>x.id===id), peers = draft.filter(x=>x.position===item.position), i = peers.indexOf(item), target = peers[i+direction];
      if (!target) return;
      const a = draft.indexOf(item), b = draft.indexOf(target); [draft[a],draft[b]] = [draft[b],draft[a]];
      draw(); list.querySelector(`[data-nav-id="${id}"] [data-dir="${direction}"]`)?.focus();
    };
    const iconOf = (e) => { const svg = e.el.querySelector('svg'); return svg ? svg.cloneNode(true) : h('span'); };
    function row(item, position, index, count) {
      const e = entries.find(e=>e.id===item.id), gone = !e.available, off = gone || item.id === 'rt' || item.id === 'artifacts';
      return h('div',{'data-nav-id':item.id,class:`nav-settings-row${off?' off':''}`,draggable:off?false:'true',
          ondragstart:ev=>{dragId=item.id;ev.dataTransfer.effectAllowed='move';ev.currentTarget.classList.add('dragging');},
          ondragend:ev=>{dragId=null;ev.currentTarget.classList.remove('dragging');},
          ondragover:ev=>{if(dragId&&dragId!==item.id){ev.preventDefault();ev.currentTarget.classList.add('drop-before');}},
          ondragleave:ev=>ev.currentTarget.classList.remove('drop-before'),
          ondrop:ev=>{ev.preventDefault();ev.stopPropagation();ev.currentTarget.classList.remove('drop-before');if(dragId)place(dragId,position,item.id);}},
        h('span',{class:'nav-settings-grip','aria-hidden':'true',title:off?'':'拖动排序'},'⋮⋮'),
        h('span',{class:'nav-settings-icon','aria-hidden':'true'},iconOf(e)),
        h('label',{class:'nav-settings-name'},
          h('span',{class:'sr-only'},`${e.name}名称`),
          h('input',{type:'text',value:item.label,placeholder:e.name,maxlength:'24','aria-label':`${e.name}名称`,disabled:gone,oninput:ev=>{item.label=ev.target.value;sync();}}),
          off?h('span',{class:'muted small nav-settings-note'},gone?'暂无内容，不可调整':item.id==='rt'?'固定在会话区':'固定在产物区第一位'):null),
        h('div',{class:'nav-settings-seg inpage-tabs',role:'radiogroup','aria-label':`${e.name}展示位置`},
          GROUPS.map(([v])=>h('label',{class:`nav-settings-seg-opt${v===position?' on':''}`},
            h('input',{type:'radio',name:`nav-pos-${item.id}`,value:v,checked:v===position,disabled:off,'aria-label':`${e.name}：${SHORT[v]}`,onchange:()=>place(item.id,v,null)}),SHORT[v]))),
        h('span',{class:'nav-settings-order'},
          h('button',{type:'button',class:'nav-settings-arrow','data-dir':'-1','aria-label':`${e.name}上移`,title:'上移',disabled:off||index===0,onclick:()=>move(item.id,-1)},'↑'),
          h('button',{type:'button',class:'nav-settings-arrow','data-dir':'1','aria-label':`${e.name}下移`,title:'下移',disabled:off||index===count-1,onclick:()=>move(item.id,1)},'↓')));
    }
    function draw(){
      list.replaceChildren(...GROUPS.map(([position,title,hint])=>{
        const items = draft.filter(x=>x.position===position);
        return h('section',{class:'nav-settings-group','data-group':position,
            ondragover:ev=>{if(dragId){ev.preventDefault();ev.currentTarget.classList.add('drop-in');}},
            ondragleave:ev=>{if(!ev.currentTarget.contains(ev.relatedTarget))ev.currentTarget.classList.remove('drop-in');},
            ondrop:ev=>{ev.preventDefault();ev.currentTarget.classList.remove('drop-in');if(dragId)place(dragId,position,null);}},
          h('h3',{},title,h('span',{class:'nav-settings-count'},String(items.length)),h('span',{class:'muted small nav-settings-hint'},hint)),
          items.length ? items.map((item,i)=>row(item,position,i,items.length)) : h('p',{class:'nav-settings-empty muted small'},'拖到这里，或在右侧选「',SHORT[position],'」'));
      }));
      sync();
    }
    const reset = () => { draft=defaults(); error.textContent=''; draw(); };
    const save = () => {
      if(draft.some(x=>/[\r\n]/.test(x.label)||[...x.label.trim()].length>12)){error.textContent='名称最多 12 个字符，且不能换行';return false;}
      const next=normalize({version:1,items:draft});
      const doc={version:1,items:next,pinned:pinnedGames};
      try{localStorage.setItem(key,JSON.stringify(doc));}catch{error.textContent='保存失败：浏览器存储不可用，请重试';return false;}
      saved=next;
      // 一级页的底栏由页面框架决定，先同步框架再排布。
      if(typeof rtSyncChrome==='function')rtSyncChrome();
      apply();
      error.textContent='';
      sync();
      onSaved?.();
      // 先本机生效，再写服务端：断网时页面照常可用，联网后自动补传。
      pending=false;writePending(false);localEpoch++;
      clientSaving++;
      void writeServer(doc).then(() => { error.textContent=''; }).catch(() => {
        pending=true;writePending(true);
        error.textContent='已保存在本机，但同步到服务端失败；联网后会自动重试';
        if(typeof announce==='function')announce('导航已保存在本机，服务端同步失败，联网后自动重试');
      }).finally(() => { clientSaving = Math.max(0, clientSaving - 1); });
      return true;
    };
    saveBtn.addEventListener('click', save);
    resetBtn.addEventListener('click', reset);
    draw();
    return { list, error, saveBtn, resetBtn };
  }

  // 与其它导航项同款：线条图标（22px）＋下方短名；齿轮占满画布，缩到 80% 与其它图标的留白一致（线宽相应加粗）
  const gear = document.createElement('template');
  gear.innerHTML = '<svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g transform="translate(2.4 2.4) scale(.8)" stroke-width="2.25"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></g></svg>';
  const settings = h('button', {type:'button',class:'tab-more nav-settings-button',title:'全局设置：本设备能力、导航、版本与故障上报','aria-label':'设置',onclick:openSettings}, gear.content.firstChild, h('span',{class:'tab-label'},'设置'));
  // runtime 有新稳定版（设置 → 运行时更新）：和「能力未开启」共用设置按钮上的红点；半小时内不重复读，读失败（未登录等）当作没有
  let runtimeUpdateCount = 0, runtimeUpdateAt = 0, runtimeUpdateBusy = false;
  const syncRuntimeUpdateAlert = async () => {
    if (runtimeUpdateBusy || Date.now() - runtimeUpdateAt < 30 * 60_000) return;
    runtimeUpdateBusy = true;
    try {
      const r = await fetch('/api/runtime-updates/summary', { credentials: 'same-origin', headers: { accept: 'application/json' } });
      runtimeUpdateCount = r.ok ? Number((await r.json()).alertCount) || 0 : 0;
      runtimeUpdateAt = Date.now();
    } catch { /* 离线：保持原状，下次再读 */ }
    runtimeUpdateBusy = false;
    syncCapabilityAlert();
  };
  const syncCapabilityAlert = () => {
    const missing = (window.sessionNotifications?.supported?.() && !window.sessionNotifications.enabled())
      || (window.piClipboardImages?.supported?.() && !window.piClipboardImages.enabled())
      || (window.piRecentPhotos?.supported?.() && !window.piRecentPhotos.enabled());
    const hasAlert = !!missing || runtimeUpdateCount > 0;
    const alertTitle = missing ? '全局设置：本设备有能力尚未开启' : runtimeUpdateCount > 0 ? '全局设置：有 runtime 出了新的稳定版' : '全局设置：本设备能力、导航、版本与故障上报';
    const alertDesc = missing ? '本设备有能力尚未开启' : runtimeUpdateCount > 0 ? '有运行时可更新' : '';
    settings.classList.toggle('has-capability-alert', hasAlert);
    settings.title = alertTitle;
    // 桌面端设置入口在会话列表头部右侧（rt-settings-link），红点与原因提示同步（保持 aria-label="设置" 不变）
    document.querySelectorAll('.rt-settings-link').forEach(el => {
      el.classList.toggle('has-capability-alert', hasAlert);
      el.title = alertTitle;
      if (alertDesc) el.setAttribute('aria-description', alertDesc);
      else el.removeAttribute('aria-description');
    });
  };
  window.addEventListener('pi-capabilities-change', syncCapabilityAlert);
  window.addEventListener('load', syncCapabilityAlert);
  window.addEventListener('focus', () => { syncCapabilityAlert(); void syncRuntimeUpdateAlert(); });
  syncCapabilityAlert();
  setTimeout(() => { void syncRuntimeUpdateAlert(); }, 3000);
  // 设置页里忽略 / 重新检测之后立刻刷新红点
  window.addEventListener('pi-runtime-updates-change', () => { runtimeUpdateAt = 0; void syncRuntimeUpdateAlert(); });
  const connection = h('button', {type:'button', class:'tab-more nav-connection-button', 'aria-label':'连接状态', popovertarget:'conn-detail', 'aria-controls':'conn-detail', 'aria-expanded':'false', onclick:()=>{ if (typeof rtSetNavOpen === 'function') rtSetNavOpen(false); }}, h('span',{class:'nav-connection-icon','aria-hidden':'true'},'●'), h('span',{class:'nav-connection-copy'},h('span',{class:'tab-label'},'连接状态'),h('span',{class:'nav-connection-sub'},h('span',{class:'nav-connection-status'},document.querySelector('#conn .conn-text')?.textContent || '连接中…'),h('span',{class:'nav-connection-net',hidden:true})),h('span',{class:'nav-connection-host','data-pending':'1','aria-hidden':'true'})), h('span',{class:'nav-connection-chevron','aria-hidden':'true'},'›'));
  document.getElementById('conn-detail')?.addEventListener('beforetoggle', event => connection.setAttribute('aria-expanded', String(event.newState === 'open')));
  // Android 壳报告的网络（局域网直连 / 公网隧道）：不点开就能在这一行看到。事件与读取两条路都接，不依赖脚本加载顺序。
  // Mac Mini 资源占比的缩略行：这一行在屏幕上可见时才刷新（host-stats.js 负责轮询与绘制）。
  window.piHostStats?.attachCompact?.(connection.querySelector('.nav-connection-host'), connection);
  const netLabel = connection.querySelector('.nav-connection-net');
  const showNet = badge => {
    netLabel.hidden = !badge; netLabel.textContent = badge?.text || ''; netLabel.dataset.mode = badge?.mode || '';
    connection.setAttribute('aria-label', badge ? `连接状态，${badge.text}` : '连接状态');
  };
  window.addEventListener('pi-network-change', event => showNet(event.detail));
  showNet(window.piAndroidShell?.badge?.() ?? null);
  // 设置放在竖栏底部（实时连接上方）；顶栏（手机）里排在导航之后
  const conn = document.getElementById('conn');
  if (conn) conn.before(settings); else nav.after(settings);

  window.piOpenSettings = () => openSettings();
  /** 打开平台设置；没有新版设置路由时退回旧的全屏导航设置（兼容单独加载此脚本的场景）。 */
  function openSettings() {
    if (typeof window.piRouteModules?.has === 'function' && window.piRouteModules.has('settings')) {
      more.hidden = true;
      location.hash = '#/settings';
      return;
    }
    open();
  }

  window.addEventListener('popstate', () => {
    if (history.state?.[historyKey]) { if (!activeSettings) open(true); }
    else activeSettings?.();
  });
  window.addEventListener('hashchange', () => activeSettings?.());

  // 设置页 → 导航：直接嵌入同一个编辑器。旧弹窗仍保留给未加载设置路由的场景。
  window.navSettingsPanel = ({ onSaved } = {}) => {
    const status = h('p',{class:'muted small nav-settings-saved',role:'status'});
    const editor = createEditor({ onSaved: () => { status.textContent='已保存'; onSaved?.(); }, onChange: () => { status.textContent=''; } });
    return h('section',{class:'card settings-card nav-settings-embedded','aria-labelledby':'settings-nav-title'},
      h('div',{class:'settings-card-head'},
        h('div',{},h('h2',{id:'settings-nav-title'},'导航'),
          h('p',{class:'muted small'},'改名称、选「置顶」或「不置顶」，拖动或用 ↑↓ 调整顺序。置顶的应用常驻产物区，保存到平台账号，登录的其它设备会同步。'))),
      h('div',{class:'nav-settings-content'},
        editor.list,
        // 导航的保存 / 恢复默认紧跟配置列表；本机正文缓存已从这个页面移出，成为设置里与「导航」并列的「会话缓存」。
        h('footer',{class:'nav-settings-actions'},
          editor.resetBtn,
          editor.error,
          status,
          editor.saveBtn)));
  };

  function open(fromHistory = false) {
    if (activeSettings) return;
    const pageMode = isPhone();
    const background = [];
    const dismiss = () => {
      if (!dialog.isConnected) return;
      if (!pageMode) dialog.close();
      dialog.remove();
      background.forEach(([el, inert]) => { el.inert = inert; });
      document.body.classList.remove('nav-settings-open');
      window.removeEventListener('keydown', escapePage);
      activeSettings = null;
      const trigger = isPhone() ? moreBtn : settings;
      trigger.focus({preventScroll:true});
    };
    const close = () => {
      dismiss();
      if (pageMode && history.state?.[historyKey]) history.back();
    };
    const escapePage = event => { if (pageMode && event.key === 'Escape') { event.preventDefault(); close(); } };
    const editor = createEditor({ onSaved: close });
    const dialog = h(pageMode ? 'section' : 'dialog',{class:`nav-settings-dialog${pageMode?' nav-settings-page':''}`,'aria-labelledby':'nav-settings-title',...(pageMode?{role:'region',tabindex:'-1'}:{})},
      h('header',{class:'nav-settings-head'},
        pageMode ? h('button',{type:'button',class:'nav-settings-back','aria-label':'返回',onclick:close},'‹') : null,
        h('div',{},h(pageMode?'h1':'h2',{id:'nav-settings-title'},'导航设置'),pageMode?null:h('p',{class:'muted small'},'改名称、选「置顶」或「不置顶」，拖动或用 ↑↓ 调整顺序。置顶的应用常驻产物区，保存到平台账号，登录的其它设备会同步。')),
        pageMode ? editor.saveBtn : h('button',{type:'button',class:'nav-settings-x','aria-label':'关闭',title:'关闭（Esc）',onclick:close},'×')),
      h('div',{class:'nav-settings-content'},
        pageMode ? h('p',{class:'muted nav-settings-intro'},'按你的习惯安排导航。导航调整保存在服务端，登录的其它设备会同步。') : null,
        editor.list,
        pageMode ? h('p',{class:'muted small nav-settings-footnote'},'产物固定在产物区第一位；置顶的应用放不下时，手机上会收进「更多」。用 ↑↓ 调整同组顺序。') : null),
      h('footer',{class:'nav-settings-actions'},
        editor.resetBtn,
        editor.error,
        h('button',{type:'button',class:'btn',onclick:close},'取消'),
        pageMode ? null : editor.saveBtn));
    dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
    if (pageMode) {
      more.hidden = true;
      for (const el of document.body.children) {
        if (['SCRIPT','STYLE','LINK'].includes(el.tagName)) continue;
        background.push([el, el.inert]); el.inert = true;
      }
      document.body.classList.add('nav-settings-open');
      if (fromHistory !== true) history.pushState({...history.state,[historyKey]:true},'');
    }
    document.body.append(dialog);
    activeSettings = dismiss;
    if (pageMode) { dialog.querySelector('.nav-settings-back').focus({preventScroll:true}); window.addEventListener('keydown', escapePage); }
    else dialog.showModal();
  }

  // 新建会话：会话区按钮与「双击 Ctrl」共用；流程与会话列表上的「＋ 新建会话」一致。
  const newSession = () => {
    const href = typeof rtNewModeHref === 'function' ? rtNewModeHref() : '#/rt/new';
    if (typeof rtMarkNewEntry === 'function') rtMarkNewEntry('list');
    if (typeof rtSetListOpen === 'function') rtSetListOpen(false);
    more.hidden = true;
    if (typeof ui !== 'undefined' && ui.rt?.launch?.req) { ui.rt.launch = null; if (location.hash === href && typeof renderMain === 'function') renderMain(); }
    if (location.hash !== href) location.hash = href;
    // 页面渲染好后把光标放进输入框，Ctrl Ctrl 之后直接就能打字。
    const until = Date.now() + 1500;
    const focusInput = () => {
      const box = document.querySelector('#main textarea');
      if (box && box.offsetParent) { box.focus({ preventScroll: true }); return; }
      if (Date.now() < until) setTimeout(focusInput, 80);
    };
    setTimeout(focusInput, 80);
  };
  window.piNewSession = newSession;
  // 双击 Ctrl：两次「干净」的 Ctrl 按下松开（中间没按别的键、没点鼠标）间隔 ≤ 450ms；按住不放的重复事件不算。
  let ctrlClean = false, ctrlAt = 0;
  window.addEventListener('keydown', event => {
    if (event.key === 'Control') { if (!event.repeat) ctrlClean = true; return; }
    ctrlClean = false; ctrlAt = 0;
  }, true);
  window.addEventListener('pointerdown', () => { ctrlClean = false; ctrlAt = 0; }, true);
  window.addEventListener('keyup', event => {
    if (event.key !== 'Control' || !ctrlClean) return;
    ctrlClean = false;
    const now = performance.now();
    if (ctrlAt && now - ctrlAt <= 450) { ctrlAt = 0; if (!document.querySelector('dialog[open]')) newSession(); }
    else ctrlAt = now;
  }, true);
  const setRecent = next => { recent = next; saveRecent(); apply(); };
  window.navNoteVisit = view => {
    const e = entries.find(x => x.id === view);
    if (!e?.app || saved.find(x => x.id === view)?.position === 'main' || (recent?.kind === 'app' && recent.id === view)) return;
    setRecent({ kind: 'app', id: view });
  };
  window.navNoteGame = item => {
    if (!item?.id || !/^[a-z][a-z0-9-]*$/.test(item.category || '') || pinnedGames.some(g => g.id === item.id) || (recent?.kind === 'game' && recent.id === item.id)) return;
    setRecent({ kind: 'game', id: item.id, category: item.category, name: String(item.name || item.id).slice(0, 40), emoji: item.emoji || '' });
  };
  // 本机先生效，再写服务端；断网时标记待同步，联网后补传（和导航编辑器保存同一套）。
  const persist = () => {
    writeCache(localDocument());
    apply(); notifyChange();
    pending = false; writePending(false); localEpoch++; clientSaving++;
    void writeServer(localDocument()).catch(() => { pending = true; writePending(true); })
      .finally(() => { clientSaving = Math.max(0, clientSaving - 1); });
  };
  // 产物页用：列出内置应用、读写置顶。
  window.piNav = {
    apps: () => entries.filter(e => e.app && e.available).map(e => { const it = saved.find(x => x.id === e.id); return { id: e.id, name: it?.label || e.name, title: e.desc, icon: e.el.querySelector('svg')?.cloneNode(true) || null, pinned: it?.position === 'main' }; }),
    setAppPinned: (id, on) => {
      const i = saved.findIndex(x => x.id === id); if (i < 0) return;
      const [item] = saved.splice(i, 1); item.position = on ? 'main' : 'more';
      if (on) { let last = -1; saved.forEach((x, j) => { if (x.position === 'main') last = j; }); saved.splice(last + 1, 0, item); }
      else saved.splice(i, 0, item);
      if (on && recent?.kind === 'app' && recent.id === id) { recent = null; saveRecent(); }
      persist();
    },
    gamePinned: id => pinnedGames.some(g => g.id === id),
    setGamePinned: (item, on) => {
      pinnedGames = pinnedGames.filter(g => g.id !== item.id);
      if (on) pinnedGames = cleanPinned([...pinnedGames, { id: item.id, category: item.category, name: item.name, emoji: item.emoji || '' }]);
      if (on && recent?.kind === 'game' && recent.id === item.id) { recent = null; saveRecent(); }
      persist();
    },
    pinnedCount: () => pinnedGames.length + saved.filter(x => entries.find(e => e.id === x.id)?.app && x.position === 'main').length,
    onChange: fn => { changeListeners.add(fn); return () => changeListeners.delete(fn); }
  };
  window.setNavAvailability = (id, available) => { const e=entries.find(e=>e.id===id);if(e&&e.available!==available){e.available=available;apply();} };
  const closeMore = () => {
    more.hidden = true; if (typeof syncNavMore === 'function') syncNavMore();
  };
  more.addEventListener('click', event => { if (isPhone() && event.target.closest('button')) closeMore(); });
  document.addEventListener('click', event => { if (isPhone() && !more.contains(event.target) && !moreBtn.contains(event.target) && !event.target.closest?.('[data-nav-more-trigger]')) closeMore(); });
  // 会话页头部的「状态」按钮：开关同一份菜单（夜间 / 设置 / 连接状态）
  window.navToggleStatus = () => { more.hidden = !more.hidden; if (typeof syncNavMore === 'function') syncNavMore(); };
  window.navStatusIcon = () => { const icon = settings.querySelector('svg')?.cloneNode(true); icon?.classList.remove('tab-icon'); return icon || null; };
  document.addEventListener('keydown', event => {
    if (isPhone() && event.key === 'Escape' && !more.hidden) { closeMore(); moreBtn.focus(); }
  });
  phone.addEventListener('change', () => { closeMore(); apply(); });
  // 夜间模式按钮可能在 DOMContentLoaded 时才挂载。
  window.syncNavLayout = () => { navScrollReset(); apply(); };
  let layoutFrame = 0;
  const scheduleLayout = () => {
    if (layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => { layoutFrame = 0; if (isPhone()) apply(); });
  };
  window.addEventListener('resize', () => { if (isPhone()) apply(); });
  if (window.ResizeObserver) {
    const observer = new ResizeObserver(scheduleLayout);
    observer.observe(topbar);
    observer.observe(bottomBar);
    if (conn) observer.observe(conn);
    const conversation = entries.find(e => e.id === 'rt');
    if (conversation) observer.observe(conversation.el);
  }
  document.fonts?.ready.then(scheduleLayout);
  // 其它标签页 / 设备保存后：SSE 调 navSettingsRemoteUpdate 重读；同一浏览器的其它标签页也会收到 storage 事件。
  window.navSettingsRemoteUpdate = () => syncWithServer();
  window.navSettingsSync = () => syncWithServer();
  window.addEventListener('online', () => { void syncWithServer(); });
  window.addEventListener('storage', event => {
    if (event.key === pendingKey) { pending = event.newValue === '1'; return; }
    if (event.key !== key) return;
    const raw = readCache();
    if (!raw) return;
    localEpoch++;
    saved = normalize(raw); pinnedGames = cleanPinned(raw.pinned);
    apply(); notifyChange();
  });
  apply();
  void syncWithServer();
  if (history.state?.[historyKey]) open(true);
}
initNavSettings();
