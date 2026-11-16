/* Android owns only OS capabilities. Business UI and credentials stay outside this bridge. */
window.piAndroidShell = (() => {
  const native = window.PiAndroid;
  if (!native || typeof native.postMessage !== "function") return null;
  const methods = new Set(["browser.x.history", "browser.x.open", "browser.link.open", "browser.site.open", "browser.site.settings", "browser.site.settings.set", "browser.site.records", "browser.site.record.delete", "communications.status", "communications.permission", "communications.enable", "communications.stop", "communications.sync", "widget.visit", "widget.appVisit", "photos.status", "photos.permission", "photos.latest", "photos.image", "badge.sync", "shell.status", "clipboard.read", "notifications.status", "notifications.enable", "notifications.disable", "notifications.settings", "updates.check", "updates.prepare", "updates.install", "session.logout", "share.send", "sync.snapshot", "sync.tail", "updates.progress", "chrome.light", "chrome.dark", "chrome.bottom.bar", "chrome.bottom.page", "chrome.top.bar", "chrome.top.page", "chrome.top.surface", "network.status", "updates.history"]);
  const pending = new Map();
  let sequence = 0;
  native.onmessage = event => {
    if (typeof event.data !== "string" || event.data.length > 14 * 1024 * 1024) return;
    let reply; try { reply = JSON.parse(event.data); } catch { return; }
    const entry = pending.get(reply?.id); if (!entry || (!["clipboard.read", "photos.latest", "photos.image"].includes(entry.method) && event.data.length > 4 * 1024 * 1024)) return;
    pending.delete(reply.id); clearTimeout(entry.timer);
    if (reply.ok === true && reply.result && typeof reply.result === "object") entry.resolve(reply.result);
    else entry.reject(new Error(typeof reply.error === "string" ? reply.error.slice(0, 160) : "Android 操作未完成"));
  };
  function call(method, params) {
    if (!methods.has(method) || pending.size >= 16) return Promise.reject(new Error("不支持此 Android 操作或操作过于频繁"));
    const id = `a${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Android 操作超时，请核对状态后重试")); }, method === "updates.install" || method === "updates.prepare" ? 1860000 : (method === "communications.permission" || method === "notifications.enable" || method === "photos.permission") ? 90000 : 30000);
      pending.set(id, { resolve, reject, timer, method });
      try { native.postMessage(JSON.stringify({ v: 1, id, method, ...(method === "browser.link.open" || method === "communications.permission" || method === "communications.enable" || method === "browser.site.open" || method === "browser.site.settings.set" || method === "browser.site.records" || method === "browser.site.record.delete" || method === "widget.visit" || method === "widget.appVisit" || method === "photos.latest" || method === "photos.image" || method === "badge.sync" || method === "share.send" || method === "sync.tail" ? { params } : {}) })); }
      catch { clearTimeout(timer); pending.delete(id); reject(new Error("Android 连接未就绪")); }
    });
  }
  const update = { message: "", busy: false, checked: false, available: false, version: "", code: 0, ready: false, installing: false, progress: null, startedAt: 0, samples: [], pollTimer: 0, silent: false, silentTimer: 0 };
  // Whether this installed APK can report download progress (older ones cannot).
  let canReportProgress = false;
  // Whether this installed APK keeps downloading in the background (foreground service), resumes after a drop, and can be re-attached to after a reload.
  let canBackground = false;
  // Whether this installed APK keeps a local install history (updates.history). History starts at the first launch of such an APK.
  let canHistory = false;
  const installs = { data: null, loading: false, error: "" };
  // 每一版 APK 的一句话更新点：打包时写进服务端发布目录（release.json / notes.json），页面按 versionCode 对上。
  const releaseNotes = { latest: null, versions: {}, loading: false, loaded: false };
  function loadReleaseNotes() {
    if (releaseNotes.loaded || releaseNotes.loading || typeof api !== "function") return;
    releaseNotes.loading = true;
    api("/api/android/release-notes").then(result => {
      const versions = result && typeof result === "object" && result.versions && typeof result.versions === "object" ? result.versions : {};
      const clean = {};
      for (const [code, list] of Object.entries(versions)) {
        if (!/^[1-9]\d{0,9}$/.test(code) || !Array.isArray(list)) continue;
        const texts = list.filter(text => typeof text === "string" && text.trim()).slice(0, 5);
        if (texts.length) clean[code] = texts;
      }
      releaseNotes.versions = clean;
      releaseNotes.latest = result?.latest && typeof result.latest === "object" ? result.latest : null;
      releaseNotes.loaded = true;
    }).catch(() => { /* 离线 / 未登录：只是没有更新说明，不影响版本与下载 */ })
      .finally(() => { releaseNotes.loading = false; refreshVersions(); refreshInstallPages(); });
  }
  /** 这一版记下的更新点；最新一版只写在发布信息里（没进 notes.json）时也能对上。没有记录就返回空数组，不编造。 */
  const notesOf = code => {
    if (!(Number(code) > 0)) return [];
    const key = String(code);
    if (Array.isArray(releaseNotes.versions[key])) return releaseNotes.versions[key];
    const latest = releaseNotes.latest;
    if (!latest || String(latest.versionCode) !== key || !Array.isArray(latest.notes)) return [];
    return latest.notes.filter(text => typeof text === "string" && text.trim()).slice(0, 5);
  };
  function notesList(code) {
    const notes = notesOf(code);
    if (!notes.length) return null;
    return h("ul", { class: "android-release-notes", "data-release-notes": String(code) }, notes.map(text => h("li", {}, text)));
  }
  /** 「最新版本」对应哪个 versionCode：优先原生刚查到的版本，其次是发布信息里的最新一版。 */
  function latestCode(current) { return update.available ? (update.code || releaseNotes.latest?.versionCode || 0) : (current?.versionCode || releaseNotes.latest?.versionCode || 0); }
  const KINDS = { install: "首次安装", update: "更新", reinstall: "覆盖安装" };
  /** 用户按北京时间读时间：不依赖手机当前时区。 */
  const stamp = ms => Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "";
  /** 「刚刚 / N分钟前 / N小时前 / N天前 / N个月前 / N年前」；绝对时间留给悬停提示。 */
  function ago(ms, now = Date.now()) {
    if (!Number.isFinite(ms) || ms <= 0) return "";
    const minutes = Math.floor((now - ms) / 60000);
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}天前`;
    if (days < 365) return `${Math.floor(days / 30)}个月前`;
    return `${Math.floor(days / 365)}年前`;
  }
  /** 带绝对时间悬停提示的相对时间。 */
  const rel = (ms, fallback = "未知") => { const text = ago(ms); return text ? h("span", { title: stamp(ms) }, text) : fallback; };
  function loadInstalls() {
    if (!canHistory || installs.loading) return;
    installs.loading = true; installs.error = "";
    call("updates.history").then(result => { installs.data = result; }).catch(error => { installs.error = error.message || "读取安装历史失败"; })
      .finally(() => { installs.loading = false; refreshVersions(); refreshInstallPages(); });
  }
  const MB = 1048576;
  const bytesText = n => n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.max(0, Math.round(n / 1024))} KB`;
  const secondsText = s => s < 60 ? `${Math.max(1, Math.round(s))} 秒` : `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒`;
  /** 下载中主按钮里显示什么：按钮文案、填充百分比（null = 不确定）、下面那行数字（字节 / 速度 / 余量）。没有下载就返回 null。 */
  function downloadView(now = Date.now()) {
    if (!update.installing && !update.silent) return null;
    const elapsed = (now - update.startedAt) / 1000, p = update.progress;
    if (!canReportProgress || !p) return { percent: null, label: "正在下载…", detail: `已用 ${secondsText(elapsed)}（此版本不显示进度，请耐心等待）` };
    if (p.phase === "verifying") return { percent: 100, label: "正在核对签名…", detail: "下载完成，正在核对包名、版本、摘要和签名…" };
    if (p.phase === "ready") return { percent: 100, label: "打开系统安装确认", detail: "安装包已校验。" };
    const total = p.total > 0 ? p.total : 0, percent = total ? Math.min(100, Math.floor(p.received * 100 / total)) : null;
    const first = update.samples[0], last = update.samples.at(-1);
    const speed = first && last && last.at - first.at >= 1000 ? (last.bytes - first.bytes) / ((last.at - first.at) / 1000) : 0;
    const parts = [total ? `已下载 ${bytesText(p.received)} / ${bytesText(total)}${percent === null ? "" : `（${percent}%）`}` : `已下载 ${bytesText(p.received)}`];
    if (speed > 1024) parts.push(`${bytesText(speed)}/秒`);
    if (total && speed > 1024) parts.push(`约剩 ${secondsText((total - p.received) / speed)}`);
    if (last && now - last.changedAt > 10000) parts.push("网络较慢或暂停，仍在等待");
    return { percent, label: percent === null ? "正在下载…" : `正在下载 ${percent}%`, detail: parts.join(" · ") };
  }
  function notePoll(result, now = Date.now()) {
    const previous = update.samples.at(-1);
    update.progress = result;
    update.samples.push({ at: now, bytes: result.received, changedAt: previous && previous.bytes === result.received ? previous.changedAt : now });
    update.samples = update.samples.filter(s => now - s.at <= 6000);
  }
  function startProgress() {
    update.installing = true; update.silent = false; update.startedAt = Date.now(); update.progress = null; update.samples = [];
    // The page asks for the counters; the download itself never waits for the page.
    const tick = canReportProgress
      ? () => { call("updates.progress").then(result => { if (update.installing) { notePoll(result); refreshVersions(); } }).catch(() => {}); }
      : () => refreshVersions();
    tick(); update.pollTimer = setInterval(tick, canReportProgress ? 700 : 1000);
    refreshVersions();
  }
  /**
   * 原生壳在后台静默下载（版本页没点任何按钮时自动开始的那一次）也要看得见进度：原生那边这次下载占着操作锁，
   * 此时点「检查 / 下载」会排在它后面，页面看起来就像没反应。进度读取不走那把锁，所以这里单独轮询。
   */
  function silentTick() {
    if (!canReportProgress || ![...panels].some(entry => entry.node.isConnected)) { stopSilent(); return; }
    if (update.installing) return;
    call("updates.progress").then(result => {
      if (update.installing) return;
      const live = result && ["downloading", "verifying"].includes(result.phase) && result.userStarted !== true;
      if (!live) { if (update.silent) { update.silent = false; update.progress = null; update.samples = []; refreshVersions(); } return; }
      if (!update.silent) { update.silent = true; update.checked = true; update.startedAt = Date.now(); update.samples = []; if (result.versionName) update.version = String(result.versionName); if (result.versionCode) update.code = Number(result.versionCode) || 0; update.available = true; update.message = ""; }
      notePoll(result); refreshVersions();
    }).catch(() => {});
  }
  function startSilentWatch() { if (update.silentTimer || !canReportProgress) return; silentTick(); update.silentTimer = setInterval(silentTick, 1000); }
  function stopSilent() { clearInterval(update.silentTimer); update.silentTimer = 0; if (update.silent) { update.silent = false; update.progress = null; update.samples = []; } }
  function stopProgress() { clearInterval(update.pollTimer); update.pollTimer = 0; update.installing = false; update.progress = null; update.samples = []; }
  let version = "", versionName = "", versionCode = 0, versionReading = false;
  // 连接方式：只读展示「现在是局域网直连还是经公网隧道」，不改变应用连接的地址（docs/requirements/v3.52-lan-direct-detection）。
  const net = { supported: false, busy: false, result: null, error: "", badge: null };
  function networkText(result) {
    if (!result || typeof result !== "object") return "";
    if (result.mode === "lan") {
      const address = String(result.address || "");
      // route 由新版 APK 给出：lan = 页面与原生请求已走局域网；public = 局域网可用，但页面还没切（正在输入时先不切，稍后自动切）。
      if (result.route === "lan") return `局域网直连（${address}），页面和原生请求都走局域网`;
      if (result.route === "public") return `局域网直连可用（${address}），稍后自动切换`;
      return `局域网直连（${address}${Number.isFinite(result.millis) ? `，探测 ${Math.round(result.millis)} ms` : ""}）`;
    }
    const why = { "no-lan": "手机与实例不在同一局域网", blocked: "在同一局域网，但连不上实例的局域网探针，请检查 Mac 防火墙是否放行端口", disabled: "实例未开启局域网探针", offline: "暂时读不到实例的局域网信息（离线或需要重新登录）" }[result.reason];
    return `经公网隧道${why ? `（${why}）` : ""}`;
  }
  /** 「连接状态」行上不点开就能看到的短标签：局域网直连 / 局域网可用（可用但页面还没切，或旧 APK 只识别）/ 公网隧道；读不到时不显示。 */
  function networkBadge(result) {
    if (!result || typeof result !== "object") return null;
    if (result.mode === "lan") return { mode: "lan", text: result.route === "lan" ? "局域网直连" : "局域网可用" };
    if (result.mode === "remote" && result.reason && result.reason !== "offline") return { mode: "remote", text: "公网隧道" };
    return null;
  }
  function publishBadge() {
    const next = networkBadge(net.result);
    if (net.busy && !next) return; // 检测中保留上一次的标签，不闪
    const same = (net.badge?.mode || "") === (next?.mode || "") && (net.badge?.text || "") === (next?.text || "");
    net.badge = next;
    if (!same && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") window.dispatchEvent(new CustomEvent("pi-network-change", { detail: next }));
  }
  async function detectNetwork() {
    if (!net.supported || net.busy) return;
    const before = net.result?.mode || null;
    net.busy = true; net.error = ""; refreshNet();
    try { net.result = await call("network.status"); } catch (error) { net.result = null; net.error = error.message; }
    finally { net.busy = false; refreshNet(); publishBadge(); }
    tipIfDirect(before, net.result);
  }
  // 局域网直连提示：从「非直连/未知」进入「直连」时提示一次；同一地址 30 分钟内不重复（页面重载、反复切回前台都不再弹）。
  // 新版 APK：只有页面真的已经走局域网（route=lan）才提示「已切换」；局域网可用但还没切时不提示，切换重载后会提示。
  // 旧版 APK 只识别、不切换（没有 route 字段）：如实写「仅识别」。
  const TIP_KEY = "pi-lan-direct-tip", TIP_GAP = 30 * 60 * 1000;
  function tipIfDirect(before, result, now = Date.now()) {
    if (!result || result.mode !== "lan" || before === "lan" || typeof document === "undefined") return false;
    const switched = result.route === "lan";
    if (!switched && result.route !== undefined) return false;
    const address = String(result.address || "");
    try {
      const last = JSON.parse(localStorage.getItem(TIP_KEY) || "null");
      if (last && last.address === address && now - last.at < TIP_GAP) return false;
      localStorage.setItem(TIP_KEY, JSON.stringify({ address, at: now }));
    } catch { /* 没有本地存储：只按本次页面内的状态变化提示 */ }
    window.piToast(switched ? `已切换到局域网直连（${address}）：页面和原生请求都走局域网。` : `检测到局域网直连可用（${address}）。当前仅识别，流量仍走公网入口。`, { ms: 6000, attrs: { "data-lan-tip": address } });
    return true;
  }
  // 自动检测：打开 App、回到前台、网络恢复时各一次，最短间隔 20 秒；读不到能力就静默放弃。
  // shell.status 只读一次：自动检测与设置卡片共用（能力与版本在 App 重启前不会变）。
  let statusPromise = null;
  function shellStatus() { return statusPromise ||= call("shell.status").catch(error => { statusPromise = null; throw error; }); }
  let lastAuto = 0;
  async function autoDetect() {
    if (typeof document !== "undefined" && document.hidden) return;
    const now = Date.now();
    if (now - lastAuto < 20000) return;
    lastAuto = now;
    try {
      if (!net.supported) { const status = await shellStatus(); net.supported = Array.isArray(status.capabilities) && status.capabilities.includes("network.status"); }
      refreshNet();
      if (net.supported) await detectNetwork();
    } catch { /* 登录待续期或桥接未就绪：下次再试 */ }
  }
  // 连接状态弹层（顶栏「连接状态」/ 手机「更多」里的连接状态）里的「网络」一行：当前走局域网还是公网隧道 + 重新检测。
  // 只在支持 network.status 的 APK 里出现；不放进「更新」卡片。
  let netBox = null;
  function netLine() {
    const text = net.busy ? "正在检测连接方式…" : net.error ? `连接方式检测失败：${net.error}` : net.result ? networkText(net.result) : "未检测";
    return [
      h("p", { class: "conn-net-text", "data-lan-status": net.result?.mode || "", role: "status" }, `网络：${text}`),
      h("button", { type: "button", class: "btn", disabled: net.busy, onclick: () => void detectNetwork() }, "重新检测")
    ];
  }
  function refreshNet() {
    if (!netBox) return;
    const slot = netBox;
    slot.hidden = !net.supported;
    if (net.supported) slot.replaceChildren(...netLine());
  }
  function mountNetwork() {
    if (typeof document === "undefined" || typeof document.getElementById !== "function") return;
    netBox = document.getElementById("conn-detail-extra");
    if (!netBox) return;
    // 打开弹层时顺手核对一次（有 20 秒节流）；平时已由进入前台/网络恢复自动核对。
    document.getElementById("conn-detail")?.addEventListener("beforetoggle", event => { if (event.newState === "open") void autoDetect(); });
    refreshNet();
  }
  const panels = new Set();
  // 能力读到了没有：shell.status 如果一直没回应（例如排在一次原生下载后面），不能就此认定「这个 APK 不显示进度」。
  let capabilitiesKnown = false, capabilityProbed = false;
  /** 下载中按钮下面那行状态：有进度就报数字，没有下载就说清楚下一步会怎样。 */
  function statusLine(view) {
    if (view) {
      // 后台静默下载不要再说「继续下载」；用户自己点的才提醒可以走开。
      const tail = !update.silent && canBackground && view.percent !== 100 ? "离开 App 也会继续下载" : "";
      return [update.silent ? `新版本 ${update.version} 正在后台下载` : "", view.detail, tail].filter(Boolean).join(" · ");
    }
    if (update.ready) return "已下载并核对签名，安装时系统会再确认一次。";
    if (update.available) return canBackground ? "下载后由你确认安装，不会静默安装；离开 App 也会继续下载。" : "下载后由你确认安装，不会静默安装。";
    return "";
  }
  /** 卡片里只放：当前版本、（有更新时）最新版本与它这一版的更新点、一个主操作、一行历史入口；逐条明细在单独页面。 */
  function buildVersionPanel() {
    const panel = h("section", { class: "card settings-card android-client-card", "aria-label": "Android 客户端更新" });
    const title = h("h2", {}, "Android 客户端");
    const check = h("button", { type: "button", class: "btn small android-check", "data-update-check": "", onclick: () => void runUpdate(false) }, "检查更新");
    const head = h("div", { class: "settings-card-head android-client-head" }, h("div", {}, title), h("div", { class: "settings-card-actions" }, check));

    // 当前版本：版本号 + 安装时间一行写完，不再和「最新版本」挤在一起。
    const currentValue = h("strong", { class: "android-version-name", "data-install-current": "" }, "正在读取…");
    const currentMeta = h("span", { class: "android-version-meta", "data-install-installed": "" });
    const currentBlock = h("div", { class: "android-version-block" },
      h("span", { class: "android-version-label" }, "当前版本"),
      h("div", { class: "android-version-line" }, currentValue, currentMeta));

    // 最新版本：只在真的查到更高版本时出现，用一条分隔线和当前版本分开。
    const latestValue = h("strong", { class: "android-version-name", "data-install-latest": "" });
    const latestBlock = h("div", { class: "android-version-block android-version-next", hidden: "" },
      h("span", { class: "android-version-label" }, "最新版本"),
      h("div", { class: "android-version-line" }, latestValue, h("span", { class: "android-version-meta" }, "尚未安装")));

    // 更新点：超过 2 条默认收起，卡片不会被长列表撑开。
    const notesLabel = h("span", { class: "android-version-label" });
    const notes = h("ul", { class: "android-release-notes android-notes-list" });
    // 展开/收起只换列表内容，按钮本身保持同一个节点；点击处理在 versionPanel 里挂上（这里还拿不到 entry）。
    const notesMore = h("button", { type: "button", class: "android-notes-more" });
    const notesBlock = h("div", { class: "android-notes-block", hidden: "" }, notesLabel, notes, notesMore);

    // 主操作只有一个；进度就画在这颗按钮里，点下去立即有反馈。
    const fill = h("span", { class: "android-action-fill", "aria-hidden": "true" });
    const label = h("span", { class: "android-action-label" });
    const action = h("button", { type: "button", class: "btn primary android-update-action", "data-update-action": "", onclick: () => void runUpdate(true) }, fill, label);
    const status = h("p", { class: "android-update-status", role: "status", "aria-live": "polite" });
    const notice = h("p", { class: "android-update-notice" });
    const actionBlock = h("div", { class: "android-update-block", hidden: "" }, action, status, notice);

    // 安装历史是导航，不是动作：退到卡片底部一行文字，不再和主操作平排。
    const history = h("a", { class: "android-install-foot", href: "#/settings/version/installs", "data-install-history-link": "" },
      h("span", { "data-install-history-count": "" }), h("span", { class: "android-install-foot-open" }, "查看历史 ›"));
    const fallback = h("p", { class: "android-install-fallback", hidden: "" }, "升级到新版 APK 后，这里会显示安装时间与安装历史。");

    panel.append(head, currentBlock, latestBlock, notesBlock, actionBlock, history, fallback);
    return { node: panel, title, check, currentValue, currentMeta, latestBlock, latestValue, notesBlock, notesLabel, notes, notesMore, actionBlock, action, fill, label, status, notice, history, fallback, notesOpen: false, notesKey: "", metaKey: "", badge: null };
  }
  function installsEntryText() {
    const count = installs.data?.items?.length;
    return count ? `安装历史 · ${count} 次` : "安装历史";
  }
  const installPages = new Set();
  function drawInstalls(container) {
    const data = installs.data, items = data?.items ?? [];
    container.replaceChildren(...[
      h("div", { class: "settings-card-head" }, h("div", {}, h("h2", {}, "Android 安装历史"),
        h("p", { class: "muted small" }, "按安装时间倒序，时间为相对现在多久前，长按或悬停可看具体时间（北京时间）。历史只保存在这台手机上。")),
        h("div", { class: "settings-card-actions" }, h("button", { type: "button", class: "btn small", disabled: installs.loading || !canHistory, onclick: () => loadInstalls() }, installs.loading ? "读取中…" : "刷新"))),
      !canHistory ? h("p", { class: "muted small" }, "当前 APK 不支持安装历史，升级到新版 APK 后可查看。") : null,
      installs.error ? h("p", { class: "field-error", role: "alert" }, installs.error) : null,
      canHistory && !data && !installs.error ? h("p", { class: "muted small" }, "正在读取…") : null,
      h("ul", { class: "android-install-list", style: "list-style:none;margin:0;padding:0;display:grid;gap:10px" }, items.map((item, index) => h("li", { class: "android-install-item", "data-install-item": "", style: "display:grid;gap:2px" },
        h("strong", {}, `${item.versionName} (${item.versionCode})`, index === 0 ? h("span", { class: "muted small" }, " · 当前") : null),
        notesList(item.versionCode),
        h("span", { class: "muted small" }, `${KINDS[item.kind] || "安装"} · `, rel(item.installedAt, "时间未知"))))),
      data && !items.length ? h("p", { class: "muted small" }, "还没有记录。") : null,
      data ? h("p", { class: "muted small" }, ["首次安装于 ", rel(data.firstInstalledAt), "。历史从支持该功能的 APK 首次启动开始记录，此前被覆盖的版本系统没有留下记录。"]) : null,
    ].filter(Boolean));
  }
  function refreshInstallPages() { for (const page of installPages) { if (page.isConnected) drawInstalls(page); else installPages.delete(page); } }
  /** 设置 → 版本 → 安装历史（#/settings/version/installs）的页面内容。 */
  function installsPage() {
    const page = h("section", { class: "card settings-card", "aria-label": "Android 安装历史" }); installPages.add(page); drawInstalls(page);
    loadReleaseNotes();
    if (canHistory) loadInstalls();
    else if (!version && !versionReading) { void readVersion(); }
    return page;
  }
  /**
   * 卡片结构只建一次，之后只改文字、显隐与进度宽度。
   * 下载中每秒都要刷新：每次都 replaceChildren 重建的话，正在按下的手指会落在被换掉的按钮上，点击就不触发（点了像没反应）。
   * 所以主按钮、历史入口这些节点建好就不再换，只改内容。
   */
  function paintVersion(entry) {
    const current = installs.data?.current || null;
    const nowName = current?.versionName || versionName, nowCode = current?.versionCode || versionCode;
    const nowText = nowName ? `${nowName}${nowCode ? ` (${nowCode})` : ""}` : "正在读取…";
    if (entry.currentValue.textContent !== nowText) entry.currentValue.textContent = nowText;

    // 安装时间只有新版 APK 才记；读不到就说在读，不编造。
    const metaKey = [canHistory ? 1 : 0, current?.installedAt || 0, installs.data ? 1 : 0, installs.error].join("|");
    if (metaKey !== entry.metaKey) {
      entry.metaKey = metaKey;
      const nodes = !canHistory ? [] : current?.installedAt ? ["已安装 · ", rel(current.installedAt)] : [installs.error || "正在读取安装时间…"];
      entry.currentMeta.replaceChildren(...nodes);
      entry.currentMeta.hidden = !nodes.length;
    }

    entry.latestBlock.hidden = !update.available;
    if (update.available) {
      const latestText = `${update.version}${update.code ? ` (${update.code})` : ""}`;
      if (entry.latestValue.textContent !== latestText) entry.latestValue.textContent = latestText;
    }

    // 更新点只挂在它所属的那一版下面；超过 2 条默认收起，点「展开全部」再看。
    const code = latestCode(current) || nowCode;
    const texts = notesOf(code);
    const open = entry.notesOpen && texts.length > 2;
    const notesKey = [code, open ? 1 : 0, texts.join("|")].join("|");
    if (notesKey !== entry.notesKey) {
      entry.notesKey = notesKey;
      entry.notesBlock.hidden = !texts.length;
      entry.notes.setAttribute("data-release-notes", String(code));
      entry.notes.replaceChildren(...(open ? texts : texts.slice(0, 2)).map(text => h("li", {}, text)));
      entry.notesMore.hidden = texts.length <= 2;
      entry.notesMore.textContent = open ? "收起" : `展开全部 ${texts.length} 条`;
    }
    const notesLabelText = update.available ? "这次更新" : "这一版的更新";
    if (entry.notesLabel.textContent !== notesLabelText) entry.notesLabel.textContent = notesLabelText;

    // 主操作一颗按钮承担「下载 / 进度 / 安装」三种状态。
    const view = downloadView();
    entry.actionBlock.hidden = !update.available;
    if (update.available) {
      const labelText = view ? view.label : update.ready ? "打开系统安装确认" : "下载并更新";
      if (entry.label.textContent !== labelText) entry.label.textContent = labelText;
      const percent = view ? view.percent : null;
      const width = percent === null ? "0%" : `${percent}%`;
      if (entry.fill.style.width !== width) entry.fill.style.width = width;
      const indeterminate = String(!!view && percent === null);
      if (entry.fill.getAttribute("data-indeterminate") !== indeterminate) entry.fill.setAttribute("data-indeterminate", indeterminate);
      const busy = String(!!view);
      if (entry.action.getAttribute("aria-busy") !== busy) entry.action.setAttribute("aria-busy", busy);
      if (entry.action.disabled !== update.busy) entry.action.disabled = update.busy;
      if (percent === null) { if (entry.action.hasAttribute("data-progress")) entry.action.removeAttribute("data-progress"); }
      else if (entry.action.getAttribute("data-progress") !== String(percent)) entry.action.setAttribute("data-progress", String(percent));
      const line = statusLine(view);
      if (entry.status.textContent !== line) entry.status.textContent = line;
      entry.status.hidden = !line;
      const noticeText = update.message || "";
      if (entry.notice.textContent !== noticeText) entry.notice.textContent = noticeText;
      entry.notice.hidden = !noticeText;
    } else {
      entry.status.hidden = true;
      entry.notice.hidden = true;
    }

    // 右上角的检查：点下去立即显示「检查中…」；后台静默下载时不禁用它（否则看起来像坏了）。
    const checkText = update.busy && !view ? "检查中…" : "检查更新";
    if (entry.check.textContent !== checkText) entry.check.textContent = checkText;
    if (entry.check.disabled !== update.busy) entry.check.disabled = update.busy;

    // 标题旁的徽标：有新版本 / 已是最新（只有真的查过才敢说已是最新）。
    const badgeKind = update.available ? "new" : update.checked && version ? "latest" : "";
    if (badgeKind !== entry.badge) {
      entry.badge = badgeKind;
      entry.title.replaceChildren("Android 客户端", ...(badgeKind === "new" ? [h("span", { class: "pi-new-version" }, "新版本")] : badgeKind === "latest" ? [h("span", { class: "android-latest-badge" }, "已是最新")] : []));
    }

    // 安装历史：导航，不是动作。
    entry.history.hidden = !canHistory;
    entry.fallback.hidden = canHistory || !version;
    if (canHistory) {
      const count = entry.history.firstElementChild, countText = installsEntryText();
      if (count && count.textContent !== countText) count.textContent = countText;
    }
  }
  function refreshVersions() { for (const entry of panels) { if (entry.node.isConnected) paintVersion(entry); else panels.delete(entry); } }
  async function runUpdate(install) {
    if (update.busy) return;
    // 后台静默下载正在跑：不排到原生锁后面（排上去点了就像没反应），进度本来就在按钮里。
    if (!install && update.silent) { refreshVersions(); return; }
    update.busy = true; update.message = "";
    if (install) startProgress(); else refreshVersions();
    try {
      const result = await call(install ? "updates.install" : "updates.check");
      if (!install) {
        update.checked = true;
        update.available = result.available === true;
        update.version = String(result.versionName || "");
        update.code = update.available ? Number(result.versionCode) || 0 : 0;
        update.ready = update.available && result.ready === true;
        // 手点检查却没有更高版本：给一次短提示，之后卡片就是「已是最新」。
        if (!update.available && typeof window.piToast === "function") window.piToast("已是最新版本", { ms: 2500 });
      }
      else { update.ready = result.ready === true; update.message = result.installPermissionRequired ? "请允许此应用安装，然后回到这里点「打开系统安装确认」。" : ""; }
    } catch (error) { update.message = error.message; }
    finally { stopProgress(); update.busy = false; refreshVersions(); }
  }
  /** 页面重载（或 App 被切走又回来）时，原生的下载可能仍在后台跑或已下完：接上它，而不是让用户重新点一遍。 */
  async function resumeRunning() {
    if (update.busy || update.installing) return;
    let p; try { p = await call("updates.progress"); } catch { return; }
    // 只接上用户自己点的下载；原生壳自动检查时的静默预下载由 native-update 管，不能被这里当成「要安装」而自动弹出安装器。
    if (!p || !p.versionName || p.userStarted !== true || !["downloading", "verifying", "ready"].includes(p.phase) || update.busy || update.installing) return;
    update.available = true; update.version = String(p.versionName); update.code = Number(p.versionCode) || 0;
    update.checked = true;
    if (p.phase === "ready") { update.ready = true; update.message = ""; refreshVersions(); }
    else { update.message = ""; void runUpdate(true); }
  }
  // 原生壳自动检查 / 后台下载的结果也画在这张卡上：不用手点「检查更新」就能看到新版本已备好。
  function syncFromShell(state) {
    if (update.busy) return; // 用户正在手动检查 / 下载时不被后台结果搮掉文案
    if (!state?.available) { update.available = false; update.ready = false; update.version = ""; update.code = 0; update.checked = true; refreshVersions(); return; }
    update.available = true;
    update.checked = true;
    update.version = String(state.versionName || ""); update.code = Number(state.versionCode) || 0; update.ready = state.downloaded === true;
    update.message = "";
    refreshVersions();
  }
  if (typeof window.addEventListener === "function") window.addEventListener("pi-native-update", () => syncFromShell(window.piNativeUpdate?.state?.()));
  function readVersion() {
    versionReading = true;
    return shellStatus().then(result => { capabilitiesKnown = true; versionName = String(result.versionName || ""); versionCode = Number(result.versionCode) || 0; version = `${versionName} (${versionCode})`; canReportProgress = Array.isArray(result.capabilities) && result.capabilities.includes("updates.progress"); canBackground = canReportProgress && result.capabilities.includes("updates.background"); canHistory = Array.isArray(result.capabilities) && result.capabilities.includes("updates.history"); net.supported = Array.isArray(result.capabilities) && result.capabilities.includes("network.status"); }).catch(() => {}).finally(() => { versionReading = false; refreshVersions(); refreshInstallPages(); if (canHistory) loadInstalls(); if (canBackground) void resumeRunning().then(startSilentWatch); if (net.supported && !net.result && !net.busy && !net.error) void detectNetwork(); if (!capabilitiesKnown) probeCapabilities(); });
  }
  function versionPanel() {
    const entry = buildVersionPanel();
    entry.notesMore.addEventListener("click", () => { entry.notesOpen = !entry.notesOpen; paintVersion(entry); });
    panels.add(entry); paintVersion(entry);
    loadReleaseNotes();
    if (window.piNativeUpdate?.state?.().available) syncFromShell(window.piNativeUpdate.state());
    if (!version && !versionReading) void readVersion();
    else {
      // 重新打开版本页时，后台下载可能还在跑：接上进度和已下好的包，而不是只剩一句「正在后台下载」。
      if (canReportProgress) startSilentWatch();
      if (canBackground) void resumeRunning();
      if (canHistory) loadInstalls();
      if (!capabilitiesKnown) probeCapabilities();
    }
    return entry.node;
  }
  /**
   * 能力读不到时（shell.status 排在一次原生下载后面、超时）直接问一次进度：
   * 能答就是能显示进度的 APK，后台下载照样看得见；老 APK 不支持就只问这一次。
   */
  function probeCapabilities() {
    if (capabilitiesKnown || capabilityProbed || ![...panels].some(entry => entry.node.isConnected)) return;
    capabilityProbed = true;
    call("updates.progress").then(result => {
      capabilitiesKnown = true; canReportProgress = true;
      if (result && ["downloading", "verifying"].includes(result.phase) && result.userStarted !== true) startSilentWatch();
      refreshVersions();
    }).catch(() => { /* 老 APK 没有这条能力：只问这一次 */ });
  }
  function canShare(data) {
    if (!data || typeof data !== "object") return false;
    const files = data.files || [];
    return Array.isArray(files) && files.length <= 4 && files.every(file => ["image/png", "image/jpeg", "image/webp"].includes(file.type) && file.size > 0 && file.size <= 5 * 1024 * 1024) && files.reduce((n, file) => n + file.size, 0) <= 8 * 1024 * 1024 && (!!data.text || !!data.url || files.length > 0);
  }
  async function share(data) {
    if (!canShare(data)) throw new Error("分享内容不支持或图片超过 8 MB，请分批分享");
    const status = await call("shell.status");
    if (!status.capabilities?.includes("share.send")) throw new Error("请更新 APK 以使用系统分享");
    const params = {};
    for (const key of ["title", "text", "url"]) if (data[key] !== undefined) params[key] = String(data[key]);
    if (data.files?.length) {
      params.files = [];
      for (const file of data.files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.length !== file.size) throw new Error("分享图片读取不完整");
        let binary = "";
        for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
        params.files.push({ name: file.name, type: file.type, data: btoa(binary) });
      }
    }
    return call("share.send", params);
  }
  // 系统状态栏、底部导航条跟网页同色：颜色由 styles.css 的 --system-bar-top / --system-bar-kind 决定（theme.js 同步到 theme-color），
  // 这里把「深浅」和「顶部是哪一种底」转告原生壳（指令不带参数，原生壳自己按同一套颜色表上色）。
  // 底部导航条：手机底部标签栏已改成悬浮玻璃胶囊（v3.78），胶囊下面露出的是页面底色，所以系统导航条一律跟页面底色，只在启动后通知原生壳一次。
  const TOP_KINDS = { bar: "chrome.top.bar", page: "chrome.top.page", surface: "chrome.top.surface" };
  let chromeDark = null, chromeBottomSent = false, chromeTop = null;
  // 冷启动时页面还在加载（原生会回「页面已变化」）、桥上排队的调用也多（超过 16 个会被拒），状态栏颜色指令可能没送达。
  // 失败后只清掉「已发送」标记不够：会话列表是启动落地页，之后没有 body class 变化再触发一次，状态栏就一直停在旧颜色。
  // 所以失败后按退避重试几次（1 / 2 / 4 / 8 / 16 秒），重试仍只发还没成功的那几条。
  let chromeRetries = 0, chromeRetryTimer = 0;
  function retryChrome() {
    if (chromeRetryTimer || chromeRetries >= 5 || typeof setTimeout !== "function") return;
    const delay = 1000 * 2 ** chromeRetries++;
    chromeRetryTimer = setTimeout(() => { chromeRetryTimer = 0; syncChrome(); }, delay);
  }
  function syncChrome() {
    if (typeof document === "undefined") return;
    if (!chromeBottomSent) {
      chromeBottomSent = true;
      call("chrome.bottom.page").catch(() => { chromeBottomSent = false; retryChrome(); });
    }
    const content = document.querySelector('meta[name="theme-color"]')?.getAttribute("content") || "";
    const m = /^#([0-9a-f]{6})$/i.exec(content.trim());
    if (!m) return;
    const n = parseInt(m[1], 16);
    const dark = (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) < 128;
    if (dark !== chromeDark) {
      chromeDark = dark;
      call(dark ? "chrome.dark" : "chrome.light").catch(() => { chromeDark = null; retryChrome(); });
    }
    let kind = "";
    try { kind = typeof getComputedStyle === "function" ? getComputedStyle(document.documentElement).getPropertyValue("--system-bar-kind").trim() : ""; } catch { /* 取不到就不报，原生壳沿用上一次 */ }
    const method = TOP_KINDS[kind];
    if (method && kind !== chromeTop) {
      chromeTop = kind;
      call(method).then(() => { chromeRetries = 0; }, () => { chromeTop = null; retryChrome(); });
    }
  }
  if (typeof document !== "undefined") {
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) new MutationObserver(syncChrome).observe(themeMeta, { attributes: true, attributeFilter: ["content"] });
    if (document.body) new MutationObserver(syncChrome).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    syncChrome();
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { syncChrome(); void autoDetect(); } });
    if (typeof window.addEventListener === "function") window.addEventListener("online", () => { lastAuto = 0; void autoDetect(); });
    mountNetwork();
    void autoDetect();
  }
  return { available: true, call, status: shellStatus, versionPanel, share, canShare, installsPage, ago, networkText, tipIfDirect, networkBadge, badge: () => net.badge };
})();
