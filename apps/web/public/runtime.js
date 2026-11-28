"use strict";

/** 会话「回合汇总模式」按设备本地保存，默认关闭；两处入口（系统设置 → 通用能力、会话详情更多菜单）共用同一状态。 */
(function initTurnSummaryMode() {
  const KEY = "pi-agent:turn-summary-mode:v1";
  const emit = (enabled) => window.dispatchEvent(new CustomEvent("pi-turn-summary-mode-change", { detail: { enabled } }));
  window.piTurnSummaryMode = {
    key: KEY,
    enabled() {
      try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
    },
    setEnabled(on) {
      const next = !!on;
      try {
        if (next) localStorage.setItem(KEY, "1");
        else localStorage.removeItem(KEY);
      } catch { /* 本地存储不可用时跳过持久化 */ }
      emit(next);
      return next;
    }
  };
  window.addEventListener("storage", (ev) => {
    if (ev.key === KEY || ev.key === null) emit(window.piTurnSummaryMode.enabled());
  });
})();
/*
 * V2.8 外部 runtime 会话工作台：Codex / Claude Code 原生会话的创建、实时查看、续聊、停止、审批，
 * 授权历史的只读查看，以及运行时配置（连接检查、能力、账户额度、授权设置、登录会话）。
 *
 * 安全约定同 app.js：来源内容一律 textContent（h()），不解释 HTML / Markdown 里的脚本。
 * 性能：按页独立加载；对话只渲染最新 100 条，向上翻页加载更早；实时事件局部更新，不整页重绘。
 */

const RT_SERVICE_ID = 'service-notifications';
const rtServiceOpen = () => ui.view === 'rt' && rtId() === RT_SERVICE_ID;
async function rtLoadServiceNotices({ earlier = false } = {}) {
  const gen = ui.rt.gen;
  if (!rtServiceOpen() || (ui.rt.serviceLoading && ui.rt.serviceLoadingGen === gen)) return;
  ui.rt.serviceLoading = true;
  ui.rt.serviceLoadingGen = gen;
  try {
    const before = earlier ? ui.rt.serviceNotices?.[0]?.seq : null;
    const result = await api(`/api/service-notifications${before ? `?before=${before}` : ''}`);
    if (!rtReadCurrent(RT_SERVICE_ID, gen)) return;
    const previous = ui.rt.serviceNotices || [];
    const gap = !earlier && previous.length && result.messages[0]?.seq > previous.at(-1).seq + 1;
    const old = gap ? [] : previous;
    const merged = new Map([...old, ...result.messages].map(n => [n.seq, n]));
    ui.rt.serviceNotices = [...merged.values()].sort((a,b) => a.seq-b.seq);
    if (earlier || !old.length) ui.rt.serviceHasMore = result.hasMore;
    ui.rt.servicePrepend = earlier;
    ui.rt.serviceEntry = result.entry;
    ui.rt.messagesFor = RT_SERVICE_ID;
    ui.rt.statusConfirmed = true;
    ui.rt.diskDisplay = null;
    ui.rt.serviceError = '';
    ui.rt.view = { session: { platformSessionId: RT_SERVICE_ID, title: '通知服务', status: 'idle', runtimeKind: 'pi' }, readOnly: true, approvals: [] };
    rtContentOpEnd('success');
  } catch (e) { if (rtReadCurrent(RT_SERVICE_ID,gen)) { ui.rt.serviceError = e.message; if ([401,403].includes(e.status)) { ui.rt.serviceNotices = []; ui.rt.serviceEntry = null; ui.rt.messagesFor = null; } } }
  finally {
    if (ui.rt.serviceLoadingGen === gen) ui.rt.serviceLoading = false;
    if (rtReadCurrent(RT_SERVICE_ID,gen)) { ui.rt.syncing = false; renderMain(); }
  }
}
function rtServiceMarkRead() {
  if (!rtServiceOpen() || !ui.rt.serviceEntry || !ui.rt.serviceNotices) return;
  const last = ui.rt.serviceNotices.at(-1);
  const read = last && last.seq === ui.rt.serviceEntry.latestTurn?.turnNo ? rtReadSync([ui.rt.serviceEntry]) : false;
  rtRenderNavStatus();
  if (read && typeof rtRenderListOnly === "function" && document.querySelector(".rt-list")) rtRenderListOnly();
}

const RT_KIND = { codex: "Codex Desktop", "claude-code": "Claude Code CLI", pi: "Pi", antigravity: "Antigravity CLI" };
const RT_KINDS = ["codex", "claude-code", "pi", "antigravity"];
/** 新建会话运行时展示优先级：有额度时 Codex → Antigravity → Claude Code → Pi（DeepSeek）；无额度自动后置 */
const RT_NEW_PRIORITY = ["codex", "antigravity", "claude-code", "pi"];
const RT_GLYPH = { codex: "◎", "claude-code": "✳", pi: "π", antigravity: "△" };
/** 窄处用的短名（手机输入区卡片、筛选条） */
const RT_SHORT = { codex: "Codex", "claude-code": "Claude", pi: "Pi", antigravity: "Antigravity" };
/** 运行时品牌图标：优先用内联 SVG Logo（codexmark / claude / gemini），Pi 保留 π 字符 */
function rtRuntimeBrandIcon(kind) {
  const logoId = kind === "codex" ? "codexmark" : kind === "claude-code" ? "claude" : kind === "antigravity" ? "gemini" : "";
  if (logoId && typeof piLogoSrc === "function") {
    return h("span", { class: `rt-glyph rt-glyph-brand ${kind}`, "aria-hidden": "true" },
      h("img", { class: "rt-glyph-logo", src: piLogoSrc(logoId), alt: "" }));
  }
  return h("span", { class: `rt-glyph ${kind}`, "aria-hidden": "true" }, RT_GLYPH[kind]);
}
/**
 * 判断运行时当前是否已无额度（订阅窗口达到 100% 且未到重置时间；或 Pi 全部有效模型服务余额 ≤ 0）。
 * 百分比一律走 rtQuotaUsedPct（向下取整）：卡片写 100% 与这里判成无额度必须同一口径，
 * 否则 99.6% 会显示成 100% 却仍排在有额度的位次（见 rtQuotaUsedPct 的说明）。
 */
function rtRuntimeQuotaExhausted(kind, profile) {
  if (!profile) return false;
  if (kind === "pi") {
    const balances = Array.isArray(profile.balances) ? profile.balances : [];
    const ok = balances.filter((x) => x?.balance?.status === "ok" && rtBalanceMain(x.balance).length > 0);
    return ok.length > 0 && ok.every((x) => rtBalanceText(x.balance).empty);
  }
  const rl = profile.rateLimit;
  if (!rl?.available || !Array.isArray(rl.windows) || !rl.windows.length) return false;
  const scoped = typeof rtQuotaForModel === "function" ? rtQuotaForModel(rl, kind) : rl;
  const windows = scoped?.windows || [];
  if (!windows.length) return false;
  const now = Date.now();
  return windows.some((w) => { const used = rtQuotaUsedPct(w.usedPercent); return used != null && used >= 100 && (!w.resetsAt || Date.parse(w.resetsAt) > now); });
}
/** 新建页运行时排序：第 0 档可执行且有额度，第 1 档可执行但无额度（后置），第 2 档未就绪；同档内按 RT_NEW_PRIORITY */
function rtRuntimeSortRank(kind, profile) {
  const pri = RT_NEW_PRIORITY.indexOf(kind);
  const base = pri >= 0 ? pri : 99;
  if (!profile || profile.state !== "executable") return 200 + base;
  return rtRuntimeQuotaExhausted(kind, profile) ? 100 + base : base;
}
function rtOrderedNewKinds(profiles) {
  const byKind = new Map((profiles || []).map((p) => [p.runtimeKind, p]));
  return [...RT_KINDS].sort((a, b) => rtRuntimeSortRank(a, byKind.get(a)) - rtRuntimeSortRank(b, byKind.get(b)));
}
/**
 * 选 runtime 的横滑条（新建页卡片、列表筛选、列表底部方框）都用这一套：条数不固定，放不下时只在条内左右滑，页面本身不横向动。
 * 重绘会把条换成新节点，滚动位置由 data-keep-scroll-x 保留；这里只保证「选中的那一项」在可见范围内。
 */
function rtRevealSelected(stripSelector, itemSelector) {
  requestAnimationFrame(() => {
    const strip = document.querySelector(stripSelector), el = strip && strip.querySelector(itemSelector);
    if (!strip || !el) return;
    const left = el.offsetLeft, right = left + el.offsetWidth;
    if (left < strip.scrollLeft) strip.scrollLeft = Math.max(0, left - 8);
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth + 8;
  });
}
const RT_STATUS = {
  creating: ["创建中", "accent"], idle: ["空闲", ""], running: ["运行中", "accent"], "waiting-input": ["等待你处理", "warn"],
  stopping: ["停止中", "warn"], interrupted: ["被中断", "bad"], failed: ["失败", "bad"], completed: ["已结束", ""], unknown: ["状态未知", "warn"]
};
const RT_TURN = { queued: "排队中", running: "运行中", "waiting-input": "等待你处理", completed: "本轮完成", failed: "失败", cancelled: "已停止", interrupted: "被中断", unknown: "结果未知" };
/** 桌面会话详情只有对话正文：工具、用量、来源三个标签已取消（用量的口径与各轮明细、来源与身份都收进右侧会话详情）。 */
const RT_PROFILE_STATE = {
  "not-installed": ["未安装", "bad"], incompatible: ["不兼容", "bad"], "needs-login": ["待登录", "warn"],
  connectable: ["可连接", "warn"], executable: ["可执行", "ok"], error: ["错误", "bad"]
};
const RT_CAP = { create: "创建", read: "读取", stream: "实时流", resume: "续聊", interrupt: "中断", approval: "审批", usage: "用量", rateLimits: "账户额度", imageInput: "图片输入", roleInstructions: "角色指令" };
const RT_OBS = { live: "实时", "catching-up": "补读中", stale: "待核对", disconnected: "观察中断", partial: "部分" };

ui.rt = {
  access: null, dir: null, dirError: "", filter: { runtime: "", q: "" }, collapsed: {}, showArchived: null,
  // 触屏：当前左滑露出归档入口的会话行 id（列表重绘后保持滑开）
  swipeOpen: null,
  id: null, view: null, viewError: "", events: [], hasMoreBefore: false, total: 0, coverage: "", notes: [],
  loading: false, newCount: 0, atBottom: true, drafts: {}, outgoing: {}, busy: "", flash: "", error: "",
  profiles: null, host: null, settings: null, settingsDraft: null, auth: null,
  form: null, confirm: null, createKey: null, listOpen: false, infoOpen: false, sideCollapsed: false, subOpen: false, moreOpen: false, noticeOpen: false, noteOpen: false, recommendationOpen: false, turnEffort: {}, conn: "", es: null, esFor: null, lastSeq: 0, gen: 0, lastId: null,
  // 快捷回复：会话 id → { key: 最后一条助手消息 key, state: loading|ready|none|error, replies, deployment? }
  quickReplies: {},
  // 正在执行的快捷回复 { id, key, text }：按钮前加转圈，避免只变灰看起来像没点上
  quickBusy: null,
  // 部署失败后首项为「重新部署」时自动触发一次：会话 + 失败通知 key → pending|done。
  // 已完成的 key 另存 localStorage，刷新页面或重新进入会话也不会重复部署。
  autoRedeploy: {},
  // 「空闲时部署」状态：会话 id → 上次读到的部署信息（读取失败为 null）。重新进入会话先用它显示头部按钮与关联部署的快捷回复，后台再更新；
  // 点按钮 / 快捷回复时都会重新读取，所以先显示旧值不会按旧状态部署
  deployCache: {},
  // 排队消息：正在修改的那条（sid、messageId、original、是否由本页暂停了自动发送）、进行中的操作、入队幂等键
  outboxEdit: null, outboxBusy: "", queueKey: null,
  // 部署等待：已落盘到部署票据、还在等部署完成的那条发送（sid + 幂等键）。等待期间按常规排队列表展示，失败后回到未确认说明
  deployWait: null
};

// 页面和后台通知共用本设备推送设置。
window.rtDesktop = window.sessionNotifications;

// 会话列表宽度（PC / 平板可拖拽，240–480，默认 300）：保存值在首帧前写到 :root，列表和占位页都按它排版
const RT_LIST_W_KEY = "pi-agent-session-list-width";
const RT_LIST_W_MIN = 240, RT_LIST_W_MAX = 480, RT_LIST_W_DEFAULT = 300, RT_LIST_W_STEP = 16, RT_CENTER_MIN = 480;
try {
  const saved = Number(localStorage.getItem(RT_LIST_W_KEY));
  if (saved >= RT_LIST_W_MIN && saved <= RT_LIST_W_MAX) document.documentElement.style.setProperty("--rt-list-w", `${saved}px`);
} catch { /* in-memory preference */ }
const RT_SIDE_STORAGE = "pi-agent-session-info-collapsed";
try { ui.rt.sideCollapsed = localStorage.getItem(RT_SIDE_STORAGE) === "true"; } catch { /* in-memory preference */ }
/** 右侧会话信息面板的收起入口：贴在内容区右缘、垂直居中；收起后停在窗口右缘。 */
function rtSideHandle({ collapsed = ui.rt.sideCollapsed, label = "会话信息", controls = "rt-session-info", className = "", onclick = rtToggleSide } = {}) {
  return h("button", {
    type: "button", class: `rt-side-handle${className ? ` ${className}` : ""}`, "aria-controls": controls,
    "aria-expanded": String(!collapsed), title: `${collapsed ? "展开" : "收起"}${label}`, onclick
  },
    h("span", { class: "rt-side-handle-chevron", "aria-hidden": "true" }, collapsed ? "‹" : "›"),
    h("span", { class: "rt-side-handle-label" }, label));
}
function rtToggleSide() {
  if (rtPhone.matches) { rtSetInfoOpen(!ui.rt.infoOpen); return; }
  ui.rt.sideCollapsed = !ui.rt.sideCollapsed;
  try { localStorage.setItem(RT_SIDE_STORAGE, String(ui.rt.sideCollapsed)); } catch { /* in-memory preference */ }
  const layout = document.querySelector(".rt-layout:not(.rt-layout-new)");
  if (layout) {
    layout.classList.toggle("side-collapsed", ui.rt.sideCollapsed);
    const side = layout.querySelector(".rt-side");
    if (side) side.hidden = ui.rt.sideCollapsed;
  }
  const handle = document.querySelector(".rt-side-handle");
  if (handle) {
    handle.setAttribute("aria-expanded", String(!ui.rt.sideCollapsed));
    handle.title = ui.rt.sideCollapsed ? "展开会话信息" : "收起会话信息";
    const chevron = handle.querySelector(".rt-side-handle-chevron");
    if (chevron) chevron.textContent = ui.rt.sideCollapsed ? "‹" : "›";
  }
  void rtLoadVisibleUsage();
}

/** 手机消息区左滑拉出右侧详情，面板右滑关闭；桌面保留原触屏交互。 */
function rtInfoPanelOpen() { return rtPhone.matches ? !!ui.rt.infoOpen : !ui.rt.sideCollapsed; }
function rtSetInfoPanelOpen(open) {
  if (rtPhone.matches) { if (ui.rt.infoOpen !== open) rtSetInfoOpen(open); return; }
  if (ui.rt.sideCollapsed === open) rtToggleSide();
}
function rtInstallInfoSwipe(layout) {
  if (!layout || layout.rtInfoSwipe) return;
  layout.rtInfoSwipe = true;
  rtInstallPhoneInfoSwipe(layout);
  let start = null;
  layout.addEventListener("pointerdown", (ev) => {
    start = null;
    if (ev.pointerType === "mouse" || !rtId()) return;
    const target = ev.target instanceof Element ? ev.target : null;
    // 展开的「更多」菜单：在菜单面板或遮罩上左滑 / 上滑收起；其它位置不接管
    if (target?.closest(".rt-head-phone .rt-more")) {
      if (ui.rt.moreOpen && target.closest(".rt-more-sheet, .rt-more-backdrop")) start = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, menu: true };
      return;
    }
    if (rtPhone.matches) return;
    // 会话详情遮罩（模态区域）本身是按钮，但允许在它上面左滑收起
    const onBackdrop = !!target?.closest(".rt-info-backdrop");
    // 输入、按钮、链接、消息目录、菜单/提示浮层等交互区域不接管
    if (!onBackdrop && target?.closest("input, textarea, select, button, a, [contenteditable='true'], .rt-list, .rt-message-nav, .rt-message-nav-rail, .rt-more, .rt-notice")) return;
    start = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, inPanel: onBackdrop || !!target?.closest(".rt-side") };
  }, { passive: true });
  const finish = (ev) => {
    const s = start; start = null;
    if (!s || ev.pointerId !== s.id) return;
    const dx = ev.clientX - s.x, dy = ev.clientY - s.y;
    if (s.menu) {
      const left = dx < -56 && Math.abs(dx) >= Math.abs(dy) * 1.4, up = dy < -48 && Math.abs(dy) >= Math.abs(dx) * 1.4;
      if (left || up) rtToggleMore(false);
      return;
    }
    // 只处理明确的横向手势，竖直滚动仍交给页面
    if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    const open = rtInfoPanelOpen();
    if (dx > 0 && !open) rtSetInfoPanelOpen(true);
    else if (dx < 0 && open && s.inPanel) rtSetInfoPanelOpen(false);
  };
  layout.addEventListener("pointerup", finish);
  layout.addEventListener("pointercancel", () => { start = null; });
}

/** 当前选中的文字；没有选区时为空串。 */
function rtSelectionText() {
  try { const sel = window.getSelection(); return sel && !sel.isCollapsed ? String(sel) : ""; } catch { return ""; }
}
/** 触点是否落在选区（含两端拖拽手柄的余量）上：落在上面是在调选区，不是滑动。 */
function rtTouchOnSelection(x, y) {
  const pad = 24;
  try {
    const sel = window.getSelection();
    for (let i = 0; i < (sel?.rangeCount || 0); i++)
      for (const r of sel.getRangeAt(i).getClientRects())
        if (x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad) return true;
  } catch { /* 没有 Selection API 就当作不在选区上 */ }
  return false;
}

function rtInstallPhoneInfoSwipe(layout) {
  let drag = null, timer = null, suppressClick = false;
  const reset = () => {
    clearTimeout(timer);
    drag = null;
    layout.classList.remove("info-dragging", "info-settling");
    layout.style.removeProperty("--rt-info-offset");
    layout.style.removeProperty("--rt-info-opacity");
    const side = layout.querySelector(".rt-side");
    if (side) side.inert = rtPhone.matches && !ui.rt.infoOpen;
  };
  layout.rtCancelInfoSwipe = reset;
  const preview = (offset, width) => {
    layout.classList.add("info-dragging");
    layout.style.setProperty("--rt-info-offset", `${offset}px`);
    layout.style.setProperty("--rt-info-opacity", String(1 - offset / width));
  };
  layout.addEventListener("touchstart", ev => {
    reset();
    suppressClick = false;
    if (!rtPhone.matches || ev.touches.length !== 1 || !rtId() || !ui.rt.view || ui.rt.listOpen || ui.rt.moreOpen) return;
    const target = ev.target instanceof Element ? ev.target : null;
    const open = !!ui.rt.infoOpen;
    if (!target?.closest(open ? ".rt-side, .rt-info-backdrop" : ".rt-transcript")) return;
    if (target.closest("input, textarea, select, button:not(.rt-info-backdrop), a, img, pre, code, .rt-table-wrap, [contenteditable='true'], [role='button'], .rt-message-nav, .rt-notice, .rt-note-pop")) return;
    // 页面上残留的旧选区（长按选字后没点掉）不该让滑动一直失效：只有触点就在选区上才让给选区手柄
    const touch = ev.touches[0];
    const selected = rtSelectionText();
    if (selected && rtTouchOnSelection(touch.clientX, touch.clientY)) return;
    drag = { target, x: touch.clientX, y: touch.clientY, open, width: Math.min(360, innerWidth * .9), offset: 0, active: false, selected };
  }, { passive: true });
  layout.addEventListener("touchmove", ev => {
    const s = drag;
    if (!s) return;
    // Long press can create (or change) a selection after touchstart; let its handles keep ownership.
    if (ev.touches.length !== 1 || rtSelectionText() !== s.selected) { reset(); return; }
    const touch = ev.touches[0];
    const dx = touch.clientX - s.x, dy = touch.clientY - s.y;
    // 详情里的记录卡片还有相邻子 Tab 时，先让它切；边界再收起详情。
    if (window.piTabSwipe?.claims(s.target, dx, dy)) { reset(); return; }
    if (!s.active) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.4 || (s.open ? dx <= 0 : dx >= 0)) { reset(); return; }
      s.active = true;
      suppressClick = true;
      const side = layout.querySelector(".rt-side");
      if (side) side.inert = true;
    }
    if (ev.cancelable) ev.preventDefault();
    s.offset = Math.max(0, Math.min(s.width, (s.open ? 0 : s.width) + dx));
    preview(s.offset, s.width);
  }, { passive: false });
  const finish = (cancelled) => {
    const s = drag;
    if (!s?.active) { reset(); return; }
    const distance = s.open ? s.offset : s.width - s.offset;
    const open = cancelled || distance < 56 ? s.open : !s.open;
    // Set modal/focus state without rebuilding the transcript or composer.
    rtSetInfoOpen(open);
    preview(s.offset, s.width);
    layout.querySelector(".rt-side")?.getBoundingClientRect();
    layout.classList.add("info-settling");
    preview(open ? 0 : s.width, s.width);
    drag = null;
    timer = setTimeout(reset, 200);
  };
  layout.addEventListener("touchend", () => finish(false));
  layout.addEventListener("touchcancel", () => finish(true));
  // A completed drag must not click a newly exposed control or the backdrop.
  layout.addEventListener("click", ev => {
    if (!suppressClick || ev.detail === 0) return;
    suppressClick = false;
    ev.preventDefault(); ev.stopPropagation();
  }, true);
}

const rtId = () => ui.rt.id;
/** 手机 Enter 换行；桌面 Enter 或 ⌘/Ctrl + Enter 发送。输入法组字时不发送。 */
function rtIsSendKey(ev) {
  return ev.key === "Enter" && (!rtPhone.matches || ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && !ev.isComposing && ev.keyCode !== 229;
}
function rtKey() { return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9_-]/g, ""); }
function rtAgo(iso) {
  if (!iso) return "时间未知";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
function rtTime(iso) { return iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "—"; }
function rtNum(n) { return typeof n === "number" ? n.toLocaleString() : "未知"; }
function rtStatusBadge(s, view) {
  if (s === "idle" && view && view.session && view.session.turns.length) {
    const last = view.session.turns[view.session.turns.length - 1];
    if (last.status === "completed") return badge("本轮完成", "ok");
    if (last.status === "failed") return badge("本轮失败", "bad");
    if (last.status === "cancelled") return badge("已停止", "");
  }
  const [t, k] = RT_STATUS[s] || [String(s), ""];
  return badge(t, k);
}

/* ------------------------------ 数据 ------------------------------ */

/* ------------------------------ 运行时状态缓存 ------------------------------ */

/**
 * 运行时的连接状态、设置与入口权限缓存在本浏览器：进入新建会话时先显示上次的状态，后台再核对最新值。
 * 只缓存渲染新建页需要的字段，不存账号身份摘要；真正能否创建以服务端校验为准。
 */
const RT_CACHE_KEY = `pi-agent.rt.cache.v1:${location.host}`;
function rtReadCache() {
  try { return JSON.parse(localStorage.getItem(RT_CACHE_KEY) || "null"); } catch { return null; }
}
function rtWriteCache() {
  const profiles = (ui.rt.profiles || []).map(({ identity, configSummary, ...p }) => p);
  try { localStorage.setItem(RT_CACHE_KEY, JSON.stringify({ at: new Date().toISOString(), profiles, host: ui.rt.host, settings: ui.rt.settings, access: ui.rt.access })); } catch { /* 存不了就只在本页有效 */ }
}
(() => {
  const c = rtReadCache();
  if (!c) return;
  if (!ui.rt.profiles && Array.isArray(c.profiles) && c.profiles.length) { ui.rt.profiles = c.profiles; ui.rt.host = c.host || null; ui.rt.profilesCached = true; }
  if (!ui.rt.settings && c.settings) ui.rt.settings = c.settings;
  if (!ui.rt.access && c.access) ui.rt.access = c.access;
})();
/*
 * 运行时页的启动读取（运行时列表 / 设置 / 入口权限 / 登录会话）原先一次 15 秒超时就直接把
 * 「读取超时，请局部重试」摆到页面上：故障诊断 fb9754838e5fc8dc9 里 20 条 408 中有 9 条来自这几个接口，
 * 用户只能自己再点一次。这里沿用待办 / 目录读取的口径：只重试幂等 GET 的瞬时失败（408 / 502 / 503 / 504 /
 * 网络层失败），页面可见、未被取消时静默补两次（0.8 / 1.6 秒），仍失败才报错；
 * 取消（AbortError）、离线、401/403 等确定性失败不重试，重试有上限，不会在服务端过载时成倍加压。
 */
const RT_PAGE_RETRY_WAITS = [800, 1600];
function rtRetryRead(read, current = () => true) {
  return typeof retryTransientRead === 'function' ? retryTransientRead(read, current, RT_PAGE_RETRY_WAITS) : read();
}
async function rtLoadAccess() {
  const hadControl = !!ui.rt.access?.control;
  const access = await rtRetryRead(() => api('/api/runtime/access')); ui.rt.access = access;
  if (access.history === false) { rtArchiveInvalidate(); sessionCachesClear(); if (typeof localFirstClear === 'function') void localFirstClear(); if (ui.view === 'rt' || ui.view === 'rt-room') renderMain(); }
  rtWriteCache();
  // 入口能力比会话详情晚到（手机走备用入口时 access 要好几秒）：详情页那次部署状态读取、输入区的权限 / 强度选项
  // 都因为 access 未就绪而按「无控制权」渲染或跳过了，之后没人再补，就一直缺着。access 一到：补读部署状态并重绘一次。
  if (!hadControl && access.control && ui.view === 'rt' && rtId() && typeof rtConversationVisible === 'function' && rtConversationVisible()) {
    if (ui.rt.deployLoadedGen !== ui.rt.gen) void rtLoadDeploy(rtId());
    if (ui.rt.view && typeof rtRenderSoft === 'function') rtRenderSoft();
  }
}
/** 目录是否已拿全：没按关键字在服务端筛过、也没有下一页。拿全时关键字只在本地过滤。 */
function rtDirComplete(runtime = ui.rt.filter.runtime) {
  const d = ui.rt.dir;
  return !!d && Array.isArray(d.entries) && !d.nextCursor && !ui.rt.dirQuery && (ui.rt.dirRuntime || "") === (runtime || "");
}
/** 与服务端 directory() 的 q 口径一致：标题、目录、原生会话 ID，不区分大小写。 */
function rtDirMatches(entry, q) {
  if (!q) return true;
  return `${entry.title} ${entry.workspace ?? ""} ${entry.nativeSessionId ?? ""}`.toLowerCase().includes(String(q).toLowerCase());
}
/** 当前目录能否直接呈现这组筛选，不必重新读取。 */
function rtDirServes(f = ui.rt.filter) {
  return !!ui.rt.dir && (ui.rt.dirRuntime || "") === (f.runtime || "") && ((ui.rt.dirQuery || "") === (f.q || "") || rtDirComplete(f.runtime));
}
/*
 * 会话列表读取：同一个查询只保留一条在飞读取。
 *
 * 部署 / 回前台时，回前台、实时连接 ready、整体刷新可能在同一两秒里各叫一次目录；
 * 以前每次都会占一条连接，服务端一慢就同时报出多条「读取超时」。
 * 未筛选的目录同时供会话列表和「对话」角标使用，两者共用 rtReadUnfilteredDirectory；
 * 同一查询的重复调用复用这条 flight，结束后最多再补读一次（期间事件到了，最后一帧不丢）。
 * 换了筛选 / 搜索词是用户的新意图，仍可立即发新读取并用 generation 淘汰旧结果。
 */
let rtDirFlight = null, rtDirFlightKey = "", rtDirMore = false;
let rtUnfilteredDirFlight = null;
/**
 * 列表读取瞬时失败后的静默重试间隔：指数退避 3 次（0.8 / 1.6 / 3.2 秒）。
 * 手机回前台后网络栈恢复前，目录请求会在几毫秒内 Failed to fetch；按退避重试能等到链路真正可用，
 * 又不会在服务端已经过载时成倍加压。
 */
const RT_DIR_RETRY_WAITS = [800, 1600, 3200];
function rtDirectoryPath({ runtime = "", q = "", cacheAccess = false } = {}) {
  const qs = new URLSearchParams({ limit: "200", source: "chat" });
  if (runtime) qs.set("runtime", runtime);
  if (q) qs.set("q", q);
  if (cacheAccess) qs.set("cacheAccess", "1");
  return `/api/session-directory?${qs}`;
}
function rtDirectoryPlan() {
  const f = { ...ui.rt.filter };
  // 上一次完整目录装得下（≤200 条）就继续拉完整目录，关键字留给本地过滤；装不下才让服务端按关键字筛。
  const serverQ = f.q && !rtDirComplete(f.runtime) ? f.q : "";
  const path = rtDirectoryPath({ runtime: f.runtime, q: serverQ, cacheAccess: typeof sessionWarmDirectory === 'function' });
  return { f, serverQ, path };
}
/** 未筛选目录：列表刷新和角标轮询共用，谁先开始另一条都只等它。 */
function rtReadUnfilteredDirectory() {
  if (rtUnfilteredDirFlight) return rtUnfilteredDirFlight;
  const path = rtDirectoryPath({ cacheAccess: typeof sessionWarmDirectory === 'function' });
  const observedAt = Date.now();
  const flight = (typeof localFirstReadDirectory === 'function' ? localFirstReadDirectory(path) : api(path)).then(dir => ({ ...dir, badgeObservedAt: observedAt })).finally(() => { if (rtUnfilteredDirFlight === flight) rtUnfilteredDirFlight = null; });
  rtUnfilteredDirFlight = flight;
  return flight;
}
function rtLoadDir(options = {}) {
  const plan = rtDirectoryPlan();
  if (rtDirFlight && rtDirFlightKey === plan.path) { rtDirMore = true; return rtDirFlight; }
  // 换了查询就是一次新读取：旧 generation 会淘汰旧回复，不做串行排队，免得慢搜索拖住下一次输入。
  rtDirMore = false;
  const flight = rtLoadDirOnce(plan, options).then((dir) => {
    if (rtDirFlight === flight) {
      rtDirFlight = null; rtDirFlightKey = "";
      // 失败时不立刻补读：让角标轮询按失败节奏（5 秒）再来，别在服务端已经过载时连着重试。
      const again = rtDirMore && !!dir; rtDirMore = false;
      // 补读只是刷新已经在屏幕上的列表（期间又有人要过目录），不再新开一次 session-list 关键操作：
      // 否则读取成功后紧接着又出现一条 op_start，看起来像「成功后重试了一次」。
      if (again) void rtLoadDir({ background: true }).then(() => { if (typeof rtRenderListOnly === 'function') rtRenderListOnly(); }).catch(() => {});
    }
    return dir;
  });
  rtDirFlight = flight; rtDirFlightKey = plan.path;
  return flight;
}
async function rtLoadDirOnce(plan, options = {}) {
  const notice = ui.rt.dirNotice;
  const generation = (ui.rt.dirGeneration || 0) + 1; ui.rt.dirGeneration = generation;
  // 故障诊断：会话列表是关键操作之一，记开始与终态（被新一次读取取代算正常取消）。
  // background 的补读不占关键操作：列表已经显示出来，它只把期间的变化补上。
  const op = options.background ? null : window.piTelemetry?.op?.('session-list');
  const { f, serverQ, path } = plan;
  const unfiltered = !f.runtime && !serverQ;
  // 读取超时 / 网关 502 是链路上的瞬时失败（服务端可能根本没慢）：页面可见、查询没被取代时先静默重试一次，
  // 仍失败才在列表上报错。取消（AbortError）不重试；之后的补读交给角标轮询的 5 秒失败节奏。
  const read = () => (unfiltered ? rtReadUnfilteredDirectory() : api(path));
  const current = () => generation === ui.rt.dirGeneration;
  // Local-first: paint the saved list while the real read is in flight (never delays it).
  if (unfiltered && !ui.rt.dir && typeof localFirstSeedDirectory === 'function') void localFirstSeedDirectory(() => !ui.rt.dir).catch(() => {});
  try { const dir = await (typeof retryTransientRead === 'function' ? retryTransientRead(read, current, RT_DIR_RETRY_WAITS) : read());
    if (generation !== ui.rt.dirGeneration) { op?.cancel('superseded'); return null; }
    if(typeof sessionWarmDirectory==='function'){
      const warmed=sessionWarmDirectory(dir,()=>generation===ui.rt.dirGeneration).catch(()=>{});
      // 预热只把已有缓存放进内存；紧接着在后台把最近几个缓存会话的新消息补上（最低优先级，见 session-sync.js）。
      if(unfiltered&&typeof sessionFreshenRecent==='function')void warmed.then(()=>sessionFreshenRecent(dir.entries,()=>generation===ui.rt.dirGeneration)).catch(()=>{});
    }
    if(generation!==ui.rt.dirGeneration){op?.cancel('superseded');return null;}
    rtArchiveReconcileFailures(dir, f.runtime, serverQ);
    ui.rt.dir = dir; ui.rt.codexReset = dir.codexReset || ui.rt.codexReset || null; ui.rt.dirQuery = serverQ; ui.rt.dirRuntime = f.runtime || ""; ui.rt.dirAt = Date.now(); ui.rt.dirError = ""; ui.rt.dirFromLocal = false;
    window.piOpenTiming?.mark('dir-net');
    if (unfiltered && typeof localFirstSaveDirectory === 'function') localFirstSaveDirectory(dir);
    if (unfiltered && typeof rtReadSharePull === 'function') void rtReadSharePull();
    if (ui.rt.dirNotice === notice) ui.rt.dirDirty = false;
    // 角标轮询用的是未筛选目录；列表刚读到的同一份数据可以直接复用，少一次请求。
    if (unfiltered && Array.isArray(dir.entries) && (!dir.nextCursor || !ui.rt.notifications)) {
      ui.rt.notifications = dir.entries; ui.rt.notificationsAt = dir.badgeObservedAt; ui.rt.notificationsComplete = !dir.nextCursor;
    }
    if (unfiltered && dir.nextCursor) void rtPollUnread(true);
    if (typeof rtPatchVerifyStatus === "function") rtPatchVerifyStatus();
    op?.success(); if(typeof sessionLive!=='undefined'&&sessionLive.enabled)void sessionLiveConnect();
    return dir;
  }
  catch (e) {
    if (generation === ui.rt.dirGeneration) {
      ui.rt.dirError = e.message; op?.failure(e, e.status);
      // A denied read ends the saved copy of the list; an unreachable server keeps showing it.
      if ([401, 403].includes(e.status) && typeof localFirstClear === 'function') void localFirstClear();
      // 超时 / 网关故障时让角标轮询按失败节奏（5 秒）尽快补读，部署完成后不必等下一次 30 秒轮询。
      if ([408, 502, 503, 504].includes(e.status) && typeof rtUnreadState !== 'undefined') { rtUnreadState.failed = true; rtUnreadReschedule(); }
    } else op?.cancel('superseded');
    return null;
  }
}
// Archive summaries live only in this page; transcript caches are never warmed here.
const rtArchivePending = new Map();
const rtArchiveFailures = new Map();
/**
 * 归档失败行是失败那一刻的快照，不能一直留着：刚从服务端读到的目录里已有这个会话，就以服务端那一行为准；
 * 目录拿全了（没筛选、没有下一页）而服务端没有它，说明它已在别处归档或删除，快照直接丢掉。
 */
function rtArchiveReconcileFailures(dir, runtime, serverQ) {
  if (!dir || !Array.isArray(dir.entries) || !rtArchiveFailures.size) return;
  const ids = new Set(dir.entries.map((x) => x.id));
  const complete = !dir.nextCursor && !serverQ;
  for (const [id, entry] of [...rtArchiveFailures]) {
    if (entry.archived) continue;
    if (ids.has(id) || (complete && (!runtime || entry.runtimeKind === runtime))) rtArchiveFailures.delete(id);
  }
}
const RT_ARCHIVE_TTL = 5 * 60_000;
let rtArchiveCache = null;
function rtArchiveInvalidate() {
  rtArchiveCache = null;
}
function rtArchiveDirectoryNotice(message) {
  // Active-session changes must not repeatedly invalidate the archive while scrolling.
  try { if (JSON.parse(message.data).archiveChanged) rtArchiveInvalidate(); } catch { /* legacy notice */ }
}
function rtArchiveState() {
  const key = JSON.stringify([ui.rt.filter.runtime, ui.rt.filter.q]);
  if (!rtArchiveCache || rtArchiveCache.key !== key || Date.now() - rtArchiveCache.at > RT_ARCHIVE_TTL) {
    rtArchiveCache = { key, at: Date.now(), pages: [], total: 0, loading: false, error: "", scroll: 0, tick: 0 };
  }
  return rtArchiveCache;
}
async function rtArchiveLoad(index = 0) {
  if (!ui.rt.showArchived || ui.rt.access?.history === false) return;
  const state = rtArchiveState();
  if (state.loading || state.pages[index]?.entries) return;
  const cursor = index ? state.pages[index - 1]?.nextCursor : null;
  if (index && !cursor) return;
  state.loading = true; state.error = ""; state.failedIndex = index;
  rtRenderListOnly();
  const qs = new URLSearchParams({ source: "chat", archived: "only", limit: "50" });
  if (ui.rt.filter.runtime) qs.set("runtime", ui.rt.filter.runtime);
  if (ui.rt.filter.q) qs.set("q", ui.rt.filter.q);
  if (cursor) qs.set("cursor", cursor);
  try {
    const result = await api(`/api/session-directory?${qs}`);
    if (state !== rtArchiveCache || !ui.rt.showArchived) return;
    if (result.resetRequired) { rtArchiveInvalidate(); return; }
    state.total = result.total;
    state.pages[index] = { ...state.pages[index], entries: result.entries || [], nextCursor: result.nextCursor, used: ++state.tick };
    // Keep the scroll geometry of evicted pages, but retain at most 150 summaries.
    const cached = state.pages.map((p, i) => ({ p, i })).filter(({ p }) => p.entries);
    while (cached.length > 3) {
      cached.sort((a, b) => Number(a.i === state.anchorIndex || a.i === index) - Number(b.i === state.anchorIndex || b.i === index) || a.p.used - b.p.used);
      const old = cached.shift();
      old.p.entries = null;
    }
  } catch (e) {
    if (state === rtArchiveCache) {
      if ([401, 403].includes(e.status)) { state.pages = []; state.total = 0; }
      state.error = e.message;
    }
  }
  finally {
    state.loading = false;
    if (state === rtArchiveCache && ui.rt.showArchived) rtRenderListOnly();
    else if (ui.rt.showArchived && !rtArchiveCache) { rtRenderListOnly(); void rtArchiveLoad(); }
  }
}
// Load by the panels actually shown, independent of device name or link speed.
function rtDirectoryVisible() {
  if (document.visibilityState === 'hidden' || !['rt','rt-new','rt-room','rt-room-new','rt-compare'].includes(ui.view)) return false;
  return !rtPhone.matches || !!ui.rt.listOpen || (ui.view === 'rt' && !rtId());
}
function rtSessionVisible() {
  return document.visibilityState !== 'hidden' && ui.view === 'rt' && !!rtId() && !(rtPhone.matches && ui.rt.listOpen);
}
function rtConversationVisible() { return rtSessionVisible() && !(rtPhone.matches && ui.rt.infoOpen); }
/** 页面在后台或窗口失焦：这时的自动跳转会打断用户，切回后看起来像被默认选中了别的会话。 */
function rtPageAway() {
  return document.visibilityState === 'hidden' || !document.hasFocus();
}
function rtUsageVisible() {
  if (!rtSessionVisible()) return false;
  const panel = rtInfoPanelOpen() ? document.querySelector('.rt-side') : null;
  return !!panel?.getClientRects?.().length;
}
function rtUsageVersion(v) { return JSON.stringify([v?.session?.bindingRevision,v?.session?.lastActivityAt,v?.session?.turns?.at(-1),ui.rt.lastSeq]); }
const rtUsageFlights = new Map();
const RT_USAGE_REFRESH_MS = 10000;
let rtUsageTimer = null;
function rtMemoryVisible() {
  return rtSessionVisible() && rtInfoPanelOpen() && RT_KINDS.includes(ui.rt.view?.session?.runtimeKind) && !!document.querySelector('.rt-side')?.getClientRects().length;
}
/** 搜索 / 抓取记录：和记忆共用侧栏卡片，所有 runtime 都读（记忆只有 Pi 有）。服务端从会话的工具调用里挑出，这里只负责按需刷新。 */
function rtWebVisible() {
  // 卡片代码在按路由懒加载的 runtime-detail.js 里；模块没到、侧栏没渲染时不读也不画（模块到了会再触发一次读取）
  return typeof rtPatchMemoryCard === 'function' && rtSessionVisible() && rtInfoPanelOpen() && !!document.querySelector('.rt-side')?.getClientRects().length;
}
const rtWebFlights = new Map();
let rtWebTimer = null;
async function rtLoadVisibleWeb(force = false) {
  if (!rtWebVisible()) return;
  const id = rtId(), gen = ui.rt.gen, key = `${id}:${gen}`, version = rtUsageVersion(ui.rt.view);
  if (rtWebFlights.has(key)) return rtWebFlights.get(key);
  let state = ui.rt.web;
  if (state?.id !== id || state.gen !== gen) state = ui.rt.web = {id, gen, items:[]};
  if (!force && state.version === version && !state.error) return;
  const wait = 10000 - (Date.now() - (state.at || 0));
  if (!force && wait > 0) {
    if (!rtWebTimer) rtWebTimer = setTimeout(() => { rtWebTimer = null; void rtLoadVisibleWeb(); }, wait);
    return;
  }
  if (rtWebTimer) { clearTimeout(rtWebTimer); rtWebTimer = null; }
  state.loading = true; state.error = ''; state.at = Date.now(); state.version = version;
  const flight = (async () => {
    try {
      const page = await api(`/api/runtime-sessions/${encodeURIComponent(id)}/web-activity`);
      if (!rtReadCurrent(id, gen) || ui.rt.web !== state) return;
      state.items = Array.isArray(page.items) ? page.items : [];
    } catch (e) {
      if (rtReadCurrent(id, gen) && ui.rt.web === state) {
        if ([401,403,404,410].includes(e.status)) { state.items = []; rtReadFailure(id, gen, e); }
        else { state.error = e.message; state.version = ''; }
      }
    } finally {
      state.loading = false; rtWebFlights.delete(key);
      if (rtReadCurrent(id, gen) && rtWebVisible()) rtPatchMemoryCard();
    }
  })();
  rtWebFlights.set(key, flight);
  return flight;
}
/** 平台公共记忆（首轮注入 + 对按需索引的查阅）：侧栏卡片的「公共记忆」tab，点开看当时实际注入的正文和查了什么。会话有新事件时随用量版本刷新。 */
function rtInjectionVisible() { return rtMemoryVisible(); }
const rtInjectionFlights = new Map();
let rtInjectionTimer = null;
async function rtLoadVisibleInjection(force = false) {
  if (!rtInjectionVisible()) return;
  const id = rtId(), gen = ui.rt.gen, key = `${id}:${gen}`, version = rtUsageVersion(ui.rt.view);
  if (rtInjectionFlights.has(key)) return rtInjectionFlights.get(key);
  let state = ui.rt.injection;
  if (state?.id !== id || state.gen !== gen) state = ui.rt.injection = {id, gen, items:[]};
  if (!force && state.version === version && !state.error) return;
  const wait = 10000 - (Date.now() - (state.at || 0));
  if (!force && wait > 0) {
    if (!rtInjectionTimer) rtInjectionTimer = setTimeout(() => { rtInjectionTimer = null; void rtLoadVisibleInjection(); }, wait);
    return;
  }
  if (rtInjectionTimer) { clearTimeout(rtInjectionTimer); rtInjectionTimer = null; }
  state.loading = true; state.error = ''; state.at = Date.now(); state.version = version;
  const flight = (async () => {
    try {
      const page = await api(`/api/runtime-sessions/${encodeURIComponent(id)}/injections`);
      if (!rtReadCurrent(id, gen) || ui.rt.injection !== state) return;
      state.items = Array.isArray(page?.items) ? page.items : [];
      state.lookups = Array.isArray(page?.lookups) ? page.lookups : [];
      state.checks = Array.isArray(page?.checks) ? page.checks : [];
      state.entries = page?.entries && typeof page.entries === 'object' ? page.entries : {};
    } catch (e) {
      if (rtReadCurrent(id, gen) && ui.rt.injection === state) {
        if ([401,403,404,410].includes(e.status)) { state.items = []; state.lookups = []; state.checks = []; state.entries = {}; rtReadFailure(id, gen, e); }
        else { state.error = e.message; state.version = ''; }
      }
    } finally {
      state.loading = false; rtInjectionFlights.delete(key);
      if (rtReadCurrent(id, gen) && rtInjectionVisible()) rtPatchMemoryCard();
    }
  })();
  rtInjectionFlights.set(key, flight);
  return flight;
}
async function rtLoadVisibleUsage(force = false) {
  void rtLoadVisibleWeb(force);
  void rtLoadVisibleInjection(force);
  if (!rtUsageVisible() || !ui.rt.view) return;
  const id = rtId(), gen = ui.rt.gen, version = rtUsageVersion(ui.rt.view), key = `${id}:${gen}`;
  if (rtUsageFlights.has(key)) return rtUsageFlights.get(key);
  if (!force && ui.rt.usageAttemptKey === key && ui.rt.usageAttemptVersion === version && ui.rt.sessionUsageError) return;
  if (!force && ui.rt.usageFor === id && ui.rt.usageVersion === version) return;
  // 已有本会话的用量快照时是后台刷新：运行中每条事件都会让 version 变化，
  // 这时把刷新合并成至多每 RT_USAGE_REFRESH_MS 一次（状态文字在标题旁显示「更新中…」）
  const background = ui.rt.usageFor === id && !!ui.rt.view.usage;
  if (background && !force) {
    const wait = RT_USAGE_REFRESH_MS - (Date.now() - (ui.rt.usageAt || 0));
    if (wait > 0) {
      if (!rtUsageTimer) rtUsageTimer = setTimeout(() => { rtUsageTimer = null; void rtLoadVisibleUsage(); }, wait);
      return;
    }
  }
  if (rtUsageTimer) { clearTimeout(rtUsageTimer); rtUsageTimer = null; }
  ui.rt.usageAttemptKey = key; ui.rt.usageAttemptVersion = version;
  ui.rt.usageAt = Date.now();
  ui.rt.sessionUsageLoading = true; ui.rt.sessionUsageError = '';
  const flight = (async () => {
    try {
      const usage = await api(`/api/runtime-sessions/${encodeURIComponent(id)}/usage`);
      if (!rtReadCurrent(id, gen)) return;
      ui.rt.usageFor = id; ui.rt.usageVersion = version; ui.rt.usageAt = Date.now();
      ui.rt.view = { ...ui.rt.view, usage };
    } catch (e) {
      if (rtReadCurrent(id, gen)) {
        if ([401,403,404,410].includes(e.status)) rtReadFailure(id, gen, e);
        else ui.rt.sessionUsageError = e.message;
      }
    }
    finally {
      rtUsageFlights.delete(key);
      if (rtReadCurrent(id, gen)) { ui.rt.sessionUsageLoading = false; if (rtUsageVisible() && typeof rtPatchUsageViews === 'function') rtPatchUsageViews(); }
    }
  })();
  rtUsageFlights.set(key, flight);
  if (typeof rtPatchUsageViews === 'function') rtPatchUsageViews();
  return flight;
}
function rtVisibleReadsChanged({directory = false} = {}) {
  if (directory && rtDirectoryVisible() && (ui.rt.dirDirty || !ui.rt.dir || Date.now() - (ui.rt.dirAt || 0) > 60000)) void rtLoadDir().then(rtRenderListOnly);
  if (typeof sessionLive !== 'undefined' && sessionLive.enabled) {
    if (!rtSessionVisible()) sessionLive.pending.clear();
    else if (sessionLive.dirty.has(`rt:${rtId()}`)) sessionLiveSchedule({kind:'rt',id:rtId()});
  }
  void rtLoadVisibleUsage();
}
function rtReadCurrent(id, gen) { return ui.view === "rt" && id === rtId() && gen === ui.rt.gen; }
function rtReadFailure(id, gen, e, kind = "view") {
  if (!rtReadCurrent(id, gen)) return;
  if (rtContentOp?.id === id) rtContentOpEnd('failure', e);
  if (kind === 'view') ui.rt.statusConfirmed = false;
  ui.rt[kind === 'view' ? 'viewSyncError' : 'messageSyncError'] = e.message;
  ui.rt.syncError = ui.rt.viewSyncError || ui.rt.messageSyncError;
  if ([401, 403, 404, 410].includes(e.status)) {
    if (typeof rtCloseFactAuditDialog === 'function') rtCloseFactAuditDialog(false);
    if (typeof rtCloseMemoryDialog === 'function') rtCloseMemoryDialog(false);
    if (typeof sessionSyncInvalidate === 'function') sessionSyncInvalidate({kind:'rt',id});
    if (typeof sessionPersistenceInvalidate === 'function') void sessionPersistenceInvalidate(e.status === 401 ? undefined : {kind:'rt',id});
    ui.rt.diskDisplay = null; ui.rt.diskAuthorized = false;
    ui.rt.web = null; ui.rt.injection = null; ui.rt.cardTab = null; ui.rt.gen++; sessionSnapshotDrop(`rt:${id}`); ui.rt.view = null; ui.rt.events = []; ui.rt.messagesFor = null; rtStop();
    ui.rt.viewError = e.message;
    document.getElementById('main')?.replaceChildren(h('p',{class:'field-error',role:'alert'},e.message));
    if (e.status === 401) sessionCachesClear();
  } else if (!ui.rt.view) ui.rt.viewError = e.message;
}
async function rtLoadDeploymentQueue(id, gen) {
  if (!ui.rt.access?.control) return;
  try {
    const r = await api(`/api/runtime-sessions/${encodeURIComponent(id)}/deployment-queue`);
    if (rtReadCurrent(id, gen)) ui.rt.deploymentQueue = { id, messages: r.messages || [] };
  } catch { /* 保留最后一次确认的队列；读取失败不能把已受理消息显示成消失 */ }
}
async function rtLoadView(id, gen) {
  if (id === RT_SERVICE_ID) return rtLoadServiceNotices();
  if (!rtSessionVisible() || !rtReadCurrent(id, gen)) return;
  return sessionRefreshOnce(`rt-view:${id}:${gen}`, async () => {
    try {
      await rtLoadDeploymentQueue(id, gen);
      if (rtConversationVisible() && await rtTrySync(id,gen)) { void rtEnsureAccountState(id, gen); return; }
      const v = await api(`/api/runtime-sessions/${id}?detail=summary`);
      if (!rtReadCurrent(id, gen)) return;
      rtApplyConfirmedView(id, v);
    } catch (e) { rtReadFailure(id, gen, e); }
  });
}
/** 服务端返回的完整画面：替换本地画面并标记「已核对最新状态」 */
function rtApplyConfirmedView(id, v) {
  if (JSON.stringify(ui.rt.view) !== JSON.stringify(v)) ui.rt.view = { ...v, ...(ui.rt.usageFor === id && ui.rt.view?.usage ? {usage:ui.rt.view.usage} : {}) }; ui.rt.viewError = ""; ui.rt.viewSyncError = ''; ui.rt.syncError = ui.rt.messageSyncError || ''; ui.rt.statusConfirmed = true;
  ui.rt.diskDisplay = null; window.piOpenTiming?.mark('body-net');
  if (typeof sessionPersistCurrent === 'function') sessionPersistCurrent({kind:'rt',id});
  void rtLoadVisibleUsage();
}
/*
 * 审批卡片在「核对最新状态」时插队核对一次：常规读取可能还排在慢的后台读取（额度、目录）后面，
 * 或者上一次读取超时后要等定时重试。这里用紧急优先级直接读完整画面（可多占一个读取槽位），
 * 失败按 2 / 4 / 8 / 10 秒退避重试，直到核对成功、卡片消失或离开这个会话。
 */
const rtApprovalConfirm = { id: null, gen: -1, flight: null, timer: null, failures: 0 };
function rtApprovalConfirmPending() {
  return ui.rt.statusConfirmed === false && (ui.rt.view?.approvals || []).some((a) => a.state === "pending") && !!ui.rt.access?.control;
}
function rtApprovalConfirmSoon() {
  const id = rtId(), gen = ui.rt.gen, c = rtApprovalConfirm;
  if (!id || !rtConversationVisible()) return;
  if (c.id !== id || c.gen !== gen) { clearTimeout(c.timer); Object.assign(c, { id, gen, flight: null, timer: null, failures: 0 }); }
  if (c.flight || c.timer || !rtApprovalConfirmPending()) return;
  const flight = c.flight = (async () => {
    try {
      // 独立路径：不和排在闸门外的常规读取合并（合并就继承不了紧急优先级）
      const v = await api(`/api/runtime-sessions/${encodeURIComponent(id)}?confirm=approval&detail=summary`, { readPriority: -1 });
      if (!rtReadCurrent(id, gen)) return;
      c.failures = 0;
      rtApplyConfirmedView(id, v);
    } catch (e) {
      if (!rtReadCurrent(id, gen)) return;
      c.failures++;
      // 失去权限 / 会话没了：交给常规失败处理（清画面、提示）
      if ([401, 403, 404, 410].includes(e.status)) rtReadFailure(id, gen, e);
    } finally {
      if (rtApprovalConfirm.flight === flight) rtApprovalConfirm.flight = null;
      if (rtReadCurrent(id, gen) && rtApprovalConfirm.id === id && rtApprovalConfirm.gen === gen) {
        if (rtApprovalConfirmPending() && !c.timer) c.timer = setTimeout(() => { c.timer = null; rtApprovalConfirmSoon(); }, Math.min(10000, 1000 * 2 ** Math.max(1, c.failures)));
        rtRenderSoft();
      }
    }
  })();
}
async function rtLoadMessages(id, gen) {
  if (id === RT_SERVICE_ID) return rtLoadServiceNotices();
  if (!rtConversationVisible() || !rtReadCurrent(id, gen)) return;
  return sessionRefreshOnce(`rt-messages:${id}:${gen}`, async () => {
    try {
      if (await rtTrySync(id,gen)) return;
      const m = await api(`/api/runtime-sessions/${id}/messages?limit=50`);
      if (!rtReadCurrent(id, gen)) return;
      rtApplyMessages(m,id,gen,!!ui.rt.syncLatestFallback&&!ui.rt.trimmedTail);
    } catch (e) { rtReadFailure(id, gen, e, "messages"); }
  });
}
/*
 * 故障诊断：单会话内容是关键操作之一。从进入会话（没有内存快照可直接显示时）算起，
 * 到这个会话的消息第一次真正应用到页面为止；读取失败记失败，离开会话记正常取消。
 */
let rtContentOp = null;
function rtContentOpStart(id) {
  rtContentOpEnd('navigate');
  const op = window.piTelemetry?.op?.('session-content');
  if (op) rtContentOp = { id, op };
}
function rtContentOpEnd(kind, error) {
  const current = rtContentOp; if (!current) return;
  rtContentOp = null;
  if (kind === 'success') current.op.success();
  else if (kind === 'failure') current.op.failure(error, error?.status);
  else current.op.cancel(kind);
}
function rtApplyMessages(m,id,gen,exact=false) {
  if (!rtReadCurrent(id,gen)) return;
  if (rtContentOp?.id === id) rtContentOpEnd('success');
  ui.rt.diskDisplay=null;ui.rt.syncLatestFallback=false;
      const r = ui.rt; r.messageSyncError = ''; r.syncError = r.viewSyncError || '';
      const before = r.events, known = new Map(before.map(e => [e.key, e]));
      let events;
      if (!r.atBottom && before.length) {
        // 阅读历史：冻结已加载窗口，只合并窗口内记录的更新；更新的记录只计数，
        // 滚到底部再按 after 续读——不能整窗替换或从尾部裁剪，否则正在读的上下文会被挤掉。
        // 没有已加载窗口时（如本机缓存只存了阅读位置）不能冻结，否则整窗永远是空的。
        events = before.map(e => m.events.find(x => x.key === e.key) || e);
        if (m.events.some(e => e.seq > (before.at(-1)?.seq ?? 0) && !known.has(e.key))) r.trimmedTail = true;
      } else if (exact && !r.trimmedTail) {
        events = m.events;
      } else {
        const first = m.events[0]?.seq;
        events = [...before.filter(e => first != null && e.seq < first), ...m.events];
        if (events.length > 200) events = events.slice(-200);
        r.trimmedTail = events.at(-1)?.seq < m.events.at(-1)?.seq;
      }
      const changed = JSON.stringify(before) !== JSON.stringify(events);
      r.events = changed ? events : before;
      r.hasMoreBefore = before.length && events[0]?.seq === before[0]?.seq && (r.trimmedTail || events[0]?.seq < m.events[0]?.seq) ? r.hasMoreBefore : m.hasMoreBefore || events[0]?.seq > before[0]?.seq; r.total = m.total; r.coverage = m.coverage; r.notes = m.notes || [];
      r.lastSeq = Math.max(r.lastSeq || 0, m.lastSeq || 0); r.messagesFor = id;
      if (changed) {
        r.panelRevision = (r.panelRevision || 0) + 1;
        if (!r.atBottom) r.newCount += m.events.filter(e => !known.has(e.key)).length;
        const box = document.querySelector('.rt-transcript');
        const reading = sessionReadingCapture(box, r.atBottom);
        if (box) {
          const removed = before.some(e => !events.some(x => x.key === e.key));
          if (removed) rtRerenderTranscript(box);
          else for (const e of events) if (JSON.stringify(known.get(e.key)) !== JSON.stringify(e)) rtPatchEventRow(e, !known.has(e.key));
          sessionReadingRestore(box, reading);
        }
      }
      rtRenderNavStatus(); rtPatchNewCount();
      if (ui.view === 'rt' && rtId() === id) { rtFillNewerIfShort(); rtFillEarlierIfShort(); }
      if (typeof sessionPersistCurrent === 'function') sessionPersistCurrent({kind:'rt',id});
 }
const rtSyncFlights = new Map();
function rtTrySync(id,gen) {
  const key=JSON.stringify([id,gen,typeof sessionDeltas==='undefined'?null:sessionDeltas.epoch]);
  const old=rtSyncFlights.get(key);if(old)return old;
  const promise=rtTrySyncOnce(id,gen).finally(()=>{if(rtSyncFlights.get(key)===promise)rtSyncFlights.delete(key);});
  rtSyncFlights.set(key,promise);return promise;
}
async function rtTrySyncOnce(id,gen) {
  if (typeof sessionSyncRead !== 'function' || ui.rt.trimmedTail || ui.rt.events.length>50) return false;
  const result=await sessionSyncRead({kind:'rt',id},{limit:50},gen);
  if (!result) { ui.rt.syncLatestFallback ||= !!ui.rt.deltaEnabled||!!ui.rt.diskDisplay; ui.rt.deltaEnabled=false; return false; }
  if (!rtReadCurrent(id,gen)) return true;
  const r=ui.rt,old=r.view;
  if(result.unchanged && r.appliedSyncCursor===result.cursor && r.appliedSyncEpoch===result.epoch && r.deltaEnabled && r.statusConfirmed && r.messagesFor===id && old && !r.diskDisplay && !r.syncError && !r.viewError && !r.viewSyncError && !r.messageSyncError)return true;
  r.deltaEnabled=true;r.syncLatestFallback=false;
  const syncedRateLimit=rtPickRateLimit(result.state.session,old?.rateLimit,r.profiles?.find(p=>p.runtimeKind===result.state.session?.runtimeKind)?.rateLimit);
  r.view={...result.state,...(old?.usage?{usage:old.usage}:{}),...((old?.profile||r.profiles?.find(p=>p.runtimeKind===result.state.session?.runtimeKind))?{profile:old?.profile||r.profiles.find(p=>p.runtimeKind===result.state.session?.runtimeKind)}:{}),...(syncedRateLimit?{rateLimit:syncedRateLimit}:{}),...(old?.balances?{balances:old.balances}:{})};
  r.statusConfirmed=true;r.viewError='';r.viewSyncError='';r.syncError='';r.diskDisplay=null;window.piOpenTiming?.mark('body-net');
  rtApplyMessages({events:result.items.map(i=>i.value),...result.window},id,gen,true);
  r.appliedSyncCursor=result.cursor;r.appliedSyncEpoch=result.epoch;
  void rtLoadVisibleUsage();
  return true;
}
/**
 * 增量同步的 state 不带 rateLimit（账号级资源，见 runtime-sync-source.ts）。
 * 从候选快照里取与会话同一账户作用域、采样最新的一份：上一份 view 的、或「新建会话」用的 runtime 配置里的。
 * 两者来自同一个按作用域存储的快照，所以和完整读取 /api/runtime-sessions/:id 的结果一致。
 */
function rtPickRateLimit(session, ...candidates) {
  const scope = session?.identityScopeId;
  if (!scope) return undefined;
  return candidates
    .filter((rl) => rl && rl.identityScopeId === scope)
    .sort((a, b) => (Date.parse(b.sampledAt || "") || 0) - (Date.parse(a.sampledAt || "") || 0))[0];
}
// 余额采样时间与服务端 BALANCE_AUTO_REFRESH_MS 一致：超过就重新读一次
const RT_BALANCE_FRESH_MS = 600_000;
function rtBalancesFresh(balances) {
  const at = Date.parse(balances?.[0]?.balance?.fetchedAt ?? "");
  return !!balances?.length && Number.isFinite(at) && Date.now() - at < RT_BALANCE_FRESH_MS;
}
const rtAccountFetchAt = new Map();
/**
 * profile / rateLimit / balances 是账号级独立资源，刻意不进增量同步的 state（见 runtime-sync-source.ts）。
 * 增量同步的 view 里因此没有余额：Pi 会话缺失余额或余额过期时，用一次完整读取补齐，
 * 只合并这几个字段，避免覆盖刚同步到的最新会话状态。force 用在服务端余额变化事件之后。
 */
async function rtEnsureAccountState(id, gen, { force = false, render = true } = {}) {
  if (!rtReadCurrent(id, gen)) return;
  const view = ui.rt.view;
  if (view?.session?.platformSessionId !== id || view.session.runtimeKind !== "pi") return;
  if (!force && rtBalancesFresh(view.balances)) return;
  const now = Date.now();
  if (!force && now - (rtAccountFetchAt.get(id) ?? -Infinity) < 60_000) return;
  rtAccountFetchAt.set(id, now);
  try {
    const v = await api(`/api/runtime-sessions/${id}?detail=summary`);
    const cur = ui.rt.view;
    if (!rtReadCurrent(id, gen) || cur?.session?.platformSessionId !== id || v.session?.platformSessionId !== id) return;
    ui.rt.view = { ...cur,
      ...(v.profile ? { profile: v.profile } : {}),
      ...(v.rateLimit ? { rateLimit: v.rateLimit } : {}),
      ...(v.balances?.length ? { balances: v.balances } : {}) };
    if (render) rtRenderSoft();
  } catch { /* 账号级资源读不到不影响同步画面 */ }
}
/**
 * 距顶部还剩多少像素就预取更早一页：至少一屏半。
 * 提前量要盖住一次网络往返，滚动时新内容通常在到达顶部之前就已铺好，
 * 不会先看到「加载更早的记录」按钮或顶部空白。
 */
function rtEarlierPrefetchGap(el) { return Math.max(600, el.clientHeight * 1.5); }
/** 「加载更早的记录」按钮：读取失败后同一个按钮变成「重新读取」，不再静默失败。 */
function rtEarlierButton(label) {
  const failed = !!ui.rt.earlierError;
  return h("button", { type: "button", class: `btn small rt-earlier${failed ? " rt-earlier-error" : ""}`, title: failed ? ui.rt.earlierError : undefined, onclick: () => void rtLoadEarlier({ manual: true }) }, failed ? "读取更早的记录失败，点此重新读取" : label);
}
/** 把按钮文字 / 状态同步到已经在 DOM 里的按钮（读取失败或重试时不整页重绘，免得打断阅读位置）。 */
function rtPatchEarlierButton(label) {
  const btn = document.querySelector(".rt-transcript .rt-earlier");
  if (!btn) return;
  const failed = !!ui.rt.earlierError;
  btn.classList.toggle("rt-earlier-error", failed);
  btn.disabled = !!ui.rt.loadingEarlier && !failed;
  btn.title = failed ? ui.rt.earlierError : "";
  btn.textContent = failed ? "读取更早的记录失败，点此重新读取" : (label || (ui.rt.total ? `加载更早的记录（共 ${ui.rt.total} 条）` : "加载更早的记录"));
}
/**
 * manual：用户点了按钮 / 下拉手势。失败后自动触发（滚动预取、补读）全部停下，
 * 只有用户明确点「重新读取」才再发，免得每次滚动都打一次已经失败的接口。
 */
async function rtLoadEarlier({ manual = false } = {}) {
  const id = rtId(), gen = ui.rt.gen; const first = ui.rt.events[0];
  if (ui.rt.loadingEarlier || !id || !first || !ui.rt.hasMoreBefore) return;
  if (ui.rt.earlierError && !manual) return;
  ui.rt.loadingEarlier = true;
  if (ui.rt.earlierError) { ui.rt.earlierError = ""; rtPatchEarlierButton("正在读取…"); }
  if (typeof sessionSyncInvalidate === 'function') sessionSyncInvalidate({kind:'rt',id});
  try {
    const box = document.querySelector(".rt-transcript");
    const before = box ? box.scrollHeight - box.scrollTop : 0;
    const m = await api(`/api/runtime-sessions/${id}/messages?limit=100&before=${first.seq}`);
    if (!rtReadCurrent(id, gen)) return;
    ui.rt.events = [...m.events, ...ui.rt.events];
    ui.rt.hasMoreBefore = m.hasMoreBefore;
    renderMain();
    const box2 = document.querySelector(".rt-transcript");
    if (box2) box2.scrollTop = box2.scrollHeight - before;
  } catch (e) {
    // 取消（换页）不算失败；其余错误转成可见的错误状态，不再抛成 unhandled_rejection。
    if (e?.name === "AbortError" || !rtReadCurrent(id, gen)) return;
    ui.rt.earlierError = e?.message || "读取失败";
    rtPatchEarlierButton();
  }
  finally { ui.rt.loadingEarlier = false; }
}
/**
 * 上拉续读：把「最新几条之后」的记录补进窗口。
 * keepAnchor：自动补读（用户仍在阅读历史，只是窗口太短）时用；即使追到最新也不把阅读位置拉到底部。
 */
async function rtLoadNewer({ keepAnchor = false } = {}) {
  const id = rtId(), gen = ui.rt.gen, last = ui.rt.events.at(-1);
  if (!id || !last || ui.rt.loadingNewer || !ui.rt.trimmedTail) return;
  ui.rt.loadingNewer = true;
  const box = document.querySelector(".rt-transcript");
  const reading = sessionReadingCapture(box, false);
  const readAtBottom = ui.rt.atBottom;
  try {
    const m = await api(`/api/runtime-sessions/${id}/messages?limit=100&after=${last.seq}`);
    if (!rtReadCurrent(id, gen)) return;
    const known = new Set(ui.rt.events.map((e) => e.key));
    const add = m.events.filter((e) => !known.has(e.key));
    if (add.length) ui.rt.events = [...ui.rt.events, ...add];
    ui.rt.lastSeq = Math.max(ui.rt.lastSeq || 0, m.lastSeq || 0);
    // 旧服务端可能没有 hasMoreAfter：退回到“整页返回说明可能还有”的保守判断。
    ui.rt.trimmedTail = typeof m.hasMoreAfter === "boolean" ? m.hasMoreAfter : m.events.length >= 100;
    ui.rt.newCount = 0;
    const reachedLatest = !ui.rt.trimmedTail;
    const settleAtBottom = reachedLatest && !(keepAnchor && !readAtBottom);
    ui.rt.atBottom = settleAtBottom;
    ui.rt.reading = settleAtBottom ? { atBottom: true } : reading;
    renderMain();
    const box2 = document.querySelector(".rt-transcript");
    if (box2 && settleAtBottom) box2.scrollTop = box2.scrollHeight;
    rtRenderNavStatus(); rtPatchNewCount();
  } catch (e) { if (e?.name !== "AbortError" && rtReadCurrent(id, gen)) { ui.rt.error = e.message; rtRenderNavStatus(); } }
  finally { ui.rt.loadingNewer = false; }
}
let rtProfilesFlight = null;
async function rtLoadProfilesOnce() {
  const generation = (ui.rt.profileLoadGeneration || 0) + 1; ui.rt.profileLoadGeneration = generation;
  const pageGeneration = ui.rt.gen;
  // 运行时状态是全局数据：只丢弃比已收到的更旧的响应；页面刷新代次变了也照样采用（否则会一直停在「未检查」）
  try { const r = await rtRetryRead(() => api("/api/runtime-profiles"), () => generation === ui.rt.profileLoadGeneration); if (generation !== ui.rt.profileLoadGeneration || !r || !Array.isArray(r.profiles)) return; ui.rt.profiles = r.profiles; ui.rt.host = r.host; ui.rt.codexReset = r.codexReset || null; ui.rt.profilesCached = false; if(ui.rt.view&&!ui.rt.view.profile)ui.rt.view.profile=r.profiles.find(p=>p.runtimeKind===ui.rt.view.session?.runtimeKind); if(ui.rt.view?.session){const rl=rtPickRateLimit(ui.rt.view.session,ui.rt.view.rateLimit,r.profiles.find(p=>p.runtimeKind===ui.rt.view.session.runtimeKind)?.rateLimit);if(rl)ui.rt.view.rateLimit=rl;} rtWriteCache(); }
  catch (e) { if (generation === ui.rt.profileLoadGeneration && pageGeneration === ui.rt.gen) ui.rt.error = e.message; }
}
/** 回前台 / 断线恢复时多个入口会同时要运行时列表：共享一条在飞读取。 */
function rtLoadProfiles() {
  if (rtProfilesFlight) return rtProfilesFlight;
  const flight = rtLoadProfilesOnce().finally(() => { if (rtProfilesFlight === flight) rtProfilesFlight = null; });
  rtProfilesFlight = flight; return flight;
}
async function rtLoadUsage() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  try { ui.rt.usageSummary = await api(`/api/runtime-usage?days=14&tz=${encodeURIComponent(tz)}`); ui.rt.usageError = ""; }
  catch (e) { ui.rt.usageError = e.message; }
}
async function rtBalancesChanged() {
  const gen = ui.rt.gen, id = rtId(), view = ui.view;
  if (!["rt", "rt-new", "runtimes"].includes(view) || (view === "rt" && !rtConversationVisible() && !rtDirectoryVisible())) return;
  await Promise.all([rtLoadProfiles(), view === "rt" && ui.rt.view?.session.runtimeKind === "pi" ? rtEnsureAccountState(id, gen, { force: true, render: false }) : null]);
  if (gen !== ui.rt.gen || id !== rtId() || view !== ui.view) return;
  rtPatchQuotaViews();
  if (view === "rt") {
    const info = document.querySelector(".rt-info");
    if (info && ui.rt.view) info.replaceWith(rtInfo(ui.rt.view));
    if (ui.rt.view) rtPatchComposeAccount(ui.rt.view);
  } else renderMain();
}
async function rtLoadSettings() {
  try {
    ui.rt.settings = await rtRetryRead(() => api("/api/runtime-settings"));
    rtSyncPreferencesFromServer(ui.rt.settings?.newSessionPreferences);
    rtWriteCache();
  } catch (e) { ui.rt.error = e.message; }
}

/**
 * 切换会话：先用有界缓存里的上一份画面（立即可见），再在后台核对最新数据（V2.7 的按页加载与竞态隔离）。
 * 缓存只放最近 12 个会话的会话摘要与最新一页对话。
 */
function rtRemember() {
  const id = rtId(), r = ui.rt;
  if (!id || id === RT_SERVICE_ID || !r.view) return;
  const box = document.querySelector('.rt-center[data-ro] .rt-transcript');
  if (box && ui.view === 'rt') { rtRememberFolds(box); r.reading = sessionReadingCapture(box, r.atBottom); }
  const snap = rtSnapshotEvents(r);
  sessionSnapshotPut(`rt:${id}`, { view: r.view, events: snap.events, hasMoreBefore: snap.hasMoreBefore, total: r.total, coverage: r.coverage, notes: r.notes, lastSeq: r.lastSeq,
    atBottom: r.atBottom, reading: r.reading, openSteps: r.openSteps, openFolds: r.openFolds, trimmedTail: snap.trimmedTail, newCount: r.newCount });
}
/**
 * 离页快照最多保留 200 条事件，但不能因此丢掉阅读锚点或伪称历史完整。
 * 以锚点为准截取一段正好 200 条（贴底跟随时保留最新一段），并按实际截掉的部分重算前后分页边界。
 * 否则「拉到最早再退出」后恢复出的窗口会停在某个回合中间，看起来像会话断了。
 */
function rtSnapshotEvents(r) {
  const events = r.events, budget = 200;
  if (events.length <= budget) return { events, hasMoreBefore: r.hasMoreBefore, trimmedTail: r.trimmedTail };
  let start;
  if (r.atBottom) start = events.length - budget;
  else {
    const anchor = r.reading?.seq;
    const idx = anchor == null ? -1 : events.findIndex((e) => e.seq >= anchor);
    // 锚点前留少量上下文，其余预算都给后面的正文，保证还能继续往下读。
    start = idx < 0 ? events.length - budget : Math.max(0, Math.min(idx - 20, events.length - budget));
  }
  const end = Math.min(events.length, start + budget);
  return {
    events: events.slice(start, end),
    hasMoreBefore: r.hasMoreBefore || start > 0,
    trimmedTail: r.trimmedTail || end < events.length,
  };
}
function rtSelect(id) {
  rtRemember(); rtStop(); ui.rt.gen++;
  const hit = id ? sessionSnapshotGet(`rt:${id}`) : null, r = ui.rt;
  r.memory = null;
  r.diskDisplay = null; r.diskAuthorized = false; r.diskRestorePending = false; r.diskRestoreFlight = null; r.memoryDisplay = !!hit; r.deltaEnabled = false; r.outgoing = hit?.initialOutgoing ? { [id]: hit.initialOutgoing } : {}; r.busy = ''; r.sendKey = null;
  // 记住上一次看的会话：列表页顶部的「返回」用它回到详情；进入会话时收起列表页与副标题
  if (r.id) r.lastId = r.id;
  if (id) r.listOpen = false;
  r.subOpen = false; r.moreOpen = false; r.noticeOpen = false; r.runtimeGrants = null; r.noteOpen = false; r.recommendationOpen = false;
  r.id = id; r.infoOpen = false; r.view = hit?.view || null; r.events = hit ? hit.events.slice() : [];
  r.hasMoreBefore = hit?.hasMoreBefore || false; r.total = hit?.total || 0; r.coverage = hit?.coverage || ''; r.notes = hit?.notes || [];
  r.lastSeq = hit?.lastSeq || 0; r.messagesFor = hit ? id : null;
  r.error = ''; r.flash = ''; r.trimmedTail = hit?.trimmedTail || false; r.newCount = hit?.newCount || 0; r.atBottom = hit ? hit.atBottom : true;
  r.loadingNewer = false; r.loadingEarlier = false; r.earlierError = ''; r.fillRounds = 0; r.fillEarlierRounds = 0;
  r.reading = hit?.reading || { atBottom: r.atBottom, top: 0 }; r.viewError = ''; r.syncError = ''; r.viewSyncError = ''; r.messageSyncError = ''; r.statusConfirmed = false; r.syncing = !!id && !hit;
  r.linkedNote = null; r.linkedNoteFor = null; r.linkedNoteBusy = false; r.linkedNoteError = '';
  clearTimeout(r.deployTimer); r.deploy = id && r.deployCache[id] ? { id, info: r.deployCache[id] } : null; r.deployLoadedGen = -1;
  r.openSteps = { ...hit?.openSteps }; r.openFolds = { ...hit?.openFolds };
  if(id!==RT_SERVICE_ID&&id&&!hit&&typeof sessionUseWarmDisplay==='function')sessionUseWarmDisplay({kind:'rt',id},r);
  // 有内存快照时内容立即可见，不算一次加载；离开上一个会话的未完成加载记正常取消
  if (id && !hit) rtContentOpStart(id); else rtContentOpEnd('navigate');
  navigationMark('session-cache', { hit: !!hit, type: 'single' });
}

/** app.js 的 refreshPage 在运行时视图上调用：各视图只取自己需要的数据 */
async function rtRefresh() {
  const gen = ui.rt.gen;
  void api('/api/auth/sessions').then(sessionAuthObserve).catch(() => {});
  // 入口能力很少变：有就先用，后台更新
  // Settings entry may initiate a control request: await fresh access there.
  const access = ui.rt.access && ui.view !== "runtimes"
    ? (void rtLoadAccess().catch(() => {}), null)
    : rtLoadAccess().then(() => true).catch((e) => { ui.rt.error = e.message; return false; });
  if (ui.view === "rt") {
    const id = rtId();
    if (id === RT_SERVICE_ID) {
      await access;
      await Promise.all([rtLoadDir(), rtLoadServiceNotices()]);
      if (rtReadCurrent(id,gen)) rtConnect();
      return;
    }
    // 目录由实时流保持更新：切换会话不重复拉取（超过 60 秒才重新取）
    const tasks = [];
    const restoring=id&&rtConversationVisible()&&typeof sessionRuntimeRestorePrepare==='function'&&!ui.rt.diskAuthorized&&!ui.rt.memoryDisplay?sessionRuntimeRestorePrepare({kind:'rt',id},gen):null;
    if(restoring)void restoring.promise.catch(()=>{});
    const background=()=>{
      if(gen!==ui.rt.gen||ui.view!=='rt')return;
      // 配置和目录不在对话的关键路径上；只局部更新，避免替换正在输入的 composer。
      // 冷启动/回前台仍要读一次：本机缓存先显示「上次数值」，最新快照到了再原地换新。
      // 读完后只局部补额度节点：详情卡可能已按增量同步的 view（不含额度）渲染过
      if (rtConversationVisible() && (!ui.rt.profiles || ui.rt.profilesCached)) {
        const profiles = () => {
          if (gen !== ui.rt.gen || !rtConversationVisible()) return;
          return rtLoadProfiles().then(() => {
            if (gen !== ui.rt.gen || ui.view !== "rt") return;
            rtPatchQuotaViews();
            // 列表底部的额度摘要不是配置页的节点：快照到了就地重画一次列表
            if (document.querySelector(".rt-runtimes-summary") && typeof rtRenderListOnly === "function") rtRenderListOnly();
          });
        };
        // 列表不预读配置后，把补充额度读取排在当前对话恢复之后，避免与首屏争抢。
        if (restoring) void restoring.promise.then(profiles, () => {}); else void profiles();
      }
      if (rtDirectoryVisible() && (ui.rt.dirDirty || !ui.rt.dir || Date.now() - (ui.rt.dirAt || 0) > 60_000)) void rtLoadDir().then(() => {
        ui.rt.dirAt = Date.now();
        if (gen === ui.rt.gen && ui.view === "rt") rtRenderListOnly();
      });
    };
    // Directory summaries may follow dispatch without waiting for a slow restore;
    // supplementary profiles above wait for the primary restore to finish.
    if(restoring)void restoring.dispatched.then(background);else background();
    if (id && rtSessionVisible()) {
      // Old clients retain bounded display restore; the new flight already owns it.
      if (!restoring && typeof sessionRestoreDisplay === 'function' && !ui.rt.diskAuthorized && !ui.rt.memoryDisplay) void sessionRestoreDisplay({kind:'rt',id},gen);
      else if (!restoring && !ui.rt.memoryDisplay && !ui.rt.diskDisplay && typeof sessionRestorePreparedDisplay === 'function') void sessionRestorePreparedDisplay({kind:'rt',id},gen);
      if (!rtReadCurrent(id,gen)) return;
      // 「空闲时部署」与「本地验证」状态与详情并行读取（不在关键路径上）
      if (ui.rt.access) { void rtLoadDeploy(id); void rtLoadVerify(id); }
      tasks.push(rtLoadView(id, gen).then(() => {
        // 详情就绪或读取失败就立即显示；消息补读不阻塞首屏与局部重试。
        if (!rtReadCurrent(id, gen)) return;
        if (ui.rt.view) {
          if (ui.rt.showArchived == null) {
            ui.rt.showArchived = !!ui.rt.view.session.archived;
            if (ui.rt.showArchived) void rtArchiveLoad();
          }
          rtConnect();
        }
        rtRenderSoft();
        // 关联待办不在关键路径上：就绪后再补读并局部重绘，读取失败不影响对话
        void rtLoadLinkedNote(id, gen);
      }), rtLoadMessages(id, gen));
    }
    else if (!id) {
      ui.rt.view = null; ui.rt.events = [];
      // The list needs directory notices, not other sessions' transcripts.
      if(typeof sessionLiveConnect==='function')void sessionLiveConnect().catch(()=>{});
    }
    await Promise.all(tasks);
    if (gen !== ui.rt.gen || ui.view !== "rt") return;
    ui.rt.syncing = false;
    rtConnect();
    void rtLoadVisibleUsage();
    // 入口能力还没读到时上面没取：这里补取
    if (id && rtConversationVisible() && ui.rt.deployLoadedGen !== gen) void rtLoadDeploy(id);
  } else if (ui.view === "rt-new") {
    await access;
    // 新建会话在对话工作台里：左侧会话列表照常显示
    await Promise.all([rtLoadProfiles(), rtLoadSettings(), !ui.rt.dir || Date.now() - (ui.rt.dirAt || 0) > 60_000 ? rtLoadDir().then(() => { ui.rt.dirAt = Date.now(); }) : null]);
    if (gen === ui.rt.gen && ui.view === "rt-new" && rtForm().runtimeKind === "antigravity" && ui.rt.antigravityCheck?.generation !== gen) void rtCheckAntigravityConnection();
    rtConnect();
  } else if (ui.view === "runtimes") {
    // 用量汇总要扫本机记录、可能要几秒：它自己的卡片显示「加载中…」，不拖住整页的读取状态
    void rtLoadUsage().then(() => { if (gen === ui.rt.gen && ui.view === "runtimes") renderMain(); });
    const [accessChecked] = await Promise.all([access, rtLoadProfiles(), rtLoadSettings()]);
    if (accessChecked && typeof rtRecoverClaudeLogin === "function") void rtRecoverClaudeLogin(gen);
    rtConnect();
  } else if (ui.view === "rt-room" || ui.view === "rt-room-new") {
    rtStop(); await roomRefresh();
  } else if (ui.view === "rt-compare") {
    // 对比页用自己的实时连接（按组订阅各通道）；左侧会话列表照常显示
    rtStop();
    await Promise.all([access, rtcRefresh(), !ui.rt.dir || Date.now() - (ui.rt.dirAt || 0) > 60_000 ? rtLoadDir().then(() => { ui.rt.dirAt = Date.now(); }) : null]);
  }
  if (gen === ui.rt.gen) void rtRefreshQuotas();
}

/* ------------------------------ 实时流 ------------------------------ */

let rtDirTimer = null;
let rtViewTimer = null;
let rtLegacyHealth = null;
function rtConnect(legacy = false) {
  const id = ui.view === "rt" && !rtServiceOpen() ? rtId() || "" : "";
  if(!legacy&&typeof sessionLiveConnect==='function'&&(id||sessionLive.enabled||rtServiceOpen())) {
    const gen=ui.rt.gen;rtStop();
    void sessionLiveConnect().then(ok=>{if(!ok&&gen===ui.rt.gen)rtConnect(true);}).catch(()=>{if(gen===ui.rt.gen)rtConnect(true);});return;
  }
  if (ui.rt.es && ui.rt.esFor === id) return;
  rtStop();
  const qs = new URLSearchParams({ after: String(ui.rt.lastSeq || 0) });
  if (id) qs.set("session", id);
  if (id&&ui.rt.deltaEnabled)qs.set("sync","1");
  const es = new EventSource(`/api/runtime/stream?${qs}`);
  try {window.piTelemetry?.trackStream?.(es);} catch {}
  ui.rt.es = es; ui.rt.esFor = id;rtLegacyHealth={es,ready:false,at:0};rtUnreadReschedule();
  const streamGen = ui.rt.gen;
  const current = () => ui.rt.es === es && (!id || rtReadCurrent(id, streamGen));
  // 与 session-sync 的共享流同一套判空 + 自愈：stop / error 会把 rtLegacyHealth 置空，心跳到达时按当前的流补建。
  es.addEventListener("ping",()=>{
    if(!current())return;
    const h=rtLegacyHealth;
    if(!h||h.es!==es)rtLegacyHealth={es,ready:true,at:Date.now()};
    else h.at=Date.now();
    rtUnreadReschedule();
  });
  es.addEventListener("ready", () => {
    if(!current())return;rtLegacyHealth={es,ready:true,at:Date.now()};rtUnreadReschedule();
    // 断线期间的会话变化不会补发：重连后重新读一次列表，免得列表停在旧状态（如一直显示「运行中」）
    if (ui.rt.conn) { announce("对话的实时连接已恢复"); if (ui.view === "rt" || ui.view === "rt-new") void rtLoadDir().then(rtRenderListOnly); }
    // 会话页先读画面、再开这条连接：中间发生的状态变化（如刚弹出的审批）只有消息会补发，状态不会。连上后补读一次画面
    if (id && ui.view === "rt" && rtId() === id) { const g = ui.rt.gen; const work=qs.has("sync")?Promise.all([rtLoadView(id,g),rtLoadMessages(id,g)]):rtLoadView(id,g); void work.then(() => { if (ui.view === "rt" && rtId() === id) rtRenderSoft(); }); }
    ui.rt.conn = ""; rtPatchConn();
  });
  es.addEventListener("sync-notice", () => {
    if(!current())return;clearTimeout(rtViewTimer);rtViewTimer=setTimeout(()=>{
      if(!current())return;const g=ui.rt.gen;
      const work=ui.rt.deltaEnabled?rtLoadView(id,g):Promise.all([rtLoadView(id,g),rtLoadMessages(id,g)]);
      void work.then(()=>{if(current())rtRenderSoft();});
    },120);
  });
  es.addEventListener("event", (m) => {
    if (!current()) return;
    let e; try { e = JSON.parse(m.data); rtOnEvent(e); } catch { return; /* 坏数据忽略 */ }
    // 完成的消息可能晚于「本轮结束」到达：重算输入区，让快捷回复跟上最后一条助手消息（签名不变时不重绘）
    if (e && e.kind === "message" && !e.partial) rtRenderSoft();
  });
  es.addEventListener("gap", () => { if (!current()) return; const g = ui.rt.gen; void rtLoadMessages(id, g).then(() => { if (current()) rtRenderSoft(); }); });
  es.addEventListener("session", (m) => {
    let u = {}; try { u = JSON.parse(m.data); } catch { return; }
    // 是不是正在看的会话按「现在」判断：刚从新建页跳过来时，消息可能还走旧连接到达（那条连接的 current 是 false）
    const open = ui.view === "rt" ? rtId() : "";
    if (u.current || (open && u.id === open)) { clearTimeout(rtViewTimer); rtViewTimer = setTimeout(() => { const g = ui.rt.gen; const vid = rtId(); if (!vid || ui.view !== "rt") return; void rtLoadView(vid, g).then(() => { if (ui.view === "rt") rtRenderSoft(); }); }, 150); }
    clearTimeout(rtDirTimer); rtDirTimer = setTimeout(() => { if (ui.view === "rt" || ui.view === "rt-new") void rtLoadDir().then(rtAfterDirReload); }, 400);
  });
  es.addEventListener("directory", (m) => { rtArchiveDirectoryNotice(m); clearTimeout(rtDirTimer); rtDirTimer = setTimeout(() => { if (ui.view === "rt" || ui.view === "rt-new") void rtLoadDir().then(rtAfterDirReload); }, 300); });
  es.addEventListener("profiles", (m) => {
    if (!["runtimes", "rt-new", "rt"].includes(ui.view)) return;
    let update = {}; try { update = JSON.parse(m.data); } catch { /* legacy event */ }
    if (ui.view === "rt" && !rtConversationVisible() && !rtDirectoryVisible()) return;
    void rtLoadProfiles().then(() => update.rateLimit ? rtPatchQuotaViews() : ui.view === "rt" ? rtRenderSoft() : renderMain());
  });
  es.addEventListener("error", () => {
    if (!current()) return;
    rtLegacyHealth=null;rtUnreadReschedule();
    // 断线：标"观察中断/状态待核对"；按最新 seq 重新连，避免浏览器用旧游标重放
    ui.rt.conn = "实时连接中断，状态待核对；已记录的内容仍可查看";
    rtPatchConn();
    es.close(); if (ui.rt.es === es) { ui.rt.es = null; ui.rt.esFor = null; }
    setTimeout(() => { if (!ui.rt.es && (ui.view === "rt" || ui.view === "rt-new" || ui.view === "runtimes")) { const g = ui.rt.gen; if (id) void Promise.all([rtLoadView(id, g)]).then(() => { rtConnect(); rtRenderSoft(); }); else rtConnect();
      // 部署切换服务会断开连接，期间推送的「目录已变」收不到：重连后补读一次列表，否则「部署成功」这类状态标签会一直留着
      if (ui.view === "rt" || ui.view === "rt-new") void rtLoadDir().then(rtAfterDirReload);
    } }, 2000);
  });
}
function rtStop() { rtLegacyHealth=null;if(typeof rtUnreadReschedule==='function')rtUnreadReschedule(); if (ui.rt.es) { ui.rt.es.close(); ui.rt.es = null; ui.rt.esFor = null; } }

function rtOnEvent(e) {
  if (ui.view !== "rt") return;
  rtDesktop.readingUpdated();
  if (ui.rt.deltaEnabled) {
    clearTimeout(rtViewTimer);const id=rtId(),gen=ui.rt.gen;
    rtViewTimer=setTimeout(()=>{if(rtReadCurrent(id,gen))void rtLoadView(id,gen).then(()=>{if(rtReadCurrent(id,gen))rtRenderSoft();});},120);
    return;
  }
  ui.rt.panelRevision = (ui.rt.panelRevision || 0) + 1;
  const list = ui.rt.events;
  const i = list.findIndex((x) => x.key === e.key);
  // 正在阅读历史：更新的记录不挤进窗口，只计数并标记；滚到底部会按 after 续读。
  // 窗口为空时没有可保护的阅读上下文，让新记录照常进入，避免空窗把所有更新都计成未读。
  if (i < 0 && !ui.rt.atBottom && list.length) {
    ui.rt.lastSeq = Math.max(ui.rt.lastSeq || 0, e.seq);
    ui.rt.trimmedTail = true;
    ui.rt.newCount++;
    rtPatchNewCount();
    return;
  }
  if (i >= 0) list[i] = e; else { list.push(e); list.sort((a, b) => a.seq - b.seq); }
  ui.rt.lastSeq = Math.max(ui.rt.lastSeq, e.seq);
  // DOM 上限 200：只有正贴底跟随时才丢最早的，阅读历史时窗口冻结。
  const trimmed = ui.rt.atBottom && list.length > 200;
  if (trimmed) { list.splice(0, list.length - 200); ui.rt.hasMoreBefore = true; }
  // 裁剪会改变折叠块的首键；此时重新整理有界窗口，避免留下不可定位的旧块。
  const box = trimmed && document.querySelector(".rt-transcript");
  if (box) { rtRememberFolds(box); rtRerenderTranscript(box); rtPatchNewCount(); return; }
  rtPatchEventRow(e, i < 0);
}

/* ------------------------------ 局部更新 ------------------------------ */

function rtPatchConn() {
  const el = document.getElementById("rt-conn");
  if (el) { el.textContent = ui.rt.conn || ""; el.hidden = !ui.rt.conn; }
}
function rtPatchEventRow(e, isNew) {
  const box = document.querySelector(".rt-transcript");
  if (!box) return;
  if (e.kind === "turn-status" && ui.rt.events.some(rtBackgroundTask)) { rtRerenderTranscript(box); return; }
  return rtPatchBlock(box, e, isNew);
}
/**
 * 对话页：思考与工具调用按块折叠，局部更新只重建事件所在的那一块。
 * 新事件不在末尾（乱序到达）时整段重绘，保持块的划分与顺序正确。
 */
function rtPatchBlock(box, e, isNew) {
  const events = ui.rt.events;
  if (isNew && events.length && events[events.length - 1].key !== e.key) { rtRerenderTranscript(box); return; }
  // 正文之后才到的思考要挪到正文前面：整段重绘
  if (e.kind === "reasoning" && e.key.endsWith(":thinking") && box.querySelector(`[data-ev-key="${CSS.escape(e.key.slice(0, -":thinking".length))}"]`) && !box.querySelector(`[data-ev-key="${CSS.escape(e.key)}"]`)) { rtRerenderTranscript(box); return; }
  const block = rtBlocks(events).find((b) => rtBlockEvents(b).some((x) => x.key === e.key));
  if (!block) return;
  const items = rtBlockEvents(block);
  const top = (el) => { let n = el; while (n && n.parentElement !== box) n = n.parentElement; return n; };
  const old = new Set(items.map((x) => top(box.querySelector(`[data-ev-key="${CSS.escape(x.key)}"]`))).filter(Boolean));
  // 收起的过程没有子行：按组键找原块，不能把更新误当成新块追加。
  if (block.steps) {
    const group = box.querySelector(`[data-steps-key="${CSS.escape(block.steps[0].key)}"]`);
    if (group) old.add(group);
  }
  for (const n of old) rtRememberFolds(n);
  // 展开状态以页面上的为准（toggle 事件是异步的，紧接着到达的更新不能把刚展开的块收起）
  if (block.steps && [...old].some((n) => n.classList.contains("rt-steps") && n.open)) (ui.rt.openSteps ||= {})[block.steps[0].key] = true;
  const node = rtBlockNode(block);
  const maxSeq = items[items.length - 1].seq;
  const first = [...old][0];
  if (first) first.replaceWith(node);
  for (const n of old) if (n !== first) n.remove();
  if (!first) {
    const after = [...box.children].find((x) => x.dataset.evSeq && Number(x.dataset.evSeq) > maxSeq);
    const tail = box.querySelector(".rt-tail");
    if (after) box.insertBefore(node, after); else if (tail) tail.before(node); else box.append(node);
    const empty = box.querySelector(".rt-empty"); if (empty) empty.remove();
  }
  if (ui.rt.atBottom) box.scrollTop = box.scrollHeight;
  else if (isNew) rtPatchNewCount();
  rtPatchOutgoing();
}
function rtRerenderTranscript(box) {
  rtRememberFolds(box);
  const keep = box.scrollTop;
  const openGroups = [...box.querySelectorAll(".rt-steps[open]")];
  const rows = rtBlocks(ui.rt.events).map((b) => {
    // 窗口裁剪改变首键时，仍按剩余事件的交集保留原组展开状态。
    if (b.steps && openGroups.some(group => b.steps.some(e => group.rtStepKeys?.has(e.key)))) (ui.rt.openSteps ||= {})[b.steps[0].key] = true;
    return rtBlockNode(b);
  });
  for (const n of [...box.children]) if (n.dataset.evSeq) n.remove();
  const tail = box.querySelector(".rt-tail");
  for (const n of rows) { if (tail) tail.before(n); else box.append(n); }
  const empty = box.querySelector(".rt-empty"); if (empty && rows.length) empty.remove();
  box.scrollTop = ui.rt.atBottom ? box.scrollHeight : keep;
  rtPatchOutgoing();
}
/** 消息区是否已经贴底：以真实滚动位置为准，避免被陈旧的 atBottom/trimmedTail 误判成「不在最新」。 */
function rtTranscriptAtBottom(box = document.querySelector(".rt-transcript")) {
  // 刚创建的节点还没进 DOM、量不到高度，此时按状态判断，不能把 0/0 当成贴底。
  if (!box || !box.isConnected) return ui.rt.atBottom;
  return box.scrollHeight - box.scrollTop - box.clientHeight < 40;
}
function rtShowJumpLatest(box = document.querySelector(".rt-transcript")) {
  // 已经贴底时没有可跳的目标；更新的记录交给贴底自动续读，不再显示入口。
  if (rtTranscriptAtBottom(box)) return false;
  if (ui.rt.newCount > 0 || ui.rt.trimmedTail) return true;
  if (!box) return false;
  // 距离最新已超出一定距离（一屏半、至少 480px）才给快捷入口
  return box.scrollHeight - box.scrollTop - box.clientHeight > Math.max(480, box.clientHeight);
}
function rtPatchNewCount() {
  const b = document.getElementById("rt-newcount");
  if (!b) return;
  b.hidden = !rtShowJumpLatest();
  b.textContent = ui.rt.newCount > 0 ? `${ui.rt.newCount} 条新内容 ↓` : "跳到最新 ↓";
}
/** 阅读锚点所在回合是否还没有正文回复（例如 200 条上限正好截在过程记录中间）。 */
function rtAnchorTurnIncomplete(events = ui.rt.events) {
  const anchor = ui.rt.reading?.seq;
  if (anchor == null) return false;
  const i = events.findIndex((e) => e.seq >= anchor);
  if (i < 0 || events[i].turnNo == null) return false;
  const turn = events[i].turnNo;
  return !events.slice(i + 1).some((e) => e.kind === "message" && e.turnNo === turn);
}
/**
 * 恢复出的历史窗口比视口还短、且锚点所在回合的回复还没进窗口时，继续补读更新的记录，
 * 免得用户停在一个看似已经结束、又滚不动的旧窗口上。补到回合完整、能滚动或追到最新为止；
 * 最多补几页，避免超大回合把整段历史一次性拖进来。
 */
function rtFillNewerIfShort() {
  if (ui.view !== "rt" || !ui.rt.trimmedTail || ui.rt.atBottom || ui.rt.loadingNewer) return;
  if ((ui.rt.fillRounds || 0) >= 3 || !rtAnchorTurnIncomplete()) return;
  const box = document.querySelector(".rt-transcript");
  if (!box || !box.isConnected || box.clientHeight <= 0) return;
  if (box.scrollHeight > box.clientHeight + 40) return;
  ui.rt.fillRounds = (ui.rt.fillRounds || 0) + 1;
  void rtLoadNewer({ keepAnchor: true });
}
/**
 * 分页按「事件条数」截取，而工具调用/思考会折叠成一行，所以最新一页可能只剩一两行可见内容
 * （甚至一条用户消息都没有），页面又短到滚不动，既触发不了向上预取，看起来就像「只有 1 条」。
 * 窗口还有更早的记录、可见内容撑不满视口，或窗口里一条对话消息都没有时，自动再读更早一页，
 * 直到有正文或能滚动为止；最多补几页，避免超长工具链一次把整段历史拖进来。
 */
function rtFillEarlierIfShort() {
  const r = ui.rt;
  if (!rtConversationVisible() || !r.hasMoreBefore || r.loadingEarlier || r.earlierError || !r.events.length) return;
  const box = document.querySelector(".rt-transcript");
  if (!box || !box.isConnected || box.clientHeight <= 0) return;
  const noMessage = !r.events.some((e) => e.kind === "message");
  const short = box.scrollHeight <= box.clientHeight + 160;
  if (!noMessage && !short) { r.fillEarlierRounds = 0; return; }
  if ((r.fillEarlierRounds || 0) >= 6) return;
  r.fillEarlierRounds = (r.fillEarlierRounds || 0) + 1;
  void rtLoadEarlier();
}
/** 快捷跳到最新：丢弃历史窗口重新读最新一页，并贴底跟随 */
async function rtJumpLatest() {
  const id = rtId();
  ui.rt.newCount = 0;
  if (ui.rt.trimmedTail) {
    ui.rt.trimmedTail = false; ui.rt.events = [];
    ui.rt.atBottom = true; ui.rt.reading = { atBottom: true };
    await rtLoadMessages(id, ui.rt.gen);
    renderMain();
  }
  ui.rt.atBottom = true; ui.rt.reading = { atBottom: true };
  const box = document.querySelector(".rt-transcript");
  if (box) box.scrollTop = box.scrollHeight;
  rtPatchNewCount(); rtRenderNavStatus();
}

/* ------------------------------ 工作台 ------------------------------ */

function rtAccessNote() {
  const a = ui.rt.access;
  if (!a || !a.public) return null;
  if (a.control && a.history) return null;
  return h("div", { class: "rt-banner warn", role: "note" },
    !a.history ? "对外入口未启用运行时对话的查看与控制。需要时在本机（127.0.0.1）的“运行时配置 → 设置”中开启。"
      : "对外入口只开启了查看：创建、续聊、停止与审批需在本机入口操作，或在本机设置中开启对外控制。");
}

const rtPhone = window.matchMedia("(max-width: 760px)");
// 宽度变化后重算标题是否被截断，决定展开的详情里要不要补显示完整标题
window.addEventListener("resize", () => {
  if (ui.view === "rt" || ui.view === "rt-room") rtSyncSubTitle();
  if (ui.view === "rt") for (const card of document.querySelectorAll('.rt-memory-card')) card.rtMemoryMeasure?.();
});
/** 手机宽度下，`#/rt`（没有会话 id）就是全屏会话列表页，`#/rt/<id>` 是会话详情页。 */
function rtListPage() { return rtPhone.matches && !rtId() && location.hash === "#/rt"; }
/** 手机详情与新建页只保留页面自己的导航；会话列表保留全局导航。 */
function rtSyncChrome() {
  // 数据未就绪时也算详情页：进入会话 / 群聊后先摆好页面自己的头部，别让全局一级导航在加载期间露出来
  // 新建会话提交后的过渡态按会话详情页的版式显示，手机上同样走详情页外壳
  const launching = ui.view === "rt-new" && !!ui.rt.launch;
  const sessionDetail = (ui.view === "rt" && (!!ui.rt.view || !!rtId())) || launching;
  const roomDetail = ui.view === "rt-room" && (!!ui.room?.view || !!ui.room?.id);
  const detail = rtPhone.matches && !ui.rt.listOpen && !rtListPage() && (sessionDetail || roomDetail);
  document.body.classList.toggle("rt-phone-detail", detail);
  document.body.classList.toggle("rt-phone-new", rtPhone.matches && ["rt-new", "rt-room-new"].includes(ui.view) && !ui.rt.listOpen && !launching);
  const notes = rtPhone.matches && ui.view === "notes" && !ui.notesManagement;
  const listing = rtPhone.matches && ui.view === "rt" && !!(rtListPage() || (ui.rt.listOpen && rtId()));
  const listChanged = document.body.classList.contains("rt-phone-list") !== listing;
  document.body.classList.toggle("rt-phone-list", listing);
  // 产物列表也是一级应用：手机上同样保留一级导航，否则进入后只能靠浏览器返回。
  // 「应用」里打开的产物（股票持仓等，category "apps"）也是自己的一级页：不铺满屏幕，底栏照样在，
  // 跟着页面滚动收放；只有真正的小游戏 / 评测产物才沉浸全屏、藏起底栏。
  // 设置（含首页）整体是二级页：进去就没有底栏，返回用页头那只返回图标（settings.js）。
  const inlineApp = ui.view === "artifacts" && !!ui.artifactGame && ui.artifactGame.category === "apps";
  const home = rtPhone.matches && (listing || notes || ui.view === "resources" || ui.view === "ledger" || ui.view === "position-guard" || ui.view === "communications" || ui.view === "web-x" || (ui.view === "memory" && !location.hash.startsWith("#/memory/")) || (ui.view === "artifacts" && !ui.artifactEval && (!ui.artifactGame || inlineApp)));
  const homeChanged = document.body.classList.contains("primary-phone") !== home;
  document.body.classList.toggle("primary-phone", home);
  // 手机一级页的入口是底部标签栏，最右「更多」收其余入口与设置。
  document.body.classList.toggle("nav-bottom", home);
  document.body.classList.toggle("primary-phone-subpage", rtPhone.matches && !home);
  const conn = document.getElementById("conn");
  if (conn) {
    conn.disabled = rtPhone.matches;
    if (rtPhone.matches) { conn.removeAttribute("popovertarget"); conn.setAttribute("aria-label", conn.title); }
    else { conn.setAttribute("popovertarget", "conn-detail"); conn.setAttribute("aria-label", `${conn.title}，查看连接说明`); }
  }
  if ((listChanged || homeChanged) && typeof syncNavLayout === "function") syncNavLayout();
  // 复用列表头的真实控件，重绘后接到全局顶栏，避免重复按钮和状态。
  queueMicrotask(rtSyncMobileHeader);
}
// A single live header slot. The placeholder lets the exact same controls return
// to their page on desktop; no cloned buttons, handlers or menu state.
let rtPageHeaderSlot = null;
const rtPageHeaderSelectors = {
  resources: ".resources > .resource-page-head",
  artifacts: ".artifacts-page > .artifact-section__head:has(h1)",
  ledger: ".ledger-head",
  "position-guard": ".position-guard-head",
  communications: ".communications > .com-heading",
  'web-x': ".web-x-head",
  memory: ".pi-memory-panel:not(.pm-settings-page) > .pi-memory-head",
  notes: ".notes-column > .notes-head",
  settings: ".settings-home > .settings-app-head",
};
function rtSyncMobileHeader() {
  const host = document.getElementById("rt-mobile-header");
  const main = document.getElementById("main");
  if (!host || !main) return;
  const selector = rtPageHeaderSelectors[ui.view];
  const next = selector ? main.querySelector(selector) : null;
  const phoneHome = document.body.classList.contains("primary-phone");
  if (rtPageHeaderSlot) {
    const { head, anchor, view } = rtPageHeaderSlot;
    if (!anchor.isConnected || view !== ui.view || (next && next !== head)) {
      head.remove(); anchor.remove(); rtPageHeaderSlot = null;
    } else if (!phoneHome) {
      anchor.replaceWith(head); rtPageHeaderSlot = null;
    }
  }
  if (next) {
    next.classList.add("page-navigation-head");
    // Descriptions and memory tabs belong to the content, just like the
    // session filters below its header. Keep them live rather than cloning.
    const tabs = next.querySelector(":scope > .pi-memory-tabs");
    if (tabs) next.after(tabs);
    const description = next.querySelector(":scope > div > p, :scope > span.muted");
    if (description) { description.classList.add("page-navigation-description"); next.after(description); }
    // 页头右侧的操作才包成 page-navigation-actions；返回图标属于标题行，不是操作（包起来会被 div:first-child 的 flex:1 推成一大块，标题跑到中间）。
    const actions = next.querySelector(".pi-memory-head-actions") || next.querySelector(":scope > button, :scope > a:not(.settings-back)");
    if (actions && !actions.classList.contains("page-navigation-actions")) {
      if (actions.matches("button, a")) {
        const group = document.createElement("div"); group.className = "page-navigation-actions";
        actions.before(group); group.append(actions);
      } else actions.classList.add("page-navigation-actions");
    }
    if (phoneHome) {
      const anchor = document.createComment("page navigation header");
      next.before(anchor);
      rtPageHeaderSlot = { head: next, anchor, view: ui.view };
      host.replaceChildren(next);
    }
  }
  if (rtPageHeaderSlot) return;
  const list = main.querySelector(".rt-list");
  if (document.body.classList.contains("rt-phone-list")) {
    const head = list?.querySelector(".rt-list-head") || host.querySelector(".rt-list-head");
    if (head && host.firstElementChild !== head) host.replaceChildren(head);
  } else {
    const head = host.querySelector(".rt-list-head");
    if (head && list && !list.querySelector(".rt-list-head")) list.prepend(head);
    if (host.childNodes.length) host.replaceChildren();
  }
}
// Memory/settings and other deferred modules can replace their own subtree.
// Observe only child changes: normalizing classes must not cause a render loop.
const rtPageHeaderObserver = new MutationObserver(() => rtSyncMobileHeader());
const rtPageHeaderMain = document.getElementById("main");
if (rtPageHeaderMain) rtPageHeaderObserver.observe(rtPageHeaderMain, { childList: true, subtree: true });
/** 详情页顶部（标题或「会话列表」）：切到全屏列表页；历史里留一条，浏览器返回时回到详情。 */
function rtOpenList() {
  if (!rtPhone.matches) return;
  rtSetInfoOpen(false, false);
  ui.rt.listOpen = true;
  renderMain();
  // 先在本页切到列表，再更新地址留下一段历史；浏览器返回时回到详情
  if (rtId() && location.hash !== "#/rt") location.hash = "#/rt";
}
/** 列表页顶部返回：手机宽度下回到上一次打开的会话；没有就只是收起列表。 */
function rtCloseList() {
  if (rtPhone.matches && rtListPage() && ui.rt.lastId) { location.hash = `#/rt/${encodeURIComponent(ui.rt.lastId)}`; return; }
  rtSetListOpen(false);
}
/**
 * 打开刚创建出来的会话 / 群聊：手机上不该把创建页留在返回链路里。
 * 先把当前的新建页换成会话列表，再压入详情页；系统返回时直接回到列表，而不是又回到创建页。
 */
function rtEnterCreated(hash) {
  if (rtPhone.matches && (ui.view === "rt-new" || ui.view === "rt-room-new")) history.replaceState(null, "", "#/rt");
  location.hash = hash;
}
rtPhone.addEventListener("change", () => {
  rtSyncChrome();
  // 跨 760px 断点时重算导航选中态，避免手机会话列表残留 artifacts 激活态到 PC 竖栏
  window.syncActiveNavTab?.();
  rtSetInfoOpen(false, false);
  rtSyncPhoneControls();
  // 断点变化后重新渲染头部：手机上标题才可点进列表
  if (ui.view === "rt" && ui.rt.view && typeof rtHead === "function") document.querySelector(".rt-head")?.replaceWith(rtHead(ui.rt.view));
  if (ui.view === "rt" && !rtId()) { syncRtListOpen(); renderMain(); }
  else if (["rt", "rt-new", "rt-room-new"].includes(ui.view)) { syncRtListOpen(); rtRenderListOnly(); }
  rtVisibleReadsChanged({directory: true});
});

function rtSyncPhoneControls() {
  for (const input of document.querySelectorAll(".rt-input[data-phone-placeholder]")) {
    input.placeholder = rtPhone.matches ? input.dataset.phonePlaceholder : input.dataset.desktopPlaceholder;
  }
}

function rtSyncInfo(layout) {
  if (!layout) return;
  const open = rtPhone.matches && ui.rt.infoOpen && (ui.view === "rt-new" ? !!ui.rt.launch : !!ui.rt.view);
  const listing = rtPhone.matches && (ui.rt.listOpen || rtListPage());
  layout.classList.toggle("info-open", open);
  for (const el of layout.querySelectorAll(".rt-center, .rt-list")) el.inert = open || (listing && el.classList.contains("rt-center"));
  const side = layout.querySelector(".rt-side");
  if (side) side.hidden = !rtPhone.matches && ui.rt.sideCollapsed;
  if (open) requestAnimationFrame(()=>side?.querySelector('.rt-memory-card')?.rtMemoryMeasure?.());
  if (side?.id === "rt-session-info") side.inert = rtPhone.matches && !open;
  side?.setAttribute("role", open ? "dialog" : "complementary");
  if (open) side?.setAttribute("aria-modal", "true");
  else side?.removeAttribute("aria-modal");
  layout.querySelector(".rt-info-toggle")?.setAttribute("aria-expanded", String(open));
}

function rtSetInfoOpen(open, focus = true) {
  document.querySelector(".rt-layout")?.rtCancelInfoSwipe?.();
  ui.rt.infoOpen = open;
  const layout = document.querySelector(".rt-layout");
  rtSyncInfo(layout);
  rtVisibleReadsChanged();
  if (focus) {
    // 手机上「更多」在没有任何操作（不是平台管理 / 归档中）时不显示，焦点回到标题上的运行时信息开关
    const target = open
      ? layout?.querySelector(".rt-info-close")
      : layout?.querySelector(rtPhone.matches ? ".rt-more-btn" : ".rt-info-toggle") || layout?.querySelector(rtPhone.matches ? ".rt-title-toggle" : ".rt-info-toggle");
    target?.focus();
  }
}

function rtToggleMore(open) {
  ui.rt.moreOpen = !!open;
  const desktop = document.querySelector("#rt-deploy-more");
  if (!open && desktop?.matches(":popover-open")) desktop.hidePopover();
  const wrap = document.querySelector(".rt-head-phone .rt-more");
  if (!wrap) return;
  wrap.classList.toggle("open", !!open);
  wrap.querySelector(".rt-more-btn")?.setAttribute("aria-expanded", String(!!open));
  if (open) (wrap.querySelector('.rt-more-item[aria-checked="true"]') || wrap.querySelector(".rt-more-item"))?.focus();
  else wrap.querySelector(".rt-more-btn")?.focus();
}

function rtInfoKeydown(ev) {
  if (!rtPhone.matches || !ui.rt.infoOpen) return;
  if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); rtSetInfoOpen(false); }
  if (ev.key === "Tab") {
    const buttons = [...ev.currentTarget.querySelectorAll('button:not(:disabled), a[href], [tabindex="0"]')].filter((el) => el.getClientRects().length);
    const first = buttons[0], last = buttons[buttons.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last?.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first?.focus(); }
  }
}

/** 新建页上次用的模式：群聊有自己的地址，单个会话 / 对比多个在 #/rt/new 里切换 */
const RT_NEW_MODE_KEY = "pi-agent.new-mode.v1";
function rtSaveNewMode(mode) { try { localStorage.setItem(RT_NEW_MODE_KEY, mode); } catch { /* 存储不可用时每次从单个会话开始 */ } }
/** 新建页的模式切换：单聊 / 群聊（对比已并入群聊：群聊里 @ 多人的每一轮都能切到对比视图） */
function rtNewModeSwitch() {
  const room = ui.view === "rt-room-new";
  const btn = (active, label, onclick) => h("button", { type: "button", class: `rtc-mode${active ? " active" : ""}`, "aria-pressed": String(active), onclick }, label);
  return h("div", { class: "rtc-modes", role: "group", "aria-label": "新建方式" },
    btn(!room, "单聊", () => { rtSaveNewMode("session"); if (room) { ui.rt.wsOpen = false; ui.rt.folders = null; location.hash = "#/rt/new"; } }),
    btn(room, "群聊", () => { rtSaveNewMode("room"); if (!room) { ui.rt.wsOpen = false; ui.rt.folders = null; location.hash = "#/rt/room/new"; } }));
}
function rtNewModeHref() { try { return localStorage.getItem(RT_NEW_MODE_KEY) === "room" ? "#/rt/room/new" : "#/rt/new"; } catch { return "#/rt/new"; } }

function syncRtListOpen() {
  const layout = document.querySelector(".rt-layout");
  const listing = ui.rt.listOpen || rtListPage();
  layout?.classList.toggle("list-open", listing);
  layout?.classList.toggle("list-page", rtListPage());
  layout?.classList.toggle("list-root", rtListPage() && !ui.rt.lastId);
  if (layout) rtSyncInfo(layout);
  rtSyncChrome();
  if (typeof syncViewport === "function") syncViewport();
  document.querySelectorAll(".rt-center .rt-list-toggle").forEach((btn) => btn.setAttribute("aria-expanded", String(listing)));
}
function rtSetListOpen(open) {
  ui.rt.listOpen = open;
  syncRtListOpen();
  rtVisibleReadsChanged({directory: open});
  if (open) document.querySelector('.rt-list [aria-label="收起会话列表"]')?.focus();
  else document.querySelector(".rt-center .rt-list-toggle")?.focus();
}
/* ------------------------------ 未读 ------------------------------ */

/*
 * 未读按「已结束的轮次」算：每个会话记到看过的最后一轮（存在本浏览器 localStorage，不跨设备）。
 * 首次启用时以当时为基线，之前结束的轮次一律算已读，避免历史会话刷出大数字。
 * 看过 = 单会话页停在底部，或打开了它所在的对比组 / 群聊。
 * 导航角标：红色数字 = 未读轮次 + 待处理的授权卡片；运行中的会话在「对话」文字后用一个慢慢呼吸的小数字表示。
 */
const RT_READ_KEY = "rt-read-turns-v2";
const RT_TURN_ENDED = ["completed", "failed", "cancelled", "interrupted"];
const RT_ACTIVE = ["creating", "running", "stopping"];
const rtRead = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(RT_READ_KEY) || "null");
    if (v && typeof v.since === "string" && v.turns && typeof v.turns === "object" && !Array.isArray(v.turns)) return v;
  } catch { /* 读不了就从现在起算 */ }
  return { since: new Date().toISOString(), turns: {}, fresh: true };
})();
/** 已结束的最后一轮轮次号（最新一轮还没结束就是上一轮） */
function rtLastEndedTurn(e) {
  const t = e.latestTurn;
  return !t ? 0 : RT_TURN_ENDED.includes(t.status) ? t.turnNo : t.turnNo - 1;
}
function rtWatching(id) {
  if (document.hidden) return false;
  if (ui.view === "rt" && !rtConversationVisible()) return false;
  if (ui.view === "rt") return rtId() === id && ui.rt.messagesFor === id && ui.rt.atBottom && !ui.rt.trimmedTail;
  if (ui.view === "rt-compare") return !!ui.rtc?.view?.lanes?.some((l) => l.platformSessionId === id);
  if (ui.view === "rt-room") return !!ui.room?.view?.members?.some((m) => m.platformSessionId === id);
  return false;
}
/** 通知服务变为已读时的排序基准时间：取本机当前时间，且不早于已知最新会话（防时钟偏差导致刚读完立刻下沉）。 */
function rtServiceReadTimestamp() {
  let maxMs = Date.now();
  for (const list of [ui.rt?.dir?.entries, ui.rt?.notifications]) {
    if (!Array.isArray(list)) continue;
    for (const x of list) {
      if (!x || x.archived || x.serviceNotifications || x.id === RT_SERVICE_ID) continue;
      const at = typeof rtTurnOrderAt === "function" ? (rtTurnOrderAt(x) || x.lastActivityAt) : (x.lastTurnEndedAt || x.latestTurn?.endedAt || x.latestTurn?.startedAt || x.lastActivityAt);
      const ms = Date.parse(at || "");
      if (Number.isFinite(ms) && ms >= maxMs) maxMs = ms + 1;
    }
  }
  return new Date(maxMs).toISOString();
}
/** 给新出现的会话定基线、把正在看的会话标为已读；有变化才写存储 */
function rtReadSync(entries) {
  let changed = !!rtRead.fresh;
  let serviceMarkedRead = false;
  for (const e of entries) {
    const ended = rtLastEndedTurn(e);
    // A guessed starting point ("b") may be replaced by what another device really read; a real reading never is.
    if (!(e.id in rtRead.turns)) { rtRead.turns[e.id] = rtRead.fresh || (e.lastActivityAt || "") <= rtRead.since ? ended : 0; (rtRead.b ||= {})[e.id] = 1; changed = true; }
    if (ended > rtRead.turns[e.id] && rtWatching(e.id) && (e.id !== RT_SERVICE_ID || ended <= (ui.rt.serviceNotices?.at(-1)?.seq ?? 0))) {
      rtRead.turns[e.id] = ended;
      if (e.id === RT_SERVICE_ID) {
        const nextAt = rtServiceReadTimestamp();
        const prevAt = rtRead.readAt?.[e.id];
        if (!prevAt || Date.parse(nextAt) > Date.parse(prevAt)) (rtRead.readAt ||= {})[e.id] = nextAt;
        serviceMarkedRead = true;
      }
      if (rtRead.b) delete rtRead.b[e.id];
      rtReadShare.dirty.add(e.id);
      changed = true;
    }
  }
  delete rtRead.fresh;
  if (Object.keys(rtRead.turns).length > 500 && ui.rt.notifications) {
    const ids = new Set(ui.rt.notifications.map((e) => e.id));
    for (const id of Object.keys(rtRead.turns)) if (!ids.has(id)) delete rtRead.turns[id];
    if (rtRead.readAt) for (const id of Object.keys(rtRead.readAt)) if (!ids.has(id)) delete rtRead.readAt[id];
    changed = true;
  }
  if (changed) try { localStorage.setItem(RT_READ_KEY, JSON.stringify(rtRead)); } catch { /* 存储不可用时仍在本页生效 */ }
  if (rtReadShare.dirty.size) rtReadSharePushSoon();
  return serviceMarkedRead;
}
/*
 * 已读位置跨设备共用：只往前走，两台设备合并取较大值。只上传「真的看过」的会话，
 * 本机猜出来的起点不上传；拉取时服务端的数字可以替换本机猜的起点。
 */
const rtReadShare = { dirty: new Set(), timer: null, pulledAt: 0, flight: null, disabled: false };
function rtReadSharePushSoon() {
  if (rtReadShare.disabled || rtReadShare.timer) return;
  rtReadShare.timer = setTimeout(() => { rtReadShare.timer = null; void rtReadSharePush(); }, 1500);
}
async function rtReadSharePush() {
  if (rtReadShare.disabled || !rtReadShare.dirty.size) return;
  const ids = [...rtReadShare.dirty]; rtReadShare.dirty.clear();
  const turns = Object.fromEntries(ids.filter((id) => id in rtRead.turns).map((id) => [id, rtRead.turns[id]]));
  const readAt = Object.fromEntries(ids.filter((id) => typeof rtRead.readAt?.[id] === "string").map((id) => [id, rtRead.readAt[id]]));
  const body = Object.keys(readAt).length ? { turns, readAt } : { turns };
  try { await api("/api/runtime/read-state", { method: "POST", body: JSON.stringify(body) }); }
  catch (e) { if ([403, 404].includes(e?.status)) rtReadShare.disabled = true; else { for (const id of ids) rtReadShare.dirty.add(id); } }
}
async function rtReadSharePull(force = false) {
  if (rtReadShare.disabled || rtReadShare.flight || (!force && Date.now() - rtReadShare.pulledAt < 60000)) return rtReadShare.flight;
  rtReadShare.pulledAt = Date.now();
  rtReadShare.flight = (async () => {
    try {
      const res = await api("/api/runtime/read-state");
      const remote = res?.turns, remoteReadAt = res?.readAt;
      let changed = false;
      if (remote && typeof remote === "object") {
        for (const [id, n] of Object.entries(remote)) {
          if (!Number.isSafeInteger(n) || n < 0) continue;
          const guessed = !!rtRead.b?.[id], local = rtRead.turns[id];
          if (guessed) { delete rtRead.b[id]; if (local !== n) { rtRead.turns[id] = n; changed = true; } }
          else if (local === undefined || n > local) { rtRead.turns[id] = n; changed = true; }
        }
      }
      if (remoteReadAt && typeof remoteReadAt === "object") {
        for (const [id, at] of Object.entries(remoteReadAt)) {
          if (typeof at !== "string") continue;
          const ms = Date.parse(at);
          if (!Number.isFinite(ms)) continue;
          const norm = new Date(ms).toISOString();
          const local = rtRead.readAt?.[id];
          if (!local || ms > Date.parse(local)) { (rtRead.readAt ||= {})[id] = norm; changed = true; }
        }
      }
      if (changed) {
        try { localStorage.setItem(RT_READ_KEY, JSON.stringify(rtRead)); } catch { /* 存储不可用时仍在本页生效 */ }
        if (typeof rtRenderNavStatus === "function") rtRenderNavStatus();
        if (typeof rtRenderListOnly === "function") rtRenderListOnly();
      }
    } catch (e) { if ([403, 404].includes(e?.status)) rtReadShare.disabled = true; }
    finally { rtReadShare.flight = null; }
  })();
  return rtReadShare.flight;
}
function rtUnreadTurns(e) {
  const read = rtRead.turns[e.id];
  return read === undefined ? 0 : Math.max(0, rtLastEndedTurn(e) - read);
}
/** 列表里的未读点；对比组 / 群聊看其中任一会话；已归档的不标 */
function rtUnread(e) {
  if (e.archived) return false;
  if (e.lanes) return e.lanes.some(rtUnread);
  if (e.members) return e.members.some(rtUnread);
  return rtUnreadTurns(e) > 0;
}
/** 列表头像右上角的数字：这条会话里没看过的已结束轮次；对比组 / 群聊 = 其中各会话相加；已归档的不计 */
function rtUnreadCount(e) {
  if (e.archived) return 0;
  if (e.lanes) return e.lanes.reduce((n, l) => n + rtUnreadCount(l), 0);
  if (e.members) return e.members.reduce((n, m) => n + rtUnreadCount(m), 0);
  return rtUnreadTurns(e);
}
let rtLocateLast = null;
/**
 * 双击导航里的「对话」图标：定位到下一条未读会话（按列表从上到下轮流，到底回到第一条）。
 * 列表里能看到就滚过去并闪一下；看不到（折叠的分组 / 筛选掉了 / 手机在详情页）时先切到列表，仍然没有就直接打开它。
 */
function rtLocateUnread() {
  const visibleRows = () => [...document.querySelectorAll(".rt-item.unread")].filter((r) => r.getClientRects().length);
  const entries = (ui.rt.notifications || []).filter((e) => !e.archived && rtUnread(e));
  if (!entries.length) { rtLocateLast = null; return false; }
  const pick = (hrefs) => {
    const i = rtLocateLast ? hrefs.indexOf(rtLocateLast) : -1;
    return hrefs[(i + 1) % hrefs.length];
  };
  let rows = visibleRows();
  if (!rows.length && rtPhone.matches && ui.view?.startsWith("rt") && !ui.rt.listOpen) { rtOpenList(); rows = visibleRows(); }
  if (!rows.length) {
    // 列表里没有这些行：直接打开最近的（按列表顺序的下一条）
    const hrefs = entries.map((e) => e.href).filter(Boolean);
    if (!hrefs.length) return false;
    rtLocateLast = pick(hrefs);
    location.hash = rtLocateLast.replace(/^#?/, "#");
    return true;
  }
  const target = rows.find((r) => r.getAttribute("href") === pick(rows.map((r2) => r2.getAttribute("href")))) || rows[0];
  rtLocateLast = target.getAttribute("href");
  target.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  document.querySelectorAll(".rt-item-locate").forEach((r) => r.classList.remove("rt-item-locate")); void target.offsetWidth; target.classList.add("rt-item-locate");
  setTimeout(() => target.classList.remove("rt-item-locate"), 1800);
  return true;
}
document.addEventListener("dblclick", (ev) => {
  if (!ev.target.closest?.('.tab[data-view="rt"]')) return;
  ev.preventDefault();
  rtLocateUnread();
});
// Keep one ordered bridge request in flight; a slow older snapshot must not overwrite a newer read.
const rtNativeUnread = { sent: "", pending: null, flight: false };
function rtSyncNativeUnread() {
  if (!window.piAndroidShell?.available || !ui.rt.notifications) return;
  const seen = new Set();
  const entries = ui.rt.notifications.filter(e => !e.lanes && !e.members && !seen.has(e.id) && seen.add(e.id)).map(e => ({
    id: e.id, ended: rtLastEndedTurn(e), read: rtRead.turns[e.id] ?? rtLastEndedTurn(e),
    baseline: !(e.id in rtRead.turns) || !!rtRead.b?.[e.id], archived: !!e.archived,
  }));
  rtNativeUnread.pending = JSON.stringify({ since: rtRead.since, observedAt: ui.rt.notificationsAt || 0, complete: ui.rt.notificationsComplete !== false, entries });
  if (rtNativeUnread.flight) return;
  void (async () => {
    rtNativeUnread.flight = true;
    try {
      while (rtNativeUnread.pending !== rtNativeUnread.sent) {
        const next = rtNativeUnread.pending;
        await window.piAndroidShell.call("badge.sync", JSON.parse(next));
        rtNativeUnread.sent = next;
      }
    } catch { /* Older APK / offline bridge: retry on the next list/read update. */ }
    finally { rtNativeUnread.flight = false; }
  })();
}
function rtRenderNavStatus() {
  const nav = document.querySelector('.tab[data-view="rt"]');
  if (!nav || !ui.rt.notifications) return;
  const entries = ui.rt.notifications.filter((e) => !e.archived);
  rtReadSync(entries);
  rtSyncNativeUnread();
  let attention = 0, running = 0;
  for (const e of entries) {
    attention += rtUnreadTurns(e) + (e.pendingApprovals || 0);
    if (RT_ACTIVE.includes(e.status)) running++;
  }
  nav.querySelectorAll(".rt-nav-attention, .rt-nav-running").forEach((el) => el.remove());
  if (attention) nav.append(h("span", { class: "rt-nav-attention", "aria-hidden": "true" }, attention > 99 ? "99+" : String(attention)));
  if (running) (nav.querySelector(".tab-label") || nav).append(h("span", { class: "rt-nav-running", "aria-hidden": "true" }, String(running)));
  nav.setAttribute("aria-label", ["会话", attention ? `${attention} 条待处理` : "", running ? `${running} 个会话运行中` : ""].filter(Boolean).join("，"));
  // 手机上会话不在底栏：别处新来的未读用顶部的悬浮胶囊提醒（session-island.js）
  window.piSessionIsland?.sync(entries);
}
/** 角标跨页面保持更新：取未筛选的普通对话目录（不读历史，开销小），列表的搜索 / 筛选不影响计数 */
const rtUnreadState={timer:null,flight:null,lastAttempt:null,failed:false,again:false,boot:Date.now()+1500};
function rtUnreadHealthExpiry(){
  if(typeof sessionLiveHealthy==='function'&&sessionLiveHealthy())return sessionLiveHealthExpiry();
  return rtLegacyHealth?.ready&&rtLegacyHealth.es===ui.rt.es&&Date.now()-rtLegacyHealth.at<45000?rtLegacyHealth.at+45000:null;
}
function rtUnreadReschedule(){
  clearTimeout(rtUnreadState.timer);rtUnreadState.timer=null;
  if(document.visibilityState==='hidden'||rtUnreadState.flight)return;
  const expiry=rtUnreadHealthExpiry(),healthy=expiry!==null&&!rtUnreadState.failed;
  let due=rtUnreadState.lastAttempt===null?rtUnreadState.boot:rtUnreadState.lastAttempt+(healthy?30000:5000);
  if(healthy)due=Math.min(due,expiry);
  rtUnreadState.timer=setTimeout(()=>{rtUnreadState.timer=null;void rtPollUnread();},Math.max(0,due-Date.now()));
}
function rtPollUnread(force=false){
  if(rtUnreadState.flight){if(force)rtUnreadState.again=true;return rtUnreadState.flight;}
  if(!document.querySelector('.tab[data-view="rt"]')||document.visibilityState==='hidden'){rtUnreadState.lastAttempt=Date.now();rtUnreadReschedule();return Promise.resolve();}
  rtUnreadState.lastAttempt=Date.now();
  rtUnreadState.flight=rtPollUnreadOnce().finally(()=>{rtUnreadState.flight=null;if(rtUnreadState.again){rtUnreadState.again=false;void rtPollUnread();}else rtUnreadReschedule();});return rtUnreadState.flight;
}
async function rtPollUnreadOnce() {
  if (!document.querySelector('.tab[data-view="rt"]') || document.visibilityState === "hidden") return;
  let entries = null, directory;
  // 回前台时列表读取可能已经起飞（实时连接 ready / 整体刷新都会读目录）：
  // 角和列表共用同一条未筛选目录 flight，不要再为角标另发请求。
  try {
    directory = await rtReadUnfilteredDirectory(); entries = [...(directory.entries || [])];
    let cursor = directory.nextCursor; const seen = new Set(), ids = new Set(entries.map(e => e.id));
    if (ids.size !== entries.length) throw new Error("会话目录重复");
    while (cursor) {
      if (seen.has(cursor) || entries.length >= 2000) throw new Error("会话目录分页超限");
      seen.add(cursor);
      const page = await api(`/api/session-directory?source=chat&limit=200&cursor=${encodeURIComponent(cursor)}`);
      if (page.restricted) throw new Error("会话目录权限已变化");
      if (directory.total != null && page.total != null && directory.total !== page.total) throw new Error("会话目录已变化");
      for (const e of page.entries || []) { if (ids.has(e.id)) throw new Error("会话目录已变化"); ids.add(e.id); entries.push(e); }
      cursor = page.nextCursor;
    }
    if (directory.total != null && entries.length !== directory.total) throw new Error("会话目录不完整");
  }
  catch { rtUnreadState.failed = true; return; }
  ui.rt.notifications = entries; ui.rt.notificationsAt = directory.badgeObservedAt; ui.rt.notificationsComplete = true; rtUnreadState.failed = false;
  if(typeof sessionLiveRetryFailures==='function')sessionLiveRetryFailures();
  rtRenderNavStatus();
  // 列表平时靠实时事件刷新；事件丢了或晚到时，角标已经算上而列表还是旧的。
  // 首次目录读取失败 / 尚未拿到时，也要靠这轮轮询自动补读，部署完成后无需用户手动刷新。
  if (["rt", "rt-new", "rt-room", "rt-room-new", "rt-compare"].includes(ui.view) && (!ui.rt.dir || ui.rt.dirError)) void rtLoadDir().then(rtRenderListOnly);
  else if (["rt", "rt-new", "rt-room", "rt-room-new", "rt-compare"].includes(ui.view) && rtDirBehind(ui.rt.notifications)) void rtLoadDir().then(rtRenderListOnly);
  if (rtServiceOpen()) {
    const service = entries.find(e => e.id === RT_SERVICE_ID);
    if (service?.latestTurn?.turnNo !== ui.rt.serviceEntry?.latestTurn?.turnNo) void rtLoadServiceNotices();
  }
  // 正在看的会话同理：状态或待审批数和目录对不上（例如审批卡片没出来），重读会话画面
  if (ui.view === "rt" && rtViewBehind(ui.rt.notifications)) { const id = rtId(), g = ui.rt.gen; void rtLoadView(id, g).then(() => { if (ui.view === "rt" && rtId() === id) rtRenderSoft(); }); }
}
function rtViewBehind(fresh) {
  const v = ui.rt.view, id = rtId();
  if (!v || !v.session || v.session.platformSessionId !== id) return false;
  const e = fresh.find((x) => x.id === id);
  if (!e) return false;
  const pending = (v.approvals || []).filter((a) => a.state === "pending").length;
  return e.status !== v.session.status || (e.pendingApprovals || 0) !== pending;
}
/** 列表里的会话与最新目录对不上：状态、最新一轮、待审批、归档变了，或（没在筛选时）有列表里没有的新会话 */
function rtDirBehind(fresh) {
  const d = ui.rt.dir;
  if (!d || !d.entries) return false;
  const sig = (e) => [e.status, e.statusReason || "", e.latestTurn ? e.latestTurn.turnNo : "", e.latestTurn ? e.latestTurn.status : "", e.latestTurn?.queuedAt || "", e.latestTurn?.startedAt || "", e.lastTurnEndedAt || e.latestTurn?.endedAt || "", e.pendingApprovals || 0, e.archived ? 1 : 0, rtMarkerState(e.deploy)].join("|");
  const listed = new Map(d.entries.map((e) => [e.id, sig(e)]));
  // 只看服务端是否筛过：本地关键字过滤时目录仍是完整的，新会话照样算“落后”
  const filtered = !!(ui.rt.dirQuery || ui.rt.dirRuntime);
  return fresh.some((e) => listed.has(e.id) ? listed.get(e.id) !== sig(e) : !filtered && d.entries.length < 200);
}
rtUnreadReschedule();
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void rtPollUnread(true);else rtUnreadReschedule(); });
/* 离线恢复后 app.js 探测到链路可用：补一次目录与当前对话的增量同步（各自有在飞读取去重）。 */
if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('pi-network-ready', () => {
  if (document.visibilityState === 'hidden') return;
  rtVisibleReadsChanged({ directory: true });
  if (rtPageEffects.has('quota-refresh')) void rtRefreshQuotas();
});

/** 列表里只标需要注意的状态；空闲 / 已结束不打标签 */
const RT_ATTENTION = { creating: ["创建中", "accent"], running: ["运行中", "accent"], "waiting-input": ["等待你处理", "warn"], stopping: ["停止中", "warn"], interrupted: ["被中断", "bad"], failed: ["失败", "bad"] };

function rtElapsedLabel(prefix, startedAt) {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return prefix;
  const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return `${prefix} ${hours ? `${hours}h` : ""}${hours || minutes ? `${minutes}m` : ""}${seconds % 60}s`;
}
function rtRunningLabel(startedAt) { return rtElapsedLabel("运行中", startedAt); }
function rtListAttention(e, att) {
  if (!att || e.status === "waiting-input") return null;
  const queued = e.status === "running" && e.latestTurn?.status === "queued";
  const prefix = queued ? "排队中" : "运行中";
  const startedAt = queued ? e.latestTurn.queuedAt : e.status === "running" && e.latestTurn?.status === "running" ? e.latestTurn.startedAt : undefined;
  const node = badge(e.status === "running" ? rtElapsedLabel(prefix, startedAt) : att[0], queued ? "warn" : att[1]);
  if (e.statusReason) node.title = e.statusReason;
  if (Number.isFinite(Date.parse(startedAt))) {
    node.setAttribute("data-rt-turn-start", startedAt);
    node.setAttribute("data-rt-elapsed-prefix", prefix);
  }
  return node;
}
/**
 * 会话列表里的部署标签：排队等所有会话停下来叫「排队部署」（从登记算起计时，悬停看在等什么）；
 * 开始后按真实阶段显示，并从阶段开始计时；没有阶段记录时显示「准备发布」。
 */
/** 叠加预发模式的步骤文案：1 排队 → 2 预发检查 → 3 待切换（已预发、复核、等对话结束）→ 4 切换上线 */
const rtStagedWord = (q, started, p) => {
  if (!q?.staging) return undefined;
  if (!started) return q.wait?.kind === "staged" ? "3/4 已预发 · 待切换" : q.wait?.kind === "skipped" ? "预发失败 · 切换后重试" : "1/4 排队中";
  if (q.stage !== "cutover") return "2/4 预发检查中";
  return (p && { preparing: "3/4 切换前复核", idle: p.sessions?.length ? `3/4 等空闲 · ${p.sessions.length} 个会话` : "3/4 等空闲", waiting: p.sessions?.length ? `3/4 等对话结束 · ${p.sessions.length} 个会话` : "3/4 等待任务核对", switching: "4/4 正在切换", ready: "4/4 部署成功", failed: "部署未完成" }[p.phase]) || "3/4 切换前复核";
};
const rtDeployWord = (started, p, q) => rtStagedWord(q, started, p) ?? (!started ? "排队部署" : !p ? "准备发布" : ({ preparing: "检查与准备中", idle: p.sessions?.length ? `等空闲 · ${p.sessions.length} 个会话` : "等空闲", waiting: p.sessions?.length ? `等待会话结束 · ${p.sessions.length} 个会话` : "等待任务核对", switching: "正在切换服务", ready: "部署成功", failed: "部署未完成" }[p.phase] || "准备发布"));
function rtDeployLabel(q) {
  const label = rtDeployWord(!!q.startedAt || q.state === "started", q.progress, q).replace(/^[1-4]\/4\s+/, "");
  return q.action === "rollback" ? label.replace("排队部署", "排队回滚").replace("部署成功", "回滚成功").replace("部署未完成", "回滚未完成") : label;
}
function rtFreshDeployAttempt(q, fresh) { return { ...q, ...fresh, startedAt: fresh.startedAt, progress: fresh.progress, state: fresh.state || (fresh.startedAt ? "started" : "pending"), ended: false }; }
function rtDeployClickable(node, q) {
  node.classList.add("rt-deploy-toggle");
  node.setAttribute("role", "button"); node.tabIndex = 0;
  node.setAttribute("data-deploy-id", q.id || "");
  node.setAttribute("aria-label", `${rtDeployLabel(q)}，查看部署进度`);
  node.setAttribute("aria-haspopup", "dialog");
  node.onclick = ev => { ev.preventDefault(); ev.stopPropagation(); rtOpenDeployProgress(q, node); };
  node.onkeydown = ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); node.click(); } };
  return node;
}
let rtDeployPanel = null;
function rtOpenDeployProgress(request, trigger) {
  if (rtDeployPanel) rtDeployPanel.close();
  const panel = h("div", { class: "rt-deploy-progress", popover: "auto", role: "dialog", "aria-label": "部署进度" });
  const state = { q: request, panel, trigger, sid: request.notifySession || request.sessionId || request.session?.id, timer: null, busy: false, close: null };
  const close = () => {
    if (rtDeployPanel !== state) return;
    clearInterval(state.timer); window.removeEventListener("hashchange", close);
    rtDeployPanel = null; if (panel.matches(":popover-open")) panel.hidePopover(); panel.remove();
    const restore = () => {
      const target = trigger?.isConnected && trigger.getClientRects().length ? trigger : state.sid === rtId() ? document.querySelector(".rt-more-btn") : null;
      target?.focus({ preventScroll: true });
    };
    restore(); requestAnimationFrame(restore);
  };
  state.close = close; rtDeployPanel = state;
  panel.addEventListener("toggle", ev => { if (ev.newState === "closed") close(); });
  window.addEventListener("hashchange", close);
  document.body.append(panel); rtPaintDeployProgress(); panel.showPopover(); void rtLoadDeployActions(state);
  panel.querySelector("button")?.focus({ preventScroll: true });
  state.timer = setInterval(async () => {
    if (rtDeployPanel !== state || state.busy) return;
    state.busy = true;
    try {
      const q = state.q;
      const result = await api(`/api/platform/deployments?limit=1&requestId=${encodeURIComponent(q.id || "")}&startedAt=${encodeURIComponent(q.startedAt || "")}`);
      if (rtDeployPanel !== state || state.q !== q) return;
      const active = (result.active || []).find(x => x.id === q.id);
      if (active) state.q = rtFreshDeployAttempt(q, active);
      else if (result.progress) state.q = { ...q, progress: result.progress };
      else if (Array.isArray(result.active)) state.q = { ...q, ended: true };
      state.error = ""; rtPaintDeployProgress(); await rtLoadDeployActions(state);
    } catch { if (rtDeployPanel === state) { state.error = "进度更新暂时失败，正在重试"; rtPaintDeployProgress(); } }
    finally { state.busy = false; }
  }, 3000);
}
/** 已结束部署的结果弹窗：通知消息里的结果标题点开后看提交、结论、诊断与日志（进度步骤只在部署进行中才有记录）。 */
function rtDeployResultClickable(node, notice, ctx) {
  node.classList.add("rt-deploy-toggle");
  node.setAttribute("role", "button"); node.tabIndex = 0;
  node.setAttribute("aria-label", `${notice.title}，查看部署详情`);
  node.setAttribute("aria-haspopup", "dialog");
  node.onclick = ev => { ev.preventDefault(); ev.stopPropagation(); rtOpenDeployResult(notice, ctx, node); };
  node.onkeydown = ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); node.click(); } };
  return node;
}
function rtOpenDeployResult(notice, { sid, time } = {}, trigger) {
  if (rtDeployPanel) rtDeployPanel.close();
  const panel = h("div", { class: "rt-deploy-progress rt-deploy-result", popover: "auto", role: "dialog", "aria-label": "部署详情" });
  const state = { q: {}, panel, trigger, sid, result: true, success: notice.title === "部署成功" || notice.title === "已在线上", close: null };
  const close = () => {
    if (rtDeployPanel !== state) return;
    window.removeEventListener("hashchange", close);
    rtDeployPanel = null; if (panel.matches(":popover-open")) panel.hidePopover(); panel.remove();
    const restore = () => {
      const target = trigger?.isConnected && trigger.getClientRects().length ? trigger : state.sid === rtId() ? document.querySelector(".rt-more-btn") : null;
      target?.focus({ preventScroll: true });
    };
    restore(); requestAnimationFrame(restore);
  };
  state.close = close; rtDeployPanel = state;
  panel.addEventListener("toggle", ev => { if (ev.newState === "closed") close(); });
  window.addEventListener("hashchange", close);
  const sha = /(?:^|[^a-f0-9])([a-f0-9]{7,40})(?![a-f0-9])/i.exec(notice.summary)?.[1];
  const when = time ? new Date(time).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  panel.append(
    h("div", { class: "rt-deploy-progress-head" }, h("strong", {}, "部署详情"), h("button", { type: "button", class: "btn small", onclick: close, "aria-label": "关闭部署详情" }, "关闭")),
    h("p", { class: "rt-deploy-progress-status", role: "status" }, h("span", { class: `rt-system-result ${notice.tone}`.trim() }, notice.title), when ? h("span", { class: "muted small" }, `  ${when}`) : null),
    sha ? h("p", { class: "mono small" }, sha.slice(0, 7)) : null,
    h("p", { class: "rt-text" }, notice.summary),
    notice.detail ? h("div", { class: "rt-deploy-result-detail" }, rtText(notice.detail, sid)) : null,
    notice.log ? h("div", { class: "rt-system-log" }, h("span", {}, "部署日志"), rtText(notice.log, sid)) : null);
  state.q.sha = sha;
  panel.append(rtDeployActions(state));
  document.body.append(panel); panel.showPopover(); void rtLoadDeployActions(state);
  panel.querySelector("button")?.focus({ preventScroll: true });
  // 流程步骤来自守候进程结束时的存档；旧部署没有存档，就只留上面的结论
  if (sha) api(`/api/platform/deployments/runs/${encodeURIComponent(sha.slice(0, 7))}`).then(({ run }) => {
    if (rtDeployPanel !== state || !run) return;
    const steps = rtDeployStepList({ sha: run.sha, startedAt: run.steps[0]?.at || run.since, progress: run, ...(run.staging ? { staging: true } : {}), ended: !["ready", "failed"].includes(run.phase) }, close);
    const holder = h("div", { class: "rt-deploy-result-steps" }, steps.list, steps.summary, run.testPlan ? rtDeployTestPlan(run.testPlan, false) : null);
    const anchor = panel.querySelector(".rt-deploy-result-detail, .rt-system-log");
    if (anchor) anchor.before(holder); else panel.querySelector(".rt-deploy-actions")?.before(holder);
  }).catch(() => {});
}
function rtDeployDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000)), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return `${hours ? `${hours}h` : ""}${hours || minutes ? `${minutes}m` : ""}${seconds % 60}s`;
}
function rtDeployStepTime(p, key, state) {
  const steps = p?.steps || [], index = steps.findIndex(s => s.phase === key);
  const since = index >= 0 ? steps[index].at : p?.phase === key ? p.since : null;
  const start = Date.parse(since || ""), end = Date.parse(steps[index + 1]?.at || "");
  if (key === "ready" && p?.phase === "ready") {
    const first = Date.parse(steps[0]?.at || ""), finished = Date.parse(since || p.since || "");
    return Number.isFinite(first) && Number.isFinite(finished) ? { text: rtDeployDuration(finished - first) } : { text: "—" };
  }
  if (index < 0 && (key === "idle" || key === "waiting") && state === "done") return { text: "耗时 0s" };
  if (!Number.isFinite(start)) return { text: "—" };
  if (index >= 0 && Number.isFinite(end)) return { text: `耗时 ${rtDeployDuration(end - start)}` };
  if (state === "current") return { text: `耗时 ${rtDeployDuration(Date.now() - start)}`, since };
  return { text: "—" };
}
/** 部署耗时：从开始准备（叠加预发则从预发检查开始）到上线完成，扣掉「等待会话结束」和预发完成后等切换的时间（与设置 → 统计同一口径）；没有流程记录时返回 undefined。 */
function rtDeployTotal(p, timeline = p?.staging) {
  const steps = (p?.steps || []).map(s => ({ phase: s.phase, at: Date.parse(s.at) })).filter(s => Number.isFinite(s.at));
  if (!steps.length) return undefined;
  const stagedStart = Date.parse(timeline?.startedAt || ""), stagedEnd = Date.parse(timeline?.stagedAt || "");
  const start = Number.isFinite(stagedStart) ? Math.min(stagedStart, steps[0].at) : steps[0].at;
  const finished = p?.phase === "ready" ? Date.parse(p.since) : Date.parse(p?.finishedAt || "");
  const end = Number.isFinite(finished) ? finished : steps[steps.length - 1].at;
  if (!(end >= start)) return undefined;
  let waiting = Number.isFinite(stagedEnd) ? Math.max(0, steps[0].at - stagedEnd) : 0;
  for (let i = 0; i < steps.length; i++) if (steps[i].phase === "waiting" || steps[i].phase === "idle") waiting += Math.max(0, (steps[i + 1]?.at ?? end) - steps[i].at);
  return Math.max(0, end - start - Math.min(waiting, end - start));
}
const RT_DEPLOY_TOTAL_TITLE = "部署耗时：从开始检查到上线完成，不含排队、等待会话和预发后等待切换的时间";
/** 部署成功通知上的总耗时：流程存档按提交只读一次（失败也记住，避免重绘反复请求）。 */
const rtDeployRunTotals = new Map();
function rtDeployNoticeTotal(commit) {
  const node = h("span", { class: "rt-system-elapsed", hidden: true, title: RT_DEPLOY_TOTAL_TITLE });
  const paint = (ms) => { if (!Number.isFinite(ms)) return; node.hidden = false; node.textContent = `总耗时${rtDeployDuration(ms)}`; };
  if (rtDeployRunTotals.has(commit)) { const ms = rtDeployRunTotals.get(commit); if (Number.isFinite(ms)) paint(ms); return node; }
  api(`/api/platform/deployments/runs/${encodeURIComponent(commit)}`).then(({ run } = {}) => {
    const ms = run ? rtDeployTotal(run) : null;
    rtDeployRunTotals.set(commit, ms);
    if (Number.isFinite(ms)) paint(ms);
  }).catch(() => {});
  return node;
}

function rtDeployStepItem({ state, label, status, time, blockers, detail, current }) {
  return h("li", { class: `rt-deploy-step ${state}`, "data-step-state": state, "aria-current": current ? "step" : null },
    h("span", { class: "rt-deploy-step-marker", "aria-hidden": "true" }, state === "done" ? "✓" : state === "failed" ? "×" : ""),
    h("div", { class: "rt-deploy-step-body" },
      h("div", { class: "rt-deploy-step-heading" }, h("span", { class: "rt-deploy-step-title" }, label), h("span", { class: "rt-deploy-step-meta" },
        h("span", { class: "rt-deploy-step-status small" }, status),
        time ? h("span", { class: "rt-deploy-step-duration small", ...(time.since ? { "data-rt-deploy-step-since": time.since } : {}) }, time.text) : null)),
      detail ? h("p", { class: "small rt-deploy-progress-detail" }, detail) : null,
      blockers));
}
const rtDeployBlockers = (p, onNavigate) => p?.sessions?.length ? h("ul", { class: "rt-deploy-blockers" }, ...p.sessions.map(s => h("li", {},
  h("a", { href: `#/rt/${encodeURIComponent(s.id)}`, onclick: onNavigate }, s.title || "未命名会话"),
  h("span", { class: "muted small" }, ({ running: "运行中", creating: "创建中", "waiting-input": "等待处理", stopping: "停止中" }[s.status] || s.status))))) : null;
/**
 * 叠加预发的四个节点，与会话列表标签的 1/4～4/4 同一套：排队 → 预发检查 → 待切换（切换前复核、等空闲、排空兜底）→ 切换上线。
 * 时间来自 q.timeline（进行中）或流程存档里的 staging（已结束）：每个节点的耗时 = 到下一个节点开始的间隔。
 */
function rtStagedStepList(q, onNavigate) {
  const p = q.progress, phase = p?.phase, steps = p?.steps || [], t = q.timeline || p?.staging || {};
  const at = key => steps.find(s => s.phase === key)?.at;
  const finishedAt = phase === "ready" ? p.since : phase === "failed" ? p.finishedAt || p.since : undefined;
  const marks = [t.queuedAt || q.requestedAt, t.startedAt || (q.stage === "staging" ? q.startedAt : undefined), t.stagedAt || (q.stage !== "staging" && p ? steps[0]?.at : undefined), at("switching"), finishedAt];
  const nodeOf = ph => ph === "switching" || ph === "ready" ? 3 : 2;
  const lastPhase = phase === "failed" ? steps.filter(x => x.phase !== "failed").at(-1)?.phase : phase;
  const current = q.stage === "staging" ? 1 : p ? (phase === "ready" ? 4 : nodeOf(lastPhase)) : q.wait?.kind === "staged" || t.stagedAt ? 2 : 0;
  const labels = ["排队", "预发检查", "待切换", "切换上线"];
  const detail = q.ended ? "本次请求已结束，请在设置的部署记录中查看结果" : [
    q.wait?.detail || "请求已登记，等待发布服务处理",
    p?.detail || "正在预发检查（类型检查与测试），当前线上服务继续运行",
    !p ? q.wait?.detail || "已预发，等待切换" : phase === "preparing" ? "正在切换前复核，当前线上服务继续运行" : p.detail,
    p?.detail || "正在切换服务并核对新版本是否就绪"
  ][Math.min(current, 3)];
  const items = labels.map((label, i) => {
    const state = phase === "failed" && i === current ? "failed" : i < current ? "done" : i === current && !q.ended ? "current" : "pending";
    const start = Date.parse(marks[i] || ""), end = Date.parse(marks[i + 1] || "");
    const time = state === "done" && Number.isFinite(start) && Number.isFinite(end) ? { text: `耗时 ${rtDeployDuration(end - start)}` }
      : state === "current" && Number.isFinite(start) ? { text: `耗时 ${rtDeployDuration(Date.now() - start)}`, since: marks[i] }
      : { text: "—" };
    const status = { failed: "未完成", current: "进行中", done: i === 3 ? "已上线" : "已完成", pending: "尚未开始" }[state];
    return rtDeployStepItem({ state, label, status, time, current: state === "current", detail: state === "current" ? detail : null, blockers: state === "current" && i === 2 ? rtDeployBlockers(p, onNavigate) : null });
  });
  const totalMs = phase === "ready" ? rtDeployTotal(p, t) : undefined;
  const summary = Number.isFinite(totalMs) ? h("div", { class: "rt-deploy-total", title: RT_DEPLOY_TOTAL_TITLE }, h("span", {}, "总耗时", h("small", { class: "muted" }, " 不含排队与等待")), h("strong", {}, rtDeployDuration(totalMs))) : null;
  return { current: Math.min(current, 3), detail, summary, list: h("ol", { class: "rt-deploy-steps", "aria-label": "部署流程" }, ...items) };
}
/** 部署流程五步（检查与准备 → 等空闲 → 排空等待会话结束（兜底，通常无需等待）→ 切换服务 → 部署成功）；进行中的进度弹窗和结束后的结果弹窗共用 */
function rtDeployStepList(q, onNavigate) {
  if (q.staging || q.timeline || q.progress?.staging) return rtStagedStepList(q, onNavigate);
  const p = q.progress, phase = p?.phase;
  const labels = [["preparing", "检查与准备"], ["idle", "等空闲"], ["waiting", "排空等待会话结束"], ["switching", "切换服务"], ["ready", "部署成功"]];
  const activePhase = phase === "failed" ? p?.steps?.filter(x => x.phase !== "failed").at(-1)?.phase : phase;
  const current = labels.findIndex(x => x[0] === activePhase);
  const detail = q.ended ? "本次请求已结束，请在设置的部署记录中查看结果" : p?.detail || q.wait?.detail || (q.startedAt || q.state === "started" ? "正在确认发布阶段" : "请求已登记，等待发布服务处理");
  const steps = labels.map(([key, label], i) => {
    const atStep = i === current;
    const active = atStep && !q.ended;
    const visited = (p?.steps || []).some(x => x.phase === key);
    const stepState = atStep && phase === "failed" ? "failed" : current > i || (atStep && phase === "ready") ? "done" : active ? "current" : "pending";
    const status = stepState === "failed" ? "未完成" : stepState === "current" ? "进行中" : stepState === "done" ? ((key === "idle" || key === "waiting") && !visited ? "无需等待" : "已完成") : !p && q.startedAt ? "待确认" : "尚未开始";
    const time = key === "ready" ? null : rtDeployStepTime(p, key, stepState);
    const blockers = active ? rtDeployBlockers(p, onNavigate) : null;
    return rtDeployStepItem({ state: stepState, label, status, time, blockers, detail: active ? detail : null, current: active && phase !== "ready" });
  });
  // 总耗时统一用「开始准备 → 上线完成，扣掉等待会话」的口径：状态行和结果弹窗显示的是同一个数
  const totalMs = phase === "ready" ? rtDeployTotal(p) : undefined;
  const summary = Number.isFinite(totalMs) ? h("div", { class: "rt-deploy-total", title: RT_DEPLOY_TOTAL_TITLE }, h("span", {}, "总耗时"), h("strong", {}, rtDeployDuration(totalMs))) : null;
  return { current, detail, summary, list: h("ol", { class: "rt-deploy-steps", "aria-label": "部署流程" }, ...steps) };
}
function rtDeployTestPlan(testPlan, open) {
  return h("details", { class: "rt-deploy-tests", open },
    h("summary", {}, `${testPlan.mode === "full" ? "完整回归" : "按需测试"} · ${{ running: "执行中", passed: "已通过", reused: "已复用", failed: "未通过" }[testPlan.state] || "待确认"} · ${testPlan.files.length} 个文件`),
    h("div", { class: "rt-deploy-tests-body" },
      h("p", { class: "muted small" }, "固定保留类型检查、登录授权、启动与部署恢复检查；以下是本次选测依据。"),
      h("ul", {}, ...testPlan.reasons.map(r => h("li", {}, h("code", {}, r.file), "：", r.rule))),
      h("p", { class: "small" }, "测试文件"),
      h("ul", {}, ...testPlan.files.map(f => h("li", {}, h("code", {}, f))))));
}
async function rtLoadDeployActions(state, refreshProgress = false) {
  if (!state.sid || !ui.rt.access?.control || state.actionBusy) return;
  try {
    const info = await api(`/api/runtime-sessions/${encodeURIComponent(state.sid)}/deploy`);
    if (rtDeployPanel !== state || state.actionBusy) return;
    state.info = info;
    const active = (info.requests || []).find(q => q.id === state.q.id);
    if (refreshProgress && !state.result && active) { state.q = rtFreshDeployAttempt(state.q, active); rtPaintDeployProgress(); }
    else rtRefreshDeployActions(state);
  } catch { if (rtDeployPanel === state) { state.actionError = "操作状态读取失败，请重新打开弹窗重试"; rtRefreshDeployActions(state); } }
}
function rtRefreshDeployActions(state) {
  const old = state.panel.querySelector(".rt-deploy-actions"), focus = old?.contains(document.activeElement) ? document.activeElement?.dataset.deployAction : null;
  if (old) old.replaceWith(rtDeployActions(state));
  if (focus) state.panel.querySelector(`[data-deploy-action="${focus}"]`)?.focus({ preventScroll: true });
}
function rtDeployActions(state) {
  const q = state.q, phase = q.progress?.phase;
  const canControl = state.sid && ui.rt.access?.control && state.info?.eligible;
  const active = canControl && !state.cancelled && !state.result && !q.ended && !["ready", "failed"].includes(phase);
  const supported = state.info?.actionsSupported === true;
  const cancellable = supported && (!q.startedAt || ["preparing", "idle", "waiting"].includes(phase));
  const target = state.info?.rollback;
  const success = state.result ? state.success : phase === "ready";
  const rollback = canControl && supported && success && !state.cancelled && target && target.live.startsWith(q.progress?.sha || q.sha || "?") && !(state.info.requests || []).length;
  return h("div", { class: "rt-deploy-actions" },
    active ? h("button", { type: "button", class: "btn danger", "data-deploy-action": "cancel", disabled: !!state.actionBusy || !cancellable, onclick: () => void rtDeployPanelAction(state, "cancel") }, state.actionBusy === "cancel" ? "取消中…" : "取消部署") : null,
    active && !cancellable ? h("p", { class: "small muted" }, !supported ? "部署控制器需升级后才能使用取消与回滚。" : phase === "switching" ? "已进入切换服务，不能取消；完成后可查看回滚操作。" : "正在核对部署阶段，暂不能取消。") : null,
    active && cancellable ? h("p", { class: "small muted" }, "取消本次请求；其他部署请求仍可能包含相同改动。") : null,
    canControl && success && !supported ? h("p", { class: "small muted" }, "部署控制器需升级后才能使用回滚。") : null,
    rollback ? h("button", { type: "button", class: "btn danger", "data-deploy-action": "rollback", disabled: !!state.actionBusy, onclick: () => void rtDeployPanelAction(state, "rollback") }, state.actionBusy === "rollback" ? "登记中…" : "回滚到上一版") : null,
    rollback ? h("p", { class: "small muted" }, `目标 ${target.sha.slice(0, 7)} · ${target.subject || "上一版"}，等待会话结束后执行。`) : null,
    state.actionError ? h("p", { class: "small", role: "alert" }, state.actionError) : null);
}
async function rtDeployPanelAction(state, action) {
  if (rtDeployPanel !== state || state.actionBusy) return;
  const target = state.info?.rollback, q = state.q;
  if (action === "rollback" && !target) return;
  const question = action === "cancel" ? `取消部署 ${(q.sha || "").slice(0, 7)}？` : `将线上 ${target.live.slice(0, 7)} 回滚到 ${target.sha.slice(0, 7)}（${target.subject}）？等待活动会话结束后执行。`;
  if (!confirm(question)) return;
  state.actionBusy = action; state.actionError = ""; rtRefreshDeployActions(state);
  try {
    const info = await api(action === "cancel" ? `/api/runtime-sessions/${encodeURIComponent(state.sid)}/deploy/${encodeURIComponent(q.id)}` : `/api/runtime-sessions/${encodeURIComponent(state.sid)}/deploy-rollback`,
      { method: action === "cancel" ? "DELETE" : "POST", ...(action === "rollback" ? { body: JSON.stringify({ expectedSha: target.sha, expectedLive: target.live }) } : {}) });
    if (rtDeployPanel !== state) return;
    state.info = info;
    if (ui.rt.deploy?.id === state.sid) ui.rt.deploy.info = info;
    if (action === "cancel") { state.cancelled = true; state.q = { ...q, ended: true }; rtPaintDeployProgress(); announce("已取消部署"); }
    else { const trigger = state.trigger; state.close(); rtOpenDeployProgress(info.request, trigger); announce("已登记回滚，等待会话结束后执行"); }
    if (rtId() === state.sid) rtRenderSoft();
  } catch (e) {
    if (rtDeployPanel === state) { state.actionError = e.message; state.actionBusy = false; await rtLoadDeployActions(state, true); }
  } finally { state.actionBusy = false; if (rtDeployPanel === state) rtRefreshDeployActions(state); }
}

function rtPaintDeployProgress() {
  const state = rtDeployPanel; if (!state) return;
  const q = state.q, p = q.progress;
  const { current, detail, list, summary } = rtDeployStepList(q, state.close);
  const elapsed = p?.since || q.startedAt || q.requestedAt;
  const testPlan = p?.testPlan;
  const focusedAction = state.panel.querySelector(".rt-deploy-actions")?.contains(document.activeElement) ? document.activeElement?.dataset.deployAction : null;
  const previousTests = state.panel.querySelector(".rt-deploy-tests");
  const testsOpen = !!previousTests?.open;
  const testsFocused = !!previousTests?.contains(document.activeElement);
  const content = [
    h("div", { class: "rt-deploy-progress-head" }, h("strong", {}, "部署进度"), h("button", { type: "button", class: "btn small", onclick: state.close, "aria-label": "关闭部署进度" }, "关闭")),
    h("p", { class: "mono small" }, (p?.sha || q.sha || "").slice(0, 7), q.subject ? ` · ${q.subject}` : ""),
    h("p", { class: "rt-deploy-progress-status", role: "status" }, state.cancelled ? "部署已取消" : q.ended ? "发布请求已结束" : current >= 0 ? rtDeployLabel(q) : rtElapsedLabel(rtDeployLabel(q), elapsed)),
    current < 0 || q.ended ? h("p", { class: "small rt-deploy-progress-detail" }, detail) : null,
    list,
    summary,
    testPlan ? rtDeployTestPlan(testPlan, testsOpen) : null,
    state.error ? h("p", { class: "small muted" }, state.error) : null,
    rtDeployActions(state)
  ];
  // Preserve the close button and its focus across progress refreshes.
  if (state.panel.firstChild) state.panel.replaceChildren(state.panel.firstChild, ...content.slice(1).filter(Boolean));
  else state.panel.replaceChildren(...content.filter(Boolean));
  if (testsFocused) state.panel.querySelector(".rt-deploy-tests summary")?.focus({ preventScroll: true });
  if (focusedAction) {
    const action = state.panel.querySelector(`[data-deploy-action="${focusedAction}"]:not(:disabled)`);
    (action || state.panel.querySelector(".rt-deploy-progress-head button"))?.focus({ preventScroll: true });
  }
}
function rtUpdateDeployProgress(requests) {
  const state = rtDeployPanel;
  if (!state) return;
  const q = (requests || []).find(x => x.id === state.q.id);
  if (q) { state.q = rtFreshDeployAttempt(state.q, q); rtPaintDeployProgress(); }
}
// 与阶段文字使用同一套映射；图形表示阶段序号，不估算耗时百分比。
function rtDeployPie(node, d) {
  const staged = rtStagedWord(d, !!d.startedAt || d.state === "started", d.progress);
  const step = staged?.match(/^([1-4])\/4/)?.[1] || ({ preparing: "1", idle: "2", waiting: "2", switching: "3", ready: "4" }[d.progress?.phase]) || "1";
  node.setAttribute("data-rt-deploy-pie", step);
  node.toggleAttribute("data-rt-deploy-sweep", !d.ended && !["ready", "failed", "cancelled"].includes(d.progress?.phase) && !["failed", "cancelled"].includes(d.state));
  return node;
}
function rtDeployBadge(d) {
  // 冲突自动解决：会话正在合并 main / 自动处理不了、需要人
  if (d.state === "resolving" || d.state === "needs-human") {
    const human = d.state === "needs-human";
    const node = badge(human ? "部署待处理" : "解决冲突中", "warn");
    node.title = human ? `自动部署需要你处理：${d.subject || ""}` : `部署时和 main 冲突，会话正在自动合并解决（${d.subject || ""}），解决后自动重新提交部署`;
    return node;
  }
  // 部署已成功：这一步到此为止，不再计时（从成功时刻起算的秒数没有意义）；下一步由「推荐操作」（归档会话）接手
  if (d.progress?.phase === "ready") {
    const done = badge(rtDeployLabel(d).split(" · ")[0], "ok");
    done.setAttribute("data-rt-deploy-done", "");
    done.title = `部署成功 ${typeof d.sha === "string" ? d.sha.slice(0, 7) : ""}${d.subject ? `（${d.subject}）` : ""}`.trim();
    return rtDeployPie(done, d);
  }
  const started = d.state === "started";
  const since = d.progress?.since || (started && d.startedAt ? d.startedAt : d.requestedAt);
  // 保留阶段文案和计时，饼图随真实阶段更新。
  const label = rtDeployLabel(d).split(" · ")[0];
  const node = badge(rtElapsedLabel(label, since), started ? "warn deploying" : "warn");
  if (Number.isFinite(Date.parse(since))) node.setAttribute("data-rt-deploy-start", `${label}|${since}`);
  const sha = typeof d.sha === "string" ? d.sha.slice(0, 7) : "";
  rtDeployPie(node, d);
  node.title = `${rtDeployLabel(d)} ${sha}${d.subject ? `（${d.subject}）` : ""}${d.progress?.detail ? `：${d.progress.detail}` : d.wait ? `：${d.wait.detail}` : ""}`.trim();
  return node;
}
const RT_VERIFY_PROFILE_ZH = { "deploy-gate": "部署门禁", "platform-gate": "门禁", "platform-quick": "类型检查" };
const RT_VERIFY_STATE_META = {
  created: { label: "验证排队", tone: "warn", active: true },
  queued: { label: "验证排队", tone: "warn", active: true },
  running: { label: "验证中", tone: "warn", active: true },
  recovering: { label: "验证中", tone: "warn", active: true },
  succeeded: { label: "验证通过", tone: "ok", active: false },
  failed: { label: "验证失败", tone: "bad", active: false },
  timed_out: { label: "验证超时", tone: "bad", active: false },
  interrupted: { label: "验证中断", tone: "warn", active: false },
  cancelled: { label: "验证已取消", tone: "", active: false },
};
function rtVerifyMeta(v) {
  if (!v) return null;
  if (v.active && v.cancelRequested) return { label: "取消验证中", tone: "warn", active: true };
  return RT_VERIFY_STATE_META[v.state] || { label: "验证中", tone: "warn", active: !!v.active };
}
function rtVerifyBadge(v, deploy = null) {
  const m = rtVerifyMeta(v);
  if (!m) return null;
  const since = v.startedAt || v.createdAt;
  const label = m.label;
  const text = m.active && Number.isFinite(Date.parse(since)) ? rtElapsedLabel(label, since) : label;
  const tone = deploy && m.active ? "warn deploying" : m.tone;
  const node = badge(text, tone);
  node.setAttribute("data-rt-verify-badge", v.state);
  if (m.active && Number.isFinite(Date.parse(since))) node.setAttribute("data-rt-verify-start", `${label}|${since}`);
  if (deploy) rtDeployPie(node, deploy);
  const profileZh = RT_VERIFY_PROFILE_ZH[v.profile] || v.profile;
  const summary = v.report?.summary || v.stateReason || (v.currentStep ? `正在执行 ${v.currentStep}` : "");
  const deploySha = deploy && typeof deploy.sha === "string" ? deploy.sha.slice(0, 7) : "";
  const deployInfo = deploySha ? ` ${deploySha}${deploy.subject ? `（${deploy.subject}）` : ""}` : "";
  node.title = `${label}（${profileZh}）${deployInfo}${summary ? `：${summary}` : ""}`;
  return node;
}
async function rtLoadVerify(id) {
  if (id === RT_SERVICE_ID) return;
  if (!id || ui.rt.access?.history === false) return;
  const gen = ui.rt.gen;
  try {
    const r = await api(`/api/runtime-sessions/${encodeURIComponent(id)}/verify`);
    if (!rtReadCurrent(id, gen)) return;
    ui.rt.verify = { id, data: r?.verify || null };
    if (typeof rtPatchVerifyStatus === "function") rtPatchVerifyStatus();
  } catch { /* 读取失败不打断对话 */ }
}
// 只更新可见列表的计时文字，避免每秒重绘列表导致焦点和滚动跳动。
function rtTickVisibleTimes() {
  if (document.visibilityState === "hidden") return;
  for (const node of document.querySelectorAll('[data-rt-memory-at]')) node.textContent = rtAgo(node.getAttribute('data-rt-memory-at'));
  if (ui.view === 'rt' || ui.view === 'rt-compare') document.querySelectorAll('[data-countdown]').forEach(el => {el.textContent = minutesLeft(el.dataset.countdown);});
  for (const node of document.querySelectorAll("[data-rt-turn-start]")) node.textContent = rtElapsedLabel(node.getAttribute("data-rt-elapsed-prefix") || "运行中", node.getAttribute("data-rt-turn-start"));
  // 额度用尽后自动续聊的倒计时（1d5h / 5h23m / 23m）：每秒只改这一小段文字，不重绘列表
  for (const node of document.querySelectorAll("[data-rt-quota-resume-left]")) {
    const at = node.getAttribute("data-rt-quota-resume-left"), text = typeof rtQuotaResumeLeft === "function" ? rtQuotaResumeLeft(at) : "";
    if (text && node.textContent !== text) node.textContent = text;
  }
  for (const node of document.querySelectorAll("[data-rt-background-start]")) node.textContent = `已运行 ${rtBackgroundDuration(node.dataset.rtBackgroundStart)}`;
  for (const node of document.querySelectorAll("[data-rt-tool-start]")) {
    const at = node.getAttribute("data-rt-tool-start");
    node.textContent = rtElapsedLabel("运行中", at);
    // 超过 5 分钟标黄：服务端看门狗在 5 分钟时也会插一条提醒
    node.classList.toggle("slow", Date.now() - Date.parse(at) > 300000);
  }
  for (const node of document.querySelectorAll("[data-rt-deploy-step-since]")) node.textContent = `耗时 ${rtDeployDuration(Date.now() - Date.parse(node.getAttribute("data-rt-deploy-step-since")))}`;
  // 时间线末尾的部署状态行：标题后只放本阶段已用时，和列表标签同一套时长格式
  for (const node of document.querySelectorAll("[data-rt-deploy-row-start]")) node.textContent = rtDeployDuration(Date.now() - Date.parse(node.getAttribute("data-rt-deploy-row-start")));
  for (const node of document.querySelectorAll("[data-rt-deploy-start]")) {
    const [state, at] = (node.getAttribute("data-rt-deploy-start") || "").split("|");
    node.textContent = rtElapsedLabel(state === "started" ? "准备发布" : state === "pending" ? "排队部署" : state, at);
  }
  for (const node of document.querySelectorAll("[data-rt-verify-start]")) {
    const [label, at] = (node.getAttribute("data-rt-verify-start") || "").split("|");
    node.textContent = rtElapsedLabel(label || "验证中", at);
  }
}

/** 会话 / 群聊列表里能拿到标题就先顶上，拿不到再退回占位文案。 */
function rtDirEntry(id) {
  const entries = ui.rt.dir?.entries;
  return Array.isArray(entries) ? entries.find((e) => e && e.id === id) || null : null;
}
/**
 * 详情页等待内容时的头部：桌面与手机都按 rtHead / roomHead 的同构结构占位，数据到达后整体替换。
 * cached=true 用于「正文已从本机显示」的情形：标题是真标题、没有 aria-busy、徽标是「本机」而不是「读取中」，
 * 因为内容已经在屏幕上了，只是还在向服务端核对。
 */
function rtHeadLoading(kind = "session", override = null, options = {}) {
  const room = kind === "room";
  const cached = options.cached === true;
  const dirEntry = rtDirEntry(room ? ui.room?.id : rtId());
  const entry = override ? { ...dirEntry, ...override } : dirEntry;
  const title = entry?.title || (cached ? "会话" : room ? "正在读取群聊…" : "正在读取会话…");
  const back = room && typeof roomOpenList === "function" ? () => roomOpenList() : () => rtOpenList();
  const tags = h("div", { class: "rt-title-tags", "aria-hidden": "true" }, badge(cached ? "本机" : "读取中", ""));
  const subtitle = cached
    ? (room ? "本机保存的群聊 · 正在核对最新状态" : "本机保存的内容 · 正在核对最新状态")
    : (room ? "正在读取群聊信息…" : "正在读取会话信息…");
  if (!rtPhone.matches) {
    return h("header", { class: `rt-head${room ? " room-head" : ""}`, ...(cached ? {} : { "aria-busy": "true" }) },
      h("button", { type: "button", class: "btn small rt-list-toggle", ...(cached ? { onclick: back } : { disabled: true }) }, "会话列表"),
      room ? null : h("button", { type: "button", class: "btn small rt-info-toggle", disabled: true }, "会话详情"),
      h("div", { class: "rt-title-row" },
        !room && typeof rtAvatar === "function" ? rtAvatar(entry?.runtimeKind || "pi", entry?.model || "", "lg") : null,
        h("div", { class: "rt-title-main" },
          h("h1", { class: "rt-title" }, h("span", { class: "rt-title-text" }, title)),
          h("p", { class: "rt-sub muted small" }, subtitle)),
        tags));
  }
  return h("header", { class: `rt-head rt-head-phone${room ? " room-head" : ""}`, ...(cached ? {} : { "aria-busy": "true" }) },
    h("div", { class: "rt-head-nav" },
      h("button", { type: "button", class: "btn small rt-list-toggle rt-back", "aria-label": "会话列表", onclick: back }, "‹"),
      !room && typeof rtAvatar === "function" ? h("span", { class: "rt-head-logo" }, rtAvatar(entry?.runtimeKind || "pi", entry?.model || "", "lg")) : null,
      h("div", { class: "rt-title-line" },
        h("h1", { class: "rt-title" }, h("span", { class: "rt-title-text" }, title))),
      h("div", { class: "rt-more" },
        h("button", { type: "button", class: "btn small rt-more-btn", "aria-label": "更多", disabled: true, "aria-disabled": "true" }, "⋮")),
      tags));
}
// Keep the first conversation frame available before deferred detail code arrives.
// Loading can accept a draft, but cannot send until live authority is confirmed.
function renderRtLoadingWorkbench() {
  const listing = ui.rt.listOpen;
  const list = rtModuleReady('rt-list') ? rtList() : h('aside', { class: 'rt-list', 'aria-busy': 'true', 'aria-label': '会话列表' },
    h('div', { class: 'rt-list-head' }, h('h2', {}, '会话')),
    h('a', { class: 'btn', href: '#/rt' }, '会话列表'));
  return h('div', { class: 'rt-page' }, h('div', {
    class: `rt-layout${listing ? ' list-open' : ''}${ui.rt.sideCollapsed ? ' side-collapsed' : ''}`
  }, list, rtDetailLoading(), h('aside', { class: 'rt-side', 'aria-label': '会话信息', 'aria-busy': 'true', hidden: ui.rt.sideCollapsed })));
}
function rtDetailLoading() {
  return h("section", { class: "rt-center" },
    // 先摆好会话框与标题（标题取自会话目录），内容区显示“加载中…”，加载完由 rtHead 接手
    rtHeadLoading("session"),
    // 先摆好输入区，再加载内容：进入会话时就看得见输入框，不在加载完成后才出现
    h("div", { class: "rt-center-wait", "aria-busy": String(!ui.rt.viewError) },
      ui.rt.viewError ? [
        h("p", { class: "field-error", role: "alert" }, ui.rt.viewError),
        h("button", { type: "button", class: "btn", onclick: () => refresh({ main: true, force: true, global: false }) }, "重新读取会话")
      ] : [
        // 消息区先占位，loading 固定落在消息列表下方，和本机缓存画面同一位置
        h("div", { class: "rt-transcript rt-loading-list", "aria-hidden": "true" }),
        h("p", { class: "rt-loading", role: "status" }, h("span", { class: "rt-spinner", "aria-hidden": "true" }), "加载中…")
      ]),
    rtComposerLoading());
}

/** 内容和状态尚未就绪时可先写草稿，发送保持禁用；核对中的提示就是这里的底纹字，不再另占一行。 */
function rtComposerLoading() {
  const id = rtId();
  return h("div", { class: "rt-composer", "aria-busy": "true" },
    h("div", { class: "rt-compose-row rt-compose-stack" },
      rtSessionMentionInput({ class: "rt-input", rows: "2", "data-key": `rt-draft-${id}`, allowReferences: false,
        value: ui.rt.drafts[id] ?? rtImageDraft(id).text ?? '',
        placeholder: "状态核对中，可以先编辑草稿。", "aria-label": "发送给该 runtime 的消息",
        oninput: ev => { if (rtId() !== id) return; ui.rt.drafts[id] = ev.target.value; rtSaveImageDraft(id, ev.target.value); },
        onkeydown: ev => { if (rtIsSendKey(ev)) ev.preventDefault(); }
      }, id),
      h("div", { class: "rt-compose-actions" },
        // 账户胶囊先按上次数值摆上（与真身同一位置）：数值读回来后就地刷新，输入区不会空一块再长出来
        rtComposeAccount(rtSessionAccount(id)),
        h("span", { class: "rt-compose-spacer", "aria-hidden": "true" }),
        h("button", { type: "button", class: "btn primary", disabled: true, title: "状态核对完成后可发送" }, "发送"))));
}

/* ------------------------------ 空闲时部署 ------------------------------ */

/**
 * 会话页「空闲时部署」：只对工作目录在 pi-agent 仓库里的会话显示。由服务端登记请求，守候进程等所有会话都停下来
 * 再做普通部署，结果作为一条消息发回这个会话（Claude、Codex、Pi 都能用，不需要会话越出沙箱）。
 */
/** 提交部署后用户已切到别的会话：只刷新这个会话的部署缓存和列表标记，不碰当前页面的部署状态 */
function rtRefreshDeployCache(id) {
  void api(`/api/runtime-sessions/${id}/deploy`).then((d) => {
    ui.rt.deployCache[id] = d;
    rtSyncDirDeploy(d, id);
    rtUpdateDeployProgress(d.requests);
  }).catch(() => {});
}

const rtDeployFlights = new Map();
async function rtLoadDeployOnce(id) {
  const gen = ui.rt.gen;
  if (!ui.rt.access || !ui.rt.access.control) return;
  try {
    ui.rt.deployLoadedGen = gen;
    const d = await api(`/api/runtime-sessions/${id}/deploy`);
    ui.rt.deployCache[id] = d;
    rtSyncDirDeploy(d, id);
    rtUpdateDeployProgress(d.requests);
    if (!rtReadCurrent(id, gen)) return;
    ui.rt.deploy = { id, info: d };
  } catch { ui.rt.deployCache[id] = null; if (rtReadCurrent(id, gen)) { const had = !!ui.rt.deploy; ui.rt.deploy = null; if (had) rtRenderSoft(); } return; }
  rtRenderSoft();
  // 排队中：每 30 秒更新一次，开始部署 / 部署完就能看到
  clearTimeout(ui.rt.deployTimer);
  const ar = ui.rt.deploy.info && ui.rt.deploy.info.autoResolve;
  if (rtDeployMine(ui.rt.deploy.info, id) || (ar && ar.phase === "resolving")) ui.rt.deployTimer = setTimeout(() => { if (id === rtId()) void rtLoadDeploy(id); }, ar && ar.phase === "resolving" ? 10_000 : rtDeployMine(ui.rt.deploy.info, id)?.startedAt ? 5_000 : 30_000);
}
/** 部署状态也可能被回前台、目录刷新和头部重读同时触发：同一会话共享在飞读取。 */
function rtLoadDeploy(id) {
  if (id === RT_SERVICE_ID) return Promise.resolve();
  const running = rtDeployFlights.get(id);
  if (running) return running;
  const flight = rtLoadDeployOnce(id).finally(() => { if (rtDeployFlights.get(id) === flight) rtDeployFlights.delete(id); });
  rtDeployFlights.set(id, flight); return flight;
}

/** 列表重新读取之后：正在看的会话在列表里的部署标记和头部不一样，就重读头部（以服务端最新状态为准） */
function rtAfterDirReload() {
  rtRenderListOnly();
  if (rtServiceOpen()) { void rtLoadServiceNotices(); return; }
  const id = ui.view === "rt" ? rtId() : "";
  const st = id && ui.rt.deploy && ui.rt.deploy.id === id ? ui.rt.deploy : null;
  if (!st || !st.info || st.busy) return;
  const entry = (ui.rt.dir?.entries || []).find((e) => e.id === id);
  if (entry && rtMarkerState(entry.deploy) !== rtMarkerState(rtDeployMarker(st.info, id))) void rtLoadDeploy(id);
}

/** 头部读到新的部署信息：请求列表含全部会话的排队 / 部署中请求，按它改写列表里所有会话的这类标记 */
function rtSyncDirDeploy(info, id) {
  const entries = ui.rt.dir?.entries;
  if (!entries || !info) return;
  let changed = false;
  for (const e of entries) {
    const before = e.deploy;
    // 别的会话的冲突自动解决状态头部不知道：保留列表原样
    const next = e.id === id ? rtDeployMarker(info, id) : (rtDeployMarker({ requests: info.requests }, e.id) || (before && ["resolving", "needs-human"].includes(before.state) ? before : null));
    if (JSON.stringify(before || null) === JSON.stringify(next)) continue;
    if (next) e.deploy = next; else delete e.deploy;
    changed = true;
  }
  if (changed) rtRenderListOnly();
}

/** 跳去待办记录里看这条：切到它自己的大类并让列表定位高亮，避免被当前筛选挡住。 */
function rtViewLinkedNote(noteId) {
  if (!noteId) return;
  // 会话里已经读到这条时直接用它的大类；还没读到就先按当前大类，待办页取完列表会补切（见 noteSwitchKindOfFocused）。
  const linked = ui.rt.linkedNote?.id === noteId ? ui.rt.linkedNote : null;
  if (linked && typeof noteDisplayKind === "function") ui.notesKindFilter = noteDisplayKind(linked);
  ui.notesTab = "records";
  ui.notesFilter = "all";
  ui.notesLinkFilter = "all";
  ui.notesCategory = "";
  ui.notesFocusNote = noteId;
  rtToggleNote(false);
  rtToggleNotice(false);
  rtToggleRecommendation(false);
  if (location.hash === "#/notes") { if (typeof route === "function") route(); }
  else location.hash = "#/notes";
}

/** 读取会话关联的待办：只在会话详情需要时拉一次，失败也不影响对话 */

/** 读取会话关联的待办：只在会话详情需要时拉一次，失败也不影响对话 */
async function rtLoadLinkedNote(id, gen) {
  if (id === RT_SERVICE_ID) return;
  if (!rtSessionVisible() || (!ui.rt.noteOpen && !ui.rt.recommendationOpen)) return;
  const recommendation = ui.rt.view?.session?.recommendationRef;
  if (recommendation) {
    try {
      const notes = await api("/api/notes");
      if (gen !== ui.rt.gen || ui.view !== "rt" || rtId() !== id) return;
      ui.rt.linkedRecommendationNotes = notes; ui.rt.linkedNoteError = "";
    } catch (e) {
      if (gen !== ui.rt.gen || ui.view !== "rt" || rtId() !== id) return;
      ui.rt.linkedRecommendationNotes = null; ui.rt.linkedNoteError = e.message;
    }
    ui.rt.linkedNoteFor = id; rtRenderSoft(); return;
  }
  const noteId = ui.rt.view?.session?.noteRef?.noteId;
  if (!noteId) { ui.rt.linkedNote = null; ui.rt.linkedNoteFor = id; return; }
  if (ui.rt.linkedNoteFor === id && ui.rt.linkedNote?.id === noteId) return;
  try {
    const notes = typeof readResource === "function" ? await readResource("/api/notes") : await api("/api/notes");
    if (gen !== ui.rt.gen || ui.view !== "rt" || rtId() !== id) return;
    ui.rt.linkedNote = (Array.isArray(notes) ? notes : []).find((n) => n.id === noteId) || null;
    ui.rt.linkedNoteError = "";
  } catch (e) {
    if (gen !== ui.rt.gen || ui.view !== "rt" || rtId() !== id) return;
    ui.rt.linkedNote = null; ui.rt.linkedNoteError = e.message;
  }
  ui.rt.linkedNoteFor = id;
  if (ui.view === "rt" && rtId() === id) rtRenderSoft();
}

/** CSP 不允许 style 属性：用 CSSOM 设宽度 */
function rtFill(pct) {
  const el = h("span", { class: "rt-meter-fill" });
  el.style.width = `${Math.max(0, Math.min(100, pct ?? 0))}%`;
  return el;
}

/** 窗口已用比例的色阶：≥95% 告急、≥80% 偏高 */
function rtQuotaTone(pct) { return pct == null ? "" : pct >= 95 ? " bad" : pct >= 80 ? " warn" : ""; }
/**
 * 额度百分比的展示口径：一律向下取整，不四舍五入。
 * 判定「无额度」用的是已用 100%（rtRuntimeQuotaExhausted）：如果 99.6% 显示成 100%，
 * 就会出现「卡片写着 100%，却还排在 Pi 前面」——用户看到 100% 只会认为已经没额度了。
 * 所以显示与判定同源：只有真到 100% 才写 100%，其余最多 99%；剩余比例 = 100 - 已用，两者永远凑成 100。
 * 加 1e-6 只是消掉 (1 - remaining) * 100 这类浮点噪声（99.9999999 该算 100）。
 */
function rtQuotaUsedPct(pct) {
  if (pct == null) return null;
  const n = Number(pct);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.floor(n + 1e-6))) : null;
}
function rtQuotaLeftPct(pct) { const used = rtQuotaUsedPct(pct); return used == null ? null : 100 - used; }
function rtQuotaPctText(pct, unknown = "?") { const used = rtQuotaUsedPct(pct); return used == null ? unknown : `${used}%`; }
function rtQuotaShortLabel(label) { return label === "5 小时窗口" ? "5h" : label === "周窗口" ? "周" : String(label || "").replace(/窗口$/, "").trim() || "额度"; }
function rtQuotaWindowName(w) { return [w.group, w.label].filter(Boolean).join(" · "); }
function rtQuotaGroups(windows) {
  const groups = new Map();
  for (const w of windows) { const name = w.group || ""; if (!groups.has(name)) groups.set(name, { name, windows: [] }); groups.get(name).windows.push(w); }
  return [...groups.values()];
}
/** 新建卡片用当前选择；未选中的运行时用它保存的选择，再回退到原生默认模型。 */
function rtQuotaSelectedModel(kind) {
  const profile = (ui.rt.profiles || []).find(p => p.runtimeKind === kind);
  const selected = ui.view === "rt-new" && ui.rt.form?.runtimeKind === kind ? rtForm().model : rtDraftValue(kind, "model");
  return selected || rtModelOption(profile, "")?.id || (kind === "antigravity" ? "gemini-4-neon" : "");
}
/** Antigravity 额度按模型分池：在紧凑额度行前放当前选中/默认模型的短词简写（参考 Pi 的 DS / OR） */
function rtQuotaModelShort(kind, model) {
  if (kind !== "antigravity") return "";
  const raw = String(model || rtQuotaSelectedModel(kind)).trim();
  const profile = (ui.rt?.profiles || []).find(p => p.runtimeKind === kind);
  const mo = typeof rtModelOption === "function" ? rtModelOption(profile, raw) : null;
  const tag = `${raw.split("/").pop()} ${mo?.label || ""}`.toLowerCase();
  if (/argon|g1-pro/.test(tag)) return "Argon";
  if (/neon/.test(tag)) return "Neon";
  if (/carbon/.test(tag)) return "Carbon";
  if (/hydrogen/.test(tag)) return "Hydro";
  if (/flash/.test(tag)) return "Flash";
  if (/opus/.test(tag)) return "Opus";
  if (/sonnet/.test(tag)) return "Sonnet";
  if (/haiku/.test(tag)) return "Haiku";
  if (/fable/.test(tag)) return "Fable";
  if (/gpt/.test(tag)) return "GPT";
  if (/gemini/.test(tag)) return "Gemini";
  return "";
}
/**
 * 运行时卡片只有一列窄格子：模型用至多两个字母的代号（PI 卡的 DS / OR 同一套语言），完整名称留在悬停说明里。
 * Neon / Carbon / Argon / Hydrogen 正好是元素符号，两个字母既好认也不撑宽卡片。
 */
const RT_QUOTA_MODEL_CODE = { Argon: "AR", Neon: "NE", Carbon: "CA", Hydro: "HY", Flash: "FL", Opus: "OP", Sonnet: "SO", Haiku: "HA", Fable: "FA", GPT: "GP", Gemini: "GM" };
function rtQuotaModelCode(kind, model) { return RT_QUOTA_MODEL_CODE[rtQuotaModelShort(kind, model)] || ""; }
/** 紧凑位置只取一个模型组、至多两个窗口；未识别模型不冒用其他模型的额度。 */
function rtQuotaForModel(rl, kind, model) {
  if (kind !== "antigravity" || !rl?.windows?.some(w => w.group)) return rl;
  const raw = String(model || rtQuotaSelectedModel(kind)).trim();
  const id = raw.toLowerCase().split("/").pop();
  const profile = (ui.rt?.profiles || []).find(p => p.runtimeKind === kind);
  const mo = typeof rtModelOption === "function" ? rtModelOption(profile, raw) : null;
  const tag = `${id} ${(mo?.label || "").toLowerCase()}`;
  const groups = rtQuotaGroups(rl.windows);
  const base = groups.find(g => /gemini/i.test(g.name) && !/argon/i.test(g.name));
  const group = /^(claude|gpt)(?:-|$)/.test(id) ? groups.find(g => /claude|gpt/i.test(g.name))
    : /^(gemini|orchestrator)(?:-|$)/.test(id) ? (/argon|g1-pro/.test(tag) ? groups.find(g => /argon/i.test(g.name)) || base : base) : null;
  const rank = w => w.windowMinutes === 300 || w.label === "5 小时窗口" ? 0 : w.windowMinutes === 10080 || w.label === "周窗口" ? 1 : 2;
  return { ...rl, windows: group ? [...group.windows].sort((a, b) => rank(a) - rank(b)).slice(0, 2) : [] };
}
function rtQuotaResetTime(iso) {
  if (!Number.isFinite(Date.parse(iso))) return "";
  return `${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso))}（北京时间）`;
}

/**
 * 额度重置倒计时（只显示剩余时间，不显示绝对时间）。
 * short：选项卡里用，最多两个单位（2h15m、6d23h、45m）；long：会话详情里用（2 小时 15 分后重置）。
 * 快照里的重置时间已过：窗口应已重置，已用比例要等下一次快照才更新。
 */
function rtCountdown(iso, style) {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (style === "beijing") return `${rtQuotaResetTime(iso)}重置${ms <= 0 ? "，等待更新" : ""}`;
  const long = style === "long";
  if (ms <= 0) return long ? "已到重置时间，等待新的额度快照" : "待更新";
  const m = Math.floor(ms / 60000);
  if (m < 1) return long ? "不到 1 分钟后重置" : "↻<1m";
  const d = Math.floor(m / 1440), hr = Math.floor((m % 1440) / 60), mi = m % 60;
  if (long) return `${d ? `${d} 天${hr ? ` ${hr} 小时` : ""}` : hr ? `${hr} 小时${mi ? ` ${mi} 分` : ""}` : `${mi} 分钟`}后重置`;
  // tiny：手机输入操作区只留最大的一个单位（↻2d / ↻3h / ↻12m），精确时间在悬停提示与详情卡里
  if (style === "tiny") return `↻${d ? `${d}d` : hr ? `${hr}h` : `${mi}m`}`;
  // 满一天后一律带小时（整点也写 4d0h），一列倒计时的宽度和 ↻ 位置才稳定
  return `↻${d ? `${d}d${hr}h` : hr ? `${hr}h${mi ? `${mi}m` : ""}` : `${mi}m`}`;
}
/** 倒计时节点：带上重置时间，由下面的定时器原地刷新文字 */
function rtResetIn(iso, style, cls, beijing = false) {
  const el = h("span", { class: cls, "data-reset-at": iso, "data-reset-style": style }, rtCountdown(iso, style));
  if (beijing || style === "beijing") { el.dataset.resetBeijing = "true"; el.title = `${rtCountdown(iso, "long")} · ${rtQuotaResetTime(iso)}`; }
  else if (style !== "long") el.title = rtCountdown(iso, "long");
  return el;
}
function rtTickCountdowns() {
  if (document.visibilityState === "hidden") return;
  for (const el of document.querySelectorAll("[data-reset-at]")) {
    const style = el.dataset.resetStyle;
    const text = rtCountdown(el.dataset.resetAt, style);
    if (el.textContent !== text) el.textContent = text;
    if (el.dataset.resetBeijing) el.title = `${rtCountdown(el.dataset.resetAt, "long")} · ${rtQuotaResetTime(el.dataset.resetAt)}`;
    else if (style !== "long") el.title = rtCountdown(el.dataset.resetAt, "long");
  }
}

/* ------------------------------ Codex reset 标记 ------------------------------ */
// 有可用 reset 卡时显示图标；服务端跟随额度刷新读取卡数，失败保留最后快照。
// 图标 / reset 语义：回转箭头，画在右上角的小圆角块里。
const RT_RESET_PATHS = ["M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5"];
function rtResetDot(kind, rl) {
  if (kind !== "codex") return null;
  // 数据由服务端跟着额度 / 目录一起下发（ui.rt.codexReset），页面不额外发请求
  const info = ui.rt?.codexReset;
  const count = info?.availableCount;
  if (!(typeof count === "number" && count > 0)) return null;
  const soonest = info?.soonestExpiry;
  const hint = `Codex 有 ${count} 张可用 reset 卡${soonest ? `，最近一张 ${rtBeijingClock(new Date(soonest), true)} 过期（北京时间）` : ""}`;
  return h("span", { class: "rt-reset-chip", title: hint, "aria-hidden": "true" }, rtMiniIcon(RT_RESET_PATHS, { size: 8 }));
}
/** 兼容旧调用名 */
function rtResetTag(kind, rl) { return rtResetDot(kind, rl); }


// 只替换额度节点，保留草稿、焦点、光标、输入法组字与展开状态。
function rtPatchQuotaViews() {
  if (!["rt-new", "rt", "runtimes"].includes(ui.view)) return;
  for (const p of ui.rt.profiles || []) {
    if (p.runtimeKind === "pi") continue;
    const choice = document.querySelector(`[data-key="rt-kind-${p.runtimeKind}"]`)?.closest(".rt-runtime-choice");
    const select = choice?.querySelector(".rt-runtime-select");
    const strip = rtQuotaStrip(p.rateLimit, "short", "", "", p.runtimeKind, undefined, true), old = select?.querySelector(".rt-quota-strip");
    if (old && strip) old.replaceWith(strip); else if (old) old.remove(); else if (select && strip) select.append(strip);
    if (p.runtimeKind === "antigravity" && p.rateLimit?.available && typeof rtSummaryQuotaNodes === "function") {
      const summary = document.querySelector('.rt-rt-sum-row[data-runtime="antigravity"] .rt-rt-sum-lines');
      if (summary) summary.replaceChildren(...rtSummaryQuotaNodes(p.rateLimit, p.runtimeKind));
    }
    for (const el of document.querySelectorAll(`[data-quota-kind="${p.runtimeKind}"]`)) {
      if (el.dataset.quotaScope && el.dataset.quotaScope !== p.rateLimit?.identityScopeId) continue;
      el.replaceChildren(...[rtRateLimit(p.rateLimit, true)].flat(Infinity));
    }
    if (ui.rt.view?.session.runtimeKind === p.runtimeKind) {
      // 同一个账户作用域才合并；合并后无论新旧都重画胶囊：新数值到了就换掉上次数值
      const rl = rtPickRateLimit(ui.rt.view.session, p.rateLimit);
      if (rl) ui.rt.view.rateLimit = rl;
      if (ui.view === "rt") rtPatchComposeAccount(ui.rt.view);
    }
  }
  // 原地同步新建页运行时的「无额度」状态与优先级顺序（不重绘输入框，不打断输入法）
  const stripBox = document.querySelector(".rt-runtime-choices");
  if (stripBox) {
    const byKind = new Map((ui.rt.profiles || []).map((p) => [p.runtimeKind, p]));
    const ordered = rtOrderedNewKinds(ui.rt.profiles || []);
    for (const kind of ordered) {
      const choice = stripBox.querySelector(`[data-key="rt-kind-${kind}"]`)?.closest(".rt-runtime-choice");
      if (!choice) continue;
      const p = byKind.get(kind);
      const exhausted = p?.state === "executable" && rtRuntimeQuotaExhausted(kind, p);
      choice.classList.toggle("exhausted", !!exhausted);
      const head = choice.querySelector(".rt-runtime-head");
      const existingBadge = head?.querySelector(".rt-exhausted-badge");
      if (exhausted && head && !existingBadge) {
        const b = badge("无额度", "bad");
        b.classList.add("rt-exhausted-badge");
        head.append(b);
      } else if (!exhausted && existingBadge) {
        existingBadge.remove();
      }
      stripBox.append(choice);
    }
  }
  // 额度刷新也同步列表底部的数值和顺序，只替换摘要，保留列表滚动位置与输入草稿。
  const summary = document.querySelector(".rt-runtimes-summary");
  if (summary && typeof rtRuntimesSummary === "function") {
    const next = rtRuntimesSummary({ top: summary.classList.contains("rt-sum-top") });
    if (next) {
      summary.replaceWith(next);
      if (typeof rtSummaryWatch === "function") rtSummaryWatch(next.querySelector(".rt-rt-sum-grid") || next);
    }
  }
  rtTickCountdowns();
}
function rtQuotaContent(kind, rl, scope = rl?.identityScopeId || "") {
  return h("div", { "data-quota-kind": kind, "data-quota-scope": scope }, rtRateLimit(rl, true));
}
const rtQuotaAttempts = new Map();
const rtQuotaPending = new Set();
async function rtRefreshQuotas() {
  if (document.visibilityState === "hidden" || !["rt-new", "rt", "runtimes"].includes(ui.view) || !ui.rt.access?.control) return;
  const now = Date.now();
  const due = (ui.rt.profiles || []).filter(p => {
    if (ui.view === "rt" && (!rtConversationVisible() || p.runtimeKind !== ui.rt.view?.session?.runtimeKind)) return false;
    if (p.runtimeKind === "pi" || p.state !== "executable" || !p.identity || p.capabilities?.rateLimits?.status === "unsupported" || rtQuotaPending.has(p.runtimeKind)) return false;
    if (now - (rtQuotaAttempts.get(p.runtimeKind) ?? -Infinity) < 30_000) return false;
    const sampled = Date.parse(p.rateLimit?.sampledAt || "");
    return !Number.isFinite(sampled) || now - sampled >= 60_000 || p.rateLimit?.windows?.some(w => {
      const reset = Date.parse(w.resetsAt || ""); return reset <= now && sampled < reset;
    });
  });
  if (!due.length) return;
  await Promise.allSettled(due.map(async p => {
    rtQuotaAttempts.set(p.runtimeKind, now); rtQuotaPending.add(p.runtimeKind);
    try { await api(`/api/runtime-profiles/${p.runtimeKind}/rate-limits`, { method: "POST", body: JSON.stringify({ automatic: true }) }); }
    catch { /* 保留上一份数据，服务端标记陈旧；下一次按节流间隔重试。 */ }
    finally { rtQuotaPending.delete(p.runtimeKind); }
  }));
  await rtLoadProfiles(); rtPatchQuotaViews();
}
// 每 15 秒检查是否需要查询；成功快照每分钟更新，重置边界无需等满一分钟。


/**
 * 新建会话的运行时选项里：每个账户窗口一条细进度条（已用比例）＋重置倒计时；没有快照就不画。
 * brief：窄卡片里模型用两个字母的代号（NE / SO），完整名称留在悬停说明里。
 */
function rtQuotaStrip(rl, resetStyle = "short", wideResetStyle = "", note = "", kind = "", model, brief = false) {
  if (!rl || !rl.available || !rl.windows || !rl.windows.length) return null;
  const compact = kind === "antigravity" && rl.windows.some(w => w.group);
  const modelShort = compact ? rtQuotaModelShort(kind, model) : "";
  const modelTag = compact ? (brief ? rtQuotaModelCode(kind, model) : modelShort) : "";

  const modelName = modelShort && brief ? `${modelShort}（${modelTag}）` : modelShort;
  rl = rtQuotaForModel(rl, kind, model);
  if (!rl.windows.length) return h("span", { class: "rt-quota-strip rt-quota-compact", title: "尚未取得当前模型对应的额度组，请查看额度详情" }, "额度待确认");
  const detail = rl.windows.map((w) => `${rtQuotaWindowName(w)} 已用 ${rtQuotaPctText(w.usedPercent, "未知")}${!compact && w.group && w.resetsAt ? `，${rtQuotaResetTime(w.resetsAt)}重置` : ""}`).join("\n");
  const row = (w) => h("span", { class: `rt-quota-item${rtQuotaTone(w.usedPercent)}` },
    h("span", { class: "rt-quota-label" },
      modelTag ? h("span", { class: "rt-quota-model", title: modelShort ? `当前模型：${modelName}` : null }, brief ? `${modelTag} ` : modelTag) : null,
      rtQuotaShortLabel(w.label)),
    h("span", { class: "rt-quota-bar", role: "meter", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(rtQuotaUsedPct(w.usedPercent) ?? 0), "aria-label": `${rtQuotaWindowName(w)} 已用` }, rtFill(w.usedPercent)),
    h("span", { class: "rt-quota-pct" }, rtQuotaPctText(w.usedPercent)),
    w.resetsAt ? rtResetIn(w.resetsAt, resetStyle, `rt-quota-reset${wideResetStyle ? " rt-narrow" : ""}`, !compact && !!w.group) : null,
    w.resetsAt && wideResetStyle ? rtResetIn(w.resetsAt, wideResetStyle, "rt-quota-reset rt-wide", !compact && !!w.group) : null);
  // note：这份数值来自本机缓存（上次数值，正在刷新）时的说明，替换默认的「已陈旧」
  return h("span", { class: `rt-quota-strip${compact ? " rt-quota-compact" : ""}${rl.stale ? " stale" : ""}`, title: compact ? detail : `账户额度${rl.stale ? `（${note || "已陈旧"}）` : ""}\n${detail}\n采样于 ${rtAgo(rl.sampledAt)}` },
    compact ? rl.windows.map(row) : rtQuotaGroups(rl.windows).map(g => g.name ? h("span", { class: "rt-quota-group-strip" }, h("span", { class: "rt-quota-group-name" }, g.name), g.windows.map(row)) : g.windows.map(row)),
    !compact && rl.stale && rl.windows.some(w => w.group) ? h("span", { class: "rt-quota-stale warn-text" }, "已过期，等待刷新") : null,
    // 有可用 reset 卡时跟着额度条一起排（同一套小标，数据就在这份快照里）
    rtResetDot(kind, rl));
}

/* ------------------------------ 模型服务余额（Pi 用到的 DeepSeek / OpenRouter…） ------------------------------ */

const RT_PROVIDER_NAME = { deepseek: "DeepSeek", openrouter: "OpenRouter" };
const rtProviderName = (p) => RT_PROVIDER_NAME[p] || p;
/** 选项卡上省地方：缩写，全名在悬停提示里 */
const RT_PROVIDER_SHORT = { deepseek: "DS", openrouter: "OR" };
function rtMoney(value, unit, whole = false) {
  const sym = { CNY: "¥", USD: "$" }[unit];
  const n = whole || Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);
  return sym ? `${value < 0 ? "-" : ""}${sym}${n.replace("-", "")}` : `${n} ${unit}`;
}
/** 选项卡上只放「余额」：去掉累计充值 / 消费；多币种只留不为 0 的（全是 0 就留第一个） */
function rtBalanceMain(b) {
  const amounts = (b.amounts || []).filter((a) => !/^累计/.test(a.label));
  const nonzero = amounts.filter((a) => a.value !== 0);
  return nonzero.length ? nonzero : amounts.slice(0, 1);
}
/* ------------------------------ DeepSeek 计费时段（高峰 / 低峰） ------------------------------ */
// 消耗卡片上的 DeepSeek 加一枚「高峰 / 低峰」标记：高峰全价，低峰是高峰的 5 折，同一件事换个时段跑差一倍。
// 规则与 apps/web/src/deepseek-peak.ts 一致（峰时按 UTC、周末与中国法定节假日全天低峰）：
// 那边给账本计价、给分诊排期，这里只标「现在」。两份实现一旦不一致，标记就会和账单互相打脸，
// 所以 apps/web/test/runtime-pi-balance-sync.test.ts 逐小时比对两边结论；改规则时两处一起改。
const RT_DS_PEAK_WINDOWS_UTC = [[1, 4], [6, 10]];
/** 中国法定节假日（整天算低峰）；与服务端 CN_HOLIDAYS_2026 同一份，没列到的年份按高峰算，只高估不低估 */
const RT_DS_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-02", "2026-01-03",
  "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
  "2026-04-04", "2026-04-05", "2026-04-06",
  "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
  "2026-06-19", "2026-06-20", "2026-06-21",
  "2026-09-25", "2026-09-26", "2026-09-27",
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"
]);
const RT_DS_TARIFF_HINT = "DeepSeek 计费时段：1X（高峰）= 工作日 UTC 01:00–04:00、06:00–10:00（北京 09:00–12:00、14:00–18:00）；其余时间（含周末与中国法定节假日）是 0.5X（低峰），价格是 1X 的 5 折。";
/** 这个时刻是不是高峰价（与服务端 isPeak 同规则：非法时间当低峰，宁可少标价） */
function rtDeepseekPeak(at) {
  const ms = at instanceof Date ? at.getTime() : Number(at);
  if (!Number.isFinite(ms)) return false;
  const d = new Date(ms), weekday = d.getUTCDay(); // 0 = 周日
  if (weekday === 0 || weekday === 6) return false;
  if (RT_DS_HOLIDAYS.has(d.toISOString().slice(0, 10))) return false;
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return RT_DS_PEAK_WINDOWS_UTC.some(([from, to]) => minutes >= from * 60 && minutes < to * 60);
}
/** 卡片上的标记文字 */
function rtDeepseekTariffLabel(at = new Date()) { return rtDeepseekPeak(at) ? "1X" : "0.5X"; }
/** 下一次换挡的时刻：现在高峰就找下一次低峰（当前窗口结束），现在低峰就找下一次高峰（跳过周末与节假日）。最多看 8 天 */
function rtDeepseekNextSwitch(at = new Date()) {
  const step = 60_000, peak = rtDeepseekPeak(at), start = Math.ceil(at.getTime() / step) * step, limit = at.getTime() + 8 * 86_400_000;
  for (let ms = start; ms <= limit; ms += step) if (rtDeepseekPeak(ms) !== peak) return { at: new Date(ms), label: peak ? "0.5X" : "1X" };
  return null;
}
/** 换挡时刻：按北京时间写（峰谷窗口本来就是北京时段，不跟本机时区变） */
function rtBeijingClock(at, withDate = false) {
  try {
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", ...(withDate ? { month: "numeric", day: "numeric", weekday: "short" } : {}), hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
  } catch { return `${at.toISOString().slice(11, 16)} UTC`; }
}
/** 「多久之后换挡」：short = 输入操作区第二行的 56m后转低峰；long = 详情卡里的 56 分钟后转低峰（北京 12:00） */
function rtDeepseekEta(next, long = false) {
  if (!next) return "";
  const m = Math.max(1, Math.floor((next.at.getTime() - Date.now()) / 60_000));
  const d = Math.floor(m / 1440), hr = Math.floor((m % 1440) / 60), mi = m % 60;
  if (long) return `${d ? `${d} 天${hr ? ` ${hr} 小时` : ""}` : hr ? `${hr} 小时${mi ? ` ${mi} 分` : ""}` : `${mi} 分钟`}后转${next.label}（北京 ${rtBeijingClock(next.at, d >= 1)}）`;
  return `${d ? `${d}d${hr ? `${hr}h` : ""}` : hr ? `${hr}h${mi ? `${mi}m` : ""}` : `${mi}m`}后转${next.label}`;
}
/**
 * 计费时段标记：高峰/低峰（跟在金额后面）+ 多久之后换挡（输入操作区里落到第二行）。
 * 只有 DeepSeek 分峰谷价，别的服务商返回空数组（调用处直接展开，不用判空）。
 */
function rtTariffTag(provider, { at = new Date(), long = false, eta: withEta = true } = {}) {
  if (provider !== "deepseek") return [];
  const label = rtDeepseekTariffLabel(at), next = rtDeepseekNextSwitch(at), eta = withEta ? rtDeepseekEta(next, long) : "";
  const hint = `${RT_DS_TARIFF_HINT}${next ? `\n现在 ${label}，${rtDeepseekEta(next, true)}。` : ""}`;
  return [
    h("span", { class: `rt-tariff-tag${label === "1X" ? " peak" : ""}`, title: hint, "aria-label": `DeepSeek 计费时段：${label}` }, label),
    eta ? h("span", { class: "rt-tariff-eta", title: hint }, eta) : null
  ].filter(Boolean);
}

function rtBalanceHint(p, b, note = "") {
  const lines = [`${rtProviderName(p)} 账户余额${b.stale ? `（${note || "非实时"}）` : ""}`];
  if (b.status === "ok") for (const a of b.amounts || []) lines.push(`${a.label} ${rtMoney(a.value, a.unit)}`);
  else lines.push(b.reason || "读不到");
  if (b.fetchedAt) lines.push(`${rtAgo(b.fetchedAt)}读取`);
  return lines.join("\n");
}
/** 新建会话的 Pi 选项里：每个模型服务一行紧凑余额（DeepSeek ¥23.27）；读不到写「?」，悬停看原因 */
/** 紧凑余额文字：读到写金额（多币种用 / 分隔），还没读写「—」，读不到写「?」 */
function rtBalanceText(b, whole = false) {
  const main = b.status === "ok" ? rtBalanceMain(b) : [];
  return { text: main.length ? main.map((a) => rtMoney(a.value, a.unit, whole)).join(" / ") : b.status === "not-refreshed" ? "—" : "?",
    empty: !!main.length && main.every((a) => a.value <= 0) };
}
function rtBalanceStrip(balances, wide = false) {
  if (!balances || !balances.length) return null;
  return h("span", { class: "rt-quota-strip rt-balance-strip" },
    balances.map(({ provider, balance: b }) => {
      const { text, empty } = rtBalanceText(b);
      return h("span", { class: `rt-balance-item${b.stale ? " stale" : ""}${empty ? " bad" : ""}`, title: rtBalanceHint(provider, b) },
        h("span", { class: `rt-quota-label${wide ? " rt-narrow" : ""}` }, RT_PROVIDER_SHORT[provider] || rtProviderName(provider)),
        // 会话输入操作区：桌面宽度写服务商全名
        wide ? h("span", { class: "rt-quota-label rt-wide" }, rtProviderName(provider)) : null,
        h("span", { class: "rt-balance-value" }, text),
        // 新建会话的运行时卡片里也标计费时段；地方小，只给高峰/低峰，多久后换挡在悬停提示里
        ...rtTariffTag(provider, { eta: false }));
    }));
}
/* ------------------------------ 账户胶囊的上次数值（先显示，再刷新） ------------------------------ */

/**
 * 会话详情的输入操作区：账户状态胶囊（附件按钮右侧）。Pi 显示所用模型服务的余额；Codex / Claude 显示订阅额度窗口。
 * 手机：一项一行、最多两行叠放，高度不超过操作区按钮，≥80% 才带重置倒计时；点开会话详情浮层（顶部就是完整卡片）。
 * 桌面：同一行横排，写服务商全名、细条更长、倒计时常显（rt-wide / rt-narrow 由 CSS 按宽度二选一）；右侧栏不再重复这张卡。
 *
 * 额度 / 余额是账号级资源，跟会话详情、runtime 配置分开读回来（增量同步的 state 里也没有）。
 * 进入会话时先显示这台浏览器上次读到的数值，最新快照到了再原地换成新数值：输入操作区不会空一块、高度也不跳。
 * 只存展示用的字段（窗口比例、余额金额），额度按 runtime ＋ 账户作用域分组；超过一天的不再回放（额度可能已重置，旧数字只会误导）。
 */
const RT_ACCOUNT_KEY = `pi-agent.rt.account.v1:${location.host}`;
const RT_ACCOUNT_SESSION_KEY = `pi-agent.rt.account-session.v1:${location.host}`;
const RT_ACCOUNT_MAX = 12;
const RT_ACCOUNT_SESSION_MAX = 50;
const RT_ACCOUNT_TTL = 24 * 60 * 60_000;
/** 额度按账户作用域分开存（多账号互不覆盖）；余额本身按模型服务上报，不涉及账户作用域 */
const rtQuotaKey = (kind, scope) => `rl|${kind}|${scope || ""}`;
const rtBalanceKey = (kind) => `bal|${kind}`;
function rtReadStored(key) {
  try { const v = JSON.parse(localStorage.getItem(key) || "null"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
function rtWriteStored(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 存不了就只在本页有效 */ }
}
/** 只留最新的 N 组 */
function rtTrimStored(all, max) {
  const keys = Object.keys(all).sort((a, b) => (Date.parse(all[b]?.at || "") || 0) - (Date.parse(all[a]?.at || "") || 0));
  for (const k of keys.slice(max)) delete all[k];
  return all;
}
function rtStoredFresh(rec) {
  return rec && Date.now() - (Date.parse(rec.at) || 0) < RT_ACCOUNT_TTL ? rec.value : null;
}
/** 记住这次读到的数值（同一份数据不重复写） */
function rtRememberAccount(kind, rateLimit, balances) {
  if (!kind) return;
  const rl = rateLimit && rateLimit.available && rateLimit.windows?.length ? rateLimit : null;
  const bs = balances && balances.length ? balances : null;
  if (!rl && !bs) return;
  const all = rtReadStored(RT_ACCOUNT_KEY);
  let changed = false;
  for (const [key, value] of [[rl ? rtQuotaKey(kind, rl.identityScopeId) : null, rl], [bs ? rtBalanceKey(kind) : null, bs]]) {
    if (!key || JSON.stringify(all[key]?.value) === JSON.stringify(value)) continue;
    all[key] = { at: new Date().toISOString(), value }; changed = true;
  }
  if (changed) rtWriteStored(RT_ACCOUNT_KEY, rtTrimStored(all, RT_ACCOUNT_MAX));
}
/** 上次数值：知道账户作用域就只认同一作用域；还不知道（会话目录、详情都没到）时才用同 runtime 的最新一份 */
function rtAccountSnapshot(kind, scope) {
  if (!kind) return null;
  const all = rtReadStored(RT_ACCOUNT_KEY);
  let rateLimit = scope ? rtStoredFresh(all[rtQuotaKey(kind, scope)]) : null;
  if (!rateLimit && !scope) {
    const newest = Object.entries(all).filter(([k]) => k.startsWith(`rl|${kind}|`))
      .sort((a, b) => (Date.parse(b[1]?.at || "") || 0) - (Date.parse(a[1]?.at || "") || 0))[0];
    rateLimit = newest ? rtStoredFresh(newest[1]) : null;
  }
  const balances = rtStoredFresh(all[rtBalanceKey(kind)]);
  return rateLimit || balances ? { rateLimit, balances } : null;
}
/** 会话 → 上次看到的 runtime 与账户作用域：进入会话的最初一帧（目录、详情都还没到）也要能摆上胶囊 */
function rtRememberSessionAccount(session) {
  const id = session?.platformSessionId;
  if (!id || !session.runtimeKind) return;
  const all = rtReadStored(RT_ACCOUNT_SESSION_KEY), prev = all[id];
  if (prev && prev.kind === session.runtimeKind && prev.scope === session.identityScopeId) return;
  all[id] = { kind: session.runtimeKind, scope: session.identityScopeId || "", at: new Date().toISOString() };
  rtWriteStored(RT_ACCOUNT_SESSION_KEY, rtTrimStored(all, RT_ACCOUNT_SESSION_MAX));
}
function rtSessionAccount(id) {
  const entry = rtDirEntry(id), hit = id ? rtReadStored(RT_ACCOUNT_SESSION_KEY)[id] : null;
  const kind = entry?.runtimeKind || hit?.kind;
  if (!kind) return null;
  return { session: { platformSessionId: id, runtimeKind: kind, identityScopeId: entry?.identityScopeId || hit?.scope || undefined } };
}
/**
 * 胶囊要显示的数值：最新的优先——会话详情里的，其次 runtime 配置里同一账户的快照；
 * 都没有才用本机上次读到的（cached：这是上次数值，正在刷新）。
 */
function rtComposeAccountData(v) {
  const session = v?.session || {};
  rtRememberSessionAccount(session);
  const kind = session.runtimeKind, scope = session.identityScopeId;
  const balances = v?.balances?.length ? v.balances : null;
  const live = v?.rateLimit && v.rateLimit.available && v.rateLimit.windows?.length ? v.rateLimit : null;
  if (balances || live) return { kind, balances, rateLimit: live, cached: false };
  // runtime 配置里同一账户的快照：来自本机缓存（profilesCached）时同样算「上次数值」，要到下一次读回才算最新
  const fromProfiles = rtPickRateLimit(session, (ui.rt.profiles || []).find((p) => p.runtimeKind === kind)?.rateLimit);
  if (fromProfiles) return { kind, balances, rateLimit: fromProfiles, cached: !!ui.rt.profilesCached };
  const snap = rtAccountSnapshot(kind, scope);
  return snap ? { kind, balances: snap.balances, rateLimit: snap.rateLimit, cached: true } : { kind, balances: null, rateLimit: null, cached: false };
}
/** 输入区的额度：账户 logo + 窗口。手机上下两行「窗口名 百分比 倒计时」，所有窗口默认带倒计时；桌面横排，每个窗口一圈细环 + 百分比 + 倒计时 */
function rtComposeQuotaStrip(kind, rl, note, modelShort = "") {
  const detail = rl.windows.map((w) => `${rtQuotaWindowName(w)} 已用 ${rtQuotaPctText(w.usedPercent, "未知")}`).join("\n");
  const logo = RT_ACCOUNT_LOGO[kind];
  return h("span", { class: `rt-quota-strip rt-quota-rings${rl.stale ? " stale" : ""}`, title: `账户额度${rl.stale ? `（${note || "已陈旧"}）` : ""}\n${detail}\n采样于 ${rtAgo(rl.sampledAt)}` },
    logo ? rtAccountLogo(logo) : null,
    h("span", { class: "rt-quota-rows" }, rl.windows.map((w) => h("span", { class: `rt-quota-item${rtQuotaTone(w.usedPercent)}` },
      rtQuotaRing(w.usedPercent),
      h("span", { class: "rt-quota-label" },
        modelShort ? h("span", { class: "rt-quota-model" }, modelShort) : null,
        rtQuotaShortLabel(w.label)),
      h("span", { class: "rt-quota-bar", role: "meter", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(rtQuotaUsedPct(w.usedPercent) ?? 0), "aria-label": `${w.label} 已用` }, rtFill(w.usedPercent)),
      h("span", { class: "rt-quota-pct" }, rtQuotaPctText(w.usedPercent)),
      w.resetsAt ? rtResetIn(w.resetsAt, "tiny", "rt-quota-reset rt-narrow") : null,
      w.resetsAt ? rtResetIn(w.resetsAt, "short", "rt-quota-reset rt-wide") : null))),
    // 有可用 reset 卡时的标记：随组件一起排，不盖住额度文字（数据就在这份额度快照里）
    rtResetDot(kind, rl));
}
/** 输入区的余额：服务商 logo（没有 logo 的画钱包）+ 金额；服务商名留给读屏和悬停 */
function rtComposeBalanceStrip(balances) {
  return h("span", { class: "rt-quota-strip rt-balance-strip" },
    balances.map(({ provider, balance: b }) => {
      const { text, empty } = rtBalanceText(b);
      return h("span", { class: `rt-balance-item${b.stale ? " stale" : ""}${empty ? " bad" : ""}`, title: rtBalanceHint(provider, b) },
        RT_PROVIDER_LOGO[provider] ? rtAccountLogo(RT_PROVIDER_LOGO[provider]) : rtMiniIcon(RT_MINI_PATHS.wallet, { className: "rt-account-glyph", size: 14 }),
        h("span", { class: "rt-quota-label sr-only" }, rtProviderName(provider)),
        h("span", { class: "rt-balance-value" }, text),
        // 金额后面跟「高峰 / 低峰」；多久之后换挡在手机上是第二行
        ...rtTariffTag(provider));
    }));
}
function rtComposeAccount(v) {
  const data = rtComposeAccountData(v);
  if (!data.cached) rtRememberAccount(data.kind, data.rateLimit, data.balances);
  const note = data.cached ? "上次数值，正在刷新" : "";
  if (data.balances && data.balances.length) {
    // 上次数值按「非实时」画淡：还是同一条信息，只是可能已经不是最新的
    const balances = data.cached ? data.balances.map((x) => ({ ...x, balance: { ...x.balance, stale: true } })) : data.balances;
    const shown = balances.slice(0, 2);
    const spoken = balances.map(({ provider, balance: b }) => {
      const eta = provider === "deepseek" ? rtDeepseekEta(rtDeepseekNextSwitch(), true) : "";
      const tariff = provider === "deepseek" ? `（${rtDeepseekTariffLabel()}${eta ? `，${eta}` : ""}）` : "";
      return `${rtProviderName(provider)} ${rtBalanceText(b).text}${tariff}${b.stale ? "（非实时）" : ""}`;
    }).join("，");
    return h("button", { type: "button", class: `rt-compose-account${shown.length > 1 ? " multi" : ""}${data.cached ? " cached" : ""}`, "data-account": "balance",
      "aria-label": `账户余额${data.cached ? "（上次数值，正在刷新）" : ""}：${spoken}。查看详情`, title: balances.map(({ provider, balance: b }) => rtBalanceHint(provider, b, note)).join("\n\n"),
      onclick: () => { if (rtPhone.matches) rtSetInfoOpen(true); } }, rtComposeBalanceStrip(shown));
  }
  if (data.rateLimit && data.rateLimit.available && data.rateLimit.windows && data.rateLimit.windows.length) {
    const rl = data.cached ? { ...data.rateLimit, stale: true } : data.rateLimit;
    const model = data.kind === "antigravity" ? (v.session.effectiveModel || v.session.requestedModel || rtQuotaSelectedModel(data.kind)) : "";
    const selected = data.kind === "antigravity" ? rtQuotaForModel(rl, data.kind, model) : rl;
    const modelShort = data.kind === "antigravity" ? rtQuotaModelShort(data.kind, model) : "";
    const windows = selected.windows.slice(0, 2);
    if (!windows.length) return h("span", { class: "rt-compose-account", hidden: true });
    const spoken = rl.windows.map((w) => `${rtQuotaWindowName(w)} 已用 ${rtQuotaPctText(w.usedPercent, "未知")}${w.resetsAt ? `，${rtQuotaResetTime(w.resetsAt)}重置` : ""}`).join("；");
    return h("button", { type: "button", class: `rt-compose-account${windows.length > 1 ? " multi" : ""}${data.cached ? " cached" : ""}`, "data-account": "quota",
      "aria-label": `账户额度${rl.stale ? `（${note || "已陈旧"}）` : ""}：${spoken}。查看详情`,
      onclick: () => { if (rtPhone.matches) rtSetInfoOpen(true); } }, rtComposeQuotaStrip(data.kind, { ...rl, windows }, note, modelShort));
  }
  return h("span", { class: "rt-compose-account", hidden: true });
}
/** 余额 / 额度刷新后，就地替换输入操作区里的账户胶囊（数值没变就不动节点，免得丢焦点、重置倒计时文案） */
function rtPatchComposeAccount(v) {
  const chip = document.querySelector(".rt-composer .rt-compose-account");
  if (!chip) return;
  const next = rtComposeAccount(v);
  if (chip.outerHTML === next.outerHTML) return;
  chip.replaceWith(next);
}
/** 会话详情与状态说明里：每个服务的全部数值、读取时间与口径；读不到写原因 */
function rtBalances(balances) {
  return balances.map(({ provider, balance: b }) => h("div", { class: "rt-balance" },
    h("div", { class: "rt-balance-head" }, h("span", { class: "rt-balance-name" }, h("strong", {}, rtProviderName(provider)), ...rtTariffTag(provider, { eta: false })), b.consoleUrl ? h("a", { class: "small", href: b.consoleUrl, target: "_blank", rel: "noopener noreferrer" }, "服务商控制台") : null),
    // 计费时段换挡时间单独一行：峰谷按北京时间划，卡片里写清楚到几点、还有多久
    rtDeepseekEta(rtDeepseekNextSwitch(), true) ? h("p", { class: "muted small rt-tariff-note" }, `当前 ${rtDeepseekTariffLabel()}，${rtDeepseekEta(rtDeepseekNextSwitch(), true)}`) : null,
    b.status === "ok"
      ? (() => {
        // 多币种里为 0 的不列（另一个币种有钱时）；全部见底才标红
        const main = rtBalanceMain(b), empty = main.every((a) => a.value <= 0);
        const rows = [...main, ...(b.amounts || []).filter((a) => /^累计/.test(a.label))];
        return h("dl", { class: "kv rt-balance-kv" }, rows.flatMap((a) => [h("dt", {}, a.label), h("dd", { class: empty && main.includes(a) ? "bad-text" : "" }, rtMoney(a.value, a.unit))]));
      })()
      : h("p", { class: "muted small" }, b.reason || "读不到"),
    b.status === "ok" ? h("p", { class: `small ${b.stale ? "warn-text" : "muted"}` }, [b.stale ? "非实时" : "", b.fetchedAt ? `${rtAgo(b.fetchedAt)}读取` : "", b.scope || ""].filter(Boolean).join(" · ")) : null));
}

function rtRateLimit(rl, compact) {
  if (!rl) return h("p", { class: "muted small" }, "不可用：还没有读到 runtime 返回的账户窗口");
  if (!rl.available) return h("p", { class: "muted small" }, `不可用：${rl.reason || "runtime 未提供"}`);
  const row = (w) => h("div", { class: `rt-meter${rtQuotaTone(w.usedPercent)}` },
      h("span", { class: "rt-meter-label small" }, w.label),
      h("span", { class: "rt-meter-bar", role: "meter", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(rtQuotaUsedPct(w.usedPercent) ?? 0), "aria-label": `${rtQuotaWindowName(w)} 已用` },
        rtFill(w.usedPercent)),
      h("span", { class: "small" }, rtQuotaUsedPct(w.usedPercent) == null ? "未知" : `${rtQuotaPctText(w.usedPercent)} 已用`),
      w.resetsAt ? rtResetIn(w.resetsAt, w.group ? "beijing" : "long", "muted small rt-meter-reset") : null);
  return [
    rtQuotaGroups(rl.windows).map(g => g.name ? h("section", { class: "rt-quota-group", "aria-label": g.name }, h("h4", { class: "small" }, g.name), g.windows.map(row)) : g.windows.map(row)),
    compact
      ? h("p", { class: `small ${rl.stale ? "warn-text" : "muted"}`, title: `账户级快照，与会话 token 独立 · 来源 ${rl.source}` }, `${rl.plan ? `计划 ${rl.plan} · ` : ""}${rl.stale ? "已陈旧，" : ""}采样于 ${rtAgo(rl.sampledAt)}`)
      : h("p", { class: `small ${rl.stale ? "warn-text" : "muted"}` }, `账户级快照，与会话 token 独立${rl.plan ? ` · 计划 ${rl.plan}` : ""} · ${rl.stale ? "已陈旧，" : ""}采样于 ${rtTime(rl.sampledAt)} · 来源 ${rl.source}`)
  ];
}

/* ------------------------------ 额度提示 ------------------------------ */

function rtShortTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return rtTime(ts);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, "0"), mm = String(d.getMinutes()).padStart(2, "0");
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

/** 最近一次真实调用因额度/限流失败：提示，不阻止（额度会重置；平台不会自动换模型、runtime 或计费渠道） */
function rtQuotaWarning(p, opts = {}) {
  const q = p && p.lastQuotaFailure;
  if (!q) return null;
  const fullText = `最近一次调用因额度不足失败（${rtTime(q.at)}${q.code ? ` · ${q.code}` : ""}）：${q.message}。平台不会自动换模型、runtime 或计费渠道；可在额度重置后再试，或查看当前账户额度。`;
  if (!opts.compact) return h("p", { class: "small warn-text", role: "note" }, fullText);
  const key = `${p.runtimeKind || ""}|${q.at || ""}|${q.code || ""}|${q.message || ""}`;
  if (ui.rt.dismissedQuotaWarnings?.has(key)) return null;
  const expanded = !!ui.rt.expandedQuotaWarnings?.has(key);
  const shortAt = rtShortTime(q.at);
  return h("div", { class: `rt-quota-notice${expanded ? " open" : ""}`, role: "note" },
    h("div", { class: "rt-quota-notice-bar" },
      h("button", {
        type: "button",
        class: "rt-quota-notice-toggle",
        "aria-expanded": String(expanded),
        onclick: () => {
          const set = (ui.rt.expandedQuotaWarnings ||= new Set());
          if (set.has(key)) set.delete(key); else set.add(key);
          renderMain();
        }
      },
        h("span", { class: "rt-quota-notice-ico", "aria-hidden": "true" }, "⚠"),
        h("span", { class: "rt-quota-notice-summary" }, `上次调用额度不足${shortAt ? `（${shortAt}）` : ""}`),
        h("span", { class: "rt-quota-notice-more" }, expanded ? "收起" : "详情 ›")),
      h("button", {
        type: "button",
        class: "rt-quota-notice-close",
        "aria-label": "关闭额度提示",
        title: "关闭提示",
        onclick: () => {
          (ui.rt.dismissedQuotaWarnings ||= new Set()).add(key);
          ui.rt.expandedQuotaWarnings?.delete(key);
          renderMain();
        }
      }, "×")),
    expanded ? h("p", { class: "rt-quota-notice-body small warn-text" }, fullText) : null);
}

/* ------------------------------ 推理强度 ------------------------------ */

const RT_EFFORT = { minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高", ultra: "极高（自动分派子任务）" };
/** 新建会话可选的模型：运行时配置里勾选的（未配置 = 全部）；defaultAllowed 表示"默认模型"能不能选 */
function rtSelectableModels(kind, profile) {
  const models = profile ? profile.models : [];
  const allowed = ui.rt.settings?.enabledModelsByRuntime?.[kind];
  if (!allowed) return { models, restricted: false, defaultAllowed: true };
  const def = models.find((m) => m.isDefault) || (kind === "pi" ? models[0] : null);
  return { models: models.filter((m) => allowed.includes(m.id)), restricted: true, defaultAllowed: !!def && allowed.includes(def.id) };
}
function rtModelOption(profile, model) {
  if (!profile) return null;
  return model ? profile.models.find((m) => m.id === model) : (profile.models.find((m) => m.isDefault) || profile.models[0] || null);
}
function rtDefaultEffortLabel(mo) {
  return mo && mo.defaultEffort ? `模型默认（${RT_EFFORT[mo.defaultEffort] || mo.defaultEffort}）` : "runtime 默认";
}
/** 折叠态摘要用短名：手机上一眼看完审批模式，完整说明仍在选项面板里 */
const RT_PERMISSION_SHORT = { "read-only": "只读", "pi-read-only": "只读", ask: "审批", "auto-review": "自动审核", auto: "自动审批", "full-access": "完全访问", bypassPermissions: "完全访问", default: "默认审批", acceptEdits: "自动编辑", plan: "计划模式", "pi-ask": "工作区沙盒", "pi-native": "原生权限" };
function rtPermissionShort(option) { return option ? RT_PERMISSION_SHORT[option.id] || option.label : ""; }
function rtEffortShort(value, mo) {
  const label = (e) => (RT_EFFORT[e] || e).split("（")[0];
  if (value) return label(value);
  return mo && mo.defaultEffort ? `默认·${label(mo.defaultEffort)}` : null;
}
/** effort 的英文缩写：模型图标右上角的小角标 */
const RT_EFFORT_EN = { minimal: "min", low: "L", medium: "M", high: "H", xhigh: "XH", max: "Max", ultra: "Ultra" };

/** 与导航一致的圆角线性图标：24px 网格、1.8px 描边。 */
function rtMiniIcon(paths, { className, title, attrs, size = 14 } = {}) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: String(size), height: String(size), fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  if (className) svg.setAttribute("class", className);
  for (const [k, v] of Object.entries(attrs || {})) svg.setAttribute(k, v);
  for (const d of paths) { const p = document.createElementNS(ns, "path"); p.setAttribute("d", d); svg.append(p); }
  if (title) { const t = document.createElementNS(ns, "title"); t.textContent = title; svg.append(t); }
  return svg;
}
const RT_MINI_PATHS = {
  // 开了 worktree：切了单独分支
  worktree: ["M6 6v12", "M6 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z", "M6 22a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z", "M18 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z", "M18 8v3a5 5 0 0 1-5 5H6"],
  // 没开 worktree：只在共享目录里单线改
  "worktree-off": ["M3 7V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"],
  // 审批模式：每种模式一个能看懂的图形（配合不同颜色）
  eye: ["M2.06 12.35a1 1 0 0 1 0-.7C3.3 8.5 6.9 5.5 12 5.5s8.7 3 9.94 6.15a1 1 0 0 1 0 .7C20.7 15.5 17.1 18.5 12 18.5S3.3 15.5 2.06 12.35Z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"],
  help: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3", "M12 17h.01"],
  shield: ["M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"],
  shieldCheck: ["M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z", "m9 12 2 2 4-4"],
  list: ["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"],
  lockOpen: ["M7 11V7a5 5 0 0 1 9.9-1", "M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z"],
  wrench: ["M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"],
  pencil: ["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"],
  message: ["M21 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v9Z", "M8 9h8", "M8 13h5"],
  sliders: ["M4 6h7", "M15 6h5", "M4 18h5", "M13 18h7", "M13 3v6", "M11 15v6"],
  chevron: ["m8 10 4 4 4-4"],
  // 余额：钱包（没有服务商 logo 时用）
  wallet: ["M19 7V5a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h14a1 1 0 0 1 1 1v3", "M3 6v12a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-3", "M21 12v4h-4a2 2 0 0 1 0-4h4Z"],
  // 待办引用：链接图标（与 @ 会话引用的头像区分开）
  link: ["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"],
  // 关联待办：与一级导航的待办图标同一套图形
  note: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z", "M8 7h8", "M8 11h8", "M8 15h5"],
  // 关联推荐任务：推荐是待办聚合，用叠起来的两层待办表示，和单条待办稍作区分
  recommendation: ["M8 3h11a2 2 0 0 1 2 2v11", "M5 7h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z", "M7 11h7", "M7 15h5"],
  // 推荐下一步：四角十字星（常见 AI 推荐标记），空心描边，与执行中的实心状态区分
  next: ["M12 2C12 7.5 16.5 12 22 12 16.5 12 12 16.5 12 22 12 16.5 7.5 12 2 12 7.5 12 12 7.5 12 2Z"],
};
/** 权限用图形、短名与颜色共同表达；原生模式沿用 runtime 设置，不作为错误标红。 */
const RT_PERMISSION_ICON = {
  "read-only": "eye", "pi-read-only": "eye",
  ask: "message", default: "message", "pi-ask": "message",
  "auto-review": "shieldCheck", auto: "shieldCheck",
  acceptEdits: "pencil",
  plan: "list",
  "full-access": "lockOpen", bypassPermissions: "lockOpen",
  "pi-native": "sliders",
};
const RT_PERMISSION_ICON_LABEL = {
  "read-only": "只读", "pi-read-only": "只读", ask: "询问", default: "询问", "pi-ask": "询问",
  "auto-review": "审核", auto: "自动", acceptEdits: "编辑", plan: "计划",
  "full-access": "全权", bypassPermissions: "全权", "pi-native": "原生",
};
/**
 * 会话输入操作区的「图形化」素材（V3.83）：全部是同一套 24 网格、1.8 圆角细线，颜色跟随 currentColor。
 * · 推理强度：只写文字档位，不配图标；
 * · 额度环：一圈细线，弧长 = 窗口已用比例；
 * · 账户 logo：用 mask 画成单色，跟着文字色走，深浅色都不会突兀；
 * · 权限：一枚小盾牌，靠颜色区分模式，不带下拉箭头。
 */
function rtSvgNode(name, attrs) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}
function rtSvgRoot(className, size) {
  return rtSvgNode("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: className });
}
/** 额度环：弧长 = 已用比例；读不到（null）画虚线圈 */
function rtQuotaRing(pct) {
  const svg = rtSvgRoot("rt-quota-ring", 16), C = 2 * Math.PI * 9;
  svg.append(rtSvgNode("circle", { cx: 12, cy: 12, r: 9, opacity: ".25", ...(pct == null ? { "stroke-dasharray": "2 3.6" } : {}) }));
  const used = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  if (used > 0) svg.append(rtSvgNode("circle", { cx: 12, cy: 12, r: 9, "stroke-dasharray": `${(C * used / 100).toFixed(2)} ${C.toFixed(2)}`, transform: "rotate(-90 12 12)" }));
  return svg;
}
const RT_ACCOUNT_LOGO = { codex: "codexmark", "claude-code": "claudecode", antigravity: "gemini" };
const RT_PROVIDER_LOGO = { deepseek: "deepseek" };
function rtAccountLogo(id) {
  const node = h("span", { class: "rt-account-logo", "aria-hidden": "true" });
  node.style.setProperty("--logo", `url("${rtLogoSrc(id)}")`);
  return node;
}
/** 权限：一枚小盾牌，模式只靠颜色区分（见 CSS 的 data-perm）；模式名在 aria-label / 悬停提示里 */
function rtPermissionGlyph(id, className = "rt-perm-glyph", size = 16) {
  return rtMiniIcon(RT_MINI_PATHS.shield, { className, size, attrs: { "data-perm": id || "" } });
}
function rtPermissionIcon(option) {
  const paths = RT_MINI_PATHS[(option && RT_PERMISSION_ICON[option.id]) || ""] || RT_MINI_PATHS.help;
  const label = option ? RT_PERMISSION_ICON_LABEL[option.id] || rtPermissionShort(option) : "权限";
  return h("span", { class: "rt-new-options-permission", title: option ? [option.label, option.detail].filter(Boolean).join(" · ") : "审批模式", "data-perm": option?.id || "" },
    rtMiniIcon(paths, { className: "rt-new-options-perm", size: 16, attrs: option ? { "data-perm": option.id } : null }),
    h("span", { class: "rt-new-options-permission-label" }, label));
}
/** 模型：用和头像同一套模型系列 logo + 模型名，右上角是 effort 英文缩写 */
function rtModelSummary(kind, modelId, modelLabel, mo, effort) {
  const value = effort || mo?.defaultEffort || "";
  const en = RT_EFFORT_EN[value] || null;
  const detail = [modelLabel, value ? `推理强度 ${RT_EFFORT[value] || value}` : null].filter(Boolean).join(" · ");
  return h("span", { class: "rt-new-options-model" },
    h("span", { class: "rt-new-options-model-avatar" },
      rtAvatar(kind, modelId, "xxs"),
      en ? h("span", { class: "rt-new-options-effort", title: `推理强度 ${RT_EFFORT[value] || value}` }, en) : null),
    h("span", { class: "rt-new-options-model-name", title: detail }, modelLabel));
}
/**
 * 新建会话选项的折叠摘要（手机）：两行、单个按钮，和发送按钮同一行。
 * 第一行：工作目录（超长从前面截断、优先留末尾）+ worktree 图标（开/关不同图标）。
 * 第二行：审批图标（不同权限不同图形与颜色）+ 模型 logo、名称和 effort 英文角标。
 */
function rtNewOptionsSummary(f, p, selectedPermission) {
  const selectable = rtSelectableModels(f.runtimeKind, p);
  const mo = rtModelOption(p, f.model);
  const model = f.model ? (selectable.models.find((m) => m.id === f.model)?.label || f.model) : "默认模型";
  const workspace = (f.workspace || "").trim();
  const wt = !!f.worktree;
  return h("span", { class: "rt-new-options-summary" },
    h("span", { class: "rt-new-options-line rt-new-options-workspace" },
      h("span", { class: "rt-new-options-path", title: workspace || "没有选择工作目录" }, workspace || "没有选择"),
      rtMiniIcon(wt ? RT_MINI_PATHS.worktree : RT_MINI_PATHS["worktree-off"], { className: `rt-new-options-wt${wt ? " on" : ""}`, title: wt ? "独立 worktree：开（单独分支，不动主目录）" : "独立 worktree：关（直接在共享目录里改）" })),
    h("span", { class: "rt-new-options-line rt-new-options-mode" },
      rtPermissionIcon(selectedPermission),
      rtModelSummary(f.runtimeKind, f.model || mo?.id || "", model, mo, f.effort)));
}
/** 紧凑的推理强度只按当前选项占位：下拉里再长的选项也不占宽，换选项后重新量。 */
function rtFitEffortSelect(sel) {
  const label = sel.selectedOptions?.[0]?.textContent ?? "";
  if (!label) return;
  const style = getComputedStyle(sel);
  // 还没插入页面时量不到字体：等插入后的下一帧再量
  if (!style.fontSize) return;
  const canvas = rtFitEffortSelect.canvas ||= document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  // 预留原生下拉箭头的宽度
  sel.style.width = `${Math.ceil(ctx.measureText(label).width + padding + 20)}px`;
}
/** 只列出模型自己报告支持的强度；模型没报告就不显示（不猜） */
function rtEffortSelect(mo, value, onChange, key, compact, disabled = false) {
  if (!mo || !mo.efforts || !mo.efforts.length) return compact ? null : h("label", { class: "rt-field" }, "推理强度", h("select", { disabled: true }, h("option", {}, "该模型未报告可选强度")));
  // 工具栏里的紧凑选择框只显示短名（「中」而不是「中（medium）」），完整名称在悬停提示里
  const concise = compact;
  const shortLabel = e => e === "ultra" ? "极高·自动分派" : (RT_EFFORT[e] || e).split("（")[0];
  const shortDefault = mo.defaultEffort === "ultra" ? "默认·极高·分派" : `默认${mo.defaultEffort ? ` · ${shortLabel(mo.defaultEffort)}` : ""}`;
  const sel = h("select", { "data-key": key, "aria-label": "推理强度", disabled, onchange: (ev) => onChange(ev.target.value) },
    h("option", { value: "", selected: !value, title: rtDefaultEffortLabel(mo) }, concise ? shortDefault : rtDefaultEffortLabel(mo)),
    mo.efforts.map((e) => h("option", { value: e, selected: value === e, title: `${RT_EFFORT[e] || e}（${e}）` }, concise ? shortLabel(e) : `${RT_EFFORT[e] || e}（${e}）`)));
  if (compact) {
    sel.addEventListener("change", () => rtFitEffortSelect(sel));
    requestAnimationFrame(() => rtFitEffortSelect(sel));
  }
  return compact ? h("label", { class: "rt-effort-compact small", title: "下一轮的推理强度" }, h("span", { class: "rt-effort-label", "aria-hidden": "true" }, rtMiniIcon(RT_MINI_PATHS.sliders, { className: "rt-new-field-icon", size: 11 }), "强度"), sel) : h("label", { class: "rt-field" }, "推理强度", sel);
}
function rtDefaultPermission(kind) { return kind === "codex" ? "ask" : kind === "pi" ? "pi-native" : kind === "antigravity" ? "auto" : "default"; }
const RT_PREFERENCES_KEY = "pi-agent.runtime-chat.preferences.v1";
let rtPrefSyncTimer = 0;
function rtReadLocalPreferences() {
  try {
    const data = JSON.parse(localStorage.getItem(RT_PREFERENCES_KEY) || "null");
    return data && data.version === 1 && data.drafts && typeof data.drafts === "object" ? data : null;
  } catch { return null; }
}
function rtReadPreferences() {
  const local = rtReadLocalPreferences();
  if (local) return local;
  const server = ui.rt?.settings?.newSessionPreferences;
  return server && server.version === 1 && server.drafts && typeof server.drafts === "object" ? server : {};
}
function rtPushPreferencesToServer(payload) {
  if (typeof api !== "function") return;
  clearTimeout(rtPrefSyncTimer);
  rtPrefSyncTimer = setTimeout(() => {
    rtPrefSyncTimer = 0;
    void api("/api/runtime-settings/preferences", { method: "PUT", body: JSON.stringify(payload) })
      .then((saved) => {
        if (saved && typeof saved === "object" && ui.rt.settings && typeof ui.rt.settings === "object") {
          ui.rt.settings.newSessionPreferences = saved;
          rtWriteCache();
        }
      })
      .catch(() => { /* 离线或只读入口时静默保留本地缓存 */ });
  }, 200);
}
function rtSyncPreferencesFromServer(serverPrefs) {
  if (serverPrefs && serverPrefs.version === 1 && serverPrefs.drafts && typeof serverPrefs.drafts === "object") {
    if (ui.rt.prefsDirty) return;
    const prev = rtReadLocalPreferences();
    const prevJson = prev ? JSON.stringify({ lastRuntimeKind: prev.lastRuntimeKind || "", lastWorkspace: prev.lastWorkspace || "", drafts: prev.drafts || {} }) : "";
    const nextJson = JSON.stringify({ lastRuntimeKind: serverPrefs.lastRuntimeKind || "", lastWorkspace: serverPrefs.lastWorkspace || "", drafts: serverPrefs.drafts || {} });
    try { localStorage.setItem(RT_PREFERENCES_KEY, JSON.stringify(serverPrefs)); } catch { /* 忽略缓存写失败 */ }
    const nextWorkspace = typeof serverPrefs.lastWorkspace === "string" && serverPrefs.lastWorkspace.length <= 8192 ? serverPrefs.lastWorkspace : "";
    const changed = prevJson !== nextJson || (typeof ui.rt.workspace === "string" && ui.rt.workspace !== nextWorkspace) || (ui.rt.form && RT_KINDS.includes(serverPrefs.lastRuntimeKind) && ui.rt.form.runtimeKind !== serverPrefs.lastRuntimeKind);
    ui.rt.workspace = nextWorkspace;
    ui.rt.draftsByRuntime = {};
    if (ui.rt.form && RT_KINDS.includes(serverPrefs.lastRuntimeKind)) ui.rt.form.runtimeKind = serverPrefs.lastRuntimeKind;
    if (changed && (ui.view === "rt-new" || ui.view === "rt-room-new") && typeof renderMain === "function") renderMain();
    return;
  }
  const local = rtReadLocalPreferences();
  if (local && !ui.rt.prefsMigrated && (local.lastWorkspace || local.lastRuntimeKind || Object.keys(local.drafts || {}).length > 0)) {
    ui.rt.prefsMigrated = true;
    rtPushPreferencesToServer(local);
  }
}
function rtSavePreferences() {
  const prefs = rtReadPreferences(), drafts = { ...prefs.drafts, ...ui.rt.draftsByRuntime };
  if (prefs.piPermissionPolicyVersion !== 1 && !ui.rt.draftsByRuntime?.pi && drafts.pi?.permissionMode === "pi-ask") drafts.pi = { ...drafts.pi, permissionMode: "pi-native" };
  if (prefs.antigravityPermissionPolicyVersion !== 1 && !ui.rt.draftsByRuntime?.antigravity && drafts.antigravity?.permissionMode === "default" && drafts.antigravity?.explicit?.permissionMode !== true) drafts.antigravity = { ...drafts.antigravity, permissionMode: "auto" };
  const payload = { version: 1, piPermissionPolicyVersion: 1, antigravityPermissionPolicyVersion: 1, lastRuntimeKind: ui.rt.form?.runtimeKind || "codex", lastWorkspace: ui.rt.workspace ?? prefs.lastWorkspace ?? "", drafts };
  ui.rt.prefsDirty = true;
  if (ui.rt.settings && typeof ui.rt.settings === "object") ui.rt.settings.newSessionPreferences = payload;
  try { localStorage.setItem(RT_PREFERENCES_KEY, JSON.stringify(payload)); }
  catch { /* Storage may be disabled; in-page drafts remain usable. */ }
  rtPushPreferencesToServer(payload);
}
const RT_DRAFT_KEYS = ["model", "effort", "permissionMode"];
/**
 * 每个运行时的新建会话选择。只有「用户自己选过」的项（explicit）才算本地最近一次配置，
 * 其余项取服务端默认配置（运行时对比表里手动设置），再没有就用内置默认。
 * 旧版本地记录没有 explicit 标记：非空的模型 / 强度、非内置默认的审批模式视为用户选过。
 */
function rtRuntimeDraft(kind) {
  const drafts = ui.rt.draftsByRuntime || (ui.rt.draftsByRuntime = {});
  if (!drafts[kind]) {
    const prefs = rtReadPreferences(), saved = prefs.drafts?.[kind];
    drafts[kind] = { model: "", effort: "", permissionMode: rtDefaultPermission(kind), explicit: {} };
    for (const key of RT_DRAFT_KEYS) {
      if (saved && typeof saved[key] === "string" && saved[key].length <= 256) {
        const hasExplicit = saved.explicit && typeof saved.explicit === "object";
        const legacyDefault = !hasExplicit && key === "permissionMode" && ((kind === "pi" && prefs.piPermissionPolicyVersion !== 1 && saved[key] === "pi-ask") || (kind === "antigravity" && prefs.antigravityPermissionPolicyVersion !== 1 && saved[key] === "default"));
        const isExplicit = hasExplicit ? saved.explicit[key] === true : (!legacyDefault && (key === "permissionMode" ? saved[key] !== rtDefaultPermission(kind) : saved[key] !== ""));
        drafts[kind].explicit[key] = isExplicit;
        if (key !== "permissionMode" || isExplicit) drafts[kind][key] = saved[key];
      }
    }
    if (kind === "pi" && prefs.piPermissionPolicyVersion !== 1 && drafts[kind].permissionMode === "pi-ask") drafts[kind].permissionMode = "pi-native";
  }
  return drafts[kind];
}
/** 某项当前生效的值：本地最近一次选择 > 服务端默认配置 > 内置默认 */
function rtDraftValue(kind, key) {
  const d = rtRuntimeDraft(kind);
  if (d.explicit?.[key]) return d[key];
  const server = ui.rt.settings?.defaultSessionByRuntime?.[kind];
  if (server && typeof server[key] === "string") {
    if (key === "permissionMode") return server.permissionMode || d.permissionMode;
    // 推理强度跟着模型走：本地换了模型，服务端默认的强度不再适用
    if (key !== "effort" || rtDraftValue(kind, "model") === server.model) return server[key];
    return "";
  }
  return d[key];
}
function rtSetDraftValue(kind, key, value) {
  const d = rtRuntimeDraft(kind);
  d[key] = value; (d.explicit ||= {})[key] = true;
  rtSavePreferences();
}
/** 工作目录不分运行时：默认沿用最近一次选过的文件夹（旧版按运行时保存的值作为兜底） */
function rtLastWorkspace() {
  if (typeof ui.rt.workspace !== "string") {
    const prefs = rtReadPreferences();
    const legacy = prefs.drafts?.[prefs.lastRuntimeKind]?.workspace;
    const saved = typeof prefs.lastWorkspace === "string" && prefs.lastWorkspace ? prefs.lastWorkspace : typeof legacy === "string" ? legacy : "";
    ui.rt.workspace = saved.length <= 8192 ? saved : "";
  }
  return ui.rt.workspace;
}
function rtForm() {
  if (!ui.rt.form) {
    const lastKind = rtReadPreferences().lastRuntimeKind;
    const form = { runtimeKind: RT_KINDS.includes(lastKind) ? lastKind : "codex", prompt: rtImageDraft("new").text || "", worktree: true };
    Object.defineProperty(form, "workspace", { enumerable: true, get: rtLastWorkspace, set: (value) => { ui.rt.workspace = value; rtSavePreferences(); } });
    // 每个新会话默认使用独立 worktree；手动取消只作用于当前表单。
    for (const key of ["model", "effort", "permissionMode"]) Object.defineProperty(form, key, {
      enumerable: true, get: () => rtDraftValue(form.runtimeKind, key), set: (value) => rtSetDraftValue(form.runtimeKind, key, value)
    });
    ui.rt.form = form;
  }
  return ui.rt.form;
}

/* 工作目录选择：默认收起；展开后可手填、用本机对话框，或在允许的根之内逐级浏览 */
function rtFolderName(path) { return path ? path.split("/").filter(Boolean).at(-1) || "/" : ""; }
/** 文件夹浏览按哪个运行时的允许根：单个会话为所选运行时；对比模式为第一条通道 */
function rtBrowseKind() {
  if (ui.view === "rt-room-new" && ui.room?.new?.members?.length) return ui.room.new.members[0].runtimeKind;
  return rtForm().runtimeKind;
}
function rtSetWorkspaceOpen(open) {
  if (ui.rt.wsOpen === open) return;
  ui.rt.wsOpen = open;
  if (open) {
    const f = rtForm();
    const ws = f.workspace.trim();
    const roots = rtWorkspaceRoots(rtBrowseKind());
    // 已选过：从它的上一级开始，便于换到同级项目；没选过且只有一个根：直接进这个根
    const parent = ws.startsWith("/") ? ws.replace(/\/+$/, "").replace(/\/[^/]+$/, "") || "/" : roots.length === 1 ? roots[0] : "";
    void rtLoadFolders(parent, ws);
  }
  renderMain();
}
async function rtLoadFolders(path, fallback) {
  const kind = rtBrowseKind();
  const seq = (ui.rt.folderSeq || 0) + 1; ui.rt.folderSeq = seq;
  ui.rt.folders = { ...(ui.rt.folders || {}), kind, loading: true, error: "" };
  const url = (p) => `/api/runtime-profiles/${kind}/folders${p ? `?path=${encodeURIComponent(p)}` : ""}`;
  let next;
  try {
    let data;
    // 上一级不在允许范围内时，先试当前文件夹本身，再退回根列表
    for (const p of [...new Set([path, fallback, ""])].filter((x) => x !== undefined)) {
      try { data = await api(url(p)); break; } catch (e) { if (!p) throw e; }
    }
    next = { kind, data, loading: false, error: "" };
  } catch (e) { next = { kind, data: null, loading: false, error: e.message }; }
  if (seq !== ui.rt.folderSeq) return;
  ui.rt.folders = next;
  renderMain();
}
function rtPickWorkspace(path) {
  rtForm().workspace = path; ui.rt.formError = "";
  ui.rt.wsOpen = false;
  renderMain();
}
function rtFolderBrowser(f) {
  const st = ui.rt.folders;
  if (!st || st.kind !== rtBrowseKind()) return h("p", { class: "muted small" }, "正在读取文件夹…");
  if (st.error) return h("p", { class: "field-error small" }, st.error);
  const d = st.data || {};
  const entries = Array.isArray(d.entries) ? d.entries : [];
  return h("div", { class: "rt-folder-browser", "aria-busy": String(!!st.loading) },
    h("div", { class: "rt-folder-head" },
      d.path ? h("button", { type: "button", class: "rt-folder-up", title: d.parent ? "上一级" : "回到允许的根", "aria-label": d.parent ? "上一级" : "回到允许的根", onclick: () => rtLoadFolders(d.parent || "") }, "‹") : null,
      h("span", { class: "rt-folder-path mono small", title: d.path || "" }, d.path || "允许的工作目录根"),
      d.path ? h("button", { type: "button", class: "btn small-btn", "data-key": "rt-ws-use", onclick: () => rtPickWorkspace(d.path) }, d.path === f.workspace ? "✓ 当前" : "选这里") : null),
    h("ul", { class: "rt-folder-list", "data-keep-scroll": "rt-folders" },
      entries.length ? entries.map((e) => h("li", { class: e.path === f.workspace ? "current" : "" },
        h("button", { type: "button", class: "rt-folder-open", title: `打开 ${e.path}`, onclick: () => rtLoadFolders(e.path) }, h("span", { "aria-hidden": "true" }, "▱"), d.path ? e.name : e.path),
        h("button", { type: "button", class: "rt-folder-pick small", "aria-label": `选择 ${e.name}`, onclick: () => rtPickWorkspace(e.path) }, e.path === f.workspace ? "✓" : "选择")))
        : h("li", { class: "muted small rt-folder-empty" }, st.loading ? "读取中…" : "没有子文件夹")),
    d.truncated ? h("p", { class: "muted small" }, "只显示前 500 个，可直接在上面输入路径") : null);
}
function rtWorkspaceOutsideClick(ev) {
  const target = ev.target;
  if (target instanceof Element && !target.isConnected) return;
  const inNew = ["rt-new", "rt-room-new"].includes(ui.view) || (ui.view === "rt" && !rtId());
  if (ui.rt.newOptionsOpen && (!(target instanceof Element) || (!target.closest(".rt-new-options") && !target.closest(".rt-new-ctx-bar")))) rtSetNewOptionsOpen(false, false);
  if (!ui.rt.wsOpen || !inNew) return;
  if (!(target instanceof Element) || !target.closest(".rt-new-workspace")) rtSetWorkspaceOpen(false);
}
function rtWorkspaceKeydown(ev) {
  if (ev.key !== "Escape") return;
  if (ui.rt.noteOpen) { ev.preventDefault(); rtToggleNote(false); return; }
  if (ui.rt.noticeOpen) { ev.preventDefault(); rtToggleNotice(false); return; }
  if (ui.rt.recommendationOpen) { ev.preventDefault(); rtToggleRecommendation(false); return; }
  const inNew = ["rt-new", "rt-room-new"].includes(ui.view) || (ui.view === "rt" && !rtId());
  if (ui.rt.wsOpen && inNew) rtSetWorkspaceOpen(false);
  else if (ui.rt.newOptionsOpen) rtSetNewOptionsOpen(false);
}
function rtSelectRuntime(kind) {
  if (!RT_KINDS.includes(kind)) return;
  rtForm().runtimeKind = kind; rtRuntimeDraft(kind); rtSavePreferences();
  if (ui.rt.wsOpen) { ui.rt.wsOpen = false; rtSetWorkspaceOpen(true); }
  ui.rt.confirmGeneration = (ui.rt.confirmGeneration || 0) + 1;
  ui.rt.confirm = null; ui.rt.formError = "";
  if (ui.rt.busy === "confirm") { ui.rt.busy = ""; ui.rt.launch = null; }
  renderMain();
  rtRevealSelected(".rt-runtime-choices", ".rt-runtime-choice.selected");
  if (kind === "antigravity" && ui.view === "rt-new") void rtCheckAntigravityConnection();
}
function rtWorkspaceRoots(kind) {
  const settings = ui.rt.settings;
  return settings ? settings.workspaceRootsByRuntime && settings.workspaceRootsByRuntime[kind] !== undefined ? settings.workspaceRootsByRuntime[kind] : settings.workspaceRoots : [];
}

/** 新建页返回入口：手机显示图标，桌面保留文字。 */
function rtNewBackLink() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [k, v] of Object.entries({ class: "rt-new-back-icon", viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", "m12 19-7-7 7-7M5 12h14");
  svg.append(path);
  return h("a", { href: "#/rt", class: "rt-new-back", "aria-label": "返回会话", title: "返回会话" },
    svg, h("span", { class: "rt-new-back-label" }, "返回会话"));
}

/** 搜索图标（放大镜） */
function rtSearchIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  for (const d of ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z", "m21 21-4.35-4.35"]) { const path = document.createElementNS(ns, "path"); path.setAttribute("d", d); svg.append(path); }
  return svg;
}

/** 工作目录选择（单个会话与对比模式共用） */
function rtSetNewOptionsOpen(open, restoreFocus = true) {
  ui.rt.newOptionsOpen = open;
  if (!open) ui.rt.wsOpen = false;
  renderMain();
  if (!open && restoreFocus) {
    // 手机新版：抽屉由配置三格打开，底栏的「会话选项」按钮不显示，焦点还给刚才点的那一格
    const toggle = document.querySelector(".rt-new-options-toggle");
    const pill = ui.rt.newOptionsOpener ? document.querySelector(`.rt-new-ctx-pill[data-ctx="${ui.rt.newOptionsOpener}"]`) : null;
    (toggle?.getClientRects().length ? toggle : pill || toggle)?.focus();
  }
}
/** 桌面直接显示选项，手机使用同一组选项的底部抽屉。折叠时可带出摘要或紧凑入口。 */
function rtNewOptions(summary, ...controls) {
  const summaryNode = summary && summary.nodeType ? summary : null;
  const titleText = typeof summary === "string" && summary ? summary : "会话选项";
  const isSingleNew = ui.view === "rt-new" || (ui.view === "rt" && !rtId());
  const sheetTitle = isSingleNew ? `会话配置 · ${RT_SHORT[rtForm().runtimeKind] || RT_KIND[rtForm().runtimeKind] || ""}`.replace(/ · $/, "") : "会话选项";
  return h("div", { class: `rt-new-options${ui.rt.newOptionsOpen ? " open" : ""}` },
    h("button", { type: "button", class: `rt-new-options-toggle${summaryNode ? "" : " compact"}`, title: "会话选项", "data-key": "rt-options-toggle", "aria-label": "会话选项", "aria-expanded": String(!!ui.rt.newOptionsOpen), "aria-controls": "rt-new-options-panel", onclick: () => rtSetNewOptionsOpen(!ui.rt.newOptionsOpen) },
      summaryNode || h("span", { class: "rt-new-options-title", "aria-hidden": "true" },
        rtMiniIcon(RT_MINI_PATHS.sliders, { className: "rt-new-options-icon", size: 14 }),
        titleText),
      summaryNode ? rtMiniIcon(RT_MINI_PATHS.chevron, { className: "rt-new-options-caret", size: 14 }) : null),
    ui.rt.newOptionsOpen ? h("button", { type: "button", class: "rt-new-options-backdrop", tabindex: "-1", "aria-label": "关闭会话选项", onclick: () => rtSetNewOptionsOpen(false) }) : null,
    h("div", { class: "rt-new-tools", id: "rt-new-options-panel", "data-keep-scroll": "rt-new-options" },
      h("div", { class: "rt-new-options-grab", "aria-hidden": "true" }),
      h("div", { class: "rt-new-options-head" }, h("strong", {}, sheetTitle), h("button", { type: "button", class: "btn small rt-new-options-done", onclick: () => rtSetNewOptionsOpen(false) }, "完成")),
      controls));
}
function rtWorkspacePicker(f, roots, a) {
  const set = (k) => (ev) => { f[k] = ev.target.value; ui.rt.formError = ""; };
  return h("div", { class: `rt-new-workspace${ui.rt.wsOpen ? " open" : ""}` },
    h("button", { type: "button", class: "rt-new-workspace-toggle", "data-key": "rt-ws-toggle", "aria-expanded": String(!!ui.rt.wsOpen), "aria-label": f.workspace ? `工作目录：${f.workspace}` : "选择工作目录", title: f.workspace || "选择工作目录", onclick: () => rtSetWorkspaceOpen(!ui.rt.wsOpen) },
      rtMiniIcon(RT_MINI_PATHS["worktree-off"], { size: 11 }), h("span", { class: f.workspace ? "" : "rt-new-workspace-empty" }, f.workspace ? rtFolderName(f.workspace) : "选择工作目录"), rtMiniIcon(RT_MINI_PATHS.chevron, { className: "rt-new-caret", size: 11 })),
    ui.rt.wsOpen ? h("div", { class: "rt-new-workspace-panel", role: "dialog", "aria-label": "选择工作目录" },
      h("div", { class: "rt-new-workspace-row" },
        h("input", { type: "text", "aria-label": "工作目录", "data-key": "rt-ws", value: f.workspace, placeholder: roots[0] ? `${roots[0]}/…` : "/Users/…", oninput: set("workspace"), onkeydown: (ev) => { if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); rtSetWorkspaceOpen(false); } } }),
        a && !a.public ? pickButton("rt-ws", "本机选择…", () => ({ purpose: "workspace", ...(f.workspace ? { current: f.workspace } : {}) }), (picked) => rtPickWorkspace(picked.path)) : null),
      roots.length ? rtFolderBrowser(f) : null,
      h("p", { class: "muted small" }, roots.length ? `本机 ${ui.rt.host ? ui.rt.host.label : ""} · 允许范围：${roots.join("、")}` : "请先在运行时配置中添加允许的工作目录根")) : null);
}

/**
 * 从别处（例如待办记录）发起对话：把引用内容写进「新建会话」的首条消息，再切到新建页。
 * 一个新建会话只关联一条待办 / 一个推荐任务：带引用再次发起时，替换上一次的引用和草稿
 * （正文、随引用复制的图片一起换掉），不把两条引用拼在一起。正文里只留一条引用，会话也只有一条关联。
 * 不带引用（只是把一段文字带进新建页）时仍按追加处理，方便连着攒需求。
 */
function rtStartNewSession(prompt, noteRef) {
  // 从待办记录、推荐任务、记忆条目发起：提交后要问用户是看对话还是回到刚才那一页
  rtMarkNewEntry("ref");
  const text = String(prompt || "").trim();
  const association = !!(noteRef && (noteRef.noteId || noteRef.recommendationId));
  if (association) {
    const draft = rtImageDraft("new"), pending = draft.pending;
    const replaced = !!(String(draft.text || "").trim() || draft.images.length || draft.noteRef || draft.recommendationRef);
    if (replaced) {
      rtClearImageDraft("new");
      if (typeof announce === "function") announce("已替换为这次的引用：一个新建会话只关联一条待办或一个推荐任务");
    }
    // 正在提交的请求要留着核对结果，不能被替换掉
    if (pending) rtImageDraft("new").pending = pending;
  }
  const target = rtImageDraft("new");
  if (text) {
    const existing = (target.text || "").replace(/\s+$/, "");
    target.text = existing ? `${existing}\n\n${text}` : text;
  }
  // 从待办 / 推荐任务发起的会话：记住是哪条记录，创建后在会话详情里显示并能标记完成
  if (noteRef && noteRef.noteId) { target.noteRef = { noteId: noteRef.noteId }; delete target.recommendationRef; }
  if (noteRef?.recommendationId) { target.recommendationRef = { taskId: noteRef.recommendationId, revision: noteRef.revision }; delete target.noteRef; }
  rtSaveImageDraft("new");
  if (ui.rt.form) ui.rt.form.prompt = rtImageDraft("new").text;
  ui.rt.confirm = null;
  ui.rt.formError = "";
  if (ui.rt.launch?.req) ui.rt.launch = null;
  if (location.hash === "#/rt/new") renderMain();
  else location.hash = "#/rt/new";
}

function rtModuleReady(name) { return !globalThis.piRouteModules || (piRouteModules.has(name) && piRouteModules.state(name) === 'ready'); }
function rtRenderSoft() { if (rtModuleReady('rt-detail') && typeof rtDetailRenderSoft === 'function') rtDetailRenderSoft(); }
function rtRenderListOnly() { if (rtModuleReady('rt-list') && typeof rtDirectoryRenderListOnly === 'function') rtDirectoryRenderListOnly(); }



/** 折叠内容在首次展开时生成；更新时保留 session 内的展开状态。 */
function rtRememberFolds(node) {
  const folds = [...node.querySelectorAll("details[data-rt-fold]")];
  if (node.matches("details[data-rt-fold]")) folds.push(node);
  for (const fold of folds) (ui.rt.openFolds ||= {})[fold.dataset.rtFold] = fold.open;
}
/* 部署状态在三处显示：会话列表（目录条目的 deploy）、会话头部与关联部署的快捷回复（ui.rt.deploy）。两份数据来源不同，
 * 这里让它们互相校正：目录推来的标记和头部不一致就重读头部；头部读到新状态就按同一份请求列表改写列表标记。 */

/** 头部这份部署信息对某个会话意味着的列表标记（与服务端 withDeploy 同口径） */
function rtDeployMarker(info, id) {
  if (!info) return null;
  const reqs = (info.requests || []).filter((q) => q.notifySession === id);
  const q = reqs.find((x) => x.startedAt) || reqs[0];
  if (q) return { action: q.action, expectedLive: q.expectedLive, id: q.id, notifySession: q.notifySession, progress: q.progress, staging: q.staging, stage: q.stage, state: q.startedAt ? "started" : "pending", sha: q.sha, subject: q.subject, requestedAt: q.requestedAt, ...(q.startedAt ? { startedAt: q.startedAt } : {}), ...(q.wait ? { wait: { kind: q.wait.kind, short: q.wait.short, detail: q.wait.detail } } : {}) };
  const ar = info.autoResolve;
  if (ar && ar.phase !== "queued" && ar.session === id) return { state: ar.phase, sha: ar.head || "", subject: ar.phase === "needs-human" ? ar.reason || "" : (ar.conflicts || []).join("、"), requestedAt: ar.at };
  return null;
}
const rtMarkerState = (m) => m ? JSON.stringify([m.id, m.state, m.sha, m.staging, m.stage, m.action, m.startedAt, m.requestedAt, m.progress, m.wait]) : "";

/** 这个会话的请求：有正在部署的就取它，否则取最早排队的（与列表标记同口径） */
const rtDeployMine = (d, id) => { const reqs = d ? (d.requests || []).filter((q) => q.notifySession === id) : []; return reqs.find((q) => q.startedAt) || reqs[0]; };
/** 授权入口的弹层：只放权限相关提示；打开时收起其它标题行弹层。 */
function rtToggleNotice(open) {
  if (open && ui.rt.noteOpen) rtToggleNote(false);
  if (open && ui.rt.recommendationOpen) rtToggleRecommendation(false);
  ui.rt.noticeOpen = !!open;
  const wrap = document.querySelector(".rt-head .rt-grant");
  if (!wrap) return;
  wrap.classList.toggle("open", !!open);
  wrap.querySelector(".rt-notice-tag")?.setAttribute("aria-expanded", String(!!open));
  if (open) { wrap.querySelector(".rt-notice-sheet button")?.focus(); if (ui.rt.view?.session?.runtimeKind === "pi") void rtLoadRuntimeGrants(); }
  else wrap.querySelector(".rt-notice-tag")?.focus();
}
/** 推荐任务入口的弹层：和授权入口分开，避免授权弹层混入非授权提示。 */
function rtToggleRecommendation(open) {
  if (open && ui.rt.noteOpen) rtToggleNote(false);
  if (open && ui.rt.noticeOpen) rtToggleNotice(false);
  ui.rt.recommendationOpen = !!open;
  if (open) void rtLoadLinkedNote(rtId(), ui.rt.gen);
  const wrap = document.querySelector(".rt-head .rt-recommendation");
  if (!wrap) return;
  wrap.classList.toggle("open", !!open);
  wrap.querySelector(".rt-rec-tag")?.setAttribute("aria-expanded", String(!!open));
  if (open) wrap.querySelector("#rt-rec-sheet button")?.focus();
  else wrap.querySelector(".rt-rec-tag")?.focus();
}
/** 关联待办的小弹层：和授权 / 推荐任务分开，点在标题行的待办图标上打开。 */
function rtToggleNote(open) {
  if (open && ui.rt.noticeOpen) rtToggleNotice(false);
  if (open && ui.rt.recommendationOpen) rtToggleRecommendation(false);
  ui.rt.noteOpen = !!open;
  if (open) void rtLoadLinkedNote(rtId(), ui.rt.gen);
  const wrap = document.querySelector(".rt-head .rt-note-pop");
  if (!wrap) return;
  wrap.classList.toggle("open", !!open);
  wrap.querySelector(".rt-note-tag")?.setAttribute("aria-expanded", String(!!open));
  if (open) wrap.querySelector(".rt-note-sheet button")?.focus();
  else wrap.querySelector(".rt-note-tag")?.focus();
}

/** 手机端标题被单行截断时，展开的详情里补上完整标题（宽度变化后重新判断）。 */
function rtSyncSubTitle() {
  const text = document.querySelector(".rt-head-phone .rt-title-text");
  const full = document.querySelector(".rt-head-phone .rt-sub-full-title");
  if (!text || !full) return;
  full.classList.toggle("truncated", text.scrollWidth > text.clientWidth + 1);
}

// Page effects have one owner and are stopped on route leave. Global live sync,
// unread, notifications, PWA and artifact catalog keep their separate owners.
const rtPageEffects = new Map();
let rtWorkspaceEffectsActive = false;
function rtSyncPageEffects() {
  if(typeof rtPatchMemoryDialog === 'function') rtPatchMemoryDialog();
  const directory = rtDirectoryVisible() && rtModuleReady('rt-list');
  if (typeof rtDirectoryEffects === 'function') rtDirectoryEffects(directory);
  const workspace = ['rt-new','rt-room-new'].includes(ui.view) || (ui.view === 'rt' && !!rtId() && rtModuleReady('rt-detail'));
  if (workspace !== rtWorkspaceEffectsActive) {
    rtWorkspaceEffectsActive = workspace;
    document[workspace ? 'addEventListener' : 'removeEventListener']('click', rtWorkspaceOutsideClick);
    document[workspace ? 'addEventListener' : 'removeEventListener']('keydown', rtWorkspaceKeydown);
  }
  const wanted = new Map();
  if (['rt','rt-new','rt-room','rt-room-new','rt-compare'].includes(ui.view) && rtModuleReady('rt-list')) wanted.set('visible-times', [rtTickVisibleTimes, 1000]);
  if (['rt','rt-new','runtimes','resources'].includes(ui.view)) wanted.set('quota-countdowns', [rtTickCountdowns, 30000]);
  if (['rt-new','runtimes'].includes(ui.view) || rtConversationVisible()) wanted.set('quota-refresh', [rtRefreshQuotas, 15000]);
  for (const [key, id] of rtPageEffects) if (!wanted.has(key)) {clearInterval(id); rtPageEffects.delete(key);}
  for (const [key, [tick, period]] of wanted) if (!rtPageEffects.has(key)) rtPageEffects.set(key, setInterval(tick, period));
  void rtLoadVisibleUsage();
}
// Visibility is a single document owner; only active page effects are awakened.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  rtVisibleReadsChanged({directory: true});
  if (rtPageEffects.has('quota-countdowns')) rtTickCountdowns();
  if (rtPageEffects.has('quota-refresh')) void rtRefreshQuotas();
});

/* ------------------------------ 后台创建会话 ------------------------------ */
/*
 * 提交新建后不再停在等待页：表单立刻清空，检查与创建请求在后台完成，
 * 会话列表顶部显示「正在创建」条目；成功后它自己变成列表里的正式会话。
 * 请求键固定在条目上，失败（含重启切换造成的 502/503）会自动用同一个键重试，不会重复创建。
 */
const RT_BG_STORAGE = "pi.rt.bgJobs.v1";
const RT_BG_RETRY_MS = [2000, 4000, 8000, 15000];
function rtBgJobs() {
  if (!ui.rt.bg) {
    ui.rt.bg = [];
    try {
      for (const j of JSON.parse(localStorage.getItem(RT_BG_STORAGE) || "[]"))
        if (j?.req?.key) ui.rt.bg.push({ req: j.req, form: j.req, images: [], phase: "create", running: false, attempt: 0, unknown: true, ...(j.origin?.hash ? { origin: j.origin } : {}), error: "页面刷新前未确认发送。点重试会用同一个请求键核对，不会重复创建。" });
    } catch { /* 存储不可用时只保留内存 */ }
  }
  return ui.rt.bg;
}
function rtBgPersist() { try { localStorage.setItem(RT_BG_STORAGE, JSON.stringify(rtBgJobs().map((j) => ({ req: j.req, ...(j.origin?.hash ? { origin: j.origin } : {}) })))); } catch { /* 忽略 */ } }
/** PC 上正在看这个后台条目的「创建中」详情页时整页重绘，其余情况只刷新列表。 */
const rtBgRender = () => {
  try {
    if (ui.view === "rt-new" && ui.rt.launch && rtBgJobs().includes(ui.rt.launch)) renderMain();
    else rtRenderListOnly();
  } catch { /* 列表未加载 */ }
};
function rtBgBody(r) {
  return {
    idempotencyKey: r.key, ...(r.scheduledFor ? { scheduledFor: r.scheduledFor } : {}), runtimeKind: r.runtimeKind, workspace: r.workspace, prompt: r.prompt, attachmentIds: r.attachmentIds || [],
    ...(r.model ? { model: r.model } : {}), ...(r.effort ? { effort: r.effort } : {}), ...(r.worktree ? { worktree: true } : {}), ...(r.runtimeKind === "pi" && r.browserProfileId ? { browserProfileId: r.browserProfileId } : {}),
    ...(r.recommendationRef ? { recommendationId: r.recommendationRef.taskId, recommendationRevision: r.recommendationRef.revision } : r.noteId ? { noteId: r.noteId } : {}),
    permissionMode: r.permissionMode, confirmedProfileVersion: r.profileVersion
  };
}
function rtBgSubmit(req, images, origin) {
  // form 是创建中详情页（rtLaunchView）读取的字段名：与请求同一份配置；origin 是这次会话的发起场景
  const job = { req, form: req, images: images || [], phase: "check", running: false, attempt: 0, error: "", ...(origin?.hash ? { origin } : {}) };
  rtBgJobs().push(job); rtBgPersist(); rtBgRender();
  void rtBgRun(job);
  return job;
}
function rtBgRemove(job) { const jobs = rtBgJobs(), i = jobs.indexOf(job); if (i >= 0) jobs.splice(i, 1); rtBgPersist(); rtBgRender(); }
/** 「正在创建」条目当前的位置：创建成功把它收进时钟时用作动效起点 */
function rtBgJobRect(job) {
  const row = [...document.querySelectorAll("[data-rt-bg-job]")].find((n) => n.dataset.rtBgJob === job.req.key);
  return row ? row.getBoundingClientRect() : null;
}
async function rtBgRun(job) {
  if (job.running) return;
  job.running = true; job.error = ""; job.unknown = false; clearTimeout(job.retryTimer); job.retryTimer = null;
  const r = job.req;
  try {
    let res;
    for (let profileRetry = 0; ; profileRetry++) {
      try {
        if (!r.profileVersion) {
          job.phase = "check"; rtBgRender();
          const p = (ui.rt.profiles || []).find((x) => x.runtimeKind === r.runtimeKind);
          if (!p) throw Object.assign(new Error("先到运行时配置检查连接"), { status: 400 });
          if (p.state !== "executable") throw Object.assign(new Error(`${RT_KIND[r.runtimeKind]} 当前不可执行：${p.stateReason}`), { status: 400 });
          const prev = await api(`/api/runtime-profiles/${r.runtimeKind}/settings-preview?cwd=${encodeURIComponent(r.workspace)}&permissionMode=${encodeURIComponent(r.permissionMode)}&model=${encodeURIComponent(r.model || "")}`);
          if (prev.profileVersion !== p.checkedAt) throw Object.assign(new Error("运行时能力已更新，点重试会重新检查"), { status: 409, recheck: true });
          r.profileVersion = prev.profileVersion; rtBgPersist();
        }
        job.phase = "create"; rtBgRender();
        res = await api("/api/runtime-sessions", { method: "POST", onDeploymentWait: () => { job.phase = "deployment"; rtBgRender(); }, body: JSON.stringify(rtBgBody(r)) });
        break;
      } catch (e) {
        const profileChanged = !!(e.recheck || (e.status === 409 && /重新检查过/.test(e.message || "")));
        if (!profileChanged || profileRetry >= 1) throw e;
        // 后台连接检查在提交途中完成会刷新 profileVersion：刷新配置后无感重试一次，不打断已发出的新建会话。
        const staleVersion = r.profileVersion || (ui.rt.profiles || []).find((x) => x.runtimeKind === r.runtimeKind)?.checkedAt;
        delete r.profileVersion; rtBgPersist();
        await rtLoadProfiles();
        if (staleVersion && (ui.rt.profiles || []).find((x) => x.runtimeKind === r.runtimeKind)?.checkedAt === staleVersion) {
          await rtLoadProfiles();
        }
      }
    }
    const id = res.session.platformSessionId;
    // 预约会话：条目在会话列表里就先把位置量下来，重绘后它就不在了
    const flyFrom = r.scheduledFor ? rtBgJobRect(job) : null;
    // 从今天卡片发起的推荐任务：待办页可能已经返回并停在屏幕上，就地刷新推荐栏。
    if (r.recommendationRef && typeof noteRecommendationLaunched === "function") noteRecommendationLaunched(r.recommendationRef.taskId, id);
    const deferred = !(res.session.turns?.length);
    sessionSnapshotPut(`rt:${id}`, {
      view: { session: res.session, readOnly: false, approvals: [], notes: [], usage: { semantics: "正在读取用量…" } }, events: [],
      ...(deferred ? {} : { initialOutgoing: { text: r.prompt, images: job.images, accepted: true, seq: 0,
        ...(res.session.turns?.[0]?.clientMessageId ? { eventKey: `user:${res.session.turns[0].clientMessageId}` } : {}) } }),
      atBottom: true, reading: { atBottom: true, top: 0 }
    });
    // 还停在这个会话的「创建中」页（手机同样）：原地换成真实会话详情；用户已经去了别处就不抢焦点。
    const watching = ui.view === "rt-new" && ui.rt.launch === job;
    // 已经切到其他应用 / 窗口失焦时不要把页面带走：切回来时仍停在离开前的创建页。
    const away = watching && rtPageAway();
    if (ui.rt.launch === job) ui.rt.launch = null;
    // 创建期间在输入框里先写的草稿，带进新会话
    if (job.draft?.trim()) { ui.rt.drafts[id] = job.draft; rtSaveImageDraft(id, job.draft); }
    if (away) {
      // 把「创建中」原地换成「已创建」，不跳转；用户回来后自己点「打开会话」。
      job.phase = "done"; job.createdId = id;
      ui.rt.launch = job;
      rtBgRemove(job);
      announce(r.scheduledFor ? "会话已创建，预约消息在会话列表的时钟里" : "会话已创建，在会话列表中");
      if (ui.view === "rt-new") renderMain();
    } else {
      rtBgRemove(job);
      // 预约会话创建成功：不弹预约列表，把条目收进右上角时钟，要看再点时钟
      if (flyFrom) rtScheduledFly({ runtimeKind: r.runtimeKind, model: r.model, text: (r.prompt || "").trim().split("\n")[0].slice(0, 28) || "预约消息" }, flyFrom);
      announce(r.scheduledFor ? `已创建：首条消息预约于 ${rtScheduleLabel(r.scheduledFor)}，可在会话列表的时钟里查看` : deferred ? "已创建：首条消息将在部署完成后发送" : watching ? "会话已创建" : "会话已创建，在会话列表中");
      // 手机：把新建页换成交互历史里的会话列表，再压入详情页，系统返回时直接回列表
      if (watching) {
        rtPrepareDetailOrigin(id, job.origin || null);
        if (rtPhone.matches) rtEnterCreated(`#/rt/${id}`); else location.replace(`#/rt/${id}`);
      }
    }
    void rtLoadDir().then(rtBgRender);
  } catch (e) {
    const unknown = !e.status || e.status >= 500 || e.status === 408;
    job.unknown = unknown;
    if (e.recheck || (e.status === 409 && /重新检查过/.test(e.message))) { delete r.profileVersion; rtBgPersist(); void rtLoadProfiles(); }
    job.recommendationChanged = e.status === 409 && !!r.recommendationRef && /推荐版本已变化|推荐正在更新、已过期或需要先决策|来源已变化，请重新生成推荐/.test(e.message);
    job.error = job.recommendationChanged ? "原推荐已变化，尚未创建会话。可按当前内容创建独立会话。" : unknown ? `${e.message}（结果未知，重试会用同一个请求键核对，不会重复创建）` : e.message;
    if (unknown && job.attempt < RT_BG_RETRY_MS.length) {
      const wait = RT_BG_RETRY_MS[job.attempt++];
      job.retryTimer = setTimeout(() => { job.retryTimer = null; void rtBgRun(job); }, wait);
      job.error = `${e.message}，${Math.round(wait / 1000)} 秒后自动重试`;
    }
  } finally { job.running = false; rtBgRender(); }
}
/** 放弃：把消息放回新建页输入框，不丢内容 */
function rtBgGiveBack(job) {
  clearTimeout(job.retryTimer);
  if (ui.rt.launch === job) ui.rt.launch = null;
  const d = rtImageDraft("new");
  if (!d.text.trim()) { d.text = job.req.prompt; rtSaveImageDraft("new"); if (ui.rt.form) ui.rt.form.prompt = d.text; }
  rtBgRemove(job);
  if (ui.view === "rt-new") renderMain();
}
/** 原推荐已变化：丢掉推荐引用，按当前内容创建独立会话（换一个请求键，重新核对配置）。 */
function rtBgRecreateStandalone(job) {
  delete job.req.recommendationRef; job.req.key = rtKey(); delete job.req.profileVersion; job.attempt = 0;
  rtBgPersist(); void rtBgRun(job);
}
/** 手机从会话列表提交后的去向：从哪来回哪去；没有来处（直接打开 / 刷新）就回会话列表。 */
function rtLeaveNewAfterSubmit() {
  const o = ui.rt.newOrigin;
  if (o?.hash && o.steps === 1) history.back();
  else location.replace(o?.hash || "#/rt");
}
/**
 * 进入新建页的入口标记：点列表上的「＋ 新建会话」打 "list"，待办 / 记忆 / 图片导入等别处发起打各自的来源。
 * 只认最近这几秒内的标记——点了按钮又没离开页面时不会留到下一次进入。
 */
const RT_NEW_ENTRY_MS = 4000;
let rtNewEntry = null;
function rtMarkNewEntry(source) { rtNewEntry = { source: source || "other", at: Date.now() }; }
/**
 * 新建页是从会话列表点进来的吗：只有从别处发起（待办引用、记忆问询、图片导入）才不是。
 * 没打标记（直接打开地址、系统快捷方式）或打的 "list"，都按会话列表来，提交后不问去向；
 * 没有标记时退回按来处判断：没有来处、来处是列表，或 PC 上来自列表旁的会话详情（列表一直在左边）。
 */
function rtNewFromList() {
  const o = ui.rt.newOrigin;
  if (o?.entry) return o.entry === "list";
  const h = o?.hash;
  return !h || h === "#/rt" || (!rtPhone.matches && /^#\/rt\/r[tx]-[a-z0-9]+$/.test(h));
}
/* ------------------------------ 会话详情的进入来源 ------------------------------ */
/*
 * 详情页的「← 待办」扒边入口只反映「本次从哪里进入这条会话」：
 * - 每次路由进入 #/rt/<id> 时刷新进入来源，不再按会话 ID 持久化到本地存储；
 * - 从待办、记忆、产物、群聊、对比、设置或另一条会话正文链接进来，显示对应返回来源；
 * - 从其他页面发起新建并停留在「创建中」直进详情页，继承本次新建的发起场景；
 * - 从会话列表、主导航「会话」入口、或冷打开/刷新进入，来源清空，不显示扒边；
 * - 离开该会话详情（回列表、点扒边返回、切到任何其他页面）立即清空，不残留到下次。
 */
const RT_DETAIL_ENTRY_MS = 4000;
let rtDetailEntry = null;
/** 标记即将进入会话详情的入口性质："list"（会话列表）、"nav"（主导航会话按钮）、"back"（点扒边返回）。 */
function rtMarkDetailEntry(source) { rtDetailEntry = { source: source || "list", at: Date.now() }; }
/** 「创建中」直进刚创建的详情页前交接本次发起场景；列表发起传 null。 */
function rtPrepareDetailOrigin(id, origin) {
  if (!id) return;
  rtDetailEntry = {
    source: "create",
    id,
    origin: origin?.hash ? { hash: origin.hash, label: origin.label || rtSceneLabel(origin.hash) } : null,
    at: Date.now(),
  };
}
/** 页面地址 → 场景名，用作「← 待办」这类入口文案。 */
function rtSceneLabel(hash) {
  const parts = String(hash || "").replace(/^#/, "").split(/[?#]/)[0].split("/").filter(Boolean);
  const top = parts[0] || "";
  if (top === "rt") {
    if (parts[1] === "room") return "群聊";
    if (parts[1] === "compare") return "对比";
    return "会话";
  }
  const labels = { resources: "资源", notes: "待办", artifacts: "产物", ledger: "股票", communications: "通讯录", memory: "记忆", "web-x": "AI 浏览器", settings: "设置", stats: "统计", "open-source-release": "开源发布" };
  return labels[top] || "之前的页面";
}
/** 提交时交出这次会话的发起场景：从会话列表或直接打开新建页进来时没有来处，返回 null。 */
function rtNewSubmitOrigin() {
  if (rtNewFromList()) return null;
  const hash = ui.rt.newOrigin?.hash;
  return hash ? { hash, label: rtSceneLabel(hash) } : null;
}
function rtDetailIdFromHash(hash) {
  const m = String(hash || "").match(/^#\/rt\/([^/?#]+)$/);
  if (!m || m[1] === "new" || m[1] === "room" || m[1] === "compare") return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}
/** 判断上一步地址能不能作为这次进入会话详情的来源：会话列表、新建页、空地址与当前会话本身都不算。 */
function rtDetailOriginFromHash(id, previousHash) {
  if (!previousHash) return null;
  if (previousHash === "#/rt" || /^#\/rt\/(?:room\/)?new(?:[?#]|$)/.test(previousHash)) return null;
  if (previousHash === `#/rt/${id}` || previousHash === `#/rt/${encodeURIComponent(id)}`) return null;
  return { hash: previousHash, label: rtSceneLabel(previousHash) };
}
/** 路由切换时刷新本次会话详情的进入来源；离开会话详情时清空。 */
function rtRefreshDetailOrigin(id, previousView, previousHash) {
  const mark = rtDetailEntry && Date.now() - rtDetailEntry.at < RT_DETAIL_ENTRY_MS ? rtDetailEntry : null;
  rtDetailEntry = null;
  if (!id) { ui.rt.originVisit = null; return null; }
  let origin = null;
  if (mark?.source === "create" && mark.id === id) origin = mark.origin || null;
  else if (mark?.source === "list" || mark?.source === "nav" || mark?.source === "back") origin = null;
  else origin = rtDetailOriginFromHash(id, previousHash);
  ui.rt.originVisit = origin ? { id, origin } : null;
  return origin;
}
/** 详情页的「← 待办」返回来源链接。 */
function rtOriginLink(origin, className) {
  if (!origin?.hash) return null;
  const label = origin.label || rtSceneLabel(origin.hash);
  return h("a", { class: `rt-origin${className ? ` ${className}` : ""}`, href: origin.hash, "data-rt-origin": origin.hash, title: `回到${label}页面`, "aria-label": `回到${label}`, onclick: () => rtMarkDetailEntry("back") },
    h("span", { class: "rt-origin-arrow", "aria-hidden": "true" }, "←"),
    h("span", { class: "rt-origin-label" }, label));
}
/**
 * 「← 待办」扒边入口：贴在消息区左边，滚动对话时一直看得见。
 */
function rtOriginEdge(origin) {
  return rtOriginLink(origin, "rt-origin-edge");
}
/** 详情页本次停留要显示的进入来源；同一次停留里重绘/软更新继续显示内存里的那份。 */
function rtOriginForDisplay(id) {
  const visit = ui.rt.originVisit;
  if (visit && visit.id === id) return visit.origin;
  const mark = rtDetailEntry && Date.now() - rtDetailEntry.at < RT_DETAIL_ENTRY_MS ? rtDetailEntry : null;
  if (mark?.source === "create" && mark.id === id && rtDetailIdFromHash(location.hash) === id) {
    rtDetailEntry = null;
    ui.rt.originVisit = mark.origin ? { id, origin: mark.origin } : null;
    return mark.origin || null;
  }
  return null;
}
/** 兜底同步：离开当前会话地址时立即清空停留态；未挂载 app.js route() 时也能承接创建直进交接。 */
function rtEndOriginVisit() {
  const curId = rtDetailIdFromHash(location.hash);
  const mark = rtDetailEntry && Date.now() - rtDetailEntry.at < RT_DETAIL_ENTRY_MS ? rtDetailEntry : null;
  if (curId && mark?.source === "create" && mark.id === curId) {
    rtDetailEntry = null;
    ui.rt.originVisit = mark.origin ? { id: curId, origin: mark.origin } : null;
    return;
  }
  const visit = ui.rt.originVisit;
  if (!visit) return;
  if (curId && curId === visit.id) return;
  ui.rt.originVisit = null;
}
window.addEventListener("hashchange", rtEndOriginVisit);
/** 路由进入新建页时记下来处与入口；单聊 / 群聊之间切换不覆盖来处，只累计压入的历史条数。 */
function rtTrackNewOrigin(previousView, previousHash) {
  const r = ui.rt;
  const entry = rtNewEntry && Date.now() - rtNewEntry.at < RT_NEW_ENTRY_MS ? rtNewEntry.source : "";
  rtNewEntry = null;
  if ((previousView === "rt-new" || previousView === "rt-room-new") && r.newOrigin) { r.newOrigin.steps++; return; }
  r.newOrigin = { hash: previousHash && !/^#\/rt\/(?:room\/)?new$/.test(previousHash) ? previousHash : null, steps: 1, entry };
}
function rtBgJobsNode() {
  const jobs = rtBgJobs();
  if (!jobs.length) return null;
  const label = (j) => j.error ? (j.retryTimer ? "创建遇到问题，稍后自动重试" : "创建未完成") : j.phase === "check" ? "正在检查配置" : j.phase === "deployment" ? "部署完成后自动发送" : "正在创建会话";
  // PC：点条目打开它的「创建中」详情页（版式同会话详情）；手机上留在列表
  const open = (j) => { ui.rt.launch = j; if (location.hash === "#/rt/new") renderMain(); else location.hash = "#/rt/new"; };
  return h("ul", { class: "rt-ul rt-bg-jobs", "aria-label": "正在创建的会话" }, jobs.map((j) => h("li", { class: `rt-bg-job${j.error && !j.retryTimer ? " failed" : ""}${rtPhone.matches ? "" : " openable"}${ui.view === "rt-new" && ui.rt.launch === j ? " active" : ""}`, role: "status", "data-rt-bg-job": j.req.key,
    onclick: rtPhone.matches ? null : (ev) => { if (!ev.target.closest("button")) open(j); } },
    h("div", { class: "rt-bg-title" }, j.error && !j.retryTimer ? null : h("span", { class: "rt-thinking-dot", "aria-hidden": "true" }),
      h("span", { class: "rt-bg-text" }, (j.req.prompt || "").trim().split("\n")[0].slice(0, 60) || "（图片消息）")),
    h("div", { class: "muted small" }, `${RT_KIND[j.req.runtimeKind] || j.req.runtimeKind} · ${rtFolderName(j.req.workspace)} · ${label(j)}`),
    j.error ? h("div", { class: "field-error small" }, j.error) : null,
    j.error && !j.running ? h("div", { class: "rt-actions" },
      j.recommendationChanged
        ? h("button", { type: "button", class: "btn small primary", onclick: () => rtBgRecreateStandalone(j) }, "按当前内容创建")
        : h("button", { type: "button", class: "btn small primary", onclick: () => { j.attempt = 0; void rtBgRun(j); } }, "立即重试"),
      h("button", { type: "button", class: "btn small", onclick: () => rtBgGiveBack(j) }, "放回输入框")) : null)));
}

/* ------------------------------ 预约发送 ------------------------------ */
function rtScheduleLocal(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
/** datetime-local 的墙上时间 → 绝对时间。夏令时回退的那一小时里同一个墙上时间出现两次，
 *  浏览器默认取较早的一次（于是预约比用户选的时间早 1 小时）；预约是"将来的时间"，取较晚的那次。 */
function rtScheduleParse(value) {
  const naive = Date.parse(value);
  if (!Number.isFinite(naive)) return NaN;
  const candidates = [naive, naive + 3600000].filter(t => rtScheduleLocal(t) === value);
  return candidates.length ? Math.max(...candidates) : naive;
}
function rtScheduleLabel(iso) { return new Date(iso).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
/** 预约倒计时：到点前显示还要等多久，到点后说明在等发送 */
function rtScheduleCountdown(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "已到点，等待发送";
  if (ms < 60000) return "不到 1 分钟后";
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `还有 ${m} 分钟`;
  const h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d) return `还有 ${d} 天${h % 24 ? ` ${h % 24} 小时` : ""}`;
  return `还有 ${h} 小时${m % 60 ? ` ${m % 60} 分钟` : ""}`;
}
function rtGearIcon() { return rtMiniIcon(['M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0', 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'], { size: 18 }); }
function rtClockIcon() { return rtMiniIcon(['M12 8v4l3 2', 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0'], { size: 18 }); }

/*
 * 预约弹窗只在点时钟时打开：点条目进会话、用系统返回回到列表都不自动重开。
 * 以前按历史条目恢复弹窗，用户从列表返回时会莫名弹出预约列表。
 */
function rtScheduledClockButton() {
  return [...document.querySelectorAll(".rt-list-head button.rt-icon-link")].find((b) => (b.getAttribute("aria-label") || "").startsWith("预约发送消息")) || null;
}
let rtScheduledClockPulseTimer = null;
/** 落点反馈：时钟轻微放大回弹，新数字跟着弹一下。列表重绘会换掉按钮，所以每次重新查。 */
function rtScheduledClockPulse() {
  const clock = rtScheduledClockButton();
  if (!clock) return;
  clearTimeout(rtScheduledClockPulseTimer);
  clock.classList.remove("rt-clock-receive"); void clock.offsetWidth; clock.classList.add("rt-clock-receive");
  rtScheduledClockPulseTimer = setTimeout(() => clock.classList.remove("rt-clock-receive"), 700);
}
/**
 * 预约会话创建成功：创建中条目收成一张小卡片，沿弧线缩小落进右上角时钟，不弹预约列表。
 * rect 是条目消失前的位置；用户不在会话列表（拿不到条目或时钟）时退回只更新计数，不动效。
 */
function rtScheduledFly(fly, rect) {
  if (!fly || !rect || !rtScheduledClockButton()) return false;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) { rtScheduledClockPulse(); return true; }
  const target = rtScheduledClockButton().getBoundingClientRect();
  const chip = h("div", { class: "rt-schedule-fly", "aria-hidden": "true" },
    rtAvatar(fly.runtimeKind, fly.model),
    h("span", { class: "rt-schedule-fly-text" }, fly.text));
  // 卡片从条目原位起飞：宽高取条目尺寸，看上去就是那条「正在创建」被收起来
  chip.style.left = `${rect.left}px`;
  chip.style.top = `${rect.top}px`;
  chip.style.width = `${rect.width}px`;
  chip.style.height = `${rect.height}px`;
  document.body.append(chip);
  const dx = target.left + target.width / 2 - (rect.left + rect.width / 2);
  const dy = target.top + target.height / 2 - (rect.top + rect.height / 2);
  let settled = false;
  const land = () => { if (settled) return; settled = true; chip.remove(); rtScheduledClockPulse(); };
  const anim = chip.animate([
    { transform: "translate(0px, 0px) scale(1)", opacity: 1, offset: 0 },
    { transform: `translate(${dx * 0.55}px, ${dy * 0.55 - 64}px) scale(.72)`, opacity: 0.95, offset: 0.5 },
    { transform: `translate(${dx}px, ${dy}px) scale(.08)`, opacity: 0.2, offset: 1 }
  ], { duration: 640, easing: "ease-in-out" });
  anim.onfinish = land; anim.oncancel = () => chip.remove();
  return true;
}

/** 单击照常发送；长按只打开预约，松手不触发发送。移动、取消、离开页面均不提交。 */
function rtSchedulePress(click, open, allowed = () => true) {
  let timer, start, consumed = false;
  const cancel = () => { clearTimeout(timer); timer = null; start = null; };
  return {
    onpointerdown: e => {
      cancel(); consumed = false;
      if (e.button !== 0 || !allowed()) return;
      const button = e.currentTarget;
      start = { x: e.clientX, y: e.clientY };
      button.setPointerCapture?.(e.pointerId);
      timer = setTimeout(() => { timer = null; if (start && button.isConnected && !button.disabled && allowed()) { consumed = true; open(); } }, 500);
    },
    onpointermove: e => { if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) { consumed = true; cancel(); } },
    onpointerup: cancel,
    onpointercancel: () => { consumed = true; cancel(); },
    onlostpointercapture: cancel,
    oncontextmenu: e => { if (allowed()) e.preventDefault(); },
    onkeydown: e => { if (e.altKey && e.key === 'ArrowDown' && allowed()) { e.preventDefault(); cancel(); open(); } },
    onclick: e => { cancel(); if (consumed) { consumed = false; e.preventDefault(); return; } click(e); }
  };
}
function rtScheduleDialog(title) {
  document.querySelector('.rt-schedule-dialog')?.close();
  const previous = document.activeElement;
  const body = h('div', { class: 'rt-schedule-body' });
  const dialog = h('dialog', { class: 'rt-schedule-dialog', 'aria-label': title, onkeydown: e => { if (e.key === 'Escape') e.stopPropagation(); } },
    h('div', { class: 'rt-schedule-head' }, h('h2', {}, title), h('button', { type: 'button', class: 'btn small', 'aria-label': '关闭', onclick: () => dialog.close() }, '关闭')), body);
  const leave = () => dialog.close();
  dialog.addEventListener('close', () => {
    // 焦点只有在还停在对话框/body 上时才还原给触发器：从「预约发送」概览点进会话时，
    // 排队面板的微任务已经把焦点交给对应条目，这里再抢回去会让条目焦点丢失（机器忙时尤甚）。
    const active = document.activeElement;
    dialog.remove(); window.removeEventListener('hashchange', leave);
    if (previous?.isConnected && (!active || active === document.body || dialog.contains(active))) previous.focus();
  }, { once: true });
  window.addEventListener('hashchange', leave, { once: true });
  document.body.append(dialog); dialog.showModal();
  return { dialog, body, close: () => dialog.close() };
}
function rtScheduleOpen(submit) {
  const modal = rtScheduleDialog('预约发送');
  const input = h('input', { type: 'datetime-local', 'aria-label': '预约时间', value: rtScheduleLocal(Date.now() + 10 * 60000), min: rtScheduleLocal(Date.now() + 60000), required: true });
  const error = h('p', { class: 'field-error', role: 'alert' });
  const confirm = h('button', { type: 'submit', class: 'btn primary' }, '确认预约');
  const form = h('form', { onsubmit: async e => {
    e.preventDefault();
    const at = rtScheduleParse(input.value);
    const date = new Date(at);
    if (!Number.isFinite(at) || at <= Date.now()) { error.textContent = '请选择未来的预约时间'; return; }
    confirm.disabled = true;
    try { await submit(date.toISOString()); modal.close(); }
    catch (e) { error.textContent = e.message; confirm.disabled = false; }
  } },
    h('p', { class: 'muted small' }, `按当前设备时区（${Intl.DateTimeFormat().resolvedOptions().timeZone}）预约。关闭页面仍会发送；归档会话会取消预约。`),
    h('div', { class: 'rt-schedule-presets' }, [[10, '10 分钟后'], [60, '1 小时后']].map(([mins, label]) => h('button', { type: 'button', class: 'btn small', onclick: () => { input.value = rtScheduleLocal(Date.now() + mins * 60000); } }, label))),
    h('label', { class: 'rt-field' }, '自定义日期时间', input), error,
    h('div', { class: 'rt-schedule-actions' }, h('button', { type: 'button', class: 'btn', onclick: modal.close }, '取消'), confirm));
  modal.body.append(form); input.focus();
}
/* ------------------------------ 额度余量不足：发送前提醒 ------------------------------ */
// 任一额度窗口余量 <3% 时再发起会话 / 发送消息，大概率被额度打断：发送前提醒一次，
// 可以直接预约到下个周期（窗口重置后）再发；也可以继续发送，并选择本周期内或该 runtime 永久不再提醒。
const RT_QUOTA_LOW_REMAINING = 3;
// 与服务端额度续聊一致：重置后多等一分钟，避开两边时钟和额度刷新的误差
const RT_QUOTA_LOW_MARGIN_MS = 60_000;
/** 需要提醒时返回 { windows, resetAt, at }（at 是建议的预约时间 ISO），否则 null。rl 缺省用 runtime 配置里的额度快照。 */
function rtQuotaLowInfo(kind, model, rl) {
  const pref = ui.rt.settings?.quotaLowPromptByRuntime?.[kind];
  const now = Date.now();
  if (pref?.off || Date.parse(pref?.snoozeUntil || "") > now) return null;
  const snapshot = rl || (ui.rt.profiles || []).find(p => p.runtimeKind === kind)?.rateLimit;
  if (!snapshot?.available || !snapshot.windows?.length) return null;
  // 没有重置时间的窗口没法给出「等到什么时候」；重置时间已过的窗口是旧快照，等下一次采样
  const low = rtQuotaForModel(snapshot, kind, model).windows.filter(w => w.usedPercent != null && 100 - w.usedPercent < RT_QUOTA_LOW_REMAINING && Date.parse(w.resetsAt || "") > now);
  if (!low.length) return null;
  // 5 小时和周窗口可能同时见底：等它们全部重置，即最晚的那个
  const resetAt = Math.max(...low.map(w => Date.parse(w.resetsAt)));
  return { kind, windows: low, resetAt, at: new Date(resetAt + RT_QUOTA_LOW_MARGIN_MS).toISOString() };
}
async function rtQuotaLowRemember(kind, body) {
  try {
    ui.rt.settings = await api(`/api/runtime-profiles/${kind}/quota-low-prompt`, { method: "PUT", body: JSON.stringify(body) });
    if (ui.rt.settingsDraft) ui.rt.settingsDraft.quotaLowPromptByRuntime = ui.rt.settings.quotaLowPromptByRuntime;
    rtWriteCache();
  } catch (e) { announce(`提醒偏好没有保存：${e.message}`); }
}
/**
 * 余量不足弹窗：resolve { action: "wait" | "send" | "cancel" }。
 * scene："session" 新建会话，"message" 会话里发消息。选「仍然现在发送」时，默认勾选「本周期内不再提醒」，可改为该 runtime 永久不再提醒。
 */
function rtQuotaLowPrompt(info, scene) {
  const message = scene === "message";
  return new Promise(resolve => {
    const modal = rtScheduleDialog("额度快用完了");
    modal.dialog.classList.add("rt-quota-low-dialog");
    let settled = false, remember = true, permanent = false;
    const settle = action => { if (settled) return; settled = true; modal.close(); resolve({ action }); };
    modal.dialog.addEventListener("close", () => { if (!settled) { settled = true; resolve({ action: "cancel" }); } }, { once: true });
    const remain = w => `${rtQuotaWindowName(w)}只剩 ${rtQuotaLeftPct(w.usedPercent) ?? 0}%`;
    const rememberLabel = h("span", {});
    const switchBtn = h("button", { type: "button", class: "btn-link small", "data-quota-low-scope": "" });
    const sync = () => {
      rememberLabel.textContent = permanent ? `${RT_KIND[info.kind]} 永久不再提醒（可在 设置 → 运行时 里改回）` : "本周期内不再提醒";
      switchBtn.textContent = permanent ? "改为仅本周期" : "改为该 runtime 永久不再提醒";
    };
    switchBtn.onclick = () => { permanent = !permanent; sync(); };
    sync();
    const check = h("input", { type: "checkbox", checked: true, "aria-label": "继续发送后不再提醒", onchange: e => { remember = e.target.checked; switchBtn.hidden = !remember; } });
    const send = h("button", { type: "button", class: "btn", "data-quota-low-send": "", onclick: async () => {
      if (remember) await rtQuotaLowRemember(info.kind, permanent ? { off: true } : { snoozeUntil: new Date(info.resetAt).toISOString() });
      settle("send");
    } }, "仍然现在发送");
    modal.body.append(
      h("p", {}, `${RT_KIND[info.kind]}：${info.windows.map(remain).join("、")}，现在${message ? "发送" : "发起会话"}容易被额度打断。`),
      h("p", {}, "下个周期 ", h("strong", { "data-quota-low-at": "" }, rtScheduleLabel(info.at)), ` 额度重置，要等到那时再${message ? "发送这条消息" : "发起会话"}吗？`),
      h("div", { class: "rt-quota-low-actions" },
        h("button", { type: "button", class: "btn primary", "data-quota-low-wait": "", onclick: () => settle("wait") }, `等到下个周期再${message ? "发送" : "发起"}`),
        send),
      h("div", { class: "rt-quota-low-remember small" },
        h("label", { class: "rt-check" }, check, " ", rememberLabel), switchBtn));
    modal.dialog.querySelector("[data-quota-low-wait]").focus();
  });
}
/** 预约后直接进入「预约发送消息」列表：不在会话列表就先回去，再打开弹窗。 */
function rtShowScheduledList() {
  const open = () => { if (location.hash === "#/rt") void rtScheduledOverview(); };
  if (location.hash === "#/rt") { open(); return; }
  window.addEventListener("hashchange", () => setTimeout(open, 0), { once: true });
  location.hash = "#/rt";
}
/** 预约时间的口语化写法：今天 14:30 / 明天 09:00 / 11月28日 09:00 */
function rtScheduledClock(iso) {
  const at = new Date(iso), now = new Date();
  const hm = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(at) - day(now)) / 86400000);
  if (diff === 0) return `今天 ${hm}`;
  if (diff === 1) return `明天 ${hm}`;
  return `${at.getMonth() + 1}月${at.getDate()}日 ${hm}`;
}
/** 列表分组：已到点 / 今天 / 明天 / 更晚（messages 已按时间从近到远排好） */
function rtScheduledGroup(iso) {
  if (Date.parse(iso) <= Date.now()) return '已到点';
  const label = rtScheduledClock(iso);
  return label.startsWith('今天') ? '今天' : label.startsWith('明天') ? '明天' : '更晚';
}
/** 手机：底部面板；宽屏：列表右侧的展开列。顶部拖动条 / 标题行下拉超过阈值关闭；点遮罩也关闭。列表区自己滚动，不影响手势。 */
function rtScheduledSheet(modal) {
  const { dialog } = modal;
  dialog.classList.add('rt-scheduled-sheet');
  const head = dialog.querySelector('.rt-schedule-head');
  const closeBtn = head.querySelector('button');
  closeBtn.className = 'rt-sheet-close';
  closeBtn.replaceChildren(rtMiniIcon(['M6 6l12 12', 'M18 6L6 18'], { size: 18 }));
  const count = h('span', { class: 'rt-scheduled-total' });
  head.querySelector('h2').append(count);
  dialog.insertBefore(h('div', { class: 'rt-sheet-grab', 'aria-hidden': 'true' }), head);
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  // 宽屏：不再是底部面板，而是紧贴会话列表右侧展开的一列（顶端、最大高度跟列表一致）；找不到列表就居中
  const place = () => {
    if (rtPhone.matches) { dialog.style.left = dialog.style.top = dialog.style.maxHeight = ''; return; }
    const r = document.querySelector('.rt-list')?.getBoundingClientRect();
    if (!r?.width) return;
    dialog.style.left = `${Math.round(r.right + 8)}px`; dialog.style.top = `${Math.round(r.top)}px`; dialog.style.maxHeight = `${Math.round(r.height)}px`;
  };
  place();
  window.addEventListener('resize', place);
  dialog.addEventListener('close', () => window.removeEventListener('resize', place), { once: true });
  let startY = null;
  const reset = () => { dialog.style.transform = ''; dialog.style.transition = ''; startY = null; };
  for (const zone of [head, dialog.querySelector('.rt-sheet-grab')]) {
    zone.addEventListener('pointerdown', (e) => { if (rtPhone.matches || e.target.closest('button')) return; startY = e.clientY; dialog.style.transition = 'none'; zone.setPointerCapture?.(e.pointerId); });
    zone.addEventListener('pointermove', (e) => { if (startY != null) dialog.style.transform = `translateY(${Math.max(0, e.clientY - startY)}px)`; });
    zone.addEventListener('pointerup', (e) => { if (startY == null) return; const dy = e.clientY - startY; if (dy > 80) dialog.close(); else { dialog.style.transition = 'transform .16s ease-out'; reset(); } });
    zone.addEventListener('pointercancel', reset);
  }
  return { setCount: (n) => { count.textContent = n ? `${n} 条` : ''; } };
}
async function rtScheduledOverview() {
  const modal = rtScheduleDialog('预约发送消息');
  const sheet = rtScheduledSheet(modal);
  const open = (m) => {
    const target = `#/rt/${encodeURIComponent(m.platformSessionId)}`;
    ui.rt.scheduledFocus = { sid: m.platformSessionId, messageId: m.messageId };
    modal.close(); rtSetListOpen(false);
    if (location.hash === target) rtRenderSoft(); else { rtMarkDetailEntry("list"); location.hash = target; }
  };
  // 一条预约：第一行是几点发（主）+ 倒计时（辅），下面是会话标题和消息内容预览
  const row = (m) => h('li', {},
    h('button', { type: 'button', class: 'rt-scheduled-link', onclick: () => open(m) },
      rtAvatar(m.runtimeKind, m.model),
      h('span', { class: 'rt-scheduled-main' },
        h('span', { class: 'rt-scheduled-top' },
          h('strong', { class: 'rt-scheduled-time', title: `预约发送：${rtScheduleLabel(m.scheduledFor)}` }, rtScheduledClock(m.scheduledFor)),
          m.paused ? badge('已暂停', 'warn') : null,
          h('span', { class: 'rt-scheduled-countdown', 'data-rt-schedule-at': m.scheduledFor }, rtScheduleCountdown(m.scheduledFor))),
        h('span', { class: 'rt-scheduled-title' }, m.title || '未命名会话'),
        h('span', { class: 'rt-scheduled-prompt' }, m.prompt || `图片 ${m.images} 张`)),
      rtMiniIcon(['M9 6l6 6-6 6'], { className: 'rt-scheduled-chevron', size: 16 })));
  const load = async () => {
    modal.body.replaceChildren(h('p', { role: 'status' }, '正在读取预约消息…'));
    try {
      const { messages } = await api('/api/runtime-scheduled-messages');
      if (!modal.dialog.isConnected) return;
      sheet.setCount(messages.length);
      if (!messages.length) {
        modal.body.replaceChildren(h('div', { class: 'rt-scheduled-empty', role: 'status' },
          h('strong', {}, '暂无预约发送消息'),
          h('span', { class: 'muted' }, '在发送按钮上长按，可以选一个时间预约发送')));
        return;
      }
      const groups = [];
      for (const m of messages) {
        const name = rtScheduledGroup(m.scheduledFor);
        if (groups.at(-1)?.name !== name) groups.push({ name, items: [] });
        groups.at(-1).items.push(m);
      }
      modal.body.replaceChildren(...groups.map(g => h('section', { class: 'rt-scheduled-group' },
        h('h3', {}, g.name),
        h('ul', { class: 'rt-scheduled-list' }, g.items.map(row)))));
    } catch (e) {
      if (modal.dialog.isConnected) modal.body.replaceChildren(h('p', { class: 'field-error', role: 'alert' }, e.message), h('button', { class: 'btn', onclick: load }, '重试'));
    }
  };
  await load();
  if (!modal.dialog.isConnected) return;
  // 弹窗开着时原地刷新倒计时，不重绘列表、不打断点击
  const tick = () => {
    if (!modal.dialog.isConnected) { clearInterval(timer); return; }
    for (const el of modal.body.querySelectorAll('[data-rt-schedule-at]')) {
      const text = rtScheduleCountdown(el.dataset.rtScheduleAt);
      if (el.textContent !== text) el.textContent = text;
    }
  };
  const timer = setInterval(tick, 30000);
  modal.dialog.addEventListener('close', () => clearInterval(timer), { once: true });
}
function rtScheduleFocus(id) {
  const target = ui.rt.scheduledFocus;
  if (!target || target.sid !== id) return;
  queueMicrotask(() => {
    const node = [...document.querySelectorAll('[data-outbox-id]')].find(n => n.dataset.outboxId === target.messageId);
    if (!node || rtId() !== id) return;
    node.classList.add('rt-outbox-focused'); node.tabIndex = -1;
    node.scrollIntoView({ block: 'center' }); node.focus({ preventScroll: true });
    ui.rt.scheduledFocus = null;
  });
}
