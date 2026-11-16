"use strict";

/* app.js 先于本文件执行（index.html 里同一批 defer，按文档顺序），对比状态挂在全局 ui 上。
 * 基础脚本加载失败时本文件仍会执行：顶层直接写 ui 会变成 Uncaught ReferenceError，
 * 把真正的 resource_error 埋掉（诊断 f0f4421f56e9e4618）。所以这里守卫式初始化：
 * ui 不存在就只记录一次、不建状态；对比页由 splash.js 的恢复提示兜底，不会再误导渲染。 */
function rtcInit() {
  if (typeof ui === "undefined") { console.warn("[shell] runtime-compare.js: app.js 未执行（ui 未定义），跳过对比状态初始化"); return null; }
  return ui.rtc || (ui.rtc = { id: null, view: null, error: "", mode: "side", active: 1, brief: {}, full: {}, diff: null, diffs: {}, archiveConfirm: false, deleteConfirm: false, busy: "", actionError: "", es: null, esFor: null });
}
rtcInit();

const RTC_ATTENTION_ORDER = ["waiting-input", "failed", "running", "creating", "stopping", "interrupted", "unknown", "idle", "completed"];
/** 同组的通道会话折叠成一项（链接到对比页） */
function rtcOriginalWorkspace(ws) { return ws ? ws.replace(/\/\.pi-compare\/cmp-[a-z0-9]+\/L\d+(?=\/|$)/, "") : ws; }
function rtcFold(entries) {
  const out = [];
  const groups = new Map();
  for (const e of entries) {
    const gid = e.comparisonRef && e.comparisonRef.groupId;
    if (!gid) { out.push(e); continue; }
    let g = groups.get(gid);
    // worktree 通道的工作目录在 <仓库>/.pi-compare/<组>/L<n> 下：按原仓库目录分组
    if (!g) { g = { id: gid, comparison: true, lanes: [], title: e.title, workspace: rtcOriginalWorkspace(e.workspace), href: `#/rt/compare/${gid}`, runtimeKind: e.runtimeKind, model: e.model, archived: true }; groups.set(gid, g); out.push(g); }
    g.lanes.push(e);
    g.archived = g.archived && !!e.archived;
    if ((e.lastTurnEndedAt || "") > (g.lastTurnEndedAt || "")) g.lastTurnEndedAt = e.lastTurnEndedAt;
    if ((e.lastActivityAt || "") > (g.lastActivityAt || "")) g.lastActivityAt = e.lastActivityAt;
  }
  for (const g of groups.values()) {
    g.lanes.sort((x, y) => x.comparisonRef.laneNo - y.comparisonRef.laneNo);
    g.status = RTC_ATTENTION_ORDER.find((s) => g.lanes.some((l) => l.status === s)) || g.lanes[0].status;
    g.pendingApprovals = g.lanes.reduce((n, l) => n + (l.pendingApprovals || 0), 0);
    // 任一条通道在等部署 / 部署中，整组就标出来
    g.deploy = g.lanes.map((l) => l.deploy).find(Boolean);
  }
  return out;
}
async function rtcArchive(g, archived) {
  try {
    await api(`/api/runtime-comparisons/${g.id}/archive`, { method: "POST", body: JSON.stringify({ archived }) });
    rtArchiveInvalidate();
    announce(archived ? "已归档整组对比" : "已恢复整组对比");
    await rtLoadDir(); rtRenderListOnly();
  } catch (err) { announce(`${archived ? "归档" : "恢复"}失败：${err.message}`); ui.rt.dirError = err.message; rtRenderListOnly(); }
}
function rtcListItem(g, a) {
  const current = ui.view === "rt-compare" && ui.rtc.id === g.id;
  const att = RT_ATTENTION[g.status];
  const busy = g.lanes.some((l) => ["creating", "running", "waiting-input", "stopping"].includes(l.status));
  const unread = rtUnread(g);
  const orderAt = rtTurnOrderAt(g) || g.lastActivityAt;
  const item = h("a", { class: `rt-item rtc-item${current ? " active" : ""}${unread ? " unread" : ""}`, href: g.href, "aria-current": current ? "page" : null, onclick: () => { ui.rt.listOpen = false; } },
      rtAvatarUnread(h("span", { class: "rtc-avatars", "aria-hidden": "true" }, g.lanes.slice(0, 4).map((l) => rtAvatar(l.runtimeKind, l.model, "sm"))), rtUnreadCount(g), g.pendingApprovals || 0, g.status === "waiting-input"),
      h("span", { class: "rt-item-main" },
        h("span", { class: "rt-item-top" },
          h("span", { class: "rt-item-title" }, unread ? h("span", { class: "sr-only" }, "未读：") : null, g.title),
          h("time", { class: "rt-item-time", datetime: orderAt || "" }, rtAgo(orderAt).replace(" 分钟前", " 分钟").replace(" 小时前", " 小时"))),
        h("span", { class: "rt-item-sub" },
          h("span", { class: "rt-item-model" }, `对比 · ${g.lanes.length} 条通道`),
          att && g.status !== "waiting-input" ? badge(att[0], att[1]) : null,
          g.deploy ? rtDeployBadge(g.deploy) : null)));
  const act = a && a.control && !busy ? h("button", {
    type: "button", class: `rt-item-act ${g.archived ? "restore" : "archive"}`, title: g.archived ? "恢复到列表" : "归档整组", "aria-label": `${g.archived ? "恢复" : "归档"}对比：${g.title}`,
    onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); void rtcArchive(g, !g.archived); }
  }, g.archived ? "恢复" : "归档") : null;
  // 对比里有通道在运行：长按给一句提示，而不是没反应
  const note = a && a.control && busy ? "对比里有通道正在运行，停止后才能归档" : "";
  return rtSessionRow(g.id, item, act, note);
}

/* ------------------------------ 对比页 ------------------------------ */

/** app.js 的 route() 进入对比页时调用 */
function rtcSelect(id) {
  if (ui.rtc.id === id) return;
  rtcStop();
  Object.assign(ui.rtc, { id, view: null, error: "", mode: "side", active: 1, full: {}, brief: {}, diff: null, diffs: {}, adoptConfirm: null, archiveConfirm: false, deleteConfirm: false, verdictDraft: null, actionError: "" });
}
function rtcStop() { if (typeof rtcPageStop === "function") rtcPageStop(); if (ui.rtc.es) { ui.rtc.es.close(); ui.rtc.es = null; ui.rtc.esFor = null; } }

function rtcDuration(ms) {
  if (typeof ms !== "number") return "—";
  if (ms < 1000) return `${ms} 毫秒`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} 秒`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${Math.round(s - m * 60)} 秒`;
}

/** 补丁按行着色：文件头、hunk、增、删 */
function rtcPatchView(patch) {
  const lines = patch.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return h("div", { class: "rtc-diff rtc-patch", role: "region", "aria-label": "完整补丁" }, lines.map((line) => {
    const cls = /^diff --git |^index |^(new|deleted) file mode |^similarity |^rename |^Binary files /.test(line) || line.startsWith("+++ ") || line.startsWith("--- ") ? "meta"
      : line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "same";
    return h("div", { class: `rtc-diff-line ${cls}` }, h("span", {}, line || " "));
  }));
}

/* ------------------------------ 文本差异（L2） ------------------------------ */

const RTC_DIFF_MAX_CELLS = 4_000_000;
/** 按行 LCS 差异；太长时返回 null（改用并排查看） */
function rtcLineDiff(a, b) {
  const x = a.split("\n"), y = b.split("\n");
  if (x.length * y.length > RTC_DIFF_MAX_CELLS) return null;
  const n = x.length, m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push(["=", x[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(["-", x[i++]]);
    else out.push(["+", y[j++]]);
  }
  while (i < n) out.push(["-", x[i++]]);
  while (j < m) out.push(["+", y[j++]]);
  return out;
}
/** 只保留改动附近 3 行上下文，其余相同段折叠 */
function rtcDiffRows(diff) {
  const keep = diff.map(() => false);
  diff.forEach(([op], i) => { if (op !== "=") for (let k = Math.max(0, i - 3); k <= Math.min(diff.length - 1, i + 3); k++) keep[k] = true; });
  const rows = [];
  let skipped = 0;
  diff.forEach(([op, text], i) => {
    if (!keep[i]) { skipped++; return; }
    if (skipped) { rows.push(h("div", { class: "rtc-diff-skip" }, `… ${skipped} 行相同`)); skipped = 0; }
    rows.push(h("div", { class: `rtc-diff-line ${op === "+" ? "add" : op === "-" ? "del" : "same"}` }, h("span", { class: "rtc-diff-op", "aria-hidden": "true" }, op === "=" ? " " : op), h("span", {}, text || " ")));
  });
  if (skipped) rows.push(h("div", { class: "rtc-diff-skip" }, `… ${skipped} 行相同`));
  return rows;
}
