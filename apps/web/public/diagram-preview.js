"use strict";
/*
 * 消息里的图表预览：SVG 文件、```mermaid / ```plantuml 代码块、.mmd / .puml 文件。
 * 消息里直接显示缩略图，点击进入图片查看器（image-zoom.js，可缩放、拖动）。
 *
 * 渲染都得到一段 SVG 文本，之后只当图片（blob:）显示，从不把 SVG 放进控制台页面的 DOM：
 * - SVG 文件：读文件内容（/file-preview），规整尺寸与背景后转成图片。
 * - Mermaid：在隐藏的隔离 iframe（sandbox、不同源、不能联网）里渲染，见 diagram-render.ts。
 * - PlantUML：服务端用本机 Java 渲染（/api/diagrams/plantuml）；没装时退回显示源码。
 */
const DIAGRAM_LABEL = { svg: "SVG", mermaid: "Mermaid", plantuml: "PlantUML" };
const DIAGRAM_SOURCE_MAX = 100000;
const DIAGRAM_CACHE_MAX = 80;
const DIAGRAM_ZOOM_TARGET = 1600;
const DIAGRAM_SVG_NS = "http://www.w3.org/2000/svg";

/** 代码块语言 → 图表类型；SVG 代码块必须真的以 <svg 开头 */
function diagramKindForLang(lang, source) {
  const l = String(lang || "").toLowerCase(), text = String(source || "");
  if (l === "mermaid" || l === "mmd") return "mermaid";
  if (l === "plantuml" || l === "puml") return "plantuml";
  if (l === "svg" && /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) return "svg";
  if (!l || l === "text" || l === "txt") { if (/^\s*@start(?:uml|mindmap|gantt|salt|json|yaml|wbs)\b/i.test(text)) return "plantuml"; }
  return null;
}
function diagramKindForPath(path) {
  const ext = (String(path || "").split(".").pop() || "").toLowerCase();
  if (ext === "svg") return "svg";
  if (ext === "mmd" || ext === "mermaid") return "mermaid";
  if (["puml", "plantuml", "pu", "iuml", "wsd"].includes(ext)) return "plantuml";
  return null;
}

/* ------------------------------ SVG 文本 → 可显示的图片 ------------------------------ */

function diagramLength(value) {
  const m = /^\s*(\d+(?:\.\d+)?)(?:px)?\s*$/.exec(value || "");
  return m ? Number(m[1]) : NaN;
}
/**
 * 规整 SVG：补 viewBox 和明确的宽高（否则在 <img> 里尺寸不定）、垫一层白底（透明背景在深色下看不见）、去掉脚本。
 * 返回 { width, height, thumbUrl, zoomUrl() }；zoomUrl 按需生成一份放大尺寸的版本，放大查看时矢量图不糊。
 */
function diagramPrepare(svgText) {
  const text = String(svgText || "");
  if (!text.trim()) throw new Error("图片内容为空");
  const doc = new DOMParser().parseFromString(text, "image/svg+xml"), root = doc.documentElement;
  if (!root || root.localName !== "svg" || doc.getElementsByTagName("parsererror").length) throw new Error("不是有效的 SVG");
  for (const node of [...root.getElementsByTagName("script")]) node.remove();
  const box = (root.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  let x = 0, y = 0, width, height;
  if (box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) [x, y, width, height] = box;
  else {
    width = diagramLength(root.getAttribute("width")); height = diagramLength(root.getAttribute("height"));
    if (!(width > 0) || !(height > 0)) { width = 300; height = 150; }
    root.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }
  root.removeAttribute("style");
  if (!root.getAttribute("xmlns")) root.setAttribute("xmlns", DIAGRAM_SVG_NS);
  const backdrop = doc.createElementNS(DIAGRAM_SVG_NS, "rect");
  for (const [k, v] of Object.entries({ x, y, width, height, fill: "#ffffff" })) backdrop.setAttribute(k, String(v));
  root.insertBefore(backdrop, root.firstChild);
  const serialize = (w, h) => {
    root.setAttribute("width", String(Math.round(w))); root.setAttribute("height", String(Math.round(h)));
    return URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(root)], { type: "image/svg+xml" }));
  };
  const thumbUrl = serialize(width, height);
  let zoom;
  const scale = Math.min(8, Math.max(1, DIAGRAM_ZOOM_TARGET / Math.max(width, height)), 6000 / Math.max(width, height));
  return { width, height, thumbUrl, zoomUrl() { return zoom ||= scale === 1 ? thumbUrl : serialize(width * scale, height * scale); } };
}

/* ------------------------------ Mermaid：隔离 iframe ------------------------------ */

let diagramFrame = null, diagramFrameReady = null, diagramFrameWake = null, diagramJobSeq = 0;
const diagramJobs = new Map();
window.addEventListener("message", (ev) => {
  const data = ev.data;
  if (!diagramFrame || ev.source !== diagramFrame.contentWindow || !data) return;
  if (data.type === "ready") diagramFrameWake?.(diagramFrame);
  else if (data.type === "result") {
    const job = diagramJobs.get(data.id);
    if (!job) return;
    diagramJobs.delete(data.id); clearTimeout(job.timer);
    if (typeof data.svg === "string") job.resolve(data.svg); else job.reject(new Error(data.error || "Mermaid 渲染失败"));
  }
});
function diagramMermaidFrame() {
  if (diagramFrameReady) return diagramFrameReady;
  diagramFrameReady = new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.className = "diagram-frame"; frame.title = "Mermaid 渲染"; frame.tabIndex = -1;
    frame.setAttribute("aria-hidden", "true"); frame.setAttribute("sandbox", "allow-scripts");
    const timer = setTimeout(() => { frame.remove(); diagramFrame = diagramFrameReady = diagramFrameWake = null; reject(new Error("Mermaid 渲染器加载超时")); }, 30000);
    diagramFrameWake = (f) => { clearTimeout(timer); resolve(f); };
    diagramFrame = frame; frame.src = "/api/diagrams/mermaid-frame";
    document.body.append(frame);
  });
  return diagramFrameReady;
}
async function diagramMermaid(source) {
  const frame = await diagramMermaidFrame(), id = String(++diagramJobSeq);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { diagramJobs.delete(id); reject(new Error("Mermaid 渲染超时")); }, 20000);
    diagramJobs.set(id, { resolve, reject, timer });
    frame.contentWindow.postMessage({ type: "render", id, source }, "*");
  });
}

async function diagramPlantuml(source) {
  try {
    const result = await api("/api/diagrams/plantuml", { method: "POST", body: JSON.stringify({ source }) });
    return result.svg;
  } catch (error) {
    // 没装 PlantUML 是服务器配置问题，给一句能照着做的话
    if (error?.status === 501) error.message = "服务器没有安装 PlantUML（需要 Java 和 plantuml.jar），已显示源码";
    throw error;
  }
}

/* ------------------------------ 渲染入口与缓存 ------------------------------ */

const diagramCache = new Map();
function diagramKey(kind, source) { return `${kind}\0${source}`; }
/** 同一份源码只渲染一次；渲染好的结果可同步取回，消息重绘时缩略图不闪 */
function diagramCached(kind, source) { return diagramCache.get(diagramKey(kind, source))?.value; }
function diagramRender(kind, source) {
  const key = diagramKey(kind, source), hit = diagramCache.get(key);
  if (hit) { diagramCache.delete(key); diagramCache.set(key, hit); return hit.promise; }
  const entry = { value: undefined, promise: null };
  entry.promise = (async () => {
    if (source.length > DIAGRAM_SOURCE_MAX) throw new Error("图表源码过长，不预览");
    const svg = kind === "svg" ? source : kind === "mermaid" ? await diagramMermaid(source) : await diagramPlantuml(source);
    return diagramPrepare(svg);
  })();
  entry.promise.then((value) => { entry.value = value; }, () => { if (diagramCache.get(key) === entry) diagramCache.delete(key); });
  diagramCache.set(key, entry);
  for (const [oldKey, old] of diagramCache) {
    if (diagramCache.size <= DIAGRAM_CACHE_MAX) break;
    diagramCache.delete(oldKey);
    old.value && URL.revokeObjectURL(old.value.thumbUrl);
  }
  return entry.promise;
}
function diagramErrorText(kind, error) {
  const message = String(error?.message || error || "").split("\n")[0].slice(0, 160);
  return error?.status === 501 ? message : `${DIAGRAM_LABEL[kind]} 图未能渲染${message ? `：${message}` : ""}，已显示源码`;
}

/* ------------------------------ 放大查看 ------------------------------ */

/** 可点开的缩略图 → 渲染结果；同一条消息里的其他图表可以左右切换 */
const diagramEntries = new WeakMap();
function diagramOpenZoom(trigger) {
  if (typeof openImageZoom !== "function") return;
  const scope = trigger.closest(".rt-row,.room-bubble,.file-preview-doc,.file-preview-body") || document;
  const buttons = [...scope.querySelectorAll("[data-diagram-zoom]")].filter((b) => diagramEntries.has(b));
  if (!buttons.includes(trigger)) buttons.push(trigger);
  const items = buttons.map((b) => { const e = diagramEntries.get(b); return { src: e.result.zoomUrl(), name: e.name }; });
  openImageZoom(items, buttons.indexOf(trigger));
  // 文件预览浮层是模态的（顶层），放大查看器要放进它里面才看得见
  const host = trigger.closest("dialog"), overlay = document.querySelector("body > .image-zoom");
  if (host && overlay) host.append(overlay);
}
function diagramKeepBottom(node) {
  const box = node.closest?.(".rt-transcript");
  if (box && typeof ui !== "undefined" && ui.rt?.atBottom) box.scrollTop = box.scrollHeight;
}

/* ------------------------------ 代码块：```mermaid ``` ------------------------------ */

/**
 * 图表代码块：缩略图 + 「源码」「复制」。渲染失败（语法错误、没装 PlantUML）退回普通代码块并说明原因。
 * fallback(source) 返回普通代码块节点；生成中的消息（opts.streaming）不渲染，等消息完整再出图。
 */
function diagramBlock(kind, source, lang, opts = {}) {
  const fallback = () => opts.fallback(source);
  if (opts.streaming) return fallback();
  const label = DIAGRAM_LABEL[kind];
  const box = h("div", { class: "diagram-card", "data-diagram-kind": kind, "data-state": "loading" });
  const show = (result) => {
    const img = h("img", { src: result.thumbUrl, alt: `${label} 图`, decoding: "async", draggable: "false" });
    const thumb = h("button", { type: "button", class: "diagram-thumb", "data-diagram-zoom": "", "aria-label": `放大查看 ${label} 图`, title: "点击放大查看", onclick: (ev) => diagramOpenZoom(ev.currentTarget) }, img);
    diagramEntries.set(thumb, { result, name: `${label} 图` });
    const code = h("pre", { class: "diagram-source", hidden: true }, h("code", {}, source));
    const toggle = h("button", { type: "button", class: "rt-copy-btn diagram-source-toggle", "aria-expanded": "false", onclick: () => {
      const open = code.hidden; code.hidden = !open; toggle.setAttribute("aria-expanded", String(open)); toggle.textContent = open ? "收起源码" : "源码";
    } }, "源码");
    const copy = typeof rtCopyButton === "function" ? rtCopyButton(source, "复制", { announce: "已复制图表源码" }) : null;
    box.className = "diagram-card rt-codeblock"; box.dataset.state = "ready";
    box.replaceChildren(h("div", { class: "rt-codeblock-head" }, h("span", {}, `${label} 图`), h("span", { class: "diagram-actions" }, toggle, copy)), thumb, code);
    if (img.complete) diagramKeepBottom(box); else img.addEventListener("load", () => diagramKeepBottom(box), { once: true });
  };
  const failed = (error) => {
    box.dataset.state = "failed"; box.className = "diagram-card failed";
    box.replaceChildren(h("p", { class: "diagram-note", role: "status" }, diagramErrorText(kind, error)), fallback());
  };
  const cached = diagramCached(kind, source);
  if (cached) { show(cached); return box; }
  box.append(h("div", { class: "rt-codeblock" }, h("div", { class: "rt-codeblock-head" }, h("span", {}, `${label} 图`)), h("p", { class: "diagram-status muted small", role: "status" }, "正在渲染…")));
  diagramRender(kind, source).then(show, failed);
  return box;
}

/* ------------------------------ 文件引用：.svg / .mmd / .puml 的缩略图胶囊 ------------------------------ */

/**
 * 文件引用胶囊的图表版本：读到文件并渲染出来后，胶囊里直接显示缩略图，点击放大查看；
 * 读不到 / 渲染不了（文件过大、语法错误、没装 PlantUML）就当普通文件胶囊，点击走文件预览。
 * 只有能定位文件所属会话 / 群聊的消息才会读文件。
 */
function diagramFileChip(reference, context, kind) {
  const type = fileType(reference.path), name = reference.path.split("/").pop(), label = reference.label || name;
  const base = fileBase(context);
  const placeholder = h("span", { class: "file-chip-thumb", "aria-hidden": "true" }, fileIcon(type));
  const chip = h("button", { type: "button", class: "file-chip file-chip-diagram", "data-file-type": type, "data-file-path": reference.path, "data-diagram-state": "idle", title: reference.path, "aria-label": `预览 ${label}：${reference.path}` },
    placeholder, h("span", { class: "file-chip-label" }, label), reference.line ? h("span", { class: "file-chip-line" }, `:${reference.line}`) : null);
  let loading = null;
  const load = () => loading ||= (async () => {
    chip.dataset.diagramState = "loading";
    const query = new URLSearchParams({ path: reference.path, ...(context?.memberId ? { memberId: context.memberId } : {}) });
    const data = await api(`${base}/file-preview?${query}`);
    if (data.mode !== "text" || data.truncated) throw new Error("文件无法作为图表预览");
    const result = await diagramRender(kind, data.text);
    const img = h("img", { src: result.thumbUrl, alt: label, decoding: "async", draggable: "false" });
    placeholder.replaceChildren(img); placeholder.classList.add("ready");
    diagramEntries.set(chip, { result, name });
    chip.setAttribute("data-diagram-zoom", ""); chip.dataset.diagramState = "ready";
    chip.setAttribute("aria-label", `放大查看 ${label}：${reference.path}`);
    if (img.complete) diagramKeepBottom(chip); else img.addEventListener("load", () => diagramKeepBottom(chip), { once: true });
    return result;
  })().catch(() => { chip.dataset.diagramState = "failed"; chip.classList.remove("file-chip-diagram"); return null; });
  chip.addEventListener("click", async (ev) => {
    const trigger = ev.currentTarget;
    const result = await load();
    if (result) diagramOpenZoom(trigger); else openFilePreview(reference, context, trigger);
  });
  // 进入视野才读文件：长对话里不会一次读完所有被提到的图
  if (typeof IntersectionObserver === "function") {
    const watcher = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { watcher.disconnect(); void load(); } }, { rootMargin: "300px" });
    watcher.observe(chip);
  } else void load();
  return chip;
}
