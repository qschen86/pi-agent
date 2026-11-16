/* 产物 · 评测产物：固定的 TestCase 集 + 各 runtime / 各版本跑出来的 HTML。
 *
 * 产物页（artifacts.js）里这个分类的位置：说明（tips）+ 评测任务卡片；
 * 点一条任务 → 按「runtime × 版本」摆出所有结果，勾选 2~4 个并排对比；
 * 对比页：并排的沙箱 iframe + 指标表（不一致的指标高亮）。
 *
 * 路由：#/artifacts/evals/<suite>/<case>                   一条任务的全部结果
 *       #/artifacts/evals/<suite>/<case>/compare/<a>+<b>   并排对比
 */
(() => {
  const MAX_COMPARE = 4;
  const MIN_LOAD_GAP_MS = 15000;
  const RUNTIME_LABEL = { pi: "Pi", codex: "Codex", claude: "Claude Code" };
  const RUNTIME_ORDER = ["pi", "codex", "claude"];

  const S = { category: null, scope: null, data: null, loading: false, error: "", lastLoad: 0, caseKey: "", selected: [], phone: false, suiteFilter: "" };

  const runtimeLabel = (id) => RUNTIME_LABEL[id] || id;
  const caseHash = (suite, id) => "#/artifacts/evals/" + suite + "/" + id;
  const compareHash = (suite, id, ids) => caseHash(suite, id) + "/compare/" + ids.join("+");
  const frameSrc = (suite, caseId, result) => "/evals/" + suite + "/" + caseId + "/" + result.id + "/" + result.entry.split("/").map(encodeURIComponent).join("/");

  const fmtDuration = (ms) => {
    if (ms == null) return "—";
    const s = Math.round(ms / 1000);
    return s < 60 ? s + " 秒" : Math.floor(s / 60) + " 分 " + String(s % 60).padStart(2, "0") + " 秒";
  };
  const fmtCount = (n) => (n == null ? "—" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
  const fmtBytes = (n) => (n == null ? "—" : n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB");
  const fmtYesNo = (v, yes, no) => (v == null ? "—" : v ? yes : no);
  const fmtWhen = (iso) => { if (!iso) return "—"; const d = new Date(iso); return (d.getMonth() + 1) + "-" + String(d.getDate()).padStart(2, "0") + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
  const STATUS_LABEL = { ok: "完成", partial: "部分完成", failed: "失败" };

  /* 游戏播放页里不画评测内容，后台刷新也不能重绘它（会把正在玩的 iframe 重建）。
   * 产物页列表里的评测分类只原地换掉自己这一块：整页重绘会把刚切换的 tab 选中气泡和内容滑入动画打断。 */
  const repaint = () => {
    if (typeof ui === "undefined" || ui.view !== "artifacts" || ui.artifactGame) return;
    if (!ui.artifactEval) {
      // 列表页：评测区块在页面上就原地换掉；不在（当前停在别的分类）就什么都不用画
      const old = document.querySelector(".eval-section");
      if (old && S.category) old.replaceWith(renderSection(S.category, S.scope));
      return;
    }
    renderMain();
  };

  async function load({ force = false } = {}) {
    if (typeof ui === "undefined") return;
    if (S.loading) return;
    if (S.data && !force) return;
    if (force && Date.now() - S.lastLoad < MIN_LOAD_GAP_MS) return;
    const hadError = !!S.error;
    S.loading = true; S.error = "";
    // 正在渲染的页面已经显示「正在加载」，这里不必再重绘一次（渲染期间再重绘会冲掉切换动画）；点「重试」时才需要把错误提示换掉
    if (hadError) repaint();
    try { S.data = await api("/api/eval-artifacts"); S.lastLoad = Date.now(); }
    catch (error) { S.error = error?.message || "加载失败"; }
    finally { S.loading = false; repaint(); }
  }

  const suites = () => (S.data && S.data.suites) || [];
  function findCase(suiteId, caseId) {
    const suite = suites().find((item) => item.id === suiteId);
    const testCase = suite && suite.cases.find((item) => item.id === caseId);
    return suite && testCase ? { suite, testCase } : null;
  }

  /* 一条任务里出现过的版本（按最早出现的时间排）和 runtime（pi / codex / claude 在前） */
  function axes(results) {
    const versions = [];
    for (const r of results) if (!versions.some((v) => v.id === r.version)) versions.push({ id: r.version, label: r.versionLabel, at: r.createdAt });
    versions.sort((a, b) => a.at.localeCompare(b.at));
    const runtimes = [...new Set(results.map((r) => r.runtime))].sort((a, b) => {
      const ia = RUNTIME_ORDER.indexOf(a), ib = RUNTIME_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    return { versions, runtimes };
  }

  /* ------------------------------ 产物页里的分类 ------------------------------ */
  function renderTips(suite) {
    return h("details", { class: "eval-tips" },
      h("summary", {}, "评测说明与固定任务（" + suite.cases.length + " 条）"),
      h("ul", { class: "eval-tips__list" }, suite.tips.map((tip) => h("li", {}, tip))),
      h("ol", { class: "eval-tips__tasks" }, suite.cases.map((testCase) =>
        h("li", {},
          h("strong", {}, testCase.title),
          h("p", { class: "eval-prompt small" }, testCase.prompt)))));
  }

  function renderCaseCard(suite, testCase) {
    const results = testCase.results || [];
    const { versions, runtimes } = axes(results);
    const foot = results.length
      ? results.length + " 个结果 · " + versions.length + " 个版本 · " + runtimes.length + " 个 runtime"
      : "还没有结果";
    return h("a", { class: "card artifact-card eval-card", href: caseHash(suite.id, testCase.id), "aria-label": "查看评测任务 " + testCase.title },
      h("span", { class: "artifact-card__name" }, testCase.title),
      h("span", { class: "artifact-card__summary muted small" }, testCase.summary),
      h("span", { class: "artifact-card__tags" }, runtimes.map((id) => h("span", { class: "artifact-tag" }, runtimeLabel(id)))),
      h("span", { class: "muted small" }, foot));
  }

  function renderSection(category, scope = null) {
    S.category = category;
    S.scope = scope;
    void load();
    // 分类名已经在顶部 tab 上，这里只留一句说明
    const head = h("div", { class: "artifact-section__head" },
      h("span", { class: "muted small" }, category.description));
    let body;
    if (S.error) {
      body = h("div", {}, h("p", { class: "field-error", role: "alert" }, "评测产物加载失败：" + S.error),
        h("button", { class: "btn small", type: "button", onclick: () => { void load({ force: true }); } }, "重试"));
    } else if (!S.data) {
      body = h("p", { class: "muted small", role: "status" }, "正在加载评测产物…");
    } else {
      body = suites().filter((suite) => scope?.suiteIds ? scope.suiteIds.includes(suite.id) : !S.suiteFilter || suite.id === S.suiteFilter).map((suite) => h("div", { class: "eval-suite" },
        h("h3", { class: "eval-suite__name" }, suite.name),
        h("p", { class: "muted small" }, suite.purpose),
        renderTips(suite),
        h("div", { class: "artifact-grid" }, suite.cases.map((testCase) => renderCaseCard(suite, testCase)))));
    }
    return h("section", { class: "artifact-section eval-section", "aria-label": category.name, role: "tabpanel", id: "artifact-panel" },
      scope?.hideFilter ? null : h("div", { class: "artifact-secondary-row pm-filter-line", role: "group", "aria-label": "二级分类" },
        h("span", { class: "muted small" }, "细分"),
        [{ id: "", name: "全部" }, ...suites()].map((suite) => h("button", {
          type: "button", class: "artifact-filter-chip" + (S.suiteFilter === suite.id ? " active" : ""), "aria-pressed": String(S.suiteFilter === suite.id),
          onclick: () => { S.suiteFilter = suite.id; repaint(); },
        }, suite.name))), head, body);
  }

  /* ------------------------------ 一条任务的全部结果 ------------------------------ */
  function syncSelection(key, results) {
    if (S.caseKey !== key) { S.caseKey = key; S.selected = []; }
    const known = new Set(results.map((r) => r.id));
    S.selected = S.selected.filter((id) => known.has(id));
  }

  function toggle(id) {
    const at = S.selected.indexOf(id);
    if (at >= 0) S.selected.splice(at, 1);
    else if (S.selected.length < MAX_COMPARE) S.selected.push(id);
    renderMain();
  }

  function resultChip(route, r) {
    const checked = S.selected.includes(r.id);
    const full = !checked && S.selected.length >= MAX_COMPARE;
    const box = h("input", { type: "checkbox", class: "eval-chip__check", "aria-label": "选中 " + runtimeLabel(r.runtime) + " " + r.versionLabel + " 第 " + r.rep + " 次", onchange: () => toggle(r.id) });
    box.checked = checked; box.disabled = full;
    return h("div", { class: "eval-chip eval-chip--" + r.status + (checked ? " is-selected" : "") },
      h("label", { class: "eval-chip__main" },
        box,
        h("span", { class: "eval-chip__rep" }, "#" + r.rep),
        r.status !== "ok" ? h("span", { class: "eval-chip__status" }, STATUS_LABEL[r.status]) : null,
        h("span", { class: "muted small" }, fmtDuration(r.durationMs))),
      h("a", { class: "btn small", href: compareHash(route.suite, route.case, [r.id]), "aria-label": "单独查看 " + runtimeLabel(r.runtime) + " " + r.versionLabel + " 第 " + r.rep + " 次" }, "查看"));
  }

  /* 预设：同一个 runtime 的每个版本各取第 1 次完成的结果 / 同一个版本的每个 runtime 各取一个 */
  function pick(results, match, keyOf) {
    const out = [];
    for (const r of results) {
      if (!match(r) || r.status === "failed") continue;
      if (!out.some((o) => keyOf(o) === keyOf(r))) out.push(r);
    }
    return out.slice(0, MAX_COMPARE);
  }
  function goCompare(route, picked) {
    if (picked.length < 1) return;
    location.hash = compareHash(route.suite, route.case, picked.map((r) => r.id));
  }

  function renderCasePage(route, found) {
    const { suite, testCase } = found;
    const results = testCase.results || [];
    syncSelection(route.suite + "/" + route.case, results);
    const { versions, runtimes } = axes(results);

    const header = h("div", { class: "eval-head" },
      h("a", { class: "btn small", href: "#/artifacts" }, "← 产物"),
      h("h1", { class: "eval-head__title" }, testCase.title),
      h("span", { class: "muted small" }, suite.name));
    const prompt = h("details", { class: "eval-tips", open: true },
      h("summary", {}, "固定任务原文"),
      h("p", { class: "eval-prompt" }, testCase.prompt),
      h("div", { class: "artifact-card__tags" }, testCase.lookFor.map((text) => h("span", { class: "artifact-tag" }, "看：" + text))));

    if (!results.length) {
      return h("section", { class: "artifacts-page eval-page" }, header, prompt,
        h("div", { class: "card" },
          h("p", {}, "这条任务还没有评测结果。"),
          h("p", { class: "muted small" }, "跑完后用 scripts/eval-artifacts.mjs import 导入，导入后这里会按「runtime × 版本」摆出来。")));
    }

    const headRow = h("tr", {},
      h("th", { scope: "col" }, ""),
      versions.map((v) => h("th", { scope: "col" },
        h("div", {}, v.label),
        h("button", { class: "btn small", type: "button", title: "每个 runtime 各取一个这个版本的结果并排看",
          onclick: () => goCompare(route, pick(results, (r) => r.version === v.id, (r) => r.runtime)) }, "对比各 runtime"))));
    const bodyRows = runtimes.map((id) => h("tr", {},
      h("th", { scope: "row" },
        h("div", {}, runtimeLabel(id)),
        h("div", { class: "muted small" }, results.find((r) => r.runtime === id)?.model || ""),
        versions.length > 1 ? h("button", { class: "btn small", type: "button", title: "这个 runtime 的每个版本各取一个并排看",
          onclick: () => goCompare(route, pick(results, (r) => r.runtime === id, (r) => r.version)) }, "对比前后") : null),
      versions.map((v) => h("td", {},
        results.filter((r) => r.runtime === id && r.version === v.id).map((r) => resultChip(route, r))))));

    const n = S.selected.length;
    const bar = h("div", { class: "eval-bar", role: "region", "aria-label": "对比选择" },
      h("span", {}, n ? "已选 " + n + " 个（最多 " + MAX_COMPARE + "）" : "勾选 2~" + MAX_COMPARE + " 个结果并排对比"),
      h("button", { class: "btn small primary", type: "button", disabled: n < 2, onclick: () => goCompare(route, S.selected.map((id) => results.find((r) => r.id === id)).filter(Boolean)) }, "并排对比"),
      n ? h("button", { class: "btn small", type: "button", onclick: () => { S.selected = []; renderMain(); } }, "清空") : null);

    return h("section", { class: "artifacts-page eval-page" }, header, prompt,
      h("div", { class: "card eval-matrix-wrap" },
        h("table", { class: "eval-matrix" }, h("thead", {}, headRow), h("tbody", {}, bodyRows))),
      bar);
  }

  /* ------------------------------ 并排对比 ------------------------------ */
  const METRICS = [
    ["状态", (r) => STATUS_LABEL[r.status] || r.status, (r) => r.status],
    ["模型", (r) => r.model || "—", (r) => r.model],
    ["耗时", (r) => fmtDuration(r.durationMs), (r) => r.durationMs],
    ["输入 token", (r) => fmtCount(r.tokens && r.tokens.input), (r) => r.tokens && r.tokens.input],
    ["输出 token", (r) => fmtCount(r.tokens && r.tokens.output), (r) => r.tokens && r.tokens.output],
    ["工具调用", (r) => fmtCount(r.toolCalls), (r) => r.toolCalls],
    ["体积", (r) => fmtBytes(r.checks.bytes), (r) => r.checks.bytes],
    ["外部依赖", (r) => (r.checks.externalRefs == null ? "—" : r.checks.externalRefs === 0 ? "无（自包含）" : r.checks.externalRefs + " 处"), (r) => r.checks.externalRefs],
    ["内联脚本", (r) => fmtCount(r.checks.inlineScripts), (r) => r.checks.inlineScripts],
    ["读取技能文件", (r) => fmtCount(r.checks.skillFiles), (r) => r.checks.skillFiles],
    ["控制台报错", (r) => fmtCount(r.checks.consoleErrors), (r) => r.checks.consoleErrors],
    ["桌面横向溢出", (r) => fmtYesNo(r.checks.overflowDesktop, "有", "无"), (r) => r.checks.overflowDesktop],
    ["手机横向溢出", (r) => fmtYesNo(r.checks.overflowMobile, "有", "无"), (r) => r.checks.overflowMobile],
    ["生成时间", (r) => fmtWhen(r.createdAt), null],
    ["备注", (r) => r.note || "—", null],
  ];

  function renderCompare(route, found) {
    const { suite, testCase } = found;
    const results = testCase.results || [];
    const picked = route.compare.map((id) => results.find((r) => r.id === id)).filter(Boolean);
    const back = h("a", { class: "btn small", href: caseHash(route.suite, route.case) }, "← " + testCase.title);
    if (!picked.length) {
      return h("section", { class: "artifacts-page eval-page" }, h("div", { class: "eval-head" }, back),
        h("div", { class: "card" }, h("p", { class: "field-error", role: "alert" }, "要对比的结果不存在，可能已被删除。")));
    }
    const single = picked.length === 1;
    const title = (r) => runtimeLabel(r.runtime) + " · " + r.versionLabel + " · #" + r.rep;

    const phoneBtn = h("button", { class: "btn small", type: "button", "aria-pressed": String(S.phone), onclick: () => { S.phone = !S.phone; renderMain(); } }, S.phone ? "手机宽度 390 ✓" : "手机宽度 390");
    const head = h("div", { class: "eval-head" }, back,
      h("h1", { class: "eval-head__title" }, single ? title(picked[0]) : "对比 " + picked.length + " 个结果"),
      h("span", { class: "muted small" }, suite.name + " / " + testCase.title),
      h("span", { class: "artifact-bar__spacer" }), phoneBtn);

    const cols = picked.map((r) => h("figure", { class: "eval-col" },
      h("figcaption", { class: "eval-col__cap" },
        h("strong", {}, title(r)),
        h("a", { class: "btn small", href: frameSrc(route.suite, route.case, r), target: "_blank", rel: "noopener" }, "新窗口")),
      h("iframe", { class: "eval-frame", src: frameSrc(route.suite, route.case, r), title: title(r), sandbox: "allow-scripts allow-popups", loading: "lazy" })));

    const differs = (get) => {
      if (!get || picked.length < 2) return false;
      const values = picked.map((r) => JSON.stringify(get(r) ?? null));
      return values.some((v) => v !== values[0]);
    };
    const table = h("div", { class: "card eval-matrix-wrap" },
      h("table", { class: "eval-metrics" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "指标"), picked.map((r) => h("th", { scope: "col" }, title(r))))),
        h("tbody", {}, METRICS.map(([label, show, get]) => h("tr", { class: differs(get) ? "is-diff" : "" },
          h("th", { scope: "row" }, label), picked.map((r) => h("td", {}, show(r))))))));

    return h("section", { class: "artifacts-page eval-page eval-compare" + (S.phone ? " eval-compare--phone" : ""), "data-count": String(picked.length) },
      head,
      h("div", { class: "eval-cols eval-cols--" + picked.length }, cols),
      single ? null : h("p", { class: "muted small" }, "高亮的行表示这几个结果在该指标上不一致。"),
      table);
  }

  /* ------------------------------ 路由入口 ------------------------------ */
  function renderRoute(route) {
    void load();
    if (S.error) {
      return h("section", { class: "card" }, h("p", { class: "field-error", role: "alert" }, "评测产物加载失败：" + S.error),
        h("button", { class: "btn", type: "button", onclick: () => { void load({ force: true }); } }, "重试"));
    }
    if (!S.data) return h("section", { class: "card" }, h("p", { role: "status" }, "正在加载评测产物…"));
    const found = findCase(route.suite, route.case);
    if (!found) {
      return h("section", { class: "card" }, h("p", { class: "field-error", role: "alert" }, "没有这条评测任务。"),
        h("a", { class: "btn", href: "#/artifacts" }, "返回产物"));
    }
    return route.compare ? renderCompare(route, found) : renderCasePage(route, found);
  }

  window.piEvalArtifacts = { renderSection, renderRoute, load, state: () => ({ ...S }) };
  window.addEventListener("focus", () => { if (typeof ui !== "undefined" && ui.view === "artifacts" && !ui.artifactGame) void load({ force: true }); });
})();
