(() => {
/* ------------------------------ v2.5 F11：外部资源 ------------------------------ */
// 全局只读状态页：模型、搜索、抓取各服务的凭据状态、最近调用、本机用量与余额；
// v3.12 起增加 DeepSeek token 消耗渠道（按应用/功能聚合、费用估算）；
// 2026-10-20 起并入「模型」里 deepseek 的详情（右侧浮层），支持今日/昨日/近 7 天/近 30 日/累计。
// 凭据只显示是否配置、来源类别与指纹；余额只在你点「刷新余额」时由服务端向服务商的只读接口读取。

const RES_STATE = {
  "not-configured": ["未配置", "bad"],
  "configured-unverified": ["未验证", "warn"],
  "last-ok": ["最近调用成功", "ok"],
  "last-failed": ["最近调用失败", "bad"],
  stale: ["状态过期／未知", "warn"],
  "quota-ok": ["额度可读", "ok"],
  "quota-stale": ["额度快照过期", "warn"],
  "quota-unavailable": ["额度不可用", "bad"]
};
const RES_KIND = [["model", "模型"], ["search", "搜索"], ["fetch", "抓取"], ["voice", "配音"]];
const RES_FILTERS = [["all", "全部"], ["model", "大模型"], ["search", "搜索"], ["fetch", "抓取"], ["voice", "语音"], ["runtime", "运行时"], ["cli", "本机 CLI"]];
const RES_CAPABILITY = { chat: "对话", search: "检索", read: "阅读", speech: "配音合成" };
const CRED_SOURCE = { env: "环境变量", "local-file": "受权限保护的本机文件", "pi-config": "Pi 配置", runtime: "运行时订阅登录" };
const ROLE_LABEL = { executor: "执行 Agent", planner: "填充 Agent", acceptanceJudge: "验收 Agent", contractCritic: "合约评审", voiceover: "视频配音" };

// 设置页里的「外部资源」：它不再是一级导航页，渲染与重绘都由设置页的 content 触发。
const resourcesEmbedded = () => ui.view === "settings" && ui.settings?.section === "resources";
const resourcesVisible = () => ui.view === "resources" || resourcesEmbedded();

async function loadResources({force = true} = {}) {
  const context = pageContext();
  ui.resourcesLoading = true; ui.resourcesError = "";
  if (resourcesVisible()) renderMain();
  // 「支持模型」一行要用运行时列表、设置与权限：并行读取，到了再补画
  void Promise.all([rtLoadProfiles(), rtLoadSettings(), rtLoadAccess()]).then(() => { if (resourcesVisible() && contextCurrent(context)) renderMain(); }).catch(() => {});
  try { const value = await readResource("/api/resources", {force}); if (contextCurrent(context)) ui.resources = value; }
  catch (e) { if (contextCurrent(context)) ui.resourcesError = e.message; }
  finally { if (contextCurrent(context)) { ui.resourcesLoading = false; if (resourcesVisible()) { renderMain(); refreshResourceDrawer(); } } }
}

function when(iso) { return iso ? iso.replace("T", " ").slice(0, 19) : "—"; }
/** 手机卡片只保留日期与分钟，省掉年份和秒。 */
function whenShort(iso) { return iso ? iso.replace("T", " ").slice(5, 16) : "—"; }
function compactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(1).replace(/\.0$/, "")}亿`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(1).replace(/\.0$/, "")}万`;
  return n.toLocaleString();
}

/** 手机卡片的主指标：一行说清余额 / 订阅额度；完整明细仍在「详情」里。 */
function quotaShortLabel(label) {
  return label.replace("小时窗口", "h").replace(" 窗口", "").replace("窗口", "");
}
function quotaShortValue(w) {
  return `${quotaShortLabel(w.label)} ${w.usedPercent == null ? "未知" : `${Math.round(w.usedPercent)}%`}`;
}
function mobileAmount(s) {
  const q = s.quota, b = s.balance;
  if (q) {
    if (!q.available) return { text: "额度不可用", tone: "warn" };
    if (!q.windows?.length) return { text: "额度尚未读取", tone: "muted" };
    return { text: quotaShortValue(q.windows[0]), tone: "" };
  }
  if (b.status === "ok") {
    // 常见配置同时有 CNY / USD 或账户余额 / 累计充值：手机上只突出第一笔非零金额。
    const main = b.amounts.find((a) => a.value !== 0) ?? b.amounts[0];
    if (!main) return { text: "余额不可用", tone: "muted" };
    return { text: `${main.value.toLocaleString()} ${main.unit}${b.stale ? " · 非实时" : ""}`, tone: b.stale ? "warn" : "" };
  }
  return { text: b.status === "not-refreshed" ? "余额尚未读取" : "余额无法获取", tone: "muted" };
}

/** 手机卡片的第二行：本机用量 + 最近调用（订阅行换成其余额度窗口、计划与采样时间）。 */
function mobileMeta(s) {
  if (s.quota) {
    const q = s.quota;
    const rest = q.windows?.slice(1).map(quotaShortValue).join(" · ");
    return [rest, q.available ? "订阅额度" : "订阅额度不可用", q.plan ? `计划 ${q.plan}` : "", q.sampledAt ? `采样 ${whenShort(q.sampledAt)}` : "尚未采样"].filter(Boolean).join(" · ");
  }
  const parts = [`${s.usage.calls.toLocaleString()} 次`];
  if (s.usage.tokens != null) parts.push(`${compactNumber(s.usage.tokens)} token`);
  if (s.usage.failures) parts.push(`失败 ${s.usage.failures}`);
  parts.push(s.last ? `最近 ${whenShort(s.last.at)}` : "暂无调用");
  return parts.join(" · ");
}

function activeResourceFilter() {
  return RES_FILTERS.some(([id]) => id === ui.resourceFilter) ? ui.resourceFilter : "all";
}

function resourceCounts(r) {
  const services = (r?.services ?? []).filter((s) => !(s.kind === "model" && s.service === "model:zhipu"));
  const count = (kind) => services.filter((s) => s.kind === kind).length;
  const model = count("model"), search = count("search"), fetch = count("fetch"), voice = count("voice");
  const runtime = r?.runtimeConfigs?.runtimes?.length ?? 0;
  const cli = r?.localClis?.length ?? 0;
  return { all: model + search + fetch + voice + runtime + cli, model, search, fetch, voice, runtime, cli };
}

function renderLocalClis(entries) {
  if (!entries?.length) return null;
  return h("section", { class: "resource-section resource-local-clis", "aria-label": "本机 CLI" },
    h("h2", {}, "本机 CLI"),
    h("p", { class: "muted small" }, "本机命令行工具；已安装不代表已登录或已授权。"),
    h("div", { class: "resource-cli-list" }, entries.map(cli =>
      h("article", { class: "resource-cli-card", "data-cli": cli.id },
        h("div", { class: "resource-cli-head" }, h("strong", {}, cli.label),
          h("span", { class: `badge ${cli.installed ? "ok" : "warn"}` }, cli.installed ? "已安装" : "未找到")),
        h("p", { class: "resource-cli-version small" }, h("code", {}, cli.command), " · ",
          cli.version ? `版本 ${cli.version}` : cli.installed ? (cli.versionError || "版本未知") : "当前运行环境 PATH 中未找到"),
        h("p", { class: "resource-cli-purpose small" }, cli.purpose)))));
}

function renderResourceFilters(counts, filter) {
  return h("div", { class: "resource-filters", role: "group", "aria-label": "资源分类筛选" },
    RES_FILTERS.map(([id, label]) => h("button", {
      type: "button", class: `filter-chip resource-filter${filter === id ? " active" : ""}`,
      "aria-pressed": String(filter === id), "data-resource-filter": id,
      onclick: () => { closeResourceDrawer(false); ui.resourceFilter = id; renderMain(); }
    }, `${label} ${counts[id] ?? 0}`)));
}

function renderQuickProviderSwitch(w) {
  const choices = [
    { id: "auto", label: "自动", key: "0" },
    { id: "brave", label: "Brave", key: "1" },
    { id: "deepseek", label: "DeepSeek", key: "2" }
  ];
  return h("div", { class: "resource-quick-switch", role: "group", "aria-label": "平台默认联网供应商" },
    h("span", { class: "resource-quick-label muted small" }, "平台默认"),
    choices.map(({ id, label, key }) => {
      const option = w.options.find((o) => o.id === id);
      const disabled = !!ui.resourceSwitching || (id !== "auto" && !option?.ready);
      const title = id === "auto" ? "按可用凭据自动选择（快捷键 0）" : `固定使用 ${option?.label ?? label}（快捷键 ${key}）`;
      return h("button", {
        type: "button", class: `filter-chip resource-quick${w.preference === id ? " active" : ""}`,
        "aria-pressed": String(w.preference === id), "aria-keyshortcuts": key,
        disabled, title,
        onclick: () => switchWebProvider(id)
      }, label);
    }),
    h("span", { class: "resource-shortcut-hint muted small", title: "在资源页按 0 自动、1 Brave、2 DeepSeek" }, "快捷键 0/1/2"));
}

/** 快捷键挂在资源页根节点上：只在本页聚焦时生效，离开页面随 DOM 一起消失，不留全局监听。 */
function resourceShortcut(event) {
  if (event.defaultPrevented || ui.resourceSwitching || !ui.resources?.webResearch) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (target && target.closest && target.closest("input, textarea, select, [contenteditable='true']")) return;
  const filter = activeResourceFilter();
  if (filter !== "all" && filter !== "search" && filter !== "fetch") return;
  const provider = event.key === "0" ? "auto" : event.key === "1" ? "brave" : event.key === "2" ? "deepseek" : undefined;
  if (!provider) return;
  event.preventDefault();
  switchWebProvider(provider);
}

async function refreshResource(s) {
  const q = s.quota;
  {
    if (ui.resourceRefreshing) return;
    const context = pageContext();
    ui.resourceRefreshing = s.service; ui.resourceMsg = ""; renderMain(); refreshResourceDrawer();
    try {
      // 订阅额度走 runtime 的只读额度接口；现金余额走资源页登记的服务商接口。
      if (q) await api(`/api/runtime-profiles/${encodeURIComponent(q.runtimeKind)}/rate-limits`, { method: "POST", body: JSON.stringify({ automatic: false }) });
      else await api(`/api/resources/${encodeURIComponent(s.service)}/refresh`, { method: "POST", body: "{}" });
      await loadResources();
    }
    catch (e) { ui.resourceMsg = `${s.label}：${e.message}`; }
    ui.resourceRefreshing = null; if (contextCurrent(context)) { renderMain(); refreshResourceDrawer(); }
  }
}

/** 详情内容：账号/凭据、用在哪里、余额或额度来源。放在右侧浮层里。 */
function resourceDetailGrid(s) {
  const c = s.credential;
  const b = s.balance;
  const q = s.quota;
  const account = h("div", {}, h("h3", {}, q ? "订阅账号" : "凭据与调用"), h("dl", { class: "kv" },
    q
      ? [h("dt", {}, "账号"), h("dd", {}, c.configured ? (c.sourceDetail || "已登录订阅") : "未登录"),
        h("dt", {}, "额度采样"), h("dd", {}, when(q.sampledAt)),
        h("dt", {}, "计划"), h("dd", {}, q.plan || "未知")]
      : [h("dt", {}, "凭据来源"), h("dd", {}, c.configured
          ? `已配置 · ${CRED_SOURCE[c.source] || c.source || "本机配置"}${c.sourceDetail && c.source === "env" ? ` · ${c.sourceDetail}` : ""}` : "未配置"),
        h("dt", {}, "指纹"), h("dd", { class: "mono" }, c.fingerprint || "—"),
        h("dt", {}, "最近调用"), h("dd", {}, s.last
          ? `${when(s.last.at)} · ${RES_CAPABILITY[s.last.capability] || "阅读"} · ${ROLE_LABEL[s.last.role] || s.last.role}${s.last.model ? ` · ${s.last.model}` : ""}` : "还没有调用记录"),
        s.last?.errorClass ? [h("dt", {}, "失败原因"), h("dd", { class: "bad-text" }, s.last.errorClass)] : null,
        h("dt", {}, "用量起点"), h("dd", {}, s.usage.since ? when(s.usage.since) : "本机还没有记录")]));
  const source = h("div", {}, h("h3", {}, q ? "额度来源" : "余额来源"),
    q
      ? [q.reason ? h("p", { class: q.available ? "muted small" : "warn-text small" }, q.reason) : null,
        q.available && q.windows.length ? h("div", { class: "resource-quota-detail" },
          typeof rtRateLimit === "function" ? rtRateLimit(q, true) : rtQuotaStripNode(q)) : null,
        h("dl", { class: "kv" },
          h("dt", {}, "采样时间"), h("dd", {}, when(q.sampledAt)),
          q.plan ? [h("dt", {}, "计划"), h("dd", {}, q.plan)] : null,
          h("dt", {}, "接口"), h("dd", { class: "mono" }, q.source)),
        q.canRefresh ? h("p", { class: "muted small" }, "手动刷新只读取 runtime 的账户额度，不执行模型任务。") : null]
      : [b.reason ? h("p", { class: b.stale ? "warn-text small" : "muted small" }, b.reason) : null,
        h("dl", { class: "kv" },
          h("dt", {}, "读取时间"), h("dd", {}, when(b.fetchedAt)),
          b.scope ? [h("dt", {}, "账户范围"), h("dd", {}, b.scope)] : null,
          b.period ? [h("dt", {}, "账期"), h("dd", {}, b.period)] : null,
          b.source ? [h("dt", {}, "接口"), h("dd", { class: "mono" }, b.source)] : null),
        b.consoleUrl ? h("a", { class: "small", href: b.consoleUrl, target: "_blank", rel: "noopener noreferrer" }, "服务商控制台 ↗") : null,
        b.source && c.configured ? h("p", { class: "muted small" }, "手动刷新只读取余额，不产生费用；60 秒内不重复请求。") : null]);
  return h("div", { class: "resource-detail-grid" },
    account,
    h("div", {}, h("h3", {}, `用在哪里 · ${s.roles.length} 项`),
      h("div", { class: "resource-roles", tabindex: "0", "aria-label": `${s.label} 的使用位置` }, s.roles.length
        ? s.roles.map((r) => h("div", { class: "resource-role small" }, `${r.role}${r.model ? ` · ${r.model}` : ""}${r.note ? `（${r.note}）` : ""}`))
        : h("span", { class: "muted" }, "暂无使用位置"))),
    source);
}

function renderResourceCard(s) {
  const [stateLabel, stateKind] = RES_STATE[s.state] || [s.state, ""];
  const c = s.credential;
  const b = s.balance;
  const q = s.quota;
  const refreshing = ui.resourceRefreshing === s.service;
  const toggle = h("button", { class: "btn small resource-detail-toggle", type: "button", "aria-haspopup": "dialog", "aria-label": `查看 ${s.label} 详情`, onclick: (e) => openResourceDrawer(s.service, e.currentTarget) }, "详情");
  const recent = q
    ? (q.sampledAt ? [h("div", {}, when(q.sampledAt)), h("div", { class: "muted small" }, `额度快照${q.plan ? ` · 计划 ${q.plan}` : ""}`)] : h("span", { class: "muted" }, "尚未读取"))
    : (s.last ? [h("div", {}, when(s.last.at)), h("div", { class: "muted small resource-model", title: s.last.model || "" }, `${ROLE_LABEL[s.last.role] || s.last.role}${s.last.model ? ` · ${s.last.model}` : ""}`)] : h("span", { class: "muted" }, "暂无记录"));
  const amountCell = q
    ? (q.available && q.windows.length
      ? [h("div", { class: "resource-quota-cell" }, rtQuotaStripNode(q, q?.runtimeKind)), q.stale ? h("span", { class: "warn-text small" }, q.reason ? "非实时 · 读取失败" : "非实时") : null]
      : h("span", { class: q.available ? "muted" : "warn-text", title: q.reason || "" }, q.available ? "尚未读取" : "无法获取"))
    : (b.status === "ok"
      ? [b.amounts.map((a, index) => index === 0
          ? h("div", { title: a.label }, a.unit !== "CNY" && a.unit !== "USD" ? h("div", { class: "muted small" }, a.label) : null,
            h("span", { class: "resource-balance-value" }, h("strong", { class: "resource-number" }, a.value.toLocaleString()), h("span", { class: "small" }, ` ${a.unit}`)))
          : h("div", { class: "resource-balance-secondary", title: a.label },
            `${a.unit !== "CNY" && a.unit !== "USD" ? `${a.label} · ` : ""}${a.value.toLocaleString()} ${a.unit}`)),
        b.stale ? h("span", { class: "warn-text small" }, b.reason ? "非实时 · 读取失败" : "非实时") : null]
      : h("span", { class: b.status === "not-refreshed" ? "muted" : "warn-text", title: b.reason || "" }, b.status === "not-refreshed" ? "尚未读取" : "无法获取"));
  const row = h("tr", { class: "resource-row" },
    h("td", { "data-label": "服务", class: "resource-service" },
      h("div", { class: "resource-mobile" },
        h("div", { class: "resource-mobile-head" },
          h("div", { class: "resource-mobile-title" }, h("span", { class: "resource-mobile-name" }, s.label), badge(stateLabel, stateKind)),
          (() => { const amount = mobileAmount(s); return h("div", { class: `resource-mobile-amount ${amount.tone === "warn" ? "warn-text" : amount.tone === "muted" ? "muted" : ""}`.trim() }, amount.text); })()),
        h("div", { class: "resource-mobile-meta muted small" }, mobileMeta(s))),
      h("strong", {}, s.label),
      h("div", { class: "muted small resource-service-sub" }, q
        ? `${c.configured ? "订阅登录" : "未登录"}${q.plan ? ` · ${q.plan}` : ""} · 账户额度`
        : `${c.configured ? "凭据已配置" : "凭据未配置"} · ${s.roles.length} 个使用位置`)),
    h("td", { "data-label": "状态" }, badge(stateLabel, stateKind)),
    h("td", { "data-label": "最近调用" }, recent),
    h("td", { "data-label": "本机用量" }, q
      ? h("span", { class: "muted", title: "订阅按账户额度窗口计，不按平台调用次数统计" }, "—")
      : h("div", {}, h("strong", { class: "resource-number" }, s.usage.calls.toLocaleString()), " 次",
        s.usage.tokens != null ? h("div", { class: "small" }, h("strong", {}, s.usage.tokens.toLocaleString()), " token") : null,
        s.usage.failures ? h("div", { class: "bad-text small" }, `失败 ${s.usage.failures} 次`) : null)),
    h("td", { "data-label": "余额 / 额度" }, amountCell),
    h("td", { "data-label": "操作", class: "resource-actions-cell" }, h("div", { class: "resource-actions" }, toggle,
      (q ? q.canRefresh : (b.source && c.configured)) ? h("button", { class: "btn small", type: "button", disabled: !!ui.resourceRefreshing, onclick: () => refreshResource(s), "aria-label": `刷新 ${s.label} ${q ? "额度" : "余额"}` }, refreshing ? "正在读取…" : (q ? "刷新额度" : "刷新余额")) : null)));
  return row;
}

/* ------------------------------ 运行时订阅额度（Claude / OpenAI） ------------------------------ */
// 订阅额度也属于模型账号：作为 model 行并入「模型」表，与模型服务同一列结构；
// 复用「新建会话」的紧凑额度条（rtQuotaStrip），保证两处展示一致；runtime.js 未加载时退回纯文本。
function rtQuotaStripNode(rl, kind = "") {
  if (typeof rtQuotaStrip === "function") return rtQuotaStrip(rl, "short", "", "", kind || rl?.runtimeKind || "");
  return h("span", { class: "muted small" }, (rl.windows || []).map((w) => `${w.label} ${w.usedPercent == null ? "未知" : `已用 ${Math.round(w.usedPercent)}%`}`).join(" · "));
}

function resourceSection(title, list, extra, className = "") {
  return h("section", { class: `resource-section ${className}`.trim(), "aria-label": title },
    h("h2", {}, title, h("span", { class: "muted small" }, ` · ${list.length}`)),
    extra || null,
    h("div", { class: "resource-table-wrap" }, h("table", { class: "resource-table", "aria-label": `${title}服务` },
      h("thead", {}, h("tr", {}, ["服务", "状态", "最近调用", "本机用量", "余额 / 额度", "操作"].map((label) => h("th", { scope: "col" }, label)))),
      h("tbody", {}, list.map(renderResourceCard)))));
}


/* ------------------------------ v3.14：运行时配置也是资源 ------------------------------ */
// Pi / Codex / Claude Code 的用户级配置目录：技能、MCP、扩展、提示词、工作流与其他自定义。
// 服务端只给名称、来源与路径；这里不读取任何配置内容，也不显示密钥。

// Mechanism reference, not a live session capability report.
// 行顺序：上下文管理 → 权限管理 → 文件与代码操作 → 搜索和抓取 → 浏览器自动化测试 → 浏览器操作 → 子 Agent / 任务委派 → 长期记忆。
const RUNTIME_CAPABILITY_LABELS = ["Pi", "Codex", "Claude Code"];
const RUNTIME_CAPABILITY_KINDS = ["pi", "codex", "claude-code"];
const RUNTIME_CAPABILITY_TONE = { pi: "platform", codex: "native", "claude-code": "mixed" };
// 三个运行时对上下文的管理权：Pi 由平台下发参数 → Claude 自动 + 手动并存 → Codex 全权交给原生运行时。
// 每个能力一行：basic = 三者共有的基础能力（跨三列合并，basicFor 标注只有部分运行时具备）；
// cells[i] = { stance?, special: 特色能力, details: [[标签, 指令 / 接口]] }，详情进悬停 / 点按浮层。
const RUNTIME_CAPABILITY_ROWS = [
  {
    name: "支持模型",
    models: true,
    basic: ["新建会话时可选模型和推理强度", "可手动设置新建会话的默认配置"],
    cells: [
      { stance: "平台可调", special: ["跨服务商的模型表，可自由挑选", "推理强度随模型提供"], details: [["来源", "Pi 模型表与各服务商配置"], ["默认", "新建会话时用所选模型；运行时不另设默认"]] },
      { special: ["模型由 Codex 上报", "可用范围随 ChatGPT 订阅变化"], details: [["来源", "Codex app-server 上报的模型列表"], ["强度", "按所选模型提供的推理强度档位"]] },
      { special: ["Claude 系列模型", "可用范围随订阅或账号变化"], details: [["来源", "Claude Agent SDK 上报的模型列表"], ["强度", "按所选模型提供的推理强度档位"]] }
    ]
  },
  {
    name: "上下文管理（组装/压缩/查询）",
    basic: ["沿原会话续聊", "变长自动压缩", "可手动压缩", "压缩后可回查历史", "角色设定附加到系统提示"],
    cells: [
      {
        stance: "平台可调",
        special: ["压缩松紧可调（输出预留、近期保留量）", "自动压缩可开关", "沿活动分支续聊", "直接读记录文件回查"],
        details: [
          ["角色设定", "--append-system-prompt"],
          ["压缩", "RPC compact（手动）、set_auto_compaction（自动开关）"],
          ["参数", "compaction.reserveTokens（输出预留）、compaction.keepRecentTokens（近期保留量）"],
          ["回查", "会话 JSONL、read / grep"]
        ]
      },
      {
        stance: "原生托管",
        special: ["压缩全交给 Codex，平台不设阈值", "平台只记录压缩事件", "靠线程历史 + 搜索回查"],
        details: [
          ["角色设定", "developerInstructions"],
          ["续聊", "thread/resume"],
          ["压缩", "thread/compact/start（手动）、thread/compacted（完成事件）"],
          ["回查", "thread/read、命令执行 / rg"]
        ]
      },
      {
        stance: "自动 + 手动",
        special: ["自动压缩 + 手动 /compact 并存", "每轮重新接上原会话", "压缩位置只记在事件里"],
        details: [
          ["角色设定", "Options.systemPrompt（preset + append）"],
          ["续聊", "resume（每轮调用）"],
          ["压缩", "/compact（手动）、compact_boundary（边界事件）"],
          ["回查", "getSessionMessages、Read / Grep、会话 JSONL"]
        ]
      }
    ]
  },
  {
    name: "权限管理",
    basic: ["执行受权限边界约束", "需要时请你审批"],
    cells: [
      { special: ["规则判断 + 进程沙箱 + 平台审批"], details: [["机制", "permission-system、macOS Seatbelt、平台审批"]] },
      { special: ["原生文件沙箱 + 审批策略"], details: [["机制", "sandbox、approval policy、工具权限"]] },
      { special: ["原生权限规则，与平台审批衔接", "实际边界随会话模式变化"], details: [["机制", "permission mode、Agent SDK canUseTool"]] }
    ]
  },
  {
    name: "文件与代码操作",
    basic: ["读取、搜索、修改文件", "执行命令", "受权限模式约束"],
    cells: [
      { special: [], details: [["工具", "read / grep / find / ls / write / edit / bash"]] },
      { special: ["以补丁方式改文件", "工具名随接口变化"], details: [["工具", "命令执行、apply_patch、rg"]] },
      { special: [], details: [["工具", "Read / Glob / Grep / Write / Edit / Bash"]] }
    ]
  },
  {
    name: "搜索和抓取",
    basic: ["联网查资料", "读取网页"],
    cells: [
      { special: ["由平台检索服务或搜索扩展提供", "未装配则不可用"], details: [["工具", "平台联网检索（Brave Search / Firecrawl）、搜索扩展"]] },
      { special: ["原生联网搜索", "受网络策略和审批约束"], details: [["工具", "内置联网搜索、网页读取（名称随版本变化）"]] },
      { special: ["原生联网搜索", "可按工具或域名收紧权限"], details: [["工具", "WebSearch / WebFetch"]] }
    ]
  },
  {
    name: "浏览器自动化测试",
    basic: ["运行项目测试"],
    cells: [
      { special: ["有专用通道：列出并运行测试", "也可用命令跑其他测试"], details: [["测试通道", "Playwright Test：test_list / test_run"], ["其他", "bash"]] },
      { special: ["命令跑测试，再用浏览器工具检查交互", "依赖项目测试环境"], details: [["工具", "命令执行工具、项目测试框架、浏览器工具"]] },
      { special: ["命令跑测试", "浏览器测试依赖服务和项目环境"], details: [["工具", "Bash、项目测试框架"]] }
    ]
  },
  {
    name: "浏览器操作",
    basic: ["观察和操作网页", "依赖插件或服务已加载"],
    cells: [
      { special: ["可选隔离状态或专用持久状态"], details: [["工具", "Playwright MCP · browser_*"]] },
      { special: ["还能走电脑操作通道"], details: [["工具", "Browser / Chrome / Computer Use · cua_repl"]] },
      { special: ["需确认 Playwright 插件已启用"], details: [["工具", "Playwright MCP · browser_*"]] }
    ]
  },
  {
    name: "子 Agent / 任务委派",
    basic: ["把子任务委派出去", "接收状态和结果"],
    basicFor: "Codex、Claude Code",
    cells: [
      { special: ["暂无，当前装配未接入委派入口"], details: [["工具", "无专用委派入口"]] },
      { special: ["子 Agent 使用独立上下文", "受会话配置和委派规则约束"], details: [["工具", "spawn_agent / send_message / wait_agent（名称随接口变化）"]] },
      { special: ["只读群聊等模式可能禁用"], details: [["工具", "Agent / Task、Agent SDK 任务事件"]] }
    ]
  },
  {
    name: "长期记忆",
    basic: ["跨会话保留信息"],
    cells: [
      { special: ["结构化记忆，可增删改查", "需装配记忆存储，仅适用于普通 pi-ask"], details: [["工具", "pi-hermes-memory：memory_add / memory_replace / memory_remove / memory_search"]] },
      { special: ["原生记忆机制 + 本地文件", "加载和更新受配置、权限约束"], details: [["工具", "memories、MEMORY.md、文件读写工具"]] },
      { special: ["靠项目记忆文件", "自动加载和写入需在目标会话确认"], details: [["工具", "memory/MEMORY.md、Read / Write / Edit"]] }
    ]
  }
];

// 浮层挂在 body 上：表格容器是横向滚动区，放在格子里会被裁掉。
// 2026-10-26 起 PC 端也改为点击触发（不再悬停弹出）：开 / 关只由点按触发区、「关闭」按钮、
// 点击浮层外或 Esc 决定，指针移进移出不再改变状态，避免鼠标划过表格时浮层闪现。
let capabilityPop = null;
let capabilityPopOwner = null;
let capabilityPopIgnoreFocus = false;
let capabilityPopSide = null;
let capabilityPopCell = null;

function capabilityLayer() {
  if (capabilityPop?.isConnected) return capabilityPop;
  capabilityPop = h("div", { class: "resource-capability-pop", id: "resource-capability-pop", role: "dialog", "aria-label": "运行时能力详情", hidden: true });
  document.body.append(capabilityPop);
  return capabilityPop;
}

/** 收起浮层并清空内容；restoreFocus 用于「关闭」按钮和 Esc，把焦点还给触发按钮且不因此重新弹出 */
function closeCapabilityPop(restoreFocus = false) {
  const owner = capabilityPopOwner;
  if (capabilityPopOwner) capabilityPopOwner.setAttribute("aria-expanded", "false");
  capabilityPopOwner = null;
  capabilityPopCell = null;
  capabilityPopSide = null;
  if (capabilityPop) { capabilityPop.hidden = true; capabilityPop.replaceChildren(); }
  if (restoreFocus && owner) {
    capabilityPopIgnoreFocus = true;
    owner.focus({ preventScroll: true });
    capabilityPopIgnoreFocus = false;
  }
}

/** 浮层放在格子外（上 / 下），不遮住触发区域 */
function placeCapabilityPop(layer, cell, anchor) {
  const margin = 12;
  const cellRect = cell.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  layer.style.left = "0px"; layer.style.top = "0px"; layer.style.visibility = "hidden";
  const size = layer.getBoundingClientRect();
  const maxLeft = Math.max(margin, window.innerWidth - size.width - margin);
  layer.style.left = `${Math.round(Math.min(Math.max(anchorRect.left - 8, margin), maxLeft))}px`;
  const fitsAbove = cellRect.top - size.height - 8 >= margin;
  const fitsBelow = cellRect.bottom + 8 + size.height <= window.innerHeight - margin;
  // 已经选定的一侧只要还放得下就保持，避免滚动时来回翻面
  let side = capabilityPopSide;
  if (side === "above" && !fitsAbove) side = null;
  if (side === "below" && !fitsBelow) side = null;
  side ||= fitsBelow ? "below" : fitsAbove ? "above" : null;
  capabilityPopSide = side;
  const top = side === "above" ? cellRect.top - size.height - 8
    : side === "below" ? cellRect.bottom + 8
    : Math.min(Math.max(cellRect.bottom + 8, margin), Math.max(margin, window.innerHeight - size.height - margin));
  layer.style.top = `${Math.round(Math.max(margin, top))}px`;
  layer.style.visibility = "";
}

function openCapabilityPop(button, cellEl, row, cell, runtimeLabel, tone, index) {
  const layer = capabilityLayer();
  if (capabilityPopOwner !== button) {
    if (capabilityPopOwner) capabilityPopOwner.setAttribute("aria-expanded", "false");
    const nodes = [
      h("div", { class: "resource-capability-pop-head" },
        h("strong", {}, row.name),
        h("div", { class: "resource-capability-pop-head-actions" },
          h("span", { class: "muted small" }, runtimeLabel),
          h("button", {
            type: "button", class: "resource-capability-pop-close", "aria-label": "关闭能力详情", title: "关闭",
            onclick: (event) => { event.stopPropagation(); closeCapabilityPop(true); }
          }, "×"))),
      cell.stance ? h("div", { class: "resource-capability-stance", "data-tone": tone }, cell.stance) : null,
      h("dl", { class: "resource-capability-pop-facts" }, cell.details.map(([label, text]) => [h("dt", {}, label), h("dd", {}, text)])),
      // 具体模型清单也收进浮层，格子里只留数量与新建默认摘要
      row.models ? renderModelsDetail(RUNTIME_CAPABILITY_KINDS[index]) : null
    ];
    layer.replaceChildren(...nodes.filter(Boolean));
  }
  capabilityPopOwner = button;
  capabilityPopCell = cellEl;
  button.setAttribute("aria-expanded", "true");
  layer.hidden = false;
  placeCapabilityPop(layer, cellEl, button);
}

function renderCapabilityCell(row, cell, index) {
  const runtimeLabel = RUNTIME_CAPABILITY_LABELS[index];
  const tone = RUNTIME_CAPABILITY_TONE[RUNTIME_CAPABILITY_KINDS[index]];
  const button = h("button", {
    type: "button", class: "resource-capability-detail", "aria-expanded": "false",
    "aria-controls": "resource-capability-pop",
    "aria-label": `${row.name} · ${runtimeLabel}：指令与接口${row.models ? "与模型清单" : ""}`
  }, "详情");
  const show = () => openCapabilityPop(button, td, row, cell, runtimeLabel, tone, index);
  // 再点一次同一个「详情」收起；点别的格子的「详情」直接换成那一格的内容
  let fromPointer = false;
  button.addEventListener("pointerdown", () => { fromPointer = true; });
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    fromPointer = false; // 已经由 click 处理，别再让下一次键盘 focus 被当成鼠标点按
    if (capabilityPopOwner === button) { closeCapabilityPop(); return; }
    show();
  });
  // 只有键盘焦点（Tab）才顺带弹出；鼠标点按走上面的 click，否则 focus 会先把浮层打开又立刻被 click 收起
  button.addEventListener("focus", () => {
    const viaPointer = fromPointer;
    fromPointer = false;
    if (viaPointer || capabilityPopIgnoreFocus) return;
    show();
  });
  const td = h("td", { class: "resource-capability-cell", "data-runtime": RUNTIME_CAPABILITY_KINDS[index] },
    h("div", { class: "resource-capability-section-label" }, "特色能力"),
    cell.stance ? h("div", { class: "resource-capability-stance", "data-tone": tone }, cell.stance) : null,
    cell.special.length
      ? h("ul", { class: "resource-capability-list" }, cell.special.map((text) => h("li", {}, text)))
      : h("p", { class: "resource-capability-none muted small" }, "—"),
    row.models ? renderModelsExtra(RUNTIME_CAPABILITY_KINDS[index]) : null,
    button);
  // 触屏上整个格子都可以点开 / 点收（手指点「详情」太窄）；PC 与键盘走「详情」按钮和焦点，不再悬停弹出
  if (window.matchMedia?.("(pointer: coarse)").matches) {
    td.addEventListener("click", (event) => {
      if (event.target.closest?.("button")) return;
      if (capabilityPopOwner === button) { closeCapabilityPop(); return; }
      show();
    });
  }
  return td;
}

/* ------------------------------ 支持模型一行 + 新建会话默认配置 ------------------------------ */
// 第一行列出各运行时上报的模型；每列有「设置默认」入口，把新建会话的模型 / 推理强度 / 审批模式存在服务端。
// 新建页优先用这台浏览器里你最近一次的选择，没有才用这里的服务端默认（见 runtime.js rtDraftValue）。

/** 服务端保存的新建默认摘要：模型 · 强度 · 审批（空项显示为运行时默认） */
function modelDefaultsSummary(p, d) {
  const mo = rtModelOption(p, d.model);
  const perm = (p?.permissionOptions || []).find((x) => x.id === d.permissionMode);
  return [d.model ? (mo?.label || d.model) : "默认模型", d.effort ? (RT_EFFORT[d.effort] || d.effort).split("（")[0] : "默认强度", perm ? rtPermissionShort(perm) : d.permissionMode || "默认审批"].join(" · ");
}
function openDefaultsEditor(kind, p) {
  const cur = ui.rt.settings?.defaultSessionByRuntime?.[kind];
  const sel = rtSelectableModels(kind, p);
  const options = p?.permissionOptions || [];
  const fallbackPerm = options.some((x) => x.id === rtDefaultPermission(kind)) ? rtDefaultPermission(kind) : (options[0]?.id ?? rtDefaultPermission(kind));
  const draft = { kind, model: cur?.model ?? "", effort: cur?.effort ?? "", permissionMode: cur?.permissionMode || fallbackPerm };
  if (draft.model && !sel.models.some((m) => m.id === draft.model)) { draft.model = ""; draft.effort = ""; }
  if (!draft.model && !sel.defaultAllowed && sel.models.length) draft.model = sel.models[0].id;
  ui.rt.defaultsDraft = draft; ui.rt.defaultsError = "";
  renderMain();
}
async function saveDefaults(draft, clear) {
  const kind = draft.kind;
  ui.rt.defaultsBusy = kind; ui.rt.defaultsError = ""; renderMain();
  try {
    ui.rt.settings = await api(`/api/runtime-profiles/${kind}/session-defaults`, { method: "PUT", body: JSON.stringify({ defaults: clear ? null : { model: draft.model, effort: draft.effort, permissionMode: draft.permissionMode } }) });
    if (typeof rtWriteCache === "function") rtWriteCache();
    ui.rt.defaultsDraft = null;
    announce(clear ? `${RT_KIND[kind]} 新建默认配置已清除` : `${RT_KIND[kind]} 新建默认配置已保存`);
  } catch (e) { ui.rt.defaultsError = e.message; }
  ui.rt.defaultsBusy = ""; renderMain();
}

/** 默认配置编辑器：整行铺开，放在「支持模型」一行下面 */
function renderDefaultsEditorRow() {
  const draft = ui.rt.defaultsDraft;
  const kind = draft.kind;
  const p = (ui.rt.profiles || []).find((x) => x.runtimeKind === kind);
  const sel = rtSelectableModels(kind, p);
  const mo = rtModelOption(p, draft.model);
  const permissions = p?.permissionOptions?.length ? p.permissionOptions : [{ id: draft.permissionMode, label: draft.permissionMode }];
  const busy = ui.rt.defaultsBusy === kind;
  const saved = ui.rt.settings?.defaultSessionByRuntime?.[kind];
  return h("tr", { class: "resource-capability-defaults-row" },
    h("th", { scope: "row" }, "新建默认配置"),
    h("td", { colspan: String(RUNTIME_CAPABILITY_LABELS.length), class: "resource-capability-defaults-cell" },
      h("div", { class: "resource-defaults-editor", role: "group", "aria-label": `${RT_KIND[kind]} 新建会话默认配置` },
        h("div", { class: "resource-defaults-title" }, h("strong", {}, `${RT_KIND[kind]} 的新建会话默认配置`),
          h("span", { class: "muted small" }, "只在这台浏览器没有你最近一次选择时使用；你在新建页改过的项以你的选择为准。")),
        h("div", { class: "resource-defaults-fields" },
          h("label", {}, h("span", {}, "模型"),
            h("select", { "aria-label": "默认模型", "data-key": "rt-defaults-model", disabled: busy, onchange: (ev) => { draft.model = ev.target.value; const m = rtModelOption(p, draft.model); if (!m || !(m.efforts || []).includes(draft.effort)) draft.effort = ""; renderMain(); } },
              sel.defaultAllowed ? h("option", { value: "", selected: !draft.model }, "运行时默认模型") : null,
              sel.models.map((m) => h("option", { value: m.id, selected: draft.model === m.id }, m.label)))),
          h("label", {}, h("span", {}, "推理强度"),
            h("select", { "aria-label": "默认推理强度", "data-key": "rt-defaults-effort", disabled: busy || !(mo?.efforts || []).length, onchange: (ev) => { draft.effort = ev.target.value; } },
              h("option", { value: "", selected: !draft.effort }, rtDefaultEffortLabel(mo)),
              (mo?.efforts || []).map((e) => h("option", { value: e, selected: draft.effort === e }, `${RT_EFFORT[e] || e}（${e}）`)))),
          h("label", {}, h("span", {}, "审批模式"),
            h("select", { "aria-label": "默认审批模式", "data-key": "rt-defaults-permission", disabled: busy, onchange: (ev) => { draft.permissionMode = ev.target.value; } },
              permissions.map((x) => h("option", { value: x.id, selected: draft.permissionMode === x.id, title: x.detail || "" }, x.label))))),
        ui.rt.defaultsError ? h("p", { class: "field-error small", role: "alert" }, ui.rt.defaultsError) : null,
        h("div", { class: "resource-defaults-actions" },
          h("button", { type: "button", class: "btn small primary", "data-key": "rt-defaults-save", disabled: busy || (!draft.model && !sel.defaultAllowed), onclick: () => saveDefaults(draft, false) }, busy ? "保存中…" : "保存"),
          h("button", { type: "button", class: "btn small", disabled: busy, onclick: () => { ui.rt.defaultsDraft = null; ui.rt.defaultsError = ""; renderMain(); } }, "取消"),
          saved ? h("button", { type: "button", class: "btn-link small", disabled: busy, onclick: () => saveDefaults(draft, true) }, "清除默认") : null))));
}

/** 具体模型清单：不占表格格子，放进「支持模型」一行的详情浮层里 */
function renderModelsDetail(kind) {
  const p = (ui.rt.profiles || []).find((x) => x.runtimeKind === kind);
  if (!p) return h("p", { class: "muted small" }, ui.rt.profiles ? "还没检查连接，先到「运行时」页检查" : "读取中…");
  const allowed = ui.rt.settings?.enabledModelsByRuntime?.[kind];
  const saved = ui.rt.settings?.defaultSessionByRuntime?.[kind];
  const off = (m) => allowed && !allowed.includes(m.id);
  return h("section", { class: "resource-capability-pop-models" },
    h("div", { class: "resource-capability-section-label" }, `当前上报 ${p.models.length} 个模型`),
    p.models.length
      ? h("div", { class: "resource-model-chips" }, p.models.map((m) => h("span", { class: `rt-chip${saved?.model === m.id ? " default" : ""}${off(m) ? " off" : ""}`, title: `${m.id}${off(m) ? "（运行时配置里未勾选，新建会话不可选）" : ""}` }, m.label, saved?.model === m.id ? h("span", { class: "rt-chip-tag" }, "默认") : null)))
      : h("p", { class: "muted small" }, "未读取到"));
}

/** 「支持模型」一行里每个运行时的实时部分：上报模型数量 + 新建默认配置入口（接在特色能力下面） */
function renderModelsExtra(kind) {
  const control = !!ui.rt.access?.control;
  const editing = ui.rt.defaultsDraft?.kind;
  const p = (ui.rt.profiles || []).find((x) => x.runtimeKind === kind);
  if (!p) return h("p", { class: "muted small" }, ui.rt.profiles ? "还没检查连接，先到「运行时」页检查" : "读取中…");
  const saved = ui.rt.settings?.defaultSessionByRuntime?.[kind];
  return h("div", { class: "resource-model-live" },
    // 模型名字太多，主体只留数量（具体清单在「详情」里）
    h("div", { class: "resource-capability-section-label" }, p.models.length ? `当前上报 ${p.models.length} 个模型` : "当前上报 0 个模型"),
    h("div", { class: "resource-model-default small" },
      h("span", { class: "muted" }, saved ? `新建默认：${modelDefaultsSummary(p, saved)}` : "新建默认：沿用上次选择"),
      control ? h("button", { type: "button", class: "btn-link small", "data-key": `rt-defaults-edit-${kind}`, "aria-expanded": String(editing === kind), "aria-label": `设置 ${RT_KIND[kind]} 的新建会话默认配置`, onclick: () => { if (editing === kind) { ui.rt.defaultsDraft = null; renderMain(); } else openDefaultsEditor(kind, p); } }, editing === kind ? "收起设置" : "设置默认") : null));
}

function renderRuntimeCapabilities() {
  const rows = RUNTIME_CAPABILITY_ROWS;
  const block = h("div", { class: "resource-capability-block" },
    // 需要横向滚动时真正的表头会跟着滚走；这里放一份只用于显示的副本，吸在顶栏下面
    h("div", { class: "resource-capability-pinned", "aria-hidden": "true" }, h("div", { class: "resource-capability-pinned-scroll" })),
    h("div", { class: "resource-capability-scroll", role: "region", "aria-label": "运行时能力对比，可横向滚动", "aria-describedby": "runtime-capability-scroll-hint", tabindex: "0" },
      h("table", { class: "resource-capability-table", "aria-label": "运行时能力对比" },
        h("thead", {}, h("tr", {}, ["能力", ...RUNTIME_CAPABILITY_LABELS].map((label, i) => h("th", { scope: "col", ...(i ? { "data-runtime": RUNTIME_CAPABILITY_KINDS[i - 1] } : {}) }, label)))),
        rows.map((row) => h("tbody", { class: `resource-capability-group${row.models ? " resource-capability-models-group" : ""}` },
          h("tr", { class: "resource-capability-basic-row" },
            h("th", { scope: "row", rowspan: "2" }, row.name),
            h("td", { class: "resource-capability-basic", colspan: String(RUNTIME_CAPABILITY_LABELS.length) },
              h("div", { class: "resource-capability-basic-body" },
                h("div", { class: "resource-capability-section-label" }, "基础能力", row.basicFor ? h("span", { class: "muted" }, `（${row.basicFor}）`) : null),
                h("ul", { class: "resource-capability-list" }, row.basic.map((text) => h("li", {}, text)))))),
          h("tr", { class: "resource-capability-special-row" },
            row.cells.map((cell, i) => renderCapabilityCell(row, cell, i))),
          row.models && ui.rt.defaultsDraft ? renderDefaultsEditorRow() : null)))));
  scheduleCapabilitySticky(block);
  const root = h("div", { class: "resource-runtime-capabilities" },
    h("h3", {}, "运行时能力对比"),
    h("p", { class: "muted small" }, "资源页未绑定具体会话，以下为机制与工具说明，不代表当前会话实际可用。"),
    h("p", { class: "muted small resource-capability-hint", id: "runtime-capability-scroll-hint" }, "左右滑动查看三个运行时，左侧能力名称固定。"),
    h("p", { class: "muted small resource-capability-detail-hint" }, "每行先列三者共有的基础能力，再分列各自的特色能力；点按「详情」查看指令、接口与模型清单，再点一次、点浮层外或点「关闭」收起。"),
    block,
    h("p", { class: "muted small" }, "普通会话首轮附平台技能目录，技能正文按需读取；项目、角色、评估与群聊只读会话的注入范围另受规则约束。历史记录可用于回查，不等于每轮全部送入模型。"),
    h("p", { class: "muted small" }, "记忆用于跨会话保留信息；上下文压缩用于当前会话变长后继续工作。表中的原生命令、接口与事件用于说明机制，不表示平台提供对应操作按钮。工具名称随 runtime 版本和接入方式变化。"));
  // 从新建页的「运行时能力对比 →」跳来：滚到这张表（只滚一次）
  if (ui.resourceScrollTo === "capabilities") {
    ui.resourceScrollTo = "";
    requestAnimationFrame(() => root.scrollIntoView?.({ block: "start" }));
  }
  return root;
}

/* 能力对比表头吸顶。
 * 表格放得下时：外层不建横向滚动区，表头用 sticky 吸在顶栏下面（相对文档滚动）。
 * 放不下时（手机）：横向滚动区本身会成为 sticky 的参照，表头吸不住；改用一份同步滚动的表头副本。 */
let capabilityStickyAbort = null;
function scheduleCapabilitySticky(block) {
  if (typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => { if (block.isConnected) setupCapabilitySticky(block); });
}
function setupCapabilitySticky(block) {
  const scroller = block.querySelector(".resource-capability-scroll");
  const table = scroller?.querySelector("table");
  const thead = table?.tHead;
  const pinned = block.querySelector(".resource-capability-pinned");
  const pinScroll = pinned?.querySelector(".resource-capability-pinned-scroll");
  if (!scroller || !thead || !pinned || !pinScroll) return;
  capabilityStickyAbort?.abort();
  const ac = new AbortController();
  capabilityStickyAbort = ac;
  // --topbar-h 可能是 calc(...)，用一个小探针让浏览器算成像素；没有顶栏时与 CSS 的 49px 回退一致
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;top:var(--topbar-h, 49px);left:0;width:0;height:0;visibility:hidden;pointer-events:none";
  block.append(probe);
  const topbar = () => parseFloat(getComputedStyle(probe).top) || 0;
  // 手机上资源页的筛选条也是 sticky 的；表头要吸在它下面，不能叠上去
  const filters = block.closest(".resources")?.querySelector(".resource-filters");
  const stickyTop = () => filters && getComputedStyle(filters).position === "sticky"
    ? parseFloat(getComputedStyle(filters).top) + filters.getBoundingClientRect().height
    : topbar();
  let cloneWidth = 0;
  const build = () => {
    const tableWidth = table.getBoundingClientRect().width;
    if (Math.abs(tableWidth - cloneWidth) < 1 && pinScroll.firstChild) return;
    cloneWidth = tableWidth;
    const head = document.createElement("thead");
    const row = document.createElement("tr");
    for (const th of thead.rows[0].cells) {
      const cell = th.cloneNode(true);
      cell.style.width = `${th.getBoundingClientRect().width}px`;
      row.append(cell);
    }
    head.append(row);
    const clone = document.createElement("table");
    clone.className = "resource-capability-table resource-capability-pinned-table";
    clone.setAttribute("aria-hidden", "true");
    clone.style.width = `${tableWidth}px`;
    clone.append(head);
    pinScroll.style.height = `${thead.getBoundingClientRect().height}px`;
    pinScroll.replaceChildren(clone);
  };
  const sync = () => {
    // 表头副本只在需要横向滚动时出现；屏够宽时表头副本不需要存在，原表头自己 sticky
    const scrollable = getComputedStyle(scroller).overflowX !== "visible";
    const wide = scrollable && scroller.scrollWidth > scroller.clientWidth + 1;
    if (!wide) { pinned.classList.remove("is-stuck"); return; }
    build();
    pinScroll.style.height = `${thead.getBoundingClientRect().height}px`;
    pinScroll.scrollLeft = scroller.scrollLeft;
    const head = thead.getBoundingClientRect();
    const bottom = scroller.getBoundingClientRect().bottom;
    const top = stickyTop();
    pinned.style.top = `${top}px`;
    pinned.classList.toggle("is-stuck", head.top < top && bottom > top + head.height);
  };
  window.addEventListener("scroll", sync, { passive: true, capture: true, signal: ac.signal });
  window.addEventListener("resize", sync, { signal: ac.signal });
  scroller.addEventListener("scroll", sync, { passive: true, signal: ac.signal });
  // 首次渲染时字体 / 表格宽度可能还没定下来，用 ResizeObserver 在尺寸稳定后再校一次
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(sync);
    ro.observe(scroller);
    ro.observe(table);
    if (filters) ro.observe(filters);
    ac.signal.addEventListener("abort", () => ro.disconnect());
  }
  // 只有需要横向滚动（窄屏）时才需要副本；宽屏不往 DOM 里放第二张表
  sync();
  requestAnimationFrame(sync);
}

// 浮层的关闭方式对所有格子共用一次
if (typeof document !== "undefined" && !globalThis.__capabilityPopBound) {
  globalThis.__capabilityPopBound = true;
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !capabilityPopOwner) return;
    // 关闭后把焦点还给触发按钮，但不能因此又弹出来
    closeCapabilityPop(true);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!capabilityPopOwner) return;
    if (capabilityPopOwner.contains(event.target) || capabilityPop?.contains(event.target)) return;
    closeCapabilityPop();
  }, true);
  document.addEventListener("scroll", () => {
    if (!capabilityPopOwner || !capabilityPopCell) return;
    placeCapabilityPop(capabilityLayer(), capabilityPopCell, capabilityPopOwner);
  }, true);
  window.addEventListener("resize", () => {
    if (!capabilityPopOwner || !capabilityPopCell) return;
    placeCapabilityPop(capabilityLayer(), capabilityPopCell, capabilityPopOwner);
  });
}

function renderRuntimeConfigs(rc) {
  if (!rc) return null;
  return h("section", { class: "resource-section resource-runtimes", "aria-label": "运行时配置" },
    h("div", { class: "resource-provider-title" },
      h("h2", {}, "运行时配置"),
      h("span", { class: "muted small" }, rc.scope || "本机用户级配置")),
    renderRuntimeCapabilities());
}

/* ------------------------------ v3.12：DeepSeek token 消耗 ------------------------------ */
// DeepSeek 的消耗统计（按应用/功能占比、趋势、热力图）已经搬到统计应用（#/stats/cost）。
// 详情浮层里只保留入口：今日 / 昨日的 token 与金额，点一下就跳到统计应用；再加价格与口径说明（它属于这个资源本身）。
const DS_SERVICE = "model:deepseek";
const DS_STATS_HREF = "#/stats/cost?m=tokens&focus=trend";

function dsMoney(cost) {
  return cost ? `${dsUsd(cost.total)}${cost.partial ? " 起" : ""}` : "—";
}

/** 单独一个金额：带币种标，避免被当成人民币或余额。 */
function dsUsd(value) {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const digits = Math.abs(n) >= 1 ? 2 : Math.abs(n) >= 0.01 ? 3 : 4;
  return `US$${n.toFixed(digits)}`;
}

/** 价格、来源与统计口径：留在资源详情里，不属于统计应用。 */
function renderDeepSeekUsage(u) {
  if (!u) return null;
  const details = h("details", { class: "resource-reading-notes muted small ds-reading-notes" },
    h("summary", {}, "价格、来源与统计口径"),
    h("p", {}, `价格版本 ${u.price?.version || "未知"}（${u.price?.currency || "USD"}，${u.price?.unit || "每百万 token"}）：${(u.price?.models || []).map((m) => `${m.label} 峰时 输入 US$${m.input} / 输出 US$${m.output} / 缓存读 US$${m.cacheRead} / 缓存写 US$${m.cacheWrite}${m.offPeak ? `，波谷 输入 US$${m.offPeak.input} / 输出 US$${m.offPeak.output} / 缓存读 US$${m.offPeak.cacheRead}` : ""}`).join("；") || "未登记"}`),
    h("p", {}, u.price?.peakRule ? `计费时段：${u.price.peakRule}。` : "计费时段未登记：金额一律按峰时价估算。"),
    h("p", {}, `平台账本 ${compactNumber(u.coverage?.ledgerCalls || 0)} 次调用${u.coverage?.ledgerSince ? `，最早 ${when(u.coverage.ledgerSince)}` : ""}；Pi 受管会话 ${compactNumber(u.coverage?.runtimeSessionsWithDeepSeek || 0)} 个有 DeepSeek 用量。更新时间 ${when(u.generatedAt)}（${u.timeZone || "本机时区"}）。`),
    h("ul", {}, (u.notes || []).map((n) => h("li", {}, n))));
  return h("section", { class: "resource-deepseek ds-usage", "aria-label": "DeepSeek 价格与口径" }, details);
}

/** DeepSeek 详情浮层顶部的统计入口：今日 / 昨日的 token 与金额；点一张卡跳到统计应用看占比、趋势和热力图。 */
function renderDeepSeekStats(u) {
  if (!u?.ranges) return null;
  const tile = (id) => {
    const r = u.ranges[id];
    if (!r) return null;
    const t = r.totals || {};
    return h("a", {
      class: "ds-stat ds-stat-tile", href: DS_STATS_HREF, "data-ds-tile": id,
      "aria-label": `${r.label} DeepSeek 消耗，在统计应用查看详情`,
      // 浮层是模态的：先关掉它，再让链接跳转
      onclick: () => closeResourceDrawer(false)
    },
      h("span", { class: "ds-stat-label" }, `${r.label}${r.from ? ` · ${r.from.slice(5)}` : ""}`),
      h("strong", { class: "ds-stat-value" }, `${compactNumber(t.totalTokens || 0)} token`, h("span", { class: "ds-stat-money" }, dsMoney(t.cost))),
      h("span", { class: "ds-stat-sub" }, `${compactNumber(t.calls || 0)} 次调用 · 点击查看统计`));
  };
  return h("div", { class: "ds-stats-module", role: "group", "aria-label": "DeepSeek 消耗统计" },
    h("div", { class: "ds-stats-head" },
      h("strong", {}, "DeepSeek 消耗"),
      h("a", { class: "ds-stats-link", href: DS_STATS_HREF, onclick: () => closeResourceDrawer(false) }, "统计应用 ›")),
    h("p", { class: "muted small ds-stats-note" }, "估算金额（USD）。按应用 / 功能的占比、日趋势和月度热力图都在统计应用里。"),
    h("div", { class: "ds-summary ds-stats-tiles" }, tile("today"), tile("yesterday")));
}

/* ------------------------------ 详情：右侧浮层 ------------------------------ */
// 点「详情」不再在列表里展开，而是拉起右侧浮层（手机铺满整屏，和文件预览同一套交互）：
// 头部是服务名 + 状态 + 刷新 / 关闭，正文是该服务的凭据、使用位置、余额来源；DeepSeek 还带今日/昨日统计和消耗明细。
let resourceDrawer = null;

function closeResourceDrawer(restoreFocus = true) {
  const d = resourceDrawer;
  if (!d) return;
  resourceDrawer = null;
  try { d.dialog.close(); } catch { /* 已关闭 */ }
  d.dialog.remove();
  if (restoreFocus && d.trigger?.isConnected) d.trigger.focus();
}

function openResourceDrawer(service, trigger) {
  closeResourceDrawer(false);
  const dialog = h("dialog", { class: "resource-drawer", "aria-label": "资源详情" });
  dialog.addEventListener("cancel", (e) => { e.preventDefault(); closeResourceDrawer(); });
  // 点浮层外的遮罩关闭（dialog 自己没有内边距，点到它就是点在遮罩上）
  dialog.addEventListener("click", (e) => { if (e.target === dialog) closeResourceDrawer(); });
  resourceDrawer = { service, dialog, trigger };
  document.body.append(dialog);
  dialog.showModal();
  refreshResourceDrawer();
}

/** 按当前数据重画浮层内容，保留滚动位置；服务已不存在（被刷新掉）就关掉。 */
function refreshResourceDrawer() {
  const d = resourceDrawer;
  if (!d) return;
  const s = (ui.resources?.services || []).find((x) => x.service === d.service);
  if (!s) { closeResourceDrawer(false); return; }
  const [stateLabel, stateKind] = RES_STATE[s.state] || [s.state, ""];
  const q = s.quota;
  const canRefresh = q ? q.canRefresh : (s.balance?.source && s.credential?.configured);
  const refreshing = ui.resourceRefreshing === s.service;
  const scroll = d.dialog.querySelector(".resource-drawer-body")?.scrollTop ?? 0;
  const head = h("header", { class: "resource-drawer-head" },
    h("div", { class: "resource-drawer-title" }, h("strong", { title: s.label }, s.label), badge(stateLabel, stateKind)),
    h("div", { class: "resource-drawer-tools" },
      canRefresh ? h("button", { type: "button", class: "btn small ghost", disabled: !!ui.resourceRefreshing, "aria-label": `刷新 ${s.label} ${q ? "额度" : "余额"}`, onclick: () => refreshResource(s) }, refreshing ? "正在读取…" : (q ? "刷新额度" : "刷新余额")) : null,
      h("button", { type: "button", class: "btn small ghost", "aria-label": "关闭", onclick: () => closeResourceDrawer() }, "关闭")),
    h("p", { class: "resource-drawer-sub muted small" }, q
      ? `${s.credential?.configured ? "订阅登录" : "未登录"}${q.plan ? ` · ${q.plan}` : ""} · 账户额度`
      : `${s.credential?.configured ? "凭据已配置" : "凭据未配置"} · ${s.roles.length} 个使用位置`));
  const body = h("div", { class: "resource-drawer-body" },
    ui.resourceMsg ? h("p", { class: "warn-text small", role: "status" }, ui.resourceMsg) : null,
    s.service === DS_SERVICE ? [renderDeepSeekStats(ui.resources?.deepseekUsage), renderDeepSeekUsage(ui.resources?.deepseekUsage)] : null,
    resourceDetailGrid(s));
  const panel = h("div", { class: "resource-drawer-panel" }, head, body);
  d.dialog.replaceChildren(panel);
  body.scrollTop = scroll;
  // 手机：按住头部往下拖关闭（与文件预览一致）
  if (typeof filePreviewSwipe === "function") filePreviewSwipe(head, panel, () => closeResourceDrawer());
}

// 换页（地址变化）时浮层不该留在新页面上
window.addEventListener("hashchange", () => closeResourceDrawer(false));

async function switchWebProvider(provider) {
  if (ui.resourceSwitching) return;
  const context = pageContext();
  ui.resourceSwitching = provider;
  ui.resourceMsg = "";
  renderMain();
  try {
    const result = await api("/api/resources/web-research/provider", { method: "POST", body: JSON.stringify({ provider }) });
    await loadResources();
    const option = result?.options?.find((o) => o.id === result.selected);
    const label = option ? option.label : "没有可用配置";
    if (contextCurrent(context)) ui.resourceMsg = provider === "auto" ? `已恢复自动选择：${label}` : `已切换到 ${label}`;
  } catch (e) {
    if (contextCurrent(context)) ui.resourceMsg = `切换联网供应商失败：${e.message}`;
  } finally {
    ui.resourceSwitching = null;
    if (contextCurrent(context)) renderMain();
  }
}

function renderWebResearch(w, r, filter = "all") {
  const selected = w.options.find((o) => o.id === w.selected);
  const preferenceLabel = w.preference === "auto"
    ? `自动选择${selected ? `（当前 ${selected.label}）` : "（没有可用配置）"}`
    : `手动选择：${selected?.label ?? w.options.find((o) => o.id === w.preference)?.label ?? w.preference}`;
  const intro = h("section", { class: "resource-section resource-web-research", "aria-label": "联网检索供应商" },
    h("div", { class: "resource-provider-title" }, h("h2", {}, "联网检索供应商"), h("span", { class: "muted small" }, preferenceLabel)),
    h("p", { class: "muted small" }, "两套配置实现同一套 web.search / web.open 契约；手动选择保存在本机数据目录，切换后对之后新启动的联网调用生效。"),
    renderQuickProviderSwitch(w),
    w.error ? h("p", { class: "warn-text small" }, `当前选择无法解析：${w.error}`) : null);
  return [intro, ...w.options.map((o) => {
    const list = r.services.filter((s) => (s.service === o.services.search || s.service === o.services.fetch) && (filter === "all" || s.kind === filter));
    if (!list.length) return null;
    const active = w.selected === o.id;
    const fixed = w.preference === o.id;
    const busy = ui.resourceSwitching === o.id;
    const action = fixed && active
      ? h("button", { class: "btn small", type: "button", disabled: true }, "当前使用")
      : h("button", {
          class: "btn small", type: "button", disabled: !o.ready || !!ui.resourceSwitching,
          "aria-label": `切换到 ${o.label}`, onclick: () => switchWebProvider(o.id)
        }, busy ? "切换中…" : active ? "固定使用这一套" : "切换到这一套");
    const head = h("div", { class: "resource-provider-head" },
      h("p", { class: o.ready ? "muted small" : "warn-text small" }, o.ready ? o.description : `${o.description} ${o.reason || ""}`.trim()),
      h("div", { class: "resource-actions" }, action));
    return resourceSection(o.label, list, head, `resource-provider-section${active ? " resource-provider-active" : ""}`);
  })].filter(Boolean);
}

function renderResources(embedded = false) {
  // 重绘时收起旧浮层：它挂在 body 上，格子被替换后不能再指向旧节点
  if (capabilityPopOwner) closeCapabilityPop();
  // 旧表头副本的监听跟着旧 DOM 一起作废（这次可能不再渲染能力表）
  capabilityStickyAbort?.abort();
  // Data is loaded by the route loader, never by a render side effect.
  const r = ui.resources;
  const filter = activeResourceFilter();
  const counts = resourceCounts(r);
  const show = (kind) => filter === "all" || filter === kind;
  const models = r ? r.services.filter((s) => s.kind === "model" && s.service !== "model:zhipu") : [];
  const refresh = h("button", { class: "btn small resource-page-refresh", type: "button", "aria-label": "重新读取本机状态", title: "重新读取本机状态", onclick: () => loadResources().then(renderMain) }, "重新读取本机状态");
  // 嵌在设置页里时，标题和说明由设置页头自己给，这里只留刷新按钮。
  const head = embedded
    ? h("div", { class: "resource-embed-head" }, h("p", { class: "muted small" }, "本机只读：CLI 安装状态与版本，模型、搜索、抓取、配音的凭据状态、用量、余额。"), refresh)
    : h("div", { class: "resource-page-head" }, h("div", {}, h("h1", {}, "外部资源"),
      h("p", { class: "muted small" }, "运行时、本机 CLI、模型（含 Claude / OpenAI 订阅账号）、DeepSeek token 消耗渠道、联网检索、配音与各服务的状态、用量和账户余额。")), refresh);
  return h("div", { class: `resources${embedded ? " resources-embedded" : ""}`, onkeydown: resourceShortcut },
    head,
    ui.resourcesLoading ? h("p", {role:"status", "aria-busy":"true"}, "正在读取本机状态…") : null,
    ui.resourcesError ? h("div", { class: "error" }, ui.resourcesError) : null,
    ui.resourceMsg ? h("div", { class: "warn-text", role: "status" }, ui.resourceMsg) : null,
    r ? h("p", { class: "muted small resource-meta" }, h("span", { class: "resource-meta-scope" }, `${r.scope} · ${r.timezone} · `), `更新于 ${when(r.generatedAt)}`) : null,
    r ? renderResourceFilters(counts, filter) : null,
    r && show("cli") ? renderLocalClis(r.localClis) : null,
    r && show("runtime") ? renderRuntimeConfigs(r.runtimeConfigs) : null,
    r && show("model") && models.length ? resourceSection("模型", models) : null,
    r && r.webResearch && (show("search") || show("fetch")) ? renderWebResearch(r.webResearch, r, filter) : null,
    r && r.webResearch && show("voice") ? RES_KIND.filter(([kind]) => kind === "voice").map(([kind, title]) => {
      const list = r.services.filter((s) => s.kind === kind);
      return list.length ? resourceSection(title, list) : null;
    }) : null,
    r && !r.webResearch && filter !== "model" ? RES_KIND.filter(([kind]) => kind !== "model" && show(kind)).map(([kind, title]) => {
      const list = r.services.filter((s) => s.kind === kind && s.service !== "model:zhipu");
      return list.length ? resourceSection(title, list) : null;
    }) : null,
    r && filter !== "all" && counts[filter] === 0 ? h("p", { class: "muted resource-empty" }, `没有${RES_FILTERS.find(([id]) => id === filter)?.[1] ?? ""}资源`) : null,
    h("details", { class: "resource-reading-notes muted small" }, h("summary", {}, "统计口径与状态说明"),
      h("p", {}, "凭据已配置只说明本机有配置；最近调用结果只代表该时间、能力和模型，不代表所有操作都可用。密钥从不显示。"),
      h("p", {}, "本机用量包含失败调用，不是服务商账单，也不能推算余额。"),
      h("p", {}, "DeepSeek token 消耗按应用-功能统计；金额是按 Pi 模型表单价反算的估算，未定价模型只计 token，不写 0 元。"),
      h("p", {}, "运行时订阅额度是 runtime 报告的账户级快照（与「新建会话」同源），和模型服务同在「模型」表；订阅按账户额度窗口计，不按本机调用次数统计，也不从 token 数反推。"),
      h("p", {}, "联网供应商只影响之后新启动的联网调用；已开始的运行不受影响。"),
      h("p", {}, "本页不修改模型选择或授权；账户余额仅在手动刷新时读取，过期或读取失败会标为非实时。")));
}

// Standalone embedders retain their existing entry points.
Object.assign(window, { renderResources, loadResources });
window.piRouteModules?.register("resources", { render: () => renderResources() });
})();
