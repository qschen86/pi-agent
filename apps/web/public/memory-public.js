/* 平台记忆：一级导航里的独立应用页。
 * 只有一个列表：公共记忆（个人偏好 + 各项目），数据来自流水线（从平台会话里你亲口说的话提炼）。
 * 设置页（#/memory/settings）里有：每日自动提炼、新会话注入的开关和注入预览。
 * 架构页（#/memory/architecture，memory-architecture.js）：当前版本的架构图，对比模式标出相对旧版本的改动；入口在「设置」左边，有新版本时亮红点。
 * 旧机制（扫描 runtime 私有记忆 → 候选 → 逐条审查）的页面、接口与数据读取都已下线。 */
const PM_API = "/api/memory/public";
function pmIcon(name) {
  const paths = {refresh:'M20 7v5h-5 M4 17v-5h5 M6.1 7a7 7 0 0 1 11.6-2L20 8 M4 16l2.3 3A7 7 0 0 0 18 17', edit:'M12 20h9 M16.6 3.4a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z', trash:'M4 7h16 M9.5 7V4.5h5V7 M6.5 7l1 13h9l1-13 M10.5 11v6 M13.5 11v6'};
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [k, v] of Object.entries({viewBox:"0 0 24 24", fill:"none", stroke:"currentColor", "stroke-width":"1.8", "stroke-linecap":"round", "stroke-linejoin":"round", "aria-hidden":"true"})) svg.setAttribute(k, v);
  const path = document.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", paths[name] || paths.refresh); svg.append(path); return svg;
}
let pmPage = null;
function pmCreate() {
  const root = h("section", {class:"pm-page pi-memory-dialog pm-dialog", "aria-label":"平台记忆"});
  return {root, data:null, loading:false, loadedAt:0, busy:false, error:"", versionConflict:false, preview:null};
}
/** 路由模块入口：页面状态留在内存里，离开再回来立刻显示上次的内容，同时在后台静默刷新。 */
function renderPublicMemoryPage() {
  if (!pmPage) pmPage = pmCreate();
  const d = pmPage;
  // 从会话里引用记忆的 chip 点回来：#/memory/t/<编号> → 打开那条记忆的详情（地址随即换回 #/memory，关掉详情后刷新不会再弹）
  const link = /^#\/memory\/t\/([\w-]+)$/.exec(location.hash);
  if (link) { const st = pmTopicState(d); st.deepLink = link[1]; st.view = "catalog"; st.entry = null; if (st.state === "ready") st.state = "idle"; history.replaceState(null, "", "#/memory"); }
  renderPublicMemory();
  // 回到页面就静默重读：列表先照旧显示，读完局部更新（比如刚在会话里「加入记忆」）
  if (!pmOnSettings() && !pmOnArch()) { const st = pmTopicState(d); if (st.state === "ready" && Date.now() - (st.loadedAt || 0) > 5000) { st.state = "idle"; void pmLoadTopics(); } }
  return d.root;
}
const PM_ERRORS = {RT_FORBIDDEN:"需要控制权限", busy:"另一个操作正在进行，请稍后重试", "storage-error":"公共记忆的记录文件需要检查", "not-found":"这条记录已不存在，请刷新", conflict:"操作与当前状态冲突，请刷新后重试", "invalid-input":"输入不合规"};
function pmMessage(e) { const m = e && e.message; return m && /[\u4e00-\u9fff]/.test(m) ? m : (PM_ERRORS[e && e.code] || "操作失败，请重试"); }
/** 设置页要用的少量数据（开关、项目列表、乐观并发版本）；列表页不读它。 */
async function pmLoadSettings() {
  const d = pmPage; if (!d || d.loading) return;
  d.loading = true; renderPublicMemory();
  try { const core = await api(`${PM_API}?slim=1&candidates=0`); if (pmPage !== d) return; d.data = core; d.error = ""; d.loadedAt = Date.now(); }
  catch (e) { if (pmPage === d) d.error = pmMessage(e); }
  finally { if (pmPage === d) { d.loading = false; renderPublicMemory(); } }
}
/* 提炼流水线的运行状态（上次运行、每日定时、下次运行）只在设置页显示：它是运维信息，不属于某一条记忆。 */
const pmPipe = d => (d.pipe ||= {status:null, state:"idle", error:"", poll:0});
async function pmLoadPipeStatus() {
  const d = pmPage; if (!d) return; const p = pmPipe(d);
  if (p.state === "loading") return;
  p.state = "loading";
  try { const r = await api(`${PM_API}/pipeline/status`); if (pmPage !== d) return; p.status = r.status || null; p.error = ""; p.state = "ready"; p.loadedAt = Date.now(); }
  catch (e) { if (pmPage === d) { p.error = pmMessage(e); p.state = "error"; } }
  if (pmPage === d) renderPublicMemory();
  pmPipePoll(d);
}
/** 运行中每 4 秒问一次状态，跑完再刷一次；离开设置页就停。 */
function pmPipePoll(d) {
  const p = pmPipe(d); clearTimeout(p.poll);
  if (p.status?.running && pmOnSettings()) p.poll = setTimeout(() => { if (pmPage === d && pmOnSettings()) void pmLoadPipeStatus(); }, 4000);
}
async function pmRunPipeline() {
  const d = pmPage; if (!d) return; const p = pmPipe(d);
  try { await api(`${PM_API}/pipeline/run`, {method:"POST", body:"{}"}); p.error = ""; p.status = {...(p.status || {}), running:true}; }
  catch (e) { p.error = pmMessage(e); }
  renderPublicMemory(); pmPipePoll(d);
}
;
async function pmSetSetting(key, value) {
  const d = pmPage; if (!d || d.busy) return;
  d.busy = true; d.error = ""; renderPublicMemory();
  try { await api(`${PM_API}/settings`, {method:"POST", body:JSON.stringify({expectedVersion:d.data?.mutationVersion, [key]:value})}); d.versionConflict = false; }
  catch (e) { d.error = pmMessage(e); d.versionConflict = e?.code === "conflict"; }
  d.busy = false;
  await pmLoadSettings();
  if (d.preview) { d.preview.result = null; void pmPreview(); }
}
const pmOnSettings = () => location.hash === "#/memory/settings";
const pmOnArch = () => location.hash === "#/memory/architecture";
/** 架构页（memory-architecture.js）是按需共享模块：没加载时（比如只载入本脚本的测试页）退化为没有这个入口的红点。 */
const pmHasArch = () => typeof renderPmArch === "function";
/* ===== 公共记忆列表：只分「个人偏好」和「项目记忆」两类 =====
 * 数据来自流水线（/api/memory/public/pipeline）：从平台会话里你亲口说的话提炼，同一条规则说过几遍只留一条。
 * 筛选一行「归属」（个人偏好 / 各项目）；单个项目下多一行「模块」（模块名 = 一级导航的应用名，没归类的收在「待归类」），
 * 个人偏好下多一行「性质」；再一行「消费方式」（常驻 / 按需）。项目范围、模块选「全部」时列表按模块分组显示；
 * 常驻/按需同时也是每条右边的小标记。待处理不占一行，只在有事时出现一条提示。
 * 顶上「分类 / 动态」两个视图：分类 = 当前所有记忆；动态 = 记忆的变更日志，按时间倒序（新增、更新、取代、冲突、裁决、升降级、移除）。
 * 除了「冲突待确认」可以在这里裁决（采用新的 / 保留旧的），其余仍然只读。 */
const PM_TSUB = {personal:["目标","沟通","验收","审美","流程","红线","背景"]};
/** 模块清单由接口给（来自后端 modules.ts，前端不另存一份）：个人偏好没有模块，没归类的收「待归类」。 */
const pmModules = st => st.status?.modules || [];
const pmModuleName = (st, id) => (pmModules(st).find(m => m.id === id) || {}).name || (id === "cross" ? "待归类" : id);
const pmTModule = t => (t.domain === "personal" ? "" : (t.module && t.module !== "cross" ? t.module : "cross"));
const pmTModuleLabel = (st, t) => { const k = pmTModule(t); return k === "cross" ? "待归类" : pmModuleName(st, k); };
/** 分类标签：个人偏好看性质，项目记忆看模块（项目没有性质这一维）。 */
const pmTKindLabel = (st, t) => (t.domain === "personal" ? (t.sub || "流程") : pmTModuleLabel(st, t));
/** 目标是方向：个人偏好的「目标」性质，或项目里 goal 模块。 */
const pmIsGoal = t => (t.domain === "personal" ? t.sub === "目标" : t.module === "goal");
const PM_TIER = {A:"常驻", B:"按需", material:"素材"};
/** 约束类型（与常驻 / 按需同级）：强约束 = 必须关联检测规则，会话按规则的节点自动检查；待补规则 = 适合强约束但还没有能检查它的规则（按软约束处理）；软约束 = 模型自己决定是否遵循；待定 = 判定模型拿不准，等人决定（之前按软约束处理）。 */
const PM_CONSTRAINT = {hard:"强约束", "needs-rule":"待补规则", soft:"软约束", uncertain:"约束待定"};
const pmConstraintLevel = t => t.constraint?.level || "soft";
const PM_CONSTRAINT_TITLE = {hard:"已绑定校验规则：平台按规则的节点自动检查，没做到会被要求重做", "needs-rule":"适合强约束，但校验规则还没写出来；写成之前按软约束处理，不会被检查", soft:"由模型自己决定是否遵循", uncertain:"判定模型拿不准是强约束还是软约束，等你决定；在此之前按软约束处理"};
/** 约束类型标签。列表头部与详情里三种都给（all=true）；不传 all 时只给强约束 / 待定（软约束是默认）。 */
const pmConstraintTag = (t, all) => { const lv = pmConstraintLevel(t); return !t.pending && (all || lv !== "soft") ? h("span", {class:`pm-topic-tier tier-${lv}`, title:PM_CONSTRAINT_TITLE[lv]}, PM_CONSTRAINT[lv]) : null; };
const pmRule = (st, id) => (st.status?.constraintRules || []).find(r => r.id === id);
const pmRuleTitle = (st, id) => pmRule(st, id)?.title || id;
/** 校验节点：目前只有回合结束。 */
const PM_NODE = {"turn-end":"回合结束"};
const pmWithNode = r => r ? {...r, nodeLabel:r.nodeLabel || PM_NODE[r.node] || r.node} : null;
/** 一条强约束绑定的规则（四要素）：DeepSeek 写的（挂在记忆上）优先，其次代码规则清单里的；by = model（回合结束由判定模型按四要素核对）| code（代码确定性判定）。 */
const pmRuleOf = (st, t) => {
  const c = t.constraint, code = c?.ruleId ? pmRule(st, c.ruleId) : null;
  const spec = c?.rule || code;
  return spec ? {...pmWithNode(spec), by:code ? "code" : "model"} : null;
};
/** 规则说明按行写：`标签：` 的标签加粗、`· ` 开头是并列要点、`1. ` 开头是步骤，其余是短句。 */
function pmRuleLines(text) {
  const out = []; let list = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { list = null; continue; }
    const bullet = /^[·•]\s*(.+)$/.exec(line), step = /^\d{1,2}[.、)]\s*(.+)$/.exec(line);
    if (bullet || step) {
      const tag = step ? "ol" : "ul";
      if (!list || list.tagName !== tag.toUpperCase()) { list = h(tag, {class:`pm-rule-points pm-rule-${tag}`}); out.push(list); }
      list.append(h("li", {}, (step || bullet)[1]));
      continue;
    }
    list = null;
    const i = line.indexOf("："), head = i > 0 && i <= 12 ? line.slice(0, i + 1) : "";
    out.push(h("p", {}, head ? h("b", {}, head) : null, head ? line.slice(i + 1) : line));
  }
  return out;
}
/** 检测规则的四要素：校验节点 / 校验对象范围 / 校验规则 / 结果反馈（每条规则必须写清楚）。 */
/** 取证项：平台在回合前后实际读到的功能事实（和 runtime-sessions/memory-probes.ts 的目录一致），模型判定的规则按它核对，而不是只看回复措辞。 */
const PM_PROBES = {"changed-files":"本回合改动的文件", "android-release":"原生 App 发布状态", "live-deploy":"线上部署状态"};
const pmRuleSpec = rule => rule ? h("dl", {class:"pm-rule-spec", "aria-label":"校验规则说明"},
  ...[["校验节点", rule.nodeLabel], ["校验对象范围", rule.scope], ["校验规则", rule.criteria], ["结果反馈", rule.feedback]].map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, pmRuleLines(v)))),
  // 代码规则自己取证；模型判定的规则要列出核对的功能事实，没有取证项的要明说（只看回复和工具记录）
  rule.id || rule.ruleId ? null : h("div", {class:"pm-rule-probes"}, h("dt", {}, "取证项"), h("dd", {}, rule.probes?.length ? rule.probes.map(id => PM_PROBES[id] || id).join("、") : "无（只看最终回复和工具记录，不核对功能事实）"))) : null;
const pmBj = (iso, opts) => { const t = Date.parse(iso || ""); return Number.isFinite(t) ? new Intl.DateTimeFormat("zh-CN", {timeZone:"Asia/Shanghai", hour12:false, ...opts}).format(new Date(t)) : "—"; };
const pmDay = iso => pmBj(iso, {month:"2-digit", day:"2-digit"}).replace("/", "-");
const pmDayTime = iso => `${pmDay(iso)} ${pmBj(iso, {hour:"2-digit", minute:"2-digit"})}`;
const pmTScope = t => (t.domain === "personal" ? "personal" : `project:${t.project}`);
const pmTScopeLabel = key => (key === "personal" ? "个人偏好" : key.slice(8));
function pmTopicState(d) { return (d.topics ||= {state:"idle", items:[], scopes:[], scopeDraft:null, rescope:null, remove:null, status:null, error:"", material:false, scope:"all", sub:"all", module:"all", layer:"all", constraint:"all", entry:null, more:false, poll:0, view:"catalog", viewDecided:false, unread:null, entryUnread:null, resolving:"", feed:{state:"idle", items:[], total:0, error:""}}); }
async function pmLoadTopics(opts = {}) {
  const d = pmPage; if (!d) return; const st = pmTopicState(d);
  if (st.state === "loading") return;
  if (opts.material !== undefined) st.material = opts.material;
  st.state = "loading"; st.error = ""; renderPublicMemory();
  try {
    const res = await api(`${PM_API}/pipeline${st.material ? "?material=1" : ""}`);
    if (pmPage !== d) return;
    st.items = res.topics || []; st.scopes = res.scopes || []; st.status = res.status || null; st.state = "ready"; st.loadedAt = Date.now();
    st.unread = res.feedUnread?.count > 0 ? res.feedUnread : null;
    // 进入记忆页：有没读过的变动就默认落在「动态」，并筛成「仅看有变动」（可一键切回「全部」）。只在这次进入页面时决定一次；深链、已经手动切过视图的不动。
    if (!st.viewDecided) {
      st.viewDecided = true;
      if (st.unread && !st.deepLink && st.view === "catalog") {
        st.entryUnread = {count:st.unread.count, since:st.unread.since};
        st.view = "feed"; Object.assign(st.feed, {kind:"all", since:st.unread.since, state:"idle", items:[], daily:[], runs:[], total:0});
      }
    }
    if (!st.reviewLoaded) { st.reviewLoaded = true; void pmLoadReview(d); }
    if (st.deepLink) {
      // 深链要打开的那条：公共层里有就直接开；没有就带上素材层再读一次；还没有说明它已经不在了（被取代、过期或清理）
      if (st.items.some(t => t.id === st.deepLink)) { st.entry = st.deepLink; st.deepLink = ""; }
      else if (!st.material) { st.material = true; st.state = "idle"; }
      else { st.error = "这条记忆已经不在了（可能被取代、过期或已清理）"; st.deepLink = ""; }
    }
  } catch (e) { if (pmPage === d) { st.state = "error"; st.error = pmMessage(e); } }
  finally { if (pmPage === d) renderPublicMemory(); }
}
const pmTOrder = t => (pmIsGoal(t) ? 0 : 1);
function pmTopicsView(d) {
  const st = pmTopicState(d);
  const pub = st.items.filter(t => st.material || t.tier !== "material");
  const byScope = new Map(); for (const t of pub) { const k = pmTScope(t); byScope.set(k, (byScope.get(k) || 0) + 1); }
  const scopes = [...byScope.keys()].sort((a, b) => (a === "personal" ? -1 : b === "personal" ? 1 : byScope.get(b) - byScope.get(a) || a.localeCompare(b)));
  if (st.scope !== "all" && !byScope.has(st.scope)) st.scope = "all";
  const inScope = pub.filter(t => st.scope === "all" || pmTScope(t) === st.scope);
  const isProject = st.scope !== "all" && st.scope !== "personal";
  const subCounts = new Map(); for (const t of inScope) subCounts.set(t.sub, (subCounts.get(t.sub) || 0) + 1);
  const subOrder = PM_TSUB.personal;
  const showSubs = st.scope === "personal" && subCounts.size > 1;
  if (!showSubs) st.sub = "all";
  // 项目范围：按模块筛（模块数 >= 2 才有意义）+ 按模块分组
  const modCounts = new Map(); if (isProject) for (const t of inScope) { const k = pmTModule(t); modCounts.set(k, (modCounts.get(k) || 0) + 1); }
  const modOrder = [...pmModules(st).map(m => m.id).filter(id => id !== "cross" && modCounts.get(id)), ...(modCounts.get("cross") ? ["cross"] : [])].filter(k => modCounts.get(k));
  const showModules = isProject && modOrder.length > 1;
  if (!showModules || (st.module !== "all" && !modCounts.has(st.module))) st.module = "all";
  const inSub = inScope.filter(t => (isProject ? (st.module === "all" || pmTModule(t) === st.module) : (st.sub === "all" || t.sub === st.sub)));
  const tierCounts = new Map(); for (const t of inSub) if (!t.pending) tierCounts.set(t.tier, (tierCounts.get(t.tier) || 0) + 1);   // 待确认的不算常驻也不算按需（不会被会话读到）
  const constraintCounts = new Map(); for (const t of inSub) if (!t.pending) constraintCounts.set(pmConstraintLevel(t), (constraintCounts.get(pmConstraintLevel(t)) || 0) + 1);   // 同样不算待确认的
  const list = inSub.filter(t => st.layer === "all" || (t.tier === st.layer && !t.pending))
    .filter(t => st.constraint === "all" || (pmConstraintLevel(t) === st.constraint && !t.pending))
    .sort((a, b) => !!b.pending - !!a.pending || (a.tier === "material") - (b.tier === "material") || pmTOrder(a) - pmTOrder(b) || (a.tier === b.tier ? 0 : a.tier === "A" ? -1 : 1) || b.score - a.score || a.id.localeCompare(b.id));
  const matN = (st.status?.counts ? Object.values(st.status.counts.projects || {}).reduce((n, p) => n + (p.material || 0), 0) + (st.status.counts.personal?.material || 0) : 0);
  // 项目范围、模块选「全部」时按模块分组：按模块清单顺序，「待归类」收尾；每个模块里目标排最前
  const groups = st.scope === "personal" && st.sub === "all" ? subOrder.filter(k => subCounts.get(k)).map(k => ({key:k, label:k, items:list.filter(t => t.sub === k)})).filter(g => g.items.length) : isProject && st.module === "all" ? modOrder.map(k => ({key:k, label:k === "cross" ? "待归类" : pmModuleName(st, k), items:list.filter(t => pmTModule(t) === k)})).filter(g => g.items.length) : null;
  return {st, pub, scopes, byScope, inScope, inSub, tierCounts, constraintCounts, subCounts, subOrder, showSubs, isProject, modCounts, modOrder, showModules, groups, list, matN};
}
function pmTopicsRail(d) {
  const st = pmTopicState(d);
  if (st.state === "idle") { queueMicrotask(() => void pmLoadTopics()); }
  if (st.state !== "ready" && !st.items.length) return null;
  const v = pmTopicsView(d);
  const go = fn => () => { fn(); st.entry = null; renderPublicMemory(); };
  const chip = (label, n, on, fn, title) => h("button", {type:"button", class:`pm-chip ${on ? "active" : ""}`, "aria-pressed":String(on), title:title || label, onclick:go(fn)}, label, h("span", {class:"pm-chip-count"}, String(n)));
  return h("section", {class:"pm-filterbar pm-filter-lines pm-topic-rail", "aria-label":"筛选"},
    h("div", {class:"pm-filter-line", role:"group", "aria-label":"归属"},
      h("span", {class:"pm-filter-label"}, "归属"),
      chip("全部", v.pub.length, st.scope === "all", () => { st.scope = "all"; st.sub = "all"; st.module = "all"; }),
      ...v.scopes.map(k => chip(pmTScopeLabel(k), v.byScope.get(k), st.scope === k, () => { st.scope = k; st.sub = "all"; st.module = "all"; }, k === "personal" ? "跟人走、所有项目通用的偏好" : `项目「${pmTScopeLabel(k)}」的记忆`))),
    v.showModules ? h("div", {class:"pm-filter-line", role:"group", "aria-label":"模块"},
      h("span", {class:"pm-filter-label"}, "模块"),
      chip("全部", v.inScope.length, st.module === "all", () => { st.module = "all"; }, "不按模块筛，列表按模块分组"),
      ...v.modOrder.map(k => chip(k === "cross" ? "待归类" : pmModuleName(st, k), v.modCounts.get(k), st.module === k, () => { st.module = k; }, k === "cross" ? "还没归到任何模块的项目约定（跨模块）" : `「${pmModuleName(st, k)}」相关的记忆`))) : null,
    v.showSubs ? h("div", {class:"pm-filter-line", role:"group", "aria-label":"性质"},
      h("span", {class:"pm-filter-label"}, "性质"),
      chip("全部", v.inScope.length, st.sub === "all", () => { st.sub = "all"; }),
      ...v.subOrder.filter(sub => v.subCounts.get(sub)).map(sub => chip(sub, v.subCounts.get(sub), st.sub === sub, () => { st.sub = sub; }))) : null,
    h("div", {class:"pm-filter-line", role:"group", "aria-label":"消费方式"},
      h("span", {class:"pm-filter-label"}, "消费方式"),
      chip("全部", v.inSub.length, st.layer === "all", () => { st.layer = "all"; }),
      ...["A", "B"].map(k => chip(PM_TIER[k], v.tierCounts.get(k) || 0, st.layer === k, () => { st.layer = k; }, k === "A" ? "每个新会话开头都会带上" : "会话需要时自己去查"))),
    h("div", {class:"pm-filter-line", role:"group", "aria-label":"约束模式"},
      h("span", {class:"pm-filter-label"}, "约束模式"),
      chip("全部", v.inSub.length, st.constraint === "all", () => { st.constraint = "all"; }),
      ...Object.keys(PM_CONSTRAINT).map(k => chip(k === "uncertain" ? "待定" : PM_CONSTRAINT[k], v.constraintCounts.get(k) || 0, st.constraint === k, () => { st.constraint = k; }, PM_CONSTRAINT_TITLE[k]))));
}
function pmTopicRow(d, t) {
  const st = pmTopicState(d);
  return h("article", {class:"pm-entry-row pm-topic-row", "data-id":t.id},
    h("button", {type:"button", class:"pm-entry-main", "aria-label":`查看详情：${t.statement}`, onclick:() => { pmTopicState(d).entry = t.id; renderPublicMemory(); }},
      h("span", {class:"pm-topic-text"},
        h("span", {class:"pm-topic-title"},
          h("span", {class:"pm-topic-tags"},
            t.pending
              ? h("span", {class:"pm-topic-tier tier-conflict", title:"和已有的相反，等你确认；确认前不会被会话读到"}, "待确认")
              : h("span", {class:`pm-topic-tier tier-${t.tier}`, title:t.tier === "A" ? "每个新会话开头都会带上" : t.tier === "B" ? "会话需要时自己去查" : "素材层：还不够重要，不会被会话读到"}, PM_TIER[t.tier] || t.tier),
            pmConstraintTag(t, true)),
          t.statement),
        h("span", {class:"pm-topic-meta"}, pmTKindLabel(st, t), " · ", `${t.signals.sessions} 个会话 · 最近 ${pmDay(t.signals.lastAt)}`)),
      h("span", {class:"pm-chevron", "aria-hidden":"true"})));
}
function pmTopicsBody(d) {
  const st = pmTopicState(d);
  if (st.state === "error") return [h("p", {role:"alert", class:"warn-text"}, `读取失败：${st.error} `, h("button", {type:"button", class:"btn small", onclick:() => { st.state = "idle"; void pmLoadTopics(); }}, "重试"))];
  if (st.state !== "ready" && !st.items.length) return [h("p", {class:"muted"}, "正在读取…")];
  const v = pmTopicsView(d), s = st.status, last = s?.lastRun;
  const out = [];
  if (last?.error) out.push(h("p", {role:"alert", class:"pi-memory-notice warn-text"}, `上次运行失败：${last.error}`));
  const nConflict = st.items.filter(t => t.pending).length;
  out.push(pmReviewPanel(d));
  if (st.scopes.length) out.push(h("section", {class:"pm-feed-pending", "aria-label":"归属待判定"}, h("h2", {class:"pm-feed-day"}, `归属待你判定（${st.scopes.length}）`), ...st.scopes.map(o => pmScopeCard(d, o))));
  if (nConflict) out.push(h("div", {class:"pm-conflict-banner", role:"status"}, h("span", {}, `有 ${nConflict} 条新说法和已有的相反，等你确认`), h("button", {type:"button", class:"btn small", onclick:() => { st.view = "feed"; st.entry = null; renderPublicMemory(); }}, "去处理")));
  const filtered = st.scope !== "all" || st.layer !== "all" || st.constraint !== "all" || st.sub !== "all" || st.module !== "all";
  out.push(h("details", {class:"pm-topic-more", open:st.more, ontoggle:e => { st.more = e.target.open; }},
    h("summary", {}, h("span", {class:"pm-topic-count"}, `${v.list.length} 条${filtered ? "（已筛选）" : ""}`), h("span", {class:"pm-topic-more-label"}, "更多筛选")),
    h("div", {class:"pm-topic-more-body"},
      h("label", {class:"pm-topic-matswitch"}, h("input", {type:"checkbox", checked:st.material, onchange:e => { void pmLoadTopics({material:e.target.checked}); }}), ` 同时显示素材层（${v.matN} 条，还不够重要，不会被会话读到）`))));
  out.push(h("div", {class:"pm-topic-list", role:"list", "aria-label":"公共记忆条目"},
    ...(v.groups ? v.groups.flatMap(g => [
      h("h3", {class:"pm-topic-group-head", role:"presentation"}, h("span", {}, g.label), h("span", {class:"pm-topic-group-count"}, `${g.items.length} 条`), pmReviewButton(d, v.isProject ? {domain:"project", project:pmTScopeLabel(st.scope), module:g.key} : {domain:"personal", project:null, sub:g.key}, g.label)),
      ...g.items.map(t => pmTopicRow(d, t))
    ]) : v.list.map(t => pmTopicRow(d, t))),
    !v.list.length ? h("p", {class:"pm-empty"}, "没有符合筛选的主题") : null));
  if (!v.groups && st.scope !== "all") {
    const scope = v.isProject ? {domain:"project", project:pmTScopeLabel(st.scope), module:st.module !== "all" ? st.module : v.modOrder[0]} : {domain:"personal", project:null, sub:st.sub !== "all" ? st.sub : [...v.subCounts.keys()][0]};
    if (scope.module || scope.sub) out.splice(1, 0, h("div", {class:"pm-review-entry"}, h("span", {class:"muted small"}, `${pmReviewLabel(st, scope)} · 全部常驻与按需记忆`), pmReviewButton(d, scope, "当前分类")));
  }
  return out;
}
const pmReviewLabel = (st, scope) => scope.domain === "personal" ? `个人偏好 · ${scope.sub}` : `${scope.project} · ${scope.module === "cross" ? "待归类" : pmModuleName(st, scope.module)}`;
function pmReviewButton(d, scope, label) {
  const st = pmTopicState(d);
  return h("button", {type:"button", class:"btn small ghost pm-review-button", disabled:st.reviewBusy || st.review?.phase === "running" || st.status?.running, "aria-label":`${label}：合并/简化与冲突检测`, onclick:() => void pmStartReview(d, scope)}, "整理", pmIcon("refresh"));
}
async function pmLoadReview(d) {
  const st = pmTopicState(d); clearTimeout(st.reviewPoll);
  try {
    const r = await api(`${PM_API}/pipeline/review`);
    if (pmPage !== d) return;
    if (!st.reviewBusy) { st.review = r.review; st.status = {...(st.status || {}), running:!!r.running}; }
    st.reviewError = "";
  } catch (e) { if (pmPage === d) st.reviewError = pmMessage(e); }
  if (pmPage !== d) return;
  renderPublicMemory();
  if (st.review?.phase === "running") st.reviewPoll = setTimeout(() => { if (pmPage === d) void pmLoadReview(d); }, 1500);
}
async function pmStartReview(d, scope) {
  const st = pmTopicState(d); if (st.reviewBusy || st.review?.phase === "running") return;
  st.reviewBusy = true; st.reviewError = ""; renderPublicMemory();
  try {
    const r = await api(`${PM_API}/pipeline/review`, {method:"POST", body:JSON.stringify(scope)});
    if (pmPage !== d) return;
    st.review = r.review;
  } catch (e) { if (pmPage === d) st.reviewError = pmMessage(e); }
  finally { if (pmPage === d) { st.reviewBusy = false; renderPublicMemory(); if (st.review) { const content = d.root.querySelector(".pi-memory-content"); if (content) content.scrollTop = 0; } if (st.review?.phase === "running") void pmLoadReview(d); } }
}
/** 预览里勾选的整理项：含人工固定条目的默认不选；同一次预览（id 不变）内保留用户的勾选。 */
function pmReviewSel(st) {
  const r = st.review;
  if (!st.reviewSel || st.reviewSel.id !== r?.id) st.reviewSel = {id:r?.id, set:new Set((r?.result?.units || []).filter(u => !u.pinned).map(u => u.id))};
  return st.reviewSel.set;
}
async function pmApplyReview(d) {
  const st = pmTopicState(d); if (st.reviewBusy || st.review?.phase !== "ready" || !pmReviewSel(st).size) return;
  st.reviewBusy = true; st.reviewError = ""; renderPublicMemory();
  try {
    const r = await api(`${PM_API}/pipeline/review/apply`, {method:"POST", body:JSON.stringify({id:st.review.id, unitIds:[...pmReviewSel(st)]})});
    if (pmPage !== d) return;
    st.review = r.review; st.feed.state = "idle"; st.entry = null;
    await pmLoadTopics();
  } catch (e) { if (pmPage === d) st.reviewError = pmMessage(e); }
  finally { if (pmPage === d) { st.reviewBusy = false; renderPublicMemory(); } }
}
/** 勾选只就地更新计数与按钮，不重绘面板：展开着的「原文」和滚动位置不被打断。 */
function pmReviewToggle(box, sel, u) {
  if (box.checked) sel.add(u.id); else sel.delete(u.id);
  box.closest(".pm-review-unit")?.classList.toggle("is-off", !box.checked);
  const panel = box.closest(".pm-review-panel"), total = panel?.querySelectorAll(".pm-review-unit").length ?? 0;
  const count = panel?.querySelector(".pm-review-count"), apply = panel?.querySelector(".pm-review-apply");
  if (count) count.textContent = `已选 ${sel.size} / ${total} 项`;
  if (apply) { apply.textContent = `确认应用（${sel.size} 项）`; apply.disabled = !sel.size; }
}
const PM_UNIT_TAG = {merge:u => `合并 ${u.topicIds.length} 条`, simplify:() => "精简", conflict:() => "冲突待裁决"};
function pmReviewUnit(d, u, sel) {
  const st = pmTopicState(d), on = sel.has(u.id), conflict = u.kind === "conflict";
  const title = conflict ? `冲突待裁决 · ${u.topic}` : u.topic;
  return h("li", {class:`pm-review-unit${on ? "" : " is-off"}`},
    h("input", {type:"checkbox", checked:on, disabled:st.reviewBusy, "aria-label":`应用「${title}」`, onchange:e => pmReviewToggle(e.target, sel, u)}),
    h("div", {},
      h("div", {class:"pm-review-unit-head"},
        h("span", {class:"pm-review-unit-title"}, title),
        conflict ? null : h("span", {class:"pm-review-tag"}, PM_UNIT_TAG[u.kind](u)),
        u.pinned ? h("span", {class:"pm-review-tag pin"}, "含固定条目 · 默认不应用") : null),
      h("p", {class:"pm-review-after"}, conflict ? "待确认：" : "", u.after),
      conflict ? h("p", {class:"pm-feed-before"}, "相冲突的记忆：", u.conflictWith) : h("details", {},
        h("summary", {}, u.before.length > 1 ? `原文 ${u.before.length} 条` : "原文"),
        ...u.before.map(text => h("p", {class:"pm-feed-before"}, text)))));
}
function pmReviewPanel(d) {
  const st = pmTopicState(d), r = st.review, result = r?.result;
  if (!r && !st.reviewError) return null;
  const ready = r?.phase === "ready" && result, sel = ready ? pmReviewSel(st) : null;
  return h("section", {class:"pm-review-panel", "aria-label":"分类记忆整理"},
    h("div", {class:"pm-review-heading"}, h("div", {}, h("h2", {}, "合并、简化与冲突检测"), h("p", {class:"muted small"}, r ? pmReviewLabel(st, r.scope) : "当前子分类")),
      r?.phase !== "running" ? h("button", {type:"button", class:"btn small ghost", "aria-label":"收起整理结果", disabled:st.reviewBusy, onclick:() => { st.review = null; st.reviewError = ""; renderPublicMemory(); }}, "收起") : null),
    h("div", {class:"pm-review-status", role:"status", "aria-live":"polite"},
      r?.phase === "running" ? h("p", {}, "正在检查当前分类的记忆，完成后显示整理建议…") : null,
      r?.phase === "error" ? h("p", {class:"warn-text"}, `检查失败：${r.error}`) : null,
      result ? h("p", {}, `检查 ${result.total} 条 · 归并为 ${result.merged} 组 · 精简 ${result.simplified} 条 · 冲突 ${result.conflicts} 处`) : null,
      h("p", {class:"muted small"}, r?.phase === "applied" ? `已应用 ${r.applied ?? 0} 项整理结果。冲突请在「动态」中逐条裁决。` : "同一原则的不同侧面合成一条，每条不超过 60 字、不写技术细节。原话与来源保留，确认后才生效。"),
      ready && result.pinned ? h("p", {class:"muted small"}, `含 ${result.pinned} 项人工固定：默认不勾选，需要时手动勾上。`) : null,
      result?.skipped ? h("p", {class:"muted small"}, `${result.skipped} 条为导入或已有冲突，保留不动。`) : null,
      result?.limited || result?.failures ? h("p", {class:"warn-text small"}, `本次检查未全部完成${result.failures ? "（模型返回不合规）" : "（已达单次上限）"}，可重新检查。`) : null),
    ready && result.units.length ? h("ul", {class:"pm-review-units"}, result.units.map(u => pmReviewUnit(d, u, sel))) : null,
    st.reviewError ? h("p", {role:"alert", class:"warn-text"}, st.reviewError) : null,
    r && r.phase !== "running" ? h("footer", {class:"pm-review-actions"},
      ready && result.units.length ? h("span", {class:"muted small pm-review-count"}, `已选 ${sel.size} / ${result.units.length} 项`) : null,
      h("button", {type:"button", class:"btn small", disabled:st.reviewBusy, onclick:() => void pmStartReview(d, r.scope)}, "重新检查"),
      ready && result.units.length ? h("button", {type:"button", class:"btn primary small pm-review-apply", disabled:st.reviewBusy || !sel.size, onclick:() => void pmApplyReview(d)}, st.reviewBusy ? "正在应用…" : `确认应用（${sel.size} 项）`) : null,
      ready && !result.units.length ? h("span", {class:"muted small"}, (result.failures || result.limited) ? "检查未完成，请重试" : "未发现需要调整的内容") : null) : null);
}
const pmTopicsEntry = d => { const st = pmTopicState(d); return st.entry ? st.items.find(t => t.id === st.entry) || null : null; };
function pmTopicDrawer(d, t) {
  const st = pmTopicState(d);
  const dialog = h("dialog", {class:"resource-drawer pm-drawer", "aria-label":"记忆详情", onclose:() => { if (st.entry === t.id) { st.entry = null; renderPublicMemory(); } }});   // 只处理自己：上一个抽屉的 close 事件可能晚到，那时新的已经打开，不能把它一起关掉
  dialog.addEventListener("click", e => { if (e.target === dialog) dialog.close(); });
  const sig = t.signals, parts = [];
  if (sig.explicit) parts.push(["你明确说过（常设性措辞）", `+3（${sig.explicit} 次）`]);
  if (sig.remembered) parts.push(["你明说了「记住」", "至少按需（下限 4 分）"]);
  if (sig.redLine) parts.push(["做错代价大", "+2"]);
  if (sig.crossFeature) parts.push(["换个功能也成立", "+1"]);
  if (sig.sessions > 1) parts.push([`在 ${sig.sessions} 个会话里出现`, `+${Math.min(sig.sessions - 1, 3)}`]);
  dialog.append(h("div", {class:"pm-detail"},
    h("header", {class:"pm-detail-head"},
      h("button", {type:"button", class:"pm-back", onclick:() => dialog.close(), "aria-label":"关闭"}, "‹ 关闭"),
      h("span", {class:"pm-breadcrumb"}, "平台记忆 · 记忆详情"),
      h("span", {class:"pm-detail-head-note"}, t.pending ? "冲突待确认" : `${PM_TIER[t.tier] || t.tier} · ${t.score} 分`)),
    h("div", {class:"pm-detail-body"},
      h("div", {class:"pm-detail-main"},
        h("h2", {class:"pm-detail-title"}, t.statement),
        h("div", {class:"pm-detail-chips"},
          h("span", {class:"pi-memory-path pm-scope"}, pmTScopeLabel(pmTScope(t))),
          t.domain === "personal" ? h("span", {class:"pi-memory-path pm-kind"}, t.sub || "流程") : h("span", {class:"pi-memory-path pm-module"}, pmTModuleLabel(st, t)),
          t.pending ? h("span", {class:"pm-topic-tier tier-conflict"}, "待确认") : h("span", {class:`pm-topic-tier tier-${t.tier}`}, PM_TIER[t.tier] || t.tier),
          pmConstraintTag(t, true),
          pmScopeEditorIcon(d, t),
          pmRemoveIcon(d, t)),
        pmScopeEditor(d, t),
        pmRemoveCard(d, t),
        pmConstraintCard(d, t),
        t.pending ? pmConflictCard(d, t, dialog) : null,
        t.pending ? null
          : h("section", {class:"pm-topic-why", "aria-label":"为什么在这里"},
              h("h3", {}, "为什么是「" + (PM_TIER[t.tier] || t.tier) + "」"),
              ...parts.map(([k, v]) => h("div", {class:"pm-topic-why-row"}, h("span", {}, k), h("span", {class:"pm-topic-why-v"}, v))),
              h("p", {class:"muted small"}, t.override?.tier ? `消费方式由你指定为${PM_TIER[t.tier]}，不随评分自动调整。` : `合计 ${t.score} 分：≥ 6 常驻，≥ 4 按需，低于 4 只留在素材层。`),
              pmIsGoal(t) && t.tier === "A" ? h("p", {class:"muted small"}, "目标：每个新会话都带上它，拿来判断新需求是否符合大方向；这里不记进展——进展以 git 为准，当前状态以代码为准。") : null),
        h("section", {class:"pm-topic-evidence", "aria-label":"依据"},
          h("h3", {}, `依据（${t.evidence.length}${t.memberIds?.length > t.evidence.length ? ` / ${t.memberIds.length}` : ""}）`),
          ...t.evidence.map(e => h("div", {class:"pm-topic-ev"},
            h("p", {class:"pm-topic-quote"}, e.quote),
            h("p", {class:"muted small"}, pmDay(e.at), " · ", h("a", {href:`#/rt/${e.sessionId}`, class:"pm-topic-sess", onclick:() => dialog.close()}, `会话 ${e.sessionId.replace(/^rt-/, "").slice(0, 8)}`), e.explicit ? " · 明确指令" : "")))),
        t.history?.length ? h("section", {class:"pm-topic-history", "aria-label":"演变"},
          h("h3", {}, "表述的演变（旧→新）"),
          ...t.history.map(x => h("p", {class:"muted small"}, `${pmDay(x.at)}　${x.statement}`))) : null,
        h("p", {class:"muted small"}, "除了裁决冲突、改归类和删除，这里只读：想改内容，说一声让我改。"))),
    h("footer", {class:"pm-detail-foot"},
      h("button", {type:"button", class:"btn primary pm-ask", onclick:() => pmAsk(d, t, dialog)}, "问询这条记忆"),
      h("span", {class:"muted small"}, "带着它的背景新建会话，接着问"))));
  return dialog;
}
/* ===== 动态：记忆的变更日志（按时间倒序） ===== */
const PM_KIND = {added:"新增", merged:"合并", updated:"更新", superseded:"取代", conflict:"冲突待确认", resolved:"已裁决", promoted:"升级", demoted:"降级", removed:"移除"};
const PM_TRIGGER = {instant:"实时 · 你说了「记住」", schedule:"每晚梳理", manual:"手动运行", human:"你的裁决"};
const PM_SOURCE = {schedule:"每晚梳理", manual:"手动运行", instant:"实时", human:"你的裁决"};
const pmKindLabel = c => (c.kind === "promoted" || c.kind === "demoted" ? `${PM_KIND[c.kind]}为${PM_TIER[c.tier] || c.tier}` : PM_KIND[c.kind] || c.kind);
const pmChangeScope = c => (c.domain === "personal" ? "个人偏好" : c.project || "项目");
function pmFeedFilters(d) {
  const f = pmTopicState(d).feed;
  const change = (key, value) => {
    f[key] = value;
    f.request = (f.request || 0) + 1; f.items = []; f.daily = []; f.runs = []; f.total = 0; f.state = "idle";
    renderPublicMemory();
  };
  const chip = (label, key, value) => h("button", {type:"button", class:`pm-chip ${(f[key] || "all") === value ? "active" : ""}`, "aria-pressed":String((f[key] || "all") === value), onclick:() => change(key, value)}, label);
  const eu = pmTopicState(d).entryUnread;
  const onlyNew = !!f.since;
  const scope = (label, active, patch) => h("button", {type:"button", class:`pm-chip ${active ? "active" : ""}`, "aria-pressed":String(active), onclick:() => { Object.assign(f, patch); f.period = "all"; f.from = ""; f.to = ""; f.source = "all"; f.kind = "all"; f.request = (f.request || 0) + 1; f.items = []; f.daily = []; f.runs = []; f.total = 0; f.state = "idle"; renderPublicMemory(); }}, label);
  return h("section", {class:"pm-filterbar pm-filter-lines pm-feed-filters", "aria-label":"动态筛选"},
    eu ? h("div", {class:"pm-filter-line", role:"group", "aria-label":"范围"}, h("span", {class:"pm-filter-label"}, "范围"),
      scope("全部", !onlyNew, {since:""}), scope(`仅看有变动 ${onlyNew && f.state === "ready" ? f.total : eu.count}`, onlyNew, {since:eu.since})) : null,
    h("div", {class:"pm-filter-line", role:"group", "aria-label":"时间范围"}, h("span", {class:"pm-filter-label"}, "时间"),
      ...[["all","全部"],["today","今天"],["7","近7天"],["30","近30天"],["custom","自选日期"]].map(([value,label]) => chip(label, "period", value))),
    f.period === "custom" ? h("div", {class:"pm-feed-dates"},
      ...[["from","开始日期"],["to","结束日期"]].map(([key,label]) => h("label", {}, h("span", {class:"pm-feed-date-label"}, label), h("input", {type:"date", value:f[key] || "", "aria-label":label, title:`${label}（北京时间）`, onchange:e => change(key, e.target.value)}))),
      h("span", {class:"muted small pm-feed-date-hint"}, "北京时间，含首尾两天")) : null,
    h("div", {class:"pm-filter-line", role:"group", "aria-label":"操作类型"}, h("span", {class:"pm-filter-label"}, "操作"), chip("全部", "kind", "all"), ...Object.entries(PM_KIND).map(([value,label]) => chip(label, "kind", value))),
    h("div", {class:"pm-filter-line", role:"group", "aria-label":"来源"}, h("span", {class:"pm-filter-label"}, "来源"), chip("全部", "source", "all"), ...Object.entries(PM_SOURCE).map(([value,label]) => chip(label, "source", value))));
}
function pmFeedQuery(f) {
  const q = new URLSearchParams();
  if (f.kind && f.kind !== "all") q.set("kind", f.kind);
  if (f.since) { q.set("since", f.since); q.set("excludeSource", "human"); }   // 未读不计你自己的裁决
  if (f.source && f.source !== "all") q.set("source", f.source);
  if (f.period === "custom") { if (f.from) q.set("from", f.from); if (f.to) q.set("to", f.to); }
  else if (f.period && f.period !== "all") {
    const now = Date.now() + 8 * 3600000, day = t => new Date(t).toISOString().slice(0, 10);
    q.set("from", day(now - ((f.period === "today" ? 1 : Number(f.period)) - 1) * 86400000)); q.set("to", day(now));
  }
  return q.size ? `&${q}` : "";
}
async function pmLoadFeed(more = false) {
  const d = pmPage; if (!d) return; const f = pmTopicState(d).feed;
  if (f.state === "loading") return;
  const request = f.request = (f.request || 0) + 1;
  f.state = "loading"; f.error = ""; renderPublicMemory();
  try {
    const before = more && f.items.length ? `&before=${encodeURIComponent(f.items[f.items.length - 1].id)}` : "";
    const res = await api(`${PM_API}/pipeline/changes?limit=30${before}${pmFeedQuery(f)}`);
    if (pmPage !== d || f.request !== request) return;
    f.items = more ? [...f.items, ...(res.changes || [])] : (res.changes || []); f.daily = res.daily || []; f.runs = res.runs || []; f.total = res.total || 0; f.state = "ready"; f.loadedAt = Date.now();
    void pmMarkFeedSeen(d);
  } catch (e) { if (pmPage === d && f.request === request) { f.state = "error"; f.error = pmMessage(e); } }
  finally { if (pmPage === d && f.request === request) renderPublicMemory(); }
}
/** 看过「动态」就标已读：徽标立刻消失，已读到最新那条新增（服务端记，多端共用）。失败不打扰，下次进来还会提示。 */
async function pmMarkFeedSeen(d) {
  const st = pmTopicState(d), u = st.unread;
  if (!u || st.view !== "feed") return;
  st.unread = null; renderPublicMemory();
  try { await api(`${PM_API}/pipeline/feed-seen`, {method:"POST", body:JSON.stringify({upTo:u.latestAt})}); }
  catch { if (pmPage === d && !st.unread) { st.unread = u; renderPublicMemory(); } }
}
/** 裁决一条冲突：采用新的（取代旧的）/ 保留旧的。成功后列表和动态都重新读。 */
async function pmResolve(d, id, choice, dialog) {
  const st = pmTopicState(d); if (st.resolving) return;
  st.resolving = id; st.error = ""; renderPublicMemory();
  try { await api(`${PM_API}/pipeline/topics/${encodeURIComponent(id)}/resolve`, {method:"POST", body:JSON.stringify({choice})}); st.entry = null; st.state = "idle"; st.feed.state = "idle"; dialog?.close?.(); }
  catch (e) { st.error = pmMessage(e); }
  st.resolving = ""; renderPublicMemory();
}
/** 人判定一条归属：选归属（个人偏好 / 项目）→ 选性质 / 模块 → 确定。成功后这条不再待判定，列表重读。 */
async function pmResolveScope(d, o) {
  const st = pmTopicState(d), draft = st.scopeDraft;
  if (!draft || draft.id !== o.id || !draft.domain) return;
  if (draft.domain === "personal" ? !draft.sub : (!draft.project || !draft.module)) return;
  st.resolving = o.id; st.error = ""; renderPublicMemory();
  try {
    await api(`${PM_API}/pipeline/scopes/${encodeURIComponent(o.id)}/resolve`, {method:"POST", body:JSON.stringify({domain:draft.domain, project:draft.domain === "project" ? draft.project : null, sub:draft.domain === "personal" ? draft.sub : null, module:draft.domain === "project" ? draft.module : null})});
    st.scopes = st.scopes.filter(x => x.id !== o.id);
    st.scopeDraft = null; st.state = "idle"; st.feed.state = "idle";
  } catch (e) { st.error = pmMessage(e); }
  st.resolving = ""; renderPublicMemory();
}
/**
 * 改归类：给一条已生效的记忆换归属 / 子类。人改过之后写 override.scope，流水线不再按成员多数票改回去；
 * 换到一个已有同名同子类的条目就并过去（服务端处理），列表与动态都重读。
 */
async function pmRescopeTopic(d, t) {
  const st = pmTopicState(d), r = st.rescope;
  if (!r || r.id !== t.id) return;
  if (r.domain === "personal" ? !r.sub : (!r.project || !r.module)) return;
  st.resolving = t.id; st.error = ""; renderPublicMemory();
  try {
    // 先改归类 / 消费方式（可能并入别的条目，所以约束要落在返回的编号上），再改约束类型；两者哪个没变就不调
    let topicId = t.id;
    if (pmScopeChanged(r, t)) {
      const res = await api(`${PM_API}/pipeline/topics/${encodeURIComponent(t.id)}/scope`, {method:"POST", body:JSON.stringify({tier:r.tier, domain:r.domain, project:r.domain === "project" ? r.project : null, sub:r.domain === "personal" ? r.sub : null, module:r.domain === "project" ? r.module : null})});
      topicId = res?.topicId || t.id;
    }
    if (pmConstraintChanged(r, t)) await pmPostConstraint(topicId, r.constraint, r.constraint === "hard" ? r.draft?.draft : null);
    st.rescope = null; st.state = "idle"; st.feed.state = "idle";
  } catch (e) { st.error = pmMessage(e); }
  st.resolving = ""; renderPublicMemory();
}
const pmScopeChanged = (r, t) => r.tier !== t.tier || r.domain !== t.domain
  || (r.domain === "personal" ? r.sub !== (t.sub || "流程") : ((r.project || "") !== (t.project || "") || (r.module || "cross") !== (t.module || "cross")));
/** 约束类型是否有改动：待定在编辑里按软约束显示，所以待定 → 软约束要走「约束待定」卡片（或在这里选强约束）。 */
const pmEditLevel = t => { const lv = pmConstraintLevel(t); return lv === "hard" || lv === "needs-rule" ? lv : "soft"; };
const pmConstraintChanged = (r, t) => r.constraint !== pmEditLevel(t) || (r.constraint === "hard" && r.draft?.state === "ready");
/** 设强约束要带上确认过的规则（rule = DeepSeek 写好、人看过的四要素），没有规则服务端会拒绝。 */
const pmPostConstraint = (topicId, level, rule) => api(`${PM_API}/pipeline/topics/${encodeURIComponent(topicId)}/constraint`, {method:"POST", body:JSON.stringify({level, rule:rule || null})});
/**
 * 先生成规则，再确认：切到强约束后点「生成校验规则」，DeepSeek 开推理写四要素（后台跑，1～2 分钟，这里轮询）；
 * 写好后展示给人看，点确认才把记忆标成强约束并绑定这条规则。草稿在 st.rescope.draft：{state: running | ready | error, draft, error, infeasible}。
 */
const PM_DRAFT_POLL_MS = [600, 2000];
const pmDraftUrl = t => `${PM_API}/pipeline/topics/${encodeURIComponent(t.id)}/constraint/draft`;
function pmSetDraft(d, t, draft) {
  const st = pmTopicState(d);
  if (st.rescope?.id !== t.id) return;
  st.rescope = {...st.rescope, draft}; renderPublicMemory();
}
async function pmStartDraft(d, t) {
  const st = pmTopicState(d), r = st.rescope;
  if (!r || r.id !== t.id) return;
  st.rescope = {...r, constraint:"hard", draftChecked:true, draft:{state:"running"}}; st.error = ""; renderPublicMemory();
  try { await api(pmDraftUrl(t), {method:"POST", body:"{}"}); } catch (e) { pmSetDraft(d, t, {state:"error", error:pmMessage(e)}); return; }
  void pmPollDraft(d, t);
}
/** 轮询草稿任务直到结束；st.draftTok 保证同一时刻只有一个轮询在跑（重新生成 / 接上之前的任务都会换新令牌）。 */
async function pmPollDraft(d, t) {
  const st = pmTopicState(d), tok = (st.draftTok = {});
  for (let i = 0; ; i++) {
    await new Promise(res => setTimeout(res, PM_DRAFT_POLL_MS[Math.min(i, PM_DRAFT_POLL_MS.length - 1)]));
    if (pmPage !== d || st.draftTok !== tok || st.rescope?.id !== t.id || st.rescope.draft?.state !== "running") return;   // 关了面板 / 换了页 / 又点了重新生成
    let job; try { job = (await api(pmDraftUrl(t))).job; } catch (e) { pmSetDraft(d, t, {state:"error", error:pmMessage(e)}); return; }
    if (!job) { pmSetDraft(d, t, {state:"error", error:"生成任务不见了，请重新生成"}); return; }
    if (job.state === "ready") { pmSetDraft(d, t, {state:"ready", draft:job.draft, at:job.finishedAt}); return; }
    if (job.state === "error") { pmSetDraft(d, t, {state:"error", error:job.error || "没有写成", infeasible:!!job.infeasible, at:job.finishedAt}); return; }
  }
}
/**
 * 打开铅笔、切到强约束时先问服务端：这条记忆有没有进行中或已写好的规则草稿（草稿在服务端落盘，退出界面 / 服务重启都还在）。
 * 进行中 → 接着显示「生成中」继续等；已写好 → 直接展示并标「上次生成的」，仍可重新生成；没有 → 保持原样（autoStart 时直接开始生成）。
 */
async function pmResumeDraft(d, t, autoStart) {
  const st = pmTopicState(d), r = st.rescope;
  if (!r || r.id !== t.id || r.draftChecked) return;
  st.rescope = {...r, draftChecked:true, draft:{state:"checking"}}; renderPublicMemory();
  let job = null; try { job = (await api(pmDraftUrl(t))).job; } catch { /* 查不到就当没有 */ }
  const now = pmTopicState(d).rescope;
  if (pmPage !== d || now?.id !== t.id || now.draft?.state !== "checking") return;   // 期间关了面板，或用户已经点了生成
  if (!job || (autoStart && job.state === "error" && !job.infeasible)) { pmSetDraft(d, t, null); if (autoStart) void pmStartDraft(d, t); return; }
  if (job.state === "running") { pmSetDraft(d, t, {state:"running", at:job.startedAt, restored:true}); void pmPollDraft(d, t); return; }
  pmSetDraft(d, t, job.state === "ready" ? {state:"ready", draft:job.draft, at:job.finishedAt, restored:true} : {state:"error", error:job.error || "没有写成", infeasible:!!job.infeasible, at:job.finishedAt, restored:true});
}
/** 待定卡片的「设为强约束」：打开铅笔面板、选强约束；有之前的草稿就接着用，没有才开始生成。 */
function pmOpenHardEditor(d, t) {
  const st = pmTopicState(d);
  st.rescope = {id:t.id, tier:t.tier, constraint:"hard", draft:null, domain:t.domain, project:t.project || "", sub:t.domain === "personal" ? t.sub : "", module:t.domain === "project" ? (t.module || "cross") : ""};
  st.error = ""; renderPublicMemory(); void pmResumeDraft(d, t, true);
}
/** 铅笔面板里「强约束」下面的规则区：没有规则先生成；生成中；写好了看四要素；写不成说原因。 */
function pmRuleDraftBlock(d, t, r, busy) {
  const st = pmTopicState(d), draft = r.draft, cur = t.constraint?.level === "hard" ? pmRuleOf(st, t) : null;
  const regen = label => h("button", {type:"button", class:"btn small ghost", disabled:busy, onclick:() => void pmStartDraft(d, t)}, label);
  const when = d0 => d0?.restored && d0.at ? h("p", {class:"muted small pm-rule-draft-when"}, `上次生成的 · ${pmDayTime(d0.at)}`) : null;
  if (draft?.state === "checking") return h("div", {class:"pm-rule-draft", role:"status", "aria-live":"polite"},
    h("p", {class:"muted small"}, "正在查看有没有之前生成的规则…"));
  if (draft?.state === "running") return h("div", {class:"pm-rule-draft", role:"status", "aria-live":"polite"},
    h("p", {class:"pm-rule-draft-status"}, h("span", {class:"pm-rule-draft-dot", "aria-hidden":"true"}), draft.restored ? `接着之前的生成（${pmDayTime(draft.at)} 开始），通常要 1～2 分钟` : "DeepSeek 正在开推理写校验规则，通常要 1～2 分钟"),
    h("p", {class:"muted small"}, "写好后会在这里展示四要素，你确认后才会标成强约束。"));
  if (draft?.state === "error") return h("div", {class:"pm-rule-draft"}, when(draft),
    h("p", {role:"alert", class:"warn-text"}, draft.infeasible ? `没写成规则：${draft.error}` : `生成失败：${draft.error}`),
    draft.infeasible ? h("p", {class:"muted small"}, "这条要求没法在回合结束时事后检查，不能成为强约束；可以选「待补规则」或「软约束」。") : null,
    h("div", {class:"pm-rule-draft-actions"}, regen("重新生成")));
  if (draft?.state === "ready") return h("div", {class:"pm-rule-draft"}, when(draft),
    h("p", {class:"pm-rule-draft-title"}, h("b", {}, draft.draft.title)),
    pmRuleSpec(pmWithNode(draft.draft)),
    h("p", {class:"muted small"}, draft.draft.ruleId ? "这条要求检查的正是平台已有的一条代码规则，会用代码判定。" : "这是 DeepSeek 写的规则草稿：确认后才绑定到这条记忆并标成强约束，每轮结束由判定模型按这四条核对。"),
    h("div", {class:"pm-rule-draft-actions"}, regen("重新生成")));
  if (cur) return h("div", {class:"pm-rule-draft"},
    h("p", {class:"pm-rule-draft-title"}, h("b", {}, cur.title)), pmRuleSpec(cur),
    h("div", {class:"pm-rule-draft-actions"}, regen("重新生成规则")));
  return h("div", {class:"pm-rule-draft"},
    h("p", {class:"muted small"}, "强约束必须先有校验规则：先让 DeepSeek 开推理写好四要素（校验节点、校验对象范围、校验规则、结果反馈），你确认后才会标成强约束。"),
    h("div", {class:"pm-rule-draft-actions"}, h("button", {type:"button", class:"btn small primary", disabled:busy, onclick:() => void pmStartDraft(d, t)}, "生成校验规则")));
}
/** 约束待定卡片：判定模型拿不准时交给人，一键定强 / 软约束；强约束的检测规则可以之后在铅笔面板里挑。 */
async function pmDecideConstraint(d, t, level) {
  const st = pmTopicState(d);
  st.resolving = t.id; st.error = ""; renderPublicMemory();
  try { await pmPostConstraint(t.id, level, null); st.state = "idle"; st.feed.state = "idle"; }
  catch (e) { st.error = pmMessage(e); }
  st.resolving = ""; renderPublicMemory();
}
function pmConstraintCard(d, t) {
  if (t.pending) return null;
  const st = pmTopicState(d), c = t.constraint, lv = pmConstraintLevel(t), busy = st.resolving === t.id;
  const stat = st.enforce?.[t.id];
  if (lv === "hard" && st.enforce === undefined) { st.enforce = null; void pmLoadEnforcement(d); }
  if (lv === "uncertain") return h("section", {class:"pm-conflict-card pm-constraint-card", "aria-label":"判定约束类型", "data-id":t.id},
    h("p", {class:"pm-conflict-lead"}, "这条要不要强约束？判定模型拿不准。你决定之前，它按软约束处理。设为强约束要先让 DeepSeek 开推理写好校验规则，你确认后才生效。"),
    c?.reason ? h("p", {class:"muted small"}, `拿不准的原因：${c.reason}`) : null,
    st.error ? h("p", {role:"alert", class:"warn-text"}, st.error) : null,
    h("div", {class:"pm-conflict-actions"},
      h("button", {type:"button", class:"btn small primary", disabled:busy, onclick:() => pmOpenHardEditor(d, t)}, "设为强约束 · 先生成规则"),
      h("button", {type:"button", class:"btn small", disabled:busy, onclick:() => void pmDecideConstraint(d, t, "soft")}, busy ? "保存中…" : "软约束")));
  if (lv === "needs-rule") return h("section", {class:"pm-topic-why pm-constraint-why", "aria-label":"待补规则说明"},
    h("h3", {}, "待补规则"),
    h("div", {class:"pm-topic-why-row"}, h("span", {}, "来源"), h("span", {class:"pm-topic-why-v pm-wrap"}, c?.by === "human" ? "你指定的" : c?.by === "cue" ? "原话里有「必须 / 一定」这类强制措辞" : "判定模型认为适合强约束")),
    c?.reason ? h("div", {class:"pm-topic-why-row"}, h("span", {}, "缺什么"), h("span", {class:"pm-topic-why-v pm-wrap"}, c.reason)) : null,
    h("p", {class:"muted small"}, "要被标成强约束，必须绑定校验规则（校验节点、校验对象范围、校验规则、结果反馈都要写清楚）。现在还没有写成：它先按软约束注入，不会被检查。点铅笔选「强约束」，让 DeepSeek 开推理写好规则，确认后就升为强约束。"));
  if (lv !== "hard") return null;
  const by = c?.by === "human" ? "你指定的" : c?.by === "cue" ? "原话里有「必须 / 一定」这类强制措辞，默认强约束" : "判定模型认为需要强约束";
  const rule = pmRuleOf(st, t);
  return h("section", {class:"pm-topic-why pm-constraint-why", "aria-label":"强约束说明"},
    h("h3", {}, "强约束"),
    h("div", {class:"pm-topic-why-row"}, h("span", {}, "来源"), h("span", {class:"pm-topic-why-v"}, by)),
    h("div", {class:"pm-topic-why-row"}, h("span", {}, "校验规则"), h("span", {class:"pm-topic-why-v pm-wrap"}, rule?.title || "—")),
    h("div", {class:"pm-topic-why-row"}, h("span", {}, "判定方式"), h("span", {class:"pm-topic-why-v pm-wrap"}, rule?.by === "code" ? "代码判定（确定、不额外耗模型）" : "回合结束由判定模型按下面四条核对；拿不准一律放行")),
    pmRuleSpec(rule),
    h("div", {class:"pm-topic-why-row"}, h("span", {}, "检查结果"), h("span", {class:"pm-topic-why-v"}, stat ? `通过 ${stat.pass} 次 · 未通过 ${stat.fail} 次` : "还没有会话被检查过")),
    h("p", {class:"muted small"}, "新会话开头会带上它，按上面的节点自动检查；没做到会被要求补齐，最多提醒 2 次。"));
}
async function pmLoadEnforcement(d) {
  const st = pmTopicState(d);
  try { st.enforce = (await api(`${PM_API}/enforcement`)).stats || {}; } catch { st.enforce = {}; }
  if (pmPage === d) renderPublicMemory();
}
/** 归类旁边的小铅笔：点它展开「改归类」（归属 / 子类）。待裁决冲突没有这个入口。 */
function pmScopeEditorIcon(d, t) {
  const st = pmTopicState(d);
  if (t.pending) return null;
  const open = st.rescope?.id === t.id;
  const label = t.override?.scope ? "改归类（归属是你定的，流水线不再改回去）" : "改归类";
  return h("button", {type:"button", class:"btn ghost small pi-memory-icon-button pm-rescope-icon", "aria-label":"改归类", "aria-expanded":String(open), title:label, disabled:st.resolving === t.id,
    onclick:() => { st.rescope = open ? null : {id:t.id, tier:t.tier, constraint:pmEditLevel(t), draft:null, domain:t.domain, project:t.project || "", sub:t.domain === "personal" ? t.sub : "", module:t.domain === "project" ? (t.module || "cross") : ""}; st.error = ""; renderPublicMemory(); if (!open && pmEditLevel(t) === "hard") void pmResumeDraft(d, t, false); }}, pmIcon("edit"));
}
/** 归类旁边的小垃圾桶：点它出确认卡片，确认后才真删。 */
function pmRemoveIcon(d, t) {
  const st = pmTopicState(d);
  const open = st.remove?.id === t.id;
  return h("button", {type:"button", class:"btn ghost small pi-memory-icon-button pm-remove-icon", "aria-label":"删除这条记忆", "aria-expanded":String(open), title:"删除这条记忆", disabled:st.resolving === t.id,
    onclick:() => { st.remove = open ? null : {id:t.id}; st.rescope = null; st.error = ""; renderPublicMemory(); }}, pmIcon("trash"));
}
/** 真删：DELETE 这条记忆，成功后关详情、列表与动态重读。 */
async function pmRemoveTopic(d, t) {
  const st = pmTopicState(d);
  if (st.resolving) return;
  st.resolving = t.id; st.error = ""; renderPublicMemory();
  try {
    await api(`${PM_API}/pipeline/topics/${encodeURIComponent(t.id)}`, {method:"DELETE"});
    st.remove = null; st.rescope = null; st.entry = null; st.state = "idle"; st.feed.state = "idle";
  } catch (e) { st.error = pmMessage(e); }
  st.resolving = ""; renderPublicMemory();
}
/** 删除确认卡：说清删了会怎样，删与取消都在卡片底部（窄屏也先看得见）。 */
function pmRemoveCard(d, t) {
  const st = pmTopicState(d);
  if (st.remove?.id !== t.id) return null;
  const busy = st.resolving === t.id;
  return h("section", {class:"pm-conflict-card pm-remove-card", "aria-label":"确认删除这条记忆"},
    h("p", {class:"pm-conflict-lead"}, "删除后这条记忆不再注入、也不进按需索引；原话与会话记录保留，动态里能看到这次删除。"),
    h("p", {class:"pm-remove-statement"}, t.statement),
    st.error ? h("p", {role:"alert", class:"warn-text"}, st.error) : null,
    h("div", {class:"pm-conflict-actions"},
      h("button", {type:"button", class:"btn small danger", disabled:busy, onclick:() => void pmRemoveTopic(d, t)}, busy ? "删除中…" : "删除"),
      h("button", {type:"button", class:"btn small ghost", disabled:busy, onclick:() => { st.remove = null; st.error = ""; renderPublicMemory(); }}, "取消")));
}
/** 模块选项（下拉用）：与筛选行同源（接口 status.modules），「目标」排最前、跨模块收在最后叫「待归类」。 */
const pmModuleOptions = st => [...pmModules(st).filter(m => m.id !== "cross"), ...pmModules(st).filter(m => m.id === "cross")].map(m => ({id:m.id, label:m.id === "cross" ? "待归类" : m.name}));
/** 模块下拉：模块有十几项，窄屏 chip 会堆好几行把确定按钮挤出首屏，所以与上面的「项目」同宽同高用下拉。 */
const pmModuleSelect = (st, value, busy, set, label = "模块") => h("select", {"aria-label":label, disabled:busy, onchange: e => set({module:e.target.value})},
  ...(value ? [] : [h("option", {value:"", selected:true, disabled:true}, "选一个模块")]),
  ...pmModuleOptions(st).map(m => h("option", {value:m.id, selected:value === m.id}, m.label)));
/** 详情里的「改归类」卡片：归属（个人偏好 / 项目）+ 分类（个人偏好选性质、项目选模块），确定与取消在卡片底部。 */
function pmScopeEditor(d, t) {
  const st = pmTopicState(d);
  if (t.pending) return null;
  const busy = st.resolving === t.id, r = st.rescope?.id === t.id ? st.rescope : null;
  if (!r) return null;
  const projects = [...new Set([...(Object.keys(st.status?.counts?.projects || {})), ...(t.project ? [t.project] : [])])].sort();
  const set = patch => { st.rescope = {...r, ...patch}; st.error = ""; renderPublicMemory(); };
  const subs = PM_TSUB.personal;
  const changed = pmScopeChanged(r, t) || pmConstraintChanged(r, t);
  // 强约束要先有规则：刚生成好的草稿，或这条本来就是绑了规则的强约束
  const hardReady = r.draft?.state === "ready" || (pmEditLevel(t) === "hard" && !!pmRuleOf(st, t) && r.draft?.state !== "running" && r.draft?.state !== "checking" && r.draft?.state !== "error");
  const ready = r.domain === "personal" ? !!r.sub : (!!r.project && !!r.module);
  return h("section", {class:"pm-conflict-card pm-scope-card pm-rescope", "aria-label":"改归类"},
    h("p", {class:"pm-conflict-lead"}, "修改归类和消费方式，保存后按你的选择生效。"),
    h("div", {class:"pm-scope-row", role:"group", "aria-label":"归属"}, h("span", {class:"pm-feed-label"}, "归属"),
      h("button", {type:"button", class:`btn small ${r.domain === "personal" ? "is-on" : ""}`, "aria-pressed":String(r.domain === "personal"), disabled:busy, onclick:() => set({domain:"personal", project:"", module:"", sub:""})}, "个人偏好"),
      h("button", {type:"button", class:`btn small ${r.domain === "project" ? "is-on" : ""}`, "aria-pressed":String(r.domain === "project"), disabled:busy || !projects.length, title:projects.length ? "改成某个项目的记忆" : "还没有可选的项", onclick:() => set({domain:"project", project:r.project || t.project || projects[0] || "", module:t.domain === "project" ? (t.module || "cross") : "", sub:""})}, "项目记忆")),
    r.domain === "project" ? h("div", {class:"pm-scope-row", role:"group", "aria-label":"项目"}, h("span", {class:"pm-feed-label"}, "项目"),
      h("select", {"aria-label":"项目", disabled:busy, onchange: e => set({project:e.target.value})}, ...projects.map(p => h("option", {value:p, selected:(r.project || projects[0]) === p}, p)))) : null,
    r.domain === "personal"
      ? h("div", {class:"pm-scope-row", role:"group", "aria-label":"性质"}, h("span", {class:"pm-feed-label"}, "性质"),
          ...subs.map(x => h("button", {type:"button", class:`btn small ${r.sub === x ? "is-on" : ""}`, "aria-pressed":String(r.sub === x), disabled:busy, onclick:() => set({sub:x})}, x)))
      : h("div", {class:"pm-scope-row", role:"group", "aria-label":"模块"}, h("span", {class:"pm-feed-label"}, "模块"),
          pmModuleSelect(st, r.module, busy, set)),
    h("div", {class:"pm-scope-row", role:"group", "aria-label":"消费方式"}, h("span", {class:"pm-feed-label"}, "消费方式"),
      ...["A", "B"].map(tier => h("button", {type:"button", class:`btn small ${r.tier === tier ? "is-on" : ""}`, "aria-pressed":String(r.tier === tier), disabled:busy, onclick:() => set({tier})}, PM_TIER[tier]))),
    h("p", {class:"muted small"}, "常驻：每次会话自动带入；按需：相关时从索引查阅。"),
    h("div", {class:"pm-scope-row", role:"group", "aria-label":"约束类型"}, h("span", {class:"pm-feed-label"}, "约束类型"),
      ...["hard", "needs-rule", "soft"].map(k => h("button", {type:"button", class:`btn small ${r.constraint === k ? "is-on" : ""}`, "aria-pressed":String(r.constraint === k), disabled:busy, onclick:() => { set({constraint:k}); if (k === "hard") void pmResumeDraft(d, t, false); }}, PM_CONSTRAINT[k]))),
    r.constraint === "hard" ? pmRuleDraftBlock(d, t, r, busy) : null,
    h("p", {class:"muted small"}, "强约束：绑定 DeepSeek 写好、你确认过的校验规则，平台按规则的节点自动检查，没做到会被要求重做；待补规则：想强约束但规则还没写成，先按软约束处理；软约束：由模型自己决定是否遵循。"),
    st.error ? h("p", {role:"alert", class:"warn-text"}, st.error) : null,
    h("div", {class:"pm-conflict-actions"},
      h("button", {type:"button", class:"btn small primary", disabled:busy || !ready || !changed || (r.constraint === "hard" && !hardReady), onclick:() => void pmRescopeTopic(d, t)}, busy ? "保存中…" : (r.constraint === "hard" && r.draft?.state === "ready" ? "确认规则并设为强约束" : "确定")),
      h("button", {type:"button", class:"btn small ghost", disabled:busy, onclick:() => { st.rescope = null; st.error = ""; renderPublicMemory(); }}, "取消")));
}
/** 归属待判定卡片：提炼时或开推理二判后仍分不清是个人偏好还是项目，交给人：选归属 → 选性质 / 模块 → 确定。 */
function pmScopeCard(d, o) {
  const st = pmTopicState(d), draft = st.scopeDraft?.id === o.id ? st.scopeDraft : null, busy = st.resolving === o.id;
  const projectName = o.sessionProject || o.suggestion?.project || "";
  const subDraft = draft && draft.domain === "personal" ? {id:o.id, domain:"personal", project:"", sub:draft.sub || "", module:""} : null;
  const modDraft = draft && draft.domain === "project" ? {id:o.id, domain:"project", project:draft.project || projectName, sub:"", module:draft.module || o.suggestion?.module || ""} : null;
  const cur = subDraft || modDraft;
  const setDomain = domain => { st.scopeDraft = domain === "personal" ? {id:o.id, domain, project:"", sub:"", module:""} : {id:o.id, domain, project:projectName, sub:"", module:o.suggestion?.module || ""}; renderPublicMemory(); };
  const set = patch => { if (!cur) return; st.scopeDraft = {...cur, ...patch}; renderPublicMemory(); };
  const scopeName = v => (v === "personal" ? "个人偏好" : `项目 ${v.project || ""}`.trim());
  const suggest = o.suggestion ? `${scopeName(o.suggestion)} · ${o.suggestion.domain === "personal" ? (o.suggestion.sub || "—") : pmModuleName(st, o.suggestion.module || "cross")}` : "";
  return h("section", {class:"pm-conflict-card pm-scope-card", "aria-label":"判定这条的归属", "data-id":o.id},
    h("p", {class:"pm-conflict-lead"}, "这句话归哪一类？你判定之前，它不会被会话读到。"),
    h("div", {class:"pm-scope-quote"}, h("span", {class:"pm-feed-label"}, "你说的"), h("p", {}, `“${o.quote}”`)),
    h("p", {class:"pm-scope-rule"}, h("span", {class:"pm-feed-label"}, "提炼成"), "：", o.statement),
    o.reason ? h("p", {class:"muted small"}, `${o.reasonSource === "judge" ? "开推理再判，仍不确定" : "提炼时没把握"}：${o.reason}`) : null,
    o.suggestion ? h("p", {class:"muted small"}, `二判倾向：${suggest}`) : null,
    h("div", {class:"pm-scope-row", role:"group", "aria-label":"归属"}, h("span", {class:"pm-feed-label"}, "归属"),
      h("button", {type:"button", class:`btn small ${draft?.domain === "personal" ? "is-on" : ""}`, "aria-pressed":String(draft?.domain === "personal"), disabled:busy, onclick:() => setDomain("personal")}, "个人偏好"),
      h("button", {type:"button", class:`btn small ${draft?.domain === "project" ? "is-on" : ""}`, "aria-pressed":String(draft?.domain === "project"), disabled:busy || !projectName, title:projectName ? `项目「${projectName}」的记忆` : "这条没记到项目", onclick:() => setDomain("project")}, projectName ? `项目 ${projectName}` : "项目（缺项目名）")),
    cur?.domain === "personal" ? h("div", {class:"pm-scope-row", role:"group", "aria-label":"性质"}, h("span", {class:"pm-feed-label"}, "性质"),
      ...PM_TSUB.personal.map(s => h("button", {type:"button", class:`btn small ${cur.sub === s ? "is-on" : ""}`, "aria-pressed":String(cur.sub === s), disabled:busy, onclick:() => set({sub:s})}, s))) : null,
    cur?.domain === "project" ? h("div", {class:"pm-scope-row", role:"group", "aria-label":"模块"}, h("span", {class:"pm-feed-label"}, "模块"),
      pmModuleSelect(st, cur.module, busy, set)) : null,
    cur ? h("div", {class:"pm-conflict-actions"},
      h("button", {type:"button", class:"btn small primary", disabled:busy || (cur.domain === "personal" ? !cur.sub : (!cur.project || !cur.module)), onclick:() => void pmResolveScope(d, o)}, busy ? "保存中…" : "确定"),
      h("button", {type:"button", class:"btn small ghost", disabled:busy, onclick:() => { st.scopeDraft = null; renderPublicMemory(); }}, "取消")) : null);
}
/** 冲突卡片：新的说法 vs 已有的，两个按钮。裁决之前已有的照常生效，新的不会被会话读到。 */
function pmConflictCard(d, t, dialog) {
  const st = pmTopicState(d), old = st.items.find(x => x.id === t.pending.withTopicId), busy = st.resolving === t.id;
  return h("section", {class:"pm-conflict-card", "aria-label":"冲突待确认", "data-id":t.id},
    h("p", {class:"pm-conflict-lead"}, "新的说法和已有的相反。你裁决之前，已有的照常生效，新的不会被会话读到。"),
    h("div", {class:"pm-conflict-sides"},
      h("div", {class:"pm-conflict-side is-new"}, h("span", {class:"pm-feed-label"}, "新的说法"), h("p", {}, t.statement), t.evidence?.[0] ? h("p", {class:"pm-conflict-quote muted small"}, `你说过：“${t.evidence[0].quote}”`) : null),
      h("div", {class:"pm-conflict-side is-old"}, h("span", {class:"pm-feed-label"}, "已有的"), h("p", {}, old ? old.statement : "（已有的这条已经不在了，冲突会自行消解）"))),
    t.pending.reason ? h("p", {class:"muted small"}, `判断依据：${t.pending.reason}`) : null,
    h("div", {class:"pm-conflict-actions"},
      h("button", {type:"button", class:"btn small", disabled:!!st.resolving || !old, onclick:() => void pmResolve(d, t.id, "adopt", dialog)}, busy ? "处理中…" : "采用新的"),
      h("button", {type:"button", class:"btn small ghost", disabled:!!st.resolving, onclick:() => void pmResolve(d, t.id, "keep", dialog)}, "保留旧的")));
}
function pmFeedItem(d, c) {
  const st = pmTopicState(d), open = st.items.some(t => t.id === c.topicId);
  const text = open ? h("button", {type:"button", class:"pm-feed-main", "aria-label":`查看详情：${c.statement}`, onclick:() => { st.entry = c.topicId; renderPublicMemory(); }}, c.statement) : h("p", {class:"pm-feed-main"}, c.statement);
  return h("article", {class:`pm-feed-item kind-${c.kind}`, "data-kind":c.kind, "data-id":c.id},
    h("time", {class:"pm-feed-time", datetime:c.at}, pmBj(c.at, {hour:"2-digit", minute:"2-digit"})),
    h("div", {class:"pm-feed-entry"}, h("div", {class:"pm-feed-head"},
      h("span", {class:`pm-feed-kind kind-${c.kind}`}, pmKindLabel(c)),
      h("span", {class:"pm-feed-where"}, pmChangeScope(c)),
      h("span", {class:"pm-feed-source", title:[PM_TRIGGER[c.trigger] || c.trigger, c.note].filter(Boolean).join(" · ")}, PM_TRIGGER[c.trigger] || c.trigger, c.note ? ` · ${c.note}` : "")),
    text,
    c.before ? h("p", {class:"pm-feed-before"}, h("span", {class:"pm-feed-label"}, c.kind === "conflict" ? "和已有的相反：" : c.kind === "resolved" ? "被忽略的说法：" : "之前："), c.before) : null,
    c.quote ? h("p", {class:"pm-feed-quote"}, `“${c.quote}”`, c.sessionId ? h("a", {href:`#/rt/${c.sessionId}`, class:"pm-topic-sess"}, `会话 ${c.sessionId.replace(/^rt-/, "").slice(0, 8)}`) : null) : null));
}
/** 一次定时 / 手动运行的汇总行：这次落下了几类变更；没变化、失败也留一行。 */
function pmFeedRun(r) {
  const parts = Object.entries(PM_KIND).filter(([kind]) => r.kinds?.[kind]).map(([kind, label]) => `${kind === "conflict" ? "冲突" : label} ${r.kinds[kind]}`);
  const state = r.error ? "failed" : r.total ? "changed" : "idle";
  const text = r.error ? `运行失败：${pmClip(r.error, 60)}` : r.total ? parts.join("、") : "本次无变化";
  const secs = Math.round((r.durationMs || 0) / 1000);
  return h("article", {class:`pm-feed-run is-${state}`, "data-run":r.trigger, "data-at":r.at, title:[r.error, secs ? `用时 ${secs >= 60 ? `${Math.floor(secs / 60)} 分 ${secs % 60} 秒` : `${secs} 秒`}` : ""].filter(Boolean).join(" · ")},
    h("time", {class:"pm-feed-time", datetime:r.at}, pmBj(r.at, {hour:"2-digit", minute:"2-digit"})),
    h("p", {class:"pm-feed-runline"}, h("strong", {}, PM_SOURCE[r.trigger] || r.trigger), "：", h("span", {class:"pm-feed-runtext"}, text)));
}
function pmFeedStats(f, at) {
  const time = Date.parse(at);
  const day = Number.isFinite(time) ? new Date(time + 8 * 3600000).toISOString().slice(0, 10) : "unknown";
  const row = (f.daily || []).find(r => r.day === day);
  if (!row) return null;
  return h("div", {class:"pm-feed-stats", "aria-label":`${day} 操作统计（北京时间）`},
    h("span", {class:"pm-feed-total"}, h("strong", {}, String(row.total)), " 次操作"),
    h("div", {class:"pm-feed-counts"}, ...Object.entries(PM_KIND).filter(([kind]) => row.kinds[kind]).map(([kind, label]) =>
      h("span", {class:"pm-feed-count", "data-kind":kind}, label, h("b", {}, String(row.kinds[kind]))))));
}
function pmFeedBody(d) {
  const st = pmTopicState(d), f = st.feed, out = [];
  const pending = st.items.filter(t => t.pending);
  if (st.scopes?.length) out.push(h("section", {class:"pm-feed-pending", "aria-label":"归属待判定"}, h("h2", {class:"pm-feed-day"}, `归属待你判定（${st.scopes.length}）`), ...st.scopes.map(o => pmScopeCard(d, o))));
  if (pending.length) out.push(h("section", {class:"pm-feed-pending", "aria-label":"待你确认的冲突"}, h("h2", {class:"pm-feed-day"}, `待你确认（${pending.length}）`), ...pending.map(t => pmConflictCard(d, t, null))));
  if (f.state === "error" && !f.items.length) { out.push(h("p", {role:"alert", class:"warn-text"}, `读取失败：${f.error} `, h("button", {type:"button", class:"btn small", onclick:() => void pmLoadFeed()}, "重试"))); return out; }
  if (f.state !== "ready" && !f.items.length) { out.push(h("p", {class:"muted"}, "正在读取…")); return out; }
  // 汇总行只放到已加载的明细范围内：还有没加载的旧明细时，比最早一条更早的运行等翻页再出现
  const oldest = f.items.length && f.items.length < f.total ? f.items[f.items.length - 1].at : "";
  const rows = [...f.items.map(c => ({at:c.at, c})), ...(f.runs || []).filter(r => r.at >= oldest).map(r => ({at:r.at, r}))].sort((a, b) => b.at.localeCompare(a.at) || (a.r ? 0 : 1) - (b.r ? 0 : 1));
  if (!rows.length) { out.push(h("p", {class:"pm-empty"}, (f.period && f.period !== "all" || f.kind && f.kind !== "all" || f.source && f.source !== "all") ? "没有符合筛选条件的动态，可调整时间、操作类型或来源。" : "还没有变更记录。从现在起，每次入库、更新、取代、冲突、升降级都会记在这里。")); return out; }
  const dayKey = iso => pmBj(iso, {year:"numeric", month:"2-digit", day:"2-digit"});
  const today = dayKey(new Date().toISOString()), yesterday = dayKey(new Date(Date.now() - 86400000).toISOString());
  const groups = []; for (const row of rows) { const k = dayKey(row.at); const g = groups[groups.length - 1]; if (g && g.k === k) g.items.push(row); else groups.push({k, at:row.at, items:[row]}); }
  out.push(h("div", {class:"pm-feed", role:"feed", "aria-label":"记忆变更动态"}, ...groups.map(g =>
    h("section", {class:"pm-feed-group", "aria-label":pmDay(g.at)},
      h("header", {class:"pm-feed-heading"},
        h("h2", {class:"pm-feed-day"}, pmBj(g.at, {year:"numeric", month:"2-digit", day:"2-digit"}), g.k === today ? " · 今天" : g.k === yesterday ? " · 昨天" : ""),
        pmFeedStats(f, g.at)),
      ...g.items.map(row => row.r ? pmFeedRun(row.r) : pmFeedItem(d, row.c))))));
  if (f.items.length < f.total) out.push(h("div", {class:"pm-feed-more"}, h("button", {type:"button", class:"btn small ghost", disabled:f.state === "loading", onclick:() => void pmLoadFeed(true)}, f.state === "loading" ? "正在读取…" : `加载更多（还有 ${f.total - f.items.length} 条）`)));
  return out;
}
/** 顶上的「分类 / 动态」：同一个页面里的两个视图。动态上的红色数字 = 有冲突等你确认；主色数字 = 有没读过的变动（新增、更新、取代、升降级、移除等，不含你自己的裁决），看过就消失。 */
function pmViewTabs(d) {
  const st = pmTopicState(d), n = st.items.filter(t => t.pending).length + (st.scopes?.length || 0), nNew = st.unread?.count || 0;
  const set = v => { st.viewDecided = true; if (st.view === v) return; st.view = v; st.entry = null; if (v === "feed") st.feed.state = "idle";
    // 动态里看过变更再切回分类：分类的数据是进页面时读的，不重读就看不到新增 / 更新。静默重读（旧列表先显示，读完局部更新），不整页刷新
    else if (st.state === "ready" && ((st.feed.loadedAt || 0) > (st.loadedAt || 0) || Date.now() - (st.loadedAt || 0) > 5000)) st.state = "idle"; renderPublicMemory(); queueMicrotask(() => d.root.querySelector('.pm-viewtabs [aria-selected="true"]')?.focus()); };
  const onKey = ev => { const step = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0; if (!step) return; ev.preventDefault(); set(st.view === "catalog" ? "feed" : "catalog"); };
  const tab = (v, label, badge, fresh) => h("button", {type:"button", role:"tab", "aria-selected":String(st.view === v), tabindex:st.view === v ? "0" : "-1", onclick:() => set(v)}, label, badge ? h("span", {class:"pm-tab-badge", "aria-label":`${badge} 条待确认`}, String(badge)) : null, fresh ? h("span", {class:"pm-tab-badge is-new", "aria-label":`${fresh} 条记忆有变动`}, String(fresh)) : null);
  return h("div", {class:"pm-viewbar"}, h("div", {class:"pm-tabs pm-viewtabs", role:"tablist", "aria-label":"查看方式", onkeydown:onKey}, tab("catalog", "分类"), tab("feed", "动态", n, nNew)));
}
/* ===== 问询：带着这条记忆的背景，新建会话 ===== */
const pmOne = v => String(v ?? "").replace(/\s+/g, " ").trim();
const pmClip = (v, n) => { const t = Array.from(pmOne(v)); return t.length > n ? `${t.slice(0, n).join("")}…` : t.join(""); };
/**
 * 「问询」的首条消息：和待办的「引用到新会话」同一种做法——一个 markdown 引用块，输入框里收成 chip（runtime-chat.js 的 rtNoteQuoteOne 认这个格式），
 * 发送时原样带给会话。第一行是这条记忆的一句话规则，后面「背景：」是它的来龙去脉：归属与消费方式、你说过的原话（依据）、表述的演变、冲突、来源。
 * 注意：背景里的话不是你这次说的，每晚梳理时整块会被剥掉（capture.ts 的 stripMemoryQuotes），不会反过来强化这条记忆。
 */
function pmAskPrompt(d, t) {
  const st = pmTopicState(d), scope = pmTScopeLabel(pmTScope(t));
  const mode = t.pending ? "待确认（不会被会话读到）" : t.tier === "material" ? "素材层（不会被会话读到）" : PM_TIER[t.tier] || t.tier;
  const lines = [pmOne(t.statement), "", "背景："];
  lines.push(`- 归属与消费：${scope} · ${pmTKindLabel(st, t)} · ${mode}${t.imported ? "" : `，${t.score} 分`}`);
  if (t.condition) lines.push(`- 适用条件：${pmClip(t.condition, 120)}`);
  if (t.signals?.remembered) lines.push("- 你明说过「记住」");
  const shown = (t.evidence || []).slice(0, 3);
  for (const e of shown) lines.push(`- 依据：${pmDay(e.at)} 你说过「${pmClip(e.quote, 120)}」（会话 ${String(e.sessionId || "").replace(/^rt-/, "").slice(0, 8)}${e.explicit ? "，明确指令" : ""}）`);
  const total = t.memberIds?.length || 0;
  if (total > shown.length) lines.push(`- 另有 ${total - shown.length} 条依据未列出`);
  if (t.history?.length) lines.push(`- 表述的演变（旧→新）：${t.history.map(x => `${pmDay(x.at)} ${pmClip(x.statement, 80)}`).join(" → ")} → 现在`);
  if (t.pending) {
    const old = st.items.find(x => x.id === t.pending.withTopicId);
    lines.push(`- 冲突：和已有的「${old ? pmClip(old.statement, 100) : "（已有的这条已经不在了）"}」相反；${pmClip(t.pending.reason, 80)}；等你裁决`);
  }
  lines.push(t.imported ? `- 来源：从旧机制导入${t.imported.evidence ? `，当时的确认依据：${pmClip(t.imported.evidence, 120)}` : ""}` : "- 来源：由你在平台会话里说过的话提炼");
  return [`引用平台记忆（编号 ${t.id} · ${scope} · ${pmTKindLabel(st, t)}）：`, "", ...lines.map(l => (l ? `> ${l}` : ">"))].join("\n");
}
/** 点「问询」：关掉详情，到新建会话页——输入框上方是这条记忆的 chip，自己接着写要问什么。已经引用过同一条就不重复加。 */
function pmAsk(d, t, dialog) {
  if (typeof rtStartNewSession !== "function") { if (typeof announce === "function") announce("请到「对话」页新建会话"); return; }
  const prompt = pmAskPrompt(d, t), head = prompt.split("\n")[0];
  const draft = typeof rtImageDraft === "function" ? rtImageDraft("new") : null;
  dialog?.close?.();
  rtStartNewSession(draft && String(draft.text || "").includes(head) ? "" : prompt, null);
}
async function pmPreview() {
  const d = pmPage; if (!d?.preview) return;
  const target = d.preview;
  try { const result = await api("/api/memory/public/injection-preview", {method:"POST", body:JSON.stringify({project:target.project})}); if (pmPage === d && d.preview === target) { target.result = result; renderPublicMemory(); } }
  catch (e) { if (pmPage === d) { d.error = pmMessage(e); renderPublicMemory(); } }
}
function renderPmSettings(d) {
  const data = d.data;
  const projects = [...new Set(data?.projects || [])].sort();
  const row = (key, label, on, off) => h("div", {class:"pm-settings-row"},
    h("label", {class:"pm-switch"}, h("input", {type:"checkbox", class:key === "pipelineEnabled" ? "pm-pipeline-enabled" : "pm-inject-enabled", checked:!!data.settings?.[key], disabled:d.busy, onchange: e => void pmSetSetting(key, e.target.checked)}), ` ${label}`),
    h("p", {class:"muted small"}, data.settings?.[key] ? on : off));
  const switches = data ? h("section", {class:"pm-add pm-settings-card", "aria-label":"新会话注入"},
    row("injectEnabled", "新会话首轮自动注入公共记忆", "已开启：只对之后新建的会话生效；自动化 / 评估会话不注入", "已关闭：不会改变任何 runtime 的提示词")) : h("p", {class:"muted small", role:"status"}, d.error ? "" : "正在读取…");
  // 提炼流水线：开关管定时，下面一行是它的运行状态（上次运行 / 下次运行），「立即运行」手动跑一次增量；三者同一张卡，不挂在某一条记忆下面
  const pipeState = pmPipe(d), ps = pipeState.status, lastRun = ps?.lastRun;
  const pipeText = !ps ? (pipeState.error ? `读取运行状态失败：${pipeState.error}` : "正在读取运行状态…")
    : ps.running ? "正在从会话里提炼，跑完自动刷新"
    : lastRun ? `上次运行 ${pmDayTime(lastRun.at)} · ${lastRun.sessions} 个会话${lastRun.error ? ` · 失败：${lastRun.error}` : ""}`
    : "还没有运行过";
  const pipeNext = !ps ? "" : !ps.enabled ? "定时已关" : ps.nextRunAt ? `下次 ${pmDayTime(ps.nextRunAt)}` : "";
  const pipe = data ? h("section", {class:"pm-add pm-settings-card pm-pipe-card", "aria-label":"提炼流水线"},
    row("pipelineEnabled", "每天自动从会话里提炼公共记忆", "已开启：每天北京时间 03:30 从平台会话里你亲口说的话提炼新的公共记忆；你说「记住…」时会当场提炼，不等这个定时", "已关闭：只在你点「立即运行」时提炼"),
    h("div", {class:"pm-pipe-status-row"},
      h("p", {class:"muted small pm-pipe-status", role:"status"}, pipeText, pipeNext ? ` · ${pipeNext}` : ""),
      h("button", {type:"button", class:"btn small ghost pm-pipe-run", disabled:!!ps?.running || pipeState.state === "loading", onclick: () => void pmRunPipeline()}, ps?.running ? "运行中…" : "立即运行"))) : null;
  const preview = data ? h("section", {class:"pm-add pm-settings-card", "aria-label":"注入预览"},
    h("div", {class:"pm-row"}, h("strong", {}, "预览注入内容"),
      h("button", {type:"button", class:"btn small ghost", onclick: () => { d.preview = d.preview ? null : {project:projects[0] || null, result:null}; renderPublicMemory(); if (d.preview) void pmPreview(); }}, d.preview ? "收起预览" : "预览")),
    d.preview ? [
      h("div", {class:"pm-row"}, h("span", {class:"muted small"}, "如果现在新建一个会话，所在项目是："),
        h("select", {"aria-label":"预览项目", onchange: e => { d.preview.project = e.target.value === "__global" ? null : e.target.value; d.preview.result = null; renderPublicMemory(); void pmPreview(); }}, [["__global", "（无项目，只含全局）"], ...projects.map(p => [p, p])].map(([v, l]) => h("option", {value:v, selected:(d.preview.project ?? "__global") === v}, l)))),
      d.preview.result ? (d.preview.result.block ? [h("p", {class:"muted small"}, `常驻 ${d.preview.result.block.count} 条（项目 ${d.preview.result.block.project} · 全局 ${d.preview.result.block.global}），约 ${d.preview.result.block.chars} 字 ≈ ${d.preview.result.block.estTokens} token${d.preview.result.block.onDemand ? `；另有 ${d.preview.result.block.onDemand} 条按需查阅（索引：${d.preview.result.block.indexPath || "—"}）` : ""}`), h("pre", {class:"pi-memory-body pm-preview"}, d.preview.result.block.text)] : h("p", {class:"muted small"}, "没有可注入的条目（只注入生效中且没有未决争议的条目）")) : h("p", {class:"muted small"}, "正在生成预览…")] : null) : null;
  d.root.replaceChildren(h("div", {class:"pi-memory-panel pm-settings-page"},
    h("header", {class:"pi-memory-head"},
      h("a", {class:"settings-back pm-settings-back", href:"#/memory", "aria-label":"返回平台记忆"}, "‹ 返回"),
      h("div", {class:"pi-memory-heading"}, h("h1", {}, "平台记忆设置"))),
    d.error ? h("p", {role:"alert", class:"pi-memory-notice warn-text"}, d.error) : null,
    d.versionConflict ? h("button", {type:"button", class:"btn small", onclick:() => void pmLoadSettings()}, "读取最新版本") : null,
    h("div", {class:"pm-settings-body"}, switches, pipe, preview),
    d.busy || d.loading ? h("footer", {class:"pi-memory-status"}, h("span", {role:"status"}, d.busy ? "处理中…" : "正在读取…")) : null));
}
function renderPublicMemory() {
  const d = pmPage; if (!d) return;
  if (pmOnSettings()) {
    renderPmSettings(d);
    if (!d.data && !d.loading) void pmLoadSettings();
    const p = pmPipe(d);
    if (p.state !== "loading" && Date.now() - (p.loadedAt || 0) > 15000) queueMicrotask(() => void pmLoadPipeStatus());   // 15 秒内的重复渲染不再请求
    return;
  }
  if (pmOnArch() && pmHasArch()) { renderPmArch(d); return; }
  if (pmHasArch() && !d.arch?.meta && !d.arch?.tried) queueMicrotask(() => void pmArchLoadMeta(d));   // 只为入口的红点：知道最新架构版本才能判断有没有更新
  const st = pmTopicState(d);
  const scroll = d.root.querySelector(".pi-memory-content")?.scrollTop || 0;
  if (st.state === "idle") queueMicrotask(() => void pmLoadTopics());
  if (st.view === "feed" && st.feed.state === "idle") queueMicrotask(() => void pmLoadFeed());
  const rail = st.view === "feed" ? pmFeedFilters(d) : pmTopicsRail(d);
  const content = h("div", {class:`pi-memory-content${st.view === "feed" ? " pm-feed-content" : ""}`}, ...(st.view === "feed" ? pmFeedBody(d) : pmTopicsBody(d)));
  const te = pmTopicsEntry(d);
  const drawer = te ? pmTopicDrawer(d, te) : null;
  d.root.replaceChildren(h("div", {class:"pi-memory-panel"},
    h("header", {class:"pi-memory-head"},
      h("div", {class:"pi-memory-heading"}, h("h1", {}, "平台记忆")),
      h("div", {class:"pi-memory-head-actions"},
        h("a", {class:"btn small pm-arch-entry", href:"#/memory/architecture", "aria-label":pmHasArch() && pmArchUnseen(d) ? "架构（有更新）" : "架构"}, "架构", pmHasArch() && pmArchUnseen(d) ? h("span", {class:"pm-red-dot", role:"status", "aria-label":"架构图有更新"}) : null),
        h("a", {class:"btn small", href:"#/memory/settings"}, "设置"),
        h("button", {type:"button", class:"btn ghost small pi-memory-icon-button", disabled:st.state === "loading", "aria-label":"刷新", title:"刷新", onclick:() => { st.state = "idle"; void pmLoadTopics(); }}, pmIcon("refresh")))),
    st.error && st.state !== "error" ? h("p", {role:"alert", class:"pi-memory-notice warn-text"}, st.error) : null,
    h("div", {class:"pi-memory-layout history pm-layout"}, pmViewTabs(d), rail, content),
    st.state === "loading" && st.items.length ? h("footer", {class:"pi-memory-status"}, h("span", {role:"status"}, "正在读取…")) : null,
    ...(drawer ? [drawer] : [])));
  if (drawer) { try { drawer.showModal(); } catch {} }
  content.scrollTop = scroll;
}

window.piRouteModules?.register("memory", { render: renderPublicMemoryPage });
