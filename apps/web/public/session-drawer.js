"use strict";
/*
 * 手机上的「会话应用」不占底栏，像微信的「最近使用小程序」那样是盖在所有应用上方的一层：
 *   · 在其他一级应用里，随时从顶部光晕 / 页头下拉，或正文在顶部时继续下拉（有阻尼）→ 过阈值震动一下 → 松手，会话层落下；没过阈值松手则回弹。
 *   · 在会话列表里，滚到最底后继续往上推 → 过阈值震动一下 → 松手，会话层收回上方，回到下拉前的应用。
 * 会话详情（二级页）不参与：它保持原来的返回方式。
 *
 * 「之前的入口」：每次从某个一级应用进入会话（下拉、悬浮提醒、链接都算）就记下它；冷启动直接落在会话时没有记录，回到底栏第一个应用。
 * 切换动画是一张从上方（或下方）落下的「帘子」带着页面一起走，路由在帘子完全盖住屏幕时换页，再淡出帘子，不露出换页的空白。
 *
 * 不抢输入与组件专用手势：横向切换禁用与纵向会话入口互相独立。
 * 不抢的地方：输入控件、可横向滚动 / 自己有手势的区域、浮层 / 弹窗、屏幕左右边缘。
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
  const FLIGHT_MS = 340;    // 智能球光印从底升顶 / 从顶落底的跨屏迁移时长
  const EMERGE_MS = 900;    // 切出后图标依次冒回来、玻璃底升回位一共占多久（与样式里的延迟合计对应）
  const IGNORE = "input, textarea, select, [contenteditable], pre, table, canvas, iframe, dialog, [popover], .rt-lightbox, .image-zoom, .notes-new-fab, .rt-new-btn";
  const OVERLAYS = "dialog[open], .rt-lightbox, .image-zoom, #nav-more:not([hidden]), body.notes-sheet-open";
  const ORIGIN_KEY = "pi-agent:session-drawer-origin:v1";
  // 从统一导航识别来源应用，新增应用无需再维护第二份页面名单。
  function appHome(hash) {
    const view = hash?.match(/^#\/([a-z][a-z0-9-]*)(?:\/|$|\?)/)?.[1];
    if (!view) return null;
    const tab = document.querySelector(`.tab[data-view="${view}"]:not([data-offline])`);
    return tab && (tab.hasAttribute("data-app") || view === "artifacts") ? { view, hash: `#/${view}` } : null;
  }
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
  // 退出时点的是哪个应用：点下去就把选中态交给它，圆点当场跟着走，不等换页后路由再补一遍
  let pendingExitView = null;
  try { origin = sessionStorage.getItem(ORIGIN_KEY); } catch { /* 存储不可用时只在本页记 */ }
  let lastHash = location.hash;
  const tabFor = (view) => document.querySelector(`#phone-bottom-nav .tabs > .tab[data-view="${view}"]:not([hidden])`);
  /** 回到哪：记下的入口还在底栏上就回它；否则回产物区自己那一页（全部产物），再不行才用底栏第一个应用 */
  function returnTarget() {
    const view = appHome(origin)?.view;
    if (view && tabFor(view)) return { hash: origin, view };
    // 底栏最右是「全部产物」，它是所有产物的入口，没记住来源时回这里
    const home = tabFor("artifacts") || document.querySelector("#phone-bottom-nav .tabs > .tab[data-view]:not([hidden]):not([data-offline])");
    return home ? { hash: `#/${home.dataset.view}`, view: home.dataset.view } : { hash: "#/notes", view: "notes" };
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
      const home = appHome(prev);
      if (home) {
        origin = home.hash;
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
    const view = pendingExitView || returnTarget().view;
    for (const t of document.querySelectorAll("#phone-bottom-nav .tabs > .tab[data-view]")) t.classList.toggle("active", t.dataset.view === view);
  }
  let wasSessionList = document.body.classList.contains("nav-bottom") && document.body.classList.contains("rt-phone-list");
  new MutationObserver(() => {
    syncOriginActive();
    const b = document.body;
    const nowList = b.classList.contains("nav-bottom") && b.classList.contains("rt-phone-list");
    const nowHome = b.classList.contains("nav-bottom") && !b.classList.contains("rt-phone-list") && !b.classList.contains("settings-mode") && !b.classList.contains("stats-mode");
    // 非手势 / 非底栏点击触发的直接离开会话（如浏览器返回、外部改 hash）：补播底栏升起与图标错峰冒出
    if (wasSessionList && nowHome && !busy && !emergeTimer && !reduced()) {
      b.classList.add("session-nav-sunk");
      void b.offsetWidth;
      emerge();
    }
    wasSessionList = nowList;
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  /* -------------------------------- 手势 -------------------------------- */
  const body = () => document.body;
  /** enter：在其他一级应用里下拉进会话；exit：在会话列表里上推回入口；其余页面都不参与 */
  function mode() {
    const b = body();
    if (!b.classList.contains("nav-bottom") || b.classList.contains("settings-mode") || b.classList.contains("stats-mode")) return null;
    return b.classList.contains("rt-phone-list") ? "exit" : "enter";
  }
  const scrollsY = (el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1;
  const parentOf = el => el.parentElement || el.getRootNode()?.host || null;
  /** 手指下面这一路滚动容器（含整页）是否都已在顶 / 底 */
  function pinned(target, side) {
    const doc = document.scrollingElement || document.documentElement;
    // 整页自己不滚（html / body 设了 overflow:hidden）时不看它
    const docScrolls = ![document.documentElement, document.body].some((el) => /^(hidden|clip)$/.test(getComputedStyle(el).overflowY));
    if (docScrolls && (side === "top" ? doc.scrollTop > 1 : doc.scrollHeight - doc.scrollTop - doc.clientHeight > 2)) return false;
    for (let el = target; el && el !== document.body; el = parentOf(el)) {
      if (!scrollsY(el)) continue;
      if (side === "top" ? el.scrollTop > 1 : el.scrollHeight - el.scrollTop - el.clientHeight > 2) return false;
    }
    return true;
  }

  // 退出手势从列表中段就接住纵向滚动，否则浏览器一旦接管原生滚动，
  // 后续 touchmove 就不可取消，触底后只能等下一次按下才能拉起下层页面。
  function scrollChain(target) {
    const chain = [], doc = document.scrollingElement || document.documentElement;
    for (let el = target; el && el !== document.body; el = parentOf(el)) {
      if (el !== doc && scrollsY(el)) chain.push(el);
    }
    if (![document.documentElement, document.body].some((el) => /^(hidden|clip)$/.test(getComputedStyle(el).overflowY)) && scrollsY(doc)) chain.push(doc);
    return chain;
  }
  function scrollBy(chain, delta) {
    for (const el of chain) {
      const before = el.scrollTop;
      el.scrollTop = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, before + delta));
      delta -= el.scrollTop - before;
      if (Math.abs(delta) < 0.5) return 0;
    }
    return delta;
  }
  let momentum = 0;
  function coast(g) {
    if (!g.scrolling || performance.now() - g.time > 80) return;
    let speed = g.speed, last = performance.now();
    const step = (now) => {
      const dt = Math.min(32, now - last); last = now;
      speed *= Math.exp(-dt / 180);
      if (!g.chain.every(el => el.isConnected) || Math.abs(speed) < 0.02 || Math.abs(scrollBy(g.chain, speed * dt)) > 0.5) { momentum = 0; return; }
      momentum = requestAnimationFrame(step);
    };
    momentum = requestAnimationFrame(step);
  }

  let gesture = null, busy = false, suppressEnterUntil = 0;
  const movers = () => { const main = mainEl(), bar = headerBar(); return main ? [main, ...(bar ? [...bar.children] : [])] : []; };

  function resolveExitTarget(override) {
    if (!override) return returnTarget();
    if (typeof override === "string") {
      const view = appHome(override)?.view || "";
      return { hash: override, view, label: view ? labelOf(view) : "" };
    }
    const view = override.view || appHome(override.hash)?.view || "";
    const hash = override.hash || (view ? `#/${view}` : returnTarget().hash);
    return { hash, view, label: override.label || (view ? labelOf(view) : "") };
  }

  /** 帘子：从上方（enter）或下方（exit）带着一行提示落下来，盖住换页的瞬间 */
  function curtain(kind, targetInfo) {
    let el = document.getElementById("session-curtain");
    if (!el) {
      el = document.createElement("div");
      el.id = "session-curtain"; el.className = "session-curtain"; el.setAttribute("aria-hidden", "true"); el.hidden = true;
      el.innerHTML = '<div class="session-curtain-body"><span class="session-curtain-icon"></span><span class="session-curtain-text"></span></div>';
      document.body.append(el);
    }
    const target = kind === "enter" ? { view: "rt" } : resolveExitTarget(targetInfo);
    const icon = target.view ? document.querySelector(`.tab[data-view="${target.view}"] .tab-icon`) : null;
    const slot = el.querySelector(".session-curtain-icon");
    slot.replaceChildren(...(icon ? [icon.cloneNode(true)] : []));
    el.dataset.kind = kind;
    el.dataset.label = kind === "enter" ? "会话" : target.label || labelOf(target.view) || "之前的应用";
    return el;
  }
  function hint(el, ready) {
    const label = el.dataset.label;
    el.querySelector(".session-curtain-text").textContent = el.dataset.kind === "enter"
      ? (ready ? "松手进入会话" : "下拉进入会话")
      : (ready ? `松手回到「${label}」` : `继续上推，回到「${label}」`);
    el.classList.toggle("ready", !!ready);
  }
  function place(g, offset, syncFx = true) {
    const sign = g.kind === "enter" ? 1 : -1, h = window.innerHeight;
    const progress = Math.min(1, Math.max(0, offset / THRESHOLD));
    for (const el of g.movers) el.style.transform = offset ? `translateY(${sign * offset}px)` : "";
    g.curtain.style.transform = `translateY(${g.kind === "enter" ? offset - h : h - offset}px)`;
    g.curtain.style.setProperty("--reveal", String(Math.min(1, offset / 40)));
    if (syncFx) {
      root.style.setProperty("--nav-drag", String(progress));
      window.piSessionIsland?.flightMove?.(g.kind, offset, offset >= THRESHOLD);
    }
  }
  function transition(g, value) { for (const el of [...g.movers, g.curtain]) el.style.transition = value; }
  function begin(g) {
    g.movers = movers(); g.curtain = curtain(g.kind, g.target);
    hint(g.curtain, false);
    g.curtain.hidden = false;
    root.dataset.drawerKind = g.kind;
    root.style.setProperty("--nav-drag", "0");
    root.classList.add("session-drawer-dragging");
    window.piSessionIsland?.flightStart?.(g.kind);
    transition(g, "none"); place(g, 0);
  }
  let emergeTimer = 0;
  function cleanup(g) {
    for (const el of [...(g?.movers || movers()), ...(headerBar() ? [...headerBar().children] : [])]) { el.style.transition = ""; el.style.transform = ""; }
    const c = document.getElementById("session-curtain");
    if (c) { c.hidden = true; c.style.transition = ""; c.style.transform = ""; c.style.opacity = ""; c.classList.remove("ready"); }
    root.classList.remove("session-drawer-dragging", "session-drawer-committing");
    delete root.dataset.drawerKind;
    root.style.removeProperty("--nav-drag");
    body().classList.remove("session-nav-sinking");
    pendingExitView = null;
    // 切出还没冒完（emergeTimer 还在跑）时不要把它掐断，让图标把这一轮走完
    if (!emergeTimer) { body().classList.remove("session-nav-sunk"); body().classList.remove("session-nav-emerge"); }
    busy = false;
  }
  /* 切出后的收尾：帘子开始淡出时，底栏从「下一层」平滑升回产物区的样子——玻璃底浮现、
     图标错峰弹性回位（延迟写在样式里）、选中边框落到目标应用身上。 */
  function emerge() {
    const b = body();
    if (!b.classList.contains("session-nav-sunk")) return;
    if (reduced()) { b.classList.remove("session-nav-sunk"); return; }
    clearTimeout(emergeTimer);
    b.classList.add("session-nav-emerge");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      root.style.removeProperty("--nav-drag");
      b.classList.remove("session-nav-sunk");
      emergeTimer = setTimeout(() => { emergeTimer = 0; b.classList.remove("session-nav-emerge"); }, EMERGE_MS);
    }));
  }
  function springBack(g) {
    if (reduced()) { window.piSessionIsland?.flightCancel?.(g.kind, 0); cleanup(g); return; }
    busy = true;
    // 取消拖动：撤掉 dragging 锁定的 transition: none，让底栏与光印同步平滑回弹
    root.classList.remove("session-drawer-dragging");
    root.classList.add("session-drawer-committing");
    root.style.removeProperty("--nav-drag");
    window.piSessionIsland?.flightCancel?.(g.kind, SETTLE_MS);
    transition(g, `transform ${SETTLE_MS}ms ease-out`); place(g, 0, false);
    setTimeout(() => cleanup(g), SETTLE_MS + 40);
  }
  /** 帘子盖满、页面滑走、光印跨屏迁移 → 换路由 → 内容换好后揭幕与底栏归位 */
  function commit(g) {
    const target = g.kind === "enter" ? "#/rt" : resolveExitTarget(g.target).hash;
    busy = true;
    root.classList.remove("session-drawer-dragging");
    root.classList.add("session-drawer-committing");
    if (g.kind === "enter") root.style.removeProperty("--nav-drag");
    // 切出：先按「下一层」锁住底栏（拖动松手时沿用已预抬高度不回落），等换页揭幕时再一鼓作气升起（emerge）；
    // 切入：保持底栏在帘子之上直接从当前位置平滑下沉
    if (g.kind === "exit") body().classList.add("session-nav-sunk");
    else if (!reduced()) body().classList.add("session-nav-sinking");
    if (!reduced()) window.piSessionIsland?.flightCommit?.(g.kind, FLIGHT_MS);
    const go = () => {
      const main = mainEl();
      let finished = false, timer = 0, observer = null;
      const reveal = () => {
        if (finished) return; finished = true; observer?.disconnect(); clearTimeout(timer);
        for (const el of [main, ...(headerBar() ? [...headerBar().children] : [])]) if (el) { el.style.transition = ""; el.style.transform = ""; }
        if (g.kind === "exit") emerge();
        window.piSessionIsland?.flightFinish?.();
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
    const t = ev.touches[0], dx = t.clientX - g.x, dy = t.clientY - g.y;
    let along = g.kind === "enter" ? dy : -dy;
    if (!g.dragging) {
      if (!g.scrolling && Math.max(Math.abs(dx), Math.abs(dy)) < LOCK) return;
      // 方向不对（往回滑 / 横滑）：这次手势还给页面自己的滚动和左右切换
      if (!g.scrolling && (along <= 0 || Math.abs(dx) > Math.abs(dy))) { detach(); gesture = null; return; }
      if (g.kind === "exit") {
        if (!ev.cancelable) { onCancel(); return; }
        ev.preventDefault();
        const delta = g.lastY - t.clientY, now = performance.now();
        g.speed = delta / Math.max(1, now - g.time); g.time = now;
        g.lastY = t.clientY; g.scrolling = true;
        const rest = scrollBy(g.chain, delta);
        // 只有触底后剩余的上滑距离才计入拉起阈值，列表滚动本身不算。
        g.y = t.clientY + Math.max(0, rest);
        along = Math.max(0, rest);
        if (!along) return;
      }
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
    if (!g?.dragging) { if (g) coast(g); return; }
    if (g.ready) commit(g); else { suppressEnterUntil = Date.now() + 300; springBack(g); }
  }
  function onCancel() {
    const g = gesture; gesture = null; detach();
    if (g?.dragging) { suppressEnterUntil = Date.now() + 300; springBack(g); }
  }
  document.addEventListener("touchstart", (ev) => {
    cancelAnimationFrame(momentum); momentum = 0;
    if (gesture) { detach(); const g = gesture; gesture = null; if (g?.dragging) springBack(g); }
    if (busy || ev.touches.length !== 1) return;
    const path = ev.composedPath().filter(node => node instanceof Element);
    const kind = mode(), target = path[0], main = mainEl();
    if (!kind || !(target instanceof Element) || !main) return;
    if (!path.some(el => el.matches("#main, #rt-mobile-header, #session-halo"))) return;
    const t = ev.touches[0];
    if (t.clientX < EDGE || t.clientX > window.innerWidth - EDGE) return;
    if (path.some(el => el.matches(IGNORE)) || document.querySelector(OVERLAYS) || claimed(target)) return;
    // 光晕所在的固定页头始终是会话入口；正文只有回到顶部才接下拉，保留正常浏览滚动。
    const fromHeader = path.some(el => el.matches("#rt-mobile-header, #session-halo"));
    if (kind === "enter" && !fromHeader && !pinned(target, "top")) return;
    gesture = { kind, x: t.clientX, y: t.clientY, lastY: t.clientY, time: performance.now(), speed: 0, chain: kind === "exit" ? scrollChain(target) : [], scrolling: false, dragging: false, ready: false, movers: null, curtain: null };
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onCancel);
  }, { passive: true });

  /** 不经过手指拖动直接进入 / 退出（悬浮提醒、点按底栏任意入口）：帘子与光印联动迁移，再换页 */
  function run(kind, target) {
    if (busy || gesture) return false;
    cancelAnimationFrame(momentum); momentum = 0;
    if (kind === "enter" && Date.now() < suppressEnterUntil) return false;
    if (kind === "enter" ? inSession(location.hash) : !inSession(location.hash)) return false;
    const g = { kind, dragging: true, ready: true, movers: null, curtain: null, target: kind === "exit" ? target : null };
    // 点是底栏上某个具体应用：选中态立刻切到它，退出动画里也不会先退回「来路」那颗圆点
    if (kind === "exit") { pendingExitView = resolveExitTarget(target).view || null; syncOriginActive(); }
    begin(g); hint(g.curtain, true);
    commit(g);
    return true;
  }

  syncHint(); syncOriginActive();
  /* 在智能球内部点底栏任意应用入口（来源应用或其他应用、置顶小游戏），统一走退出动画：
     底栏全程可见从球内态平滑升回球外态，同时智能球光印从底边滑升到顶边。 */
  document.getElementById("phone-bottom-nav")?.addEventListener("click", (ev) => {
    const tab = ev.target instanceof Element ? ev.target.closest(".tabs > .tab[data-view]:not([data-offline]), .tabs > .tab[data-game]") : null;
    if (!tab || !inSession(location.hash) || !document.body.classList.contains("rt-phone-list")) return;
    if (tab.dataset.view === "rt") return;
    let target = null;
    if (tab.dataset.game) {
      const cat = tab.dataset.category || "game";
      const label = (tab.querySelector(".tab-label")?.textContent || "").trim() || "产物";
      target = { hash: `#/artifacts/${cat}/${tab.dataset.game}`, view: "artifacts", label };
    } else if (tab.dataset.view) {
      const originTarget = returnTarget();
      target = tab.dataset.view === originTarget.view
        ? originTarget
        : { hash: `#/${tab.dataset.view}`, view: tab.dataset.view, label: labelOf(tab.dataset.view) };
    }
    if (target && run("exit", target)) ev.stopPropagation();
  }, true);
  window.piSessionDrawer = {
    enter: () => run("enter"),
    exit: (target) => run("exit", target),
    origin: () => returnTarget().hash,
    originView: () => returnTarget().view,
    refresh: () => { syncHint(); syncOriginActive(); }, // 导航排布 / 名称变了（nav-settings.js 调用）
    busy: () => busy,
  };
})();
