// 分段控件的「选中气泡」（v3.78 液态玻璃）：所有「同组互斥」的切换控件（页签条、筛选胶囊行）共用。
// 样式在 styles.css（--glass-bubble*）；这里只做一件事：量出当前选中项的位置，写成 --ind-x / --ind-y / --ind-w / --ind-h，
// 气泡（容器的 ::before）靠这几个变量定位，位置变了由 CSS 过渡滑过去。
//
// 选中项的标记各页写法不同：.active / .on / .selected / aria-selected / aria-pressed / aria-checked，都认。
// 恰好一个选中项 → 气泡滑动；有多个选中项（多选的筛选）→ 不画气泡，选中的胶囊各自带气泡底色（容器上加 seg-multi）。
// 分段控件会随局部刷新被整块换成新节点：按「类名 + aria-label」记住上一次的位置，新节点先把气泡放回旧位置（不带过渡）、
// 再设到新位置，才会「从旧位置滑过去」；位置没变就不动。
(() => {
  if (typeof document === "undefined" || typeof MutationObserver !== "function") return;
  const GROUPS = [
    ".notes-kind-tabs", ".notes-today-switch",            // 待办：类型切换、今天卡片 人 / Agent
    ".rt-tabs", ".rt-memory-tabs", ".rtc-lane-tabs", ".room-round-tabs", // 会话详情 / 新建 / 对比 / 群聊的页签
    ".inpage-tabs",                                      // 通讯录、关系视图、推荐详情及设置分段
    ".pm-tabs", ".pi-memory-tabs",                          // 记忆页、资源页的视图页签
    ".rt-chips", ".pm-filter-line", ".pm-typechips", ".resource-filters", ".resource-quick-switch", ".ds-tabs" // 筛选胶囊行
  ].join(",");
  const ACTIVE = ".active, .on, .selected, [aria-selected='true'], [aria-pressed='true'], [aria-checked='true']";
  const last = new Map();
  const watched = new WeakSet();
  let resizeObserver = null;

  const keyOf = (el) => el.dataset.segKey || `${el.className.replace(/\b(ind-ready|seg-multi)\b/g, "").trim()}|${el.getAttribute("aria-label") || ""}`;

  function sync(el) {
    const active = [...el.children].filter((c) => c.matches(ACTIVE));
    el.classList.toggle("seg-multi", active.length > 1);
    if (active.length !== 1) { el.style.setProperty("--ind-o", "0"); return; }
    const a = active[0];
    if (!a.offsetWidth || !a.offsetHeight) return;           // 容器还没显示：等 ResizeObserver 再来
    const box = { x: a.offsetLeft, y: a.offsetTop, w: a.offsetWidth, h: a.offsetHeight };
    const set = (b) => {
      el.style.setProperty("--ind-x", `${b.x}px`); el.style.setProperty("--ind-y", `${b.y}px`);
      el.style.setProperty("--ind-w", `${b.w}px`); el.style.setProperty("--ind-h", `${b.h}px`);
      el.style.setProperty("--ind-o", "1");
    };
    const key = keyOf(el), prev = last.get(key);
    const moved = prev && (prev.x !== box.x || prev.y !== box.y || prev.w !== box.w || prev.h !== box.h);
    // 换行排的胶囊：选中项跨行时气泡不滑（斜着划过别的胶囊，像叠了一层幻影），直接落到新位置。
    if (moved && prev.y !== box.y) {
      el.classList.remove("ind-ready"); set(box); void el.offsetWidth; el.classList.add("ind-ready"); last.set(key, box); return;
    }
    if (!el.classList.contains("ind-ready")) {
      if (moved) { set(prev); void el.offsetWidth; el.classList.add("ind-ready"); set(box); }
      else { set(box); requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("ind-ready"))); }
    } else set(box);
    last.set(key, box);
  }

  function syncAll() {
    window.piTabSwipeSync?.();
    document.querySelectorAll(GROUPS).forEach((el) => {
      if (!watched.has(el) && typeof ResizeObserver === "function") {
        watched.add(el);
        resizeObserver = resizeObserver || new ResizeObserver((entries) => entries.forEach((e) => sync(e.target)));
        resizeObserver.observe(el);
      }
      sync(el);
    });
  }

  let frame = 0;
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(syncAll); };
  const relevant = (r) => r.type === "attributes"
    ? !!r.target.closest?.(GROUPS)
    : [...r.addedNodes].some((n) => n.nodeType === 1 && (n.matches?.(GROUPS) || n.querySelector?.(GROUPS)));
  new MutationObserver((records) => { if (records.some(relevant)) schedule(); })
    .observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "aria-selected", "aria-pressed", "aria-checked", "hidden"] });
  window.addEventListener("resize", schedule);
  document.fonts?.ready?.then(schedule);
  schedule();
  window.piSegSync = syncAll;
})();

// 页内内容切换：共用待办的 56px 阈值、160ms 滑出及 240ms 滑入。
// 只调用已有 Tab 的 click；业务状态、懒加载、焦点处理仍由各应用负责。
(() => {
  if (window.piTabSwipe) return;
  const specs = [
    ['.com-tabs', '.communications', ':scope > :not(.com-heading):not(.com-tabs)'],
    ['.pm-viewtabs', '.pm-page', '.pi-memory-content'],
    ['.resource-filters', '.resources', ':scope > .resource-section, :scope > .resource-empty'],
    ['.pi-memory-tabs', '.pi-memory-panel', '.pi-memory-layout'],
    ['.relation-tabs', '.entry-relations', '.relation-content'],
    ['.note-iteration-tabs', '.note-iteration-card', '.note-iteration-panel:not([hidden])'],
    ['.rt-memory-tabs', '.rt-memory-card', ':scope > :not(.rt-card-head)'],
    ['.rtc-lane-tabs', '.rtc-side, .room-round', '.rtc-cards, .room-round-cards'],
    ['.rt-tabs', '.rtc-page, .rt-center, .room-round', ':scope > :not(:has(.rt-tabs)):not(.rt-tabs)'],
    // 产物保留已有跟手 / 动画实现，这里只补应用级仲裁，不安装第二套手势。
    ['.artifact-tabs', '.artifacts-page', '.artifact-swipe', true]
  ];
  const active = el => el.matches('.active, [aria-selected=true], [aria-pressed=true]');
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const buttons = group => [...group.children].filter(el => el.matches('button, [role=tab]') && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && el.getClientRects().length);
  const entries = () => specs.flatMap((spec, kind) => [...document.querySelectorAll(spec[0])].map((group, index) => {
    const scope = group.closest(spec[1]);
    return scope ? { group, scope, panels: [...scope.querySelectorAll(spec[2])].filter(el => !el.contains(group)), legacy: spec[3], kind, index } : null;
  }).filter(Boolean));
  const find = target => entries().filter(e => e.scope.contains(target) && (e.group.contains(target) || e.panels.some(p => p.contains(target))))
    .sort((a, b) => a.scope.contains(b.scope) ? 1 : b.scope.contains(a.scope) ? -1 : a.group.classList.contains('rtc-lane-tabs') ? -1 : 1)[0];
  const directional = (target, dx) => {
    const candidates = entries().filter(e => e.scope.contains(target) && (e.group.contains(target) || e.panels.some(p => p.contains(target))));
    candidates.sort((a, b) => a.scope === b.scope ? Number(b.group.matches('.rtc-lane-tabs')) - Number(a.group.matches('.rtc-lane-tabs')) : a.scope.contains(b.scope) ? 1 : -1);
    return candidates.find(e => neighbour(e, dx)) || find(target);
  };
  const neighbour = (e, dx) => { const list = buttons(e.group), from = list.findIndex(active); return from < 0 ? null : list[from + (dx < 0 ? 1 : -1)] || null; };
  // 手机资源表已变成纵向卡片，不应再按横向表格拦截；真正的横滚仍由后面的检测保护。
  const resourceCard = target => {
    const table = target.closest('.resources .resource-table');
    return innerWidth <= 760 && !!table && !!target.closest('.resource-row') && getComputedStyle(table).display === 'block';
  };
  const ignored = (target, e) => {
    if (target.closest('input,textarea,select,[contenteditable],pre,canvas,iframe,svg,.rt-composer,.room-composer,[data-no-app-swipe]')) return true;
    if (target.closest('table') && !(e.group.matches('.resource-filters') && resourceCard(target))) return true;
    if (document.body.classList.contains('notes-sheet-open') && !target.closest('.notes-sheet')) return true;
    const modal = document.querySelector('dialog[open],.image-zoom,.rt-lightbox,#nav-more:not([hidden])');
    if (modal && !modal.contains(e.scope)) return true;
    if (getSelection()?.toString()) return true;
    for (let el = target; el && el !== e.scope; el = el.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1) return true;
    }
    return false;
  };
  let drag = null, busy = false, swallowUntil = 0;
  const clean = e => { e.scope.classList.remove('tab-swipe-drag'); for (const p of e.panels) { p.style.removeProperty('transform'); p.style.removeProperty('opacity'); p.style.removeProperty('transition'); } };
  function enter(old, direction, expected) {
    const e = entries().find(e => e.kind === old.kind && e.index === old.index);
    if (!e || buttons(e.group).findIndex(active) !== expected || reduced()) return;
    for (const p of e.panels) {
      p.classList.remove('tab-enter-right', 'tab-enter-left'); void p.offsetWidth;
      const cls = direction > 0 ? 'tab-enter-right' : 'tab-enter-left'; p.classList.add(cls);
      const done = () => p.classList.remove(cls);
      p.addEventListener('animationend', done, { once: true }); setTimeout(done, 600);
    }
  }
  const claims = (target, dx, dy) => {
    const e = target instanceof Element && directional(target, dx);
    return !!e && (busy || ignored(target, e) || (Math.abs(dx) >= Math.abs(dy) * 1.5 && !!neighbour(e, dx)));
  };
  (window.piAppSwipeClaimers = window.piAppSwipeClaimers || []).push(claims);
  window.piTabSwipeSync = () => { for (const e of entries()) if (!e.legacy && !e.scope.classList.contains('tab-swipe-region')) e.scope.classList.add('tab-swipe-region'); };
  document.addEventListener('pointerdown', ev => {
    const previous = drag; drag = null;
    const multi = ev.pointerType === 'touch' && !!window.piOtherTouchDown?.(ev);
    if (previous?.moving) clean(previous.e);
    if (busy || multi || ev.pointerType !== 'touch' || innerWidth > 760 || ev.clientX < 24 || ev.clientX > innerWidth - 24) return;
    const e = ev.target instanceof Element && find(ev.target);
    if (!e || e.legacy || buttons(e.group).length < 2 || ignored(ev.target, e)) return;
    drag = { e, id: ev.pointerId, x: ev.clientX, y: ev.clientY, target: ev.target, hash: location.hash, width: e.scope.clientWidth || innerWidth, moving: false };
  }, { passive: true });
  document.addEventListener('pointermove', ev => {
    const g = drag; if (!g || ev.pointerId !== g.id) return;
    const dx = ev.clientX - g.x, dy = ev.clientY - g.y;
    if (!g.moving) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
      g.e = directional(g.target, dx) || g.e;
      if (Math.abs(dx) < Math.abs(dy) * 1.5 || !neighbour(g.e, dx) || ignored(g.target, g.e)) { drag = null; return; }
      g.width = g.e.scope.clientWidth || innerWidth;
      for (const p of g.e.panels) p.classList.remove("tab-enter-right", "tab-enter-left");
      g.moving = true;
    }
    if (reduced()) return;
    g.e.scope.classList.add('tab-swipe-drag');
    const offset = neighbour(g.e, dx) ? dx : 0;
    for (const p of g.e.panels) { p.style.transition = 'none'; p.style.transform = `translateX(${offset}px)`; p.style.opacity = String(Math.max(.25, 1 - Math.abs(offset) / (g.width * .9))); }
  }, { passive: true });
  const back = g => {
    if (reduced()) { clean(g.e); return; }
    for (const p of g.e.panels) { p.style.transition = 'transform 160ms ease-out, opacity 160ms ease-out'; p.style.transform = ''; p.style.opacity = ''; }
    busy = true; setTimeout(() => { clean(g.e); busy = false; }, 200);
  };
  document.addEventListener('pointerup', ev => {
    const g = drag; if (!g || ev.pointerId !== g.id) return; drag = null;
    if (!g.moving) return;
    swallowUntil = Date.now() + 400;
    const dx = ev.clientX - g.x, next = neighbour(g.e, dx);
    if (!next || Math.abs(dx) < 56) { back(g); return; }
    const from = buttons(g.e.group).findIndex(active), to = buttons(g.e.group).indexOf(next);
    const commit = () => {
      clean(g.e); busy = false;
      if (!g.e.group.isConnected || location.hash !== g.hash || buttons(g.e.group).findIndex(active) !== from) return;
      next.click();
    };
    if (reduced()) { commit(); return; }
    busy = true;
    for (const p of g.e.panels) { p.style.transition = 'transform 160ms ease-in, opacity 160ms ease-in'; p.style.transform = `translateX(${dx < 0 ? -g.width : g.width}px)`; p.style.opacity = '0'; }
    setTimeout(commit, 160);
  }, { passive: true });
  document.addEventListener('pointercancel', () => { const g = drag; drag = null; if (g?.moving) back(g); }, { passive: true });
  document.addEventListener('click', ev => {
    if (!(ev.target instanceof Element)) return;
    const e = find(ev.target), button = ev.target.closest('button, [role=tab]');
    // 只吞手势补发的内容点击，程序点击 Tab 和紧接着手点 Tab 均放行。
    if (Date.now() < swallowUntil && ev.target.closest('#main') && (!e || !e.group.contains(ev.target))) { swallowUntil = 0; ev.preventDefault(); ev.stopImmediatePropagation(); return; }
    if (!e || e.legacy || !button || !e.group.contains(button)) return;
    const list = buttons(e.group), from = list.findIndex(active), to = list.indexOf(button);
    if (from < 0 || to < 0 || from === to) return;
    requestAnimationFrame(() => enter(e, Math.sign(to - from), to));
  }, true);
  window.piTabSwipe = { claims, entries, resourceCard };
  window.piTabSwipeSync();
})();
