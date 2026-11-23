"use strict";
/*
 * 平台设置：独立页面，有自己的一条导航栏。
 * 目录按七组排列；只有一个条目的组直接显示条目（组名即条目名，不重复出两行标题）：
 * - 通用：通用能力（通知、PC 剪贴板图片与链接识别、相册、保持竖屏）/ 产物区（导航设置）/ 应用（启用 / 关闭可选应用，基础应用始终开启）/ 运行时 / 会话缓存。
 * - 记忆：公共记忆列表 + 提炼与注入配置。
 * - 资源：模型、搜索、抓取、配音的凭据状态、用量与余额。
 * - 统计：消耗、会话、部署的趋势与拆解（独立应用，用链接进入）。
 * - 自迭代 / 定时任务：每晚错误统计与 Codex Reset 扫描。
 * - 版本：运行时版本（Pi / Claude Code / Codex 新稳定版）/ 平台前端版本（线上版本与部署历史）/ 平台 APP 版本（只在 Android 客户端里出现）。
 * - 登录管理：登录会话列表、吊销、退出其他登录、退出登录。
 * 旧地址（#/settings/errorstats、#/settings/codexreset）由 app.js 重定向到合并后的定时任务页；
 * 安装历史挪到 #/settings/appversion/installs，旧的 #/settings/version/installs 转过去。
 */
(function () {
  // 分组顺序即目录顺序：同组条目连续排列，目录里先出组名再出条目。
  const GROUPS = [
    { id: "general", label: "通用" },
    { id: "memory", label: "记忆" },
    { id: "resources", label: "资源" },
    { id: "stats", label: "统计" },
    { id: "scheduled", label: "自迭代 / 定时任务" },
    { id: "versions", label: "版本" },
    { id: "login", label: "登录管理" },
  ];
  // 每一项的说明都是详情页里的一个关键状态（通知/截图开关、入口数、缓存开关、线上版本、记录开关），
  // 读不到状态时退回原来的静态描述，所以目录在脚本没加载完时也不会空着。
  // 单项组的条目名 = 组名；show 返回 false 的条目不进目录，地址也回到目录（平台 APP 版本只在 Android 客户端里有）。
  const SECTIONS = [
    { id: "capabilities", group: "general", label: "通用能力", hint: capabilityHint },
    { id: "navigation", group: "general", label: "产物区", hint: navigationHint },
    { id: "apps", group: "general", label: "应用", hint: appsHint },
    { id: "runtimes", group: "general", label: "运行时", hint: runtimesHint },
    { id: "cache", group: "general", label: "会话缓存", hint: cacheHint },
    { id: "memory", group: "memory", label: "记忆", hint: memoryHint },
    { id: "resources", group: "resources", label: "资源", hint: resourcesHint },
    { id: "stats", group: "stats", label: "统计", hint: () => "消耗、会话、部署的趋势与拆解", href: "#/stats" },
    { id: "scheduled", group: "scheduled", label: "自迭代 / 定时任务", hint: scheduledHint },
    { id: "runtimeupdates", group: "versions", label: "运行时版本", hint: runtimeUpdatesHint },
    { id: "version", group: "versions", label: "平台前端版本", hint: versionHint },
    { id: "appversion", group: "versions", label: "平台 APP 版本", hint: appVersionHint, show: () => Boolean(window.piAndroidShell?.available) },
    { id: "login", group: "login", label: "登录管理", hint: loginHint },
  ];
  const visibleSections = () => SECTIONS.filter((item) => !item.show || item.show());
  function capabilityHint() {
    const notifications = window.sessionNotifications;
    const clipboard = window.piClipboardImages;
    if (typeof notifications?.supported !== "function" || typeof clipboard?.supported !== "function") return "本设备通知与截图";
    const notify = !notifications.supported() ? "通知不可用" : notifications.enabled?.() ? "通知已开" : "通知未开";
    const shot = !clipboard.supported() ? "截图不可用" : clipboard.enabled?.() ? "截图已开" : "截图未开";
    return `${notify} · ${shot}`;
  }
  // 产物区：说明报导航的入口数／位置。
  function navigationHint() {
    const nav = document.querySelector(".tabs");
    if (!nav) return "名称、位置与顺序";
    const shown = [...nav.querySelectorAll(":scope > .tab[data-view]:not([data-offline])")].filter((el) => !el.hidden).length;
    if (!shown) return "名称、位置与顺序";
    const total = document.querySelectorAll(".tab[data-view]:not([data-offline])").length;
    const inMore = document.querySelectorAll("#nav-more .tab[data-view]:not([data-offline])").length;
    const hiddenCount = Math.max(0, total - shown - inMore);
    const place = phone.matches ? "底部标签" : "侧栏";
    return `${shown} 个入口 · ${place}${hiddenCount ? ` · 隐藏 ${hiddenCount}` : ""}`;
  }
  // 外部资源：先报服务数量，再报有多少个服务的状态还没确认（凭据未验证、最近调用失败、额度读不到）。
  function resourcesHint() {
    let data = null;
    try { data = typeof ui === "undefined" ? null : ui.resources; } catch { /* 没加载资源模块 */ }
    if (!data || !Array.isArray(data.services)) return "模型、搜索、抓取的凭据与余额";
    const pending = data.services.filter((s) => ["not-configured", "configured-unverified", "last-failed", "quota-unavailable"].includes(s.state)).length;
    return `${data.services.length} 个服务${pending ? ` · ${pending} 个待确认` : " · 状态正常"}`;
  }
  // 平台记忆：条数来自记忆面板自己读到的列表（没读过就退回静态描述）。
  function memoryHint() {
    if (typeof window.piMemoryHint !== "function") return "公共记忆、提炼与注入";
    try { return window.piMemoryHint(); } catch { return "公共记忆、提炼与注入"; }
  }
  // 定时任务：每晚两个任务合并成一页，说明一条给统计、一条给 Codex 重置卡。
  function scheduledHint() {
    return `错误统计：${errorStatsHint()} · Codex：${codexResetHint()}`;
  }
  // 应用：先报有多少个可选应用开着；还没读到时退回静态说明，目录不会空着。
  function appsHint() {
    const view = state().appsView;
    if (!view) return "可选应用的开关，基础应用始终开启";
    if (!view.apps.length) return "只有基础应用";
    return `${view.apps.filter((app) => app.enabled).length} / ${view.apps.length} 个可选应用已开启`;
  }
  function loginHint() {
    const a = state().auth;
    if (!a) return "登录会话与退出登录";
    if (!a.enabled || !a.public) return "未启用登录";
    const active = (a.sessions || []).filter((x) => x.active).length;
    return `${active} 个有效登录 · 可退出`;
  }
  // 应用开关：读取服务端当前状态；切换后整份落到服务端，再由 route-loader 缓存并刷新页面，入口与模块按新状态重新装配。
  async function loadApps() {
    const s = state();
    s.appsLoaded = true;
    try { s.appsView = await api("/api/apps"); s.appsError = ""; }
    catch (error) { s.appsError = error?.message || "读取应用列表失败"; }
    if (ui.view === "settings" && section() === "apps") renderMain();
  }
  async function toggleApp(app, enabled) {
    const s = state();
    s.appsBusy = app.id; s.appsError = "";
    renderMain();
    try {
      const view = await api(`/api/apps/${encodeURIComponent(app.id)}`, { method: "PUT", body: JSON.stringify({ enabled }) });
      s.appsView = view;
      announce(enabled ? `已打开${app.name}` : `已关闭${app.name}，数据保留`);
      // 入口和路由模块在启动时装配：清单变了就刷新一次页面（commit 内部判断，没变不刷新）。
      window.piApps?.commit?.(view);
    } catch (error) { s.appsError = error?.message || "保存失败，请重试"; }
    finally { s.appsBusy = ""; if (ui.view === "settings" && section() === "apps") renderMain(); }
  }
  function appsSection() {
    const s = state();
    if (!s.appsLoaded) void loadApps();
    const view = s.appsView;
    const intro = h("section", { class: "card settings-card", "data-apps-intro": "" },
      h("div", { class: "settings-card-head" }, h("div", {},
        h("h2", {}, "可选应用"),
        h("p", { class: "muted small" }, "会话、群聊、记忆、产物和设置是基础应用，始终开启。下面是可选应用：关闭后入口和功能隐藏、后台任务停止，已有数据都保留，随时可以重新打开。"))),
      s.appsError ? h("p", { class: "field-error", role: "alert" }, s.appsError,
        h("button", { type: "button", class: "btn small", onclick: () => { s.appsError = ""; void loadApps(); } }, "重试")) : null,
      !view && !s.appsError ? h("p", { class: "muted small" }, "正在读取应用列表…") : null,
      view && !view.apps.length ? h("p", { class: "muted small" }, "这个版本没有可开关的可选应用。") : null);
    const rows = (view?.apps || []).map((app) => {
      const busy = s.appsBusy === app.id;
      const control = h("input", { type: "checkbox", role: "switch", class: "settings-switch", "aria-label": app.name, checked: app.enabled, disabled: !!s.appsBusy,
        onchange: (event) => { event.target.checked = app.enabled; void toggleApp(app, !app.enabled); } });
      const notes = [
        app.alsoOff.length ? `关闭后「${app.alsoOff.join("、")}」也会一起关闭。` : "",
        !app.enabled && app.needs.length ? `打开时会一并打开「${app.needs.join("、")}」。` : "",
      ].filter(Boolean);
      return h("section", { class: "card settings-card", "data-app-switch": app.id },
        h("div", { class: "settings-switch-row" }, h("h2", {}, app.name), control),
        h("p", { class: "muted small" }, app.description),
        notes.length ? h("p", { class: "muted small" }, notes.join("")) : null,
        busy ? h("p", { class: "muted small", role: "status" }, "正在保存…") : null);
    });
    return [intro, ...rows];
  }
  function runtimesHint() {
    const profiles = typeof ui === "undefined" ? null : ui.rt?.profiles;
    if (!Array.isArray(profiles) || !profiles.length) return "连接检查、模型与授权";
    const ready = profiles.filter((p) => p && p.state === "executable").length;
    const login = profiles.filter((p) => p && p.state === "needs-login").length;
    return `${ready}/${profiles.length} 个可执行${login ? ` · ${login} 个待登录` : ""}`;
  }
  // 红点 = 有没被忽略的新稳定版。设置页每次打开只读一次小结（详情页里读完整数据），不打断别的页面。
  function runtimeUpdatesAlerts() {
    const s = state();
    return s.runtimeUpdates ? s.runtimeUpdates.runtimes.filter((r) => r.alert).map((r) => ({ kind: r.kind, label: r.label, installed: r.installed, latest: r.latest })) : s.ruSummary?.items || [];
  }
  function runtimeUpdatesHint() {
    const s = state();
    const alerts = runtimeUpdatesAlerts();
    if (alerts.length) return `${alerts.length} 个有新稳定版：${alerts.map((a) => `${(a.label || "").split("（")[0]} ${a.latest}`).join("、")}`;
    if (s.runtimeUpdates || s.ruSummary) return "三个 runtime 都是最新稳定版或已忽略";
    return "新稳定版检测、更新记录与风险分析";
  }
  async function loadRuntimeUpdatesSummary() {
    const s = state();
    if (s.ruSummaryLoading || (s.ruSummaryAt && Date.now() - s.ruSummaryAt < 5 * 60_000)) return;
    s.ruSummaryLoading = true;
    s.ruSummaryAt = Date.now(); // 成功失败都记：失败也要隔 5 分钟再试，否则「读完 → 重绘 → 再读」会循环
    let next = null;
    try {
      // 红点用的小结直接 fetch：不占设置页的 api 读队列，失败（未登录等）就当没有
      const res = await fetch("/api/runtime-updates/summary", { credentials: "same-origin", headers: { accept: "application/json" } });
      if (res.ok) next = await res.json();
    } catch { /* 没登录或服务没接上：不显示红点 */ }
    s.ruSummaryLoading = false;
    if (next && JSON.stringify(next) !== JSON.stringify(s.ruSummary)) { s.ruSummary = next; if (ui.view === "settings") renderMain(); }
  }
  function cacheHint() {
    let disk = null;
    try { disk = typeof sessionDisk === "undefined" ? null : sessionDisk; } catch { /* 没加载缓存模块 */ }
    if (!disk) return "本机正文与清除";
    return disk.enabled ? "已开启 · 正文留 7 天" : "未开启 · 打开读服务器";
  }
  function appVersionHint() {
    const u = window.piNativeUpdate?.state?.();
    if (u?.available) return `有新版本 ${u.versionName || ""}`.trim();
    return "Android 客户端更新与安装历史";
  }
  function versionHint() {
    const s = state();
    hydrateSnapshot();
    const data = s.deployments;
    if (!data) return "部署历史";
    const parts = [];
    if (data.live) parts.push(`线上 ${shortSha(data.live)}`);
    if (typeof data.periods?.today?.total === "number") parts.push(`今日 ${data.periods.today.total} 次`);
    return parts.length ? parts.join(" · ") : "部署历史";
  }
  function errorStatsHint() {
    const data = state().errorStats;
    if (!data) return "手动统计与运行历史";
    if (data.running) return "统计中…";
    const last = (data.runs || []).find((r) => r.status === "ok" || r.status === "failed");
    return last ? `上次 ${beijing(last.startedAt)} · 新建待办 ${(last.created || []).length} 条` : "还没有统计记录";
  }
  // Codex reset 卡：每晚北京时间 23:30 自动扫一次，这里显示可用张数与近 7 天用掉的张数。
  function codexResetHint() {
    const data = state().codexReset;
    if (!data) return "每晚扫一次可用与使用情况";
    if (data.running) return "扫描中…";
    if (!data.auth?.ok) return "没读到 Codex 登录态";
    return `${data.availableCount ?? 0} 张可用 · 近 7 天用 ${data.stats?.used7d ?? 0} 张`;
  }
  function hintOf(item) {
    return typeof item.hint === "function" ? item.hint() : item.hint;
  }
  // 设置按钮上的红点（nav-settings.js 的 syncCapabilityAlert）= 这里列出的能力“设备支持但还没开”。
  // 目录保留能力入口提示；详情页由开关直接表达状态。
  function pendingCapabilities() {
    const list = [];
    const notifications = window.sessionNotifications, clipboard = window.piClipboardImages;
    if (notifications?.supported?.() && !notifications.enabled?.()) list.push({ id: "notifications", label: "本设备通知" });
    if (clipboard?.supported?.() && !clipboard.enabled?.()) list.push({ id: "clipboard", label: window.piAndroidShell?.available ? "App 剪贴板图片与链接识别" : "PC 剪贴板图片与链接识别" });
    if (window.piRecentPhotos?.supported?.() && !window.piRecentPhotos.enabled()) list.push({ id: 'photos', label: '相册新图片' });
    return list;
  }
  /** 能力开关变化时就地刷新红点与目录项提示，不重绘整页（避免打断正在操作的开关）。 */
  function syncCapabilityMarks() {
    const pending = pendingCapabilities();
    const nav = document.querySelector('[data-settings-nav="capabilities"]');
    if (nav) {
      nav.classList.toggle("has-alert", pending.length > 0);
      const hint = nav.querySelector(".settings-nav-hint");
      if (hint) hint.textContent = capabilityHint();
    }
  }
  window.addEventListener("pi-capabilities-change", syncCapabilityMarks);
  const VERSION_PAGE = 20;
  const phone = window.matchMedia("(max-width: 760px)");

  function state() {
    if (!ui.settings) ui.settings = {};
    if (!ui.settings.section) ui.settings.section = "home";
    if (ui.settings.returnHash === undefined) ui.settings.returnHash = "#/rt";
    if (ui.settings.auth === undefined) ui.settings.auth = null;
    if (ui.settings.authError === undefined) ui.settings.authError = "";
    if (ui.settings.authLoaded === undefined) ui.settings.authLoaded = false;
    if (ui.settings.deployments === undefined) ui.settings.deployments = null;
    if (ui.settings.deployError === undefined) ui.settings.deployError = "";
    if (ui.settings.deployLoading === undefined) ui.settings.deployLoading = false;
    if (ui.settings.deployLoadingMore === undefined) ui.settings.deployLoadingMore = false;
    if (ui.settings.deployMoreError === undefined) ui.settings.deployMoreError = "";
    if (ui.settings.deploySentinel === undefined) ui.settings.deploySentinel = null;
    if (ui.settings.deployFolds === undefined) ui.settings.deployFolds = {};
    if (ui.settings.heatRuntime === undefined) ui.settings.heatRuntime = "all";
    if (ui.settings.deployFoldAt === undefined) ui.settings.deployFoldAt = 0;
    if (ui.settings.deployAttempted === undefined) ui.settings.deployAttempted = false;
    if (ui.settings.deployStale === undefined) ui.settings.deployStale = false;
    if (ui.settings.deploySnapshotAt === undefined) ui.settings.deploySnapshotAt = "";
    if (ui.settings.deployHydrated === undefined) ui.settings.deployHydrated = false;
    if (ui.settings.resourcesLoaded === undefined) ui.settings.resourcesLoaded = false;
    return ui.settings;
  }
  function section() {
    const wanted = state().section;
    return wanted === "home" || visibleSections().some((x) => x.id === wanted && !x.href) ? wanted : "home";
  }
  function sectionHref(id) { return `#/settings/${id}`; }
  function backHref() {
    const target = state().returnHash;
    return typeof target === "string" && target.startsWith("#/") && !target.startsWith("#/settings") ? target : "#/rt";
  }
  function shortSha(sha) {
    return (sha || "").slice(0, 7) || "—";
  }
  function when(value) {
    if (!value) return "—";
    const date = new Date(String(value).replace(" ", "T"));
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
  }
  function ago(value) {
    if (!value) return "";
    const date = new Date(String(value).replace(" ", "T"));
    if (Number.isNaN(date.getTime())) return "";
    const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}天前`;
    const months = Math.floor(days / 30);
    return months < 12 ? `${months}个月前` : `${Math.floor(months / 12)}年前`;
  }
  function monthLabel(key) {
    const [year, month] = key.split("-");
    return `${year}年${Number(month)}月`;
  }
  function dayLabel(key) {
    const date = new Date(`${key}T00:00:00`);
    if (Number.isNaN(date.getTime())) return key;
    return `${date.getMonth() + 1}月${date.getDate()}日 ${["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()]}`;
  }
  function outcomeLabel(entry) {
    if (entry.state === "ok") return "已上线";
    if (entry.state === "failed") {
      const code = String(entry.outcome || "").split(":")[1];
      return code ? `失败（退出码 ${code}）` : "失败";
    }
    if (entry.state === "cancelled") return "已取消";
    if (entry.state === "expired") return "等待超时";
    if (entry.state === "already-live") return "已在线上";
    return "已结束";
  }
  function noteLabel(note) {
    if (!note) return "";
    if (note === "main:moved") return "main 已快进";
    if (note === "main:contained") return "main 已包含";
    if (note.startsWith("main:")) return `main ${note.slice(5)}`;
    return note;
  }
  // 上次成功读到的统计（含第一页历史）存在本机，下次进「版本」先显示它，再后台同步。
  const SNAPSHOT_KEY = "pi-agent.deploy-stats.v1";
  function saveSnapshot(value) {
    try {
      if (!value || !Array.isArray(value.entries) || !value.periods) return;
      const { active, progress, ...rest } = value;
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ savedAt: new Date().toISOString(), data: { ...rest, active: [], statsTimeZone: "Asia/Shanghai" } }));
    } catch { /* 存储满了或被禁用：下次照常等网络 */ }
  }
  function hydrateSnapshot() {
    const s = state();
    if (s.deployments || s.deployHydrated) return;
    s.deployHydrated = true;
    try {
      const cached = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || "null");
      const data = cached?.data;
      if (!data || !Array.isArray(data.entries) || !Array.isArray(data.calendar) || !data.periods) return;
      s.deployments = data;
      s.deployStale = true;
      s.deploySnapshotAt = typeof cached.savedAt === "string" ? cached.savedAt : "";
    } catch { /* 没有快照或已损坏：照常等网络 */ }
  }
  function loadDeployments(force = false, more = false) {
    const s = state();
    if (more) {
      if (s.deployLoading || s.deployLoadingMore || !s.deployments) return;
      if (s.deployments.entries.length >= s.deployments.total) return;
      const offset = s.deployments.entries.length;
      s.deployLoadingMore = true;
      s.deployMoreError = "";
      if (ui.view === "settings" && section() === "version") renderMain();
      api(`/api/platform/deployments?limit=${VERSION_PAGE}&offset=${offset}&tz=Asia/Shanghai`)
        .then((value) => {
          const current = s.deployments;
          s.deployments = { ...value, statsTimeZone: "Asia/Shanghai", entries: [...(current?.entries ?? []), ...value.entries] };
        })
        .catch((error) => { s.deployMoreError = error.message; })
        .finally(() => {
          s.deployLoadingMore = false;
          if (ui.view === "settings" && section() === "version") renderMain();
        });
      return;
    }
    if (s.deployLoading || s.deployLoadingMore) return;
    // 先把上次的快照摆出来（不等网络），再在后台拉最新统计；服务端也是「快照 + 增量」，通常几毫秒。
    hydrateSnapshot();
    if (!force && s.deployAttempted) return;
    s.deployAttempted = true;
    s.deployLoading = true;
    s.deployError = "";
    s.deployMoreError = "";
    api(`/api/platform/deployments?limit=${VERSION_PAGE}&offset=0&tz=Asia/Shanghai`)
      .then((value) => {
        s.deployments = { ...value, statsTimeZone: "Asia/Shanghai" };
        s.deployStale = false;
        s.deploySnapshotAt = "";
        saveSnapshot(value);
      })
      .catch((error) => { s.deployError = s.deployStale ? `同步最新统计失败：${error.message}（先显示上次快照）` : error.message; })
      .finally(() => {
        s.deployLoading = false;
        if (ui.view === "settings" && section() === "version") renderMain();
      });
  }

  let historyObserver = null;
  function observeHistorySentinel() {
    historyObserver?.disconnect();
    historyObserver = null;
    const s = state();
    if (ui.view !== "settings" || section() !== "version" || !s.deploySentinel || !s.deployments) return;
    if (s.deployments.entries.length >= s.deployments.total || s.deployMoreError) return;
    if (typeof IntersectionObserver !== "function") return;
    historyObserver = new IntersectionObserver((entries) => {
      // 折叠会让 sentinel 立刻进入视口：这次不算“滚动到底”，避免一折叠就自动加载旧记录。
      if (Date.now() - (s.deployFoldAt || 0) < 700) return;
      if (entries.some((entry) => entry.isIntersecting)) loadDeployments(false, true);
    }, { rootMargin: "240px 0px" });
    historyObserver.observe(s.deploySentinel);
  }

  /** #/settings/appversion/installs：Android 客户端的安装历史明细页（卡片里只放摘要和入口）。 */
  function installsRoute() { return section() === "appversion" && state().extra === "installs"; }
  function installsSection() {
    const page = window.piAndroidShell?.installsPage?.();
    return page ? [page] : [h("section", { class: "card settings-card" }, h("p", { class: "muted small" }, "安装历史只在 Android 客户端里可用。"))];
  }

  function settingsHeader() {
    const detail = phone.matches && section() !== "home";
    const item = SECTIONS.find((item) => item.id === section());
    // 平台 APP 版本 → 安装历史是设置里的下一层页面：任何屏幕上返回都回到「平台 APP 版本」，标题就是页面本身。
    const sub = installsRoute();
    return h("header", { class: "settings-app-head page-navigation-head" },
      section() !== "home" ? h("a", { class: "settings-back", href: sub ? "#/settings/appversion" : detail ? "#/settings" : backHref(), "aria-label": sub ? "返回平台 APP 版本" : detail ? "返回设置" : "返回上一页" }, "‹ 返回") : null,
      h("div", { class: "settings-app-title" },
        h("h1", {}, sub ? "安装历史" : detail ? item.label : "系统设置")));
  }

  function settingsNav() {
    const current = section() === "home" && !phone.matches ? "navigation" : section();
    const groups = [];
    for (const item of visibleSections()) {
      let group = groups.at(-1);
      if (!group || group.id !== item.group) {
        group = { id: item.group, label: GROUPS.find((g) => g.id === item.group)?.label || "", items: [] };
        groups.push(group);
      }
      group.items.push(item);
    }
    const link = (item) => h("a", {
      class: `settings-nav-item${item.id === current ? " on" : ""}${(item.id === "capabilities" && pendingCapabilities().length) || (item.id === "runtimeupdates" && runtimeUpdatesAlerts().length) ? " has-alert" : ""}`,
      href: item.href || sectionHref(item.id),
      "data-settings-nav": item.id,
      ...(item.id === current ? { "aria-current": "page" } : {}),
    },
      h("span", { class: "settings-nav-head" },
        h("span", { class: "settings-nav-label" }, item.label),
        item.id === "capabilities" ? h("span", { class: "settings-alert-dot", title: "有能力尚未开启", "aria-label": "有能力尚未开启" }) : null,
        item.id === "runtimeupdates" ? h("span", { class: "settings-alert-dot", title: "有 runtime 出了新稳定版", "aria-label": "有 runtime 出了新稳定版" }) : null,
        item.id === "appversion" ? window.piNativeUpdate?.badge?.() ?? null : null),
      h("span", { class: "settings-nav-hint" }, hintOf(item)),
      h("span", { class: "settings-nav-arrow", "aria-hidden": "true" }, "›"));
    return h("nav", { class: "settings-app-nav", "aria-label": "设置导航" },
      h("span", { class: "settings-app-nav-label" }, "系统设置"),
      groups.map((group) => h("div", { class: "settings-nav-group", "data-settings-group": group.id },
        // 单项组的条目名就是组名：不再多出一行同名的组标题。
        group.items.length > 1 ? h("span", { class: "settings-nav-group-label" }, group.label) : null,
        group.items.map(link))));
  }

  function syncCapabilityCard(current, next) {
    const control = current.querySelector('[role=switch]'), updated = next.querySelector('[role=switch]');
    control.checked = updated.checked; control.disabled = updated.disabled;
    current.className = next.className;
    // The heading and switch stay mounted; refresh only descriptions/actions.
    while (current.children.length > 1) current.lastElementChild.remove();
    current.append(...[...next.children].slice(1));
  }
  let clipboardBusy = false, clipboardMessage = '';
  function clipboardSection() {
    const clipboard = window.piClipboardImages;
    const label = window.piAndroidShell?.available ? 'App 剪贴板图片与链接识别' : 'PC 剪贴板图片与链接识别';
    const supported = !!clipboard?.supported?.(), on = !!clipboard?.enabled?.();
    const button = h("input", { type: "checkbox", role: "switch", class: "settings-switch", "aria-label": label, checked: on, disabled: clipboardBusy || !supported,
      onchange: async () => {
        clipboardBusy = true; clipboardMessage = ''; refreshClipboard();
        try {
          if (clipboard.enabled()) clipboard.disable();
          else if (!await window.imageIntake?.enableClipboard?.()) clipboardMessage = '未能开启，请允许浏览器访问剪贴板后重试。';
        } catch (error) { clipboardMessage = error.message || '剪贴板识别开启失败，请重试'; }
        finally { clipboardBusy = false; refreshClipboard(); }
      } });
    return h('section', { class: 'card settings-card', 'data-clipboard-settings': '' },
      h('div', { class: 'settings-switch-row' }, h('h2', {}, label), button),
      h('p', { class: 'muted small' }, '仅保存在本设备。回到 pi-agent 或剪贴板变化时检测图片与链接，可记录待办或发起会话；App 中点按链接圆圈可直接浏览。'),
      window.piAndroidShell?.available && supported && clipboard.linksSupported?.() === false ? h('p', { class: 'muted small' }, '当前 App 仅支持图片识别，链接识别需要升级至支持此功能的新版 App。') : null,
      h('div', { class: 'settings-capability-actions' },
        h('span', { role: 'status', hidden: supported && !clipboardMessage }, clipboardMessage || (!supported ? '当前设备或浏览器不支持，可直接粘贴或选择图片' : ''))));
  }
  function refreshClipboard() {
    const current = document.querySelector('[data-clipboard-settings]');
    if (!current) return;
    const focused = current.contains(document.activeElement);
    const next = clipboardSection(); syncCapabilityCard(current, next);
    if (focused) current.querySelector('[role=switch]:not(:disabled)')?.focus();
  }
  window.addEventListener('pi-capabilities-change', refreshClipboard);
  let photosBusy = false, photosMessage = '';
  function photosSection() {
    if (!window.piAndroidShell?.available) return null;
    const photos = window.piRecentPhotos, supported = !!photos?.supported?.(), on = !!photos?.enabled?.();
    const limited = photos?.permission?.() === 'limited';
    async function allow() {
      photosBusy = true; photosMessage = ''; refreshPhotos();
      try { await photos.enable(); }
      catch (error) { photosMessage = error.message || '照片权限未开启'; }
      finally { photosBusy = false; refreshPhotos(); }
    }
    return h('section', { class: 'card settings-card', 'data-photo-settings': '' },
      h('div', { class: 'settings-switch-row' }, h('h2', {}, '相册新图片'),
        h('input', { type: 'checkbox', role: 'switch', class: 'settings-switch', 'aria-label': '相册新图片', checked: on, disabled: photosBusy || !supported, onchange: () => { if (photos.enabled()) { photos.disable(); refreshPhotos(); } else void allow(); } })),
      h('p', { class: 'muted small' }, '首次授权读取最新一张；回到 App 时，只提示上次成功检查后新增的最新一张。点击输入框旁的图片气泡才上传。'),
      h('div', { class: 'settings-capability-actions' },
        limited && on ? h('button', { type: 'button', class: 'btn', disabled: photosBusy, onclick: () => void allow() }, '重新选择照片') : null,
        h('span', { role: 'status', hidden: supported && !on && !photosMessage }, photosMessage || (!supported ? '请更新 Android APK 后开启' : !on ? '' : limited ? '照片范围：仅获授权照片，新截图可能需要重新授权' : '照片范围：所有照片'))));
  }
  function refreshPhotos() {
    const current = document.querySelector('[data-photo-settings]');
    if (!current) return;
    const focused = current.contains(document.activeElement), next = photosSection();
    if (next) { syncCapabilityCard(current, next); if (focused) current.querySelector('[role=switch]:not(:disabled)')?.focus(); }
  }
  window.addEventListener('pi-capabilities-change', refreshPhotos);
  function orientationStatusIsRoutine(status) { return /^(已保持竖屏|已跟随系统方向|本次游戏已切换横屏)$/.test(status || ''); }
  function orientationSection() {
    const controller = window.piOrientation;
    return h('section', { class: 'card settings-card', 'data-orientation-settings': '' },
      h('div', { class: 'settings-switch-row' }, h('h2', {}, '保持竖屏'),
        h('input', { type: 'checkbox', role: 'switch', class: 'settings-switch', 'aria-label': '保持竖屏', checked: controller?.enabled() !== false, disabled: !controller,
          onchange: event => controller.setEnabled(event.currentTarget.checked) })),
      h('p', { class: 'muted small' }, '仅保存在本设备。游戏切换横屏前会确认，退出游戏后恢复此设置。部分浏览器需要进入全屏才能锁定方向。'),
      h('p', { class: 'muted small', role: 'status', hidden: orientationStatusIsRoutine(controller?.status()) }, controller?.status() || '方向设置正在加载，请刷新后重试。'),
      h('button', { type: 'button', class: 'btn primary', 'data-orientation-activate': '', hidden: !controller?.canActivate(), disabled: !!controller?.activating(),
        onclick: () => { void controller.requestPortrait(); } }, '进入全屏'));
  }
  window.addEventListener('pi-orientation-change', () => {
    const current = document.querySelector('[data-orientation-settings]');
    if (!current) return;
    // Keep the focused checkbox and its native interaction intact.
    const checkbox = current.querySelector('input');
    if (checkbox) checkbox.checked = window.piOrientation.enabled();
    const status = current.querySelector('[role="status"]');
    status.textContent = window.piOrientation.status(); status.hidden = orientationStatusIsRoutine(status.textContent);
    const activate = current.querySelector('[data-orientation-activate]');
    if (activate) { activate.hidden = !window.piOrientation.canActivate(); activate.disabled = window.piOrientation.activating(); }
  });
  function capabilitiesSection() {
    const notificationPanel = window.sessionNotifications?.panel?.();
    const cards = [orientationSection(), notificationPanel || h('section', { class: 'card settings-card' }, '通知设置正在加载，请稍后重试。'), clipboardSection(), photosSection()].filter(Boolean);
    return cards;
  }

  // 运行时配置（连接检查、模型可选、工作目录与历史授权、用量、本机历史）：
  // 原来在会话列表右上角「更多」里，现在作为系统设置的一行；内容与 #/runtimes 是同一份。
  function runtimesSection() {
    if (typeof window.rtRuntimesPanel !== "function") {
      return h("section", { class: "card settings-card" },
        h("h2", {}, "运行时配置"),
        h("p", { class: "muted small" }, "运行时配置还没有加载。刷新页面后再试。"));
    }
    const s = state();
    if (!s.rtLoaded && !s.rtLoading) void loadRuntimeConfig();
    return window.rtRuntimesPanel();
  }
  // 运行时配置自己的读取：能力、各 runtime 状态、设置与授权。用量要扫本机记录，不阻塞其他卡片。
  async function loadRuntimeConfig() {
    const s = state();
    const call = (name) => (typeof window[name] === "function" ? Promise.resolve().then(() => window[name]()) : Promise.resolve());
    s.rtLoading = true;
    try {
      await Promise.all([call("rtLoadAccess"), call("rtLoadProfiles"), call("rtLoadSettings")]);
      void call("rtLoadUsage").then(() => { if (ui.view === "settings" && section() === "runtimes") renderMain(); });
    } catch (error) {
      if (ui.rt) ui.rt.error = `运行时配置：${error?.message || "读取失败"}`;
    } finally {
      s.rtLoading = false;
      s.rtLoaded = true;
    }
    if (ui.view === "settings" && section() === "runtimes") renderMain();
  }

  // 产物区：导航设置（名称、位置与顺序、置顶）。会话缓存是它旁边独立的一项。
  function navigationSection() {
    const panel = typeof window.navSettingsPanel === "function" ? window.navSettingsPanel() : h("section", { class: "card settings-card" },
      h("h2", {}, "导航"),
      h("p", { class: "muted small" }, "导航设置还没有加载。刷新页面后再试。"));
    return [panel];
  }

  // 嵌入的页面脚本不在设置模块的依赖里（资源 / 记忆各是一个按需加载的模块）：
  // 进入对应设置页时再拉，拉到后重绘这一页，不阻塞设置目录首屏。
  function ensureSectionModule(id) {
    const modules = window.piRouteModules;
    if (typeof modules?.has !== "function" || !modules.has(id) || modules.state(id) === "ready") return null;
    return Promise.resolve()
      .then(() => modules.ensure(id))
      .catch(() => null);
  }
  function modulePlaceholder(label, loading) {
    return h("section", { class: "card settings-card", "data-settings-embed-loading": "" },
      h("p", { class: "muted small", role: "status" }, loading ? `正在加载${label}…` : `${label}还没有加载。刷新页面后再试。`));
  }

  // 外部资源：主导航里的「资源」搬进设置，内容和 #/resources 是同一份（嵌入模式去掉它自己的页头）。
  function resourcesSection() {
    const s = state();
    if (typeof window.renderResources !== "function") {
      if (!s.resourcesModuleLoading) {
        s.resourcesModuleLoading = true;
        const loading = ensureSectionModule("resources");
        if (!loading) s.resourcesModuleLoading = false;
        else void loading.finally(() => { s.resourcesModuleLoading = false; if (ui.view === "settings" && section() === "resources") renderMain(); });
      }
      return [modulePlaceholder("资源面板", !!s.resourcesModuleLoading)];
    }
    if (!s.resourcesLoaded) {
      s.resourcesLoaded = true;
      void Promise.resolve()
        .then(() => window.loadResources({ force: !ui.resources }))
        .catch(() => {})
        .finally(() => { if (ui.view === "settings" && section() === "resources") renderMain(); });
    }
    return [h("div", { class: "settings-embedded settings-embedded-resources", "data-settings-embed": "resources" }, window.renderResources(true))];
  }

  // 平台记忆：主导航里的「记忆」搬进设置，提炼与注入配置和列表在同一页（原来的 #/memory/settings 合并进来）。
  function memorySection() {
    const s = state();
    if (typeof window.renderPublicMemoryEmbedded !== "function") {
      if (!s.memoryModuleLoading) {
        s.memoryModuleLoading = true;
        const loading = ensureSectionModule("memory");
        if (!loading) s.memoryModuleLoading = false;
        else void loading.finally(() => { s.memoryModuleLoading = false; if (ui.view === "settings" && section() === "memory") renderMain(); });
      }
      return [modulePlaceholder("记忆面板", !!s.memoryModuleLoading)];
    }
    return [h("div", { class: "settings-embedded settings-embedded-memory", "data-settings-embed": "memory" }, window.renderPublicMemoryEmbedded())];
  }

  // 定时任务：每晚的错误统计与 Codex Reset 扫描合并为一页，各保留自己的卡片和运行历史。
  function scheduledSection() {
    return [h("div", { class: "settings-scheduled" }, errorStatsSection(), codexResetSection())];
  }

  // 登录：服务端登录会话列表、吊销、退出其他登录、退出登录。原来是「运行时」配置页底部的「登录会话」，现在归到系统设置。
  async function loadAuth() {
    const s = state();
    s.authLoaded = true;
    try { s.auth = await api("/api/auth/sessions"); s.authError = ""; }
    catch (error) { s.authError = error?.message || "读取登录会话失败"; }
    if (ui.view === "settings") renderMain();
  }
  async function logout() {
    await window.rtDesktop?.stopForLogout?.();
    await window.piAndroidShell?.call("session.logout").catch(() => {});
    await window.imageIntake?.invalidate({ explicitLogout: true });
    sessionCachesClear();
    await api("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => {});
    location.href = "/login";
  }
  function loginSection() {
    const s = state();
    if (!s.authLoaded) void loadAuth();
    const a = s.auth;
    const act = async (path, msg) => {
      try { await api(path, { method: "POST", body: "{}" }); announce(msg); s.authError = ""; }
      catch (error) { s.authError = error?.message || "操作失败"; }
      await loadAuth();
    };
    const when = (iso) => iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "—";
    const head = h("div", { class: "settings-card-head" }, h("div", {},
      h("h2", {}, "登录"),
      h("p", { class: "muted small" }, "每次登录一个服务端会话：30 天到期、7 天不用自动失效，可以单独吊销。")));
    const error = s.authError ? h("p", { class: "field-error", role: "alert" }, s.authError,
      h("button", { type: "button", class: "btn small", onclick: () => { s.authLoaded = false; s.authError = ""; renderMain(); } }, "重试")) : null;
    if (!a) return h("section", { class: "card settings-card", "data-login-settings": "" }, head, error || h("p", { class: "muted small" }, "正在读取登录会话…"));
    if (!a.enabled || !a.public) return h("section", { class: "card settings-card", "data-login-settings": "" }, head,
      error, h("p", { class: "muted small" }, "当前入口没有启用登录，没有可管理的登录会话。"));
    return h("section", { class: "card settings-card", "data-login-settings": "" },
      head, error,
      h("table", { class: "rt-table" }, h("tbody", {}, (a.sessions || []).map((x) => h("tr", {},
        h("td", { class: "small" }, `${when(x.createdAt)}${x.id === a.current ? "（当前）" : ""}`),
        h("td", { class: "small muted" }, String(x.userAgent || "").slice(0, 60)),
        h("td", {}, x.active ? h("span", { class: "badge ok" }, "有效") : h("span", { class: "badge" }, x.revokedAt ? "已吊销" : "已过期")),
        h("td", {}, x.active && x.id !== a.current ? h("button", { type: "button", class: "btn small", onclick: () => act(`/api/auth/sessions/${x.id}/revoke`, "已吊销") }, "吊销") : null))))),
      h("div", { class: "rt-actions" },
        h("button", { type: "button", class: "btn", "data-login-revoke-others": "", onclick: () => act("/api/auth/revoke-others", "已退出其他登录") }, "退出其他登录"),
        h("button", { type: "button", class: "btn", "data-login-logout": "", onclick: logout }, "退出登录")));
  }

  // 会话缓存：本机会话列表 / 正文的保存与清除。
  function cacheSection() {
    const panel = typeof window.sessionPersistenceSettings === "function" ? window.sessionPersistenceSettings() : null;
    return h("section", { class: "card settings-card settings-cache" },
      h("div", { class: "settings-card-head" },
        h("div", {},
          h("h2", {}, "会话缓存"),
          h("p", { class: "muted small" }, "控制此站点是否在本机保存会话列表与正文。只影响本机显示速度，不影响服务器上的会话历史。"))),
      panel || h("p", { class: "muted small" }, "缓存设置还没有加载。刷新页面后再试。"));
  }

  // 错误统计：手动触发每晚的统计（增量入库 + DeepSeek 归并 + 跨 runtime 重复建待办），下面是每一轮的历史。时间一律按北京时间。
  const RUN_TRIGGER = { manual: "手动", schedule: "定时", "catch-up": "补跑" };
  const RUN_STATE = { running: "统计中", ok: "完成", failed: "失败", interrupted: "中断" };
  const beijingFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  function beijing(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    const p = Object.fromEntries(beijingFormat.formatToParts(date).map((x) => [x.type, x.value]));
    return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
  }
  function runDuration(run) {
    if (!run.finishedAt) return "";
    const sec = Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000));
    return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
  }
  async function loadErrorStats() {
    const s = state();
    if (s.errorStatsLoading) return;
    s.errorStatsLoading = true;
    try { s.errorStats = await api("/api/error-stats"); s.errorStatsError = ""; }
    catch (error) { s.errorStatsError = error?.message || "读取统计记录失败"; }
    s.errorStatsLoading = false;
    clearTimeout(s.errorStatsPoll); s.errorStatsPoll = 0;
    // 有一轮在跑：隔几秒再读一次，跑完自动出现在历史里
    if (s.errorStats?.running && ui.view === "settings") s.errorStatsPoll = setTimeout(() => { if (ui.view === "settings" && section() === "scheduled") void loadErrorStats(); }, 2500);
    if (ui.view === "settings") renderMain();
  }
  // Codex reset：可用张数、近 7 / 30 天用掉的张数、扫描历史。数据都在服务端台账里，页面只读。
  async function loadCodexReset() {
    const s = state();
    if (s.codexResetLoading) return;
    s.codexResetLoading = true;
    try { s.codexReset = await api("/api/codex-resets"); s.codexResetError = ""; }
    catch (error) { s.codexResetError = error?.message || "读取 Codex reset 失败"; }
    s.codexResetLoading = false;
    clearTimeout(s.codexResetPoll); s.codexResetPoll = 0;
    if (s.codexReset?.running && ui.view === "settings") s.codexResetPoll = setTimeout(() => { if (ui.view === "settings" && section() === "scheduled") void loadCodexReset(); }, 2500);
    if (ui.view === "settings") renderMain();
  }
  async function runCodexResetScan() {
    const s = state();
    if (s.codexResetStarting || s.codexReset?.running) return;
    s.codexResetStarting = true; s.codexResetMessage = ""; renderMain();
    try { await api("/api/codex-resets/scan", { method: "POST", body: "{}" }); }
    catch (error) { s.codexResetMessage = error?.message || "没能开始扫描，请重试"; }
    s.codexResetStarting = false;
    await loadCodexReset();
  }
  async function runErrorStats() {
    const s = state();
    if (s.errorStatsStarting || s.errorStats?.running) return;
    s.errorStatsStarting = true; s.errorStatsMessage = ""; renderMain();
    try { await api("/api/error-stats/run", { method: "POST", body: "{}" }); }
    catch (error) { s.errorStatsMessage = error?.message || "没能开始统计，请重试"; }
    s.errorStatsStarting = false;
    await loadErrorStats();
  }
  function runItem(run) {
    const s = state();
    const open = !!s.errorStatsOpen?.[run.id];
    const created = run.createdTodos || [];
    const kinds = run.byKind || {};
    const title = `${RUN_TRIGGER[run.trigger] || "统计"} · 入库 ${run.added ?? 0} 条 · 新建待办 ${created.length} 条`;
    const meta = [beijing(run.startedAt), run.status === "running" ? "进行中" : runDuration(run), run.assessed ? `评估 ${run.assessed} 个` : "", run.costUsd ? `DeepSeek $${run.costUsd.toFixed(3)}` : ""].filter(Boolean).join(" · ");
    const assessments = run.assessments || [];
    const VERDICT = { do: "值得做", skip: "不建议做", unsure: "拿不准" };
    const body = [
      h("p", { class: "settings-run-line" }, `入库：工具 ${kinds.tool ?? 0} · 部署 ${kinds.deploy ?? 0} · 记忆强约束 ${kinds.memory ?? 0} · 门禁不稳定 ${kinds.flaky ?? 0}；DeepSeek 归并 ${run.merged ?? 0} 个指纹`),
      run.assessed ? h("p", { class: "settings-run-line" }, `AI 评估（DeepSeek 推理 high，带上下文）：评估 ${run.assessed} 个，值得做 ${run.worth ?? 0} 个${run.worth ? "，已建待办" : ""}。`) : null,
      created.length
        ? h("div", {}, h("p", { class: "settings-run-line" }, "新建的待办（在「待办 · 平台 / debug」里）："), h("ul", { class: "settings-run-todos" }, created.map((t) => h("li", {}, t.title))))
        : h("p", { class: "settings-run-line muted" }, "这一轮没有新建待办。"),
      assessments.length
        ? h("div", {}, h("p", { class: "settings-run-line" }, "评估明细："),
          h("ul", { class: "settings-run-assess" }, assessments.map((x) => h("li", { class: `verdict-${x.verdict}` },
            h("span", { class: "settings-run-verdict" }, `${VERDICT[x.verdict] || x.verdict}${x.verdict === "do" && x.confidence === "low" ? "（把握低）" : ""}`),
            h("span", { class: "settings-run-assess-title" }, x.title),
            h("span", { class: "settings-run-assess-reason" }, x.reason)))))
        : null,
      run.deferred ? h("p", { class: "settings-run-line muted" }, `另有 ${run.deferred} 个候选本轮没处理（超过单轮评估 / 建待办上限，或评估没成功），顺延到下一轮。`) : null,
      run.note ? h("p", { class: "settings-run-line settings-run-note" }, run.note) : null,
    ];
    return h("div", { class: `settings-run-item${open ? " open" : ""}`, "data-run-id": run.id },
      h("button", { type: "button", class: "settings-run-row", "aria-expanded": String(open), onclick: () => { s.errorStatsOpen = { ...(s.errorStatsOpen || {}), [run.id]: !open }; renderMain(); } },
        h("span", { class: `settings-run-state ${run.status}` }, RUN_STATE[run.status] || "—"),
        h("span", { class: "settings-run-main" }, h("span", { class: "settings-run-title" }, title), h("span", { class: "settings-run-meta" }, meta)),
        h("span", { class: "settings-run-chev", "aria-hidden": "true" }, "›")),
      open ? h("div", { class: "settings-run-detail" }, body) : null);
  }
  const FLAKY_RELEASE = { expired: "到期，已恢复拦截", fixed: "测试已修改并通过，已恢复拦截", "red-streak": "隔离期间连续多次红，疑似真实问题，已恢复拦截" };
  const flakyLabel = (file) => String(file).split("/").pop().replace(/\.test\.ts$/, "").replace(/-browser$/, "");
  // 只读：隔离由门禁自动做，这里让人看得见「现在有哪些检查被暂时放过、为什么、什么时候恢复」。
  function flakyCard(flaky) {
    if (!flaky) return null;
    const entries = flaky.entries || [], released = flaky.released || [];
    const item = (cls, pill, file, reason) => h("li", { class: cls, "data-flaky-file": file },
      h("span", { class: "settings-run-verdict" }, pill),
      h("span", { class: "settings-run-assess-title" }, flakyLabel(file)),
      h("span", { class: "settings-run-assess-reason" }, reason));
    return h("section", { class: "card settings-card", "data-error-stats-flaky": "" },
      h("div", { class: "settings-card-head" }, h("div", {}, h("h2", {}, "门禁自动隔离"),
        h("p", { class: "muted small" }, `部署前的自动检查，近 ${flaky.windowDays ?? 7} 天有 ${flaky.threshold ?? 3} 次「第一次没过、重跑才过」，会被自动隔离：照常运行，但红了不再拦住上线，14 天后到期恢复拦截。全程自动，不需要你操作。`))),
      entries.length
        ? h("ul", { class: "settings-run-assess" }, entries.map((e) => item("verdict-unsure", "已隔离", e.file, `北京时间 ${beijing(e.expiresAt)} 到期${e.runs ? ` · 隔离期间跑了 ${e.runs} 次，${e.red} 次红` : ""}`)))
        : h("p", { class: "muted small", role: "status" }, "目前没有被隔离的自动检查。"),
      released.length
        ? h("div", {}, h("p", { class: "muted small settings-flaky-sub" }, "最近恢复拦截的"),
          h("ul", { class: "settings-run-assess" }, released.map((r) => item(r.suspectedRegression ? "verdict-bad" : "verdict-do", r.suspectedRegression ? "疑似真问题" : "已恢复", r.file, `北京时间 ${beijing(r.at)} · ${FLAKY_RELEASE[r.reason] || r.reason}`))))
        : null);
  }
  function errorStatsSection() {
    const s = state();
    if (!s.errorStatsLoaded) { s.errorStatsLoaded = true; void loadErrorStats(); }
    const data = s.errorStats;
    const running = !!data?.running || !!s.errorStatsStarting;
    const runs = data?.runs || [];
    const last = runs.find((r) => r.status === "ok" || r.status === "failed");
    const status = running ? "统计中，跑完会自动出现在下面的历史里…"
      : last ? `上次统计 ${beijing(last.startedAt)}（北京时间）· 入库 ${last.added ?? 0} 条 · 新建待办 ${(last.created || []).length} 条` : "还没有统计记录。第一次会回填过去 30 天的数据。";
    const list = !data
      ? [h("div", { class: "settings-run-empty", role: "status" }, s.errorStatsError || "读取中…")]
      : runs.length ? runs.map(runItem) : [h("div", { class: "settings-run-empty" }, "还没有统计记录。点上面的「立即统计」跑第一轮。")];
    return h("div", { class: "settings-errorstats" },
      h("section", { class: "card settings-card" },
        h("div", { class: "settings-card-head" },
          h("div", {},
            h("h2", {}, "错误统计"),
            h("p", { class: "muted small" }, `每晚北京时间 ${data?.scheduleHour ?? 23}:${String(data?.scheduleMinute ?? 50).padStart(2, "0")} 自动统计工具、部署和记忆强约束的报错（增量入库）。近 ${data?.windowDays ?? 30} 天内同一个错误在 ${data?.minRuntimes ?? 2} 个及以上 runtime 各出现 ${data?.minPerRuntime ?? 2} 次，先由 DeepSeek（推理 high）带上下文评估值不值得做，值得做才建一条「平台 / debug」待办，由你决定是否修复；记忆强约束用尽重试的，出现 1 次就评估。`))),
        h("div", { class: "settings-run-actions" },
          h("button", { type: "button", class: "btn primary", "data-error-stats-run": "", disabled: running, "aria-busy": String(running), onclick: runErrorStats }, running ? "统计中…" : "立即统计"),
          h("span", { class: "muted small", role: "status", "data-error-stats-status": "" }, status)),
        s.errorStatsMessage ? h("p", { class: "settings-run-note small", role: "alert" }, s.errorStatsMessage) : null,
        data?.nextRunAt ? h("p", { class: "muted small" }, `下次自动统计：北京时间 ${beijing(data.nextRunAt)}`) : null),
      flakyCard(data?.flaky),
      h("section", { class: "card settings-card" },
        h("div", { class: "settings-card-head" }, h("div", {}, h("h2", {}, "统计历史"), h("p", { class: "muted small" }, "时间均为北京时间；点一轮查看明细和新建的待办。"))),
        h("div", { class: "settings-run-list", "data-error-stats-history": "" }, list)));
  }

  /* ------------------------------ 运行时更新 ------------------------------ */
  const RU_VERDICT = { upgrade: ["建议升级", "ok"], wait: ["建议观望", "warn"], skip: ["暂不升级", "bad"] };
  const RU_LEVEL = { high: "高", medium: "中", low: "低" };
  const RU_TRIGGER = { manual: "手动", schedule: "定时", "catch-up": "补跑" };
  const ruDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v).slice(5) : v ? beijing(v) : "");
  async function loadRuntimeUpdates() {
    const s = state();
    if (s.ruLoading) return;
    s.ruLoading = true;
    const wasRunning = !!s.runtimeUpdates?.running;
    try { s.runtimeUpdates = await api("/api/runtime-updates"); s.ruError = ""; }
    catch (error) { s.ruError = error?.message || "读取版本更新失败"; }
    s.ruLoading = false;
    clearTimeout(s.ruPoll); s.ruPoll = 0;
    if (wasRunning && !s.runtimeUpdates?.running) window.dispatchEvent(new Event("pi-runtime-updates-change"));
    if (s.runtimeUpdates?.running && ui.view === "settings") s.ruPoll = setTimeout(() => { if (ui.view === "settings" && section() === "runtimeupdates") void loadRuntimeUpdates(); }, 2500);
    if (ui.view === "settings") renderMain();
  }
  async function runRuntimeUpdateCheck() {
    const s = state();
    if (s.ruStarting || s.runtimeUpdates?.running) return;
    s.ruStarting = true; s.ruMessage = ""; renderMain();
    try { await api("/api/runtime-updates/check", { method: "POST", body: "{}" }); }
    catch (error) { s.ruMessage = error?.message || "没能开始检测，请重试"; }
    s.ruStarting = false;
    await loadRuntimeUpdates();
    window.dispatchEvent(new Event("pi-runtime-updates-change"));
  }
  async function analyzeRuntimeUpdate(kind, force) {
    const s = state();
    s.ruAnalyzing = { ...(s.ruAnalyzing || {}), [kind]: true }; s.ruAnalyzeError = { ...(s.ruAnalyzeError || {}), [kind]: "" }; renderMain();
    try { await api(`/api/runtime-updates/${kind}/analyze`, { method: "POST", body: JSON.stringify({ force: force === true }) }); }
    catch (error) { s.ruAnalyzeError = { ...s.ruAnalyzeError, [kind]: error?.message || "分析失败，请重试" }; }
    s.ruAnalyzing = { ...s.ruAnalyzing, [kind]: false };
    s.ruOpen = { ...(s.ruOpen || {}), [`analysis-${kind}`]: true };
    await loadRuntimeUpdates();
  }
  async function ignoreRuntimeUpdate(kind, undo) {
    const s = state();
    try { await api(`/api/runtime-updates/${kind}/ignore`, { method: "POST", body: JSON.stringify({ undo: undo === true }) }); }
    catch (error) { s.ruMessage = error?.message || "操作失败，请重试"; }
    s.ruSummaryAt = 0;
    await loadRuntimeUpdates();
    window.dispatchEvent(new Event("pi-runtime-updates-change"));
  }
  const RU_EXECUTOR = { pi: ["Claude Code", "Pi"], "claude-code": ["Pi", "Claude Code"] };
  /** 运行时配置限定了可选模型、而默认模型没勾选时，升级会话要显式选一个已勾选的模型（优先新建默认配置里的，其次第一个）；返回 "" 表示沿用默认。 */
  async function ruExecutorModel(kind) {
    const [{ profiles }, settings] = await Promise.all([api("/api/runtime-profiles"), api("/api/runtime-settings")]);
    const allowed = settings?.enabledModelsByRuntime?.[kind];
    if (!allowed) return "";
    const models = (profiles || []).find((p) => p.runtimeKind === kind)?.models || [];
    const def = models.find((m) => m.isDefault) || (kind === "pi" ? models[0] : null);
    if (def && allowed.includes(def.id)) return "";
    const saved = settings?.defaultSessionByRuntime?.[kind]?.model;
    if (saved && allowed.includes(saved) && models.some((m) => m.id === saved)) return saved;
    const pick = models.find((m) => allowed.includes(m.id));
    if (!pick) throw new Error("运行时配置里没有可用的已勾选模型，请先到运行时配置勾选至少一个模型");
    return pick.id;
  }
  /** 点「升级」：服务端给出方案，交给新建会话流程在另一个 runtime 里执行（Pi ↔ Claude Code 互相升级）。 */
  async function upgradeRuntime(kind) {
    const s = state();
    if (s.ruUpgrading?.[kind]) return;
    s.ruUpgrading = { ...(s.ruUpgrading || {}), [kind]: true }; s.ruUpgradeError = { ...(s.ruUpgradeError || {}), [kind]: "" }; renderMain();
    try {
      const { plan } = await api(`/api/runtime-updates/${kind}/upgrade`, { method: "POST", body: "{}" });
      const model = await ruExecutorModel(plan.executor);
      const prev = await api(`/api/runtime-profiles/${plan.executor}/settings-preview?cwd=${encodeURIComponent(plan.workspace)}&permissionMode=${encodeURIComponent(plan.permissionMode)}`);
      // 同一个版本重试沿用同一个请求键：第一次其实已建好会话时不会重复创建
      const keyId = `${kind}:${plan.to}`;
      s.ruUpgradeKeys = { ...(s.ruUpgradeKeys || {}) };
      const key = s.ruUpgradeKeys[keyId] ||= (typeof rtKey === "function" ? rtKey() : crypto.randomUUID());
      const res = await api("/api/runtime-sessions", { method: "POST", body: JSON.stringify({
        idempotencyKey: key, runtimeKind: plan.executor, workspace: plan.workspace, prompt: plan.prompt, title: plan.title, attachmentIds: [],
        permissionMode: plan.permissionMode, ...(model ? { model } : {}), ...(plan.worktree ? { worktree: true } : {}), confirmedProfileVersion: prev.profileVersion
      }) });
      delete s.ruUpgradeKeys[keyId];
      const id = res?.session?.platformSessionId;
      s.ruUpgrading = { ...s.ruUpgrading, [kind]: false };
      if (id) { location.hash = `#/rt/${id}`; return; }
      s.ruMessage = "正在部署，升级会话会在部署完成后创建，稍后到会话列表查看";
    } catch (error) { s.ruUpgradeError = { ...s.ruUpgradeError, [kind]: error?.message || "没能发起升级，请重试" }; }
    s.ruUpgrading = { ...s.ruUpgrading, [kind]: false };
    renderMain();
  }
  function ruToggle(key) { const s = state(); s.ruOpen = { ...(s.ruOpen || {}), [key]: !s.ruOpen?.[key] }; renderMain(); }
  function ruList(items, cls) { return h("ul", { class: `ru-list ${cls || ""}` }, items.map((t) => h("li", {}, t))); }
  function ruCopy(text, btn) {
    const done = () => { btn.textContent = "已复制"; setTimeout(() => { btn.textContent = "复制命令"; }, 1500); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done).catch(() => {});
    else { const ta = h("textarea", { style: "position:fixed;opacity:0" }, text); document.body.append(ta); ta.select(); try { document.execCommand("copy"); done(); } catch { /* 不支持复制 */ } ta.remove(); }
  }
  function ruAnalysis(r) {
    const s = state();
    const busy = !!s.ruAnalyzing?.[r.kind] || (s.runtimeUpdates?.analyzing || []).includes(r.kind);
    const a = r.analysis;
    const err = s.ruAnalyzeError?.[r.kind];
    const [vlabel, vkind] = a ? RU_VERDICT[a.value.verdict] || [a.value.verdict, ""] : ["", ""];
    return h("div", { class: "ru-analysis", "data-ru-analysis": r.kind },
      !a ? h("p", { class: "muted small" }, "「是否值得升级」「升级风险与兼容」不会自动分析，点下面的按钮才调用一次 AI（DeepSeek，约几分钱）。") : [
        h("div", { class: "ru-verdict" }, h("span", { class: `badge ${vkind}` }, vlabel), h("span", { class: "ru-verdict-reason" }, a.value.reason)),
        a.stale ? h("p", { class: "small warn-text" }, "这份报告基于更早的版本，之后又出了新版本，建议重新分析。") : null,
        h("h4", {}, "值得升级的收益"),
        a.value.benefits.length ? h("ul", { class: "ru-list" }, a.value.benefits.map((b) => h("li", {}, h("strong", {}, b.title), h("span", { class: "ru-tag" }, `相关度 ${RU_LEVEL[b.relevance] || b.relevance}`), h("span", { class: "muted" }, ` ${b.detail}`)))) : h("p", { class: "muted small" }, "没有发现对平台有实质用处的新增内容。"),
        h("h4", {}, "风险"),
        a.value.risks.length ? h("ul", { class: "ru-list" }, a.value.risks.map((x) => h("li", { class: `ru-risk ru-risk-${x.severity}` }, h("strong", {}, x.title), h("span", { class: "ru-tag" }, `严重度 ${RU_LEVEL[x.severity] || x.severity}`), h("span", { class: "muted" }, ` ${x.detail}`)))) : h("p", { class: "muted small" }, "没有发现和平台依赖相关的风险。"),
        a.value.compat.length ? [h("h4", {}, "平台需要兼容的"), h("ul", { class: "ru-list" }, a.value.compat.map((c) => h("li", {}, h("strong", {}, c.what), h("span", { class: "muted" }, ` → ${c.action}`))))] : null,
        h("h4", {}, "升级前后的验证步骤"), h("ol", { class: "ru-list" }, a.value.testPlan.map((t) => h("li", {}, t))),
        h("p", { class: "muted small" }, `分析于北京时间 ${beijing(a.at)} · ${a.installed} → ${a.latest}${a.costUsd ? ` · DeepSeek $${a.costUsd.toFixed(3)}` : ""}；AI 只依据更新日志和平台依赖清单判断，仅供决策参考。`)],
      err ? h("p", { class: "settings-run-note small", role: "alert" }, err) : null,
      h("div", { class: "settings-run-actions" },
        h("button", { type: "button", class: `btn${a ? "" : " primary"}`, "data-ru-analyze": r.kind, disabled: busy, "aria-busy": String(busy), onclick: () => analyzeRuntimeUpdate(r.kind, !!a) }, busy ? "分析中…（约半分钟）" : a ? "重新分析" : "分析收益与风险")));
  }
  function ruRelease(r, key) {
    const s = state();
    const open = !!s.ruOpen?.[key];
    const sum = r.summary || { features: [], breaking: [] };
    return h("div", { class: `ru-release${open ? " open" : ""}`, "data-ru-release": r.version },
      h("button", { type: "button", class: "ru-release-row", "aria-expanded": String(open), onclick: () => ruToggle(key) },
        h("span", { class: "ru-release-ver" }, r.version),
        h("span", { class: "ru-release-meta" }, [ruDate(r.publishedAt) || `检测到 ${beijing(r.firstSeenAt)}`, sum.breaking.length ? `${sum.breaking.length} 项破坏性变更` : "", sum.features.length ? `${sum.features.length} 项新增` : ""].filter(Boolean).join(" · ")),
        h("span", { class: "settings-run-chev", "aria-hidden": "true" }, "›")),
      open ? h("div", { class: "ru-release-body" },
        sum.breaking.length ? [h("p", { class: "small warn-text" }, "破坏性变更"), ruList(sum.breaking)] : null,
        sum.features.length ? [h("p", { class: "small" }, "新增"), ruList(sum.features)] : null,
        h("pre", { class: "ru-notes" }, r.notes || "（这一版没有更新日志正文）"),
        r.url ? h("a", { class: "small", href: r.url, target: "_blank", rel: "noopener noreferrer" }, "打开原始发布页") : null) : null);
  }
  function ruCard(r) {
    const s = state();
    const status = r.error && !r.latest ? ["检测失败", "bad"] : r.hasUpdate ? (r.ignored ? ["有新版本（已忽略）", ""] : ["有新稳定版", "warn"]) : r.installed && r.latest ? ["已是最新稳定版", "ok"] : ["已装版本未知", ""];
    const executor = RU_EXECUTOR[r.kind];
    const fullFeatures = !!s.ruOpen?.[`features-${r.kind}`];
    const features = r.highlights.features, shown = fullFeatures ? features : features.slice(0, 5);
    return h("section", { class: "card settings-card ru-card", "data-ru-card": r.kind, "aria-label": r.label },
      h("div", { class: "rt-profile-head" }, h("span", { class: `rt-glyph ${r.kind}`, "aria-hidden": "true" }, { pi: "π", "claude-code": "✺", codex: "◎" }[r.kind] || "•"), h("h2", {}, r.label), h("span", { class: `badge ${status[1]}` }, status[0])),
      h("dl", { class: "kv rt-facts" },
        h("dt", {}, "已装版本"), h("dd", {}, r.installed || "未知（先到「运行时配置」点一次「检查」）"),
        h("dt", {}, "最新稳定版"), h("dd", {}, r.latest ? `${r.latest}${r.hasUpdate ? `（落后 ${r.pendingCount} 个版本）` : ""}` : "还没有检测到"),
        h("dt", {}, "检测"), h("dd", { title: r.checkedAt ? beijing(r.checkedAt) : "" }, r.checkedAt ? `北京时间 ${beijing(r.checkedAt)}` : "还没检测过")),
      r.error ? h("p", { class: "small warn-text", role: "alert" }, `最近一次检测失败：${r.error}${r.latest ? "（下面仍是上次检测到的内容）" : ""}`) : null,
      r.hasUpdate ? [
        h("div", { class: "ru-sec" }, h("h3", {}, `新增了什么（${r.installed} → ${r.latest}）`),
          shown.length ? ruList(shown) : h("p", { class: "muted small" }, "更新日志里没有明确标注的新增功能，主要是修复和调整；点下面的完整更新记录查看原文。"),
          features.length > 5 ? h("button", { type: "button", class: "btn-link small", onclick: () => ruToggle(`features-${r.kind}`) }, fullFeatures ? "收起" : `展开全部 ${features.length} 条`) : null,
          r.highlights.breaking.length ? [h("p", { class: "small warn-text ru-breaking-title" }, `需要留意的破坏性变更（${r.highlights.breaking.length} 条）`), ruList(r.highlights.breaking, "ru-breaking")] : null),
        h("div", { class: "ru-sec" }, h("h3", {}, "值不值得升级 · 风险与兼容"), ruAnalysis(r)),
        h("details", { class: "ru-sec rt-profile-more", ...(s.ruOpen?.[`guide-${r.kind}`] ? { open: true } : {}), ontoggle: (ev) => { s.ruOpen = { ...(s.ruOpen || {}), [`guide-${r.kind}`]: ev.currentTarget.open }; } },
          h("summary", { class: "small" }, executor ? `升级步骤（点「升级」后由 ${executor[0]} 会话照此执行）` : "升级方式"),
          ruList(r.guide.steps), r.guide.note ? h("p", { class: "muted small" }, r.guide.note) : null,
          r.guide.command ? h("div", { class: "ru-command" }, h("code", {}, r.guide.command), h("button", { type: "button", class: "btn small", onclick: (ev) => ruCopy(r.guide.command, ev.currentTarget) }, "复制命令")) : null),
        executor ? h("div", { class: "settings-run-actions" },
          h("button", { type: "button", class: "btn primary", "data-ru-upgrade": r.kind, disabled: !!s.ruUpgrading?.[r.kind], onclick: () => upgradeRuntime(r.kind) }, s.ruUpgrading?.[r.kind] ? "正在发起…" : `升级 ${executor[1]} 到 ${r.latest}`),
          h("span", { class: "muted small" }, `由 ${executor[0]} 开一个会话来执行，你可以在会话里看进度`)) : null,
        s.ruUpgradeError?.[r.kind] ? h("p", { class: "small warn-text", role: "alert" }, s.ruUpgradeError[r.kind]) : null,
        h("div", { class: "settings-run-actions" },
          r.ignored ? h("button", { type: "button", class: "btn small", onclick: () => ignoreRuntimeUpdate(r.kind, true) }, "取消忽略")
            : h("button", { type: "button", class: "btn small", "data-ru-ignore": r.kind, onclick: () => ignoreRuntimeUpdate(r.kind) }, "忽略这个版本"),
          h("span", { class: "muted small" }, r.ignored ? `已忽略 ${r.latest}，有更新的版本才会再提醒` : "忽略后红点熄灭，出了更新的版本才再提醒"))
      ] : null,
      h("details", { class: "rt-profile-more", ...(s.ruOpen?.[`log-${r.kind}`] ? { open: true } : {}), ontoggle: (ev) => { s.ruOpen = { ...(s.ruOpen || {}), [`log-${r.kind}`]: ev.currentTarget.open }; } },
        h("summary", { class: "small" }, `版本更新记录（${r.pending.length + r.history.length} 版）`),
        r.pending.length || r.history.length
          ? h("div", { class: "ru-releases" }, [...r.pending.map((x) => ruRelease(x, `rel-${r.kind}-${x.version}`)), ...r.history.map((x) => ruRelease(x, `rel-${r.kind}-${x.version}`))])
          : h("p", { class: "muted small" }, "还没有记录，点上面的「立即检测」。"),
        r.pendingCount > r.pending.length ? h("p", { class: "muted small" }, `只列出最新 ${r.pending.length} 个新版本；更早的 ${r.pendingCount - r.pending.length} 个见`, " ", h("a", { href: r.homepage, target: "_blank", rel: "noopener noreferrer" }, "完整更新日志")) : null,
        r.kind === "codex" ? h("p", { class: "muted small" }, "Codex 的发布列表太大，平台只读最新稳定版和近期的稳定版，更早的版本会从首次检测起逐日积累。") : null));
  }
  function runtimeUpdatesSection() {
    const s = state();
    if (!s.ruLoaded) { s.ruLoaded = true; void loadRuntimeUpdates(); }
    const data = s.runtimeUpdates;
    const running = !!data?.running || !!s.ruStarting;
    const status = running ? "检测中，跑完会自动更新下面的内容…" : data?.lastCheckAt ? `上次检测 ${beijing(data.lastCheckAt)}（北京时间）` : "还没有检测记录，点「立即检测」。";
    const logs = data?.installLog || [];
    const checks = data?.checks || [];
    return h("div", { class: "settings-errorstats ru-page" },
      h("section", { class: "card settings-card" },
        h("div", { class: "settings-card-head" }, h("div", {},
          h("h2", {}, "运行时更新"),
          h("p", { class: "muted small" }, `每天北京时间 ${data?.scheduleHour ?? 9}:${String(data?.scheduleMinute ?? 0).padStart(2, "0")} 检测 Pi、Claude Code、Codex 有没有新的稳定版（不含 alpha / beta / rc）。有新版本时只提示：先看新增了什么，再决定要不要让 AI 分析收益与风险；Pi 和 Claude Code 点「升级」由对方 runtime 开会话执行，Codex 跟随桌面版 App 升级。`))),
        h("div", { class: "settings-run-actions" },
          h("button", { type: "button", class: "btn primary", "data-ru-check": "", disabled: running, "aria-busy": String(running), onclick: runRuntimeUpdateCheck }, running ? "检测中…" : "立即检测"),
          h("span", { class: "muted small", role: "status" }, status)),
        s.ruMessage ? h("p", { class: "settings-run-note small", role: "alert" }, s.ruMessage) : null,
        data?.nextRunAt ? h("p", { class: "muted small" }, `下次自动检测：北京时间 ${beijing(data.nextRunAt)}`) : null),
      !data ? h("section", { class: "card settings-card" }, h("div", { class: "settings-run-empty", role: "status" }, s.ruError || "读取中…")) : data.runtimes.map(ruCard),
      data ? h("section", { class: "card settings-card" },
        h("div", { class: "settings-card-head" }, h("div", {}, h("h2", {}, "升级记录"), h("p", { class: "muted small" }, "平台观察到的已装版本变化（升级完成后，下一次检测时记下）。"))),
        logs.length ? h("ul", { class: "ru-list" }, logs.map((e) => h("li", {}, h("strong", {}, (data.runtimes.find((r) => r.kind === e.kind) || {}).label || e.kind), h("span", { class: "muted" }, ` ${e.from ? `${e.from} → ${e.to}` : `首次记录 ${e.to}`} · 北京时间 ${beijing(e.at)}`))))
          : h("p", { class: "muted small" }, "还没有记录。点「运行时配置」里的「检查」后再检测一次，就会记下当前版本。")) : null,
      data && checks.length ? h("section", { class: "card settings-card" },
        h("div", { class: "settings-card-head" }, h("div", {}, h("h2", {}, "检测历史"))),
        h("ul", { class: "ru-list" }, checks.map((c) => h("li", {}, h("span", { class: `settings-run-state ${c.status}` }, { running: "检测中", ok: "完成", failed: "失败" }[c.status] || c.status),
          h("span", { class: "muted" }, ` ${RU_TRIGGER[c.trigger] || "检测"} · 北京时间 ${beijing(c.startedAt)}${c.found.length ? ` · 新发现 ${c.found.map((f) => `${f.kind} ${f.version}`).join("、")}` : ""}${c.errors.length ? ` · 失败 ${c.errors.map((e) => e.kind).join("、")}` : ""}`))))) : null);
  }

  const CODEX_TRIGGER = { schedule: "定时", "catch-up": "补扫", manual: "手动" };
  function codexResetSection() {
    const s = state();
    if (!s.codexResetLoaded) { s.codexResetLoaded = true; void loadCodexReset(); }
    const data = s.codexReset;
    const running = !!data?.running || !!s.codexResetStarting;
    const stats = data?.stats || {};
    const credits = data?.credits || [];
    const auth = data?.auth;
    const status = running ? "扫描中，跑完会自动刷新…"
      : !data ? (s.codexResetError || "读取中…")
      : !auth?.ok ? "没读到 Codex 登录态：先在本机登录 Codex 客户端，再点「立即扫描」。"
      : data.error ? data.error
      : data.lastScanAt ? `上次扫描 北京时间 ${beijing(data.lastScanAt)}` : "还没有扫描记录，点「立即扫描」跑第一轮。";
    const metric = (label, value, unit, sub) => h("div", { class: "settings-deploy-metric" },
      h("span", { class: "settings-deploy-metric-label" }, label),
      h("span", { class: "settings-deploy-metric-value" }, String(value ?? 0), h("small", {}, unit)),
      sub ? h("span", { class: "settings-deploy-metric-sub" }, sub) : null);
    const creditList = !data ? null : credits.length
      ? h("ul", { class: "codex-reset-credits" }, credits.map((credit) => h("li", { class: "codex-reset-credit" },
        h("span", { class: "codex-reset-credit-title" }, credit.title || "重置卡"),
        h("span", { class: "codex-reset-credit-meta" }, [credit.description, credit.grantedAt ? `发放 ${beijing(credit.grantedAt)}` : "", credit.expiresAt ? `${beijing(credit.expiresAt)} 过期` : "长期有效"].filter(Boolean).join(" · ")))))
      : h("div", { class: "settings-run-empty" }, auth?.ok ? "现在没有可用的重置卡。" : "等读到登录态后再看。");
    const scans = data?.scans || [];
    const scanList = !data
      ? h("div", { class: "settings-run-empty", role: "status" }, s.codexResetError || "读取中…")
      : scans.length ? scans.map((scan) => h("div", { class: "settings-run-item" },
        h("p", { class: "settings-run-line" }, `${CODEX_TRIGGER[scan.trigger] || "扫描"} · ${scan.status === "ok" ? "成功" : scan.status === "running" ? "进行中" : "失败"} · 可用 ${scan.availableCount ?? "—"} 张`),
        h("p", { class: "settings-run-line muted" }, [beijing(scan.finishedAt || scan.startedAt), scan.newGranted?.length ? `新发放 ${scan.newGranted.length} 张` : "", scan.newUsed?.length ? `新使用 ${scan.newUsed.length} 张` : "", scan.error || ""].filter(Boolean).join(" · "))))
      : h("div", { class: "settings-run-empty" }, "还没有扫描记录。点上面的「立即扫描」跑第一轮。");
    return h("div", { class: "settings-codexreset" },
      h("section", { class: "card settings-card" },
        h("div", { class: "settings-card-head" },
          h("div", {},
            h("h2", {}, "Codex Reset"),
            h("p", { class: "muted small" }, `每晚北京时间 ${data?.scheduleHour ?? 23}:${String(data?.scheduleMinute ?? 30).padStart(2, "0")} 自动扫一次 Codex 的 reset 卡：现在有几张可用、过去 7 天用掉几张。数据来自 Codex 自己的用量接口（只读），不打开、不点击客户端。`))),
        h("div", { class: "settings-run-actions" },
          h("button", { type: "button", class: "btn primary", "data-codex-reset-run": "", disabled: running, "aria-busy": String(running), onclick: runCodexResetScan }, running ? "扫描中…" : "立即扫描"),
          h("span", { class: "muted small", role: "status", "data-codex-reset-status": "" }, status)),
        s.codexResetMessage ? h("p", { class: "settings-run-note small", role: "alert" }, s.codexResetMessage) : null,
        data?.nextRunAt ? h("p", { class: "muted small" }, `下次自动扫描：北京时间 ${beijing(data.nextRunAt)}`) : null),
      h("section", { class: "card settings-card" },
        h("div", { class: "settings-card-head" }, h("div", {}, h("h2", {}, "重置卡用量"), h("p", { class: "muted small" }, "时间均为北京时间；本地台账会一直累积，不受 Codex 只保留 30 天流水的限制。"))),
        h("div", { class: "settings-deploy-metrics" },
          metric("可用", data?.availableCount ?? 0, "张", auth?.ok ? null : h("span", {}, "没读到登录态")),
          metric("近 7 天用掉", stats.used7d ?? 0, "张", stats.lastUsedAt ? h("span", {}, `最近 ${beijing(stats.lastUsedAt)}`) : h("span", {}, "没有记录")),
          metric("累计用掉", stats.usedTotal ?? 0, "张", h("span", {}, `近 30 天 ${stats.used30d ?? 0} 张`))),
        h("div", { class: "codex-reset-block" },
          h("p", { class: "muted small" }, "当前可用："),
          creditList)),
      h("section", { class: "card settings-card" },
        h("div", { class: "settings-card-head" }, h("div", {}, h("h2", {}, "扫描历史"), h("p", { class: "muted small" }, "最近 12 轮；点「立即扫描」可手动补一次。"))),
        h("div", { class: "settings-run-list", "data-codex-reset-history": "" }, scanList)));
  }

  function deploySummary(data) {
    const mode = data?.runtimePeriods ? (state().heatRuntime || "all") : "all";
    const periods = mode === "all" ? data?.periods : data?.runtimePeriods?.[mode];
    const fallback = { total: data?.total ?? 0, ok: data?.counts?.ok ?? 0, failed: data?.counts?.failed ?? 0 };
    const rows = [
      ["今日", periods?.today],
      ["最近 7 天", periods?.last7],
      ["最近 30 天", periods?.last30],
      ["累计", periods?.all],
    ];
    return h("div", { class: "settings-deploy-metrics" },
      rows.map(([label, stat]) => {
        const value = stat || (label === "累计" && mode === "all" ? fallback : { total: 0, ok: 0, failed: 0 });
        return h("div", { class: "settings-deploy-metric" },
          h("span", { class: "settings-deploy-metric-label" }, label),
          h("span", { class: "settings-deploy-metric-value" }, String(value.total ?? 0), h("small", {}, "次")),
          h("span", { class: "settings-deploy-metric-sub" },
            h("span", { class: "settings-deploy-summary-ok" }, "成功 ", h("strong", {}, String(value.ok ?? 0))),
            h("span", { class: "settings-deploy-summary-bad" }, "失败 ", h("strong", {}, String(value.failed ?? 0)))));
      }));
  }

  function syncStatus() {
    const s = state();
    if (!s.deployStale) return null;
    const from = s.deploySnapshotAt ? `${ago(s.deploySnapshotAt)}的快照` : "上次的快照";
    if (s.deployLoading) return h("span", { class: "settings-deploy-sync", role: "status" }, `先显示${from} · 正在同步最新统计…`);
    return h("span", { class: "settings-deploy-sync warn", role: "status" }, `显示的是${from}，尚未同步最新`);
  }

  function versionStatus(data) {
    return h("div", { class: "settings-version-status" },
      syncStatus(),
      data?.live ? h("span", { class: "settings-deploy-live" }, "线上 ", h("code", { class: "mono" }, shortSha(data.live))) : null,
      data && data.watcherRunning === false ? h("span", { class: "settings-deploy-watcher" }, "部署服务未运行") : null);
  }

  function shareButton(data) {
    const s = state();
    const button = h("button", { type: "button", class: "btn small settings-share-button", disabled: !data || !!s.shareOpening,
      onclick: async () => {
        if (s.shareOpening || !s.deployments) return;
        s.shareOpening = true; button.disabled = true; s.shareError = "";
        try {
          const module = await window.piRouteModules.ensure("version-share");
          if (ui.view !== "settings" || section() !== "version") return;
          const latest = state();
          module.open({ data: latest.deployments, heatRuntime: latest.heatRuntime, stale: latest.deployStale, snapshotAt: latest.deploySnapshotAt, returnFocus: button });
        } catch {
          s.shareError = "分享组件未能加载，请重试";
          if (ui.view === "settings" && section() === "version") renderMain();
        } finally {
          s.shareOpening = false; button.disabled = !s.deployments;
          const mounted = document.querySelector(".settings-share-button"); if (mounted) mounted.disabled = !s.deployments;
        }
      }
    }, "分享图片");
    return button;
  }

  function sessionCell(session, fallback) {
    if (!session) return h("span", { class: "settings-deploy-session muted" }, fallback);
    return h("span", { class: "settings-deploy-session" },
      h("span", { class: "settings-deploy-session-title" }, session.title, session.archived ? h("span", { class: "settings-deploy-archived" }, "已归档") : null),
      h("span", { class: "settings-deploy-open", "aria-hidden": "true" }, "›"));
  }

  function deployRow(entry) {
    const session = entry.session || null;
    const title = entry.subject || session?.title || `部署 ${shortSha(entry.sha)}`;
    const relative = ago(entry.at);
    const children = [
      h("time", { class: "settings-deploy-ago", datetime: entry.at, title: when(entry.at) }, relative),
      h("span", { class: `settings-deploy-state ${entry.state}` }, outcomeLabel(entry)),
      h("span", { class: "settings-deploy-main" },
        h("span", { class: "settings-deploy-title" }, title),
        h("span", { class: "settings-deploy-meta" },
          h("code", { class: "mono" }, shortSha(entry.sha)),
          h("span", { class: "settings-deploy-dot", "aria-hidden": "true" }, "·"),
          h("time", { datetime: entry.at }, when(entry.at)),
          h("span", { class: "settings-deploy-relative-inline" }, relative),
          entry.note ? h("span", { class: "settings-deploy-note" }, noteLabel(entry.note)) : null)),
      sessionCell(session, entry.sessionId ? "会话已删除" : "没有关联会话"),
    ];
    if (session) {
      return h("a", {
        class: `settings-deploy-row state-${entry.state}`,
        href: session.href,
        title: `打开会话：${session.title}`,
        "aria-label": `${outcomeLabel(entry)} ${shortSha(entry.sha)}，打开会话 ${session.title}`,
      }, ...children);
    }
    return h("div", { class: `settings-deploy-row disabled state-${entry.state}` }, ...children);
  }

  function activeRow(entry) {
    const session = entry.session || null;
    const started = entry.state === "started";
    const state = started ? "started" : "pending";
    const relative = ago(entry.requestedAt);
    const children = [
      h("time", { class: "settings-deploy-ago", datetime: entry.requestedAt, title: when(entry.requestedAt) }, relative),
      rtDeployClickable(h("span", { class: `settings-deploy-state ${state}` }, rtDeployLabel(entry)), entry),
      h("span", { class: "settings-deploy-main" },
        h("span", { class: "settings-deploy-title" }, entry.subject || session?.title || `部署 ${shortSha(entry.sha)}`),
        h("span", { class: "settings-deploy-meta" },
          h("code", { class: "mono" }, shortSha(entry.sha)),
          h("span", { class: "settings-deploy-dot", "aria-hidden": "true" }, "·"),
          h("time", { datetime: entry.requestedAt }, when(entry.requestedAt)),
          h("span", { class: "settings-deploy-relative-inline" }, relative))),
      sessionCell(session, entry.sessionId ? "会话已删除" : "没有关联会话"),
    ];
    if (session) {
      return h("a", {
        class: `settings-deploy-row state-${state}`,
        href: session.href,
        title: `打开会话：${session.title}`,
        "aria-label": `${rtDeployLabel(entry)} ${shortSha(entry.sha)}，打开会话 ${session.title}`,
      }, ...children);
    }
    return h("div", { class: `settings-deploy-row disabled state-${state}` }, ...children);
  }

  function historyFooter(data) {
    const s = state();
    if (!data) return null;
    if (data.entries.length >= data.total) {
      return h("p", { class: "muted small settings-deploy-end" }, data.total ? `已加载全部 ${data.total} 条` : "");
    }
    if (s.deployMoreError) {
      return h("div", { class: "settings-deploy-loadmore" },
        h("p", { class: "field-error", role: "alert" }, s.deployMoreError),
        h("button", { type: "button", class: "btn small", onclick: () => { s.deployMoreError = ""; loadDeployments(false, true); } }, "重试加载"));
    }
    if (s.deployLoadingMore) {
      return h("p", { class: "muted small settings-deploy-loadmore", role: "status" }, "正在加载更早的记录…");
    }
    const sentinel = h("div", { class: "settings-deploy-sentinel", "aria-hidden": "true" });
    s.deploySentinel = sentinel;
    queueMicrotask(observeHistorySentinel);
    return h("div", { class: "settings-deploy-loadmore" },
      sentinel,
      h("button", { type: "button", class: "btn small", onclick: () => loadDeployments(false, true) }, "加载更早的记录"));
  }

  function toggleFold(key) {
    const s = state();
    s.deployFolds[key] = !s.deployFolds[key];
    s.deployFoldAt = Date.now();
    renderMain();
  }

  function groupedEntries(entries) {
    const months = [];
    for (const entry of entries) {
      const date = entry.at.slice(0, 10), month = date.slice(0, 7);
      let group = months.at(-1);
      if (!group || group.key !== month) { group = { key: month, label: monthLabel(month), entries: [], days: [] }; months.push(group); }
      group.entries.push(entry);
      let day = group.days.at(-1);
      if (!day || day.key !== date) { day = { key: date, label: dayLabel(date), entries: [] }; group.days.push(day); }
      day.entries.push(entry);
    }
    return months;
  }

  function groupHeader({ key, label, count, kind }) {
    const folded = !!state().deployFolds[key];
    return h("button", {
      type: "button",
      class: `settings-deploy-${kind}`,
      "aria-expanded": String(!folded),
      onclick: () => toggleFold(key),
    },
      h("span", { class: `settings-deploy-${kind}-label` }, label),
      h("span", { class: `settings-deploy-${kind}-count` }, `${count} 条`),
      h("span", { class: "settings-deploy-chevron", "aria-hidden": "true" }, folded ? "›" : "⌄"));
  }

  function deployGroups(entries) {
    return groupedEntries(entries).map((month) => {
      const nodes = [groupHeader({ key: `m:${month.key}`, label: month.label, count: month.entries.length, kind: "month" })];
      if (!state().deployFolds[`m:${month.key}`]) {
        for (const day of month.days) {
          nodes.push(groupHeader({ key: `d:${day.key}`, label: day.label, count: day.entries.length, kind: "day" }));
          if (!state().deployFolds[`d:${day.key}`]) nodes.push(day.entries.map(deployRow));
        }
      }
      return nodes;
    });
  }

  const RUNTIMES = [
    { id: "codex", label: "Codex" },
    { id: "claude-code", label: "Claude Code" },
    { id: "pi", label: "Pi" },
  ];
  /** 版本页只留关键指标；耗时、成功率、趋势和月度热力图都去统计应用看。 */
  function statsLink() {
    return h("a", { class: "settings-stats-link", href: "#/stats/deploys?focus=trend", "data-key": "settings-stats-link" },
      h("span", { class: "settings-stats-link-text" }, h("strong", {}, "更多部署统计"), h("span", { class: "muted small" }, "部署耗时、成功率、趋势、月度热力图，以及按控制器版本 / 发起端拆解")),
      h("span", { class: "settings-stats-link-go", "aria-hidden": "true" }, "统计 ›"));
  }

  function versionSection() {
    const s = state();
    s.deploySentinel = null;
    loadDeployments();
    const data = s.deployments;
    const active = data?.active ?? [];
    const entries = data?.entries ?? [];
    const historyHead = h("div", { class: "settings-card-head" },
      h("div", {},
        h("h2", {}, "部署历史"),
        h("p", { class: "muted small" }, "按时间倒序。点一条记录打开发起这次部署的会话；滚动到底部会自动加载更早的记录。")),
      h("div", { class: "settings-card-actions" },
        h("button", { type: "button", class: "btn small", disabled: s.deployLoading || s.deployLoadingMore, onclick: () => { s.deployAttempted = false; s.deployMoreError = ""; loadDeployments(true); } }, s.deployLoading || s.deployLoadingMore ? "读取中…" : "刷新")));

    return [
      h("section", { class: "card settings-card settings-version settings-heat-card" },
        h("div", { class: "settings-card-head" },
          h("div", {},
            h("h2", {}, "平台前端版本"),
            h("p", { class: "muted small" }, "每次从页面或命令行发起的空闲时部署都会记在这里。部署成功后线上槽位切到对应提交；失败时线上保持不变。")),
          h("div", { class: "settings-card-actions" }, versionStatus(data), shareButton(data))),
        s.shareError ? h("p", { class: "field-error", role: "alert" }, s.shareError) : null,
        h("div", { class: "settings-heat-filters", role: "group", "aria-label": "按 runtime 筛选部署统计" },
          [{ id: "all", label: "全部" }, ...RUNTIMES].map((item) => h("button", {
            type: "button", class: `settings-heat-filter${(data?.runtimePeriods ? (s.heatRuntime || "all") : "all") === item.id ? " on" : ""}`,
            "aria-pressed": String((data?.runtimePeriods ? (s.heatRuntime || "all") : "all") === item.id),
            disabled: item.id !== "all" && !data?.runtimePeriods,
            onclick: () => { s.heatRuntime = item.id; renderMain(); },
          }, item.label))),
        deploySummary(data),
        statsLink(),
        s.deployError ? h("p", { class: "field-error", role: "alert" }, s.deployError,
          h("button", { type: "button", class: "btn small", onclick: () => { s.deployAttempted = false; loadDeployments(true); } }, "重试")) : null,
        !data && !s.deployError ? h("p", { class: "muted small" }, "正在读取部署历史…") : null,
        data && !active.length && data.total === 0 ? h("p", { class: "muted small" }, "还没有部署记录。") : null),
      active.length ? h("section", { class: "card settings-card settings-deploy-active" },
        h("div", { class: "settings-card-head" }, h("div", {}, h("h2", {}, "进行中"), h("p", { class: "muted small" }, "已经登记、还在排队或正在部署的请求。"))),
        h("div", { class: "settings-deploy-list" }, active.map(activeRow))) : null,
      data && entries.length ? h("section", { class: "card settings-card" },
        historyHead,
        h("div", { class: "settings-deploy-list" }, deployGroups(entries)),
        historyFooter(data)) : null,
    ];
  }

  // 平台 APP 版本：Android 客户端的版本卡（检查更新、安装历史入口）；网页端不出现这一项。
  function appVersionSection() {
    return [window.piAndroidShell?.versionPanel() ?? h("section", { class: "card settings-card" }, h("p", { class: "muted small" }, "平台 APP 版本只在 Android 客户端里可用。"))];
  }

  // 每个设置页的渲染器；目录（home）在 PC 上就是导航页，手机上只显示组目录。
  const SECTION_VIEWS = {
    capabilities: capabilitiesSection,
    navigation: navigationSection,
    apps: appsSection,
    cache: cacheSection,
    resources: resourcesSection,
    runtimes: runtimesSection,
    runtimeupdates: runtimeUpdatesSection,
    login: loginSection,
    memory: memorySection,
    scheduled: scheduledSection,
    version: versionSection,
    appversion: appVersionSection,
  };
  function sectionContent() {
    if (installsRoute()) return installsSection();
    const view = SECTION_VIEWS[section()];
    return view ? view() : navigationSection();
  }

  function render() {
    if (section() !== "runtimeupdates") void loadRuntimeUpdatesSummary();
    if (section() !== "version" || installsRoute()) {
      historyObserver?.disconnect();
      historyObserver = null;
    }
    return h("section", { class: `settings-app ${section() === "home" ? "settings-home" : "settings-detail"}`, "aria-label": "系统设置" },
      settingsHeader(),
      h("div", { class: "settings-app-body" },
        settingsNav(),
        h("main", { class: "settings-app-content", "data-keep-scroll": "settings-content" },
          section() === "home" && phone.matches ? null : sectionContent())));
  }

  phone.addEventListener("change", () => { if (ui.view === "settings") renderMain(); });

  if (window.piRouteModules && typeof window.piRouteModules.register === "function") {
    window.piRouteModules.register("settings", { render });
  }
})();
