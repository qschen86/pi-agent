"use strict";
// Retained comparison detail; definitions only until the route is current.

/*
 * 已有对比组的查看页（V3.2）。2026-10-07 起对比并入群聊：新建页不再有「对比多个」，接口不再新建对比组；
 * 群聊里 @ 多个成员的每一轮都能切到对比视图（见 docs/requirements/v3.3-agent-room/COMPARE-MERGE.md）。
 * 已有对比组只能查看、归档或删除：结论与采用不再可用。
 *
 * 对比页 #/rt/compare/<groupId>：L1 指标表、L2 回复并排与文本差异、L3 代码改动（只读）、汇总审批。
 * 安全约定同 app.js：一律经 h() 建 DOM，不使用 innerHTML，也不用内联 style（CSP 不允许）。
 */

const RTC_READ_ONLY_LABEL = { codex: "只读", "claude-code": "计划模式", pi: "只读" };
function rtcContext() { const id = ui.rtc.id, gen = ui.routeGeneration; return () => ui.view === "rt-compare" && ui.rtc.id === id && ui.routeGeneration === gen; }
async function rtcLoad(id) {
  const current = rtcContext();
  try {
    const v = await api(`/api/runtime-comparisons/${encodeURIComponent(id)}`);
    if (!current()) return;
    // 实时片段可能比快照新：同一条回复保留较新的内容
    const old = ui.rtc.view;
    if (old) for (const lane of v.lanes) {
      const prev = old.lanes.find((x) => x.laneNo === lane.laneNo);
      if (prev && prev.answer && lane.answer && prev.answer.seq === lane.answer.seq && prev.answer.partial && lane.answer.partial && prev.answer.text.length > lane.answer.text.length) lane.answer = prev.answer;
    }
    ui.rtc.view = v; ui.rtc.error = ""; rtRenderNavStatus();
  } catch (e) { if (current()) ui.rtc.error = e.message; }
}
async function rtcRefresh() {
  const current = rtcContext();
  const id = ui.rtc.id;
  if (!id) return;
  await rtcLoad(id);
  if (!current()) return;
  // 每条通道的消息列表默认就显示（与单会话一致）：打开页面即读取
  rtcEnsureEvents(true);
  // worktree 组：打开页面就读各通道的改动，指标表的“改动文件”不必等点开「代码改动」
  void rtcLoadDiffs();
  rtcConnect();
}

let rtcTimer = null;
function rtcSoon() {
  const current = rtcContext();
  clearTimeout(rtcTimer);
  rtcTimer = setTimeout(async () => {
    if (!current()) return;
    const wasSettled = !!(ui.rtc.view && ui.rtc.view.settled);
    await rtcLoad(ui.rtc.id);
    if (!current()) return;
    rtcEnsureEvents(false);
    renderMain();
    // 通道全部结束时（或正看着「代码改动」）重读改动；运行中的流式事件不触发 git
    if ((ui.rtc.view && ui.rtc.view.settled && !wasSettled) || ui.rtc.mode === "code") void rtcLoadDiffs();
  }, 250);
}
let rtcDirTimer = null, rtcReconnectTimer = null;
function rtcConnect() {
  const current = rtcContext();
  const id = ui.rtc.id;
  if (!id || ui.view !== "rt-compare") return;
  if (ui.rtc.es && ui.rtc.esFor === id) return;
  rtcStop();
  const es = new EventSource(`/api/runtime/stream?${new URLSearchParams({ comparison: id })}`);
  try {window.piTelemetry?.trackStream?.(es);} catch {}
  ui.rtc.es = es; ui.rtc.esFor = id;
  const listen = (type, handler) => es.addEventListener(type, event => {if (current() && ui.rtc.es === es) handler(event);});
  const laneIds = () => new Set((ui.rtc.view ? ui.rtc.view.lanes : []).map((l) => l.platformSessionId).filter(Boolean));
  const dirSoon = () => { clearTimeout(rtcDirTimer); rtcDirTimer = setTimeout(() => { if (ui.view === "rt-compare") void rtLoadDir().then(rtRenderListOnly); }, 400); };
  listen("ready", () => { if (ui.rtc.conn) { ui.rtc.conn = ""; rtcSoon(); } });
  listen("lane-event", (m) => { try { rtcOnLaneEvent(JSON.parse(m.data)); } catch { /* 坏数据忽略 */ } });
  listen("session", (m) => { try { if (laneIds().has(JSON.parse(m.data).id)) rtcSoon(); } catch { /* 忽略 */ } dirSoon(); });
  listen("directory", (m) => { rtArchiveDirectoryNotice(m); dirSoon(); });
  listen("approvals", rtcSoon);
  listen("comparison", rtcSoon);
  listen("error", () => {
    ui.rtc.conn = "实时连接中断，正在重连";
    es.close(); if (ui.rtc.es === es) { ui.rtc.es = null; ui.rtc.esFor = null; }
    rtcReconnectTimer = setTimeout(() => { if (current() && !ui.rtc.es) rtcConnect(); }, 2000);
  });
}

const rtcFrames = new Map();
function rtcOnLaneEvent(u) {
  const v = ui.rtc.view;
  if (!v || ui.view !== "rt-compare") return;
  const lane = v.lanes.find((l) => l.platformSessionId === u.platformSessionId);
  if (!lane) return;
  const e = u.event;
  const full = ui.rtc.full[lane.laneNo];
  if (full && full.events) {
    const i = full.events.findIndex((x) => x.key === e.key);
    if (i >= 0) full.events[i] = e; else { full.events.push(e); full.events.sort((x, y) => x.seq - y.seq); }
  }
  if (e.kind === "message" && e.role === "assistant" && !e.subagent && e.text && (!lane.answer || e.seq >= lane.answer.seq)) {
    lane.answer = { text: e.text, seq: e.seq, turnNo: e.turnNo, partial: !!e.partial, ...(e.truncated ? { truncated: e.truncated } : {}) };
  }
  if (rtcFrames.has(lane.laneNo)) return;
  rtcFrames.set(lane.laneNo, requestAnimationFrame(() => {
    rtcFrames.delete(lane.laneNo);
    const old = document.querySelector(`[data-rtc-body="${lane.laneNo}"]`);
    if (!old || ui.rtc.mode !== "side") return;
    const atBottom = old.scrollHeight - old.scrollTop - old.clientHeight < 40;
    const next = rtcCardBody(lane);
    const top = old.scrollTop;
    old.replaceWith(next);
    next.scrollTop = atBottom ? next.scrollHeight : top;
  }));
}

/** 读取还没读过的通道消息（force：全部重读，用于打开页面或重连） */
function rtcEnsureEvents(force) {
  const v = ui.rtc.view;
  if (!v) return;
  for (const l of v.lanes) if (l.platformSessionId && !l.error && (force || !ui.rtc.full[l.laneNo])) void rtcLoadFull(l.laneNo);
}
async function rtcLoadFull(laneNo) {
  const current = rtcContext();
  const lane = ui.rtc.view && ui.rtc.view.lanes.find((l) => l.laneNo === laneNo);
  if (!lane || !lane.platformSessionId) return;
  const first = !(ui.rtc.full[laneNo] && ui.rtc.full[laneNo].events);
  ui.rtc.full[laneNo] = { ...(ui.rtc.full[laneNo] || {}), loading: true, error: "" };
  try {
    const r = await api(`/api/runtime-sessions/${lane.platformSessionId}/messages?limit=200`);
    if (!current()) return;
    ui.rtc.full[laneNo] = { loading: false, events: r.events, hasMoreBefore: r.hasMoreBefore, total: r.total, error: "" };
  } catch (e) { if (!current()) return; ui.rtc.full[laneNo] = { loading: false, error: e.message }; }
  if (ui.view !== "rt-compare") return;
  renderMain();
  // 第一次读到：像单会话一样停在最新的消息
  if (first) requestAnimationFrame(() => { const el = document.querySelector(`[data-rtc-body="${laneNo}"].rtc-transcript`); if (el) el.scrollTop = el.scrollHeight; });
}
function rtcLaneModel(l) { return (l.session && (l.session.effectiveModel || l.session.requestedModel)) || l.model || ""; }
function rtcLaneLabel(l) { return `通道 ${l.laneNo} · ${rtModelShort(rtcLaneModel(l)) || RT_KIND[l.runtimeKind]}`; }
function rtcLaneState(l) {
  if (l.error) return badge("创建失败", "bad");
  if (!l.session) return badge("创建中", "accent");
  if (l.queuePosition) return badge(`排队第 ${l.queuePosition} 位`, "warn");
  const t = l.metrics.latestTurn;
  if (t && !["running", "queued", "waiting-input"].includes(t.status) && !["creating", "stopping"].includes(l.session.status)) {
    return badge(RT_TURN[t.status] || t.status, t.status === "completed" ? "ok" : t.status === "failed" || t.status === "unknown" ? "bad" : "warn");
  }
  const [label, tone] = RT_STATUS[l.session.status] || [l.session.status, ""];
  return badge(label, tone);
}

/** 对比页放在对话工作台里：左侧会话列表保留 */
function renderRtCompareWorkbench() {
  const layout = h("div", { class: `rt-layout rt-layout-new${ui.rt.listOpen ? " list-open" : ""}` }, rtList(), h("section", { class: "rt-center rtc-center", "aria-label": "对比结果", "data-keep-scroll": "rtc-center" }, renderRtCompare()));
  return h("div", { class: "rt-page rt-page-new" }, rtAccessNote(), layout);
}

function renderRtCompare() {
  const v = ui.rtc.view;
  const nav = h("div", { class: "rt-new-nav" },
    h("button", { type: "button", class: "btn small rt-list-toggle", "aria-expanded": String(ui.rt.listOpen), onclick: () => { ui.rt.listOpen = !ui.rt.listOpen; renderMain(); } }, "会话列表"),
    h("span", { class: "muted small" }, "对比已并入群聊：在群聊里 @ 多个成员，每一轮都能切到对比视图。", ui.rt.access && ui.rt.access.control ? h("a", { href: "#/rt/room/new", onclick: () => rtSaveNewMode("room") }, "新建群聊") : null));
  if (!v) return h("div", { class: "rtc-page" }, nav, ui.rtc.error ? h("p", { class: "field-error", role: "alert" }, ui.rtc.error) : h("p", { class: "muted" }, "加载中…"));
  const g = v.group;
  const a = ui.rt.access;
  const canAct = a && a.control;
  const allArchived = v.lanes.every((l) => !l.session || l.session.archived);
  return h("div", { class: "rtc-page" }, nav,
    h("header", { class: "rtc-head" },
      h("div", { class: "rtc-head-main" },
        h("h1", {}, g.title),
        h("p", { class: "muted small" }, [`${v.lanes.length} 条通道`, g.worktree ? "worktree 隔离" : "只读对比", g.workspace, `创建于 ${rtTime(g.createdAt)}`].join(" · "))),
      h("div", { class: "rtc-head-tags" }, v.settled ? badge("全部结束", "ok") : badge("运行中", "accent"),
        g.adopted ? badge(`已采用通道 ${g.adopted.laneNo}`, "ok") : null,
        canAct && v.settled ? h("button", { type: "button", class: "btn small", disabled: !!ui.rtc.busy, onclick: () => {
          // worktree 还在：归档会删掉它们，先二次确认
          if (!allArchived && g.worktree && !g.worktree.cleanedAt) { ui.rtc.archiveConfirm = true; renderMain(); return; }
          void rtcDoArchive(g, !allArchived);
        } }, allArchived ? "恢复整组" : "归档整组") : null,
        canAct && v.settled ? h("button", { type: "button", class: "btn small danger", disabled: !!ui.rtc.busy, onclick: () => { ui.rtc.deleteConfirm = true; renderMain(); } }, "删除整组") : null)),
    ui.rtc.deleteConfirm ? h("div", { class: "rt-banner warn rtc-confirm-box", role: "alertdialog", "aria-label": "确认删除" },
      h("p", {}, `删除整组：删除 ${v.lanes.length} 条通道的平台记录${g.worktree && !g.worktree.cleanedAt ? "和各自的 worktree（未采用的改动会丢失）" : ""}，不能恢复；各运行时的原生会话记录保留。`),
      h("div", { class: "rt-actions" },
        h("button", { type: "button", class: "btn", onclick: () => { ui.rtc.deleteConfirm = false; renderMain(); } }, "取消"),
        h("button", { type: "button", class: "btn danger", disabled: !!ui.rtc.busy, onclick: () => rtcDoDelete(g) }, "确认删除"))) : null,
    ui.rtc.archiveConfirm ? h("div", { class: "rt-banner warn rtc-confirm-box", role: "alertdialog", "aria-label": "确认归档" },
      h("p", {}, g.adopted ? "归档会删除各通道的 worktree。已采用的改动已经在原目录里，不受影响；其他通道的改动会丢失。" : "归档会删除各通道的 worktree，还没采用的改动会全部丢失（恢复归档不会重建）。"),
      h("div", { class: "rt-actions" },
        h("button", { type: "button", class: "btn", onclick: () => { ui.rtc.archiveConfirm = false; renderMain(); } }, "取消"),
        h("button", { type: "button", class: "btn primary", disabled: !!ui.rtc.busy, onclick: () => rtcDoArchive(g, true) }, "确认归档并删除 worktree"))) : null,
    ui.rtc.conn ? h("p", { class: "rt-banner warn", role: "status" }, ui.rtc.conn) : null,
    h("details", { class: "rtc-prompt" }, h("summary", {}, "首条消息"), h("pre", { class: "rt-code" }, h("code", {}, g.promptPreview))),
    v.notes.length ? h("div", { class: "rt-banner", role: "note" }, v.notes.join("；")) : null,
    ui.rtc.actionError ? h("p", { class: "field-error", role: "alert" }, ui.rtc.actionError) : null,
    rtcApprovals(v),
    rtcMetrics(v),
    h("div", { class: "rtc-modebar" },
      h("div", { class: "rt-tabs", role: "tablist", "aria-label": "对比方式" }, [["side", "并排回复"], ["diff", "文本差异"], ...(g.worktree ? [["code", "代码改动"]] : [])].map(([k, label]) => h("button", {
        type: "button", role: "tab", class: `rt-tab${ui.rtc.mode === k ? " active" : ""}`, "aria-selected": String(ui.rtc.mode === k), onclick: () => { ui.rtc.mode = k; if (k === "code") void rtcLoadDiffs(); renderMain(); }
      }, label)))),
    // 已并入群聊：旧对比组的改动只能查看，结论只读
    ui.rtc.mode === "diff" ? rtcDiffPanel(v) : ui.rtc.mode === "code" && g.worktree ? rtcCodePanel(v, false) : rtcCards(v),
    rtcVerdict(v, false));
}

function rtcApprovals(v) {
  // 对比页没有「状态核对」：只区分权限还在读取（核对中）和确实没有控制权限
  const gate = rtApprovalGate(ui.rt.access), canAct = gate.canAct;
  const pending = v.lanes.flatMap((l) => l.approvals.map((ap) => ({ lane: l, ap })));
  const granted = v.lanes.filter((l) => l.session && l.session.approvalGrant);
  if (!pending.length && !granted.length) return null;
  const act = async (fn, ok) => {
    ui.rtc.busy = "approval"; ui.rtc.actionError = ""; renderMain();
    try { await fn(); announce(ok); }
    catch (e) { ui.rtc.actionError = e.message; }
    ui.rtc.busy = ""; await rtcLoad(ui.rtc.id); renderMain();
  };
  const decide = (lane, ap, approve, scope, answers) => act(
    async () => { await api(`/api/runtime-sessions/${lane.platformSessionId}/approvals/${ap.approvalId}`, { method: "POST", body: JSON.stringify({ approve, paramsDigest: ap.paramsDigest, turnNo: ap.turnNo, ...(scope ? { scope } : {}), ...(answers ? { answers } : {}) }) }); rtQuestionDrafts.delete(ap.approvalId); },
    ap.kind === "question" ? (approve ? "已回答" : "已跳过") : scope === "session" ? (ap.runtimeSessionScope ? "已授权本会话内相同动作与范围" : `已批准，${rtcLaneLabel(lane)} 之后的审批自动批准`) : approve ? "已批准本次" : "已拒绝");
  const revoke = (lane) => act(() => api(`/api/runtime-sessions/${lane.platformSessionId}/approval-grant/revoke`, { method: "POST", body: "{}" }), `已撤销 ${rtcLaneLabel(lane)} 的全部授权`);
  return h("section", { class: `rtc-approvals${pending.length ? "" : " granted-only"}`, "aria-label": "权限请求" },
    // 已全部授权的通道：一直显示，可随时撤销
    granted.map((l) => h("div", { class: "rt-banner rt-grant", role: "status" },
      `${rtcLaneLabel(l)}：本会话已全部授权，之后的审批自动批准（${l.session.approvalGrant.grantedBy} · ${rtTime(l.session.approvalGrant.at)}）。`,
      canAct ? h("button", { type: "button", class: "btn small", disabled: !!ui.rtc.busy, onclick: () => revoke(l) }, "撤销全部授权") : null)),
    pending.length ? h("h2", {}, `待审批（${pending.length}）`) : null,
    pending.map(({ lane, ap }) => ap.kind === "question"
      ? rtQuestionCard(ap, { label: rtcLaneLabel(lane), gate, busy: ui.rtc.busy, onSubmit: (answers) => decide(lane, ap, true, undefined, answers), onSkip: () => decide(lane, ap, false) })
      : h("div", { class: "rt-approval" },
      h("div", { class: "rt-approval-head" }, h("strong", {}, `${rtcLaneLabel(lane)} · ${ap.title}`), h("span", { class: "muted small", "data-countdown": ap.expiresAt }, minutesLeft(ap.expiresAt))),
      h("div", { class: "rt-approval-body" },
        h("pre", { class: "rt-code" }, h("code", {}, ap.action)),
        ap.scope ? h("p", { class: "small muted" }, ap.scope) : null,
        ap.runtimeSessionScope ? h("p", { class: "small muted" }, ap.runtimeSessionScope) : null),
      rtApprovalActionRow(gate, "当前入口没有控制权限，不能处理审批", (waiting) => [
        h("button", { type: "button", class: "btn", disabled: !!ui.rtc.busy || waiting, onclick: () => decide(lane, ap, false) }, "拒绝"),
        h("button", { type: "button", class: "btn primary", disabled: !!ui.rtc.busy || waiting, onclick: () => decide(lane, ap, true) }, ap.runtimeSessionScope ? "本次" : "批准本次"),
        ap.runtimeSessionScope ? h("button", {type:"button",class:"btn",disabled:!!ui.rtc.busy || waiting,title:ap.runtimeSessionScope,onclick:()=>decide(lane,ap,true,"session")}, "本会话") : ap.requiresExplicitApproval ? null : h("button", { type: "button", class: "btn", disabled: !!ui.rtc.busy || waiting, title: "批准这一项，并让这条通道的会话之后的审批都自动批准（可随时撤销）", onclick: () => decide(lane, ap, true, "session") }, "本会话全部批准")]))));
}

/** L1 指标表：行是指标，列是通道；只在已完成的通道之间标“最快 / 最省” */
function rtcMetrics(v) {
  const lanes = v.lanes;
  const done = lanes.filter((l) => l.metrics.latestTurn && l.metrics.latestTurn.status === "completed");
  const pick = (val) => { const xs = done.map((l) => [l.laneNo, val(l)]).filter(([, x]) => typeof x === "number"); return xs.length >= 2 ? xs.reduce((m, x) => x[1] < m[1] ? x : m)[0] : null; };
  const fastest = pick((l) => l.metrics.totalDurationMs);
  const cheapest = pick((l) => l.metrics.usage.total);
  const tok = (l, k) => l.metrics.usage[k] === undefined ? (l.metrics.usageCoverage === "unknown" ? "未知" : "—") : rtNum(l.metrics.usage[k]);
  const rows = [
    ["状态", (l) => [rtcLaneState(l), l.error ? h("div", { class: "small bad-text" }, l.error) : l.session && l.session.statusReason && l.session.status === "failed" ? h("div", { class: "small muted" }, l.session.statusReason) : null]],
    ["运行时", (l) => RT_KIND[l.runtimeKind]],
    ["模型", (l) => rtModelShort(rtcLaneModel(l)) || "runtime 默认"],
    ["推理强度", (l) => (l.session && (l.session.effectiveEffort || l.session.requestedEffort)) || l.effort || "默认"],
    ["耗时", (l) => [rtcDuration(l.metrics.totalDurationMs), l.laneNo === fastest ? badge("最快", "ok") : null]],
    ["输入 token", (l) => tok(l, "input")],
    ["缓存读 / 写 token", (l) => `${tok(l, "cachedInput")} / ${tok(l, "cacheCreation")}`],
    ["输出 token", (l) => tok(l, "output")],
    ["推理 token", (l) => tok(l, "reasoningOutput")],
    ["合计 token", (l) => [tok(l, "total"), l.laneNo === cheapest ? badge("最省", "ok") : null]],
    ["工具调用", (l) => `${l.metrics.toolCalls}${l.metrics.toolFailures ? `（失败 ${l.metrics.toolFailures}）` : ""}`],
    ...(v.group.worktree ? [["改动文件", (l) => { const d = ui.rtc.diffs[l.laneNo] && ui.rtc.diffs[l.laneNo].data; return d ? `${d.files.length} 个（+${d.added} −${d.deleted}）` : "—"; }]] : []),
    ["错误", (l) => String(l.metrics.errors)]
  ];
  return h("section", { class: "rtc-metrics", "aria-label": "指标对比" },
    h("div", { class: "rtc-table-wrap", "data-keep-scroll-x": "rtc-metrics" },
      h("table", { class: "rtc-table" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "指标"), lanes.map((l) => h("th", { scope: "col" }, h("span", { class: "rtc-th" }, rtAvatar(l.runtimeKind, rtcLaneModel(l), "sm"), `通道 ${l.laneNo}`, v.group.verdict && v.group.verdict.laneNo === l.laneNo ? badge("胜出", "ok") : null))))),
        h("tbody", {}, rows.map(([label, cell]) => h("tr", {}, h("th", { scope: "row" }, label), lanes.map((l) => h("td", {}, cell(l)))))))),
    h("p", { class: "muted small" }, "耗时为已结束各轮之和。token 按各 runtime 回报的口径（输入是否含缓存因 runtime 而异），未回报显示“未知”或“—”；没有回报合计的通道不参与“最省”。"));
}

/** 通道的消息列表：与单会话页同一套渲染（过程折叠、图片 / HTML 预览）；「只看结论」只显示最终回复 */
function rtcCardBody(l) {
  const sid = l.platformSessionId;
  const ans = l.answer;
  const empty = h("p", { class: "muted" }, l.error ? "这条通道没有创建成功" : l.queuePosition ? "排队中：等同一运行时有空位" : "还没有回复");
  if (ui.rtc.brief[l.laneNo] || !sid) {
    return h("div", { class: "rtc-card-body", "data-rtc-body": String(l.laneNo), "data-keep-scroll": `rtc-ans-${l.laneNo}` },
      ans ? [rtMarkdown(ans.text, {sessionId:sid, streaming:!!ans.partial}),
        ans.partial ? h("p", { class: "muted small" }, "生成中…") : typeof fileChip === "function" ? null : rtFileStrip(sid, rtFileRefs(ans.text)),
        ans.truncated ? h("p", { class: "muted small" }, `已截断，原文 ${ans.truncated.originalChars} 字符；完整内容在会话页`) : null]
        : empty);
  }
  const full = ui.rtc.full[l.laneNo] || {};
  const box = h("div", { class: "rtc-card-body rtc-transcript", "data-rtc-body": String(l.laneNo), "data-keep-scroll": `rtc-tx-${l.laneNo}`, role: "log", "aria-label": `${rtcLaneLabel(l)} 的对话` },
    full.loading && !full.events ? h("p", { class: "muted small" }, "读取中…") : null,
    full.error ? h("p", { class: "field-error small" }, full.error) : null,
    full.hasMoreBefore ? h("p", { class: "muted small" }, `只显示最近 200 条（共 ${full.total} 条），更早的在会话页`) : null,
    full.events && !full.events.length ? empty : null,
    rtBlocks(full.events || [], true).map((b) => rtBlockNode(b, sid)));
  return box;
}

function rtcCards(v) {
  const lanes = v.lanes;
  if (!lanes.some((l) => l.laneNo === ui.rtc.active)) ui.rtc.active = lanes[0].laneNo;
  return h("section", { class: "rtc-side", "aria-label": "并排回复" },
    h("div", { class: "rtc-lane-tabs", role: "tablist", "aria-label": "通道" }, lanes.map((l) => h("button", {
      type: "button", role: "tab", class: `rtc-lane-tab${ui.rtc.active === l.laneNo ? " active" : ""}`, "aria-selected": String(ui.rtc.active === l.laneNo), onclick: () => { ui.rtc.active = l.laneNo; renderMain(); }
    }, rtAvatar(l.runtimeKind, rtcLaneModel(l), "sm"), `通道 ${l.laneNo}`))),
    h("div", { class: `rtc-cards n${lanes.length}` }, lanes.map((l) => {
      const brief = !!ui.rtc.brief[l.laneNo];
      const winner = v.group.verdict && v.group.verdict.laneNo === l.laneNo;
      return h("article", { class: `rtc-card${ui.rtc.active === l.laneNo ? " active" : ""}${winner ? " winner" : ""}`, "aria-label": rtcLaneLabel(l) },
        h("header", { class: "rtc-card-head" },
          rtAvatar(l.runtimeKind, rtcLaneModel(l)),
          h("div", { class: "rtc-card-title" }, h("strong", {}, rtcLaneLabel(l)), h("span", { class: "muted small" }, [RT_KIND[l.runtimeKind], (l.session && l.session.permissionLabel) || RTC_READ_ONLY_LABEL[l.runtimeKind]].join(" · "))),
          winner ? badge("胜出", "ok") : null, rtcLaneState(l)),
        rtcCardBody(l),
        h("footer", { class: "rtc-card-foot" },
          l.platformSessionId && !l.error ? h("button", { type: "button", class: "btn small", "aria-pressed": String(!!brief), onclick: () => { if (brief) delete ui.rtc.brief[l.laneNo]; else ui.rtc.brief[l.laneNo] = true; renderMain(); } }, brief ? "显示对话" : "只看结论") : null,
          l.answer ? h("button", { type: "button", class: "btn small", onclick: (ev) => { const b = ev.currentTarget; navigator.clipboard?.writeText(l.answer.text).then(() => { b.textContent = "已复制"; setTimeout(() => { b.textContent = "复制结论"; }, 1500); }).catch(() => {}); } }, "复制结论") : null,
          l.platformSessionId && l.session ? h("a", { class: "btn small", href: `#/rt/${l.platformSessionId}` }, "打开会话") : null));
    })));
}

/* ------------------------------ 归档（worktree 需二次确认） ------------------------------ */

async function rtcDoDelete(g) {
  ui.rtc.busy = "delete"; ui.rtc.actionError = ""; renderMain();
  try { await api(`/api/runtime-comparisons/${g.groupId}`, { method: "DELETE" }); announce("已删除整组对比"); ui.rtc.deleteConfirm = false; ui.rt.dir = null; location.hash = "#/rt"; }
  catch (e) { ui.rtc.actionError = e.message; }
  ui.rtc.busy = ""; renderMain();
}
async function rtcDoArchive(g, archived) {
  ui.rtc.busy = "archive"; ui.rtc.actionError = ""; renderMain();
  try { await api(`/api/runtime-comparisons/${g.groupId}/archive`, { method: "POST", body: JSON.stringify({ archived }) });
    rtArchiveInvalidate(); announce(archived ? "已归档整组对比" : "已恢复"); void rtLoadDir().then(rtRenderListOnly); ui.rtc.archiveConfirm = false; ui.rtc.diffs = {}; }
  catch (e) { ui.rtc.actionError = e.message; }
  ui.rtc.busy = ""; await rtcLoad(ui.rtc.id); renderMain();
}

/* ------------------------------ 代码改动（L3，worktree 隔离） ------------------------------ */

async function rtcLoadDiffs() {
  const current = rtcContext();
  const v = ui.rtc.view;
  if (!v || !v.group.worktree || v.group.worktree.cleanedAt) return;
  const id = v.group.groupId;
  await Promise.all(v.lanes.filter((l) => l.worktree && !l.error).map(async (l) => {
    ui.rtc.diffs[l.laneNo] = { ...(ui.rtc.diffs[l.laneNo] || {}), loading: true, error: "" };
    try {
      const data = await api(`/api/runtime-comparisons/${id}/lanes/${l.laneNo}/diff`);
      if (current()) ui.rtc.diffs[l.laneNo] = { loading: false, data, error: "" };
    } catch (e) { if (current()) ui.rtc.diffs[l.laneNo] = { loading: false, error: e.message }; }
  }));
  if (current()) renderMain();
}

function rtcCodePanel(v, canAct) {
  const g = v.group;
  const wt = g.worktree;
  if (wt.cleanedAt) return h("section", { class: "rtc-code-panel", "aria-label": "代码改动" }, h("p", { class: "muted" }, `各通道的 worktree 已在 ${rtTime(wt.cleanedAt)} 归档时清理。${g.adopted ? `已采用的通道 ${g.adopted.laneNo} 的改动在原目录里。` : ""}`));
  const lanes = v.lanes.filter((l) => l.worktree);
  const adopt = async (l, d) => {
    ui.rtc.busy = "adopt"; ui.rtc.actionError = ""; renderMain();
    try {
      const r = await api(`/api/runtime-comparisons/${g.groupId}/lanes/${l.laneNo}/adopt`, { method: "POST", body: JSON.stringify({ patchHash: d.patchHash }) });
      v.group = r; ui.rtc.adoptConfirm = null; announce(`已把通道 ${l.laneNo} 的改动应用到原目录`);
    } catch (e) {
      ui.rtc.actionError = e.message;
      // 改动在查看之后变了：重新读取，让用户看到最新的再确认
      if (e.status === 409) { ui.rtc.adoptConfirm = null; void rtcLoadDiffs(); }
    }
    ui.rtc.busy = ""; await rtcLoad(ui.rtc.id); renderMain();
  };
  return h("section", { class: "rtc-code-panel", "aria-label": "代码改动" },
    h("div", { class: "rtc-code-head" },
      h("p", { class: "muted small" }, `各通道相对 ${wt.baseCommit.slice(0, 10)}${wt.baseBranch ? `（${wt.baseBranch}）` : ""} 的全部改动（已提交、未提交与新文件，遵守 .gitignore）。采用会把补丁应用到 ${wt.repoRoot} 的工作区，不暂存、不提交。`),
      h("button", { type: "button", class: "btn small", onclick: () => void rtcLoadDiffs() }, "刷新改动")),
    g.adopted ? h("div", { class: "rt-banner", role: "status" }, `已采用通道 ${g.adopted.laneNo}（${g.adopted.files} 个文件，${rtTime(g.adopted.at)}）。`) : null,
    lanes.map((l) => {
      const st = ui.rtc.diffs[l.laneNo] || {};
      const d = st.data;
      const running = l.session && ["creating", "running", "waiting-input", "stopping"].includes(l.session.status) || !!l.queuePosition;
      const adopted = g.adopted && g.adopted.laneNo === l.laneNo;
      const confirming = ui.rtc.adoptConfirm === l.laneNo;
      const why = !canAct ? "对比已并入群聊：旧对比组只能查看、归档或删除" : g.adopted ? "这组对比已经采用过" : running ? "通道还在运行" : !d ? "先读取改动" : !d.files.length ? "这条通道没有改动" : "";
      return h("article", { class: `rtc-code-lane${adopted ? " winner" : ""}`, "aria-label": `${rtcLaneLabel(l)} 的代码改动` },
        h("header", { class: "rtc-card-head" },
          rtAvatar(l.runtimeKind, rtcLaneModel(l)),
          h("div", { class: "rtc-card-title" }, h("strong", {}, rtcLaneLabel(l)), h("span", { class: "muted small mono" }, l.worktree.path)),
          adopted ? badge("已采用", "ok") : null, rtcLaneState(l)),
        h("div", { class: "rtc-code-body" },
          st.loading && !d ? h("p", { class: "muted small" }, "读取中…") : null,
          st.error ? h("p", { class: "field-error small" }, st.error) : null,
          d ? [
            h("p", { class: "small" }, d.files.length ? `${d.files.length} 个文件，+${d.added} −${d.deleted}${d.head !== d.baseCommit ? `；通道自己提交过（HEAD ${d.head.slice(0, 10)}）` : ""}` : "没有改动"),
            d.files.length ? h("ul", { class: "rtc-files small mono" }, d.files.map((f) => h("li", {}, h("span", { class: "rtc-file-path" }, f.path), h("span", { class: "rtc-file-stat" }, f.binary ? "二进制" : [h("span", { class: "ok-text" }, `+${f.added}`), " ", h("span", { class: "bad-text" }, `−${f.deleted}`)])))) : null,
            d.files.length ? h("details", { class: "rtc-patch-wrap" }, h("summary", {}, "查看完整 diff"),
              d.truncated ? h("p", { class: "muted small" }, `补丁过长，只显示前 ${d.patch.length.toLocaleString()} 字符（共 ${d.truncated.originalChars.toLocaleString()}）；采用时应用完整补丁`) : null,
              rtcPatchView(d.patch)) : null] : null),
        confirming && d ? h("div", { class: "rt-banner warn rtc-confirm-box", role: "alertdialog", "aria-label": "确认采用" },
          h("p", {}, `将把通道 ${l.laneNo} 的 ${d.files.length} 个文件改动（+${d.added} −${d.deleted}）应用到 ${wt.repoRoot} 的工作区，不暂存、不提交。原目录里有冲突的改动时整体不应用。一组对比只能采用一次。`),
          h("div", { class: "rt-actions" },
            h("button", { type: "button", class: "btn", onclick: () => { ui.rtc.adoptConfirm = null; renderMain(); } }, "取消"),
            h("button", { type: "button", class: "btn primary", disabled: !!ui.rtc.busy, onclick: () => adopt(l, d) }, ui.rtc.busy === "adopt" ? "应用中…" : "确认采用"))) : null,
        h("footer", { class: "rtc-card-foot" },
          !adopted && !confirming ? h("button", { type: "button", class: "btn small primary", disabled: !!why || !!ui.rtc.busy, title: why || "", onclick: () => { ui.rtc.adoptConfirm = l.laneNo; renderMain(); } }, "采用这个方案") : null,
          why && !adopted ? h("span", { class: "muted small" }, why) : null,
          l.platformSessionId && l.session ? h("a", { class: "btn small", href: `#/rt/${l.platformSessionId}` }, "打开会话") : null));
    }));
}
function rtcDiffPanel(v) {
  const lanes = v.lanes;
  if (!ui.rtc.diff || !lanes.some((l) => l.laneNo === ui.rtc.diff.a) || !lanes.some((l) => l.laneNo === ui.rtc.diff.b)) ui.rtc.diff = { a: lanes[0].laneNo, b: lanes[1].laneNo };
  const d = ui.rtc.diff;
  const A = lanes.find((l) => l.laneNo === d.a), B = lanes.find((l) => l.laneNo === d.b);
  const sel = (k, label) => h("label", { class: "rtc-diff-pick" }, label, h("select", { "aria-label": `差异 ${label}`, "data-key": `rtc-diff-${k}`, onchange: (ev) => { d[k] = Number(ev.target.value); renderMain(); } },
    lanes.map((l) => h("option", { value: String(l.laneNo), selected: d[k] === l.laneNo }, rtcLaneLabel(l)))));
  let body;
  if (!A.answer || !B.answer) body = h("p", { class: "muted" }, "两条通道都有回复后才能比较");
  else if (d.a === d.b) body = h("p", { class: "muted" }, "请选择两条不同的通道");
  else {
    const diff = rtcLineDiff(A.answer.text, B.answer.text);
    body = !diff ? h("p", { class: "muted" }, "回复太长，不做逐行差异；请用并排回复查看")
      : diff.every(([op]) => op === "=") ? h("p", { class: "muted" }, "两条回复完全相同")
        : h("div", { class: "rtc-diff", role: "region", "aria-label": "逐行差异", "data-keep-scroll": "rtc-diff" }, rtcDiffRows(diff));
  }
  return h("section", { class: "rtc-diff-panel", "aria-label": "文本差异" },
    h("div", { class: "rtc-diff-head" }, sel("a", "−"), h("button", { type: "button", class: "btn small", "aria-label": "交换两侧", onclick: () => { ui.rtc.diff = { a: d.b, b: d.a }; renderMain(); } }, "⇄"), sel("b", "+"),
      (A.answer && A.answer.partial) || (B.answer && B.answer.partial) ? h("span", { class: "muted small" }, "有通道仍在生成，差异会随之变化") : null),
    body);
}

/* ------------------------------ 人工结论 ------------------------------ */

function rtcVerdict(v, canAct) {
  const g = v.group;
  const cur = g.verdict;
  if (!ui.rtc.verdictDraft) ui.rtc.verdictDraft = { laneNo: cur ? (cur.laneNo === null ? "none" : String(cur.laneNo)) : "", note: cur ? cur.note : "" };
  const draft = ui.rtc.verdictDraft;
  const save = async () => {
    if (!draft.laneNo) { ui.rtc.actionError = "先选择胜出的通道，或选“都不满意”"; return renderMain(); }
    ui.rtc.busy = "verdict"; ui.rtc.actionError = ""; renderMain();
    try {
      const r = await api(`/api/runtime-comparisons/${g.groupId}/verdict`, { method: "POST", body: JSON.stringify({ laneNo: draft.laneNo === "none" ? null : Number(draft.laneNo), note: draft.note }) });
      v.group = r; announce("已记录结论");
    } catch (e) { ui.rtc.actionError = e.message; }
    ui.rtc.busy = ""; renderMain();
  };
  const curLane = cur && cur.laneNo !== null ? v.lanes.find((l) => l.laneNo === cur.laneNo) : null;
  return h("section", { class: "rtc-verdict", "aria-label": "结论" },
    h("h2", {}, "结论"),
    cur ? h("p", { class: "small" }, cur.laneNo === null ? "都不满意" : `胜出：${curLane ? rtcLaneLabel(curLane) : `通道 ${cur.laneNo}`}`, cur.note ? `。${cur.note}` : "", h("span", { class: "muted" }, ` · ${rtTime(cur.at)}`)) : h("p", { class: "muted small" }, "还没有结论。看完结果后选出更好的一条，记一句理由。"),
    canAct ? h("div", { class: "rtc-verdict-form" },
      h("label", { class: "rt-new-control" }, h("select", { "aria-label": "胜出通道", "data-key": "rtc-verdict-lane", onchange: (ev) => { draft.laneNo = ev.target.value; } },
        h("option", { value: "", selected: !draft.laneNo }, "选择胜出通道…"),
        v.lanes.map((l) => h("option", { value: String(l.laneNo), selected: draft.laneNo === String(l.laneNo) }, rtcLaneLabel(l))),
        h("option", { value: "none", selected: draft.laneNo === "none" }, "都不满意"))),
      h("input", { type: "text", class: "rtc-verdict-note", "aria-label": "结论备注", "data-key": "rtc-verdict-note", maxlength: "2000", placeholder: "理由（可选）", value: draft.note, oninput: (ev) => { draft.note = ev.target.value; } }),
      h("button", { type: "button", class: "btn primary small", disabled: !!ui.rtc.busy, onclick: save }, ui.rtc.busy === "verdict" ? "保存中…" : cur ? "更新结论" : "记录结论")) : null);
}
globalThis.piRouteModules?.register("rt-compare", {render: renderRtCompareWorkbench});

function rtcPageStop() {
  clearTimeout(rtcTimer); clearTimeout(rtcDirTimer); clearTimeout(rtcReconnectTimer);
  for (const frame of rtcFrames.values()) cancelAnimationFrame(frame);
  rtcFrames.clear();
}
