// New-session UI definitions; shared drafts and launch entry remain eager.


/* ------------------------------ 新建运行时会话 ------------------------------ */

/* 手机键盘弹起后页面按可视高度收（styles.css 的 html.kb-open）：新建页的输入区往往比剩下的
   高度还高，一屏高的页面里只有整块输入区能滚。滚动位置贴到底部，输入框和发送按钮才都露在
   键盘上方；放得下时不滚，和之前一模一样。 */
function rtNewPinComposer() {
  // Android 壳弹键盘是缩短整个 WebView，kb-open 不会置上：窗口矮到 560px 以下（styles.css 同一口径）也算
  if (!document.documentElement.classList.contains("kb-open") && !(window.innerHeight <= 560 && window.matchMedia("(max-width: 760px)").matches)) return;
  requestAnimationFrame(() => {
    const center = document.querySelector(".rt-new-center");
    if (center && center.scrollHeight > center.clientHeight + 1) center.scrollTop = center.scrollHeight;
  });
}
document.addEventListener("pi-keyboard", (ev) => { if (ev.detail && ev.detail.inset) rtNewPinComposer(); });
// WebView 被缩短时没有 pi-keyboard 事件，只有窗口 resize：输入框聚焦着就再贴一次底
window.addEventListener("resize", () => {
  if (document.activeElement instanceof Element && document.activeElement.matches(".rt-new-center .rt-new-prompt")) rtNewPinComposer();
});
// 整页重绘（添加 / 移除图片、刷新额度）会重置滚动位置：重新点回输入框时再贴一次底
document.addEventListener("focusin", (ev) => {
  if (ev.target instanceof Element && ev.target.matches(".rt-new-center .rt-new-prompt")) rtNewPinComposer();
});

/** 新建页常驻提醒的审批模式：不经确认就能改文件、跑命令 */
const RT_RISKY_PERMISSIONS = new Set(["full-access", "bypassPermissions"]);

/** 新建会话放在对话工作台里：左侧会话列表保留，右侧消息区显示新建表单 */
function renderRtNewWorkbench() {
  rtSyncChrome();
  if (ui.rt.launch) return rtLaunchWorkbench(ui.rt.launch);
  const enter = !!ui.rt.newEnter;
  ui.rt.newEnter = false;
  const layout = h("div", { class: `rt-layout rt-layout-new${ui.rt.listOpen ? " list-open" : ""}` }, rtList(), h("section", { class: "rt-center rt-new-center", "aria-label": "新建会话" },
    h("button", { type: "button", class: "btn small rt-list-toggle", "aria-expanded": String(ui.rt.listOpen), onclick: () => rtSetListOpen(!ui.rt.listOpen) }, "会话列表"), renderRtNew()));
  return h("div", { class: `rt-page rt-page-new${enter ? " rt-page-enter" : ""}` }, rtAccessNote(), layout);
}

/* ------------------------------ 运行时能力对比入口 ------------------------------ */

/** 跳资源页只看运行时，并滚到那张完整的运行时能力对比表 */
function rtOpenResourceCapabilities() {
  ui.resourceFilter = "runtime"; ui.resourceScrollTo = "capabilities";
  location.hash = "#/resources";
}
/** 新建页不再铺对比表，只留这一行入口（输入卡片下面正中）：小箭头表示整块标题可点，跳到资源页的完整对比 */
function rtCompareEntry() {
  return h("section", { class: "rt-compare", "aria-label": "运行时能力对比" },
    h("div", { class: "rt-compare-head" },
      h("h2", {}, h("a", { class: "rt-compare-link", href: "#/resources", title: "到「资源 · 运行时」查看完整能力对比，并设置新建会话默认配置", onclick: (ev) => { ev.preventDefault(); rtOpenResourceCapabilities(); } }, "运行时能力对比",
        h("span", { class: "rt-compare-go", "aria-hidden": "true" }, "→")))));
}

/** 输入框里移除待办引用 chip 时，同步解除这次会话与那条待办的关联（发送时不再带 noteId）。
 *  正常只有一个引用；手工拼出多段引用时，只要正文里还留着别的引用就继续关联。 */
function rtClearNoteReference(stillQuoted) {
  const draft = rtImageDraft("new");
  if (!draft.noteRef || stillQuoted) return;
  delete draft.noteRef;
  rtSaveImageDraft("new");
}

/**
 * 提交后的过渡态：服务器还没给出真实会话 ID 之前，按会话详情页的结构摆好标题栏、对话区、输入框与会话详情，
 * 创建成功后切到真实详情页时只是内容补齐，不换版式。
 */
function rtLaunchWorkbench(launch) {
  const layout = h("div", { class: `rt-layout rt-layout-launch${ui.rt.listOpen ? " list-open" : ""}${ui.rt.sideCollapsed ? " side-collapsed" : ""}` },
    rtList(), rtLaunchView(launch),
    h("button", { type: "button", class: "rt-info-backdrop", tabindex: "-1", "aria-label": "关闭会话详情浮层", onclick: () => rtSetInfoOpen(false) }),
    rtLaunchSide(launch), rtSideHandle());
  rtSyncInfo(layout);
  return h("div", { class: "rt-page rt-page-launch" }, rtAccessNote(), layout);
}

function rtLaunchStatus(launch) {
  if (launch.createdId) return badge("已创建", "ok");
  return launch.error ? badge("提交未完成", "bad") : badge("创建中", "accent");
}
/** 后台完成创建后用户回到创建页：由用户自己打开，不在切回时自动换成别的会话。 */
function rtOpenLaunchCreated(launch) {
  if (!launch?.createdId) return;
  ui.rt.launch = null;
  if (typeof rtPrepareDetailOrigin === "function") rtPrepareDetailOrigin(launch.createdId, launch.origin || null);
  location.hash = `#/rt/${encodeURIComponent(launch.createdId)}`;
}
function rtLaunchSubText(f) {
  return [rtModelShort(f.model) || "默认模型", RT_KIND[f.runtimeKind], (f.workspace || "").trim(), f.worktree ? "独立 worktree" : ""].filter(Boolean).join(" · ");
}
/** 与 rtHead 同构；真实标题由服务器生成，这里先用占位标题。 */
function rtLaunchHead(launch) {
  const f = launch.form;
  const title = "新会话";
  const tags = h("div", { class: "rt-title-tags" }, rtLaunchStatus(launch));
  if (rtPhone.matches) {
    const openInfo = () => { rtToggleMore(false); rtSetInfoOpen(true); };
    return h("header", { class: "rt-head rt-head-phone", "aria-busy": String(!launch.error && !launch.createdId) },
      h("div", { class: "rt-head-nav" },
        h("button", { type: "button", class: "btn small rt-list-toggle rt-back", "aria-label": "返回会话列表", onclick: () => { location.hash = "#/rt"; } }, "‹"),
        h("span", { class: "rt-head-logo" }, rtAvatar(f.runtimeKind, f.model, "lg")),
        h("div", { class: "rt-title-line" }, h("h1", { class: "rt-title" }, h("span", { class: "rt-title-text" }, title))),
        h("div", { class: `rt-more${ui.rt.moreOpen ? " open" : ""}` },
          h("button", { type: "button", class: "btn small rt-more-btn", "aria-label": "更多", "aria-expanded": String(!!ui.rt.moreOpen), "aria-controls": "rt-more-sheet", onclick: () => rtToggleMore(!ui.rt.moreOpen) }, "⋮"),
          h("button", { type: "button", class: "rt-more-backdrop", tabindex: "-1", "aria-label": "关闭菜单", onclick: () => rtToggleMore(false) }),
          h("div", { class: "rt-more-sheet", id: "rt-more-sheet", role: "menu", "aria-label": "会话菜单" },
            h("button", { type: "button", role: "menuitem", class: "rt-more-item", onclick: openInfo }, h("span", { class: "rt-more-check", "aria-hidden": "true" }), h("span", { class: "rt-more-label" }, "会话详情")),
            h("div", { class: "rt-more-sep", role: "separator" }),
            h("button", { type: "button", role: "menuitem", class: "rt-more-item rt-more-cancel", onclick: () => rtToggleMore(false) }, h("span", { class: "rt-more-label" }, "取消")))),
        tags));
  }
  return h("header", { class: "rt-head", "aria-busy": String(!launch.error && !launch.createdId) },
    h("button", { type: "button", class: "btn small rt-list-toggle", "aria-expanded": String(!!ui.rt.listOpen), onclick: () => rtSetListOpen(!ui.rt.listOpen) }, "会话列表"),
    h("button", { type: "button", class: "btn small rt-info-toggle", "aria-controls": "rt-session-info", "aria-expanded": "false", onclick: () => rtSetInfoOpen(true) }, "会话详情"),
    h("div", { class: "rt-title-row" },
      rtAvatar(f.runtimeKind, f.model, "lg"),
      h("div", { class: "rt-title-main" },
        h("h1", { class: "rt-title" }, title),
        h("p", { class: "rt-sub muted small" }, rtLaunchSubText(f))),
      tags));
}

/** 输入框先摆好：可以先写下一条，创建成功后草稿带进新会话；发送要等会话创建完成。 */
function rtLaunchComposer(launch) {
  return h("div", { class: "rt-composer", "aria-busy": String(!launch.error && !launch.createdId) },
    h("div", { class: "rt-compose-row rt-compose-stack" },
      rtSessionMentionInput({ class: "rt-input", rows: "2", "data-key": "rt-launch-draft", allowReferences: false,
        value: launch.draft || "", placeholder: "可以先输入，会话创建完成后发送", "aria-label": "发送给该 runtime 的消息",
        oninput: (ev) => { launch.draft = ev.target.value; },
        onkeydown: (ev) => { if (rtIsSendKey(ev)) ev.preventDefault(); }
      }, "launch"),
      h("div", { class: "rt-compose-actions" },
        h("span", { class: "rt-compose-spacer", "aria-hidden": "true" }),
        launch.createdId
          ? h("button", { type: "button", class: "btn primary", onclick: () => rtOpenLaunchCreated(launch) }, "打开会话")
          : h("button", { type: "button", class: "btn primary", disabled: true, title: "会话创建完成后可发送" }, "发送"))));
}

/** 会话详情侧栏：只列提交时已经确定的配置，其余等真实会话返回后补齐。 */
function rtLaunchSide(launch) {
  const f = launch.form;
  const p = (ui.rt.profiles || []).find((x) => x.runtimeKind === f.runtimeKind);
  const permission = (p?.permissionOptions || []).find((x) => x.id === f.permissionMode);
  const pending = () => h("span", { class: "muted" }, launch.error ? "未创建" : launch.createdId ? "已创建" : "创建后显示");
  return h("aside", { class: "rt-side", id: "rt-session-info", hidden: !rtPhone.matches && ui.rt.sideCollapsed, "aria-label": "会话信息", onkeydown: rtInfoKeydown },
    h("div", { class: "rt-info-head" }, h("strong", {}, "会话详情"), h("button", { type: "button", class: "btn small rt-info-close", "aria-label": "关闭会话详情", onclick: () => rtSetInfoOpen(false) }, "关闭")),
    h("div", { class: "rt-info" },
      h("section", { class: "card rt-card rt-usage-card" },
        h("div", { class: "rt-card-head" }, h("h3", {}, "本会话用量")),
        h("p", { class: "muted" }, launch.error ? "会话尚未创建" : "会话创建后开始统计")),
      h("section", { class: "card rt-card" }, h("h3", {}, "会话信息"),
        h("dl", { class: "kv" },
          h("dt", {}, "运行时"), h("dd", {}, `${RT_KIND[f.runtimeKind]}${p?.binaryVersion ? ` ${p.binaryVersion}` : ""}`),
          h("dt", {}, "宿主机"), h("dd", {}, p?.hostLabel || "本机"),
          h("dt", {}, "请求模型"), h("dd", {}, f.model || "runtime 默认"),
          h("dt", {}, "推理强度"), h("dd", {}, f.effort || "runtime 默认"),
          h("dt", {}, "权限模式"), h("dd", {}, permission?.label || f.permissionMode || "默认"),
          h("dt", {}, "工作目录"), h("dd", { class: "mono small" }, (f.workspace || "").trim()),
          f.worktree ? h("dt", {}, "改动位置") : null,
          f.worktree ? h("dd", {}, "独立 worktree（创建后分配分支）") : null,
          h("dt", {}, "原生会话 ID"), h("dd", {}, pending()),
          h("dt", {}, "平台 ID"), h("dd", {}, pending())))));
}

/** 中间栏：与 rtDetailCenter 同序——标题栏、对话、输入框。 */
function rtLaunchView(launch) {
  // 创建中也能先回去：和详情页同位置的「← 待办」扒边入口（电话档显示，桌面档由 CSS 隐藏）
  const edge = rtOriginLink(launch.origin, "rt-origin-edge");
  return h("section", { class: "rt-center rt-launch-page", "aria-label": "会话内容" },
    rtLaunchHead(launch),
    // 二级标签已取消（工具 / 用量 / 来源），只留发起场景的扒边入口
    h("div", { class: `rt-tx-wrap${edge ? " has-origin-tab" : ""}` }, h("div", { class: "rt-transcript", role: "log", "aria-live": "off", "aria-label": "对话与工具记录", tabindex: "0" },
      h("div", { class: "rt-row user" }, h("div", { class: "rt-bubble user" },
        h("div", { class: "rt-launch-text" }, launch.form.prompt), rtAttachmentHistory(launch.images)),
        h("div", { class: "rt-row-meta" }, h("span", { class: "muted small rt-outgoing-state" }, launch.error ? "尚未确认发送" : launch.createdId ? "已创建" : "发送中…"))),
      h("div", { class: "rt-row assistant rt-thinking", role: "status", "aria-live": "polite" },
        launch.error || launch.createdId ? null : h("span", { class: "rt-thinking-dot", "aria-hidden": "true" }),
        h("span", { class: "rt-thinking-label" }, launch.error ? "提交未完成" : launch.createdId ? "会话已创建" : launch.phase === "deployment" ? "消息已排队，部署完成后自动发送" : launch.phase === "check" ? "正在检查配置" : "正在创建会话"),
        launch.error || launch.createdId ? null : h("span", { class: "rt-thinking-ellipsis", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
        launch.createdId ? h("button", { type: "button", class: "btn small primary rt-launch-open", onclick: () => rtOpenLaunchCreated(launch) }, "打开会话") : null),
      launch.error ? h("div", { class: "rt-launch-error" },
        h("p", { class: "field-error", role: "alert" }, launch.error),
        h("div", { class: "rt-actions" },
          // 后台条目（launch.req）：重试 / 放回输入框都走同一份后台逻辑；旧的等待页对象保留原行为
          launch.recommendationChanged
            ? h("button", { type: "button", class: "btn primary", onclick: () => {
              if (launch.req) return rtBgRecreateStandalone(launch);
              const c = { ...launch.request, key: rtKey() }; delete c.recommendationRef;
              const draft = rtImageDraft("new"); delete draft.recommendationRef; delete draft.noteRef;
              launch.recommendationChanged = false;
              void rtCreateSession(c);
            } }, "按当前内容创建")
            : h("button", { type: "button", class: "btn primary", disabled: !!launch.running, onclick: () => { if (launch.req) { launch.attempt = 0; void rtBgRun(launch); } else if (launch.request) void rtCreateSession(launch.request); else void rtPrepareConfirm(); } }, launch.retryTimer ? "立即重试" : "重试"),
          h("button", { type: "button", class: "btn", onclick: () => {
            if (launch.req) return rtBgGiveBack(launch);
            ui.rt.launch = null; ui.rt.confirm = null; ui.rt.formError = "";
            // An unknown POST result must be reconciled with its original key before editing.
            renderMain();
          }, disabled: !!launch.unknown && !launch.req }, launch.req ? "放回输入框" : "返回修改"))) : null,
      h("div", { class: "rt-tail" })), edge),
    rtLaunchComposer(launch));
}

// 只做连接/认证探测，不发送模型任务。同一时刻只允许一次，切走或已提交后不打断当前页面。
async function rtCheckAntigravityConnection() {
  const check = ui.rt.antigravityCheck ||= { pending: false, error: "" };
  if (check.pending) return;
  check.pending = true; check.generation = ui.rt.gen; check.error = "";
  const visible = () => ui.view === "rt-new" && !ui.rt.launch && !ui.rt.confirm && rtForm().runtimeKind === "antigravity";
  if (visible()) renderMain();
  try {
    await rtLoadAccess();
    if (!ui.rt.access?.control) throw new Error("当前入口没有控制权限，请登录后重试");
    const profile = await api("/api/runtime-profiles/antigravity/probe", { method: "POST", body: "{}" });
    if (profile?.runtimeKind !== "antigravity" || !profile.state) throw new Error("连接检查未返回有效状态，请重试");
    // 等待已有读取完成后采用本次探测结果，避免旧快照盖掉刚确认的登录状态。
    await rtLoadProfiles();
    // probe 返回认证/能力，不附带账号额度；同一账号刚读回的额度仍要保留。
    const quota = ui.rt.profiles?.find(p => p.runtimeKind === "antigravity")?.rateLimit;
    const sameAccount = quota?.identityScopeId && quota.identityScopeId === profile.identity?.identityScopeId;
    ui.rt.profiles = [...(ui.rt.profiles || []).filter(p => p.runtimeKind !== "antigravity"), { ...profile, ...(sameAccount ? { rateLimit: quota } : {}) }];
    ui.rt.profilesCached = false;
    rtWriteCache();
    if (profile.state !== "executable") check.error = profile.stateReason || "Antigravity 当前不可用，请重试检查";
  } catch (e) {
    check.error = /Failed to fetch|NetworkError|Load failed/i.test(e.message || "")
      ? "连接失败：无法连接服务，请检查网络后重试"
      : e.message || "连接检查失败，请重试";
  } finally {
    check.pending = false;
    if (visible()) renderMain();
  }
}

function renderRtNew() {
  if (ui.rt.launch) return rtLaunchView(ui.rt.launch);
  const f = rtForm();
  const a = ui.rt.access;
  const profiles = ui.rt.profiles || [];
  const p = profiles.find((x) => x.runtimeKind === f.runtimeKind);
  const check = f.runtimeKind === "antigravity" ? ui.rt.antigravityCheck : null;
  // 后台探测不阻塞已有可用配置的新建提交；只在明确检查失败时才拦截发送。
  const checkBlocksSend = !!check?.error;
  const roots = rtWorkspaceRoots(f.runtimeKind);
  if (a && !a.control) return h("div", { class: "rt-form-page" }, h("h1", {}, "新建运行时会话"), rtAccessNote() || h("p", { class: "muted" }, "当前入口没有控制权限"));
  // pending 也用于保存正在提交的请求；仅恢复未完成请求时进入确认页，提交期间保持输入页。
  if (ui.rt.busy !== "create" && !ui.rt.confirm && rtImageDraft("new").pending) ui.rt.confirm = rtImageDraft("new").pending;
  if (ui.rt.confirm) return rtConfirmView(ui.rt.confirm);
  const set = (k) => (ev) => { f[k] = ev.target.value; if (k === "prompt") rtSaveImageDraft("new", f.prompt); ui.rt.formError = ""; };
  const permissions = p && p.permissionOptions && p.permissionOptions.length ? p.permissionOptions : [{ id: rtDefaultPermission(f.runtimeKind), label: f.runtimeKind === "codex" ? "Ask for approval" : f.runtimeKind === "pi" ? "原生工具权限" : f.runtimeKind === "antigravity" ? "自动审批" : "默认审批", detail: "检查连接后显示该运行时支持的权限模式。" }];
  const selectable = rtSelectableModels(f.runtimeKind, p);
  if (p && f.model && !selectable.models.some((m) => m.id === f.model)) f.model = "";
  // 默认模型没被勾选：落到第一个可选模型，而不是让运行时用未授权的默认模型
  if (p && !f.model && !selectable.defaultAllowed && selectable.models.length) f.model = selectable.models[0].id;
  if (p && f.effort && !(rtModelOption(p, f.model)?.efforts || []).includes(f.effort)) f.effort = "";
  if (p && !permissions.some((x) => x.id === f.permissionMode)) f.permissionMode = permissions[0].id;
  const selectedPermission = permissions.find((x) => x.id === f.permissionMode) || permissions[0];
  // 图片加号放到输入框底部工具栏最左，和发送按钮同一行；草稿缩略图留在输入框上方
  const att = rtAttachmentComposer("new", f.runtimeKind, f.model || "", !!ui.rt.busy);
  const uploadDraft = rtImageDraft("new"), uploadingCount = uploadDraft.images.filter(i => i.state === "uploading").length;
  rtRevealSelected(".rt-runtime-choices", ".rt-runtime-choice.selected");
  return h("div", { class: "rt-new-page" },
    h("div", { class: "rt-new-nav" }, rtNewBackLink(), h("a", { href: "#/runtimes" }, "运行时配置")),
    // 上方只留一句标题（对比表已从新建页去掉）；输入区固定在底部，和进行中对话的输入框同一位置
    h("div", { class: "rt-new-scroll", "data-keep-scroll": "rt-new-scroll" },
      // 只留一句标题：选运行时、写任务的说明就在下方控件上，不再重复
      h("div", { class: "rt-new-intro" }, h("h1", {}, "想让它做什么？"))),
    h("section", { class: "rt-new-dock", "aria-label": "新建运行时会话" },
      rtNewModeSwitch(),
      h("div", { class: "rt-new-composer" },
        h("div", { class: "rt-runtime-choices", role: "radiogroup", "aria-label": "运行时", "data-keep-scroll-x": "rt-new-runtimes" }, RT_KINDS.map((kind) => {
          const profile = profiles.find((x) => x.runtimeKind === kind);
          const checking = kind === "antigravity" && ui.rt.antigravityCheck;
          const loadingLabel = checking?.pending ? "正在检查 Antigravity 连接与登录状态…" : !profile && ui.rt.profiles === null ? "读取中" : "";
          const [status, tone] = checking?.error ? ["检查失败", "bad"] : profile ? RT_PROFILE_STATE[profile.state] || [profile.state, ""] : ["未检查", "warn"];
          return h("div", { class: `rt-runtime-choice${kind === f.runtimeKind ? " selected" : ""}` },
            h("label", { class: "rt-runtime-select" },
              h("input", { type: "radio", name: "rt-new-runtime", "data-key": `rt-kind-${kind}`, value: kind, checked: kind === f.runtimeKind, "aria-label": RT_KIND[kind], onchange: () => rtSelectRuntime(kind) }),
              h("span", { class: "rt-runtime-head" },
                h("span", { class: "rt-runtime-name" },
                  h("span", { class: `rt-glyph ${kind}`, "aria-hidden": "true" }, RT_GLYPH[kind]),
                  h("span", { class: "rt-name-full" }, RT_KIND[kind]),
                  h("span", { class: "rt-name-short", "aria-hidden": "true" }, RT_SHORT[kind]),
                  loadingLabel ? h("span", { class: "rt-runtime-loading", role: "status", title: loadingLabel }, h("span", { class: "rt-note-launch-spinner", "aria-hidden": "true" }), h("span", { class: "sr-only" }, loadingLabel)) : null),
                // 正常可执行是常态，查询/读取中由名字后的小 loading 表达，不再插徽标撑高卡片；只在异常或未检查时显示状态
                loadingLabel || (profile?.state === "executable" && !checking?.error) ? null : badge(status, tone)),
              rtQuotaStrip(profile?.rateLimit, "short", "", "", kind) || rtBalanceStrip(profile?.balances)));
        })),
        att.node,
        rtSessionMentionInput({ onpaste: ev => rtImagePaste("new", ev), ondragover: ev => ev.preventDefault(), ondrop: ev => rtImageDrop("new", ev), onNoteRemove: rtClearNoteReference, class: "rt-new-prompt", rows: "3", "aria-label": "首条消息", "data-key": "rt-prompt", value: f.prompt, oninput: set("prompt"), placeholder: "描述任务，输入 @ 引用未归档会话，/ 调用技能…", onkeydown: (ev) => { if (!rtIsSendKey(ev)) return; ev.preventDefault(); if (!ui.rt.busy) rtPrepareConfirm(); } }),
        h("div", { class: "rt-new-toolbar" },
          att.addButton,
          rtNewOptions(
            rtNewOptionsSummary(f, p, selectedPermission),
            rtWorkspacePicker(f, roots, a),
            h("label", { class: `rt-new-control rt-new-worktree${f.worktree ? " on" : ""}`, title: "从工作目录所在 git 仓库的 main 切出这个会话专用的 worktree（分支 pi/<会话>），会话只在里面改，不和其他会话的未提交改动混在一起；改完可在会话页「提交并在空闲时部署」。工作目录要在 git 仓库里。" },
              h("input", { type: "checkbox", "data-key": "rt-worktree", checked: !!f.worktree, onchange: (ev) => { f.worktree = ev.target.checked; renderMain(); } }), h("span", {}, "独立 worktree")),
            h("label", { class: "rt-new-control", title: selectedPermission.detail }, h("span", { class: "rt-new-option-label" }, rtMiniIcon(RT_MINI_PATHS[RT_PERMISSION_ICON[selectedPermission.id]] || RT_MINI_PATHS.help, { className: "rt-new-field-icon", size: 11 }), "审批模式"),
              rtMiniIcon(RT_MINI_PATHS[RT_PERMISSION_ICON[selectedPermission.id]] || RT_MINI_PATHS.help, { className: "rt-new-desktop-perm", size: 11 }),
              h("select", { "aria-label": "审批模式", "data-key": "rt-permission", onchange: (ev) => { f.permissionMode = ev.target.value; f.browserProfileId = "isolated"; renderMain(); } }, permissions.map((x) => h("option", { value: x.id, selected: x.id === f.permissionMode }, x.label)))),
            h("label", { class: "rt-new-control" }, h("span", { class: "rt-new-option-label" }, rtAvatar(f.runtimeKind, f.model || rtModelOption(p, f.model)?.id || "", "xxs"), "模型"), h("select", { "aria-label": "模型", "data-key": "rt-model", onchange: (ev) => { f.model = ev.target.value; const mo = rtModelOption(p, f.model); if (!mo || !(mo.efforts || []).includes(f.effort)) f.effort = ""; renderMain(); rtPatchQuotaViews(); } },
              selectable.defaultAllowed ? h("option", { value: "", selected: !f.model }, "默认模型") : null,
              selectable.models.map((m) => h("option", { value: m.id, selected: f.model === m.id }, m.label)))),
            // 只有确实有得选（多于一个配置）且当前审批模式支持持久浏览器（工作区沙盒）时才显示；
            // 否则它只是一个点不开的「临时隔离」，白占一行把输入框工具栏挤成两行。
            f.runtimeKind === "pi" && f.permissionMode === "pi-ask" && p?.browserProfiles?.length > 1 ? h("label", { class: "rt-new-control", title: "持久浏览器保留登录状态，同一配置同时只供一个任务使用；仅工作区沙盒模式可用" }, h("span", { class: "rt-new-option-label" }, "浏览器配置"),
              // 选项文字保持短名：浏览器下拉按最长选项定宽，长后缀会把工具栏撑宽
              h("select", { "aria-label": "浏览器配置", "data-key": "rt-browser-profile", onchange: ev => { f.browserProfileId = ev.target.value; renderMain(); } }, p.browserProfiles.map(x => h("option", { value: x.id, selected: x.id === (f.browserProfileId || "isolated"), title: x.persistent ? `${x.label}：保留登录状态，同一时间只供一个任务使用` : `${x.label}：每个任务都从空白浏览器状态开始` }, x.label)))) : null,
            rtEffortSelect(rtModelOption(p, f.model), f.effort, (v) => { f.effort = v; }, "rt-effort", true)),
          h("button", { type: "button", class: `rt-new-send${uploadingCount ? " waiting" : ""}`, "aria-label": uploadingCount ? "发送（图片上传中）" : "发送", ...(uploadingCount ? { "aria-disabled": "true" } : {}), title: uploadingCount ? `正在上传图片（${uploadingCount} 张），上传完成后才能发送` : ui.rt.busy ? "正在准备附件…" : "点击发送，长按预约发送（Alt + ↓）", disabled: !!ui.rt.busy || checkBlocksSend || !roots.length || !p || p.state !== "executable", ...rtSchedulePress(() => rtPrepareConfirm(), () => rtScheduleOpen(time => rtPrepareConfirm(time)), () => !checkBlocksSend && !rtImageDraft("new").images.some(i => i.state === "uploading")) }, ui.rt.busy ? "…" : uploadingCount ? h("span", { class: "rt-note-launch-spinner on-accent", "aria-hidden": "true" }) : "↑"))),
      check?.error ? h("div", { class: "rt-runtime-check small", role: "alert" },
        h("span", {}, check.error),
        h("button", { type: "button", class: "btn small", onclick: () => void rtCheckAntigravityConnection() }, "重试检查")) : null,
      !check?.error && a?.canEditSettings && p && (p.state === "needs-login" || p.state === "not-installed")
        ? h("div", { class: "rt-runtime-check rt-runtime-connect-hint small", role: "status" },
            h("span", {}, p.state === "not-installed" ? `${RT_KIND[f.runtimeKind]} 尚未启用，可在界面一键安装并登录。` : `${RT_KIND[f.runtimeKind]} 尚未登录，无需打开终端即可在浏览器完成授权。`),
            h("button", { type: "button", class: "btn small primary", onclick: () => { ui.rt.pendingAuthKind = f.runtimeKind; location.hash = "#/settings/runtimes"; } }, p.state === "not-installed" ? "去启用并连接" : "去网页登录"))
        : null,
      uploadingCount ? h("p", { class: "rt-new-upload-status small", role: "status", "data-key": "rt-upload-status" }, h("span", { class: "rt-note-launch-spinner", "aria-hidden": "true" }), `正在上传图片（${uploadingCount}/${uploadDraft.images.length}），上传完成后才能发送`) : null,
      ui.rt.noteLaunch ? h("p", { class: "rt-note-launch-status muted small", role: "status" }, h("span", { class: "rt-note-launch-spinner", "aria-hidden": "true" }), `正在附上推荐来源的图片（${ui.rt.noteLaunch.count} 张）…`) : null,
      ui.rt.formError ? h("p", { class: "field-error", role: "alert" }, ui.rt.formError) : null,
      // 审批模式说明平时在选择框的悬停提示里；只有完全访问这类高风险模式才常驻提醒
      RT_RISKY_PERMISSIONS.has(selectedPermission.id) ? h("p", { class: "rt-new-permission-note small warn-text" }, selectedPermission.detail) : null,
      rtQuotaWarning(p),
      // 完整对比的入口放在输入卡片下面正中：新建页不再铺表，但入口照旧能跳到资源页那张完整表
      rtCompareEntry()));
}

async function rtPrepareConfirm(scheduledFor) {
  if (ui.rt.launch && !ui.rt.launch.error) return;
  if (rtForm().runtimeKind === "antigravity" && ui.rt.antigravityCheck) {
    if (ui.rt.antigravityCheck.error) {
      announce("连接检查失败，请先重试检查");
      return;
    }
    const antigravityProfile = (ui.rt.profiles || []).find((x) => x.runtimeKind === "antigravity");
    if (ui.rt.antigravityCheck.pending && (!antigravityProfile || antigravityProfile.state !== "executable")) {
      announce("正在检查连接，请稍候");
      return;
    }
  }
  if (rtImageDraft("new").images.some(i => i.state === "uploading")) {
    // 不往表单底部塞报错（常在视野外）：让输入框下面那行上传状态闪一下，并播报
    announce("图片还在上传，上传完成后才能发送");
    const line = document.querySelector(".rt-new-upload-status");
    if (line) { line.classList.remove("nudge"); void line.offsetWidth; line.classList.add("nudge"); line.scrollIntoView?.({ block: "nearest" }); }
    return;
  }
  const f = { ...rtForm() };
  const generation = (ui.rt.confirmGeneration || 0) + 1; ui.rt.confirmGeneration = generation;
  ui.rt.formError = "";
  if (!rtWorkspaceRoots(f.runtimeKind).length) { ui.rt.formError = "该运行时尚未配置允许的工作目录根"; return renderMain(); }
  if (!f.workspace.trim().startsWith("/")) { ui.rt.formError = "工作目录必须是绝对路径"; return renderMain(); }
  const imageError = rtImageError("new", f.runtimeKind, f.model || "");
  if (imageError) { ui.rt.formError = imageError; return renderMain(); }
  if (!f.prompt.trim() && !rtImageIds("new").length) { ui.rt.formError = "首条消息不能为空"; return renderMain(); }
  const p = (ui.rt.profiles || []).find((x) => x.runtimeKind === f.runtimeKind);
  if (!p) { ui.rt.formError = "先到运行时配置检查连接"; return renderMain(); }
  if (p.state !== "executable") { ui.rt.formError = `${RT_KIND[f.runtimeKind]} 当前不可执行：${p.stateReason}`; return renderMain(); }
  // 提交后不再占着表单：请求交给后台条目（列表顶部显示进度），页面立刻回到空白的新建表单
  const draft = rtImageDraft("new");
  const noteRef = draft.noteRef;
  const recommendationRef = draft.recommendationRef;
  const req = {
    key: rtKey(), ...(typeof scheduledFor === "string" ? { scheduledFor } : {}), runtimeKind: f.runtimeKind, workspace: f.workspace.trim(), prompt: f.prompt, attachmentIds: rtImageIds("new"),
    ...(f.model ? { model: f.model } : {}), ...(f.effort ? { effort: f.effort } : {}), ...(f.worktree ? { worktree: true } : {}), ...(f.runtimeKind === "pi" && f.permissionMode === "pi-ask" && f.browserProfileId ? { browserProfileId: f.browserProfileId } : {}), permissionMode: f.permissionMode,
    ...(recommendationRef ? { recommendationRef: { ...recommendationRef } } : noteRef?.noteId ? { noteId: noteRef.noteId } : {})
  };
  const images = draft.images.filter(i => i.state === "ready").map(i => ({ ...i }));
  rtClearImageDraft("new"); ui.rt.form = null; ui.rt.draftsByRuntime = {}; ui.rt.confirm = null; ui.rt.formError = ""; ui.rt.busy = "";
  const job = rtBgSubmit(req, images, rtNewSubmitOrigin());
  if (rtNewFromList() && rtPhone.matches) {
    // 手机：从会话列表来就回会话列表；列表顶部「正在创建」条目显示进度
    announce("已提交：会话在后台创建，可在会话列表查看");
    rtLeaveNewAfterSubmit();
  } else {
    // 别处发起（待办、记忆、推荐任务、图片导入）与 PC：发送后直接进入这条会话的详情页。
    // 创建是后台异步的，先按会话详情页的版式显示「正在创建」，拿到会话 ID 后原地换成真实详情。
    announce("已提交：正在创建会话");
    ui.rt.launch = job;
    renderMain();
  }
}

/** 创建会话；失败时就地重试，结果未知时保留同一个请求键核对。 */
async function rtCreateSession(c) {
  if (ui.rt.busy) return;
  const launch = ui.rt.launch || { form: c, images: rtImageDraft("new").images.filter(i => i.state === "ready").map(i => ({ ...i })) };
  ui.rt.launch = launch; launch.phase = "create"; launch.request = c; launch.error = "";
  rtImageDraft("new").pending = c; rtSaveImageDraft("new", c.prompt);
  ui.rt.busy = "create"; ui.rt.formError = ""; renderMain();
  try {
    const noteRef = rtImageDraft("new").noteRef;
    const r = await api("/api/runtime-sessions", { method: "POST", onDeploymentWait: () => { launch.phase = "deployment"; if (ui.view === "rt-new" && ui.rt.launch === launch) renderMain(); }, body: JSON.stringify({
      idempotencyKey: c.key, ...(c.scheduledFor ? { scheduledFor: c.scheduledFor } : {}), runtimeKind: c.runtimeKind, workspace: c.workspace, prompt: c.prompt, attachmentIds: c.attachmentIds || [],
      ...(c.model ? { model: c.model } : {}), ...(c.effort ? { effort: c.effort } : {}), ...(c.worktree ? { worktree: true } : {}), ...(c.runtimeKind === "pi" && c.browserProfileId ? { browserProfileId: c.browserProfileId } : {}), ...(c.recommendationRef ? { recommendationId: c.recommendationRef.taskId, recommendationRevision: c.recommendationRef.revision } : noteRef?.noteId ? { noteId: noteRef.noteId } : {}), permissionMode: c.permissionMode, confirmedProfileVersion: c.preview.profileVersion
    }) });
    const id = r.session.platformSessionId;
    // 从今天卡片发起的推荐任务：待办页可能已经返回并停在屏幕上，就地刷新推荐栏。
    if (c.recommendationRef && typeof noteRecommendationLaunched === "function") noteRecommendationLaunched(c.recommendationRef.taskId, id);
    // 部署排空时只建了会话：首条消息还在排队，不能把它当成已发送的消息画进对话。
    const deferredFirstTurn = !(r.session.turns?.length);
    // The POST response seeds display only; GET still confirms permission to act.
    sessionSnapshotPut(`rt:${id}`, {
      view: { session: r.session, readOnly: false, approvals: [], notes: [], usage: { semantics: "正在读取用量…" } }, events: [],
      ...(deferredFirstTurn ? {} : { initialOutgoing: { text: c.prompt, images: launch.images, accepted: true, seq: 0,
        ...(r.session.turns?.[0]?.clientMessageId ? { eventKey: `user:${r.session.turns[0].clientMessageId}` } : {}) } }),
      atBottom: true, reading: { atBottom: true, top: 0 }, tab: "chat"
    });
    const active = ui.view === "rt-new" && ui.rt.launch === launch;
    const away = active && rtPageAway();
    if (!away) ui.rt.launch = null;
    if (launch.draft?.trim()) { ui.rt.drafts[id] = launch.draft; rtSaveImageDraft(id, launch.draft); }
    rtClearImageDraft("new"); ui.rt.confirm = null; ui.rt.form = null; ui.rt.draftsByRuntime = {}; if (active) ui.rt.busy = "";
    if (away) {
      // 已经切到其他应用：把「创建中」就地换成「已创建」，不把用户从离开时的页面带走。
      launch.phase = "done"; launch.createdId = id; ui.rt.launch = launch;
      renderMain();
    }
    announce(r.replayed ? "这个请求已经提交过，打开原会话" : deferredFirstTurn ? "已创建：首条消息将在部署完成后发送" : "已发送：正在创建会话");
    if (active && !away) { if (typeof rtPrepareDetailOrigin === "function") rtPrepareDetailOrigin(id, launch.origin || null); rtEnterCreated(`#/rt/${id}`); }
    return;
  } catch (e) {
    ui.rt.confirm = c;
    ui.rt.formError = e.status >= 500 || !e.status ? `结果未知：${e.message}。再点一次会用同一个请求键核对，不会重复创建。` : e.message;
    launch.error = ui.rt.formError; launch.unknown = e.status >= 500 || !e.status;
    launch.recommendationChanged = e.status === 409 && !!c.recommendationRef && /推荐版本已变化|推荐正在更新、已过期或需要先决策|来源已变化，请重新生成推荐/.test(e.message);
    if (launch.recommendationChanged) launch.error = "原推荐已变化，尚未创建会话。可按当前输入内容创建独立会话，或返回待办查看最新推荐。";
    if (e.status && e.status < 500) { delete rtImageDraft("new").pending; rtSaveImageDraft("new"); }
    if (e.status === 409 && /重新检查过/.test(e.message)) { ui.rt.confirm = null; launch.request = null; await rtLoadProfiles(); }
  }
  if (ui.view === "rt-new" && ui.rt.launch === launch) { ui.rt.busy = ""; renderMain(); }
}

function rtConfirmView(c) {
  const p = c.profile;
  const create = () => rtCreateSession(c);
  return h("div", { class: "rt-form-page" },
    h("h1", {}, "确认创建"), rtAttachmentHistory(rtImageDraft("new").images.filter(i => i.state === "ready")),
    h("div", { class: "rt-banner warn", role: "note" }, `使用 ${RT_KIND[c.runtimeKind]} 的 ${c.preview.permissions.label} 模式运行，尚未启用完整 pi-agent 合约门禁。`),
    h("dl", { class: "kv rt-confirm" },
      h("dt", {}, "运行时"), h("dd", {}, `${RT_KIND[c.runtimeKind]} ${p.binaryVersion || ""}${p.sdkVersion ? `（Agent SDK ${p.sdkVersion}）` : ""}`),
      h("dt", {}, "宿主机"), h("dd", {}, `${p.hostLabel}（运行目录、凭据与 transcript 都在这台机器上）`),
      h("dt", {}, "账号"), h("dd", {}, p.identity ? `${p.identity.summary} · ${p.identity.authMode}` : "未知"),
      h("dt", {}, "工作目录"), h("dd", { class: "mono" }, c.workspace),
      h("dt", {}, "改动位置"), h("dd", {}, c.worktree ? "独立 worktree：从仓库的 main 切出，分支 pi/<会话>；改完可在会话页「提交并在空闲时部署」" : "直接在工作目录里改"),
      h("dt", {}, "模型"), h("dd", {}, c.model || "runtime 默认"),
      h("dt", {}, "推理强度"), h("dd", {}, c.effort || rtDefaultEffortLabel(rtModelOption(p, c.model))),
      h("dt", {}, "执行模式"), h("dd", {}, "runtime-native（本轮完成不等于合约验收）"),
      h("dt", {}, "权限"), h("dd", {}, h("strong", {}, c.preview.permissions.label), h("div", { class: "muted small" }, c.preview.permissions.detail)),
      h("dt", {}, "生效配置"), h("dd", {}, h("ul", { class: "small" }, c.preview.lines.map((l) => h("li", {}, l)))),
      h("dt", {}, "首条消息"), h("dd", {}, h("pre", { class: "rt-code" }, h("code", {}, c.prompt)))),
    ui.rt.formError ? h("p", { class: "field-error", role: "alert" }, ui.rt.formError) : null,
    h("div", { class: "rt-actions" },
      h("button", { type: "button", class: "btn", disabled: ui.rt.busy === "create", onclick: () => { ui.rt.confirm = null; renderMain(); } }, "返回修改"),
      h("button", { type: "button", class: "btn primary", disabled: ui.rt.busy === "create", onclick: create }, ui.rt.busy === "create" ? "提交中…" : "创建并运行")));
}
globalThis.piRouteModules?.register("rt-new", { render: () => renderRtNewWorkbench() });
