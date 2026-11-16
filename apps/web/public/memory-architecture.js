/* 平台记忆·架构图页（#/memory/architecture）：看当前版本的架构；开「对比」后，标出最新版相对所选旧版的改动点（新增 / 修改 / 删除）。
 * 数据是随代码部署的版本快照（apps/web/src/memory/architecture/versions/vNNN.json），接口 /api/memory/architecture[/:id]。
 * 对比按节点 id 做：层、层里的卡片、时序图的参与者与每一步都有稳定 id，文字变了 = 修改，旧版没有 = 新增，新版没有 = 删除。
 * 入口红点：本机记着“最后看过哪一版”，最新版比它新就亮（见 pmArchUnseen）。 */
const PM_ARCH_API = "/api/memory/architecture";
const PM_ARCH_SEEN = "pm-arch-seen";
const PM_ARCH_VIEWS = [["arch", "架构图"], ["ingest", "时序·入库"], ["session", "时序·会话中"]];
const PM_DIFF_LABEL = {added:"新增", changed:"修改", removed:"已删除"};

function pmArchCreate() { return {meta:null, loading:false, tried:false, error:"", versions:{}, view:"arch", compare:false, base:null}; }
const pmArchState = d => (d.arch ||= pmArchCreate());
function pmArchSeen() { try { return localStorage.getItem(PM_ARCH_SEEN) || ""; } catch { return ""; } }
function pmArchMarkSeen(id) { try { if (id) localStorage.setItem(PM_ARCH_SEEN, id); } catch { /* 隐私模式：红点下次还会亮，不影响使用 */ } }
/** 入口红点：最新版本比本机看过的新。meta 还没读到时不亮（避免闪一下）。 */
const pmArchUnseen = d => { const m = d.arch?.meta; return !!(m?.latest && pmArchSeen() !== m.latest); };

async function pmArchLoadMeta(d) {
  const a = pmArchState(d);
  if (a.loading || a.meta || a.tried) return;
  a.loading = true; a.tried = true;
  try { a.meta = await api(PM_ARCH_API); a.error = ""; }
  catch (e) { a.error = pmMessage(e); }
  finally { a.loading = false; renderPublicMemory(); }
}
async function pmArchLoadVersion(d, id) {
  const a = pmArchState(d);
  if (!id || a.versions[id] || a.versions[`#${id}`]) return;
  a.versions[`#${id}`] = true;   // 读取中占位，避免重复请求
  try { a.versions[id] = await api(`${PM_ARCH_API}/${id}`); }
  catch (e) { a.error = pmMessage(e); }
  finally { delete a.versions[`#${id}`]; renderPublicMemory(); }
}

/* ---------- 对比：把一个版本摊平成 key → 节点，逐 key 比 ---------- */
const pmSig = o => JSON.stringify(o, Object.keys(o).filter(k => k !== "id").sort());
function pmArchFlatten(v) {
  const m = new Map(), put = (key, label, node) => m.set(key, {label, sig: pmSig(node), node});
  for (const l of v.layers || []) {
    put(`L:${l.id}`, `${l.no}. ${l.title}`, {no:l.no, title:l.title, sub:l.sub, arrow:l.arrow});
    for (const b of l.blocks || []) for (const it of b.items) put(`I:${it.id}`, it.title, it);
  }
  if (v.aside) put(`I:${v.aside.id}`, v.aside.title, v.aside);
  for (const s of v.sequences || []) {
    put(`Q:${s.id}`, s.title, {title:s.title, lead:s.lead});
    for (const a of s.actors) put(`A:${s.id}:${a.id}`, `${s.title}·参与者「${a.name}」`, a);
    for (const st of s.steps) put(`S:${s.id}:${st.id}`, `${s.title}·${st.text.slice(0, 22)}${st.text.length > 22 ? "…" : ""}`, st);
  }
  return m;
}
/** 返回 {status(key), before(key), removed:[{key,label,node}], counts}；没开对比时 status 恒为 same。 */
function pmArchDiff(head, base) {
  if (!head || !base) return {status: () => "same", before: () => null, removed: [], counts: {added:0, changed:0, removed:0}, list: []};
  const a = pmArchFlatten(head), b = pmArchFlatten(base), list = [], removed = [], counts = {added:0, changed:0, removed:0};
  for (const [k, v] of a) { const o = b.get(k); if (!o) { counts.added++; list.push({kind:"added", key:k, label:v.label}); } else if (o.sig !== v.sig) { counts.changed++; list.push({kind:"changed", key:k, label:v.label}); } }
  for (const [k, v] of b) if (!a.has(k)) { counts.removed++; removed.push({key:k, label:v.label, node:v.node}); list.push({kind:"removed", key:k, label:v.label}); }
  return {status: k => { const o = b.get(k), v = a.get(k); return !v ? "same" : !o ? "added" : o.sig !== v.sig ? "changed" : "same"; }, before: k => b.get(k)?.node || null, removed, counts, list};
}

/* ---------- 架构图（卡片） ---------- */
const pmArchBadge = s => s === "same" ? null : h("span", {class:`pma-badge pma-badge-${s}`}, PM_DIFF_LABEL[s]);
function pmArchCardText(it) {
  return [it.body ? h("p", {}, it.body) : null, it.bullets?.length ? h("ul", {}, it.bullets.map(x => h("li", {}, x))) : null];
}
function pmArchCard(it, diff, ghost) {
  const s = ghost ? "removed" : diff.status(`I:${it.id}`), before = s === "changed" ? diff.before(`I:${it.id}`) : null;
  return h("div", {class:`pma-card pma-tone-${it.tone || "plain"} pma-diff-${s}`, "data-arch-id":it.id},
    h("h3", {}, it.title, it.tag ? h("span", {class:`pma-tag ${it.tag === "模型" ? "pma-tag-m" : "pma-tag-d"}`}, it.tag) : null, pmArchBadge(s)),
    ...pmArchCardText(it),
    before ? h("details", {class:"pma-before"}, h("summary", {}, "看改前"), h("div", {class:"pma-before-body"}, h("strong", {}, before.title), ...pmArchCardText(before))) : null);
}
function pmArchLayer(l, diff, baseLayers) {
  const s = diff.status(`L:${l.id}`), removedHere = diff.removed.filter(r => r.key.startsWith("I:") && (baseLayers.get(l.id) || new Set()).has(r.key.slice(2)));
  const blocks = (l.blocks || []).map((b, i) => {
    const items = b.items.map(it => pmArchCard(it, diff, false));
    if (i === 0) for (const r of removedHere) items.push(pmArchCard(r.node, diff, true));
    return h("div", {class:`pma-block pma-block-${b.layout}`}, items);
  });
  return [
    l.arrow ? h("div", {class:`pma-arrow pma-diff-${s}`}, h("span", {}, l.arrow)) : null,
    h("section", {class:`pma-layer pma-diff-${s}`, "data-arch-id":l.id, "aria-label":l.title},
      h("h2", {}, h("i", {}, String(l.no)), l.title, h("span", {}, l.sub), pmArchBadge(s)), ...blocks)];
}
function pmArchDiagram(v, diff, base) {
  const baseLayers = new Map((base?.layers || []).map(l => [l.id, new Set(l.blocks.flatMap(b => b.items.map(i => i.id)))]));
  return h("div", {class:"pma-arch"},
    ...v.layers.flatMap(l => pmArchLayer(l, diff, baseLayers)),
    v.aside ? pmArchCard(v.aside, diff, false) : null,
    h("div", {class:"pma-legend"}, [["m", "模型调用"], ["d", "确定性逻辑"], ["blue", "主要产出"], ["red", "强约束"], ["amber", "需人处理"]].map(([c, t]) => h("span", {class:`pma-lg pma-lg-${c}`}, t))));
}

/* ---------- 时序图（SVG；窄屏改成竖向步骤清单） ---------- */
const PMA_NS = "http://www.w3.org/2000/svg";
const pmaEl = (n, a = {}, t) => { const e = document.createElementNS(PMA_NS, n); for (const k in a) e.setAttribute(k, a[k]); if (t != null) e.textContent = t; return e; };
const pmaCw = ch => /[⺀-鿿＀-￯　-〿]/.test(ch) ? 1 : (/[A-Z0-9@#%&]/.test(ch) ? .66 : .56);
function pmaWrap(text, maxPx, fs) {
  const out = [], CJK = "\\u2e80-\\u9fff\\uff00-\\uffef\\u3000-\\u303f", re = new RegExp(`[${CJK}]|[^\\s${CJK}]+|\\s+`, "g");
  for (const para of String(text).split("\n")) {
    let line = "", w = 0;
    for (const t of para.match(re) || [""]) {
      const tw = [...t].reduce((a, c) => a + pmaCw(c) * fs, 0);
      if (w + tw > maxPx && line.trim()) { out.push(line.trimEnd()); line = ""; w = 0; if (/^\s+$/.test(t)) continue; }
      line += t; w += tw;
    }
    out.push(line.trimEnd());
  }
  return out;
}
function pmArchSequenceSvg(seq, diff) {
  const actors = seq.actors, COL = 150, PADX = 20, W = PADX * 2 + COL * actors.length, HEAD = 62, FS = 12.5, LH = 17;
  const X = id => PADX + COL * (actors.findIndex(a => a.id === id) + .5), svg = pmaEl("svg", {class:"pma-seq", role:"img", "aria-label":seq.title});
  const body = pmaEl("g"); svg.append(body);
  let y = HEAD + 16, n = 0;
  const hl = (g, x, y0, w, hgt, s) => { if (s !== "same") g.append(pmaEl("rect", {class:`pma-hl pma-hl-${s}`, x, y:y0, width:w, height:hgt, rx:5})); };
  for (const st of seq.steps) {
    const s = diff.status(`S:${seq.id}:${st.id}`);
    if (st.type === "phase") {
      y += 6; const g = pmaEl("g", {class:`pma-phaseband pma-hl-${s}`}); body.append(g);
      g.append(pmaEl("rect", {x:6, y:y - 14, width:W - 12, height:22, rx:6}), pmaEl("text", {x:16, y:y + 1}, st.text)); y += 26; continue;
    }
    if (st.type === "note") {
      const xs = st.over.map(X), x1 = Math.min(...xs) - COL * .45, x2 = Math.max(...xs) + COL * .45, lines = pmaWrap(st.text, x2 - x1 - 16, 11.5), hgt = lines.length * 15 + 10;
      const g = pmaEl("g", {class:`pma-note pma-hl-${s}`}); g.append(pmaEl("rect", {x:x1, y:y - 6, width:x2 - x1, height:hgt, rx:6}));
      lines.forEach((l, i) => g.append(pmaEl("text", {x:x1 + 8, y:y + 8 + i * 15}, l))); body.append(g); y += hgt + 10; continue;
    }
    n++;
    const f = X(st.from), t = X(st.to), g = pmaEl("g"), numFill = s === "same" ? "" : ` pma-num-${s}`;
    if (st.from === st.to) {
      const avail = Math.min(W - (f + 36) - 8, 330), lines = pmaWrap(st.text, avail, FS), hgt = Math.max(lines.length * LH, 30);
      hl(g, f + 28, y - 13, avail + 12, lines.length * LH + 4, s);
      g.append(pmaEl("path", {class:"pma-msg", d:`M${f} ${y}h26v${hgt - 10}h-26`}), pmaEl("path", {class:"pma-tip", d:`M${f} ${y + hgt - 10}l7-4v8z`}));
      lines.forEach((l, i) => g.append(pmaEl("text", {class:"pma-lab pma-halo", x:f + 34, y:y + 4 + i * LH}, l)));
      const nm = pmaEl("g", {class:`pma-num${numFill}`}); nm.append(pmaEl("circle", {cx:f - 12, cy:y, r:8}), pmaEl("text", {x:f - 12, y:y + 3.5, "text-anchor":"middle"}, n));
      g.append(nm); body.append(g); y += hgt + 14;
    } else {
      const x1 = Math.min(f, t), span = Math.max(f, t) - x1, maxw = Math.max(span - 16, Math.min(W - x1 - 12, 360)), lines = pmaWrap(st.text, Math.min(maxw, span > COL * 1.4 ? span - 20 : maxw), FS);
      const ly = y + (lines.length - 1) * LH + 9;
      hl(g, x1 + 4, y - 13, Math.min(maxw, W - x1 - 8) + 12, lines.length * LH + 2, s);
      lines.forEach((l, i) => g.append(pmaEl("text", {class:"pma-lab pma-halo", x:x1 + 10, y:y + i * LH}, l)));
      g.append(pmaEl("line", {class:`pma-msg${st.ret ? " pma-ret" : ""}`, x1:f, y1:ly, x2:t, y2:ly}), pmaEl("path", {class:`pma-tip${st.ret ? " pma-ret" : ""}`, d:`M${t} ${ly}l${t > f ? -8 : 8} -4v8z`}));
      const nx = f + (t > f ? -13 : 13), nm = pmaEl("g", {class:`pma-num${numFill}`}); nm.append(pmaEl("circle", {cx:nx, cy:ly, r:8}), pmaEl("text", {x:nx, y:ly + 3.5, "text-anchor":"middle"}, n));
      g.append(nm); body.append(g); y = ly + 16;
    }
  }
  const H = y + 20, under = pmaEl("g");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  actors.forEach(a => {
    const x = X(a.id), s = diff.status(`A:${seq.id}:${a.id}`), g = pmaEl("g", {class:`pma-actor ${a.c || ""} pma-hl-${s}`});
    under.append(pmaEl("line", {class:"pma-life", x1:x, y1:HEAD, x2:x, y2:H - 6}));
    g.append(pmaEl("rect", {x:x - COL / 2 + 8, y:8, width:COL - 16, height:HEAD - 18, rx:8}), pmaEl("text", {class:"pma-aname", x, y:30, "text-anchor":"middle"}, a.name));
    if (a.sub) g.append(pmaEl("text", {class:"pma-asub", x, y:46, "text-anchor":"middle"}, a.sub));
    under.append(g);
  });
  svg.insertBefore(under, body);
  return svg;
}
/** 手机：同一张图的竖向步骤清单。 */
function pmArchSequenceList(seq, diff) {
  const name = id => seq.actors.find(a => a.id === id)?.name || id;
  let n = 0;
  return h("ol", {class:"pma-steps"}, seq.steps.map(st => {
    const s = diff.status(`S:${seq.id}:${st.id}`), before = s === "changed" ? diff.before(`S:${seq.id}:${st.id}`) : null;
    if (st.type === "phase") return h("li", {class:`pma-step pma-step-phase pma-diff-${s}`}, st.text, pmArchBadge(s));
    if (st.type === "note") return h("li", {class:`pma-step pma-step-note pma-diff-${s}`}, h("span", {class:"pma-who"}, `备注 · ${st.over.map(name).join(" / ")}`), st.text, pmArchBadge(s));
    n++;
    return h("li", {class:`pma-step pma-diff-${s}`, value:n},
      h("span", {class:"pma-who"}, st.from === st.to ? `${name(st.from)}（自身）` : `${name(st.from)} ${st.ret ? "⇢" : "→"} ${name(st.to)}`, pmArchBadge(s)),
      st.text, before ? h("details", {class:"pma-before"}, h("summary", {}, "看改前"), h("div", {class:"pma-before-body"}, before.text)) : null);
  }));
}
function pmArchSequence(seq, diff) {
  return h("div", {class:"pma-seqblock"}, h("p", {class:"muted small"}, seq.lead),
    h("div", {class:"pma-seqwrap"}, pmArchSequenceSvg(seq, diff)), pmArchSequenceList(seq, diff));
}

/* ---------- 页面 ---------- */
function pmArchToolbar(d, a, versions) {
  const latest = a.meta.latest, older = a.meta.versions.filter(v => v.id !== latest);
  const canCompare = older.length > 0;
  const base = a.base && older.some(v => v.id === a.base) ? a.base : older.at(-1)?.id || null;
  return h("div", {class:"pma-toolbar"},
    h("div", {class:"pma-ver"}, h("strong", {}, `当前版本 ${latest}`), h("span", {class:"muted small"}, ` · ${a.meta.versions.at(-1).date} · ${a.meta.versions.at(-1).title}`)),
    h("div", {class:"pma-compare"},
      h("label", {class:"pm-switch"}, h("input", {type:"checkbox", class:"pma-compare-switch", checked:a.compare && canCompare, disabled:!canCompare, onchange: e => { a.compare = e.target.checked; if (a.compare) { a.base = base; void pmArchLoadVersion(d, base); } renderPublicMemory(); }}), " 对比模式"),
      canCompare ? (a.compare ? h("label", {class:"pma-base"}, h("span", {class:"muted small"}, "相对于"),
        h("select", {class:"pma-base-select", "aria-label":"对比的旧版本", onchange: e => { a.base = e.target.value; void pmArchLoadVersion(d, a.base); renderPublicMemory(); }},
          older.slice().reverse().map(v => h("option", {value:v.id, selected:v.id === base}, `${v.id} · ${v.date} · ${v.title}`)))) : null)
        : h("span", {class:"muted small"}, "目前只有一个版本，记忆应用下次改动后就能对比")));
}
function pmArchSummary(a, diff, head, baseV) {
  const meta = a.meta.versions.find(v => v.id === head.id);
  const c = diff.counts, none = !c.added && !c.changed && !c.removed;
  return h("section", {class:"pma-summary pm-add pm-settings-card", "aria-label":"本版改动"},
    h("div", {class:"pm-row"}, h("strong", {}, a.compare && baseV ? `${baseV.id} → ${head.id} 的改动点` : `${head.id} 说明`),
      a.compare && baseV ? h("span", {class:"pma-counts"}, [["added", c.added], ["changed", c.changed], ["removed", c.removed]].map(([k, n]) => h("span", {class:`pma-badge pma-badge-${k}`}, `${PM_DIFF_LABEL[k]} ${n}`))) : null),
    h("ul", {class:"pma-notes"}, (meta?.notes || []).map(x => h("li", {}, x))),
    a.compare && baseV ? (none ? h("p", {class:"muted small"}, "这两版的图一致（只有说明或代码上的变化）。") : h("ul", {class:"pma-changes"}, diff.list.map(x => h("li", {class:`pma-diff-${x.kind}`}, h("span", {class:`pma-badge pma-badge-${x.kind}`}, PM_DIFF_LABEL[x.kind]), ` ${x.label}`)))) : null);
}
function renderPmArch(d) {
  const a = pmArchState(d);
  if (!a.meta && !a.loading && !a.tried) queueMicrotask(() => void pmArchLoadMeta(d));
  const latest = a.meta?.latest, head = latest ? a.versions[latest] : null;
  if (latest && !head) queueMicrotask(() => void pmArchLoadVersion(d, latest));
  if (head) pmArchMarkSeen(latest);
  const baseId = a.compare ? (a.base && a.meta.versions.some(v => v.id === a.base && v.id !== latest) ? a.base : a.meta.versions.filter(v => v.id !== latest).at(-1)?.id) : null;
  const baseV = baseId ? a.versions[baseId] : null;
  if (baseId && !baseV) queueMicrotask(() => void pmArchLoadVersion(d, baseId));
  const diff = pmArchDiff(a.compare ? head : null, a.compare ? baseV : null);
  const tabs = h("div", {class:"pm-viewbar"}, h("div", {class:"pm-tabs pm-viewtabs pma-tabs", role:"tablist", "aria-label":"架构图视图",
    onkeydown: ev => { const i = PM_ARCH_VIEWS.findIndex(x => x[0] === a.view), step = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0; if (!step) return; ev.preventDefault(); a.view = PM_ARCH_VIEWS[(i + step + PM_ARCH_VIEWS.length) % PM_ARCH_VIEWS.length][0]; renderPublicMemory(); }},
    PM_ARCH_VIEWS.map(([v, label]) => h("button", {type:"button", role:"tab", "aria-selected":String(a.view === v), tabindex:a.view === v ? "0" : "-1", onclick:() => { a.view = v; renderPublicMemory(); }}, label))));
  const seq = head?.sequences?.find(s => s.id === a.view);
  const loading = !head || (a.compare && baseId && !baseV);
  d.root.replaceChildren(h("div", {class:"pi-memory-panel pm-settings-page pma-page"},
    h("header", {class:"pi-memory-head"},
      h("a", {class:"settings-back pm-settings-back", href:"#/memory", "aria-label":"返回平台记忆"}, "‹ 返回"),
      h("div", {class:"pi-memory-heading"}, h("h1", {}, "记忆架构"))),
    a.error ? h("p", {role:"alert", class:"pi-memory-notice warn-text"}, a.error) : null,
    a.meta ? pmArchToolbar(d, a) : null,
    tabs,
    h("div", {class:"pm-settings-body pma-body"},
      loading ? h("p", {class:"muted small", role:"status"}, a.error ? "" : "正在读取…")
        : [pmArchSummary(a, diff, head, baseV), seq ? pmArchSequence(seq, diff) : pmArchDiagram(head, diff, baseV)])));
}
window.piRouteModules?.register("memory-architecture", {});
