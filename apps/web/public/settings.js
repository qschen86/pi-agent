"use strict";
/*
 * 平台设置：独立页面，有自己的一条导航栏。
 * - 通用能力：本设备通知、PC 剪贴板图片与链接识别。
 * - 导航：原来的导航设置（名称、位置、顺序）。
 * - 登录：登录会话列表、吊销、退出其他登录、退出登录（原来在「运行时」配置页底部）。
 * - 运行时配置：连接检查、模型可选范围、工作目录与历史授权、用量、本机历史（原来在会话列表右上角的「更多」里）。
 * - 版本：线上版本与部署历史；历史按时间倒序，点一条记录回到发起部署的会话。
 * - 错误统计：手动触发每晚错误统计（跑批），并保留运行历史（时间一律北京时间）。
 */
(function () {
  // 每一项的说明都是详情页里的一个关键状态（通知/截图开关、入口数、缓存开关、线上版本、记录开关），
  // 读不到状态时退回原来的静态描述，所以目录在脚本没加载完时也不会空着。
  const SECTIONS = [
    { id: "capabilities", label: "通用能力", hint: capabilityHint },
    { id: "navigation", label: "导航", hint: navigationHint },
    { id: "runtimes", label: "运行时配置", hint: runtimesHint },
    { id: "cache", label: "会话缓存", hint: cacheHint },
    { id: "stats", label: "统计", hint: () => "消耗、会话、部署的趋势与拆解", href: "#/stats" },
    { id: "version", label: "版本", hint: versionHint },
    { id: "errorstats", label: "错误统计", hint: errorStatsHint },
    { id: "codexreset", label: "Codex Reset", hint: codexResetHint },
    { id: "login", label: "登录", hint: loginHint },
  ];
  function capabilityHint() {
    const notifications = window.sessionNotifications;
    const clipboard = window.piClipboardImages;
    if (typeof notifications?.supported !== "function" || typeof clipboard?.supported !== "function") return "本设备通知与截图";
    const notify = !notifications.supported() ? "通知不可用" : notifications.enabled?.() ? "通知已开" : "通知未开";
    const shot = !clipboard.supported() ? "截图不可用" : clipboard.enabled?.() ? "截图已开" : "截图未开";
    return `${notify} · ${shot}`;
  }
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
  function loginHint() {
    const a = state().auth;
    if (!a) return "登录会话与退出登录";
    if (!a.enabled || !a.public) return "未启用登录";
    const active = (a.sessions || []).filter((x) => x.active).length;
    return `${active} 个有效登录 · 可退出`;
  }
  function runtimesHint() {
    const profiles = typeof ui === "undefined" ? null : ui.rt?.profiles;
    if (!Array.isArray(profiles) || !profiles.length) return "连接检查、模型与授权";
    const ready = profiles.filter((p) => p && p.state === "executable").length;
    const login = profiles.filter((p) => p && p.state === "needs-login").length;
    return `${ready}/${profiles.length} 个可执行${login ? ` · ${login} 个待登录` : ""}`;
  }
  function cacheHint() {
    let disk = null;
    try { disk = typeof sessionDisk === "undefined" ? null : sessionDisk; } catch { /* 没加载缓存模块 */ }
    if (!disk) return "本机正文与清除";
    return disk.enabled ? "已开启 · 正文留 7 天" : "未开启 · 打开读服务器";
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
    return ui.settings;
  }
  function section() {
    const wanted = state().section;
    return wanted === "home" || SECTIONS.some((x) => x.id === wanted && !x.href) ? wanted : "home";
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

  /** #/settings/version/installs：Android 客户端的安装历史明细页（卡片里只放摘要和入口）。 */
  function installsRoute() { return section() === "version" && state().extra === "installs"; }
  function installsSection() {
    const page = window.piAndroidShell?.installsPage?.();
    return page ? [page] : [h("section", { class: "card settings-card" }, h("p", { class: "muted small" }, "安装历史只在 Android 客户端里可用。"))];
  }

  function settingsHeader() {
    const detail = phone.matches && section() !== "home";
    const item = SECTIONS.find((item) => item.id === section());
    // 版本 → 安装历史是设置里的下一层页面：任何屏幕上返回都回到「版本」，标题就是页面本身。
    const sub = installsRoute();
    return h("header", { class: "settings-app-head page-navigation-head" },
      section() !== "home" ? h("a", { class: "settings-back", href: sub ? "#/settings/version" : detail ? "#/settings" : backHref(), "aria-label": sub ? "返回版本" : detail ? "返回设置" : "返回上一页" }, "‹ 返回") : null,
      h("div", { class: "settings-app-title" },
        h("h1", {}, sub ? "安装历史" : detail ? item.label : "系统设置")));
  }

  function settingsNav() {
    const current = section() === "home" && !phone.matches ? "navigation" : section();
    return h("nav", { class: "settings-app-nav", "aria-label": "设置导航" },
      h("span", { class: "settings-app-nav-label" }, "系统设置"),
      SECTIONS.map((item) => h("a", {
        class: `settings-nav-item${item.id === current ? " on" : ""}${item.id === "capabilities" && pendingCapabilities().length ? " has-alert" : ""}`,
        href: item.href || sectionHref(item.id),
        "data-settings-nav": item.id,
        ...(item.id === current ? { "aria-current": "page" } : {}),
      },
        h("span", { class: "settings-nav-head" },
          h("span", { class: "settings-nav-label" }, item.label),
          item.id === "capabilities" ? h("span", { class: "settings-alert-dot", title: "有能力尚未开启", "aria-label": "有能力尚未开启" }) : null,
          item.id === "version" ? window.piNativeUpdate?.badge?.() ?? null : null),
        h("span", { class: "settings-nav-hint" }, hintOf(item)),
        h("span", { class: "settings-nav-arrow", "aria-hidden": "true" }, "›"))));
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

  function navigationSection() {
    if (typeof window.navSettingsPanel === "function") return window.navSettingsPanel();
    return h("section", { class: "card settings-card" },
      h("h2", {}, "导航"),
      h("p", { class: "muted small" }, "导航设置还没有加载。刷新页面后再试。"));
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

  // 会话缓存：本机会话列表 / 正文的保存与清除。原来是「导航」页面里的一块，独立成菜单后和导航并列。
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
    if (s.errorStats?.running && ui.view === "settings") s.errorStatsPoll = setTimeout(() => { if (ui.view === "settings" && section() === "errorstats") void loadErrorStats(); }, 2500);
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
    if (s.codexReset?.running && ui.view === "settings") s.codexResetPoll = setTimeout(() => { if (ui.view === "settings" && section() === "codexreset") void loadCodexReset(); }, 2500);
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
      h("p", { class: "settings-run-line" }, `入库：工具 ${kinds.tool ?? 0} · 部署 ${kinds.deploy ?? 0} · 记忆强约束 ${kinds.memory ?? 0}；DeepSeek 归并 ${run.merged ?? 0} 个指纹`),
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
      h("section", { class: "card settings-card" },
        h("div", { class: "settings-card-head" }, h("div", {}, h("h2", {}, "统计历史"), h("p", { class: "muted small" }, "时间均为北京时间；点一轮查看明细和新建的待办。"))),
        h("div", { class: "settings-run-list", "data-error-stats-history": "" }, list)));
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
      window.piAndroidShell?.versionPanel() ?? null,
      h("section", { class: "card settings-card settings-version settings-heat-card" },
        h("div", { class: "settings-card-head" },
          h("div", {},
            h("h2", {}, "版本", window.piNativeUpdate?.badge?.() ?? null),
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

  function render() {
    if (section() !== "version" || installsRoute()) {
      historyObserver?.disconnect();
      historyObserver = null;
    }
    return h("section", { class: `settings-app ${section() === "home" ? "settings-home" : "settings-detail"}`, "aria-label": "系统设置" },
      settingsHeader(),
      h("div", { class: "settings-app-body" },
        settingsNav(),
        h("main", { class: "settings-app-content", "data-keep-scroll": "settings-content" },
          section() === "home" && phone.matches ? null : installsRoute() ? installsSection() : section() === "version" ? versionSection() : section() === "capabilities" ? capabilitiesSection() : section() === "login" ? loginSection() : section() === "cache" ? cacheSection() : section() === "errorstats" ? errorStatsSection() : section() === "codexreset" ? codexResetSection() : section() === "runtimes" ? runtimesSection() : navigationSection())));
  }

  phone.addEventListener("change", () => { if (ui.view === "settings") renderMain(); });

  if (window.piRouteModules && typeof window.piRouteModules.register === "function") {
    window.piRouteModules.register("settings", { render });
  }
})();
