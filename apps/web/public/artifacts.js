/* V3.9 产物：平台里"可以直接玩"的东西（目前是「小游戏」分类）。
 *
 * 加载：点开就用 iframe 装进控制台，小游戏自己注册 Service Worker，
 *       第一次打开后缓存到本机，断网也能玩。
 * 更新：沿用顶栏那套前端更新策略——服务端给出版本号（运行时文件的内容哈希），
 *       页面把它和上次玩过的版本比对，不一致就在右上角冒出「游戏更新」，
 *       点了才更新，不会打断正在进行的操作。
 */
(() => {
  const CACHE_PREFIX = "pi-artifact-seen:";
  const TAB_KEY = "pi-artifact-tab";
  const FILTER_KEY = "pi-artifact-mine-filter";
  const MINE_ID = "mine";
  const POLL_MS = 300000;
  const CHECK_MIN_MS = 30000;

  const STATE = { tab: "", mineFilter: null, panelOpen: false, catalog: null, collections: null, loading: false, error: "", applying: false, pending: null, dismissed: null, lastCheck: 0 };

  /* 正在播放的游戏播放层。iframe 一旦从文档里摘下再装回就会重新加载（游戏回到首页、对战画面丢失），
   * 所以同一次播放（同一个 src、播放层还在页面上）一律复用同一个节点，后台刷新也不重绘它。 */
  let livePlayer = null;
  const playerShown = () => !!(livePlayer && livePlayer.section.isConnected && typeof ui !== "undefined" && ui.view === "artifacts" && ui.artifactGame);
  /* 后台刷新（焦点回来 / 切后台回来 / 定时）只更新数据；播放页已经在显示时不重绘 */
  /* 分类面板里按住 / 拖动抓手时也不整页重绘（面板被换掉会打断拖动）；放手后下一次数据变化再补 */
  const panelBusy = () => !!document.querySelector(".artifact-category-directory.pressing, .artifact-category-directory.dragging");
  const repaint = () => { if (typeof ui !== "undefined" && ui.view === "artifacts" && !playerShown() && !panelBusy()) renderMain(); };

  const seenKey = (id) => CACHE_PREFIX + id;
  function seenVersion(id) { try { return localStorage.getItem(seenKey(id)); } catch { return null; } }
  function markSeen(id, version) { try { localStorage.setItem(seenKey(id), version); } catch { /* 隐私模式下忽略 */ } }

  /* 产物页顶部的分类 tab：选中的分类记在本机，从游戏/评测详情返回时仍停在原来的分类 */
  function savedTab() { try { return localStorage.getItem(TAB_KEY) || ""; } catch { return ""; } }
  function rememberTab(id) { STATE.tab = id; try { localStorage.setItem(TAB_KEY, id); } catch { /* 隐私模式下忽略 */ } }
  /* 当前分类：记住的那个还在目录里就用它，否则落到第一个分类（分类被下线 / 重命名时不会空白） */
  function activeCategory(list) {
    return list.find((category) => category.id === (STATE.tab || savedTab())) || list[0] || null;
  }

  const items = () => (STATE.catalog && STATE.catalog.items) || [];
  const findItem = (id) => items().find((item) => item.id === id) || null;
  const collections = () => STATE.collections || window.piArtifactCollect?.state?.() || { schema: 1, categories: [], items: [] };
  const collectionItems = () => collections().items || [];
  /* 用户分类直接与小游戏、评测并列；图片 / 视频 / 文档始终可见。 */
  const collectionCategories = () => (collections().categories || []).filter((c) => !c.parentId).map((c) => ({ ...c, kind: "collection", primaryId: c.id }));
  /* 没有「全部」页签：一级分类各自一页；还没打分类的产物放在最后的「未分类」页签（有才出现），不会丢。 */
  const uncategorizedItems = () => collectionItems().filter((item) => !(item.categoryIds || []).length);
  /* 「应用」放在最前：待办 / 通讯录 / 股票 / AI浏览器等内置应用也是产物；在这里（和小游戏卡片上）置顶，置顶的常驻导航的产物区。 */
  const APPS_CATEGORY = { id: "apps", name: "应用", kind: "apps" };
  const categories = () => [APPS_CATEGORY, ...(collections().catalogRefsSeen ? [] : ((STATE.catalog && STATE.catalog.categories) || [])), ...collectionCategories(), ...(uncategorizedItems().length ? [{ id: "uncategorized", name: "未分类", kind: "uncategorized" }] : [])];
  function catalogRefs(category, secondary = "") {
    if (category.kind === "uncategorized") return [];
    const tree = collections().categories || [];
    return tree.filter((c) => (secondary ? c.id === secondary : c.id === category.id || c.parentId === category.id)).flatMap((c) => c.catalogRefs || []);
  }
  const SECONDARIES = new Map();
  function secondaryRail(category, entries, onSelect) {
    const selected = SECONDARIES.get(category.id) || "";
    return h("div", { class: "artifact-secondary-row pm-filter-line", role: "group", "aria-label": "二级分类", "data-seg-key": "artifact-secondary:" + category.id },
      h("span", { class: "pm-filter-label" }, "二级"),
      [ { id: "", name: "全部" }, ...entries ].map((entry) => h("button", {
        type: "button", class: "artifact-filter-chip" + (selected === entry.id ? " active" : ""),
        "aria-pressed": String(selected === entry.id), onclick: () => { SECONDARIES.set(category.id, entry.id); onSelect(); },
      }, entry.name, entry.count != null ? h("span", { class: "pm-chip-count" }, String(entry.count)) : null)));
  }

  /** 当前一级分类的二级行：和页签条放在同一个固顶块里（记忆页的两行筛选也是整块一起），滚动时内容不会从它们中间穿过去。 */
  function subRail(category) {
    if (!category || category.kind === "apps" || category.kind === "eval" || category.kind === "uncategorized") return null;
    if (category.kind === "collection") {
      const api = window.piArtifactCollect;
      const children = (collections().categories || []).filter((c) => c.parentId && c.parentId === category.primaryId);
      if (SECONDARIES.get(category.id) && !children.some((c) => c.id === SECONDARIES.get(category.id))) SECONDARIES.delete(category.id);
      if (!children.length) return null;
      const scoped = collectionItems().filter((item) => api?.matchesCategory(item, category.primaryId));
      return secondaryRail(category, children.map((c) => ({ ...c, count: scoped.filter((item) => api?.matchesCategory(item, c.id)).length + (c.catalogRefs || []).length })), repaint);
    }
    return secondaryRail(category, items().filter((item) => item.category === category.id).map((item) => ({ id: item.id, name: item.name })), repaint);
  }

  async function loadArtifacts({ force = false } = {}) {
    // app.js 未执行时全局 ui 不存在：直接记录并返回，不能让未捕获的 rejection 掩盖
    // 真正的资源错误（诊断 f0f4421f56e9e4618）。重试由页面刷新触发。
    if (typeof ui === "undefined") { STATE.loading = false; STATE.error = "页面未完整加载，请刷新重试"; return; }
    if (ui.view !== "artifacts" || document.visibilityState === "hidden" || STATE.loading) return;
    if (STATE.catalog && !force) return;
    if (force && Date.now() - STATE.lastCheck < CHECK_MIN_MS) return;
    STATE.loading = true; STATE.error = "";
    repaint();
    try {
      const [catalog, collections] = await Promise.all([
        api("/api/artifacts"),
        window.piArtifactCollect ? window.piArtifactCollect.load({ force }).catch(() => STATE.collections) : Promise.resolve(STATE.collections),
      ]);
      STATE.catalog = catalog;
      // 分类脚本可能比目录接口晚一步就绪：再取一次，别让用户分类等到下次轮询才出现。
      STATE.collections = collections || STATE.collections || (window.piArtifactCollect ? await window.piArtifactCollect.load().catch(() => null) : null);
      STATE.lastCheck = Date.now();
    }
    catch (error) { STATE.error = error?.message || "加载失败"; }
    finally {
      STATE.loading = false;
      repaint();
      syncTrigger();
    }
  }

  /* 本地玩过、但服务端版本已经变了的产物 */
  function outdated() {
    return items().filter((item) => { const local = seenVersion(item.id); return !!local && local !== item.version; });
  }

  /* ------------------------------ 顶栏更新提示 ------------------------------ */
  const make = (tag, text, cls) => { const el = document.createElement(tag); if (text) el.textContent = text; if (cls) el.className = cls; return el; };
  const button = (text, cls) => { const el = make("button", text, cls); el.type = "button"; return el; };

  const trigger = button("游戏更新", "btn small pwa-update-trigger artifact-update-trigger");
  trigger.hidden = true;
  trigger.setAttribute("aria-label", "小游戏有新版本，查看更新");
  trigger.setAttribute("popovertarget", "artifact-update-panel");
  const panel = make("aside", "", "pwa-update-panel");
  panel.id = "artifact-update-panel";
  panel.setAttribute("popover", "auto");
  panel.setAttribute("aria-label", "小游戏更新");
  const heading = make("strong", "小游戏更新");
  const status = make("p", "", "");
  status.setAttribute("role", "status");
  const confirmUpdate = button("立即更新", "btn primary");
  const later = button("稍后", "btn");
  const actions = make("div", "", "pwa-update-actions");
  actions.append(confirmUpdate, later);
  panel.append(heading, status, actions);
  const closePanel = () => { panel.hidePopover?.(); if (!panel.showPopover) panel.hidden = true; };

  function toast(text) {
    window.piToast(text);
  }

  function syncTrigger() {
    const list = outdated();
    const candidate = STATE.pending || list.find((item) => item.id !== STATE.dismissed) || null;
    trigger.hidden = !STATE.applying && !candidate;
    heading.textContent = candidate ? "小游戏更新 · " + candidate.name : "小游戏更新";
    status.textContent = STATE.applying
      ? "正在把新版本缓存到本机…"
      : candidate
        ? "服务端有新版本（" + candidate.version + "）。更新后本机缓存换成新版，断网时也能玩到新内容。"
        : "";
    confirmUpdate.textContent = STATE.applying ? "正在更新…" : "立即更新";
    confirmUpdate.disabled = STATE.applying || !candidate;
    later.hidden = STATE.applying;
    return { candidate, list };
  }

  const artifactScope = (item) => new URL(item.entry || "/games/" + item.id + "/", location.origin).pathname;

  /**
   * 直接让小游戏自己的 Service Worker 按最新清单重建缓存。
   * 只发 postMessage 给页面是不够的：旧页面的代码可能根本没有「问 SW 要新版本」这一步，
   * 而且浏览器对 sw.js 的更新检查会被节流（最长 24 小时），于是发版后手机一直用旧页面。
   * 守在这里重建成 buff，页面一重载就是新版。
   */
  async function syncArtifactCache(item, timeoutMs = 6000) {
    if (!("serviceWorker" in navigator)) return false;
    let registrations = [];
    try { registrations = await navigator.serviceWorker.getRegistrations(); } catch { return false; }
    const scope = artifactScope(item);
    const reg = registrations.find((r) => { try { return new URL(r.scope).pathname === scope; } catch { return false; } });
    const worker = reg && (reg.active || reg.waiting);
    if (!worker) return false;
    let settled = false;
    const done = new Promise((resolve) => {
      const finish = () => { if (!settled) { settled = true; resolve(true); } };
      const timer = setTimeout(finish, timeoutMs);
      const listener = (event) => {
        if (event.data && event.data.type === "version-synced") { clearTimeout(timer); navigator.serviceWorker.removeEventListener("message", listener); finish(); }
      };
      navigator.serviceWorker.addEventListener("message", listener);
    });
    try { worker.postMessage({ type: "sync-version" }); } catch { return false; }
    return done;
  }

  async function applyUpdate(item) {
    if (!item || STATE.applying) return;
    STATE.applying = true; STATE.pending = item; syncTrigger();
    try {
      // 先让 SW 把缓存换成新版（旧页面没有这个能力也照样生效），再让页面重载。
      const synced = await syncArtifactCache(item);
      const frame = document.querySelector(".artifact-frame");
      frame?.contentWindow?.postMessage({ type: "pi-artifact-update" }, location.origin);
      await new Promise((resolve) => setTimeout(resolve, synced ? 800 : 1500));
      markSeen(item.id, item.version);
      toast(item.name + " 已更新到新版本");
    } catch {
      toast("更新失败，可以稍后重试");
    } finally {
      STATE.applying = false; STATE.pending = null; syncTrigger();
      repaint();
    }
  }

  /* ------------------------------ 页面 ------------------------------ */
  function artifactEntry(item) { return item.entry || "/games/" + item.id + "/"; }

  /* 点开就是全屏：先在这次点击里请求浏览器全屏（iPhone 不支持也没关系，下面的沉浸层照样铺满屏幕），
   * 再切路由渲染沉浸式播放层。退出按钮在游戏自己的顶栏里（postMessage 通知这里）。 */
  const IMMERSIVE_RE = /^#\/artifacts\/(?!evals\/)[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;
  let wentFullscreen = false;

  function enterGame(item) {
    const root = document.documentElement;
    if (document.fullscreenEnabled && !document.fullscreenElement && root.requestFullscreen) {
      root.requestFullscreen({ navigationUI: "hide" }).then(() => { wentFullscreen = true; }).catch(() => { /* 用户拒绝或不支持：沉浸层照样铺满 */ });
    }
    location.hash = "#/artifacts/" + item.category + "/" + item.id;
  }

  function exitGame() {
    window.piOrientation?.restorePortrait();
    if (wentFullscreen && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    wentFullscreen = false;
    if (IMMERSIVE_RE.test(location.hash)) location.hash = "#/artifacts";
  }

  /* 离开播放页（返回键、点别的导航）时收起沉浸层与全屏 */
  function syncImmersive() {
    const on = IMMERSIVE_RE.test(location.hash);
    document.body.classList.toggle("artifact-immersive", on);
    if (!on && wentFullscreen && document.fullscreenElement) { void document.exitFullscreen().catch(() => {}); wentFullscreen = false; }
  }

  /* 置顶开关：置顶的应用常驻导航「产物区」；没置顶的，最近打开的 1 个会临时出现在产物区末尾。 */
  function pinButton(pinned, name, onToggle) {
    return h("button", { class: "btn small artifact-pin" + (pinned ? " on" : ""), type: "button", "aria-pressed": String(pinned), title: pinned ? "取消置顶（从导航产物区移除）" : "置顶到导航产物区", "aria-label": (pinned ? "取消置顶 " : "置顶 ") + name, onclick: onToggle }, pinned ? "已置顶" : "置顶");
  }
  function renderApps() {
    const nav = window.piNav;
    const apps = nav ? nav.apps() : [];
    return h("section", { class: "artifact-section", "aria-label": "应用", role: "tabpanel", id: "artifact-panel" },
      h("div", { class: "artifact-section__head" },
        h("span", { class: "muted small" }, "待办、通讯录、股票等内置应用都是产物。置顶的常驻在导航的产物区，最近打开的 1 个会临时出现在末尾；小游戏在「小游戏」分类里同样可以置顶。")),
      apps.length
        ? h("div", { class: "artifact-grid artifact-app-grid" }, apps.map((app) => h("div", { class: "card artifact-card artifact-app-card", "data-app-id": app.id },
          h("button", { class: "artifact-card__open", type: "button", "aria-label": "打开 " + app.name, onclick: () => { location.hash = "#/" + app.id; } },
            h("span", { class: "artifact-card__emoji artifact-app-icon", "aria-hidden": "true" }, app.icon || ""),
            h("span", { class: "artifact-card__name" }, app.name),
            h("span", { class: "artifact-card__summary muted small" }, app.title)),
          h("span", { class: "artifact-card__foot" },
            h("span", { class: "artifact-card__actions" },
              h("button", { class: "btn small primary", type: "button", onclick: () => { location.hash = "#/" + app.id; } }, "打开"),
              pinButton(app.pinned, app.name, () => nav.setAppPinned(app.id, !app.pinned)))))))
        : h("p", { class: "card muted small", role: "status" }, "暂时没有可用的应用。"));
  }
  if (window.piNav) window.piNav.onChange(() => repaint());

  function renderCard(item) {
    const local = seenVersion(item.id);
    const stale = !!local && local !== item.version;
    return h("div", { class: "card artifact-card" },
      h("button", { class: "artifact-card__open", type: "button", "aria-label": "全屏打开 " + item.name, onclick: () => enterGame(item) },
        h("span", { class: "artifact-card__emoji", "aria-hidden": "true" }, item.emoji),
        h("span", { class: "artifact-card__name" }, item.name),
        h("span", { class: "artifact-card__summary muted small" }, item.summary),
        h("span", { class: "artifact-card__tags" }, item.tags.map((tag) => h("span", { class: "artifact-tag" }, tag)))),
      h("span", { class: "artifact-card__foot" },
        h("span", { class: "muted small" }, local ? (stale ? "有新版本 " + item.version : "已缓存 " + item.version) : "还没玩过"),
        stale ? h("span", { class: "artifact-badge" }, "可更新") : null,
        h("span", { class: "artifact-card__actions" },
          h("button", { class: "btn small primary", type: "button", onclick: () => enterGame(item) }, "▶ 全屏玩"),
          window.piNav ? pinButton(window.piNav.gamePinned(item.id), item.name, () => window.piNav.setGamePinned(item, !window.piNav.gamePinned(item.id))) : null,
          // 带孩子隐私数据的产物（错题本）不提供分享
          item.private ? null : h("button", { class: "btn small", type: "button", onclick: () => openShareDialog(item) }, "分享"),
          h("a", { class: "btn small", href: artifactEntry(item), target: "_blank", rel: "noopener" }, "新窗口"))));
  }

  function renderPlayer(item) {
    const src = artifactEntry(item);
    window.navNoteGame?.(item);   // 没置顶的小游戏：作为「最近打开」临时出现在导航产物区
    if (livePlayer && livePlayer.src === src && livePlayer.section.isConnected) return livePlayer.section;
    // Only an actually opened artifact is a visit. Older APKs reject this optional narrow capability harmlessly.
    if (window.piAndroidShell?.available) void window.piAndroidShell.call("widget.visit", {
      id: item.id, category: item.category, name: item.name, emoji: item.emoji || "▣"
    }).catch(() => {});
    // 打开的是旧缓存版本：顺手让小游戏自己的 SW 把缓存换成新版，下次进来就是新页面（不打断这一局）。
    const cached = seenVersion(item.id);
    if (cached && cached !== item.version) void syncArtifactCache(item);
    // 沉浸式播放层：铺满整个视口，盖住控制台顶栏和底部导航
    // 错题本的「拍照」要在页面里直接出取景画面（getUserMedia），同源 iframe 要显式放行 camera
    const allow = item.id === "wrong-book" ? "fullscreen; autoplay; camera" : "fullscreen; autoplay";
    const player = h("section", { class: "artifact-player artifact-player--immersive", "aria-label": item.name },
      h("iframe", { class: "artifact-frame", src, title: item.name, allow, loading: "eager" }),
      // 兜底退出：旧版本游戏（缓存里还没有"退出"按钮）时才显示；新版游戏加载后会通知这里收起
      h("button", { class: "artifact-exit", type: "button", "aria-label": "退出全屏", onclick: exitGame }, "✕ 退出"));
    livePlayer = { src, section: player };
    return player;
  }

  /* ------------------------------ 分享链接 ------------------------------
   * 分享给控制台之外的人：对方只能打开这一个产物，需要输入这里设定的密码；
   * 输对后链接绑定那台设备，转发给别人也打不开（可在这里重置设备或撤销）。 */
  const SHARE_EXPIRY = [["7", "7 天"], ["30", "30 天"], ["90", "90 天"], ["", "不限"]];
  const SHARE_DEVICES = [["1", "1 台"], ["2", "2 台"], ["3", "3 台"]];

  async function copyText(text, btn) {
    const old = btn.textContent;
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement("textarea");
        ta.value = text; ta.setAttribute("readonly", ""); ta.className = "rt-copy-buffer";
        document.body.append(ta); ta.select();
        try { if (!document.execCommand("copy")) throw new Error("copy failed"); } finally { ta.remove(); }
      }
      btn.textContent = "✓ 已复制";
    } catch { btn.textContent = "复制失败"; }
    setTimeout(() => { btn.textContent = old; }, 1500);
  }

  function randomPassword() {
    const digits = new Uint32Array(1);
    crypto.getRandomValues(digits);
    return String(digits[0] % 1000000).padStart(6, "0");
  }

  const fmtTime = (iso) => { if (!iso) return ""; const d = new Date(iso); return (d.getMonth() + 1) + "-" + String(d.getDate()).padStart(2, "0") + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };

  function openShareDialog(item) {
    const dialog = h("dialog", { class: "share-dialog", "aria-label": "分享 " + item.name, onclose: () => dialog.remove() });
    dialog.addEventListener("click", (ev) => { if (ev.target === dialog) dialog.close(); });
    const state = { shares: null, error: "", created: null, busy: false };
    const password = h("input", { type: "text", name: "share-password", value: randomPassword(), maxlength: "64", autocomplete: "off", spellcheck: "false", required: true });
    const label = h("input", { type: "text", name: "share-label", maxlength: "40", placeholder: "例如：小宇妈妈", autocomplete: "off" });
    const expiry = h("select", { name: "share-expiry" }, SHARE_EXPIRY.map(([v, t]) => h("option", { value: v, ...(v === "30" ? { selected: true } : {}) }, t)));
    const devices = h("select", { name: "share-devices" }, SHARE_DEVICES.map(([v, t]) => h("option", { value: v }, t)));
    const body = h("div", { class: "share-dialog__body" });

    async function refresh() {
      try { state.shares = (await api("/api/artifact-shares?artifact=" + encodeURIComponent(item.id))).shares; state.error = ""; }
      catch (error) { state.error = error?.message || "读取分享失败"; }
      draw();
    }

    async function act(share, action, confirmText) {
      if (confirmText && !confirm(confirmText)) return;
      try { await api("/api/artifact-shares/" + encodeURIComponent(share.id) + "/" + action, { method: "POST", body: "{}" }); }
      catch (error) { state.error = error?.message || "操作失败"; }
      await refresh();
    }

    async function create(ev) {
      ev.preventDefault();
      if (state.busy) return;
      state.busy = true; state.error = ""; draw();
      try {
        const res = await api("/api/artifact-shares", { method: "POST", body: JSON.stringify({
          artifactId: item.id, password: password.value.trim(), label: label.value.trim(),
          expiresInDays: expiry.value ? Number(expiry.value) : null, maxDevices: Number(devices.value),
        }) });
        state.created = { share: res.share, password: password.value.trim() };
        password.value = randomPassword(); label.value = "";
      } catch (error) { state.error = error?.message || "生成失败"; }
      state.busy = false;
      await refresh();
    }

    function shareRow(share) {
      const status = share.status === "active" ? "有效" : share.status === "revoked" ? "已撤销" : "已过期";
      const meta = [
        "设备 " + share.devices.length + "/" + share.maxDevices,
        "打开 " + share.opens + " 次",
        share.lastOpenAt ? "最近 " + fmtTime(share.lastOpenAt) : "还没打开过",
        share.expiresAt ? "到期 " + fmtTime(share.expiresAt) : "不限期",
      ].join(" · ");
      const link = share.inviteUrl || share.url;
      const copyBtn = h("button", { class: "btn small", type: "button", onclick: (ev) => copyText(link, ev.currentTarget) }, "复制链接");
      return h("li", { class: "share-row share-row--" + share.status },
        h("div", { class: "share-row__head" },
          h("strong", {}, share.label || "未备注"),
          h("span", { class: "share-status share-status--" + share.status }, status),
          h("span", { class: "muted small" }, "创建于 " + fmtTime(share.createdAt))),
        h("div", { class: "muted small" }, meta),
        h("div", { class: "muted small" }, share.inviteUrl ? "复制的链接里带着密码，对方打开点一下「进入」就行" : "这条链接没存密码，要带密码请重新生成一条"),
        share.blockedDevices ? h("div", { class: "share-warn small" }, "⚠ 有 " + share.blockedDevices + " 次在其他设备上输对了密码但被拦下（链接可能被转发了）") : null,
        h("div", { class: "share-row__actions" },
          share.status === "active" ? [
            copyBtn,
            share.devices.length ? h("button", { class: "btn small", type: "button", onclick: () => act(share, "reset-devices", "重置后，已绑定的设备需要重新输入密码，先输对的设备重新占用名额。确定吗？") }, "重置设备") : null,
            h("button", { class: "btn small danger", type: "button", onclick: () => act(share, "revoke", "撤销后这个链接立刻失效，不能恢复。确定吗？") }, "撤销"),
          ] : h("button", { class: "btn small", type: "button", onclick: () => act(share, "delete") }, "删除记录")));
    }

    function draw() {
      const created = state.created;
      const invite = created && (created.share.inviteUrl || created.share.url);
      const createdBox = created ? h("div", { class: "share-created", role: "status" },
        h("strong", {}, "邀请链接已生成"),
        h("code", { class: "share-created__url" }, invite),
        h("div", { class: "share-created__pw" }, "密码：", h("b", {}, created.password)),
        h("div", { class: "share-row__actions" },
          h("button", { class: "btn small primary", type: "button", onclick: (ev) => copyText(item.name + "：" + invite + "\n（只能在 " + created.share.maxDevices + " 台设备上打开，请不要转发）", ev.currentTarget) }, "复制链接")),
        h("p", { class: "muted small" }, "密码已经放在链接里，对方打开点一下「进入」就进来了；密码也记在本机，随时能在下面再复制这条链接。")) : null;
      const list = state.shares === null
        ? h("p", { class: "muted small", role: "status" }, "正在读取…")
        : state.shares.length
          ? h("ul", { class: "share-list" }, state.shares.map(shareRow))
          : h("p", { class: "muted small" }, "还没有分享过。");
      body.replaceChildren(...[
        h("form", { class: "share-form", onsubmit: create },
          h("label", {}, h("span", {}, "访问密码"), h("div", { class: "share-form__pw" }, password,
            h("button", { class: "btn small", type: "button", onclick: () => { password.value = randomPassword(); } }, "换一个"))),
          h("label", {}, h("span", {}, "给谁（备注，可不填）"), label),
          h("div", { class: "share-form__row" },
            h("label", {}, h("span", {}, "有效期"), expiry),
            h("label", {}, h("span", {}, "可用设备"), devices)),
          h("p", { class: "muted small" }, "链接里会带上这个密码：对方打开后密码框已经填好，点「进入」才登录。输对后链接和那台设备绑定（最多「可用设备」台），转发给别人也打不开；对方看不到控制台，也不能再分享。你自己打开也会占用设备名额，可以随时重置。"),
          state.error ? h("p", { class: "field-error", role: "alert" }, state.error) : null,
          h("button", { class: "btn primary", type: "submit", disabled: state.busy }, state.busy ? "正在生成…" : "生成分享链接")),
        createdBox,
        h("h3", { class: "share-dialog__sub" }, "已分享的链接"),
        list].filter(Boolean));
    }

    dialog.append(
      h("header", { class: "share-dialog__head" },
        h("strong", {}, "分享 " + item.emoji + " " + item.name),
        h("button", { class: "btn small", type: "button", onclick: () => dialog.close() }, "关闭")),
      body);
    draw();
    document.body.append(dialog);
    dialog.showModal();
    void refresh();
  }

  const artifactPageHead = () => h("div", { class: "artifact-section__head artifact-page-head" }, h("h1", {}, "全部产物"),
    h("button", { type: "button", class: "btn small ghost artifact-cat-manage", onclick: () => window.piArtifactCategoryBrowser?.openManager?.() }, "管理分类"));

  function syncCollections() {
    STATE.collections = window.piArtifactCollect?.state?.() || STATE.collections;
    repaint();
  }

  /* 「我的」里的筛选：""=全部，"uncategorized"=没打分类，其余是分类 id（一级含它下面所有二级）。记在本机。 */
  function savedFilter() { try { return localStorage.getItem(FILTER_KEY) || ""; } catch { return ""; } }
  function mineFilter() {
    const value = STATE.mineFilter ?? savedFilter();
    const api = window.piArtifactCollect;
    if (value === "uncategorized") return collectionItems().some((item) => !(item.categoryIds || []).length) ? value : "";
    return value && api?.categoryById(value) ? value : "";
  }
  function setMineFilter(value) {
    STATE.mineFilter = value;
    try { localStorage.setItem(FILTER_KEY, value); } catch { /* 隐私模式下忽略 */ }
  }
  function mineFilterLabel(value) {
    const api = window.piArtifactCollect;
    if (!value) return "全部分类";
    if (value === "uncategorized") return "未分类";
    const category = api?.categoryById(value);
    if (!category) return "全部分类";
    const parent = category.parentId ? api.categoryById(category.parentId) : null;
    return parent ? `${parent.name} / ${category.name}` : category.name;
  }
  function collectionItemsFor(value) {
    const list = collectionItems();
    if (!value) return list;
    if (value === "uncategorized") return list.filter((item) => !(item.categoryIds || []).length);
    return list.filter((item) => window.piArtifactCollect.matchesCategory(item, value));
  }

  function collectionThumb(item) {
    if (item.kind === "document" && item.source.type === "file" && typeof docThumbChip === "function") {
      const ref = { ...window.piArtifactCollect.sourceRef(item.source), label: item.title };
      const card = docThumbChip(ref, { sessionId: item.source.sessionId, artifactSource: item.source }, /\.html?$/i.test(ref.path) ? "html" : "md", "document");
      card.classList.add("artifact-document-preview");
      return card;
    }
    if (item.kind === "video") return h("span", { class: "artifact-collection-thumb", "aria-hidden": "true" }, "▶");
    const url = window.piArtifactCollect?.itemUrl?.(item, "view") || window.piArtifactCollect?.sourceUrl?.(item.source, "view");
    const box = h("span", { class: "artifact-collection-thumb" });
    if (!url) return box;
    const img = h("img", { src: url, alt: "", loading: "lazy", decoding: "async" });
    img.addEventListener("error", () => box.replaceChildren(h("span", { class: "artifact-preview-missing muted small" }, "预览暂不可用", h("br"), "点开查看说明")), { once: true });
    box.append(img);
    return box;
  }

  function collectionDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" }).format(d);
  }

  function renderCollectionCard(item, list) {
    const kind = window.piArtifactCollect?.kindLabel?.(item.kind) || "产物";
    const open = () => openCollectionItem(item, list);
    const caption = h("span", { class: "artifact-collection-caption" },
      h("span", { class: "artifact-collection-title" }, item.title),
      h("span", { class: "artifact-collection-meta" }, kind, item.updatedAt ? " · " + collectionDate(item.updatedAt) : ""));
    // 文档缩略图自身是可聚焦按钮，避免嵌套按钮；标题也可打开同一预览。
    if (item.kind === "document") return h("article", { class: "card artifact-collection-card" }, collectionThumb(item),
      h("button", { class: "artifact-collection-open", type: "button", onclick: open, "aria-label": `浏览 ${item.title}` }, caption));
    return h("article", { class: "card artifact-collection-card" },
      h("button", { class: "artifact-collection-open", type: "button", "aria-label": `浏览 ${item.title}`, onclick: open }, collectionThumb(item), caption));
  }

  /** 图片在现有放大器里浏览同分类的前后项；视频 / 文档沿用文件预览半屏。 */
  function openCollectionItem(item, list) {
    if (!window.piArtifactCollect) return;
    if (item.kind === "image") {
      const media = list.filter((entry) => entry.kind === "image");
      const index = Math.max(0, media.indexOf(item));
      const entries = media.map((entry) => ({
        src: window.piArtifactCollect.itemUrl(entry, "view"),
        original: window.piArtifactCollect.itemUrl(entry),
        name: entry.title,
        key: entry.source.eventKey,
        seq: entry.source.eventSeq,
        artifactItem: entry,
      }));
      if (entries.length && typeof openImageZoom === "function") {
        openImageZoom(entries, index, {
          closeOnNavigate: true,
          artifactMode: true,
          onLocate: (entry) => window.piArtifactCollect.returnToSession(entry.artifactItem || entry),
          locateAlways: true,
          locateLabel: "回到会话",
          tagControl: (entry, helpers) => window.piArtifactCollect.control({
            item: entry.artifactItem,
            kind: "image",
            title: entry.name || entry.artifactItem?.title || "",
            source: (entry.artifactItem || entry).source,
            variant: "dark",
            compact: true,
            capture: helpers?.capture,
            onDone: syncCollections,
          }),
        });
        return;
      }
    }
    const ref = window.piArtifactCollect.sourceRef?.(item.source);
    if (!ref || typeof openFilePreview !== "function") { toast("这个产物暂时打不开（原会话文件可能已删除）"); return; }
    openFilePreview(ref, { sessionId: item.source.sessionId, artifactSource: item.source }, null);
  }

  /** 只重画「我的」这一块（展开 / 收起分类面板、选了分类）；整页重绘会把 tab 条的滚动和动画一起带掉。 */
  function refreshMine() {
    const body = document.querySelector(".artifact-swipe");
    const current = activeCategory(categories());
    if (!body || !body.isConnected || current?.id !== MINE_ID) { repaint(); return; }
    // 切 tab 的滑入动画带 transform：它会让 position:fixed 的手机浮层相对这块区域定位，先收掉
    body.classList.remove("artifact-slide-from-right", "artifact-slide-from-left");
    body.replaceChildren(renderCollectionCategory(current));
  }

  function setPanel(open) {
    if (STATE.panelOpen === open) return;
    STATE.panelOpen = open;
    if (open) window.piArtifactCategoryBrowser?.reset({ editing: false });
    refreshMine();
  }

  function renderCollectionCategory(category) {
    const api = window.piArtifactCollect;
    const children = (collections().categories || []).filter((c) => c.parentId && c.parentId === category.primaryId);
    if (SECONDARIES.get(category.id) && !children.some((c) => c.id === SECONDARIES.get(category.id))) SECONDARIES.delete(category.id);
    const secondary = SECONDARIES.get(category.id) || "";
    const scoped = category.kind === "uncategorized" ? uncategorizedItems() : collectionItems().filter((item) => api?.matchesCategory(item, category.primaryId));
    const owned = secondary ? scoped.filter((item) => api?.matchesCategory(item, secondary)) : scoped;
    const refs = catalogRefs(category, secondary);
    const games = items().filter((item) => refs.includes("game:" + item.id));
    const evalIds = refs.filter((ref) => ref.startsWith("eval:")).map((ref) => ref.slice(5));
    const count = owned.length + games.length + evalIds.length;
    return h("section", { class: "artifact-section", "aria-label": category.name, role: "tabpanel", id: "artifact-panel" },
      h("div", { class: "artifact-section__head" }, h("span", { class: "muted small" }, `${count} 项`)),
      owned.length ? h("div", { class: "artifact-collection-grid" }, owned.map((item) => renderCollectionCard(item, owned))) : null,
      games.length ? h("div", { class: "artifact-grid" }, games.map(renderCard)) : null,
      evalIds.length ? window.piEvalArtifacts?.renderSection({ name: "评测产物", description: "" }, { suiteIds: evalIds, hideFilter: true }) : null,
      !count ? h("p", { class: "card muted small", role: "status" }, "这个分类下还没有产物。") : null);
  }

  function renderArtifacts() {
    if (!STATE.collections && window.piArtifactCollect && !STATE.loading) {
      void window.piArtifactCollect.load().then((data) => { STATE.collections = data; repaint(); }).catch(() => {});
    }
    if (ui.artifactEval) {
      const linked = (collections().categories || []).find((c) => (c.catalogRefs || []).includes("eval:" + ui.artifactEval.suite));
      rememberTab(linked ? linked.parentId || linked.id : "evals");
    }
    if (ui.artifactEval) return window.piEvalArtifacts ? window.piEvalArtifacts.renderRoute(ui.artifactEval) : h("section", { class: "card" }, h("p", { role: "status" }, "正在加载评测产物…"));
    if (!STATE.catalog && !STATE.loading) void loadArtifacts();
    const open = ui.artifactGame;
    if (open) {
      const item = findItem(open.id);
      if (!item) {
        return h("section", { class: "card" },
          h("p", { class: "field-error", role: "alert" }, STATE.loading ? "正在加载…" : "没有这个产物。"),
          h("button", { class: "btn", type: "button", onclick: () => { location.hash = "#/artifacts"; } }, "返回产物"));
      }
      return renderPlayer(item);
    }
    if (STATE.error) {
      return h("section", { class: "artifacts-page" }, artifactPageHead(),
        h("div", { class: "card" },
          h("p", { class: "field-error", role: "alert" }, "产物加载失败：" + STATE.error),
          h("button", { class: "btn", type: "button", onclick: () => { void loadArtifacts({ force: true }); } }, "重试")));
    }
    if (!STATE.catalog) return h("section", { class: "artifacts-page" }, artifactPageHead(), h("p", { class: "card", role: "status" }, "正在加载产物…"));

    const cats = categories();
    const current = activeCategory(cats);
    const tabs = renderTabs(cats);
    const body = h("div", { class: "artifact-swipe" }, current ? renderCategory(current) : null);
    // 左右滑切换分类（跟手 + 滑入动画）；滑到两端再往外滑，才交给一级应用的左右切换（seg-indicator.js 的仲裁）
    if (cats.length > 1) installSwipe(body, cats);
    return h("section", { class: "artifacts-page" }, artifactPageHead(), tabs, body);
  }

  function renderCategory(category) {
    if (category.kind === "eval") return window.piEvalArtifacts ? window.piEvalArtifacts.renderSection(category) : null;
    if (category.kind === "apps") return renderApps();
    if (category.kind === "collection" || category.kind === "uncategorized") return renderCollectionCategory(category);
    const scoped = items().filter((item) => item.category === category.id);
    const secondary = SECONDARIES.get(category.id) || "";
    const owned = secondary ? scoped.filter((item) => item.id === secondary) : scoped;
    return h("section", { class: "artifact-section", "aria-label": category.name, role: "tabpanel", id: "artifact-panel" },
      h("div", { class: "artifact-section__head" },
        h("span", { class: "muted small" }, category.description)),
      owned.length
        ? h("div", { class: "artifact-grid" }, owned.map(renderCard))
        : h("p", { class: "card muted small", role: "status" }, "这个分类下还没有产物。"));
  }

  const reducedMotion = () => { try { return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };

  /* 内容区换成新分类，并从切换的那一侧滑入（位移 / 时长 / 缓动和待办页的类型切换共用同一套 keyframes） */
  function slideInto(body, category, direction) {
    body.classList.remove("artifact-slide-from-right", "artifact-slide-from-left");
    // 滑出 / 跟手留下的行内位移先清掉，否则新内容会顶着 translateX 停在屏外
    body.style.removeProperty("transition"); body.style.removeProperty("transform"); body.style.removeProperty("opacity");
    delete body.dataset.leaving;
    body.replaceChildren(...[renderCategory(category)].filter(Boolean));
    if (!direction || reducedMotion()) return;
    void body.offsetWidth;   // 重新开始动画：连续快速切换时每次都从头滑入
    const cls = direction > 0 ? "artifact-slide-from-right" : "artifact-slide-from-left";
    body.classList.add(cls);
    body.addEventListener("animationend", () => body.classList.remove(cls), { once: true });
  }

  /* 切到另一个分类。tab 按钮原地改选中状态（同一个节点，选中气泡才会滑过去），内容区单独换，
   * 整页不重建——和待办页切 笔记 / 待办 / 日程 一样。页面还没渲染出来时退回整页重绘。 */
  function switchTab(cats, id) {
    const current = activeCategory(cats);
    const from = cats.findIndex((category) => category.id === current?.id), to = cats.findIndex((category) => category.id === id);
    if (to < 0 || to === from) return;
    STATE.panelOpen = false;   // 离开「我的」时收起分类面板
    rememberTab(id);
    const tabs = document.querySelector(".artifact-tabs"), body = document.querySelector(".artifact-swipe");
    if (!tabs || !body || !body.isConnected) { renderMain(); return; }
    [...tabs.querySelectorAll('[role="tab"]')].forEach((btn, i) => {
      const on = i === to;
      btn.setAttribute("aria-selected", String(on));
      btn.classList.toggle("active", on);
      btn.tabIndex = on ? 0 : -1;
    });
    document.querySelector(".artifact-sub-slot")?.replaceChildren(...[subRail(cats[to])].filter(Boolean));
    slideInto(body, cats[to], Math.sign(to - from));
  }

  function renderTabs(cats) {
    if (cats.length < 2) return null;   // 只有一个分类时不需要切换
    const onKey = (ev) => {
      const step = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      ev.preventDefault();
      const at = cats.findIndex((category) => category.id === activeCategory(cats)?.id);
      const next = (at + step + cats.length) % cats.length;
      switchTab(cats, cats[next].id);
      ev.currentTarget.querySelectorAll('[role="tab"]')[next]?.focus();
    };
    const current = activeCategory(cats);
    // 外面这层固定在顶栏下面：页面往下滚时 tab 始终可见
    return h("div", { class: "artifact-tabbar" },
      h("div", { class: "artifact-tabs pm-filter-line", role: "tablist", "aria-label": "产物分类", onkeydown: onKey },
        h("span", { class: "pm-filter-label" }, "分类"),
        cats.map((category) => h("button", {
          type: "button", class: "pm-chip" + (category.id === current?.id ? " active" : ""), role: "tab", "aria-label": category.name, "aria-selected": String(category.id === current?.id),
          tabindex: category.id === current?.id ? "0" : "-1",
          onclick: () => switchTab(cats, category.id),
        }, category.name, category.kind === "collection" ? h("span", { class: "pm-chip-count" }, String(collectionItems().filter((item) => window.piArtifactCollect?.matchesCategory(item, category.id)).length + catalogRefs(category).length))
          : category.kind === "uncategorized" ? h("span", { class: "pm-chip-count" }, String(uncategorizedItems().length)) : null))),
      h("div", { class: "artifact-sub-slot" }, subRail(current)));
  }

  /* ------------------------------ 左右滑动切换分类 ------------------------------
   * 手感和待办页「笔记 / 待办 / 日程」一致：先跟手（带淡出、只往有下一个分类的方向走），
   * 松手够远就把当前内容往手指方向滑出、换分类、新内容从另一侧滑入；不够远弹回。竖滑始终留给页面滚动。 */
  const SWIPE_MIN = 56;
  const SWIPE_OUT_MS = 160;
  /* 这些地方的横向手势归它们自己（输入、可横滚的表格 / 代码、分类 tab 自己的横滚） */
  const SWIPE_IGNORE = "input, textarea, select, pre, table, .artifact-tabbar, .artifact-category-directory, dialog";

  /* 手势位移 → 下一个分类 id；竖滑、不够远、已在两端都返回 null */
  function swipeTarget(dx, dy, ids, currentId, { needDistance = true } = {}) {
    if (Math.abs(dx) < Math.abs(dy) * 1.5) return null;
    if (needDistance && Math.abs(dx) < SWIPE_MIN) return null;
    const at = ids.indexOf(currentId);
    if (at < 0) return null;
    return ids[at + (dx < 0 ? 1 : -1)] ?? null;   // 手指向左滑 = 看右边一个 tab
  }

  function installSwipe(region, cats) {
    const ids = cats.map((category) => category.id);
    let drag = null;
    const reset = () => { region.style.removeProperty("transition"); region.style.removeProperty("transform"); region.style.removeProperty("opacity"); delete region.dataset.leaving; };
    const bounce = () => {
      if (reducedMotion()) { reset(); finish(); return; }
      region.style.transition = "transform 160ms ease-out, opacity 160ms ease-out";
      region.style.transform = ""; region.style.opacity = "";
      region.dataset.leaving = "1";
      setTimeout(() => { reset(); finish(); }, 200);
    };
    region.addEventListener("pointerdown", (ev) => {
      const previous = drag; drag = null;
      if (ev.pointerType === "touch" && window.piOtherTouchDown?.(ev)) { if (previous?.active) bounce(); return; }
      if (ev.clientX < 24 || ev.clientX > window.innerWidth - 24 || window.getSelection()?.toString()) return;
      if (ev.pointerType !== "touch" || region.dataset.leaving) return;
      if (ev.target instanceof Element && ev.target.closest(SWIPE_IGNORE)) return;
      drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, width: region.clientWidth || window.innerWidth || 1, active: false };
    });
    region.addEventListener("pointermove", (ev) => {
      const s = drag;
      if (!s || ev.pointerId !== s.id) return;
      const dx = ev.clientX - s.x, dy = ev.clientY - s.y;
      if (!s.active) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
        // 竖滑留给页面滚动；这个方向没有下一个分类（已在两端）也不接管
        if (!swipeTarget(dx, dy, ids, activeCategory(cats)?.id, { needDistance: false })) { drag = null; return; }
        s.active = true;
        region.classList.remove("artifact-slide-from-right", "artifact-slide-from-left");
        region.style.transition = "none";
        document.body.classList.add("artifact-swiping");   // 滑动期间裁掉横向溢出，免得出现横向滚动条
        try { region.setPointerCapture?.(ev.pointerId); } catch { /* 合成事件 / 老浏览器没有指针捕获也照常 */ }
      }
      const forward = swipeTarget(dx, dy, ids, activeCategory(cats)?.id, { needDistance: false }) ? dx : 0;
      region.style.transform = forward ? "translateX(" + forward + "px)" : "";
      region.style.opacity = forward ? String(Math.max(0.25, 1 - Math.abs(forward) / (s.width * 0.9))) : "";
    });
    const finish = () => document.body.classList.remove("artifact-swiping");
    region.addEventListener("pointerup", (ev) => {
      const s = drag; drag = null;
      if (!s) return;
      try { region.releasePointerCapture?.(ev.pointerId); } catch { /* 没有捕获就忽略 */ }
      if (!s.active || ev.pointerId !== s.id) return;
      const dx = ev.clientX - s.x, dy = ev.clientY - s.y;
      // 已经横滑：挡掉这次落在卡片 / 按钮上的 click，免得顺手打开游戏
      region.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); }, { capture: true, once: true });
      const target = swipeTarget(dx, dy, ids, activeCategory(cats)?.id);
      if (!target) { bounce(); return; }
      if (reducedMotion()) { reset(); finish(); switchTab(cats, target); return; }
      region.dataset.leaving = "1";
      region.style.transition = "transform " + SWIPE_OUT_MS + "ms ease-in, opacity " + SWIPE_OUT_MS + "ms ease-in";
      region.style.transform = "translateX(" + (dx < 0 ? -1 : 1) * s.width + "px)";
      region.style.opacity = "0";
      setTimeout(() => {
        finish();
        // 页面被重绘（节点已摘下）：这次滑动作废。滑出期间点了 tab 切过分类的，switchTab 里会因为已在目标分类而不重复切换
        if (!region.isConnected) return;
        switchTab(cats, target);
      }, SWIPE_OUT_MS);
    });
    region.addEventListener("pointercancel", () => {
      const s = drag; drag = null;
      if (s?.active) bounce();
    });
  }

  /* ------------------------------ 启动 ------------------------------ */
  function onFrameMessage(ev) {
    if (ev.origin !== location.origin || !ev.data || typeof ev.data !== "object") return;
    const frame = document.querySelector(".artifact-frame");
    if (!frame || ev.source !== frame.contentWindow) return;
    if (ev.data.type === "pi-artifact-exit") exitGame();
    if (ev.data.type === "pi-artifact-ready" && ev.data.exit) frame.closest(".artifact-player")?.classList.add("has-game-exit");
    if (ev.data.type === "pi-artifact-haptic" && window.piAndroidShell?.haptic) void window.piAndroidShell.haptic(ev.data.payload);
  }

  function start() {
    window.addEventListener("message", onFrameMessage);
    window.addEventListener("hashchange", syncImmersive);
    // 面板展开时：点面板和入口按钮之外的地方、按 Esc 收起（手机上点遮罩同样收起）
    document.addEventListener("click", (ev) => {
      if (!STATE.panelOpen || !(ev.target instanceof Element)) return;
      if (ev.target.closest(".artifact-category-directory, .artifact-filter-entry, .notes-filter-backdrop")) return;
      setPanel(false);
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape" || !STATE.panelOpen || (ev.target instanceof Element && ev.target.closest("input, textarea, select"))) return;
      setPanel(false);
    });
    window.addEventListener("pi-artifact-collections-change", () => { STATE.collections = window.piArtifactCollect?.state?.() || STATE.collections; repaint(); });
    syncImmersive();
    const bar = document.querySelector(".topbar");
    if (bar) bar.append(trigger); else document.body.append(trigger);
    document.body.append(panel);
    if (!panel.showPopover) {
      panel.hidden = true;
      trigger.addEventListener("click", () => { panel.hidden = !panel.hidden; syncTrigger(); });
    }
    confirmUpdate.addEventListener("click", () => {
      const list = outdated();
      void applyUpdate(STATE.pending || list[0]);
    });
    later.addEventListener("click", () => {
      const list = outdated();
      STATE.dismissed = list[0]?.id ?? null;
      closePanel();
      syncTrigger();
    });
    panel.addEventListener("toggle", syncTrigger);
    syncTrigger();
    void loadArtifacts();
    setInterval(() => { if (document.visibilityState !== "hidden") void loadArtifacts({ force: true }); }, POLL_MS);
    window.addEventListener("focus", () => void loadArtifacts({ force: true }));
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void loadArtifacts({ force: true }); });
  }

  Object.assign(window, {
    renderArtifacts,
    loadArtifacts,
    piArtifacts: { swipeTarget, state: () => ({ ...STATE }), outdated: () => outdated().map((item) => item.id), syncNow: syncTrigger },
  });
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
