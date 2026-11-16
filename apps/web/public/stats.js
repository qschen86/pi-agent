"use strict";
/*
 * 统计应用（#/stats）：把 pi-agent 各处的统计汇总到一页，分「消耗 / 会话 / 部署」三个模块，
 * 每个模块有若干指标（费用 / Token、会话数、部署数 / 耗时 / 成功率），统一提供：
 *   区间合计（今日、昨日、近 7 天、近 30 日）→ 按维度拆解（runtime / 应用·功能 / 发起端 / 控制器版本，每个维度一个饼图、同时展示）
 *   → 日期趋势图 → 整年热力图（GitHub 贡献图那样，按周按天）。
 * 数据来自 GET /api/stats/<domain>：北京时间按日的「指标 × 维度」明细，区间合计、拆解、趋势、热力图都在这里算。
 * 地址：#/stats/<domain>?m=<指标>&focus=trend|heat，其它页面的入口都用这个地址跳进来。
 */
(function () {
  const RUNTIME_LABEL = { pi: "Pi", "claude-code": "Claude", codex: "Codex", unknown: "未知" };
  const DEVICE_LABEL = { mobile: "手机", desktop: "PC", auto: "自动", unknown: "未知" };
  const DIM_LABEL = { runtime: "Runtime", app: "应用 / 功能", device: "发起端", controller: "控制器版本" };
  const RANGES = [
    { id: "today", label: "今日", days: 1, offset: 0 },
    { id: "yesterday", label: "昨日", days: 1, offset: 1 },
    { id: "7d", label: "近 7 天", days: 7, offset: 0 },
    { id: "30d", label: "近 30 日", days: 30, offset: 0 },
  ];
  const TREND_DAYS = 90; // 趋势图固定看近 90 天
  const LOAD_DAYS = 371; // 53 周：热力图要整年
  const STALE_MS = 60_000;

  // 指标：num / den 是「按日明细里的哪些量」，区间值 = Σnum（有 den 时 = Σnum ÷ Σden）
  const DOMAINS = {
    cost: {
      label: "消耗", dims: ["runtime", "app", "device"],
      metrics: [
        { id: "usd", label: "费用", num: ["usd"], fmt: "usd", additive: true },
        { id: "tokens", label: "Token", num: ["tokens"], fmt: "tokens", additive: true },
      ],
    },
    sessions: {
      label: "会话", dims: ["runtime", "app", "device"],
      metrics: [{ id: "sessions", label: "会话数", num: ["sessions"], fmt: "count", additive: true }],
    },
    deploys: {
      label: "部署", dims: ["runtime", "controller", "device"],
      metrics: [
        { id: "deploys", label: "部署数", num: ["deploys"], fmt: "count", additive: true },
        { id: "duration", label: "部署耗时", num: ["durationMs"], den: ["durationN"], fmt: "duration", sub: "n" },
        { id: "rate", label: "成功率", num: ["ok"], den: ["ok", "failed"], fmt: "rate", sub: "ratio" },
      ],
    },
  };

  /* ---------------------------------- 格式化 ---------------------------------- */
  const fmtInt = (n) => Math.round(n).toLocaleString("zh-CN");
  function fmtUsd(n) {
    if (n >= 10000) return `$${(n / 1000).toFixed(1)}k`;
    if (n >= 100) return `$${Math.round(n)}`;
    return `$${n.toFixed(2)}`;
  }
  function fmtToken(n) {
    if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1).replace(/\.0$/, "")} 亿`;
    if (n >= 10_000) return `${(n / 10_000).toFixed(1).replace(/\.0$/, "")} 万`;
    return fmtInt(n);
  }
  function fmtDuration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} 秒`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} 分 ${String(s % 60).padStart(2, "0")} 秒`;
    return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
  }
  const fmtRate = (r) => `${Math.round(r * 100)}%`;
  const FORMAT = { usd: fmtUsd, tokens: fmtToken, count: fmtInt, duration: fmtDuration, rate: fmtRate };
  const fmtValue = (metric, value) => (value === null || value === undefined ? "—" : FORMAT[metric.fmt](value));

  function keyLabel(dim, key) {
    if (dim === "runtime") return RUNTIME_LABEL[key] || key;
    if (dim === "device") return DEVICE_LABEL[key] || key;
    return key;
  }

  /* ---------------------------------- 日期 ---------------------------------- */
  const shiftDay = (day, delta) => {
    const [y, m, d] = day.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
  };
  const monthOf = (day) => day.slice(0, 7);
    const weekdayOf = (day) => { const [y, m, d] = day.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
  const shortDay = (day) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
  const longDay = (day) => `${Number(day.slice(5, 7))} 月 ${Number(day.slice(8, 10))} 日 周${"日一二三四五六"[weekdayOf(day)]}`;

  /* ---------------------------------- 聚合 ---------------------------------- */
  function sumParts(days, ids, dim, key) {
    let total = 0;
    for (const day of days) for (const id of ids) {
      const m = day.v[id];
      if (m) total += key === undefined ? m.total : (m.by[dim]?.[key] || 0);
    }
    return total;
  }
  /** 区间值；有分母时分母为 0 返回 null（那段时间没有可算的样本）。 */
  function valueOf(metric, days, dim, key) {
    const num = sumParts(days, metric.num, dim, key);
    if (!metric.den) return num;
    const den = sumParts(days, metric.den, dim, key);
    return den ? num / den : null;
  }
  function rangeDays(data, range) {
    const to = shiftDay(data.to, -range.offset), from = shiftDay(to, -(range.days - 1));
    return data.days.filter((d) => d.day >= from && d.day <= to);
  }
  const rangeSpan = (data, range) => {
    const to = shiftDay(data.to, -range.offset), from = shiftDay(to, -(range.days - 1));
    return from === to ? shortDay(to) : `${shortDay(from)} – ${shortDay(to)}`;
  };

  /* ---------------------------------- 状态 ---------------------------------- */
  function state() {
    // app.js 在路由里只放 returnHash；其余字段在这里补齐
    const s = (ui.stats ||= {});
    s.domain ||= "cost"; s.range ||= "7d";
    s.metric ||= {}; s.data ||= {}; s.error ||= {}; s.loading ||= {};
    s.hash ??= ""; s.picked ??= ""; s.focus ??= "";
    return s;
  }
  function parseHash(hash) {
    const m = /^#\/stats(?:\/(cost|sessions|deploys))?(?:\?(.*))?$/.exec(hash || "");
    if (!m) return null;
    const q = new URLSearchParams(m[2] || "");
    return { domain: m[1] || "cost", metric: q.get("m") || "", focus: q.get("focus") || "" };
  }
  /** 地址变化（从别处跳进来）时采用地址里的模块 / 指标 / 维度；页内切换时自己维护状态。 */
  function adoptHash() {
    const s = state(), parsed = parseHash(location.hash);
    if (!parsed || s.hash === location.hash) return;
    s.hash = location.hash;
    s.domain = parsed.domain;
    const def = DOMAINS[parsed.domain];
    if (def.metrics.some((m) => m.id === parsed.metric)) s.metric[parsed.domain] = parsed.metric;
    s.focus = parsed.focus === "trend" || parsed.focus === "heat" ? parsed.focus : "";
    s.picked = "";
  }
  function syncHash() {
    const s = state(), def = DOMAINS[s.domain];
    const q = new URLSearchParams();
    if (metricOf().id !== def.metrics[0].id) q.set("m", metricOf().id);
    const hash = `#/stats/${s.domain}${q.toString() ? `?${q}` : ""}`;
    s.hash = hash;
    history.replaceState(null, "", hash);
  }
  const defOf = () => DOMAINS[state().domain];
  const metricOf = () => { const s = state(), def = defOf(); return def.metrics.find((m) => m.id === s.metric[s.domain]) || def.metrics[0]; };
  const dataOf = () => state().data[state().domain]?.value || null;

  function load(domain, force = false) {
    const s = state(), entry = s.data[domain];
    if (s.loading[domain]) return s.loading[domain];
    if (!force && entry && Date.now() - entry.at < STALE_MS) return Promise.resolve();
    s.error[domain] = "";
    const flight = api(`/api/stats/${domain}?days=${LOAD_DAYS}`)
      .then((value) => {
        if (!value || !Array.isArray(value.days)) throw new Error("统计数据格式无效");
        s.data[domain] = { value, at: Date.now() };
      })
      .catch((e) => { s.error[domain] = e.message || "读取失败"; })
      .finally(() => { delete s.loading[domain]; if (ui.view === "stats") rerender(); });
    s.loading[domain] = flight;
    if (ui.view === "stats") rerender();
    return flight;
  }

  /* ---------------------------------- 组件 ---------------------------------- */
  // 页面可能运行在 style-src 'self' 之下：内联 style 属性会被拦，宽度 / 位置一律用 CSSOM 赋值
  function styled(el, props) { for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v); return el; }

  // 页签 / 分段统一用全局组件：一级页签 = .pm-tabs（和资源、记忆页同款），页内分段 = .inpage-tabs；
  // 选中气泡由 seg-indicator.js 按 aria-selected 画，这里不再自己写样式。
  function tabButton(label, on, onclick, extra = {}) {
    return h("button", { type: "button", role: "tab", class: `stats-tab${on ? " active" : ""}`, "aria-selected": String(on), onclick, ...extra }, label);
  }

  function header() {
    const s = state();
    const back = typeof s.returnHash === "string" && s.returnHash.startsWith("#/") && !s.returnHash.startsWith("#/stats") ? s.returnHash : "#/settings";
    return h("header", { class: "stats-head" },
      h("a", { class: "stats-back", href: back, "aria-label": "返回" }, "‹ 返回"),
      h("h1", {}, "统计"),
      h("button", {
        type: "button", class: "stats-refresh", "data-key": "stats-refresh", disabled: !!s.loading[s.domain],
        onclick: () => void load(s.domain, true),
      }, s.loading[s.domain] ? "刷新中…" : "刷新"));
  }

  function domainTabs() {
    const s = state();
    return h("div", { class: "pm-tabs stats-domains", role: "tablist", "aria-label": "统计模块" },
      Object.entries(DOMAINS).map(([id, def]) => tabButton(def.label, s.domain === id, () => {
        if (s.domain === id) return;
        s.domain = id; s.picked = ""; s.focus = "";
        syncHash(); void load(id); rerender();
      }, { "data-key": `stats-domain-${id}` })));
  }

  function metricTabs() {
    const s = state(), def = defOf();
    if (def.metrics.length < 2) return null;
    return h("div", { class: "inpage-tabs stats-metrics", role: "tablist", "aria-label": "指标" },
      def.metrics.map((m) => tabButton(m.label, metricOf().id === m.id, () => {
        s.metric[s.domain] = m.id; s.picked = ""; syncHash(); rerender();
      }, { "data-key": `stats-metric-${m.id}` })));
  }

  function rangeCards(data) {
    const s = state(), metric = metricOf();
    return h("div", { class: "stats-ranges", role: "group", "aria-label": "区间合计" },
      RANGES.map((range) => {
        const on = s.range === range.id;
        const value = data ? valueOf(metric, rangeDays(data, range)) : undefined;
        return h("button", {
          type: "button", class: `stats-range${on ? " on" : ""}`, "aria-pressed": String(on), "data-key": `stats-range-${range.id}`,
          onclick: () => { s.range = range.id; rerender(); },
        },
          h("span", { class: "stats-range-label" }, range.label),
          h("strong", { class: `stats-range-value${data ? "" : " skeleton"}` }, data ? fmtValue(metric, value) : " "),
          h("span", { class: "stats-range-span" }, data ? rangeSpan(data, range) : " "));
      }));
  }

  /* ---- 拆解：每个维度一个饼图（环形），三个同时展示，不用切页签 ---- */
  const PIE_VISIBLE = 6; // 图例默认最多显示六项，可展开查看全部
  const RUNTIME_PIE = { pi: "sp-rt-pi", "claude-code": "sp-rt-claude", codex: "sp-rt-codex" };
  const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function pieClass(dim, key, index) {
    if (key === "__other") return "sp-other";
    if (key === "unknown" || key === "未知") return "sp-gray";
    if (dim === "runtime" && RUNTIME_PIE[key]) return RUNTIME_PIE[key];
    return `sp-c${index % 6}`;
  }

  /** 某个维度在区间内的各块：num / den 是区间合计，value 是指标值，weight 是饼图里的大小（累加型 = 数值本身，比率型 = 样本数）。 */
  function pieRows(metric, dim, days) {
    const keys = new Set();
    for (const day of days) for (const id of [...metric.num, ...(metric.den || [])]) for (const key of Object.keys(day.v[id]?.by[dim] || {})) keys.add(key);
    const rows = [...keys].map((key) => ({
      key, num: sumParts(days, metric.num, dim, key), den: metric.den ? sumParts(days, metric.den, dim, key) : 0,
    })).map((r) => ({ ...r, weight: metric.den ? r.den : r.num })).filter((r) => r.weight > 0).sort((a, b) => b.weight - a.weight);
    return rows.map((r) => ({ ...r, value: metric.den ? (r.den ? r.num / r.den : null) : r.num }));
  }

  /** 环形图：按各块占比画扇形；只有一块时画整圈。颜色靠 class（样式表里定义），不写内联样式。 */
  function pieSvg(rows, dim, metric) {
    const total = rows.reduce((n, r) => n + r.weight, 0);
    const R = 50, r = 29, C = 60, at = (rad, a) => `${(C + rad * Math.cos(a)).toFixed(2)} ${(C + rad * Math.sin(a)).toFixed(2)}`;
    let angle = -Math.PI / 2, out = "";
    rows.forEach((row, i) => {
      const frac = row.weight / total, cls = pieClass(dim, row.key, i);
      const label = `${esc(keyLabel(dim, row.key === "__other" ? "其他" : row.key))}：${esc(fmtValue(metric, row.value))}（${Math.round(frac * 100)}%）`;
      if (frac >= 0.9999) { out += `<circle class="stats-ring ${cls}" cx="${C}" cy="${C}" r="${(R + r) / 2}" stroke-width="${R - r}"><title>${label}</title></circle>`; return; }
      const next = angle + frac * 2 * Math.PI, large = frac > 0.5 ? 1 : 0;
      out += `<path class="stats-slice ${cls}" d="M${at(R, angle)} A${R} ${R} 0 ${large} 1 ${at(R, next)} L${at(r, next)} A${r} ${r} 0 ${large} 0 ${at(r, angle)} Z"><title>${label}</title></path>`;
      angle = next;
    });
    return `<svg viewBox="0 0 120 120" role="img" aria-hidden="true">${out}</svg>`;
  }

  function pieCard(dim, metric, days) {
    const rows = pieRows(metric, dim, days);
    const card = h("div", { class: `stats-pie${rows.length > 3 ? " stats-pie-wide" : ""}`, "data-pie": dim, role: "group", "aria-label": `按${DIM_LABEL[dim]}拆解` },
      h("h3", {}, DIM_LABEL[dim]));
    if (!rows.length) { card.append(h("p", { class: "muted small stats-empty", role: "status" }, "没有数据")); return card; }
    const total = rows.reduce((n, r) => n + r.weight, 0);
    const chart = h("div", { class: "stats-pie-chart" });
    chart.innerHTML = pieSvg(rows, dim, metric);
    // 环中间：累加型显示合计，比率型显示整体值
    chart.append(h("div", { class: "stats-pie-center" },
      h("strong", {}, fmtValue(metric, valueOf(metric, days))),
      h("span", {}, metric.additive ? "合计" : "整体")));
    const legend = h("ul", { class: "stats-pie-legend" }, rows.map((r, i) => {
      const sub = metric.additive ? `${Math.round(r.weight / total * 100)}%`
        : metric.sub === "n" ? `${fmtInt(r.den)} 次` : `${fmtInt(r.num)}/${fmtInt(r.den)}`;
      return h("li", { class: "stats-pie-row", hidden: i >= PIE_VISIBLE },
        h("i", { class: `stats-dot ${pieClass(dim, r.key, i)}`, "aria-hidden": "true" }),
        h("span", { class: "stats-pie-name" }, keyLabel(dim, r.key === "__other" ? "其他" : r.key)),
        h("span", { class: "stats-pie-meta" },
          h("span", { class: "stats-pie-value" }, fmtValue(metric, r.value)),
          h("span", { class: "stats-pie-sub" }, sub)));
    }));
    const legendPanel = h("div", { class: "stats-pie-legend-panel" }, legend);
    if (rows.length > PIE_VISIBLE) {
      const toggle = h("button", { type: "button", class: "stats-pie-toggle", "aria-expanded": "false", onclick: () => {
        const expanded = toggle.getAttribute("aria-expanded") !== "true";
        toggle.setAttribute("aria-expanded", String(expanded));
        toggle.textContent = expanded ? "收起" : `展开其余 ${rows.length - PIE_VISIBLE} 项`;
        [...legend.children].forEach((row, i) => { row.hidden = !expanded && i >= PIE_VISIBLE; });
      } }, `展开其余 ${rows.length - PIE_VISIBLE} 项`);
      legendPanel.append(toggle);
    }
    card.append(h("div", { class: "stats-pie-body" }, chart, legendPanel));
    return card;
  }

  function breakdown(data) {
    const s = state(), metric = metricOf(), def = defOf();
    const range = RANGES.find((r) => r.id === s.range) || RANGES.find((r) => r.id === "7d");
    const days = data ? rangeDays(data, range) : [];
    const note = metric.additive ? "" : `，饼图按${metric.sub === "n" ? "有耗时记录的部署次数" : "成功 + 失败的次数"}划分`;
    const cards = data ? def.dims.map((dim) => pieCard(dim, metric, days))
      : def.dims.map(() => h("div", { class: "stats-pie" }, h("div", { class: "stats-pie-skeleton skeleton", "aria-hidden": "true" })));
    const simple = cards.filter((card) => !card.classList.contains("stats-pie-wide"));
    if (simple.length % 2) simple[simple.length - 1].classList.add("stats-pie-single");
    return h("section", { class: "stats-section", "aria-label": "拆解" },
      h("div", { class: "stats-section-head" }, h("h2", {}, "拆解")),
      h("p", { class: "muted small stats-section-note" }, `${range.label}${data ? ` · ${rangeSpan(data, range)}` : ""} · ${metric.label}${note}`),
      // 外壳是容器查询的容器（容器自己不能被自己的查询改样式），里面的 .stats-pies 按宽度排成两列或三列
      h("div", { class: "stats-pies-host" },
        h("div", { class: "stats-pies" },
          cards)));

  }

  /* ---- 趋势图：近 90 天的平滑曲线 + 面积；没有样本的日子（比如没有部署）断开，不画成 0 ---- */
  function trendSeries(data, metric) {
    return data.days.slice(-TREND_DAYS).map((d) => ({ day: d.day, value: valueOf(metric, [d]) }));
  }

  /**
   * 一段连续的点 → 平滑的三次贝塞尔曲线（单调三次插值）：曲线穿过每个点，而且不会在两点之间冲出去，
   * 所以全是正数的数据不会画到 0 以下，平台期也不会出现假的起伏。返回 "C…" 命令串，调用方负责起点。
   */
  function smoothCurve(pts) {
    const n = pts.length;
    if (n < 2) return "";
    const d = pts.slice(1).map((p, i) => (p.y - pts[i].y) / (p.x - pts[i].x));
    const m = pts.map((_, i) => (i === 0 ? d[0] : i === n - 1 ? d[n - 2] : d[i - 1] * d[i] <= 0 ? 0 : (2 * d[i - 1] * d[i]) / (d[i - 1] + d[i])));
    let out = "";
    for (let i = 0; i < n - 1; i++) {
      const dx = (pts[i + 1].x - pts[i].x) / 3;
      out += `C${(pts[i].x + dx).toFixed(2)} ${(pts[i].y + m[i] * dx).toFixed(2)} ${(pts[i + 1].x - dx).toFixed(2)} ${(pts[i + 1].y - m[i + 1] * dx).toFixed(2)} ${pts[i + 1].x.toFixed(2)} ${pts[i + 1].y.toFixed(2)} `;
    }
    return out;
  }

  function trendChart(data) {
    const s = state(), metric = metricOf();
    const section = h("section", { class: "stats-section", id: "stats-trend", "aria-label": "趋势" },
      h("div", { class: "stats-section-head" }, h("h2", {}, "趋势"), h("span", { class: "muted small" }, `近 ${TREND_DAYS} 天`)));
    if (!data) { section.append(h("div", { class: "stats-chart skeleton", "aria-hidden": "true" })); return section; }
    const series = trendSeries(data, metric);
    const values = series.map((p) => p.value).filter((v) => v !== null);
    if (!values.length) { section.append(h("p", { class: "muted small stats-empty", role: "status" }, "这段时间没有数据")); return section; }
    const max = metric.fmt === "rate" ? 1 : Math.max(...values) || 1;
    const W = 300, H = 110, n = series.length;
    const x = (i) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
    const y = (v) => H - (v / max) * (H - 6) - 3;
    // 按「连续有值的一段」分别画曲线；只有一个点的段画成一个圆点
    const runs = [];
    series.forEach((p, i) => {
      if (p.value === null) { runs.push(null); return; }
      if (!runs.length || runs.at(-1) === null) runs.push([]);
      runs.at(-1).push({ x: x(i), y: y(p.value) });
    });
    let line = "", area = "";
    for (const run of runs.filter(Boolean)) {
      const start = `${run[0].x.toFixed(2)} ${run[0].y.toFixed(2)}`, end = run.at(-1);
      line += `M${start} ${run.length === 1 ? `L${start} ` : smoothCurve(run)}`;
      if (run.length > 1) area += `M${run[0].x.toFixed(2)} ${H} L${start} ${smoothCurve(run)}L${end.x.toFixed(2)} ${H} Z `;
    }
    const grid = [0, 0.5, 1].map((f) => `<line x1="0" x2="${W}" y1="${(3 + (1 - f) * (H - 6)).toFixed(1)}" y2="${(3 + (1 - f) * (H - 6)).toFixed(1)}" />`).join("");
    const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><g class="stats-grid">${grid}</g><path class="stats-area" d="${area}"/><path class="stats-line" d="${line}" vector-effect="non-scaling-stroke"/></svg>`;
    const picked = s.picked && series.find((p) => p.day === s.picked);
    const frame = h("div", { class: "stats-chart", role: "img", "aria-label": `${metric.label}趋势图` });
    frame.innerHTML = svg;
    frame.append(
      h("span", { class: "stats-axis-top" }, fmtValue(metric, max)),
      h("span", { class: "stats-axis-bottom" }, metric.fmt === "rate" ? "0%" : fmtValue(metric, 0)));
    if (picked && picked.value !== null) {
      const i = series.indexOf(picked);
      frame.append(
        styled(h("i", { class: "stats-marker-line" }), { left: `calc(12px + (100% - 24px) * ${(x(i) / W).toFixed(4)})` }),
        styled(h("i", { class: "stats-marker" }), { left: `calc(12px + (100% - 24px) * ${(x(i) / W).toFixed(4)})`, top: `calc(6px + (100% - 12px) * ${(y(picked.value) / H).toFixed(4)})` }));
    }
    // 手指 / 鼠标在图上移动：选中最近的一天
    const pick = (event) => {
      const rect = frame.getBoundingClientRect();
      const i = Math.max(0, Math.min(n - 1, Math.round(((event.clientX - rect.left - 12) / Math.max(1, rect.width - 24)) * (n - 1))));
      if (s.picked !== series[i].day) { s.picked = series[i].day; rerender(); }
    };
    frame.addEventListener("pointerdown", pick);
    frame.addEventListener("pointermove", (event) => { if (event.pointerType === "mouse" || event.buttons) pick(event); });
    const labels = h("div", { class: "stats-axis-x" }, [0, Math.floor((n - 1) / 2), n - 1].map((i) => h("span", {}, shortDay(series[i].day))));
    const readout = h("p", { class: "stats-readout", role: "status", "aria-live": "polite" },
      picked ? `${longDay(picked.day)} · ${fmtValue(metric, picked.value)}` : `点按或划过图表，查看某一天的${metric.label}`);
    section.append(frame, labels, readout);
    return section;
  }

  /* ---- 热力图：GitHub 贡献图那样的整年（53 周 × 7 天，周一在上），颜色深浅 = 当天的值，上方标月份 ---- */
  const HEAT_WEEKS = 53;
  const fullDay = (day) => `${day.slice(0, 4)} 年 ${longDay(day)}`;

  /** 以「今天所在的那一周」收尾，往前 53 周；每周 7 格，周一开头。 */
  function heatWeeks(data) {
    const end = shiftDay(data.to, 6 - ((weekdayOf(data.to) + 6) % 7));
    const start = shiftDay(end, -(HEAT_WEEKS * 7 - 1));
    return Array.from({ length: HEAT_WEEKS }, (_, w) => Array.from({ length: 7 }, (_, d) => {
      const day = shiftDay(start, w * 7 + d);
      return { day, future: day > data.to, out: day < data.from };
    }));
  }

  /** 月份标签：标在这个月第一次出现的那一周；相邻两个挤在 3 列以内时只留后一个，避免叠字。 */
  function monthLabels(weeks) {
    const marks = [];
    let last = "";
    weeks.forEach((week, i) => {
      const month = monthOf(week[0].day);
      if (month !== last) { marks.push({ index: i, text: `${Number(month.slice(5))}月` }); last = month; }
    });
    const labels = new Map();
    marks.forEach((mark, i) => { if (i === marks.length - 1 || marks[i + 1].index - mark.index >= 3) labels.set(mark.index, mark.text); });
    return labels;
  }

  function heatBand(weeks, cells, extra) {
    const labels = monthLabels(weeks);
    const band = h("div", { class: `stats-heat-band${extra ? ` ${extra}` : ""}` },
      h("div", { class: "stats-heat-months" }, weeks.map((_, i) => h("span", { class: "stats-heat-month" }, labels.get(i) || ""))),
      h("div", { class: "stats-heat-body" },
        h("div", { class: "stats-heat-weekdays" }, ["一", "", "三", "", "五", "", "日"].map((w) => h("span", {}, w))),
        h("div", { class: "stats-heat-grid" }, cells)));
    band.style.setProperty("--heat-cols", String(weeks.length));
    return band;
  }

  function heatmap(data) {
    const s = state(), metric = metricOf();
    const section = h("section", { class: "stats-section", id: "stats-heat", "aria-label": "热力图" });
    const head = (...extra) => h("div", { class: "stats-section-head" }, h("h2", {}, "热力图"), ...extra);
    if (!data) { section.append(head(), h("div", { class: "stats-heat-skeleton skeleton", "aria-hidden": "true" })); return section; }
    const byDay = new Map(data.days.map((d) => [d.day, valueOf(metric, [d])]));
    const weeks = heatWeeks(data);
    const values = [...byDay.values()].filter((v) => v !== null && v !== undefined);
    const peak = metric.fmt === "rate" ? 1 : Math.max(0, ...values);
    const level = (v) => (v === null || v === undefined || !peak || v <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((v / peak) * 4))));
    const cellsOf = (list) => list.flatMap((week) => week.map((d) => {
      const v = byDay.get(d.day);
      if (d.future) return h("span", { class: "stats-heat-cell future", "aria-hidden": "true" });
      return h("span", {
        class: `stats-heat-cell l${d.out ? 0 : level(v)}${d.out ? " out" : ""}${s.picked === d.day ? " picked" : ""}`,
        "data-day": d.day, role: "img", "aria-label": `${fullDay(d.day)}：${d.out ? "没有数据" : fmtValue(metric, v)}`,
      });
    }));
    // 宽屏：53 周一整条；容器放不下（手机）：拆成上下两段（27 + 26 周），整年一眼看全，不用横向拖动。
    // 两种版式都渲染，由容器查询显示其一。
    const half = Math.ceil(weeks.length / 2);
    const readout = h("p", { class: "stats-readout", role: "status", "aria-live": "polite" },
      s.picked && byDay.has(s.picked) ? `${fullDay(s.picked)} · ${fmtValue(metric, byDay.get(s.picked))}` : `点按格子查看某一天的${metric.label}`);
    const pick = (event) => {
      const cell = event.target?.closest?.(".stats-heat-cell");
      const day = cell?.dataset?.day;
      if (!day || cell.classList.contains("out")) return;
      s.picked = s.picked === day ? "" : day;
      rerender();
    };
    section.append(
      head(h("span", { class: "muted small" }, "近一年")),
      h("div", { class: "stats-heat-layouts", onclick: pick },
        h("div", { class: "stats-heat-wide" }, heatBand(weeks, cellsOf(weeks))),
        h("div", { class: "stats-heat-bands" },
          heatBand(weeks.slice(0, half), cellsOf(weeks.slice(0, half)), "first"),
          heatBand(weeks.slice(half), cellsOf(weeks.slice(half)), "second"))),
      readout,
      h("div", { class: "stats-legend", "aria-hidden": "true" }, h("span", {}, "少"), [0, 1, 2, 3, 4].map((l) => h("i", { class: `stats-heat-swatch l${l}` })), h("span", {}, "多")));
    return section;
  }

  function content() {
    const s = state(), data = dataOf(), error = s.error[s.domain];
    return [
      metricTabs(),
      error && !data ? h("p", { class: "field-error stats-error", role: "alert" }, `统计读取失败：${error}`, h("button", { type: "button", class: "btn small", onclick: () => void load(s.domain, true) }, "重试")) : null,
      rangeCards(data),
      breakdown(data),
      trendChart(data),
      heatmap(data),
      data && data.notes?.length ? h("div", { class: "stats-notes muted small" }, data.notes.map((note) => h("p", {}, note))) : null,
    ];
  }

  function rerender() {
    const body = document.getElementById("stats-body");
    if (!body) return;
    body.replaceChildren(...content().filter(Boolean));
    // 切换模块 / 指标后，标签上的状态同步（标签栏本身不重建，焦点不丢）
    document.querySelectorAll(".stats-domains .stats-tab").forEach((el, i) => {
      const on = Object.keys(DOMAINS)[i] === state().domain;
      el.classList.toggle("active", on); el.setAttribute("aria-selected", String(on));
    });
    const refresh = document.querySelector("[data-key='stats-refresh']");
    if (refresh) { refresh.disabled = !!state().loading[state().domain]; refresh.textContent = state().loading[state().domain] ? "刷新中…" : "刷新"; }
    focusSection();
  }

  /** 从别处跳进来要「定位到趋势 / 热力图」：数据到了再滚过去，只滚一次。 */
  function focusSection() {
    const s = state();
    if (!s.focus || !dataOf()) return;
    const id = s.focus === "heat" ? "stats-heat" : "stats-trend";
    s.focus = "";
    // 等两帧：内容刚替换完，布局稳定后再滚；这期间页面可能又重画一次，所以滚的时候再按 id 找节点
    requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "auto" })));
  }

  function render() {
    adoptHash();
    const s = state();
    void load(s.domain);
    const page = h("section", { class: "stats-app", "aria-label": "统计" },
      header(),
      h("div", { class: "stats-page" },
        domainTabs(),
        h("div", { id: "stats-body", class: "stats-body" }, ...content().filter(Boolean))));
    queueMicrotask(focusSection);
    return page;
  }

  if (window.piRouteModules && typeof window.piRouteModules.register === "function") {
    window.piRouteModules.register("stats", { render });
  }
})();
