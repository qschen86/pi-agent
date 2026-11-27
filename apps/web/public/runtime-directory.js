"use strict";
// Directory UI, also used by new/room/comparison routes.

function rtArchiveScroll(box) {
  if (!ui.rt.showArchived || !box?.isConnected || !box.clientHeight) return;
  const state = rtArchiveState();
  state.scroll = box.scrollTop;
  const bounds = box.getBoundingClientRect();
  let missing = null, anchored = false;
  for (const el of box.querySelectorAll('[data-archive-page]')) {
    const index = Number(el.dataset.archivePage), page = state.pages[index];
    if (!page) continue;
    const rect = el.getBoundingClientRect();
    if (page.entries) page.height = rect.height;
    if (!anchored && rect.bottom > bounds.top && rect.top < bounds.bottom) {
      anchored = true; state.anchorIndex = index;
      if (page.entries) page.used = ++state.tick;
      else missing = index;
    }
  }
  if (state.loading || state.error) return;
  if (missing != null) { void rtArchiveLoad(missing); return; }
  const last = state.pages.at(-1);
  if (!last || (last.nextCursor && box.scrollHeight - box.scrollTop - box.clientHeight < 240)) void rtArchiveLoad(state.pages.length);
}
function rtArchivePageNodes(group) {
  if (ui.rt.access?.history === false) return h("p", { class: "muted small rt-pad" }, "当前入口未启用会话查看");
  const state = rtArchiveState();
  const nodes = state.pages.map((page, index) => {
    const node = h("div", {
      "data-archive-page": String(index),
      "aria-hidden": page.entries ? null : "true"
    }, page.entries ? rtGroupByWorkspace(typeof roomFold === 'function' ? roomFold(rtcFold(rtArchiveDisplayEntries(page.entries, true, index === 0))) : rtcFold(rtArchiveDisplayEntries(page.entries, true, index === 0))).map(group) : null);
    // CSSOM properties work with style-src 'self'; a style attribute is blocked by CSP.
    if (!page.entries) node.style.height = `${page.height || 3600}px`;
    return node;
  });
  if (!state.pages.length && !state.loading && !state.error) nodes.push(h("p", { class: "muted small rt-pad" }, "加载中…"));
  if (state.loading) nodes.push(h("p", { class: "muted small rt-pad", role: "status" }, "加载中…"));
  if (state.error) nodes.push(h("p", { class: "field-error rt-pad" }, state.error, h("button", { type: "button", class: "btn small", onclick: () => { state.error = ""; void rtArchiveLoad(state.failedIndex); } }, "重试")));
  if (state.pages.length && !state.pages.at(-1).nextCursor && !state.loading) nodes.push(h("p", { class: "muted small rt-pad" }, state.total ? "已全部加载" : (ui.rt.filter.q || ui.rt.filter.runtime ? "没有符合条件的会话" : "没有已归档的会话。")));
  queueMicrotask(() => { const box = document.querySelector('.rt-list .rt-items'); if (box) rtArchiveScroll(box); });
  return nodes;
}
/** 待办（可选应用）在这个构建里是否可用：笔记模块已经加载，或路由清单里登记了它（懒加载，首次上滑时还没执行）。
 *  没有路由加载器时（精简页面）沿用原行为，当作可用；只有清单明确没有 notes 才关掉。 */
const rtNotesAvailable = () => typeof notesFocusInput === "function" || !window.piRouteModules || window.piRouteModules.has("notes");
let rtTodayListRefreshTimer = null;
/* 手机上新会话只有右下角一个「＋」：第一次进会话列表时给一次文字提示（约 6 秒），之后不再出现。
 * 提示挂在列表的「＋」上，列表每次重绘都会重建它：所以用一个截止时间，重绘后仍在提示期内就继续显示。 */
const RT_NEW_HINT_KEY = "pi-agent:rt-new-hint:v1";
let rtNewCoachUntil = 0;
function rtNewCoachMark() {
  if (!rtPhone.matches) return null;
  try { if (localStorage.getItem(RT_NEW_HINT_KEY)) return null; } catch { return null; }
  const now = Date.now();
  if (!rtNewCoachUntil) {
    rtNewCoachUntil = now + 6000;
    setTimeout(() => {
      rtNewCoachUntil = 0;
      try { localStorage.setItem(RT_NEW_HINT_KEY, "1"); } catch { /* 存储不可用时每次进列表都提示一次 */ }
      document.querySelector(".rt-new-coach")?.remove();
    }, 6000);
  }
  if (now >= rtNewCoachUntil) return null;
  return h("span", { class: "rt-new-coach", "aria-hidden": "true" }, "＋ 新建会话");
}
function rtDirectoryRenderListOnly() {
  clearTimeout(rtTodayListRefreshTimer);
  rtTodayListRefreshTimer = null;
  const old = document.querySelector(".rt-list");
  if (!old) return;
  if (rtRowPressBusy) { rtRowPressPending = true; return; }
  // 今日卡片随列表一起重建；手指按住卡片、横滑或退场提交期间都延迟刷新，避免拆掉正在处理触摸手势的节点。
  if (old.querySelector("#notes-today.is-sliding, #notes-today-body[data-today-touch], #notes-today-body[data-today-leaving]")) {
    rtTodayListRefreshTimer = setTimeout(rtDirectoryRenderListOnly, 200);
    return;
  }
  const scroll = old.querySelector(".rt-items")?.scrollTop ?? 0;
  // 正在列表里输入（如搜索框）：重绘后把焦点与光标放回去，不打断输入
  const active = document.activeElement;
  const key = active && old.contains(active) && active.dataset ? active.dataset.key : undefined;
  const sel = key && "selectionStart" in active ? [active.selectionStart, active.selectionEnd] : null;
  const next = rtList();
  old.replaceWith(next);
  rtSyncInfo(document.querySelector(".rt-layout"));
  rtSyncMobileHeader();
  const items = next.querySelector(".rt-items"); if (items) items.scrollTop = scroll;
  if (key) { const again = next.querySelector(`[data-key="${CSS.escape(key)}"]`); if (again) { again.focus(); if (sel) try { again.setSelectionRange(sel[0], sel[1]); } catch { /* 部分输入类型不支持 */ } } }
}
/** 展开 / 收起列表搜索；收起时清空搜索词与运行时筛选，恢复完整列表（筛选行是搜索区的一部分，收起后不留看不见的条件） */
function rtToggleSearch(open, setFilter) {
  ui.rt.searchOpen = open;
  clearTimeout(ui.rt.searchTimer);
  if (!open && (ui.rt.filter.q || ui.rt.filter.runtime)) { setFilter({ q: "", runtime: "" }); return; }
  rtRenderListOnly();
  if (open) document.querySelector('.rt-list [data-key="rt-search"]')?.focus();
}

function renderRtWorkbench() {
  rtSyncChrome();
  const listing = ui.rt.listOpen || rtListPage();
  const layout = h("div", { class: `rt-layout${listing ? " list-open" : ""}${rtListPage() ? " list-page" : ""}${rtListPage() && !ui.rt.lastId ? " list-root" : ""}${ui.rt.sideCollapsed ? " side-collapsed" : ""}${rtId() ? "" : " no-session"}` }, rtList(), rtCenter(), h("button", { type: "button", class: "rt-info-backdrop", tabindex: "-1", "aria-label": "关闭会话详情浮层", onclick: () => rtSetInfoOpen(false) }), rtId() ? rtSide() : null, rtId() ? rtSideHandle() : null);
  rtSyncInfo(layout);
  if (rtId() && typeof rtInstallInfoSwipe === "function") rtInstallInfoSwipe(layout);
  return h("div", { class: "rt-page" }, rtAccessNote(), layout);
}

/** 今日卡片与会话条目共用滚动区域，长列表后仍可滚动到达。 */
function rtTodayCard() {
  if (typeof noteTodaySection !== "function") return null;
  const card = noteTodaySection();
  noteInstallTodaySwipe(card.querySelector("#notes-today-body"));
  requestAnimationFrame(() => {
    if (!document.getElementById("notes-today")) return;
    noteStartCountdownTicker();
    if (noteTodayWho() === "agent") void noteLoadAgentToday({ force: false });
    else {
      if (!noteUpcomingState().loaded && !noteUpcomingState().loading) void noteLoadUpcoming();
      noteLoadTodayRecsLater();
      void noteLoadTodayOverview({ force: false });
    }
  });
  return card;
}

/* ------------------------------ 列表底部：三个 runtime 的额度 / 余额 ------------------------------ */
// 会话列表滚到底就结束了：用几行弱化文字交代「现在还能不能跑、还剩多少」。
// 数据搭会话目录这一次读带回来（服务端只读缓存，不额外请求服务商）；目录还没带上时退回 runtime 配置
// 里的快照，再退回本机上次读到的数值，所以列表首屏不会为这三行多发一条请求。
const rtSummarySnapshot = (kind) => typeof rtAccountSnapshot === "function" ? rtAccountSnapshot(kind) : null;
function rtRuntimesSummaryData(kind) {
  const profile = (ui.rt.profiles || []).find((p) => p.runtimeKind === kind);
  const directory = (ui.rt.dir?.runtimes || []).find((r) => r.runtimeKind === kind);
  // 配置刷新可能先于目录推送到达，不能让旧目录覆盖刚读到的额度或余额。
  const sampledAt = (p) => Math.max(Date.parse(p?.rateLimit?.sampledAt || "") || 0,
    ...(p?.balances || []).map((b) => Date.parse(b.balance?.fetchedAt || "") || 0));
  const fromDir = sampledAt(profile) > sampledAt(directory) ? profile : directory;
  const state = fromDir?.state ?? directory?.state ?? profile?.state;
  const dirLive = fromDir?.rateLimit && fromDir.rateLimit.windows?.length ? fromDir.rateLimit : null;
  const dirBalances = fromDir?.balances?.length ? fromDir.balances : null;
  if (dirLive || dirBalances) return { rateLimit: dirLive, balances: dirBalances, cached: false, state };
  const live = profile?.rateLimit && profile.rateLimit.available && profile.rateLimit.windows?.length ? profile.rateLimit : null;
  const balances = profile?.balances?.length ? profile.balances : null;
  if (live || balances) return { rateLimit: live, balances, cached: false, state };
  const snap = rtSummarySnapshot(kind);
  return snap ? { rateLimit: snap.rateLimit, balances: snap.balances, cached: true, state } : { rateLimit: null, balances: null, cached: false, state };
}
/**
 * 状态色阶（与新建页卡片同一口径）：已用 <80% 够用、≥80% 快不够用、≥95% 基本用完；读不到比例不着色。
 * 颜色只落在数字、图标和方框描边上，且混入弱化色，不抢会话标题。
 */
const rtSummaryTone = (pct) => pct == null ? "" : rtQuotaTone(pct).trim() || "ok";
const RT_SUMMARY_TONE_WORD = { ok: "够用", warn: "快不够用", bad: "基本用完" };
const RT_SUMMARY_TONE_RANK = { "": 0, ok: 1, warn: 2, bad: 3 };
/** 一个窗口一行：名称（5h / 周）、已用比例、重置倒计时（只留最大的一个单位；倒计时节点由 rtTickCountdowns 原地刷新）；精确口径在悬停提示里 */
function rtSummaryQuotaNodes(rl, kind = "", model) {
  const compact = kind === "antigravity" && rl.windows.some(w => w.group);
  const modelShort = compact && typeof rtQuotaModelShort === "function" ? rtQuotaModelShort(kind, model) : "";
  rl = rtQuotaForModel(rl, kind, model);
  if (!rl.windows.length) return [h("span", { class: "rt-rt-sum-item" }, "额度待确认")];
  const row = (w) => {
    const tone = rtSummaryTone(w.usedPercent), word = RT_SUMMARY_TONE_WORD[tone];
    return h("span", { class: "rt-rt-sum-item", "data-tone": tone,
      title: [`${rtQuotaWindowName(w)} 已用 ${w.usedPercent == null ? "未知" : `${Math.round(w.usedPercent)}%`}${word ? `（${word}）` : ""}`, w.resetsAt ? (!compact && w.group ? rtQuotaResetTime(w.resetsAt) : rtCountdown(w.resetsAt, "long")) : ""].filter(Boolean).join("\n") },
      h("span", { class: "rt-rt-sum-key" }, [modelShort, rtQuotaShortLabel(w.label)].filter(Boolean).join(" ")),
      h("span", { class: "rt-rt-sum-value" }, w.usedPercent == null ? "?" : `${Math.round(w.usedPercent)}%`),
      w.resetsAt ? rtResetIn(w.resetsAt, "tiny", "rt-rt-sum-reset", !compact && !!w.group) : null);
  };
  return compact ? rl.windows.map(row) : rtQuotaGroups(rl.windows).map(g => g.name ? h("span", { class: "rt-quota-group-strip" }, h("span", { class: "rt-quota-group-name" }, g.name), g.windows.map(row)) : g.windows.map(row)).flat();
}
/** 余额一行：服务商缩写 + 整数金额（只留非零的主余额，小数位让给计费时段标记）+ DeepSeek 的 1X / 0.5X；余额见底标告急，读不到不着色 */
function rtSummaryBalanceNodes(balances) {
  return balances.slice(0, 2).map(({ provider, balance: b }) => {
    const { text, empty } = rtBalanceText(b, true);
    return h("span", { class: "rt-rt-sum-item", "data-tone": empty ? "bad" : b.status === "ok" ? "ok" : "", title: rtBalanceHint(provider, b) },
      h("span", { class: "rt-rt-sum-key" }, RT_PROVIDER_SHORT[provider] || rtProviderName(provider)),
      h("span", { class: "rt-rt-sum-value" }, text),
      ...(typeof rtTariffTag === "function" ? rtTariffTag(provider, { eta: false }) : []));
  });
}
/** 点方框：带着这个 runtime 打开新建会话页（和列表上的「＋ 新建会话」同一个入口，只是预选了 runtime）。Pi 没有群聊，统一进单聊。 */
function rtSummaryStart(kind) {
  if (typeof rtMarkNewEntry === "function") rtMarkNewEntry("list");
  if (typeof rtSaveNewMode === "function") rtSaveNewMode("session");
  if (typeof rtForm === "function" && RT_KINDS.includes(kind)) {
    rtForm().runtimeKind = kind;
    if (typeof rtRuntimeDraft === "function") rtRuntimeDraft(kind);
    if (typeof rtSavePreferences === "function") rtSavePreferences();
  }
  if (ui.rt) { ui.rt.confirm = null; ui.rt.formError = ""; }
  location.hash = "#/rt/new";
}
/**
 * 会话列表底部：三个 runtime 各一个弱化的小方框，一行三个，两行高（一行一个窗口 / 一个服务商余额）。
 * 方框左边是 runtime 图标（和手机输入区的账户胶囊同一套 logo；Pi 没有单独的 logo，用 π），整个方框可点，直接用这个 runtime 新建会话。
 * 运行时不可执行时方框变灰、不可点，只写「不可用」。
 */
function rtRuntimesSummary() {
  if (typeof RT_KINDS === "undefined" || typeof rtQuotaShortLabel !== "function") return null;
  const data = new Map(RT_KINDS.map((kind) => [kind, { runtimeKind: kind, ...rtRuntimesSummaryData(kind) }]));
  const boxes = rtOrderedNewKinds([...data.values()]).map((kind) => {
    const d = data.get(kind);
    const unavailable = !!d.state && d.state !== "executable";
    const lines = unavailable
      ? [h("span", { class: "rt-rt-sum-item", "data-tone": "bad" }, h("span", { class: "rt-rt-sum-value" }, "不可用"))]
      : d.balances ? rtSummaryBalanceNodes(d.balances) : d.rateLimit ? rtSummaryQuotaNodes(d.rateLimit, kind) : [h("span", { class: "rt-rt-sum-item rt-rt-sum-empty" }, "—")];
    // 方框整体的状态 = 最差的那一项：图标和描边跟着它变色
    const tones = unavailable ? ["bad"] : d.balances ? d.balances.slice(0, 2).map(({ balance: b }) => rtBalanceText(b).empty ? "bad" : b.status === "ok" ? "ok" : "")
      : d.rateLimit ? rtQuotaForModel(d.rateLimit, kind).windows.map((w) => rtSummaryTone(w.usedPercent)) : [""];
    const tone = tones.reduce((worst, t) => RT_SUMMARY_TONE_RANK[t] > RT_SUMMARY_TONE_RANK[worst] ? t : worst, "");
    const detail = [
      d.rateLimit ? `账户额度${d.rateLimit.stale ? "（非实时）" : ""}` : d.balances ? "账户余额" : "",
      unavailable ? "当前不可执行" : "点一下用它新建会话",
      !d.rateLimit && !d.balances ? "还没读到这台机器上的额度或余额" : "",
      d.cached ? "本机上次读到的数值" : ""
    ].filter(Boolean).join("\n");
    const icon = RT_ACCOUNT_LOGO[kind] ? rtAccountLogo(RT_ACCOUNT_LOGO[kind]) : h("span", { class: "rt-rt-sum-pi", "aria-hidden": "true" }, "π");
    return h("button", { type: "button", class: "rt-rt-sum-row", "data-tone": tone, "data-runtime": kind, disabled: unavailable,
      "aria-label": unavailable ? `${RT_KIND[kind]} 不可用` : `用 ${RT_KIND[kind]} 新建会话`, title: `${RT_KIND[kind]}\n${detail}`,
      onclick: () => rtSummaryStart(kind) },
      h("span", { class: "rt-rt-sum-name", "aria-hidden": "true" }, icon),
      h("span", { class: "rt-rt-sum-lines" }, lines),
      // 右上角：有可用 reset 卡时的小标（与输入区账户胶囊同一套，数据在同一份额度快照里）
      typeof rtResetDot === "function" ? rtResetDot(kind, d.rateLimit) : null);
  });
  // 外层是容器查询的容器（容器查询只作用于它的后代），网格放在里面一层，窄列表时才能改列数。
  // 桌面侧栏窄：三块额度默认收成一行「运行时额度与余额」，点开才占三行的高度，不把仪表盘塞在会话列表的必经之路上；手机保持展开。
  const grid = h("div", { class: "rt-rt-sum-grid", "data-keep-scroll-x": "rt-runtimes-summary" }, boxes);
  const group = (child) => h("div", { class: "rt-runtimes-summary", role: "group", "aria-label": "用哪个 runtime 新建会话（附账户额度与余额）" }, child);
  if (rtPhone.matches) return group(grid);
  return group(h("details", {
    class: "rt-rt-sum-fold", open: !!ui.rt.runtimeSummaryOpen,
    ontoggle: (ev) => { ui.rt.runtimeSummaryOpen = ev.currentTarget.open; }
  },
  h("summary", { class: "rt-rt-sum-fold-head",
    // toggle 事件是异步的：点下就同步记状态，列表重绘后才不会又折回去
    onclick: (ev) => { const d = ev.currentTarget.parentElement; if (d) ui.rt.runtimeSummaryOpen = !d.open; } },
    h("span", {}, "运行时额度与余额"),
    h("span", { class: "rt-caret rt-rt-sum-fold-caret", "aria-hidden": "true" }, "›")),
  grid));
}
/**
 * 窗口已经过了重置时间、比例却还停在旧值（例如 100% 卡了好几天）：这块真的在屏幕上时补读一次额度，
 * 读完重读目录把新数值铺上。60 秒内不重复，列表滚到别处就不做。
 */
let rtSummaryOnScreen = false;
let rtSummaryObserver = null;
let rtSummaryRefreshAt = 0;
function rtListQuotaVisible() { return rtSummaryOnScreen && !!document.querySelector(".rt-rt-sum-grid")?.getClientRects().length; }
function rtSummaryRefreshStale() {
  if (!rtListQuotaVisible() || Date.now() - rtSummaryRefreshAt < 60_000) return;
  const now = Date.now();
  const due = (ui.rt.dir?.runtimes || []).filter((r) => r.runtimeKind !== "pi" && r.state === "executable"
    && r.rateLimit?.windows?.some((w) => w.resetsAt && Date.parse(w.resetsAt) <= now));
  if (!due.length) return;
  rtSummaryRefreshAt = Date.now();
  void Promise.allSettled(due.map((r) => api(`/api/runtime-profiles/${r.runtimeKind}/rate-limits`, { method: "POST", body: JSON.stringify({ automatic: true }) })))
    .then(() => rtLoadDir({ background: true }))
    .then(() => { if (rtDirectoryVisible()) rtRenderListOnly(); })
    .catch(() => { /* 读不到就继续显示上一份，服务端会标陈旧 */ });
}
function rtSummaryWatch(node) {
  if (typeof IntersectionObserver !== "function") { rtSummaryOnScreen = true; rtSummaryRefreshStale(); return; }
  if (!rtSummaryObserver) rtSummaryObserver = new IntersectionObserver((entries) => {
    rtSummaryOnScreen = entries.some((e) => e.isIntersecting);
    if (rtSummaryOnScreen) rtSummaryRefreshStale();
  });
  rtSummaryObserver.disconnect();
  rtSummaryOnScreen = false;
  rtSummaryObserver.observe(node);
}

const RT_TODAY_COLLAPSED_KEY = "pi.rt.todayCollapsed";
let rtTodayCollapsed = false;
/** 当前设备记住整个今日区域的展开状态；存储不可用时仍能在本页切换。 */
function rtTodaySegment() {
  if (typeof noteTodaySection !== "function") return null;
  try { rtTodayCollapsed = localStorage.getItem(RT_TODAY_COLLAPSED_KEY) === "true"; } catch { /* in-memory preference */ }
  const toggle = h("button", {
    type: "button", class: "rt-today-divider", "data-key": "rt-today-toggle",
    "aria-expanded": String(!rtTodayCollapsed), "aria-controls": "notes-today",
    onclick: () => {
      rtTodayCollapsed = !rtTodayCollapsed;
      try { localStorage.setItem(RT_TODAY_COLLAPSED_KEY, String(rtTodayCollapsed)); } catch { /* in-memory preference */ }
      toggle.setAttribute("aria-expanded", String(!rtTodayCollapsed));
      arrow.textContent = rtTodayCollapsed ? "▸" : "▾";
      if (rtTodayCollapsed) { if (toggle.nextElementSibling?.matches("#notes-today")) toggle.nextElementSibling.remove(); }
      else { const card = rtTodayCard(); if (card) toggle.after(card); }
    }
  }, h("span", {}, "会话到这里 · 下面是今天的日程与推荐"));
  const arrow = h("span", { class: "rt-today-arrow", "aria-hidden": "true" }, rtTodayCollapsed ? "▸" : "▾");
  toggle.append(arrow);
  return [toggle, rtTodayCollapsed ? null : rtTodayCard()];
}

/** 列表宽度的上限：不超过 480，也要给对话区（和右侧信息栏）留够位置。 */
function rtListWidthMax() {
  const layout = document.querySelector(".rt-layout");
  const side = layout?.querySelector(".rt-side");
  const sideW = side && !side.hidden && window.innerWidth > 1100 ? side.offsetWidth : 0;
  const room = layout ? layout.clientWidth - RT_CENTER_MIN - sideW : RT_LIST_W_MAX;
  return Math.max(RT_LIST_W_MIN, Math.min(RT_LIST_W_MAX, room));
}
// 取的是列宽（卡片宽 + 水平外边距）：桌面列表是带 4px 左边距的悬浮卡片，只量卡片会让每次拖动 / 方向键后宽度悄悄少 4px。
function rtListWidthNow() {
  const el = document.querySelector(".rt-list");
  if (!el) return RT_LIST_W_DEFAULT;
  const cs = getComputedStyle(el), margin = (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0);
  return Math.round(el.getBoundingClientRect().width + margin) || RT_LIST_W_DEFAULT;
}
/** width 为 null 时恢复默认（去掉覆盖，回到样式表里 300 / 260 的默认值）。 */
function rtSetListWidth(width, { save = true } = {}) {
  const root = document.documentElement;
  if (width == null) { root.style.removeProperty("--rt-list-w"); if (save) try { localStorage.removeItem(RT_LIST_W_KEY); } catch { /* in-memory preference */ } return null; }
  const w = Math.round(Math.max(RT_LIST_W_MIN, Math.min(rtListWidthMax(), width)));
  root.style.setProperty("--rt-list-w", `${w}px`);
  if (save) try { localStorage.setItem(RT_LIST_W_KEY, String(w)); } catch { /* in-memory preference */ }
  return w;
}
/** 列表与对话区之间的拖拽条：拖动 / 方向键调宽，双击恢复默认。手机端（全屏列表）样式里隐藏。 */
function rtListResizer() {
  const sync = (el) => { const w = rtListWidthNow(); el.setAttribute("aria-valuenow", String(w)); el.setAttribute("aria-valuemax", String(Math.round(rtListWidthMax()))); };
  const el = h("div", {
    class: "rt-list-resizer", role: "separator", "aria-orientation": "vertical", "aria-label": "调整会话列表宽度（双击恢复默认）", title: "拖动调整列表宽度，双击恢复默认",
    tabindex: "0", "aria-valuemin": String(RT_LIST_W_MIN), "aria-valuemax": String(RT_LIST_W_MAX), "aria-valuenow": String(RT_LIST_W_DEFAULT),
    onpointerdown: (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      const startX = ev.clientX, startW = rtListWidthNow(), id = ev.pointerId;
      document.body.classList.add("rt-list-resizing");
      // 监听挂在 window 上：拖动中列表被重绘（替换节点）也不会丢
      const move = (e) => { if (e.pointerId === id) rtSetListWidth(startW + e.clientX - startX, { save: false }); };
      const end = (e) => {
        if (e.pointerId !== id) return;
        window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end);
        document.body.classList.remove("rt-list-resizing");
        rtSetListWidth(rtListWidthNow());
        const cur = document.querySelector(".rt-list-resizer"); if (cur) sync(cur);
      };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end);
    },
    ondblclick: () => { rtSetListWidth(null); sync(el); },
    onkeydown: (ev) => {
      const dir = ev.key === "ArrowLeft" ? -1 : ev.key === "ArrowRight" ? 1 : 0;
      if (ev.key === "Home" || ev.key === "Enter") { ev.preventDefault(); rtSetListWidth(null); sync(el); return; }
      if (!dir) return;
      ev.preventDefault();
      rtSetListWidth(rtListWidthNow() + dir * RT_LIST_W_STEP); sync(el);
    }
  });
  queueMicrotask(() => { if (el.isConnected) sync(el); });
  return el;
}

function rtList() {
  const el = rtListBase();
  el.append(rtListResizer());
  return el;
}
function rtListBase() {
  const f = ui.rt.filter;
  const a = ui.rt.access;
  const d = ui.rt.dir;
  const setFilter = (patch) => { Object.assign(f, patch); rtArchiveInvalidate(); if (ui.rt.showArchived) { rtRenderListOnly(); void rtArchiveLoad(); } else if (rtDirServes(f)) rtRenderListOnly(); else void rtLoadDir().then(rtRenderListOnly); };
  // 输入法组字中不筛；目录已拿全时本地过滤即时生效，否则仍按 250ms 合并请求
  const search = (q) => { clearTimeout(ui.rt.searchTimer); ui.rt.searchTimer = setTimeout(() => setFilter({ q }), !ui.rt.showArchived && rtDirServes({ ...f, q }) ? 0 : 250); };
  // 搜索收起时列表上方只留标题与图标：搜索框和运行时筛选行都随放大镜一起出现
  const searchOpen = !!(ui.rt.searchOpen || f.q || f.runtime);
  const chipIcon = (id) => typeof piLogoSrc === "function" ? piLogoSrc(id) : `/logos/${id}.svg`;
  const chip = (v, label) => h("button", { type: "button", class: `rt-chip${f.runtime === v ? " active" : ""}`, "aria-pressed": String(f.runtime === v), onclick: () => setFilter({ runtime: v }) },
    v === "codex" ? h("img", { src: chipIcon("codex"), alt: "" }) : v === "claude-code" ? h("img", { src: chipIcon("claudecode"), alt: "" }) : v === "pi" ? h("span", { class: "rt-chip-pi", "aria-hidden": "true" }, "π") : v === "antigravity" ? h("img", { src: chipIcon("gemini"), alt: "" }) : null, label);
  const localEntries = rtArchiveDisplayEntries(d?.entries || [], false);
  const entries = f.q ? localEntries.filter(e => rtDirMatches(e, f.q)) : localEntries;
  rtReadSync(entries);
  queueMicrotask(rtRenderNavStatus);
  queueMicrotask(rtSyncMobileHeader);
  const folded = typeof roomFold === "function" ? roomFold(rtcFold(entries)) : rtcFold(entries);
  const live = folded.filter((e) => !e.archived);
  const archived = folded.filter((e) => e.archived);
  // 直接打开一个已归档的会话：列表先切到「已归档」；之后以用户在标题下拉里的选择为准
  if (ui.rt.showArchived == null && ui.rt.view?.session) ui.rt.showArchived = !!ui.rt.view.session.archived;
  const showArchived = !!ui.rt.showArchived;
  // 时钟上的计数与预约弹窗同一口径：所有可读的未归档预约消息，不随搜索 / 运行时筛选变化
  const scheduledCount = Math.max(0, Number(d?.scheduledCount) || 0);
  const shown = showArchived ? archived : live;
  const group = (g) => {
    // 两个视图的同名目录各记各的收起状态
    const ck = showArchived ? `archived:${g.key}` : g.key;
    const open = !ui.rt.collapsed[ck];
    return h("section", { class: "rt-group" },
      h("button", { type: "button", class: "rt-group-head", title: g.path || "工作目录未知", "aria-expanded": String(open), onclick: () => { ui.rt.collapsed[ck] = open; rtRenderListOnly(); } },
        h("span", { class: `rt-caret${open ? " open" : ""}`, "aria-hidden": "true" }, "›"),
        h("span", { class: "rt-folder", "aria-hidden": "true" }),
        h("span", { class: "rt-group-name" }, g.label),
        !open && g.entries.some(rtUnread) ? h("span", { class: "rt-unread-dot", title: "有未读", "aria-label": "有未读" }) : null,
        h("span", { class: "rt-group-count" }, String(g.entries.length))),
      open ? h("ul", { class: "rt-ul" }, g.entries.map((e) => rtListItem(e, a))) : null);
  };
  return h("aside", { class: `rt-list${searchOpen ? " search-open" : ""}`, "aria-label": "会话列表" },
    h("div", { class: "rt-list-head" }, rtListViewSwitch(live, archived),
      h("div", { class: "rt-head-actions" },
        h("button", { type: "button", class: "btn small rt-list-toggle", "aria-label": "收起会话列表", onclick: () => rtCloseList() }, "返回"),
        h("button", { type: "button", class: `rt-icon-link${searchOpen ? " active" : ""}`, title: searchOpen ? "关闭搜索" : "搜索会话", "aria-label": searchOpen ? "关闭搜索" : "搜索会话", "aria-expanded": String(searchOpen), "aria-controls": searchOpen ? "rt-search-box rt-runtime-filters" : null, onclick: () => rtToggleSearch(!searchOpen, setFilter) }, rtSearchIcon()),
        h("button", { type: "button", class: `rt-icon-link${scheduledCount ? " has-count" : ""}`, "aria-label": scheduledCount ? `预约发送消息，${scheduledCount} 条` : "预约发送消息", title: scheduledCount ? `预约发送消息（${scheduledCount} 条）` : "预约发送消息", onclick: rtScheduledOverview }, rtClockIcon(),
          scheduledCount ? h("span", { class: "rt-schedule-count", "aria-hidden": "true" }, scheduledCount > 99 ? "99+" : String(scheduledCount)) : null),
        // 桌面端：全局设置放在会话列表右上角最右（竖栏左下角的入口已撤）；手机在下面的状态区菜单里
        (() => {
          const navSettings = document.querySelector(".nav-settings-button");
          const hasAlert = !!navSettings?.classList.contains("has-capability-alert");
          const settingsTitle = navSettings?.title || "全局设置：本设备能力、导航、版本与故障上报";
          const settingsDesc = hasAlert ? (settingsTitle.includes("能力") ? "本设备有能力尚未开启" : "有运行时可更新") : null;
          return h("button", { type: "button", class: `rt-icon-link rt-settings-link${hasAlert ? " has-capability-alert" : ""}`, title: settingsTitle, "aria-label": "设置", ...(settingsDesc ? { "aria-description": settingsDesc } : {}), onclick: () => window.piOpenSettings?.() }, rtGearIcon());
        })(),
        // 手机的状态区（夜间 / 设置 / 连接状态）：底栏没有「更多」了，入口在会话页头部
        h("button", { type: "button", class: "rt-icon-link rt-status-link", "data-nav-more-trigger": "", title: "夜间、设置与连接状态", "aria-label": "夜间、设置与连接状态", onclick: () => window.navToggleStatus?.() }, window.navStatusIcon?.() || "⚙"))),
    // 搜索默认收起成图标；有搜索词时保持展开，看得出列表正在被筛选
    searchOpen ? h("div", { class: "rt-search-row", id: "rt-search-box" },
      h("input", { class: "rt-search", type: "search", placeholder: "搜索标题或目录…", "aria-label": "搜索会话", value: f.q, "data-key": "rt-search",
        oninput: (ev) => { if (!ev.isComposing) search(ev.target.value); },
        oncompositionend: (ev) => search(ev.target.value),
        onkeydown: (ev) => { if (ev.key === "Escape") { ev.preventDefault(); rtToggleSearch(false, setFilter); } } })) : null,
    // 单个会话、对比多个、群聊共用一个入口：新建页里切换，按上次用的模式打开。
    // 手机上是右下角圆形「＋」：单击新建会话；按住后上滑松手，快速进入待办记录并聚焦输入框。
    a && a.control ? (() => {
      const cur = ui.view === "rt-new" || ui.view === "rt-room-new";
      // 按住就绪的阈值压到 180ms：手指落下后很快就震动、给出「上滑」提示，与会话列表的待办页加号一致
      const HOLD_MS = 180, BUZZ_LEAD_MS = 80, SWIPE_UP = 36, DRIFT_X = 40;
      // 马达从收到指令到真正震起来有几十毫秒延迟，震动指令比「上滑」提示提前发，两者在手上才同时到；脉冲稍长一点更容易感到
      const HOLD_BUZZ = 20;
      // 震动反馈：不支持或用户关掉震动的设备上静默跳过（iOS Safari 没有 Vibration API）
      const buzz = (pattern) => { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* 忽略 */ } };
      const hint = h("span", { class: "rt-new-hint", "aria-hidden": "true" }, "上滑进入待办");
      let holdTimer = null, buzzTimer = null, startY = 0, startX = 0, holding = false, armed = false, suppressClick = false, preBuzzed = false;
      const cleanup = () => {
        clearTimeout(holdTimer); holdTimer = null; clearTimeout(buzzTimer); buzzTimer = null;
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", onCancel, true);
        holding = false; armed = false;
        el.classList.remove("rt-new-holding", "rt-new-armed");
      };
      // 按住已经就绪，手指上滑越过阈值就武装；松手才真正进入待办。
      const onMove = (ev) => {
        if (!holding) return;
        const dy = ev.clientY - startY, dx = Math.abs(ev.clientX - startX);
        if (dx > DRIFT_X) { cleanup(); return; }
        if (dy <= -SWIPE_UP) {
          if (!armed) { armed = true; hint.textContent = "松开进入待办"; el.classList.add("rt-new-armed"); }
        } else if (armed) {
          // 又滑回来了：取消这次手势，松手还是普通新建
          armed = false; hint.textContent = "上滑进入待办"; el.classList.remove("rt-new-armed");
        }
      };
      const onUp = (ev) => {
        const commit = armed;
        cleanup();
        if (!commit) return;
        suppressClick = true;
        buzz([10, 30, 10]);
        if (ev.cancelable) ev.preventDefault();
        // 这是手势不是普通点击：结束按住的指针状态，让渲染与聚焦在这个手势里同步完成
        if (typeof pointerHeld !== "undefined") pointerHeld = false;
        if (location.hash !== "#/notes") location.hash = "#/notes";
        if (typeof route === "function") route();
        // 待办模块是按路由懒加载的：首次上滑时 notes.js 还没执行，notesFocusInput 不存在。
        // 此时只记下意图，模块加载完成后由 renderNotes 把新建浮层拉起来（手机）/ 聚焦输入框（PC）。
        if (typeof notesFocusInput === "function") notesFocusInput();
        else { ui.notesFocusInput = true; ui.notesComposerOpen = true; }
      };
      const onCancel = () => cleanup();
      const el = h("a", {
        class: `btn primary rt-new-btn${cur ? " current" : ""}`, href: rtNewModeHref(), "aria-current": cur ? "page" : null,
        "aria-label": "＋ 新建会话", title: rtNotesAvailable() ? "新建会话（快捷键：双击 Ctrl；按住上滑进入待办记录）" : "新建会话（快捷键：双击 Ctrl）", draggable: "false",
        // 长按时不要弹出浏览器自带的菜单（Android 的链接菜单、iOS 的链接预览）
        oncontextmenu: (ev) => ev.preventDefault(),
        onclick: (ev) => {
          if (suppressClick) { suppressClick = false; ev.preventDefault(); return; }
          // 这是会话列表上的新建按钮：提交后不问去向，按列表的流程走
          if (typeof rtMarkNewEntry === "function") rtMarkNewEntry("list");
          if (!preBuzzed) buzz(10);
          preBuzzed = false; rtSetListOpen(false);
          // 正看着某个会话的「创建中」页时再点新建：回到空白表单（地址相同不会触发路由，要自己重绘）
          if (ui.rt.launch?.req) { ui.rt.launch = null; if (location.hash === rtNewModeHref()) { ev.preventDefault(); renderMain(); } }
        },
        onpointerdown: (ev) => {
          if (ev.pointerType === "mouse" && ev.button !== 0) return;
          // 待办是可选应用：这个构建没带笔记模块时，按住上滑这个手势不启用，新建按钮只做新建。
          if (!rtNotesAvailable()) return;
          cleanup(); suppressClick = false; preBuzzed = false; startY = ev.clientY; startX = ev.clientX;
          // 手指可能滑出这个小小的圆形按钮，移动与松手都放在 window 上听
          window.addEventListener("pointermove", onMove, true);
          window.addEventListener("pointerup", onUp, true);
          window.addEventListener("pointercancel", onCancel, true);
          holdTimer = setTimeout(() => { holdTimer = null; holding = true; hint.textContent = "上滑进入待办"; el.classList.add("rt-new-holding"); document.querySelector(".rt-new-coach")?.remove(); }, HOLD_MS);
          buzzTimer = setTimeout(() => { buzzTimer = null; preBuzzed = true; buzz(HOLD_BUZZ); }, HOLD_MS - BUZZ_LEAD_MS);
        }
      }, h("span", { class: "rt-new-plus", "aria-hidden": "true" }, "＋"), h("span", { class: "rt-new-text" }, "新建会话"), h("kbd", { class: "rt-new-keys", "aria-hidden": "true" }, "双击 Ctrl"), hint, rtNewCoachMark());
      return el;
    })() : null,
    // 运行时筛选跟着搜索一起出现 / 收起：不搜索时列表上方只留标题行，把高度让给会话
    searchOpen ? h("div", { class: "rt-chips rt-strip", id: "rt-runtime-filters", role: "group", "aria-label": "按运行时筛选", "data-keep-scroll-x": "rt-runtime-filters" }, chip("", "全部"), RT_KINDS.map((k) => chip(k, RT_SHORT[k]))) : null,
    rtArchiveProgress(),
    rtArchiveFlash(),
    !showArchived && typeof rtBgJobsNode === "function" ? rtBgJobsNode() : null,
    !showArchived && ui.rt.dirError ? h("p", { class: "field-error" }, ui.rt.dirError) : null,
    d && d.restricted ? h("p", { class: "muted small" }, d.restricted) : null,
    h("div", { class: "rt-items", "data-keep-scroll": "rt-items", onscroll: (ev) => rtArchiveScroll(ev.currentTarget) },
      showArchived ? rtArchivePageNodes(group) : !d ? h("p", { class: "muted small rt-pad" }, "加载中…")
        : !shown.length ? h("p", { class: "muted small rt-pad" }, f.q || f.runtime ? "没有符合条件的会话" : showArchived ? "没有已归档的会话。" : "还没有会话。新建一个，和 Codex、Claude Code、Pi 或 Antigravity 对话。")
          : rtGroupByWorkspace(shown).map(group),
      !showArchived && d && d.total > entries.length ? h("p", { class: "muted small rt-pad" }, `共 ${d.total} 项，已显示最近 ${entries.length} 项；用搜索缩小范围`) : null,
      // 会话列表到底之后先交代三个 runtime 的额度 / 余额，再看下面的今日日程与推荐
      !showArchived ? (() => { const summary = rtRuntimesSummary(); if (summary) rtSummaryWatch(summary.querySelector(".rt-rt-sum-grid") || summary); return summary; })() : null,
      rtTodaySegment()));
}

/**
 * 列表标题即视图切换：「会话 ▾」下拉选「会话」或「已归档」，列表只显示所选的一类。
 * 已归档的不标未读；看已归档时，会话里有未读就在标题旁出个点。
 */
function rtListViewSwitch(live, archived) {
  const showArchived = !!ui.rt.showArchived;
  const open = !!ui.rt.viewMenuOpen;
  const pick = (v) => {
    ui.rt.viewMenuOpen = false;
    if (!ui.rt.showArchived) ui.rt.liveListScroll = document.querySelector('.rt-items')?.scrollTop || 0;
    if (ui.rt.showArchived) { const box = document.querySelector('.rt-items'); if (box) rtArchiveState().scroll = box.scrollTop; }
    ui.rt.showArchived = v;
    rtRenderListOnly();
    const box = document.querySelector('.rt-items');
    if (box) box.scrollTop = v ? rtArchiveState().scroll : (ui.rt.liveListScroll || 0);
    if (v && box) rtArchiveScroll(box);
    else if (!v && (!rtDirServes() || Date.now() - (ui.rt.dirAt || 0) > 60_000)) void rtLoadDir().then(rtRenderListOnly);
    document.querySelector(".rt-view-switch")?.focus();
  };
  const item = (v, label, list) => h("button", {
    type: "button", role: "menuitemradio", class: "rt-view-item", "aria-checked": String(showArchived === v), onclick: () => pick(v)
  }, h("span", { class: "rt-view-check", "aria-hidden": "true" }, showArchived === v ? "✓" : ""), h("span", { class: "rt-view-label" }, label),
    list.some(rtUnread) ? h("span", { class: "rt-unread-dot", title: "有未读", "aria-label": "有未读" }) : null,
    h("span", { class: "rt-group-count" }, v ? (rtArchiveCache?.pages.length ? String(rtArchiveCache.total) : "") : String(list.length)));
  const onkeydown = (ev) => {
    if (ev.key === "Escape" && open) { ev.preventDefault(); rtSetViewMenu(false); document.querySelector(".rt-view-switch")?.focus(); return; }
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    ev.preventDefault();
    if (!open) { rtSetViewMenu(true); document.querySelector(".rt-view-item[aria-checked=true]")?.focus(); return; }
    const items = [...document.querySelectorAll(".rt-view-item")];
    const i = items.indexOf(document.activeElement);
    items[(i + (ev.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  };
  return h("div", { class: "rt-view-wrap", onkeydown },
    h("h2", {}, h("button", {
      type: "button", class: "rt-view-switch", "aria-haspopup": "menu", "aria-expanded": String(open), "aria-controls": "rt-view-menu",
      title: "切换会话 / 已归档", onclick: () => rtSetViewMenu(!open)
    }, showArchived ? "已归档" : "会话",
      !open && showArchived && live.some(rtUnread) ? h("span", { class: "rt-unread-dot", title: "会话里有未读", "aria-label": "会话里有未读" }) : null,
      h("span", { class: `rt-caret rt-view-caret${open ? " open" : ""}`, "aria-hidden": "true" }, "›"))),
    open ? h("div", { class: "rt-view-menu", id: "rt-view-menu", role: "menu", "aria-label": "列表视图" },
      item(false, "会话", live), item(true, "已归档", archived)) : null);
}
function rtSetViewMenu(open) {
  if (!!ui.rt.viewMenuOpen === open) return;
  ui.rt.viewMenuOpen = open;
  rtRenderListOnly();
}

// Pending rows stay hidden even if an SSE reload returns the old server snapshot.
// Failed rows remain available for retry, including failures after server-side archiving.
function rtArchiveDisplayEntries(entries, archived, includeFailures = true) {
  const rows = new Map(entries.map(e => [e.id, e]));
  for (const [id, entry] of includeFailures ? rtArchiveFailures : []) {
    // 快照是失败那一刻的样子：部署 / 验证状态（带自己走的计时）早已过期，不显示
    if (!!entry.archived === archived && (!ui.rt.filter.runtime || entry.runtimeKind === ui.rt.filter.runtime) && rtDirMatches(entry, ui.rt.filter.q)) { const { deploy, verify, ...rest } = entry; rows.set(id, rest); }
  }
  return [...rows.values()].filter(e => !rtArchivePending.has(e.id));
}
function rtArchiveBusy(id) { return rtArchivePending.has(id); }
// 同一条提示被局部重绘时不再重播入场动画；换成新提示才重新滑入。
let rtFlashShownFor = null, rtFlashPendingShown = "";
/** 提示条高度随换行变化：量出来写给轻提示栈，让它排在条的下面。 */
function rtFlashMeasure(node) {
  requestAnimationFrame(() => {
    const root = document.documentElement.style;
    if (node && node.isConnected) root.setProperty("--rt-flash-h", `${node.offsetHeight}px`);
    else if (!document.querySelector(".rt-flash")) root.removeProperty("--rt-flash-h");
    if (typeof piToastLayout === "function") piToastLayout();
  });
}
function rtArchiveProgress() {
  if (!rtArchivePending.size) { rtFlashPendingShown = ""; return null; }
  const text = [...rtArchivePending.values()].map(({ entry, archived }) => `${archived ? "归档处理中" : "恢复处理中"}：${entry.title}`).join("；");
  const fresh = rtFlashPendingShown !== text;
  rtFlashPendingShown = text;
  const node = h("div", { class: `rt-flash rt-flash-pending${fresh ? "" : " settled"}`, role: "status" },
    h("span", { class: "rt-flash-body", title: text }, h("span", { class: "rt-flash-text" }, text)));
  rtFlashMeasure(node);
  return node;
}
/** 关掉提示浮层：状态清空后局部重绘，列表不再为它留出行高。 */
function rtFlashDismiss(f) {
  clearTimeout(ui.rt.flashTimer);
  if (!f || ui.rt.archiveFlash === f) ui.rt.archiveFlash = null;
  rtFlashShownFor = null;
  rtRenderListOnly();
}
/**
 * 提示浮层的上滑关闭：跟手往上走并淡出，松手超过阈值就消失，不够阈值弹回原位。
 * 往下拖带阻尼（推不走那一边），撤销 / 关闭按钮上的按下不参与拖动。
 */
function rtFlashSwipe(node, dismiss) {
  const THRESHOLD = 36;
  let id = null, startY = 0, dy = 0;
  const settle = () => { node.classList.remove("swiping"); node.style.transform = ""; node.style.opacity = ""; };
  node.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    if (ev.target instanceof Element && ev.target.closest("button")) return;
    id = ev.pointerId; startY = ev.clientY; dy = 0;
    node.classList.add("swiping");
    clearTimeout(ui.rt.flashTimer);
    try { node.setPointerCapture(id); } catch { /* 不支持捕获时同一元素的 pointerup 仍然可用 */ }
  });
  node.addEventListener("pointermove", (ev) => {
    if (id === null || ev.pointerId !== id) return;
    const raw = ev.clientY - startY;
    dy = raw < 0 ? raw : raw / 4;
    node.style.transform = `translateY(${dy}px)`;
    node.style.opacity = String(Math.max(0, 1 + Math.min(0, dy) / 96));
  });
  const end = (ev) => {
    if (id === null || (ev && ev.pointerId !== id)) return;
    const dismissNow = dy <= -THRESHOLD;
    try { node.releasePointerCapture(id); } catch { /* 已经释放 */ }
    id = null;
    if (dismissNow) {
      node.classList.add("leaving");
      node.style.transform = ""; node.style.opacity = "";
      setTimeout(dismiss, 160);
      return;
    }
    settle();
    // 没推走：重新开始计时，别让弹回的提示紧接着就自动消失
    clearTimeout(ui.rt.flashTimer);
    ui.rt.flashTimer = setTimeout(dismiss, 6000);
  };
  node.addEventListener("pointerup", end);
  node.addEventListener("pointercancel", end);
}
/** 列表里排第一的（未归档、符合当前筛选的）条目；没有则为 null。 */
function rtLatestListEntry(excludeId) {
  const f = ui.rt.filter;
  const local = rtArchiveDisplayEntries(ui.rt.dir?.entries || [], false).filter((e) => e.id !== excludeId);
  const entries = f.q ? local.filter((e) => rtDirMatches(e, f.q)) : local;
  const folded = typeof roomFold === "function" ? roomFold(rtcFold(entries)) : rtcFold(entries);
  return rtGroupByWorkspace(folded.filter((e) => !e.archived))[0]?.entries[0] || null;
}
/**
 * 归档了正在看的会话之后去哪：手机回会话列表；PC 需要展示详情，默认打开列表里最新的一条，
 * 列表里已经没有会话了才落到空白兜底页（#/rt）。用 replace，已归档的会话不留在返回链路里。
 */
function rtLeaveArchivedSession(id) {
  if (ui.view !== "rt" || rtId() !== id) return;
  const next = rtPhone.matches ? null : rtLatestListEntry(id);
  if (next && typeof rtMarkDetailEntry === "function") rtMarkDetailEntry("list");
  location.replace(next?.href || "#/rt");
}

/** 归档 / 恢复：即时收起当前项，逐条独立处理，后台清理完成后提供恢复入口。 */
async function rtArchive(e, archived, btn) {
  if (rtArchiveBusy(e.id)) return;
  let done = false;
  rtArchiveFailures.delete(e.id);
  rtArchivePending.set(e.id, { entry: e, archived });
  if (btn) { btn.disabled = true; btn.textContent = archived ? "归档中…" : "恢复中…"; }
  rtRenderListOnly();
  try {
    const result = await api(`/api/runtime-sessions/${e.id}/archive`, { method: "POST", body: JSON.stringify({ archived }) });
    // Reject older directory requests and update locally before background reconciliation.
    ui.rt.dirGeneration = (ui.rt.dirGeneration || 0) + 1;
    if (ui.rt.dir) {
      const previous = ui.rt.dir.entries;
      const entries = previous.filter(row => row.id !== e.id);
      if (!archived && (!ui.rt.filter.runtime || ui.rt.filter.runtime === e.runtimeKind) && rtDirMatches(e, ui.rt.filter.q)) entries.push({ ...e, archived });
      ui.rt.dir = { ...ui.rt.dir, entries, total: Math.max(0, (ui.rt.dir.total ?? previous.length) + entries.length - previous.length) };
    }
    rtArchiveInvalidate();
    // 归档后输入区只读：同时清掉这个会话的文字与图片草稿，别让「草稿」标签和过期图片留在已归档会话里
    if (archived) {
      if (ui.rt.drafts) ui.rt.drafts[e.id] = "";
      if (typeof rtClearImageDraft === "function") rtClearImageDraft(e.id);
      // 幂等键只属于当前打开的会话，归档别的会话时不要碰正在发送的重试状态
      if (e.id === rtId()) { ui.rt.sendKey = null; ui.rt.queueKey = null; }
    }
    const removed = result && result.worktree && result.worktree.removedAt;
    ui.rt.archiveFlash = { text: `${archived ? "已归档" : "已恢复"}「${e.title}」`, note: removed ? "worktree 已删除，恢复后不含代码改动" : undefined, undo: { ...e, archived }, undoLabel: removed && archived ? "恢复到列表" : "撤销" };
    announce(archived ? `已归档：${e.title}` : `已恢复：${e.title}`);
    done = true;
  } catch (err) {
    // 服务端明确拒绝（部署还没结束）：状态没变，列表里的真实行还在，不留失败快照；说清楚等什么
    if (err.code === "RT_DEPLOY_PENDING") ui.rt.archiveFlash = { text: `暂时不能归档「${e.title}」：${err.message}`, error: true };
    else {
      rtArchiveFailures.set(e.id, e);
      ui.rt.archiveFlash = { text: `${archived ? "归档" : "恢复"}未完成「${e.title}」：${err.message}，可在列表重试`, error: true };
    }
    announce(ui.rt.archiveFlash.text);
  } finally {
    rtArchivePending.delete(e.id);
    clearTimeout(ui.rt.flashTimer);
    ui.rt.flashTimer = setTimeout(() => { ui.rt.archiveFlash = null; rtRenderListOnly(); }, 6000);
    rtRenderListOnly();
  }
  // Neither list reconciliation nor detail loading holds up another archive action.
  void rtLoadDir().then(rtRenderListOnly);
  if (done && archived && e.id === rtId()) { rtLeaveArchivedSession(e.id); return; }
  if (e.id === rtId()) {
    const gen = ui.rt.gen;
    void rtLoadView(e.id, gen).then(() => { if (rtReadCurrent(e.id, gen)) rtRenderSoft(); });
  }
}
function rtArchiveFlash() {
  const f = ui.rt.archiveFlash;
  // One notice at a time: concurrent completions must not add a second row.
  if (!f || rtArchivePending.size) { rtFlashShownFor = null; if (!rtArchivePending.size) rtFlashMeasure(null); return null; }
  const fresh = rtFlashShownFor !== f;
  rtFlashShownFor = f;
  const dismiss = () => rtFlashDismiss(f);
  const node = h("div", { class: `rt-flash${f.error ? " bad" : ""}${fresh ? "" : " settled"}`, role: "status" },
    h("span", { class: "rt-flash-body", title: f.note ? `${f.text}\n${f.note}` : f.text },
      h("span", { class: "rt-flash-text" }, f.text),
      f.note ? h("span", { class: "rt-flash-note" }, f.note) : null),
    f.undo ? h("button", { type: "button", class: "rt-flash-undo", onclick: (ev) => void rtArchive(f.undo, !f.undo.archived, ev.currentTarget) }, f.undoLabel || "撤销") : null,
    h("button", { type: "button", class: "rt-flash-x", "aria-label": "关闭提示", onclick: dismiss }, "×"));
  rtFlashSwipe(node, dismiss);
  rtFlashMeasure(node);
  return node;
}

/** 会话里还有没发出的文字或图片草稿：列表在状态标签前显示「草稿」 */
function rtSessionHasDraft(id) {
  if (!id) return false;
  const saved = typeof rtImageDrafts === "object" && rtImageDrafts ? rtImageDrafts[id] : undefined;
  const text = ui.rt.drafts?.[id] ?? saved?.text ?? "";
  return !!String(text).trim() || !!saved?.images?.length;
}
function rtDraftBadge(id) {
  return rtSessionHasDraft(id) ? h("span", { class: "badge", title: "输入框里有未发送的草稿", "data-rt-draft-badge": "" }, "草稿") : null;
}
/** 推荐操作标签：只有快捷回复的第一条本身就是 action（部署 / 归档）时才显示，打开会话即可一键执行。
 *  排队 / 等待 / 部署中时下一步是看部署结果，不再展示旧的推荐操作标签（部署结束会按新回复重新生成）。 */
function rtQuickActionBadge(e) {
  const a = e.quickAction;
  // 部署已成功（请求还没从队列里消失的那一瞬或列表还没刷新）：只认归档，旧的「部署」推荐不再出现
  const deployed = e.deploy?.progress?.phase === "ready";
  if ((e.deploy && !deployed) || !a?.label || (a.action !== "deploy" && a.action !== "archive") || (deployed && a.action !== "archive")) return null;
  const archive = a.action === "archive";
  return h("span", {
    class: `badge ${archive ? "ok" : "warn"} rt-item-quick-action`, "data-rt-quick-action": a.action,
    title: `推荐操作：${a.label}（打开会话后可执行）`,
    "aria-label": `推荐操作：${a.label}`
  }, rtMiniIcon(RT_MINI_PATHS.next, { className: "rt-item-quick-action-icon", size: 11, attrs: { "stroke-width": "1.6" } }), h("span", { class: "rt-item-quick-action-label" }, a.label));
}
/** 预约标签：会话里排着预约发送的消息时显示「预约 12:04」（非当天带日期），悬停看完整时间；点开会话可修改或撤销 */
function rtScheduledBadge(e) {
  if (!e.scheduledNext) return null;
  const at = new Date(e.scheduledNext);
  if (!Number.isFinite(at.getTime())) return null;
  const now = new Date(), sameDay = at.toDateString() === now.toDateString();
  const clock = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const text = sameDay ? clock : `${at.getMonth() + 1}/${at.getDate()} ${clock}`;
  return h("span", {
    class: "badge accent rt-item-scheduled", "data-rt-scheduled-badge": e.scheduledNext,
    title: `预约发送：${rtScheduleLabel(e.scheduledNext)}（打开会话可修改或撤销）`, "aria-label": `预约发送于 ${rtScheduleLabel(e.scheduledNext)}`
  }, rtMiniIcon(["M12 8v4l3 2", "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0"], { className: "rt-item-scheduled-icon", size: 11 }), `预约 ${text}`);
}
/** 输入、发图、发送或退回草稿后只更新这一行的标签，不重绘列表（避免滚动和焦点跳动） */
function rtSyncDraftBadge(id) {
  if (!id || typeof document === "undefined") return;
  const sub = document.querySelector(`.rt-li[data-id="${CSS.escape(id)}"] .rt-item-sub`);
  if (!sub) return;
  const existing = sub.querySelector("[data-rt-draft-badge]");
  if (!rtSessionHasDraft(id)) { existing?.remove(); return; }
  if (!existing) sub.querySelector(".rt-item-model")?.after(rtDraftBadge(id));
}
/** 从待办 / 推荐任务发起的会话：列表行里单独一个关联图标，不占会话提示的统计数字。
 *  推荐任务本身是待办聚合，沿用同一套图标位置，只把图形换成叠层；两者都是灰色线性图标，
 *  颜色只留给状态胶囊（运行中 / 归档 / 部署待处理），来源标记不再抢注意力。 */
function rtSessionLinkIcon(e) {
  const recommendation = e.recommendationRef;
  const noteId = e.noteRef?.noteId;
  if (!recommendation && !noteId) return null;
  const aggregate = !!recommendation;
  const detail = aggregate ? [recommendation.title || "推荐任务", recommendation.sourceCount ? `${recommendation.sourceCount} 条待办` : ""].filter(Boolean).join(" · ") : "从待办记录发起";
  return h("span", {
    class: `rt-item-note${aggregate ? " rt-item-recommendation" : ""}`, role: "img",
    "aria-label": aggregate ? "关联推荐任务" : "关联待办",
    title: `${aggregate ? "关联推荐任务" : "关联待办"}：${detail}`,
    "data-rt-note-icon": aggregate ? null : "",
    "data-rt-recommendation-icon": aggregate ? "" : null
  }, rtMiniIcon(RT_MINI_PATHS[aggregate ? "recommendation" : "note"], { size: 12 }));
}
/**
 * 会话行上只放一个状态标签：部署需要人 / 正在解决冲突 > 会话自身状态（运行中、被中断、失败…）> 部署进度 > 本地验证 > 推荐操作 > 预约发送。
 * 草稿、外部写入不是状态，仍可并排显示。
 */
function rtSessionStatusBadge(e, att) {
  const deployHuman = e.deploy && (e.deploy.state === "needs-human" || e.deploy.state === "resolving");
  if (deployHuman) return rtDeployBadge(e.deploy);
  const attention = rtListAttention(e, att);
  if (attention) return attention;
  const quick = rtQuickActionBadge(e);
  // 部署正在通过新 CI 验证引擎跑门禁：列表显示「验证排队 / 验证中」，并保留雷达进度小动图
  const deployPhase = e.deploy?.progress?.phase;
  const deployRunningGate = e.deploy && !e.deploy.ended && e.deploy.state === "started"
    && (!deployPhase || deployPhase === "preparing")
    && e.verify && e.verify.active && e.verify.profile === "deploy-gate";
  if (deployRunningGate) return rtVerifyBadge(e.verify, e.deploy);
  // 部署成功后下一步是推荐操作（归档会话）：它出现时不再并排放一个「部署成功」
  if (e.deploy && !(quick && e.deploy.progress?.phase === "ready")) return rtDeployBadge(e.deploy);
  if (e.verify && !(e.verify.profile === "deploy-gate" && !e.verify.active)) return rtVerifyBadge(e.verify);
  return quick || rtScheduledBadge(e);
}
function rtSessionListContent(e) {
  const unread = rtUnread(e), att = RT_ATTENTION[e.status], orderAt = rtTurnOrderAt(e), knownTime = !!orderAt;
  return [
      rtAvatarUnread(rtAvatar(e.runtimeKind, e.model), rtUnreadCount(e), e.pendingApprovals || 0, e.status === "waiting-input"),
      h("span", { class: "rt-item-main" },
        h("span", { class: "rt-item-top" },
          h("span", { class: "rt-item-title" }, unread ? h("span", { class: "sr-only" }, "未读：") : null, e.title),
          h("time", { class: "rt-item-time", datetime: knownTime ? orderAt : null, title: knownTime ? `最近轮次开始或结束：${rtTime(orderAt)}` : "暂无轮次时间" }, knownTime ? rtAgo(orderAt).replace(" 分钟前", " 分钟").replace(" 小时前", " 小时") : "—")),
        h("span", { class: "rt-item-sub" },
          h("span", { class: "rt-item-model" }, rtModelShort(e.model) || RT_KIND[e.runtimeKind] || e.runtimeKind),
          rtSessionLinkIcon(e),
          rtDraftBadge(e.id),
          // 等待审批 / 待审批数改由头像上的黄点表示，这里不再重复
          rtSessionStatusBadge(e, att),
          e.conflict ? badge("外部写入", "warn") : null))];
}

/** 触屏设备（手机）左滑会话行露出归档入口，点入口再半屏确认；有 hover 的鼠标设备仍用 hover 显示按钮 */
const RT_SWIPE_W = 84;
const rtHoverNone = typeof window.matchMedia === "function" ? window.matchMedia("(hover: none)") : null;
const rtNarrowForSwipe = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 760px)") : null;
/** 手机布局（窄屏）或触屏：行的左滑布局；宽屏鼠标设备保持 hover 小按钮 */
function rtSwipeEnabled() {
  try { return !!rtNarrowForSwipe?.matches || !!rtHoverNone?.matches; } catch { return false; }
}

/**
 * 手指按在某一行上的这段时间不能重绘整张列表：会话状态 / 目录刷新会 replaceWith 整个列表，
 * 手指下的那一行被换掉，后续 move / up 落到已摘除的节点上，滑动 / 点按就悄悄丢了。
 * 这段时间的重绘先挂起，手指抬起后补一次；兜底超时防止 pointerup 丢失后列表一直不刷新。
 */
let rtRowPressBusy = false, rtRowPressPending = false, rtRowPressGuard = 0, rtRowPressFlush = 0;
function rtRowPress(on) {
  clearTimeout(rtRowPressGuard); clearTimeout(rtRowPressFlush);
  rtRowPressBusy = on;
  if (on) { rtRowPressGuard = setTimeout(() => rtRowPress(false), 5000); return; }
  // 点按之后紧跟着还有 click：晚一点再补重绘，别把刚点的行换掉
  if (rtRowPressPending) rtRowPressFlush = setTimeout(() => { if (rtRowPressBusy || !rtRowPressPending) return; rtRowPressPending = false; rtDirectoryRenderListOnly(); }, 350);
}

/**
 * 运行中 / 等待处理 / 停止中的会话没有归档入口，露出按钮后的提示要说清「现在为什么不能归档、先做什么」。
 */
function rtArchiveBlockedNote(e) {
  switch (e && e.status) {
    case "creating": return "会话还在创建，建好之后才能归档";
    case "running": return "会话正在运行，停止后才能归档";
    case "waiting-input": return "会话在等你处理，处理完或停止后才能归档";
    case "stopping": return "会话正在停止，停下来之后才能归档";
    default: return "";
  }
}

/** 行滑开 / 收起：整行向左滑出 RT_SWIPE_W，露出背后那颗归档 / 恢复按钮 */
function rtSwipeShift(li, item, open) {
  if (!li || !item) return;
  item.style.transform = open ? `translateX(-${RT_SWIPE_W}px)` : "";
  li.classList.toggle("swipe-open", !!open);
}

/** 收起当前露出归档入口的行；exceptId 是要保留的那一行 */
function rtSwipeClose(exceptId) {
  const li = document.querySelector(".rt-li.swipe-open");
  if (!li || li.dataset.id === exceptId) return;
  rtSwipeShift(li, li.querySelector(".rt-item"), false);
  if (ui.rt.swipeOpen === li.dataset.id) ui.rt.swipeOpen = null;
}

/** 收起这一行自己（点行内其它地方 / 点了不能归档的入口之后） */
function rtSwipeCloseRow(li, item) {
  rtSwipeShift(li, item, false);
  if (ui.rt.swipeOpen === li.dataset.id) ui.rt.swipeOpen = null;
}

/**
 * 触屏会话行的左滑（Apple 式）：向左滑跟手露出右侧归档 / 恢复按钮，滑过一半松手就停住，点行内其它地方收起。
 * 竖直方向的滑动仍然交给列表滚动；滑开之后抬手补发的 click 要拦掉，否则会顺手打开这个会话。
 * 只对触摸指针接管，鼠标设备仍用 hover 小按钮。当前滑开的行记在 ui.rt.swipeOpen，列表重绘后仍是滑开的。
 */
function rtSwipeRow(li, item) {
  let pid = null, startX = 0, startY = 0, base = 0, cur = 0, axis = "", dragged = false, touching = false, dragger = null;
  const isOpen = () => li.classList.contains("swipe-open");
  const restoreDrag = () => { if (dragger) { dragger.setAttribute("draggable", "true"); dragger = null; } };
  const reset = () => { pid = null; axis = ""; li.classList.remove("swiping"); restoreDrag(); rtRowPress(false); };
  const shift = (value) => { cur = Math.max(-RT_SWIPE_W, Math.min(0, value)); item.style.transform = cur ? `translateX(${cur}px)` : ""; };
  const settle = (open) => {
    rtSwipeShift(li, item, open);
    if (open) ui.rt.swipeOpen = li.dataset.id;
    else if (ui.rt.swipeOpen === li.dataset.id) ui.rt.swipeOpen = null;
    if (open) { try { navigator.vibrate?.(10); } catch { /* 不支持震动 */ } }
  };
  li.addEventListener("pointerdown", (ev) => {
    dragged = false;
    const touch = ev.pointerType === "touch";
    touching = touch;
    // 不看 isPrimary：三指截图等系统手势吞掉抬起事件后它会一直是 false，改成「别的手指也按着就不算滑动」
    if (touch && window.piOtherTouchDown?.(ev)) return;
    // 只有左滑布局的行（手机 / 触屏）接管横向手势；宽屏鼠标设备仍然用 hover 小按钮
    if (!touch && !li.classList.contains("rt-swipeable")) return;
    // 触屏上也可能先是鼠标、之后才用手指：第一次触摸时补上左滑布局
    li.classList.add("rt-swipeable");
    reset();
    pid = ev.pointerId; startX = ev.clientX; startY = ev.clientY; axis = "";
    base = cur = isOpen() ? -RT_SWIPE_W : 0;
    // 同时只留一行滑开
    rtSwipeClose(li.dataset.id);
    rtRowPress(true);
    // 行里的链接是可拖动的（桌面拖进分类）：手指按着时先关掉，否则安卓会把横滑当成拖拽起手
    dragger = li.querySelector('a[draggable="true"]');
    dragger?.setAttribute("draggable", "false");
  });
  li.addEventListener("pointermove", (ev) => {
    if (ev.pointerId !== pid) return;
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    if (!axis) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      // 竖滑留给列表滚动：这次手势不接管，move 不拦
      if (Math.abs(dy) >= Math.abs(dx)) { reset(); return; }
      axis = "x";
      li.classList.add("swiping");
      try { li.setPointerCapture(ev.pointerId); } catch { /* 合成事件没有活动指针 */ }
    }
    ev.preventDefault(); dragged = true;
    shift(base + dx);
  });
  const end = (ev) => {
    if (ev.pointerId !== pid) return;
    const horizontal = axis === "x";
    reset();
    if (horizontal) settle(cur < -RT_SWIPE_W / 2);
  };
  li.addEventListener("pointerup", end);
  li.addEventListener("pointercancel", end);
  li.addEventListener("click", (ev) => {
    // 拖动结束浏览器还会补一次 click：拦掉它，别顺手打开会话
    if (dragged) { dragged = false; ev.preventDefault(); ev.stopPropagation(); return; }
    if (!isOpen()) return;
    // 归档 / 恢复按钮自己处理这次点击（它还要弹半屏确认）
    if (ev.target instanceof Element && ev.target.closest(".rt-item-act")) return;
    ev.preventDefault(); ev.stopPropagation();
    settle(false);
  }, true);
  // 触摸时不要弹系统菜单 / 起系统拖拽：横滑只留给我们
  li.addEventListener("contextmenu", (ev) => { if (touching) ev.preventDefault(); });
  li.addEventListener("dragstart", (ev) => { if (touching) { ev.preventDefault(); ev.stopPropagation(); } }, true);
}

/**
 * 长按会话行弹出菜单（现在只有「引用发起新会话」）：新建会话，首条消息带这个会话的引用 chip，和输入框里 @ 会话是同一种引用。
 * 手指移动（滚动 / 左滑）就不算长按；长按松手后补发的那次 click 要拦掉，否则会顺手打开这个会话。
 */
const RT_ROW_LONG_PRESS_MS = 500;
const RT_ROW_LONG_PRESS_MOVE_PX = 10;
function rtQuoteSessionToNew(entry) {
  if (typeof rtStartNewSession !== "function" || typeof rtSessionReference !== "function") { if (typeof announce === "function") announce("请稍后再试"); return; }
  const draft = typeof rtImageDraft === "function" ? rtImageDraft("new") : null;
  // 新建草稿里已经引用过这个会话就不再重复加
  const quoted = draft && typeof rtSessionReferenceDraft === "function" && rtSessionReferenceDraft(draft.text || "").references.some(ref => ref.entry.id === entry.id);
  rtStartNewSession(quoted ? "" : rtSessionReference(entry), null);
}
function rtRowMenuOpen(entry, at) {
  document.querySelectorAll("dialog.rt-row-menu").forEach(el => el.remove());
  const opened = Date.now();
  const close = () => { try { dialog.close(); } catch { /* 已经关了 */ } dialog.remove(); };
  const quote = h("button", { type: "button", class: "rt-row-menu-item", role: at ? "menuitem" : null, "data-key": "rt-row-menu-quote", onclick: () => { close(); rtQuoteSessionToNew(entry); } }, "引用发起新会话");
  // 电脑右键：贴着鼠标的小菜单，只有菜单项；触屏长按：底部半屏，带标题和取消
  const dialog = h("dialog", { class: `rt-row-menu${at ? " at-point" : ""}`, "aria-label": `会话操作：${entry.title || entry.id}` },
    h("div", { class: "rt-row-menu-body", role: at ? "menu" : null },
      at ? null : h("p", { class: "rt-row-menu-title" }, entry.title || entry.id),
      quote,
      at ? null : h("button", { type: "button", class: "rt-row-menu-item cancel", onclick: close }, "取消")));
  dialog.addEventListener("cancel", (ev) => { ev.preventDefault(); close(); });
  // 触屏长按的手指刚抬起时不算点空白处（右键菜单没有这个问题）
  dialog.addEventListener("click", (ev) => { if (ev.target === dialog && (at || Date.now() - opened > 350)) close(); });
  // 菜单外再点右键：关掉这一个，不弹系统菜单
  if (at) dialog.addEventListener("contextmenu", (ev) => { ev.preventDefault(); if (ev.target === dialog) close(); });
  document.body.append(dialog); dialog.showModal();
  if (at) {
    // 贴着鼠标，放不下就往左 / 往上收，始终留在窗口内
    const box = dialog.getBoundingClientRect(), gap = 8;
    dialog.style.left = `${Math.max(gap, Math.min(at.x, window.innerWidth - box.width - gap))}px`;
    dialog.style.top = `${Math.max(gap, Math.min(at.y, window.innerHeight - box.height - gap))}px`;
    quote.focus();
  }
}
function rtRowLongPress(li, entry) {
  let state = null, fired = 0, dragger = null, lastType = "";
  const restoreDrag = () => { dragger?.setAttribute("draggable", "true"); dragger = null; };
  const clear = () => { document.removeEventListener("pointerdown", extra, true); if (state) { clearTimeout(state.timer); state = null; } restoreDrag(); };
  // 按住期间又落下别的手指（三指截图等系统手势）：不是长按，放弃
  const extra = (ev) => { if (state && ev.pointerId !== state.pointerId && ev.pointerType === "touch") clear(); };
  const fire = () => {
    if (!state) return;
    clear();
    // 这段时间里列表重绘掉了这一行，或手指已滑开成左滑：不弹
    if (!li.isConnected || li.classList.contains("swiping")) return;
    fired = Date.now();
    try { navigator.vibrate?.(12); } catch { /* 不支持震动 */ }
    try { window.getSelection()?.removeAllRanges(); } catch { /* 老浏览器没有 Selection API */ }
    rtRowMenuOpen(entry);
  };
  li.addEventListener("pointerdown", (ev) => {
    fired = 0; lastType = ev.pointerType;
    if (ev.button !== undefined && ev.button !== 0) return;
    // 鼠标不靠长按（会和拖进分类、点选打架），电脑上走右键
    if (ev.pointerType === "mouse") return;
    if (ev.target instanceof Element && ev.target.closest(".rt-item-act")) return;
    // 不看 isPrimary：别的手指也按着就不算长按
    if (ev.pointerType === "touch" && window.piOtherTouchDown?.(ev)) return;
    clear();
    state = { pointerId: ev.pointerId, pointerType: ev.pointerType, x: ev.clientX, y: ev.clientY, timer: setTimeout(fire, RT_ROW_LONG_PRESS_MS) };
    // 行里的链接是可拖动的（桌面拖进分类）：安卓上长按它会被系统当成拖拽起手，抛 pointercancel 把计时清掉
    if (ev.pointerType === "touch") { dragger = li.querySelector('a[draggable="true"]'); dragger?.setAttribute("draggable", "false"); }
    document.addEventListener("pointerdown", extra, true);
  });
  li.addEventListener("pointermove", (ev) => {
    if (!state || ev.pointerId !== state.pointerId) return;
    if (Math.abs(ev.clientX - state.x) > RT_ROW_LONG_PRESS_MOVE_PX || Math.abs(ev.clientY - state.y) > RT_ROW_LONG_PRESS_MOVE_PX) clear();
  });
  li.addEventListener("pointerup", clear);
  li.addEventListener("pointercancel", clear);
  li.addEventListener("pointerleave", (ev) => { if (ev.pointerType === "mouse") clear(); });
  li.addEventListener("click", (ev) => {
    if (!fired || Date.now() - fired > 1500) return;
    fired = 0; ev.preventDefault(); ev.stopPropagation();
  }, true);
  // 系统的长按（contextmenu）先于我们的计时到达：手指没动过就是长按，就地接管；菜单刚弹出来那一下也挡掉系统菜单
  // 电脑上的右键（鼠标 / 触控板 / 菜单键）：弹出贴着鼠标的自定义菜单，不出浏览器自带的菜单
  li.addEventListener("contextmenu", (ev) => {
    if (state?.pointerType === "touch") { ev.preventDefault(); fire(); return; }
    if (state || (fired && Date.now() - fired < 1500) || lastType === "touch" || lastType === "pen") { ev.preventDefault(); return; }
    // 行里的按钮（归档 / 恢复）保持浏览器原有的右键行为
    if (ev.target instanceof Element && ev.target.closest(".rt-item-act")) return;
    ev.preventDefault();
    if (!li.isConnected) return;
    // 键盘菜单键没有鼠标位置（坐标为 0）：贴在这一行左上
    const box = li.getBoundingClientRect(), keyboard = !ev.clientX && !ev.clientY;
    rtRowMenuOpen(entry, { x: keyboard ? box.left + 16 : ev.clientX, y: keyboard ? box.bottom - 8 : ev.clientY });
  });
}

/** 会话列表行：包一层 <li>；触屏接左滑，单聊 / 群聊 / 对比三种行共用。传 entry 的行（未归档的单聊）还接长按菜单 */
function rtSessionRow(id, item, act, note, entry) {
  // 触屏上从一开始就是左滑布局；列表重绘 / 切换视图时，滑开的行接着用左滑布局恢复成滑开态
  const swipe = rtSwipeEnabled() || ui.rt.swipeOpen === id;
  /** 运行中 / 等待处理 / 停止中的会话没有归档入口：按钮照样露出，点它说清现在为什么不能归档 */
  const blocked = !act && note ? h("button", {
    type: "button", class: "rt-item-act archive blocked", title: note, "aria-label": `归档：${note}`,
    onclick: (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      rtSwipeCloseRow(li, item);
      window.piToast?.(note, { tone: "warn", attrs: { "data-rt-archive-note": "" } });
    }
  }, "归档") : null;
  const li = h("li", { class: `rt-li${swipe ? " rt-swipeable" : ""}`, "data-id": id }, item, act || blocked);
  if (act || blocked) rtSwipeRow(li, item);
  if (entry) rtRowLongPress(li, entry);
  if (swipe && (act || blocked) && ui.rt.swipeOpen === id) rtSwipeShift(li, item, true);
  return li;
}

/** 会话行上的横向手势归左滑归档：手机一级页「左右滑切换应用」要在这里让路 */
function rtRowSwipeClaims(target, dx) {
  if (!(target instanceof Element)) return false;
  const li = target.closest(".rt-li");
  // 左滑露出归档；已经滑开的行，右滑是把它收回去
  return !!li && (dx < 0 || li.classList.contains("swipe-open"));
}
(window.piAppSwipeClaimers = window.piAppSwipeClaimers || []).push(rtRowSwipeClaims);

function rtListItem(e, a) {
  if (rtArchiveBusy(e.id)) return null;
  if (e.room) return roomListItem(e, a);
  if (e.comparison) return rtcListItem(e, a);
  const current = ui.view === "rt" && e.id === rtId();
  const unread = rtUnread(e);
  const busy = ["creating", "running", "waiting-input", "stopping"].includes(e.status);
  const canArchive = a && a.control && !busy;
  const canSwipe = a && a.control;
  const note = canSwipe && busy ? rtArchiveBlockedNote(e) || "会话正在运行，停止后才能归档" : "";
  const item = h("a", { class: `rt-item${current ? " active" : ""}${unread ? " unread" : ""}`, href: e.href, draggable: e.archived ? "false" : "true",
    ondragstart: ev => {
      if (e.archived || !ev.dataTransfer) { ev.preventDefault(); return; }
      rtDraggedSession = e; ev.dataTransfer.effectAllowed = "copy";
      ev.dataTransfer.setData(RT_SESSION_DRAG_TYPE, e.id);
    },
    ondragend: () => { rtDraggedSession = null; document.querySelectorAll(".rt-reference-drop").forEach(el => el.classList.remove("rt-reference-drop")); },
    "aria-current": current ? "page" : null, onclick: () => { ui.rt.listOpen = false; if (typeof rtMarkDetailEntry === "function") rtMarkDetailEntry("list"); } },
    rtSessionListContent(e));
  const act = canArchive ? h("button", {
    type: "button", class: `rt-item-act ${e.archived ? "restore" : "archive"}`, title: e.archived ? "恢复到列表（不会恢复已删除的 worktree）" : e.worktreeBranch ? "归档并删除 worktree，未提交、未合并改动将丢弃" : "归档", "aria-label": `${e.archived ? "恢复" : "归档"}：${e.title}`,
    disabled: rtArchiveBusy(e.id),
    // 点左滑露出的入口直接归档（完成后列表里收起 + 顶部提示可撤销）
    onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); void rtArchive(e, !e.archived, ev.currentTarget); }
  }, rtArchiveBusy(e.id) ? (e.archived ? "恢复中…" : "归档中…") : e.archived ? "恢复" : "归档") : null;
  // 已归档的会话不能再被引用，不接长按菜单
  return rtSessionRow(e.id, item, act, note, e.archived ? null : e);
}
let rtHomeBootFlight = null;
let rtHomeBootGen = -1;
let rtHomeNewModuleGen = -1;
function rtEnsureHomeData() {
  const gen = ui.rt.gen || 0;
  if (rtHomeBootFlight || rtHomeBootGen === gen) return;
  const hadProfiles = ui.rt.profiles !== null;
  const hadAccess = !!ui.rt.access;
  const tasks = [];
  if (!hadProfiles && typeof rtLoadProfiles === "function") tasks.push(rtLoadProfiles());
  if (!hadAccess && typeof rtLoadAccess === "function") tasks.push(rtLoadAccess());
  rtHomeBootGen = gen;
  if (!tasks.length) return;
  rtHomeBootFlight = Promise.allSettled(tasks).finally(() => {
    rtHomeBootFlight = null;
    const loaded = (!hadProfiles && ui.rt.profiles !== null) || (!hadAccess && !!ui.rt.access);
    if (loaded && ui.view === "rt" && !rtId() && !rtPhone.matches) renderMain();
  });
}
function rtCenter() {
  const id = rtId();
  if (!id) {
    if (!rtPhone.matches) {
      rtEnsureHomeData();
      if (ui.rt.launch && typeof rtLaunchView === "function") return rtLaunchView(ui.rt.launch);
      if (typeof renderRtNew === "function") {
        return h("section", { class: "rt-center rt-new-center rt-home-center", "aria-label": "合己工作台" },
          h("button", { type: "button", class: "btn small rt-list-toggle", onclick: () => rtSetListOpen(!ui.rt.listOpen) }, "会话列表"),
          renderRtNew({ home: true }));
      }
      const gen = ui.rt.gen || 0;
      if (rtHomeNewModuleGen !== gen && window.piRouteModules?.has?.("rt-new")) {
        rtHomeNewModuleGen = gen;
        void window.piRouteModules.ensure("rt-new").then(() => {
          if (ui.view === "rt" && !rtId() && !rtPhone.matches) renderMain();
        }).catch(() => {});
      }
      return h("section", { class: "rt-center rt-empty-state rt-home-center", "aria-label": "合己工作台" },
        h("button", { type: "button", class: "btn small rt-list-toggle", onclick: () => rtSetListOpen(!ui.rt.listOpen) }, "会话列表"),
        h("div", { class: "rt-heji-hero" },
          h("div", { class: "rt-heji-logo-wrap" },
            h("img", { class: "rt-heji-logo rt-heji-logo-light", src: "/icons/heji-logo-light.png", alt: "合己 heji" }),
            h("img", { class: "rt-heji-logo rt-heji-logo-dark", src: "/icons/heji-logo-dark.png", alt: "合己 heji" }),
            h("span", { class: "rt-heji-sparkle s1", "aria-hidden": "true" }, "✦"),
            h("span", { class: "rt-heji-sparkle s2", "aria-hidden": "true" }, "✦")),
          h("h1", {}, "想让合己做什么？"),
          h("p", { class: "rt-heji-sub" }, "正在准备即用输入区，也可直接新建或从左侧继续会话")),
        h("a", { class: "btn primary rt-empty-cta", href: rtNewModeHref(), onclick: () => { if (typeof rtMarkNewEntry === "function") rtMarkNewEntry("list"); } }, "＋ 开始新对话"));
    }
    return h("section", { class: "rt-center rt-empty-state" },
      h("button", { type: "button", class: "btn rt-list-toggle", onclick: () => rtSetListOpen(!ui.rt.listOpen) }, "会话列表"),
      h("h2", {}, "合己对话"),
      h("p", { class: "muted" }, "在 Codex、Claude Code、Pi 和 Antigravity 上直接发起任务、续聊、审批与对比。"),
      h("a", { class: "btn primary rt-empty-cta", href: rtNewModeHref(), onclick: () => { if (typeof rtMarkNewEntry === "function") rtMarkNewEntry("list"); } }, "＋ 开始新对话"));
  }
  return rtDetailCenter();
}

globalThis.piRouteModules?.register("rt-list", {render: renderRtWorkbench});

// 点菜单外面就收起：捕获阶段先改状态，被点的元素照常处理这次点击（它自己的重绘也不会再带出菜单）
function rtDirectoryOutsideClick(ev) {
  if (!ui.rt.viewMenuOpen) return;
  if (ev.target instanceof Element && ev.target.closest(".rt-view-wrap")) return;
  ui.rt.viewMenuOpen = false;
  setTimeout(() => { if (document.getElementById("rt-view-menu")) rtRenderListOnly(); });
}


let rtDirectoryEffectsActive = false;
function rtDirectoryEffects(active) {
  if (active === rtDirectoryEffectsActive) return;
  rtDirectoryEffectsActive = active;
  document[active ? 'addEventListener' : 'removeEventListener']('click', rtDirectoryOutsideClick, true);
}
