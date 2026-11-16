"use strict";
/*
 * 手机底部导航的一级页：在页面上左右滑 = 切到底栏里的上一个 / 下一个应用。
 *
 * 只在 body.nav-bottom（手机一级页）生效；顺序就是底栏上直接展示的入口顺序，
 * 收在「更多」里的不参与；唯一的例外是 AI浏览器（nav-settings.js 标 data-swipe-only，不占底栏）：
 * 它排在所有入口最左边、会话的左侧，在会话页右滑拉出，在它上面左滑回会话；到头了（第一个再往右 / 最后一个再往左）不循环，只做小幅阻尼回弹。
 *
 * 页面里自己有「子 tab」且左右滑能切子 tab 的区域（例如待办页的 笔记 / 待办 / 日程，「今天」卡片的 人 / Agent），
 * 先让子 tab 滑：它在这个方向上还有下一项就归它；滑到头、这个方向没有下一项了，才轮到应用层切换。
 * 子 tab 通过 window.piAppSwipeClaimers 登记一个函数 (target, dx, dy) => boolean：
 * 返回 true 表示「这次手势归我（或者这里不能被应用级滑动打断）」，应用级切换让路。
 *
 * 其余不抢的地方：输入控件、可横向滚动的区域、浮层 / 弹窗、屏幕左右边缘（留给系统返回）、
 * 带 data-no-app-swipe 的区域、两个悬浮「＋」按钮（它们有自己的按住上滑手势）。
 */
(function () {
  if (window.piAppSwipe) return;
  const LOCK = 10;          // 位移超过它才判定方向
  const RATIO = 1.5;        // 横向位移至少是纵向的 1.5 倍才算横滑，其余留给页面滚动
  const MIN_DX = 64;        // 松手时横向位移至少这么多才切换
  const EDGE = 24;          // 屏幕左右边缘，留给系统返回手势
  const IGNORE = "input, textarea, select, [contenteditable], pre, table, canvas, iframe, dialog, [popover], .rt-lightbox, .image-zoom, .notes-new-fab, .rt-new-btn, [data-no-app-swipe]";
  const OVERLAYS = "dialog[open], .rt-lightbox, .image-zoom, #nav-more:not([hidden]), body.notes-sheet-open";

  const claimers = (window.piAppSwipeClaimers = window.piAppSwipeClaimers || []);
  const tabs = () => [...document.querySelectorAll("#phone-bottom-nav .tabs > .tab[data-view]:not([hidden]):not([data-offline])")];
  /** 滑动顺序：不占底栏的「只能滑出」页（AI浏览器）在最左边，后面是底栏入口。 */
  const order = () => { const side = document.querySelector("#phone-bottom-nav .tab[data-swipe-only]"); return side ? [side, ...tabs()] : tabs(); };
  const claimed = (target, dx, dy) => claimers.some((fn) => { try { return !!fn(target, dx, dy); } catch { return false; } });
  const horizontalScroller = (target, main) => {
    for (let el = target; el && el !== main; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1) return true;
    }
    return false;
  };

  let gesture = null, swallowUntil = 0, busy = false;
  const OUT_MS = 160;   // 滑出时长，和待办的卡片 / 大类切换一致
  const root = document.documentElement;
  const reduced = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const mainEl = () => document.getElementById("main");
  const neighbour = (direction) => {
    const list = order();
    const index = list.findIndex((el) => el.classList.contains("active"));
    return index < 0 ? null : list[index + direction] || null;
  };

  /**
   * 一起动的东西：页面内容 #main，加上手机顶栏里的页面标题栏（#rt-mobile-header 的子节点：标题、操作按钮）。
   * 标题栏是各页把自己的头部挪进顶栏的，不在 #main 里，只动 #main 的话页面在滑、顶上的标题却钉在原地。
   * 顶栏的左侧（pi logo）和底栏本身不动；标题栏的容器在滑动期间裁掉横向溢出，滑出的标题不会盖到 logo 上。
   */
  const headerBar = () => document.getElementById("rt-mobile-header");
  const movers = () => { const main = mainEl(), bar = headerBar(); return main ? [main, ...(bar ? [...bar.children] : [])] : []; };
  const animated = () => [mainEl(), headerBar()].filter(Boolean);
  let cancelEntry = null, springTimer = 0;

  /** 跟手位移，带淡出（同待办里的手感）；边界传入受限的阻尼位移。 */
  function setOffset(dx, width) {
    for (const el of movers()) {
      el.style.transform = dx ? `translateX(${dx}px)` : "";
      el.style.opacity = dx ? String(Math.max(0.25, 1 - Math.abs(dx) / (width * 0.9))) : "";
    }
  }
  function setTransition(value) { for (const el of movers()) el.style.transition = value; }
  function clearOffset() {
    // 新手势接管时，旧动画的事件 / 兜底定时器不能再清理它的定位状态。
    cancelEntry?.(); cancelEntry = null;
    clearTimeout(springTimer); springTimer = 0;
    for (const el of tabs()) el.style.color = "";
    for (const el of movers()) { el.style.transition = ""; el.style.transform = ""; el.style.opacity = ""; }
    root.classList.remove("app-sliding");
  }

  /**
   * 底栏的选中态跟手：拖动时选中气泡在当前项和相邻项之间按进度移动，两个标签的颜色同步渐变；
   * 松手够远就一路滑到目标项，没滑够则回到原来的选中项。只写 --ind-x / --ind-w 和行内 color
   * （nav-settings.js 的 MutationObserver 只盯 class / hidden，不会被这些写入打断）；底栏本身始终留在屏幕上。
   */
  const navBar = () => document.getElementById("phone-bottom-nav");
  const navGeometry = (el) => {
    const n = el.parentElement.getBoundingClientRect(), a = el.getBoundingClientRect();
    return { x: a.left - n.left, w: a.width };
  };
  const mix = (p) => `color-mix(in srgb, var(--accent) ${Math.round(p * 100)}%, var(--muted))`;
  function previewNav(direction, p) {
    const bar = navBar(), list = tabs();
    const from = list.find((el) => el.classList.contains("active")), to = direction ? neighbour(direction) : null;
    if (!bar || !from) return;
    bar.classList.add("ind-drag");
    if (!to || to.hasAttribute("data-swipe-only")) { navReset(true); return; } // 目标不在底栏上：气泡不动
    const a = navGeometry(from), b = navGeometry(to);
    bar.style.setProperty("--ind-x", `${Math.round(a.x + (b.x - a.x) * p)}px`);
    bar.style.setProperty("--ind-w", `${Math.round(a.w + (b.w - a.w) * p)}px`);
    from.style.color = mix(1 - p); to.style.color = mix(p);
  }
  /** 把气泡和颜色交还给 nav-settings.js / 样式：keepDrag 为 true 时仍保持跟手（不带过渡） */
  function navReset(keepDrag) {
    const bar = navBar();
    for (const el of tabs()) el.style.color = "";
    if (!bar) return;
    if (!keepDrag) bar.classList.remove("ind-drag");
    window.navSyncIndicator?.();
  }
  /** 松手够远：气泡立刻带着过渡滑向目标项（页面滑出的同时），颜色也交给目标项 */
  function commitNav(direction) {
    const bar = navBar(), to = neighbour(direction), from = tabs().find((el) => el.classList.contains("active"));
    if (!bar || !to || !from) return;
    if (to.hasAttribute("data-swipe-only")) { navReset(false); return; }
    bar.classList.remove("ind-drag");
    const b = navGeometry(to);
    bar.style.setProperty("--ind-x", `${Math.round(b.x)}px`);
    bar.style.setProperty("--ind-w", `${Math.round(b.w)}px`);
    from.style.color = mix(0); to.style.color = mix(1);
  }

  /** 新页面（内容 + 标题栏）从切换方向的那一侧滑入并淡入（keyframes 与待办的 tab 切换共用） */
  function slideIn(direction) {
    const targets = animated();
    if (!targets.length) return;
    clearOffset();
    if (reduced()) return;
    const cls = direction > 0 ? "app-slide-from-right" : "app-slide-from-left";
    for (const el of targets) el.classList.remove("app-slide-from-right", "app-slide-from-left");
    void targets[0].offsetWidth; // 连续快速切换时每次都从头滑入
    root.classList.add("app-sliding");
    for (const el of targets) el.classList.add(cls);
    let timer = 0;
    const cancel = () => {
      clearTimeout(timer);
      targets[0].removeEventListener("animationend", onEnd);
      for (const el of targets) el.classList.remove(cls);
    };
    const done = () => {
      if (cancelEntry !== cancel) return;
      cancel(); cancelEntry = null;
      root.classList.remove("app-sliding");
    };
    const onEnd = (ev) => { if (ev.target === targets[0]) done(); };
    cancelEntry = cancel;
    targets[0].addEventListener("animationend", onEnd);
    timer = setTimeout(done, 600); // animationend 偶尔不触发（节点被替换、标签页在后台）：兜底收尾
  }

  /** 切到相邻应用：直接点底栏上的入口，走和点按完全相同的路由逻辑。返回是否真的切了。 */
  function go(direction) {
    const next = neighbour(direction);
    if (!next) return false;
    swallowUntil = 0; // 上一次滑动补发 click 的拦截窗口还没过时，这次程序触发的点击也要放行
    next.click();
    return true;
  }

  /**
   * 滑动切换：旧页面往手指方向滑出，路由把页面换掉之后，新页面从另一侧滑入。
   * 路由是异步换内容的：滑出后先让 #main 停在透明的屏外状态，等内容真的被换掉（或 400ms 兜底）再滑入，
   * 不让旧页面在原位闪一下。
   */
  function swipeTo(direction, width, animate) {
    const main = mainEl();
    if (!main || !animate || reduced()) { if (go(direction) && main) slideIn(direction); return; }
    busy = true;
    setTransition(`transform ${OUT_MS}ms ease-in, opacity ${OUT_MS}ms ease-in`);
    for (const el of movers()) { el.style.transform = `translateX(${-direction * width}px)`; el.style.opacity = "0"; }
    setTimeout(() => {
      let entered = false, timer = 0;
      const enter = () => {
        if (entered) return; entered = true; observer.disconnect(); clearTimeout(timer);
        busy = false;
        slideIn(direction);
      };
      const observer = new MutationObserver(enter);
      observer.observe(main, { childList: true });
      timer = setTimeout(enter, 400);
      if (!go(direction)) enter();
    }, OUT_MS);
  }

  /** 没滑够：弹回原位 */
  function springBack() {
    navReset(false);
    if (reduced()) { clearOffset(); return; }
    setTransition(`transform ${OUT_MS}ms ease-out, opacity ${OUT_MS}ms ease-out`);
    for (const el of movers()) { el.style.transform = ""; el.style.opacity = ""; }
    clearTimeout(springTimer);
    springTimer = setTimeout(() => { springTimer = 0; if (!busy) clearOffset(); }, OUT_MS + 40);
  }

  document.addEventListener("pointerdown", (ev) => {
    // 多指（三指截图等）不是翻页：已经在跟手的也收回去；不看 isPrimary——系统手势吞掉抬起事件后它会一直是 false
    const g = gesture; gesture = null;
    const multi = ev.pointerType === "touch" && !!window.piOtherTouchDown?.(ev);
    if (multi && g?.dragging && mainEl()) springBack();
    if (busy || ev.pointerType !== "touch" || multi) return;
    if (!document.body.classList.contains("nav-bottom")) return;
    const target = ev.target;
    const main = mainEl();
    if (!(target instanceof Element) || !main || !main.contains(target)) return;
    if (ev.clientX < EDGE || ev.clientX > window.innerWidth - EDGE) return;
    const ignored = target.closest(IGNORE);
    // 与页内切换共用手机资源卡片例外：子 Tab 到边界后才能交给应用层。
    if ((ignored && !(ignored.matches('table') && window.piTabSwipe?.resourceCard?.(target))) || document.querySelector(OVERLAYS) || horizontalScroller(target, main)) return;
    if (!order().some((el) => el.classList.contains("active"))) return;
    gesture = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, target, locked: false, dragging: false, width: main.clientWidth || window.innerWidth || 1 };
  }, { passive: true });

  document.addEventListener("pointermove", (ev) => {
    const g = gesture;
    if (!g || ev.pointerId !== g.id) return;
    const dx = ev.clientX - g.x, dy = ev.clientY - g.y;
    if (!g.locked) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < LOCK) return;
      // 竖滑留给页面滚动；这个方向上子 tab 还能往下滑就归子 tab
      if (Math.abs(dx) < Math.abs(dy) * RATIO || claimed(g.target, dx, dy)) { gesture = null; return; }
      g.locked = true;
    }
    // 有相邻应用时正常跟手；边界只拉动一小段，松手回弹，不切页。
    const main = mainEl();
    if (!main || reduced()) return;
    if (!g.dragging) { clearOffset(); g.dragging = true; setTransition("none"); root.classList.add("app-sliding"); }
    const dir = dx < 0 ? 1 : -1, has = !!neighbour(dir);
    setOffset(has ? dx : Math.max(-24, Math.min(24, dx * 0.22)), g.width);
    previewNav(has ? dir : 0, has ? Math.min(1, Math.abs(dx) / (g.width * 0.5)) : 0);
  }, { passive: true });

  document.addEventListener("pointerup", (ev) => {
    const g = gesture; gesture = null;
    if (!g || !g.locked || ev.pointerId !== g.id) return;
    const dx = ev.clientX - g.x, direction = dx < 0 ? 1 : -1, main = mainEl();
    if (Math.abs(dx) >= MIN_DX && neighbour(direction)) {
      // 手指往左滑 = 看右边的应用
      swallowUntil = Date.now() + 400;
      if (g.dragging) commitNav(direction);
      swipeTo(direction, g.width, g.dragging);
    } else if (g.dragging && main) springBack();
  }, { passive: true });
  document.addEventListener("pointercancel", () => {
    const g = gesture; gesture = null;
    const main = mainEl();
    if (g?.dragging && main) springBack();
  }, { passive: true });

  // 滑动结束浏览器还会补一次 click：别顺手点到指尖下的卡片
  document.addEventListener("click", (ev) => {
    if (Date.now() >= swallowUntil) return;
    // 只拦页面内容上的（指尖下的卡片）；底栏等其他地方的点击照常
    if (!(ev.target instanceof Element) || !ev.target.closest("#main")) return;
    swallowUntil = 0; ev.preventDefault(); ev.stopPropagation();
  }, true);

  window.piAppSwipe = { go, tabs, busy: () => busy };
})();
