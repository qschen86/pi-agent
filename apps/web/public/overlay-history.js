"use strict";
/*
 * 浮层与系统返回：任何时候出现浮层 / 弹窗，系统返回（iOS 左缘右滑、Android 返回键、浏览器后退）都先关浮层，
 * 而不是把底下的页面切走。
 *
 * 做法：不逐个浮层打补丁，而是按页面上「现在有哪些浮层」来对账——
 *   - 模态 <dialog>（showModal）和打开的 popover 自动识别；
 *   - 靠 class / 状态显示的浮层（会话「更多」、会话详情、授权 / 推荐 / 待办弹层、图片查看器、日历小浮层……）登记在 SOURCES；
 *   - 每多一层浮层就压一条同 URL 的历史（state.piOverlayDepth = 层数），少一层就把这条历史退掉；
 *   - 用户按返回回到层数更少的那条历史时，从最上面一层开始关（dialog 走 cancel，其它走各自的关闭函数）。
 * 关不掉的浮层（例如不可取消的确认框）会在下一次对账时补回那条历史，返回键就停在它上面，而不是越过它。
 *
 * 已经自己管历史的视图（手机日历、分类目录、导航设置页）不在这里登记，避免两套历史互相抵消。
 */
(function () {
  if (window.piOverlays) return;
  const KEY = "piOverlayDepth";
  const call = (name, ...args) => { const fn = window[name]; if (typeof fn === "function") fn(...args); };
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  /** 点一下页面空白处：笔记 / 导航里的轻量菜单都靠 document 的外部点击收起。 */
  const outsideClick = () => document.body.click();
  const phone = () => !!window.matchMedia?.("(max-width: 760px)").matches;

  /** 靠 class / 状态显示的浮层：sel 命中即视为打开，close 收起它（el 是命中的节点）。 */
  const SOURCES = [
    { sel: ".rt-more.open", close: () => call("rtToggleMore", false) },
    { sel: ".rt-layout.info-open", close: () => call("rtSetInfoOpen", false) },
    { sel: ".rt-head .rt-grant.open", close: () => call("rtToggleNotice", false) },
    { sel: ".rt-head .rt-recommendation.open", close: () => call("rtToggleRecommendation", false) },
    { sel: ".rt-head .rt-note-pop.open", close: () => call("rtToggleNote", false) },
    { sel: "#nav-more:not([hidden])", when: phone, close: outsideClick },
    { sel: ".ledger-chat.is-open", when: phone, close: () => call("ledgerCloseChat") },
    { sel: ".room-layout.members-open", when: () => !!window.matchMedia?.("(max-width: 1100px)").matches, close: () => call("roomToggleMembers") },
    { sel: ".room-diff-drawer", close: (el) => el.querySelector(".room-diff-drawer-head button")?.click() },
    { sel: ".rt-new-workspace-panel", close: () => call("rtSetWorkspaceOpen", false) },
    { sel: ".rt-lightbox", close: () => call("rtCloseLightbox") },
    { sel: ".image-zoom", close: (el) => key(el, "Escape") },
    { sel: ".category-modal-backdrop", close: (el) => (el.querySelector(".category-modal") || el).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })) },
    { sel: ".notes-calendar-overlay", close: (el) => el.querySelector(".notes-calendar-overlay-backdrop")?.click() },
    { sel: ".note-more-menu", close: outsideClick },
    { sel: ".notes-filter-dropdown.open:not([data-filter-dim='category'])", close: outsideClick },
  ];

  /** 点到 dialog 之外就是点遮罩；Esc 同样先触发 cancel——页面自己的 cancel 处理（确认 / 清状态）照常执行。 */
  function closeDialog(dialog) {
    const event = new Event("cancel", { cancelable: true });
    dialog.dispatchEvent(event);
    if (!event.defaultPrevented && dialog.open) dialog.close();
  }

  function detect() {
    const found = [];
    let dialogs;
    try { dialogs = document.querySelectorAll("dialog:modal"); } catch { dialogs = document.querySelectorAll("dialog[open]"); }
    for (const dialog of dialogs) {
      if (dialog.matches("[data-no-overlay-history], #startup-recovery")) continue;
      found.push({ key: dialog, close: () => closeDialog(dialog) });
    }
    try {
      for (const pop of document.querySelectorAll(":popover-open")) found.push({ key: pop, close: () => { try { pop.hidePopover(); } catch { /* 已关 */ } } });
    } catch { /* 不支持 popover 选择器 */ }
    for (const source of SOURCES) {
      if (source.when && !source.when()) continue;
      const el = document.querySelector(source.sel);
      if (el) found.push({ key: source, close: () => source.close(el) });
    }
    return found;
  }

  let entries = [];
  let pending = 0;
  let pendingTimer = 0;

  const object = (v) => (v && typeof v === "object" ? v : {});
  function depth() {
    try { const d = object(history.state)[KEY]; return Number.isInteger(d) && d > 0 ? d : 0; } catch { return 0; }
  }
  /** 等自己发起的历史跳转落地；万一事件没来也别永远卡住。 */
  function expectTraversal() {
    pending = 1;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => { pending = 0; reconcile(); }, 800);
  }
  function sync() {
    const have = depth(), want = entries.length;
    try {
      if (want > have) {
        for (let i = have + 1; i <= want; i++) history.pushState({ ...object(history.state), [KEY]: i }, "", location.href);
      } else if (want < have) {
        expectTraversal();
        history.go(want - have);
      }
    } catch { pending = 0; /* 历史接口被限流 / 不可用：浮层照常工作，只是返回不先关它 */ }
  }
  function refresh() {
    const now = detect();
    const next = [];
    for (const old of entries) {
      const hit = now.find((n) => n.key === old.key);
      if (hit) { old.close = hit.close; next.push(old); }
    }
    for (const n of now) if (!next.some((e) => e.key === n.key)) next.push(n);
    entries = next;
  }
  function reconcile() {
    if (pending) return;
    refresh();
    sync();
  }

  window.addEventListener("popstate", () => {
    if (pending) { pending = 0; clearTimeout(pendingTimer); reconcile(); return; }
    const d = depth();
    if (entries.length > d) {
      // 回到了层数更少的历史：从最上面一层开始关
      const doomed = entries.splice(d);
      for (const entry of doomed.reverse()) { try { entry.close(); } catch { /* 关闭函数出错不影响其余层 */ } }
      queueMicrotask(reconcile);
    } else if (d > entries.length) {
      // 落在没有浮层对应的空历史上（浮层已被别的路径关掉）：继续退一步
      expectTraversal();
      try { history.go(entries.length - d); } catch { pending = 0; }
    }
  });

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; reconcile(); });
  };
  window.addEventListener("hashchange", schedule);
  document.addEventListener("toggle", schedule, true);
  document.addEventListener("close", schedule, true);
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["open", "class", "hidden"],
  });

  // 刷新后上一次留下的浮层历史已经没有对应的浮层：摘掉标记，别让它成为一条需要多按一次返回的空历史。
  if (depth()) {
    try { const next = { ...object(history.state) }; delete next[KEY]; history.replaceState(next, "", location.href); } catch { /* 忽略 */ }
  }
  window.piOverlays = { reconcile, depth, count: () => entries.length };
  schedule();
})();
