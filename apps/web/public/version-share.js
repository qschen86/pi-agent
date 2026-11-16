"use strict";
/* Safe version-page share model. Never clone the private page DOM. */
(() => {
  const RUNTIMES = { codex: "Codex", "claude-code": "Claude Code", pi: "Pi", unknown: "未知" };
  const STATES = { ok: "成功", failed: "失败", cancelled: "已取消", expired: "等待超时", "already-live": "已在线上" };
  const count = value => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const runtime = value => Object.hasOwn(RUNTIMES, value) ? value : "unknown";
  function timestamp(value) {
    if (typeof value === "number") return Number.isFinite(value) && Math.abs(value) <= 8640000000000000 ? value : NaN;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
    return Date.parse(value);
  }
  function dateText(value) {
    const ms = timestamp(value);
    if (!Number.isFinite(ms)) return "时间未知";
    const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
    return parts;
  }
  function validDay(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  }
  function project(data, options = {}) {
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    const active = Array.isArray(data?.active) ? data.active : [];
    const selectedRuntime = Object.hasOwn(RUNTIMES, options.heatRuntime) ? options.heatRuntime : "all";
    const periods = {};
    for (const key of ["today", "last7", "last30", "all"]) {
      const p = selectedRuntime === "all" ? data?.periods?.[key] : data?.runtimePeriods?.[selectedRuntime]?.[key];
      periods[key] = { total: count(p?.total), ok: count(p?.ok), failed: count(p?.failed) };
    }
    const heatRuntime = options.heatRuntime === "all" ? "all" : runtime(options.heatRuntime);
    return {
      generatedAt: dateText(options.now ?? Date.now()),
      legacyStats: !!options.stale && data?.statsTimeZone !== "Asia/Shanghai",
      stale: !!options.stale, snapshotAt: dateText(options.snapshotAt),
      scopeLabel: options.scope === "all" ? `全部 ${entries.length} 条历史` : `已加载 ${entries.length} / ${count(data?.total)} 条历史`,
      heatRuntime: heatRuntime === "unknown" && options.heatRuntime !== "unknown" ? "all" : heatRuntime,
      periods,
      calendar: (Array.isArray(data?.calendar) ? data.calendar : []).filter(row => validDay(row?.date)).map(row => ({
        date: row.date, total: count(row.total), runtimes: Object.fromEntries(Object.keys(RUNTIMES).map(key => [key, count(row.runtimes?.[key])])),
      })),
      entries: entries.map(row => ({ date: dateText(row.atMs), state: Object.hasOwn(STATES, row.state) ? STATES[row.state] : "已结束", runtime: RUNTIMES[runtime(row.runtimeKind)] })),
      active: active.map(row => ({ date: dateText(row.requestedAt), state: row.state === "started" ? "部署中" : "排队中", runtime: RUNTIMES[runtime(row.runtimeKind)] })),
    };
  }
  function checkAbort(signal) { if (signal?.aborted) throw new DOMException("已取消", "AbortError"); }
  async function collectHistory(fetchPage, { signal, onProgress } = {}) {
    checkAbort(signal);
    const get = async offset => { const value = await fetchPage({ limit: 500, offset, tz: "Asia/Shanghai", signal }); checkAbort(signal); return value; };
    const first = await get(0);
    if (!Number.isSafeInteger(first?.total) || first.total < 0 || first.total > 100000) throw new Error("历史数量超出接口可读取范围，未生成图片");
    const anchor = value => JSON.stringify([value.total, value.statsAt, value.entries?.[0]?.id]);
    const seen = new Set(), entries = [];
    let page = first;
    for (;;) {
      if (page.total !== first.total || page.statsAt !== first.statsAt) throw new Error("历史已变化，请重新生成");
      if (!Array.isArray(page.entries)) throw new Error("历史不完整，请重试");
      for (const row of page.entries) {
        if (typeof row.id !== "string" || !row.id || seen.has(row.id)) throw new Error("历史变化或不完整，请重新生成");
        seen.add(row.id); entries.push(row);
      }
      if (entries.length > first.total || (!page.entries.length && entries.length < first.total)) throw new Error("历史不完整，请重试");
      onProgress?.(entries.length, first.total);
      if (entries.length === first.total) break;
      page = await get(entries.length);
    }
    if (anchor(await get(0)) !== anchor(first)) throw new Error("历史已变化，请重新生成");
    return { ...first, entries };
  }
  // Render only the whitelisted model. No private attributes or free-form errors.
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  const labels = { today: "今日", last7: "最近 7 天", last30: "最近 30 天", all: "累计" };
  function card(title, subtitle) {
    const node = el("section", "vs-card");
    node.append(el("h2", "", title));
    if (subtitle) node.append(el("p", "vs-sub", subtitle));
    return node;
  }
  function summary(model) {
    const node = card("版本统计", model.legacyStats ? "全局部署统计 · 旧快照日期口径" : `${model.heatRuntime === "all" ? "全部" : RUNTIMES[model.heatRuntime]}部署统计 · 北京时间`);
    const grid = el("div", "vs-metrics");
    for (const [key, name] of Object.entries(labels)) {
      const stat = model.periods[key], metric = el("div", "vs-metric");
      metric.append(el("span", "vs-sub", name), el("strong", "vs-number", String(stat.total)), el("span", "vs-sub", `成功 ${stat.ok}  ·  失败 ${stat.failed}`));
      grid.append(metric);
    }
    node.append(grid); return node;
  }
  function heatmap(model) {
    const label = model.heatRuntime === "all" ? "全部运行时" : RUNTIMES[model.heatRuntime];
    const node = card("部署日历", `最近 53 周 · ${label}${model.legacyStats ? " · 旧快照日期口径" : ""} · 颜色越深表示部署越多`);
    const end = new Date(model.generatedAt.slice(0, 10) + "T00:00:00Z");
    const weekday = (end.getUTCDay() + 6) % 7;
    const start = new Date(+end - (52 * 7 + weekday) * 86400000);
    const days = new Map(model.calendar.map(row => [row.date, row]));
    const grid = el("div", "vs-heat");
    const months = el("div", "vs-months");
    const max = Math.max(1, ...model.calendar.map(row => model.heatRuntime === "all" ? row.total : row.runtimes[model.heatRuntime]));
    let previous = "";
    for (let week = 0; week < 53; week++) {
      const date = new Date(+start + week * 7 * 86400000), month = date.toISOString().slice(0, 7);
      months.append(el("span", "", month !== previous && (week !== 0 || date.getUTCDate() <= 14) ? `${date.getUTCMonth() + 1}月` : "")); previous = month;
      const column = el("div", "vs-week");
      for (let day = 0; day < 7; day++) {
        const current = new Date(+date + day * 86400000), key = current.toISOString().slice(0, 10), row = days.get(key);
        const cell = el("div", "vs-cell");
        cell.dataset.date = key;
        if (+current > +end) cell.classList.add("vs-future");
        else if (row) {
          const value = model.heatRuntime === "all" ? row.total : row.runtimes[model.heatRuntime];
          const alpha = value ? 0.22 + 0.78 * Math.min(1, value / max) : 0;
          if (alpha && model.heatRuntime === "all") {
            const colors = { codex: "#3674d9", "claude-code": "#c87750", pi: "#7950c7", unknown: "#777581" };
            const parts = [], total = Object.values(row.runtimes).reduce((a, b) => a + b, 0);
            let offset = 0;
            for (const key of Object.keys(RUNTIMES)) {
              const n = row.runtimes[key]; if (!n) continue;
              parts.push(`${colors[key]} ${offset}% ${(offset += n / total * 100)}%`);
            }
            cell.style.background = parts.length ? `linear-gradient(90deg,${parts.join(",")})` : "#7950c7";
            cell.style.opacity = String(alpha);
          } else if (alpha) { cell.style.background = ({ codex: "#3674d9", "claude-code": "#c87750", pi: "#7950c7", unknown: "#777581" })[model.heatRuntime]; cell.style.opacity = String(alpha); }
        }
        column.append(cell);
      }
      grid.append(column);
    }
    const legend = el("div", "vs-legend");
    for (const [key, name] of Object.entries(RUNTIMES)) {
      const item = el("span", `vs-runtime vs-runtime-${key}`, name); legend.append(item);
    }
    node.append(months, grid, legend); return node;
  }
  function record(row) {
    const node = el("div", "vs-record");
    const status = el("span", row.state === "失败" ? "vs-state vs-failed" : "vs-state", row.state);
    node.append(status, el("strong", "", "部署记录"), el("span", "vs-record-runtime", row.runtime), el("time", "", row.date));
    return node;
  }
  function sheet(model) {
    const node = el("article", "version-share-sheet");
    const head = el("header", "vs-header"), mark = el("span", "vs-mark", "pi"), title = el("div", "");
    title.append(el("span", "vs-eyebrow", "PI PLATFORM"), el("h1", "", "版本部署概览"));
    head.append(mark, title); node.append(head);
    if (model.stale) node.append(el("p", "vs-stale", `离线快照 · ${model.snapshotAt} · 尚未同步最新`));
    node.append(el("p", "vs-scope", `${model.scopeLabel} · 已隐藏内部信息`));
    const body = el("div", "vs-body"), footer = el("footer", "vs-footer");
    footer.append(el("span", "", `生成于 ${model.generatedAt}（北京时间）`), el("span", "vs-page", ""));
    node.append(body, footer); return node;
  }
  function paginate(model, host) {
    const pages = [], maxHeight = 3200;
    let page, body;
    function next() { page = sheet(model); host.append(page); body = page.querySelector(".vs-body"); pages.push(page); }
    next(); body.append(summary(model), heatmap(model));
    function addRows(title, rows, empty) {
      let group = card(title, title === "部署历史" ? model.scopeLabel : "生成时的部署状态");
      body.append(group);
      if (!rows.length) {
        group.append(el("p", "vs-empty", empty));
        if (page.getBoundingClientRect().height > maxHeight) { group.remove(); next(); body.append(group); }
        return;
      }
      for (const row of rows) {
        const item = record(row); group.append(item);
        if (page.getBoundingClientRect().height > maxHeight) {
          item.remove(); if (!group.querySelector(".vs-record")) group.remove();
          next(); group = card(`${title}（续）`, title === "部署历史" ? model.scopeLabel : "生成时的部署状态"); body.append(group); group.append(item);
        }
      }
    }
    addRows("进行中", model.active, "当前没有进行中的部署");
    addRows("部署历史", model.entries, "暂无部署历史");
    pages.forEach((page, i) => { page.querySelector(".vs-page").textContent = `第 ${i + 1} / ${pages.length} 张`; });
    return pages;
  }
  let current = null;
  function open(options) {
    current?.close();
    const frozen = structuredClone(options.data);
    const dialog = el("dialog", "version-share-dialog");
    dialog.setAttribute("aria-label", "分享版本图片");
    const head = el("div", "version-share-head"), closeButton = el("button", "btn small", "关闭");
    closeButton.type = "button"; closeButton.setAttribute("aria-label", "关闭分享预览");
    head.append(el("h2", "", "分享图片"), closeButton);
    const scopeLabel = el("label", "version-share-range", "历史范围"), scope = el("select", "");
    scope.setAttribute("aria-label", "历史范围");
    for (const [value, name] of [["loaded", `已加载 ${frozen.entries.length} 条`], ["all", "全部历史"]]) {
      const option = el("option", "", name); option.value = value; scope.append(option);
    }
    scopeLabel.append(scope);
    const privacy = el("p", "muted small", "仅在本机生成，已隐藏提交与会话标题、SHA、内部链接、路径和日志。图片含部署日期、次数与状态，请预览后分享。");
    const status = el("p", "version-share-status"); status.setAttribute("role", "status");
    const preview = el("div", "version-share-preview"), actions = el("div", "version-share-actions");
    const retry = el("button", "btn small", "重新生成"); retry.type = "button";
    dialog.append(head, privacy, scopeLabel, status, preview, actions, retry);
    let controller, urls = [], outputs = [], closed = false, host;
    const clear = () => { for (const url of urls) URL.revokeObjectURL(url); urls = []; outputs = []; preview.replaceChildren(); actions.replaceChildren(); };
    const stop = () => { controller?.abort(); host?.remove(); host = null; };
    const close = () => {
      if (closed) return; closed = true; stop();
      dialog.querySelector(".image-zoom-close")?.click(); clear(); dialog.close(); dialog.remove();
      window.removeEventListener("hashchange", close); if (current?.dialog === dialog) current = null;
      (options.returnFocus?.isConnected ? options.returnFocus : document.querySelector(".settings-share-button"))?.focus();
    };
    closeButton.onclick = close; dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
    window.addEventListener("hashchange", close);
    async function generate() {
      stop(); clear(); controller = new AbortController(); const signal = controller.signal;
      status.textContent = "正在准备分享图片…"; retry.disabled = true;
      const range = scope.value;
      const taskHost = el("div", "version-share-render-host"); host = taskHost; document.body.append(taskHost);
      const localUrls = [];
      try {
        let data = frozen;
        if (range === "all") {
          data = await collectHistory(({ limit, offset, tz, signal }) => api(`/api/platform/deployments?limit=${limit}&offset=${offset}&tz=${tz}`, { signal }), {
            signal, onProgress: (n, total) => { if (!signal.aborted) status.textContent = `正在读取历史 ${n} / ${total}…`; },
          });
        }
        checkAbort(signal);
        const model = project(data, { ...options, scope: range, stale: range === "all" ? false : options.stale });
        const pages = paginate(model, taskHost);
        const renderer = window.piShareImageRenderer || await window.piRouteModules.ensure("share-image-renderer");
        checkAbort(signal); await document.fonts.ready; checkAbort(signal);
        const blobs = [];
        for (let i = 0; i < pages.length; i++) {
          status.textContent = `正在生成第 ${i + 1} / ${pages.length} 张…`;
          const blob = await renderer.toBlob(pages[i]); checkAbort(signal);
          blobs.push(blob); localUrls.push(URL.createObjectURL(blob)); pages[i].remove();
        }
        checkAbort(signal); urls = localUrls; outputs = blobs;
        urls.forEach((url, index) => {
          const item = el("div", "version-share-image"), img = el("img", "");
          img.src = url; img.alt = `版本分享图片，第 ${index + 1} / ${urls.length} 张`; img.tabIndex = 0;
          const enlarge = () => {
            if (!window.openImageZoom) return;
            window.openImageZoom(urls.map((src, i) => ({ src, name: `版本分享 ${i + 1}/${urls.length}` })), index);
            // Keep the existing gesture viewer inside the modal top layer.
            const zoom = document.querySelector(".image-zoom"); if (zoom) dialog.append(zoom);
          };
          img.onclick = enlarge; img.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); enlarge(); } };
          item.append(img, el("span", "muted small", `第 ${index + 1} / ${urls.length} 张 · 点击放大`)); preview.append(item);
          const download = el("a", "btn small", `下载第 ${index + 1} 张`);
          download.href = url; download.download = `pi-version-${model.generatedAt.slice(0, 10)}-${String(index + 1).padStart(2, "0")}.png`; actions.append(download);
        });
        const files = blobs.map((blob, i) => new File([blob], `pi-version-${i + 1}.png`, { type: "image/png" }));
        if (window.piAndroidShell?.canShare({ files }) || navigator.share && navigator.canShare?.({ files })) {
          const share = el("button", "btn primary", "系统分享"); share.type = "button";
          share.onclick = async () => {
            share.disabled = true;
            try { if (window.piAndroidShell) await window.piAndroidShell.share({ files }); else await navigator.share({ files }); }
            catch (error) { if (error.name !== "AbortError" && !closed) status.textContent = "系统分享未完成，可下载图片后分享"; }
            finally { share.disabled = false; }
          }; actions.append(share);
        }
        status.textContent = `已生成 ${urls.length} 张 · ${model.scopeLabel}`;
      } catch (error) {
        for (const url of localUrls) URL.revokeObjectURL(url);
        if (!signal.aborted && !closed) status.textContent = "未能生成图片：读取不完整、数据变化或图片生成失败，请重新生成";
      } finally {
        taskHost.remove(); if (host === taskHost) host = null;
        if (!signal.aborted && !closed) retry.disabled = false;
      }
    }
    retry.onclick = generate; scope.onchange = generate;
    current = { dialog, close }; document.body.append(dialog); dialog.showModal(); void generate();
    return { close };
  }
  window.piVersionShare = { project, collectHistory, open };
  window.piRouteModules?.register("version-share", window.piVersionShare);
})();
