"use strict";

/** The directory only needs the outcome and target commit, never the commit subject or live baseline. */
function rtDeploymentIndexSummary(notice) {
  const commit = /(?:^已上线：|^不用部署：|^没有部署 |^部署 |放弃部署 )([a-f0-9]{7,40})(?![a-f0-9])/i.exec(notice.summary)?.[1];
  return notice.title + (commit ? ` · ${commit.slice(0, 7)}` : "");
}

/** Compact transcript copy; the original notice remains available in the fold and copy action. */
function rtDeploymentCompact(notice) {
  const commit = /(?:^已上线：|^不用部署：|^没有部署 |^部署 |放弃部署 )([a-f0-9]{7,40})(?![a-f0-9])/i.exec(notice.summary)?.[1];
  const subject = commit ? new RegExp(`${commit}（([^\\n]+?)）`).exec(notice.summary)?.[1] : null;
  return { commit: commit?.slice(0, 7), summary: subject || notice.summary };
}

/** The deploy worker's stable prefix also covers notifications already in history.
 * Only whole user messages qualify; quoted notices and assistant explanations stay ordinary chat. */
function rtDeploymentNotice(event) {
  if (event.kind !== "message" || event.role !== "user" || event.attachments?.length) return null;
  const match = /^\[pi-agent 自动部署通知\] ([^\n]+)(?:\n([\s\S]*))?$/.exec(event.text || "");
  if (!match) return null;
  const summary = match[1].trim();
  const result = summary.startsWith("已上线：") ? ["部署成功", "ok"]
    : summary.startsWith("不用部署：") ? ["已在线上", "ok"]
    : /^部署 .*没有成功/.test(summary) ? ["部署失败", "bad"]
    : /^部署 [a-f0-9]{7,40} 门禁未通过，自动重试/.test(summary) ? ["自动重试", "warn"]
    : summary.startsWith("等空闲超时") ? ["部署超时", "warn"]
    : summary.startsWith("没有部署 ") ? ["未部署", "warn"] : ["部署结果", ""];
  const body = (match[2] || "").trim();
  // The worker always appends the log as its final line. Do not consume similar text in diagnostics.
  const log = /(?:^|\n)部署日志：([^\n]+)$/.exec(body);
  return { title: result[0], tone: result[1], summary,
    requestId: /^部署请求：([^\n]+)$/m.exec(body)?.[1],
    requestSha: /^请求提交：([a-f0-9]{7,40})$/mi.exec(body)?.[1],
    detail: (log ? body.slice(0, log.index) : body).trim(), log: log?.[1].trim() || "" };
}
/**
 * 强约束检查的自动反馈（平台以 system:memory-enforcement 发给会话的那条消息，正文以固定前缀开头）：
 * 它是平台的旁白，不是用户的发言，和部署通知一样画成居中的系统消息；完整正文收进「详情」。
 * 只认整条用户消息；被引用的、助手转述的仍是普通对话。
 */
const RT_ENFORCEMENT_MARK = "\u3010\u5e73\u53f0\u5f3a\u7ea6\u675f\u68c0\u67e5\u672a\u901a\u8fc7\u3011";
function rtEnforcementFeedback(event) {
  return event?.kind === "message" && event.role === "user" && !event.attachments?.length && String(event.text || "").startsWith(RT_ENFORCEMENT_MARK);
}
function rtEnforcementNotice(event) {
  if (event.kind === "notice" && event.enforcement) {
    const groups = event.enforcementGroups || [event];
    const counts = { skipped: 0, passed: 0, failed: 0 };
    const labels = { skipped: "跳过", passed: "通过", failed: "未通过", exhausted: "未通过（已停止自动提醒）" };
    const details = groups.map(e => {
      if (rtEnforcementFeedback(e)) return `自动补救指令：\n${e.text}`;
      const check = e.enforcement;
      const phase = check.phase === "exhausted" ? "failed" : check.phase;
      if (Object.hasOwn(counts, phase)) counts[phase] += check.rules.length;
      return [e.text, ...check.rules.map(r => [
        `${labels[check.phase] || check.phase} · ${r.title}`,
        `记忆「${r.topic}」：${r.statement}`,
        r.note ? `原因：${r.note}` : null,
        r.problem ? `问题：${r.problem}` : null,
        r.fix ? `怎么改：${r.fix}` : null
      ].filter(Boolean).join("\n"))].filter(Boolean).join("\n\n");
    });
    return { title: "强约束校验", counts, tone: counts.failed ? "warn" : "", summary: `通过 ${counts.passed} · 未通过 ${counts.failed} · 跳过 ${counts.skipped}${groups.some(rtEnforcementFeedback) ? " · 已自动启动下一轮补齐" : ""}`, detail: details.join("\n\n") };
  }
  if (event.kind !== "message" || event.role !== "user" || event.attachments?.length) return null;
  const text = String(event.text || "");
  if (!text.startsWith(RT_ENFORCEMENT_MARK)) return null;
  // 自动补救消息只携带失败项；没有通过和跳过的数据时不把未知数量写成零。
  const count = [...text.matchAll(/(?:^|\n)（\d+）记忆「/g)].length;
  return { title: "强约束检测", tone: "warn", summary: count ? `未通过 ${count}` : "未通过", detail: text.slice(RT_ENFORCEMENT_MARK.length).trim() };
}
/*
 * 多运行时 chat 的展示部件：模型系列图标 + 运行时角标、按工作目录分组、助手回复的 Markdown 排版。
 *
 * 安全约定同 app.js：一律经 h() 建 DOM（textContent），不使用 innerHTML；链接只放行 http(s)。
 * 图标来自 /logos（logos/NOTICE.md），以 <img> 引用，避免内联 SVG 的 id 冲突。
 */

/* ------------------------------ 对话输入框自适应高度 ------------------------------ */
/*
 * 输入框随内容向上撑高，方便阅读已经输入的内容；到达 CSS max-height 后改在框内滚动。
 * 手机宽度下未激活时仍收成一行（第一行输入、第二行操作区），聚焦或输入时再撑高，失焦后收回。
 * 群聊输入框每次输入都会整块重绘，所以事件委托并把测量延后一帧取当前聚焦的输入框。
 */
const rtPhoneComposer = window.matchMedia("(max-width: 760px)");
// 只接管对话输入胶囊里的多行输入框，普通表单的 textarea 仍保持原高度
const rtComposerInput = (el) => el instanceof HTMLTextAreaElement && el.classList.contains("rt-input") && !!el.closest(".rt-compose-row");

const rtAutosizeLast = new WeakMap();
function rtAutosizeComposer(el) {
  if (!rtComposerInput(el)) return;
  const scrollTop = el.scrollTop;
  // 输入框撑高会压缩消息区；原本贴着最新消息时，同步缩进滚动位置，别让最新内容被挤出视野
  const transcript = el.closest(".rt-center")?.querySelector(".rt-transcript");
  const stayAtBottom = !!transcript && transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
  const style = getComputedStyle(el);
  const limit = parseFloat(style.maxHeight);
  // 内容、宽度、上限都没变且已经（正在）去往这个高度：不用重量，重量会打断正在跑的过渡并让它重新起步
  const last = rtAutosizeLast.get(el);
  if (last && last.value === el.value && last.limit === limit && last.width === el.clientWidth && el.style.height === `${last.height}px`) return;
  // 手机上高度有过渡：量高要暂停过渡，量完再从原来的高度滑到新高度，否则会从 0 / 默认高度反复折腾
  const from = el.offsetHeight;
  el.style.transition = "none";
  // 恢复 CSS 默认高度（桌面 rows=2、手机一行）取基线，避免聚焦空输入框时反而缩矮
  el.style.height = "";
  const min = Math.max(parseFloat(style.minHeight) || 0, el.offsetHeight);
  // 再归零读 scrollHeight：避免 textarea 默认 rows 把一行内容也撑成两行（min-height 仍兜底）
  el.style.height = "0px";
  el.style.overflowY = "hidden";
  const content = Math.max(min, el.scrollHeight);
  const height = Number.isFinite(limit) ? Math.min(content, limit) : content;
  const overflowing = el.scrollHeight > height + 1;
  // 量高时把高度设成过 0px（被 min-height 夹成 44px 并已排过版）；恢复过渡前必须先把高度还原成量之前的 from，
  // 否则过渡会从 44px 起步——哪怕这次高度几乎没变（差 ≤1px），每敲一个字输入框都会先塌到 44px 再爬回来。
  if (rtPhoneComposer.matches) {
    el.style.height = `${from}px`;
    void el.offsetHeight;
  }
  el.style.transition = "";
  el.style.height = `${height}px`;
  rtAutosizeLast.set(el, { value: el.value, limit, width: el.clientWidth, height });
  el.style.overflowY = overflowing ? "auto" : "hidden";
  el.scrollTop = scrollTop;
  if (stayAtBottom) rtKeepTranscriptBottom(transcript, true);
}

/**
 * 输入框高度、键盘（原生壳里是 WebView 一帧一帧缩短）都会让消息区变矮：原本贴着最新消息的，
 * 在这段时间里每帧都贴回底部，最新消息跟着输入区一起上移，不会被盖住或一下子跳开。
 */
const rtPinTimers = new WeakMap();
function rtKeepTranscriptBottom(transcript, stuck, ms = 600) {
  if (!transcript || !stuck) return;
  transcript.scrollTop = transcript.scrollHeight;
  // 桌面只需要这一下；手机上键盘 / 输入框高度在动画，持续贴底
  if (!rtPhoneComposer.matches) return;
  const until = performance.now() + ms;
  if (rtPinTimers.get(transcript)) { rtPinTimers.get(transcript).until = until; return; }
  const state = { until };
  rtPinTimers.set(transcript, state);
  const tick = () => {
    if (!transcript.isConnected || performance.now() > state.until) { rtPinTimers.delete(transcript); return; }
    transcript.scrollTop = transcript.scrollHeight;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
const rtTranscriptStuck = (el) => {
  const transcript = el.closest(".rt-center")?.querySelector(".rt-transcript");
  return transcript && transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40 ? transcript : null;
};

function rtResetComposerHeight(el) {
  if (!rtComposerInput(el)) return;
  rtAutosizeLast.delete(el);
  el.style.height = "";
  el.style.overflowY = "";
}

const rtComposerTarget = () => rtComposerInput(document.activeElement) ? document.activeElement : null;
// 输入/聚焦后重绘可能替换节点：优先量事件目标，已被替换时退回到当前的聚焦输入框；手机只量聚焦中的输入框
const rtRefreshComposer = (el) => requestAnimationFrame(() => {
  const target = rtComposerInput(el) && el.isConnected ? el : rtComposerTarget();
  if (!target || (rtPhoneComposer.matches && target !== rtComposerTarget())) return;
  rtAutosizeComposer(target);
});
document.addEventListener("focusin", (ev) => {
  if (!rtComposerInput(ev.target)) return;
  // 键盘动画从聚焦这一刻开始：趁消息区还没变矮，记下它是不是贴着底部
  if (rtPhoneComposer.matches) rtKeepTranscriptBottom(rtTranscriptStuck(ev.target), true);
  rtRefreshComposer(ev.target);
});
document.addEventListener("input", (ev) => { if (rtComposerInput(ev.target)) rtRefreshComposer(ev.target); });
// 键盘弹起 / 收起会改变输入框的高度上限（按看得见的高度收）：窗口停止变化后再按新上限量一次。
// 不能每帧量——原生壳里键盘动画期间 WebView 每帧都在缩短，每帧强制重排会卡。
let rtKeyboardSettle = 0;
window.addEventListener("resize", () => {
  if (!rtPhoneComposer.matches || !rtComposerTarget()) return;
  // 窗口还在一帧帧变化：正在贴底的就顺延，别在动画中途停下
  const pinned = rtComposerTarget().closest(".rt-center")?.querySelector(".rt-transcript");
  const pin = pinned && rtPinTimers.get(pinned);
  if (pin) pin.until = performance.now() + 250;
  clearTimeout(rtKeyboardSettle);
  rtKeyboardSettle = setTimeout(() => { if (rtComposerTarget()) rtRefreshComposer(); }, 120);
});
// 手机失焦收回一行；桌面保留与草稿内容相称的高度，草稿为空时收回默认高度
document.addEventListener("focusout", (ev) => {
  if (!rtComposerInput(ev.target)) return;
  if (rtPhoneComposer.matches) rtKeepTranscriptBottom(rtTranscriptStuck(ev.target), true);
  if (rtPhoneComposer.matches || !ev.target.value) rtResetComposerHeight(ev.target);
  else rtAutosizeComposer(ev.target);
});
// 跨过断点或改变窗口宽度时重新量：手机宽度下未聚焦的输入框收回一行，桌面宽度下按内容撑高
let rtComposerResizeFrame = 0;
document.addEventListener("resize", () => {
  cancelAnimationFrame(rtComposerResizeFrame);
  rtComposerResizeFrame = requestAnimationFrame(() => {
    document.querySelectorAll("textarea.rt-input").forEach(el => rtComposerInput(el) && (rtPhoneComposer.matches && el !== document.activeElement ? rtResetComposerHeight(el) : rtAutosizeComposer(el)));
  });
});
rtPhoneComposer.addEventListener("change", () => {
  document.querySelectorAll("textarea.rt-input").forEach(el => rtComposerInput(el) && (rtPhoneComposer.matches ? rtResetComposerHeight(el) : rtAutosizeComposer(el)));
  if (rtPhoneComposer.matches) rtRefreshComposer();
});

/** Shared @ picker: the prompt contains metadata only, never a transcript snapshot. */
let rtMentionSequence = 0;
const RT_SESSION_DRAG_TYPE = "application/x-pi-session-reference";
let rtDraggedSession = null;
function rtSessionReference(entry) {
  const label = String(entry.title || entry.id).replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]/g, " ");
  const url = new URL(`/#/rt/${encodeURIComponent(entry.id)}`, location.origin).href;
  // Escape delimiters only when needed, keeping ordinary references readable to the runtime.
  const field = value => /[；（）\r\n"\\]/.test(String(value))
    ? JSON.stringify(String(value)).replace(/[；（）]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`) : String(value);
  const details = [`会话 ID：${field(entry.id)}`, `运行时：${field(entry.runtimeKind)}`, ...(entry.nativeSessionId ? [`原生会话 ID：${field(entry.nativeSessionId)}`] : []), ...(entry.workspace ? [`工作目录：${field(entry.workspace)}`] : [])];
  return `[@${label}](${url})（${details.join("；")}）`;
}
/** Rehydrate existing serialized drafts without fetching a transcript. */
function rtSessionReferenceDraft(value) {
  const references = [];
  const text = String(value || "").replace(/\[@((?:\\.|[^\]\n])*)\]\((https?:\/\/[^\s)]+\/#\/rt\/([^\s)]+))\)（(会话 ID：[^\n]*?)）[ \n]?/g, (full, label, url, encodedId, details) => {
    let id;
    try { id = decodeURIComponent(encodedId); } catch { return full; }
    let fields;
    try {
      fields = Object.fromEntries(details.split("；").map(part => {
        const at = part.indexOf("："), value = part.slice(at + 1);
        return [part.slice(0, at), value.startsWith('"') ? JSON.parse(value) : value];
      }));
    } catch { return full; }
    if (fields["会话 ID"] !== id || !fields["运行时"]) return full;
    if (!references.some(ref => ref.entry.id === id)) {
      const known = ui.rt?.dir?.entries?.find(e => e.id === id);
      references.push({ entry: { ...known, id, title: label.replace(/\\(.)/g, "$1"), runtimeKind: fields["运行时"], workspace: fields["工作目录"], nativeSessionId: fields["原生会话 ID"] }, reference: full.trimEnd() });
    }
    return "";
  });
  return { text, references };
}
/**
 * 输入框里的「待办引用」：从待办发起对话时，noteConversationPrompt 用固定格式把正文引进来。
 * 这里把它识别成带 🔗 的 chip（和 @ 会话引用不是一回事）：显示时从正文里剥离，发送时再原样拼回去。
 * 一条消息里可有多段待办引用；每段以 markdown 引用块给出原文，后面可跟一句图片说明。
 */
const RT_NOTE_QUOTE_HEAD = /^引用待办记录（记于 ([^）\n]+)）：\n\n/;
/** 「问询」平台记忆：记忆页详情里的问询按钮（memory-public.js 的 pmAskPrompt）用固定格式把这条记忆和它的背景引进来。
 *  引用块第一行是那条记忆的一句话规则，后面是「背景：」若干行，整块都是 > 引用行；chip 的标签取第一行，点 chip 回到这条记忆。 */
const RT_MEMORY_QUOTE_HEAD = /^引用平台记忆（编号 (t-[\w-]+) · ([^）\n]+)）：\n\n/;
function rtNoteQuoteOne(text) {
  const noteHead = RT_NOTE_QUOTE_HEAD.exec(text), memoryHead = noteHead ? null : RT_MEMORY_QUOTE_HEAD.exec(text);
  const head = noteHead || memoryHead;
  if (!head) return null;
  const lines = text.slice(head[0].length).split("\n");
  const quoted = [];
  while (quoted.length < lines.length && lines[quoted.length].startsWith(">")) quoted.push(lines[quoted.length]);
  if (!quoted.length) return null;
  let block = head[0] + quoted.join("\n");
  let rest = lines.slice(quoted.length).join("\n");
  const tail = noteHead ? /^\n+（这条记录附带的图片见附件）/.exec(rest) : null;
  if (tail) { block += tail[0]; rest = rest.slice(tail[0].length); }
  const quote = quoted.map((line) => line.replace(/^>\s?/, "")).join("\n");
  const label = quote.split("\n").find((line) => line.trim()) || "（无正文）";
  const base = { block, quote, label, rest: rest.replace(/^\n+/, "") };
  return memoryHead ? { ...base, kind: "memory", topicId: memoryHead[1], scope: memoryHead[2] } : { ...base, kind: "note", stamp: head[1] };
}
function rtNoteQuotes(value) {
  let rest = String(value || "");
  const quotes = [];
  for (let hit; (hit = rtNoteQuoteOne(rest));) { quotes.push(hit); rest = hit.rest; }
  return { quotes, rest };
}
/** 侧栏目录已是完整的普通对话列表（没按运行时或关键字筛过、没有下一页）时，@ 候选直接本地匹配，不发请求。 */
function rtMentionLocalEntries(q) {
  if (typeof rtDirComplete !== "function" || ui.rt?.dirRuntime || !rtDirComplete("")) return null;
  return ui.rt.dir.entries.filter(e => rtDirMatches(e, q));
}
/**
 * 平台级技能目录（输入框 `/` 菜单）。成功后缓存整个页面生命周期；失败不缓存，下次再按 `/` 重试。
 * 菜单只是辅助：目录读不到时 `/` 仍然是普通文字，照常发送，不拦截 runtime 自带的斜杠命令。
 */
let rtPlatformSkillsCache = null, rtPlatformSkillsLoading = null;
function rtLoadPlatformSkills() {
  if (rtPlatformSkillsCache) return Promise.resolve(rtPlatformSkillsCache);
  rtPlatformSkillsLoading ??= api("/api/platform-skills", { readPriority: 1 })
    .then(r => (rtPlatformSkillsCache = Array.isArray(r?.skills) ? r.skills : []), () => [])
    .finally(() => { rtPlatformSkillsLoading = null; });
  return rtPlatformSkillsLoading;
}
function rtFilterPlatformSkills(list, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return list;
  return list.filter(k => k.name.toLowerCase().includes(q) || k.id.toLowerCase().includes(q) || String(k.description || "").toLowerCase().includes(q));
}

function rtSessionMentionInput(attrs, currentId = "") {
  const inputAttrs = { ...attrs };
  delete inputAttrs.onNoteRemove;
  const parsed = rtNoteQuotes(attrs.value);
  const draft = rtSessionReferenceDraft(parsed.rest);
  const references = draft.references;
  let noteQuotes = parsed.quotes;
  const listId = `rt-session-mentions-${++rtMentionSequence}`;
  let generation = 0, timer, composingMention = false, match, entries = [], selected = 0, nextCursor = "", reading = null;
  let slash = null, skillEntries = [];
  const candidates = list => list.filter(e => !e.archived && !e.roomRef && e.id !== currentId && /^#\/rt\//.test(e.href || ""));
  // 事件都经 attrs 转发：加载态的输入框节点会被详情页复用（updateMentionAttrs 换 attrs），
  // 直接绑在 textarea 上的处理函数换不掉——粘贴图片曾因此在详情页失效。
  const input = h("textarea", { ...inputAttrs, ondrop: undefined, ondragover: undefined, value: draft.text, "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": listId,
    onpaste: ev => attrs.onpaste?.(ev),
    oninput: ev => { changed(ev); update(); },
    onclick: () => update(),
    onfocus: () => update(),
    onblur: ev => { if (!host.contains(ev.relatedTarget)) close(); },
    oncompositionstart: () => { composingMention = true; close(); },
    oncompositionend: () => { composingMention = false; update(); },
    onkeydown: ev => {
      if (composingMention || ev.isComposing || ev.keyCode === 229) return;
      if (slash) {
        // `/` 菜单只在有候选时接管按键；没有候选、候选还没加载好、或已经完整敲出技能名时，Enter 照常发送，
        // 这样 Claude Code / Codex / Pi 自带的斜杠命令（/compact 等）不会被菜单吞掉。
        const exact = skillEntries.some(k => slash.query === k.name || slash.query === k.id);
        if (ev.key === "Escape") { ev.preventDefault(); close(); return; }
        if (skillEntries.length && !exact && ["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(ev.key) && !ev.shiftKey) {
          ev.preventDefault();
          if (ev.key === "Enter" || ev.key === "Tab") chooseSkill(skillEntries[selected]);
          else { selected = (selected + (ev.key === "ArrowDown" ? 1 : -1) + skillEntries.length) % skillEntries.length; paintSkills(); }
          return;
        }
        if (ev.key === "Enter") close();
      }
      if (match && ["Escape", "ArrowDown", "ArrowUp", "Enter"].includes(ev.key)) {
        if (ev.key === "Enter" && ev.shiftKey) { close(); attrs.onkeydown?.(ev); return; }
        ev.preventDefault();
        if (ev.key === "Escape") close();
        else if (ev.key === "Enter") { if (entries.length) choose(entries[selected]); }
        else if (entries.length) { selected = (selected + (ev.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length; paint(); }
        return;
      }
      attrs.onkeydown?.(ev);
    },
    onkeyup: ev => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(ev.key)) update(); }
  });
  const panel = h("div", { class: "rt-session-mentions", hidden: true });
  const chips = h("div", { class: "rt-session-chips", "aria-label": "引用的待办、记忆与会话" });
  const host = h("div", { class: "rt-mention-input",
    ondragover: ev => {
      if (ev.dataTransfer?.types.includes(RT_SESSION_DRAG_TYPE)) {
        ev.preventDefault(); ev.stopPropagation();
        if (input.disabled || input.readOnly) { ev.dataTransfer.dropEffect = "none"; return; }
        ev.dataTransfer.dropEffect = "copy"; host.classList.add("rt-reference-drop");
      } else attrs.ondragover?.(ev);
    },
    ondragleave: ev => { if (!host.contains(ev.relatedTarget)) host.classList.remove("rt-reference-drop"); },
    ondrop: ev => {
      host.classList.remove("rt-reference-drop");
      if (!ev.dataTransfer?.types.includes(RT_SESSION_DRAG_TYPE)) { attrs.ondrop?.(ev); return; }
      ev.preventDefault(); ev.stopPropagation();
      if (input.disabled || input.readOnly || !rtDraggedSession || ev.dataTransfer.getData(RT_SESSION_DRAG_TYPE) !== rtDraggedSession.id) return;
      add(rtDraggedSession); close(); input.focus(); changed(ev);
    }
  }, chips, input, panel);
  function changed(ev) {
    const parts = [];
    for (const note of noteQuotes) parts.push(note.block);
    if (references.length) parts.push(references.map(ref => ref.reference).join("\n"));
    if (input.value) parts.push(input.value);
    attrs.oninput?.({ target: { value: parts.join("\n") }, currentTarget: input, originalEvent: ev });
  }
  function noteChip(note) {
    const memory = note.kind === "memory", noun = memory ? "记忆" : "待办";
    const label = `${noun}：${note.label}`;
    return h("span", { class: `rt-note-chip${memory ? " rt-memory-chip" : ""}`, title: note.block },
      typeof rtMiniIcon === "function"
        ? rtMiniIcon(RT_MINI_PATHS.link, { className: "rt-note-chip-link", size: 15 })
        : h("span", { class: "rt-note-chip-link", "aria-hidden": "true" }, "🔗"),
      h("span", { class: "rt-note-chip-label" }, label),
      h("button", { type: "button", disabled: input.disabled, "aria-label": `移除${noun}引用：${note.label}`, onclick: () => {
        noteQuotes.splice(noteQuotes.indexOf(note), 1);
        // 告诉调用方还剩下几条待办引用（调用方据此决定要不要解除会话与待办的关联；记忆引用不关联任何待办）
        attrs.onNoteRemove?.(noteQuotes.some(q => q.kind !== "memory")); paintChips(); changed(); input.focus();
      } }, "×"));
  }
  function paintChips() {
    chips.hidden = !references.length && !noteQuotes.length;
    chips.replaceChildren(...noteQuotes.map(noteChip), ...references.map(ref => h("span", { class: "rt-session-chip", title: ref.reference },
      h("span", { class: "rt-session-chip-at", "aria-hidden": "true" }, "@"),
      rtAvatar(ref.entry.runtimeKind, ref.entry.model, "sm"),
      h("span", { class: "rt-session-chip-title" }, ref.entry.title || ref.entry.id),
      h("button", { type: "button", disabled: input.disabled, "aria-label": `移除会话引用：${ref.entry.title || ref.entry.id}`, onclick: () => {
        references.splice(references.indexOf(ref), 1); paintChips(); changed(); input.focus();
      } }, "×"))));
  }
  function add(entry) {
    if (attrs.allowReferences === false) return;
    if (entry.archived || entry.id === currentId || references.some(ref => ref.entry.id === entry.id)) return;
    references.push({ entry, reference: rtSessionReference(entry) }); paintChips();
  }
  paintChips();
  function token() {
    if (input.disabled || input.readOnly || composingMention || input.selectionStart !== input.selectionEnd) return null;
    const end = input.selectionStart;
    const hit = /(?:^|[\s（(])@([^\s@\[\]()（）]*)$/.exec(input.value.slice(0, end));
    return hit ? { start: end - hit[1].length - 1, end, query: hit[1] } : null;
  }
  function close() {
    // 关掉或换了关键字：在飞/排队中的旧请求一并取消，不再占读取名额
    generation++; clearTimeout(timer); reading?.abort(); reading = null; match = null; entries = []; nextCursor = ""; slash = null; skillEntries = [];
    panel.hidden = true; panel.replaceChildren(); input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant");
  }
  function status(text) { panel.replaceChildren(h("p", { class: "muted small", role: "status" }, text)); }
  function paint() {
    const list = h("div", { id: listId, role: "listbox", "aria-label": "未归档会话" }, entries.map((entry, i) =>
      h("button", { type: "button", role: "option", id: `${listId}-${i}`, tabindex: "-1", "aria-selected": String(i === selected),
        class: `rt-session-mention${i === selected ? " selected" : ""}`, onmousedown: ev => ev.preventDefault(), onclick: () => choose(entry) },
        rtSessionListContent(entry))));
    panel.replaceChildren(h("p", { class: "muted small rt-mention-hint" }, "引用会话 · ↑↓ 选择，Enter 确认"), list);
    if (!entries.length) list.append(h("p", { class: "muted small", role: "status" }, "没有匹配的未归档会话"));
    if (nextCursor) panel.append(h("button", { type: "button", class: "btn small", onmousedown: ev => ev.preventDefault(), onclick: () => void load(generation, nextCursor) }, "更多会话"));
    if (entries.length) { input.setAttribute("aria-activedescendant", `${listId}-${selected}`); list.children[selected]?.scrollIntoView({ block: "nearest" }); }
    else input.removeAttribute("aria-activedescendant");
  }
  async function load(gen, cursor = "") {
    if (attrs.allowReferences === false) return;
    const query = new URLSearchParams({ source: "chat", limit: "200", ...(match?.query ? { q: match.query } : {}), ...(cursor ? { cursor } : {}) });
    const controller = reading = new AbortController();
    try {
      // 用户正在等的前台读取：优先级高于后台目录刷新（2），低于当前会话的同步（0）
      const result = await api(`/api/session-directory?${query}`, { signal: controller.signal, readPriority: 1 });
      if (gen !== generation || !input.isConnected || !match || JSON.stringify(token()) !== JSON.stringify(match)) return;
      const allowed = candidates(result.entries || []);
      entries = cursor ? [...entries, ...allowed.filter(e => !entries.some(old => old.id === e.id))] : allowed;
      nextCursor = result.nextCursor || ""; paint();
    } catch (error) { if (gen === generation && input.isConnected && match) { entries = []; input.removeAttribute("aria-activedescendant"); status(`会话加载失败：${error.message}，重新输入 @ 可重试`); } }
  }
  function slashToken() {
    if (input.disabled || input.readOnly || composingMention || input.selectionStart !== input.selectionEnd) return null;
    const end = input.selectionStart;
    const hit = /(?:^|\n)[ \t]*\/([^\s/]*)$/.exec(input.value.slice(0, end));
    return hit ? { start: end - hit[1].length - 1, end, query: hit[1] } : null;
  }
  function paintSkills() {
    const list = h("div", { id: listId, role: "listbox", "aria-label": "平台技能" }, skillEntries.map((k, i) =>
      h("button", { type: "button", role: "option", id: `${listId}-${i}`, tabindex: "-1", "aria-selected": String(i === selected),
        class: `rt-session-mention rt-skill-option${i === selected ? " selected" : ""}`, onmousedown: ev => ev.preventDefault(), onclick: () => chooseSkill(k) },
        h("span", { class: "rt-skill-name" }, k.trigger), h("span", { class: "rt-skill-desc muted small" }, k.description))));
    panel.replaceChildren(h("p", { class: "muted small rt-mention-hint" }, "平台技能 · ↑↓ 选择，Enter 确认；所有 runtime 通用"), list);
    if (skillEntries.length) { input.setAttribute("aria-activedescendant", `${listId}-${selected}`); list.children[selected]?.scrollIntoView({ block: "nearest" }); }
    else input.removeAttribute("aria-activedescendant");
  }
  function openSlash(found) {
    if (slash && JSON.stringify(slash) === JSON.stringify(found)) return;
    close(); slash = found; selected = 0;
    const gen = generation;
    void rtLoadPlatformSkills().then(all => {
      if (gen !== generation || !input.isConnected || !slash) return;
      skillEntries = rtFilterPlatformSkills(all, slash.query);
      // 没有可选技能（目录为空、读取失败、或输入的是 runtime 自带命令）：不弹空面板，`/` 就是普通文字
      if (!skillEntries.length) { panel.hidden = true; input.setAttribute("aria-expanded", "false"); return; }
      panel.hidden = false; input.setAttribute("aria-expanded", "true"); paintSkills();
    });
  }
  function chooseSkill(entry) {
    const found = slashToken();
    if (!slash || !found || found.start !== slash.start || !entry) { close(); return; }
    input.setRangeText(`${entry.trigger} `, slash.start, slash.end, "end"); close(); input.focus(); changed();
  }
  function update() {
    const slashFound = slashToken();
    if (slashFound) { openSlash(slashFound); return; }
    if (slash) close();
    if (attrs.allowReferences === false) { close(); return; }
    const found = token();
    if (!found) { close(); return; }
    if (match && JSON.stringify(match) === JSON.stringify(found)) return;
    close(); match = found; selected = 0; panel.hidden = false; input.setAttribute("aria-expanded", "true");
    const local = rtMentionLocalEntries(found.query);
    if (local) { entries = candidates(local); paint(); return; }
    status("正在查找未归档会话…");
    const gen = generation; timer = setTimeout(() => void load(gen), 120);
  }
  function choose(entry) {
    const found = token();
    if (!match || JSON.stringify(found) !== JSON.stringify(match)) { close(); return; }
    const start = match.start, end = match.end;
    input.setRangeText("", start, end, "end"); add(entry); close(); input.focus(); changed();
  }
  host.mentionAttrs = attrs;
  // 软重绘复用同一个输入框节点：草稿被清空（发送）或退回（失败）时，引用 chips 也要跟着变；
  // 已存在的引用保留原条目的模型/头像信息，只按新的列表对齐。
  host.updateMentionAttrs = next => {
    attrs = next;
    const parsedNext = rtNoteQuotes(next.value);
    const parsedRefs = rtSessionReferenceDraft(parsedNext.rest).references;
    const sameNotes = parsedNext.quotes.length === noteQuotes.length && parsedNext.quotes.every((q, i) => q.block === noteQuotes[i].block);
    if (sameNotes && parsedRefs.length === references.length && parsedRefs.every((r, i) => r.reference === references[i]?.reference)) return;
    const prev = new Map(references.map(r => [r.entry.id, r]));
    noteQuotes = parsedNext.quotes;
    references.length = 0;
    references.push(...parsedRefs.map(r => prev.get(r.entry.id) ?? r));
    paintChips();
  };
  // 桌面宽度下已有的草稿（恢复会话、切换页签）也要按内容撑高；手机仍由聚焦/输入触发
  requestAnimationFrame(() => { if (input.isConnected && !rtPhoneComposer.matches) rtAutosizeComposer(input); });
  return host;
}

/** 模型 ID → 模型系列（顺序即匹配优先级）；Pi 的模型带 provider 前缀，如 deepseek/deepseek-flash */
const RT_FAMILIES = [
  { id: "claude", label: "Claude", test: /claude|anthropic/i },
  { id: "openai", label: "OpenAI", test: /^(openai\/)?(gpt|o\d|codex|chatgpt)|openai/i },
  { id: "deepseek", label: "DeepSeek", test: /deepseek/i },
  { id: "zhipu", label: "智谱 GLM", test: /glm|zhipu|z-ai|chatglm/i },
  { id: "qwen", label: "通义千问", test: /qwen|dashscope|tongyi|alibaba/i },
  { id: "kimi", label: "Kimi", test: /kimi|moonshot/i },
  { id: "gemini", label: "Gemini", test: /gemini|google/i },
  { id: "doubao", label: "豆包", test: /doubao|volc|bytedance/i }
];
/** 没有模型信息时按运行时推断：Codex 一定是 OpenAI，Claude Code 一定是 Claude；Pi 不推断 */
const RT_DEFAULT_FAMILY = { codex: "openai", "claude-code": "claude", antigravity: "gemini" };

function rtFamily(model, kind) {
  const hit = model ? RT_FAMILIES.find((f) => f.test.test(model)) : null;
  if (hit) return hit;
  const id = RT_DEFAULT_FAMILY[kind];
  return id ? RT_FAMILIES.find((f) => f.id === id) : null;
}

/** 模型名去掉 provider 前缀：deepseek/deepseek-flash → deepseek-flash */
function rtModelShort(model) { return model ? String(model).split("/").pop() : ""; }

/** 图标地址：logos.js 内联后随列表立即出现；没加载到内联文件时退回静态资源，行为不变。 */
function rtLogoSrc(id) { return typeof piLogoSrc === "function" ? piLogoSrc(id) : `/logos/${id}.svg`; }

/** 头像：模型系列图标，右下角是运行时角标（Codex / Claude Code / Pi） */
function rtAvatar(kind, model, size) {
  const f = rtFamily(model, kind);
  const mono = (rtModelShort(model) || RT_KIND[kind] || "?").slice(0, 1).toUpperCase();
  return h("span", { class: `rt-avatar${size ? ` ${size}` : ""}`, title: `${f ? f.label : rtModelShort(model) || "模型未知"} · ${RT_KIND[kind] || kind}`, "aria-hidden": "true" },
    f ? h("img", { class: "rt-avatar-logo", src: rtLogoSrc(f.id), alt: "", draggable: "false" }) : h("span", { class: "rt-avatar-mono" }, mono),
    h("span", { class: `rt-runtime-badge ${kind}` },
      kind === "codex" ? h("img", { src: rtLogoSrc("codexmark"), alt: "", draggable: "false" })
        : kind === "claude-code" ? h("img", { src: rtLogoSrc("claudecode"), alt: "", draggable: "false" })
          : kind === "antigravity" ? "A" : "π"));
}

/**
 * 会话列表里的头像右上角：等你审批 = 黄点（优先，要你动手），否则未读 = 数字红点（未读轮数）。运行时小标在右下角，不冲突。
 * approvals：待审批数；waiting 为 true 表示在等你处理但还没有审批卡片计数。
 */
function rtAvatarUnread(avatar, unread, approvals = 0, waiting = false) {
  const pending = approvals > 0 || waiting;
  const label = approvals > 0 ? `${approvals} 个待审批` : "等待你处理";
  // unread：未读轮数（数字红点；99 以上显示 99+）；传 true 视为 1
  const count = unread === true ? 1 : Math.max(0, Math.floor(Number(unread) || 0));
  return h("span", { class: "rt-avatar-wrap" }, avatar,
    pending ? h("span", { class: "rt-approval-dot rt-avatar-dot", title: label }, h("span", { class: "sr-only" }, label))
      : count ? h("span", { class: "rt-unread-badge rt-avatar-dot", "aria-hidden": "true" }, count > 99 ? "99+" : String(count)) : null);
}

/* ------------------------------ 分组 ------------------------------ */

/** 最近的轮次开始或结束时间；流式事件不参与列表排序。 */
function rtTurnOrderAt(e) {
  return [e.lastTurnEndedAt, e.latestTurn?.startedAt, e.latestTurn?.endedAt,
    ...(e.members || e.lanes || []).map(rtTurnOrderAt)]
    .filter(at => Number.isFinite(Date.parse(at)))
    .sort().at(-1) || "";
}

/**
 * 按工作目录分组：组按最近轮次开始或结束时间排序（无轮次时间时退回最近活动）；显示名用目录最后一段，同名时带上父目录。
 * 返回 [{ key, label, path, entries }]
 */
function rtGroupByWorkspace(entries) {
  const map = new Map();
  for (const e of entries) {
    const key = e.workspace || "";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  const parts = (p) => p.split("/").filter(Boolean);
  const base = (p) => parts(p).at(-1) || "/";
  const counts = new Map();
  for (const key of map.keys()) if (key) counts.set(base(key), (counts.get(base(key)) || 0) + 1);
  const latest = (list) => list.reduce((m, e) => { const k = rtTurnOrderAt(e) || e.lastActivityAt || ""; return k > m ? k : m; }, "");
  return [...map.entries()]
    .map(([key, list]) => ({
      key, path: key, entries: list,
      label: !key ? "未知目录" : counts.get(base(key)) > 1 ? parts(key).slice(-2).join("/") : base(key)
    }))
    .sort((a, b) => latest(b.entries).localeCompare(latest(a.entries)));
}

/* ------------------------------ Markdown ------------------------------ */

const RT_SAFE_URL = /^https?:\/\//i;
/** 本机 / 局域网地址：只有开着平台的那台机器（或同一局域网）能打开，手机走公网入口点了必然打不开 */
const RT_LOCAL_HOST = /^(?:localhost|0\.0\.0\.0|\[::1?\]|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[^.]+\.local)$/i;
function rtLocalOnlyUrl(href) {
  try { return RT_LOCAL_HOST.test(new URL(href).hostname) && !RT_LOCAL_HOST.test(location.hostname); } catch { return false; }
}
/**
 * 端面：Android 壳里 window.piAndroidShell 可用，那是在 App 内；手机浏览器、桌面网页都是网页。
 * 平台自己也在手机 App 里跑同一套页面，所以站内入口要跟着端面走：在 App 里点就在 App 内换页，
 * 在网页里点就留在网页内。壳只把「自己入口的页面路径（/、/login）」当 App 文档，
 * 别的入口域名（同一实例的其它公开域名、局域网入口）会交给系统浏览器打开——
 * 所以跨入口的站内地址不能原样交给链接，否则同一个会话引用 chip 会从 App 跳到网页版。
 */
function rtFaceIsApp() {
  try { return !!window.piAndroidShell?.available; } catch { return false; }
}
/** 站内路由地址 → 端内可用的 hash（#/rt/…、#/notes…）；不是站内路由就返回 null。 */
function rtFaceRoute(href) {
  let url;
  try { url = new URL(href, location.href); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || (url.pathname !== "/" && url.pathname !== "") || url.search) return null;
  return /^#\/[\w~%][\w~%./=&?+-]*$/.test(url.hash) ? url.hash : null;
}
/** 端内优先的站内地址：在 App 里把其它入口的站内路由收进当前入口（不交给系统浏览器），网页里原样保留。 */
function rtFaceHref(href) {
  return (rtFaceIsApp() && rtFaceRoute(href)) || href;
}
/** 外链：本机地址在当前入口打不开时只留文字（鼠标悬停说明原因）；其余照常新窗口打开，
 *  只有站内路由在 App 里改成端内换页（同一处路由，不在系统浏览器里另开一个网页）。 */
function rtExternalLink(href, children) {
  if (rtLocalOnlyUrl(href)) return h("span", { class: "rt-local-link", "data-local-only": "true", title: `仅开着平台的那台电脑能打开：${href}` }, children);
  const face = rtFaceHref(href);
  if (face !== href) return h("a", { href: face }, children);
  return h("a", { href, target: "_blank", rel: "noopener noreferrer" }, children);
}

/** Session references are presentation only; the original message remains intact. */
function rtMessageSessionReference(label, target, tail = "") {
  if (!label.startsWith("@") || label.length < 2) return null;
  let url;
  try { url = new URL(target, location.href); } catch { return null; }
  const route = /^#\/rt\/([\w-]+)$/.exec(url.hash);
  if (!/^https?:$/.test(url.protocol) || url.pathname !== "/" || url.search || !route) return null;
  let details = "", consumed = 0;
  // Only hide a complete metadata group belonging to this reference. Balance
  // parentheses so workspace names containing parentheses remain intact.
  const start = /^\s*([（(])会话 ID[：:]\s*([\w-]+)(?=[；;）)])/u.exec(tail);
  if (start && start[2] === route[1]) {
    const offset = tail.indexOf(start[1]), stack = [];
    for (let i = offset; i < tail.length; i++) {
      const char = tail[i];
      if (char === "（" || char === "(") stack.push(char === "（" ? "）" : ")");
      else if (char === "）" || char === ")") {
        if (char !== stack.pop()) break;
        if (!stack.length) { details = tail.slice(offset + 1, i); consumed = i + 1; break; }
      }
    }
  }
  return { label: label.replace(/\\([\\[\]])/g, "$1"), href: rtFaceHref(url.origin === location.origin ? url.hash : url.href), sessionId: route[1], details, consumed };
}

function rtMessageSessionChip(ref) {
  const name = ref.label.slice(1);
  const entry = ref.href.startsWith("#") ? ui.rt?.dir?.entries?.find(e => e.id === ref.sessionId) : null;
  const recordedKind = /(?:^|[；;])\s*运行时[：:]\s*(codex|claude-code|pi|antigravity)(?=\s*(?:[；;]|$))/.exec(ref.details)?.[1];
  const kind = entry?.runtimeKind || recordedKind || "";
  const avatar = rtAvatar(kind, entry?.model, "sm");
  if (!kind) {
    avatar.querySelector(".rt-runtime-badge")?.remove();
    avatar.title = "模型未知";
  }
  const link = h("a", { class: "rt-message-session-chip-link", href: ref.href, title: ref.label,
    "aria-label": ref.label,
    ...(ref.href.startsWith("#") ? {} : { target: "_blank", rel: "noopener noreferrer" }) },
    h("span", { class: "rt-message-session-chip-at", "aria-hidden": "true" }, "@"),
    avatar,
    h("span", { class: "rt-message-session-chip-label" }, name));
  const info = h("button", { type: "button", class: "rt-message-session-chip-info", "aria-label": `查看会话引用详情：${name}`, title: "会话引用详情", onclick: ev => {
    const trigger = ev.currentTarget;
    const close = () => { dialog.close(); dialog.remove(); if (trigger.isConnected) trigger.focus(); };
    const dialog = h("dialog", { class: "file-preview-dialog rt-session-reference-dialog", "aria-label": "会话引用详情" },
      h("header", { class: "file-preview-head" }, h("strong", {}, name), h("button", { type: "button", class: "btn small", onclick: close }, "关闭")),
      h("p", { class: "rt-text" }, ref.details || ref.href), h("p", { class: "muted small" }, "消息发送时的会话引用信息"));
    dialog.addEventListener("cancel", ev => { ev.preventDefault(); close(); });
    document.body.append(dialog); dialog.showModal();
  } }, "ⓘ");
  return h("span", { class: "rt-message-session-chip" }, link, info);
}

/** 消息正文里的待办引用：和输入框里的待办 chip 一样（🔗 + 「待办：…」），只是不能再移除。
 *  会话绑定了待办时 chip 可点击，跳到待办页并定位那条记录。 */
function rtMessageNoteChip(note, noteId) {
  // 引用的平台记忆：点 chip 回到记忆页那条记忆的详情（编号在引用块的标题里，不依赖会话绑定）
  if (note.kind === "memory") {
    const memoryIcon = typeof rtMiniIcon === "function"
      ? rtMiniIcon(RT_MINI_PATHS.link, { className: "rt-note-chip-link", size: 15 })
      : h("span", { class: "rt-note-chip-link", "aria-hidden": "true" }, "🔗");
    return h("button", { type: "button", class: "rt-note-chip rt-memory-chip rt-note-chip-action", title: note.block, "aria-label": `查看记忆：${note.label}`,
      onclick: () => { location.hash = `#/memory/t/${note.topicId}`; } }, memoryIcon, h("span", { class: "rt-note-chip-label" }, `记忆：${note.label}`));
  }
  const icon = typeof rtMiniIcon === "function"
    ? rtMiniIcon(RT_MINI_PATHS.link, { className: "rt-note-chip-link", size: 15 })
    : h("span", { class: "rt-note-chip-link", "aria-hidden": "true" }, "🔗");
  const label = h("span", { class: "rt-note-chip-label" }, `待办：${note.label}`);
  if (!noteId) return h("span", { class: "rt-note-chip rt-note-chip-static", title: note.block }, icon, label);
  return h("button", { type: "button", class: "rt-note-chip rt-note-chip-action", title: note.block, "aria-label": `查看待办：${note.label}`,
    onclick: () => { if (typeof rtViewLinkedNote === "function") rtViewLinkedNote(noteId); } }, icon, label);
}

/** 正文里裸写的会话 ID（rt-…）也做成链接：点了直接进那个会话，不用先去列表里找。 */
const RT_BARE_SESSION_ID = /(?<![\w#/.\-])(rt-[0-9a-f]{8,})(?![\w/\-])/g;

function rtBareSessionLink(id) {
  const entry = ui.rt?.dir?.entries?.find(e => e.id === id);
  return h("a", { class: "rt-session-id", href: `#/rt/${id}`, title: entry?.title ? `${entry.title}（${id}）` : `打开会话 ${id}` }, id);
}

/** 纯文本按裸会话 ID 切开；每段再交给文件 chip 处理，两者不会互相吞掉。 */
function rtBareSessionTextParts(text, context) {
  const s = String(text || ""), out = [];
  const plain = value => typeof fileTextParts === "function" ? fileTextParts(value, context) : [value];
  let last = 0;
  for (const m of s.matchAll(RT_BARE_SESSION_ID)) {
    if (m.index > last) out.push(...plain(s.slice(last, m.index)));
    out.push(rtBareSessionLink(m[1]));
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(...plain(s.slice(last)));
  return out;
}

/** Preserve user prose and inline code while decorating session references. */
function rtMessageSessionTextParts(text, context) {
  const s = String(text || ""), out = [];
  const re = /(`+)[\s\S]*?\1(?!`)|!?\[((?:\\.|[^\]\\\n])+)\]\((<[^>\n]+>|[^)\n]+)\)/g;
  const plain = value => rtBareSessionTextParts(value, context);
  const raw = value => typeof fileTextParts === "function" ? fileTextParts(value, context) : [value];
  let last = 0;
  for (let m; (m = re.exec(s));) {
    // 行内代码保持原样：里面的会话 ID 不当链接。
    if (m[1]) { out.push(...plain(s.slice(last, m.index)), ...raw(m[0])); last = re.lastIndex; continue; }
    const ref = !m[0].startsWith("!") && rtMessageSessionReference(m[2], m[3].trim().replace(/^<|>$/g, ""), s.slice(re.lastIndex));
    if (!ref) continue;
    out.push(...plain(s.slice(last, m.index)), rtMessageSessionChip(ref));
    re.lastIndex += ref.consumed; last = re.lastIndex;
  }
  out.push(...plain(s.slice(last))); return out;
}

/** Markdown 图片 ![alt](path)：正文里显示为小标签，图片本身由消息下方的预览卡片展示（远程图片受 CSP 限制不加载） */
function rtInline(text) {
  if (typeof fileChip !== "undefined") return rtInlineText(text);
  const parts = String(text).split(/(!\[[^\]\n]*\]\([^)\s]+\))/);
  if (parts.length === 1) return rtInlineText(text);
  return parts.flatMap((part, i) => {
    if (i % 2 === 0) return part ? rtInlineText(part) : [];
    const m = /^!\[([^\]\n]*)\]\(([^)\s]+)\)$/.exec(part);
    return [h("span", { class: "rt-md-imgref", title: m[2] }, "▣ ", m[1] || m[2].split("/").pop())];
  });
}
/** 行内：`code`、**粗体**、*斜体*、~~删除线~~、[文字](链接)、裸链接 */
function rtInlineText(text) {
  const out = [];
  const re = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|~~([^~\n]+?)~~|!?\[((?:\\.|[^\]\\\n])+)\]\((<[^>\n]+>|[^)\n]+)\)|(?<![\w*])\*([^*\n]+?)\*(?![\w*])|(?<![\w])_([^_\n]+?)_(?![\w])|(https?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"，。；：！？）])/g;
  let last = 0;
  for (let m; (m = re.exec(text));) {
    if (m.index > last) out.push(...rtBareSessionTextParts(text.slice(last, m.index)));
    if (m[1]) { const value = m[2].replace(/^ (.*) $/, "$1"), ref = typeof fileInlineCodeReference === "function" ? fileInlineCodeReference(value) : null; out.push(ref ? fileChip(ref) : h("code", { class: "rt-ic" }, value)); }
    else if (m[3] || m[4]) out.push(h("strong", {}, rtInline(m[3] || m[4])));
    else if (m[5]) out.push(h("del", {}, rtInline(m[5])));
    else if (m[6]) {
      const target = m[7].trim().replace(/^<|>$/g, "");
      const sessionRef = !m[0].startsWith("!") && rtMessageSessionReference(m[6], target, text.slice(re.lastIndex));
      if (sessionRef) { out.push(rtMessageSessionChip(sessionRef)); re.lastIndex += sessionRef.consumed; last = re.lastIndex; continue; }
      const ref = typeof fileReference === "function" ? fileReference(target, true, true) : null;
      // 目录（末段没有扩展名）预览不了，就不做成可点胶囊：只显示作者写的文字
      const directory = !ref && typeof fileHasExtension === "function" && /^(?:\/|~\/|file:\/\/|\.\.?\/)/.test(target) && !fileHasExtension(target);
      out.push(ref ? fileChip({...ref,label:m[6]}) : directory ? h("span", { class: "rt-path-text", title: target }, rtInline(m[6])) : RT_SAFE_URL.test(target) ? rtExternalLink(target, rtInline(m[6])) : `${m[6]} (${m[7]})`);
    }
    else if (m[8] || m[9]) out.push(h("em", {}, rtInline(m[8] || m[9])));
    else if (m[10]) out.push(rtExternalLink(m[10], m[10]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(...rtBareSessionTextParts(text.slice(last)));
  return out;
}

/** 段落内保留单个换行（聊天输出常用单换行分行） */
function rtInlineLines(lines) {
  return lines.flatMap((l, i) => i ? [h("br", {}), ...rtInline(l)] : rtInline(l));
}

/* ------------------------------ 复制 ------------------------------ */

/** 写入剪贴板；剪贴板接口不可用或被拒时退回到选中文本再复制 */
async function rtWriteClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* 权限被拒等：退回旧方式再试一次 */ }
  }
  const ta = document.createElement("textarea");
  ta.value = text; ta.setAttribute("readonly", ""); ta.className = "rt-copy-buffer";
  document.body.append(ta); ta.select();
  try { if (!document.execCommand("copy")) throw new Error("copy failed"); } finally { ta.remove(); }
}

/**
 * 复制按钮：点击后按钮本身显示结果（✓ 已复制 / 复制失败）1.5 秒，再恢复原文字；同时读屏播报。
 * opts.class 追加样式类，opts.announce 是播报文案。
 */
function rtCopyButton(getText, label = "复制", opts = {}) {
  let timer = null;
  return h("button", {
    type: "button", class: `rt-copy-btn ${opts.class || "rt-copy"}`, title: opts.title || label, "aria-label": opts.ariaLabel || label,
    onclick: async (ev) => {
      const b = ev.currentTarget;
      let ok = true;
      try { await rtWriteClipboard(String(typeof getText === "function" ? getText() : getText ?? "")); } catch { ok = false; }
      clearTimeout(timer);
      b.textContent = ok ? "✓ 已复制" : "复制失败";
      b.classList.toggle("copied", ok); b.classList.toggle("copy-failed", !ok);
      if (typeof announce === "function") announce(ok ? opts.announce || "已复制" : "复制失败：浏览器不允许访问剪贴板");
      timer = setTimeout(() => { b.textContent = label; b.classList.remove("copied", "copy-failed"); }, 1500);
    }
  }, label);
}

/** 长代码块默认收起：标题行写语言、行数与首行，展开后才铺开正文（回复里的长代码不再占满一屏） */
const RT_CODE_FOLD_LINES = 12;
const RT_CODE_FOLD_CHARS = 900;

/** 图表代码块（```mermaid / ```plantuml / ```svg）显示成缩略图，其余照旧是代码块 */
function rtCodeBlock(code, lang, context) {
  const text = String(code ?? "");
  const diagram = typeof diagramKindForLang === "function" && !(context && context.diagrams === false) ? diagramKindForLang(lang, text) : null;
  if (diagram) return diagramBlock(diagram, text, lang, { streaming: !!(context && context.streaming), fallback: (source) => rtPlainCodeBlock(source, lang, context) });
  return rtPlainCodeBlock(text, lang, context);
}

function rtPlainCodeBlock(code, lang, context) {
  const text = String(code ?? "");
  const name = lang || "text";
  const copy = rtCopyButton(text, "复制", { announce: "已复制代码" });
  const pre = h("pre", {}, h("code", {}, text));
  const refs = typeof fileCodeReferences === "function" ? fileCodeReferences(text) : null;
  const lines = text ? text.split("\n").length : 0;
  // 文件预览里整篇就是代码，再折起来等于把内容藏了；只有回复正文才需要默认收起
  const foldable = !(context && context.foldCode === false);
  // 短代码块照旧铺开：一两行命令不值得多一次点击
  if (!foldable || (lines <= RT_CODE_FOLD_LINES && text.length <= RT_CODE_FOLD_CHARS)) {
    return h("div", { class: "rt-codeblock" }, h("div", { class: "rt-codeblock-head" }, h("span", {}, name), copy), pre, refs);
  }
  const meta = `${lines} 行`;
  const preview = (text.split("\n").find((l) => l.trim()) || "").trim();
  const toggle = h("button", { type: "button", class: "rt-codeblock-toggle", "aria-expanded": "false",
    "aria-label": `展开代码：${name}，共 ${meta}` },
  h("span", { class: "rt-codeblock-lang" }, name),
  h("span", { class: "rt-codeblock-meta" }, meta),
  preview ? h("span", { class: "rt-codeblock-preview", "aria-hidden": "true" }, preview) : null,
  h("span", { class: "rt-fold-caret", "aria-hidden": "true" }, "›"));
  const body = h("div", { class: "rt-codeblock-body", hidden: true }, pre, refs);
  const box = h("div", { class: "rt-codeblock folded" }, h("div", { class: "rt-codeblock-head" }, toggle, copy), body);
  // 展开状态只放这一个按钮上：展开后标题行仍能收起，复制按钮独立、点了不会误折叠
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", `${open ? "收起" : "展开"}代码：${name}，共 ${meta}`);
    box.classList.toggle("folded", !open);
    body.hidden = !open;
  });
  return box;
}

const RT_LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RT_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const RT_TABLE_SHOT_REF = /!?\[[^\]\n]*\]\((?:<[^>\n]+>|[^)\n]+)\.(?:png|jpe?g|gif|webp)(?::\d+)?>?\)|`?[^\s`|()\[\]]+\.(?:png|jpe?g|gif|webp)`?/gi;
/** 单元格基本只由位图引用组成（剩下的文字不超过一个短标注），才算截图格，避免正文里提到 x.png 就改版式 */
const rtTableShotCell = (cell) => { const rest = cell.replace(RT_TABLE_SHOT_REF, ""); return rest !== cell && rest.replace(/[\s,，、;；<>\/brBR]/g, "").length <= 6; };

function rtTableRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** 列表：按缩进处理一层嵌套（更深的缩进并入子列表） */
function rtMdList(lines, context) {
  const first = RT_LIST_RE.exec(lines[0]);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  for (const line of lines) {
    const m = RT_LIST_RE.exec(line);
    if (m && m[1].length <= indent) items.push({ text: [m[3]], children: [] });
    else if (items.length) {
      if (m || items.at(-1).children.length) items.at(-1).children.push(line);
      else items.at(-1).text.push(line.trim());
    }
  }
  const start = ordered ? parseInt(first[2], 10) : 1;
  return h(ordered ? "ol" : "ul", ordered && start !== 1 ? { start: String(start) } : {},
    items.map((it) => {
      const m = /^\[([ xX])\]\s+(.*)$/.exec(it.text[0]);
      const head = m ? [h("input", { type: "checkbox", disabled: true, checked: m[1] !== " " }), " ", ...rtInlineLines([m[2], ...it.text.slice(1)])] : rtInlineLines(it.text);
      return h("li", m ? { class: "rt-task" } : {}, head, it.children.length ? rtMarkdownBlocks(it.children.map((l) => l.slice(Math.min(l.search(/\S|$/), indent + 2))), context) : null);
    }));
}

function rtMarkdownBlocks(lines, context) {
  const out = [];
  let i = 0;
  const isBlockStart = (l) => /^\s*(```|~~~)/.test(l) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l) || RT_LIST_RE.test(l) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(rtCodeBlock(body.join("\n"), fence[2], context));
      continue;
    }
    const head = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (head) { out.push(h(`h${Math.min(6, head[1].length + 2)}`, { class: "rt-h" }, rtInline(head[2]))); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push(h("hr", {})); i++; continue; }
    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(h("blockquote", {}, rtMarkdownBlocks(body, context)));
      continue;
    }
    if (RT_LIST_RE.test(line)) {
      const body = [];
      while (i < lines.length && (RT_LIST_RE.test(lines[i]) || (lines[i].trim() && /^\s+/.test(lines[i])) || (!lines[i].trim() && i + 1 < lines.length && (RT_LIST_RE.test(lines[i + 1]) || /^\s+\S/.test(lines[i + 1]))))) {
        if (lines[i].trim()) body.push(lines[i]);
        i++;
      }
      out.push(rtMdList(body, context));
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && RT_TABLE_SEP.test(lines[i + 1])) {
      const header = rtTableRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(rtTableRow(lines[i++]));
      // 验收截图对照表：含位图引用的列是「图列」，等分剩余宽度；其余列（维度名）收窄，整张表不横向滑动
      const shotCol = header.map((_, k) => rows.some((r) => rtTableShotCell(r[k] || "")));
      const shots = shotCol.some(Boolean);
      out.push(h("div", { class: "rt-table-wrap" }, h("table", { class: shots ? "rt-md-table rt-md-shots" : "rt-md-table" },
        h("thead", {}, h("tr", {}, header.map((c, k) => h("th", { class: shots && !shotCol[k] ? "rt-md-label" : null }, rtInline(c))))),
        h("tbody", {}, rows.map((r) => h("tr", {}, header.map((_, k) => h("td", { class: shots && !shotCol[k] ? "rt-md-label" : null }, rtInline(r[k] || "")))))))));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines[i]))) {
      if (lines[i].includes("|") && i + 1 < lines.length && RT_TABLE_SEP.test(lines[i + 1])) break;
      para.push(lines[i++]);
    }
    if (!para.length) para.push(lines[i++]);
    out.push(h("p", {}, rtInlineLines(para)));
  }
  return out;
}

/** 助手回复：Markdown 排版（只生成 DOM 节点，不解释 HTML） */
function rtMarkdown(text, context) {
  const previous = typeof fileRenderContext === "undefined" ? undefined : fileRenderContext;
  // 整条消息里写过的目录，省略了目录的相对路径据此定位
  const hints = typeof fileDirectoryHints === "function" ? fileDirectoryHints(text) : [];
  if (hints.length && !context?.baseDir) context = { ...context, hints };
  if (typeof fileChip !== "undefined") fileRenderContext = context;
  try {
    const doc = h("div", { class: "rt-md" }, rtMarkdownBlocks(String(text || "").replace(/\r\n?/g, "\n").split("\n"), context));
    return typeof fileLayoutPreviews === "function" ? fileLayoutPreviews(doc) : doc;
  }
  finally { if (typeof fileChip !== "undefined") fileRenderContext = previous; }
}

/* ------------------------------ 提问面板：runtime 要你做选择 / 填写时 ------------------------------ */
/*
 * Claude 的 AskUserQuestion、Codex 的 request_user_input 与 MCP 表单、Pi 扩展的 select / input 都落到同一种审批
 * （kind=question，带 questions）。三个页面（会话 / 对比 / 群聊）共用这一个面板：
 * 单选、多选、「其他」自填、纯文本题；没答完不能提交；可以跳过（runtime 收到"用户没回答"）。
 * 草稿按 approvalId 存在内存里：页面因实时更新重绘时，已选的答案不丢。
 */
const rtQuestionDrafts = new Map();
const rtQuestionSteps = new WeakMap();
function rtQuestionDraft(ap, q) {
  let all = rtQuestionDrafts.get(ap.approvalId);
  if (!all) { all = {}; rtQuestionDrafts.set(ap.approvalId, all); }
  // 文本题的预填（Pi editor / MCP 默认值）只在第一次出现时放进草稿
  return all[q.id] ||= { picks: [], otherOn: !q.options.length, other: q.options.length ? "" : q.prefill || "" };
}
function rtQuestionAnswer(ap, q) {
  const d = rtQuestionDraft(ap, q);
  const other = d.otherOn ? d.other.trim() : "";
  if (q.multiSelect) return [...d.picks, ...(other ? [other] : [])];
  return other ? [other] : d.picks.slice(0, 1);
}
/** 还没答的题（可选题不算）；全答完返回空数组 */
function rtQuestionMissing(ap) {
  return (ap.questions || []).filter((q) => !q.optional && !rtQuestionAnswer(ap, q).length);
}
function rtQuestionAnswers(ap) {
  const answers = {};
  for (const q of ap.questions || []) { const a = rtQuestionAnswer(ap, q); if (a.length) answers[q.id] = a; }
  return answers;
}

/**
 * 审批 / 提问卡片能不能操作。按钮要等两件事：入口有控制权限，并且画面已和服务端核对过最新状态。
 * - canAct：可以批准 / 拒绝 / 回答
 * - confirming：有控制权限（或权限还在读取），但画面来自本机缓存或最近一次读取失败，
 *   正在核对最新状态：按钮照常显示但先禁用，旁边写明原因，别误报成「没有控制权限」
 * - 两者都不是：当前入口确实没有控制权限
 */
function rtApprovalGate(access, statusConfirmed, syncError) {
  if (access && !access.control) return { canAct: false, confirming: false, note: "" };
  if (!access || statusConfirmed === false) return { canAct: false, confirming: true, note: syncError ? "最新状态还没核对上，正在重试…" : "正在核对最新状态…" };
  return { canAct: true, confirming: false, note: "" };
}
/** 卡片底部操作行：核对中显示禁用按钮 + 原因；没有控制权限时只留一行说明。buttons(disabled) 返回按钮数组。 */
function rtApprovalActionRow(gate, deniedText, buttons, className = "rt-approval-actions") {
  if (!gate.canAct && !gate.confirming) return h("p", { class: "muted small" }, deniedText);
  return h("div", { class: className },
    gate.confirming ? h("span", { class: "muted small rt-approval-confirming", role: "status" }, gate.note) : null,
    buttons(gate.confirming));
}

/**
 * 提问卡片。opts: { label（多通道/群聊里标出是谁在问）, gate（rtApprovalGate 的结果；旧调用可只给 canAct）, busy, onSubmit(answers), onSkip() }
 * 核对最新状态期间可以先填答案，提交 / 跳过等核对完成。
 * 提交失败时草稿保留（可改后重试）；成功后调用方要 rtQuestionDrafts.delete(approvalId)，再重新读取视图。
 */
function rtQuestionCard(ap, opts) {
  const { label = "", busy = false, onSubmit, onSkip } = opts;
  const gate = opts.gate || { canAct: opts.canAct !== false, confirming: false, note: "" };
  // 能不能填答案：有权限或正在核对（草稿先留着）；能不能提交：必须已核对且有权限
  const canFill = gate.canAct || gate.confirming;
  const questions = ap.questions || [];
  if (!rtQuestionDrafts.has(ap.approvalId)) rtQuestionDrafts.set(ap.approvalId, {});
  const draft = rtQuestionDrafts.get(ap.approvalId);
  let current = Math.min(rtQuestionSteps.get(draft) || 0, Math.max(0, questions.length - 1));
  const submit = h("button", { type: "button", class: "btn primary", "data-rt-q-submit": ap.approvalId });
  const body = h("div", { class: "rt-q-body" });
  const progress = h("span", { class: "muted small", role: "status" });
  const previous = h("button", { type: "button", class: "btn rt-q-step", "aria-label": "上一题", title: "上一题", onclick: () => { if (current > 0 && !busy) show(current - 1, true); } }, "‹");
  const forward = h("button", { type: "button", class: "btn rt-q-step", "aria-label": "下一题", title: "下一题", onclick: () => {
    if (!busy && current < questions.length - 1 && !rtQuestionMissing(ap).includes(questions[current])) show(current + 1, true);
  } }, "›");
  const show = (index, focus = false) => {
    current = index;
    rtQuestionSteps.set(draft, current);
    body.replaceChildren(...(questions[current] ? [field(questions[current], current)] : []));
    body.scrollTop = 0;
    refresh();
    if (focus) body.querySelector("legend")?.focus();
  };
  const refresh = () => {
    const last = current >= questions.length - 1;
    const missing = rtQuestionMissing(ap).filter((q) => last || q === questions[current]);
    submit.textContent = last ? "提交" : "下一步";
    submit.disabled = !!busy || !gate.canAct || !!missing.length;
    submit.title = missing.length ? `还没回答：${missing.map((q) => q.header || q.question).join("、")}` : "";
    progress.textContent = `${questions.length ? current + 1 : 0} / ${questions.length} 题 · 已答 ${questions.filter((q) => rtQuestionAnswer(ap, q).length).length} 题`;
    previous.disabled = !!busy || current === 0;
    forward.disabled = !!busy || last || rtQuestionMissing(ap).includes(questions[current]);
  };
  const field = (q, i) => {
    const d = rtQuestionDraft(ap, q);
    const name = `rtq-${ap.approvalId}-${q.id}`;
    const inputType = q.multiSelect ? "checkbox" : "radio";
    const otherKey = `rtq-${ap.approvalId}-${q.id}-other`;
    const pickBox = (value, text, desc) => {
      const input = h("input", { type: inputType, name, value, checked: d.picks.includes(value) && !(d.otherOn && !q.multiSelect), disabled: !canFill || busy, onchange: (ev) => {
        if (q.multiSelect) { d.picks = ev.target.checked ? [...d.picks.filter((x) => x !== value), value] : d.picks.filter((x) => x !== value); }
        else { d.picks = [value]; d.otherOn = false; otherRadio?.removeAttribute("checked"); if (otherRadio) otherRadio.checked = false; }
        refresh();
      } });
      return h("label", { class: "rt-q-option" }, input, h("span", { class: "rt-q-option-text" }, h("strong", {}, text), desc ? h("span", { class: "muted small" }, desc) : null));
    };
    let otherRadio = null;
    const otherText = h(q.multiline ? "textarea" : "input", {
      ...(q.multiline ? { rows: "4" } : { type: q.secret ? "password" : "text" }), class: "rt-q-other", "data-key": otherKey, value: d.other,
      placeholder: q.options.length ? "其他（自己写）" : q.placeholder || "在这里回答", disabled: !canFill || busy, autocomplete: "off",
      "aria-label": q.options.length ? `${q.question}：其他` : q.question,
      oninput: (ev) => {
        d.other = ev.target.value;
        // 一开始输入就当作选了「其他」；清空则取消
        const on = !!d.other.trim() || !q.options.length;
        if (q.options.length && on !== d.otherOn) { d.otherOn = on; if (otherRadio) otherRadio.checked = on; if (on && !q.multiSelect) d.picks = []; if (on && !q.multiSelect) card.querySelectorAll(`input[name="${name}"]:not([data-other])`).forEach((x) => { x.checked = false; }); }
        refresh();
      }
    });
    const other = q.options.length && q.allowOther
      ? h("label", { class: "rt-q-option rt-q-other-row" },
        (otherRadio = h("input", { type: inputType, name, "data-other": "1", checked: d.otherOn, disabled: !canFill || busy, onchange: (ev) => {
          d.otherOn = ev.target.checked;
          if (d.otherOn && !q.multiSelect) { d.picks = []; card.querySelectorAll(`input[name="${name}"]:not([data-other])`).forEach((x) => { x.checked = false; }); }
          if (d.otherOn) otherText.focus();
          refresh();
        } })), otherText)
      : null;
    return h("fieldset", { class: "rt-q", disabled: !canFill || busy },
      h("legend", { class: "rt-q-legend", tabindex: "-1" }, q.header ? h("span", { class: "badge accent" }, q.header) : null, h("span", { class: "rt-q-text" }, `${i + 1}. ${q.question}`),
        q.multiSelect ? h("span", { class: "muted small" }, "可多选") : null, q.optional ? h("span", { class: "muted small" }, "可不填") : null),
      q.options.length ? h("div", { class: "rt-q-options" }, q.options.map((o) => pickBox(o.label, o.label, o.description)), other) : otherText);
  };
  const card = h("div", { class: "rt-approval rt-question", role: "group", "aria-label": `${label ? `${label} ` : ""}${ap.title}` },
    h("div", { class: "rt-approval-head" }, h("strong", {}, `${label ? `${label} · ` : ""}${ap.title}`), h("span", { class: "muted small" }, ap.expiresAt ? "等你回答 · 到期后将自动跳过" : "等待你回答，不自动跳过")),
    // 详情单独滚动，操作区固定在卡片底部右侧。
    questions.length > 1 ? h("div", { class: "rt-q-navigation" },
      progress, h("nav", { class: "rt-q-steps", "aria-label": "切换问题" }, previous, forward)) : null,
    body,
    rtApprovalActionRow(gate, "当前入口没有控制权限，不能回答", (waiting) => [
      h("button", { type: "button", class: "btn", disabled: !!busy || waiting, title: "不回答，让它自己判断", onclick: () => onSkip() }, "跳过"),
      submit]));
  submit.addEventListener("click", () => {
    if (busy || !gate.canAct) return;
    if (current < questions.length - 1) {
      if (rtQuestionMissing(ap).includes(questions[current])) return;
      show(current + 1, true);
    } else {
      if (rtQuestionMissing(ap).length) return;
      onSubmit(rtQuestionAnswers(ap));
    }
  });
  show(current);
  return card;
}
