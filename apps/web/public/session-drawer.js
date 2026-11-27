"use strict";
/*
 * 手机上的「会话应用」不占底栏，像微信的「最近使用小程序」那样是盖在所有应用上方的一层：
 *   · 在任何其他一级应用里，页面已在最顶部时继续往下拉（有阻尼）→ 过阈值震动一下 → 松手，会话层落下；没过阈值松手则回弹。
 *   · 在会话列表里，滚到最底后继续往上推 → 过阈值震动一下 → 松手，会话层收回上方，回到下拉前的应用。
 * 会话详情（二级页）不参与：它保持原来的返回方式。
 *
 * 「之前的入口」：每次从某个一级应用进入会话（下拉、悬浮提醒、链接都算）就记下它；冷启动直接落在会话时没有记录，回到底栏第一个应用。
 * 切换动画是一张从上方（或下方）落下的「帘子」带着页面一起走，路由在帘子完全盖住屏幕时换页，再淡出帘子，不露出换页的空白。
 *
 * 不抢的地方和左右滑切换应用一致：输入控件、可横向滚动 / 自己有手势的区域、浮层 / 弹窗、屏幕左右边缘。
 * 页面里自己要用「顶部下拉」的区域可以往 window.piSessionDrawerClaimers 登记 (target) => boolean，返回 true 就让路。
 */
(function () {
  if (window.piSessionDrawer) return;
  const THRESHOLD = 72;     // 阻尼后的位移达到它 = 过阈值（震动一次，松手生效）
  const MAX = 150;          // 阻尼后的最大位移
  const DAMP = 0.6;         // 手指位移 → 页面位移
  const LOCK = 6;           // 位移超过它才判定方向（越小越早拦下浏览器自带的整页下拉刷新）
  const EDGE = 24;          // 屏幕左右边缘，留给系统返回手势
  const SETTLE_MS = 200;    // 帘子盖满 / 页面滑出的时长
  const FADE_MS = 200;      // 帘子淡出的时长
  const IGNORE = "input, textarea, select, [contenteditable], pre, table, canvas, iframe, dialog, [popover], .rt-lightbox, .image-zoom, .notes-new-fab, .rt-new-btn, [data-no-app-swipe]";
  const OVERLAYS = "dialog[open], .rt-lightbox, .image-zoom, #nav-more:not([hidden]), body.notes-sheet-open";
  const ORIGIN_KEY = "pi-agent:session-drawer-origin:v1";
  const APP_HOME = /^#\/(resources|notes|artifacts|ledger|communications|memory|web-x)(?:\/|$|\?)/;
  const inSession = (hash) => /^#\/rt(?:\/|$)/.test(hash || "");

  const root = document.documentElement;
  const reduced = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const buzz = (pattern) => { try { navigator.vibrate?.(pattern); } catch { /* 不支持震动的设备静默跳过 */ } };
  const claimers = (window.piSessionDrawerClaimers = window.piSessionDrawerClaimers || []);
  const claimed = (target) => claimers.some((fn) => { try { return !!fn(target); } catch { return false; } });
  const mainEl = () => document.getElementById("main");
  const headerBar = () => document.getElementById("rt-mobile-header");

  /* ------------------------------ 之前的入口 ------------------------------ */
  let origin = null;
  try { origin = sessionStorage.getItem(ORIGIN_KEY); } catch { /* 存储不可用时只在本页记 */ }
  let lastHash = location.hash;
  const tabFor = (view) => document.querySelector(`#phone-bottom-nav .tabs > .tab[data-view="${view}"]:not([hidden])`);
  /** 回到哪：记下的入口还在底栏上就回它，否则底栏第一个应用 */
  function returnTarget() {
    const view = origin?.match(APP_HOME)?.[1];
    if (view && tabFor(view)) return { hash: origin, view };
    const first = document.querySelector("#phone-bottom-nav .tabs > .tab[data-view]:not([hidden]):not([data-offline])");
    return first ? { hash: `#/${first.dataset.view}`, view: first.dataset.view } : { hash: "#/notes", view: "notes" };
  }
  const labelOf = (view) => (document.querySelector(`.tab[data-view="${view}"] .tab-label`)?.textContent || "").trim();
  /** 列表底部的提示文字走 CSS 变量，列表重绘不会把它冲掉 */
  function syncHint() {
    const label = labelOf(returnTarget().view).replace(/["\\\n]/g, "");
    root.style.setProperty("--session-exit-hint", `"继续上滑，回到${label ? `「${label}」` : "之前的应用"}"`);
  }
  window.addEventListener("hashchange", () => {
    const prev = lastHash; lastHash = location.hash;
    if (inSession(lastHash) && !inSession(prev)) {
      const home = prev.match(APP_HOME);
      if (home) {
        origin = `#/${home[1]}`;
        try { sessionStorage.setItem(ORIGIN_KEY, origin); } catch { /* 忽略 */ }
      }
    }
    syncHint(); syncOriginActive();
  });

  /* 会话列表里底栏选中「来源应用」：会话本身不在底栏上，选中态落在进入前的应用上，用户能直接点别的入口切走。
   * 平时选中态由 app.js 的路由写；这里在来源变了之后补一次，两边算出来的是同一个应用，先后顺序不影响结果。 */
  function syncOriginActive() {
    const b = document.body;
    if (!b.classList.contains("nav-bottom") || !b.classList.contains("rt-phone-list")) return;
    const view = returnTarget().view;
    for (const t of document.querySelectorAll("#phone-bottom-nav .tabs > .tab[data-view]")) t.classList.toggle("active", t.dataset.view === view);
  }
  new MutationObserver(syncOriginActive).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  /* -------------------------------- 手势 -------------------------------- */
  const body = () => document.body;
  /** enter：在其他一级应用里下拉进会话；exit：在会话列表里上推回入口；其余页面都不参与 */
  function mode() {
    const b = body();
    if (!b.classList.contains("nav-bottom") || b.classList.contains("settings-mode") || b.classList.contains("stats-mode")) return null;
    return b.classList.contains("rt-phone-list") ? "exit" : "enter";
  }
  const scrollsY = (el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1;
  /** 手指下面这一路滚动容器（含整页）是否都已在顶 / 底 */
  function pinned(target, side) {
    const doc = document.scrollingElement || document.documentElement;
    // 整页自己不滚（html / body 设了 overflow:hidden）时不看它
    const docScrolls = ![document.documentElement, document.body].some((el) => /^(hidden|clip)$/.test(getComputedStyle(el).overflowY));
    if (docScrolls && (side === "top" ? doc.scrollTop > 1 : doc.scrollHeight - doc.scrollTop - doc.clientHeight > 2)) return false;
    for (let el = target; el && el !== document.body; el = el.parentElement) {
      if (!scrollsY(el)) continue;
      if (side === "top" ? el.scrollTop > 1 : el.scrollHeight - el.scrollTop - el.clientHeight > 2) return false;
    }
    return true;
  }

  let gesture = null, busy = false, suppressEnterUntil = 0;
  const movers = () => { const main = mainEl(), bar = headerBar(); return main ? [main, ...(bar ? [...bar.children] : [])] : []; };

  /** 帘子：从上方（enter）或下方（exit）带着一行提示落下来，盖住换页的瞬间 */
  function curtain(kind) {
    let el = document.getElementById("session-curtain");
    if (!el) {
      el = document.createElement("div");
      el.id = "session-curtain"; el.className = "session-curtain"; el.setAttribute("aria-hidden", "true"); el.hidden = true;
      el.innerHTML = '<div class="session-curtain-body"><span class="session-curtain-icon"></span><span class="session-curtain-text"></span></div>';
      document.body.append(el);
    }
    const target = kind === "enter" ? { view: "rt" } : returnTarget();
    const icon = document.querySelector(`.tab[data-view="${target.view}"] .tab-icon`);
    const slot = el.querySelector(".session-curtain-icon");
    slot.replaceChildren(...(icon ? [icon.cloneNode(true)] : []));
    el.dataset.kind = kind;
    el.dataset.label = kind === "enter" ? "会话" : labelOf(target.view) || "之前的应用";
    return el;
  }
  function hint(el, ready) {
    const label = el.dataset.label;
    el.querySelector(".session-curtain-text").textContent = el.dataset.kind === "enter"
      ? (ready ? "松手进入会话" : "下拉进入会话")
      : (ready ? `松手回到「${label}」` : `继续上推，回到「${label}」`);
    el.classList.toggle("ready", !!ready);
  }
  function place(g, offset) {
    const sign = g.kind === "enter" ? 1 : -1, h = window.innerHeight;
    for (const el of g.movers) el.style.transform = offset ? `translateY(${sign * offset}px)` : "";
    g.curtain.style.transform = `translateY(${g.kind === "enter" ? offset - h : h - offset}px)`;
    g.curtain.style.setProperty("--reveal", String(Math.min(1, offset / 40)));
  }
  function transition(g, value) { for (const el of [...g.movers, g.curtain]) el.style.transition = value; }
  function begin(g) {
    g.movers = movers(); g.curtain = curtain(g.kind);
    hint(g.curtain, false);
    g.curtain.hidden = false;
    transition(g, "none"); place(g, 0);
    root.classList.add("session-drawer-dragging");
  }
  function cleanup(g) {
    for (const el of [...(g?.movers || movers()), ...(headerBar() ? [...headerBar().children] : [])]) { el.style.transition = ""; el.style.transform = ""; }
    const c = document.getElementById("session-curtain");
    if (c) { c.hidden = true; c.style.transition = ""; c.style.transform = ""; c.style.opacity = ""; c.classList.remove("ready"); }
    root.classList.remove("session-drawer-dragging");
    busy = false;
  }
  function springBack(g) {
    if (reduced()) { cleanup(g); return; }
    busy = true;
    transition(g, `transform ${SETTLE_MS}ms ease-out`); place(g, 0);
    setTimeout(() => cleanup(g), SETTLE_MS + 40);
  }
  /** 帘子盖满、页面滑走 → 换路由 → 内容换好后淡出帘子 */
  function commit(g) {
    const target = g.kind === "enter" ? "#/rt" : returnTarget().hash;
    busy = true;
    const go = () => {
      const main = mainEl();
      let finished = false, timer = 0, observer = null;
      const reveal = () => {
        if (finished) return; finished = true; observer?.disconnect(); clearTimeout(timer);
        for (const el of [main, ...(headerBar() ? [...headerBar().children] : [])]) if (el) { el.style.transition = ""; el.style.transform = ""; }
        if (reduced()) { cleanup(g); return; }
        g.curtain.style.transition = `opacity ${FADE_MS}ms ease-out`; g.curtain.style.opacity = "0";
        setTimeout(() => cleanup(g), FADE_MS + 40);
      };
      if (main && typeof MutationObserver === "function") { observer = new MutationObserver(reveal); observer.observe(main, { childList: true }); }
      timer = setTimeout(reveal, 500); // 内容迟迟不换（路由没变 / 模块还在加载）：兜底收尾
      if (location.hash === target) reveal(); else location.hash = target;
    };
    if (reduced()) { go(); return; }
    const sign = g.kind === "enter" ? 1 : -1, h = window.innerHeight;
    transition(g, `transform ${SETTLE_MS}ms cubic-bezier(.2,.7,.3,1)`);
    for (const el of g.movers) el.style.transform = `translateY(${sign * h}px)`;
    g.curtain.style.transform = "translateY(0)";
    setTimeout(go, SETTLE_MS);
  }

  function detach() {
    document.removeEventListener("touchmove", onMove, { passive: false });
    document.removeEventListener("touchend", onEnd);
    document.removeEventListener("touchcancel", onCancel);
  }
  function onMove(ev) {
    const g = gesture;
    if (!g) return;
    if (ev.touches.length !== 1) { onCancel(); return; }
    const t = ev.touches[0], dx = t.clientX - g.x, dy = t.clientY - g.y, along = g.kind === "enter" ? dy : -dy;
    if (!g.dragging) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < LOCK) return;
      // 方向不对（往回滑 / 横滑）：这次手势还给页面自己的滚动和左右切换
      if (along <= 0 || Math.abs(dx) > Math.abs(dy)) { detach(); gesture = null; return; }
      g.dragging = true; begin(g);
    }
    // 拦下浏览器的整页下拉刷新 / 橡皮筋，只由这一层处理
    if (ev.cancelable) ev.preventDefault();
    const offset = Math.max(0, Math.min(MAX, along * DAMP));
    place(g, offset);
    const ready = offset >= THRESHOLD;
    if (ready !== g.ready) { g.ready = ready; hint(g.curtain, ready); if (ready) buzz(14); }
  }
  function onEnd() {
    const g = gesture; gesture = null; detach();
    if (!g?.dragging) return;
    if (g.ready) commit(g); else { suppressEnterUntil = Date.now() + 300; springBack(g); }
  }
  function onCancel() {
    const g = gesture; gesture = null; detach();
    if (g?.dragging) { suppressEnterUntil = Date.now() + 300; springBack(g); }
  }
  document.addEventListener("touchstart", (ev) => {
    if (gesture) { detach(); const g = gesture; gesture = null; if (g?.dragging) springBack(g); }
    if (busy || ev.touches.length !== 1) return;
    const kind = mode(), target = ev.target, main = mainEl();
    if (!kind || !(target instanceof Element) || !main) return;
    if (!target.closest("#main, #rt-mobile-header, #session-halo")) return;
    const t = ev.touches[0];
    if (t.clientX < EDGE || t.clientX > window.innerWidth - EDGE) return;
    if (target.closest(IGNORE) || document.querySelector(OVERLAYS) || claimed(target)) return;
    if (!pinned(target, kind === "enter" ? "top" : "bottom")) return;
    gesture = { kind, x: t.clientX, y: t.clientY, dragging: false, ready: false, movers: null, curtain: null };
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onCancel);
  }, { passive: true });

  /** 不经过手指拖动直接进入 / 退出（悬浮提醒、点按）：帘子整张落下，再换页 */
  function run(kind) {
    if (busy || gesture) return false;
    if (kind === "enter" && Date.now() < suppressEnterUntil) return false;
    if (kind === "enter" ? inSession(location.hash) : !inSession(location.hash)) return false;
    const g = { kind, dragging: true, ready: true, movers: null, curtain: null };
    begin(g); hint(g.curtain, true);
    commit(g);
    return true;
  }

  syncHint(); syncOriginActive();
  /* 点底栏里选中的「来源应用」= 和上推一样的动画退回去；点别的入口走原来的路由，直接切过去 */
  document.getElementById("phone-bottom-nav")?.addEventListener("click", (ev) => {
    const tab = ev.target instanceof Element ? ev.target.closest(".tabs > .tab[data-view]") : null;
    if (!tab || !inSession(location.hash) || !document.body.classList.contains("rt-phone-list")) return;
    if (tab.dataset.view === returnTarget().view && run("exit")) ev.stopPropagation();
  }, true);
  window.piSessionDrawer = {
    enter: () => run("enter"),
    exit: () => run("exit"),
    origin: () => returnTarget().hash,
    originView: () => returnTarget().view,
    refresh: () => { syncHint(); syncOriginActive(); }, // 导航排布 / 名称变了（nav-settings.js 调用）
    busy: () => busy,
  };
})();
