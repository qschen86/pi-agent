/*
 * 连接状态弹层里的「Mac Mini」资源状态：CPU / GPU / 内存 / 硬盘占比 + 最近的网速。
 * 数据来自 GET /api/host/stats（服务端只在有人读取时采样）。只在弹层打开且页面可见时每 3 秒刷新一次，
 * 关闭或切到后台就停；读取失败保留上一次的数值并标明，不影响连接状态本身。
 */
(() => {
  const POLL_MS = 3000, TIMEOUT_MS = 6000;

  const formatBytes = (n) => {
    if (!Number.isFinite(n) || n < 0) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = n, i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
  };
  const formatRate = (n) => (Number.isFinite(n) && n >= 0 ? `${formatBytes(n)}/s` : "—");
  const formatPercent = (n) => (Number.isFinite(n) ? `${Math.round(n)}%` : "—");
  /** 占比的颜色档位：<70 正常，70–89 注意，≥90 紧张。 */
  const level = (n) => (!Number.isFinite(n) ? "" : n >= 90 ? "bad" : n >= 70 ? "warn" : "ok");

  function element(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) { if (value !== undefined && value !== null) el.setAttribute(key, value); }
    for (const child of children) { if (child !== null && child !== undefined) el.append(child); }
    return el;
  }

  function meter(key, label, percent, detail) {
    const known = Number.isFinite(percent);
    const fill = element("span", { class: "conn-host-fill", "data-level": level(percent) });
    fill.style.width = known ? `${Math.max(0, Math.min(100, percent))}%` : "0%";
    const bar = element("span", { class: "conn-host-bar", role: "progressbar", "aria-label": label, "aria-valuemin": "0", "aria-valuemax": "100", ...(known ? { "aria-valuenow": String(Math.round(percent)) } : {}) }, fill);
    return element("div", { class: "conn-host-row", "data-host": key },
      element("span", { class: "conn-host-label" }, label), bar,
      element("span", { class: "conn-host-value" }, formatPercent(percent)),
      detail ? element("span", { class: "conn-host-detail" }, detail) : null);
  }

  /** 数据还没到时的骨架：行数、明细行都与真实数据一致，到数据后原地换数字，弹层 / 菜单高度不变。 */
  const SKELETON = { cpu: { percent: NaN, cores: "—" }, gpu: { percent: NaN }, memory: { percent: NaN, usedBytes: NaN, totalBytes: NaN }, disk: { percent: NaN, usedBytes: NaN, totalBytes: NaN }, network: { interface: "—", windowSec: "—" }, windowSec: "—" };
  function render(box, stats, failed) {
    const pair = (a, b) => `${formatBytes(a)} / ${formatBytes(b)}`;
    const net = stats.network || {};
    // 空位（null）必须滤掉：replaceChildren 会把 null 当文字「null」画出来。
    box.replaceChildren(...[
      element("p", { class: "conn-host-title" }, "Mac Mini 状态"),
      meter("cpu", "CPU", stats.cpu?.percent, stats.cpu?.cores ? `${stats.cpu.cores} 核` : ""),
      meter("gpu", "GPU", stats.gpu?.percent, ""),
      meter("memory", "内存", stats.memory?.percent, stats.memory ? pair(stats.memory.usedBytes, stats.memory.totalBytes) : ""),
      meter("disk", "硬盘", stats.disk?.percent, stats.disk ? pair(stats.disk.usedBytes, stats.disk.totalBytes) : ""),
      element("div", { class: "conn-host-row conn-host-net", "data-host": "network" },
        element("span", { class: "conn-host-label" }, "网速"),
        element("span", { class: "conn-host-speed" },
          element("span", { "data-dir": "down", title: "下行（接收）" }, `↓ ${formatRate(net.rxBytesPerSec)}`),
          element("span", { "data-dir": "up", title: "上行（发送）" }, `↑ ${formatRate(net.txBytesPerSec)}`)),
        net.interface ? element("span", { class: "conn-host-detail" }, `${net.interface} · 近 ${stats.windowSec ?? "?"} 秒`) : null),
      failed ? element("p", { class: "conn-host-stale", role: "status" }, "刷新失败，显示的是上一次的数据") : null].filter(Boolean));
    box.classList.toggle("conn-host-pending", stats === SKELETON);
  }

  /*
   * 两个展示位共用一个轮询：
   *  - 连接状态弹层里的完整版（打开时）；
   *  - 「更多」菜单里「连接状态」那一行的缩略版（这一行在屏幕上可见时；nav-settings.js 用 attachCompact 登记）。
   * 任何一个需要才轮询，都不需要或页面在后台就停。
   */
  let timer = null, controller = null, last = null, unavailable = false, popoverOpen = false, box = null;
  const compacts = new Map(); // 缩略版节点 → 它所在行是否可见
  const wanted = () => document.visibilityState !== "hidden" && (popoverOpen || [...compacts.values()].some(Boolean));
  const stop = () => { clearTimeout(timer); timer = null; controller?.abort(); controller = null; };
  const schedule = () => { clearTimeout(timer); timer = wanted() ? setTimeout(poll, POLL_MS) : null; };
  const sync = () => { if (wanted()) { if (!controller && !timer) void poll(); } else stop(); };

  /** 缩略行用的短写法：84K/s、1.5M/s（单位不带 B，<10 才保留一位小数）。 */
  const compactRate = (n) => {
    if (!Number.isFinite(n) || n < 0) return "—";
    const units = ["B", "K", "M", "G", "T"];
    let value = n, i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return `${value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)}${units[i]}/s`;
  };
  function renderCompact(host, stats, stale) {
    const item = (label, percent) => element("span", { class: "nav-host-item", "data-level": level(percent) }, `${label} `, element("b", {}, formatPercent(percent)));
    const net = stats.network || {};
    host.replaceChildren(
      item("CPU", stats.cpu?.percent), item("GPU", stats.gpu?.percent), item("内存", stats.memory?.percent), item("硬盘", stats.disk?.percent),
      element("span", { class: "nav-host-item nav-host-net" }, `↓${compactRate(net.rxBytesPerSec)} ↑${compactRate(net.txBytesPerSec)}`));
    host.dataset.stale = stale ? "1" : "";
    host.dataset.pending = "";
    host.hidden = false;
  }
  /** 缩略行骨架：用典型数值排出和真实行一样的换行与宽度，但整行透明、只显示灰色块（CSS 的 data-pending），数据到了原地替换。 */
  const COMPACT_SAMPLE = { cpu: { percent: 88 }, gpu: { percent: 88 }, memory: { percent: 88 }, disk: { percent: 88 }, network: { rxBytesPerSec: 1.5 * 2 ** 20, txBytesPerSec: 84 * 1024 } };
  function renderCompactSkeleton(host) {
    renderCompact(host, COMPACT_SAMPLE, false);
    host.dataset.pending = "1";
  }
  function paint(failed) {
    if (unavailable) {
      if (box) box.hidden = true;
      for (const host of compacts.keys()) host.hidden = true;
      return;
    }
    if (!last && !failed) return; // 还在等第一份数据：保留骨架占位，不收起
    if (box && popoverOpen) {
      box.hidden = false;
      if (last) render(box, last, failed);
      else box.replaceChildren(element("p", { class: "conn-host-stale", role: "status" }, "暂时读不到 Mac Mini 状态"));
    }
    for (const host of compacts.keys()) { if (last) renderCompact(host, last, failed); else renderCompactSkeleton(host); }
  }
  async function poll() {
    if (!wanted()) return;
    controller?.abort();
    const mine = controller = new AbortController();
    const timeout = setTimeout(() => mine.abort(), TIMEOUT_MS);
    try {
      const res = await fetch("/api/host/stats", { cache: "no-store", credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" }, signal: mine.signal });
      // 未登录 / 旧版本服务端没有这个接口：整块与缩略行都不显示，连接状态说明照旧。
      if (res.status === 401 || res.status === 404) {
        // 不消费响应体时浏览器会一直挂着这条连接（route-loading 的 networkidle 用例暴露过）。
        try { await res.text(); } catch { /* 读不读都不影响结论 */ }
        if (controller === mine) { unavailable = true; paint(false); }
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      if (controller === mine) { last = data; unavailable = false; paint(false); }
    } catch {
      if (controller === mine) paint(true);
    } finally { clearTimeout(timeout); if (controller === mine) { controller = null; schedule(); } }
  }

  /** target：这一行在屏幕上是否可见由它决定（display:none 时不轮询）。 */
  function attachCompact(host, target) {
    if (!host || compacts.has(host)) return;
    compacts.set(host, typeof IntersectionObserver === "undefined");
    if (typeof IntersectionObserver !== "undefined") {
      new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        compacts.set(host, entry.isIntersecting);
        if (entry.isIntersecting && last && !unavailable) renderCompact(host, last, true); // 先给上次的数据，刷新完成后去掉「旧」标记
        sync();
      }).observe(target || host);
    } else sync();
    if (unavailable) return;
    if (last) renderCompact(host, last, true); else renderCompactSkeleton(host);
  }

  function mount() {
    box = document.getElementById("conn-detail-host");
    const detail = document.getElementById("conn-detail");
    if (!box || !detail || box.dataset.mounted) return;
    box.dataset.mounted = "1";
    detail.addEventListener("beforetoggle", (event) => {
      popoverOpen = event.newState === "open";
      // 打开瞬间就占好位置：有上次的数据先用旧的，没有就用骨架，等第一份数据到了原地替换
      if (popoverOpen) { if (!unavailable) { box.hidden = false; render(box, last || SKELETON, false); } stop(); sync(); } else sync();
    });
  }
  document.addEventListener("visibilitychange", () => { stop(); sync(); });

  window.piHostStats = { formatBytes, formatRate, formatPercent, level, compactRate, attachCompact };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
