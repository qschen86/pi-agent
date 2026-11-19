"use strict";
// Optional message renderer shared by single detail and retained comparisons.


/** 思考、工具调用与审批记录算「过程」：同一轮里连续的过程在对话页折叠成一块（工具页逐条显示） */
const RT_STEP_KINDS = new Set(["reasoning", "tool", "approval"]);
/** 旧记录里同一条回复的思考排在正文之后（Pi 早先的投影顺序）：显示时挪回正文前面 */
function rtThinkingFirst(events) {
  const out = events.slice();
  for (let i = 1; i < out.length; i++) {
    const e = out[i], prev = out[i - 1];
    if (e.kind === "reasoning" && prev.kind === "message" && prev.role === "assistant" && e.key === `${prev.key}:thinking`) { out[i - 1] = e; out[i] = prev; }
  }
  return out;
}
/** 结束行里平台写的是「本轮被中断：原文」；错误行已经显示过同一段原文时，结束行只留结论，避免同一段报错出现两遍。 */
const RT_TURN_END_REASON = /^本轮(?:被中断|失败|结果未知)：([\s\S]+)$/;
const RT_TURN_END_LABEL = { failed: "本轮失败", interrupted: "本轮被中断", unknown: "本轮结果未知", cancelled: "本轮已停止", completed: "本轮完成" };
function rtErrorText(text) { return String(text || "").replace(/（runtime 将自动重试）\s*$/, "").trim(); }
function rtTurnEndRows(events) {
  const out = events.slice();
  for (let i = 0; i < out.length; i++) {
    const end = out[i];
    if (end?.kind !== "turn-status" || !end.text) continue;
    const reason = RT_TURN_END_REASON.exec(end.text)?.[1]?.trim();
    const shown = reason || rtErrorText(end.text);
    if (!shown) continue;
    for (let j = i - 1; j >= 0; j--) {
      const prev = out[j];
      if (prev.kind === "turn-status") break;
      if (prev.turnNo !== undefined && end.turnNo !== undefined && prev.turnNo !== end.turnNo) break;
      if (prev.kind !== "error") continue;
      const error = rtErrorText(prev.text);
      if (!error) continue;
      // 完全相同，或平台截断了其中一份。太短的文本不按包含关系匹配，免得误吞别的错误。
      const same = error === shown || (error.length >= 12 && shown.length >= 12 && (error.includes(shown) || shown.includes(error)));
      if (!same) continue;
      out[i] = { ...end, text: RT_TURN_END_LABEL[end.status] || (reason ? end.text.slice(0, end.text.length - reason.length - 1) : "本轮结束") };
      break;
    }
  }
  return out;
}
/** group：对话视图把过程折叠成块（工具页逐条）；对比页的通道列表也按对话视图 */
function rtBlocks(events, group = ui.rt.tab === "chat") {
  events = events.filter(e => !rtOnboardingTrigger(e));
  const out = [];
  const checks = new Map();
  const background = new Map();
  for (const e of rtTurnEndRows(rtThinkingFirst(events))) {
    if (rtBackgroundTask(e)) {
      const key = `${e.turnNo ?? "legacy"}:${e.subagent || ""}`;
      const existing = background.get(key);
      if (existing) { existing.backgroundGroups.push(e); continue; }
      const end = events.find(x => x.kind === "turn-status" && x.turnNo === e.turnNo && ["completed", "cancelled", "failed", "interrupted", "unknown"].includes(x.status));
      const combined = { ...e, backgroundGroups: [e], backgroundEnd: end };
      background.set(key, combined);
      out.push({ event: combined });
      continue;
    }
    // 同一轮的跳过、通过、未通过可能分成几条事件；只在展示时合成统计，原始记录保留。
    if (e.kind === "notice" && e.enforcement && e.turnNo !== undefined) {
      const key = e.turnNo;
      const existing = checks.get(key);
      if (existing) { existing.enforcementGroups.push(e); continue; }
      const combined = { ...e, enforcementGroups: [e] };
      checks.set(key, combined);
      out.push({ event: combined });
      continue;
    }
    const last = out[out.length - 1];
    if (group && RT_STEP_KINDS.has(e.kind)) {
      if (last && last.steps && last.turnNo === e.turnNo) last.steps.push(e);
      else out.push({ steps: [e], turnNo: e.turnNo });
    } else out.push({ event: e });
  }
  // 补救指令属于上一轮检测；只有明确的相邻轮次且上一轮失败时才合并。
  for (let i = out.length - 1; i >= 0; i--) {
    const feedback = out[i].event;
    if (!rtEnforcementFeedback(feedback) || feedback.turnNo === undefined) continue;
    const check = checks.get(feedback.turnNo - 1);
    if (!check?.enforcementGroups.some(x => x.enforcement.phase === "failed")) continue;
    check.enforcementGroups.push(feedback);
    out.splice(i, 1);
  }
  // 校验通常晚于结束事件到达；先归组再关联，也兼容历史记录的相反顺序。
  const ends = new Map(out.filter(b => b.event?.kind === "turn-status" && b.event.turnNo !== undefined).map(b => [b.event.turnNo, b]));
  return out.filter(b => {
    const e = b.event, end = e?.kind === "notice" && e.enforcementGroups && ends.get(e.turnNo);
    if (!end) return true;
    end.event = { ...end.event, enforcementGroups: e.enforcementGroups };
    return false;
  });
}
/** 用源事件定位合并块，确保增量更新可以替换已有结束行。 */
function rtBlockEvents(b) { return b.steps || b.event?.backgroundGroups || (b.event?.enforcementGroups ? [b.event, ...b.event.enforcementGroups] : [b.event]); }
/** sid：消息所属的会话（文件预览按它读取）；默认是当前打开的会话 */
function rtBlockNode(b, sid = rtId()) {
  if (b.event) return rtEventRow(b.event, sid);
  if (b.steps.length === 1) return rtEventRow(b.steps[0], sid);
  return rtStepsGroup(b.steps, sid);
}
/** 一块过程：默认收起，摘要写明工具调用与思考的次数；展开状态按块记住 */
function rtStepsGroup(steps, sid = rtId()) {
  const key = steps[0].key;
  const tools = steps.filter((x) => x.kind === "tool");
  const thinking = steps.filter((x) => x.kind === "reasoning").length;
  const running = tools.some((x) => { const t = x.tool || {}; return !(t.status === "completed" || t.status === "failed" || t.status === "declined" || typeof t.exitCode === "number"); });
  const failed = tools.filter((x) => { const t = x.tool || {}; return t.status === "failed" || t.status === "declined" || (typeof t.exitCode === "number" && t.exitCode !== 0); }).length;
  const names = new Map();
  for (const x of tools) { const n = (x.tool && x.tool.name) || "工具"; names.set(n, (names.get(n) || 0) + 1); }
  // 折叠摘要里的工具种类清单全量列出（含各自次数），由 CSS 换行展示，不再截成前三种。
  const nameText = [...names].map(([n, c]) => c > 1 ? `${n} ×${c}` : n).join("、");
  const parts = [tools.length ? `${tools.length} 次工具调用` : null, thinking ? `${thinking} 段思考` : null].filter(Boolean);
  const open = !!(ui.rt.openSteps || {})[key];
  const last = steps[steps.length - 1];
  const time = last.occurredAt ? h("time", { class: "rt-time", datetime: last.occurredAt, title: rtTime(last.occurredAt) }, new Date(last.occurredAt).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })) : null;
  const body = h("div", { class: "rt-steps-body" });
  let loaded = false;
  const load = () => { if (!loaded) { loaded = true; body.append(...steps.map(x => rtEventRow(x, sid))); } };
  if (open) load();
  const group = h("details", {
    class: "rt-row rt-steps", "data-ev-seq": String(steps[0].seq), "data-steps-key": key, open,
    ontoggle: (ev) => { (ui.rt.openSteps ||= {})[key] = ev.currentTarget.open; if (ev.currentTarget.open) load(); }
  },
  h("summary", {},
    h("span", { class: `rt-tool-dot ${running ? "run" : failed ? "bad" : "ok"}`, "aria-hidden": "true" }, running ? "" : failed ? "!" : "✓"),
    h("span", { class: "rt-fold-title" }, running ? "处理中" : "思考与工具调用"),
    h("span", { class: "rt-steps-count" }, parts.join(" · ")),
    nameText ? h("span", { class: "rt-steps-names" }, nameText) : null,
    failed ? h("span", { class: "rt-tool-state bad" }, `${failed} 次失败`) : null,
    h("span", { class: "rt-fold-caret", "aria-hidden": "true" }, "›"),
    time),
  body);
  group.rtStepKeys = new Set(steps.map(e => e.key));
  return group;
}

/** 文本里的 ``` 代码块按代码显示，其余按纯文本（不解释 HTML / Markdown）。
 *  从待办发起会话的首条消息：引用块收成和输入框一致的待办 chip，原文仍保留用于复制。 */
function rtText(text, sid = rtId()) {
  const source = String(text || "");
  const parsed = typeof rtNoteQuotes === "function" ? rtNoteQuotes(source) : { quotes: [], rest: source };
  // 会话绑定的待办（从待办发起时写入）：消息里的引用 chip 用它跳转到对应记录
  const noteId = parsed.quotes.length && sid === rtId() ? ui.rt?.view?.session?.noteRef?.noteId : null;
  const parts = (parsed.quotes.length ? parsed.rest : source).split(/```/);
  return [
    parsed.quotes.length ? h("div", { class: "rt-message-note-chips", "aria-label": "引用的待办与记忆" }, parsed.quotes.map((note) => rtMessageNoteChip(note, noteId))) : null,
    ...parts.map((p, i) => i % 2 ? h("div", {}, h("pre", { class: "rt-code" }, h("code", {}, p.replace(/^[a-zA-Z0-9_+-]*\n/, ""))), typeof fileCodeReferences === "function" ? fileCodeReferences(p,{sessionId:sid}) : null) : p ? h("div", { class: "rt-text" }, rtMessageSessionTextParts(p,{sessionId:sid})) : null)
  ];
}

/* ------------------------------ 加入记忆（用户消息的手动入口） ------------------------------ */

// 消息里有「记住 / 记得 / 记一下 / 牢记 / 别忘 / 以后」才给入口；非 ASCII 一律写成 \u 转义
const RT_REMEMBER_CUE = /\u8bb0\u4f4f|\u8bb0\u5f97|\u8bb0\u4e00\u4e0b|\u7262\u8bb0|\u522b\u5fd8|\u4ee5\u540e/;
const rtRememberKeys = new Map();   // 会话 id → {keys:Set, loaded:bool}：服务端记着哪些消息已手动加入
function rtRememberLabel(b, state) {
  b.textContent = { idle: "\u52a0\u5165\u8bb0\u5fc6", busy: "\u52a0\u5165\u4e2d\u2026", done: "\u2713 \u5df2\u52a0\u5165\u8bb0\u5fc6", queued: "\u2713 \u5df2\u63d0\u4ea4", fail: "\u52a0\u5165\u5931\u8d25" }[state];
  b.disabled = state === "busy" || state === "done" || state === "queued";
  b.classList.toggle("copied", state === "done" || state === "queued"); b.classList.toggle("copy-failed", state === "fail");
}
/** 会话里已手动加入的消息只在第一次需要时读一次；读到后就地把对应按钮改成「已加入」。 */
function rtRememberLoad(sid) {
  let rec = rtRememberKeys.get(sid);
  if (rec) return rec;
  rec = { keys: new Set(), loaded: false }; rtRememberKeys.set(sid, rec);
  api(`/api/memory/public/pipeline/remember?sessionId=${encodeURIComponent(sid)}`).then((r) => {
    rec.loaded = true; for (const k of r.keys || []) rec.keys.add(k);
    for (const b of document.querySelectorAll(".rt-remember[data-remember-key]")) if (b.dataset.rememberSid === sid && rec.keys.has(b.dataset.rememberKey) && !b.disabled) rtRememberLabel(b, "done");
  }).catch(() => { rtRememberKeys.delete(sid); });
  return rec;
}
/** 用户消息下方的「加入记忆」：点了就把这条消息交给记忆流水线立刻提炼；这一轮结束后不再自动提炼。 */
function rtRememberButton(sid, e) {
  if (!e.key || e.partial || !RT_REMEMBER_CUE.test(String(e.text || ""))) return null;
  const rec = rtRememberLoad(sid);
  const b = h("button", { type: "button", class: "rt-copy-btn rt-copy rt-remember", title: "\u628a\u8fd9\u6761\u6d88\u606f\u52a0\u5165\u5e73\u53f0\u8bb0\u5fc6\uff08\u52a0\u5165\u540e\u672c\u8f6e\u7ed3\u675f\u4e0d\u518d\u81ea\u52a8\u63d0\u70bc\uff09", "data-remember-key": e.key, "data-remember-sid": sid,
    onclick: async () => {
      rtRememberLabel(b, "busy");
      try {
        const r = await api("/api/memory/public/pipeline/remember", { method: "POST", body: JSON.stringify({ sessionId: sid, key: e.key }) });
        if (!r.error) rec.keys.add(e.key);
        rtRememberLabel(b, r.error ? "fail" : r.queued ? "queued" : "done");
        if (typeof announce === "function") announce(r.error ? "\u52a0\u5165\u8bb0\u5fc6\u5931\u8d25" : "\u5df2\u52a0\u5165\u8bb0\u5fc6");
      } catch { rtRememberLabel(b, "fail"); setTimeout(() => { if (b.isConnected) rtRememberLabel(b, "idle"); }, 2500); }
    } });
  rtRememberLabel(b, rec.keys.has(e.key) ? "done" : "idle");
  return b;
}

// 旧版本只有固定键和文本，继续兼容已有会话记录。
function rtBackgroundTask(e) {
  if (e.kind !== "notice") return null;
  if (e.backgroundTask) return e.backgroundTask;
  if (!String(e.key).startsWith("claude:task:")) return null;
  const status = /^后台任务开始/.test(e.text || "") ? "running" : /^后台任务完成/.test(e.text || "") ? "completed" : /^后台任务失败/.test(e.text || "") ? "failed" : "stopped";
  return { id: e.key, status, ...(status === "running" ? { startedAt: e.occurredAt } : { endedAt: e.occurredAt }) };
}
function rtBackgroundDuration(start, end = Date.now()) {
  const seconds = Math.max(0, Math.floor((end - Date.parse(start)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  const minutes = Math.floor(seconds / 60);
  return `${minutes ? `${minutes}分` : ""}${seconds % 60}秒`;
}
function rtBackgroundRow(e, sid) {
  const rows = e.backgroundGroups || [e];
  const tasks = rows.map(rtBackgroundTask);
  const session = sid === rtId() ? ui.rt.view?.session : null;
  const turn = session?.turns?.find(t => t.turnNo === e.turnNo);
  const ended = e.backgroundEnd || (turn && !["running", "queued", "waiting-input"].includes(turn.status) ? turn : null);
  const running = ended ? 0 : tasks.filter(t => t.status === "running").length;
  const failed = tasks.filter(t => t.status === "failed").length;
  const stopped = tasks.some(t => t.status === "stopped") || ended && ended.status !== "completed";
  const label = running ? `${running} 个后台任务进行中` : failed ? `${failed} 个后台任务失败` : stopped ? "后台任务已停止" : "后台任务已完成";
  const starts = tasks.map(t => t.startedAt).filter(at => Number.isFinite(Date.parse(at)));
  const start = starts.sort()[0];
  const end = Math.max(...tasks.map(t => Date.parse(t.endedAt)).filter(Number.isFinite), Date.parse(ended?.occurredAt || ended?.endedAt) || 0);
  const duration = start ? h("span", { class: "rt-background-duration", ...(running ? { "data-rt-background-start": start } : {}) }, `${running ? "已运行" : "耗时"} ${rtBackgroundDuration(start, running ? Date.now() : end || Date.parse(start))}`) : null;
  const fold = rtLazyFold({ class: "rt-background-fold" },
    h("summary", {}, h("span", { class: "rt-background-label" }, label), duration, h("span", { class: "rt-fold-caret", "aria-hidden": "true" }, "›")),
    () => h("div", { class: "rt-background-details" }, rows.map((row, i) => h("div", {},
      h("div", {}, tasks[i].description || row.text || tasks[i].id),
      h("span", { class: "muted" }, ({ running: ended ? "已结束" : "进行中", completed: "已完成", failed: "失败", stopped: "已停止" }[tasks[i].status] || tasks[i].status)),
      tasks[i].startedAt ? h("span", { class: "muted", ...(tasks[i].status === "running" && !ended ? { "data-rt-background-start": tasks[i].startedAt } : {}) }, `${tasks[i].status === "running" && !ended ? "已运行" : "耗时"} ${rtBackgroundDuration(tasks[i].startedAt, Date.parse(tasks[i].endedAt || ended?.occurredAt || ended?.endedAt) || Date.now())}`) : null,
      tasks[i].description && row.text ? h("div", {}, row.text) : null))), null, `${sid}:${e.key}:background`);
  const canStop = running && session?.sourceMode === "platform-managed" && ui.rt.access?.control && ui.rt.statusConfirmed !== false && !ui.rt.view?.readOnly && ["running", "waiting-input", "stopping"].includes(session.status);
  return h("section", { class: "rt-row rt-system-message rt-background", "data-ev-key": e.key, "data-ev-seq": String(e.seq), "aria-label": "后台任务" }, fold,
    canStop ? h("button", { type: "button", class: "rt-background-stop", title: "停止本轮及后台任务", disabled: !!ui.rt.busy || session.status === "stopping", onclick: () => rtInterruptSession(sid) }, ui.rt.busy === "stop" || session.status === "stopping" ? "停止中…" : "终止") : null);
}

/** Deployment results keep their title and truncated subject in one keyboard-accessible line. */
function rtSystemNotice(e, notice, { sid, time, flags, deployment }) {
  const compact = deployment ? rtDeploymentCompact(notice) : { summary: notice.summary };
  const summary = () => h("span", { class: "rt-system-summary", title: compact.summary }, compact.summary);
  return h("section", { "data-ev-key": e.key, "data-ev-seq": String(e.seq), class: `rt-row rt-system-message rt-system-compact${deployment ? " rt-deployment-notice" : ""}`, "aria-label": deployment ? "自动部署通知" : "强约束检查反馈" },
    rtLazyFold({ class: "rt-system-details" }, h("summary", { "aria-label": `${notice.title}，展开或收起详情` },
      h("span", { class: "rt-system-head" },
        h("span", { class: `rt-system-result ${notice.tone}` }, notice.title),
        compact.commit ? h("span", { class: "rt-system-commit" }, `· ${compact.commit}`) : null,
        deployment ? h("span", { class: "rt-system-separator", "aria-hidden": "true" }, "·") : null,
        deployment ? summary() : null,
        h("span", { class: "rt-system-caret", "aria-hidden": "true" }, "›")),
      deployment ? null : summary()),
      () => h("div", {},
        h("div", { class: "rt-system-actions" }, time,
          rtCopyButton(e.enforcement ? notice.detail : e.text || "", "复制", { announce: "已复制消息" }),
          deployment ? rtDeployResultClickable(h("span", {}, "查看部署过程"), notice, { sid, time: e.occurredAt }) : null),
        deployment ? rtText(notice.summary, sid) : null,
        notice.detail ? rtText(notice.detail, sid) : null,
        notice.log ? h("div", { class: "rt-system-log" }, h("span", {}, "部署日志"), rtText(notice.log, sid)) : null,
        flags), null, `${sid}:${e.key}:${deployment ? "deployment" : "enforcement"}`));
}

function rtEnforcementEnd(e, sid, time, flags) {
  if (e.occurredAt) time = h("time", { class: "rt-time", datetime: e.occurredAt, title: "北京时间（UTC+8）" }, new Date(e.occurredAt).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, hour: "2-digit", minute: "2-digit" }));
  const notice = rtEnforcementNotice({ ...e.enforcementGroups[0], enforcementGroups: e.enforcementGroups });
  const { passed, failed, skipped } = notice.counts;
  const total = passed + failed + skipped;
  const state = failed ? "bad" : skipped || !total ? "neutral" : "ok";
  const extras = [failed ? `未通过 ${failed}` : null, skipped ? `跳过 ${skipped}` : null].filter(Boolean);
  // CSS mask 使用现有盾牌轮廓，内部符号明确区分全通过、未通过及跳过。
  const icon = h("span", { class: "rt-cert-icon", "aria-hidden": "true" }, state === "ok" ? "✓" : state === "bad" ? "!" : "−");
  const label = e.text || RT_TURN[e.status] || "本轮结束";
  const summary = h("summary", { class: `rt-cert-summary ${state}`, "aria-label": `强约束校验，共 ${total} 项，${notice.summary}，展开或收起明细`, title: `强约束校验：${notice.summary}` },
    h("span", { class: "rt-cert-label" }, label), h("span", { class: "rt-cert-badge" }, icon, h("span", { class: "rt-cert-count" }, total), ...extras.map(text => h("span", { class: "rt-cert-extra" }, `· ${text}`))));
  const fold = rtLazyFold({ class: "rt-cert-details" }, summary, () => h("div", {},
    h("strong", {}, `强约束校验 · 共 ${total} 项`), h("p", {}, notice.summary), rtText(notice.detail, sid),
    rtCopyButton(notice.detail, "复制", { announce: "已复制检查明细" })), null, `${sid}:${e.key}:certification`);
  return h("section", { class: `rt-row rt-certified-end ${e.status || ""}`, "data-ev-key": e.key, "data-ev-seq": String(e.seq), "aria-label": "本轮结束与强约束校验" },
    h("div", { class: "rt-cert-meta" }, time, e.turnNo ? h("span", {}, `第 ${e.turnNo} 轮`) : null),
    fold, flags);
}

function rtEventRow(e, sid = rtId()) {
  if (rtBackgroundTask(e)) return rtBackgroundRow(e, sid);
  const time = e.occurredAt ? h("time", { class: "rt-time", datetime: e.occurredAt, title: rtTime(e.occurredAt) }, new Date(e.occurredAt).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })) : null;
  const meta = [
    e.turnNo ? h("span", {}, `第 ${e.turnNo} 轮`) : null,
    e.subagent ? h("span", {}, "子 Agent") : null
  ];
  // 生成中 / 截断 / 脱敏 / 未采集：始终可见（meta 只在悬停时显示）
  const flagList = [
    e.partial ? "生成中" : null,
    e.truncated ? `已截断，原文 ${e.truncated.originalChars} 字符` : null,
    e.redactions ? `${e.redactions} 处敏感值已脱敏` : null,
    e.availability && e.availability !== "recorded" ? ({ not_collected: "未采集", redacted: "未公开", not_applicable: "不适用" }[e.availability] || e.availability) : null
  ].filter(Boolean);
  const flags = flagList.length ? h("div", { class: "rt-row-flags" }, flagList.map((f) => h("span", {}, f))) : null;
  const attrs = { "data-ev-key": e.key, "data-ev-seq": String(e.seq) };
  const copy = (text) => rtCopyButton(text || "", "复制", { announce: "已复制消息" });
  if (e.kind === "turn-status" && e.enforcementGroups?.length) return rtEnforcementEnd(e, sid, time, flags);
  const deployment = rtDeploymentNotice(e);
  if (deployment) return rtSystemNotice(e, deployment, { sid, time, flags, deployment: true });
  const enforcement = deployment ? null : rtEnforcementNotice(e);
  if (enforcement) return rtSystemNotice(e, enforcement, { sid, time, flags });
  if (e.kind === "image") {
    const image = e.image || {};
    const url = `/api/runtime-sessions/${encodeURIComponent(sid)}/images/${encodeURIComponent(e.seq)}`;
    const canLoad = image.status === "completed" && image.path;
    const fallback = h("p", { class: "muted small", hidden: true, role: "status" }, "图片文件不可用或没有查看权限");
    const preview = canLoad ? h("img", { src: `${url}?size=thumb`, alt: "生成的图片", loading: "lazy", decoding: "async", onerror: (ev) => { ev.currentTarget.hidden = true; fallback.hidden = false; }, onload: () => { const box = document.querySelector(".rt-transcript"); if (box && ui.rt.atBottom) box.scrollTop = box.scrollHeight; } }) : null;
    return h("div", { ...attrs, class: "rt-row assistant rt-image" },
      preview ? h("a", { href: url, target: "_blank", rel: "noopener", "aria-label": "打开生成的图片", onclick: (ev) => {
        // 和看上传图片一样进放大查看器；新标签 / 修饰键点击仍按链接打开原图
        if (typeof openImageZoom !== "function" || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button) return;
        ev.preventDefault();
        const item = { src: `${url}?size=view`, original: url, name: "生成的图片", kind: "generated", seq: e.seq, key: e.key };
        if (!rtOpenSessionImages(sid, item, ev.currentTarget)) openImageZoom([item], 0);
      } }, preview) : h("p", {}, e.text || "图片生成中"),
      fallback, image.prompt ? h("details", {}, h("summary", {}, "图片描述"), h("div", { class: "rt-text" }, image.prompt)) : null,
      flags, h("div", { class: "rt-row-meta" }, time, meta));
  }
  if (e.kind === "message" && e.role === "user") return h("div", { ...attrs, class: "rt-row user" },
    h("div", { class: "rt-bubble user" }, rtText(e.text, sid), rtAttachmentHistory(e.attachments, sid)), flags,
    e.partial || typeof fileChip === "function" ? null : rtFileStrip(sid, rtFileRefs(e.text)),
    h("div", { class: "rt-row-meta" }, time, meta, rtRememberButton(sid, e), copy(e.text)));
  if (e.kind === "message") return h("div", { ...attrs, class: `rt-row assistant${e.subagent ? " sub" : ""}` },
    rtMarkdown(e.text, {sessionId:sid, streaming:!!e.partial}), flags,
    // 回复里提到的图片 / HTML：预览卡片（流式生成中先不检查）
    e.partial || typeof fileChip === "function" ? null : rtFileStrip(sid, rtFileRefs(e.text)),
    h("div", { class: "rt-row-meta" }, copy(e.text), time, meta));
  if (e.kind === "reasoning") return rtLazyFold({ ...attrs, class: "rt-row fold reasoning" },
    h("summary", {}, h("span", { class: "rt-fold-icon", "aria-hidden": "true" }, "✻"), h("span", { class: "rt-fold-title" }, "思考过程"), h("span", { class: "rt-fold-caret", "aria-hidden": "true" }, "›"), time),
    () => h("div", { class: "rt-fold-body rt-reasoning-text" }, e.text || ""), flags, `${sid}:${e.key}`);
  if (e.kind === "tool") {
    const t = e.tool || {};
    const st = t.status === "completed" || t.exitCode === 0 ? ["✓", "ok"] : t.status === "failed" || t.status === "declined" || (typeof t.exitCode === "number" && t.exitCode !== 0) ? ["✕", "bad"] : ["", "run"];
    const label = t.status ? { completed: "", inProgress: "进行中", failed: "失败", declined: "已拒绝" }[t.status] ?? t.status : "";
    // 运行中的工具显示已经跑了多久（每秒由 rtTickVisibleTimes 刷新）：卡住不再只能靠用户等
    const startedAt = st[1] === "run" ? (e.recordedAt || e.occurredAt) : undefined;
    const state = startedAt
      ? h("span", { class: "rt-tool-state run", "data-rt-tool-start": startedAt }, typeof rtElapsedLabel === "function" ? rtElapsedLabel("运行中", startedAt) : "进行中")
      : (label || typeof t.exitCode === "number" ? h("span", { class: `rt-tool-state ${st[1]}` }, `${label}${typeof t.exitCode === "number" && t.exitCode !== 0 ? `${label ? " · " : ""}退出码 ${t.exitCode}` : ""}`) : null);
    return rtLazyFold({ ...attrs, class: "rt-row fold tool" },
      h("summary", {},
        h("span", { class: `rt-tool-dot ${st[1]}`, "aria-hidden": "true" }, st[0]),
        h("span", { class: "rt-fold-title" }, t.name || "工具"),
        h("span", { class: "rt-tool-input" }, (t.input || "").replace(/\s+/g, " ").slice(0, 160)),
        state,
        h("span", { class: "rt-fold-caret", "aria-hidden": "true" }, "›")),
      () => h("div", { class: "rt-fold-body" },
        t.input ? h("div", { class: "rt-io" }, h("div", { class: "rt-io-label" }, "输入"), h("pre", { class: "rt-code" }, h("code", {}, t.input))) : null,
        t.output ? h("div", { class: "rt-io" }, h("div", { class: "rt-io-label" }, "输出"), h("pre", { class: "rt-code rt-output" }, h("code", {}, t.output))) : h("p", { class: "muted small" }, "没有输出记录"),
        // 工具读写的图片 / HTML：默认收起，展开看预览
        typeof fileCodeReferences === "function" ? fileCodeReferences(`${t.input || ""}\n${t.output || ""}`,{sessionId:sid}) : null,
        e.partial || typeof fileChip === "function" ? null : rtFileStrip(sid, rtFileRefs(`${t.input || ""}\n${t.output || ""}`, 6), { collapsed: true }),
        h("div", { class: "rt-row-meta" }, time, meta)), flags, `${sid}:${e.key}`);
  }
  // 运行时记录的「查看图片」：小号预览图，点击看大图
  if (e.kind === "notice" && e.image?.path) return h("div", { ...attrs, class: "rt-row note rt-image-ref-row" }, rtViewedImage(sid, e.image.path, e), time, meta);
  if (e.kind === "approval") return h("div", { ...attrs, class: "rt-row note" }, h("span", {}, `⚑ ${e.text || ""}`), time);
  if (e.kind === "turn-status") return h("div", { ...attrs, class: `rt-row turn ${e.status || ""}` }, h("span", {}, e.text || RT_TURN[e.status] || "本轮结束"), time);
  if (e.kind === "error") return h("div", { ...attrs, class: "rt-row note bad" }, h("span", {}, e.text || "错误"), time);
  return h("div", { ...attrs, class: "rt-row note" }, h("span", {}, e.text || e.kind), time, meta, flags);
}


/* ------------------------------ 消息里提到的图片 / HTML ------------------------------ */

/**
 * 从消息与工具调用里找出提到的图片 / HTML 路径（相对路径按会话工作目录解析，由服务端核对）。
 * 只有服务端确认「在本会话工作目录内、真实存在」的才显示预览卡片。
 */
const RT_FILE_RE = /(?:^|[\s"'`(（[<：:，,=])((?:\.{1,2}\/|\/)?[\w\-.@+一-龥/]*[\w\-@+一-龥]\.(?:png|jpe?g|gif|webp|svg|html?))(?=$|[\s"'`)）\]>，。,;；:：!?！？])/gi;
function rtFileRefs(text, max = 8) {
  const out = [];
  for (const m of String(text || "").matchAll(RT_FILE_RE)) {
    if (!out.includes(m[1])) out.push(m[1]);
    if (out.length >= max) break;
  }
  return out;
}

/** 检查结果缓存：确认存在的长期有效；不存在的 10 秒后重查（模型可能稍后才写出文件） */
const rtFileCache = new Map();
async function rtStatFiles(sid, paths) {
  const k = (p) => `${sid}|${p}`;
  const stale = (v) => !v || (!v.then && !v.ok && Date.now() - (v.at || 0) > 10_000);
  const missing = paths.filter((p) => stale(rtFileCache.get(k(p))));
  if (missing.length) {
    const req = api(`/api/runtime-sessions/${sid}/files/stat?${missing.map((p) => `path=${encodeURIComponent(p)}`).join("&")}`)
      .then((r) => { for (const f of r.files || []) rtFileCache.set(k(f.path), { ...f, at: Date.now() }); })
      .catch(() => { for (const p of missing) rtFileCache.set(k(p), { path: p, ok: false, at: Date.now() }); });
    for (const p of missing) rtFileCache.set(k(p), req);
    await req;
  }
  await Promise.all(paths.map((p) => rtFileCache.get(k(p))));
  return paths.map((p) => rtFileCache.get(k(p))).filter((f) => f && f.ok);
}

/**
 * 文件地址：图片走 raw；HTML 走路径形式的交互预览（相对引用的同目录资源能解析）。
 * HTML 在沙箱里可以执行脚本，但不给同源权限（读不到控制台 Cookie、调不了接口），也不能导航顶层页面。
 */
const RT_HTML_SANDBOX = "allow-scripts allow-popups allow-forms allow-modals";
function rtFileUrl(sid, f) {
  if (f.kind === "html") return `/api/runtime-sessions/${sid}/files/view/${f.rel.split("/").map(encodeURIComponent).join("/")}?v=${encodeURIComponent(f.mtime || "")}`;
  return `/api/runtime-sessions/${sid}/files/raw?path=${encodeURIComponent(f.path)}&v=${encodeURIComponent(f.mtime || "")}`;
}

/**
 * 只写了文件名（没带目录）时，用本会话其他地方出现过的同名完整路径补上候选：
 * 模型常先说「文件在 artifacts/x/」，再只列文件名。候选仍由服务端核对是否存在、是否在工作目录内。
 */
let rtRefIndex = { events: null, size: -1, byName: new Map() };
function rtExpandRefs(paths) {
  const events = ui.rt.events || [];
  if (rtRefIndex.events !== events || rtRefIndex.size !== events.length) {
    const byName = new Map();
    for (const e of events) {
      const text = e.kind === "tool" ? `${e.tool?.input || ""}\n${e.tool?.output || ""}` : e.kind === "message" ? e.text : "";
      for (const p of rtFileRefs(text, 40)) {
        if (!p.includes("/")) continue;
        const name = p.split("/").pop();
        if (!byName.has(name)) byName.set(name, []);
        if (!byName.get(name).includes(p)) byName.get(name).push(p);
      }
    }
    rtRefIndex = { events, size: events.length, byName };
  }
  const out = [];
  for (const p of paths) {
    out.push(p);
    if (!p.includes("/")) for (const full of (rtRefIndex.byName.get(p) || []).slice(0, 3)) if (!out.includes(full)) out.push(full);
  }
  return out.slice(0, 30);
}

/** 一组预览卡片：先占位不显示，服务端确认后填入；同一个文件（相对 / 绝对写法）只出现一次 */
function rtFileStrip(sid, rawPaths, opts = {}) {
  if (!sid || !rawPaths.length) return null;
  const paths = rtExpandRefs(rawPaths);
  const box = h("div", { class: "rt-files", hidden: true });
  void rtStatFiles(sid, paths).then((files) => {
    const seen = new Set();
    const cards = files.filter((f) => !seen.has(f.absPath) && seen.add(f.absPath)).map((f) => rtFileCard(sid, f, opts));
    box.replaceChildren(...cards);
    box.hidden = !cards.length;
  });
  return box;
}

/**
 * 运行时记录的「查看图片」：小号预览图，点一下看大图。
 * 事件里只有路径，图片按需经 file-content 读取（本会话引用过的临时文件也可读），读不到就退回文字，不静默丢消息。
 */
function rtViewedImage(sid, path, event) {
  const name = String(path || "").split("/").pop() || "图片";
  const label = h("span", { class: "rt-image-ref-name", title: path }, name);
  if (!sid || !path) return label;
  const url = `/api/runtime-sessions/${encodeURIComponent(sid)}/file-content?path=${encodeURIComponent(path)}`;
  const img = h("img", { src: `${url}&size=thumb`, alt: name, loading: "lazy", decoding: "async" });
  const button = h("button", {
    type: "button", class: "rt-image-thumb rt-image-ref-thumb", title: `查看大图：${path}`, "aria-label": `查看图片 ${name}`,
    onclick: (ev) => {
      if (typeof openImageZoom === "function") {
        const item = { src: `${url}&size=view`, original: url, name, kind: "file", path, ...(event?.key ? { key: event.key } : {}), ...(Number.isInteger(event?.seq) ? { seq: event.seq } : {}) };
        if (!rtOpenSessionImages(sid, item, ev.currentTarget)) openImageZoom([item], 0);
      }
      else if (typeof openFilePreview === "function") openFilePreview({ path }, { sessionId: sid }, ev.currentTarget);
    }
  }, img);
  img.addEventListener("error", () => button.replaceWith(h("span", { class: "rt-image-ref-missing" }, `查看图片：${path}（图片不可读）`)));
  return h("span", { class: "rt-image-ref" }, button, label);
}

/** 预览卡片：可折叠；图片缩略图 / HTML 沙箱预览；放大、新标签打开、在访达中显示（本机入口）、复制路径 */
function rtFileCard(sid, f, opts) {
  const key = `${sid}|${f.absPath}`;
  const opened = ui.rt.fileOpen || (ui.rt.fileOpen = {});
  const open = opened[key] ?? !opts.collapsed;
  const name = f.rel.split("/").pop();
  const url = rtFileUrl(sid, f);
  const local = ui.rt.access && !ui.rt.access.public;
  const card = h("div", { class: `rt-file-card ${f.kind}${open ? " open" : ""}` },
    h("div", { class: "rt-file-head" },
      h("button", { type: "button", class: "rt-file-toggle", "aria-expanded": String(open), title: open ? "收起预览" : "展开预览", onclick: () => { opened[key] = !open; card.replaceWith(rtFileCard(sid, f, opts)); } },
        h("span", { class: `rt-caret${open ? " open" : ""}`, "aria-hidden": "true" }, "›"),
        h("span", { class: "rt-file-kind" }, f.kind === "image" ? "图片" : "HTML"),
        h("span", { class: "rt-file-name" }, name)),
      h("span", { class: "rt-file-path", title: f.absPath }, f.rel),
      h("span", { class: "rt-file-actions" },
        h("button", { type: "button", class: "rt-file-act", onclick: ev => rtLightbox(sid, f, ev.currentTarget) }, "放大"),
        f.kind === "html" ? h("button", { type: "button", class: "rt-file-act", onclick: ev => rtCollectFile(sid, f, ev.currentTarget) }, "加入产物") : null,
        h("a", { class: "rt-file-act", href: url, target: "_blank", rel: "noopener noreferrer" }, "新标签打开"),
        local ? h("button", { type: "button", class: "rt-file-act", onclick: (ev) => rtRevealFile(sid, f, ev.currentTarget) }, "在访达中显示") : null,
        rtCopyButton(f.absPath, "复制路径", { class: "rt-file-act", announce: "已复制文件路径" }))),
    open ? (f.kind === "image"
      ? h("button", { type: "button", class: "rt-file-thumb", title: "放大查看", onclick: ev => rtLightbox(sid, f, ev.currentTarget) }, h("img", { src: `${url}&size=thumb`, alt: name, loading: "lazy", decoding: "async" }))
      : h("iframe", { class: "rt-file-frame", src: url, sandbox: RT_HTML_SANDBOX, title: `预览：${name}`, loading: "lazy" })) : null);
  return card;
}

async function rtRevealFile(sid, f, btn) {
  const label = btn.textContent;
  try {
    await api(`/api/runtime-sessions/${sid}/files/reveal`, { method: "POST", body: JSON.stringify({ path: f.path }) });
    btn.textContent = "✓ 已在访达中显示";
  } catch (e) { btn.textContent = "打开失败"; if (typeof announce === "function") announce(`打开失败：${e.message}`); }
  setTimeout(() => { btn.textContent = label; }, 1800);
}

/** 放大浮层：图片按窗口适配，点图片切换原始尺寸；HTML 用大尺寸沙箱预览。Esc / 点背景 / × 关闭 */
let rtLightboxKey = null;
function rtCloseLightbox() {
  document.querySelector(".rt-lightbox")?.remove();
  document.body.classList.remove("rt-lightbox-open");
  if (rtLightboxKey) { document.removeEventListener("keydown", rtLightboxKey); rtLightboxKey = null; }
}
function rtLightbox(sid, f, trigger) {
  rtCloseLightbox();
  const url = rtFileUrl(sid, f);
  // 图片统一用放大查看器（缩放 / 拖动 / 压缩图 + 原图），和看上传图片一致
  if (f.kind === "image" && typeof openImageZoom === "function") {
    const row = trigger?.closest?.('.rt-row[data-ev-key]');
    const item = { src: `${url}&size=view`, original: url, name: f.rel, kind: "file", path: f.path, ...(row?.dataset.evKey ? { key: row.dataset.evKey } : {}), ...(Number(row?.dataset.evSeq) ? { seq: Number(row.dataset.evSeq) } : {}) };
    if (!rtOpenSessionImages(sid, item, trigger)) openImageZoom([item], 0);
    return;
  }
  const local = ui.rt.access && !ui.rt.access.public;
  const media = f.kind === "image"
    ? h("img", { src: url, alt: f.rel, title: "点击切换原始尺寸", onclick: (ev) => ev.currentTarget.classList.toggle("actual") })
    : h("iframe", { src: url, sandbox: RT_HTML_SANDBOX, title: `预览：${f.rel}` });
  const body = h("div", { class: "rt-lightbox-body", onclick: (ev) => { if (ev.target === ev.currentTarget) rtCloseLightbox(); } }, media);
  const el = h("div", { class: "rt-lightbox", role: "dialog", "aria-modal": "true", "aria-label": `查看 ${f.rel}` },
    h("div", { class: "rt-lightbox-bar" },
      h("span", { class: "rt-lightbox-name", title: f.absPath }, f.rel),
      h("a", { class: "rt-file-act", href: url, target: "_blank", rel: "noopener noreferrer" }, "新标签打开"),
      local ? h("button", { type: "button", class: "rt-file-act", onclick: (ev) => rtRevealFile(sid, f, ev.currentTarget) }, "在访达中显示") : null,
      rtCopyButton(f.absPath, "复制路径", { class: "rt-file-act", announce: "已复制文件路径" }),
      h("button", { type: "button", class: "rt-lightbox-close", "aria-label": "关闭", title: "关闭（Esc）", onclick: rtCloseLightbox }, "×")),
    body);
  document.body.append(el);
  document.body.classList.add("rt-lightbox-open");
  rtLightboxKey = (ev) => { if (ev.key === "Escape") rtCloseLightbox(); };
  document.addEventListener("keydown", rtLightboxKey);
  el.querySelector(".rt-lightbox-close").focus();
}
globalThis.piRouteModules?.register("rt-transcript", {});


function rtLazyFold(attrs, summary, body, flags, key) {
  const open = !!(ui.rt.openFolds || {})[key];
  let loaded = false;
  const content = h("div", { class: "rt-lazy-body" });
  const load = () => { if (!loaded) { loaded = true; content.append(body()); } };
  const fold = h("details", { ...attrs, open, "data-rt-fold": key, ontoggle: ev => {
    (ui.rt.openFolds ||= {})[key] = ev.currentTarget.open;
    if (ev.currentTarget.open) load();
  } }, summary, flags, content);
  if (open) load();
  return fold;
}

/** A session gallery is metadata-only until its current/neighbor images are displayed. */
let rtImageGalleryGeneration = 0;
function rtGalleryImage(entry, sid) {
  const base = `/api/runtime-sessions/${encodeURIComponent(sid)}`;
  let url;
  if (entry.kind === 'attachment') url = rtAttachmentUrl({ attachmentId: entry.attachmentId }, sid);
  else if (entry.kind === 'generated') url = `${base}/images/${entry.seq}`;
  else url = `${base}/file-content?path=${encodeURIComponent(entry.path)}${(entry.hints || []).map(hint => `&hint=${encodeURIComponent(hint)}`).join('')}`;
  return { ...entry, original: url, src: `${url}${url.includes('?') ? (/[?&]$/.test(url) ? '' : '&') : '?'}size=view` };
}
function rtGalleryResource(item) {
  try {
    const url = new URL(item.original || item.src, location.href);
    const path = url.searchParams.get('path');
    if (path) {
      let local = path.startsWith('file://') ? decodeURIComponent(new URL(path).pathname) : path;
      const parts = [];
      for (const segment of local.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
        else parts.push(segment);
      }
      return `file:${local.startsWith('/') ? '/' : ''}${parts.join('/')}`;
    }
    url.searchParams.delete('size'); url.searchParams.delete('thumbnail');
    return `${url.pathname}?${url.searchParams.toString().replace(/&$/, '')}`;
  } catch { return item.original || item.src; }
}
function rtArtifactSource(sid, item) {
  if (!sid || !item || !item.kind) return null;
  const title = ui.rt.view?.session?.title || '';
  const shared = { sessionId: sid, ...(item.name ? { name: item.name } : {}), ...(item.key ? { eventKey: item.key } : {}), ...(Number.isInteger(item.seq) && item.seq > 0 ? { eventSeq: item.seq } : {}), ...(title ? { sessionTitle: title } : {}) };
  if (item.kind === 'attachment' && item.attachmentId) return { type: 'attachment', ...shared, attachmentId: item.attachmentId };
  if (item.kind === 'generated' && Number.isInteger(item.seq)) return { type: 'generated', ...shared, seq: item.seq };
  if (item.kind === 'file' && item.path) return { type: 'file', ...shared, path: item.path, ...(item.hints?.length ? { hints: item.hints } : {}) };
  return null;
}
/** 图片放大器里的产物控件：切到哪张就绑哪张的来源，右下角一键打标。 */
function rtCollectControl(sid, item, helpers) {
  if (typeof window.piArtifactCollect?.control !== 'function') return null;
  const source = rtArtifactSource(sid, item);
  if (!source) return null;
  const kind = item.kind === 'document' ? 'document' : item.kind === 'video' ? 'video' : 'image';
  return window.piArtifactCollect.control({ kind, title: item.name || item.title || '', source, variant: 'dark', capture: helpers?.capture });
}
/** HTML 文件卡片上的「加入产物」：来源就是这张卡片所在的工具 / 消息行；同样交给 DeepSeek 打标。 */
function rtCollectFile(sid, f, trigger) {
  if (typeof window.piArtifactCollect?.quickAdd !== 'function') return;
  const row = trigger?.closest?.('.rt-row[data-ev-key]');
  const name = f.rel.split('/').pop();
  const source = { type: 'file', sessionId: sid, path: f.path, name, ...(row?.dataset.evKey ? { eventKey: row.dataset.evKey } : {}), ...(Number(row?.dataset.evSeq) ? { eventSeq: Number(row.dataset.evSeq) } : {}) };
  void window.piArtifactCollect.quickAdd({ kind: 'document', title: name, source });
}
function rtOpenSessionImages(sid, initial, trigger) {
  const row = trigger?.closest?.('.rt-row[data-ev-key]');
  const box = trigger?.closest?.('.rt-transcript');
  if (typeof openImageZoom !== 'function' || ui.view !== 'rt' || rtId() !== sid || !row || !box || !['chat', 'tools'].includes(ui.rt.tab)) return false;
  const generation = ++rtImageGalleryGeneration, gen = ui.rt.gen;
  const current = () => rtImageGalleryGeneration === generation && ui.view === 'rt' && rtId() === sid && ui.rt.gen === gen && box.isConnected;
  const entry = { ...initial, key: row.dataset.evKey, seq: Number(row.dataset.evSeq) };
  const reading = sessionReadingCapture(box, false);
  ui.rt.atBottom = false;
  box.rtNavigating = true;
  async function reveal(target, restoreReading) {
    if (!current()) return;
    box.rtNavigating = true;
    const find = () => box.querySelector(`.rt-row[data-ev-key="${CSS.escape(target.key || '')}"]`);
    try {
      const anchorPresent = restoreReading && [...box.querySelectorAll('[data-ev-seq]')].some(n => Number(n.dataset.evSeq) === reading.seq);
      const grouped = [...box.querySelectorAll('.rt-steps')].some(n => n.rtStepKeys?.has(target.key));
      if (!find() && !grouped && !anchorPresent) {
        const seq = restoreReading ? reading.seq ?? target.seq : target.seq;
        const page = await api(`/api/runtime-sessions/${encodeURIComponent(sid)}/messages?after=${Math.max(0, seq - 1)}&limit=100`);
        if (!current()) return;
        if (!page.events?.length || !restoreReading && !page.events.some(e => e.key === target.key)) throw new Error('消息已不可用');
        if (typeof sessionSyncInvalidate === 'function') sessionSyncInvalidate({ kind: 'rt', id: sid });
        ui.rt.events = page.events; ui.rt.hasMoreBefore = !!page.hasMoreBefore || (page.firstSeq ?? page.events[0]?.seq) > 1;
        ui.rt.trimmedTail = page.hasMoreAfter; ui.rt.total = page.total;
        ui.rt.panelRevision = (ui.rt.panelRevision || 0) + 1;
        rtRerenderTranscript(box);
        box.querySelector('.rt-earlier')?.remove();
        if (ui.rt.hasMoreBefore) box.prepend(rtEarlierButton('加载更早的记录'));
      }
      if (!current()) return;
      if (restoreReading) {
        sessionReadingRestore(box, reading);
        ui.rt.reading = sessionReadingCapture(box, false);
        if (trigger.isConnected) trigger.focus({ preventScroll: true });
      } else {
        // Tool images can live in an unrendered, folded process group.
        const group = [...box.querySelectorAll('.rt-steps')].find(n => n.rtStepKeys?.has(target.key));
        if (group && !find()) {
          (ui.rt.openSteps ||= {})[group.dataset.stepsKey] = true;
          rtRerenderTranscript(box);
        }
        const destination = find();
        if (!destination) throw new Error('消息已不可用');
        for (let parent = destination.parentElement; parent && parent !== box; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
        for (const marked of box.querySelectorAll('.rt-image-location')) marked.classList.remove('rt-image-location');
        destination.classList.add('rt-image-location');
        box.scrollTop += destination.getBoundingClientRect().top - box.getBoundingClientRect().top - 16;
        destination.tabIndex = -1; destination.focus({ preventScroll: true });
        ui.rt.reading = sessionReadingCapture(box, false);
      }
      rtPatchNewCount();
    } finally { if (current()) box.rtNavigating = false; }
  }
  openImageZoom([entry], 0, {
    closeOnNavigate: true,
    loadItems: async () => {
      const result = await api(`/api/runtime-sessions/${encodeURIComponent(sid)}/image-index`);
      if (!current()) throw new Error('会话已切换');
      const items = (result.items || []).map(item => rtGalleryImage(item, sid));
      const resource = rtGalleryResource(entry);
      let index = items.findIndex(item => item.key === entry.key && rtGalleryResource(item) === resource);
      if (index < 0) {
        // A just-finished stream record may precede its persisted index. Keep the clicked image and its exact source.
        items.push(entry); items.sort((a, b) => a.seq - b.seq); index = items.indexOf(entry);
      }
      return { items, index };
    },
    onLocate: target => reveal(target, false),
    tagControl: (item, helpers) => rtCollectControl(sid, item, helpers),
    onClose: reason => {
      if (reason === 'navigation') { box.rtNavigating = false; return; }
      if (reason !== 'locate') void reveal(entry, true).catch(() => { if (current()) announce('返回进入位置失败，请重试'); });
    }
  });
  return true;
}

/**
 * 产物里的「回到会话」：切到会话页，必要时补读目标消息所在的那一页，再滚到那条消息并高亮。
 * 会话已删除时由调用方先核对并提示；这里找不到消息就返回 false，不把页面留在空白状态。
 */
async function piRevealSessionEvent(sid, target = {}) {
  const id = String(sid || '');
  if (!id) return false;
  if (ui.view !== 'rt' || rtId() !== id) {
    const arrived = await new Promise((resolve) => {
      let timer = 0;
      const finish = (ok) => {
        if (timer) clearTimeout(timer);
        window.removeEventListener('hashchange', check);
        resolve(ok);
      };
      const check = () => { if (ui.view === 'rt' && rtId() === id) finish(true); };
      window.addEventListener('hashchange', check);
      location.hash = '#/rt/' + encodeURIComponent(id);
      check();
      timer = setTimeout(() => finish(false), 8000);
    });
    if (!arrived) return false;
  }
  if (ui.rt.tab !== "chat" && ui.rt.tab !== "tools" && typeof rtSwitchTab === "function") rtSwitchTab("chat");
  let box = null;
  for (let i = 0; i < 50 && !box; i++) {
    box = document.querySelector('.rt-transcript');
    if (!box) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!box) return false;
  const key = target.key ? String(target.key) : '';
  const seq = Number(target.seq) || 0;
  const selector = key ? `.rt-row[data-ev-key="${CSS.escape(key)}"]` : seq ? `.rt-row[data-ev-seq="${seq}"]` : '';
  const find = () => selector ? box.querySelector(selector) : null;
  let destination = find();
  if (!destination && key) {
    // Tool images can live in an unrendered, folded process group.
    const group = [...box.querySelectorAll('.rt-steps')].find(n => n.rtStepKeys?.has(key));
    if (group) {
      (ui.rt.openSteps ||= {})[group.dataset.stepsKey] = true;
      rtRerenderTranscript(box);
      destination = find();
    }
  }
  if (!destination && seq > 0) {
    try {
      const page = await api(`/api/runtime-sessions/${encodeURIComponent(id)}/messages?after=${Math.max(0, seq - 1)}&limit=100`);
      if (page.events?.length) {
        if (typeof sessionSyncInvalidate === 'function') sessionSyncInvalidate({ kind: 'rt', id });
        ui.rt.events = page.events;
        ui.rt.hasMoreBefore = !!page.hasMoreBefore || (page.firstSeq ?? page.events[0]?.seq) > 1;
        ui.rt.trimmedTail = page.hasMoreAfter;
        ui.rt.total = page.total;
        ui.rt.panelRevision = (ui.rt.panelRevision || 0) + 1;
        rtRerenderTranscript(box);
        box.querySelector('.rt-earlier')?.remove();
        if (ui.rt.hasMoreBefore) box.prepend(rtEarlierButton('加载更早的记录'));
      }
    } catch { /* 读取失败就按当前已渲染的消息找 */ }
    destination = find();
  }
  if (!destination) return false;
  for (let parent = destination.parentElement; parent && parent !== box; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
  for (const marked of box.querySelectorAll('.rt-image-location')) marked.classList.remove('rt-image-location');
  destination.classList.add('rt-image-location');
  box.scrollTop += destination.getBoundingClientRect().top - box.getBoundingClientRect().top - 16;
  destination.tabIndex = -1;
  destination.focus({ preventScroll: true });
  ui.rt.reading = sessionReadingCapture(box, false);
  if (typeof rtPatchNewCount === 'function') rtPatchNewCount();
  return true;
}
window.piRevealSessionEvent = piRevealSessionEvent;
