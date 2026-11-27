"use strict";
// Single-session UI. Shared authority and sync state stay in runtime.js.

/** 会话状态变了：只重绘头部、信息栏与输入区，不动对话（保留滚动与选中） */
function rtDetailRenderSoft() {
  if (ui.view !== "rt" || composing) { if (composing) renderDeferred = true; return; }
  const v = ui.rt.view;
  if (!v) return renderMain();
  rtDesktop.readingUpdated();
  // 只读状态变了（外部写入冲突出现/解除）：横幅也要跟着变，整块重绘
  const center = document.querySelector(".rt-center");
  if (!center || center.dataset.ro !== String(!!v.readOnly)) return renderMain();
  // 软重绘保留输入区节点，避免打断输入法与光标；但状态里的草稿可能已变化（发送成功清空、草稿恢复），必须同步 value
  // 只有「状态已核对」变了、输入区其余输入都没变：输入区原地改禁用状态，不重建节点（加号不闪）
  let composerStatusOnly = false;
  const swap = (sel, el) => {
    const old = document.querySelector(sel);
    if (!old) return;
    if (sel === '.rt-composer') {
      if (composerStatusOnly && rtPatchComposerStatus(old, el)) return;
      old.dataset.startupSendReady = el.dataset.startupSendReady;
      // 加号 / 剪贴板快捷按钮沿用旧节点：下面不管走哪条分支，新输入区里放的都是这组旧节点
      const toolsFocus = rtAdoptAttachmentTools(old, el);
      if (toolsFocus) queueMicrotask(() => { if (toolsFocus.isConnected && document.activeElement !== toolsFocus) toolsFocus.focus({ preventScroll: true }); });
      // 输入框正在用时原地更新：节点（连同 @ 面板、光标、输入法组字）一直留在文档里。
      // 不能像下面那样先搬进新输入区再替换整块——那会把输入框从文档里摘出去再放回来，
      // 浏览器随即 blur → focus，输入法 / 语音输入的文字客户端被断开（微信语音输入这时退回剪贴板）。
      if (rtPatchComposerInPlace(old, el)) return;
      const input = old.querySelector('textarea'), next = el.querySelector('textarea');
      if (input && next && input.dataset.key === next.dataset.key) {
        input.disabled = next.disabled;
        input.readOnly = next.readOnly;
        input.placeholder = next.placeholder;
        const host = input.closest('.rt-mention-input'), newHost = next.closest('.rt-mention-input');
        if (host?.updateMentionAttrs && newHost) {
          host.updateMentionAttrs(newHost.mentionAttrs);
          input.dataset.phonePlaceholder = next.dataset.phonePlaceholder;
          input.dataset.desktopPlaceholder = next.dataset.desktopPlaceholder;
          newHost.replaceWith(host);
        } else next.replaceWith(input);
        if (!input.isComposing && input.value !== next.value) {
          input.value = next.value;
          rtRefreshComposer(input);
        }
      }
      // 打开着的选项面板（桌面权限菜单 / 手机合并入口）必须在软重绘里整棵保留，
      // 否则浏览器会在指针按下与松开之间丢掉这次点击
      const openControl = old.querySelector('[data-compose-menu]:has(:popover-open)');
      const nextControl = openControl && el.querySelector(`[data-compose-menu="${openControl.dataset.composeMenu}"]`);
      if (openControl && nextControl && openControl.dataset.state === nextControl.dataset.state) {
        if (openControl.rtPermissionState) openControl.rtPermissionState.view = nextControl.rtPermissionState.view;
        // Keep the open top-layer subtree connected throughout the patch: even moving it
        // into the replacement composer would dismiss the popover between pointer down/up.
        let keep = openControl, placeholder = nextControl;
        while (keep !== old) {
          const parent = keep.parentNode, nextParent = placeholder.parentNode;
          for (const child of [...parent.childNodes]) if (child !== keep) child.remove();
          let before = true;
          for (const child of [...nextParent.childNodes]) {
            if (child === placeholder) { before = false; continue; }
            parent.insertBefore(child, before ? keep : null);
          }
          keep = parent; placeholder = nextParent;
        }
        return;
      }
      const bar = old.querySelector(".rt-quick-replies"), nextBar = el.querySelector(".rt-quick-replies");
      // 后台更新可能落在按下与松开之间。未变化的推荐节点必须一直留在文档里，
      // 否则浏览器会丢弃这次 click；仍更新 handler，避免发送闭包持有旧会话状态。
      if (bar && nextBar && bar.outerHTML === nextBar.outerHTML) {
        const buttons = bar.querySelectorAll("button"), nextButtons = nextBar.querySelectorAll("button");
        buttons.forEach((button, i) => { button.onclick = nextButtons[i].onclick; });
        for (const child of [...old.childNodes]) if (child !== bar) child.remove();
        let before = true;
        for (const child of [...el.childNodes]) {
          if (child === nextBar) { before = false; continue; }
          old.insertBefore(child, before ? bar : null);
        }
        return;
      }
    }
    old.replaceWith(el);
  };
  const active = document.activeElement;
  const infoLabel = ui.rt.infoOpen && active?.closest(".rt-side") ? active.getAttribute("aria-label") : null;
  const noticeFocused = !!active?.closest("#rt-notice-sheet");
  const noteFocused = !!active?.closest(".rt-note-sheet");
  const recommendationFocused = !!active?.closest("#rt-rec-sheet");
  const key = active && active.dataset ? active.dataset.key : undefined;
  const sel = key && "selectionStart" in active ? [active.selectionStart, active.selectionEnd] : null;
  rtPatchRecoveryState();
  rtPatchTurnSummaryState();
  const composerSignature = rtComposerSignature(v);
  const signature = composerSignature + "|" + ui.rt.statusConfirmed;
  swap("#rt-sync", sessionSyncNote(ui.rt, () => refresh({ main: true, force: true, global: false }), "rt-sync"));
  if (center.rtSoftSignature === signature) return;
  center.rtSoftSignature = signature;
  composerStatusOnly = center.rtComposerSignature === composerSignature;
  center.rtComposerSignature = composerSignature;
  // 审批卡片、输入区与头部的高度都会改变消息区的可视高度。
  // 在布局改变前保留阅读位置，否则原本贴底的视图会被滚动回调误判为在读历史，
  // 后续增量回复便只计入 newCount 而不进入当前窗口。
  const transcript = document.querySelector('.rt-transcript');
  const reading = sessionReadingCapture(transcript, ui.rt.atBottom);
  swap(".rt-head", rtHead(v));
  if(ui.rt.noticeOpen&&ui.rt.runtimeGrants?.id===rtId()){const body=document.querySelector(".rt-runtime-grants-sheet .rt-notice-body");if(body)body.scrollTop=ui.rt.runtimeGrants.scroll||0;}
  swap("#rt-sync", sessionSyncNote(ui.rt, () => refresh({ main: true, force: true, global: false }), "rt-sync"));
  swap(".rt-info", rtInfo(v));
  swap(".rt-approvals", rtApprovals(v));
  swap(".rt-composer", rtComposer(v));
  rtPatchOutgoing();
  if (transcript?.isConnected) sessionReadingRestore(transcript, reading);
  if (key) { const again = document.querySelector(`[data-key="${key}"]`); if (again) { again.focus(); if (sel) again.setSelectionRange(sel[0], sel[1]); } }
  else if (noticeFocused && ui.rt.noticeOpen) document.querySelector(".rt-notice-sheet button")?.focus();
  else if (recommendationFocused && ui.rt.recommendationOpen) document.querySelector("#rt-rec-sheet button")?.focus();
  else if (noteFocused && ui.rt.noteOpen) document.querySelector(".rt-note-sheet button")?.focus();
  else if (infoLabel) document.querySelector(`.rt-side [aria-label="${CSS.escape(infoLabel)}"]`)?.focus();
}

/** 后台计划可能晚于结束消息到达；只在恢复状态变化时重投影时间线。 */
function rtPatchRecoveryState() {
  const box = document.querySelector(".rt-transcript");
  if (!box) return;
  const state = rtRecoveryState();
  const summaryMode = typeof rtTurnSummaryModeEnabled === "function" ? rtTurnSummaryModeEnabled() : false;
  const signature = JSON.stringify([summaryMode, state?.end.key, state?.raw, state?.plan, state ? rtRecoveryCanSend(ui.rt.view.session) : null, ui.rt.access?.control, ui.rt.busy, ui.rt.statusConfirmed]);
  if (box.rtRecoverySignature === signature) return;
  const hadRecovery = box.rtHadRecovery;
  box.rtRecoverySignature = signature;
  box.rtHadRecovery = !!state;
  if (state || hadRecovery) rtRerenderTranscript(box);
}

/** 回合收束卡片依赖开关状态及异步到达的摘要 / 快捷回复与按钮忙态；变化时按需重绘时间线（保留阅读位置与展开状态）。 */
function rtPatchTurnSummaryState() {
  const box = document.querySelector(".rt-transcript");
  if (!box) return;
  const s = ui.rt.view?.session;
  const id = s?.platformSessionId || "";
  const summaryMode = typeof rtTurnSummaryModeEnabled === "function" ? rtTurnSummaryModeEnabled() : false;
  const lastKey = rtLastAssistantKey();
  const cur = id ? ui.rt.quickReplies?.[id] : null;
  const curSig = cur && cur.key === lastKey ? [cur.state, cur.headline || "", cur.decision || "", cur.replies, cur.deployment || "", cur.deploymentSha || ""] : null;
  const srvSig = s?.quickReplies && s.quickReplies.eventKey === lastKey ? [s.quickReplies.headline || "", s.quickReplies.decision || "", s.quickReplies.replies, s.quickReplies.deployment || ""] : null;
  const summaryKeys = s?.turnSummaries ? Object.keys(s.turnSummaries).sort().map(k => [k, s.turnSummaries[k]?.headline || "", s.turnSummaries[k]?.decision || ""]) : null;
  const deploySig = ui.rt.deploy?.id === id ? [!!ui.rt.deploy.busy, !!ui.rt.deploy.info?.eligible, typeof rtDeployMine === "function" ? !!rtDeployMine(ui.rt.deploy.info, id) : false] : null;
  const busy = ui.rt.quickBusy && ui.rt.quickBusy.id === id ? [ui.rt.quickBusy.key, ui.rt.quickBusy.text] : null;
  const imagePending = typeof rtImageDraft === "function" ? !!rtImageDraft(id).pending : !!(typeof rtImageDrafts !== "undefined" && rtImageDrafts?.[id]?.pending);
  const signature = JSON.stringify([summaryMode, id, lastKey, curSig, srvSig, summaryKeys, deploySig, busy, !!ui.rt.busy, !!ui.rt.access?.control, !!rtRecoveryState(), imagePending, s?.status, s?.bindingRevision, !!s?.archived]);
  if (box.rtTurnSummarySignature === signature) return;
  const hadCard = !!box.querySelector?.(".rt-turn-card:not(.is-recovery)");
  box.rtTurnSummarySignature = signature;
  const wantsCard = summaryMode && (!!(id && lastKey && typeof rtTurnCardOwnsQuickReplies === "function" && rtTurnCardOwnsQuickReplies(id, lastKey, ui.rt.events))
    || !!(summaryKeys && summaryKeys.length));
  if (hadCard || wantsCard) rtRerenderTranscript(box);
}

/**
 * 输入区的重绘签名：除「状态已核对」之外，所有会改变输入区画面的状态。
 * 状态已核对只影响按钮能不能点，由 rtPatchComposerStatus 原地更新，不进这个签名。
 */
function rtComposerSignature(v) {
  // 图片草稿（上传中/完成/失败/移除）只改本地状态，必须计入签名，否则输入区不重绘、按钮像没反应
  const images = v.session?.platformSessionId ? rtImageDrafts[v.session.platformSessionId] : undefined;
  const outboxEdit = ui.rt.outboxEdit ? [ui.rt.outboxEdit, rtImageDrafts[rtOutboxKey(ui.rt.outboxEdit.messageId)]] : null;
  // 入口权限（ui.rt.access）也在里面：发送 / 排队的处理函数捕获了它，原地更新不换处理函数，权限变了必须重建
  return JSON.stringify([v, typeof rtTurnSummaryModeEnabled === "function" && rtTurnSummaryModeEnabled(), ui.rt.coldPrompt, ui.rt.access, ui.rt.sessionUsageLoading, ui.rt.sessionUsageError, ui.rt.runtimeGrants, ui.rt.busy, ui.rt.quickBusy, ui.rt.error, ui.rt.flash, ui.rt.deploy, ui.rt.deployWait, ui.rt.deploymentQueue, images, outboxEdit, ui.rt.outboxBusy, ui.rt.linkedRecommendationNotes, ui.rt.linkedNote, ui.rt.linkedNoteFor, ui.rt.linkedNoteBusy, ui.rt.linkedNoteError, rtLastAssistantKey(), ui.rt.quickReplies[v.session?.platformSessionId]]);
}

/**
 * 输入区除了「状态已核对」之外的输入都没变：新旧输入区只可能在禁用状态上不同（发送、权限、强度按钮）。
 * 结构确认一致才原地改 disabled，旧节点（加号、输入框、已打开的面板）全部保留；不一致返回 false，交给整块替换。
 * 比对时忽略 disabled、data-state、行内 style（自动撑宽写的）、权限面板说明文字和每次递增的 @ 面板编号；按钮的点击处理读到的会话状态与新建的一致（输入相同），状态已核对在点击时才读取。
 */
function rtPatchComposerStatus(old, el) {
  const shape = n => n.outerHTML.replace(/ disabled=""/g, "").replace(/ data-state="[^"]*"/g, "").replace(/ data-startup-send-ready="[^"]*"/g, "").replace(/rt-session-mentions-\d+/g, "rt-session-mentions").replace(/ style="[^"]*"/g, "").replace(/权限模式 · (此会话权限由原流程固定|修改后用于下一轮)/g, "权限模式 · ");
  if (shape(old) !== shape(el)) return false;
  const oldNodes = old.querySelectorAll("*"), newNodes = el.querySelectorAll("*");
  if (oldNodes.length !== newNodes.length) return false;
  // 输入框的事件都经 attrs 转发：换成新一轮的处理函数（发送、排队闭包），和整块替换时一致
  const oldHost = old.querySelector(".rt-mention-input"), newHost = el.querySelector(".rt-mention-input");
  if (oldHost?.updateMentionAttrs && newHost) oldHost.updateMentionAttrs(newHost.mentionAttrs);
  newNodes.forEach((n, i) => {
    const o = oldNodes[i];
    if ("disabled" in n && o.disabled !== n.disabled) o.disabled = n.disabled;
    if (n.dataset.state !== undefined && o.dataset.state !== n.dataset.state) o.dataset.state = n.dataset.state;
    if (n.rtPermissionState && o.rtPermissionState) o.rtPermissionState.view = n.rtPermissionState.view;
    // 权限面板里的说明文字随「是否已核对」在「权限固定」和「修改后用于下一轮」之间切换
    if (n.tagName === "P" && n.closest(".rt-permission-menu") && o.textContent !== n.textContent) o.textContent = n.textContent;
  });
  old.dataset.startupSendReady = el.dataset.startupSendReady;
  return true;
}

/**
 * 输入框正在使用时，把新输入区的其余节点搬进旧输入区，输入框所在的父链保持连接。
 * 返回 true 表示已经原地更新完，调用方不要再替换整个输入区。
 */
function rtPatchComposerInPlace(old, el) {
  const input = old.querySelector('textarea'), next = el.querySelector('textarea');
  if (!input || !next || input.dataset.key !== next.dataset.key) return false;
  const host = input.closest('.rt-mention-input'), newHost = next.closest('.rt-mention-input');
  // 没有焦点在输入区里时整体替换更简单；只有正在输入（或点着 @ 面板 / 引用 chip）才需要保住节点
  if (!host || !newHost || !host.contains(document.activeElement)) return false;
  // 绑定更新到新状态，草稿被清空（发送成功）或退回（发送失败）时仍要同步 value
  if (host.updateMentionAttrs) host.updateMentionAttrs(newHost.mentionAttrs);
  input.disabled = next.disabled;
  input.readOnly = next.readOnly;
  input.placeholder = next.placeholder;
  input.dataset.phonePlaceholder = next.dataset.phonePlaceholder || '';
  input.dataset.desktopPlaceholder = next.dataset.desktopPlaceholder || '';
  if (!input.isComposing && input.value !== next.value) {
    input.value = next.value;
    if (typeof rtRefreshComposer === "function") rtRefreshComposer(input);
  }
  // 沿父链把新输入区的其余子节点搬进来，keep 节点始终连着文档（不会触发 blur）
  // 先确认旧/新输入区的父链同构，避免结构变了还按旧位置搬节点
  let a = host, b = newHost;
  while (a !== old && b !== el) {
    if (!a || !b || a.parentNode?.tagName !== b.parentNode?.tagName) return false;
    a = a.parentNode; b = b.parentNode;
  }
  if (a !== old || b !== el) return false;
  let keep = host, placeholder = newHost;
  while (keep !== old && keep.parentNode) {
    const parent = keep.parentNode, nextParent = placeholder.parentNode;
    for (const child of [...parent.childNodes]) if (child !== keep) child.remove();
    let before = true;
    for (const child of [...nextParent.childNodes]) {
      if (child === placeholder) { before = false; continue; }
      parent.insertBefore(child, before ? keep : null);
    }
    keep = parent; placeholder = nextParent;
  }
  return keep === old;
}

const rtSha = (x) => (x || "").slice(0, 7);

/**
 * 这个会话有排队中/进行中的部署时，返回「排队部署 1e626b5 / 部署阶段 1e626b5」标签；没有就不显示。
 * 头部标题行不换行：标签只放阶段和提交号（与会话列表、部署结果通知同口径），在等什么只在悬停提示和时间线状态行里说。
 */
function rtDeployStateBadge(s) {
  const st = ui.rt.deploy && ui.rt.deploy.id === s.platformSessionId ? ui.rt.deploy : null;
  const d = st && st.info;
  if (!d || !d.eligible) return null;
  const mine = rtDeployMine(d, s.platformSessionId);
  if (!mine) {
    // 冲突自动解决：头部只放短标签（完整说明在悬停提示和时间线末尾的状态行），长文字放进标签行会把标题挤没
    const ar = d.autoResolve;
    if (!ar || ar.phase === "queued") return null;
    const node = ar.phase === "resolving" ? badge(`${ar.stage === "gate" ? "自动修复" : "解决冲突中"} ${ar.attempts}/${ar.max || 3}`, "accent") : badge("部署待处理", "bad");
    node.title = rtAutoResolveText(d);
    return node;
  }
  const started = !!mine.startedAt;
  // 排队时也不再塞「等哪个会话 / 哪一步」：手机上那串字会把标签挤成一长条，完整说明在悬停提示和状态行里
  const node = badge(`${rtDeployLabel(mine)} ${rtSha(mine.sha)}`, started && !["idle", "waiting"].includes(mine.progress?.phase) ? "accent" : "warn");
  node.title = rtDeployWaitText(mine);
  return rtDeployClickable(node, mine);
}

/** 部署请求的完整说明：排队时说明在等什么，部署中说明从什么时候开始 */
function rtDeployWaitText(q) {
  const what = `${rtSha(q.sha)}（${q.subject || ""}）`;
  if (q.startedAt) return `${rtDeployLabel(q)} ${what}：${q.progress?.detail || "正在确认发布阶段"}`;
  return `${q.staging ? rtDeployLabel(q) : "排队部署"} ${what}${q.wait ? `：${q.wait.detail}` : "：等所有会话停下来后部署"}`;
}

/**
 * 冲突自动解决的完整说明：进行中说明在等会话；需要人时说明原因（部署按钮照常可点，人点了就重新开始）。
 * 全站只在这一处生成这段话：悬停提示、时间线末尾的状态行都取它，别在别处再写一遍。
 */
function rtAutoResolveText(d) {
  const ar = d && d.autoResolve;
  if (!ar || ar.phase === "queued") return "";
  const files = (ar.conflicts || []).join("、");
  const gate = ar.stage === "gate";
  if (ar.phase !== "resolving") return `自动部署需要你处理：${ar.reason || files || (gate ? "会话没能自动修好门禁失败" : "会话没能自动解决冲突")}${rtGateRetryTail(d)}`;
  return gate
    ? `部署门禁没过（${files || "测试失败"}）：会话正在自动修复（第 ${ar.attempts}/${ar.max || 3} 次），这一轮结束后自动重新提交部署${rtGateRetryTail(d)}`
    : `和 ${d.branch || "main"} 冲突（${files || "代码冲突"}）：会话正在自动合并解决（第 ${ar.attempts}/${ar.max || 3} 次），这一轮结束后自动重新提交部署`;
}

/** 自动重试的次数与分段耗时（服务端生成的一句话；没有重试记录时为空） */
function rtGateRetryTail(d) {
  const text = d && d.gateRetry && d.gateRetry.summary;
  return text ? `。${text}` : "";
}

/** 额度用尽后的自动续聊说明：写明哪个窗口、几点自动继续，到点前可取消 */
function rtQuotaResumeNote(s, canControl) {
  const q = s.quotaResume;
  if (!q) return null;
  const when = new Date(q.scheduledFor).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const text = q.known
    ? `${q.window}额度已用尽，预计北京时间 ${when} 重置后自动继续，不需要你操作`
    : `额度暂时用尽，北京时间 ${when} 左右自动再试一次，不需要你操作`;
  return h("p", { class: "muted small rt-auto-resolve rt-quota-resume", role: "status" }, text,
    canControl ? h("button", { type: "button", class: "btn small", disabled: !!ui.rt.busy, onclick: () => void rtQuotaResumeCancel(s.platformSessionId) }, "取消自动继续") : null);
}

/* 缓存变冷：长上下文会话空闲超过缓存保留时间后再发消息，续聊要先把整段上下文重写一遍。
   服务端先拒绝并带上数字（RT_CACHE_COLD），这里在输入框上方问用户：继续旧会话，或新开会话接续并归档旧会话。 */
function rtColdCacheText(d) {
  const hours = (d.idleMs || 0) / 3600000;
  const idle = hours >= 1 ? `${hours.toFixed(hours >= 10 ? 0 : 1)} 小时` : `${Math.max(1, Math.round(hours * 60))} 分钟`;
  return `这个会话已空闲约 ${idle}，缓存已过期；上下文约 ${Math.round((d.contextTokens || 0) / 1000)}k token，继续发送会先把整段重写一次，比较费额度。`;
}

function rtColdCachePanel(id, send) {
  const c = ui.rt.coldPrompt;
  if (!c || c.id !== id) return null;
  const pick = (mode) => { ui.rt.coldPrompt = null; ui.rt.cacheChoice = { id, mode }; void send(c.quick); };
  return h("div", { class: "rt-cold-cache", role: "alert" },
    h("p", { class: "small rt-cold-cache-text" }, rtColdCacheText(c.details), " 新开会话会沿用工作目录和待办，并带上这个会话的记录位置，旧会话自动归档。"),
    h("div", { class: "rt-cold-cache-actions" },
      h("button", { type: "button", class: "btn small primary", disabled: !!ui.rt.busy, onclick: () => pick("new") }, "新开会话并归档旧会话"),
      h("button", { type: "button", class: "btn small", disabled: !!ui.rt.busy, onclick: () => pick("continue") }, "继续旧会话"),
      h("button", { type: "button", class: "btn small", onclick: () => { ui.rt.coldPrompt = null; rtRenderSoft(); } }, "先不发")));
}

/* 接续关系：新会话标明从哪个会话接续，被归档的旧会话标明已转到哪个新会话 */
function rtHandoffNote(s) {
  const link = (ref, label) => h("a", { href: `#/rt/${encodeURIComponent(ref.platformSessionId)}`, class: "rt-handoff-link" }, `${label}「${ref.title || ref.platformSessionId}」`);
  if (s.handoff?.from) return h("p", { class: "muted small rt-auto-resolve rt-handoff-note", role: "status" }, "接续自 ", link(s.handoff.from, "旧会话"), "：缓存已过期，所以新开会话接着做，旧会话已归档。");
  if (s.handoff?.to) return h("p", { class: "muted small rt-auto-resolve rt-handoff-note", role: "status" }, "缓存已过期，已转到 ", link(s.handoff.to, "新会话"), " 继续，这个会话已归档。");
  return null;
}

async function rtQuotaResumeCancel(id) {
  if (ui.rt.busy) return;
  ui.rt.error = "";
  try {
    const r = await api(`/api/runtime-sessions/${encodeURIComponent(id)}/quota-resume-cancel`, { method: "POST", body: "{}" });
    rtOutboxApply(id, r.session);
    announce("已取消自动继续");
  } catch (e) { if (rtId() === id) { ui.rt.error = e.message; announce(e.message); } }
  if (rtId() === id) rtRenderSoft();
}

/**
 * 输入框上方的说明行（可以换行，不占头部）；只对正在看的会话。
 * 时间线末尾的状态行已经写了同样的说明，这时不再重复一遍：只有状态行看不见时才在这里兜底。
 */
function rtComposerFlash() {
  const text = ui.rt.flash;
  if (!text) return null;
  // 仅去除消息中完整出现的提示，不按相似含义隐藏操作反馈。
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
  const required = /未确认|丢弃|没有自动重新部署|没有新提交|没有新改动|还在运行/.test(text);
  const repeated = !required && (ui.rt.events || []).some(event => event.kind === "message" && normalize(event.text).includes(normalize(text)));
  return repeated ? null : h("p", { class: "muted small" }, text);
}

function rtAutoResolveNote(id) {
  const st = ui.rt.deploy && ui.rt.deploy.id === id ? ui.rt.deploy : null;
  const d = st && st.info, ar = d && d.autoResolve;
  if (!ar || ar.phase === "queued" || rtDeployMine(d, id) || rtDeployStatusVisible()) return null;
  return ar.phase === "resolving"
    ? h("p", { class: "muted small rt-auto-resolve", role: "status" }, rtAutoResolveText(d))
    : h("p", { class: "small rt-auto-resolve rt-deploy-human", role: "alert" }, rtAutoResolveText(d));
}

function rtDeployControl(s, opts) {
  const st = ui.rt.deploy && ui.rt.deploy.id === s.platformSessionId ? ui.rt.deploy : null;
  const d = st && st.info;
  if (!d) return null;
  const mine = rtDeployMine(d, s.platformSessionId);
  // 会话正在解决冲突：结束后平台自动重新提交，这时不给按钮（状态见标签与输入框上方的说明）
  if (!mine && d.autoResolve && d.autoResolve.phase === "resolving") return null;
  return rtDeployButton(s, st, d, mine, opts);
}

function rtDeployButton(s, st, d, mine, opts) {
  // menuRow：出现在手机「更多」菜单里，和「归档」一样是一行菜单项（样式见 .rt-more-acts）
  const itemClass = opts && opts.menuRow ? "rt-more-item" : "btn small";
  const attrs = opts && opts.menuRow ? { role: "menuitem" } : {};
  if (mine) return h("button", { type: "button", ...attrs, class: itemClass, onclick: ev => { rtToggleMore(false); rtOpenDeployProgress(mine, document.querySelector(".rt-more-btn") || ev.currentTarget); } }, "查看部署进度");
  if (!d.eligible) return d.blockedCode ? h("span", { class: "muted small rt-deploy", role: "status" }, `暂不能部署：${d.reason}`) : null;
  const wt = d.mode === "worktree";
  return h("button", { type: "button", ...attrs, class: itemClass, disabled: !!st.busy,
    title: wt ? `提交这个会话 worktree 里的改动、并进 ${d.branch}，等所有会话都停下来后部署，结果发回这个会话` : `等所有会话都停下来后部署 ${d.branch} 的最新提交，结果发回这个会话`,
    onclick: () => { rtToggleMore(false); void rtDeployAsk(s); } }, st.busy ? (wt ? "提交中…" : "登记中…") : wt ? "提交并在空闲时部署" : "空闲时部署");
}

/**
 * 桌面「更多」浮层是按需弹出的 popover：弹在顶层，不受父容器的 overflow / 层叠影响，
 * 因此位置要按按钮的视口坐标手动算（CSS 里不再写死 top / right）。
 * 右边缘对齐按钮：放得下就贴在按钮下方，下方空间不够翻到上方，左右 / 上下都夹在视口内。
 */
function rtPlaceDeployMenu(button, menu) {
  if (!button.isConnected || !menu.isConnected) return;
  const gap = 6, pad = 8;
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = window.innerHeight;
  const r = button.getBoundingClientRect();
  // 优先弹在按钮下方；下方比上方窄（按钮靠近页底）时弹到上方。高度按这一侧剩余空间限，放不下就菜单自己滚。
  const below = vh - pad - (r.bottom + gap) >= r.top - gap - pad;
  menu.style.maxHeight = `${Math.max(160, below ? vh - pad - (r.bottom + gap) : r.top - gap - pad)}px`;
  const box = menu.getBoundingClientRect();
  const w = Math.min(box.width, vw - pad * 2);
  const h = box.height;
  const left = Math.min(Math.max(r.right - w, pad), Math.max(pad, vw - pad - w));
  const top = Math.min(Math.max(below ? r.bottom + gap : r.top - gap - h, pad), Math.max(pad, vh - pad - h));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

/** 当前打开的桌面「更多」浮层：窗口变化、页面滚动、菜单内容尺寸变化时都重新贴回按钮旁边。 */
let rtDeployMenuAnchor = null;
let rtDeployMenuWatch = false;
let rtDeployMenuObserver = null;
function rtWatchDeployMenu() {
  if (rtDeployMenuWatch) return;
  rtDeployMenuWatch = true;
  const follow = () => {
    const a = rtDeployMenuAnchor;
    if (!a) return;
    if (!a.menu.isConnected || !a.menu.matches(":popover-open")) { rtDeployMenuAnchor = null; return; }
    rtPlaceDeployMenu(a.button, a.menu);
  };
  window.addEventListener("resize", follow);
  window.addEventListener("scroll", follow, true);
  if (typeof ResizeObserver === "function") rtDeployMenuObserver = new ResizeObserver(follow);
}
function rtTrackDeployMenu(button, menu) {
  rtDeployMenuAnchor = { button, menu };
  rtWatchDeployMenu();
  rtDeployMenuObserver?.disconnect();
  rtDeployMenuObserver?.observe(menu);
}

function rtSetTurnSummaryMode(next) {
  const enabled = !!next;
  if (window.piTurnSummaryMode?.setEnabled) window.piTurnSummaryMode.setEnabled(enabled);
  else {
    try {
      if (enabled) localStorage.setItem("pi-agent:turn-summary-mode:v1", "1");
      else localStorage.removeItem("pi-agent:turn-summary-mode:v1");
    } catch { /* 忽略 */ }
    window.dispatchEvent(new CustomEvent("pi-turn-summary-mode-change", { detail: { enabled } }));
  }
  announce(enabled ? "已开启回合汇总模式" : "已关闭回合汇总模式");
}
if (!window.__rtTurnSummaryModeBound) {
  window.__rtTurnSummaryModeBound = true;
  window.addEventListener("pi-turn-summary-mode-change", () => {
    if (typeof ui !== "undefined" && ui.view === "rt" && ui.rt?.view) rtRenderSoft();
  });
}

function rtTurnSummaryMenuItem({ menuRow = false, onToggle } = {}) {
  const on = typeof rtTurnSummaryModeEnabled === "function" ? rtTurnSummaryModeEnabled() : false;
  return h("button", {
    type: "button",
    role: "menuitemcheckbox",
    "aria-checked": String(on),
    class: menuRow ? "rt-more-item rt-more-toggle" : "btn small rt-more-toggle",
    onclick: () => {
      if (onToggle) onToggle();
      rtSetTurnSummaryMode(!on);
    }
  },
    h("span", { class: "rt-more-label" }, "回合汇总模式"),
    h("span", { class: `rt-more-state${on ? " on" : ""}` }, on ? "已开启" : "已关闭"));
}

function rtDesktopDeployMore(s) {
  const control = rtDeployControl(s);
  const singleChat = !s.roomRef && !s.comparisonRef && !s.projectRef;
  if (!control && !singleChat) return null;
  const menu = h("div", { id: "rt-deploy-more", popover: "auto", role: "dialog", class: "rt-deploy-more-menu", "aria-label": "会话更多操作" },
    control,
    singleChat ? rtTurnSummaryMenuItem({ onToggle: () => { try { menu.hidePopover?.(); } catch { /* ignore */ } } }) : null);
  const button = h("button", { type: "button", class: "btn small rt-more-btn", "aria-label": "更多", "aria-expanded": "false", "aria-haspopup": "dialog", popovertarget: "rt-deploy-more" }, "⋯");
  menu.addEventListener("toggle", ev => {
    button.setAttribute("aria-expanded", String(ev.newState === "open"));
    if (ev.newState !== "open") { if (rtDeployMenuAnchor?.menu === menu) rtDeployMenuAnchor = null; return; }
    rtTrackDeployMenu(button, menu);
    rtPlaceDeployMenu(button, menu);
    menu.querySelector("button")?.focus({ preventScroll: true });
  });
  return h("span", { class: "rt-desktop-more" }, button, menu);
}

/**
 * direct：从快捷回复里的「部署」点进来，等同点「空闲时部署 / 提交并在空闲时部署」并在确认框里点确定
 * （提交说明用确认框的默认值，即会话标题）；info 是刚读到的部署状态，不再重读。
 */
async function rtDeployAsk(s, { direct = false, info = null, auto = false, failedSha = "", state = null } = {}) {
  const id = s.platformSessionId;
  const gen = ui.rt.gen, current = () => rtReadCurrent(id, gen);
  const st = state || ui.rt.deploy;
  // direct 是用户已经点了提交：一旦开始就要做完，中途切到别的会话也不能中断（只是结果不能写进别的会话的页面）。
  const proceed = () => direct || current();
  if (!st || st.id !== id || !proceed()) return false;
  const prefix = auto ? "已自动重新部署：" : "";
  // 还在这个会话页就写在页面上；已经切走就用列表顶部的提示条说明结果，别写进现在看的会话。
  const note = (kind, msg) => {
    if (current()) { ui.rt[kind] = msg; return; }
    announce(msg);
    ui.rt.archiveFlash = { text: `「${s.title || "会话"}」${msg}`, error: kind === "error" };
    clearTimeout(ui.rt.flashTimer);
    ui.rt.flashTimer = setTimeout(() => { ui.rt.archiveFlash = null; rtRenderListOnly(); }, 6000);
    if (typeof rtRenderListOnly === "function") rtRenderListOnly();
  };
  st.busy = true;
  if (current()) { ui.rt.error = ""; ui.rt.flash = ""; rtRenderSoft(); }
  try {
    const d = info || await api(`/api/runtime-sessions/${id}/deploy`);
    if (!proceed()) return false;
    st.info = d;
    const queued = rtDeployMine(d, id);
    if (queued) { const msg = `已登记过：空闲时部署 ${rtSha(queued.sha)}（${queued.subject}），结果会发回这个会话。`; announce(prefix + msg); return false; }
    if (!d.eligible) { const msg = d.reason || "这个会话不能请求部署"; note("error", msg); if (auto) announce(`${prefix}${msg}`); return false; }
    const wt = d.mode === "worktree" ? d.worktree : null;
    // 共享目录里的会话：改动不会自动进 main；main 上没有新提交时说明原因，而不是只说「已经在线上」
    if (!wt && d.live && d.live.sha === d.main.sha) { const msg = `${d.branch} 的 ${rtSha(d.main.sha)} 已经在线上，没有新提交可部署。${d.note || ""}`; note("flash", msg); if (auto) announce(prefix + msg); return false; }
    if (wt && !wt.changes.length && !wt.ahead) { const msg = `这个会话的 worktree 里没有新改动（和 ${d.branch} 一样），不用部署。`; note("flash", msg); if (auto) announce(prefix + msg); return false; }
    if (wt && ["creating", "running", "waiting-input", "stopping"].includes((current() ? ui.rt.view?.session || s : s).status)) { const msg = "会话还在运行，等这一轮结束再提交。"; note("flash", msg); if (auto) announce(prefix + msg); return false; }
    const act = d.activity || {};
    const waits = [
      ...(act.active || []).map((x) => `· 会话「${x.title}」${RT_STATUS[x.status] ? RT_STATUS[x.status][0] : x.status}${x.platformSessionId === id ? "（就是这个会话，这一轮结束后）" : ""}`),
      act.pendingApprovals ? `· 待审批 ${act.pendingApprovals} 项` : "", act.queued ? `· 排队 ${act.queued} 项` : "", act.unknownOps ? `· 结果未知 ${act.unknownOps} 项` : ""
    ].filter(Boolean);
    const tail = [
      d.live ? `线上现在是 ${rtSha(d.live.sha)}（${d.live.subject}）。` : "",
      waits.length ? `要等这些结束后才开始部署：\n${waits.join("\n")}` : "现在没有在跑的会话，稍后就会开始部署。",
      "部署前会自动合并最新 main、线上版本与要部署的提交；无冲突会继续部署，有代码冲突才停下来。",
      "部署会先跑类型检查和 web 测试（几分钟），通过后重启服务；重启时不能有会话在跑，所以会一直等到全部空闲（最多 6 小时）。结果会作为一条消息发回这个会话。"
    ].filter(Boolean);
    let message;
    if (wt) {
      const files = wt.changes.slice(0, 12).map((c) => `· ${c.path}`);
      const head = [
        wt.changes.length ? `提交这个会话 worktree 里的 ${wt.changes.length} 个改动：\n${files.join("\n")}${wt.changes.length > files.length ? `\n· …另有 ${wt.changes.length - files.length} 个` : ""}` : "",
        wt.ahead ? `已有 ${wt.ahead} 个提交还没进 ${d.branch}。` : "",
        wt.behind ? `${d.branch} 之后又有 ${wt.behind} 个新提交：会先把这个会话的改动移到最新的 ${d.branch} 上，冲突就停下、不部署。` : "",
        `然后空闲时部署这个提交（它先留在会话分支 ${wt.branch} 上）：类型检查、测试都通过并上线成功后，才把 ${d.branch} 前移到它；没通过 ${d.branch} 不变。`
      ].filter(Boolean);
      message = direct ? s.title || "" : prompt([...head, ...tail, wt.changes.length ? "提交说明：" : "确定吗？（说明不会用到）"].join("\n\n"), s.title || "");
      if (message === null) return false;
    } else if (!direct && !confirm([`空闲时部署 ${d.branch} 的 ${rtSha(d.main.sha)}（${d.main.subject}）？`, ...tail, d.note ? `注意：${d.note}` : ""].filter(Boolean).join("\n\n"))) return false;
    const r = await api(`/api/runtime-sessions/${id}/deploy`, { method: "POST", body: JSON.stringify({ expectedSha: d.main.sha, ...(auto ? { autoRedeploy: true, ...(failedSha ? { failedSha } : {}) } : {}), ...(wt ? { message } : {}) }) });
    st.info = r;
    if (r.conflict && !r.request) {
      // 和 main 冲突：平台已让会话自己合并解决，结束后自动重新提交部署；自动处理不了才需要人
      const ar = r.autoResolve || {};
      const files = (r.conflict.conflicts || []).join("、");
      if (ar.phase === "resolving") {
        // 只写这一下点的结果；后续进展（这一轮结束后自动重新提交部署）由时间线末尾的状态行说明，不在这重复
        const msg = `${prefix}${r.conflict.committed ? `已提交 ${rtSha(r.conflict.committed)}，` : ""}和 ${d.branch} 冲突（${files || "代码冲突"}）：已交给会话自动合并解决。`;
        announce(msg);
      } else { const msg = `自动部署需要你处理：${ar.reason || r.conflict.message}`; note("error", msg); if (auto) announce(`${prefix}${msg}`); }
      if (current()) { void rtLoadView(id, gen).then(() => { if (current()) rtRenderSoft(); }); void rtLoadDeploy(id); }
      else rtRefreshDeployCache(id);
      return false;
    }
    const done = `${r.committed ? `已提交 ${rtSha(r.committed)}${r.rebased ? `（已移到最新的 ${d.branch} 上${r.autoResolvedAssets ? `，自动解决了 index.html 的 ${r.autoResolvedAssets} 处版本号冲突` : ""}）` : ""}，` : ""}已登记：空闲时部署 ${rtSha(r.request.sha)}。结果会发回这个会话。${direct && !wt && d.note ? `注意：${d.note}` : ""}`;
    const msg = prefix + done;
    announce(msg);
    // 登记结果由部署消息和状态行呈现；共享目录注意事项仍需单独提醒。
    if (direct && !wt && d.note) note("flash", `注意：${d.note}`);
    else if (!current()) note("flash", msg);
    if (current()) void rtLoadDeploy(id); else rtRefreshDeployCache(id);
    // 返回登记结果：自动触发用它同步服务端已占用的配额。
    return r;
  } catch (e) { note("error", e.message); if (auto) announce(`${prefix}${e.message}`); return false; }
  finally { st.busy = false; if (current()) rtRenderSoft(); }
}

async function rtDeployCancel(s, q) {
  const id = s.platformSessionId, gen = ui.rt.gen, current = () => rtReadCurrent(id, gen);
  if (!current()) return;
  if (!confirm(`取消空闲时部署 ${rtSha(q.sha)}（${q.subject}）？`)) return;
  const st = ui.rt.deploy;
  st.busy = true; rtRenderSoft();
  try {
    const info = await api(`/api/runtime-sessions/${id}/deploy/${encodeURIComponent(q.id)}`, { method: "DELETE" });
    if (!current()) return;
    st.info = info;
    announce(`已取消部署 ${rtSha(q.sha)}`);
  } catch (e) { if (current()) ui.rt.error = e.message; }
  finally { st.busy = false; if (current()) rtRenderSoft(); }
}

/** 独立 worktree 的会话显示原来选的目录（仓库根 + 子目录）；实际改动位置另行列出 */
function rtShownWorkspace(s) {
  const w = s.worktree;
  return w ? (w.subdir ? `${w.repoRoot}/${w.subdir}` : w.repoRoot) : s.workspace;
}

/** 会话副标题：模型 / 运行时 / 工作目录 / 状态；手机上默认收起，点「模型/运行时」展开。 */
function rtSubText(s, model, v) {
  return [rtModelShort(model) || "模型未知", RT_KIND[s.runtimeKind], rtShownWorkspace(s), s.worktree ? `独立 worktree ${s.worktree.branch}` : "", rtStatusReasonText(s, v)].filter(Boolean).join(" · ");
}
/** 状态标签显示的文字：和 rtStatusBadge 同一套，空闲时优先显示最后一轮的结果。 */
function rtStatusLabel(s, v) {
  if (s.status === "idle" && v && v.session && (v.session.turns || []).length) {
    const last = v.session.turns[v.session.turns.length - 1];
    if (last.status === "completed") return "本轮完成";
    if (last.status === "failed") return "本轮失败";
    if (last.status === "cancelled") return "已停止";
  }
  return (RT_STATUS[s.status] || [String(s.status)])[0];
}
/** 副标题里的状态说明去重：「本机运行中」「本轮完成」这类只重复标签的文字不再显示，保留额外说明。 */
function rtStatusReasonText(s, v) {
  const reason = (s.statusReason || "").trim();
  if (!reason) return "";
  const label = rtStatusLabel(s, v);
  if (!label || !reason.includes(label)) return reason;
  return reason.split(label).join("")
    .replace(/^(本轮|本机|当前|这一轮|会话)/, "")
    .replace(/^[：:，,。；;、\s（(【\[]+|[：:，,。；;、\s）)】\]]+$/g, "")
    .trim();
}
function rtSubLinks(s) {
  return [
    s.roomRef ? h("p", { class: "small" }, h("a", { href: `#/rt/room/${s.roomRef.roomId}` }, "← 群聊")) : null,
    s.comparisonRef ? h("p", { class: "small" }, h("a", { href: `#/rt/compare/${s.comparisonRef.groupId}` }, `← 对比组 · 通道 ${s.comparisonRef.laneNo}`)) : null
  ].filter(Boolean);
}
function rtTitleTags(v, s, a, managed, busy, entry, withActions = true) {
  return h("div", { class: "rt-title-tags" },
    managed ? null : badge("只读历史", ""),
    s.archived ? badge("已归档", "") : null,
    rtStatusBadge(s.status, v),
    s.observation && s.observation !== "live" ? badge(RT_OBS[s.observation] || s.observation, "warn") : null,
    v.queuePosition ? badge(`排队第 ${v.queuePosition} 位`, "warn") : null,
    rtDeployStateBadge(s),
    rtLinkedNoteTag(v),
    rtNoticeTag(v),
    rtRecommendationTag(v),
    withActions && managed && a && a.control ? rtDesktopDeployMore(s) : null,
    withActions && managed && a && a.control && !busy ? h("button", { type: "button", class: "btn small", title: s.archived ? "恢复到列表，不会恢复已删除的 worktree" : s.worktree ? "归档并删除 worktree，未提交、未合并改动将丢弃" : "归档", disabled: rtArchivePending.has(s.platformSessionId), onclick: (ev) => void rtArchive(entry, !entry.archived, ev.currentTarget) }, s.archived ? "恢复" : "归档") : null);
}

/**
 * 会话里的提示不长期占据正文顶部，也不混在同一个弹层里：
 * - 授权入口（盾牌图标 + 数字）：权限模式 / 合约门禁说明、本会话已全部授权的撤销；
 * - 推荐任务入口（叠层待办图标 + 数字）：从推荐任务发起的会话，展示启动时需求与来源待办；
 *   推荐任务本质上是待办聚合，沿用待办入口的位置，图形叠层区分，颜色与授权入口一致。
 * 两者都在标题标签行末尾，点开才展开；单条关联待办另有自己的待办图标。
 */
function rtNoticeItems(v) {
  const s = v && v.session;
  if (!s) return [];
  const items = [];
  if (v.executionNotice) items.push({ key: "gate", text: v.executionNotice });
  if (s.runtimeKind === "pi" && s.sourceMode === "platform-managed" && s.nativeSessionId) items.push({ key: "runtime-grants" });
  if (s.approvalGrant) items.push({ key: "grant", grant: s.approvalGrant });
  if (s.recommendationRef) items.push({ key: "recommendation", ref: s.recommendationRef, loading: ui.rt.linkedNoteFor !== s.platformSessionId, notes: ui.rt.linkedRecommendationNotes });
  return items;
}
/** 授权入口只收权限相关提示：推荐任务有自己的入口，不混进授权弹层。 */
function rtGrantNoticeItems(v) {
  return rtNoticeItems(v).filter((item) => item.key === "gate" || item.key === "grant" || item.key === "runtime-grants");
}
/** 推荐任务入口单独计数，不占用授权入口的数字。 */
function rtRecommendationNoticeItems(v) {
  return rtNoticeItems(v).filter((item) => item.key === "recommendation");
}
function rtLinkedNoteItem(v) {
  const s = v && v.session;
  const noteId = s?.noteRef?.noteId;
  if (!noteId) return null;
  const forThis = ui.rt.linkedNoteFor === s.platformSessionId;
  return { key: "note", noteId, loading: !forThis, note: forThis ? ui.rt.linkedNote : null };
}
/**
 * 会话详情标题行的关联待办：单独一个图标，点开看记录并就地标记完成 / 跳去查看。
 * 一个会话最多关联一条待办：数字取实际读到的记录数（1），记录被删后为 0；仍在读取或读取失败时
 * 不显示数字（不知道实际数量，不能用 0 冒充）。没有 noteRef 时整个图标（连同数字）都不渲染。
 * 数字样式与授权 / 推荐任务入口共用 .rt-notice-count，按钮的点击与弹层行为不变。
 */
function rtLinkedNoteTag(v) {
  const item = rtLinkedNoteItem(v);
  if (!item) return null;
  const open = !!ui.rt.noteOpen;
  const done = item.note?.done;
  const count = item.loading || (!item.note && ui.rt.linkedNoteError) ? null : item.note ? 1 : 0;
  const detail = item.loading ? "正在读取待办记录…" : !item.note ? "关联的待办记录已被删除" : item.note.text || "关联待办";
  const label = `关联待办${count == null ? "" : ` ${count} 条`}${done ? "，已完成" : ""}`;
  return h("span", { class: `rt-note-pop${open ? " open" : ""}` },
    h("button", { type: "button", class: "rt-note-tag", "data-rt-note-tag": "", "data-note-id": item.noteId,
      "aria-expanded": String(open), "aria-controls": "rt-note-sheet",
      title: [count == null ? "关联待办" : `关联待办 ${count} 条${done ? "（已完成）" : ""}`, detail].filter(Boolean).join("："), "aria-label": label,
      onclick: () => rtToggleNote(!ui.rt.noteOpen) },
      rtMiniIcon(RT_MINI_PATHS.note, { size: 14 }),
      count == null ? null : h("span", { class: "rt-notice-count" }, String(count))),
    h("button", { type: "button", class: "rt-note-backdrop", tabindex: "-1", "aria-label": "关闭关联待办", onclick: () => rtToggleNote(false) }),
    h("div", { class: "rt-note-sheet", id: "rt-note-sheet", role: "dialog", "aria-modal": "true", tabindex: "-1", "aria-label": "关联待办", onkeydown: rtNoticeKeydown(() => rtToggleNote(false)) },
      h("div", { class: "rt-notice-heading" },
        h("p", { class: "rt-notice-title" }, "关联待办"),
        h("button", { type: "button", class: "btn small", "aria-label": "关闭关联待办弹窗", onclick: () => rtToggleNote(false) }, "关闭")),
      rtLinkedNoteNotice(item)));
}
/** 提示弹层的键盘行为：Esc 关闭，Tab 在弹层内循环。 */
function rtNoticeKeydown(close) {
  return (ev) => {
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); close(); }
    if (ev.key === "Tab") {
      const buttons = [...ev.currentTarget.querySelectorAll("button:not(:disabled)")];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last?.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first?.focus(); }
    }
  };
}
/** 标题行的授权入口：盾牌图标 + 数字 = 授权相关提示条数（合约门禁说明 + 授权撤销）。 */
/**
 * 卡住看门狗的自动中止开关（默认开）：关掉后仍会在 2/5/10 分钟提醒，但不会打断本轮。
 * 放在「授权」入口里，不占新地方也不进正文。
 */
function rtStallGuardRow(v) {
  const s = v.session, on = s.stallGuardAutoAbort !== false;
  const canAct = !!ui.rt.access?.control && ui.rt.statusConfirmed !== false && !ui.rt.busy;
  return h("div", { class: "rt-notice-item rt-stall-guard", role: "group", "aria-label": "卡住自动中止" },
    h("p", { class: "rt-notice-item-text" }, on
      ? "卡住的工具会自动中止：单个工具连续运行 2 / 5 / 10 分钟各提醒一次，20 分钟没结束就停掉这一轮（浏览器工具从 5 分钟开始提醒）。"
      : "卡住的工具只提醒不中止：2 / 5 / 10 分钟各提醒一次（浏览器工具从 5 分钟开始），停下来由你决定。"),
    h("button", { type: "button", class: "btn small", disabled: !canAct, onclick: () => rtSetStallGuard(!on) }, on ? "关掉自动中止" : "开启自动中止"));
}

async function rtSetStallGuard(autoAbort) {
  const id = rtId();
  if (ui.rt.statusConfirmed === false) return;
  const gen = ui.rt.gen;
  ui.rt.busy = "stall"; ui.rt.error = ""; rtRenderSoft();
  try {
    const r = await api(`/api/runtime-sessions/${id}/stall-guard`, { method: "POST", body: JSON.stringify({ autoAbort }) });
    if (rtReadCurrent(id, gen)) { ui.rt.view = { ...ui.rt.view, session: r.session }; announce(autoAbort ? "已开启卡住自动中止" : "已关闭卡住自动中止：仍会提醒，不会打断"); }
  } catch (e) { if (rtReadCurrent(id, gen)) { ui.rt.error = `设置失败：${e.message}`; announce(`设置失败：${e.message}`); } }
  if (rtReadCurrent(id, gen)) { ui.rt.busy = ""; await rtLoadView(id, gen); rtRenderSoft(); }
}

function rtNoticeTag(v) {
  const items = rtGrantNoticeItems(v);
  if (!items.length) return null;
  const open = !!ui.rt.noticeOpen;
  const hasRuntime = items.some(i => i.key === "runtime-grants");
  const grantState = ui.rt.runtimeGrants?.id === v.session.platformSessionId ? ui.rt.runtimeGrants : null;
  const kinds = [hasRuntime ? "runtime 授权管理" : null, items.some((i) => i.key === "gate") ? "合约门禁说明" : null, items.some((i) => i.key === "grant") ? "授权撤销" : null].filter(Boolean).join("、");
  return h("span", { class: `rt-notice rt-grant${open ? " open" : ""}` },
    h("button", { type: "button", class: `badge accent rt-notice-tag${open ? " open" : ""}`, "data-rt-grant-tag": "", "aria-expanded": String(open), "aria-controls": "rt-notice-sheet",
      title: `授权 ${items.length} 条：${kinds}`, "aria-label": `授权提示 ${items.length} 条`,
      onclick: () => rtToggleNotice(!ui.rt.noticeOpen) },
      rtMiniIcon(RT_MINI_PATHS.shieldCheck, { size: 13 }),
      h("span", { class: "rt-notice-count" }, String(items.length))),
    h("button", { type: "button", class: "rt-notice-backdrop", tabindex: "-1", "aria-label": "关闭授权提示", onclick: () => rtToggleNotice(false) }),
    h("div", { class: `rt-notice-sheet${hasRuntime ? " rt-runtime-grants-sheet" : ""}`, id: "rt-notice-sheet", role: "dialog", "aria-modal": "true", tabindex: "-1", "aria-label": "授权提示", onkeydown: rtNoticeKeydown(() => rtToggleNotice(false)) },
      h("div", { class: "rt-notice-heading" },
        h("p", { class: "rt-notice-title" }, `授权（${items.length}）`),
        h("button", { type: "button", class: "btn small", "aria-label": "关闭授权提示弹窗", onclick: () => rtToggleNotice(false) }, "关闭")),
      h("div", {class:"rt-notice-body",onscroll:ev=>{const state=ui.rt.runtimeGrants;if(hasRuntime&&state?.id===v.session.platformSessionId)state.scroll=ev.currentTarget.scrollTop;}}, ...(hasRuntime?[rtStallGuardRow(v)]:[]), ...items.map(rtNoticeItem)),
      hasRuntime ? h("div",{class:"rt-runtime-grants-footer"},
        h("button",{type:"button",class:"btn small",disabled:!!grantState?.loading||!!grantState?.busy,onclick:()=>rtLoadRuntimeGrants()},"刷新授权"),
        ui.rt.access?.control && ui.rt.statusConfirmed !== false ? h("button",{type:"button",class:"btn small",disabled:!grantState?.data?.grants?.length||!!grantState?.loading||!!grantState?.busy,onclick:()=>rtRevokeRuntimeGrant()},"撤销全部 runtime 授权") : null) : null));
}
/** 推荐任务入口：与授权入口分开，弹层里只放推荐任务内容。推荐是待办聚合，叠层待办图形与单条待办区分，颜色与授权入口一致。 */
function rtRecommendationTag(v) {
  const items = rtRecommendationNoticeItems(v);
  if (!items.length) return null;
  const ref = items[0].ref;
  const open = !!ui.rt.recommendationOpen;
  return h("span", { class: `rt-notice rt-recommendation${open ? " open" : ""}` },
    h("button", { type: "button", class: `rt-rec-tag${open ? " open" : ""}`, "data-rt-rec-tag": "", "aria-expanded": String(open), "aria-controls": "rt-rec-sheet",
      title: `推荐任务 ${items.length} 条：${ref.title} · ${ref.sources.length} 条待办`, "aria-label": `推荐任务 ${items.length} 条`,
      onclick: () => rtToggleRecommendation(!ui.rt.recommendationOpen) },
      rtMiniIcon(RT_MINI_PATHS.recommendation, { size: 13 }),
      h("span", { class: "rt-notice-count" }, String(items.length))),
    h("button", { type: "button", class: "rt-notice-backdrop", tabindex: "-1", "aria-label": "关闭推荐任务", onclick: () => rtToggleRecommendation(false) }),
    h("div", { class: "rt-notice-sheet rt-rec-sheet", id: "rt-rec-sheet", role: "dialog", "aria-modal": "true", tabindex: "-1", "aria-label": "推荐任务", onkeydown: rtNoticeKeydown(() => rtToggleRecommendation(false)) },
      h("div", { class: "rt-notice-heading" },
        h("p", { class: "rt-notice-title" }, `推荐任务（${items.length}）`),
        h("button", { type: "button", class: "btn small", "aria-label": "关闭推荐任务弹窗", onclick: () => rtToggleRecommendation(false) }, "关闭")),
      ...items.map(rtNoticeItem)));
}
function rtNoticeItem(item) {
  if (item.key === "runtime-grants") return rtRuntimeGrantNotice();
  if (item.key === "gate") return h("div", { class: "rt-notice-item", role: "note" }, item.text);
  if (item.key === "recommendation") return rtLinkedRecommendationNotice(item);
  const g = item.grant;
  const canAct = ui.rt.access && ui.rt.access.control && ui.rt.statusConfirmed !== false;
  return h("div", { class: "rt-notice-item", role: "status" },
    h("p", { class: "rt-notice-item-text" }, `本会话已全部授权：普通审批自动批准，Pi 扩大执行权限仍需单次批准（${g.grantedBy} · ${new Date(g.at).toLocaleString()}）。`),
    canAct ? h("button", { type: "button", class: "btn small", disabled: !!ui.rt.busy, onclick: () => rtRevokeGrant() }, "撤销全部授权") : null,
    ui.rt.error ? h("p", { class: "field-error", role: "alert" }, ui.rt.error) : null);
}

function rtHead(v) {
  const s = v.session;
  const a = ui.rt.access;
  const managed = s.sourceMode === "platform-managed";
  const busy = ["creating", "running", "waiting-input", "stopping"].includes(s.status);
  const model = s.effectiveModel || s.requestedModel;
  const entry = { id: s.platformSessionId, title: s.title, archived: !!s.archived };
  const tags = rtTitleTags(v, s, a, managed, busy, entry);
  if (rtPhone.matches) {
    // 手机详情页：头部导航栏分两行——第一行返回 / 标题 / ⋮，第二行状态与部署标签；点标题展开运行时信息；部署/归档收进「⋮」
    const subOpen = !!ui.rt.subOpen;
    const toggleSub = () => { if (ui.view !== "rt") return; ui.rt.subOpen = !subOpen; renderMain(); };
    const deployCtrl = managed && a && a.control ? rtDeployControl(s, { menuRow: true }) : null;
    const canArchive = managed && a && a.control && !busy;
    const singleChat = managed && a && a.control && !s.roomRef && !s.comparisonRef && !s.projectRef;
    // 「⋮」里放部署、归档与受管单聊的回合汇总模式开关；只读会话不弹出空菜单
    const moreActions = [
      deployCtrl ? h("div", { class: "rt-more-deploy" }, deployCtrl) : null,
      canArchive ? h("button", { type: "button", role: "menuitem", class: "rt-more-item", onclick: (ev) => { rtToggleMore(false); void rtArchive(entry, !entry.archived, ev.currentTarget); } }, h("span", { class: "rt-more-label" }, entry.archived ? "恢复" : "归档")) : null,
      singleChat ? rtTurnSummaryMenuItem({ menuRow: true, onToggle: () => rtToggleMore(false) }) : null,
    ].filter(Boolean);
    if (!moreActions.length) ui.rt.moreOpen = false;
    const more = moreActions.length ? h("div", { class: `rt-more${ui.rt.moreOpen ? " open" : ""}` },
      h("button", { type: "button", class: "btn small rt-more-btn", "aria-label": "更多", "aria-expanded": String(!!ui.rt.moreOpen), "aria-controls": "rt-more-sheet", onclick: () => rtToggleMore(!ui.rt.moreOpen) }, "⋮"),
      h("button", { type: "button", class: "rt-more-backdrop", tabindex: "-1", "aria-label": "关闭菜单", onclick: () => rtToggleMore(false) }),
      h("div", { class: "rt-more-sheet rt-more-acts", id: "rt-more-sheet", role: "menu", "aria-label": "会话菜单" }, moreActions)) : null;
    const titleText = h("span", { class: "rt-title-text" }, s.title);
    const titleLine = h("div", { class: "rt-title-line" },
      h("h1", { class: "rt-title" },
        h("span", { class: "rt-title-toggle", role: "button", tabindex: "0", "aria-expanded": String(subOpen), "aria-controls": "rt-sub-body", title: subOpen ? "收起模型与运行时信息" : "展开模型与运行时信息", onclick: toggleSub, onkeydown: (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggleSub(); } } }, titleText)));
    // 标题左侧的大 logo：占满标题与标签两行，两行内容都从 logo 右侧开始对齐
    const logo = h("span", { class: "rt-head-logo" }, rtAvatar(s.runtimeKind, model, "lg"));
    const header = h("header", { class: "rt-head rt-head-phone" },
      h("div", { class: "rt-head-nav" },
        h("button", { type: "button", class: "btn small rt-list-toggle rt-back", "aria-label": "会话列表", "aria-expanded": String(ui.rt.listOpen || rtListPage()), onclick: () => rtOpenList() }, "‹"),
        logo,
        titleLine,
        more,
        rtTitleTags(v, s, a, managed, busy, entry, false)),
      subOpen ? h("div", { class: "rt-sub-block", id: "rt-sub-body" },
        h("p", { class: "rt-sub-full-title" }, s.title),
        h("p", { class: "rt-sub muted small" }, rtSubText(s, model, v)),
        rtSubLinks(s)) : null);
    requestAnimationFrame(() => rtSyncSubTitle());
    return header;
  }
  return h("header", { class: "rt-head" },
    h("button", { type: "button", class: "btn small rt-list-toggle", "aria-expanded": String(ui.rt.listOpen || rtListPage()), onclick: () => rtOpenList() }, "会话列表"),
    h("button", { type: "button", class: "btn small rt-info-toggle", "aria-controls": "rt-session-info", "aria-expanded": String(rtPhone.matches && ui.rt.infoOpen), onclick: () => rtSetInfoOpen(true) }, "会话详情"),
    // 标题独占第一行：状态与部署等标签移到第三行右对齐（原来的「对话/工具/用量/来源」标签已取消）
    h("div", { class: "rt-title-row" },
      rtAvatar(s.runtimeKind, model, "lg"),
      h("div", { class: "rt-title-main" },
        h("h1", { class: "rt-title" }, s.title),
        h("p", { class: "rt-sub muted small" }, rtSubText(s, model, v)),
        rtSubLinks(s))),
    h("div", { class: "rt-head-tabrow" }, tags));
}

/** 提交中显示发送中；服务器确认后立即显示已发送，直到对应真实消息替换占位。 */
function rtOutgoing(id = rtId()) {
  const out = ui.rt.outgoing?.[id];
  if (!out) return null;
  if(ui.rt.events.some((e)=>e.kind==='message' && e.role==='user' && (out.eventKey?e.key===out.eventKey:e.seq>out.seq))){delete ui.rt.outgoing[id];return null;}
  return out;
}
function rtOutgoingNode() {
  if (ui.rt.trimmedTail) return null;
  const out = rtOutgoing();
  return out ? h("div", { class: "rt-row user rt-outgoing", "data-outgoing": "1" },
    h("div", { class: "rt-bubble user" }, rtText(out.text, rtId()), rtAttachmentHistory(out.images, rtId())),
    h("div", { class: "rt-row-meta" }, h("span", { class: "muted small rt-outgoing-state" }, out.accepted ? "已发送" : "发送中…"))) : null;
}
/**
 * 本轮运行中在时间线末尾显示「思考中」，免得两段回复之间看起来像已经结束。
 * 等待审批有审批卡片、停止中单独提示；停在历史窗口（未追到最新）时不显示。
 */
function rtThinkingNode() {
  if (ui.rt.trimmedTail) return null;
  const s = ui.rt.view?.session;
  if (!s || s.platformSessionId !== rtId()) return null;
  const label = s.status === "creating" ? "正在创建会话" : s.status === "queued" ? "等待运行" : s.status === "running" ? (ui.rt.events.some(e => e.role === "assistant") ? "思考中" : "等待回复") : s.status === "stopping" ? "正在停止" : null;
  if (!label) return null;
  return h("div", { class: "rt-row assistant rt-thinking", "data-thinking": "1", role: "status" },
    h("span", { class: "rt-thinking-dot", "aria-hidden": "true" }),
    h("span", { class: "rt-thinking-label" }, label),
    h("span", { class: "rt-thinking-ellipsis", "aria-hidden": "true" }, h("i"), h("i"), h("i")));
}
/**
 * 部署状态行：请求登记后在消息列表末尾显示真实发布阶段，点击可看进度，结束后改成成功 / 失败。
 * 部署结果通知是部署结束后才发回会话的一条消息；通知已经到达时不再重复显示这条状态。
 */
const RT_DEPLOY_DONE_LABEL = {
  ok: ["部署成功", "ok"], failed: ["部署失败", "bad"], "already-live": ["已在线上", "ok"],
  cancelled: ["部署已取消", "warn"], expired: ["部署超时", "warn"], unknown: ["部署结果", ""]
};
function rtDeployNoticeDone(sha, since, requestId, deployedSha) {
  const short = rtSha(String(sha || ""));
  if (!short) return false;
  const sinceMs = Date.parse(since || "");
  return (ui.rt.events || []).some((e) => {
    const notice = rtDeploymentNotice(e);
    if (!notice) return false;
    const matchesRequest = requestId && notice.requestId === requestId;
    const matchesCommit = [notice.requestSha, rtDeploymentCompact(notice).commit].some(commit => commit && [short, rtSha(deployedSha || "")].filter(Boolean).some(target => commit.toLowerCase().startsWith(target.toLowerCase())));
    const legacyRequest = notice.summary.toLowerCase().includes(`本请求的提交 ${short.toLowerCase()} 已包含在内`);
    if (!matchesRequest && !matchesCommit && !legacyRequest) return false;
    const at = Date.parse(e.occurredAt || "");
    return !Number.isFinite(sinceMs) || !Number.isFinite(at) || at >= sinceMs;
  });
}
/**
 * 部署各阶段统一显示一行「阶段 · 提交号」；进行中的阶段在标题后加本阶段已用时，说明、时间和操作点开查看。
 */
function rtDeployStatusRow({ title, tone, summary, detail, sha, at, key, state, request, timed, totalMs, extra }) {
  const description = detail || summary;
  const iso = at ? String(at).replace(" ", "T") : "";
  const ms = Date.parse(iso);
  const time = Number.isFinite(ms)
    ? h("time", { class: "rt-time", datetime: iso, title: "北京时间（UTC+8）" }, new Date(ms).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, hour: "2-digit", minute: "2-digit" }))
    : null;
  const section = (...children) => h("section", { class: "rt-row rt-system-message rt-deploy-status rt-system-compact", "data-deploy-status": key, "data-deploy-state": state, role: "status", "aria-label": "部署状态" }, ...children);
  // 进行中的部署阶段在标题后带上本阶段已用时（每秒刷新），排队时是「已登记多久」
  const elapsed = timed && Number.isFinite(ms)
    ? h("span", { class: "rt-system-elapsed", "data-rt-deploy-row-start": iso, title: "本阶段已用时" }, rtDeployDuration(Date.now() - ms))
    : null;
  // 部署成功：显示这次部署的总耗时（开始准备 → 上线，扣掉等待会话），不再显示阶段计时
  const total = !elapsed && Number.isFinite(totalMs)
    ? h("span", { class: "rt-system-elapsed", title: RT_DEPLOY_TOTAL_TITLE }, `总耗时${rtDeployDuration(totalMs)}`)
    : null;
  const head = h("span", { class: "rt-system-head" },
    h("span", { class: `rt-system-result ${tone}`.trim() }, title),
    elapsed || total,
    sha ? h("span", { class: "rt-system-commit" }, `· ${sha}`) : null,
    h("span", { class: "rt-system-caret", "aria-hidden": "true" }, "›"));
  // 折叠键跟着请求走：进度轮询重绘时保持用户展开的位置
  return section(rtLazyFold({ class: "rt-system-details" },
    h("summary", { "aria-label": `${title}，展开或收起完整说明`, title: summary }, head),
    () => h("div", {},
      h("div", { class: "rt-system-actions" }, time,
        request ? h("button", { type: "button", class: "btn small", "aria-label": `${rtDeployLabel(request)}，查看部署进度`, onclick: (ev) => { ev.preventDefault(); rtOpenDeployProgress(request, ev.currentTarget); } }, "查看部署进度") : null,
        rtCopyButton(description, "复制", { announce: "已复制部署说明" })),
      h("p", { class: "rt-system-detail" }, description),
      extra ? extra() : null),
    null, `${rtId()}:deploy-status:${key}`));
}
/** 时间线末尾的部署状态行是否在显示（聊天页，且没在翻更早的记录）：部署说明只在它和悬停提示里出现 */
function rtDeployStatusVisible() { return !ui.rt.trimmedTail; }
function rtDeployStatusNode(includeHistory = false) {
  if (!rtDeployStatusVisible()) return null;
  const id = rtId();
  if (!id || ui.rt.view?.session?.platformSessionId !== id) return null;
  const st = ui.rt.deploy && ui.rt.deploy.id === id ? ui.rt.deploy : null;
  const d = st && st.info;
  if (!d) return null;
  const mine = rtDeployMine(d, id);
  const gateTarget = rtDeployGateTarget(id, includeHistory);
  if (mine) {
    // 结果通知已到达、只是排队文件还没被下一次轮询清掉：不要同时显示「部署中」和结果消息
    if (rtDeployNoticeDone(mine.sha, mine.requestedAt, mine.id)) return null;
    const started = !!mine.startedAt;
    const ready = mine.progress?.phase === "ready";
    const what = `${rtSha(mine.sha)}${mine.subject ? `（${mine.subject}）` : ""}`;
    const gate = gateTarget?.kind === "mine" ? gateTarget.verify : null;
    return rtDeployStatusRow({
      extra: gate ? () => rtVerifyGateSection(gate, id) : null,
      // 门禁失败后自动重试的部署：标题上直接带第几次，累计和分段耗时在折叠里
      title: rtDeployLabel(mine) + (d.gateRetry ? ` · 第${d.gateRetry.attempts.length}次重试` : ""),
      sha: rtSha(mine.sha),
      request: mine,
      tone: started && !["idle", "waiting"].includes(mine.progress?.phase) ? "accent" : "warn",
      // 一行就能看完的短语：排队说在等什么，部署中说到哪一步；完整说明在折叠里
      summary: (d.gateRetry ? `自动重试第 ${d.gateRetry.attempts.length} 次 · ` : "") + (started ? (mine.progress?.detail || "正在确认发布阶段") : (mine.wait?.short || "等所有会话停下来")),
      detail: (started
        ? `${rtDeployWaitText(mine)}。点击「查看部署进度」看每一步。`
        : `已登记部署 ${what}${mine.wait?.detail ? `：${mine.wait.detail}` : "：等所有会话停下来后开始"}。结果会更新到这条消息。`) + rtGateRetryTail(d),
      at: mine.progress?.since || mine.startedAt || mine.requestedAt,
      key: `deploy:${mine.id}:${started ? "started" : "pending"}`,
      state: started ? "started" : "pending",
      timed: !mine.ended && !ready,
      totalMs: ready ? rtDeployTotal(mine.progress, mine.timeline || mine.progress?.staging) : undefined,
    });
  }
  const ar = d.autoResolve;
  if (ar && ar.phase !== "queued") {
    const gate = gateTarget?.kind === "autoResolve" ? gateTarget.verify : null;
    return rtDeployStatusRow({
      extra: gate ? () => rtVerifyGateSection(gate, id) : null,
      title: ar.phase === "resolving" ? (ar.stage === "gate" ? `自动修复重试 ${ar.attempts}/${ar.max || 3}` : "解决部署冲突中") : "部署待处理",
      tone: ar.phase === "resolving" ? "accent" : "bad",
      summary: ar.phase === "resolving" ? "这一轮结束后自动重新提交部署" : `自动部署需要你处理：${ar.reason || (ar.conflicts || []).join("、") || "会话没能自动解决冲突"}`,
      detail: ar.phase === "resolving" ? `${rtAutoResolveText(d)}。` : rtAutoResolveText(d),
      at: ar.at,
      key: `deploy:auto:${ar.phase}:${ar.attempts}:${ar.at}`,
      state: ar.phase,
      timed: ar.phase === "resolving",
    });
  }
  const lastState = rtDeployLastState(d, includeHistory);
  if (!lastState) return null;
  const { last, resultMs, historical, next } = lastState;
  const [title, tone] = RT_DEPLOY_DONE_LABEL[last.state] || RT_DEPLOY_DONE_LABEL.unknown;
  const what = `${rtSha(last.sha)}${last.subject ? `（${last.subject}）` : ""}`;
  // 提交号提到标题旁（与自动部署通知同口径），说明只在正文里说事
  const summary = {
    ok: `已上线${historical ? "。" : "，现在跑的就是这一版。"}`,
    "already-live": "已经在线上。",
    failed: `没有部署成功${d.live ? `，线上仍是 ${rtSha(d.live.sha)}` : ""}。`,
    cancelled: "部署请求已取消。",
    expired: "等空闲超时，已放弃。",
  }[last.state] || "部署结果未知。";
  const gate = gateTarget?.kind === "last" ? gateTarget.verify : null;
  const node = rtDeployStatusRow({ title, tone, sha: rtSha(last.deployedSha || last.sha), summary, at: resultMs ? new Date(resultMs).toISOString() : last.at, key: `deploy:${last.sha}:${last.state}:${last.at}`, state: last.state, totalMs: last.durationMs, extra: gate ? () => rtVerifyGateSection(gate, id) : null });
  if (historical) node.dataset.deployBefore = String(next.seq);
  return node;
}
/** 进行中的状态放在末尾，历史结果按时间插回记录之间；事件重绘或部署轮询后重新对齐。 */
function rtPatchDeployStatus(box = document.querySelector(".rt-transcript")) {
  if (!box) return;
  box.querySelector("[data-deploy-status]")?.remove();
  const node = rtDeployStatusNode(true);
  if (!node) return;
  if (node.dataset.deployBefore) {
    const next = [...box.children].find(row => row.hasAttribute("data-ev-seq") && Number(row.dataset.evSeq) >= Number(node.dataset.deployBefore));
    if (next) next.before(node);
    return;
  }
  const tail = box.querySelector(".rt-tail");
  if (tail) tail.before(node); else box.append(node);
  if (ui.rt.atBottom) box.scrollTop = box.scrollHeight;
}
const RT_VERIFY_STEP_ZH = { starting: "启动中", running: "运行中", succeeded: "通过", failed: "失败", timed_out: "超时", cancelled: "已取消", interrupted: "中断" };
function rtVerifyNoticeDone(jobId) {
  if (!jobId) return false;
  return (ui.rt.events || []).some((e) => typeof e.text === "string" && e.text.includes(`[pi-agent 自动验证通知] 任务 ${jobId}`));
}
function rtCurrentVerify(id) {
  const entry = typeof rtDirEntry === "function" ? rtDirEntry(id) : null;
  if (entry && entry.verify) return entry.verify;
  return ui.rt.verify && ui.rt.verify.id === id ? ui.rt.verify.data : null;
}
async function rtCancelVerify(id, jobId, btn) {
  if (!id || !jobId) return;
  if (btn) btn.disabled = true;
  try {
    const r = await api(`/api/runtime-sessions/${encodeURIComponent(id)}/verify/${encodeURIComponent(jobId)}/cancel`, { method: "POST", body: "{}" });
    if (r?.verify) ui.rt.verify = { id, data: r.verify };
    announce(r?.note || "已请求取消验证");
    void rtLoadDir({ background: true });
    rtPatchVerifyStatus();
  } catch (e) {
    announce(`取消验证失败：${e.message}`);
    if (btn) btn.disabled = false;
  }
}
function rtVerifySummary(v) {
  return v.report?.summary
    || (v.workerStale ? "心跳超过 30 秒未更新，验证服务可能已停止。" : "")
    || (v.active && v.cancelRequested ? "已发送取消请求，正在清理步骤进程…" : "")
    || v.stateReason
    || (v.currentStep ? `正在执行步骤：${v.currentStep}` : (v.state === "created" || v.state === "queued" ? "已加入验证队列，等待执行…" : "等待结果…"));
}
/** 验证详情正文：独立验证行和并入部署行的「部署门禁」小节共用；merged 时时间与复制交给外层部署行 */
function rtVerifyDetailBody(v, id, time, merged = false) {
  const summary = rtVerifySummary(v);
  const staleNote = v.report?.stale ? "注意：代码在验证期间又改过，此结果不能证明当前版本通过。" : "";
  const copyText = [`${rtVerifyMeta(v).label}（${v.profile} · ${v.jobId}）`, summary, staleNote].filter(Boolean).join("\n");
  const canControl = !!ui.rt.access?.control;
  return h("div", {},
    h("div", { class: "rt-system-actions" },
      merged ? null : time,
      h("span", { class: "muted small rt-verify-jobid" }, v.jobId),
      v.active && !v.cancelRequested && canControl
        ? h("button", { type: "button", class: "btn small", onclick: (ev) => { ev.preventDefault(); void rtCancelVerify(id, v.jobId, ev.currentTarget); } }, "取消验证")
        : null,
      merged ? null : rtCopyButton(copyText, "复制", { announce: "已复制验证摘要" })),
    h("p", { class: "rt-system-detail" }, summary),
    staleNote ? h("p", { class: "rt-system-detail muted small" }, staleNote) : null,
    v.steps?.length ? h("ul", { class: "rt-verify-steps" }, ...v.steps.map((s) =>
      h("li", { class: "rt-verify-step" },
        h("span", { class: "rt-verify-step-name" }, s.name),
        h("span", { class: `rt-verify-step-state ${s.state === "succeeded" ? "ok" : ["failed", "timed_out"].includes(s.state) ? "bad" : ""}`.trim() },
          `${RT_VERIFY_STEP_ZH[s.state] || s.state}${s.exitCode != null && s.exitCode !== 0 ? `（退出码 ${s.exitCode}）` : ""}`)))) : null,
    v.report?.locations?.length ? h("ul", { class: "rt-verify-locs" }, ...v.report.locations.slice(0, 3).map((l) =>
      h("li", { class: "rt-verify-loc" }, `${l.file}:${l.line}${l.code ? ` ${l.code}` : ""}`))) : null);
}
/** 解析时间戳（兼容 "YYYY-MM-DD HH:MM:SS" 与 ISO 字符串），无效返回 NaN。 */
function rtParseMs(at) {
  if (typeof at === "number") return Number.isFinite(at) ? at : NaN;
  if (!at) return NaN;
  return Date.parse(String(at).replace(" ", "T"));
}
/** 验证任务是否不晚于对应部署结果（允许 60 秒落盘/时钟偏差），避免旧部署结果误吞更新的门禁。 */
function rtVerifyMatchesDeployAt(v, deployMs) {
  if (!Number.isFinite(deployMs) || deployMs <= 0) return true;
  const verifyMs = rtParseMs(v.endedAt || v.startedAt || v.createdAt);
  return !Number.isFinite(verifyMs) || verifyMs <= deployMs + 60_000;
}
/** 计算 d.last 部署结果状态行是否应在当前时间线渲染及其定位信息。 */
function rtDeployLastState(d, includeHistory = true) {
  const last = d?.last;
  if (!last?.sha || rtDeployNoticeDone(last.sha, last.atMs ? new Date(last.atMs).toISOString() : last.at, last.requestId, last.deployedSha)) return null;
  // 工具/推理事件可能没有 occurredAt；不能仅看数组末项。
  const resultMs = Number(last.atMs) || rtParseMs(last.at) || 0;
  const timed = (ui.rt.events || []).map(e => ({ e, ms: Date.parse(e.occurredAt || "") })).filter(x => Number.isFinite(x.ms));
  const eventMs = Math.max(0, ...timed.map(x => x.ms));
  const session = ui.rt.view?.session;
  const turn = session?.turns?.at(-1) || session?.latestTurn;
  const turnMs = Date.parse(turn?.startedAt || turn?.queuedAt || "") || 0;
  const historical = resultMs && resultMs < Math.max(eventMs, turnMs);
  const next = historical ? timed.find(x => x.ms > resultMs)?.e : null;
  // 仅在加载窗口覆盖结果时间时补历史状态；已有真实通知时由上面的去重逻辑保留原位。
  if (historical && (!includeHistory || !next || !timed.some(x => x.ms <= resultMs))) return null;
  return { last, resultMs, historical, next };
}
/**
 * 决定当前会话的 deploy-gate 验证应并入哪一条部署记录（进行中 / 自动修复 / 部署成功或失败状态行 / 真实自动部署通知），
 * 不再在部署进行中或结束后拆成「验证」和「部署」两条并列系统消息。
 */
function rtDeployGateTarget(id, includeHistory = true) {
  const v = rtCurrentVerify(id);
  if (!v || v.profile !== "deploy-gate") return null;
  const d = ui.rt.deploy && ui.rt.deploy.id === id ? ui.rt.deploy.info : null;
  const mine = d && rtDeployMine(d, id);
  if (mine && !rtDeployNoticeDone(mine.sha, mine.requestedAt, mine.id)) {
    if (!mine.ended || !v.active) return { kind: "mine", verify: v };
    return null;
  }
  const ar = d?.autoResolve;
  if (ar && ar.phase !== "queued") {
    return !v.active ? { kind: "autoResolve", verify: v } : null;
  }
  if (!v.active && d?.last?.sha) {
    const lastState = rtDeployLastState(d, includeHistory);
    if (lastState) {
      return rtVerifyMatchesDeployAt(v, lastState.resultMs) ? { kind: "last", verify: v } : null;
    }
    const lastDone = rtDeployNoticeDone(d.last.sha, d.last.atMs ? new Date(d.last.atMs).toISOString() : d.last.at, d.last.requestId, d.last.deployedSha);
    const lastMs = Number(d.last.atMs) || rtParseMs(d.last.at) || 0;
    if (!lastDone && rtVerifyMatchesDeployAt(v, lastMs)) return { kind: "suppressed", verify: v };
  }
  if (!v.active) {
    const events = ui.rt.events || [];
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (!rtDeploymentNotice(ev)) continue;
      return rtVerifyMatchesDeployAt(v, rtParseMs(ev.occurredAt)) ? { kind: "notice", eventKey: ev.key, verify: v } : null;
    }
  }
  return null;
}
function rtDeployGateVerify(id, mine) {
  if (!mine || mine.ended) return null;
  const v = rtCurrentVerify(id);
  return v && v.profile === "deploy-gate" ? v : null;
}
function rtVerifyGateSection(v, id) {
  const m = rtVerifyMeta(v);
  return h("div", { class: "rt-deploy-gate", "data-deploy-gate-verify": v.state },
    h("p", { class: "rt-system-detail muted small" }, `部署门禁 · ${m.label}`),
    rtVerifyDetailBody(v, id, null, true));
}
/** 时间线里的「自动部署通知」折叠展开时附带对应的已结束 deploy-gate 详情。 */
function rtDeployNoticeGateSection(e, sid) {
  const target = rtDeployGateTarget(sid);
  return target && target.kind === "notice" && target.eventKey === e.key ? rtVerifyGateSection(target.verify, sid) : null;
}
/** 验证数据异步到达或更新时，同步刷新已展开的「自动部署通知」里的门禁小节。 */
function rtPatchDeployNoticeGate(box, id, target) {
  for (const old of box.querySelectorAll(".rt-deployment-notice .rt-deploy-gate")) old.remove();
  if (!target || target.kind !== "notice") return;
  const row = [...box.querySelectorAll(".rt-deployment-notice")].find((n) => n.dataset.evKey === target.eventKey);
  const details = row?.querySelector("details.rt-system-details");
  if (!details?.open) return;
  const body = [...details.children].find((el) => el.tagName !== "SUMMARY");
  if (!body) return;
  const gateNode = rtVerifyGateSection(target.verify, id);
  const flags = body.querySelector(":scope > .rt-row-flags");
  if (flags) flags.before(gateNode); else body.append(gateNode);
}
/** 会话详情时间线末尾的验证状态行：完全复用部署状态行的单行折叠样式。 */
function rtVerifyStatusRow(v) {
  const m = rtVerifyMeta(v);
  if (!m) return null;
  const id = rtId();
  const iso = String(v.startedAt || v.createdAt || "").replace(" ", "T");
  const ms = Date.parse(iso);
  const time = Number.isFinite(ms)
    ? h("time", { class: "rt-time", datetime: iso, title: "北京时间（UTC+8）" }, new Date(ms).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, hour: "2-digit", minute: "2-digit" }))
    : null;
  const elapsed = m.active && Number.isFinite(ms)
    ? h("span", { class: "rt-system-elapsed", "data-rt-deploy-row-start": iso, title: "本次验证已用时" }, rtDeployDuration(Date.now() - ms))
    : null;
  const total = !elapsed && Number.isFinite(v.totalMs)
    ? h("span", { class: "rt-system-elapsed", title: "本次验证总耗时" }, `总耗时${rtDeployDuration(v.totalMs)}`)
    : null;
  const head = h("span", { class: "rt-system-head" },
    h("span", { class: `rt-system-result ${m.tone}`.trim() }, m.label),
    elapsed || total,
    h("span", { class: "rt-system-commit" }, `· ${v.profile}`),
    h("span", { class: "rt-system-caret", "aria-hidden": "true" }, "›"));
  const key = `verify:${v.jobId}:${v.active ? "active" : v.state}`;
  return h("section", {
    class: "rt-row rt-system-message rt-deploy-status rt-verify-status rt-system-compact",
    "data-verify-status": key, "data-verify-state": v.state, role: "status", "aria-label": "验证状态"
  }, rtLazyFold({ class: "rt-system-details" },
    h("summary", { "aria-label": `${m.label}，展开或收起验证详情`, title: rtVerifySummary(v) }, head),
    () => rtVerifyDetailBody(v, id, time),
    null, `${id}:verify-status:${v.jobId}`));
}
/** 门禁验证已归属到部署状态行或部署通知，不再单独成行。 */
function rtDeployGateMerged(id) {
  return !!rtDeployGateTarget(id);
}
function rtVerifyStatusNode() {
  if (!rtDeployStatusVisible()) return null;
  const id = rtId();
  if (!id || ui.rt.view?.session?.platformSessionId !== id) return null;
  const v = rtCurrentVerify(id);
  if (!v) return null;
  if (!v.active && v.profile === "deploy-gate") return null;
  if (!v.active && rtVerifyNoticeDone(v.jobId)) return null;
  if (rtDeployGateMerged(id)) return null;
  return rtVerifyStatusRow(v);
}
function rtPatchVerifyStatus(box = document.querySelector(".rt-transcript")) {
  if (!box) return;
  box.querySelector("[data-verify-status]")?.remove();
  const id = rtId();
  const target = rtDeployGateTarget(id);
  // 门禁验证并在部署状态行里：验证数据变了要重绘部署行；若原本并入、现在切回独立验证，也同步清理残留门禁小节
  if ((target && ["mine", "autoResolve", "last"].includes(target.kind)) || box.querySelector("[data-deploy-status] .rt-deploy-gate")) {
    rtPatchDeployStatus(box);
  }
  rtPatchDeployNoticeGate(box, id, target);
  const node = rtVerifyStatusNode();
  if (!node) return;
  const anchor = box.querySelector("[data-deploy-status]:not([data-deploy-before])") || box.querySelector(".rt-tail");
  if (anchor) anchor.before(node); else box.append(node);
  if (ui.rt.atBottom) box.scrollTop = box.scrollHeight;
}
/** 把占位气泡、「思考中」与部署状态维持在时间线末尾（真实行之前）：真实消息到达或发送失败后由 rtOutgoing 自动消失 */
function rtPatchOutgoing() {
  const box = document.querySelector(".rt-transcript");
  if (!box) return;
  box.querySelectorAll("[data-outgoing], [data-thinking]").forEach((n) => n.remove());
  const nodes = [rtOutgoingNode(), rtThinkingNode()].filter(Boolean);
  // 状态行先占住末尾之前的位置；占位气泡与「思考中」紧贴状态行，不插到它后面
  const anchor = box.querySelector("[data-verify-status], [data-deploy-status]:not([data-deploy-before])") || box.querySelector(".rt-tail");
  for (const node of nodes) { if (anchor) anchor.before(node); else box.append(node); }
  rtPatchDeployStatus(box);
  rtPatchVerifyStatus(box);
  if (ui.rt.atBottom) box.scrollTop = box.scrollHeight;
}

function rtTranscript(v) {
  const events = ui.rt.events;
  const edge = rtOriginEdge(rtOriginForDisplay(v?.session?.platformSessionId));
  const box = h("div", {
    class: "rt-transcript", role: "log", "aria-live": "off", "aria-label": "对话与工具记录", "data-keep-scroll": `rt-tx-${rtId()}`, tabindex: "0",
    onscroll: (ev) => {
      const el = ev.target;
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      // 还有更新的没加载时，停在已加载内容的底部不算「贴底跟随」
      const at = gap < 40 && !ui.rt.trimmedTail;
      ui.rt.reading = sessionReadingCapture(el, at);
      if (at !== ui.rt.atBottom) { ui.rt.atBottom = at; if (at) { ui.rt.newCount = 0; rtRenderNavStatus(); } }
      rtPatchNewCount();
      if (el.rtNavigating) return;
      // 接近顶部就自动续读更早的记录（不需要先顶到最上面再人手下拉）；提前量比旧版更大，滚到顶前就备好
      const scrollable = el.scrollHeight > el.clientHeight + 160;
      if (scrollable && el.scrollTop < rtEarlierPrefetchGap(el) && ui.rt.hasMoreBefore && !ui.rt.loadingEarlier && !ui.rt.earlierError) void rtLoadEarlier();
      // 上拉到已加载消息的底部时继续把更新的记录补进来。内容略高于视口（不足 160px 溢出）时
      // 旧条件会漏掉续读、让「跳到最新」入口一直挂着；只要确有溢出且未在翻页就补读，
      // loadingNewer/loadingEarlier 与 hasMoreAfter 共同兜住重复翻页。
      if (ui.rt.trimmedTail && gap < 160 && el.scrollHeight > el.clientHeight + 1 && !ui.rt.loadingNewer && !ui.rt.loadingEarlier) void rtLoadNewer();
    }
  },
  ui.rt.hasMoreBefore ? rtEarlierButton(`加载更早的记录（共 ${ui.rt.total} 条）`) : null,
  ui.rt.notes.length ? h("p", { class: "muted small" }, ui.rt.notes.join("；")) : null,
  !events.length && !rtOutgoing() ? h("p", { class: "muted rt-empty" }, v.session.sourceMode === "platform-managed" && v.session.status === "creating" ? "提交中：等待 runtime 创建会话…" : "还没有记录") : null,
  rtBlocks(events).map((b) => rtBlockNode(b)),
  rtOutgoingNode(),
  rtThinkingNode(),
  h("div", { class: "rt-tail" }));
  rtPatchDeployStatus(box);
  rtPatchVerifyStatus(box);
  // 手机下拉／PC 向上滚：在消息区顶端加载更早的记录，别让浏览器整页刷新
  sessionPullEarlier(box, { hasMore: () => !!ui.rt.hasMoreBefore, onLoad: () => rtLoadEarlier({ manual: true }) });
  // 首次渲染：跟随底部
  const reading = ui.rt.reading;
  requestAnimationFrame(() => {
    if (!box.isConnected) return;
    sessionReadingWatch(box, reading || sessionReadingCapture(box, ui.rt.atBottom));
    rtFillNewerIfShort();
    rtFillEarlierIfShort();
    // 贴底但窗口尾部还被裁着：入口已隐藏，这里主动续读，别让用户卡在「看着最新、其实还没加载」的窗口上。
    if (ui.rt.trimmedTail && !ui.rt.loadingNewer && !ui.rt.loadingEarlier && rtTranscriptAtBottom(box)) void rtLoadNewer();
  });
  return h("div", { class: `rt-tx-wrap${edge ? " has-origin-tab" : ""}` }, box, edge, rtMessageNavigator(box),
    h("button", { id: "rt-newcount", type: "button", class: "btn small rt-newcount", hidden: !rtShowJumpLatest(box), onclick: () => void rtJumpLatest() }, ui.rt.newCount > 0 ? `${ui.rt.newCount} 条新内容 ↓` : "跳到最新 ↓"));
}

function rtApprovals(v) {
  const pending = (v.approvals || []).filter((a) => a.state === "pending");
  const gate = rtApprovalGate(ui.rt.access, ui.rt.statusConfirmed, ui.rt.syncError || ui.rt.viewSyncError);
  // 会话级授权撤销已在标题标签行的提示数字里（rtNoticeTag）；这里只留需要处理的审批卡片。
  if (!pending.length) return h("div", { class: "rt-approvals" });
  // 卡片可能来自本机缓存或上次读取：先显示，同时立刻插队核对一次最新状态，核对完按钮才能点
  if (gate.confirming) rtApprovalConfirmSoon();
  return h("div", { class: "rt-approvals", role: "region", "aria-label": "权限请求" }, pending.map((a) => a.kind === "question"
    ? rtQuestionCard(a, { gate, busy: ui.rt.busy, onSubmit: (answers) => rtDecide(a, true, undefined, answers), onSkip: () => rtDecide(a, false) })
    : h("div", { class: "rt-approval" },
    h("div", { class: "rt-approval-head" }, h("strong", {}, `权限请求 · ${a.title}`), h("span", { class: "muted small", "data-countdown": a.expiresAt }, minutesLeft(a.expiresAt))),
    h("dl", { class: "kv rt-approval-body" },
      h("dt", {}, "动作"), h("dd", {}, h("pre", { class: "rt-code" }, h("code", {}, a.action))),
      h("dt", {}, "范围"), h("dd", {}, a.scope || "—", a.runtimeSessionScope ? h("p", {class:"muted small"}, a.runtimeSessionScope) : null),
      h("dt", {}, "来源"), h("dd", {}, `${a.source} · 第 ${a.turnNo} 轮 · 请求 ${a.nativeRequestId}`)),
    rtApprovalActionRow(gate, "当前入口没有控制权限，不能处理审批", (waiting) => [
      h("button", { type: "button", class: "btn", disabled: !!ui.rt.busy || waiting, onclick: () => rtDecide(a, false) }, "拒绝"),
      h("button", { type: "button", class: "btn primary", disabled: !!ui.rt.busy || waiting, onclick: () => rtDecide(a, true) }, a.runtimeSessionScope ? "本次" : "批准本次"),
      a.runtimeSessionScope ? h("button", { type:"button", class:"btn", disabled:!!ui.rt.busy || waiting, title:a.runtimeSessionScope, onclick:()=>rtDecide(a,true,"session") }, "本会话") : a.requiresExplicitApproval ? null : h("button", { type: "button", class: "btn", disabled: !!ui.rt.busy || waiting, title: "批准这一项，并让本会话之后的审批都自动批准（可随时撤销）", onclick: () => rtDecide(a, true, "session") }, "本会话全部批准")]))));
}

function rtRuntimeGrantNotice() {
  const state=ui.rt.runtimeGrants?.id===rtId()?ui.rt.runtimeGrants:null;
  const canAct=ui.rt.access?.control&&ui.rt.statusConfirmed!==false;
  return h("section",{class:"rt-notice-item", "aria-label":"Pi runtime 授权"},
    h("p",{class:"rt-notice-item-text"},"Pi runtime 会话授权；撤销后，下次相同操作重新询问。已开始的执行不受影响。"),
    state?.error ? h("p",{class:"field-error",role:"alert"},state.error) : null,
    !state?.data ? h("p",{class:"muted small"},state?.loading?"正在读取授权…":"尚未读取授权") :
    !state.data.grants.length ? h("p",{class:"muted small"},"没有已保存的会话授权") :
    h("div",{class:"rt-runtime-grants-list"},...state.data.grants.map(g=>h("div",{class:"rt-runtime-grant"},
      h("strong",{},g.tool === "unknown" ? "历史精确授权" : g.tool),
      h("details",{open:state.expanded?.includes(g.id),ontoggle:ev=>{if(!ev.currentTarget.isConnected)return;state.expanded=(state.expanded||[]).filter(id=>id!==g.id);if(ev.currentTarget.open)state.expanded.push(g.id);}},h("summary",{},"动作与范围"),h("pre",{class:"rt-code"},g.action),h("p",{},g.scope||"历史授权未保存显示范围"),g.grantedAt?h("p",{class:"muted small"},new Date(g.grantedAt).toLocaleString()):null),
      canAct?h("button",{type:"button",class:"btn small",disabled:!!state.busy||!!state.loading,onclick:()=>rtRevokeRuntimeGrant(g.id)},"撤销此授权"):null))));
}
async function rtLoadRuntimeGrants() {
  const id=rtId(),gen=ui.rt.gen;
  const previous=ui.rt.runtimeGrants?.id===id?ui.rt.runtimeGrants:null;
  if(previous?.busy||previous?.loading)return;
  const state=ui.rt.runtimeGrants={id,loading:true,data:previous?.data||null,error:"",scroll:previous?.scroll||0,expanded:previous?.expanded||[]};rtRenderSoft();
  try { const data=await api(`/api/runtime-sessions/${id}/permission-grants`);if(id===rtId()&&gen===ui.rt.gen&&ui.rt.runtimeGrants===state)state.data=data; }
  catch(e){if(id===rtId()&&gen===ui.rt.gen&&ui.rt.runtimeGrants===state)state.error=e.message;}
  finally{if(id===rtId()&&gen===ui.rt.gen&&ui.rt.runtimeGrants===state){state.loading=false;rtRenderSoft();}}
}
async function rtRevokeRuntimeGrant(grantId) {
  if(!ui.rt.access?.control||ui.rt.statusConfirmed===false)return;
  const id=rtId(),gen=ui.rt.gen,state=ui.rt.runtimeGrants;
  if(!state||state.id!==id||state.busy||state.loading)return;
  state.busy=grantId||"all";state.error="";rtRenderSoft();
  try{
    const data=await api(`/api/runtime-sessions/${id}/permission-grants/revoke`,{method:"POST",body:JSON.stringify(grantId?{id:grantId}:{})});
    if(id===rtId()&&gen===ui.rt.gen&&ui.rt.runtimeGrants===state){state.data=data;announce(grantId?"已撤销此授权，下次执行重新询问":"已撤销全部 runtime 授权，下次执行重新询问");}
  }catch(e){if(id===rtId()&&gen===ui.rt.gen&&ui.rt.runtimeGrants===state)state.error=e.message;}
  finally{if(id===rtId()&&gen===ui.rt.gen&&ui.rt.runtimeGrants===state){state.busy="";rtRenderSoft();}}
}

async function rtRevokeGrant() {
  if (ui.rt.statusConfirmed === false) return;
  ui.rt.busy = "approval"; ui.rt.error = ""; rtRenderSoft();
  try { await api(`/api/runtime-sessions/${rtId()}/approval-grant/revoke`, { method: "POST", body: "{}" }); announce("已撤销本会话全部授权"); }
  catch (e) { ui.rt.error = e.message; announce(`撤销失败：${e.message}`); }
  ui.rt.busy = "";
  await rtLoadView(rtId(), ui.rt.gen); rtRenderSoft();
}

async function rtDecide(a, approve, scope, answers) {
  if (ui.rt.statusConfirmed === false) return;
  const asking = a.kind === "question";
  ui.rt.busy = "approval"; ui.rt.error = ""; rtRenderSoft();
  try { await api(`/api/runtime-sessions/${rtId()}/approvals/${a.approvalId}`, { method: "POST", body: JSON.stringify({ approve, paramsDigest: a.paramsDigest, turnNo: a.turnNo, ...(scope ? { scope } : {}), ...(answers ? { answers } : {}) }) }); if (asking) rtQuestionDrafts.delete(a.approvalId); announce(asking ? (approve ? "已回答" : "已跳过") : scope === "session" ? (a.runtimeSessionScope ? "已授权本会话内相同动作与范围" : "已批准，本会话之后的审批自动批准") : approve ? "已批准本次" : "已拒绝"); }
  catch (e) { ui.rt.error = e.message; announce(`${asking ? "回答" : "审批"}失败：${e.message}`); }
  ui.rt.busy = "";
  await rtLoadView(rtId(), ui.rt.gen); rtRenderSoft();
}

/** 输入区只放一眼能懂的短名，完整说明在展开的选项里 */
const RT_COMPOSE_PERMISSION_SHORT = { "ask": "需审批", "auto-review": "代审批", "full-access": "完全访问", "read-only": "只读", "default": "默认审批", "acceptEdits": "自动编辑", "plan": "计划", "bypassPermissions": "完全访问", "pi-read-only": "只读", "pi-ask": "工作区沙盒", "pi-native": "原生权限" };
function rtComposePermissionBrief(v) {
  const s = v.session, options = v.permissionOptions || [];
  const selected = s.pendingPermissionMode || s.permissionMode;
  const current = options.find(p => p.id === selected);
  const label = current?.label || s.permissionLabel || selected || "权限";
  return { selected, options, label, brief: RT_COMPOSE_PERMISSION_SHORT[selected] || label };
}
/** 权限由原流程固定 / 当前入口没有控制权 / 正在忙时，两个入口都不该让人以为能改 */
function rtComposePermissionLocked(v) {
  const s = v.session, options = v.permissionOptions || [];
  return s.sourceMode !== "platform-managed" || !ui.rt.access?.control || v.readOnly || s.archived || s.conflict || ["unknown", "disconnected"].includes(s.status) || options.length < 2 || ui.rt.statusConfirmed === false || !!ui.rt.busy || !!rtImageDraft(s.platformSessionId).pending;
}
/** 选项面板贴在按钮上方、宽度不出窗口；手机软键盘弹起时也够得着 */
function rtPositionComposeMenu(menu, button) {
  const rect = button.getBoundingClientRect();
  const width = Math.min(320, window.innerWidth - 24);
  menu.style.width = `${width}px`;
  menu.style.left = `${Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))}px`;
  menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  menu.style.maxHeight = `${Math.max(80, rect.top - 18)}px`;
}
function rtWireComposeMenu(menu, button) {
  menu.addEventListener("beforetoggle", ev => { if (ev.newState === "open") rtPositionComposeMenu(menu, button); });
  menu.addEventListener("toggle", ev => {
    button.setAttribute("aria-expanded", String(ev.newState === "open"));
    if (ev.newState === "open") menu.querySelector('[aria-pressed="true"]')?.focus();
  });
  menu.addEventListener("keydown", ev => {
    if (ev.key === "Escape") { ev.preventDefault(); menu.hidePopover(); button.focus(); }
  });
}
/** 选中权限模式：保存后重载视图（桌面按钮与手机合并入口共用）；view 用可更新的引用，避免软重绘后拿到旧版本号 */
async function rtSetComposePermission(state, option, focusKey) {
  const s = state.view.session, id = s.platformSessionId;
  if (option.id === (s.pendingPermissionMode || s.permissionMode)) return;
  const gen = ui.rt.gen;
  ui.rt.busy = "permission"; ui.rt.error = ""; rtRenderSoft();
  try {
    const result = await api(`/api/runtime-sessions/${id}/permission-mode`, { method: "POST", body: JSON.stringify({ permissionMode: option.id, expectedRevision: s.bindingRevision }) });
    if (rtReadCurrent(id, gen)) {
      ui.rt.view = { ...ui.rt.view, session: result.session };
      announce(result.session.pendingPermissionMode ? "权限已保存，下一轮生效" : "会话权限已保存");
    }
  } catch (e) { if (rtReadCurrent(id, gen)) ui.rt.error = e.message; }
  if (rtReadCurrent(id, gen)) {
    ui.rt.busy = "";
    await rtLoadView(id, gen); rtRenderSoft();
    document.querySelector(`[data-key="${focusKey}"]`)?.focus();
  }
}
/** 权限模式选项：手机合并面板里权限被锁时也要如实说明，所以可以整体置灰而不是藏起来 */
function rtComposePermissionChoices(state, { close, focusKey, disabled }) {
  const { selected, options } = rtComposePermissionBrief(state.view);
  return options.map(option => h("button", { type: "button", "aria-label": option.label, "aria-pressed": String(option.id === selected), disabled: !!disabled,
    onclick: async () => { close(); await rtSetComposePermission(state, option, focusKey); } },
    h("span", {}, option.label), h("small", { class: "muted" }, option.detail)));
}
function rtComposePermission(v) {
  const state = { view: v };
  const s = v.session, id = s.platformSessionId, options = v.permissionOptions || [];
  const { selected, label, brief } = rtComposePermissionBrief(v);
  const disabled = rtComposePermissionLocked(v);
  const button = h("button", { type: "button", class: "btn small rt-permission-button", "data-key": `rt-permission-${id}`, disabled: !!disabled,
    "aria-label": `权限模式：${label}${s.pendingPermissionMode ? "，下一轮生效" : ""}`, "aria-expanded": "false", "aria-haspopup": "dialog", popovertarget: "rt-permission-menu",
    title: `${label}${s.pendingPermissionMode ? " · 下一轮生效" : ""}${options.length < 2 ? "（此会话权限由原流程固定）" : ""}` },
    // 一枚小盾牌，模式靠颜色区分，没有下拉箭头；模式名与「下一轮生效」留给读屏和悬停提示
    rtPermissionGlyph(selected, "rt-permission-icon", 16),
    h("span", { class: "rt-permission-value sr-only" }, brief), s.pendingPermissionMode ? h("small", { class: "sr-only" }, "下一轮生效") : null);
  if (s.pendingPermissionMode) button.classList.add("pending");
  const menu = h("div", { id: "rt-permission-menu", class: "rt-permission-menu", popover: "auto", role: "dialog", "aria-label": "选择权限模式" },
    h("p", { class: "muted small" }, "权限模式 · 修改后用于下一轮"),
    rtComposePermissionChoices(state, { close: () => { menu.hidePopover(); button.focus(); }, focusKey: `rt-permission-${id}` }));
  rtWireComposeMenu(menu, button);
  const control = h("span", { class: "rt-permission-control", "data-compose-menu": "permission", "data-state": JSON.stringify([id, selected, label, !!disabled, options]) }, button, menu);
  control.rtPermissionState = state;
  return control;
}
/**
 * 手机：推理强度和权限模式合成一个入口，展开面板里一起改（桌面还是两个并排的内联控件）。
 * 强度是这条消息发送时生效，选完留在面板里可以直接接着改权限；权限保存后按服务端结果重载。
 */
function rtComposeOptions(v, withEffort = true) {
  const state = { view: v };
  const s = v.session, id = s.platformSessionId;
  const { selected, label, brief, options } = rtComposePermissionBrief(v);
  const effort = withEffort && v.effortOptions && v.effortOptions.efforts?.length ? v.effortOptions : null;
  const chosen = ui.rt.turnEffort[id] ?? (s.requestedEffort || "");
  // 和桌面紧凑下拉同一套短名：极高带「自动分派」，默认项写清模型默认值
  const shortEffort = (e) => e === "ultra" ? "极高·自动分派" : (RT_EFFORT[e] || e).split("（")[0];
  const defaultEffort = effort ? (effort.defaultEffort === "ultra" ? "默认·极高·分派" : `默认${effort.defaultEffort ? ` · ${shortEffort(effort.defaultEffort)}` : ""}`) : "";
  const locked = rtComposePermissionLocked(v);
  const disabled = !!ui.rt.busy || !!rtImageDraft(id).pending || (!effort && locked);
  const permBrief = options.length ? brief : null;
  const summaryText = (effortText) => [effort ? effortText : null, permBrief].filter(Boolean).join(" · ");
  // 默认项显示模型默认档位的文字（「默认 · 中」整句留给读屏）；模型没给默认档位时写「默认」
  const levelWord = (e) => e === "ultra" ? "极高" : shortEffort(e);
  const levelText = (value) => levelWord(value || effort?.defaultEffort || "") || "默认";
  const levelEl = effort ? h("span", { class: "rt-compose-options-level", "aria-hidden": "true" }, levelText(chosen)) : null;
  const summaryEl = h("span", { class: "rt-compose-options-summary sr-only" }, summaryText(chosen ? shortEffort(chosen) : defaultEffort));
  const ariaLabel = (effortLabel) => ["本轮选项", effort ? `推理强度 ${effortLabel}` : null, options.length ? `权限模式 ${label}${s.pendingPermissionMode ? "（下一轮生效）" : ""}` : null].filter(Boolean).join("，");
  const button = h("button", { type: "button", class: `btn small rt-compose-options-button${s.pendingPermissionMode ? " pending" : ""}`, "data-key": `rt-turn-options-${id}`, disabled,
    "aria-label": ariaLabel(chosen ? RT_EFFORT[chosen] || chosen : defaultEffort), "aria-expanded": "false", "aria-haspopup": "dialog", popovertarget: "rt-turn-options-menu" },
    effort ? h("span", { class: "rt-compose-options-seg rt-compose-options-effort" }, levelEl) : null,
    options.length ? h("span", { class: `rt-compose-options-seg rt-compose-options-perm${s.pendingPermissionMode ? " pending-dot" : ""}` }, rtPermissionGlyph(selected, "rt-perm-glyph", 16)) : null,
    summaryEl, s.pendingPermissionMode ? h("small", { class: "sr-only" }, "下一轮生效") : null);
  const effortButtons = effort ? [["", defaultEffort], ...effort.efforts.map(e => [e, shortEffort(e)])].map(([value, text]) => {
    const choice = h("button", { type: "button", "aria-label": `推理强度 ${text}`, "aria-pressed": String(chosen === value), "data-key": `rt-turn-effort-${id}-${value || "default"}`,
      onclick: () => {
        ui.rt.turnEffort[id] = value;
        for (const other of effortButtons) other.setAttribute("aria-pressed", String(other === choice));
        summaryEl.textContent = summaryText(text);
        levelEl.textContent = levelText(value);
        button.setAttribute("aria-label", ariaLabel(value ? RT_EFFORT[value] || value : defaultEffort));
      } }, h("span", {}, text));
    return choice;
  }) : null;
  const groups = [];
  if (effort) {
    groups.push(h("p", { class: "muted small" }, "推理强度 · 发送时生效"),
      h("div", { class: "rt-turn-options-group rt-turn-options-effort", role: "group", "aria-label": "推理强度" }, effortButtons));
  }
  // 没有可选项（历史/只读会话）时整段权限不出现，别留一个点不开的空区块
  if (options.length) {
    groups.push(h("p", { class: "muted small" }, locked ? "权限模式 · 此会话权限由原流程固定" : "权限模式 · 修改后用于下一轮"),
      h("div", { class: "rt-turn-options-group", role: "group", "aria-label": "权限模式" },
        rtComposePermissionChoices(state, { close: () => { menu.hidePopover(); button.focus(); }, focusKey: `rt-turn-options-${id}`, disabled: locked })));
  }
  const menu = h("div", { id: "rt-turn-options-menu", class: "rt-permission-menu rt-turn-options", popover: "auto", role: "dialog", "aria-label": "本轮选项" }, groups);
  rtWireComposeMenu(menu, button);
  const control = h("span", { class: "rt-compose-options", "data-compose-menu": "options", "data-state": JSON.stringify([id, selected, label, locked, options]) }, button, menu);
  control.rtPermissionState = state;
  return control;
}

async function rtInterruptSession(id) {
    if (ui.rt.statusConfirmed === false) return;
    ui.rt.busy = "stop"; ui.rt.error = ""; rtRenderSoft();
    try { const r = await api(`/api/runtime-sessions/${id}/interrupt`, { method: "POST", body: "{}" }); announce(r.message); ui.rt.flash = r.noop ? r.message : ""; }
    catch (e) { ui.rt.error = e.message; }
    ui.rt.busy = "";
    await rtLoadView(id, ui.rt.gen); rtRenderSoft();
}

function rtComposer(v, recoveryText, directOpts) {
  const s = v.session;
  const id = s.platformSessionId;
  const a = ui.rt.access;
  const running = ["creating", "running", "waiting-input", "stopping"].includes(s.status) || (s.turns || []).some((t) => t.status === "queued");
  let blocked = "";
  if (s.sourceMode !== "platform-managed") blocked = "只读历史：不能续聊";
  else if (!a || !a.control) blocked = "当前入口没有控制权限";
  // 归档优先于 worktree 已删除：归档页先说明怎么恢复，恢复后才会看到 worktree 的提示
  else if (s.archived) blocked = "会话已归档，请先恢复";
  else if (s.worktree && s.worktree.removedAt) blocked = "worktree 已在归档时删除，请新建会话继续工作";
  else if (s.conflict) blocked = "检测到外部写入：平台写入已暂停";
  else if (!s.nativeSessionId && s.status !== "creating" && !(s.status === "idle" && !s.turns?.length)) blocked = "原生会话没有创建成功，不能续聊";

  // 排队消息：普通单聊在本轮运行中（或队列还在自动发送）时，发送改为加入排队，正常结束后按顺序逐条发出
  const outbox = s.outbox || [];
  rtOutboxEditVanished(id, outbox);
  const canQueue = !blocked && !a?.draining && rtOutboxAllowed(s) && !!(a && a.control);
  const queueMode = (!blocked && !!a?.draining && rtOutboxAllowed(s)) || (canQueue && (running || (outbox.some(m => !m.scheduledFor || Date.parse(m.scheduledFor) <= Date.now()) && !s.outboxPaused)));
  const hint = blocked || (a?.draining ? "部署完成后自动发送" : "") || (queueMode ? "" : running ? "本轮运行中：草稿会保留，结束后再发送" : "");
  const phoneHint = hint || (queueMode ? "运行中：消息会排队，结束后依次发出" : "继续对话，换行后点击发送");
  const desktopHint = hint || (queueMode ? "本轮运行中：发送的消息会排队，结束后依次发出（Enter 排队）" : "继续对话（Enter 发送，Shift + Enter 换行，/ 调用技能）");
  // 上次发送没拿到结果时幂等信封留在本机（网络中断、平台重启、页面中途被关掉）：
  // 发送开始时草稿正文就已经从本地清掉了，所以重开页面后正文只剩信封里那一份。
  // 这里用信封里的正文兜底显示，免得输入框空着、整块又禁用，看起来像「消息丢了还写不进去」。
  const pendingSend = rtImageDraft(id).pending || null;
  // 部署排空时消息先落进部署票据：等待期间它不是「结果未知」，而是确定已排队，按常规排队列表展示
  const deployQueued = !!(pendingSend && ui.rt.deployWait?.id === id && ui.rt.deployWait.key === pendingSend.key);
  const deploymentMessages = ui.rt.deploymentQueue?.id === id ? ui.rt.deploymentQueue.messages.slice() : [];
  if (deployQueued && !deploymentMessages.some(m => m.key === pendingSend.key)) deploymentMessages.push({ ...pendingSend, attachmentCount: pendingSend.attachmentIds?.length || 0, messageId: `deployment:${pendingSend.key}`, deployment: true });
  const queueSession = { ...s, outbox: [...outbox, ...deploymentMessages] };
  const storedDraft = ui.rt.drafts[id] ?? rtImageDraft(id).text ?? "";
  const draft = storedDraft || String(pendingSend?.prompt || "");
  const enqueue = async () => {
    if (a?.draining) return send();
    if (await rtQuotaLowGate(id, s)) return rtOutboxEnqueue(id, s);
  };
  // quick：点击快捷回复时直接发送这段文字；不读取、不清空输入框里的草稿与图片
  const send = async (quick) => {
    if (ui.rt.statusConfirmed === false) return;
    const sendGen = ui.rt.gen;
    const isQuick = typeof quick === "string";
    const pendingDraft = rtImageDraft(id).pending || null;
    // 重发未确认的信封：正文和图片都从信封取，输入框这时可能是空的
    const pending = isQuick ? null : pendingDraft;
    const raw = isQuick ? quick : (ui.rt.drafts[id] ?? rtImageDraft(id).text ?? "") || String(pending?.prompt || "");
    const text = raw.trim();
    if (isQuick) { if (!text || ui.rt.busy || pendingDraft) return; }
    else {
      const imageError = rtImageError(id, s.runtimeKind, s.requestedModel || "");
      if (imageError) { ui.rt.error = imageError; rtRenderSoft(); return; }
      // 信封里可能还带着上次没确认的图片：正文和本地图片都空时也要允许重发
      if ((!text && !rtImageIds(id).length && !pending?.attachmentIds?.length) || ui.rt.busy) return;
      if (!pending && !(await rtQuotaLowGate(id, s))) return;
    }
    const key = isQuick ? rtKey() : pending?.key || ui.rt.sendKey || (ui.rt.sendKey = rtKey());
    // 乐观上屏：输入框立刻清空，并把这条消息放到时间线末尾标「发送中」，后台再发请求；真实消息到达后自动替换
    if (!isQuick) { ui.rt.drafts[id] = ""; rtSaveImageDraft(id, ""); }
    const outgoing=(ui.rt.outgoing ||= {})[id] = { text: text || (rtImageIds(id).length ? "［图片］" : ""), seq: ui.rt.lastSeq };
    ui.rt.busy = "send"; ui.rt.error = ""; if (rtReadCurrent(id, sendGen)) ui.rt.atBottom = true;
    rtRenderSoft(); rtPatchOutgoing();
    // 故障诊断：消息提交到服务端确认是关键操作之一；排队等部署算正常取消（之后由部署流程送达）
    const submitOp = window.piTelemetry?.op?.('message-submit');
    try {
      const effort = pending ? pending.effort : ui.rt.turnEffort[id];
      // 缓存变冷时用户在输入框上方选过「新开会话」或「继续旧会话」：只用这一次
      const coldChoice = ui.rt.cacheChoice?.id === id ? ui.rt.cacheChoice.mode : "";
      ui.rt.cacheChoice = null;
      const envelope = pending || {key, prompt: text, attachmentIds: isQuick ? [] : rtImageIds(id), expectedRevision: s.bindingRevision, ...(effort ? {effort} : {}), ...(coldChoice ? {cacheHandoff: coldChoice} : {})};
      if (!isQuick) { rtImageDraft(id).pending = envelope; rtSaveImageDraft(id); }
      const accepted=await api(`/api/runtime-sessions/${id}/turns`, { method: "POST", onDeploymentWait: () => { void rtLoadDeploymentQueue(id, sendGen).then(() => { if (rtReadCurrent(id, sendGen)) rtRenderSoft(); }); submitOp?.cancel('deploy-queued'); if (!isQuick) ui.rt.deployWait = { id, key }; if (rtReadCurrent(id, sendGen)) { ui.rt.flash = isQuick ? "消息已排队，部署完成后自动发送" : ""; rtRenderSoft(); } }, body: JSON.stringify({ idempotencyKey: key, prompt: envelope.prompt, attachmentIds: envelope.attachmentIds, expectedRevision: envelope.expectedRevision, ...(effort ? { effort } : {}), ...(envelope.cacheHandoff ? { cacheHandoff: envelope.cacheHandoff } : {}) }) });
      submitOp?.success();
      await rtLoadDeploymentQueue(id, sendGen);
      if (ui.rt.deployWait?.id === id && ui.rt.deployWait.key === key) ui.rt.deployWait = null;
      if (!isQuick) { rtClearImageDraft(id); if(ui.rt.sendKey===key)ui.rt.sendKey = null; }
      if (accepted.queued && ui.rt.outgoing?.[id] === outgoing) delete ui.rt.outgoing[id];
      if(ui.rt.outgoing?.[id]===outgoing){
        outgoing.accepted=true;
        const turn=accepted.session?.turns?.find(t=>t.operationId===accepted.operation?.operationId);
        if(turn?.clientMessageId)outgoing.eventKey='user:'+turn.clientMessageId;
      }
      if(accepted.handedOffFrom && accepted.session?.platformSessionId && accepted.session.platformSessionId!==id){
        // 新开了接续会话（旧会话已归档）：直接切到新会话，消息已经作为它的第一轮发出
        if(ui.rt.outgoing?.[id]===outgoing)delete ui.rt.outgoing[id];
        if(rtReadCurrent(id,sendGen)){ui.rt.busy='';ui.rt.flash='';announce("已新开会话接续，旧会话已归档");location.hash=`#/rt/${encodeURIComponent(accepted.session.platformSessionId)}`;}
        return;
      }
      if(rtReadCurrent(id,sendGen)){
        ui.rt.atBottom=true;
        if(accepted.session?.platformSessionId===id && ui.rt.view)ui.rt.view={...ui.rt.view,session:accepted.session};
        ui.rt.busy='';rtRenderSoft();rtPatchOutgoing();ui.rt.flash = ""; announce(accepted.queued ? "已加入消息队列" : "已发送，本轮运行中");
      }
    } catch (e) {
      submitOp?.failure(e, e.status);
      if (ui.rt.deployWait?.id === id && ui.rt.deployWait.key === key) ui.rt.deployWait = null;
      if(ui.rt.outgoing?.[id]===outgoing)delete ui.rt.outgoing[id]; if(rtReadCurrent(id,sendGen))rtPatchOutgoing();
      if (!isQuick) { ui.rt.drafts[id] = raw; rtSaveImageDraft(id, raw); }
      if(rtReadCurrent(id,sendGen)){
        if (e.code === "RT_CACHE_COLD" && e.details) { ui.rt.error = ""; ui.rt.coldPrompt = { id, details: e.details, ...(isQuick ? { quick } : {}) }; announce("缓存已过期，请选择继续旧会话还是新开会话"); }
        else { ui.rt.error = e.message; announce(`发送失败：${e.message}`); }
      }
      // 冲突/拒绝：换新键再试；网络错误保留原键（重试不会重复执行）
      if (!isQuick && e.status && e.status < 500) { if(ui.rt.sendKey===key)ui.rt.sendKey = null; delete rtImageDraft(id).pending; rtSaveImageDraft(id); }
    }
    if(rtReadCurrent(id,sendGen)){
      ui.rt.busy='';rtRenderSoft();rtPatchOutgoing();
      void rtLoadView(id,sendGen).then(()=>{if(rtReadCurrent(id,sendGen)){rtRenderSoft();rtPatchOutgoing();}});
    }
  };
  // 状态卡与回合收束卡片复用同一发送逻辑（幂等、权限和失败恢复均与输入区一致）。
  if (typeof recoveryText === "string") {
    if (directOpts && directOpts.quickReply) return !blocked && !running && s.sourceMode === "platform-managed" && a && a.control ? send(recoveryText) : undefined;
    return !blocked && !running && rtRecoveryCanSend(s) ? send(recoveryText) : undefined;
  }
  const stop = () => rtInterruptSession(id);
  const resume = async () => {
    if (ui.rt.statusConfirmed === false) return;
    ui.rt.busy = "resume"; ui.rt.error = ""; rtRenderSoft();
    try { await api(`/api/runtime-sessions/${id}/resume-writes`, { method: "POST", body: JSON.stringify({ expectedRevision: s.bindingRevision }) }); announce("已核对并恢复平台写入"); }
    catch (e) { ui.rt.error = e.message; }
    ui.rt.busy = "";
    await rtLoadView(id, ui.rt.gen); await rtLoadMessages(id, ui.rt.gen); renderMain();
  };
  const canRun = s.sourceMode === "platform-managed" && a && a.control;
  const showQuickReplies = !running && !blocked && canRun && !s.roomRef && !s.comparisonRef && !s.projectRef;
  const att = s.sourceMode === "platform-managed" && !s.roomRef && !s.comparisonRef && !s.projectRef
    ? rtAttachmentComposer(id, s.runtimeKind, s.requestedModel || "", !!blocked || !!ui.rt.busy || !!rtImageDraft(id).pending)
    : null;
  // 已归档（或 worktree 已随归档删除）的会话不再接受输入：要输入先恢复成未归档
  const inputLocked = s.archived || !!(s.worktree && s.worktree.removedAt) || (!!blocked && s.sourceMode !== "platform-managed");
  return h("div", { class: "rt-composer", "data-startup-send-ready": String(ui.rt.statusConfirmed === true && !blocked && !ui.rt.busy && !rtImageDraft(id).pending && (!running || queueMode)) },
    ui.rt.error ? h("p", { class: "field-error", role: "alert" }, ui.rt.error) : null,
    rtComposerFlash(),
    rtAutoResolveNote(id),
    rtRecoveryState() ? null : rtQuotaResumeNote(s, !!(a && a.control)),
    rtHandoffNote(s),
    rtColdCachePanel(id, send),
    pendingSend && !deployQueued && !deploymentMessages.some(m => m.key === pendingSend.key) ? rtPendingSendNote(id, pendingSend, send, blocked) : null,
    s.conflict && a && a.control ? h("p", { class: "small" }, "确认没有 CLI / Desktop 在继续这个会话后，可以", h("button", { type: "button", class: "btn small", disabled: ui.rt.statusConfirmed === false || !!ui.rt.busy, onclick: resume }, "核对并恢复写入")) : null,
    queueSession.outbox.length ? rtOutboxPanel(queueSession, { canEdit: canQueue && canRun, canRemove: !blocked && rtOutboxAllowed(s) && !!canRun, running }) : null,
    showQuickReplies ? rtQuickReplyBar(id, s.bindingRevision, send, !!ui.rt.busy || !!rtImageDraft(id).pending) : null,
    showQuickReplies ? rtQuickRedeployLimitNote(id) : null,
    h("div", { class: "rt-compose-row rt-compose-stack" },
      // 草稿图片和新建会话页一样放在输入框边框里面、文字输入上方
      att && !deployQueued ? att.node : null,
      rtSessionMentionInput({
        onpaste: ev => rtImagePaste(id, ev), ondragover: ev => ev.preventDefault(), ondrop: ev => rtImageDrop(id, ev), "data-key": `rt-draft-${id}`, rows: "2", class: "rt-input", "aria-label": "发送给该 runtime 的消息",
        placeholder: rtPhone.matches ? phoneHint : desktopHint, "data-phone-placeholder": phoneHint, "data-desktop-placeholder": desktopHint,
        // 发送 / 停止 / 图片上传中只是暂时不让输入：用 readonly 而不是 disabled。
        // 聚焦中的 textarea 一变 disabled 就会失焦，之后再启用焦点也不会回来——输入法 / 微信语音输入失去文字客户端，结果退回剪贴板。
        disabled: inputLocked, readonly: !inputLocked && (!!ui.rt.busy || !!rtImageDraft(id).pending), value: draft,
        oninput: (ev) => { ui.rt.drafts[id] = ev.target.value; rtSaveImageDraft(id, ev.target.value); ui.rt.sendKey = null; ui.rt.queueKey = null; rtOutboxSyncButton(ev.currentTarget, id); rtSyncQuickReplyVisibility(ev.currentTarget, id); },
        onkeydown: (ev) => { if (!rtIsSendKey(ev)) return; ev.preventDefault(); if (queueMode) void enqueue(); else if ((!running || a?.draining) && !blocked) void send(); }
      }, id),
      h("div", { class: "rt-compose-actions" },
      att ? att.addButton : null,
      rtComposeAccount(v),
      h("span", { class: "rt-compose-spacer", "aria-hidden": "true" }),
      // 运行中只占一个按钮位：输入框有内容（文字或图片）时是「排队发送」，为空时是「停止本轮」；入队后输入框清空，自动回到「停止本轮」
      !running && !blocked && v.effortOptions
        ? rtEffortSelect({ efforts: v.effortOptions.efforts, defaultEffort: v.effortOptions.defaultEffort }, ui.rt.turnEffort[id] ?? (s.requestedEffort || ""), (val) => { ui.rt.turnEffort[id] = val; }, `rt-turn-effort-${id}`, true, !!rtImageDraft(id).pending || !!ui.rt.busy)
        : null,
      rtComposePermission(v),
      // 手机：强度和权限的合并入口；桌面用上面两个内联控件（CSS 按幅面各显一个）
      rtComposeOptions(v, !running && !blocked),
      (running && canRun) || queueMode
        ? rtTurnActionButton(id, { canStop: running && canRun, queueMode, stopping: s.status === "stopping", stop, enqueue })
        : h("button", { type: "button", class: "btn primary", title: "点击发送，长按预约发送（Alt + ↓）", disabled: ui.rt.statusConfirmed === false || !!blocked || !!ui.rt.busy || running, ...rtSchedulePress(send, () => rtScheduleOpen(time => rtOutboxEnqueue(id, s, time)), () => rtOutboxAllowed(s) && !blocked && rtOutboxHasDraft(id)) }, ui.rt.busy === "send" ? "发送中…" : "发送"))),
    blocked ? h("p", { class: "muted small" }, blocked) : null);
}

/**
 * 上次发送没拿到结果（网络中断 / 平台重启 / 页面在请求中途被关掉）：幂等信封留在本机，
 * 输入框、推荐胶囊、发送按钮都会禁用，而且重开页面也不会自己消失。
 * 这里把原因和正文摆出来，并给两个出口：
 * · 重发：沿用原幂等键——服务端已经收下这条时不会重复执行；
 * · 丢弃：把正文放回输入框重新编辑，下一次发送算一条新消息。
 */
function rtPendingSendNote(id, p, send, blocked) {
  const text = String(p.prompt || "").trim();
  const images = Array.isArray(p.attachmentIds) ? p.attachmentIds.length : 0;
  const busy = !!ui.rt.busy || ui.rt.statusConfirmed === false || !!blocked;
  return h("div", { class: "rt-pending-send", role: "status" },
    h("p", { class: "rt-pending-title" }, "上一次发送没有确认结果（网络中断或平台重启），消息可能已经送达"),
    text || images ? h("p", { class: "rt-pending-text muted small", title: text }, [text, images ? `［${images} 张图片］` : ""].filter(Boolean).join(" ")) : null,
    h("div", { class: "rt-pending-actions" },
      text || images ? h("button", { type: "button", class: "btn small primary", disabled: busy, title: "用原来的幂等键再发一次：服务端已经收下这条就不会重复执行", onclick: () => void send() }, "重发") : null,
      h("button", { type: "button", class: "btn small", disabled: !!ui.rt.busy, title: "把这条正文放回输入框，之后按新消息发送", onclick: () => rtPendingSendDiscard(id) }, "丢弃，文字放回输入框")),
    h("p", { class: "muted small" }, "重发沿用原来的幂等键，不会重复执行；丢弃后重新发送会当作一条新消息。"));
}

function rtPendingSendDiscard(id) {
  const d = rtImageDraft(id), text = String(d.pending?.prompt || "");
  if (ui.rt.deployWait?.id === id) ui.rt.deployWait = null;
  delete d.pending;
  if (!String(ui.rt.drafts[id] ?? d.text ?? "").trim()) ui.rt.drafts[id] = text;
  rtSaveImageDraft(id, ui.rt.drafts[id]);
  ui.rt.sendKey = null; ui.rt.error = ""; ui.rt.flash = "已丢弃上一次未确认的发送；正文放回输入框，可以直接改或重新发送";
  announce("已丢弃上一次未确认的发送");
  rtRenderSoft();
}

/* ------------------------------ 排队消息 ------------------------------ */

/** 只有普通单聊能排队（群聊、对比、项目、验收会话有各自的投递流程） */
function rtOutboxAllowed(s) { return s.sourceMode === "platform-managed" && !s.roomRef && !s.comparisonRef && !s.projectRef && !s.role && !s.evaluation; }
function rtOutboxKey(messageId) { return `outbox:${messageId}`; }
function rtOutboxHasDraft(id) { return !!String(ui.rt.drafts[id] ?? rtImageDraft(id).text ?? "").trim() || rtImageDraft(id).images.length > 0; }
/** 输入时不重绘输入区：直接切换「排队发送」按钮的可用状态 */
function rtOutboxSyncButton(input, id) {
  const btn = input?.closest?.(".rt-composer")?.querySelector(".rt-turn-action");
  if (btn) rtTurnActionPaint(btn, id);
}
/** 运行中的按钮位：同一个按钮在「停止本轮」和「排队发送」之间切换（不重绘输入区，输入法和光标不受影响） */
function rtTurnActionButton(id, cfg) {
  const btn = h("button", { type: "button", ...rtSchedulePress(() => { if (btn.dataset.mode === "queue") void cfg.enqueue(); else if (btn.dataset.mode === "stop") void cfg.stop(); }, () => rtScheduleOpen(time => rtOutboxEnqueue(id, ui.rt.view.session, time)), () => btn.dataset.mode === "queue" && rtOutboxHasDraft(id)) });
  btn.rtTurnAction = cfg;
  rtTurnActionPaint(btn, id);
  return btn;
}
function rtTurnActionPaint(btn, id) {
  const cfg = btn.rtTurnAction, queue = cfg.queueMode && rtOutboxHasDraft(id);
  const mode = queue ? "queue" : cfg.canStop ? "stop" : "";
  btn.dataset.mode = mode;
  btn.hidden = !mode;
  btn.className = `btn rt-turn-action ${queue ? "primary rt-outbox-send" : "danger rt-stop-turn"}`;
  btn.title = queue ? "点击排队发送，长按预约发送（Alt + ↓）" : "";
  btn.disabled = ui.rt.statusConfirmed === false || (queue ? !!rtImageDraft(id).pending : ui.rt.busy === "stop" || cfg.stopping);
  btn.textContent = queue ? (ui.rt.outboxBusy === "enqueue" ? "排队中…" : "排队发送") : cfg.stopping ? "停止中…" : "■ 停止本轮";
}
/** 接口返回的最新会话直接上屏（之后的实时同步会给出同样的结果） */
function rtOutboxApply(id, session) {
  if (session && rtId() === id && ui.rt.view?.session?.platformSessionId === id) ui.rt.view = { ...ui.rt.view, session };
}
async function rtOutboxCall(id, path, body, method = "POST") {
  const r = await api(`/api/runtime-sessions/${encodeURIComponent(id)}/${path}`, { method, ...(method === "DELETE" ? {} : { body: JSON.stringify(body || {}) }) });
  rtOutboxApply(id, r.session);
  await rtLoadDeploymentQueue(id, ui.rt.gen);
  return r.session;
}
/** 已上传的图片元数据转成草稿图（已绑定到会话，不按草稿过期） */
function rtOutboxDraftImages(attachments) {
  return (attachments || []).map(a => { const { expiresAt: _e, ...rest } = a; return { ...rest, localId: rtKey(), state: "ready" }; });
}

/** 加入排队：先清空输入框（可以接着写下一条），失败时把内容放回去 */
/**
 * 余量 <3% 时发送 / 排队前的提醒：true = 照常发送；false = 已取消，或已预约到下个周期（并进入预约列表）。
 * 自己长按选了预约时间的发送不走这里。
 */
async function rtQuotaLowGate(id, s) {
  if (ui.rt.quotaLowOpen) return false;
  if (!rtOutboxAllowed(s) || !rtOutboxHasDraft(id)) return true;
  const low = rtQuotaLowInfo(s.runtimeKind, s.requestedModel || "", rtPickRateLimit(s, ui.rt.view?.rateLimit));
  if (!low) return true;
  ui.rt.quotaLowOpen = true;
  let choice;
  try { choice = await rtQuotaLowPrompt(low, "message"); } finally { ui.rt.quotaLowOpen = false; }
  if (choice.action === "send") return true;
  if (choice.action === "wait" && await rtOutboxEnqueue(id, s, low.at)) rtShowScheduledList();
  return false;
}
async function rtOutboxEnqueue(id, s, scheduledFor) {
  if (ui.rt.statusConfirmed === false || ui.rt.outboxBusy === "enqueue" || rtImageDraft(id).pending) return;
  const imageError = rtImageError(id, s.runtimeKind, s.requestedModel || "");
  if (imageError) { ui.rt.error = imageError; rtRenderSoft(); return; }
  const raw = String(ui.rt.drafts[id] ?? rtImageDraft(id).text ?? ""), text = raw.trim(), images = rtImageDraft(id).images.slice();
  if (!text && !images.length) return;
  const messageId = ui.rt.queueKey || (ui.rt.queueKey = rtKey());
  const effort = ui.rt.turnEffort[id];
  const saved = rtImageDrafts[id];
  delete rtImageDrafts[id]; ui.rt.drafts[id] = ""; rtSaveImageDraft(id, "");
  ui.rt.outboxBusy = "enqueue"; ui.rt.error = ""; rtRenderSoft();
  let ok = false;
  try {
    await rtOutboxCall(id, "outbox", { messageId, ...(scheduledFor ? { scheduledFor } : {}), prompt: text, attachmentIds: images.map(i => i.attachmentId), ...(effort ? { effort } : {}) });
    if (ui.rt.queueKey === messageId) ui.rt.queueKey = null;
    for (const i of images) rtImageFiles.delete(i.localId);
    announce(scheduledFor ? `已预约于 ${rtScheduleLabel(scheduledFor)}` : "已加入排队，本轮结束后按顺序发出");
    ok = true;
  } catch (e) {
    // 放回输入框：期间又写了新内容就接在后面，不覆盖
    const now = String(ui.rt.drafts[id] ?? "");
    if (!rtImageDraft(id).images.length && saved) rtImageDrafts[id] = saved;
    ui.rt.drafts[id] = now.trim() ? `${raw}\n${now}` : raw; rtSaveImageDraft(id, ui.rt.drafts[id]);
    if (e.status && e.status < 500) ui.rt.queueKey = null;
    if (rtId() === id) { ui.rt.error = `排队失败：${e.message}`; announce(`排队失败：${e.message}`); }
  }
  ui.rt.outboxBusy = "";
  if (rtId() === id) rtRenderSoft();
  return ok;
}

async function rtOutboxAction(id, busy, fn, done) {
  if (ui.rt.outboxBusy) return;
  ui.rt.outboxBusy = busy; ui.rt.error = ""; rtRenderSoft();
  try { await fn(); if (done) announce(done); }
  catch (e) { if (rtId() === id) { ui.rt.error = e.message; announce(e.message); } }
  ui.rt.outboxBusy = "";
  if (rtId() === id) rtRenderSoft();
}

function rtOutboxMove(s, index, delta) {
  const order = (s.outbox || []).map(m => m.messageId), to = index + delta;
  if (to < 0 || to >= order.length) return;
  [order[index], order[to]] = [order[to], order[index]];
  const id = s.platformSessionId;
  void rtOutboxAction(id, `move:${order[to]}`, () => rtOutboxCall(id, "outbox-order", { order }), delta < 0 ? "已上移" : "已下移");
}

/** 开始修改：先暂停自动发送（免得正在改的这条被发出去），把内容放进独立的编辑草稿 */
function rtOutboxEditStart(s, m) {
  const id = s.platformSessionId;
  if (ui.rt.outboxEdit) rtOutboxEditCancel(id, { keepHold: true });
  const key = rtOutboxKey(m.messageId);
  rtClearImageDraft(key);
  const d = rtImageDraft(key); d.text = m.prompt; d.images = rtOutboxDraftImages(m.attachments); rtSaveImageDraft(key);
  ui.rt.outboxEdit = { sid: id, messageId: m.messageId, scheduledFor: m.scheduledFor, original: { prompt: m.prompt, images: (m.attachments || []).map(a => a.attachmentId) } };
  rtRenderSoft();
  queueMicrotask(() => document.querySelector(`[data-key="rt-outbox-edit-${m.messageId}"]`)?.focus());
  if (!s.outboxPaused) {
    const edit = ui.rt.outboxEdit;
    rtOutboxCall(id, "outbox-hold", {}).then(session => { if (ui.rt.outboxEdit === edit) edit.held = !!session?.outboxPaused?.editing; else if (session?.outboxPaused?.editing) void rtOutboxCall(id, "outbox-resume", { onlyEditHold: true }).catch(() => {}); if (rtId() === id) rtRenderSoft(); })
      .catch(e => { if (rtId() === id) { ui.rt.error = `暂停自动发送失败：${e.message}`; rtRenderSoft(); } });
  }
}
function rtOutboxEditCancel(id, { keepHold = false } = {}) {
  const edit = ui.rt.outboxEdit;
  if (!edit) return;
  ui.rt.outboxEdit = null; rtClearImageDraft(rtOutboxKey(edit.messageId));
  // 只解除自己造成的「正在修改」暂停；期间因停止 / 失败等原因暂停的保留
  if (edit.held && !keepHold) void rtOutboxCall(id, "outbox-resume", { onlyEditHold: true }).catch(() => {}).then(() => { if (rtId() === id) rtRenderSoft(); });
  rtRenderSoft();
}
async function rtOutboxEditSave(s) {
  const id = s.platformSessionId, edit = ui.rt.outboxEdit;
  if (!edit) return;
  const key = rtOutboxKey(edit.messageId), d = rtImageDraft(key);
  const imageError = rtImageError(key, s.runtimeKind, s.requestedModel || "");
  if (imageError) { ui.rt.error = imageError; rtRenderSoft(); return; }
  const text = String(d.text || "").trim();
  if (!text && !rtImageIds(key).length) { ui.rt.error = "消息不能为空；不需要这条就点「撤销」"; rtRenderSoft(); return; }
  await rtOutboxAction(id, `save:${edit.messageId}`, async () => {
    try { await rtOutboxCall(id, `outbox/${encodeURIComponent(edit.messageId)}`, { prompt: text, attachmentIds: rtImageIds(key), ...(edit.scheduledFor ? { scheduledFor: edit.scheduledFor } : {}) }); }
    catch (e) {
      if (e.status === 404) { const kept = String(d.text || ""); rtOutboxEditCancel(id); rtOutboxRestoreToComposer(id, kept, d.images); throw new Error("这条已经发出或被撤销，修改内容已放回输入框"); }
      throw e;
    }
    rtOutboxEditCancel(id);
  }, "已保存修改");
}
/** 正在修改的那条已不在队列里（另一端撤销，或暂停失败时被发出）：有改动就放回输入框，不让修改悄悄丢掉 */
function rtOutboxEditVanished(id, outbox) {
  const edit = ui.rt.outboxEdit;
  if (!edit || edit.sid !== id || outbox.some(m => m.messageId === edit.messageId)) return;
  const d = rtImageDraft(rtOutboxKey(edit.messageId)), text = String(d.text || ""), images = d.images.slice();
  const changed = text !== edit.original.prompt || JSON.stringify(images.map(i => i.attachmentId)) !== JSON.stringify(edit.original.images);
  ui.rt.outboxEdit = null; rtClearImageDraft(rtOutboxKey(edit.messageId));
  if (edit.held) void rtOutboxCall(id, "outbox-resume", { onlyEditHold: true }).catch(() => {});
  if (!changed) return;
  rtOutboxRestoreToComposer(id, text, images);
  queueMicrotask(() => { announce("正在修改的那条已不在队列里（已发出或被撤销），修改内容已放回输入框"); if (rtId() === id) rtRenderSoft(); });
}
/** 把内容放回输入框：输入框为空时整体放回；已有草稿时文字接在后面，图片在名额内合并 */
function rtOutboxRestoreToComposer(id, text, images) {
  const cur = String(ui.rt.drafts[id] ?? rtImageDraft(id).text ?? "");
  const d = rtImageDraft(id);
  d.images = [...d.images, ...(images || []).filter(i => i.state === "ready")].slice(0, 5);
  ui.rt.drafts[id] = cur.trim() ? `${cur}\n${text}` : text;
  rtSaveImageDraft(id, ui.rt.drafts[id]);
}
/** 撤销：从队列里拿掉；输入框为空时内容放回输入框，否则先确认 */
function rtOutboxRemove(s, m) {
  const id = s.platformSessionId, empty = !rtOutboxHasDraft(id);
  if (!empty && !confirm("撤销这条排队消息？输入框里已有草稿，撤销的内容不会保留。")) return;
  void rtOutboxAction(id, `remove:${m.messageId}`, async () => {
    await rtOutboxCall(id, `outbox/${encodeURIComponent(m.messageId)}`, null, "DELETE");
    if (ui.rt.outboxEdit?.messageId === m.messageId) rtOutboxEditCancel(id);
    if (empty) rtOutboxRestoreToComposer(id, m.prompt, rtOutboxDraftImages(m.attachments));
  }, empty ? "已撤销，内容放回输入框" : "已撤销");
}

function rtOutboxEditor(s, m) {
  const id = s.platformSessionId, key = rtOutboxKey(m.messageId), d = rtImageDraft(key), busy = !!ui.rt.outboxBusy;
  const att = rtAttachmentComposer(key, s.runtimeKind, s.requestedModel || "", busy);
  return h("div", { class: "rt-outbox-editor" },
    att.node,
    m.scheduledFor ? h("label", { class: "rt-field" }, "预约时间", h("input", { type: "datetime-local", "aria-label": "修改预约时间", value: rtScheduleLocal(ui.rt.outboxEdit.scheduledFor), onchange: e => { const at = rtScheduleParse(e.target.value); ui.rt.outboxEdit.scheduledFor = Number.isFinite(at) ? new Date(at).toISOString() : "invalid"; } })) : null,
    rtSessionMentionInput({
      class: "rt-input rt-outbox-input", rows: "3", "data-key": `rt-outbox-edit-${m.messageId}`, "aria-label": "修改排队消息", value: d.text || "",
      placeholder: "修改这条排队消息（Enter 保存，Esc 取消）",
      onpaste: ev => rtImagePaste(key, ev), ondragover: ev => ev.preventDefault(), ondrop: ev => rtImageDrop(key, ev),
      oninput: ev => rtSaveImageDraft(key, ev.target.value),
      onkeydown: ev => { if (ev.key === "Escape") { ev.preventDefault(); rtOutboxEditCancel(id); } else if (rtIsSendKey(ev)) { ev.preventDefault(); void rtOutboxEditSave(s); } }
    }, id),
    h("div", { class: "rt-outbox-editor-actions" },
      att.addButton,
      h("span", { class: "rt-compose-spacer", "aria-hidden": "true" }),
      h("button", { type: "button", class: "btn small", disabled: busy, onclick: () => rtOutboxEditCancel(id) }, "取消"),
      h("button", { type: "button", class: "btn small primary", disabled: busy || !!d.images.some(i => i.state === "uploading"), onclick: () => void rtOutboxEditSave(s) }, ui.rt.outboxBusy === `save:${m.messageId}` ? "保存中…" : "保存")));
}

/**
 * 插话中的说明：插话要等本轮正在执行的工具跑完才会送进模型（不会打断工具），
 * 所以写明在等哪个工具、已经等了多久，免得长工具（如整套测试）跑几分钟时看起来像没生效。
 */
const RT_TOOL_DONE = new Set(["completed", "failed", "declined", "cancelled"]);
function rtSteerWaitText(steering) {
  const tool = [...(ui.rt.events || [])].reverse().find(e => e.kind === "tool" && !e.partial && !RT_TOOL_DONE.has(e.tool?.status) && typeof e.tool?.exitCode !== "number" && (e.turnNo === undefined || !steering?.turnNo || e.turnNo === steering.turnNo));
  const since = Date.parse(steering?.at || "");
  const mins = Number.isFinite(since) ? Math.max(0, Math.floor((Date.now() - since) / 60000)) : 0;
  const waited = Number.isFinite(since) ? `（已等${mins < 1 ? "不到 1 分钟" : ` ${mins} 分钟`}）` : "";
  return `插话中：${tool ? `正在等 ${tool.tool?.name || "工具"} 执行完${waited}，之后送进本轮` : `等本轮当前这一步完成${waited}后送进本轮`}；没赶上就留在排队里`;
}
let rtSteerTicker = 0;
/** 长工具跑几分钟期间没有新事件，页面不会重绘；每 15 秒只刷新这行文字里的时间和工具名 */
function rtSteerTick() {
  if (rtSteerTicker) return;
  rtSteerTicker = setInterval(() => {
    const nodes = document.querySelectorAll("[data-steer-since]");
    if (!nodes.length) { clearInterval(rtSteerTicker); rtSteerTicker = 0; return; }
    const steering = ui.rt.view?.session?.outbox?.find(m => m.steering)?.steering;
    for (const n of nodes) n.textContent = rtSteerWaitText({ ...steering, at: n.getAttribute("data-steer-since") });
  }, 15000);
}

/** 输入框上方的排队列表：序号、内容预览（含图片缩略图）、上移 / 下移 / 修改 / 撤销 */
function rtOutboxPanel(s, { canEdit, canRemove = canEdit, running }) {
  rtScheduleFocus(s.platformSessionId);
  const id = s.platformSessionId, list = s.outbox || [], paused = s.outboxPaused, busy = !!ui.rt.outboxBusy;
  const editing = ui.rt.outboxEdit?.sid === id ? ui.rt.outboxEdit.messageId : "";
  const normalSession = { ...s, outbox: list.filter(m => !m.deployment) };
  const ownHold = paused?.editing && editing && ui.rt.outboxEdit?.held;
  if (list.some(m => m.steering)) rtSteerTick();
  const status = !normalSession.outbox.length ? "等待部署完成后自动发送" : paused
    ? (ownHold ? "修改期间暂停自动发送" : `已暂停：${paused.reason}`)
    : list.some(m => m.scheduledFor) ? "预约消息到点后发送；当前轮运行中则等待结束" : running ? "本轮结束后按顺序逐条发出" : "即将发出第 1 条";
  return h("section", { class: `rt-outbox${list.some(m => m.deployment) ? " deploy-wait" : ""}${paused ? " paused" : ""}`, "aria-label": "排队消息" },
    h("div", { class: "rt-outbox-head" },
      h("strong", {}, `排队消息 ${list.length}`),
      h("span", { class: `rt-outbox-status small${paused && !ownHold ? " warn" : " muted"}`, role: "status" }, status),
      paused && !ownHold && canEdit
        ? h("button", { type: "button", class: "btn small", disabled: busy, title: running ? "解除暂停：本轮结束后自动发出" : "现在发出第 1 条，之后每轮结束自动发下一条", onclick: () => void rtOutboxAction(id, "resume", () => rtOutboxCall(id, "outbox-resume", {}), running ? "已恢复，本轮结束后自动发出" : "已继续发送") }, running ? "恢复自动发送" : "继续发送")
        : null),
    h("ol", { class: "rt-outbox-list" }, list.map((m, i) => {
      if (m.deployment) return h("li", { class: "rt-outbox-item", "data-outbox-id": m.messageId },
        h("span", { class: "rt-outbox-no", "aria-hidden": "true" }, String(i + 1)),
        h("div", { class: "rt-outbox-body" },
          h("span", { class: "small muted", role: "status" }, "消息已排队，部署完成后自动发送"),
          m.prompt?.trim() ? h("div", { class: "rt-outbox-text" }, rtText(m.prompt, id)) : null,
          m.attachmentCount ? h("span", { class: "small muted" }, `图片 ${m.attachmentCount} 张`) : null,
          m.scheduledFor ? h("span", { class: "small muted" }, `预约于 ${rtScheduleLabel(m.scheduledFor)}`) : null));
      const isEditing = editing === m.messageId;
      // 插话：本轮运行中把这条送进本轮（当前工具执行完、下一次调用模型前）；Pi、Codex、Claude Code 都支持
      const canSteer = canEdit && running && ["pi", "codex", "claude-code"].includes(s.runtimeKind) && !paused && !m.scheduledFor;
      if (m.steering) return h("li", { class: "rt-outbox-item steering", "data-outbox-id": m.messageId },
        h("span", { class: "rt-outbox-no", "aria-hidden": "true" }, String(i + 1)),
        h("div", { class: "rt-outbox-body" },
          m.prompt.trim() ? h("div", { class: "rt-outbox-text" }, rtText(m.prompt, id)) : null,
          m.attachments?.length ? rtAttachmentHistory(m.attachments, id) : null,
          h("span", { class: "muted small", role: "status", "data-steer-since": m.steering.at || "" }, rtSteerWaitText(m.steering))));
      return h("li", { class: `rt-outbox-item${m.scheduledFor ? " scheduled" : ""}${isEditing ? " editing" : ""}`, "data-outbox-id": m.messageId },
        h("span", { class: "rt-outbox-no", "aria-hidden": "true" }, m.scheduledFor ? rtClockIcon() : String(i + 1)),
        isEditing ? rtOutboxEditor(s, m) : h("div", { class: "rt-outbox-body" },
          m.scheduledFor ? h("span", { class: "rt-schedule-time small" }, `预约于 ${rtScheduleLabel(m.scheduledFor)}${Date.parse(m.scheduledFor) <= Date.now() ? " · 已到点，等待发送" : ""}`) : null,
          m.prompt.trim() ? h("div", { class: "rt-outbox-text" }, rtText(m.prompt, id)) : null,
          m.attachments?.length ? rtAttachmentHistory(m.attachments, id) : null,
          m.effort ? h("span", { class: "muted small" }, `推理强度 ${m.effort}`) : null),
        isEditing || (!canEdit && !canRemove) ? null : h("div", { class: "rt-outbox-actions" },
          canEdit ? [
          !m.scheduledFor ? h("button", { type: "button", class: "btn small icon", disabled: busy || i === 0, "aria-label": `上移第 ${i + 1} 条`, title: "上移", onclick: () => rtOutboxMove(normalSession, i, -1) }, "↑") : null,
          !m.scheduledFor ? h("button", { type: "button", class: "btn small icon", disabled: busy || i === normalSession.outbox.length - 1, "aria-label": `下移第 ${i + 1} 条`, title: "下移", onclick: () => rtOutboxMove(normalSession, i, 1) }, "↓") : null,
          h("button", { type: "button", class: "btn small", disabled: busy, "aria-label": `修改第 ${i + 1} 条`, onclick: () => rtOutboxEditStart(s, m) }, "修改"),
          ] : null,
          canRemove ? h("button", { type: "button", class: "btn small", disabled: busy, "aria-label": `撤销第 ${i + 1} 条`, onclick: () => rtOutboxRemove(s, m) }, "撤销") : null,
          canSteer ? h("button", { type: "button", class: "btn small", disabled: busy, "aria-label": `插话第 ${i + 1} 条`, title: "不等本轮结束：当前工具执行完、下一次调用模型前送进本轮（沿用本轮的模型和推理强度）", onclick: () => void rtOutboxAction(id, `steer:${m.messageId}`, () => rtOutboxCall(id, `outbox/${encodeURIComponent(m.messageId)}/steer`, {}), "已插话，当前工具执行完后送达") }, "插话") : null));
    })));
}

/**
 * 推荐胶囊挂在最后一条可回复的消息上：通常是助手回复；最后一条是部署结果通知时也挂它，
 * 让「归档会话 / 重新部署」直接出现在输入框上方。
 * 中断 / 失败 / 用户按请求停止的一轮可能没有任何助手回复（例如额度错误直接打断、点「停止本轮」）：
 * 这时挂在这一轮的结束记录上，让服务端补的「重试本轮」也能显示（与服务端 quickReplies 同口径）。
 */
const RT_RETRY_TURN = new Set(["interrupted", "failed", "unknown", "cancelled"]);
function rtLastAssistantKey() {
  // 人类回复已在发送中或已受理时，旧推荐立即收起，不等真实消息同步回来。
  if (ui.rt.trimmedTail || rtOutgoing()) return "";
  const list = ui.rt.events;
  let turnEnd = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (e.partial || e.subagent) continue;
    if (e.kind === "turn-status") { if (!turnEnd) turnEnd = e; continue; }
    if (e.kind !== "message") continue;
    if (e.role === "user") {
      if (typeof rtDeploymentNotice === "function" && (rtDeploymentNotice(e) || rtEnforcementNotice(e))) return e.key;
      return turnEnd && RT_RETRY_TURN.has(turnEnd.status) ? turnEnd.key : "";
    }
    // 空正文的助手消息（中断时可能只有错误）继续往前找，最终按这一轮的结束记录挂推荐
    if (e.role === "assistant" && String(e.text || "").trim()) return e.key;
  }
  return "";
}

/**
 * 推荐操作只跟「最后一条消息」绑定，一轮结束后不会变：把上次拿到的结果存在本机（按会话 + 消息 key），
 * 重新打开会话（含刷新 / 重启 PWA）时先直接显示，再在后台向服务端核对一次，不用等模型和部署状态。
 */
const RT_QUICK_CACHE_KEY = "pi-agent:quick-replies.v1";
const RT_QUICK_CACHE_LIMIT = 60;
function rtQuickCacheAll() {
  try {
    const saved = JSON.parse(localStorage.getItem(RT_QUICK_CACHE_KEY) || "null");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  } catch { return {}; }
}
function rtQuickCacheRead(id, key) {
  const hit = rtQuickCacheAll()[id];
  if (!hit || hit.key !== key || !Array.isArray(hit.replies)) return null;
  const replies = hit.replies.filter((x) => x && x.label && x.text);
  return replies.length ? { replies, ...(hit.headline ? { headline: hit.headline } : {}), ...(hit.decision ? { decision: hit.decision } : {}), ...(hit.deployment ? { deployment: hit.deployment } : {}), ...(hit.deploymentSha ? { deploymentSha: hit.deploymentSha } : {}) } : null;
}
function rtQuickCacheWrite(id, key, entry) {
  try {
    const all = rtQuickCacheAll();
    if (entry && entry.state === "ready" && entry.replies.length) all[id] = { key, at: Date.now(), replies: entry.replies, ...(entry.headline ? { headline: entry.headline } : {}), ...(entry.decision ? { decision: entry.decision } : {}), ...(entry.deployment ? { deployment: entry.deployment } : {}), ...(entry.deploymentSha ? { deploymentSha: entry.deploymentSha } : {}) };
    else delete all[id];
    // 只保留最近用到的会话，避免这个本地记录无限增长。
    const items = Object.entries(all).sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0));
    for (const [old] of items.slice(RT_QUICK_CACHE_LIMIT)) delete all[old];
    localStorage.setItem(RT_QUICK_CACHE_KEY, JSON.stringify(all));
  } catch { /* 存不了就只在本页生效 */ }
}

/**
 * 服务端在一轮结束时算好、存在会话记录上的最终推荐结果（随会话详情 / 实时同步一起到）。
 * 只认挂在当前最后一条消息上的那份；有它就不用再请求，也不用等本机缓存。
 */
function rtServerQuickReplies(id, key) {
  const s = ui.rt.view?.session;
  const q = s && s.platformSessionId === id ? s.quickReplies : null;
  if (!q || q.eventKey !== key || !Array.isArray(q.replies)) return null;
  const replies = q.replies.filter((x) => x && x.label && x.text);
  return replies.length ? { replies, ...(q.headline ? { headline: q.headline } : {}), ...(q.decision ? { decision: q.decision } : {}), ...(q.deployment ? { deployment: q.deployment } : {}), ...(q.deploymentSha ? { deploymentSha: q.deploymentSha } : {}) } : null;
}
function rtAdoptServerQuickReplies(id, key, srv) {
  const cur = ui.rt.quickReplies[id];
  const same = cur && cur.key === key && cur.server && JSON.stringify(cur.replies) === JSON.stringify(srv.replies) && (cur.headline || "") === (srv.headline || "") && (cur.decision || "") === (srv.decision || "") && cur.deployment === srv.deployment && cur.deploymentSha === srv.deploymentSha;
  if (same) return cur;
  const entry = { key, state: "ready", server: true, ...srv };
  ui.rt.quickReplies[id] = entry;
  rtQuickCacheWrite(id, key, entry);
  return entry;
}

/**
 * 每条助手回复向服务端核对一次；服务端按消息缓存（一轮结束时已预先生成）。
 * 本机有同一条消息的上次结果时先显示它（stale），后台核对后再替换；核对失败就保留。
 */
function rtLoadQuickReplies(id, key) {
  if (rtServerQuickReplies(id, key)) return;
  const cur = ui.rt.quickReplies[id];
  if (cur && cur.key === key && !cur.stale) return;
  if (cur && cur.key === key && cur.fetching) return;
  const cached = cur && cur.key === key ? cur : null;
  ui.rt.quickReplies[id] = cached ? { ...cached, fetching: true } : { key, state: "loading", replies: [], fetching: true };
  const gen = ui.rt.gen;
  api(`/api/runtime-sessions/${id}/quick-replies`, { method: "POST", body: "{}" }).then((r) => {
    if (ui.rt.quickReplies[id]?.key !== key) return;
    // 服务端看到的最后一条助手消息和本地不同（本地记录还没追上）：等本地更新后再按新 key 请求
    const replies = r.eventKey === key && Array.isArray(r.replies) ? r.replies.filter((x) => x && x.label && x.text) : [];
    // deployment=failed 是部署失败通知的可靠标记：自动重新部署必须同时看到它、首项 action 和「重新部署」文案。
    const next = { key, state: r.state === "ready" && r.eventKey === key ? "ready" : "none", replies, ...(r.headline ? { headline: r.headline } : {}), ...(r.decision ? { decision: r.decision } : {}), ...(r.deployment ? { deployment: r.deployment } : {}), ...(r.deploymentSha ? { deploymentSha: r.deploymentSha } : {}) };
    ui.rt.quickReplies[id] = next;
    // 服务端暂时不可用（模型没配置 / 生成失败）不覆盖上次的好结果；明确没有推荐才清掉
    if (r.state !== "unavailable" && r.eventKey === key) rtQuickCacheWrite(id, key, next);
  }).catch(() => {
    const now = ui.rt.quickReplies[id];
    if (now?.key !== key) return;
    // 核对失败：有本机缓存就继续显示（点击时仍会重新核对），不再反复请求
    ui.rt.quickReplies[id] = now.stale && now.state === "ready" ? { key, state: "ready", replies: now.replies, ...(now.headline ? { headline: now.headline } : {}), ...(now.decision ? { decision: now.decision } : {}), ...(now.deployment ? { deployment: now.deployment } : {}), ...(now.deploymentSha ? { deploymentSha: now.deploymentSha } : {}) } : { key, state: "error", replies: [] };
  }).finally(() => { if (rtReadCurrent(id, gen)) rtRenderSoft(); });
}

/** 自动重新部署的已触发记录：按「会话 + 部署失败通知 key」持久化，刷新或重新进入会话都不重复触发。 */
const RT_AUTO_REDEPLOY_KEY = "pi-agent:auto-redeploy.v1";
/** 与服务端 AUTO_REDEPLOY_LIMIT 一致：只限制自动触发，手动点击不受影响。 */
const RT_AUTO_REDEPLOY_LIMIT = 3;
function rtAutoRedeployMark(id, key) {
  const marker = `${id}\n${key}`;
  const seen = (ui.rt.autoRedeploy ||= {});
  seen[marker] = "done";
  try {
    const saved = JSON.parse(localStorage.getItem(RT_AUTO_REDEPLOY_KEY) || "{}");
    const next = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    next[marker] = Date.now();
    // 只保留最近 200 条失败通知，避免这个本地记录无限增长。
    const entries = Object.entries(next).sort((a, b) => Number(b[1]) - Number(a[1]));
    for (const [old] of entries.slice(200)) delete next[old];
    localStorage.setItem(RT_AUTO_REDEPLOY_KEY, JSON.stringify(next));
  } catch { /* 存不了就只在本页生效 */ }
}
function rtAutoRedeployDone(id, key) {
  const marker = `${id}\n${key}`;
  if (ui.rt.autoRedeploy?.[marker]) return true;
  try {
    const saved = JSON.parse(localStorage.getItem(RT_AUTO_REDEPLOY_KEY) || "null");
    return !!(saved && typeof saved === "object" && !Array.isArray(saved) && saved[marker]);
  } catch { return false; }
}

/**
 * 首项为部署失败后的「重新部署」时自动执行一次：
 * 判定同时要求服务端 deployment=failed、首项 action=deploy、文案精确为「重新部署」；
 * 只在会话空闲、状态已核对、能从这里部署、没有排队部署 / 未确认发送时触发；
 * 不能部署时留给用户手动决定，不退回发送普通消息。每个失败通知只触发一次（localStorage 记住 key）。
 */
function rtMaybeAutoRedeploy(id, key, revision, cur, disabled) {
  const first = cur?.replies?.[0];
  // 本机缓存的旧结果（还没向服务端核对）不能触发自动部署
  if (cur?.state !== "ready" || cur.stale || cur?.deployment !== "failed" || !first || first.action !== "deploy" || first.label !== "重新部署") return;
  if (disabled || ui.rt.busy) return;
  const s = ui.rt.view?.session;
  if (!s || s.platformSessionId !== id || s.bindingRevision !== revision) return;
  if (ui.rt.statusConfirmed === false) return;
  if (!ui.rt.access?.control || s.sourceMode !== "platform-managed") return;
  if (s.archived || s.conflict || s.worktree?.removedAt || !s.nativeSessionId) return;
  if (["creating", "running", "waiting-input", "stopping"].includes(s.status) || (s.turns || []).some((t) => t.status === "queued")) return;
  if (rtOutboxHasDraft(id) || rtImageDraft(id).pending) return;
  if (rtLastAssistantKey() !== key) return;
  if (Number(s.autoRedeployCount ?? 0) >= RT_AUTO_REDEPLOY_LIMIT) return;
  const marker = `${id}\n${key}`;
  const seen = (ui.rt.autoRedeploy ||= {});
  if (seen[marker] || rtAutoRedeployDone(id, key)) return;
  seen[marker] = "pending";
  const gen = ui.rt.gen;
  void (async () => {
    let d = null;
    try { d = await api(`/api/runtime-sessions/${id}/deploy`); } catch { /* 读不到部署状态：留给用户手动点 */ }
    if (!rtReadCurrent(id, gen)) { delete seen[marker]; return; }
    if (ui.rt.busy || (ui.rt.deploy?.id === id && ui.rt.deploy.busy)) { delete seen[marker]; return; }
    const now = ui.rt.view?.session;
    const busyNow = !now || ["creating", "running", "waiting-input", "stopping"].includes(now.status) || (now.turns || []).some((t) => t.status === "queued");
    if (ui.rt.statusConfirmed === false || busyNow || now.platformSessionId !== id || now.bindingRevision !== revision || now.archived || now.conflict || rtLastAssistantKey() !== key || rtOutboxHasDraft(id) || rtImageDraft(id).pending) {
      delete seen[marker]; return;
    }
    if (!d) { delete seen[marker]; return; }
    // 把读到的状态交给界面：胶囊能正确显示排队中 / 不能部署，而不是一直停留在未知状态。
    if (!ui.rt.deploy || ui.rt.deploy.id !== id) ui.rt.deploy = { id, info: d };
    else ui.rt.deploy.info = d;
    // 已经登记过这个会话的部署：不重复登记，记成已处理（这时手动胶囊本身也是禁用的）。
    if (rtDeployMine(d, id)) { rtAutoRedeployMark(id, key); rtRenderSoft(); return; }
    // 不能从这里部署时不自动执行，也不把「请重新部署」当普通消息发给助手。
    if (!d.eligible) { delete seen[marker]; rtRenderSoft(); return; }
    rtAutoRedeployMark(id, key);
    // 失败的提交没有任何变化：重试只会再失败一遍，留给用户修改后再部署或手动点击。
    if (rtSameFailedHead(d, cur.deploymentSha)) {
      const msg = "上次部署失败的提交没有变化，没有自动重新部署；修改后再部署，或手动点击「重新部署」。";
      ui.rt.flash = msg; announce(msg); rtRenderSoft(); return;
    }
    const registered = await rtDeployAsk(now, { direct: true, info: d, auto: true, failedSha: cur.deploymentSha || "" });
    if (!registered) return;
    // 服务端已占用一次配额；优先用它返回的计数，界面立即显示上限提示（服务端仍按会话记录把关）。
    const after = ui.rt.view?.session;
    if (after && after.platformSessionId === id) {
      const serverCount = registered.autoRedeploy?.count;
      after.autoRedeployCount = typeof serverCount === "number" ? serverCount : Math.min(RT_AUTO_REDEPLOY_LIMIT, Number(after.autoRedeployCount ?? 0) + 1);
      rtRenderSoft();
    }
  })();
}

/** 部署失败通知里的提交，就是现在要部署的提交（会话分支没有新提交也没有未提交改动）。 */
function rtSameFailedHead(d, failedSha) {
  if (!failedSha) return false;
  const wt = d.mode === "worktree" ? d.worktree : null;
  const head = wt ? (wt.changes.length ? "" : wt.head) : d.main?.sha;
  return !!head && head.startsWith(failedSha);
}

/** 自动重新部署已达到服务端上限：首项仍显示，提示用户可手动点击。 */
function rtQuickRedeployLimitNote(id) {
  const s = ui.rt.view?.session;
  if (!s || s.platformSessionId !== id || Number(s.autoRedeployCount ?? 0) < RT_AUTO_REDEPLOY_LIMIT) return null;
  const key = rtLastAssistantKey();
  const cur = ui.rt.quickReplies[id];
  const first = cur?.replies?.[0];
  if (!key || !cur || cur.key !== key || cur.state !== "ready" || cur.deployment !== "failed" || first?.label !== "重新部署" || first?.action !== "deploy") return null;
  return h("p", { class: "muted small rt-quick-redeploy-limit", role: "status" }, `自动重新部署已达 ${RT_AUTO_REDEPLOY_LIMIT} 次上限，可手动点击「重新部署」。`);
}

/** 快捷回复：原模型在最后一条回复里推荐的选择，点一下直接作为人类回复发出 */
function rtSyncQuickReplyVisibility(input, id) {
  const bar = input.closest(".rt-composer")?.querySelector(".rt-quick-replies");
  if (bar) bar.hidden = rtOutboxHasDraft(id);
}

/** 点击后还要等结果的快捷回复：在按钮文字前加转圈，别让「整体变灰」看起来像没点上。 */
function rtQuickBusyStart(id, key, text) { ui.rt.quickBusy = { id, key, text }; }
function rtQuickBusyEnd(id, key, text) {
  const b = ui.rt.quickBusy;
  if (b && b.id === id && b.key === key && b.text === text) ui.rt.quickBusy = null;
}
function rtQuickBusyMatches(id, key, text) {
  const b = ui.rt.quickBusy;
  return !!b && b.id === id && b.key === key && b.text === text;
}
function rtQuickBusyMark(busy) {
  return busy ? h("span", { class: "rt-quick-busy", "aria-hidden": "true" }) : null;
}

// 使用可替换的 onclick 属性；软重绘保留按钮时同步最新发送闭包。
function rtQuickReplyButton(attrs, ...children) {
  const { onclick, ...rest } = attrs;
  const button = h("button", rest, ...children);
  button.onclick = onclick;
  return button;
}

function rtResolveQuickReplies(id, key, { fetch = true } = {}) {
  if (!id || !key) return null;
  let cur = ui.rt.quickReplies[id];
  // 服务端已经算好并随会话详情到达：直接用，不请求、不等本机缓存
  const srv = rtServerQuickReplies(id, key);
  if (srv) cur = rtAdoptServerQuickReplies(id, key, srv);
  else if (!cur || cur.key !== key) {
    // 本机有这条消息上次的结果：先显示，后台核对
    const cached = rtQuickCacheRead(id, key);
    cur = ui.rt.quickReplies[id] = cached ? { key, state: "ready", stale: true, ...cached } : undefined;
    if (fetch) queueMicrotask(() => rtLoadQuickReplies(id, key));
    if (!cur) return null;
  } else if (fetch && cur.stale && !cur.fetching) queueMicrotask(() => rtLoadQuickReplies(id, key));
  return cur;
}

/** 构造一组快捷回复按钮；供输入框上方条与回合收束卡片「要你决定」区共用，绝不重复渲染。 */
function rtRenderQuickReplyGroup(id, key, revision, cur, send, disabled, { inCard = false } = {}) {
  const qd = rtQuickDeployState(id);
  // 等本次渲染落地后再自动执行，避免在 render 里直接触发网络写操作。
  queueMicrotask(() => rtMaybeAutoRedeploy(id, key, revision, cur, disabled));
  return h("div", {
    class: inCard ? "rt-quick-replies rt-tc-btns" : "rt-quick-replies",
    "data-session": id, "data-event": key, "data-revision": revision,
    hidden: !inCard && rtOutboxHasDraft(id),
    role: "group", "aria-label": "快捷回复（点击直接发送）"
  }, ...cur.replies.map((r, idx) => {
    const busy = rtQuickBusyMatches(id, key, r.text);
    const node = r.action === "deploy" ? rtQuickDeployChip(id, key, revision, r, send, disabled, qd, busy)
      : r.action === "archive" ? rtQuickArchiveChip(id, key, revision, r, disabled, busy)
      : rtQuickReplyButton({
        type: "button", class: "chip rt-quick-reply", disabled, title: r.text, "aria-label": `发送：${r.text}`, "aria-busy": busy ? "true" : null,
        // 发送时立即收起；失败后恢复，可再点或改为手动输入
        onclick: () => void rtQuickReplyClick(id, key, revision, r.text, send)
      }, rtQuickBusyMark(busy), r.label);
    if (inCard && idx === 0) node.classList.add("is-primary");
    return node;
  }));
}

/** 当前会话是否允许展示可点击的快捷回复（与 rtComposer 保持完全一致口径）。 */
function rtQuickReplyCanShow(v = ui.rt.view) {
  const s = v?.session;
  const a = ui.rt.access;
  if (!s || !a || !a.control || s.sourceMode !== "platform-managed") return false;
  if (s.roomRef || s.comparisonRef || s.projectRef || s.archived || s.conflict || (s.worktree && s.worktree.removedAt) || !s.nativeSessionId) return false;
  const running = ["creating", "running", "waiting-input", "stopping"].includes(s.status) || (s.turns || []).some((t) => t.status === "queued");
  if (running || rtRecoveryState()) return false;
  return true;
}

/** 回合收束卡片内嵌的快捷回复按钮组：只在最新一轮且有权限执行时显示。 */
function rtTurnCardQuickReplies(id, key) {
  const v = ui.rt.view;
  if (!v || v.session?.platformSessionId !== id || rtLastAssistantKey() !== key || !rtQuickReplyCanShow(v)) return null;
  const cur = rtResolveQuickReplies(id, key, { fetch: true });
  if (!cur || cur.state !== "ready" || !cur.replies.length) return null;
  const send = (text) => rtComposer(ui.rt.view, text, { quickReply: true });
  return rtRenderQuickReplyGroup(id, key, v.session.bindingRevision, cur, send, !!ui.rt.busy || !!rtImageDraft(id).pending, { inCard: true });
}

function rtQuickReplyBar(id, revision, send, disabled) {
  if (rtRecoveryState()) return null;
  const key = rtLastAssistantKey();
  if (!key) return null;
  const cur = rtResolveQuickReplies(id, key, { fetch: true });
  if (!cur || cur.state !== "ready" || !cur.replies.length) return null;
  // 最新一轮已经由「回合收束卡片」承接快捷回复时，输入区上方不再重复显示。
  if (typeof rtTurnCardOwnsQuickReplies === "function" && rtTurnCardOwnsQuickReplies(id, key, ui.rt.events)) return null;
  return rtRenderQuickReplyGroup(id, key, revision, cur, send, disabled);
}

/** 这个会话能从页面部署（有「空闲时部署」按钮或被主工作区阻塞）时返回部署状态；不能或还没读到时返回 null */
function rtQuickDeployState(id) {
  const st = ui.rt.deploy && ui.rt.deploy.id === id ? ui.rt.deploy : null;
  const d = st && st.info;
  if (d) return d.eligible || d.blockedCode ? { st, d, mine: rtDeployMine(d, id) } : null;
  // 还没读到过这个会话的部署状态（第一次打开）：先按能部署显示，免得样式过一会儿才变；点击时会重新读取，不能部署就照常发送文字
  return id in ui.rt.deployCache ? null : { st: { busy: false }, d: { eligible: true, unknown: true }, mine: null };
}

/**
 * 快捷回复里「同意部署」的那条关联会话的部署按钮：点击直接登记空闲时部署（不再确认），不把文字发给助手。
 * 会话不能从页面部署时退回普通快捷回复，把 text 发给助手。
 */
function rtQuickDeployChip(id, key, revision, r, send, disabled, qd, busy = false) {
  if (!qd) return rtQuickReplyButton({ type: "button", class: "chip rt-quick-reply", disabled, title: r.text, "aria-label": `发送：${r.text}`, "aria-busy": busy ? "true" : null,
    onclick: () => void rtQuickReplyDeploy(id, key, revision, r.text, send) }, rtQuickBusyMark(busy), r.label);
  const { st, d, mine } = qd;
  const wt = d.mode === "worktree";
  const what = d.unknown ? "部署" : wt ? "提交并在空闲时部署" : "空闲时部署";
  const title = d.unknown ? "点击直接部署（等同点会话头部的部署按钮并确认），结果会发回这个会话" : mine ? `已登记${mine.startedAt ? "并开始" : ""}空闲时部署 ${rtSha(mine.sha)}（${mine.subject}），结果会发回这个会话`
    : !d.eligible ? `暂不能部署：${d.reason}`
    : `点击直接${what}（等同点会话头部的「${what}」并确认），结果会发回这个会话`;
  return rtQuickReplyButton({
    type: "button", class: "chip rt-quick-reply rt-quick-deploy", disabled: disabled || !!st.busy || !!mine || !d.eligible, title,
    "aria-label": `${what}：${r.label}`, "aria-busy": busy && !mine ? "true" : null,
    onclick: () => void rtQuickReplyDeploy(id, key, revision, r.text, send)
  }, rtQuickBusyMark(busy && !mine), h("span", { class: "rt-quick-deploy-mark", "aria-hidden": "true" }, "⇪"), mine ? rtDeployWord(!!mine.startedAt) : r.label);
}

async function rtQuickReplyDeploy(id, key, revision, text, send) {
  if (ui.rt.busy) return;
  const gen = ui.rt.gen;
  // 点击当时的会话对象：读部署状态期间用户可能已切走，之后仍按它提交
  const s = ui.rt.view && ui.rt.view.session && ui.rt.view.session.platformSessionId === id ? ui.rt.view.session : null;
  let d = null;
  ui.rt.busy = "deploy"; rtQuickBusyStart(id, key, text); rtRenderSoft();
  try { d = await api(`/api/runtime-sessions/${id}/deploy`); } catch { /* 读不到部署状态：按普通快捷回复发送 */ }
  finally { if (ui.rt.busy === "deploy") ui.rt.busy = ""; }
  // 点了之后如果很快切到别的会话：提交照常继续（按点击时的会话登记），不能因为页面已不在这个会话就丢掉
  const here = rtReadCurrent(id, gen);
  if (!s || !d || (!d.eligible && !d.blockedCode)) {
    rtQuickBusyEnd(id, key, text);
    if (!here) { announce("没能提交部署：这个会话现在不能从页面部署，回到会话再试"); return; }
    rtRenderSoft(); return rtQuickReplyClick(id, key, revision, text, send);
  }
  // 交给 rtDeployAsk 提交登记；它自己会置部署忙状态，快捷回复继续转圈到登记完成。
  const state = here && ui.rt.deploy && ui.rt.deploy.id === id ? ui.rt.deploy : { id, info: d };
  if (here && (!ui.rt.deploy || ui.rt.deploy.id !== id)) ui.rt.deploy = state;
  try { return await rtDeployAsk(s, { direct: true, info: d, state }); }
  finally {
    rtQuickBusyEnd(id, key, text);
    if (rtReadCurrent(id, gen)) rtRenderSoft();
  }
}

/** 部署成功后的「归档会话」：与头部归档按钮同一套接口，点击直接归档，不再发送聊天消息。 */
function rtQuickArchiveChip(id, key, revision, r, disabled, busy = false) {
  const s = ui.rt.view && ui.rt.view.session;
  return rtQuickReplyButton({
    type: "button", class: "chip rt-quick-reply rt-quick-archive", disabled: disabled || !s,
    title: s && s.worktree ? "点击直接归档这个会话并删除 worktree，未提交、未合并改动将丢弃；可在列表里恢复会话" : "点击直接归档这个会话；可在列表里恢复",
    "aria-label": `归档会话：${r.label}`, "aria-busy": busy ? "true" : null,
    onclick: () => void rtQuickReplyArchive(id, key, revision, r.text)
  }, rtQuickBusyMark(busy), r.label);
}

async function rtQuickReplyArchive(id, key, revision, text) {
  if (ui.rt.busy) return;
  const gen = ui.rt.gen;
  rtQuickBusyStart(id, key, text);
  rtRenderSoft();
  try {
    if (ui.rt.statusConfirmed === false) {
      ui.rt.busy = "archive"; rtRenderSoft();
      try { await rtLoadView(id, gen); }
      finally { if (rtReadCurrent(id, gen) && ui.rt.busy === "archive") ui.rt.busy = ""; }
      if (!rtReadCurrent(id, gen)) return;
    }
    const s = ui.rt.view && ui.rt.view.session;
    const idle = !!s && !["creating", "running", "waiting-input", "stopping"].includes(s.status) && !(s.turns || []).some((t) => t.status === "queued");
    // 与普通快捷回复同口径：只有明确核对失败（false）才拦；首次渲染还没核对过时照常执行。
    if (ui.rt.statusConfirmed === false || !idle || s.conflict || s.archived || s.bindingRevision !== revision || rtLastAssistantKey() !== key) {
      rtRenderSoft();
      announce(ui.rt.statusConfirmed === false ? "会话状态核对失败，快捷回复未归档" : "会话已有更新，快捷回复未归档");
      return;
    }
    await rtArchive({ id, title: s.title, archived: false, runtimeKind: s.runtimeKind }, true);
    // rtArchive 自己会显示失败原因；失败时留在会话里，推荐胶囊还在，可以重试。
    // 归档成功后 rtArchive 已经按端离开了这个会话（手机回列表 / PC 打开列表最新一条）
  } finally {
    rtQuickBusyEnd(id, key, text);
    if (rtReadCurrent(id, gen)) rtRenderSoft();
  }
}

/**
 * 重新进入会话时先显示缓存画面，状态核对完成前写操作都禁用；快捷回复不跟着变灰：
 * 点击时若尚未核对，就先核对，最后一条助手消息与会话版本都没变才发送（服务端仍按 expectedRevision 把关）。
 */
async function rtQuickReplyClick(id, key, revision, text, send) {
  if (ui.rt.statusConfirmed !== false) return send(text);
  if (ui.rt.busy) return;
  const gen = ui.rt.gen;
  // 重新进入会话后还没核对状态：等待核对期间也要看得出这条已经点上了。
  ui.rt.busy = "send"; rtQuickBusyStart(id, key, text); rtRenderSoft();
  try { await rtLoadView(id, gen); }
  finally { if (rtReadCurrent(id, gen) && ui.rt.busy === "send") ui.rt.busy = ""; }
  if (!rtReadCurrent(id, gen)) { rtQuickBusyEnd(id, key, text); return; }
  const s = ui.rt.view?.session;
  const idle = !!s && !["creating", "running", "waiting-input", "stopping"].includes(s.status) && !(s.turns || []).some((t) => t.status === "queued");
  if (ui.rt.statusConfirmed !== true || !idle || s.conflict || s.archived || s.bindingRevision !== revision || rtLastAssistantKey() !== key) {
    rtQuickBusyEnd(id, key, text);
    rtRenderSoft();
    announce(ui.rt.statusConfirmed === true ? "会话已有更新，快捷回复未发送" : "会话状态核对失败，快捷回复未发送");
    return;
  }
  rtQuickBusyEnd(id, key, text);
  return send(text);
}

function rtSide() {
  const v = ui.rt.view;
  if (!v) return h("aside", { class: "rt-side", id: "rt-session-info", hidden: ui.rt.sideCollapsed });
  return h("aside", { class: "rt-side", id: "rt-session-info", hidden: !rtPhone.matches && ui.rt.sideCollapsed, "aria-label": "会话信息", onkeydown: rtInfoKeydown },
    h("div", { class: "rt-info-head" }, h("strong", {}, "会话详情"), h("button", { type: "button", class: "btn small rt-info-close", "aria-label": "关闭会话详情", onclick: () => rtSetInfoOpen(false) }, "关闭")), rtInfo(v));
}

/** 会话 / 平台 ID 只展示头尾各 3 位：完整值靠 title 与复制按钮，避免撑破一行 */
function rtShortId(id) {
  const text = String(id ?? "");
  return text.length > 8 ? `${text.slice(0, 3)}…${text.slice(-3)}` : text;
}

/** 一行 ID：中间截断 + 紧凑复制按钮，最多占一行 */
function rtIdRow(id, label) {
  const text = String(id ?? "");
  return h("span", { class: "rt-id" },
    h("span", { class: "rt-id-text mono small", title: text }, rtShortId(text)),
    rtCopyButton(text, "复制", { class: "rt-id-copy", title: `复制${label}`, ariaLabel: `复制${label}`, announce: `已复制${label}` }));
}

/** 会话提示里的关联待办：展示那次发起对话引用的记录，并可就地标记完成、跳转查看。 */
function rtLinkedNoteNotice(item) {
  const note = item.note;
  const busy = !!ui.rt.linkedNoteBusy;
  const done = !!note?.done;
  const stamp = (iso) => typeof noteStamp === "function" ? noteStamp(iso) : iso;
  return h("div", { class: "rt-notice-item rt-linked-note", role: "status", "data-note-id": item.noteId },
    h("strong", {}, "待办"),
    item.loading ? h("p", { class: "muted small", role: "status" }, "正在读取待办记录…")
      : !note ? h("p", { class: "muted small", role: "status" }, "关联的待办记录已被删除。")
        : h("div", { class: `rt-linked-note-body${done ? " done" : ""}` },
            h("div", { class: "rt-linked-note-main" },
              note.text ? h("p", { class: "rt-linked-note-text" }, note.text) : null,
              note.schedule && typeof noteScheduleLabel === "function" ? h("p", { class: "muted small" }, `日程：${noteScheduleLabel(note.schedule)}`) : null,
              typeof noteImageStrip === "function" ? noteImageStrip(note.images || []) : null,
              h("p", { class: "muted small" }, `记于 ${stamp(note.createdAt)}`, done && note.doneAt ? ` · 已完成 ${stamp(note.doneAt)}` : ""))),
    ui.rt.linkedNoteError ? h("p", { class: "field-error", role: "alert" }, ui.rt.linkedNoteError) : null,
    h("div", { class: "rt-notice-actions" },
      note ? h("button", { type: "button", class: "btn small", disabled: busy, onclick: () => void rtToggleLinkedNote(note) }, done ? "取消完成" : "标记完成") : null,
      h("button", { type: "button", class: "btn small", onclick: () => rtViewLinkedNote(item.noteId) }, "查看")));
}

function rtLinkedRecommendationNotice(item) {
  const ref = item.ref;
  return h('div', { class: 'rt-notice-item' }, h('strong', {}, `推荐任务 · ${ref.title} · ${ref.sources.length} 条待办`),
    h('p', { class: 'muted small' }, `启动时修订 ${ref.revision}`),
    h('details', { open: !!ui.rt.recommendationNoticeOpen, ontoggle: e => { ui.rt.recommendationNoticeOpen = e.target.open; } }, h('summary', {}, '启动时需求与来源'),
      h('p', { class: 'note-text' }, ref.requirement),
      item.loading ? h('p', { class: 'muted small' }, '正在核对来源状态…') : null,
      ui.rt.linkedNoteError ? h('p', { class: 'error' }, `来源状态暂不可用：${ui.rt.linkedNoteError}`) : null,
      ...ref.sources.map(source => {
        const note = item.notes?.find(n => n.id === source.noteId);
        const changed = note && (note.text !== source.text || JSON.stringify((note.images || []).map(i => i.id)) !== JSON.stringify(source.imageIds || []));
        const status = item.loading || !item.notes ? '状态待核对' : !note ? '已删除' : `${note.done ? '已完成' : '未完成'}${changed ? ' · 来源有更新' : ''}`;
        return h('div', { class: 'note-iteration-source' }, h('p', {}, source.text || '图片需求'), h('p', { class: 'muted small' }, `待办 · ${status}`), note ? h('button', { class: 'btn small', onclick: () => rtViewLinkedNote(source.noteId) }, '查看待办') : null,
          changed && note ? h('button', { class: 'btn small', onclick: () => { const id = rtId(); const prompt = `来源待办有更新（${source.noteId}）：\n${note.text}\n请结合当前迭代判断影响。`; const old = ui.rt.drafts[id] ?? rtImageDraft(id).text ?? ''; ui.rt.drafts[id] = `${old}${old ? '\n\n' : ''}${prompt}`; rtSaveImageDraft(id, ui.rt.drafts[id]); ui.rt.sendKey = null; rtToggleRecommendation(false); rtRenderSoft(); void noteCopyImages(note.images || [], id); } }, '将更新加入输入框') : null);
      })),
    h('button', { class: 'btn small', onclick: () => { ui.notesTab = 'recommended'; ui.noteIterationFilter = 'all'; ui.notesFocusIteration = ref.taskId; rtToggleRecommendation(false); location.hash = '#/notes'; } }, '查看推荐任务'));
}

/** 会话详情里直接标记 / 撤销关联待办的完成状态 */
async function rtToggleLinkedNote(note) {
  if (ui.rt.linkedNoteBusy) return;
  const id = rtId();
  ui.rt.linkedNoteBusy = true; ui.rt.linkedNoteError = "";
  rtRenderSoft();
  try {
    const updated = await api(`/api/notes/${encodeURIComponent(note.id)}`, { method: "PATCH", body: JSON.stringify({ done: !note.done }) });
    invalidateReads((key) => key === "/api/notes" || key.startsWith("/api/notes?"));
    if (ui.view === "rt" && rtId() === id) ui.rt.linkedNote = updated;
  } catch (e) {
    if (ui.view === "rt" && rtId() === id) ui.rt.linkedNoteError = e.message;
  } finally {
    ui.rt.linkedNoteBusy = false;
    if (ui.view === "rt" && rtId() === id) rtRenderSoft();
  }
}

/** 统计卡片的 token 数值压缩：≥1 万取整用「万」/「亿」；1 千～1 万保留一位小数万；不足 1 千直接给原数（否则会显示成 0.0 万，看起来像 0）。 */
function rtTokenNum(n) {
  if (typeof n !== "number") return "未知";
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${Math.round(n / 1e8)}亿`;
  if (abs >= 1e4) return `${Math.round(n / 1e4)}万`;
  if (abs < 1e3) return n.toLocaleString();
  return `${(n / 1e4).toFixed(1)}万`;
}

function rtPatchUsageViews() {
  const v = ui.rt.view;
  if (!v || !rtUsageVisible()) return;
  const old = document.querySelector('.rt-side .rt-usage-card');
  if (old && rtInfoPanelOpen()) {
    const next = rtInfo(v).querySelector('.rt-usage-card');
    if (old.querySelector('details')?.open && next.querySelector('details')) next.querySelector('details').open = true;
    old.replaceWith(next);
  }
}
/** 用量读取状态：跟在标题右边的一小段行内文字，不单独占一行（插入/移除整行会让下面的内容上下跳动）。
 *  已有本会话快照时是「更新中…」，首次是「读取中…」；失败给「读取失败 · 重试」，完整原因放悬停提示。 */
function rtUsageReadStatus() {
  if (ui.rt.sessionUsageError) return h('span',{class:'rt-usage-status error',role:'alert',title:ui.rt.sessionUsageError},'读取失败',h('button',{type:'button',class:'rt-usage-retry',onclick:()=>void rtLoadVisibleUsage(true)},'重试'));
  if (!ui.rt.sessionUsageLoading) return null;
  const refreshing = ui.rt.usageFor === ui.rt.view?.session?.platformSessionId && !!ui.rt.view?.usage;
  return h('span',{class:'rt-usage-status',role:'status'},refreshing ? '更新中…' : '读取中…');
}
let rtMemoryDialog = null;

let rtFactDialog=null;
const RT_FACT_LABELS={accepted:'接受',replaced:'替换',duplicate:'去重',stale:'过时',conflict:'冲突',rejected:'拒绝',needs_verification:'待核实',unstructured:'未结构化'};
function rtCloseFactAuditDialog(restore=true){if(!rtFactDialog)return;const state=rtFactDialog;rtFactDialog=null;state.controller?.abort();state.dialog.close();state.dialog.remove();if(restore&&rtId()===state.id&&ui.rt.gen===state.gen)(state.opener?.isConnected?state.opener:document.querySelector('.rt-fact-open'))?.focus({preventScroll:true});}
function rtOpenFactAuditDialog(){
 if(rtFactDialog)rtCloseFactAuditDialog(false);
 const dialog=h('dialog',{class:'rt-memory-dialog rt-fact-dialog','aria-label':'本会话记忆校验记录'}),state={id:rtId(),gen:ui.rt.gen,dialog,opener:document.activeElement,items:[],nextCursor:null,loading:false,result:''};rtFactDialog=state;
 const note=h('p',{class:'muted small',role:'status'},'读取中…'),body=h('div',{class:'rt-memory-dialog-body'}),filter=h('select',{'aria-label':'筛选判定',onchange:e=>{state.result=e.target.value;state.items=[];state.nextCursor=null;void rtLoadFactAudit(state);}},h('option',{value:''},'全部判定'),...Object.entries(RT_FACT_LABELS).map(([key,label])=>h('option',{value:key},label)));
 dialog.append(h('header',{},h('h2',{},'记忆校验记录'),h('button',{type:'button',class:'btn',autofocus:true,onclick:()=>rtCloseFactAuditDialog()},'关闭')),filter,note,body);
 state.note=note;state.body=body;dialog.addEventListener('cancel',e=>{e.preventDefault();rtCloseFactAuditDialog();});document.body.append(dialog);dialog.showModal();void rtLoadFactAudit(state);
}
async function rtLoadFactAudit(state,more=false){
 if(rtFactDialog!==state)return;state.controller?.abort();const controller=new AbortController();state.controller=controller;state.loading=true;
 const current=()=>rtFactDialog===state&&state.controller===controller&&ui.view==='rt'&&rtId()===state.id&&ui.rt.gen===state.gen;
 try{const params=new URLSearchParams();if(more&&state.nextCursor)params.set('before',state.nextCursor);if(state.result)params.set('result',state.result);
 const page=await api(`/api/runtime-sessions/${encodeURIComponent(state.id)}/memory-fact-decisions?${params}`,{signal:controller.signal});if(!current())return;
 state.items=more?[...state.items,...page.items]:page.items;state.nextCursor=page.nextCursor;
 state.note.textContent=!page.supported?'此运行时尚未启用结构化事实校验':page.health==='not-initialized'?'尚无事实账本':page.health==='degraded'?'存在待恢复或待核实事实，请检查提交状态':`${state.items.length} 条判定；每条记录说明是否实际提交。`;
 const show=value=>value===undefined?'未记录':typeof value==='string'?value:JSON.stringify(value,null,2);
 const field=(name,value)=>h('div',{class:'rt-fact-field'},h('strong',{},name),h('pre',{},show(value)));
 const rows=state.items.map(d=>h('details',{'data-fact-decision':d.id},h('summary',{},`${RT_FACT_LABELS[d.decision.kind]||d.decision.kind} · ${d.candidate?.subject||'普通记忆'} · ${d.decision.reasonCode} · ${rtTime(d.at)}`),field('事实',d.candidate?.predicate),field('旧值',d.previous?.fact?.value),field('新值',d.candidate?.value),field('证据引用',d.candidate?.evidenceRef),field('证据摘要',d.evidence?{sourceId:d.evidence.sourceId,sequence:d.evidence.sequence,observedAt:d.evidence.observedAt,expiresAt:d.evidence.expiresAt,hash:d.evidence.sourceHash}:undefined),field('规则',d.decision.ruleVersion),field('来源会话',d.origin?.platformSessionId),field('触发节点',d.origin?.trigger),field('提交状态',d.state),field('提交 ID',d.commitId),h('button',{type:'button',class:'btn small',onclick:()=>navigator.clipboard?.writeText(show(d.candidate?.value)).catch(()=>{})},'复制新值')));
 state.body.replaceChildren(...rows,...(state.nextCursor?[h('button',{type:'button',class:'btn',onclick:()=>void rtLoadFactAudit(state,true)},'加载更早判定')]:[]));
 }catch(error){if(current()&&error.name!=='AbortError'){state.note.textContent='校验记录读取失败';if([401,403,404,410].includes(error.status)){state.items=[];state.body.replaceChildren();}state.body.append(h('button',{type:'button',class:'btn',onclick:()=>void rtLoadFactAudit(state)},'重试'));}}
 finally{if(current())state.loading=false;}
}

function rtCloseMemoryDialog(restore = true) {
  if (!rtMemoryDialog) return;
  const {dialog,id,gen,selected} = rtMemoryDialog;rtMemoryDialog = null;
  dialog.close();dialog.remove();
  if (restore && rtId() === id && ui.rt.gen === gen) {
    const entry=selected && [...document.querySelectorAll('.rt-memory-card details')].find(el=>el.dataset.memoryEvent===selected)?.querySelector('summary');
    (entry?.getClientRects().length ? entry : document.querySelector('.rt-memory-toggle'))?.focus({preventScroll:true});
  }
}
/* ---------- 搜索 / 抓取记录（和记忆共用一张卡片的另一个 tab） ---------- */
const RT_WEB_KINDS = {search:'搜索', fetch:'抓取'};
const RT_WEB_STATUS = {failed:'失败', running:'进行中'};
const RT_WEB_ICONS = {
  search:'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  fetch:'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm6.93 6h-2.95a15.65 15.65 0 0 0-1.38-3.56A8.03 8.03 0 0 1 18.92 8zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2 0 .68.06 1.34.14 2H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56A7.987 7.987 0 0 1 5.08 16zm2.95-8H5.08a7.987 7.987 0 0 1 4.33-3.56A15.65 15.65 0 0 0 8.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66c-.09-.66-.16-1.32-.16-2 0-.68.07-1.35.16-2h4.68c.09.65.16 1.32.16 2 0 .68-.07 1.34-.16 2zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a8.03 8.03 0 0 1-4.33 3.56zM16.36 14c.08-.66.14-1.32.14-2 0-.68-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38z'
};
/** 本会话已读到的搜索 / 抓取记录，新的在前。 */
function rtWebItems() {
  const state = ui.rt.web;
  return state && state.id === rtId() ? [...state.items || []].sort((a,b)=>b.seq-a.seq) : [];
}
function rtWebIcon(kind) {
  const icon=h('span',{class:'rt-memory-kind',role:'img','aria-label':RT_WEB_KINDS[kind],title:kind === 'search' ? '搜索：用关键字联网查资料' : '抓取：读取一个网页'});
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
  const path=document.createElementNS('http://www.w3.org/2000/svg','path');
  path.setAttribute('d',RT_WEB_ICONS[kind]);svg.append(path);icon.append(svg);return icon;
}
function rtWebLink(url) {
  return /^https?:\/\//i.test(url || '') ? h('a',{href:url,target:'_blank',rel:'noopener noreferrer'},url) : (url || null);
}
function rtWebEntry(item, preview = false) {
  const search=item.kind === 'search', label=RT_WEB_KINDS[item.kind] || item.kind, state=RT_WEB_STATUS[item.status];
  const title=search ? item.query || '关键字未记录' : item.title || item.url || item.note || '网址未记录';
  const action=state ? `${label} · ${state}` : label;
  const row=h('details',{class:`rt-memory-entry web ${item.kind} ${item.status}`,'data-memory-event':item.key},
    h('summary',{},h('span',{class:'rt-memory-meta'},rtWebIcon(item.kind),h('span',{class:'rt-memory-action',title:action},action),
      item.occurredAt ? h('time',{'data-rt-memory-at':item.occurredAt,datetime:item.occurredAt,title:rtTime(item.occurredAt)},rtAgo(item.occurredAt)) : null),
      h('span',{class:'rt-memory-title',title},title)));
  if (preview) {
    row.querySelector('summary').setAttribute('aria-haspopup','dialog');
    row.querySelector('summary').addEventListener('click',event=>{event.preventDefault();rtOpenMemoryDialog(item.key,'web');});
    return row;
  }
  const field=(name,value)=>value ? h('div',{class:'rt-memory-field'},h('dt',{},name),h('dd',{},value)) : null;
  row.append(h('dl',{class:'rt-memory-fields'},
    field('类型',search ? '联网搜索' : '网页抓取'),
    search ? field('搜索关键字',item.query || '未记录') : field('网址',rtWebLink(item.url) || '未记录'),
    !search ? field('网页标题',item.title) : null,
    search && item.resultCount !== undefined ? field('结果数量',`${item.resultCount} 条`) : null,
    item.results?.length ? field(`前 ${item.results.length} 条结果`,h('ol',{class:'rt-web-results'},...item.results.map(r=>h('li',{},h('span',{},r.title),h('br'),rtWebLink(r.url))))) : null,
    field('状态',item.status === 'failed' ? '失败' : item.status === 'running' ? '进行中' : '已完成'),
    field(item.status === 'failed' ? '失败原因' : !search ? '读取说明' : '备注',item.note),
    item.occurredAt ? field('时间',rtTime(item.occurredAt)) : null,
    field('调用工具',item.tool),
    item.turnNo !== undefined ? field('所在轮次',`第 ${item.turnNo} 轮`) : null));
  return row;
}
/** 本会话里平台公共记忆的两类记录：首轮注入（正文）+ 之后对按需索引的查阅。Pi / Codex / Claude 自己的私有记忆不在这里显示。 */
function rtInjectionState() {
  const state = ui.rt.injection;
  return state && state.id === rtId() ? state : null;
}
function rtInjectionItems() {
  const state = rtInjectionState();
  return state ? [...state.items || []].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)) : [];
}
function rtLookupItems() {
  const state = rtInjectionState();
  return state ? [...state.lookups || []].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)) : [];
}
function rtCheckItems() {
  const state = rtInjectionState();
  return state ? [...state.checks || []].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)) : [];
}
const RT_CHECK_PHASE = {passed:'通过', failed:'未通过 · 已反馈', exhausted:'仍未通过', skipped:'未检查'};
/** 校验记录的图标：盾牌 + 对勾（通过）/ 感叹号（没做到）。 */
function rtCheckIcon(phase) {
  const icon=h('span',{class:'rt-memory-kind',role:'img','aria-label':'强约束校验','title':'强约束校验：每轮结束后平台检查强约束记忆有没有做到'});
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
  const path=document.createElementNS('http://www.w3.org/2000/svg','path');
  path.setAttribute('d',phase === 'passed' ? 'M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z' : 'M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm1 15h-2v-2h2v2zm0-4h-2V7h2v5z');
  svg.append(path);icon.append(svg);return icon;
}
/** 一次强约束校验：卡片里一句话（与时间线通知相同），点开看每条规则的检查项、问题和给模型的改法。 */
function rtCheckEntry(item, preview = false) {
  const action = `校验${item.turnNo !== undefined ? ` · 第 ${item.turnNo} 轮` : ''} · ${RT_CHECK_PHASE[item.phase] || item.phase}`;
  const title = item.notice || `强约束校验：${item.rules.map(r => `「${r.topic}」`).join('、')}`;
  const row=h('details',{class:`rt-memory-entry platform check ${item.phase}`,'data-memory-event':item.key},
    h('summary',{},h('span',{class:'rt-memory-meta'},rtCheckIcon(item.phase),h('span',{class:'rt-memory-scope platform',title:'平台公共记忆'},'平台记忆'),h('span',{class:'rt-memory-action',title:action},action),h('time',{'data-rt-memory-at':item.at,datetime:item.at,title:rtTime(item.at)},rtAgo(item.at))),
      h('span',{class:'rt-memory-title',title},title)));
  if (preview) {
    row.querySelector('summary').setAttribute('aria-haspopup','dialog');
    row.querySelector('summary').addEventListener('click',event=>{event.preventDefault();rtOpenMemoryDialog(item.key);});
    return row;
  }
  const field=(label,value)=>h('div',{class:'rt-memory-field'},h('dt',{},label),h('dd',{},value || '未记录'));
  row.append(h('dl',{class:'rt-memory-fields'},
    field('结果',item.phase === 'passed' ? '通过' : item.phase === 'skipped' ? '本轮没有触发这条规则，平台没有检查' : item.phase === 'failed' ? `未通过，已把怎么改的反馈发给模型（第 ${item.attempt + 1} 次）` : `仍未通过，已提醒 ${item.attempt} 次，不再自动提醒`),
    ...item.rules.map(r=>h('div',{class:'rt-memory-field rt-check-rule'},h('dt',{},r.title),h('dd',{},
      h('div',{class:'rt-check-topic'},`记忆「${r.topic}」：${r.statement}`),
      r.note ? h('div',{class:'rt-check-note'},h('strong',{},'原因：'),r.note) : null,
      r.problem ? h('div',{class:'rt-check-problem'},h('strong',{},'问题：'),r.problem) : null,
      r.fix ? h('div',{class:'rt-check-fix'},h('strong',{},'给模型的改法：'),h('pre',{class:'rt-injection-text'},r.fix)) : null))),
    item.turnNo !== undefined ? field('所在轮次',`第 ${item.turnNo} 轮`) : null,
    field('校验时间',rtTime(item.at)),
    field('平台会话 ID',h('a',{class:'rt-session-id',href:`#/rt/${encodeURIComponent(rtId())}`,title:`打开会话 ${rtId()}`,onclick:()=>rtCloseMemoryDialog(true)},rtId()))));
  return row;
}
function rtInjectionIcon() {
  const icon=h('span',{class:'rt-memory-kind',role:'img','aria-label':'平台载入','title':'平台载入：平台在派发时代补进提示词的正文'});
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
  const path=document.createElementNS('http://www.w3.org/2000/svg','path');
  path.setAttribute('d','M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z');svg.append(path);icon.append(svg);return icon;
}
/** 一条平台注入：卡片里只显示与中心区时间线相同的那句话，点开看当时实际注入的正文。 */
function rtInjectionEntry(item, preview = false) {
  const action = item.turnNo !== undefined ? `载入 · 第 ${item.turnNo} 轮` : '载入';
  const title = item.notice || `${item.label}：${item.count} 条`;
  const row=h('details',{class:'rt-memory-entry platform','data-memory-event':item.key},
    h('summary',{},h('span',{class:'rt-memory-meta'},rtInjectionIcon(),h('span',{class:'rt-memory-scope platform',title:item.label},'平台记忆'),h('span',{class:'rt-memory-action',title:action},action),h('time',{'data-rt-memory-at':item.at,datetime:item.at,title:rtTime(item.at)},rtAgo(item.at))),
      h('span',{class:'rt-memory-title',title},title)));
  if (preview) {
    row.querySelector('summary').setAttribute('aria-haspopup','dialog');
    row.querySelector('summary').addEventListener('click',event=>{event.preventDefault();rtOpenMemoryDialog(item.key);});
    return row;
  }
  const field=(label,value)=>h('div',{class:'rt-memory-field'},h('dt',{},label),h('dd',{},value || '未记录'));
  row.append(h('dl',{class:'rt-memory-fields'},
    field('动作',`${item.label} · 会话首轮载入`),
    item.count ? field('常驻注入',`${item.count} 条`) : null,
    item.onDemand !== undefined ? field('按需索引',`${item.onDemand} 条（只给指针，模型按需查阅）`) : null,
    item.rules?.length ? field('登记的强约束检查',h('ul',{class:'rt-check-rules'},...item.rules.map(r=>h('li',{},`「${r.topic}」→ ${r.title}`)))) : null,
    field('正文长度',`${item.chars} 字`),
    item.turnNo !== undefined ? field('所在轮次',`第 ${item.turnNo} 轮`) : null,
    field('注入时间',rtTime(item.at)),
    field('平台会话 ID',h('a',{class:'rt-session-id',href:`#/rt/${encodeURIComponent(rtId())}`,title:`打开会话 ${rtId()}`,onclick:()=>rtCloseMemoryDialog(true)},rtId())),
    h('div',{class:'rt-memory-field'},h('dt',{},'注入内容'),h('dd',{},h('pre',{class:'rt-injection-text'},item.text)))));
  return row;
}
const RT_LOOKUP_KINDS = {map:'目录', catalog:'条目列表', details:'条目详情', api:'接口'};
function rtLookupIcon() {
  const icon=h('span',{class:'rt-memory-kind',role:'img','aria-label':'按需查阅','title':'按需查阅：会话里读了公共记忆索引'});
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
  const path=document.createElementNS('http://www.w3.org/2000/svg','path');
  path.setAttribute('d','M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5C21.27 7.61 17 4.5 12 4.5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z');svg.append(path);icon.append(svg);return icon;
}
/** 一处查阅的说法：读取 · 目录 / 检索 · 条目列表 / 查看详情 / 检索 · 接口。 */
function rtLookupOpAction(op) {
  if (op.kind === 'details' && op.ids?.length) return '查看详情';
  return `${op.how === 'search' ? '检索' : '读取'} · ${RT_LOOKUP_KINDS[op.kind] || op.kind}`;
}
const rtLookupQueries = item => [...new Set(item.ops.map(op => op.query).filter(Boolean))];
/** 这次查阅查到的条目：优先用当时工具输出里还原的内容（模型实际看到的）；按编号看详情但输出被截断时，退回按编号取当前条目。 */
function rtLookupRecalled(item) {
  const current = rtInjectionState()?.entries || {};
  const shown = (item.recalled || []).map(r => ({id:r.id, tier:r.tier, scope:r.scope, text:r.text}));
  for (const id of new Set(item.ops.flatMap(op => op.ids || []))) {
    if (shown.some(r => r.id.startsWith(id) || id.startsWith(r.id))) continue;
    const hit = current[id];
    shown.push({id, scope:hit?.scope, text:hit?.text || '', missing:!hit, now:true});
  }
  return shown;
}
function rtLookupTitle(item) {
  const queries = rtLookupQueries(item), rec = rtLookupRecalled(item), total = Math.max(item.recalledTotal || 0, rec.filter(r => !r.now).length);
  const byId = item.ops.some(op => op.ids?.length);
  if (queries.length) return `${queries.map(q => `「${q}」`).join('')} · 命中 ${total} 条`;
  if (byId && rec.some(r => r.text)) return rec.filter(r => r.text).map(r => r.text).join('；');
  if (byId) return `条目 ${[...new Set(item.ops.flatMap(op => op.ids || []))].join('、')}`;
  if (total) return `整份读取 · ${total} 条：${rec[0].text}`;
  const kind = item.ops[0].kind;
  return kind === 'map' ? '主题目录（各模块条数）' : kind === 'api' ? '索引接口' : '公共记忆索引';
}
/** 一条查阅记录：卡片里只显示一句话（检索词 / 查到的内容），点开看查了什么、模型实际收到哪些条目、命令原文。 */
function rtLookupEntry(item, preview = false) {
  const first = item.ops[0], more = item.ops.length > 1 ? ` 等 ${item.ops.length} 处` : '';
  const action = `${rtLookupOpAction(first)}${more}`, title = rtLookupTitle(item);
  const row=h('details',{class:'rt-memory-entry platform lookup','data-memory-event':item.key},
    h('summary',{},h('span',{class:'rt-memory-meta'},rtLookupIcon(),h('span',{class:'rt-memory-scope platform',title:'平台公共记忆'},'平台记忆'),h('span',{class:'rt-memory-action',title:action},action),h('time',{'data-rt-memory-at':item.at,datetime:item.at,title:rtTime(item.at)},rtAgo(item.at))),
      h('span',{class:'rt-memory-title',title},title)));
  if (preview) {
    row.querySelector('summary').setAttribute('aria-haspopup','dialog');
    row.querySelector('summary').addEventListener('click',event=>{event.preventDefault();rtOpenMemoryDialog(item.key);});
    return row;
  }
  const field=(label,value)=>h('div',{class:'rt-memory-field'},h('dt',{},label),h('dd',{},value || '未记录'));
  const queries = rtLookupQueries(item), rec = rtLookupRecalled(item), more2 = Math.max(0, (item.recalledTotal || 0) - (item.recalled?.length || 0));
  const isResult = op => op.how === 'search' || (op.ids?.length || 0) > 0;
  const hasResultOp = item.ops.some(isResult);
  const recalled = rec.length
    ? h('div',{class:'rt-lookup-entries'},...rec.map(r=>h('div',{class:'rt-lookup-entry'},
        h('div',{class:'rt-lookup-entry-meta'},h('code',{},r.id),r.tier ? h('span',{class:`rt-lookup-tier ${r.tier === '常驻' ? 'resident' : 'ondemand'}`},r.tier) : null,r.scope ? h('span',{class:'muted small'},r.scope) : null),
        h('div',{class:'rt-lookup-entry-text'},r.missing ? '当前条目里已找不到这个编号' : r.text),
        r.now ? h('div',{class:'muted small'},'输出里没有这条的内容，这里是按编号取的当前内容') : null)),
        more2 ? h('div',{class:'muted small'},`另有 ${more2} 条未显示`) : null)
    : h('span',{class:'muted'},item.ops.every(op => op.kind === 'map') ? '读的是主题目录，只有各模块的条数，没有具体条目' : hasResultOp ? '没有返回条目（没有命中，或输出无法识别）' : '输出里没有可识别的条目（可能被截断）');
  const total = Math.max(item.recalledTotal || 0, rec.length);
  row.append(h('dl',{class:'rt-memory-fields'},
    field('检索词',queries.length ? queries.map(q=>`「${q}」`).join('') : '无（整份读取）'),
    field('查阅方式',h('div',{class:'rt-lookup-ops'},...item.ops.map(op=>h('div',{},rtLookupOpAction(op),op.query ? `（「${op.query}」）` : '')))),
    field(`${hasResultOp ? '查询结果' : '返回的条目'}${rec.length ? `（${total} 条）` : ''}`,h('div',{},recalled,item.alsoRead ? h('div',{class:'muted small rt-lookup-note'},'同一条命令里还整份读取了条目列表，那部分不在查询结果里，见下方命令') : null)),
    field('命令 / 路径',h('pre',{class:'rt-lookup-command'},item.command)),
    field('调用工具',item.tool),
    item.turnNo !== undefined ? field('所在轮次',`第 ${item.turnNo} 轮`) : null,
    field('查阅时间',rtTime(item.at))));
  return row;
}
/** 记忆卡片里的条目：平台首轮注入 + 对按需索引的查阅。弹窗按时间倒序（新的在前）；卡片里注入固定排在最上面——
 *   它是最早的一条，按时间排会被后面的查阅挤出可见区（卡片有高度上限），而它正是用户最常要看的那一条。 */
function rtMemoryRows(preview) {
  const injections=rtInjectionItems().map(item=>({at:Date.parse(item.at)||0,make:()=>rtInjectionEntry(item,preview)}));
  const lookups=rtLookupItems().map(item=>({at:Date.parse(item.at)||0,make:()=>rtLookupEntry(item,preview)}));
  const checks=rtCheckItems().map(item=>({at:Date.parse(item.at)||0,make:()=>rtCheckEntry(item,preview)}));
  const later=[...lookups,...checks];
  const rows=preview?[...injections,...later.sort((a,b)=>b.at-a.at)]:[...injections,...later].sort((a,b)=>b.at-a.at);
  return rows.map(row=>row.make());
}
function rtPatchMemoryDialog(selected) {
  if (!rtMemoryDialog) return;
  const which = rtMemoryDialog.which;
  const visible = which === 'web' ? rtWebVisible() : rtMemoryVisible();
  if (ui.view !== 'rt' || rtId() !== rtMemoryDialog.id || ui.rt.gen !== rtMemoryDialog.gen || !visible) {rtCloseMemoryDialog(false);return;}
  const {dialog} = rtMemoryDialog, body = dialog.querySelector('.rt-memory-dialog-body'), state = rtInjectionState();
  const opened = new Set([...body.querySelectorAll('details[open]')].map(el=>el.dataset.memoryEvent));
  const focused = document.activeElement?.closest('[data-memory-event]')?.dataset.memoryEvent, top=body.scrollTop;
  let list,note,extra;
  if (which === 'web') {
    const items=rtWebItems();
    list=h('div',{class:'rt-memory-timeline'},...items.map(item=>rtWebEntry(item)));
    note=`仅本会话：${items.length} 次联网调用。按时间倒序；展开查看关键字、网址与结果。`;
    extra=[ui.rt.web?.error ? h('p',{class:'error',role:'alert'},'读取失败',h('button',{type:'button',class:'btn',onclick:()=>void rtLoadVisibleWeb(true)},'重试')) : null];
  } else {
    const lookups=rtLookupItems(),injections=rtInjectionItems(),checks=rtCheckItems();
    list=h('div',{class:'rt-memory-timeline'},...rtMemoryRows(false));
    note=`仅本会话：${lookups.length} 次查阅${injections.length ? `、${injections.length} 次平台载入` : ''}${checks.length ? `、${checks.length} 次强约束校验` : ''}。按时间倒序；展开查看查了什么、返回了哪些条目${injections.length ? '与当时注入的正文' : ''}${checks.length ? '、校验结果与给模型的改法' : ''}。`;
    extra=[state?.error ? h('p',{class:'error',role:'alert'},'读取失败',h('button',{type:'button',class:'btn',onclick:()=>void rtLoadVisibleInjection(true)},'重试')) : null];
  }
  dialog.querySelector('.rt-memory-dialog-note').textContent=note;
  for (const row of list.querySelectorAll('details')) row.open = opened.has(row.dataset.memoryEvent) || selected === row.dataset.memoryEvent;
  body.replaceChildren(...[list,...extra].filter(Boolean));
  body.scrollTop=top;
  if (focused) [...body.querySelectorAll('details')].find(el=>el.dataset.memoryEvent===focused)?.querySelector('summary')?.focus({preventScroll:true});
  if (selected) [...body.querySelectorAll('details')].find(el=>el.dataset.memoryEvent===selected)?.scrollIntoView({block:'nearest'});
}
function rtOpenMemoryDialog(selected, which = 'memory') {
  if (rtMemoryDialog && rtMemoryDialog.which === which) {rtPatchMemoryDialog(selected);return;}
  if (rtMemoryDialog) rtCloseMemoryDialog(false);
  const name=which === 'web' ? '本会话搜索与抓取' : '本会话公共记忆';
  const dialog=h('dialog',{class:'rt-memory-dialog','aria-label':name},
    h('header',{},h('h2',{},name),h('button',{type:'button',class:'btn',autofocus:true,onclick:()=>rtCloseMemoryDialog()},'关闭')),
    h('p',{class:'muted small rt-memory-dialog-note'}),h('div',{class:'rt-memory-dialog-body'}));
  rtMemoryDialog={dialog,id:rtId(),gen:ui.rt.gen,selected,which};
  dialog.addEventListener('cancel',event=>{event.preventDefault();rtCloseMemoryDialog();});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)rtCloseMemoryDialog();}});
  document.body.append(dialog);dialog.showModal();rtPatchMemoryDialog(selected);
}
/** 卡片当前显示哪个 tab：用户点过的优先（须仍有内容），否则有记忆先看记忆，没有就看搜索抓取。 */
function rtCardTab(hasMemory, hasWeb) {
  if (ui.rt.cardTab === 'web' && hasWeb) return 'web';
  if (ui.rt.cardTab === 'memory' && hasMemory) return 'memory';
  return hasMemory ? 'memory' : 'web';
}
function rtMemoryCard(v) {
  const state=rtInjectionState();
  const supported=['pi','codex','claude-code'].includes(v.session.runtimeKind);
  // 平台公共记忆放同一张卡片的「公共记忆」tab：首轮注入 + 之后对按需索引的查阅（私有记忆不在这里）
  const injections=supported?rtInjectionItems():[],lookups=supported?rtLookupItems():[],checks=supported?rtCheckItems():[];
  const hasMemory=supported&&(!!state?.error||injections.length>0||lookups.length>0||checks.length>0);
  const webItems=rtWebItems(),hasWeb=webItems.length>0;
  if(!hasMemory&&!hasWeb)return null;
  const tab=rtCardTab(hasMemory,hasWeb),isWeb=tab==='web';
  const list=h('div',{class:'rt-memory-list'},...(isWeb?webItems.map(item=>rtWebEntry(item,true)):rtMemoryRows(true)));
  const toggle=h('button',{type:'button',class:'btn small rt-memory-toggle','aria-haspopup':'dialog',onclick:()=>rtOpenMemoryDialog(undefined,tab)},'更多');
  const memoryCount=lookups.length+injections.length+checks.length;
  const tabs=[hasMemory?['memory','公共记忆',memoryCount]:null,hasWeb?['web','搜索抓取',webItems.length]:null].filter(Boolean);
  const select=next=>{if(next===tab)return;ui.rt.cardTab=next;rtPatchMemoryCard();document.querySelector('.rt-memory-card [role=tab][aria-selected=true]')?.focus({preventScroll:true});};
  const tabbar=h('div',{class:'rt-memory-tabs',role:'tablist','aria-label':'本会话记录类型'},...tabs.map(([key,label,count],i)=>
    h('button',{type:'button',role:'tab','aria-selected':String(key===tab),tabindex:key===tab?'0':'-1','data-rt-card-tab':key,
      onclick:()=>select(key),
      onkeydown:e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)||tabs.length<2)return;e.preventDefault();const to=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;select(tabs[to][0]);}},
      label,count?h('span',{class:'rt-memory-tab-count'},String(count)):null)));
  const headCount=isWeb?`${webItems.length} 次调用`:`${lookups.length} 次查阅${injections.length ? ` · 载入 ${injections.length}` : ''}${checks.length ? ` · 校验 ${checks.length}` : ''}`;
  const headTitle=isWeb?'仅统计当前会话的搜索与抓取':'仅统计当前会话对平台公共记忆的首轮载入、按需查阅与强约束校验';
  const failed=isWeb?ui.rt.web?.error:state?.error;
  const retry=isWeb?()=>void rtLoadVisibleWeb(true):()=>void rtLoadVisibleInjection(true);
  const hasMore=false;
  const card=h('section',{class:'card rt-card rt-memory-card','aria-label':'本会话公共记忆与联网记录','data-rt-card-tab-active':tab},
    h('div',{class:'rt-card-head'},tabbar,h('span',{class:'muted small',title:headTitle},headCount)),list,
    failed ? h('p',{class:'error small',role:'alert'},'读取失败',h('button',{type:'button',class:'btn small',onclick:retry},'重试')) : null,toggle);
  const measure=()=>{
    if(!card.isConnected||!card.getClientRects().length)return;
    toggle.hidden=false;
    for(const row of list.children)row.hidden=false;
    const bottom=list.getBoundingClientRect().bottom;
    let overflow=false;
    for(const row of list.children){overflow=overflow||row.getBoundingClientRect().bottom>bottom+1;row.hidden=overflow;}
    // Preserve room for the control so resizing never oscillates at the height cap.
    toggle.style.visibility=overflow||hasMore?'visible':'hidden';
    toggle.disabled=!(overflow||hasMore);
  };
  card.rtMemoryMeasure=measure;requestAnimationFrame(measure);
  return card;
}
function rtPatchMemoryCard() {
  const side=document.querySelector('.rt-side .rt-info');
  if(side && ui.rt.view){
    const old=side.querySelector('.rt-memory-card'),next=rtMemoryCard(ui.rt.view);
    if(old){if(next)old.replaceWith(next);else old.remove();}
    else if(next)side.querySelector('.rt-usage-card')?.after(next);
  }
  rtPatchMemoryDialog();
}
function rtInfo(v) {
  const s = v.session;
  const u = v.usage || {totals:{},semantics:"打开会话详情后读取",coverage:"unknown"};
  const rl = v.rateLimit;
  // 账户额度放最上面：决定还能不能继续用，比会话元数据更常看（桌面上这张卡由 CSS 隐藏，改在输入操作区的账户胶囊显示；手机浮层仍保留完整卡片）
  // Pi 没有订阅额度窗口：显示这次所用模型服务（DeepSeek / OpenRouter…）的账户余额
  const quota = v.balances && v.balances.length
    ? h("section", { class: "card rt-card rt-quota-card" }, h("h3", {}, "账户余额"), rtBalances(v.balances))
    : h("section", { class: "card rt-card rt-quota-card" }, h("h3", {}, "账户额度"), rtQuotaContent(s.runtimeKind, rl, s.identityScopeId || rl?.identityScopeId || "unknown"));
  // 统一「输入」口径：Codex 原始 input 含缓存读取，这里拆成未缓存输入，与 Claude / Pi 可比
  const codexRawInput = s.runtimeKind === "codex";
  const inputTokens = u.totals?.input === undefined ? undefined : Math.max(0, u.totals.input - (codexRawInput ? (u.totals.cachedInput ?? 0) : 0));
  const usageSemantics = codexRawInput
    ? "Codex：输入为未缓存输入（原始 input 含缓存读取），缓存读取单列；输出包含推理输出；会话累计快照取最新值，不相加"
    : u.semantics;
  // 三个 runtime 用同一套指标、同一顺序：主指标只有输入 / 输出，其余四项（请求数 / 缓存读取 / 缓存写入 / 推理输出）弱化；
  // runtime 不回报的项写「—」（悬停说明），不再按 runtime 增减行，避免三种会话的卡片长得不一样
  const t = u.totals;
  const kindName = RT_KIND[s.runtimeKind] || s.runtimeKind;
  const missing = `${kindName} 不单独回报这一项`;
  const metric = (label, value, unit, title, cls = "rt-metric") => h("div", { class: cls },
    h("dt", title ? { title } : {}, label),
    h("dd", value === undefined ? { class: "rt-metric-na", title: missing } : {}, value === undefined ? "—" : value, value !== undefined && unit ? h("span", { class: "rt-metric-unit" }, unit) : null));
  const coverage = ({ complete: "完整", partial: "部分", unknown: "未知" })[u.coverage] || u.coverage;
  const usage = h("section", { class: "card rt-card rt-usage-card" },
    h("div", { class: "rt-card-head" }, h("div", { class: "rt-card-title" }, h("h3", {}, "本会话用量"), rtUsageReadStatus()), h("span", { class: `rt-card-tag${u.coverage === "complete" ? "" : " warn"}` }, `覆盖${coverage}`)),
    t && typeof (t.total ?? t.input) === "number"
      ? [
          // 重点只有输入 / 输出：两个大号数字并排，不加线框
          h("dl", { class: "rt-metrics" },
            metric("输入", rtTokenNum(inputTokens), "", "未缓存输入"),
            metric("输出", rtTokenNum(t.output))),
          // 其他字段弱化：小号灰字两列，不加线框
          h("dl", { class: "rt-metric-more" },
            metric("请求数", u.requestCount ? String(u.requestCount) : undefined, "次", "", "rt-metric-sm"),
            metric("缓存读取", t.cachedInput === undefined ? undefined : rtTokenNum(t.cachedInput), "", "", "rt-metric-sm"),
            metric("缓存写入", t.cacheCreation === undefined ? undefined : rtTokenNum(t.cacheCreation), "", "", "rt-metric-sm"),
            metric("推理输出", t.reasoningOutput === undefined ? undefined : rtTokenNum(t.reasoningOutput), "", "推理输出（含于输出）", "rt-metric-sm"))
        ]
      : h("p", { class: "muted" }, "未知（没有采集到，不是 0）"),
    u.subagentTotals ? h("p", { class: "rt-usage-sub small", title: "子 Agent 的用量单列，未计入上面的输入 / 输出" }, `子 Agent 另计：输入 ${rtTokenNum(u.subagentTotals.input)} · 输出 ${rtTokenNum(u.subagentTotals.output)}`) : null,
    // 口径说明三家各不相同且较长：收进「口径」，卡片底部只留采集时间
    h("div", { class: "rt-usage-foot" },
      h("span", {}, u.sampledAt ? `采集于 ${rtTime(u.sampledAt)}` : "尚未采集"),
      h("details", { class: "rt-usage-semantics" }, h("summary", {}, "口径"),
        h("p", {}, usageSemantics),
        u.notes && u.notes.length ? h("p", {}, u.notes.join("；")) : null)),
    rtUsageDetails(v));
  const sessionCard = h("section", { class: "card rt-card" }, h("h3", {}, "会话信息"),
    s.runtimeKind==='pi'?h('button',{type:'button',class:'btn small rt-fact-open',onclick:rtOpenFactAuditDialog},'校验记录'):null,
    h("dl", { class: "kv" },
      h("dt", {}, "运行时"), h("dd", {}, `${RT_KIND[s.runtimeKind]}${v.profile ? ` ${v.profile.binaryVersion || ""}${v.profile.sdkVersion ? `（SDK ${v.profile.sdkVersion}）` : ""}` : ""}`),
      h("dt", {}, "宿主机"), h("dd", {}, v.profile ? v.profile.hostLabel : "本机"),
      h("dt", {}, "请求模型"), h("dd", {}, s.requestedModel || "runtime 默认"),
      h("dt", {}, "实际模型"), h("dd", {}, s.effectiveModel ? `${s.effectiveModel}` : "未知", s.effectiveModelSource ? h("span", { class: "muted small" }, `（${s.effectiveModelSource}）`) : null),
      h("dt", {}, "推理强度"), h("dd", {}, s.effectiveEffort || s.requestedEffort || "runtime 默认",
        s.effectiveEffort ? h("span", { class: "muted small" }, `（${s.effectiveEffortSource || "runtime 回报"}）`) : s.requestedEffort ? h("span", { class: "muted small" }, "（请求值，runtime 未回报生效值）") : null),
      h("dt", {}, "权限模式"), h("dd", {}, s.permissionLabel),
      s.runtimeKind === "pi" ? h("dt", {}, "浏览器配置") : null,
      s.runtimeKind === "pi" ? h("dd", {}, ((ui.rt.profiles || []).find(p => p.runtimeKind === "pi")?.browserProfiles || []).find(p => p.id === s.browserProfileId)?.label || s.browserProfileId || "临时隔离") : null,
      h("dt", {}, "工作目录"), h("dd", { class: "mono small" }, rtShownWorkspace(s)),
      s.worktree ? h("dt", {}, "改动位置") : null,
      s.worktree ? h("dd", {}, `独立 worktree ${s.worktree.branch}（会话专属，可在会话页「提交并在空闲时部署」）`) : null,
      h("dt", {}, "原生会话 ID"), h("dd", {}, s.nativeSessionId ? rtIdRow(s.nativeSessionId, "原生会话 ID") : h("span", { class: "mono small" }, "尚未获得")),
      h("dt", {}, "平台 ID"), h("dd", {}, rtIdRow(s.platformSessionId, "平台 ID")),
      h("dt", {}, "观察"), h("dd", {}, RT_OBS[s.observation] || s.observation, ` · 覆盖 ${({ complete: "完整", partial: "部分", unknown: "未知" })[s.coverage] || s.coverage}`),
      h("dt", {}, "最后活动"), h("dd", {}, `${rtTime(s.lastActivityAt.at)}（${s.lastActivityAt.source === "runtime" ? "runtime 记录" : s.lastActivityAt.source === "history-file" ? "历史文件" : "平台记录"}）`)),
    v.notes && v.notes.length ? h("p", { class: "muted small" }, v.notes.join("；")) : null,
    rtSourceDetails(v));
  // 用量的查看频率高于会话元数据：排第二张卡
  return h("div", { class: "rt-info" }, quota, usage, rtMemoryCard(v), sessionCard);
}

/**
 * 「用量口径与各轮」：原来在桌面「用量」标签页里，标签取消后收进用量卡片，默认不展开。
 * 按模型 / 按轮次用短列表而不是表格：侧栏只有三百出头的宽度，表格会把三列挤成竖排或横向滑动。
 */
function rtUsageDetails(v) {
  const s = v.session;
  const usage = v.usage || { semantics: "正在读取用量…", totals: {} };
  return h("details", { class: "rt-more-details rt-usage-details" },
    h("summary", {}, "用量口径与各轮"),
    h("p", { class: "small" }, usage.semantics),
    h("ul", { class: "small" },
      h("li", {}, "累计快照取最新值，不把多次快照相加；只有带请求 ID 的单次用量才求和。"),
      h("li", {}, "缺失记为未知，不是 0；子 Agent 单独列出，不重复计入。"),
      h("li", {}, "账户额度是账户级窗口，不从 token 数反推订阅用了几成；不提供财务账单。")),
    usage.byModel && usage.byModel.length ? h("ul", { class: "rt-usage-models" }, usage.byModel.map((m) => h("li", {},
      h("span", { class: "mono small rt-usage-model" }, m.model),
      h("span", { class: "rt-usage-line small muted" }, `输入 ${rtNum(m.input)} · 缓存 ${rtNum(m.cachedInput)} · 输出 ${rtNum(m.output)}`)))) : null,
    h("p", { class: "muted small" }, `来源：${usage.sourceRef || "—"}`),
    s.turns && s.turns.length ? [h("h4", {}, "各轮"), h("ul", { class: "rt-usage-turns" }, s.turns.map((t) => h("li", {},
      h("span", { class: "rt-usage-turn-head" }, h("strong", {}, `第 ${t.turnNo} 轮`), ` · ${RT_TURN[t.status] || t.status}`),
      t.statusReason ? h("span", { class: "rt-usage-line small muted" }, t.statusReason) : null,
      h("span", { class: "rt-usage-line small muted" }, `${rtTime(t.startedAt)} → ${t.endedAt ? rtTime(t.endedAt) : "未结束"}`, t.nativeTurnId ? h("span", { class: "mono" }, ` · ${t.nativeTurnId}`) : null))))] : null);
}

/**
 * 「来源与身份」：原来在桌面「来源」标签页里，标签取消后收进会话信息卡片，默认不展开。
 * 运行环境、宿主机、工作目录等已经在上面的会话信息里，这里只留来源与身份独有的字段。
 */
function rtSourceDetails(v) {
  const s = v.session;
  return h("details", { class: "rt-more-details rt-source-details" },
    h("summary", {}, "来源与身份"),
    h("dl", { class: "kv" },
      h("dt", {}, "关系"), h("dd", {}, s.sourceMode === "platform-managed" ? "平台创建（runtime-native）：权限由原 runtime 与适配层处理，不冒充合约门禁" : "已发现的外部历史：只读，不进入任务状态机"),
      h("dt", {}, "身份空间"), h("dd", { class: "mono small" }, s.identityScopeId),
      h("dt", {}, "宿主机 ID"), h("dd", { class: "mono small" }, s.hostId),
      s.worktree ? [h("dt", {}, "worktree"), h("dd", { class: "small" }, h("span", { class: "mono" }, s.worktree.branch), s.worktree.baseRef && s.worktree.baseCommit ? ` · 从 ${s.worktree.baseRef} ${s.worktree.baseCommit.slice(0, 7)} 切出` : "", s.worktree.removedAt ? "（已在归档时删除）" : "")] : null,
      s.nativeParentSessionId ? [h("dt", {}, "父会话"), h("dd", { class: "mono small" }, s.nativeParentSessionId)] : null,
      h("dt", {}, "创建时间"), h("dd", {}, s.createdAt ? `${rtTime(s.createdAt.at)}（${s.createdAt.source === "platform" ? "平台记录" : s.createdAt.source}）` : "未知"),
      h("dt", {}, "绑定版本"), h("dd", {}, String(s.bindingRevision)),
      s.nativeFingerprint ? [h("dt", {}, "原生核对"), h("dd", { class: "small" }, `${s.nativeFingerprint.value} · ${rtTime(s.nativeFingerprint.checkedAt)}`)] : null),
    s.sourceMode === "platform-managed" && ui.rt.access && ui.rt.access.control ? h("div", { class: "rt-actions" },
      h("button", { type: "button", class: "btn small", onclick: async () => { try { const r = await api(`/api/runtime-sessions/${s.platformSessionId}/backfill`, { method: "POST", body: "{}" }); announce(`已从原生记录补读 ${r.added} 条`); await rtLoadMessages(s.platformSessionId, ui.rt.gen); renderMain(); } catch (e) { ui.rt.error = e.message; renderMain(); } } }, "从原生记录补读")) : null,
    v.resumeCommand ? h("section", { class: "rt-resume" },
      h("h4", {}, "在本机终端继续"),
      h("pre", { class: "rt-code" }, h("code", {}, v.resumeCommand)),
      h("div", { class: "rt-actions" },
        rtCopyButton(v.resumeCommand, "复制命令", { class: "btn small", announce: "已复制命令" }),
        s.nativeSessionId ? rtCopyButton(s.nativeSessionId, "复制原生 ID", { class: "btn small", announce: "已复制原生会话 ID" }) : null),
      h("p", { class: "muted small" }, s.sourceMode === "platform-managed"
        ? "在终端里续聊之后，平台下次续聊前会发现原生记录变了，暂停平台写入、补读内容，需要你确认后再恢复。请不要同时在两边运行。"
        : "这是只读的外部历史；在终端里继续不会经过平台。")) : null,
    h("p", { class: "muted small" }, s.worktree ? "归档会删除 worktree 和分支，未提交、未合并改动将丢弃；恢复到列表不会恢复代码。会话历史与 runtime 的原生 transcript 保留。" : "平台归档只隐藏列表，删除只删平台数据，都不会修改或删除 runtime 的原生 transcript。"));
}
function rtDetailCenter() {
  const id = rtId();
  const v = ui.rt.view;
  if (!v && ui.rt.diskDisplay && typeof sessionDiskPanel === 'function') return sessionDiskPanel({kind:'rt',id},ui.rt.diskDisplay);
  if (!v) return rtDetailLoading();
  const panel = rtTranscript(v);
  const center = h("section", { class: "rt-center", "aria-label": "会话内容", "data-ro": String(!!v.readOnly) },
    rtHead(v),
    sessionSyncNote(ui.rt, () => refresh({ main: true, force: true, global: false }), "rt-sync"),
    h("p", { id: "rt-conn", class: "rt-banner warn", hidden: !ui.rt.conn, role: "status" }, ui.rt.conn || ""),
    v.readOnlyReason ? h("div", { class: "rt-banner warn", role: "note" }, v.readOnlyReason,
      v.session.conflict ? [" ", h("span", { class: "small muted" }, `证据：${v.session.conflict.evidence}；发现于 ${rtTime(v.session.conflict.detectedAt)}`)] : null) : null,
    panel,
    rtApprovals(v),
    rtComposer(v));
  // panel 随当前 center 生命周期释放，不跨会话保留 DOM。
  center.rtSoftSignature = JSON.stringify([v, ui.rt.statusConfirmed, ui.rt.busy, ui.rt.error, ui.rt.flash, ui.rt.deploy]);
  // 首次软重绘时输入区只有「状态已核对」变了的话，也能原地改状态
  center.rtComposerSignature = rtComposerSignature(v);
  return center;
}




/** Scrollbar-side conversation landmarks. State belongs to this transcript, never another session. */
const rtDetailCleanups = new Set();
function rtDisposeMessageNavigators() {
  for (const dispose of [...rtDetailCleanups]) dispose();
}
function rtMessageNavigator(box) {
  let disposed = false;
  const id = rtId(), gen = ui.rt.gen;
  let index = [], items = [], signature = "", selected = null, pressed = null, frame = 0, jump = 0;
  let firstSeq, lastSeq, loading = false, pending = null, flight = false;
  const status = h("span", { class: "sr-only", role: "status" });
  const list = h("div", { class: "rt-message-nav-list", id: `rt-message-nav-${id}` });
  const panel = h("div", { class: "rt-message-nav-panel", hidden: true },
    h("div", { class: "rt-message-nav-title" }, "对话目录"), list, status);
  const rail = h("button", { type: "button", class: "rt-message-nav-rail", "aria-label": "对话目录",
    "aria-expanded": "false", "aria-controls": list.id });
  const nav = h("nav", { class: "rt-message-nav", "aria-label": "对话定位", hidden: true }, rail, panel);
  const current = () => !disposed && box.isConnected && rtId() === id && ui.rt.gen === gen;
  const rowFor = key => box.querySelector(`.rt-row[data-ev-key="${CSS.escape(key)}"]`);
  const open = value => {
    nav.classList.toggle("open", value); panel.hidden = !value;
    rail.setAttribute("aria-expanded", String(value));
    if (value) reveal();
  };
  const reveal = () => {
    const entry = [...list.children].find(n => n.dataset.key === selected);
    if (!entry) return;
    if (entry.offsetTop < list.scrollTop) list.scrollTop = entry.offsetTop;
    else if (entry.offsetTop + entry.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = entry.offsetTop + entry.offsetHeight - list.clientHeight;
  };
  const mark = key => {
    selected = key;
    for (const node of [...rail.children, ...list.children]) {
      const active = node.dataset.key === key;
      node.classList.toggle("active", active);
      if (node.parentElement === list) { if (active) node.setAttribute("aria-current", "location"); else node.removeAttribute("aria-current"); }
    }
    if (!panel.hidden) reveal();
  };
  // Coalesce fast scrubbing: keep one history read in flight and only the latest pending target.
  const choose = item => {
    mark(item.key); pending = item; ++jump;
    if (flight) return;
    void (async () => {
      flight = true;
      while (pending && current()) { const next = pending; pending = null; await locate(next, jump); }
      flight = false;
    })();
  };
  const locate = async (item, request) => {
    mark(item.key);
    box.rtNavigating = true;
    try {
      if (!rowFor(item.key)) {
        loading = true; status.textContent = "正在定位消息…";
        const page = await api(`/api/runtime-sessions/${encodeURIComponent(id)}/messages?after=${item.seq - 1}&limit=100`);
        if (!current() || request !== jump) return;
        if (!page.events?.some(e => e.key === item.key)) throw new Error("消息已不可用");
        if (typeof sessionSyncInvalidate === "function") sessionSyncInvalidate({ kind: "rt", id });
        ui.rt.events = page.events; ui.rt.hasMoreBefore = firstSeq == null || page.events[0].seq > firstSeq;
        ui.rt.trimmedTail = page.hasMoreAfter; ui.rt.total = page.total; ui.rt.atBottom = false;
        ui.rt.panelRevision = (ui.rt.panelRevision || 0) + 1;
        rtRerenderTranscript(box);
        box.querySelector(".rt-earlier")?.remove();
        if (ui.rt.hasMoreBefore) box.prepend(rtEarlierButton("加载更早的记录"));
      }
      if (!current() || request !== jump) return;
      const row = rowFor(item.key);
      if (!row) return;
      ui.rt.atBottom = false;
      box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top - 16;
      ui.rt.reading = sessionReadingCapture(box, false);
      rtPatchNewCount();
      status.textContent = item.summary;
    } catch (e) {
      if (current() && request === jump) { status.textContent = "定位失败，请重试"; announce("消息定位失败，请重试"); }
    } finally {
      if (request === jump) { loading = false; box.rtNavigating = pressed !== null; }
    }
  };
  const refresh = () => {
    frame = 0;
    if (!current()) { dispose(); return; }
    const map = new Map(index.map(item => [item.key, item]));
    for (const e of ui.rt.events) {
      if (e.kind !== "message" || e.role !== "user" || e.subagent) continue;
      if (rtEnforcementNotice(e)) continue;      // 平台自动反馈不是用户消息，不进消息导航
      const deployment = rtDeploymentNotice(e);
      map.set(e.key, { key: e.key, seq: e.seq,
        ...(deployment ? { type: "deployment" } : {}),
        summary: (deployment ? rtDeploymentIndexSummary(deployment) : e.text || "").replace(/\s+/g, " ").trim().slice(0, 120) || (e.attachments?.length ? "图片 / 附件消息" : "用户消息") });
    }
    items = [...map.values()].sort((a, b) => a.seq - b.seq);
    nav.hidden = !items.length;
    const next = JSON.stringify(items.map(({ key, seq, summary, type }) => [key, seq, summary, type]));
    if (signature !== next) {
      signature = next;
      rail.replaceChildren(...items.map(item => h("span", { class: `rt-message-nav-dot${item.type === "deployment" ? " deployment" : ""}`, "data-key": item.key, "aria-hidden": "true" })));
      let messageNo = 0;
      list.replaceChildren(...items.map(item => {
        const deployment = item.type === "deployment";
        const tone = deployment ? ({ "部署成功": "ok", "已在线上": "ok", "部署失败": "bad", "部署超时": "warn", "未部署": "warn" }[item.summary.split(" · ")[0]] || "") : "";
        return h("button", { type: "button", class: `rt-message-nav-item${deployment ? ` rt-message-nav-deployment ${tone}` : ""}`, "data-key": item.key,
          onclick: () => choose(item) }, h("span", { class: "rt-message-nav-number", "aria-hidden": "true" }, deployment ? "↑" : ++messageNo),
          h("span", {}, item.summary));
      }));
    }
    const start = firstSeq ?? ui.rt.events[0]?.seq ?? 0;
    const end = Math.max(lastSeq || 0, ui.rt.events.at(-1)?.seq || 0, start + 1);
    const complete = !ui.rt.hasMoreBefore && !ui.rt.trimmedTail;
    for (let i = 0; i < items.length; i++) {
      const row = complete && rowFor(items[i].key);
      const fraction = row ? (row.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop) / Math.max(1, box.scrollHeight)
        : (items[i].seq - start) / (end - start);
      items[i].position = Math.max(0, Math.min(1, fraction));
      rail.children[i].style.top = `${items[i].position * 100}%`;
    }
    if (pressed !== null || loading) { mark(selected); return; }
    const top = box.getBoundingClientRect().top + 32;
    const rows = [...box.querySelectorAll("[data-ev-seq]")];
    const anchor = rows.find(row => row.getBoundingClientRect().bottom > top) || rows.at(-1);
    const seq = Number(anchor?.dataset.evSeq || start);
    mark(items.filter(item => item.seq <= seq).at(-1)?.key || items[0]?.key);
  };
  const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(refresh); };
  const mutations = new MutationObserver(schedule), resize = new ResizeObserver(schedule);
  const dispose = () => {
    disposed = true; mutations.disconnect(); resize.disconnect();
    if (frame) cancelAnimationFrame(frame); frame = 0;
    rtDetailCleanups.delete(dispose);
  };
  rtDetailCleanups.add(dispose);
  mutations.observe(box, { childList: true, subtree: true, characterData: true });
  resize.observe(box);
  box.addEventListener("scroll", schedule, { passive: true });
  box.addEventListener("load", schedule, true);
  box.addEventListener("toggle", schedule, true);
  nav.addEventListener("pointerenter", ev => { if (ev.pointerType === "mouse") open(true); });
  nav.addEventListener("pointerleave", ev => { if (ev.pointerType === "mouse" && !nav.contains(document.activeElement)) open(false); });
  nav.addEventListener("focusin", () => open(true));
  nav.addEventListener("focusout", ev => { if (!nav.contains(ev.relatedTarget) && pressed === null) open(false); });
  rail.addEventListener("click", ev => { if (ev.detail === 0) open(!nav.classList.contains("open")); });
  nav.addEventListener("keydown", ev => {
    if (ev.key === "Escape") { rail.focus(); open(false); ev.preventDefault(); return; }
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(ev.key) || !items.length) return;
    ev.preventDefault(); open(true);
    let i = items.findIndex(item => item.key === selected);
    i = ev.key === "Home" ? 0 : ev.key === "End" ? items.length - 1 : Math.max(0, Math.min(items.length - 1, i + (ev.key === "ArrowDown" ? 1 : -1)));
    choose(items[i]);
  });
  const scrub = y => {
    const rect = rail.getBoundingClientRect(), fraction = Math.max(0, Math.min(1, (y - rect.top) / rect.height));
    const item = items.reduce((best, item) => !best || Math.abs(item.position - fraction) < Math.abs(best.position - fraction) ? item : best, null);
    if (item && (item.key !== selected || !rowFor(item.key) && !loading)) choose(item);
  };
  rail.addEventListener("pointerdown", ev => {
    if (ev.pointerType === "mouse" || ev.button !== 0 || !items.length) return;
    ev.preventDefault(); pressed = ev.pointerId; box.rtNavigating = true;
    rail.setPointerCapture(ev.pointerId); nav.classList.add("scrubbing"); open(true); scrub(ev.clientY);
  });
  rail.addEventListener("pointermove", ev => { if (ev.pointerId === pressed) { ev.preventDefault(); scrub(ev.clientY); } });
  const release = ev => {
    if (ev.pointerId !== pressed) return;
    pressed = null; box.rtNavigating = loading; nav.classList.remove("scrubbing"); open(false);
    if (rail.hasPointerCapture(ev.pointerId)) rail.releasePointerCapture(ev.pointerId);
  };
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) rail.addEventListener(type, release);
  requestAnimationFrame(() => {
    if (!current()) return;
    refresh();
    void api(`/api/runtime-sessions/${encodeURIComponent(id)}/message-index`).then(result => {
      if (!current() || !Array.isArray(result.items)) return;
      index = result.items; firstSeq = result.firstSeq; lastSeq = result.lastSeq; schedule();
    }).catch(() => { /* Loaded messages remain navigable when the index is temporarily unavailable. */ });
  });
  return nav;
}
globalThis.piRouteModules?.register("rt-detail", {render: renderRtWorkbench});
