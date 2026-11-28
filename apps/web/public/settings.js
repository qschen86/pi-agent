"use strict";
/*
 * 设置：独立页面，有自己的一条导航栏。自愈（基础组）是两级：#/settings/selfheal 板块列表，#/settings/selfheal/<板块> 板块详情。
 * 顶部先分「平台设置 / 应用设置」两栏（页内标签：扁平，只有选中项带液态玻璃，手机上左右滑也能切）：
 * - 平台设置目录顶部带二级分类导航（智能球 / 产物库 / 基础），点按快速定位到对应分组，滚动时联动高亮：
 *   - 智能球：会话及回复 / 记忆 / 能力增强（MCP、技能）/ 通知及授权（设备能力、登录会话）。
 *   - 产物库：位置（导航里产物区的名称、顺序与置顶）/ 分类管理 / 可选应用（基础应用始终开启）。
 *   - 基础：运行时接入与设置 / 账户资源 / 网络及设备 / 深色模式 / 统计 / 自愈（含定时任务）/ 迭代升级。
 *     （MCP 服务由 runtime profile 自动装配，没有面向用户的开关，不单列；产品目前只有中文，没有语言项。）
 * - 应用设置：各产物自己的设置，先列应用，再进单个应用。
 * 旧地址（#/settings/cache、auth、noticeservice、connections、login、errorstats、codexreset 等）由 app.js 重定向到合并后的页；
 * 调用记录是「能力增强」下的二级页；安装历史在 #/settings/appversion/installs。
 */
(function () {
  // 分组顺序即目录顺序：同组条目连续排列，目录里先出组名再出条目。
  const SCOPES = [
    { id: "platform", label: "平台设置", href: "#/settings" },
    { id: "apps", label: "应用设置", href: "#/settings/application" },
  ];
  const GROUPS = [
    { id: "orb", label: "智能球" },
    { id: "library", label: "产物库" },
    { id: "base", label: "基础" },
  ];
  // 每一项的说明都是详情页里的一个关键状态（通知/截图/连接/登录、缓存与回复、入口数、线上版本、记录开关），
  // 读不到状态时退回原来的静态描述，所以目录在脚本没加载完时也不会空着。
  // 单项组的条目名 = 组名；show 返回 false 的条目不进目录，地址也回到目录（平台 APP 版本只在 Android 客户端里有）。
  // 目录每项左侧的图标（设计稿 A「分组列表」）：24×24 描边图形，颜色由 CSS 给。
  const NAV_ICONS = {
    reply: '<path d="M4 5h16v11H9l-5 4z"/>',
    memory: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 3 4 3 3 0 0 0 5 1V5a2 2 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-3 4 3 3 0 0 1-5 1"/>',
    enhancement: '<path d="M9 3v4M15 3v4M7 7h10v5a5 5 0 0 1-10 0zM12 17v4"/>',
    capabilities: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4"/>',
    navigation: '<path d="M12 21s-6-6-6-11a6 6 0 0 1 12 0c0 5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>',
    collections: '<path d="M4 4h8l8 8-8 8-8-8z"/><circle cx="8.5" cy="8.5" r="1"/>',
    apps: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
    runtimes: '<path d="M7 7h10v10H7zM9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    resources: '<path d="M4 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4zM4 7l12-3v3M16 14h2"/>',
    remote: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
    theme: '<path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10z"/>',
    stats: '<path d="M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-3"/>',
    selfheal: '<path d="M12 21s-8-5-8-11a4.5 4.5 0 0 1 8-2.5A4.5 4.5 0 0 1 20 10c0 6-8 11-8 11zM12 9v5M9.5 11.5h5"/>',
    upgrades: '<path d="M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8"/>',
  };
  const SECTIONS = [
    { id: "reply", group: "orb", label: "会话及回复", hint: replyHint },
    { id: "memory", group: "orb", label: "记忆", hint: memoryHint },
    { id: "enhancement", group: "orb", label: "能力增强", hint: enhancementHint },
    { id: "capabilities", group: "orb", label: "通知及授权", hint: capabilityHint },
    { id: "navigation", group: "library", label: "位置", hint: navigationHint },
    { id: "collections", group: "library", label: "分类管理", hint: categoriesHint },
    { id: "apps", group: "library", label: "可选应用", hint: appsHint },
    { id: "runtimes", group: "base", label: "运行时接入与设置", hint: runtimesHint },
    { id: "resources", group: "base", label: "账户资源", hint: resourcesHint },
    { id: "remote", group: "base", label: "网络及设备", hint: remoteHint },
    { id: "theme", group: "base", label: "深色模式", hint: themeHint },
    { id: "stats", group: "base", label: "统计", hint: () => "消耗、会话、部署的趋势与拆解", href: "#/stats" },
    { id: "selfheal", group: "base", label: "自愈", hint: selfHealHint },
    { id: "upgrades", group: "base", label: "迭代升级", hint: runtimeUpdatesHint },
  ];
  // 旧分组 ID 兼容映射（除了 app.js 路由重定向，也保护直接设置 ui.settings.section 的场景）。
  const SECTION_ALIAS = { cache: "reply", auth: "capabilities" };
  // 二级页：不在目录里出现，只能从父页进入（返回也回到父页）。
  const SUBS = {
    connectionaudit: { parent: "enhancement", label: "调用记录" },
  };
  const visibleSections = () => SECTIONS.filter((item) => !item.show || item.show());
  function enhancementHint() {
    const parts = [];
    if (connectionsState.loaded) parts.push(`${connectionsState.connections.filter((item) => item.status === "connected").length} 个外部连接`);
    if (Array.isArray(state().skills)) parts.push(skillsHint());
    return parts.length ? parts.join(" · ") : "连接外部服务、MCP 与技能";
  }
  // 通知及授权：设备能力开关与登录会话。
  function capabilityHint() {
    const parts = [];
    const notifications = window.sessionNotifications;
    const clipboard = window.piClipboardImages;
    if (typeof notifications?.supported === "function" && typeof clipboard?.supported === "function") {
      parts.push(!notifications.supported() ? "通知不可用" : notifications.enabled?.() ? "通知已开" : "通知未开");
      parts.push(!clipboard.supported() ? "截图不可用" : clipboard.enabled?.() ? "截图已开" : "截图未开");
    }
    const auth = state().auth;
    if (auth && auth.enabled && auth.public) parts.push(`${(auth.sessions || []).filter((item) => item.active).length} 个登录`);
    return parts.length ? parts.join(" · ") : "设备通知、系统权限与登录会话";
  }
  // 会话及回复：合并会话缓存、回合汇总（本机开关）和 PC 用量栏置顶的状态。
  function replyHint() {
    let disk = null;
    try { disk = typeof sessionDisk === "undefined" ? null : sessionDisk; } catch { /* 没加载缓存模块 */ }
    const hasSummary = typeof window.piTurnSummaryMode?.enabled === "function";
    if (!disk && !hasSummary) return "会话缓存、回合汇总与用量栏";
    const parts = [];
    if (disk) parts.push(disk.enabled ? "缓存已开" : "缓存未开");
    const summary = turnSummaryEnabled();
    parts.push(`回合汇总${summary ? "已开" : "未开"}`);
    if (!phone.matches) parts.push(`用量栏置顶${usageTopEnabled() ? "已开" : "未开"}`);
    return parts.join(" · ");
  }
  function themeHint() {
    const mode = window.piTheme?.mode?.() || "system";
    return mode === "dark" ? "深色" : mode === "light" ? "浅色" : "跟随系统";
  }
  function categoriesHint() {
    return window.piArtifactCategoryBrowser ? "新建、改名、合并与排序" : "在产物页里整理分类";
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
  function remoteHint() {
    const nativeConn = state().nativeConn;
    if (nativeConn) {
      const activeRoute = Array.isArray(nativeConn.routes) ? nativeConn.routes.find((item) => item.active) : null;
      if (activeRoute) {
        const kind = activeRoute.type === "public_domain" ? "自有域名" : activeRoute.type === "custom_relay" ? "自建中继" : "公共中继";
        return `当前线路：${kind}（${activeRoute.label}）`;
      }
      return nativeConn.active === "remote"
        ? `当前线路：加密中继${nativeConn.remoteHostName ? `（${nativeConn.remoteHostName}）` : ""}`
        : `当前线路：自有域名${nativeConn.publicHost ? `（${nativeConn.publicHost}）` : ""}`;
    }
    const r = state().remote;
    if (!r) return "扫码配对手机，端到端加密访问";
    if (!r.enabled) return "未开启";
    const activeCount = (r.devices || []).filter((d) => !d.revokedAt).length;
    return `${r.connectionLabel || "离线"} · ${activeCount} 台已配对设备`;
  }
  // 应用开关：读取服务端当前状态；切换后整份落到服务端，再由 route-loader 缓存并刷新页面，入口与模块按新状态重新装配。
  async function loadApps() {
    const s = state();
    s.appsLoaded = true;
    try { s.appsView = await api("/api/apps"); s.appsError = ""; }
    catch (error) { s.appsError = error?.message || "读取应用列表失败"; }
    if (ui.view === "settings" && (section() === "apps" || section() === "application")) renderMain();
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
    finally { s.appsBusy = ""; if (ui.view === "settings" && (section() === "apps" || section() === "application")) renderMain(); }
  }
  function appsSection() {
    const s = state();
    if (!s.appsLoaded) void loadApps();
    const view = s.appsView;
    const intro = h("div", { class: "settings-page-intro", "data-apps-intro": "" },
      h("p", { class: "settings-note" }, "会话、群聊、记忆、产物和设置是基础应用，始终开启。下面是可选应用：关闭后入口和功能隐藏、后台任务停止，已有数据都保留，随时可以重新打开。"),
      h("section", { class: "card settings-rows" },
        s.appsError ? h("p", { class: "field-error", role: "alert" }, s.appsError,
          h("button", { type: "button", class: "btn small", onclick: () => { s.appsError = ""; void loadApps(); } }, "重试")) : null,
        !view && !s.appsError ? skeletonRows(3, "正在读取应用列表…") : null,
        view && !view.apps.length ? h("p", { class: "settings-note" }, "这个版本没有可开关的可选应用。") : null,
        ...(view?.apps || []).map((app) => {
          const control = h("input", { type: "checkbox", role: "switch", class: "settings-switch", "aria-label": app.name, checked: app.enabled, disabled: !!s.appsBusy,
            onchange: (event) => { event.target.checked = app.enabled; void toggleApp(app, !app.enabled); } });
          const notes = [
            app.alsoOff.length ? `关闭后「${app.alsoOff.join("、")}」也会一起关闭。` : "",
            !app.enabled && app.needs.length ? `打开时会一并打开「${app.needs.join("、")}」。` : "",
          ].filter(Boolean);
          return settingsRow(app.name, [app.description, ...notes].filter(Boolean).join(" "), control, {
            cls: s.appsBusy === app.id ? "is-busy" : "",
            attrs: { "data-app-switch": app.id },
          });
        })));
    return [intro];
  }
  // 应用设置：各产物自己的设置。先列已启用的应用，再进单个应用。
  // 现在真正存在应用内部的设置只有两处（通讯录的数据权限与同步范围、X 浏览器的采集设置），
  // 所以这里先给入口和说明；应用以后把自己的设置面板注册进来时，把入口换成面板即可。
  const APP_SETTINGS = {
    notes: [
      { label: "日历来源与设置", hint: "待办页的日历 → 更多 → 日历来源与设置（Google / iCloud）", href: "#/notes" },
      { label: "笔记分类", hint: "新建、改名、合并笔记分类，已归档的笔记跟着走", href: "#/notes/categories" },
    ],
    communications: [{ label: "同步与权限", hint: "通讯录页的「同步与权限」：逐项授权、采集范围、立即同步", href: "#/communications" }],
    "web-x": [{ label: "采集设置", hint: "AI 浏览器右上角齿轮：采集范围、停留时长与站点", href: "#/web-x" }],
  };
  const appSettingsOf = (id) => APP_SETTINGS[id] || [];
  function appSettingsHint(app) {
    const entries = appSettingsOf(app.id);
    return entries.length ? `${entries.map((entry) => entry.label).join("、")}` : "还没有单独的设置项";
  }
  /**
   * 应用设置的清单 = 产物区导航里真的出现的产物（用户自己排过序、改过名字，所以名字读渲染后的标签）。
   * 优先问 piNav（顺序与自定义名都在它手里），没加载就直接读导航 DOM，再退到可选应用清单。
   */
  function appsForSettings() {
    let nav = [];
    try { nav = window.piNav?.apps?.() || []; } catch { nav = []; }
    if (nav.length) return nav.map((app) => ({ id: app.id, name: app.name, description: app.title, icon: app.icon || null }));
    const dom = [...document.querySelectorAll(".tabs .tab[data-app][data-view], #nav-more .tab[data-app][data-view]")]
      .filter((el) => !el.hasAttribute("data-offline"))
      .map((el) => ({ id: el.dataset.view, name: el.querySelector(".tab-label")?.textContent?.trim() || el.dataset.view, description: el.title, icon: el.querySelector("svg")?.cloneNode(true) || null }));
    if (dom.length) return dom;
    const view = state().appsView;
    return (view?.apps || []).filter((app) => app.enabled).map((app) => ({ id: app.id, name: app.name }));
  }
  function appSettingsLinks() {
    const s = state();
    if (!s.appsLoaded) void loadApps();
    const view = s.appsView;
    let nav = [];
    try { nav = window.piNav?.apps?.() || []; } catch { nav = []; }
    if (!nav.length && !view) {
      return s.appsError
        ? [h("p", { class: "field-error", role: "alert" }, s.appsError,
          h("button", { type: "button", class: "btn small", onclick: () => { s.appsError = ""; void loadApps(); } }, "重试"))]
        : [skeletonRows(4, "正在读取应用…")];
    }
    const apps = appsForSettings();
    if (!apps.length) return [h("p", { class: "muted small" }, "没有已启用的应用。先到「平台设置 → 可选应用」打开需要的应用。")];
    const current = state().extra || "";
    return apps.map((app) => h("a", {
        class: `settings-nav-item${app.id === current ? " on" : ""}`,
        href: `#/settings/application/${app.id}`,
        "data-settings-app": app.id,
        ...(app.id === current ? { "aria-current": "page" } : {}),
      },
        appNavIcon(app),
        h("span", { class: "settings-nav-text" },
          h("span", { class: "settings-nav-head" }, h("span", { class: "settings-nav-label" }, app.name)),
          h("span", { class: "settings-nav-hint" }, appSettingsHint(app))),
        h("span", { class: "settings-nav-arrow", "aria-hidden": "true" }, "›")));
  }
  /** 应用条目的图标：用产物区自己的图标，没有就用四宫格占位。 */
  function appNavIcon(app) {
    const box = document.createElement("span");
    box.className = "settings-nav-icon";
    box.setAttribute("aria-hidden", "true");
    if (app.icon) {
      const icon = app.icon.cloneNode(true);
      // 产物区自己的图标带 .tab-icon（那里控制显隐与 22px 尺寸），拿进来要去掉，尺寸交给目录样式。
      icon.classList?.remove("tab-icon");
      icon.removeAttribute?.("width"); icon.removeAttribute?.("height");
      box.append(icon);
    }
    else box.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${NAV_ICONS.apps}</svg>`;
    return box;
  }
  // 应用设置首页：PC 上靠左侧目录进入单个应用，手机目录就是这一页；没有选应用时给一句说明。
  function applicationSection() {
    const appId = state().extra;
    if (!appId) {
      return h("section", { class: "card settings-card", "data-app-settings-empty": "" },
        h("h2", {}, "应用设置"),
        h("p", { class: "muted small" }, "选择左侧（手机上在目录里）的一个应用，看它自己的设置。平台级的开关在「平台设置」里。"));
    }
    if (!state().appsLoaded) void loadApps();
    const app = appsForSettings().find((item) => item.id === appId);
    if (!app) {
      if (!state().appsLoaded) return skeletonRows(3, "正在读取应用…");
      return h("section", { class: "card settings-card", "data-app-settings-missing": "" },
        h("p", { class: "muted small" }, "没有这个应用，或它已经被关闭。"),
        h("a", { class: "btn small", href: "#/settings/application" }, "回到应用设置"));
    }
    const entries = appSettingsOf(app.id);
    return [
      h("section", { class: "card settings-card", "data-app-settings-intro": app.id },
        h("h2", {}, app.name),
        h("p", { class: "muted small" }, app.description)),
      entries.length
        ? h("section", { class: "card settings-card", "data-app-settings-list": app.id },
          h("h2", {}, "设置"),
          ...entries.map((entry) => h("a", { class: "settings-app-setting-row", href: entry.href },
            h("span", {}, h("strong", {}, entry.label), h("span", { class: "muted small" }, entry.hint)),
            h("span", { class: "settings-nav-arrow", "aria-hidden": "true" }, "›"))))
        : h("section", { class: "card settings-card", "data-app-settings-none": app.id },
          h("h2", {}, "设置"),
          h("p", { class: "muted small" }, "这个应用还没有单独的设置项：它的用法和开关都在应用页里。")),
    ];
  }
  // 会话及回复：会话缓存、回合汇总与 PC 会话列表用量栏合并为一页（均为智能球会话的本机偏好）。
  // 会话及回复（设计稿 A）：会话缓存一卡（只影响本机），回复展示一卡（回合汇总 + PC 用量栏）。
  // PC 用量栏只在电脑宽屏生效，手机上不列。
  function replySection() {
    return [
      h("div", { class: "settings-group-label" }, "会话缓存"),
      cacheSection(),
      h("p", { class: "settings-note" }, "是否在本机保存会话列表与正文，只影响本机显示速度，不影响服务器上的会话历史。"),
      h("div", { class: "settings-group-label" }, "回复展示"),
      settingsRows([
        settingsRow("会话回合汇总模式", "单聊里的长回复、带产出物或待决定的回合在顶部汇总为结论卡片，正文默认折叠、一键可看。",
          h("input", {
            type: "checkbox", role: "switch", class: "settings-switch", "aria-label": "会话回合汇总模式",
            checked: turnSummaryEnabled(),
            onchange: event => { setTurnSummaryEnabled(event.currentTarget.checked); }
          }), { attrs: { "data-turn-summary-settings": "" } }),
        phone.matches ? null : settingsRow("PC 会话列表：用量栏置顶", "只在电脑宽屏上生效：顶部换成三个 runtime 的额度方框，点一下就用它新建会话；双击 Ctrl 不变。",
          h("input", {
            type: "checkbox", role: "switch", class: "settings-switch", "aria-label": "PC 会话列表：用量栏置顶",
            checked: usageTopEnabled(),
            onchange: event => { setUsageTopEnabled(event.currentTarget.checked); }
          }), { attrs: { "data-usage-top-settings": "" } }),
      ]),
    ];
  }
  // 分类管理：产物页那个半屏面板的独立入口，不复制一套编辑逻辑。
  function collectionsSection() {
    return h("section", { class: "card settings-card", "data-collections-settings": "" },
      h("h2", {}, "分类管理"),
      h("p", { class: "muted small" }, "产物库的一级、二级分类在这里集中整理：新建、改名、合并与排序。保存后所有设备下次打开产物页时生效。"),
      h("div", { class: "rt-actions" },
        h("button", {
          type: "button", class: "btn primary",
          onclick: () => { window.piArtifactCategoryBrowser?.openManager?.({}); },
        }, "打开分类管理")));
  }
  // 深色模式：和顶栏「夜间」按钮是同一个设置（pi-agent.theme.v1），这里能显式选「跟随系统」。
  function themeMode() {
    return window.piTheme?.mode?.() || "system";
  }
  function setThemeMode(mode) {
    if (typeof window.piTheme?.setMode === "function") return window.piTheme.setMode(mode);
    try {
      if (mode === "dark" || mode === "light") localStorage.setItem("pi-agent.theme.v1", mode);
      else localStorage.removeItem("pi-agent.theme.v1");
    } catch { /* 存不了就只在本页生效 */ }
    if (mode === "dark" || mode === "light") document.documentElement.dataset.theme = mode;
    else delete document.documentElement.dataset.theme;
  }
  function themeSection() {
    const mode = themeMode();
    return h("section", { class: "card settings-card", "data-theme-settings": "" },
      h("div", { class: "settings-card-head" }, h("div", {},
        h("h2", {}, "深色模式"),
        h("p", { class: "muted small" }, "只保存在这个浏览器；选「跟随系统」时随设备的深浅色切换。顶栏的「夜间」按钮也是同一个设置。"))),
      h("div", { class: "inpage-tabs settings-theme-tabs", role: "radiogroup", "aria-label": "深色模式" },
        ...[['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([id, label]) => h("button", {
          type: "button", role: "radio", class: mode === id ? "active" : "", "aria-checked": String(mode === id), "data-theme-mode": id,
          onclick: () => { setThemeMode(id); renderMain(); },
        }, label))));
  }

  // 通知服务：通知服务会话里收哪些场景。只管「要不要记进会话」，系统推送各走各的开关；关闭只影响之后的新通知。
  function noticeServiceHint() {
    const view = state().noticesView;
    if (!view) return "决定哪些场景进通知服务会话";
    const on = view.scenes.filter((scene) => scene.enabled).length;
    return on === view.scenes.length ? `${on} 个场景全部开启` : `${on}/${view.scenes.length} 个场景开启`;
  }
  // 技能：平台技能（仓库 skills/platform）的开关，决定输入框 `/` 菜单里出现哪些。
  // 被关掉的技能对会话来说就像不存在：不出现在菜单里，也不会被展开。
  function skillsHint() {
    const list = state().skills;
    if (!Array.isArray(list) || !list.length) return "输入框 / 菜单里出现哪些技能";
    return `${list.filter((skill) => skill.enabled !== false).length}/${list.length} 个技能开启`;
  }
  async function loadSkills() {
    const s = state();
    s.skillsLoaded = true;
    try {
      const data = await api("/api/platform-skills/switches");
      s.skills = Array.isArray(data?.skills) ? data.skills : [];
      s.skillsError = "";
    } catch (error) { s.skillsError = error?.message || "读取技能失败"; }
    if (ui.view === "settings" && section() === "skills") renderMain();
  }
  async function toggleSkill(skill, enabled) {
    const s = state();
    s.skillsBusy = skill.id; s.skillsError = "";
    renderMain();
    try {
      const next = await api(`/api/platform-skills/${encodeURIComponent(skill.id)}`, { method: "PUT", body: JSON.stringify({ enabled }) });
      // 服务端返回整份开关表就整份换掉，否则只改这一项。
      if (Array.isArray(next?.skills)) s.skills = next.skills;
      else skill.enabled = enabled;
      announce(enabled ? `已开启 ${skill.name}` : `已关闭 ${skill.name}`);
    } catch (error) { s.skillsError = error?.message || "保存失败，请重试"; }
    finally { s.skillsBusy = ""; if (ui.view === "settings" && section() === "skills") renderMain(); }
  }
  function skillsSection() {
    const s = state();
    if (!s.skillsLoaded) void loadSkills();
    const list = Array.isArray(s.skills) ? s.skills : [];
    const intro = h("div", { class: "settings-page-intro", "data-skills-intro": "" },
      h("p", { class: "settings-note" }, "在输入框写 /技能名，平台会在这一轮把说明展开给 runtime。关掉的技能不出现在 / 菜单里，已经跑过的会话不受影响。"),
      h("section", { class: "card settings-rows" },
        s.skillsError ? h("p", { class: "field-error", role: "alert" }, s.skillsError,
          h("button", { type: "button", class: "btn small", onclick: () => { s.skillsError = ""; s.skillsLoaded = false; renderMain(); } }, "重试")) : null,
        !s.skillsLoaded ? skeletonRows(3, "正在读取技能…")
          : !list.length ? h("p", { class: "settings-note" }, "这台机器上没有平台技能。") : null,
        ...list.map((skill) => settingsRow(skill.name, `${skill.description || ""} · /${skill.name}${skill.id && skill.id !== skill.name ? ` · /${skill.id}` : ""}`.replace(/^ · /, ""), h("input", {
          type: "checkbox", role: "switch", class: "settings-switch", "aria-label": skill.name,
          checked: skill.enabled !== false, disabled: s.skillsBusy === skill.id,
          onchange: (event) => { event.target.checked = skill.enabled !== false; void toggleSkill(skill, !(skill.enabled !== false)); },
        }), {
          cls: s.skillsBusy === skill.id ? "is-busy" : "",
          attrs: { "data-skill": skill.id },
        }))));
    return [intro];
  }

  async function loadNotices() {
    const s = state();
    s.noticesLoaded = true;
    try { s.noticesView = await api("/api/service-notifications/settings"); s.noticesError = ""; }
    catch (error) { s.noticesError = error?.message || "读取通知设置失败"; }
    if (ui.view === "settings" && section() === "capabilities") renderMain();
  }
  async function toggleNoticeScene(scene, enabled) {
    const s = state();
    s.noticesBusy = scene.id; s.noticesError = "";
    renderMain();
    try {
      s.noticesView = await api(`/api/service-notifications/settings/${encodeURIComponent(scene.id)}`, { method: "PUT", body: JSON.stringify({ enabled }) });
      announce(enabled ? `已开启${scene.name}通知` : `已关闭${scene.name}通知`);
    } catch (error) { s.noticesError = error?.message || "保存失败，请重试"; }
    finally { s.noticesBusy = ""; if (ui.view === "settings" && section() === "capabilities") renderMain(); }
  }
  function noticeServiceSection() {
    const s = state();
    if (!s.noticesLoaded) void loadNotices();
    const view = s.noticesView;
    const rows = (view?.scenes || []).map((scene) => {
      const control = h("input", { type: "checkbox", role: "switch", class: "settings-switch", "aria-label": scene.name, checked: scene.enabled, disabled: !!s.noticesBusy,
        onchange: (event) => { event.target.checked = scene.enabled; void toggleNoticeScene(scene, !scene.enabled); } });
      return settingsRow(scene.name, scene.description, control, {
        cls: s.noticesBusy === scene.id ? "is-busy" : "",
        attrs: { "data-notice-scene": scene.id },
      });
    });
    return [
      h("div", { class: "settings-group-label" }, "通知场景"),
      h("div", { class: "settings-page-intro", "data-notice-intro": "" },
        h("p", { class: "settings-note" }, "选择哪些场景会记进会话列表里的「通知服务」。"),
        h("section", { class: "card settings-rows" },
          s.noticesError ? h("p", { class: "field-error", role: "alert" }, s.noticesError,
            h("button", { type: "button", class: "btn small", onclick: () => { s.noticesError = ""; void loadNotices(); } }, "重试")) : null,
          !view && !s.noticesError ? skeletonRows(3, "正在读取通知场景…") : null,
          ...rows),
        h("p", { class: "settings-note" }, "关闭只影响之后的新通知，已有的通知保留；系统推送不受这里影响。")),
    ];
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
    const raw = state().section;
    const wanted = SECTION_ALIAS[raw] || raw;
    // 内容仍复用原管理面板，路由负责选择聚合菜单和标签。
    if (wanted === "enhancement") return state().extra === "skills" ? "skills" : "connections";
    if (wanted === "upgrades") return state().extra === "app" ? "appversion" : state().extra === "frontend" ? "version" : "runtimeupdates";
    if (wanted === "selfheal" && state().extra === "scheduled") return "scheduled";
    if (["skills", "connections", "scheduled", "runtimeupdates", "version", "appversion"].includes(wanted)) return wanted;
    if (wanted === "home" || wanted === "application" || SUBS[wanted]) return wanted;
    return visibleSections().some((x) => x.id === wanted && !x.href) ? wanted : "home";
  }
  /** 目录页：平台设置首页、应用设置首页（没有具体应用）；它们不是详情页，不显示返回上一层。 */
  const rootSection = () => section() === "home" || (section() === "application" && !state().extra);
  function menuSection() {
    const current = section();
    if (["skills", "connections", "connectionaudit"].includes(current)) return "enhancement";
    if (["runtimeupdates", "version", "appversion"].includes(current)) return "upgrades";
    return current === "scheduled" ? "selfheal" : current;
  }
  function sectionHref(id) { return `#/settings/${id}`; }
  function managementTabs() {
    if (installsRoute() || ruDetailRoute() || shBoardRoute() || section() === "connectionaudit") return null;
    const groups = {
      enhancement: [["connections", "账号与工具", "enhancement"], ["skills", "技能", "enhancement/skills"]],
      selfheal: [["selfheal", "自愈", "selfheal"], ["scheduled", "自迭代 / 定时任务", "selfheal/scheduled"]],
      upgrades: [["runtimeupdates", "运行时", "upgrades"], ["appversion", "APP", "upgrades/app"], ["version", "平台前端", "upgrades/frontend"]],
    };
    const items = groups[menuSection()];
    if (!items) return null;
    return h("nav", { class: "inpage-tabs settings-management-tabs", "aria-label": "管理分类" },
      items.map(([id, label, path]) => h("a", { href: sectionHref(path), class: id === section() ? "active" : "", "aria-current": id === section() ? "page" : null }, label)));
  }
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
  function installsRoute() { return state().section === "appversion" && state().extra === "installs"; }
  /** #/settings/runtimeupdates/<kind>：某个 runtime 的详情二级页。 */
  function ruDetailRoute() {
    if (state().section !== "runtimeupdates" || !state().extra) return null;
    const data = state().runtimeUpdates;
    return (data?.runtimes || []).find((r) => r.kind === state().extra) || null;
  }
  /** #/settings/selfheal/<板块>：自愈的板块详情二级页。板块清单没读到之前先按地址里的 id 显示。 */
  function shBoardRoute() {
    if (state().section !== "selfheal" || !state().extra || state().extra === "scheduled") return null;
    const known = (state().shOverview?.boards || []).find((b) => b.id === state().extra);
    return known || { id: state().extra, name: "板块" };
  }
  function installsSection() {
    const page = window.piAndroidShell?.installsPage?.();
    return page ? [page] : [h("section", { class: "card settings-card" }, h("p", { class: "muted small" }, "安装历史只在 Android 客户端里可用。"))];
  }

  let groupScrollLockUntil = 0;
  let groupScrollRaf = 0;
  let scopeSwipeReturnGroup = "";
  let settingsHeadObserver = null;
  function defaultGroup() {
    const item = SECTIONS.find((x) => x.id === menuSection());
    return item?.group || "orb";
  }
  function activeGroup() {
    const s = state();
    if (s.activeGroup && GROUPS.some((g) => g.id === s.activeGroup)) return s.activeGroup;
    return defaultGroup();
  }
  function setActiveGroupDom(groupId) {
    state().activeGroup = groupId;
    document.querySelectorAll(".settings-group-tab[data-settings-group-nav]").forEach((btn) => {
      const on = btn.dataset.settingsGroupNav === groupId;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", String(on));
    });
  }
  function groupScrollHost(target) {
    const nav = target?.closest?.(".settings-app-nav");
    if (nav && !phone.matches) {
      const oy = getComputedStyle(nav).overflowY;
      if ((oy === "auto" || oy === "scroll") && nav.scrollHeight > nav.clientHeight + 1) return nav;
    }
    for (let el = target?.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) return el;
    }
    return window;
  }
  function jumpToGroup(groupId) {
    setActiveGroupDom(groupId);
    groupScrollLockUntil = Date.now() + 650;
    const group = document.querySelector(`.settings-nav-group[data-settings-group="${groupId}"]`);
    const target = phone.matches && groupId === GROUPS[0].id ? group?.closest(".settings-app-nav") : group;
    if (!target) return;
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const behavior = reduced ? "auto" : "smooth";
    const host = groupScrollHost(target);
    if (host === window) {
      const head = document.querySelector(".settings-app-head");
      const bar = phone.matches ? document.querySelector(".settings-group-bar") : null;
      const offset = (head ? head.getBoundingClientRect().bottom : 0) + (bar ? bar.getBoundingClientRect().height : 0);
      const nextTop = window.scrollY + target.getBoundingClientRect().top - offset - 10;
      window.scrollTo({ top: Math.max(0, nextTop), behavior });
    } else {
      const nav = target.closest(".settings-app-nav");
      const sticky = host === nav ? nav?.querySelector(".settings-group-bar") : host.querySelector(".settings-app-head");
      const bar = phone.matches ? document.querySelector(".settings-group-bar") : null;
      const offset = (sticky ? sticky.getBoundingClientRect().height : 0) + (bar ? bar.getBoundingClientRect().height : 0);
      const nextTop = host.scrollTop + (target.getBoundingClientRect().top - host.getBoundingClientRect().top) - offset - 8;
      host.scrollTo({ top: Math.max(0, nextTop), behavior });
    }
  }
  function syncActiveGroupFromScroll() {
    if (ui.view !== "settings" || section() === "application") return;
    if (Date.now() < groupScrollLockUntil) return;
    const tabs = document.querySelector(".settings-group-tabs");
    if (!tabs) return;
    const groups = [...document.querySelectorAll(".settings-nav-group[data-settings-group]")];
    if (!groups.length) return;
    let anchorY = 0;
    let atBottom = false;
    if (!phone.matches) {
      const nav = document.querySelector(".settings-app-nav");
      if (!nav) return;
      const bar = nav.querySelector(".settings-group-bar");
      anchorY = nav.getBoundingClientRect().top + (bar ? bar.getBoundingClientRect().height : 0) + 18;
      atBottom = nav.scrollTop > 0 && nav.scrollHeight > nav.clientHeight + 4 && nav.scrollTop + nav.clientHeight >= nav.scrollHeight - 4;
    } else {
      const head = document.querySelector(".settings-app-head");
      const bar = document.querySelector(".settings-group-bar");
      anchorY = (head ? head.getBoundingClientRect().bottom : 0) + (bar ? bar.getBoundingClientRect().height : 0) + 18;
      const host = groupScrollHost(groups[0]);
      if (host === window) {
        const scroller = document.scrollingElement || document.documentElement;
        atBottom = window.scrollY > 0 && scroller.scrollHeight > window.innerHeight + 4 && window.scrollY + window.innerHeight >= scroller.scrollHeight - 4;
      } else {
        atBottom = host.scrollTop > 0 && host.scrollHeight > host.clientHeight + 4 && host.scrollTop + host.clientHeight >= host.scrollHeight - 4;
      }
    }
    let next = groups[0].dataset.settingsGroup;
    if (atBottom) {
      next = groups[groups.length - 1].dataset.settingsGroup;
    } else {
      for (const group of groups) {
        if (group.getBoundingClientRect().top <= anchorY) next = group.dataset.settingsGroup;
      }
    }
    if (next && next !== state().activeGroup) setActiveGroupDom(next);
  }
  document.addEventListener("scroll", (event) => {
    if (ui.view !== "settings") return;
    const t = event.target;
    if (t !== document && t !== document.documentElement && t !== document.body && !t?.matches?.(".settings-app-nav, .main")) return;
    if (groupScrollRaf) return;
    groupScrollRaf = requestAnimationFrame(() => { groupScrollRaf = 0; syncActiveGroupFromScroll(); });
  }, { passive: true, capture: true });

  /** 平台设置目录的二级分类定位条（智能球 / 产物库 / 基础）：点按快速滚到对应分组，滚动时自动联动高亮。 */
  function groupTabs() {
    const current = activeGroup();
    return h("div", { class: "settings-group-bar", "data-settings-group-bar": "" },
      h("div", { class: "inpage-tabs settings-group-tabs", role: "group", "aria-label": "设置分组定位" },
        ...GROUPS.map((group) => h("button", {
          type: "button",
          class: `settings-group-tab${group.id === current ? " active" : ""}`,
          "aria-pressed": String(group.id === current),
          "data-settings-group-nav": group.id,
          onclick: () => jumpToGroup(group.id),
        }, group.label))));
  }

  function settingsHeader() {
    const scope = section() === "application" ? "apps" : "platform";
    const appId = scope === "apps" ? state().extra : "";
    const app = appId ? (state().appsView?.apps || []).find((item) => item.id === appId) : null;
    const root = rootSection();
    const detail = phone.matches && !root;
    const item = SECTIONS.find((item) => item.id === menuSection());
    const sub = SUBS[section()];
    const subRoute = installsRoute();
    const ru = ruDetailRoute();
    const sh = shBoardRoute();
    // 二级页（安装历史、runtime 详情、自愈板块、调用记录、应用设置）的返回回到直接父页，其余回到目录。
    const backTarget = subRoute ? "#/settings/upgrades/app" : ru ? "#/settings/upgrades" : sh ? "#/settings/selfheal" : sub ? `#/settings/${sub.parent}` : detail ? (scope === "apps" ? "#/settings/application" : "#/settings") : backHref();
    const backLabel = subRoute ? "返回迭代升级" : ru ? "返回迭代升级" : sh ? "返回自愈" : sub ? `返回${SECTIONS.find((x) => x.id === sub.parent)?.label || "上一页"}` : scope === "apps" ? "返回应用设置" : "返回设置";
    const title = subRoute ? "安装历史" : ru ? ru.label.replace(/（.*?）/g, "") : sh ? sh.name : appId ? (app?.name || "应用设置") : (phone.matches && !root) ? (sub?.label || item?.label || "系统设置") : "系统设置";
    return h("header", { class: "settings-app-head page-navigation-head" },
      h("div", { class: "settings-head-row" },
        // 返回只留一个图标（不再带「返回」文字），标题紧跟其后左对齐。
        (!root || phone.matches) ? h("a", { class: "settings-back", href: backTarget, "aria-label": root ? "返回上一页" : backLabel, title: "返回" }, backIcon()) : null,
        h("div", { class: "settings-app-title" }, h("h1", {}, title))),
      // 手机进入具体设置页后，顶部只留返回图标和标题；范围标签属于设置首页，不在详情页重复出现。
      detail ? null : scopeTabs());
  }

  /** 返回图标：SVG 要从 SVG 命名空间建，createElement 建出来的不算图形。 */
  function backIcon() {
    const box = document.createElement("span");
    box.className = "settings-back-icon";
    box.setAttribute("aria-hidden", "true");
    box.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
    return box;
  }

  /** 统一的读取占位：先按最终尺寸铺行，数据到了原地替换（PB-004）。 */
  function skeletonRows(count = 3, label = "正在读取…") {
    return h("div", { class: "settings-skeleton", role: "status", "aria-label": label },
      ...Array.from({ length: count }, () => h("div", { class: "settings-skeleton-row" },
        h("span", { class: "settings-skeleton-stack" },
          h("i", { class: "settings-skeleton-line main" }),
          h("i", { class: "settings-skeleton-line sub" })))));
  }

  /** 目录条目的图标：设计稿 A「分组列表」的左侧小图标（32×32 淡色方块里 18×18 图形）。 */
  function navIcon(id) {
    const box = document.createElement("span");
    box.className = "settings-nav-icon";
    box.setAttribute("aria-hidden", "true");
    box.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${NAV_ICONS[id] || NAV_ICONS.reply}</svg>`;
    return box;
  }

  /** 详情页的一条设置：左边标题 + 一句话，右边控件（设计稿 A「详情页一条设置一行」）。 */
  function settingsRow(title, desc, control, extra = {}) {
    return h("div", { class: `settings-row${extra.cls ? ` ${extra.cls}` : ""}`, ...(extra.attrs || {}) },
      h("span", { class: "settings-row-text" },
        h("b", {}, title, extra.tag ? h("span", { class: "settings-tag" }, extra.tag) : null),
        desc ? h("p", {}, desc) : null),
      control || null);
  }
  /** 一组设置行：一张卡片，行间细线。 */
  function settingsRows(rows, extra = {}) {
    return h("section", { class: "card settings-rows", ...(extra.attrs || {}) }, ...rows.filter(Boolean));
  }

  function settingsNav() {
    const current = section() === "home" && !phone.matches ? "navigation" : menuSection();
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
      class: `settings-nav-item${item.id === current ? " on" : ""}${(item.id === "capabilities" && pendingCapabilities().length) || (item.id === "upgrades" && runtimeUpdatesAlerts().length) ? " has-alert" : ""}`,
      href: item.href || sectionHref(item.id),
      "data-settings-nav": item.id,
      ...(item.id === current ? { "aria-current": "page" } : {}),
    },
      navIcon(item.id),
      h("span", { class: "settings-nav-text" },
        h("span", { class: "settings-nav-head" },
          h("span", { class: "settings-nav-label" }, item.label),
          item.id === "capabilities" ? h("span", { class: "settings-alert-dot", title: "有能力尚未开启", "aria-label": "有能力尚未开启" }) : null,
          item.id === "runtimeupdates" ? h("span", { class: "settings-alert-dot", title: "有 runtime 出了新稳定版", "aria-label": "有 runtime 出了新稳定版" }) : null,
          item.id === "appversion" ? window.piNativeUpdate?.badge?.() ?? null : null),
        h("span", { class: "settings-nav-hint" }, hintOf(item))),
      h("span", { class: "settings-nav-arrow", "aria-hidden": "true" }, "›"));
    const isApps = section() === "application";
    const body = isApps
      ? h("div", { class: "settings-nav-group settings-app-settings-list", "data-settings-apps": "" },
        h("span", { class: "settings-nav-group-label" }, "各应用的设置"),
        h("div", { class: "settings-nav-card" }, appSettingsLinks()))
      : groups.map((group) => h("div", { class: "settings-nav-group", "data-settings-group": group.id },
        // 单项组的条目标题就是组名：不再多出一行同名的组标题。
        group.items.length > 1 ? h("span", { class: "settings-nav-group-label" }, group.label) : null,
        h("div", { class: "settings-nav-card" }, group.items.map(link))));
    return h("nav", { class: "settings-app-nav", "aria-label": "设置导航", "data-keep-scroll": "settings-nav" }, !isApps && (!phone.matches || rootSection()) ? groupTabs() : null, body);
  }
  /** 「平台设置 / 应用设置」两栏：页内标签，扁平背景，只有选中项带液态玻璃（seg-indicator 统一管）。 */
  function scopeTabs() {
    const scope = section() === "application" ? "apps" : "platform";
    return h("div", { class: "inpage-tabs settings-scope-tabs", role: "tablist", "aria-label": "设置范围" },
      ...SCOPES.map((item) => h("a", {
        class: `settings-scope-tab${item.id === scope ? " active" : ""}`,
        href: item.href,
        role: "tab",
        "aria-selected": String(item.id === scope),
        "data-settings-scope": item.id,
      }, item.label)));
  }

  /** 能力行里的附属动作：独立一行，按钮靠右。 */
  function settingsActionRow(node, extra = {}) {
    return h("div", { class: "settings-row settings-row-action", ...(extra.attrs || {}) }, node);
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
    const message = clipboardMessage || (!supported ? '当前设备或浏览器不支持，可直接粘贴或选择图片' : '');
    const linkHint = window.piAndroidShell?.available && supported && clipboard.linksSupported?.() === false
      ? '当前 App 仅支持图片识别，链接识别需要升级至支持此功能的新版 App。' : '';
    return h('div', { class: 'settings-capability-rows', 'data-clipboard-settings': '' },
      settingsRow(label, '仅保存在本设备：回到 pi-agent 或剪贴板变化时检测图片与链接，可记录待办或发起会话。', button),
      message || linkHint ? h('p', { class: 'settings-note', role: 'status', hidden: supported && !message }, [message, linkHint].filter(Boolean).join(' ')) : null);
  }
  function refreshClipboard() {
    const current = document.querySelector('[data-clipboard-settings]');
    if (!current) return;
    const focused = current.contains(document.activeElement);
    current.replaceWith(clipboardSection());
    if (focused) document.querySelector('[data-clipboard-settings] [role=switch]:not(:disabled)')?.focus();
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
    const message = photosMessage || (!supported ? '请更新 Android APK 后开启' : !on ? '' : limited ? '照片范围：仅获授权照片，新截图可能需要重新授权' : '照片范围：所有照片');
    return h('div', { class: 'settings-capability-rows', 'data-photo-settings': '' },
      settingsRow('相册新图片', '首次授权读取最新一张；回到 App 时只提示上次检查后新增的那张，点开图片气泡才上传。',
        h('input', { type: 'checkbox', role: 'switch', class: 'settings-switch', 'aria-label': '相册新图片', checked: on, disabled: photosBusy || !supported, onchange: () => { if (photos.enabled()) { photos.disable(); refreshPhotos(); } else void allow(); } })),
      limited && on ? settingsActionRow(h('button', { type: 'button', class: 'btn', disabled: photosBusy, onclick: () => void allow() }, '重新选择照片')) : null,
      h('p', { class: 'settings-note', role: 'status', hidden: supported && !on && !photosMessage }, message));
  }
  function refreshPhotos() {
    const current = document.querySelector('[data-photo-settings]');
    if (!current) return;
    const focused = current.contains(document.activeElement), next = photosSection();
    if (!next) return;
    current.replaceWith(next);
    if (focused) document.querySelector('[data-photo-settings] [role=switch]:not(:disabled)')?.focus();
  }
  window.addEventListener('pi-capabilities-change', refreshPhotos);
  function orientationStatusIsRoutine(status) { return /^(已保持竖屏|已跟随系统方向|本次游戏已切换横屏)$/.test(status || ''); }
  function orientationSection() {
    const controller = window.piOrientation;
    return h('div', { class: 'settings-capability-rows', 'data-orientation-settings': '' },
      settingsRow('保持竖屏', '仅保存在本设备；游戏切横屏前会确认，退出游戏后恢复。部分浏览器需要全屏才能锁定。',
        h('input', { type: 'checkbox', role: 'switch', class: 'settings-switch', 'aria-label': '保持竖屏', checked: controller?.enabled() !== false, disabled: !controller,
          onchange: event => controller.setEnabled(event.currentTarget.checked) })),
      h('p', { class: 'settings-note', role: 'status', hidden: orientationStatusIsRoutine(controller?.status()) }, controller?.status() || '方向设置正在加载，请刷新后重试。'),
      settingsActionRow(h('button', { type: 'button', class: 'btn primary', 'data-orientation-activate': '', hidden: !controller?.canActivate(), disabled: !!controller?.activating(),
        onclick: () => { void controller.requestPortrait(); } }, '进入全屏')));
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
  function turnSummaryEnabled() {
    if (typeof window.piTurnSummaryMode?.enabled === 'function') return !!window.piTurnSummaryMode.enabled();
    try { return localStorage.getItem('pi-agent:turn-summary-mode:v1') === '1'; } catch { return false; }
  }
  function setTurnSummaryEnabled(on) {
    if (typeof window.piTurnSummaryMode?.setEnabled === 'function') return window.piTurnSummaryMode.setEnabled(!!on);
    try {
      if (on) localStorage.setItem('pi-agent:turn-summary-mode:v1', '1');
      else localStorage.removeItem('pi-agent:turn-summary-mode:v1');
    } catch { /* 忽略 */ }
    window.dispatchEvent(new CustomEvent('pi-turn-summary-mode-change', { detail: { enabled: !!on } }));
    return !!on;
  }
  window.addEventListener('pi-turn-summary-mode-change', () => {
    const checkbox = document.querySelector('[data-turn-summary-settings] input[role="switch"]');
    if (checkbox) checkbox.checked = turnSummaryEnabled();
  });
  // PC 会话列表「用量栏置顶」：只是本设备的显示偏好；列表模块（runtime-directory.js）按路由懒加载，这里先直接读写同一个本机键
  function usageTopEnabled() {
    if (typeof window.piUsageTopbar?.enabled === 'function') return !!window.piUsageTopbar.enabled();
    try { return localStorage.getItem('pi-agent:usage-topbar:v1') === '1'; } catch { return false; }
  }
  function setUsageTopEnabled(on) {
    if (typeof window.piUsageTopbar?.setEnabled === 'function') return window.piUsageTopbar.setEnabled(!!on);
    try {
      if (on) localStorage.setItem('pi-agent:usage-topbar:v1', '1');
      else localStorage.removeItem('pi-agent:usage-topbar:v1');
    } catch { /* 忽略 */ }
    window.dispatchEvent(new CustomEvent('pi-usage-topbar-change', { detail: { enabled: !!on } }));
    return !!on;
  }
  window.addEventListener('pi-usage-topbar-change', () => {
    const checkbox = document.querySelector('[data-usage-top-settings] input[role="switch"]');
    if (checkbox) checkbox.checked = usageTopEnabled();
  });
  // 通知及授权：本设备通知、通知场景、剪贴板/相册/方向能力，加上外部连接（含调用记录二级页入口）与登录会话。
  // 通知及授权（设计稿 A）：本设备一卡（通知 + 剪贴板 + 相册 + 方向），通知场景一卡，登录单独一卡。
  function capabilitiesSection() {
    const notificationPanel = window.sessionNotifications?.panel?.();
    return [
      h("div", { class: "settings-group-label" }, "本设备"),
      h("section", { class: "card settings-rows", "data-device-settings": "" },
        notificationPanel || h("p", { class: "settings-note" }, "通知设置正在加载，请稍后重试。"),
        clipboardSection(),
        photosSection(),
        orientationSection()),
      h("p", { class: "settings-note" }, "以上只对当前浏览器或 App 生效，各设备分别设置。"),
      noticeServiceSection(),
      h("div", { class: "settings-group-label" }, "登录"),
      loginSection(),
    ].flat().filter(Boolean);
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
      loading ? skeletonRows(3, `正在加载${label}…`) : h("p", { class: "muted small", role: "status" }, `${label}还没有加载。刷新页面后再试。`));
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
    if (!a) return h("section", { class: "card settings-card", "data-login-settings": "" }, head, error || skeletonRows(3, "正在读取登录会话…"));
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
    return h("section", { class: "card settings-rows settings-cache" },
      panel || h("p", { class: "settings-note" }, "缓存设置还没有加载。刷新页面后再试。"));
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
      ? [s.errorStatsError ? h("div", { class: "settings-run-empty", role: "status" }, s.errorStatsError) : skeletonRows(3)]
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

  /* ------------------------------ 自愈 ------------------------------ */
  /*
   * 两级（docs/requirements/self-heal）：
   * - 一级 #/settings/selfheal：每个基础板块一行，回答「最近一次检查怎么样、有没有等我审核的」；
   * - 二级 #/settings/selfheal/<板块>：检查策略、屏蔽规则、归到这个板块的夜间任务、检查历史。
   *   检查历史先看分析结论和结果状态；点「分析过程」才展开过程；点结果状态看执行历史与任务。
   */
  const SH_RESULT = {
    fixed: ["已修复", "ok"], "no-fix": ["不修复", ""], "awaiting-human": ["待人类审核", "warn"], fixing: ["修复中", ""], evaluating: ["评估中", ""], failed: ["处理失败", "bad"],
  };
  const SH_MODELS = [
    { id: "", label: "默认（DeepSeek V4.1 Flash）", efforts: ["off", "low", "high", "max"] },
    { id: "deepseek/deepseek-flash", label: "DeepSeek V4.1 Flash", efforts: ["off", "low", "high", "max"] },
    { id: "zhipu/glm-5.3-flash", label: "GLM-5.3 Flash", efforts: ["minimal", "low", "medium", "high"] },
  ];
  const SH_EFFORT = { off: "关闭", minimal: "最小", low: "低", medium: "中", high: "高", max: "最高" };
  const SH_TASK = { session: "修复会话", note: "待办", commit: "提交", notice: "记录", evaluation: "评估" };

  function selfHealHint() {
    const data = state().shOverview;
    if (!data) return "夜间检查、修复与历史";
    if (data.running) return "夜检进行中…";
    const open = (data.boards || []).reduce((n, b) => n + (b.open || 0), 0);
    const last = data.lastRunAt ? `上次 ${beijing(data.lastRunAt)}` : "还没有检查记录";
    return open ? `${last} · ${open} 条待处理` : last;
  }
  async function loadSelfHeal() {
    const s = state();
    try { s.shOverview = await api("/api/self-heal"); s.shError = ""; }
    catch (error) { s.shError = error?.message || "读取自愈状态失败"; }
    clearTimeout(s.shPoll); s.shPoll = 0;
    // 夜检在跑：隔几秒再读一次，结果出来自动更新
    if (s.shOverview?.running && ui.view === "settings") s.shPoll = setTimeout(() => { if (ui.view === "settings" && section() === "selfheal") { void loadSelfHeal(); if (s.extra) void loadSelfHealBoard(s.extra); } }, 3000);
    if (ui.view === "settings" && section() === "selfheal") renderMain();
  }
  async function loadSelfHealBoard(id) {
    const s = state();
    try { s.shBoards = { ...(s.shBoards || {}), [id]: await api(`/api/self-heal/boards/${encodeURIComponent(id)}`) }; s.shBoardError = ""; }
    catch (error) { s.shBoardError = error?.message || "读取板块失败"; }
    if (ui.view === "settings" && section() === "selfheal") renderMain();
  }
  /** 改动后重读总览和当前板块（结果状态、待处理数都会变）。 */
  async function refreshSelfHeal() {
    const s = state();
    await Promise.all([loadSelfHeal(), s.extra ? loadSelfHealBoard(s.extra) : null]);
  }
  async function runSelfHeal() {
    const s = state();
    if (s.shStarting || s.shOverview?.running) return;
    s.shStarting = true; s.shMessage = ""; renderMain();
    try { await api("/api/self-heal/run", { method: "POST", body: "{}" }); }
    catch (error) { s.shMessage = error?.message || "没能开始夜检，请重试"; }
    s.shStarting = false;
    await refreshSelfHeal();
  }
  async function shAct(key, request, done) {
    const s = state();
    if (s.shBusy) return;
    s.shBusy = key; s.shMessage = ""; renderMain();
    try { await request(); if (done) announce(done); }
    catch (error) { s.shMessage = error?.message || "操作失败，请重试"; }
    s.shBusy = "";
    await refreshSelfHeal();
  }
  const shToggle = (key) => { const s = state(); s.shOpen = { ...(s.shOpen || {}), [key]: !s.shOpen?.[key] }; renderMain(); };
  const shPill = (text, tone) => h("span", { class: `ru2-pill${tone ? ` ${tone}` : ""}` }, text);

  /** RRULE → 一句人话（只覆盖平台任务用到的几种）。 */
  function shScheduleText(rule) {
    const text = String(rule || "");
    const part = (name) => (text.match(new RegExp(`${name}=([^;]+)`)) || [])[1];
    const freq = part("FREQ"), interval = Number(part("INTERVAL") || 1);
    const hh = part("BYHOUR"), mm = part("BYMINUTE");
    const clock = hh !== undefined ? `${String(hh).padStart(2, "0")}:${String(mm ?? 0).padStart(2, "0")}` : "";
    if (freq === "DAILY") return `每天 ${clock || ""}`.trim();
    if (freq === "WEEKLY") return `每周${{ MO: "一", TU: "二", WE: "三", TH: "四", FR: "五", SA: "六", SU: "日" }[part("BYDAY")] || ""} ${clock}`.trim();
    if (freq === "HOURLY") return interval > 1 ? `每 ${interval} 小时` : "每小时";
    if (freq === "MINUTELY") return `每 ${interval} 分钟`;
    if (freq === "SECONDLY") return `每 ${interval} 秒`;
    return text.replace(/^RRULE:/, "");
  }

  /** 一级：板块列表。 */
  function shBoardRow(b) {
    const last = b.lastCheck;
    const sub = !b.collector ? (b.id === "other" ? `${b.taskCount || 0} 个夜间任务 · 只展示运行状态` : "采集待接入")
      : last ? `上次检查 ${beijing(last.startedAt)} · ${last.scanned ?? 0} 条报错 · ${(last.findingIds || []).length} 条结论` : "还没有检查记录";
    const pill = !b.collector ? shPill(b.id === "other" ? "不自动修复" : "待接入", "")
      : b.open ? shPill(`${b.open} 待处理`, "warn") : last?.status === "failed" ? shPill("检查失败", "bad") : last ? shPill("无待处理", "ok") : shPill("未检查", "");
    return h("a", { class: "ru-row", href: `#/settings/selfheal/${b.id}`, "data-sh-board": b.id },
      h("span", { class: "ru-row-main" }, h("b", {}, b.name), h("small", {}, b.description), h("small", {}, sub)),
      pill, h("span", { class: "settings-run-chev", "aria-hidden": "true" }, "›"));
  }
  function selfHealHome() {
    const s = state();
    const data = s.shOverview;
    const running = !!data?.running || !!s.shStarting;
    const status = running ? "夜检进行中，跑完会自动更新下面的内容…" : data?.lastRunAt ? `上次夜检 ${beijing(data.lastRunAt)}（北京时间）` : "还没有夜检记录。";
    return [
      h("section", { class: "card settings-card", "data-self-heal-intro": "" },
        h("div", { class: "settings-card-head" }, h("div", {},
          h("h2", {}, "自愈"),
          h("p", { class: "muted small" }, `每天北京时间 ${data?.scheduleHour ?? 3}:${String(data?.scheduleMinute ?? 0).padStart(2, "0")} 汇总自动上传的前端异常现场和上次检查至今的报错，按基础板块分析并处置：无用户感知的小修直接修并自动部署；无感知的大改先让多个模型评估风险收益，合适就修、部署等你确认，不合适交给你；涉及用户可感知的改动只出方案，通知你审核。`))),
        h("div", { class: "settings-run-actions" },
          h("button", { type: "button", class: "btn primary", "data-self-heal-run": "", disabled: running, "aria-busy": String(running), onclick: runSelfHeal }, running ? "夜检中…" : "立即夜检"),
          h("span", { class: "muted small", role: "status" }, status)),
        s.shMessage ? h("p", { class: "settings-run-note small", role: "alert" }, s.shMessage) : null,
        data?.nextRunAt ? h("p", { class: "muted small" }, `下次夜检：北京时间 ${beijing(data.nextRunAt)} · 每晚最多自动开 ${data.maxAutoFixPerRun ?? 3} 个修复会话`) : null),
      !data
        ? (s.shError ? h("div", { class: "settings-run-empty", role: "status" }, s.shError) : skeletonRows(5, "正在读取自愈板块…"))
        : h("div", { class: "ru-rows", "data-self-heal-boards": "" }, data.boards.map(shBoardRow)),
    ];
  }

  /** 二级：板块详情。 */
  function shStrategyCard(b, d) {
    const s = state();
    const model = d.settings?.model || "", effort = d.settings?.effort || "";
    const current = SH_MODELS.find((m) => m.id === model) || SH_MODELS[0];
    const save = (patch) => shAct("settings", () => api(`/api/self-heal/boards/${encodeURIComponent(b.id)}/settings`, { method: "PUT", body: JSON.stringify({ model, effort, ...patch }) }), "已保存");
    const rows = [
      ["覆盖范围", b.collector ? "程序化采集上次检查至今该板块的全部报错；跑一段时间后，可以屏蔽无关紧要的报错类型或规则。" : "这个板块的报错采集还没有接入（二期补埋点），暂时没有检查记录。"],
      ["执行频率", `每天北京时间 ${s.shOverview?.scheduleHour ?? 3}:${String(s.shOverview?.scheduleMinute ?? 0).padStart(2, "0")}`],
      ["自检策略", "无感知小修：直接安排修复，通过门禁后自动部署，完成后发服务通知。无感知大改：多个模型分别评估风险收益，合适就做并通知，不合适交给你。有感知改动：只出方案，通知你审核。"],
    ];
    return h("section", { class: "card settings-card", "data-sh-strategy": b.id },
      h("div", { class: "settings-card-head" }, h("div", {}, h("h2", {}, "检查策略"), h("p", { class: "muted small" }, b.description))),
      h("dl", { class: "sh-facts" }, rows.map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
      b.autoFix ? h("div", { class: "sh-fields" },
        h("label", { class: "sh-field" }, h("span", {}, "分析模型"),
          h("select", { "aria-label": "分析模型", "data-sh-model": "", disabled: !!s.shBusy,
            onchange: (ev) => { const next = SH_MODELS.find((m) => m.id === ev.target.value) || SH_MODELS[0]; void save({ model: ev.target.value, effort: next.efforts.includes(effort) ? effort : "" }); } },
            SH_MODELS.map((m) => h("option", { value: m.id, selected: m.id === model }, m.label)))),
        h("label", { class: "sh-field" }, h("span", {}, "推理强度"),
          h("select", { "aria-label": "推理强度", "data-sh-effort": "", disabled: !!s.shBusy, onchange: (ev) => void save({ effort: ev.target.value }) },
            h("option", { value: "", selected: !effort }, "默认（高）"),
            current.efforts.map((e) => h("option", { value: e, selected: e === effort }, SH_EFFORT[e] || e))))) : h("p", { class: "muted small" }, "这个板块不参与自动修复，没有模型策略。"));
  }
  function shIgnoreCard(b, d) {
    const s = state();
    const rules = d.ignore || [];
    const input = h("input", { type: "text", class: "sh-ignore-input", "data-sh-ignore-input": "", placeholder: "要屏蔽的报错关键词（至少 3 个字）", maxlength: "200", "aria-label": "屏蔽关键词",
      onkeydown: (ev) => { if (ev.key === "Enter") { ev.preventDefault(); add(); } } });
    const add = () => {
      const match = input.value.trim();
      if (match.length < 3) { s.shMessage = "屏蔽关键词至少 3 个字"; renderMain(); return; }
      void shAct("ignore", () => api(`/api/self-heal/boards/${encodeURIComponent(b.id)}/ignore`, { method: "POST", body: JSON.stringify({ match }) }), "已屏蔽，之后的检查不再理会这类报错");
    };
    return h("section", { class: "card settings-card", "data-sh-ignore": b.id },
      h("div", { class: "settings-card-head" }, h("div", {}, h("h2", {}, "屏蔽规则"), h("p", { class: "muted small" }, "命中关键词的报错（按指纹或标题匹配）不再形成结论，只在检查里计数。随时可以恢复。"))),
      rules.length ? h("ul", { class: "sh-rules" }, rules.map((r) => h("li", { "data-sh-rule": r.id },
        h("span", { class: "sh-rule-text" }, h("code", {}, r.match), r.reason ? h("small", { class: "muted" }, ` ${r.reason}`) : null),
        h("button", { type: "button", class: "btn small", disabled: !!s.shBusy, onclick: () => void shAct("ignore", () => api(`/api/self-heal/ignore/${encodeURIComponent(r.id)}`, { method: "DELETE" }), "已恢复这类报错的检查") }, "恢复")))) : h("p", { class: "muted small" }, "还没有屏蔽任何报错。"),
      h("div", { class: "sh-ignore-add" }, input, h("button", { type: "button", class: "btn small", disabled: !!s.shBusy, onclick: add }, "屏蔽")));
  }
  function shTasksCard(d) {
    const tasks = d.tasks || [];
    return h("section", { class: "card settings-card", "data-sh-tasks": "" },
      h("div", { class: "settings-card-head" }, h("div", {}, h("h2", {}, "夜间任务"), h("p", { class: "muted small" }, "归到这个板块的定时任务，和 Agent 日历是同一份清单。"))),
      tasks.length ? h("ul", { class: "sh-tasks" }, tasks.map((t) => h("li", {},
        h("span", { class: "sh-task-main" }, h("b", {}, t.name), h("small", { class: "muted" }, t.description)),
        h("span", { class: "sh-task-when" }, shScheduleText(t.schedule), t.status === "unknown" ? h("small", { class: "muted" }, "未确认") : null)))) : h("p", { class: "muted small" }, "没有夜间任务归到这个板块。"));
  }
  function shFinding(f, boardId) {
    const s = state();
    const [label, tone] = SH_RESULT[f.result] || [f.result, ""];
    const resultOpen = !!s.shOpen?.[`r:${f.id}`], analysisOpen = !!s.shOpen?.[`a:${f.id}`];
    const pending = f.result === "awaiting-human" || f.result === "failed";
    const busy = (k) => s.shBusy === `${k}:${f.id}`;
    return h("li", { class: `sh-finding${resultOpen ? " open" : ""}`, "data-sh-finding": f.id, "data-sh-result": f.result },
      h("div", { class: "sh-finding-head" },
        h("span", { class: "sh-finding-title" }, f.title),
        h("button", { type: "button", class: `ru2-pill sh-result-btn${tone ? ` ${tone}` : ""}`, "data-sh-result-btn": "", "aria-expanded": String(resultOpen), onclick: () => shToggle(`r:${f.id}`) }, label, h("span", { class: "sh-chev", "aria-hidden": "true" }, "›"))),
      h("p", { class: "sh-conclusion" }, f.resultReason || f.conclusion),
      h("button", { type: "button", class: "sh-link", "data-sh-analysis-btn": "", "aria-expanded": String(analysisOpen), onclick: () => shToggle(`a:${f.id}`) }, analysisOpen ? "收起分析过程" : "分析过程"),
      analysisOpen ? h("ol", { class: "sh-analysis", "data-sh-analysis": "" }, (f.analysis || []).map((line) => h("li", {}, line))) : null,
      resultOpen ? h("div", { class: "sh-result-detail", "data-sh-result-detail": "" },
        h("h4", {}, "执行历史"),
        h("ul", { class: "sh-history" }, (f.history || []).length ? f.history.map((x) => h("li", {}, h("time", {}, beijing(x.at)), " ", (SH_RESULT[x.result] || [x.result])[0], " — ", x.reason)) : [h("li", { class: "muted" }, "还没有执行记录")]),
        h("h4", {}, "关联任务"),
        h("ul", { class: "sh-task-links" }, (f.tasks || []).length ? f.tasks.map((t) => h("li", {},
          h("span", { class: "sh-task-type" }, SH_TASK[t.type] || t.type), " ",
          t.href ? h("a", { href: t.href }, t.label) : t.label,
          t.status ? h("small", { class: "muted" }, ` · ${t.status === "running" ? "进行中" : t.status === "done" ? "已结束" : t.status === "failed" ? "失败" : t.status}`) : null)) : [h("li", { class: "muted" }, "没有关联任务")])) : null,
      pending ? h("div", { class: "sh-actions" },
        h("button", { type: "button", class: "btn small primary", "data-sh-approve": "", disabled: !!s.shBusy, "aria-busy": String(busy("approve")), onclick: () => void shAct(`approve:${f.id}`, () => api(`/api/self-heal/findings/${encodeURIComponent(f.id)}/decision`, { method: "POST", body: JSON.stringify({ decision: "approve" }) }), "已开始修复，修完等你确认部署") }, busy("approve") ? "启动中…" : "批准修复"),
        h("button", { type: "button", class: "btn small", "data-sh-reject": "", disabled: !!s.shBusy, onclick: () => void shAct(`reject:${f.id}`, () => api(`/api/self-heal/findings/${encodeURIComponent(f.id)}/decision`, { method: "POST", body: JSON.stringify({ decision: "reject" }) }), "已记为不修复") }, "不修复"),
        h("button", { type: "button", class: "btn small", "data-sh-ignore-finding": "", disabled: !!s.shBusy, onclick: () => void shAct(`ignore:${f.id}`, async () => { await api(`/api/self-heal/boards/${encodeURIComponent(boardId)}/ignore`, { method: "POST", body: JSON.stringify({ match: f.key || f.title, reason: "从结论里屏蔽" }) }); await api(`/api/self-heal/findings/${encodeURIComponent(f.id)}/decision`, { method: "POST", body: JSON.stringify({ decision: "reject" }) }); }, "已屏蔽这类报错") }, "以后忽略这类")) : null);
  }
  function shCheckSummaryPill(c) {
    const fs = c.findings || [];
    const n = (r) => fs.filter((f) => f.result === r).length;
    if (c.status === "failed") return shPill("检查失败", "bad");
    if (n("awaiting-human") + n("failed")) return shPill(`待处理 ${n("awaiting-human") + n("failed")}`, "warn");
    if (n("fixing") + n("evaluating")) return shPill("处理中", "");
    return shPill(fs.length ? "已处理" : "无异常", "ok");
  }
  function shCheck(c, boardId) {
    const s = state();
    const open = !!s.shOpen?.[`c:${c.id}`];
    const findings = c.findings || [];
    return h("div", { class: `settings-run-item${open ? " open" : ""}`, "data-sh-check": c.id },
      h("button", { type: "button", class: "settings-run-row", "aria-expanded": String(open), onclick: () => shToggle(`c:${c.id}`) },
        shCheckSummaryPill(c),
        h("span", { class: "settings-run-main" }, h("span", { class: "settings-run-title" }, `${RUN_TRIGGER[c.trigger] || "夜检"} · ${findings.length} 条结论`), h("span", { class: "settings-run-meta" }, `${beijing(c.startedAt)} · 覆盖 ${c.scanned ?? 0} 条报错${c.ignored ? ` · 屏蔽 ${c.ignored} 条` : ""}${c.costUsd ? ` · $${c.costUsd.toFixed(3)}` : ""}`)),
        h("span", { class: "settings-run-chev", "aria-hidden": "true" }, "›")),
      open ? h("div", { class: "settings-run-detail" },
        h("p", { class: "settings-run-line" }, c.summary),
        findings.length ? h("ul", { class: "sh-findings" }, findings.map((f) => shFinding(f, boardId))) : null) : null);
  }
  function shHistoryCard(d) {
    const checks = d.checks || [];
    return h("section", { class: "card settings-card", "data-sh-history": "" },
      h("div", { class: "settings-card-head" }, h("div", {}, h("h2", {}, "检查历史"), h("p", { class: "muted small" }, "时间均为北京时间。点一次检查看分析结论；每条结论右侧是最终执行结果，点它看执行历史和任务，点「分析过程」看推理依据。"))),
      h("div", { class: "settings-run-list" }, checks.length ? checks.map((c) => shCheck(c, d.board.id)) : [h("div", { class: "settings-run-empty" }, d.board.collector ? "还没有检查记录，等今晚夜检或点上一页的「立即夜检」。" : "这个板块的采集还没有接入，暂时没有检查记录。")]));
  }
  function selfHealBoard(id) {
    const s = state();
    const d = s.shBoards?.[id];
    if (!d) return [s.shBoardError ? h("div", { class: "settings-run-empty", role: "status" }, s.shBoardError) : skeletonRows(4, "正在读取板块…")];
    return [
      s.shMessage ? h("p", { class: "settings-run-note small", role: "alert" }, s.shMessage) : null,
      shStrategyCard(d.board, d), shIgnoreCard(d.board, d), shTasksCard(d), shHistoryCard(d),
    ];
  }
  function selfHealSection() {
    const s = state();
    // 进入或回到这一页时读一次（隔 15 秒内不重复读）
    if (Date.now() - (s.shLoadedAt || 0) > 15_000) {
      s.shLoadedAt = Date.now(); s.shMessage = "";
      void loadSelfHeal();
      if (s.extra) void loadSelfHealBoard(s.extra);
    } else if (s.extra && !s.shBoards?.[s.extra] && !s.shBoardLoading) {
      s.shBoardLoading = true; void loadSelfHealBoard(s.extra).finally(() => { s.shBoardLoading = false; });
    }
    return [h("div", { class: "settings-selfheal" }, shBoardRoute() ? selfHealBoard(s.extra) : selfHealHome())];
  }

  /* ------------------------------ 运行时更新 ------------------------------ */
  /*
   * 页面分两级（docs/requirements/runtime-version-updates）：
   * - 一级 #/settings/runtimeupdates：每个组件一行，只回答「有没有新版、推不推荐升」；
   * - 二级 #/settings/runtimeupdates/<kind>：结论 + 点开才看收益 / 风险，再往下才是步骤与版本记录。
   * 检测沿用服务端：每天 09:00 + 手动；检测到更新后服务端自动分析，页面只轮询进度（分析要几十秒，接口不再同步等）。
   */
  const RU_VERDICT = { upgrade: ["建议升级", "ok"], wait: ["建议观望", "warn"], skip: ["暂不升级", "bad"] };
  const RU_LEVEL = { high: "高", medium: "中", low: "低" };
  const RU_TRIGGER = { manual: "手动", schedule: "定时", "catch-up": "补跑" };
  const RU_AUTO_ENTRY = { scheduled: "已安排", started: "已开始", done: "已完成", failed: "失败", cancelled: "已取消" };
  const ruDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v).slice(5) : v ? beijing(v) : "");
  const ruWorking = (data) => !!data?.running || (data?.analyzing || []).length > 0;
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
    // 检测或分析还在跑：接着轮询，跑完自动刷新（等价于以前同步接口的等待，但不会撞上网关超时）
    if (ruWorking(s.runtimeUpdates) && ui.view === "settings" && section() === "runtimeupdates") {
      s.ruPoll = setTimeout(() => { if (ui.view === "settings" && section() === "runtimeupdates") void loadRuntimeUpdates(); }, 2500);
    }
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
  /** 重新分析：接口立即返回，进度靠轮询；失败原因从概览里读（服务端会记下来）。 */
  async function analyzeRuntimeUpdate(kind, force) {
    const s = state();
    s.ruAnalyzing = { ...(s.ruAnalyzing || {}), [kind]: true }; s.ruAnalyzeError = { ...(s.ruAnalyzeError || {}), [kind]: "" }; renderMain();
    try { await api(`/api/runtime-updates/${kind}/analyze`, { method: "POST", body: JSON.stringify({ force: force === true }) }); }
    catch (error) { s.ruAnalyzeError = { ...s.ruAnalyzeError, [kind]: error?.message || "分析没能开始，请重试" }; }
    s.ruAnalyzing = { ...s.ruAnalyzing, [kind]: false };
    await loadRuntimeUpdates();
  }
  async function setAutoUpgrade(enabled) {
    const s = state();
    s.ruAutoBusy = true; renderMain();
    try { await api("/api/runtime-updates/auto-upgrade", { method: "POST", body: JSON.stringify({ enabled }) }); }
    catch (error) { s.ruMessage = error?.message || "操作失败，请重试"; }
    s.ruAutoBusy = false;
    await loadRuntimeUpdates();
    window.dispatchEvent(new Event("pi-runtime-updates-change"));
  }
  async function cancelAutoUpgrade(kind) {
    const s = state();
    s.ruAutoBusy = true; renderMain();
    try { await api(`/api/runtime-updates/${kind}/auto-upgrade`, { method: "POST", body: "{}" }); }
    catch (error) { s.ruMessage = error?.message || "没能取消，请重试"; }
    s.ruAutoBusy = false;
    await loadRuntimeUpdates();
    window.dispatchEvent(new Event("pi-runtime-updates-change"));
  }
  async function ignoreRuntimeUpdate(kind, undo) {
    const s = state();
    try { await api(`/api/runtime-updates/${kind}/ignore`, { method: "POST", body: JSON.stringify({ undo: undo === true }) }); }
    catch (error) { s.ruMessage = error?.message || "操作失败，请重试"; }
    s.ruSummaryAt = 0;
    await loadRuntimeUpdates();
    window.dispatchEvent(new Event("pi-runtime-updates-change"));
  }
  const RU_EXECUTOR = { pi: ["Claude Code", "Pi"], "claude-code": ["Pi", "Claude Code"], antigravity: ["Claude Code", "Antigravity"] };
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
  /** 一个 runtime 在页面上的状态：一级列表和二级页共用同一套结论。 */
  function ruState(r) {
    const a = r.analysis;
    if (r.error && !r.latest) return { pill: ["检测失败", "bad"], dot: "bad" };
    if (!r.installed || !r.latest) return { pill: ["版本未知", ""], dot: "" };
    if (!r.hasUpdate) return { pill: ["已是最新", "ok"], dot: "ok" };
    if (r.ignored) return { pill: ["已忽略", ""], dot: "" };
    if (r.kind === "codex") return { pill: ["随桌面版", ""], dot: "warn" };
    if (a && !a.stale) { const [t, k] = RU_VERDICT[a.value.verdict] || [a.value.verdict, ""]; return { pill: [t, k], dot: k === "ok" ? "ok" : "warn" }; }
    if (r.analyzing) return { pill: ["分析中", ""], dot: "warn" };
    if (a?.stale) return { pill: ["报告过期", "warn"], dot: "warn" };
    return { pill: ["待分析", ""], dot: "warn" };
  }
  /** 卡片式折叠区：展开状态记在 ruOpen 里，重绘不丢。 */
  function ruFold(kind, name, summary, ...body) {
    const s = state(), key = `${name}-${kind}`;
    return h("details", { class: "ru2-card ru2-fold", ...(s.ruOpen?.[key] ? { open: true } : {}), ontoggle: (ev) => { s.ruOpen = { ...(s.ruOpen || {}), [key]: ev.currentTarget.open }; } },
      h("summary", {}, summary), h("div", { class: "ru2-fold-in" }, ...body));
  }
  function ruDots(items, risk) {
    return h("ul", { class: `ru2-list${risk ? " risk" : ""}` }, items.map((x) => h("li", { class: risk && x.severity === "high" ? "high" : "" }, h("div", {}, h("b", {}, x.title), h("span", {}, x.detail)))));
  }
  /** 结论：已装 → 最新 + 一句人话结论（收益 / 风险要再点一下才展开）。 */
  function ruHero(r, st) {
    const a = r.analysis, fresh = a && !a.stale;
    const track = h("div", { class: "ru2-track" },
      h("div", { class: "ru2-node from" }, h("small", {}, "已装版本"), h("code", {}, r.installed || "未知")),
      h("div", { class: "ru2-line" }, r.hasUpdate ? h("em", {}, `落后 ${r.pendingCount} 个版本`) : null),
      h("div", { class: "ru2-node to" }, h("small", {}, "最新稳定版"), h("code", {}, r.latest || "—")));
    let verdict;
    if (fresh) {
      const [vl, vk] = RU_VERDICT[a.value.verdict] || [a.value.verdict, ""];
      verdict = h("div", { class: "ru2-verdict", "data-ru-analysis": r.kind, "data-ru-verdict": a.value.verdict }, h("span", { class: `ru2-pill ${vk}` }, vl), h("p", {}, a.value.reason));
    } else if (r.analyzing) {
      verdict = h("div", { class: "ru2-verdict", "data-ru-analysis": r.kind }, h("span", { class: "ru2-pill" }, "分析中"),
        h("p", { class: "muted" }, a?.stale ? "这一版已经有新报告在生成，等一会儿就好。" : "正在看更新日志，马上就出结论。"));
    } else if (a?.stale) {
      // 报告对不上当前版本：不把旧版本的判断当成现在的，只说差异
      verdict = h("div", { class: "ru2-verdict stale", "data-ru-analysis": r.kind, "data-ru-stale": r.kind }, h("span", { class: "ru2-pill warn" }, "待重新分析"),
        h("p", {}, `这份报告分析的是 ${a.installed} → ${a.latest}，现在是 ${r.installed || "未知"} → ${r.latest || "未知"}，正在重新分析。`));
    } else if (r.hasUpdate) {
      verdict = h("div", { class: "ru2-verdict", "data-ru-analysis": r.kind }, h("span", { class: `ru2-pill ${st.pill[1]}` }, st.pill[0]),
        h("p", { class: "muted" }, r.kind === "codex" ? "已装的是 ChatGPT.app 内置的 alpha，随桌面版自动更新，平台不替你升级。" : "还没出结论：点下面的「重新分析」马上跑一次（检测到更新时也会自动分析）。"));
    } else {
      verdict = h("div", { class: "ru2-verdict", "data-ru-analysis": r.kind }, h("span", { class: `ru2-pill ${st.pill[1]}` }, st.pill[0]),
        h("p", { class: "muted" }, r.installed && r.latest ? (r.kind === "codex" ? "已装版本不低于最新稳定版，不用动。" : "已是最新稳定版，无需处理。") : "还没检测过：回上一页点「立即检测」，就知道有没有新版、要不要升。"));
    }
    return h("div", { class: "ru2-hero" }, track, verdict,
      r.error ? h("p", { class: "small warn-text", role: "alert" }, `最近一次检测失败：${r.error}${r.latest ? "（下面仍是上次检测到的内容）" : ""}`) : null,
      r.analysisError && !r.analyzing ? h("p", { class: "small warn-text", role: "alert" }, `上次分析没成功：${r.analysisError}`) : null);
  }
  /** 收益 / 风险：各自一个折叠行，内容紧跟自己的标题（默认收起，一级只让人看「推不推荐」）。 */
  function ruPeek(r, a) {
    const s = state(), v = a.value;
    // 触发行用和页内其它折叠一样的 details：展开的内容就在自己标题下面，不会隔着别人的行
    const fold = (name, label, count, ...body) => {
      const key = `peek-${name}-${r.kind}`, open = !!s.ruOpen?.[key];
      return h("details", {
        class: "ru2-card ru2-fold", ...(open ? { open: true } : {}),
        ontoggle: (ev) => { s.ruOpen = { ...(s.ruOpen || {}), [key]: ev.currentTarget.open }; }
      },
        h("summary", { [`data-ru-${name}`]: r.kind },
          h("span", { class: "ru2-fold-title" }, label),
          h("span", { class: "ru2-fold-count" }, `${count} 条`)),
        h("div", { class: "ru2-fold-in", [`data-ru-${name}-body`]: r.kind }, ...body));
    };
    return [
      fold("benefit", "升级有什么好处", v.benefits.length,
        v.benefits.length ? ruDots(v.benefits) : h("p", { class: "muted small" }, "这一批更新里没有对平台有用的东西。")),
      fold("risk", "可能出什么问题", v.risks.length,
        v.risks.length ? ruDots(v.risks, true) : h("p", { class: "muted small" }, "没发现会碰到平台的问题。"),
        h("p", { class: "ru2-reassure" }, "升级前会先在临时目录验证，通过才替换；出问题可以退回现在的版本。")),
      v.compat.length || v.testPlan.length ? ruFold(r.kind, "analysis-more", "平台要做哪些适配",
        v.compat.length ? h("ul", { class: "ru-list" }, v.compat.map((c) => h("li", {}, h("strong", {}, c.what), h("span", { class: "muted" }, ` → ${c.action}`)))) : null,
        h("p", { class: "ru2-sub" }, "升级前后的验证步骤"), h("ol", { class: "ru-list" }, v.testPlan.map((t) => h("li", {}, t)))) : null,
      h("p", { class: "foot" }, `分析于北京时间 ${beijing(a.at)} · 分析的是 ${a.installed} → ${a.latest}${a.costUsd ? ` · DeepSeek $${a.costUsd.toFixed(3)}` : ""}${a.trigger === "auto" ? " · 检测后自动分析" : ""}。只依据更新日志和平台依赖清单判断，仅供参考。`)
    ];
  }
  /** 自动夜间升级：已安排就显示时间并可取消；没安排就说清缺哪一条。 */
  function ruAutoBlock(r, data) {
    if (!r.hasUpdate) return null;
    const enabled = !!data?.autoUpgrade?.enabled;
    const threshold = data?.autoUpgrade?.threshold ?? 10;
    const entry = r.autoUpgrade?.entry;
    const supported = (data?.autoUpgrade?.kinds || []).includes(r.kind);
    const status = entry?.status;
    let pill = ["不会自动升级", ""], body;
    if (status === "scheduled") {
      pill = ["已安排", "ok"];
      body = `北京时间 ${beijing(entry.at)} 自动升到 ${entry.to}：到点先看有没有会话在跑，有就等，最晚等到 05:30，还忙就改到明晚。`;
    } else if (status === "started") {
      pill = ["正在自动升级", "ok"];
      body = `北京时间 ${beijing(entry.at)} 已经开始，升级完成后下一次检测会写进升级记录。`;
    } else if (status === "done") {
      pill = ["已自动升过", "ok"];
      body = `这个版本已经自动升过一次（${entry.from} → ${entry.to}）。`;
    } else if (status === "failed") {
      pill = ["自动升级失败", "bad"];
      body = `这次没有升成：${entry.note || "开升级会话失败"}。同一个版本不会再自动重试，需要你手动升。`;
    } else if (status === "cancelled") {
      pill = ["已取消", ""];
      body = "这个版本的自动升级已被取消，需要的话可以手动升。";
    } else if (!supported) {
      body = `${r.kind === "codex" ? "Codex" : "Claude Code"} 不自动升级：${r.kind === "codex" ? "它跟着 ChatGPT.app 一起更新。" : "它的升级要改代码并部署，交给人工决定。"}`;
    } else if (!enabled) {
      body = `自动夜间升级现在是关的。打开后：落后超过 ${threshold} 个版本、结论是「建议升级」、又没有高风险时，平台会在北京时间 03:00–05:30 自动升。`;
    } else {
      body = `还不会自动升：${(r.autoUpgrade?.blocked || []).slice(0, 3).join("；")}。条件：落后超过 ${threshold} 个版本 + 结论是「建议升级」+ 没有高风险项。`;
    }
    const actions = [];
    if (status === "scheduled") actions.push(h("button", { type: "button", class: "btn small", "data-ru-auto-cancel": r.kind, disabled: !!state().ruAutoBusy, onclick: () => cancelAutoUpgrade(r.kind) }, "取消这次自动升级"));
    else if (supported && !enabled && !status) actions.push(h("button", { type: "button", class: "btn small", "data-ru-auto-enable": r.kind, disabled: !!state().ruAutoBusy, onclick: () => setAutoUpgrade(true) }, "打开自动夜间升级"));
    return h("section", { class: "ru2-card ru-auto-status", "data-ru-auto-status": r.kind },
      h("h3", {}, "自动夜间升级", h("span", { class: `ru2-pill ${pill[1]}` }, pill[0])),
      h("p", { class: "small muted" }, body), actions.length ? h("div", { class: "ru-auto-actions" }, ...actions) : null);
  }
  /** 固定在底部的主操作：报告有效时「升级」是主按钮，否则先「分析」。 */
  function ruBar(r) {
    if (!r.hasUpdate) return null;
    const s = state(), a = r.analysis, fresh = a && !a.stale, executor = RU_EXECUTOR[r.kind];
    const busy = r.analyzing || !!s.ruAnalyzing?.[r.kind] || (s.runtimeUpdates?.analyzing || []).includes(r.kind);
    // 一屏只留一个实心主操作，另一个用 ghost：不和折叠行抢「按钮」的样子
    const analyze = (primary) => h("button", { type: "button", class: `btn${primary ? " primary" : " ghost"}`, "data-ru-analyze": r.kind, disabled: busy, "aria-busy": String(busy), onclick: () => analyzeRuntimeUpdate(r.kind, !!a) }, busy ? "分析中…" : a ? "重新分析" : "分析收益与风险");
    const upgrade = executor ? h("button", { type: "button", class: `btn${fresh ? " primary" : " ghost"}`, "data-ru-upgrade": r.kind, disabled: !!s.ruUpgrading?.[r.kind], onclick: () => upgradeRuntime(r.kind) }, s.ruUpgrading?.[r.kind] ? "正在发起…" : fresh ? `升级 ${executor[1]} 到 ${r.latest}` : `升级到 ${r.latest}`) : null;
    const err = s.ruAnalyzeError?.[r.kind] || s.ruUpgradeError?.[r.kind];
    return h("div", { class: "ru2-bar", "data-ru-bar": r.kind },
      err ? h("p", { class: "small warn-text ru2-bar-err", role: "alert" }, err) : null,
      h("div", { class: "ru2-bar-btns" }, fresh && upgrade ? [upgrade, analyze(false)] : [analyze(true), upgrade]));
  }
  /** 一级：一行一个组件，回答「有没有新版、推不推荐升」。 */
  function ruRow(r) {
    const st = ruState(r), entry = r.autoUpgrade?.entry;
    const sub = [];
    if (r.hasUpdate) sub.push(`落后 ${r.pendingCount} 版`);
    else if (r.installed && r.latest) sub.push("已是最新");
    if (r.hasUpdate && r.highlights.breaking.length) sub.push(`${r.highlights.breaking.length} 项破坏性变更`);
    const auto = entry && entry.status === "scheduled" ? `${beijing(entry.at)} 自动升级` : entry && entry.status === "started" ? "自动升级进行中" : null;
    return h("a", { class: "ru-row", href: `#/settings/runtimeupdates/${r.kind}`, "data-ru-row": r.kind },
      h("span", { class: "ru-row-main" },
        h("b", {}, h("i", { class: `ru2-dot ${st.dot}`, "aria-hidden": "true" }), r.label.replace(/（.*?）/g, "")),
        h("span", { class: "ru-row-vers" }, h("code", {}, r.installed || "未知"), " → ", h("code", {}, r.latest || "—")),
        h("small", {}, auto ? `${sub.join(" · ")} · ${auto}` : sub.join(" · "))),
      h("span", { class: `ru2-pill ${st.pill[1]}` }, st.pill[0]),
      h("span", { class: "settings-run-chev", "aria-hidden": "true" }, "›"));
  }
  function ruHead(data) {
    const s = state();
    const running = !!data?.running || !!s.ruStarting;
    const analyzing = !!(data?.analyzing || []).length;
    const status = running ? "检测中，跑完会自动更新下面的内容…"
      : analyzing ? "检测完了，正在自动分析是不是值得升…"
      : data?.lastCheckAt ? `上次检测 ${beijing(data.lastCheckAt)}（北京时间）` : "还没有检测记录，点「立即检测」。";
    return h("div", { class: "ru2-sum" },
      h("div", {}, h("h2", {}, !data ? "运行时版本" : data.alertCount ? `${data.alertCount} 个组件有新稳定版` : "都是最新稳定版"), h("p", { class: "muted small", role: "status" }, status)),
      h("button", { type: "button", class: "btn small", "data-ru-check": "", disabled: running, "aria-busy": String(running), onclick: runRuntimeUpdateCheck }, running ? "检测中…" : "立即检测"));
  }
  function ruAutoCard(data) {
    const enabled = !!data.autoUpgrade?.enabled;
    const threshold = data.autoUpgrade?.threshold ?? 10;
    const scheduled = (data.autoUpgrade?.entries || []).filter((e) => e.status === "scheduled" || e.status === "started");
    return h("section", { class: "ru2-card ru-auto-card", "data-ru-auto": enabled ? "on" : "off" },
      h("h3", {}, "自动夜间升级", h("span", { class: `ru2-pill ${enabled ? "ok" : ""}` }, enabled ? "已开" : "已关")),
      h("p", { class: "small muted" }, `落后超过 ${threshold} 个版本、结论是「建议升级」、又没有高风险时，北京时间 03:00–05:30 没有会话在跑就自动升 Pi 和 Antigravity。Claude Code 要改代码并部署、Codex 跟着桌面版，都不自动升。`),
      scheduled.length ? h("ul", { class: "ru-auto-list" }, scheduled.map((e) => h("li", {}, `${e.label} ${e.from} → ${e.to} · ${e.status === "started" ? "正在升级" : `北京时间 ${beijing(e.at)}`}`))) : null,
      h("button", { type: "button", class: `btn small${enabled ? "" : " primary"}`, "data-ru-auto-toggle": "", disabled: !!state().ruAutoBusy, onclick: () => setAutoUpgrade(!enabled) }, enabled ? "关掉自动夜间升级" : "开启自动夜间升级"));
  }
  function ruHistory(data, logs, checks) {
    const s = state();
    return h("details", { class: "ru2-card ru2-fold", ...(s.ruOpen?.["history"] ? { open: true } : {}), ontoggle: (ev) => { s.ruOpen = { ...(s.ruOpen || {}), history: ev.currentTarget.open }; } },
      h("summary", {}, "升级记录与检测历史"),
      h("div", { class: "ru2-fold-in" },
        h("p", { class: "ru2-sub" }, "升级记录（平台观察到的已装版本变化，升级完成后下一次检测时记下）"),
        logs.length ? h("ul", { class: "ru-list" }, logs.map((e) => h("li", {}, h("strong", {}, (data.runtimes.find((r) => r.kind === e.kind) || {}).label || e.kind), h("span", { class: "muted" }, ` ${e.from ? `${e.from} → ${e.to}` : `首次记录 ${e.to}`} · 北京时间 ${beijing(e.at)}`))))
          : h("p", { class: "muted small" }, "还没有记录。点「运行时配置」里的「检查」后再检测一次，就会记下当前版本。"),
        (data.autoUpgrade?.entries || []).length ? [h("p", { class: "ru2-sub" }, "自动夜间升级"), h("ul", { class: "ru-list" }, data.autoUpgrade.entries.map((e) => h("li", {}, h("span", { class: `settings-run-state ${e.status === "failed" ? "failed" : "ok"}` }, RU_AUTO_ENTRY[e.status] || e.status), h("span", { class: "muted" }, ` ${e.label} ${e.from} → ${e.to} · 北京时间 ${beijing(e.at)}${e.note ? ` · ${e.note}` : ""}`))))] : null,
        checks.length ? [h("p", { class: "ru2-sub" }, "检测历史"), h("ul", { class: "ru-list" }, checks.map((c) => h("li", {}, h("span", { class: `settings-run-state ${c.status}` }, { running: "检测中", ok: "完成", failed: "失败" }[c.status] || c.status),
          h("span", { class: "muted" }, ` ${RU_TRIGGER[c.trigger] || "检测"} · 北京时间 ${beijing(c.startedAt)}${c.found.length ? ` · 新发现 ${c.found.map((f) => `${f.kind} ${f.version}`).join("、")}` : ""}${c.errors.length ? ` · 失败 ${c.errors.map((e) => e.kind).join("、")}` : ""}`))))] : null));
  }
  /** 一级：列表 → 详情。 */
  function runtimeUpdatesList(data) {
    const s = state();
    return h("div", { class: "ru2 ru2-flat" },
      ruHead(data),
      s.ruMessage ? h("p", { class: "settings-run-note small", role: "alert" }, s.ruMessage) : null,
      h("nav", { class: "ru-rows", "aria-label": "运行时组件" }, data.runtimes.map(ruRow)),
      ruAutoCard(data),
      ruHistory(data, data.installLog || [], data.checks || []),
      h("p", { class: "foot" }, `每天北京时间 ${data.scheduleHour ?? 9}:${String(data.scheduleMinute ?? 0).padStart(2, "0")} 自动检测 Pi、Claude Code、Codex、Antigravity 的新稳定版（不含 alpha / beta / rc），检测到就自动分析值不值得升。点组件看收益和风险。${data.nextRunAt ? `下次自动检测：北京时间 ${beijing(data.nextRunAt)}。` : ""}`));
  }
  /** 二级：一个组件的结论、收益、风险、安排与记录。 */
  function runtimeUpdatesDetail(r, data) {
    const s = state(), st = ruState(r), a = r.analysis, fresh = a && !a.stale;
    const executor = RU_EXECUTOR[r.kind];
    const features = r.highlights.features;
    return h("div", { class: "ru2 ru2-detail ru2-flat" },
      s.ruMessage ? h("p", { class: "settings-run-note small", role: "alert" }, s.ruMessage) : null,
      ruHero(r, st),
      fresh ? ruPeek(r, a) : null,
      a?.stale ? ruFold(r.kind, "analysis-old", "查看旧报告（仅供参考）", h("p", { class: "ru2-sub" }, `分析的是 ${a.installed} → ${a.latest}：${(RU_VERDICT[a.value.verdict] || [a.value.verdict])[0]}`), h("p", { class: "muted small" }, a.value.reason), ...ruPeek(r, a)) : null,
      ruAutoBlock(r, data),
      r.hasUpdate && r.highlights.breaking.length ? ruFold(r.kind, "breaking", `需要留意的破坏性变更（${r.highlights.breaking.length} 项）`, ruList(r.highlights.breaking, "ru-breaking")) : null,
      r.hasUpdate && features.length ? ruFold(r.kind, "features", `新增功能（${features.length} 条）`, ruList(features)) : null,
      r.hasUpdate ? ruFold(r.kind, "guide", executor ? `升级步骤（点「升级」后由 ${executor[0]} 会话照此执行）` : "升级方式",
        ruList(r.guide.steps), r.guide.note ? h("p", { class: "muted small" }, r.guide.note) : null,
        r.guide.command ? h("div", { class: "ru-command" }, h("code", {}, r.guide.command), h("button", { type: "button", class: "btn small", onclick: (ev) => ruCopy(r.guide.command, ev.currentTarget) }, "复制命令")) : null) : null,
      ruFold(r.kind, "log", `版本更新记录（${r.pending.length + r.history.length} 版）`,
        r.pending.length || r.history.length
          ? h("div", { class: "ru-releases" }, [...r.pending.map((x) => ruRelease(x, `rel-${r.kind}-${x.version}`)), ...r.history.map((x) => ruRelease(x, `rel-${r.kind}-${x.version}`))])
          : h("p", { class: "muted small" }, "还没有记录，回上一页点「立即检测」。"),
        r.pendingCount > r.pending.length ? h("p", { class: "muted small" }, `只列出最新 ${r.pending.length} 个新版本；更早的 ${r.pendingCount - r.pending.length} 个见`, " ", h("a", { href: r.homepage, target: "_blank", rel: "noopener noreferrer" }, "完整更新日志")) : null,
        r.kind === "codex" ? h("p", { class: "muted small" }, "Codex 的发布列表太大，平台只读最新稳定版和近期的稳定版，更早的版本会从首次检测起逐日积累。") : null),
      r.hasUpdate ? h("p", { class: "ru2-ignore" },
        r.ignored ? [`已忽略 ${r.latest}，有更新的版本才会再提醒。`, h("button", { type: "button", class: "btn-link small", onclick: () => ignoreRuntimeUpdate(r.kind, true) }, "取消忽略")]
          : [h("button", { type: "button", class: "btn-link small", "data-ru-ignore": r.kind, onclick: () => ignoreRuntimeUpdate(r.kind) }, "忽略这个版本"), "忽略后红点熄灭，出了更新的版本才再提醒。"]) : null,
      h("p", { class: "foot" }, `检查时间：${r.checkedAt ? `北京时间 ${beijing(r.checkedAt)}` : "还没检测过"}。检测只认稳定版（不含 alpha / beta / rc）。`),
      ruBar(r));
  }
  function runtimeUpdatesSection() {
    const s = state();
    if (!s.ruLoaded) { s.ruLoaded = true; void loadRuntimeUpdates(); }
    const data = s.runtimeUpdates;
    const kind = s.extra && data ? data.runtimes.find((r) => r.kind === s.extra) : null;
    if (!data) {
      return h("div", { class: "ru2 ru2-flat" }, ruHead(undefined),
        s.ruMessage ? h("p", { class: "settings-run-note small", role: "alert" }, s.ruMessage) : null,
        h("section", { class: "card settings-card" }, s.ruError ? h("div", { class: "settings-run-empty", role: "status" }, s.ruError) : skeletonRows(3)));
    }
    return kind ? runtimeUpdatesDetail(kind, data) : runtimeUpdatesList(data);
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
      ? (s.codexResetError ? h("div", { class: "settings-run-empty", role: "status" }, s.codexResetError) : skeletonRows(3))
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
        !data && !s.deployError ? skeletonRows(3, "正在读取部署历史…") : null,
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

  // APP 标签复用 Android 版本卡，浏览器中显示客户端能力说明。
  function appVersionSection() {
    return [window.piAndroidShell?.versionPanel() ?? h("section", { class: "card settings-card" }, h("p", { class: "muted small" }, "请在 Android 客户端中检查 APP 更新与查看安装历史。"))];
  }

  /* ------------------------------ 设备与远程连接 ------------------------------ */
  function formatMegabytes(bytes) {
    const mb = Number(bytes) / 1048576;
    return mb >= 100 ? `${Math.round(mb)} MB` : mb >= 1 ? `${Number(mb.toFixed(1))} MB` : `${Math.max(0, Math.round(Number(bytes) / 1024))} KB`;
  }
  function usageMeter(label, used, limit, usedText, limitText) {
    const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
    const level = ratio >= 1 ? "bad" : ratio >= 0.8 ? "warn" : "ok";
    return h("div", { class: "settings-usage-row" },
      h("div", { class: "settings-usage-head" },
        h("span", { class: "small settings-usage-label" }, label),
        h("span", { class: "small settings-usage-nums" },
          h("strong", {}, usedText),
          h("span", {}, ` / ${limitText} · ${Math.round(ratio * 100)}%`))),
      h("div", { class: "settings-usage-bar", role: "progressbar", "aria-label": label, "aria-valuemin": "0", "aria-valuemax": String(limit), "aria-valuenow": String(Math.min(used, limit)) },
        h("div", { class: `settings-usage-fill ${level}`, style: `width:${Math.max(ratio > 0 ? 2 : 0, ratio * 100)}%` })));
  }
  /** 公共中继当日用量；自建中继显示无限额；还没查到时不画任何东西。 */
  function relayUsageBlock(usage) {
    if (!usage) return null;
    if (usage.kind === "unlimited") return h("div", { class: "settings-usage", "data-relay-usage": "unlimited" }, h("span", { class: "settings-run-meta" }, "自建中继 · 无限额"));
    return h("div", { class: "settings-usage", "data-relay-usage": "limited" },
      usageMeter("今日流量", usage.dayBytes, usage.dailyRoomBytes, formatMegabytes(usage.dayBytes), formatMegabytes(usage.dailyRoomBytes)),
      usageMeter("今日帧数", usage.dayFrames, usage.dailyRoomFrames, String(usage.dayFrames), String(usage.dailyRoomFrames)),
      h("span", { class: "settings-run-meta settings-usage-reset" }, usage.blocked
        ? `今日额度已用完，将于 ${beijing(new Date(usage.resetAt).toISOString())} 重置；可切换到自有域名或自建中继`
        : `每日免费额度 · ${beijing(new Date(usage.resetAt).toISOString())} 重置`));
  }
  function stopRemotePoll() {
    const s = state();
    if (s.remotePoll) { clearTimeout(s.remotePoll); s.remotePoll = 0; }
  }
  async function loadRemoteStatus(force = false) {
    const s = state();
    if (s.remoteLoading && !force) return;
    s.remoteLoading = true;
    try {
      const data = await api("/api/remote-connect/status");
      s.remote = data;
      s.remoteError = "";
      if (!s.remoteDraftDirty) {
        s.remoteHostName = data.hostName || "";
        s.remoteRelayMode = data.relayMode || "official";
        s.remoteCustomRelay = data.customRelayUrl || "";
      }
    } catch (error) {
      s.remoteError = error?.message || "读取远程连接状态失败";
    }
    // 自有域名方式添加的手机：仅电脑/浏览器登录态可读待批准列表；Android App 壳为设备身份，调用只会 403。
    if (window.piAndroidShell?.available) {
      s.devicePairs = [];
    } else {
      try { s.devicePairs = (await api("/api/auth/device-pairs/pending"))?.pairs || []; } catch { s.devicePairs = []; }
    }
    s.remoteLoading = false;
    stopRemotePoll();
    if (ui.view === "settings" && section() === "remote") {
      // 手机已经发来请求（比如刷新页面时配对进行到一半）：直接弹出新增设备弹窗，在同一个地方核对批准。
      // 只在等批准时弹；单纯还没人扫的二维码不弹，用户要用再点「新增设备」。
      const ap = s.remote?.activePairing;
      if (!link.open && ap?.status === "awaiting_approval" && !link.dismissed.has(ap.pairId)) openLinkModal({ restore: "relay" });
      else if (!link.open && (s.devicePairs || []).some((p) => !link.dismissed.has(p.pairId))) openLinkModal({ restore: "domain" });
      const waiting = s.remote?.activePairing || s.devicePairs.length > 0;
      s.remotePoll = setTimeout(() => { if (ui.view === "settings" && section() === "remote") void loadRemoteStatus(true); }, waiting ? 1500 : 4000);
    }
    if (ui.view === "settings") renderMain();
  }
  async function saveRemoteConfig(patch) {
    const s = state();
    s.remoteBusy = true; s.remoteError = ""; s.remoteNotice = ""; renderMain();
    try {
      s.remote = await api("/api/remote-connect/config", { method: "POST", body: JSON.stringify(patch) });
      s.remoteDraftDirty = false;
      s.remoteHostName = s.remote.hostName || "";
      s.remoteRelayMode = s.remote.relayMode || "official";
      s.remoteCustomRelay = s.remote.customRelayUrl || "";
      s.remoteNotice = "设置已保存";
    } catch (error) {
      s.remoteError = error?.message || "保存远程连接配置失败";
    }
    s.remoteBusy = false;
    renderMain();
  }
  /* ------------------------------ 新增设备弹窗：选线路 → 扫码 → 确认 → 完成 ------------------------------ */
  // 弹窗挂在 body 上、有自己的渲染：页面每 1.5~4 秒轮询刷新列表时不会重建弹窗，输入框的内容和光标不会丢。
  const LINK_STEPS = [{ id: "route", label: "选线路" }, { id: "scan", label: "扫码" }, { id: "confirm", label: "确认" }];
  const LINK_ROUTE_KEY = "heji.link.route";
  const link = {
    open: false, step: "route", routeId: "public", adding: false, addType: "custom_relay", addUrl: "", addName: "",
    busy: false, error: "", pair: null, baseline: new Set(), done: null, expired: false,
    root: null, box: null, poll: 0, tick: 0, dismissed: new Set(), onKey: null,
  };
  const publicRouteOf = () => ({ id: "public", type: "public_relay", name: "公共中继", url: state().remote?.defaultRelayUrl || "wss://relay.heji.pro" });
  const linkRoutes = () => [publicRouteOf(), ...(state().remote?.routes || [])];
  const linkRoute = () => linkRoutes().find((r) => r.id === link.routeId) || publicRouteOf();
  const ROUTE_KIND = { public_relay: "公共中继", custom_relay: "自建中继", domain: "自有域名" };
  const routeHost = (url) => String(url || "").replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "");
  const countdownText = (ms) => {
    const sec = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  };
  const pairCode = (code) => String(code || "").replace(/(\d{3})(\d{3})/, "$1 $2");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function openLinkModal(opts = {}) {
    if (link.open) return;
    const s = state();
    Object.assign(link, {
      open: true, step: "route", adding: false, addType: "custom_relay", addUrl: "", addName: "", busy: false, error: "",
      pair: null, done: null, expired: false, baseline: new Set(),
    });
    try { link.routeId = localStorage.getItem(LINK_ROUTE_KEY) || "public"; } catch { link.routeId = "public"; }
    if (!linkRoutes().some((r) => r.id === link.routeId)) link.routeId = "public";

    if (opts.restore === "relay" && s.remote?.activePairing) {
      const ap = s.remote.activePairing;
      const route = linkRoutes().find((r) => r.url === ap.relayUrl);
      if (route) link.routeId = route.id;
      link.pair = { kind: "relay", pairId: ap.pairId, qrSvg: ap.qrSvg, qrText: ap.qrText, expiresAt: ap.expiresAt };
      link.step = "scan";
      if (ap.status === "awaiting_approval") adoptRelayRequest(ap);
    } else if (opts.restore === "domain") {
      const pair = (s.devicePairs || []).find((p) => !link.dismissed.has(p.pairId));
      if (pair) {
        link.pair = { kind: "domain", pairId: pair.pairId, expiresAt: pair.expiresAt };
        adoptDomainRequest(pair);
        link.baseline = domainDeviceIds();
      }
    }

    link.root = h("div", { class: "link-backdrop", "data-link-modal": "" });
    link.box = h("div", { class: "link-modal", role: "dialog", "aria-modal": "true", "aria-label": "新增设备" });
    link.root.append(link.box);
    document.body.append(link.root);
    link.onKey = (ev) => { if (ev.key === "Escape") void closeLinkModal(); };
    document.addEventListener("keydown", link.onKey);
    renderLink();
    startLinkLoops();
  }

  function startLinkLoops() {
    stopLinkLoops();
    link.tick = setInterval(() => {
      const el = link.box?.querySelector("[data-link-countdown]");
      if (!el || !link.pair?.expiresAt) return;
      const left = link.pair.expiresAt - Date.now();
      el.textContent = left > 0 ? countdownText(left) : "已过期";
      if (left <= 0 && link.step === "scan" && !link.expired) { link.expired = true; renderLink(); }
    }, 1000);
    const loop = async () => {
      if (!link.open) return;
      if (["scan", "confirm", "working"].includes(link.step)) await linkProgress();
      if (link.open) link.poll = setTimeout(loop, 1200);
    };
    link.poll = setTimeout(loop, 1200);
  }
  function stopLinkLoops() {
    if (link.tick) clearInterval(link.tick);
    if (link.poll) clearTimeout(link.poll);
    link.tick = 0; link.poll = 0;
  }

  async function closeLinkModal() {
    if (!link.open) return;
    const pair = link.pair;
    const wasPending = (link.step === "scan" || link.step === "confirm") && pair;
    link.open = false;
    stopLinkLoops();
    document.removeEventListener("keydown", link.onKey);
    link.root?.remove();
    link.root = null; link.box = null;
    if (wasPending) {
      // 关掉弹窗等于放弃这次配对：电脑上的二维码和待批准请求都作废，手机端会提示被拒绝。
      link.dismissed.add(pair.pairId);
      const url = pair.kind === "relay"
        ? `/api/remote-connect/pairings/${encodeURIComponent(pair.pairId)}/reject`
        : link.step === "confirm" ? `/api/auth/device-pairs/${encodeURIComponent(pair.pairId)}/reject` : "";
      if (url) { try { await api(url, { method: "POST", body: "{}" }); } catch { /* 已过期即可 */ } }
    }
    if (ui.view === "settings" && section() === "remote") void loadRemoteStatus(true);
  }

  function domainDeviceIds() {
    return new Set((state().remote?.devices || []).filter((d) => d.route === "domain").map((d) => d.id));
  }
  function adoptRelayRequest(ap) {
    link.pair = { ...link.pair, deviceName: ap.deviceName, code: ap.safetyCode };
    link.step = "confirm";
  }
  function adoptDomainRequest(pair) {
    link.pair = { ...link.pair, kind: "domain", pairId: pair.pairId, deviceName: pair.deviceName, code: pair.userCode, expiresAt: pair.expiresAt };
    link.step = "confirm";
  }
  function linkFail(message, step = "scan") {
    link.error = message; link.step = step; link.busy = false;
    renderLink();
  }

  // 轮询推进：电脑端状态由服务端权威给出，弹窗只负责把它翻译成当前步骤。
  async function linkProgress() {
    const s = state();
    let status, pending = [];
    try {
      [status, pending] = await Promise.all([
        api("/api/remote-connect/status"),
        window.piAndroidShell?.available ? Promise.resolve([]) : api("/api/auth/device-pairs/pending").then((r) => r?.pairs || []).catch(() => []),
      ]);
    } catch { return; }
    if (!link.open) return;
    s.remote = status; s.devicePairs = pending;
    const pair = link.pair;
    if (!pair) return;
    if (link.step === "working") {
      if (pair.kind === "domain") {
        const created = (status.devices || []).find((d) => d.route === "domain" && !link.baseline.has(d.id));
        if (created) finishLink(created);
      }
      return;
    }
    if (pair.kind === "relay") {
      const ap = status.activePairing;
      if (ap && ap.pairId === pair.pairId) {
        if (link.step === "scan" && ap.status === "awaiting_approval") { adoptRelayRequest(ap); link.error = ""; renderLink(); }
      } else if (!link.busy) {
        linkFail("这次配对已失效（二维码过期或被取消），请重新生成二维码。", "scan");
        link.expired = true; renderLink();
      }
      return;
    }
    // 自有域名：手机出示的六位码出现在待批准列表里
    const hit = link.step === "scan" ? pending[0] : pending.find((p) => p.pairId === pair.pairId);
    if (link.step === "scan" && hit) { adoptDomainRequest(hit); link.error = ""; renderLink(); }
    else if (link.step === "confirm" && !hit && !link.busy) { link.expired = true; linkFail("手机已取消或请求已过期，请让手机重新扫码。", "scan"); }
  }

  async function linkNext() {
    const route = linkRoute();
    link.busy = true; link.error = ""; renderLink();
    try {
      if (route.type === "domain") {
        const qr = await api("/api/remote-connect/domain-qr", { method: "POST", body: JSON.stringify({ routeId: route.id }) });
        link.baseline = domainDeviceIds();
        link.pair = { kind: "domain", pairId: "", qrSvg: qr.qrSvg, qrText: qr.qrText, expiresAt: qr.expiresAt, origin: qr.origin };
      } else {
        const pairing = await api("/api/remote-connect/pairings", { method: "POST", body: JSON.stringify({ routeId: route.id }) });
        link.pair = { kind: "relay", pairId: pairing.pairId, qrSvg: pairing.qrSvg, qrText: pairing.qrText, expiresAt: pairing.expiresAt };
      }
      try { localStorage.setItem(LINK_ROUTE_KEY, route.id); } catch { /* 无痕模式 */ }
      link.step = "scan"; link.expired = false;
    } catch (error) {
      link.error = error?.message || "生成二维码失败";
    }
    link.busy = false;
    renderLink();
  }

  async function linkBack() {
    const pair = link.pair;
    link.busy = true; renderLink();
    if (pair?.kind === "relay" && pair.pairId) { try { await api(`/api/remote-connect/pairings/${encodeURIComponent(pair.pairId)}/reject`, { method: "POST", body: "{}" }); } catch { /* ignore */ } }
    if (pair?.pairId) link.dismissed.add(pair.pairId);
    link.pair = null; link.step = "route"; link.busy = false; link.error = ""; link.expired = false;
    renderLink();
  }

  async function linkDecide(decision) {
    const pair = link.pair;
    if (!pair?.pairId) return;
    const started = Date.now();
    link.busy = true; link.error = "";
    if (decision === "approve") link.step = "working";
    renderLink();
    try {
      if (pair.kind === "relay") {
        const res = await api(`/api/remote-connect/pairings/${encodeURIComponent(pair.pairId)}/${decision}`, { method: "POST", body: "{}" });
        if (res?.status) state().remote = res.status;
        if (decision === "approve") {
          await sleep(Math.max(0, 700 - (Date.now() - started)));
          finishLink(res?.device || { name: pair.deviceName });
          return;
        }
      } else {
        await api(`/api/auth/device-pairs/${encodeURIComponent(pair.pairId)}/${decision}`, { method: "POST", body: "{}" });
        if (decision === "approve") {
          // 手机每 3 秒查一次批准结果，换到凭据后设备才会出现在列表里：这段时间一直显示「正在链接」。
          link.busy = false;
          const deadline = Date.now() + 30_000;
          while (link.open && link.step === "working" && Date.now() < deadline) await sleep(500);
          if (link.open && link.step === "working") linkFail("已批准，但手机还没完成连接。请保持手机 App 在前台，连上后会自动出现在设备列表里。", "scan");
          return;
        }
      }
      link.dismissed.add(pair.pairId);
      link.pair = null; link.step = "route"; link.busy = false; link.expired = false;
      renderLink();
    } catch (error) {
      linkFail(error?.message || (decision === "approve" ? "批准失败，请求可能已过期，请让手机重新扫码" : "拒绝失败，请求可能已过期"), decision === "approve" ? "scan" : "confirm");
      link.expired = decision === "approve";
    }
  }

  function finishLink(device) {
    if (link.step === "done") return;
    const s = state();
    link.done = { name: device?.name || link.pair?.deviceName || "新设备", route: linkRoute() };
    link.step = "done"; link.busy = false;
    if (device?.id) { s.remoteHighlight = device.id; s.remoteHighlightAt = Date.now(); }
    renderLink();
    void loadRemoteStatus(true);
    setTimeout(() => { if (link.open && link.step === "done") void closeLinkModal(); }, 1600);
  }

  async function saveLinkRoute() {
    const url = link.addUrl.trim();
    if (!url) { link.error = link.addType === "domain" ? "请填写自有域名地址（https://…）" : "请填写自建中继地址（wss://…）"; renderLink(); return; }
    link.busy = true; link.error = ""; renderLink();
    try {
      const res = await api("/api/remote-connect/routes", { method: "POST", body: JSON.stringify({ type: link.addType, url, name: link.addName.trim() }) });
      if (res?.status) state().remote = res.status;
      link.routeId = res.route.id; link.adding = false; link.addUrl = ""; link.addName = "";
    } catch (error) {
      link.error = error?.message || "保存线路失败";
    }
    link.busy = false;
    renderLink();
  }
  async function removeLinkRoute(route) {
    if (!window.confirm(`移除线路「${route.name}」？已经用它链接的设备不受影响。`)) return;
    try {
      const res = await api(`/api/remote-connect/routes/${encodeURIComponent(route.id)}`, { method: "DELETE" });
      if (res?.status) state().remote = res.status;
      if (link.routeId === route.id) link.routeId = "public";
    } catch (error) {
      link.error = error?.message || "移除线路失败";
    }
    if (link.open) renderLink(); else renderMain();
  }

  // 每种线路下面的说明和教程：选中哪条就讲哪条，教程里的命令都是仓库里真实存在的。
  function routeGuide(route) {
    const steps = (items) => h("ol", { class: "link-guide-steps" }, items.map((x) => h("li", {}, x)));
    if (route.type === "public_relay") {
      return h("details", { class: "link-guide", open: "", "data-link-guide": "public_relay" },
        h("summary", {}, "公共中继 · 说明与教程"),
        h("p", { class: "muted small" }, "官方 Cloudflare 中继，开箱即用，国内不用 VPN。中继只转发端到端加密的密文，看不到聊天、文件和模型密钥；它能看到连接 IP、在线状态和帧大小。免费额度每日 150 MB / 2 万帧，用完次日 0 点（UTC）自动恢复，重度使用建议自建中继。"),
        steps(["手机安装并打开 Heji App，点「扫码连接」", "回到这里点「下一步」，用手机扫描二维码", "手机上会出现六位码，回到电脑核对一致后批准"]));
    }
    if (route.type === "custom_relay") {
      return h("details", { class: "link-guide", open: "", "data-link-guide": "custom_relay" },
        h("summary", {}, "自建中继 · 说明与教程"),
        h("p", { class: "muted small" }, "把中继放在你自己的 Cloudflare 或服务器上，没有公共额度限制，连接也不经过官方中继。已经链接的设备不会自动迁移，需要重新新增。"),
        steps([
          h("span", {}, "部署中继：Cloudflare 在仓库 ", h("code", {}, "apps/relay/cloudflare"), " 里运行 ", h("code", {}, "node build.mjs && cf deploy --prebuilt"), "；自有服务器用 ", h("code", {}, "apps/relay/node"), " 的 Docker Compose，并配好 HTTPS（已附 Caddyfile）。"),
          h("span", {}, "确认 ", h("code", {}, "https://你的域名/health"), " 返回 ", h("code", {}, "{\"ok\":true…}"), "，中继地址就是 ", h("code", {}, "wss://你的域名"), "。"),
          "点上方「新增我的线路」，类型选「自建中继」，填入地址并保存",
          "选中它，点「下一步」，用手机扫码",
        ]));
    }
    return h("details", { class: "link-guide", open: "", "data-link-guide": "domain" },
      h("summary", {}, "自有域名 · 说明与教程"),
      h("p", { class: "muted small" }, "适合电脑已经有公网 https 入口（Cloudflare Tunnel、frp 或反向代理到本机 Heji）。手机直连你的域名，不经过中继；同一局域网会自动走内网直连。"),
      steps([
        h("span", {}, "确认电脑已能通过 ", h("code", {}, "https://你的域名"), " 打开 Heji"),
        "点上方「新增我的线路」，类型选「自有域名」，填入实例根地址并保存（不要带路径）",
        "选中它，点「下一步」，手机扫码后会显示六位码",
        "回到这里核对六位码一致，批准后手机自动进入；凭据可在「登录管理」里吊销",
      ]));
  }

  function linkRouteCard(route) {
    const selected = link.routeId === route.id;
    const desc = route.type === "public_relay" ? "免费 · 开箱即用，国内可直连" : routeHost(route.url);
    return h("div", { class: `link-route${selected ? " is-selected" : ""}`, "data-link-route": route.id },
      h("button", {
        type: "button", class: "link-route-main", role: "radio", "aria-checked": selected ? "true" : "false", disabled: link.busy,
        onclick: () => { link.routeId = route.id; link.error = ""; renderLink(); },
      },
        h("span", { class: "link-route-radio", "aria-hidden": "true" }),
        h("span", { class: "link-route-text" },
          h("span", { class: "link-route-title" },
            h("span", { class: `settings-route-kind ${route.type === "domain" ? "kind-domain" : route.type === "custom_relay" ? "kind-custom-relay" : "kind-public-relay"}` }, ROUTE_KIND[route.type]),
            route.type === "public_relay" ? "官方中继" : route.name),
          h("span", { class: "muted small" }, desc))),
      route.id === "public" ? null : h("button", { type: "button", class: "link-route-remove", "aria-label": `移除线路 ${route.name}`, disabled: link.busy, onclick: () => removeLinkRoute(route) }, "移除"));
  }

  function linkAddRouteForm() {
    if (!link.adding) {
      return h("button", { type: "button", class: "link-add-route", "data-link-add-route": "", disabled: link.busy, onclick: () => { link.adding = true; link.error = ""; renderLink(); } }, "＋ 新增我的线路");
    }
    const isDomain = link.addType === "domain";
    const here = location.protocol === "https:" && !/^(localhost|127\.|\[::1\])/.test(location.hostname) ? location.origin : "";
    return h("div", { class: "link-add-form", "data-link-add-form": "" },
      h("div", { class: "category-level-switch", role: "tablist" },
        ...[["custom_relay", "自建中继"], ["domain", "自有域名"]].map(([type, label]) => h("button", {
          type: "button", class: link.addType === type ? "active" : "", role: "tab", "aria-selected": link.addType === type ? "true" : "false",
          onclick: () => { link.addType = type; link.error = ""; renderLink(); },
        }, label))),
      h("input", {
        type: "url", class: "input", inputmode: "url", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "data-link-add-url": "",
        placeholder: isDomain ? "https://你的域名" : "wss://relay.你的域名", value: link.addUrl,
        oninput: (ev) => { link.addUrl = ev.target.value; },
      }),
      isDomain && here && !link.addUrl ? h("button", { type: "button", class: "link-chip", onclick: () => { link.addUrl = here; renderLink(); } }, `使用当前访问地址 ${here}`) : null,
      h("input", {
        type: "text", class: "input", maxlength: "40", autocomplete: "off", placeholder: "线路名称（可不填）", value: link.addName,
        oninput: (ev) => { link.addName = ev.target.value; },
      }),
      h("div", { class: "link-add-actions" },
        h("button", { type: "button", class: "btn small", disabled: link.busy, onclick: () => { link.adding = false; link.error = ""; renderLink(); } }, "取消"),
        h("button", { type: "button", class: "btn primary small", disabled: link.busy, "data-link-save-route": "", onclick: saveLinkRoute }, link.busy ? "保存中…" : "保存线路")));
  }

  function linkStepBody() {
    const pair = link.pair;
    if (link.step === "route") {
      return [
        h("p", { class: "muted small link-lead" }, "先选一条线路。手机通过它连到这台电脑，所有内容端到端加密。"),
        h("div", { class: "link-routes", role: "radiogroup", "aria-label": "连接线路", "data-link-routes": "" }, linkRoutes().map(linkRouteCard)),
        linkAddRouteForm(),
        routeGuide(linkRoute()),
      ];
    }
    if (link.step === "scan") {
      const isDomain = pair?.kind === "domain";
      return [
        link.expired
          ? h("div", { class: "link-expired", "data-link-expired": "" }, h("strong", {}, "二维码已失效"), h("span", { class: "muted small" }, "请重新生成后再用手机扫码。"))
          : h("div", { class: "settings-remote-qr-wrap link-qr", "data-remote-qr": "" },
              h("div", { class: "settings-remote-qr-box" }, parseQrSvgNode(pair?.qrSvg)),
              h("div", { class: "settings-remote-qr-info" },
                h("p", { class: "link-wait" }, h("span", { class: "link-pulse", "aria-hidden": "true" }), "等待手机扫码…"),
                h("ol", { class: "link-guide-steps" },
                  h("li", {}, "手机打开 Heji App，点「扫码连接」"),
                  h("li", {}, "扫描二维码并提交"),
                  h("li", {}, isDomain ? "手机显示六位码后，这里会自动出现确认卡片" : "手机提交后，这里会自动出现确认卡片")),
                h("p", { class: "muted small" }, `线路：${ROUTE_KIND[linkRoute().type]}${linkRoute().type === "public_relay" ? "" : ` · ${routeHost(linkRoute().url)}`}　有效期 `, h("span", { "data-link-countdown": "" }, countdownText((pair?.expiresAt || 0) - Date.now()))),
                !isDomain && pair?.qrText ? h("div", { class: "settings-run-actions" },
                  h("button", {
                    type: "button", class: "btn small",
                    onclick: async () => {
                      try { await navigator.clipboard.writeText(pair.qrText); link.error = ""; link.notice = "已复制配对码"; }
                      catch { link.notice = ""; link.error = "复制失败，请直接扫码"; }
                      renderLink();
                    },
                  }, "复制配对码")) : null)),
        link.notice ? h("p", { class: "muted small", role: "status" }, link.notice) : null,
        h("p", { class: "muted small settings-remote-privacy" }, "中继只转发端到端加密的密文，不保存聊天、文件或模型 API Key；中继可见连接 IP、在线状态与帧大小。"),
      ];
    }
    if (link.step === "confirm") {
      return [
        h("div", { class: "settings-remote-approve link-confirm", "data-remote-approve": "", "data-device-pair": pair?.kind === "domain" ? pair.pairId : null },
          h("p", { class: "small" }, "手机「", h("strong", {}, pair?.deviceName || "Android 设备"), "」请求连接，请核对手机屏幕上的六位码是否和下面一致："),
          h("div", { class: "settings-remote-sas", "data-remote-sas": "", "data-device-pair-code": pair?.kind === "domain" ? "" : null }, pairCode(pair?.code)),
          h("p", { class: "muted small" }, "只在你本人刚刚用手机扫码、两边六位码一致时才批准。")),
      ];
    }
    if (link.step === "working") {
      return [h("div", { class: "link-state", "data-link-working": "", role: "status" },
        h("span", { class: "link-spinner", "aria-hidden": "true" }),
        h("strong", {}, "正在建立加密通道…"),
        h("span", { class: "muted small" }, "手机会自动进入，请保持手机 App 在前台。"))];
    }
    return [h("div", { class: "link-state is-done", "data-link-done": "", role: "status" },
      h("span", { class: "link-check", "aria-hidden": "true" }, "✓"),
      h("strong", {}, "链接成功"),
      h("span", { class: "muted small" }, `「${link.done?.name || "新设备"}」已加入，设备列表已更新。`))];
  }

  function linkFooter() {
    const btn = (label, cls, onclick, extra = {}) => h("button", { type: "button", class: `btn ${cls}`.trim(), disabled: link.busy, onclick, ...extra }, label);
    if (link.step === "route") return [btn("取消", "", () => closeLinkModal()), btn(link.busy ? "正在生成…" : "下一步：生成二维码", "primary", linkNext, { "data-link-next": "" })];
    if (link.step === "scan") return [btn("上一步", "", linkBack, { "data-link-back": "" }), link.expired ? btn("重新生成二维码", "primary", async () => { await linkBack(); await linkNext(); }, { "data-link-regenerate": "" }) : null];
    if (link.step === "confirm") return [
      btn("拒绝", "", () => linkDecide("reject"), { "data-link-reject": "" }),
      btn("核对一致，批准连接", "primary", () => linkDecide("approve"), { "data-link-approve": "", "data-device-pair-approve-btn": link.pair?.kind === "domain" ? "" : null }),
    ];
    if (link.step === "done") return [btn("完成", "primary", () => closeLinkModal(), { "data-link-finish": "" })];
    return [];
  }

  function renderLink() {
    if (!link.open || !link.box) return;
    const titles = { route: "新增设备 · 选择线路", scan: "新增设备 · 手机扫码", confirm: "新增设备 · 核对并批准", working: "正在链接", done: "链接成功" };
    const activeIdx = { route: 0, scan: 1, confirm: 2, working: 2, done: 3 }[link.step];
    const footer = linkFooter().filter(Boolean);
    const scroller = link.box.querySelector(".link-body");
    const top = scroller?.scrollTop ?? 0;
    link.box.replaceChildren(...[
      h("div", { class: "link-head" },
        h("h2", {}, titles[link.step]),
        h("button", { type: "button", class: "category-modal-close", "aria-label": "关闭", "data-link-close": "", onclick: () => closeLinkModal() }, "×")),
      h("ol", { class: "link-steps", "aria-label": "进度" }, LINK_STEPS.map((x, i) => h("li", { class: i < activeIdx ? "is-done" : i === activeIdx ? "is-active" : "", "aria-current": i === activeIdx ? "step" : null },
        h("span", { class: "link-step-dot" }, i < activeIdx ? "✓" : String(i + 1)), h("span", {}, x.label)))),
      h("div", { class: "link-body" },
        ...linkStepBody(),
        link.error ? h("p", { class: "field-error", role: "alert", "data-link-error": "" }, link.error) : null),
      footer.length ? h("div", { class: "link-foot" }, ...footer) : null,
    ].filter(Boolean));
    const next = link.box.querySelector(".link-body");
    if (next && top) next.scrollTop = top;
    link.notice = "";
  }
  async function revokeRemoteDevice(device) {
    const group = (device.memberIds || [device.id]).length > 1;
    const tip = group ? "这台手机会同时断开所有线路并失效全部登录会话。" : "撤销后会立即断开它的连接。";
    if (!window.confirm(`确定撤销「${device.name}」的远程访问权限？${tip}`)) return;
    const s = state();
    s.remoteBusy = true; s.remoteError = ""; renderMain();
    try {
      const res = await api(`/api/remote-connect/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" });
      if (res?.status) s.remote = res.status;
      s.remoteNotice = `已撤销「${device.name}」`;
    } catch (error) {
      s.remoteError = error?.message || "撤销设备失败";
    }
    s.remoteBusy = false;
    renderMain();
  }
  function parseQrSvgNode(svgText) {
    try {
      const doc = new DOMParser().parseFromString(String(svgText || ""), "image/svg+xml");
      const svg = doc.documentElement;
      if (svg && svg.tagName.toLowerCase() === "svg") return document.importNode(svg, true);
    } catch { /* fallback below */ }
    return h("span", { class: "muted small" }, "二维码加载失败，请使用下方配对码");
  }
  async function loadNativeConnectionStatus(force = false) {
    const shell = window.piAndroidShell;
    if (!shell?.available || typeof shell.call !== "function") return;
    const s = state();
    if (s.nativeConnLoading && !force) return;
    s.nativeConnLoading = true;
    try {
      const status = await shell.call("shell.status");
      const caps = Array.isArray(status?.capabilities) ? status.capabilities : [];
      s.nativeConnSupported = caps.includes("connection.switch");
      s.nativeRoutesSupported = caps.includes("connection.routes.v1");
      if (s.nativeConnSupported) {
        s.nativeConn = await shell.call("connection.status");
        s.nativeConnError = "";
        // 中继用量由 App 在后台查询，第一次读状态时还没有；最多补读 3 次，不一直轮询。
        const waitingUsage = (s.nativeConn?.routes || []).some((r) => (r.type === "public_relay" || r.type === "custom_relay") && !r.usage);
        if (waitingUsage && (s.nativeUsageRetry || 0) < 3) {
          s.nativeUsageRetry = (s.nativeUsageRetry || 0) + 1;
          setTimeout(() => { if (ui.view === "settings") void loadNativeConnectionStatus(true); }, 2500);
        } else if (!waitingUsage) {
          s.nativeUsageRetry = 0;
        }
      }
    } catch (error) {
      s.nativeConnError = error?.message || "读取本机连接方式失败";
    }
    s.nativeConnLoading = false;
    if (ui.view === "settings") renderMain();
  }
  async function switchNativeConnection(target) {
    const shell = window.piAndroidShell;
    if (!shell?.available || typeof shell.call !== "function") return;
    const s = state();
    const params = typeof target === "string" ? { mode: target } : target;
    if (params.action) {
      // 添加线路改用 App 里的半屏弹层：网页这侧不进忙态、不重绘，刚看的设置页和滚动位置原样留着。
      s.nativeConnError = "";
      try {
        await shell.call("connection.switch", params);
      } catch (error) {
        s.nativeConnError = error?.message || "打不开添加线路";
        renderMain();
      }
      return;
    }
    s.nativeConnBusy = true; s.nativeConnError = ""; renderMain();
    try {
      await shell.call("connection.switch", params);
    } catch (error) {
      s.nativeConnError = error?.message || "切换连接线路失败";
      s.nativeConnBusy = false;
      renderMain();
    }
  }
  // App 里刚添加完线路会派发这个事件：页面回到线路列表，并把那条新线路高亮一会儿。
  let addedRouteId = null;
  let addedRouteTimer = 0;
  function markAddedRoute(routeId) {
    addedRouteId = routeId || null;
    if (addedRouteTimer) clearTimeout(addedRouteTimer);
    addedRouteTimer = setTimeout(() => {
      addedRouteId = null; addedRouteTimer = 0;
      rerenderIfSettings();
    }, 8000);
    rerenderIfSettings();
  }
  function rerenderIfSettings() {
    if (typeof renderMain === "function" && ui.view === "settings") renderMain();
  }
  window.addEventListener("pi-native-route-added", (event) => {
    const id = event?.detail?.routeId;
    if (id) markAddedRoute(id);
  });
  // 连接状态弹层里点「线路」跳过来：滚到当前线路并短暂高亮，回到列表就知道在用哪条。
  let focusRouteId = null;
  let focusRouteTimer = 0;
  function markFocusRoute(routeId) {
    if (!routeId) return;
    focusRouteId = routeId;
    if (focusRouteTimer) clearTimeout(focusRouteTimer);
    focusRouteTimer = setTimeout(() => {
      focusRouteId = null; focusRouteTimer = 0;
      rerenderIfSettings();
    }, 3000);
    rerenderIfSettings();
  }
  function scrollToFocusedRoute() {
    if (!focusRouteId) return;
    const item = [...document.querySelectorAll("[data-native-route-list] [data-route-item]")].find((el) => el.dataset.routeItem === focusRouteId);
    if (!item) return;
    try { item.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { /* 老浏览器不滚动，只高亮 */ }
  }
  /** 跳转时这一页可能还没渲染：全局变量兜住时差，渲染这一页时消费掉（60 秒内有效，过期不重放）。 */
  function consumeRouteFocus() {
    const pending = window.piRouteFocus;
    if (!pending || !pending.id) return;
    window.piRouteFocus = null;
    if (Date.now() - (pending.at || 0) > 60_000) return;
    markFocusRoute(pending.id);
  }
  window.addEventListener("pi-route-focus", (event) => {
    const id = event?.detail?.id;
    if (!id) return;
    window.piRouteFocus = null;
    markFocusRoute(id);
  });
  // 页面重建时事件可能已经发过：全局变量兜住时差。
  if (window.__piNativeAddedRoute) markAddedRoute(window.__piNativeAddedRoute);
  async function removeNativeRoute(route) {
    if (!window.confirm(`确定移除线路「${route.label}」？不会影响其他已保存的线路。`)) return;
    const shell = window.piAndroidShell;
    if (!shell?.available || typeof shell.call !== "function") return;
    const s = state();
    s.nativeConnBusy = true; s.nativeConnError = ""; renderMain();
    try {
      await shell.call("connection.removeRoute", { routeId: route.id });
      await loadNativeConnectionStatus(true);
    } catch (error) {
      s.nativeConnError = error?.message || "移除线路失败";
    }
    s.nativeConnBusy = false;
    renderMain();
  }
  async function unpairNativeRemote() {
    if (!window.confirm("确定清除本机的加密远程连接配对信息？你原有的公网地址凭据会保留。")) return;
    const shell = window.piAndroidShell;
    if (!shell?.available || typeof shell.call !== "function") return;
    const s = state();
    s.nativeConnBusy = true; s.nativeConnError = ""; renderMain();
    try {
      await shell.call("connection.unpairRemote");
      await loadNativeConnectionStatus(true);
    } catch (error) {
      s.nativeConnError = error?.message || "解除远程配对失败";
    }
    s.nativeConnBusy = false;
    renderMain();
  }
  function routeTypeMeta(type) {
    if (type === "public_domain") return { label: "自有域名", cls: "kind-domain" };
    if (type === "custom_relay") return { label: "自建中继", cls: "kind-custom-relay" };
    return { label: "公共中继", cls: "kind-public-relay" };
  }
  function routeRefreshIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const p1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p1.setAttribute("d", "M21 12a9 9 0 1 1-2.64-6.36");
    const p2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p2.setAttribute("d", "M21 3v6h-6");
    svg.append(p1, p2);
    return svg;
  }
  function routeActiveStateBadge(text, quotaExceeded) {
    return h("span", {
      class: `settings-route-state ${quotaExceeded ? "is-quota" : "is-live"}`,
      "data-native-conn-active": "",
    },
      h("span", { class: "settings-route-dot", "aria-hidden": "true" }),
      text);
  }
  function nativeConnectionCard(remoteData) {
    if (!window.piAndroidShell?.available) return null;
    const s = state();
    if (!s.nativeConnLoaded) { s.nativeConnLoaded = true; void loadNativeConnectionStatus(true); }
    if (s.nativeConnSupported === false) {
      return h("section", { class: "card settings-card", "data-native-connection-card": "" },
        h("div", { class: "settings-card-head" },
          h("div", {},
            h("h2", {}, "连接线路"),
            h("p", { class: "muted small" }, "当前 App 版本暂不支持线路切换与扫码接入，请先到「设置 → 平台 APP 版本」更新客户端。"))));
    }
    const c = s.nativeConn;
    const busy = Boolean(s.nativeConnBusy);
    const loading = Boolean(s.nativeConnLoading);
    const isRemote = c?.active === "remote";
    const lanBadge = typeof window.piAndroidShell?.badge === "function" ? window.piAndroidShell.badge() : null;
    const hasMultiRoutes = Boolean(c && Array.isArray(c.routes));
    const activeRoute = hasMultiRoutes ? c.routes.find((r) => r.active) : null;
    const quotaHit = Boolean(c?.quotaExceeded || activeRoute?.quotaExceeded || remoteData?.connectionState === "quota_exceeded");

    const relayKindLabel = remoteData?.relayMode === "custom" ? "自建中继" : remoteData ? "公共中继" : "加密中继";

    let routeList = null;
    if (hasMultiRoutes) {
      const sortedRoutes = [...c.routes].sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
      const items = sortedRoutes.map((route) => {
        const meta = routeTypeMeta(route.type);
        const isNew = Boolean(addedRouteId && route.id === addedRouteId);
        const stateText = route.quotaExceeded
          ? "额度已满"
          : route.type === "public_domain"
            ? (lanBadge?.mode === "lan" ? `使用中 · ${lanBadge.text}` : "使用中")
            : (route.state && route.state !== "已保存" && route.state !== "使用中" && route.state !== "加密中继"
                ? `使用中 · ${route.state}`
                : "使用中");
        const desc = route.type === "public_domain"
          ? (route.active && lanBadge?.mode === "lan" ? `${lanBadge.text}，页面与请求走内网` : "直连公网 HTTPS · 同局域网自动直连")
          : route.type === "custom_relay"
            ? `${route.relayHost ? `${route.relayHost} · ` : ""}端到端加密${route.usage?.kind === "unlimited" ? " · 无限额" : ""}`
            : route.quotaExceeded
              ? "端到端加密 · 今日已达上限"
              : route.state === "P2P 直连"
                ? "端到端加密 · 优先走 P2P 通道"
                : `${route.state && route.state !== "已保存" && route.state !== "使用中" ? `${route.state} · ` : ""}端到端加密`;
        const canRemove = c.routes.length > 1 || !route.active;
        const routeActionBtns = [
          canRemove
            ? h("button", { type: "button", class: "btn small settings-route-remove", disabled: busy, "data-remove-route": route.id, onclick: () => removeNativeRoute(route) }, "移除")
            : null,
          !route.active
            ? h("button", { type: "button", class: "btn primary small", disabled: busy, "data-switch-route": route.id, onclick: () => switchNativeConnection({ routeId: route.id }) }, "切换")
            : null,
        ].filter(Boolean);
        return h("article", {
          class: `settings-route-item${route.active ? " is-active" : ""}${route.quotaExceeded ? " is-quota" : ""}${isNew ? " is-new" : ""}${focusRouteId === route.id ? " is-focus" : ""}`,
          "data-route-item": route.id,
          "data-route-type": route.type,
          "data-route-new": isNew ? "1" : null,
        },
          h("div", { class: "settings-route-meta" },
            h("div", { class: "settings-route-meta-left" },
              h("span", { class: `settings-route-kind ${meta.cls}` }, meta.label),
              isNew ? h("span", { class: "settings-route-new" }, "刚刚添加") : null),
            route.active ? routeActiveStateBadge(stateText, route.quotaExceeded) : null),
          h("div", { class: "settings-route-main" },
            h("strong", { class: "settings-route-title" }, route.label),
            h("p", { class: "muted small settings-route-desc" }, desc)),
          route.type === "public_relay" ? relayUsageBlock(route.usage) : null,
          routeActionBtns.length ? h("div", { class: "settings-route-actions" }, ...routeActionBtns) : null);
      });
      routeList = h("div", { class: "settings-route-list", "data-native-route-list": "" },
        items.length ? items : h("p", { class: "muted small" }, "还没有已保存的连接线路，点击下方按钮扫码或输入自有域名添加。"));
      if (focusRouteId) requestAnimationFrame(scrollToFocusedRoute);
    } else if (c) {
      const publicTitle = c.publicHost || "自有域名入口";
      const publicDesc = c.publicConfigured
        ? (isRemote ? "已保存登录凭据，可一键切回" : (lanBadge?.mode === "lan" ? `${lanBadge.text}，页面与请求走内网` : "直连公网 HTTPS · 同局域网自动直连"))
        : "输入你的公网域名并通过浏览器批准";
      const remoteTitle = c.remoteConfigured ? (c.remoteHostName || "我的电脑") : "扫码接入电脑端中继";
      const remoteDesc = c.remoteConfigured
        ? `${relayKindLabel} · ${c.remoteState || "就绪"} · 端到端加密`
        : "在电脑端打开配对二维码，手机扫码核对 6 位安全码即可连接";
      const publicItem = h("article", { class: `settings-route-item${!isRemote ? " is-active" : ""}`, "data-route-item": "public" },
        h("div", { class: "settings-route-meta" },
          h("div", { class: "settings-route-meta-left" },
            h("span", { class: "settings-route-kind kind-domain" }, "自有域名")),
          !isRemote ? routeActiveStateBadge(lanBadge?.mode === "lan" ? `使用中 · ${lanBadge.text}` : "使用中", false) : null),
        h("div", { class: "settings-route-main" },
          h("strong", { class: "settings-route-title" }, publicTitle),
          h("p", { class: "muted small settings-route-desc" }, publicDesc)),
        isRemote
          ? h("div", { class: "settings-route-actions" },
              h("button", { type: "button", class: "btn primary small", disabled: busy, "data-switch-public": "", onclick: () => switchNativeConnection("public") }, c.publicConfigured ? "切换" : "去配置"))
          : null);
      const remoteItem = h("article", { class: `settings-route-item${isRemote ? " is-active" : ""}`, "data-route-item": "remote" },
        h("div", { class: "settings-route-meta" },
          h("div", { class: "settings-route-meta-left" },
            h("span", { class: `settings-route-kind ${remoteData?.relayMode === "custom" ? "kind-custom-relay" : "kind-public-relay"}` }, relayKindLabel)),
          isRemote ? routeActiveStateBadge(c.remoteState && c.remoteState !== "加密中继" ? `使用中 · ${c.remoteState}` : "使用中", quotaHit) : null),
        h("div", { class: "settings-route-main" },
          h("strong", { class: "settings-route-title" }, remoteTitle),
          h("p", { class: "muted small settings-route-desc" }, remoteDesc)),
        !isRemote
          ? h("div", { class: "settings-route-actions" },
              h("button", { type: "button", class: "btn primary small", disabled: busy, "data-switch-remote": "", onclick: () => switchNativeConnection("remote") }, c.remoteConfigured ? "切换" : "扫码连接"))
          : null);
      routeList = h("div", { class: "settings-route-list", "data-native-route-list": "" },
        isRemote ? remoteItem : publicItem,
        isRemote ? publicItem : remoteItem);
    } else if (loading) {
      routeList = skeletonRows(2);
    }

    const bottomActions = hasMultiRoutes || s.nativeRoutesSupported
      ? h("div", { class: "settings-route-add-actions" },
          h("button", { type: "button", class: "btn primary small", disabled: busy, "data-add-relay-scan": "", onclick: () => switchNativeConnection({ action: "scan_relay" }) }, "扫码添加中继"),
          h("button", { type: "button", class: "btn small", disabled: busy, "data-add-domain": "", onclick: () => switchNativeConnection({ action: "add_domain" }) }, "添加自有域名"))
      : (c?.remoteConfigured
          ? h("div", { class: "settings-run-actions" },
              h("button", { type: "button", class: "btn small", disabled: busy, "data-unpair-remote": "", onclick: unpairNativeRemote }, "解除中继配对"))
          : null);

    return h("section", { class: "card settings-card", "data-native-connection-card": "" },
      h("div", { class: "settings-card-head settings-native-head" },
        h("div", {},
          h("h2", {}, "连接线路"),
          h("p", { class: "muted small" }, "各线路独立保存，随时一键切换")),
        h("button", {
          type: "button",
          class: "btn small settings-route-refresh",
          disabled: loading || busy,
          "data-native-conn-refresh": "",
          onclick: () => loadNativeConnectionStatus(true),
        }, routeRefreshIcon(), h("span", {}, loading ? "读取中…" : "刷新"))),
      quotaHit
        ? h("p", { class: "settings-remote-quota-alert", role: "alert", "data-quota-alert": "" },
            remoteData?.quotaNotice || "公共中继今日免费额度（150 MB / 20,000 帧）已用完，次日 UTC 0 点自动重置；可切换到自有域名或自建中继线路。")
        : null,
      routeList,
      s.nativeConnError ? h("p", { class: "field-error", role: "alert" }, s.nativeConnError) : null,
      bottomActions);
  }
  /* ------------------------------ 链接设备列表 ------------------------------ */
  const TIER_LABEL = { good: "流畅", fair: "一般", poor: "较慢", unknown: "未测速" };
  const PLATFORM_LABEL = { android: "Android", ios: "iOS" };
  const ROUTE_NOTE = { public_relay: "公共中继", custom_relay: "自建中继", domain: "自有域名" };
  function formatRate(kbps) {
    return kbps >= 1024 ? `${(kbps / 1024).toFixed(1)} MB/s` : `${Math.max(1, Math.round(kbps))} KB/s`;
  }
  // 通道标签：在线时按实际走的通道（直连优先，其次中继种类），离线统一灰色。
  function deviceChannel(d) {
    if (!d.online) return { label: "离线", cls: "is-off" };
    if (d.route === "domain") return { label: "自有域名", cls: "kind-domain" };
    if (d.pathKind === "lan") return { label: "局域网直连", cls: "kind-direct" };
    if (d.pathKind === "p2p") return { label: "P2P 直连", cls: "kind-direct" };
    // 中继记录本身没通道、但同一台手机的自有域名会话在线：按实际在用的线路显示。
    if (!d.pathKind && (d.routes || []).some((r) => r.route === "domain" && r.online)) return { label: "自有域名", cls: "kind-domain" };
    return d.route === "custom_relay" ? { label: "自建中继", cls: "kind-custom-relay" } : { label: "公共中继", cls: "kind-public-relay" };
  }
  function deviceRouteNote(d) {
    const other = (d.routes || []).filter((r) => r.route !== d.route).map((r) => ROUTE_NOTE[r.route]);
    const extra = other.length ? ` · 另有${[...new Set(other)].join("/")}会话` : "";
    if (d.route === "domain") return `线路：自有域名${extra}`;
    const kind = d.route === "custom_relay" ? "自建中继" : "公共中继";
    const host = d.routeHost ? ` · ${d.routeHost}` : "";
    return d.online && (d.pathKind === "lan" || d.pathKind === "p2p") ? `中继备用：${kind}${host}${extra}` : `线路：${kind}${host}${extra}`;
  }
  function deviceQualityLine(d) {
    if (d.route === "domain") return h("span", { class: "link-quality is-unknown", "data-device-quality": "unknown" }, "自有域名按请求访问，暂不测速");
    const q = d.quality;
    if (!q || q.tier === "unknown") {
      return h("span", { class: "link-quality is-unknown", "data-device-quality": "unknown" }, d.online ? "暂未测得网速" : "暂无测速记录");
    }
    const detail = [q.rttMs !== undefined ? `延迟 ${q.rttMs} ms` : "", q.kbps !== undefined ? formatRate(q.kbps) : "", d.online ? "" : `${ago(q.at)}测得`].filter(Boolean).join(" · ");
    return h("span", { class: `link-quality is-${q.tier}`, "data-device-quality": q.tier },
      h("span", { class: "link-quality-dot", "aria-hidden": "true" }),
      h("strong", {}, `${d.online ? "" : "上次"}网速${TIER_LABEL[q.tier]}`),
      detail ? h("span", { class: "muted small" }, ` · ${detail}`) : null);
  }
  function deviceRow(d, busy) {
    const s = state();
    const ch = deviceChannel(d);
    const fresh = s.remoteHighlight === d.id && Date.now() - (s.remoteHighlightAt || 0) < 8000;
    return h("div", { class: `link-device${d.online ? "" : " is-offline"}${fresh ? " is-new" : ""}`, "data-remote-device-id": d.id, "data-device-route": d.route, "data-device-channel": ch.label },
      h("div", { class: "link-device-icon", "aria-hidden": "true" }, "📱"),
      h("div", { class: "link-device-main" },
        h("div", { class: "link-device-title" },
          h("strong", {}, d.name),
          fresh ? h("span", { class: "settings-route-new" }, "刚刚添加") : null),
        h("div", { class: "muted small" }, `${PLATFORM_LABEL[d.platform] || d.platform || "设备"} · ${d.online ? "在线" : `最近活跃 ${beijing(d.lastSeenAt)}`} · ${deviceRouteNote(d)}`),
        deviceQualityLine(d),
        relayUsageBlock(d.usage)),
      h("div", { class: "link-device-side" },
        h("span", { class: `settings-route-kind link-channel ${ch.cls}`, "data-device-channel-tag": "" }, ch.label),
        h("button", { type: "button", class: "btn small", disabled: busy, onclick: () => revokeRemoteDevice(d) }, "撤销")));
  }

  function remoteSection() {
    const s = state();
    consumeRouteFocus();
    if (!s.remoteLoaded) { s.remoteLoaded = true; void loadRemoteStatus(true); }
    const data = s.remote;
    const busy = Boolean(s.remoteBusy);
    const devices = (data?.devices || []).filter((d) => !d.revokedAt);
    const stateCls = data?.connectionState === "lan" || data?.connectionState === "p2p" || data?.connectionState === "relay"
      ? "ok"
      : data?.connectionState === "quota_exceeded"
        ? "failed"
        : data?.connectionState === "recovering"
          ? "warn"
          : "";
    const isAndroidApp = Boolean(window.piAndroidShell?.available);

    const hostConnectCard = h("section", { class: "card settings-card", "data-remote-connect-card": "" },
      h("div", { class: "settings-card-head" },
        h("div", {},
          h("h2", {}, "链接设备"),
          h("p", { class: "muted small" }, "用手机 App 扫码加入，设备经端到端加密通道访问这台电脑上的 Heji。")),
        h("div", { class: "settings-card-actions" },
          h("span", { class: `settings-run-state ${stateCls}`, "data-remote-state": "" }, data ? data.connectionLabel : "读取中…"),
          h("button", { type: "button", class: "btn primary", disabled: busy || !data, "data-remote-add": "", onclick: () => openLinkModal() }, "新增设备"))),
      data?.quotaNotice ? h("p", { class: "settings-remote-quota-alert", role: "alert", "data-host-quota-alert": "" }, data.quotaNotice) : null,
      s.remoteError ? h("p", { class: "field-error", role: "alert" }, s.remoteError) : null,
      s.remoteNotice ? h("p", { class: "muted small", role: "status" }, s.remoteNotice) : null,
      !data
        ? skeletonRows(2)
        : devices.length === 0
          ? h("div", { class: "link-empty", "data-link-empty": "" },
              h("strong", {}, "还没有链接的设备"),
              h("span", { class: "muted small" }, "点「新增设备」，选好线路后用手机扫码，电脑上确认即可。"),
              h("button", { type: "button", class: "btn primary", onclick: () => openLinkModal() }, "新增设备"))
          : h("div", { class: "link-device-list", "data-link-device-list": "" }, devices.map((d) => deviceRow(d, busy))),
      h("div", { class: "settings-run-actions link-list-foot" },
        h("button", { type: "button", class: "btn small", disabled: s.remoteLoading, onclick: () => loadRemoteStatus(true) }, "刷新状态"),
        h("span", { class: "muted small" }, "撤销后立即断开该设备并失效其登录凭据。")),
      h("p", { class: "muted small settings-remote-privacy" }, "隐私说明：中继服务器仅转发端到端加密密文，不保存聊天、文件或模型 API Key；中继可见连接 IP、在线状态与帧大小。"));

    const savedRoutes = data?.routes || [];
    const hostAdvancedCard = h("section", { class: "card settings-card" },
      h("details", { class: "settings-remote-advanced", open: Boolean(s.remoteAdvOpen), ontoggle: (ev) => { s.remoteAdvOpen = ev.target.open; } },
        h("summary", { class: "settings-remote-summary" }, "高级设置（本机名称、远程服务开关、我的线路）"),
        h("div", { class: "settings-remote-form" },
          h("label", { class: "settings-remote-field" },
            h("span", { class: "small" }, "电脑显示名称"),
            h("input", {
              type: "text", class: "input", maxlength: "60",
              value: s.remoteHostName ?? data?.hostName ?? "",
              oninput: (ev) => { s.remoteHostName = ev.target.value; s.remoteDraftDirty = true; },
            })),
          h("div", { class: "settings-run-actions" },
            h("button", {
              type: "button", class: "btn primary small", disabled: busy || !data,
              onclick: () => saveRemoteConfig({ hostName: s.remoteHostName ?? data?.hostName ?? "" }),
            }, "保存名称"),
            h("button", {
              type: "button", class: `btn small ${data?.enabled ? "" : "primary"}`, disabled: busy || !data, "data-remote-toggle": "",
              onclick: () => saveRemoteConfig({ enabled: !data.enabled }),
            }, data?.enabled ? "关闭远程连接" : "开启远程连接")),
          h("div", { class: "settings-remote-field" },
            h("span", { class: "small" }, "我的线路"),
            savedRoutes.length === 0
              ? h("p", { class: "muted small" }, "还没有自建中继或自有域名线路。在「新增设备」里选线路时可以添加。")
              : h("div", { class: "link-saved-routes", "data-link-saved-routes": "" }, savedRoutes.map((r) => h("div", { class: "link-saved-route" },
                  h("span", { class: `settings-route-kind ${r.type === "domain" ? "kind-domain" : "kind-custom-relay"}` }, ROUTE_KIND[r.type]),
                  h("span", { class: "link-saved-route-name" }, r.name === routeHost(r.url) ? r.name : `${r.name} · ${routeHost(r.url)}`),
                  h("button", { type: "button", class: "btn small", disabled: busy, onclick: () => removeLinkRoute(r) }, "移除"))))))));

    if (isAndroidApp) {
      const hostSummaryMeta = !data
        ? "读取中…"
        : `${data.connectionLabel}${devices.length ? ` · ${devices.length} 台设备` : ""}`;
      const autoOpenHost = data?.activePairing?.status === "awaiting_approval" || (s.devicePairs || []).length > 0;
      return [
        nativeConnectionCard(data),
        h("details", {
          class: "card settings-card settings-remote-host-panel",
          "data-remote-host-panel": "",
          open: Boolean(s.remoteHostPanelOpen || autoOpenHost),
          ontoggle: (ev) => { s.remoteHostPanelOpen = ev.target.open; },
        },
          h("summary", { class: "settings-remote-host-summary" },
            h("div", { class: "settings-remote-host-summary-text" },
              h("span", { class: "settings-remote-host-title" }, "管理电脑端远程服务"),
              h("span", { class: "muted small" }, autoOpenHost ? "有新的配对请求等待批准" : hostSummaryMeta)),
            h("span", { class: "settings-remote-host-chevron", "aria-hidden": "true" }, "›")),
          h("div", { class: "settings-remote-host-body" },
            hostConnectCard,
            hostAdvancedCard)),
      ];
    }

    return [hostConnectCard, hostAdvancedCard];
  }

  // 每个设置页的渲染器；目录（home）在 PC 上就是导航页，手机上只显示组目录。
  // Account connections and runtime MCP are distinct surfaces. Credentials stay in memory only.
  const connectionsState = {loaded:false,loading:false,busy:false,error:"",connections:[],legacy:[],catalog:[],sessions:[],audit:[],filterConnection:"",filterSession:"",view:"home",tab:"services",provider:"github",accountId:"",step:1,draft:null,successId:"",auditLoaded:false};
  let connectionSecret = "";
  const connectionProviders = {
    github:{name:"GitHub",mark:"GH",description:"仓库、Issue、PR 与发布",value:"汇总待处理 Issue、查看 PR 与工作流；创建 PR 或发布前会请你确认。",tokenUrl:"https://github.com/settings/personal-access-tokens/new",guideUrl:"https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens"},
    cloudflare:{name:"Cloudflare",mark:"CF",description:"域名、DNS、Workers 与 Pages",value:"查看域名解析与部署状态；修改 DNS 或触发 Pages 部署前会请你确认。",tokenUrl:"https://dash.cloudflare.com/profile/api-tokens",guideUrl:"https://developers.cloudflare.com/fundamentals/api/get-started/create-token/"},
  };
  const connectionCard = (title,body) => h("section",{class:"card settings-card connection-card"},title?h("h2",{},title):null,...body);
  const connectionLink = (url,label) => h("a",{class:"btn",href:url,target:"_blank",rel:"noopener noreferrer"},label);
  const connectionLabel = (id) => connectionProviders[id]?.name || id;
  const connectionResourceLabel = (value) => value.replace(/^repo:/,"").replace(/^zone:/,"域名区域 · ").replace(/^account:/,"账号 · ");
  function connectionRerender() { if(ui.view==="settings")renderMain(); }
  async function loadConnections() {
    const s=connectionsState;if(s.loading)return;
    s.loading=true;s.error="";
    const results=await Promise.allSettled([api("/api/capabilities/connections"),api("/api/capabilities/catalog")]);
    results.forEach((result,i)=>{
      if(result.status==="rejected")s.error=connectionError(result.reason);
      else if(i===0){s.connections=Array.isArray(result.value?.connections)?result.value.connections:[];s.legacy=Array.isArray(result.value?.legacy)?result.value.legacy:[];}
      else s.catalog=Array.isArray(result.value?.capabilities)?result.value.capabilities:[];
    });
    s.loaded=true;s.loading=false;connectionRerender();
  }
  function connectionError(error) {
    const code=error?.code||error?.message||"";
    if(error?.status===401)return "登录已过期，请重新登录后继续；账号名称和资源草稿仍会保留。";
    if(error?.status===403)return "当前入口没有管理连接的权限，请在已授权的入口操作。";
    if(/AUTH_FAILED/.test(code))return "凭据无效、已过期，或没有所选资源的权限。请核对令牌与资源授权后重试。";
    if(/INVALID_RESOURCE/.test(code))return "资源范围不正确，请核对仓库或 Cloudflare ID。";
    if(/INVALID_TOKEN|INVALID_INPUT/.test(code))return "请核对账号名称、令牌和资源内容。";
    if(/TIMEOUT|AbortError/.test(code))return "验证超时。请稍后重试，先不要重复添加账号。";
    if(/RATE_LIMITED/.test(code))return "服务请求过于频繁，请稍后重试。";
    if(/UPSTREAM_UNAVAILABLE|UPSTREAM_FAILED/.test(code))return "暂时无法访问服务，请检查网络和所选资源后重试。";
    return "暂时无法完成操作，请检查网络后重试。";
  }
  async function connectionAction(work) {
    const s=connectionsState;if(s.busy)return;
    s.busy=true;s.error="";connectionRerender();
    try {await work();await loadConnections();}
    catch(error){s.error=connectionError(error);}
    finally{s.busy=false;connectionRerender();}
  }
  function connectionHome() { connectionSecret="";Object.assign(connectionsState,{view:"home",draft:null,error:"",successId:"",accountId:""});connectionRerender(); }
  function connectionStart(provider,edit) {
    const s=connectionsState;connectionSecret="";
    Object.assign(s,{view:"wizard",provider,step:1,error:"",draft:{label:edit?.label||`个人 ${connectionLabel(provider)}`,resources:[...(edit?.resources||[])],resourceInput:"",resourceType:"account",editId:edit?.id||""}});
    connectionRerender();
  }
  function connectionParseResource(provider,input,type) {
    let raw=String(input||"").trim();
    if(provider==="github"){
      if(/^https:\/\//i.test(raw)){
        let url;try{url=new URL(raw);}catch{throw new Error("请粘贴完整的 GitHub 仓库网址，或填写 owner/repo。");}
        if(url.hostname!=="github.com"||url.username||url.password||url.port||url.search||url.hash)throw new Error("请使用 github.com 上的仓库首页网址。");
        raw=url.pathname.replace(/^\//,"").replace(/\/$/,"");
      }
      raw=raw.replace(/^repo:/,"").replace(/\.git$/,"");
      if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)||raw.includes(".."))throw new Error("仓库格式应为 owner/repo，例如 lemon-demo/notes。");
      return `repo:${raw}`;
    }
    const match=raw.match(/^(zone|account):([a-fA-F0-9]{32})$/);
    if(match)return `${match[1]}:${match[2].toLowerCase()}`;
    if(!/^[a-fA-F0-9]{32}$/.test(raw))throw new Error("请复制控制台中完整的 32 位账号 ID 或区域 ID。");
    return `${type}:${raw.toLowerCase()}`;
  }
  function connectionAddResource() {
    const s=connectionsState,d=s.draft;
    try{
      const value=connectionParseResource(s.provider,d.resourceInput,d.resourceType);
      if(d.resources.includes(value))throw new Error("这个资源已经添加，可以继续添加其他资源或进入下一步。");
      if(d.resources.length>=20)throw new Error("每个连接最多添加 20 个资源。");
      d.resources.push(value);d.resourceInput="";s.error="";
    }catch(error){s.error=error.message;}
    connectionRerender();
  }
  function connectionNext() {
    const s=connectionsState,d=s.draft;s.error="";
    if(s.step===1&&!connectionSecret.trim())s.error="请先创建并粘贴访问令牌。";
    else if(s.step===2){
      if(d.resourceInput.trim()){
        try{const value=connectionParseResource(s.provider,d.resourceInput,d.resourceType);if(!d.resources.includes(value)){if(d.resources.length>=20)throw new Error("每个连接最多添加 20 个资源。");d.resources.push(value);}d.resourceInput="";}
        catch(error){s.error=error.message;connectionRerender();return;}
      }
      if(!d.label.trim())s.error="请给这个账号起个名称。";
      else if(!d.resources.length)s.error="请至少添加一个允许访问的资源。";
      else s.step=3;
    }else s.step++;
    connectionRerender();
  }
  async function connectionSubmit() {
    const s=connectionsState,d=s.draft;if(s.busy||!d||!connectionSecret.trim())return;
    const payload={provider:s.provider,label:d.label.trim(),token:connectionSecret.trim(),resources:[...d.resources],...(d.editId?{connectionId:d.editId}:{})};
    connectionSecret="";
    await connectionAction(async()=>{
      try{
        const created=await api("/api/capabilities/connections",{method:"POST",body:JSON.stringify(payload)});
        s.connections=[...s.connections.filter(c=>c.id!==created.id),created];s.loaded=true;s.successId=created.id;s.accountId=created.id;s.view="success";s.draft=null;
      }catch(error){s.step=1;throw error;}
      finally{payload.token="";}
    });
  }
  function connectionWizard() {
    const s=connectionsState,d=s.draft,p=connectionProviders[s.provider];
    const field=(label,input,help)=>h("label",{class:"connection-field"},h("span",{},label),input,help?h("small",{class:"muted"},help):null);
    let body;
    if(s.step===1)body=[
      h("p",{class:"connection-eyebrow"},"第一步 · 准备凭据"),h("h2",{},`为合己创建一个 ${p.name} 访问令牌`),
      h("p",{class:"muted"},"令牌是供合己使用的专用钥匙，不需要提供账号密码。当前使用令牌连接；网页登录授权尚未接入。"),
      h("ol",{class:"connection-guide"},s.provider==="github"?[
        h("li",{},"打开 GitHub 令牌创建页，选择资源所有者并设置有效期。"),
        h("li",{},"在 Repository access 中选择 Only select repositories，只勾选要使用的仓库。"),
        h("li",{},"读取 Issue：Issues → Read-only；读取 PR：Pull requests → Read-only；读取工作流：Actions → Read-only。仓库 Metadata 权限保持可读。"),
        h("li",{},"创建并复制令牌，回到这里粘贴。组织账号可能需要管理员批准。"),
      ]:[
        h("li",{},"打开 Cloudflare API Tokens，选择 Create Token，创建自定义令牌。"),
        h("li",{},"查看 DNS：Zone → Zone → Read 和 DNS → Read，范围只选对应域名。"),
        h("li",{},"查看 Workers 或 Pages：选择对应 Account 权限的 Read，并包含 Account Settings → Read，用于验证账号范围。"),
        h("li",{},"复制令牌，回到这里粘贴。此处支持用户 API Token。"),
      ]),
      h("div",{class:"connection-actions"},connectionLink(p.tokenUrl,"打开令牌创建页 ↗"),connectionLink(p.guideUrl,"官方指引 ↗")),
      field("访问令牌",h("input",{type:"password","aria-label":"访问令牌",value:connectionSecret,autocomplete:"off",spellcheck:"false",maxlength:4096,placeholder:"粘贴刚刚创建的 Token",oninput:ev=>{connectionSecret=ev.target.value;}})),
      h("p",{class:"muted small"},"不要将令牌发到会话中。验证后不回显；退出连接向导会清除未提交的令牌。"),
    ];
    else if(s.step===2)body=[
      h("p",{class:"connection-eyebrow"},"第二步 · 选择资源"),h("h2",{},s.provider==="github"?"允许访问哪些仓库？":"允许访问哪些账号或域名？"),
      field("账号名称",h("input",{type:"text","aria-label":"账号名称",value:d.label,maxlength:80,oninput:ev=>{d.label=ev.target.value;}}),"例如：个人 GitHub、工作用 Cloudflare。多个账号靠名称区分。"),
      s.provider==="cloudflare"?field("资源类型",h("select",{"aria-label":"资源类型",onchange:ev=>{d.resourceType=ev.target.value;}},h("option",{value:"account",selected:d.resourceType==="account"},"账号 · Workers / Pages"),h("option",{value:"zone",selected:d.resourceType==="zone"},"域名区域 · DNS"))):null,
      field(s.provider==="github"?"仓库网址或 owner/repo":"账号 ID 或区域 ID",h("input",{type:"text","aria-label":"添加资源",value:d.resourceInput,placeholder:s.provider==="github"?"https://github.com/owner/repo":"32 位 ID",autocapitalize:"off",spellcheck:"false",oninput:ev=>{d.resourceInput=ev.target.value;},onkeydown:ev=>{if(ev.key==="Enter"){ev.preventDefault();connectionAddResource();}}})),
      h("button",{class:"btn",type:"button",onclick:connectionAddResource},"添加资源"),
      s.provider==="cloudflare"?h("details",{},h("summary",{},"在哪里找到 ID？"),h("p",{class:"muted small"},"在 Cloudflare 控制台选择目标账号；账号首页可复制 Account ID。进入目标域名概览可复制 Zone ID。"),connectionLink("https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/","查看官方位置指引 ↗")):null,
      h("div",{class:"connection-resources","aria-label":"已添加资源"},d.resources.map((resource,index)=>h("div",{class:"connection-resource-row"},h("span",{},connectionResourceLabel(resource)),h("button",{class:"btn small",type:"button","aria-label":`移除 ${connectionResourceLabel(resource)}`,onclick:()=>{d.resources.splice(index,1);connectionRerender();}},"移除")))),
      h("p",{class:"connection-note"},"只允许访问你列出的资源。多个仓库或域名逐个添加，无需填写技术前缀。"),
    ];
    else body=[
      h("p",{class:"connection-eyebrow"},"第三步 · 验证连接"),h("h2",{},"核对范围后，验证并保存账号"),
      h("dl",{class:"connection-status"},h("dt",{},"服务"),h("dd",{},p.name),h("dt",{},"名称"),h("dd",{},d.label),h("dt",{},"允许访问"),h("dd",{},d.resources.map(r=>h("div",{},connectionResourceLabel(r))))),
      h("p",{class:"connection-note"},"验证将检查账号身份和每个资源的读取权限，不执行外部写入。具体功能的权限在实际调用时检查。"),
      h("p",{class:"muted small"},"连接用于平台外部能力工具，接入该工具的新会话可以使用。读取遵守当前授权规则；创建、修改、发布前仍需逐次确认。"),
    ];
    return h("div",{class:"connection-wizard"},h("div",{class:"connection-progress","aria-label":`连接进度：第 ${s.step} 步，共 3 步`},["准备凭据","选择资源","验证连接"].map((label,index)=>h("span",{class:index+1===s.step?"current":index+1<s.step?"done":"","aria-current":index+1===s.step?"step":null},`${index+1} ${label}`))),
      h("form",{class:"connection-form",onsubmit:ev=>{ev.preventDefault();if(s.step===3)void connectionSubmit();else connectionNext();}},
        connectionCard("连接 "+p.name,body),
        s.error?h("p",{role:"alert",class:"connection-error"},s.error," 账号名称与资源草稿仍保留。",s.step===1?"请重新输入令牌后继续。":""):null,
        h("div",{class:"connection-actions connection-wizard-actions"},h("button",{class:"btn",type:"button",disabled:s.busy,onclick:connectionHome},"取消"),s.step>1?h("button",{class:"btn",type:"button",disabled:s.busy,onclick:()=>{s.step--;s.error="";connectionRerender();}},"上一步"):null,h("button",{class:"btn primary",type:"submit",disabled:s.busy},s.busy?"验证中…":s.step===3?"验证并连接":"下一步"))));
  }
  function connectionServiceCards() {
    const s=connectionsState;
    return h("div",{class:"connection-service-grid"},Object.entries(connectionProviders).map(([id,p])=>{
      const accounts=s.connections.filter(c=>c.provider===id),live=accounts.filter(c=>c.status==="connected");
      return connectionCard("",[
        h("div",{class:"connection-service-head"},h("span",{class:`connection-service-mark ${id}`,"aria-hidden":"true"},p.mark),h("div",{},h("h2",{},p.name),h("p",{class:"muted small"},p.description))),
        h("p",{},p.value),h("p",{class:`connection-service-state${live.length?" connected":""}`},!s.loaded?"正在读取账号…":accounts.length?`${live.length} 个已连接${accounts.length>live.length?` · ${accounts.length-live.length} 个已断开`:""}`:"尚未添加账号"),
        h("div",{class:"connection-actions"},accounts.length?h("button",{class:"btn",disabled:s.busy,onclick:()=>{s.provider=id;s.accountId="";s.view="manage";s.error="";connectionRerender();}},"管理账号"):null,
          h("button",{class:"btn primary",disabled:s.busy||!s.loaded||s.loading,onclick:()=>connectionStart(id)},accounts.length?"添加另一个账号":`连接 ${p.name}`)),
      ]);
    }));
  }
  function connectionUseForm(c) {
    let resource=c.resources.length===1?c.resources[0]:"";
    const select=h("select",{"aria-label":`选择 ${c.label} 的资源`,onchange:ev=>{resource=ev.target.value;}},h("option",{value:"",disabled:true,selected:!resource},"选择本次要用的资源"),c.resources.map(r=>h("option",{value:r,selected:r===resource},connectionResourceLabel(r))));
    return h("div",{class:"connection-use-form"},select,h("button",{class:"btn primary",disabled:connectionsState.busy,onclick:()=>{
      if(!resource){select.focus();announce("请先选择本次使用的资源");return;}
      void connectionTry(c,resource);
    }},"去会话试用"));
  }
  function connectionTask(c,resource) {
    if(c.provider==="github")return "汇总这个仓库待处理的 Issue，并标注来源。";
    return resource.startsWith("zone:")?"查看这个域名区域当前的 DNS 记录。":"列出这个账号的 Pages 项目。";
  }
  function connectionReference(c,resource) {
    return `请通过平台外部能力工具，使用「${c.label}」（${connectionLabel(c.provider)} 账号：${c.account}，连接 ID：${c.id}），本次访问资源 ${resource}。如该账号或资源不可用，请说明原因，不要自动改用其他账号。`;
  }
  async function connectionTry(c,resource) {
    const s=connectionsState;if(s.busy)return;
    s.busy=true;connectionRerender();
    try{
      if(window.piRouteModules?.has?.("rt-new"))await window.piRouteModules.ensure("rt-new");
      if(typeof rtStartNewSession!=="function")throw new Error("NEW_SESSION_UNAVAILABLE");
      const reference=connectionReference(c,resource);
      rtStartNewSession(`${connectionTask(c,resource)}\n\n${reference}`);
    }catch{s.error="新建会话暂时无法打开，请重试。";}
    finally{s.busy=false;connectionRerender();}
  }
  function connectionManage() {
    const s=connectionsState,accounts=s.connections.filter(c=>c.provider===s.provider&&(!s.accountId||c.id===s.accountId));
    return h("div",{},h("div",{class:"connection-heading"},h("div",{},h("h2",{},s.view==="success"?"连接成功，现在试一句任务":connectionLabel(s.provider)+" 账号"),h("p",{class:"muted small"},"选择账号和资源后进入会话。只有验证过的状态才会显示为已验证。")),h("button",{class:"btn",onclick:connectionHome},"返回服务")),
      s.error?h("p",{class:"connection-error",role:"alert"},s.error):null,
      accounts.map(c=>connectionCard(c.label,[
        h("p",{class:"connection-account"},`${connectionLabel(c.provider)} · ${c.account}`),
        h("span",{class:`connection-state ${c.status==="connected"?"connected":""}`},c.status==="connected"?"账号与资源验证通过":c.status==="invalid"?"需要重新连接":"已断开"),
        h("p",{class:"muted small"},`最近验证：${when(c.verifiedAt)}`),
        h("div",{class:"connection-resources"},c.resources.map(r=>h("div",{class:"connection-resource-row"},connectionResourceLabel(r)))),
        h("p",{class:"connection-note"},"已验证账号身份及所选资源的基础读取权限。Issue、PR、DNS 等具体能力仍受令牌权限限制，创建与修改前需逐次确认。"),
        c.status==="connected"?connectionUseForm(c):null,
        h("details",{},h("summary",{},"可做什么？"),h("ul",{},s.catalog.filter(cap=>cap.provider===c.provider&&c.resources.some(r=>r.startsWith(cap.resourceKind+":"))).map(cap=>h("li",{},cap.title,cap.risk==="read"?" · 使用时检查读取权限":" · 使用时检查权限并逐次确认")))),
        h("div",{class:"connection-actions"},h("button",{class:"btn",disabled:s.busy,onclick:()=>connectionStart(c.provider,c)},c.status==="connected"?"更新令牌或资源":"重新连接"),h("a",{class:"btn",href:"#/settings/connectionaudit",onclick:()=>{s.filterConnection=c.id;}},"使用记录")),
        c.status==="connected"?h("details",{class:"connection-disconnect"},h("summary",{},"断开连接"),h("p",{class:"muted small"},"断开后，所有会话经平台网关发起的新调用立即停止，已发出的操作无法撤回。本机 gh / wrangler 登录不受影响。"),h("button",{class:"btn danger",disabled:s.busy,onclick:()=>{if(confirm(`断开「${c.label}」？经平台外部能力工具发起的新调用将停止。`))void connectionAction(async()=>{await api(`/api/capabilities/connections/${encodeURIComponent(c.id)}`,{method:"DELETE"});});}},"确认断开此账号")):null,
      ])),h("button",{class:"btn",disabled:s.busy,onclick:()=>connectionStart(s.provider)},"＋ 添加另一个账号"));
  }
  function connectionsSection() {
    const s=connectionsState;if(!s.loaded&&!s.loading)void loadConnections();
    if(s.view==="wizard")return connectionWizard();
    if(s.view==="manage"||s.view==="success")return connectionManage();
    return h("div",{class:"connections-view"},
      h("div",{class:"connection-heading"},h("div",{},h("h2",{},"连接常用服务，在会话里直接使用"),h("p",{class:"muted"},"选择服务 → 按步骤连接账号 → 试一句真实任务。")),h("button",{class:"btn small",disabled:s.loading||s.busy,onclick:()=>void loadConnections()},s.loading?"读取中…":"刷新")),
      h("nav",{class:"inpage-tabs connection-tabs","aria-label":"账号与工具分类"},[["services","服务与账号"],["tools","MCP 服务"]].map(([id,label])=>h("button",{type:"button",class:s.tab===id?"active":"","aria-pressed":s.tab===id,onclick:()=>{s.tab=id;s.error="";connectionRerender();}},label)),h("a",{href:"#/settings/connectionaudit"},"使用记录")),
      s.error?h("p",{role:"alert",class:"connection-error"},s.error):null,
      s.tab==="tools"?[
        connectionCard("运行时 MCP",[h("p",{},"MCP 为 AI 提供工具，不一定需要连接账号。平台内置服务随会话装配；运行时自己的配置与这里的账号连接分别管理。"),h("p",{class:"muted small"},"当前支持查看运行时已有配置。自定义服务的新增、编辑和启停尚未提供。"),h("a",{class:"btn",href:"#/runtimes"},"查看运行时配置")]),
        connectionCard("其他已有接入",s.legacy.length?s.legacy.map(x=>h("div",{class:"connection-legacy"},h("strong",{},x.name),h("p",{class:"muted small"},`${x.connected?"已连接":"未连接"} · ${x.detail}`))):[h("p",{class:"muted small"},"暂无其他接入记录。")]),
      ]:[connectionServiceCards(),h("p",{class:"connection-note"},"新会话会接入平台连接；当前运行时、权限模式或历史授权可能影响可用性。"),h("details",{},h("summary",{},"已经在电脑上登录过，为什么还要连接？"),h("p",{class:"muted small"},"本机 gh / wrangler 登录、运行时自带 MCP 和本页的账号连接属于不同来源。本页仅管理经平台外部能力工具发起的调用。"))]);
  }
  async function loadConnectionAudit() {
    const s=connectionsState;s.auditLoaded=true;
    const results=await Promise.allSettled([api("/api/capabilities/audit"),api("/api/capabilities/sessions")]);
    results.forEach((r,i)=>{if(r.status==="rejected")s.error=connectionError(r.reason);else if(i===0)s.audit=Array.isArray(r.value?.records)?r.value.records:[];else s.sessions=Array.isArray(r.value?.sessions)?r.value.sessions:[];});
    connectionRerender();
  }
  function connectionAuditSection() {
    const s=connectionsState;if(!s.loaded&&!s.loading)void loadConnections();if(!s.auditLoaded)void loadConnectionAudit();
    const connection=h("select",{"aria-label":"按连接筛选",onchange:ev=>{s.filterConnection=ev.target.value;connectionRerender();}},h("option",{value:""},"全部账号"),s.connections.map(c=>h("option",{value:c.id,selected:s.filterConnection===c.id},c.label)));
    const session=h("select",{"aria-label":"按会话筛选",onchange:ev=>{s.filterSession=ev.target.value;connectionRerender();}},h("option",{value:""},"全部会话"),s.sessions.map(x=>h("option",{value:x.id,selected:s.filterSession===x.id},x.title||x.id)));
    const names={"connection.connect":"连接成功","connection.disconnect":"断开连接","connection.verify":"验证账号","grant.create":"新增授权","grant.revoke":"撤销授权","approval.request":"请求确认","approval.decision":"确认决定",invoke:"使用能力"};
    const outcomes={connected:"已连接",disconnected:"已断开",succeeded:"成功",failed:"失败",denied:"已拒绝",pending:"等待确认",approved:"已确认",AUTH_FAILED:"凭据或权限无效",TIMEOUT:"请求超时"};
    const rows=s.audit.filter(a=>(!s.filterConnection||a.connectionId===s.filterConnection)&&(!s.filterSession||a.actor===s.filterSession));
    return h("div",{class:"connections-view"},connectionCard("使用记录",[h("p",{class:"muted small"},"记录账号、资源、操作和结果，不展示令牌与调用正文。"),h("div",{class:"connection-filters"},connection,session),h("div",{class:"connection-actions"},h("a",{class:"btn",href:"#/settings/enhancement"},"管理账号"),h("button",{class:"btn",onclick:()=>void loadConnectionAudit()},"刷新"))]),s.error?h("p",{role:"alert",class:"connection-error"},s.error):null,
      !rows.length?connectionCard("暂无记录",[h("p",{class:"muted"},"连接账号或使用能力后，记录会出现在这里。")]):null,
      rows.map(a=>connectionCard(names[a.event]||"连接操作",[h("p",{},s.catalog.find(c=>c.id===a.capabilityId)?.title||s.connections.find(c=>c.id===a.connectionId)?.label||"外部连接"),h("p",{class:"muted small"},`${outcomes[a.outcome]||(["grant.create","grant.revoke"].includes(a.event)?"已记录":a.outcome)} · ${when(a.at)}`),a.resource?h("p",{class:"small"},connectionResourceLabel(a.resource)):null,a.actor!=="platform-owner"?h("a",{class:"small",href:`#/rt/${encodeURIComponent(a.actor)}`},s.sessions.find(x=>x.id===a.actor)?.title||"查看会话"):null])));
  }
  window.addEventListener("hashchange",()=>{if(connectionsState.view==="wizard"&&!/^#\/settings\/(enhancement|connections)$/.test(location.hash)){connectionSecret="";connectionsState.draft=null;connectionsState.view="home";}});
  window.addEventListener("pagehide",()=>{connectionSecret="";if(connectionsState.view==="wizard")connectionsState.view="home";connectionsState.draft=null;});

  // Loaded on demand by the composer; selecting an account adds a visible request, never changes permissions.
  window.piConnections = {
    async openPicker(context,onSelect) {
      document.querySelector("dialog.connection-picker")?.close();
      const previous=document.activeElement;
      const dialog=h("dialog",{class:"connection-picker","aria-labelledby":"connection-picker-title"});
      const content=h("div",{class:"connection-picker-body"});
      const close=()=>dialog.close();
      dialog.append(h("div",{class:"connection-heading"},h("h2",{id:"connection-picker-title"},"选择账号与资源"),h("button",{class:"btn small",type:"button","aria-label":"关闭连接选择",onclick:close},"关闭")),content);
      window.addEventListener("hashchange",close);
      dialog.addEventListener("close",()=>{window.removeEventListener("hashchange",close);dialog.remove();if(previous?.isConnected)previous.focus();},{once:true});
      dialog.addEventListener("click",ev=>{if(ev.target===dialog){const rect=dialog.getBoundingClientRect();if(ev.clientX<rect.left||ev.clientX>rect.right||ev.clientY<rect.top||ev.clientY>rect.bottom)close();}});
      document.body.append(dialog);dialog.showModal();
      const management=()=>h("a",{class:"btn",href:"#/settings/enhancement",onclick:()=>{state().returnHash=location.hash;connectionHome();close();}},"连接或管理账号");
      const load=async()=>{
        content.replaceChildren(h("p",{class:"muted",role:"status"},"正在检查当前会话可用的连接…"));
        try{
          const query=new URLSearchParams(context);
          const data=await api(`/api/capabilities/availability?${query}`);
          if(!dialog.isConnected)return;
          if(!data.available){content.replaceChildren(h("p",{class:"connection-note",role:"status"},data.reason||"当前会话暂不可用"),h("a",{class:"btn primary",href:"#/rt/new",onclick:close},"新建会话"),management());return;}
          const connections=Array.isArray(data.connections)?data.connections:[];
          content.replaceChildren(h("p",{class:"muted small"},"选择本次要用的账号与资源，会在输入框中加入明确说明。不会修改会话权限，也不会自动发送。"));
          if(!connections.length)content.append(h("p",{class:"connection-note"},"还没有已连接的账号。先连接一个常用服务，再回到这里使用。"));
          for(const c of connections){
            let resource=c.resources.length===1?c.resources[0]:"";
            const selectedResource=h("p",{class:"connection-selected-resource muted small"},resource?connectionResourceLabel(resource):"请明确选择本次资源");
            const select=h("select",{"aria-label":`选择 ${c.label} 的资源`,onchange:ev=>{resource=ev.target.value;use.disabled=!resource;selectedResource.textContent=connectionResourceLabel(resource);}},h("option",{value:"",disabled:true,selected:!resource},c.resources.length?"选择资源":"当前会话没有可用的授权范围"),c.resources.map(r=>h("option",{value:r,selected:r===resource},connectionResourceLabel(r))));
            const use=h("button",{class:"btn primary",disabled:!resource,onclick:()=>{if(!resource)return;onSelect({connection:c,resource,reference:connectionReference(c,resource)});close();}},"使用此账号");
            content.append(connectionCard(c.label,[h("p",{class:"muted small"},`${connectionLabel(c.provider)} · ${c.account}`),select,selectedResource,h("div",{class:"connection-actions"},use)]));
          }
          content.append(management());
        }catch(error){if(dialog.isConnected)content.replaceChildren(h("p",{role:"alert",class:"connection-error"},connectionError(error)),h("button",{class:"btn",onclick:()=>void load()},"重试"),management());}
      };
      await load();
    },
  };

  const SECTION_VIEWS = {
    reply: replySection,
    memory: memorySection,
    capabilities: capabilitiesSection,
    navigation: navigationSection,
    collections: collectionsSection,
    apps: appsSection,
    runtimes: runtimesSection,
    skills: skillsSection,
    connections: connectionsSection,
    resources: resourcesSection,
    remote: remoteSection,
    theme: themeSection,
    selfheal: selfHealSection,
    scheduled: scheduledSection,
    runtimeupdates: runtimeUpdatesSection,
    version: versionSection,
    appversion: appVersionSection,
    // 二级页（不在目录里，只能从父页进入）
    connectionaudit: connectionAuditSection,
  };
  function sectionContent() {
    if (section() === "application") return applicationSection();
    if (installsRoute()) return installsSection();
    const view = SECTION_VIEWS[section()];
    return view ? view() : navigationSection();
  }

  function render() {
    const curSec = section();
    if (curSec === "application" || (curSec === "home" && state().lastRenderedSection && state().lastRenderedSection !== "home")) {
      state().activeGroup = "";
    }
    if(curSec!=="connections"&&connectionsState.view==="wizard"){connectionSecret="";connectionsState.draft=null;connectionsState.view="home";}
    state().lastRenderedSection = curSec;
    if (curSec !== "runtimeupdates") void loadRuntimeUpdatesSummary();
    // 回到这一页（含从详情返回）时隔一会儿重新读一次，进度和安排不会停在旧状态
    else if (Date.now() - (state().ruLoadedAt || 0) > 20_000) { state().ruLoadedAt = Date.now(); void loadRuntimeUpdates(); }
    if (section() !== "remote") { stopRemotePoll(); if (link.open) void closeLinkModal(); }
    if (section() !== "version" || installsRoute()) {
      historyObserver?.disconnect();
      historyObserver = null;
    }
    const root = rootSection();
    // 一级标签切回平台设置后，等目录挂载再定位到相邻的末组。
    if (curSec === "home" && scopeSwipeReturnGroup) {
      const group = scopeSwipeReturnGroup;
      requestAnimationFrame(() => {
        if (ui.view !== "settings" || section() !== "home" || scopeSwipeReturnGroup !== group) return;
        scopeSwipeReturnGroup = "";
        jumpToGroup(group);
      });
    }
    const page = h("section", { class: `settings-app ${root ? "settings-home" : "settings-detail"}`, "aria-label": "系统设置" },
      settingsHeader(),
      h("div", { class: "settings-app-body" },
        settingsNav(),
        h("main", { class: "settings-app-content", "data-keep-scroll": "settings-content" },
          root && phone.matches ? null : [managementTabs(), sectionContent()])));
    settingsHeadObserver?.disconnect();
    requestAnimationFrame(() => {
      if (!page.isConnected) return;
      const head = page.querySelector('.settings-app-head');
      const measure = () => page.style.setProperty('--settings-head-height', `${head.getBoundingClientRect().height}px`);
      measure();
      if (typeof ResizeObserver === 'function') {
        settingsHeadObserver = new ResizeObserver(measure);
        settingsHeadObserver.observe(head);
      }
    });
    return page;
  }

  /*
   * 手机设置目录按「智能球 ↔ 产物库 ↔ 基础 ↔ 应用设置」连续横滑。
   * 只认明显的横滑（横向位移 ≥ 64px 且大于纵向 1.5 倍）；详情页、控件与其它页签的手势不抢。
   * 设置是二级页，没有应用级横滑，所以不会和底栏导航的切换打架。
   */
  (function bindScopeSwipe() {
    let start = null, swipedAt = 0;
    // 新一次真实按下是主动点击，不能被上次横滑的防误触窗口吞掉。
    document.addEventListener("pointerdown", () => { swipedAt = 0; }, { passive: true });
    // 目录条目也在可滑范围内：横滑之后紧跟的那一次点击要吞掉，否则会顺手点进某一行。
    const IGNORE = "input, textarea, select, [contenteditable], dialog, .settings-switch, pre, table, iframe, [data-no-app-swipe]";
    document.addEventListener("touchstart", (event) => {
      start = null;
      if (!phone.matches || ui.view !== "settings" || !rootSection() || event.touches.length !== 1) return;
      if (!event.target?.closest?.(".settings-app")) return;
      if (event.target?.closest?.(IGNORE)) return;
      const tabs = event.target?.closest?.(".inpage-tabs");
      if (tabs && !tabs.matches(".settings-group-tabs, .settings-scope-tabs")) return;
      start = { x: event.touches[0].clientX, y: event.touches[0].clientY, section: section() };
    }, { passive: true });
    document.addEventListener("touchcancel", () => { start = null; }, { passive: true });
    document.addEventListener("touchend", (event) => {
      const from = start;
      start = null;
      if (!from || !phone.matches || ui.view !== "settings" || !rootSection() || from.section !== section() || event.touches.length) return;
      const touch = event.changedTouches?.[0];
      if (!touch) return;
      const dx = touch.clientX - from.x, dy = touch.clientY - from.y;
      if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const scope = section() === "application" ? "apps" : "platform";
      if (scope === "platform") {
        const index = GROUPS.findIndex((group) => group.id === activeGroup());
        const next = index + (dx < 0 ? 1 : -1);
        if (next < 0) return;
        if (next < GROUPS.length) jumpToGroup(GROUPS[next].id);
        else location.hash = "#/settings/application";
      } else if (dx > 0) {
        scopeSwipeReturnGroup = GROUPS[GROUPS.length - 1].id;
        location.hash = "#/settings";
      } else return;
      swipedAt = Date.now();
    }, { passive: true });
    document.addEventListener("click", (event) => {
      if (!swipedAt || Date.now() - swipedAt > 500) return;
      if (!event.target?.closest?.(".settings-nav-item, [data-settings-group-nav], [data-settings-scope], [data-settings-app]")) return;
      swipedAt = 0;
      event.preventDefault();
      event.stopPropagation();
    }, true);
  })();

  phone.addEventListener("change", () => { if (ui.view === "settings") { state().activeGroup = ""; renderMain(); } });

  if (window.piRouteModules && typeof window.piRouteModules.register === "function") {
    window.piRouteModules.register("settings", { render });
  }
})();
