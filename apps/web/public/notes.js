/* ------------------------------ 待办记录：大备忘录 ------------------------------ */
// 一级导航进入后就是一张按时间顺序的备忘录：每次记下一个「小想法」，
// 新的排在最上面，按日期分组。内容存在控制台数据目录（notes.json），
// 换浏览器、换设备打开同一个控制台都能看到。
// 除了文字，还可以粘贴图片或从相册/文件里选图；每条记录可以标记完成。

const NOTE_WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
const NOTE_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";
const NOTE_IMAGE_KINDS = ["image/png", "image/jpeg", "image/webp"];
const NOTE_MAX_IMAGES = 9;
const NOTE_IMAGE_MAX_BYTES = 10 * 1024 ** 2;
// 与对话附件同一套压缩口径：超过阈值的大图先在浏览器里缩到长边 1600、尽量压到 640 KB 再上传。
const NOTE_IMAGE_MAX_SIDE = 1600, NOTE_IMAGE_TARGET_BYTES = 640 * 1024, NOTE_IMAGE_REENCODE_BYTES = 400 * 1024;
const NOTE_IMAGE_QUALITY_MIN = 0.5, NOTE_IMAGE_QUALITY_MAX = 0.86;
// 待办页一次取多少条；滚动到底部自动续读更早的一页（与会话记录同一节奏）。
const NOTE_PAGE_SIZE = 50;
// 标记完成：先给正文划线，延迟 3 秒才从「未完成」筛选移走；期间再点一次撤销，恢复原样。
const NOTE_DONE_DELAY_MS = 3000;
const noteDoneRemoval = new Map();
const noteDoneDeadline = new Map();
const noteDoneVersion = new Map();

/** 分组用的日期标题：今天／昨天用相对说法，其余给完整日期（一律北京时间） */
function noteDayLabel(iso) {
  const d = noteValid(iso);
  if (!d) return iso || "时间未知";
  const parts = noteBeijingParts(d);
  const todayKey = noteBeijingDateKey(new Date());
  const dateKey = noteBeijingDateKey(d);
  const day = `${parts.year} 年 ${parts.month} 月 ${parts.day} 日 · 周${NOTE_WEEKDAY[parts.weekday]}`;
  if (dateKey === todayKey) return `今天 · ${day}`;
  const yesterday = new Date(Date.parse(`${todayKey}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  if (dateKey === yesterday) return `昨天 · ${day}`;
  return day;
}

/** 只显示时分；完整时刻放在 title 里（北京时间） */
function noteClock(iso) {
  const d = noteValid(iso);
  if (!d) return iso || "";
  const parts = noteBeijingParts(d);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

/* ------------------------------ 待办日程 ------------------------------ */
// 待办记录不再提供「安排时间」入口；已有 schedule 的记录仍由日历视图只读展示。

function noteImageItems(images) {
  return (images || []).map((image) => ({ image, name: image.name, state: "ready", error: "" }));
}

/** Intake first preserves the draft; a confirmed quick action starts upload. */
function noteImportImage({ intakeId, file, source }) {
  const items = ui.notesImages || (ui.notesImages = []);
  if (items.some(item => item.intakeId === intakeId)) return true;
  if (ui.notesBusy || !file || !file.size || !NOTE_IMAGE_KINDS.includes(file.type) || file.size > NOTE_IMAGE_MAX_BYTES || items.length >= NOTE_MAX_IMAGES) return false;
  items.push({ intakeId, source, file, name: file.name || "截图.png", state: "local", error: "", preview: URL.createObjectURL(file) });
  ui.notesDraftRevision = (ui.notesDraftRevision || 0) + 1;
  ui.notesComposerOpen = true;
  noteRenderCurrent();
  return true;
}
/** A confirmed intake action uploads an attachment without creating a note. */
async function noteUploadIntake(intakeId) {
  const item = (ui.notesImages || []).find(i => i.intakeId === intakeId);
  if (!item || item.state === 'ready') return true;
  if (item.uploadFlight) return item.uploadFlight;
  const epoch = noteOperationEpoch;
  item.state = 'uploading'; item.error = ''; noteRenderCurrent();
  item.uploadFlight = (async () => {
    try {
      await window.imageIntake?.beforeSave?.([intakeId]);
      if (epoch !== noteOperationEpoch || !(ui.notesImages || []).includes(item)) return false;
      await noteUploadOne(item, item.file);
      return epoch === noteOperationEpoch && item.state === 'ready';
    } catch (error) {
      if (epoch === noteOperationEpoch) { item.state = 'failed'; item.error = error.message || '图片上传失败，请保存时重试'; noteRenderCurrent(); }
      return false;
    } finally { item.uploadFlight = null; }
  })();
  return item.uploadFlight;
}
function noteReleaseLocalImage(item) {
  if (item.preview?.startsWith("blob:")) URL.revokeObjectURL(item.preview);
  item.preview = ""; item.file = null;
}
function noteCancelIntake(intakeId) {
  if (ui.notesBusy) return;
  const items = ui.notesImages || [];
  for (const item of [...items]) if (item.intakeId === intakeId) {
    noteReleaseLocalImage(item); items.splice(items.indexOf(item), 1);
  }
  ui.notesDraftRevision = (ui.notesDraftRevision || 0) + 1;
  void window.imageIntake?.cancelled(intakeId);
  noteRenderCurrent();
}
function noteDraftHasImage(items) { return (items || []).some(i => i.state === 'ready' || !!i.file); }
function noteDraftBlocked(items) { return (items || []).some(i => i.state === 'failed' && !i.file); }

function noteDraftReadyIds(items) {
  return (items || []).filter((i) => i.state === "ready" && i.image).map((i) => i.image.id);
}

function noteDraftBusy(items) {
  return (items || []).some((i) => i.state === "uploading");
}

function noteDraftFailed(items) {
  return (items || []).some((i) => i.state === "failed");
}

/** 命中返回已存图片的新条目；未命中、出错一律返回 null，交给正常上传。 */
async function noteReuseImage(sha256) {
  if (!sha256) return null;
  try {
    const res = await fetch("/api/notes/images/reuse", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha256 }) });
    if (!res.ok) return null;
    const meta = await res.json();
    return meta?.reused === true && /^img-[a-f0-9]{32}$/.test(meta.id || "") ? meta : null;
  } catch { return null; }
}

/** 上传一张待办图片：大图先在浏览器里重编码压缩，再传字节。 */
async function noteUploadOne(item, file) {
  const epoch = noteOperationEpoch;
  item.state = "uploading"; item.error = "";
  noteRenderCurrent();
  try {
    let body = file, name = file.name || "粘贴图片";
    // 同对话附件：不管大小都先转成 WebP，避免同一批图片格式不一。
    // 同时按原文件哈希问一下「这张传过没有」：命中就直接用，不再传字节。
    const encoding = file.type !== "image/webp" ? noteReencodeImage(file) : Promise.resolve(null);
    const sourceHash = typeof rtImageSourceHash === "function" ? await rtImageSourceHash(file) : "";
    const hit = await noteReuseImage(sourceHash);
    if (hit) {
      if (epoch !== noteOperationEpoch) return;
      const { reused: _r, ...image } = hit;
      if (item.preview?.startsWith("blob:")) URL.revokeObjectURL(item.preview);
      item.image = image; item.state = "ready"; item.preview = ""; item.name = image.name;
      noteRenderCurrent(); return;
    }
    const re = await encoding;
    if (re) { body = re.blob; name = re.name; }
    if (epoch !== noteOperationEpoch) return;
    const res = await fetch(`/api/notes/images?name=${encodeURIComponent(name)}`, {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": body.type || file.type || "application/octet-stream", ...(sourceHash ? { "x-source-sha256": sourceHash } : {}) }, body
    });
    let meta = {};
    try { meta = await res.json(); } catch { meta = {}; }
    if (!res.ok) {
      if (res.status === 401) { if (typeof sessionCachesClear === "function") sessionCachesClear(); window.sessionNotifications?.noteAuthFailure?.("note-upload"); }
      throw new Error(meta.error || `上传失败（${res.status}）`);
    }
    if (epoch !== noteOperationEpoch) return;
    if (item.preview?.startsWith("blob:")) URL.revokeObjectURL(item.preview);
    item.image = meta; item.state = "ready"; item.preview = "";
    if (meta && meta.name) item.name = meta.name;
  } catch (e) {
    if (epoch !== noteOperationEpoch) return;
    item.state = "failed"; item.error = e.message || "上传失败";
  }
  noteRenderCurrent();
}

function noteFilePreview(file) {
  return new Promise((resolve) => {
    if (typeof FileReader !== "function") return resolve("");
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}

/* 大图重编码（与 runtime-attachments.js 同一口径）：先缩到长边 1600，再取预算内最高质量。
   浏览器解码宽松，手机相册的原图可能很大；先压小可省上行，也让记录的预览图不再动辄几 MB。 */
function noteCanvasBlob(bitmap, width, height, type, quality) {
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const g = canvas.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, width, height); g.drawImage(bitmap, 0, 0, width, height);
  return new Promise((res) => canvas.toBlob(res, type, quality));
}

async function noteEncodeImage(bitmap, width, height) {
  const probe = await noteCanvasBlob(bitmap, width, height, "image/webp", NOTE_IMAGE_QUALITY_MAX);
  const type = probe && probe.type === "image/webp" ? "image/webp" : "image/jpeg";
  let best = type === "image/webp" ? probe : await noteCanvasBlob(bitmap, width, height, type, NOTE_IMAGE_QUALITY_MAX);
  if (best && best.size <= NOTE_IMAGE_TARGET_BYTES) return { blob: best, type };
  let lo = NOTE_IMAGE_QUALITY_MIN, hi = NOTE_IMAGE_QUALITY_MAX, fitting = null;
  for (let i = 0; i < 5 && hi - lo > 0.04; i++) {
    const q = (lo + hi) / 2, mid = await noteCanvasBlob(bitmap, width, height, type, q);
    if (!mid) break;
    if (mid.size <= NOTE_IMAGE_TARGET_BYTES) { fitting = mid; lo = q; } else hi = q;
  }
  if (fitting) return { blob: fitting, type };
  const floor = await noteCanvasBlob(bitmap, width, height, type, NOTE_IMAGE_QUALITY_MIN);
  if (floor && best && floor.size < best.size) best = floor;
  return best ? { blob: best, type } : null;
}

async function noteReencodeImage(file) {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, NOTE_IMAGE_MAX_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale)), hgt = Math.max(1, Math.round(bmp.height * scale));
    const encoded = await noteEncodeImage(bmp, w, hgt);
    if (!encoded) return null;
    const name = (file.name || "图片").replace(/\.[a-zA-Z0-9]{1,12}$/, "") + (encoded.type === "image/webp" ? ".webp" : ".jpg");
    return { blob: encoded.blob, name, type: encoded.type, width: w, height: hgt };
  } catch { return null; } finally { bmp?.close?.(); }
}

/** 把选中的 / 粘贴的图片加入草稿并开始上传；返回是否全部被接受。 */
function noteAddFiles(items, files) {
  const list = files || [];
  let added = 0;
  for (const file of list) {
    if (!file) continue;
    if (!NOTE_IMAGE_KINDS.includes(file.type)) { announce("只支持 PNG、JPEG、WebP 图片"); continue; }
    if (file.size > NOTE_IMAGE_MAX_BYTES) { announce("单张图片不能超过 10 MiB"); continue; }
    if (items.length + added >= NOTE_MAX_IMAGES) { announce(`一条记录最多 ${NOTE_MAX_IMAGES} 张图片`); break; }
    const item = {
      localId: `ni-${items.length}-${Date.now()}-${added}`,
      name: file.name || "粘贴图片", preview: "", state: "uploading", error: "", image: null
    };
    items.push(item);
    added++;
    // 大图不再读成 data URL（对比原图加倍占内存）；上传压缩完直接显示服务端缩略图。
    if (file.size <= NOTE_IMAGE_REENCODE_BYTES) void noteFilePreview(file).then((preview) => { item.preview = preview; noteRenderCurrent(); });
    void noteUploadOne(item, file);
  }
  if (added) noteRenderCurrent();
  return added > 0;
}

function noteDropImage(items, ev) {
  const files = Array.from(ev.dataTransfer?.files || []).filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  ev.preventDefault();
  noteAddFiles(items, files);
}

/** 粘贴：剪贴板里有图片就上传，同时保留其中的文字 */
function notePaste(items, ev) {
  const files = Array.from(ev.clipboardData?.files || []).filter((f) => NOTE_IMAGE_KINDS.includes(f.type));
  if (!files.length) return;
  ev.preventDefault();
  const text = ev.clipboardData?.getData?.("text/plain") || "";
  const el = ev.target;
  if (text && el && typeof el.setRangeText === "function") {
    const start = el.selectionStart ?? el.value.length, end = el.selectionEnd ?? start;
    el.setRangeText(text, start, end, "end");
    ui.notesDraft = el.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  noteAddFiles(items, files);
}

function notePreviewImage(image) {
  noteOpenImages([{ src: noteImageUrl(image), name: image.name }], 0);
}

function noteDraftSrc(item) {
  return item.state === "ready" && item.image ? noteImageUrl(item.image) : (item.preview || "");
}

/** 草稿 / 编辑里的图片也能点开放大：已上传看原图，上传中看本地预览 */
function notePreviewDraft(items, item) {
  const view = (items || []).filter((it) => noteDraftSrc(it)).map((it) => ({ src: noteDraftSrc(it), name: it.name, ref: it }));
  const index = view.findIndex((v) => v.ref === item);
  if (index >= 0) noteOpenImages(view, index);
}

/** 会话图标：与一级导航「会话」（原「对话」）同一个气泡样式——气泡轮廓 + 三个点。
    用 SVG 而不是纯色块，是为了让人一眼认出这是会话，不是普通标签。 */
function noteSessionIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ class: "note-session-icon", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  const bubble = document.createElementNS(ns, "path");
  bubble.setAttribute("d", "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z");
  const dots = document.createElementNS(ns, "path");
  dots.setAttribute("d", "M8.5 10h.01M12 10h.01M15.5 10h.01");
  svg.append(bubble, dots);
  return svg;
}

/** 一条待办关联的会话：从这条记录发起的会话会记下它（一个待办可以关联多个会话）。点进去就跳到对应会话。 */
function noteSessionLinks(sessions, relationItem) {
  const list = Array.isArray(sessions) ? sessions.filter((s) => s && s.platformSessionId) : [];
  if (!list.length && !relationItem) return null;
  // 不再写「关联会话」标签：每个标签前的会话图标本身就说明这是会话而不是普通标签
  return h("div", { class: "note-sessions", role: "group", "aria-label": list.length > 1 ? `关联 ${list.length} 个会话` : "关联会话" },
    h("ul", { class: "note-sessions-list" }, relationItem, list.map((s) =>
      h("li", { class: "note-session-item" },
        h("a", { class: "note-session-link", href: s.href || `#/rt/${encodeURIComponent(s.platformSessionId)}`, title: `查看会话：${s.title || s.platformSessionId}` },
          noteSessionIcon(),
          h("span", { class: "note-session-title" }, s.title || s.platformSessionId),
          s.archived ? h("span", { class: "note-session-tag small muted" }, "已归档") : null)))));
}

/**
 * 故障诊断待办的一行状态（docs/requirements/autonomous-diagnostics §7.3）：结论以诊断记录为准，
 * 待办完成 / 归档不改变它。只有点「忽略」才会让同一问题在一段时间内不再推荐。
 */
function noteDiagnosticLine(note) {
  const d = note.diagnostic;
  if (!d || !d.findingId) return null;
  const ignored = d.status === "ignored";
  const bundle = (d.bundleIds || []).at(-1);
  return h("div", { class: "note-diagnostic small", role: "group", "aria-label": "故障诊断状态" },
    h("span", { class: "note-diagnostic-label" }, `故障诊断 · ${d.label}${ignored && d.ignoredUntil ? `（到 ${noteStamp(d.ignoredUntil)}）` : ""}`),
    bundle ? h("a", { class: "note-diagnostic-link", href: `/api/diagnostics/bundles/${encodeURIComponent(bundle)}`, target: "_blank", rel: "noopener", title: "查看出错时打包的前后端记录（JSON）" }, "证据包") : null,
    d.status === "observing" && d.verification ? h("span", { class: "note-diagnostic-repair", title: d.verification.detail || "" }, `观察 ${d.verification.days}/${d.verification.observeDays} 天 · 使用 ${d.verification.attempts}/${d.verification.minAttempts} 次${d.verification.recurrences ? ` · 复发 ${d.verification.recurrences}` : ""}`) : null,
    d.repair ? h("span", { class: "note-diagnostic-repair" }, `修复会话结论：${{ recommend_fix: "需要修复", collect_more: "证据不足", no_action: "不需要处理" }[d.repair.disposition] || d.repair.disposition}${d.repair.agreesWithTriage === false ? "（与 AI 分诊不同）" : ""}`) : null,
    d.repairSessions ? h("button", { type: "button", class: "btn small", disabled: ui.notesBusy === note.id, title: "读取修复会话写在工作目录 .diagnostics/ 里的报告（每轮结束也会自动导入）", onclick: () => void noteDiagnosticImport(note) }, "导入修复报告") : null,
    h("button", { type: "button", class: "btn small", disabled: ui.notesBusy === note.id, title: ignored ? "恢复：同一问题再出现时重新推荐" : "30 天内同一问题不再推荐（明显恶化时例外）", onclick: () => void noteDiagnosticIgnore(note, !ignored) }, ignored ? "取消忽略" : "忽略 30 天"));
}
async function noteDiagnosticImport(note) {
  if (ui.notesBusy) return;
  ui.notesBusy = note.id; noteRenderCurrent();
  try {
    await api(`/api/diagnostics/findings/${encodeURIComponent(note.diagnostic.findingId)}/import`, { method: "POST", body: "{}" });
    const fresh = await api(`/api/notes/${encodeURIComponent(note.id)}`);
    ui.notes = (ui.notes || []).map((n) => n.id === note.id ? { ...n, diagnostic: fresh.diagnostic } : n);
    announce("已导入修复报告");
  } catch (e) { announce(e.issues?.length ? `报告没通过校验：${e.issues.slice(0, 2).join("；")}` : e.message); }
  finally { ui.notesBusy = ""; noteRenderCurrent(); }
}
async function noteDiagnosticIgnore(note, ignore) {
  if (ui.notesBusy) return;
  ui.notesBusy = note.id; noteRenderCurrent();
  try {
    await api(`/api/diagnostics/findings/${encodeURIComponent(note.diagnostic.findingId)}/ignore`, { method: "POST", body: JSON.stringify(ignore ? { days: 30 } : { undo: true }) });
    const fresh = await api(`/api/notes/${encodeURIComponent(note.id)}`);
    ui.notes = (ui.notes || []).map((n) => n.id === note.id ? { ...n, diagnostic: fresh.diagnostic } : n);
    announce(ignore ? "已忽略 30 天：期间同一问题不再推荐" : "已取消忽略");
  } catch (e) { announce(`操作失败：${e.message}`); }
  finally { ui.notesBusy = ""; noteRenderCurrent(); }
}

/** 草稿 / 编辑里的图片：上传状态、大小与移除按钮 */
function noteDraftStatus(item) {
  if (item.state === "local") return "待保存 · 图片尚未上传";
  if (item.state === "uploading") return "上传中…";
  if (item.state === "ready" && item.image) return noteFileSize(item.image.byteSize);
  return item.error || "上传失败";
}

function noteImageDraftStrip(items, disabled, remove) {
  return h("div", { class: `notes-images${items.length ? "" : " empty"}` }, items.map((item) =>
    h("div", { class: "note-draft-image" },
      h("button", { type: "button", class: "note-draft-thumb", "aria-label": `预览图片 ${item.name}`, title: "点击可放大查看", onclick: () => notePreviewDraft(items, item) },
        item.state === "ready" && item.image
          ? h("img", { src: noteImageUrl(item.image, true), alt: item.name })
          : item.preview ? h("img", { src: item.preview, alt: item.name }) : h("span", { class: "note-draft-placeholder", "aria-hidden": "true" }, "图")),
      h("span", { class: "note-draft-name", title: item.name }, item.name),
      h("span", { class: `small${item.state === "failed" ? " warn" : " muted"}`, role: item.state === "failed" ? "alert" : null }, noteDraftStatus(item)),
      h("button", { type: "button", class: "btn small", disabled, "aria-label": `移除图片 ${item.name}`, onclick: () => remove(item) }, item.intakeId ? "取消此次导入" : "移除"))));
}

function noteImagePicker(items, disabled) {
  const input = h("input", {
    type: "file", accept: NOTE_IMAGE_ACCEPT, multiple: true, hidden: true, "aria-label": "添加图片",
    onchange: (ev) => { noteAddFiles(items, Array.from(ev.target.files || [])); ev.target.value = ""; }
  });
  return {
    input,
    button: h("button", {
      type: "button", class: "btn small notes-image-add", disabled: disabled || items.length >= NOTE_MAX_IMAGES,
      title: items.length >= NOTE_MAX_IMAGES ? `最多 ${NOTE_MAX_IMAGES} 张图片` : "添加图片，或直接把图片粘贴进输入框",
      onclick: () => input.click()
    }, "＋ 图片")
  };
}

/* -------------------------------- 记录 -------------------------------- */

// Writes belong to the notes resource, not the route that happened to submit them.
let noteOperationEpoch = 0;
function noteOperationsInvalidate() {
  noteOperationEpoch++;
  noteClearRelationDraft();
  if (typeof noteRelationsDispose === "function") noteRelationsDispose(true);
  ui.notesBusy = ''; ui.notesClassificationBusy = false;
  ui.notes = []; ui.notesTabFilters = null; ui.notesKindCounts = null; ui.notesCounts = null; ui.notesCategoryCounts = null; ui.notesFilteredCounts = null; ui.notesCategories = [];
  ui.noteTaxonomy = null; ui.notesError = ''; ui.noteReadError = ''; ui.noteReadErrorMsg = '';
  ui.noteIterations = null; ui.noteIterationSummary = null; ui.notesClassificationId = null; ui.notesCalendar = null;
  // Agent 卡片的数据也随访问状态作废：重新进入时按新的权限重读，不把上一个人的会话 / 用量留在页面上。
  ui.notesAgentToday = null; ui.notesTodayWho = "human";
  if (ui.view === 'notes') document.getElementById('main')?.replaceChildren(h('p', {class: 'field-error', role: 'alert'}, '访问状态已变化，请重新读取'));
}
function noteRenderCurrent() {
  if (ui.view !== 'notes') return;
  // 手机浮层开着时输入区这个节点不在页面里：整页重绘碰不到它，改为就地更新表单和列表，
  // 否则图片上传的状态、预览、保存按钮会停在旧快照上。
  if (noteSheet) { notePatchComposer(); noteRefreshList(); return; }
  renderMain();
}

/** 待办变化后让日历缓存失效；下次打开日历或收到实时事件时重新读取。「最近日程」一行在页面上就立刻重读。 */
function noteCalendarInvalidate() {
  if (ui.notesUpcoming) { if (noteTodayMounted()) void noteLoadUpcoming(); else ui.notesUpcoming.loaded = false; }
  if (!ui.notesCalendar) return;
  ui.notesCalendar.monthCache = {};
  if (ui.notesCalendar.recent) { ui.notesCalendar.recent.token++; ui.notesCalendar.recent.loading = false; ui.notesCalendar.recent.loaded = false; }
  // 只有纯 Agent 读取范围不随待办变化；混合开启本地后仍须刷新。
  if (noteCalendarReadScope(ui.notesCalendar) === "agent") return;
  ui.notesCalendar.data = null;
  ui.notesCalendar.error = "";
  ui.notesCalendar.googleError = "";
  ui.notesCalendar.loading = false;
  ui.notesCalendar.localLoading = false;
  ui.notesCalendar.googleLoading = false;
  ui.notesCalendar.token = (ui.notesCalendar.token || 0) + 1;
  // 宽屏侧边栏常驻：数据失效后直接重读，否则侧边栏会停在旧日程上。
  if (noteCalendarInlineOpen()) { void noteLoadCalendar(); void noteLoadCalendarRecent(true); }
}
function notePatchComposer() {
  if (ui.view !== 'notes') return;
  const form = document.querySelector('.notes-composer');
  if (!form) return;
  const busy = ui.notesBusy === 'new', items = ui.notesImages || [];
  form.setAttribute('aria-busy', String(busy));
  noteKeepHeadInPlace(() => form.classList.toggle('is-open', noteComposerShouldOpen()));
  const oldRelationFields = form.querySelector('.notes-relation-fields'), nextRelationFields = noteRelationComposerFields();
  if (oldRelationFields) { if(nextRelationFields)oldRelationFields.replaceWith(nextRelationFields);else oldRelationFields.remove(); } else if(nextRelationFields)form.prepend(nextRelationFields);
  const input = form.querySelector('.notes-input');
  if (input && input.value !== (ui.notesDraft || '')) input.value = ui.notesDraft || '';
  const button = form.querySelector('#notes-save-btn');
  if (button) {
    button.textContent = busy ? '保存中…' : '记下';
    button.disabled = busy || noteDraftBusy(items) || noteDraftBlocked(items) || (!String(ui.notesDraft || '').trim() && !noteDraftHasImage(items));
  }
  const strip = form.querySelector('.notes-images');
  if (strip) strip.replaceWith(noteImageDraftStrip(items, busy, item => {
    if (item.intakeId) { noteCancelIntake(item.intakeId); return; }
    const index = items.indexOf(item); if (index >= 0) items.splice(index, 1);
    notePatchComposer();
  }));
  // 浮层里也要看得到保存失败的原因（页面顶部那条错误被遮罩挡住了）
  const sheetError = document.getElementById('notes-sheet-error');
  if (sheetError) { sheetError.textContent = ui.notesError || ''; sheetError.hidden = !ui.notesError; }
}
function noteRelationRequestKey() { return globalThis.crypto?.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), b=>b.toString(16).padStart(2,'0')).join(''); }
function noteRelationKey(ref) { return ref.kind === 'note' ? `note:${ref.noteId}` : `google:${JSON.stringify([ref.accountId,ref.calendarId,ref.seriesId || ref.eventId])}`; }
function noteRelationsHref(ref) { return '#/notes/relations/' + encodeURIComponent(noteRelationKey(ref)); }
function noteClearRelationDraft() { ui.notesRelationDraft = null; }
function noteOpenRelatedComposer(sourceRefs) {
  if (ui.notesBusy) return;
  if (noteComposerHasContent()) { ui.notesError = '已有草稿，请先保存或放弃，再从此条目创建'; noteRenderCurrent(); return; }
  ui.notesRelationDraft = { sourceRefs: structuredClone(sourceRefs), idempotencyKey: noteRelationRequestKey() };
  ui.notesError = ''; ui.notesComposerOpen = true;
  if (ui.view !== 'notes') { ui.notesFocusInput = true; location.hash = '#/notes'; return; }
  noteRenderCurrent(); noteOpenComposer();
}
function noteAbandonRelatedDraft() {
  if (ui.notesBusy) return;
  if (noteComposerHasContent() && !confirm('放弃本次关联创建的草稿？')) return;
  for (const item of ui.notesImages || []) noteReleaseLocalImage(item);
  ui.notesDraft = ''; delete ui.notesDraftKind; ui.notesImages = []; noteClearRelationDraft(); ui.notesComposerOpen = false; noteCloseSheet(); noteRenderCurrent();
}
/** 「新增子关联」：直接打开普通新建表单，只带来源；类型（笔记/待办/日程）与分类跟普通新建一样，保存后由 AI 判断。 */
function noteRelatedMenu(ref, disabled, beforeAction) {
  return h('button',{type:'button',class:'btn small note-related-add',disabled,onclick:()=>{beforeAction?.();noteOpenRelatedComposer([ref]);}},'新增子关联');
}
/** 「更多」里的「新增子关联」：直接打开带来源的新建表单，类型交给 AI。 */
function noteChildRelationMenu(note, busy) {
  return h("button", { type: "button", role: "menuitem", class: "btn small", disabled: busy || !!note.relationError, title: note.relationError || "从这条记录继续新建，并记住来源",
    onclick: () => { ui.notesMore = null; noteOpenRelatedComposer([{ kind: "note", noteId: note.id }]); } }, "新增子关联");
}
function noteRelationIcon() {
  const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ class: "note-session-icon", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  for (const [cx, cy] of [[6, 6], [18, 6], [12, 18]]) { const c = document.createElementNS(ns, "circle"); c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", 2.6); svg.append(c); }
  const lines = document.createElementNS(ns, "path"); lines.setAttribute("d", "M7.4 8.2l3.6 7.6M16.6 8.2l-3.6 7.6"); svg.append(lines);
  return svg;
}
/** 列表行的关联统计：只在已有关联时出现，和会话标签同一排，点击进入图谱与演进页；新增子关联入口在「更多」里。 */
function noteRelationBadge(note) {
  const count = Number(note.relationCount) || 0;
  if (!count && !note.relationError) return null;
  const label = note.relationError ? "关联不可用" : `关联 ${count}${note.relationVerificationPending ? " · 待核验" : ""}`;
  return h("li", { class: "note-session-item" },
    h("a", { class: "note-session-link note-relation-link", href: noteRelationsHref({ kind: "note", noteId: note.id }), title: note.relationError || "查看知识图谱与演进过程" }, noteRelationIcon(), h("span", { class: "note-session-title" }, label)));
}
function noteRelationActions(ref, count, error, beforeAction, pending) {
  return h('span',{class:'note-relation-actions'},h('a',{class:'btn small note-relation-count',href:noteRelationsHref(ref),title:error || '查看知识图谱与演进过程',onclick:()=>beforeAction?.()},error?'关联不可用':`关联 ${Number(count)||0}${pending?' · 待核验':''}`),noteRelatedMenu(ref,!!error,beforeAction));
}
function noteRelationComposerFields() {
  const d=ui.notesRelationDraft;if(!d)return null;
  const busy=!!ui.notesBusy;
  return h('div',{class:'notes-relation-fields'},
    h('div',{class:'note-source-list'},d.sourceRefs.length?d.sourceRefs.map((ref,i)=>h('span',{class:'note-source-chip'},h('a',{href:noteRelationsHref(ref)},'来源：'+((ui.notes||[]).find(n=>ref.kind==='note'&&n.id===ref.noteId)?.text?.split('\n')[0]?.slice(0,60)||'来源条目')),h('button',{type:'button',class:'btn small',disabled:busy,'aria-label':'移除来源',onclick:()=>{d.sourceRefs.splice(i,1);notePatchComposer();}},'×'))):h('span',{class:'muted small'},'将创建独立条目')),
    h('button',{type:'button',class:'btn small',disabled:busy,onclick:noteAbandonRelatedDraft},'放弃本次关联创建'));
}
function noteRelationCreatePayload(snapshot) {
 // 不指定类型和日程：与普通新建一致，由 AI 分类（服务端对未指定类型的新条目排队分类）
 return snapshot?{sourceRefs:snapshot.sourceRefs,idempotencyKey:snapshot.idempotencyKey}:{};
}

async function noteCreate(text) {
  if (ui.notesBusy) return;
  const epoch = noteOperationEpoch, revision = ui.notesDraftRevision || 0;
  const kindEpoch = noteKindManualEpoch;
  const relationDraft = ui.notesRelationDraft, relationSnapshot = relationDraft ? structuredClone(relationDraft) : null;
  const draft = ui.notesDraft, draftImages = ui.notesImages;
  const submittedItems = [...(ui.notesImages || [])];
  let images = noteDraftReadyIds(submittedItems);
  const queryBefore = noteQueryKey();
  const fromSheet = !!noteSheet;
  let saved = false;
  ui.notesBusy = "new";
  ui.notesError = "";
  notePatchComposer();
  try {
    const relationPayload = noteRelationCreatePayload(relationSnapshot);
    await window.imageIntake?.beforeSave?.(submittedItems.map(i => i.intakeId).filter(Boolean));
    if (epoch !== noteOperationEpoch) return;
    for (const item of submittedItems) if (item.file && item.state !== 'ready') {
      await noteUploadOne(item, item.file);
      if (epoch !== noteOperationEpoch) return;
      if (item.state !== 'ready') throw new Error(item.error || '图片上传失败，请重试');
    }
    images = noteDraftReadyIds(submittedItems);
    const note = await api("/api/notes", { method: "POST", body: JSON.stringify({ text, images, ...(ui.notesDraftKind === 'todo' ? { kind: 'todo' } : {}), timeZone: noteTimeZone(), ...relationPayload }) });
    if (epoch !== noteOperationEpoch) return;
    saved = true;
    void window.imageIntake?.saved(submittedItems.map(i => i.intakeId).filter(Boolean));
    for (const item of submittedItems) noteReleaseLocalImage(item);
    // 输入框下方跟着显示这条被 AI 归到了哪一类；新记录在当前类型筛选下看不到时切到它自己的大类。
    ui.notesLastCreated = note.id;
    ui.notesLastCreatedNote = note;
    ui.notesCreatedFollow = { id: note.id, epoch: kindEpoch };
    // 大类尚未确定时保留当前 Tab，避免先跳待办再跳最终类型。
    if (!note.kindPending && kindEpoch === noteKindManualEpoch) ui.notesKindFilter = noteDisplayKind(note);
    const exists = (ui.notes || []).some(n => n.id === note.id);
    ui.notes = [note, ...(Array.isArray(ui.notes) ? ui.notes : []).filter(n => n.id !== note.id)];
    if (!exists) noteCountsShift(note, { all: 1 }, null, noteStatusDone(note) ? "done" : "todo");
    // 新记录默认没完成 / 没过期；停在「已完成 / 已过期」时切回「未完成 / 未过期」，保证刚写下就能看到
    if (noteFilter() === "done" && !noteStatusDone(note)) ui.notesFilter = "todo";
    ui.notesCategory = ""; ui.notesCategories = []; ui.notesFilteredCounts = null;
    ui.notesFocusNote = note.id;
    if (revision === (ui.notesDraftRevision || 0) && ui.notesDraft === draft && ui.notesImages === draftImages && JSON.stringify(noteDraftReadyIds(ui.notesImages)) === JSON.stringify(images)) {
      ui.notesDraft = "";
      delete ui.notesDraftKind;
      if (ui.notesRelationDraft === relationDraft) noteClearRelationDraft();
      if (ui.notesImages) ui.notesImages.splice(0);
      ui.notesComposerOpen = false; // 记下后收回成单按钮
    }
    if (ui.notesRelationDraft && ui.notesRelationDraft === relationDraft) ui.notesRelationDraft.idempotencyKey = noteRelationRequestKey();
    noteCalendarInvalidate();
    invalidateReads((key) => key === "/api/notes" || key.startsWith("/api/notes?"));
    // 新记录可能把视图从“已完成”拉回“未完成”、或清掉分类筛选：分页条件跟着变了，
    // 用新条件重新取第一页（本地刚插入的记录先保留，不闪空）。
    if ((noteQueryKey() !== queryBefore || relationSnapshot?.sourceRefs.length) && ui.view === "notes") {
      noteQueryReload();
    }
  } catch (e) {
    if (epoch === noteOperationEpoch) ui.notesError = e.message;
  } finally {
    if (epoch === noteOperationEpoch) {
      ui.notesBusy = "";
      // 手机上记完把浮层收起，回到列表看这条被归到了哪一类（renderNotes 会把页面重绘好）
      if (fromSheet && saved) noteDismissSheet();
      else { notePatchComposer(); if (ui.view === 'notes') noteRefreshList(); }
    }
  }
}

/* ------------------------------ 大类：笔记 / 待办 / 日程 ------------------------------ */

/** 平台统一北京时间：AI 换算「明天下午 3 点」这类相对时间用，不跟随浏览器时区。 */
function noteTimeZone() {
  return typeof NOTE_PLATFORM_TIME_ZONE === "string" ? NOTE_PLATFORM_TIME_ZONE : "Asia/Shanghai";
}

/** 本地替换一条记录（保留关联会话），并同步刚记下那条的跟踪副本。 */
function noteReplaceLocal(note) {
  if (!note?.id) return;
  if (ui.notesCalendarRecordNote?.id === note.id) ui.notesCalendarRecordNote = noteKeepSessions(ui.notesCalendarRecordNote, note);
  ui.notes = (ui.notes || []).map((n) => (n.id === note.id ? noteKeepSessions(n, note) : n));
  if (ui.notesLastCreated === note.id) ui.notesLastCreatedNote = note;
  noteFollowCreatedKind(note);
}

function noteFollowCreatedKind(note) {
  const follow = ui.notesCreatedFollow;
  if (!follow || follow.id !== note.id || note.kindPending) return;
  ui.notesCreatedFollow = null;
  if (follow.epoch !== noteKindManualEpoch || ui.view !== "notes" || ui.notesManagement) return;
  ui.notesFocusNote = note.id;
  const kind = noteDisplayKind(note);
  noteSetKindFilter(kind, { automatic: true });
  if (kind === "event") { ui.notesCalendarRecord = note.id; noteRefreshList(); }
}

/** 人工改类（改为笔记 / 待办）或让 AI 重新判断。 */
async function noteChangeKind(note, body) {
  if (ui.notesBusy) return;
  const epoch = noteOperationEpoch;
  const kindEpoch = noteKindManualEpoch;
  ui.notesBusy = note.id; ui.notesError = ""; ui.notesMore = null;
  noteRefreshList(); noteSyncKindResult();
  try {
    const updated = await api(`/api/notes/${encodeURIComponent(note.id)}`, { method: "PATCH", body: JSON.stringify({ ...body, timeZone: noteTimeZone() }) });
    if (epoch !== noteOperationEpoch) return;
    if (ui.notesLastCreated === note.id) ui.notesCreatedFollow = { id: note.id, epoch: kindEpoch };
    noteReplaceLocal(updated);
    ui.notesCounts = null; ui.notesCategoryCounts = null;
    noteCalendarInvalidate();
    invalidateReads((key) => key === "/api/notes" || key.startsWith("/api/notes?"));
  } catch (e) {
    if (epoch === noteOperationEpoch) ui.notesError = e.message;
  } finally {
    if (epoch === noteOperationEpoch) { ui.notesBusy = ""; if (ui.view === "notes") { noteRefreshList(); noteSyncKindResult(); } }
  }
}

/** 置顶操作进行中的标记：卡片图钉、今日卡片图钉和「更多」菜单共用，读完所有刷新后才清掉。 */
function notePinPendingMap() {
  if (!(ui.notePinPending instanceof Map)) ui.notePinPending = new Map();
  return ui.notePinPending;
}
function notePinPendingState(noteId) { return notePinPendingMap().get(noteId) || ""; }
function noteNextPaint() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "function") return setTimeout(resolve, 0);
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}
/** 列表卡片上真的出现 / 消失图钉后才算这次置顶操作完成；当前页没有这张卡片时直接通过。 */
async function noteWaitForCardPinState(notes, pinned) {
  // 本地状态已在同一帧渲染；这里只兜底等一帧布局，不再用几秒超时拖住按钮。
  const deadline = Date.now() + 800;
  for (;;) {
    const ready = notes.every((note) => {
      const entry = [...document.querySelectorAll(".note-entry[data-note-id]")].find((el) => el.dataset.noteId === note.id);
      if (!entry) return true;
      return pinned ? !!entry.querySelector(".note-pin-action:not(.is-busy)") : !entry.querySelector(".note-pin-action");
    });
    if (ready || Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 本地先更新今日卡片的摘要数据：置顶不必等下一次网络摘要，页面就能立刻显示/移除图钉。 */
function noteApplySummaryPinLocal(targets, pinned, updated) {
  const summary = ui.noteIterationSummary;
  if (!summary) return;
  const targetIds = new Set((targets || []).map((note) => note.id));
  const oldPinned = Array.isArray(summary.pinnedNotes) ? summary.pinnedNotes : [];
  const pinnedNotes = oldPinned.filter((note) => !targetIds.has(note.id));
  if (pinned) for (const note of updated) pinnedNotes.push({ id: note.id, text: note.text, kind: note.kind, schedule: note.schedule, createdAt: note.createdAt, pinned: true, pinnedAt: note.pinnedAt });
  summary.pinnedNotes = pinnedNotes;
  const remaining = new Set(pinnedNotes.map((note) => note.id));
  for (const task of Array.isArray(summary.tasks) ? summary.tasks : []) {
    if (!(task.noteIds || []).some((id) => targetIds.has(id))) continue;
    if ((task.noteIds || []).some((id) => remaining.has(id))) task.pinned = true;
    else delete task.pinned;
  }
}

/** 置顶 / 取消置顶：先标进行中；本地列表和今日卡片刷新出最终状态后才清标记并返回成功。 */
async function noteSetPinned(targets, pinned, message) {
  if (ui.notesBusy) return false;
  const notes = [...new Map((targets || []).filter((n) => n && n.id).map((n) => [n.id, n])).values()];
  if (!notes.length) return false;
  const epoch = noteOperationEpoch, pending = notePinPendingMap(), ids = notes.map((note) => note.id);
  for (const id of ids) pending.set(id, pinned ? "pinning" : "unpinning");
  ui.notesBusy = notes[0].id; ui.notesError = "";
  // 菜单保持展开，按钮先显示「置顶中 / 取消中」，刷新完再变成操作后的状态。
  noteRefreshList();
  noteRefreshRecommended();
  try {
    const updated = [];
    // 顺序提交：多条来源同时取消置顶时，服务端每次只改一条，避免并发写同一份 notes.json。
    for (const note of notes) updated.push(await api(`/api/notes/${encodeURIComponent(note.id)}`, { method: "PATCH", body: JSON.stringify({ pinned }) }));
    if (epoch !== noteOperationEpoch) return false;
    // 本地先落到列表和今日卡片：图钉立即出现 / 进入取消中的转动状态，不再等下一次摘要网络请求。
    for (const note of updated) noteReplaceLocal(note);
    noteApplySummaryPinLocal(notes, pinned, updated);
    invalidateReads((key) => key === "/api/notes" || key.startsWith("/api/notes?"));
    noteIterationsEpoch++;
    if (ui.view === "notes") noteRefreshList();
    if (noteTodayMounted() || ui.view === "notes") noteRefreshRecommended();
    await noteNextPaint();
    if (ui.view === "notes") await noteWaitForCardPinState(notes, pinned);
    // 摘要仍在后台核对真实顺序；失败也不影响这次置顶已经落到的本地页面状态。
    if (noteTodayMounted() || ui.view === "notes") void noteLoadTodaySummary();
    announce(message);
    return true;
  } catch (e) {
    if (epoch === noteOperationEpoch) ui.notesError = e.message;
    return false;
  } finally {
    for (const id of ids) pending.delete(id);
    if (epoch === noteOperationEpoch) {
      ui.notesBusy = "";
      if (ui.view === "notes") noteRefreshList();
      if (noteTodayMounted() || ui.view === "notes") noteRefreshRecommended();
    }
  }
}

function noteTogglePin(note) {
  const next = !note.pinned;
  return noteSetPinned([note], next, next ? "已置顶：会排在今日推荐最前面" : "已取消置顶");
}

/** 今日卡片上的图钉直接取消置顶：置顶推荐可能由多条来源合成，一并取消这些来源的置顶。 */
function noteUnpinToday(targets) {
  return noteSetPinned(targets, false, "已取消置顶");
}

let noteKindFollowFlight = null;
/**
 * 服务端事件到达时：本地还标着「判断中」的记录逐条重读。
 * AI 把它归入日程后，它会离开「待办」的分页结果，只靠第一页合并拿不到新状态。
 */
function noteFollowPendingKinds() {
  if (noteKindFollowFlight) return noteKindFollowFlight;
  const pending = (n) => n?.kindPending || n?.writing?.state === "pending";
  const ids = new Set((ui.notes || []).filter(pending).map((n) => n.id));
  if (pending(ui.notesLastCreatedNote)) ids.add(ui.notesLastCreatedNote.id);
  if (!ids.size) return Promise.resolve();
  const epoch = noteOperationEpoch;
  const flight = (async () => {
    for (const id of [...ids].slice(0, 10)) {
      try {
        const note = await api(`/api/notes/${encodeURIComponent(id)}`, noteReadOptions());
        if (epoch === noteOperationEpoch) noteReplaceLocal(note);
      } catch (e) {
        // 已被删除：不再跟踪
        if (ui.notesLastCreated === id && /不存在/.test(e?.message || "")) { ui.notesLastCreated = null; ui.notesLastCreatedNote = null; }
      }
    }
  })().finally(() => {
    if (noteKindFollowFlight === flight) noteKindFollowFlight = null;
    if (ui.view === "notes") { noteRefreshList(); noteSyncKindResult(); }
  });
  noteKindFollowFlight = flight;
  return flight;
}

/** 输入框下方：刚记下的这条被归到哪一类，附一键改类。 */
function noteKindResult() {
  const id = ui.notesLastCreated;
  const note = id ? ((ui.notes || []).find((n) => n.id === id) || ui.notesLastCreatedNote) : null;
  if (!note) return h("div", { id: "notes-kind-result", class: "notes-kind-result", hidden: true });
  const busy = ui.notesBusy === note.id;
  const kind = noteDisplayKind(note);
  const dismiss = h("button", { type: "button", class: "notes-kind-result-close", "aria-label": "关闭归类提示", title: "关闭", onclick: () => { ui.notesLastCreated = null; ui.notesLastCreatedNote = null; noteSyncKindResult(); } }, "×");
  if (note.kindPending) {
    return h("div", { id: "notes-kind-result", class: "notes-kind-result pending", role: "status" },
      h("span", { class: "notes-kind-spinner", "aria-hidden": "true" }), h("span", { class: "notes-kind-result-text" }, "已记下，AI 正在判断是笔记、待办还是日程…"), dismiss);
  }
  const label = NOTE_KIND_LABEL[kind];
  const actions = [];
  if (kind === "event") actions.push(h("button", { type: "button", class: "notes-kind-result-action", disabled: busy, "data-key": "notes-kind-result-calendar", onclick: () => noteOpenNoteInCalendar(note) }, "在日历中查看"));
  if (kind !== "note") actions.push(h("button", { type: "button", class: "notes-kind-result-action", disabled: busy, onclick: () => void noteChangeKind(note, { kind: "note" }) }, "改为笔记"));
  if (kind !== "todo") actions.push(h("button", { type: "button", class: "notes-kind-result-action", disabled: busy, onclick: () => void noteChangeKind(note, { kind: "todo" }) }, kind === "event" ? "改为待办（去掉时间）" : "改为待办"));
  const by = note.kindSource === "user" ? "已改为" : note.kindSource === "ai" ? "AI 已归入" : "已按";
  return h("div", { id: "notes-kind-result", class: `notes-kind-result kind-${kind}`, role: "status", "data-kind": kind },
    h("span", { class: "notes-kind-result-text" },
      `${by}「${label}」`, kind === "event" ? h("span", { class: "muted" }, ` · ${noteScheduleLabel(note.schedule)}`) : null,
      !note.kindSource ? h("span", { class: "muted" }, "保存（AI 未能判断）") : null),
    h("span", { class: "notes-kind-result-actions" }, ...actions), dismiss);
}

function noteSyncKindResult() {
  const el = document.getElementById("notes-kind-result");
  if (el && ui.view === "notes") el.replaceWith(noteKindResult());
}

/**
 * 列表行不再重复大类标签：笔记 / 待办 / 日程由上方的大类 tab 区分，
 * 每行再挂一个同名的「笔记」只是在复读当前 tab。只有 AI 还在判断、暂时不属于任何一类时，
 * 才在行内标一个「判断中…」，让这条记录的状态不至于凭空消失。
 */
function noteKindPendingBadge(note) {
  return note.kindPending ? h("span", { class: "note-kind-chip pending", title: "AI 正在判断类型" }, "判断中…") : null;
}

/* ------------------------------ 今天卡片：日程 + 推荐 ------------------------------ */
// 一张卡片把「最近日程」和「今日推荐」平铺在一起（不再分页签）：宽屏左右两栏，窄屏上下堆叠。
// 两个模块标题前各带一个小图标：日程前是日历（点开日历视图），推荐前是四角星（与会话列表的推荐操作同一图形）；
//「全部推荐任务」展开完整推荐面板。同一时刻只展开一个（ui.notesTab：records=都收起）。
// 推荐行右侧只留一个「处理」按钮：点开轻量弹窗看完整需求，并在弹窗里选择「忽略 / 发起迭代对话」。

function noteUpcomingState() {
  return (ui.notesUpcoming ||= { events: [], total: 0, loaded: false, loading: false, error: "", external: [] });
}

function noteUpcomingDay(event) {
  const key = noteDateKey(event.start);
  if (!key) return "";
  const todayKey = noteDateKey(new Date());
  const diff = Math.round((Date.parse(`${key}T00:00:00Z`) - Date.parse(`${todayKey}T00:00:00Z`)) / 86400000);
  if (diff <= 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === 2) return "后天";
  const parts = noteBeijingParts(`${key}T00:00:00+08:00`);
  return `${parts.month} 月 ${parts.day} 日`;
}

// 日程行只看未来 48 小时（含正在进行的）的前 3 个；更远的去日历看。
const NOTE_TODAY_EVENT_LIMIT = 3;
const NOTE_TODAY_EVENT_WINDOW_MS = 48 * 3600_000;
const NOTE_TODAY_REC_LIMIT = 3;

const NOTE_CALENDAR_ICON = '<svg class="notes-today-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="16.5" rx="3"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/></svg>';
// 推荐前的四角星：与会话列表「推荐下一步」同一个 sparkle 图形（空心描边），两处推荐长得一致。
const NOTE_SPARKLE_ICON = '<svg class="notes-today-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2C12 7.5 16.5 12 22 12 16.5 12 12 16.5 12 22 12 16.5 7.5 12 2 12 7.5 12 12 7.5 12 2Z"/></svg>';
const NOTE_OVERVIEW_ICON = '<svg class="notes-today-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 16v-4M12 16V7M17 16v-6"/></svg>';
const NOTE_TODAY_HEADING_ICONS = { overview: NOTE_OVERVIEW_ICON, calendar: NOTE_CALENDAR_ICON, sparkle: NOTE_SPARKLE_ICON };
// 置顶标记：图钉轮廓，配 sr-only「置顶」；推荐序号位和列表行都用同一个图形。
const NOTE_PIN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';

/** 模块标题前的小图标：装饰性图形，文案仍由标题提供。 */
function noteTodayHeadingIcon(name) {
  const wrap = h("span", { class: "notes-today-heading-icon", "aria-hidden": "true" });
  wrap.innerHTML = NOTE_TODAY_HEADING_ICONS[name] || "";
  return wrap;
}

function notePinIcon(className = "notes-rec-pin") {
  const wrap = h("span", { class: className, "aria-hidden": "true" });
  wrap.innerHTML = NOTE_PIN_ICON;
  return wrap;
}

/** 今日推荐里的置顶标记：替换序号；传 onUnpin 时就是可直接点击取消置顶的图钉按钮。 */
function notePinnedBadge({ onUnpin, pending = false } = {}) {
  const className = `note-iteration-priority notes-rec-badge pinned${pending ? " is-busy" : ""}`;
  const content = [notePinIcon(), h("span", { class: "sr-only" }, "置顶")];
  if (!onUnpin) return h("span", { class: className, "data-pinned": "true", title: "置顶", "aria-label": "置顶" }, ...content);
  const label = pending ? "取消置顶中" : "取消置顶";
  return h("button", {
    type: "button", class: `${className} pinned-toggle`, disabled: !!ui.notesBusy || pending,
    "data-pinned": "true", title: label, "aria-label": label, "aria-busy": pending ? "true" : null,
    onclick: (ev) => { ev.stopPropagation(); onUnpin(); }
  }, ...content);
}

function noteRecBadge(task, index, pinned, onUnpin, pending = false) {
  if (pinned) return notePinnedBadge({ onUnpin, pending });
  return h("span", { class: "note-iteration-priority notes-rec-badge" }, String(task.rank?.priority || index + 1));
}

/** 置顶记录（后端摘要里有 pinnedNotes；旧缓存 / 测试替身没有时从当前列表推出来）。 */
function noteTodayPinnedNotes(data) {
  const list = Array.isArray(data?.pinnedNotes)
    ? data.pinnedNotes
    : (Array.isArray(ui.notes) ? ui.notes.filter((n) => n && n.pinned && !n.done) : []);
  return list
    .filter((n) => n && n.id && !n.done)
    .sort((a, b) => (Date.parse(b.pinnedAt || b.createdAt) || 0) - (Date.parse(a.pinnedAt || a.createdAt) || 0));
}

function noteTaskPinned(task, pinnedNotes) {
  if (task?.pinned) return true;
  const ids = new Set((pinnedNotes || []).map((n) => n.id));
  return (task?.noteIds || []).some((id) => ids.has(id));
}

function noteTaskPinnedAt(task, pinnedNotes) {
  const explicit = Date.parse(task?.pinnedAt || "");
  if (Number.isFinite(explicit)) return explicit;
  return Math.max(0, ...(task?.noteIds || []).map((id) => {
    const note = (pinnedNotes || []).find((n) => n.id === id);
    return Date.parse(note?.pinnedAt || note?.createdAt || "") || 0;
  }));
}

/** 置顶的笔记 / 待办直接混在推荐列表里：标题只是文字（不可点），和处理推荐一样走右侧「处理」弹窗。 */
function notePinnedNoteRow(note) {
  const kind = noteDisplayKind(note);
  const text = String(note.text || "").trim() || "（图片记录）";
  return h("li", { class: "notes-rec-item notes-rec-pinned-note", "data-note-id": note.id, "data-pinned": "true" },
    notePinnedBadge({ onUnpin: () => void noteUnpinToday([note]), pending: notePinPendingState(note.id) === "unpinning" }),
    h("span", { class: "notes-rec-title", title: `置顶的${NOTE_KIND_LABEL[kind]}：${text}` },
      h("span", { class: "notes-rec-title-text" }, text)),
    h("button", {
      type: "button", class: "btn small notes-rec-more", "data-key": `notes-rec-more-${note.id}`,
      disabled: !!ui.notesBusy, "aria-haspopup": "dialog", "aria-label": `处理置顶的${NOTE_KIND_LABEL[kind]}：${text}`, title: "处理这条置顶记录：取消置顶或发起对话",
      onclick: () => noteOpenPinnedPop(note)
    }, "处理"));
}

/* 刚发起会话的推荐：新快照回来之前先留在列表里显示「刷新中…」。
 * 手机上提交后会立刻返回待办页，若这时把缓存里的任务直接删掉，看起来就是任务凭空消失；
 * 所以这里只在快照（或失败结果）回来、且「刷新中」显示够久之后才收尾。 */
const NOTE_LAUNCH_REFRESH_MIN_MS = 900;
const NOTE_LAUNCH_REFRESH_MAX_MS = 8000;
let noteLaunchRefreshTimer = null;
function noteLaunchRefreshingMap() { return (ui.noteIterationLaunchRefreshing ||= {}); }
function noteIterationLaunchRefreshing(taskId) { return noteLaunchRefreshingMap()[taskId] || null; }
/** 发起成功：记住标题 / 序号，摘要刷新掉这条之后仍能画出它的「刷新中…」行。 */
function noteIterationMarkLaunchRefreshing(task, sessionId = '') {
  if (!task?.id) return;
  noteLaunchRefreshingMap()[task.id] = {
    id: task.id, title: String(task.title || ''), rank: task.rank, pinned: !!task.pinned,
    sessionId, at: Date.now(), seenAt: 0
  };
  noteLaunchRefreshTick();
}
/** 推荐快照已经读回来了：已经显示够久的立刻移出列表，没到时间的到点再移。 */
function noteIterationLaunchRefreshed() {
  const now = Date.now();
  for (const entry of Object.values(noteLaunchRefreshingMap())) if (!entry.seenAt) entry.seenAt = now;
  noteLaunchRefreshTick();
}
function noteLaunchRefreshTick() {
  if (noteLaunchRefreshTimer) { clearTimeout(noteLaunchRefreshTimer); noteLaunchRefreshTimer = null; }
  const state = noteLaunchRefreshingMap(), now = Date.now();
  let next = Infinity, changed = false;
  for (const [id, entry] of Object.entries(state)) {
    // 快照到了也要至少显示 MIN；一直读不回来时按 MAX 兜底，不让这一行永远停在「刷新中」。
    const until = entry.seenAt ? Math.max(entry.at + NOTE_LAUNCH_REFRESH_MIN_MS, entry.seenAt) : entry.at + NOTE_LAUNCH_REFRESH_MAX_MS;
    if (until <= now) { delete state[id]; changed = true; }
    else next = Math.min(next, until);
  }
  if (next !== Infinity) noteLaunchRefreshTimer = setTimeout(() => { noteLaunchRefreshTimer = null; noteLaunchRefreshTick(); }, next - now);
  if (changed) noteRefreshRecommended();
}

/** 推荐行右侧只留一个紧凑的「处理」按钮：点开弹窗看完整需求，再做「忽略 / 发起迭代对话」的选择。 */
function noteTaskRecRow(task, index, pinned, pinnedNotes = []) {
  const ownBusy = !!ui.noteIterationBusy && ui.noteIterationBusyTask === task.id;
  const refreshing = noteIterationLaunchRefreshing(task.id);
  // 置顶推荐可能由多条来源合成：点击图钉取消这些来源的置顶，推荐随之回到普通排序。
  const pinnedSources = pinned ? (task.noteIds || []).map((id) => pinnedNotes.find((n) => n.id === id)).filter(Boolean) : [];
  const onUnpin = pinned ? () => void noteUnpinToday(pinnedSources.length ? pinnedSources : (task.noteIds || []).map((id) => ({ id }))) : null;
  const pendingSourceIds = pinnedSources.length ? pinnedSources.map((note) => note.id) : (task.noteIds || []);
  const unpinning = pinned && pendingSourceIds.some((id) => notePinPendingState(id) === "unpinning");
  return h("li", { class: `notes-rec-item${pinned ? " pinned notes-rec-pinned-task" : ""}`, "data-iteration-id": task.id, ...(pinned ? { "data-pinned": "true" } : {}), ...(refreshing ? { "data-refreshing": "true", "aria-busy": "true" } : {}) },
    noteRecBadge(task, index, pinned, refreshing ? null : onUnpin, unpinning),
    // 标题只是文字：不再能点开，完整需求走右侧「处理」弹窗（标题的 title 提示仍保留）
    h("span", {
      class: "notes-rec-title",
      title: `${pinned ? "置顶 · " : ""}${task.title}\n${task.noteIds.length > 1 ? `${task.noteIds.length} 条待办` : "单条待办"}${task.rank?.reasons?.length ? ` · ${task.rank.reasons.join(" · ")}` : ""}`
    }, h("span", { class: "notes-rec-title-text" }, task.title)),
    refreshing
      ? h("span", { class: "notes-rec-refreshing", role: "status" }, noteActionSpinner(), "刷新中…")
      : h("button", {
        type: "button", class: "btn small notes-rec-more", "data-key": `notes-rec-more-${task.id}`,
        disabled: !!ui.noteIterationBusy || !!task.launch, "aria-busy": ownBusy ? "true" : null,
        "aria-haspopup": "dialog", "aria-label": `处理推荐任务：${task.title}`, title: "处理这条推荐：忽略或发起迭代对话",
        onclick: () => noteOpenRecPop(task)
      }, ownBusy ? noteActionSpinner() : "处理"));
}

/** 已经不在摘要里的发起任务：仍占一行显示「刷新中…」，等推荐快照刷新完再移走。 */
function noteTaskLaunchRefreshingRow(entry) {
  return h("li", { class: "notes-rec-item notes-rec-launching", "data-iteration-id": entry.id, "data-refreshing": "true", "aria-busy": "true" },
    noteRecBadge(entry, 0, !!entry.pinned),
    h("span", { class: "notes-rec-title", title: `${entry.title}（正在刷新推荐）` }, h("span", { class: "notes-rec-title-text" }, entry.title)),
    h("span", { class: "notes-rec-refreshing", role: "status" }, noteActionSpinner(), "刷新中…"));
}

/** 处理弹窗：把标题、目标、需求、来源待办一起摊开，底部再放「忽略 / 发起迭代对话」。 */
let noteRecPop = null;
function noteRecPopSection(title, values) {
  const items = (values || []).filter(v => String(v ?? "").trim());
  return items.length ? h("section", { class: "notes-rec-pop-section" }, h("strong", {}, title), h("ul", {}, items.map(v => h("li", {}, v)))) : null;
}
function noteCloseRecPop({ restoreFocus = true } = {}) {
  const open = noteRecPop;
  if (!open) return;
  noteRecPop = null;
  window.removeEventListener("hashchange", open.onHash);
  try { open.dialog.close(); } catch { /* 已关闭 */ }
  open.dialog.remove();
  if (restoreFocus && open.trigger?.isConnected) open.trigger.focus({ preventScroll: true });
}
/** 处理弹窗的外壳：标题 + 说明 + 正文，底部一排操作；Esc / 点遮罩 / 换页收起，收起后焦点回到触发按钮。 */
let noteRecPopSeq = 0;
function noteOpenRecPopShell({ title, badge, body, actions, focus }) {
  noteCloseRecPop({ restoreFocus: false });
  const trigger = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  const titleId = `notes-rec-pop-title-${(noteRecPopSeq += 1)}`;
  const dialog = h("dialog", { class: "notes-rec-pop", "aria-labelledby": titleId },
    h("div", { class: "notes-rec-pop-body" },
      h("header", { class: "notes-rec-pop-head" },
        badge || null,
        h("h2", { id: titleId }, title),
        h("button", { type: "button", class: "btn small", "data-key": "notes-rec-pop-close", "aria-label": "关闭", title: "关闭", onclick: () => noteCloseRecPop() }, "关闭")),
      ...(body || []).filter(Boolean)),
    h("footer", { class: "notes-rec-pop-actions" }, ...(actions || []).filter(Boolean)));
  // 点遮罩 / 按 Esc 关闭：Esc 走 cancel，点外面走 click 命中 dialog 自身。
  dialog.addEventListener("click", (e) => { if (e.target === dialog) noteCloseRecPop(); });
  dialog.addEventListener("cancel", (e) => { e.preventDefault(); noteCloseRecPop(); });
  const onHash = () => noteCloseRecPop({ restoreFocus: false });
  window.addEventListener("hashchange", onHash);
  noteRecPop = { dialog, trigger, onHash };
  document.body.append(dialog);
  dialog.showModal();
  if (focus) focus.focus({ preventScroll: true });
  return dialog;
}

function noteOpenRecPop(task) {
  const busy = !!ui.noteIterationBusy, pending = !!task.launch;
  const goal = String(task.goal || "").trim();
  // 单条待办的目标与「需求」常常是同一句：弹窗里不重复摆两遍。
  const scope = (task.scope || []).filter(v => { const text = String(v ?? "").trim(); return text && text !== goal; });
  const sources = (task.sources || []).map(n => {
    const text = String(n.text || "").trim() || "图片需求";
    const images = n.images?.length || 0;
    return images ? `${text}（${images} 张图片）` : text;
  });
  const meta = [task.rank?.priority ? `优先推荐 ${task.rank.priority}` : null,
    task.noteIds.length > 1 ? `${task.noteIds.length} 条待办` : "单条待办",
    ...(task.rank?.reasons || [])].filter(Boolean).join(" · ");
  const more = []
    .concat(task.order?.length ? [`分期：${task.order.join("；")}`] : [])
    .concat(task.acceptance?.length ? [`验收：${task.acceptance.join("；")}`] : []);
  const ignore = () => {
    noteCloseRecPop({ restoreFocus: false });
    void noteIterationAct(`/api/note-iterations/${encodeURIComponent(task.id)}/ignore`, { revision: task.revision }, { taskId: task.id, label: "忽略", success: "已忽略，后面的推荐已前移" });
  };
  const launch = () => { noteCloseRecPop({ restoreFocus: false }); void noteStartIteration(task); };
  const launchButton = h("button", { type: "button", class: "btn primary notes-rec-pop-launch", "data-key": "notes-rec-pop-launch", disabled: busy || pending, onclick: launch }, "发起迭代对话");
  noteOpenRecPopShell({
    title: task.title,
    badge: noteRecBadge(task, 0, !!task.pinned),
    body: [
      h("p", { class: "muted small notes-rec-pop-meta" }, meta),
      goal ? h("p", { class: "notes-rec-pop-goal" }, goal) : null,
      task.noteIds.length > 1 && task.mergeReason ? h("p", { class: "muted small notes-rec-pop-meta" }, `合并理由：${task.mergeReason}`) : null,
      noteRecPopSection("需求", scope),
      noteRecPopSection("来源待办", sources),
      more.length ? h("details", { class: "notes-rec-pop-more" }, h("summary", {}, "交付与验收"), h("ul", {}, more.map(v => h("li", {}, v)))) : null
    ],
    actions: [
      h("button", { type: "button", class: "notes-rec-pop-link", "data-key": "notes-rec-pop-full", onclick: () => { const id = task.id; noteCloseRecPop({ restoreFocus: false }); noteOpenRecommendation(id); } }, "查看完整需求 ›"),
      h("button", { type: "button", class: "btn small notes-rec-pop-ignore", "data-key": "notes-rec-pop-ignore", disabled: busy || pending, title: "忽略这份推荐，后面的推荐前移；行为会用于每天 03:00 的排序校准", onclick: ignore }, "忽略"),
      launchButton
    ],
    focus: launchButton
  });
}

/** 置顶记录的处理弹窗：和非置顶的推荐同一套壳，就地摊开正文，再选「取消置顶 / 发起对话」。 */
function noteOpenPinnedPop(note) {
  const kind = noteDisplayKind(note);
  const text = String(note.text || "").trim();
  const unpinning = notePinPendingState(note.id) === "unpinning";
  const images = (note.images || []).length;
  const meta = ["置顶", NOTE_KIND_LABEL[kind], note.schedule ? noteScheduleLabel(note.schedule) : "", note.createdAt ? `记于 ${noteStamp(note.createdAt)}` : ""].filter(Boolean).join(" · ");
  // 标题取第一行（与列表行一致），正文只在多行时补一份，不把同一句话摆两遍。
  const lines = text.split("\n");
  const lead = lines.length > 1 ? text : "";
  const talkButton = h("button", {
    type: "button", class: "btn primary notes-rec-pop-launch", "data-key": "notes-rec-pop-launch", disabled: !!ui.notesBusy,
    title: "把这条记录引用到新建会话", onclick: () => { noteCloseRecPop({ restoreFocus: false }); noteStartConversation(note); }
  }, "发起对话");
  noteOpenRecPopShell({
    title: lines[0] || "（图片记录）",
    badge: notePinnedBadge({}),
    body: [
      h("p", { class: "muted small notes-rec-pop-meta" }, meta),
      lead ? h("p", { class: "notes-rec-pop-goal" }, lead) : null,
      images ? h("p", { class: "muted small notes-rec-pop-meta" }, `附带 ${images} 张图片`) : null
    ],
    actions: [
      h("button", { type: "button", class: "notes-rec-pop-link", "data-key": "notes-rec-pop-record", onclick: () => { noteCloseRecPop({ restoreFocus: false }); noteOpenNoteRecords(note.id, kind); } }, "查看记录 ›"),
      h("button", {
        type: "button", class: "btn small notes-rec-pop-ignore", "data-key": "notes-rec-pop-unpin",
        disabled: !!ui.notesBusy || unpinning, "aria-busy": unpinning ? "true" : null,
        title: "取消置顶：不再排在今日推荐最前面", onclick: () => { noteCloseRecPop({ restoreFocus: false }); void noteUnpinToday([note]); }
      }, unpinning ? "取消置顶中…" : "取消置顶"),
      talkButton
    ],
    focus: talkButton
  });
}

/** 倒计时提示：进行中 / N 分钟后 / N 小时 M 分后 / N 天后（只看开始时间）。 */
function noteCountdown(event, now = Date.now()) {
  const start = noteCalendarDate(event.start);
  if (!start) return "";
  if (event.allDay) {
    const key = noteDateKey(event.start), todayKey = noteDateKey(new Date(now));
    const days = Math.round((Date.parse(`${key}T00:00:00Z`) - Date.parse(`${todayKey}T00:00:00Z`)) / 86400000);
    return days <= 0 ? "今天" : `${days} 天后`;
  }
  const diff = start.getTime() - now;
  if (diff <= 0) return "进行中";
  const minutes = Math.ceil(diff / 60000);
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} 小时 ${rest} 分后` : `${hours} 小时后`;
  return `${Math.floor(hours / 24)} 天后`;
}

function noteUpcomingRow(event, scope = "human") {
  const day = noteUpcomingDay(event), time = noteCalendarEventTime(event), countdown = noteCountdown(event);
  const calendarName = scope === "agent" ? "Agent 日历" : "日历";
  return h("li", { class: "notes-upcoming-item" },
    h("button", {
      type: "button", class: `notes-upcoming-card${countdown === "进行中" ? " ongoing" : ""}`, "data-note-id": event.noteId || "",
      "aria-label": `${event.title}，${day} ${time}${countdown ? `，${countdown}` : ""}，在${calendarName}中查看`, title: `${day} ${time} · 在${calendarName}中查看`,
      onclick: () => noteOpenEventInCalendar(event, { scope })
    },
      h("span", { class: "notes-upcoming-when" },
        h("span", { class: "notes-upcoming-day" }, day), h("span", { class: "notes-upcoming-time" }, String(time).split("–")[0]),
        countdown ? h("span", { class: "notes-upcoming-countdown", "data-note-countdown": "" }, countdown) : null),
      h("span", { class: "notes-upcoming-title" }, event.title)));
}

/** 第一行：未来 48 小时内的前 3 个日程，横向排列；层级弱于下面的推荐。 */
function noteUpcomingSection() {
  const st = noteUpcomingState();
  const now = Date.now(), limit = now + NOTE_TODAY_EVENT_WINDOW_MS;
  const inWindow = (event) => { const d = noteCalendarDate(event.start); return !d || d.getTime() <= limit; };
  const localSoon = (st.events || []).filter(inWindow);
  // 「人」的日历 = 除 Agent 外的所有日历：本地日程 + 外部（Google / iCloud 订阅）日历，被日历页脚点掉的来源不算。
  const calendarState = ui.notesCalendar;
  const external = (st.external || []).filter((event) => {
    const end = noteCalendarDate(event.end);
    return inWindow(event) && (!end || end.getTime() > now)
      && !(calendarState && noteCalendarSourceHidden(calendarState, noteCalendarSourceKey(event)));
  });
  const startMs = (event) => noteCalendarDate(event.start)?.getTime() ?? 0;
  const soon = [...localSoon, ...external].sort((a, b) => startMs(a) - startMs(b) || String(a.title).localeCompare(String(b.title)));
  const shown = soon.slice(0, NOTE_TODAY_EVENT_LIMIT);
  const rest = Math.max(0, Math.max(st.total || 0, (st.events || []).length) - localSoon.length) + (soon.length - shown.length);
  return h("section", { id: "notes-upcoming", class: "notes-today-row notes-upcoming", "aria-label": "最近日程" },
    h("div", { class: "notes-today-row-head" },
      h("div", { class: "notes-today-row-heading" },
        h("button", {
          type: "button", class: "notes-today-cal", "data-key": "notes-today-calendar",
          "aria-label": "日历", title: "打开日历", "aria-haspopup": "dialog",
          onclick: () => noteOpenCalendarFor("human")
        }, noteTodayHeadingIcon("calendar")),
        h("h3", { class: "notes-today-row-title" }, "日程")),
      // 「更多」常驻：48 小时内没有日程、或刚好都在前三张里时也要有进日历的入口，不随数量时有时无。
      h("button", {
        type: "button", class: "notes-upcoming-more notes-module-more", "data-key": "notes-upcoming-more",
        "aria-haspopup": "dialog", title: "打开日历，查看全部日程",
        "aria-label": rest > 0 ? `更多日程（另有 ${rest} 个），打开日历` : "更多日程，打开日历",
        onclick: () => noteOpenCalendarFor("human")
      }, rest > 0 ? `更多 ${rest} 个 ›` : "更多 ›")),
    shown.length
      ? h("ol", { class: "notes-upcoming-list" }, shown.map(noteUpcomingRow))
      : h("span", { class: "muted small notes-today-empty" },
        !st.loaded && !st.error ? "正在读取日程…"
          : st.error ? `日程读取失败：${st.error}`
          : "未来 48 小时没有日程"));
}

/* --------------------- Agent 的今天卡片：今日概览 + Agent 日程 --------------------- */
// 「人」和「Agent」两张卡片放在同一个「今天」卡片里，卡头最右侧的分段按钮 / 左右滑切换：
// 人的卡片保持原样（日程 + 推荐任务）；Agent 的卡片左边是当日会话数 / 当日消耗 token / 部署次数，
// 每项下面是分项数据；右边是未来 48 小时 Agent 日历里的定时任务。日历按卡片分范围：
// 人的日历不含 Agent 日程，Agent 卡片的「更多」进入只看 Agent 的日历。

const NOTE_AGENT_ACTIVE_STATUS = new Set(["creating", "running", "waiting-input", "stopping"]);
const NOTE_AGENT_RUNTIME_ORDER = ["pi", "claude-code", "codex"];
const NOTE_RUNTIME_LABEL = { pi: "Pi", codex: "Codex", "claude-code": "Claude" };
const NOTE_AGENT_READ_TIMEOUT_MS = 8000;

/** 当前展示哪张卡片：人的卡片是默认，只有明确选过 Agent 才切过去。 */
function noteTodayWho() { return ui.notesTodayWho === "agent" ? "agent" : "human"; }

function noteRuntimeLabel(kind) {
  if (!kind) return "Runtime";
  // runtime.js 在待办页之前加载；单独加载 notes.js 的测试页没有它，退回本文件里的小表。
  if (typeof RT_KIND !== "undefined" && RT_KIND && RT_KIND[kind]) return RT_KIND[kind];
  return NOTE_RUNTIME_LABEL[kind] || String(kind);
}

/** 统计行里的短名：Pi / Claude / Codex，放得下分项；未知来源写「未知」。 */
function noteRuntimeShort(kind) {
  if (!kind || kind === "unknown") return "未知";
  return NOTE_RUNTIME_LABEL[kind] || noteRuntimeLabel(kind);
}

function noteAgentTodayState() {
  return (ui.notesAgentToday ||= {
    loading: false, loaded: false, at: 0, sessions: null, sessionsError: "",
    usage: null, usageError: "", deploys: null, deploysError: "",
    events: null, eventsError: "", tasks: 0, warnings: []
  });
}

/** token 数量压缩：亿 / 万，不足一万直接给原数（避免出现「0.0 万」）。 */
function noteCompactToken(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1).replace(/\.0$/, "")} 亿`;
  if (v >= 10_000) return `${(v / 10_000).toFixed(1).replace(/\.0$/, "")} 万`;
  return v.toLocaleString("zh-CN");
}

/**
 * 当日会话数（北京时间今天）：新建 / 在途 / 已归档三类互斥，合计就是大数字。
 * 今天有活动的会话 = 今天新建 ∪ 现在仍在进行 ∪ 今天归档；归档优先、其次在途、最后新建。
 * 目录里没有 createdAt / archivedAt 的旧数据按最后活动时间兜底，避免整块统计消失。
 */
function noteAgentSessionStats() {
  const list = noteAgentTodayState().sessions;
  if (!Array.isArray(list)) return null;
  const today = noteBeijingDateKey(new Date());
  const onDay = (iso) => !!iso && noteBeijingDateKey(iso) === today;
  const stats = { new: 0, active: 0, archived: 0, total: 0, runtimes: {} };
  for (const entry of list) {
    if (!entry) continue;
    const createdToday = onDay(entry.createdAt);
    const archivedToday = onDay(entry.archivedAt) || (!!entry.archived && !entry.archivedAt && onDay(entry.lastActivityAt));
    const activeNow = !entry.archived && NOTE_AGENT_ACTIVE_STATUS.has(entry.status);
    if (!createdToday && !archivedToday && !activeNow) continue;
    const bucket = archivedToday ? "archived" : activeNow ? "active" : "new";
    stats[bucket]++;
    stats.total++;
    const kind = entry.runtimeKind || "unknown";
    stats.runtimes[kind] = (stats.runtimes[kind] || 0) + 1;
  }
  return stats;
}

/** 今日（北京时间）各 runtime 的 token 合计；只算 runtime 报告的用量，不是账单。 */
function noteAgentTodayUsage() {
  const usage = noteAgentTodayState().usage;
  if (!usage) return null;
  const day = noteBeijingDateKey(new Date());
  const row = (usage.days || []).find((d) => d && d.day === day);
  const total = { day, input: 0, output: 0, requests: 0, runtimes: [] };
  for (const [kind, m] of Object.entries(row?.byRuntime || {})) {
    const input = Number(m?.input) || 0, output = Number(m?.output) || 0, requests = Number(m?.requests) || 0;
    if (!input && !output && !requests) continue;
    total.input += input; total.output += output; total.requests += requests;
    total.runtimes.push({ kind, input, output, requests });
  }
  total.runtimes.sort((a, b) => (b.input + b.output) - (a.input + a.output) || a.kind.localeCompare(b.kind));
  return total;
}

/** 今日部署次数（已结束的部署）和各 runtime 的拆分，来自平台部署历史。 */
function noteAgentDeployStats() {
  const data = noteAgentTodayState().deploys;
  if (!data) return null;
  const day = (data.calendar || []).find((d) => d && d.date === noteBeijingDateKey(new Date()));
  return { total: Math.max(0, Number(day?.total) || 0), runtimes: day?.runtimes || {} };
}

/** 分项：小圆点 + 分项说明 + 小数字；换行时整块换。 */
function noteAgentBreakdownItem(tone, label, value) {
  return h("span", { class: `notes-agent-breakdown-item ${tone || ""}`.trim() },
    h("i", { "aria-hidden": "true" }),
    h("span", { class: "notes-agent-breakdown-text" }, label, " ", h("b", { class: "notes-agent-breakdown-num" }, String(value))));
}

/** 会话分项：新建 / 在途 / 已归档，各带一个语义色圆点。 */
function noteAgentSessionBreakdown(stats) {
  return [
    noteAgentBreakdownItem("new", "新建", stats.new),
    noteAgentBreakdownItem("active", "在途", stats.active),
    noteAgentBreakdownItem("archived", "已归档", stats.archived)
  ];
}

/** runtime 分项：按数量从多到少（Pi 6 / Claude Code 4 / Codex 2）。 */
function noteAgentRuntimeBreakdown(counts, format = (n) => n.toLocaleString("zh-CN")) {
  return Object.entries(counts || {})
    .map(([kind, n]) => [kind, Number(n) || 0])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || NOTE_AGENT_RUNTIME_ORDER.indexOf(a[0]) - NOTE_AGENT_RUNTIME_ORDER.indexOf(b[0]))
    .map(([kind, n]) => noteAgentBreakdownItem(kind, noteRuntimeShort(kind), format(n)));
}

/** 分项行：一排小圆点条目；空数组时返回 null，不占一行。 */
function noteAgentBreakdownRow(items) {
  return items?.length ? h("p", { class: "notes-agent-stat-sub notes-agent-breakdown" }, ...items) : null;
}

function noteAgentRetryButton() {
  return h("button", {
    type: "button", class: "notes-today-retry", "data-key": "notes-agent-retry",
    onclick: () => {
      const st = noteAgentTodayState();
      st.sessionsError = ""; st.usageError = ""; st.deploysError = ""; st.eventsError = "";
      st.loaded = false; noteReplaceTodayBody();
      void noteLoadAgentToday({ force: true });
    }
  }, "重试");
}

function noteAgentStat({ id, label, value, rows, href }) {
  // 左边是大数字（指标名跟在数字下面），右边是分项；两边上下对齐。带 href 的指标整块可点，跳到统计应用看趋势。
  const headBody = [
    h("strong", { class: "notes-agent-stat-value" }, value),
    h("span", { class: "notes-agent-stat-label" }, label, href ? h("i", { class: "notes-agent-stat-go", "aria-hidden": "true" }, " ›") : null)
  ];
  return h("div", { class: "notes-agent-stat", "data-stat": id },
    href
      ? h("a", { class: "notes-agent-stat-head is-link", href, "data-key": `notes-stat-link-${id}`, "aria-label": `${label} ${value}，在统计应用查看趋势` }, ...headBody)
      : h("div", { class: "notes-agent-stat-head" }, ...headBody),
    // 子项：一行一个分项；错误行带就地重试。
    h("div", { class: "notes-agent-stat-rows" },
      ...rows.filter(Boolean).map((row) => h("p", { class: "notes-agent-stat-sub" }, ...([row].flat())))));
}

/** 左栏「今日概览」：当日会话数 / 当日消耗 token / 部署次数，每项下面按分项列数据。 */
function noteAgentStatsSection() {
  const st = noteAgentTodayState();
  const sessions = noteAgentSessionStats();
  const usage = noteAgentTodayUsage();
  const deploys = noteAgentDeployStats();
  const tokens = usage ? usage.input + usage.output : null;
  const sessionBreakdown = sessions ? noteAgentRuntimeBreakdown(sessions.runtimes) : null;
  const usageBreakdown = usage
    ? noteAgentRuntimeBreakdown(Object.fromEntries(usage.runtimes.map((r) => [r.kind, r.input + r.output])), noteCompactToken)
    : null;
  const deployBreakdown = deploys ? noteAgentRuntimeBreakdown(deploys.runtimes) : null;
  return h("section", { id: "notes-agent-stats", class: "notes-today-row notes-agent-stats", "aria-label": "今日概览" },
    h("div", { class: "notes-today-row-head" },
      h("div", { class: "notes-today-row-heading" },
        noteTodayHeadingIcon("overview"),
        h("h3", { class: "notes-today-row-title" }, "今日概览")),
      h("button", {
        type: "button", class: "notes-module-more", "data-key": "notes-agent-refresh", disabled: !!st.loading,
        title: "重新读取今日会话、token 和部署", onclick: () => void noteLoadAgentToday({ force: true })
      }, st.loading ? "刷新中…" : "刷新")),
    h("div", { class: "notes-agent-stat-list" },
      noteAgentStat({
        id: "sessions", label: "当日会话数",
        value: sessions ? String(sessions.total) : "—",
        rows: [
          sessions
            ? noteAgentBreakdownRow(noteAgentSessionBreakdown(sessions))
            : st.sessionsError ? [`会话读取失败：${st.sessionsError}`, noteAgentRetryButton()] : "正在读取会话…",
          sessions ? (sessionBreakdown?.length ? noteAgentBreakdownRow(sessionBreakdown) : "今天还没有会话活动") : null
        ]
      }),
      noteAgentStat({
        id: "tokens", label: "当日消耗 token",
        value: tokens === null ? "—" : noteCompactToken(tokens),
        rows: [
          usage
            ? (usageBreakdown?.length ? noteAgentBreakdownRow(usageBreakdown) : "今天还没有 runtime 用量")
            : st.usageError ? [`token 读取失败：${st.usageError}`, noteAgentRetryButton()] : "正在读取用量…",
          ...(st.usage?.unattributed || []).map((r) =>
            h("span", { class: "notes-agent-unattributed" },
              `${noteRuntimeShort(r.runtimeKind)} ${noteCompactToken(r.total ?? ((r.input || 0) + (r.output || 0)))}（累计，无法分日）`))
        ]
      }),
      noteAgentStat({
        id: "deploys", label: "部署次数",
        value: deploys ? String(deploys.total) : "—",
        rows: [
          deploys
            ? (deployBreakdown?.length ? noteAgentBreakdownRow(deployBreakdown) : "今天还没有部署")
            : st.deploysError ? [`部署读取失败：${st.deploysError}`, noteAgentRetryButton()] : "正在读取部署…"
        ]
      })));
}

/** Agent 日程：未来 48 小时内（含正在进行的）最多 3 个，剩下的去 Agent 日历看。 */
function noteAgentUpcomingEvents() {
  const now = Date.now(), limit = now + NOTE_TODAY_EVENT_WINDOW_MS;
  return (noteAgentTodayState().events || [])
    .filter((event) => {
      const start = noteCalendarDate(event.start), end = noteCalendarDate(event.end);
      if (end && end.getTime() <= now) return false;
      if (start && start.getTime() > limit) return false;
      return true;
    })
    .sort((a, b) => (noteCalendarDate(a.start)?.getTime() || 0) - (noteCalendarDate(b.start)?.getTime() || 0)
      || String(a.title || "").localeCompare(String(b.title || "")));
}

function noteAgentScheduleSection() {
  const st = noteAgentTodayState();
  const events = noteAgentUpcomingEvents();
  const shown = events.slice(0, NOTE_TODAY_EVENT_LIMIT);
  const rest = events.length - shown.length;
  const loading = !st.loaded && !st.eventsError;
  return h("section", { id: "notes-agent-schedule", class: "notes-today-row notes-upcoming notes-agent-schedule", "aria-label": "Agent 日程" },
    h("div", { class: "notes-today-row-head" },
      h("div", { class: "notes-today-row-heading" },
        h("button", {
          type: "button", class: "notes-today-cal", "data-key": "notes-agent-calendar",
          "aria-label": "Agent 日历", title: "打开 Agent 日历", "aria-haspopup": "dialog",
          onclick: () => noteOpenCalendarFor("agent")
        }, noteTodayHeadingIcon("calendar")),
        h("h3", { class: "notes-today-row-title" }, "Agent 日程")),
      h("button", {
        type: "button", class: "notes-upcoming-more notes-module-more", "data-key": "notes-agent-schedule-more",
        "aria-haspopup": "dialog", title: "打开 Agent 日历，查看全部定时任务",
        "aria-label": rest > 0 ? `更多 Agent 日程（另有 ${rest} 个），打开 Agent 日历` : "更多 Agent 日程，打开 Agent 日历",
        onclick: () => noteOpenCalendarFor("agent")
      }, rest > 0 ? `更多 ${rest} 个 ›` : "更多 ›")),
    shown.length
      ? h("ol", { class: "notes-upcoming-list" }, shown.map((event) => noteUpcomingRow(event, "agent")))
      : h("span", { class: "muted small notes-today-empty", role: "status" },
        st.eventsError ? `Agent 日程读取失败：${st.eventsError}`
          : loading ? "正在读取 Agent 日程…"
            : "未来 48 小时没有 Agent 日程",
        st.eventsError ? noteAgentRetryButton() : null));
}

function noteAgentTodayChildren() {
  return [noteAgentStatsSection(), noteAgentScheduleSection()];
}

let noteAgentTodayFlight = null;
/** 读 Agent 卡片的四块数据：今日会话（目录）、今日 token（用量）、部署历史、未来 48h 的 Agent 日程。 */
function noteLoadAgentToday({ force = true } = {}) {
  const st = noteAgentTodayState();
  if (noteAgentTodayFlight) return noteAgentTodayFlight;
  if (st.loaded && !force) return Promise.resolve();
  st.loading = true;
  const from = new Date(Date.now() - 3_600_000).toISOString();
  const to = new Date(Date.now() + NOTE_TODAY_EVENT_WINDOW_MS).toISOString();
  const read = (path) => api(path, { readTimeoutMs: NOTE_AGENT_READ_TIMEOUT_MS })
    .then((value) => ({ value }), (error) => ({ error }));
  const flight = Promise.all([
    // 已归档的要带上（当日会话数的「已归档」分项），目录自带 createdAt / archivedAt。
    read("/api/session-directory?source=chat&archived=include&limit=200"),
    read(`/api/runtime-usage?days=1&tz=${encodeURIComponent(NOTE_PLATFORM_TIME_ZONE)}`),
    read(`/api/platform/deployments?limit=1&tz=${encodeURIComponent(NOTE_PLATFORM_TIME_ZONE)}`),
    read(`/api/calendar/agent?${new URLSearchParams({ from, to }).toString()}`)
  ]).then(([dir, usage, deploys, calendar]) => {
    if (dir.error) st.sessionsError = dir.error.message || "读取失败";
    else { st.sessions = Array.isArray(dir.value?.entries) ? dir.value.entries : []; st.sessionsError = ""; }
    if (usage.error) st.usageError = usage.error.message || "读取失败";
    else { st.usage = usage.value || null; st.usageError = ""; }
    if (deploys.error) st.deploysError = deploys.error.message || "读取失败";
    else { st.deploys = deploys.value || null; st.deploysError = ""; }
    if (calendar.error) st.eventsError = calendar.error.message || "读取失败";
    else {
      st.events = Array.isArray(calendar.value?.agent) ? calendar.value.agent : [];
      st.tasks = Number(calendar.value?.tasks) || 0;
      st.warnings = Array.isArray(calendar.value?.warnings) ? calendar.value.warnings.filter(Boolean) : [];
      st.eventsError = "";
    }
    st.loaded = true;
    st.at = Date.now();
  }).finally(() => {
    st.loading = false;
    if (noteAgentTodayFlight === flight) noteAgentTodayFlight = null;
    if (noteTodayMounted() && noteTodayWho() === "agent") {
      noteReplaceTodayBody();
      noteInstallTodaySwipe(document.getElementById("notes-today-body"));
    }
  });
  noteAgentTodayFlight = flight;
  return flight;
}

/** 倒计时每 30 秒续一拍：Agent 卡片的日程也一起重画（只替换日程模块，不动左侧统计）。 */
function noteReplaceAgentSchedule() {
  const el = document.getElementById("notes-agent-schedule");
  if (el && noteTodayMounted()) el.replaceWith(noteAgentScheduleSection());
}

/** 停在 Agent 卡片时，今日概览每 5 分钟重读一次；切走就停。 */
function noteRefreshAgentTodayIfStale() {
  if (noteTodayWho() !== "agent") return;
  const st = noteAgentTodayState();
  if (st.loading || Date.now() - (st.at || 0) < 300_000) return;
  void noteLoadAgentToday({ force: true });
}


/**
 * 今日推荐现在只读几 KB 的 summary（不再拉整份快照）：日程读完后很快补上，不必再等 800ms，
 * 也不因为列表还在加载而一轮轮推迟；读取仍走全局读预算，不和首屏关键请求硬抢。
 */
let noteTodayRecsTimer = null;
function noteLoadTodayRecsLater() {
  if (noteTodaySummaryData() || noteTodayRecsTimer) return;
  noteTodayRecsTimer = setTimeout(() => {
    noteTodayRecsTimer = null;
    if (!noteTodayMounted() || noteTodaySummaryData()) return;
    void noteLoadTodaySummary();
  }, 120);
}

/**
 * 「今天」卡片只要前 3 条可发起的推荐和各状态计数：读 /api/note-iterations/summary（几 KB），
 * 不再把整份推荐快照（几百 KB，且随已完成的推荐越积越多）拉下来；完整列表等打开「推荐任务」浮层再分页读。
 */
let noteTodaySummaryLoading = false, noteTodaySummaryFlight = null;
function noteLoadTodaySummary() {
  // 共用一个在途请求：置顶操作要等它真正结束，才能说“所有局部刷新完成”。
  if (noteTodaySummaryFlight) return noteTodaySummaryFlight;
  noteTodaySummaryLoading = true;
  const flight = (async () => {
    try {
      // 读取期间本地操作写入了更新的状态（epoch 变了）：这次结果作废，重读一次。
      for (let attempt = 0; attempt < 2; attempt++) {
        const epoch = noteIterationsEpoch;
        const read = () => api(`/api/note-iterations/summary?limit=${NOTE_TODAY_REC_LIMIT}`, { readPriority: 2, ...noteReadOptions() });
        const data = typeof retryTransientRead === "function"
          ? await retryTransientRead(read, noteTodayMounted, NOTE_SUMMARY_RETRY_WAITS)
          : await read();
        if (!data || !Array.isArray(data.tasks) || !data.counts) throw new Error("推荐任务响应格式无效，请重试");
        if (epoch !== noteIterationsEpoch && attempt === 0) continue;
        ui.noteIterationSummary = data; ui.noteIterationSummaryError = "";
        break;
      }
    } catch (e) {
      ui.noteIterationSummaryError = e.message;
    } finally {
      noteTodaySummaryLoading = false;
      // 推荐快照（或失败结果）已经回来：给「刷新中…」的推荐行收尾，别让它一直停在那儿。
      noteIterationLaunchRefreshed();
      // 手指按着（拖拽）/ 正在输入法组字时不重绘，等放开后再补，和推荐列表的刷新同一规则。
      noteRefreshRecommended();
    }
  })().finally(() => {
    noteTodaySummaryLoading = false;
    if (noteTodaySummaryFlight === flight) noteTodaySummaryFlight = null;
  });
  noteTodaySummaryFlight = flight;
  return flight;
}
/** 卡片数据：优先用摘要；没有摘要但已有整份快照（旧形态）时，从快照里推出同样的结构。 */
function noteTodaySummaryData() {
  if (ui.noteIterationSummary) return ui.noteIterationSummary;
  const full = ui.noteIterations;
  if (!full || !Array.isArray(full.tasks) || full.page) return null;
  const visible = full.tasks.filter((t) => t.status !== "invalid" && t.noteIds.length > 0);
  const ready = noteIterationOrder(visible.filter((t) => t.status === "ready" && t.launchable !== false && !t.deferred));
  return {
    enabled: full.enabled, tasks: ready,
    counts: { all: visible.length, launchable: ready.length, decision: visible.filter((t) => t.status === "decision").length },
    pinnedNotes: noteTodayPinnedNotes({})
  };
}

/** 今日推荐：置顶的笔记 / 待办排在最前，其后是可发起的推荐任务；完整列表、判定与修订在「全部推荐任务」里。 */
function noteTodayRecChildren() {
  noteScheduleRoiExposure();
  const data = noteTodaySummaryData();
  const toggle = (label) => h("button", {
    type: "button", class: "notes-today-more notes-module-more", "data-key": "notes-today-recommended-toggle",
    "aria-haspopup": "dialog", onclick: () => noteSetTab("recommended")
  }, label);
  // 模块右上角：「更多」，与日程模块的「更多」同一位置、同一弱化样式；可发起条数已由右侧（N）体现，不再重复计数
  const head = (extra, label) => h("div", { class: "notes-today-col-head" },
    h("h3", { class: "notes-today-col-title" }, noteTodayHeadingIcon("sparkle"), "推荐任务"),
    h("div", { class: "notes-today-col-meta" }, extra || null, toggle(label)));
  // 刚发起会话的推荐：数据里可能已经把它摘掉了，仍先占一行显示「刷新中…」，不要凭空消失。
  const launchRows = () => Object.values(noteLaunchRefreshingMap());
  if (!data) {
    // 读取失败：置顶记录仍先显示；推荐部分给一个就地「重试」，不影响上面的日程和下面的列表。
    const error = ui.noteIterationSummaryError || ui.noteIterationsError;
    const retry = () => { ui.noteIterationSummaryError = ""; ui.noteIterationsError = ""; noteReplaceTodayRecs(); void noteLoadTodaySummary(); };
    const pinned = noteTodayPinnedNotes({});
    const pending = launchRows();
    return [head(null, pinned.length ? `更多（${pinned.length}） ›` : "更多 ›"),
      ...(pinned.length ? [h("ol", { class: "notes-rec-list" }, pinned.map(notePinnedNoteRow))] : []),
      ...(pending.length ? [h("ol", { class: "notes-rec-list" }, pending.map(noteTaskLaunchRefreshingRow))] : []),
      h("p", { class: "muted small notes-today-empty", role: "status" },
        error || "正在读取推荐任务…",
        error ? h("button", { type: "button", class: "notes-today-retry", "data-key": "notes-today-recs-retry", onclick: retry }, "重试") : null)];
  }
  const counts = data.counts || {};
  const pinnedNotes = noteTodayPinnedNotes(data);
  const tasks = (data.tasks || []).filter((t) => t.status === "ready" && t.launchable !== false && !t.deferred && Array.isArray(t.noteIds) && t.noteIds.length > 0);
  // 已进入推荐的置顶笔记不再单独出一行：那条推荐本身带上置顶标记。
  const taskSourceIds = new Set(tasks.flatMap((t) => t.noteIds));
  const standalonePinned = pinnedNotes.filter((n) => !taskSourceIds.has(n.id));
  const pinnedTasks = tasks.filter((t) => noteTaskPinned(t, pinnedNotes));
  const pinnedTaskIds = new Set(pinnedTasks.map((t) => t.id));
  const pinnedRows = [
    ...standalonePinned.map((note) => ({ type: "note", at: Date.parse(note.pinnedAt || note.createdAt) || 0, note })),
    ...pinnedTasks.map((task) => ({ type: "task", at: noteTaskPinnedAt(task, pinnedNotes), task }))
  ].sort((a, b) => b.at - a.at);
  const remaining = Math.max(0, NOTE_TODAY_REC_LIMIT - pinnedRows.length);
  const rest = tasks.filter((t) => !pinnedTaskIds.has(t.id)).slice(0, remaining);
  const decisions = counts.decision || 0;
  // 「更多（N）」的 N 与抽屉默认列表（待启动 · 优先推荐）同一口径：优先推荐窗口里可发起的条数。
  // 用 counts.all 会把已完成、已发起、已忽略也算进来（卡片写 63，点开只有 2 条）。没有窗口计数时退回可发起数。
  const total = typeof counts.window === "number" ? counts.window : counts.launchable ?? counts.all ?? 0;
  const unranked = counts.unranked || 0;
  const shown = [...pinnedRows.map((row) => row.type === "note" ? notePinnedNoteRow(row.note) : noteTaskRecRow(row.task, 0, true, pinnedNotes)), ...rest.map((t, i) => noteTaskRecRow(t, i, false, pinnedNotes))];
  // 刚发起会话、已经不在摘要里的那些仍排在后面显示「刷新中…」（还在列表里的由行本身处理，不重复画）。
  const shownIds = new Set([...tasks.map((t) => t.id), ...pinnedNotes.map((n) => n.id)]);
  const rows = [...shown, ...launchRows().filter((entry) => !shownIds.has(entry.id)).map(noteTaskLaunchRefreshingRow)];
  // 没排满 3 条时说明剩下的去哪了：评估中的自己会好，评估失败的要就地重试，价值不够的永远不会进窗口。
  const hint = rows.length < NOTE_TODAY_REC_LIMIT
    ? noteTodayUnrankedHint({ unranked, assessing: counts.assessing, blocked: counts.blocked, belowFloor: counts.belowFloor, aggregate: data.aggregate })
    : null;
  if (data.enabled === false && !rows.length) return [head(null, "更多 ›"), h("p", { class: "muted small notes-today-empty" }, "自动推荐未启用。")];
  return [
    head(null, `更多${total ? `（${total}）` : ""} ›`),
    rows.length
      // 一行一条：序号（置顶行换成图钉）+ 标题 + 忽略 + 发起；标题是文字按钮，点开看完整需求 / 定位记录。
      ? h("ol", { class: "notes-rec-list" }, rows)
      : h("p", { class: "muted small notes-today-empty" }, data.enabled === false ? "自动推荐未启用。" : decisions ? `暂无可直接发起的推荐，${decisions} 个等你决策。` : "暂时没有可发起的推荐。"),
    hint
  ];
}

/**
 * 「今天」卡片没排满时的去向说明。三种情况不能混成一句：
 * - 整理器失败 / 有评估失败：只有人类点「重试」会继续，必须给出按钮，否则卡片看起来像还在跑；
 * - 评估中：自己会好；
 * - 未过价值底线（low / unknown）：按策略永远不会进优先推荐，不能写成“补齐后进入”。
 */
function noteTodayUnrankedHint({ unranked, assessing, blocked, belowFloor, aggregate }) {
  const cls = "muted small notes-today-empty notes-today-unranked";
  if (aggregate?.state === "failed") {
    const message = aggregate.error || (unranked > 0 ? `推荐整理失败，${unranked} 条待评估暂时无法进入优先推荐。` : "推荐整理失败，暂时无法生成新的推荐。");
    return h("p", { class: cls, role: "status" }, message, noteTodayRetryAnalysisButton());
  }
  if (blocked > 0) {
    return h("p", { class: cls, role: "status" },
      `另有 ${blocked} 条评估没跑完，重试后可进入优先推荐。`, noteTodayRetryAnalysisButton());
  }
  // 旧版摘要没有拆分计数：退回原句，不报错。
  if (typeof assessing !== "number") {
    return unranked > 0 ? h("p", { class: cls, role: "status" }, `另有 ${unranked} 条待评估，补齐投入产出后进入优先推荐`) : null;
  }
  const parts = [];
  if (assessing > 0) parts.push(`${assessing} 条评估中`);
  if (belowFloor > 0) parts.push(`${belowFloor} 条未过价值底线，不会进入优先推荐`);
  if (!parts.length) return null;
  return h("p", { class: cls, role: "status" }, `另有 ${unranked} 条待评估：${parts.join("，")}`);
}

function noteTodayRetryAnalysisButton() {
  const busy = !!ui.noteTodayRetryBusy;
  return h("button", { type: "button", class: "notes-today-retry", "data-key": "notes-today-recs-retry-analysis", disabled: busy, "aria-busy": busy ? "true" : null,
    onclick: () => void noteTodayRetryAnalysis() }, busy ? "重试中…" : "重试");
}

/** 卡片就地重试失败的分析 / 整理：只重发任务并刷新摘要，不拉整份推荐快照。 */
async function noteTodayRetryAnalysis() {
  if (ui.noteTodayRetryBusy) return;
  ui.noteTodayRetryBusy = true; noteReplaceTodayRecs();
  try {
    await api("/api/note-iterations/retry", { method: "POST", body: "{}" });
    ui.noteIterationSummaryError = ""; ui.noteIterationsError = "";
    // 已打开的抽屉拿着旧快照：作废在途读取，等摘要回来后再按当前筛选重读。
    noteIterationsEpoch++; noteIterationsToken = null;
  } catch (e) {
    ui.noteIterationSummaryError = e.message;
  } finally { ui.noteTodayRetryBusy = false; }
  noteReplaceTodayRecs();
  void noteLoadTodaySummary();
  if (document.getElementById("notes-recommended-panel")) void noteLoadIterations();
}

/** 点今日推荐的标题：拉起「推荐任务」抽屉并翻到这一条，看完整需求、来源和操作。 */
function noteOpenRecommendation(taskId) {
  noteIterationsEpoch++; noteIterationsToken = null;
  ui.noteIterationScope = "window";
  ui.noteIterationFilter = "ready";
  ui.notesFocusIteration = taskId || "";
  noteSetTab("recommended");
  noteRefreshRecommended();
}

/* ------------------------------ 「今天」卡片：人 / Agent 两张 ------------------------------ */
// 卡头是一组分段按钮（也支持左右滑 / 键盘左右键）：人的卡片保持原样，Agent 卡片换成进行中 + Agent 日程。
// 只替换卡片节点，不重绘整页，输入框草稿和下面的列表不受影响。

const NOTE_TODAY_SWIPE_MIN = 56;
const NOTE_TODAY_SWIPE_IGNORE = "input, textarea, select, pre, table, dialog, .notes-upcoming-list";

function noteTodaySwitchButton(who, label, ariaLabel) {
  const active = noteTodayWho() === who;
  return h("button", {
    type: "button", role: "tab", id: `notes-today-tab-${who}`, "data-key": `notes-today-${who}`,
    class: `notes-today-switch-btn${active ? " active" : ""}`,
    "aria-selected": String(active), "aria-controls": "notes-today-body", "aria-label": ariaLabel,
    tabindex: active ? "0" : "-1",
    onclick: () => noteSwitchToday(who, { focus: true })
  }, label);
}

function noteTodaySwitch() {
  return h("div", { class: "notes-today-switch", role: "tablist", "aria-label": "今天卡片", onkeydown: noteTodaySwitchKeys },
    noteTodaySwitchButton("human", "人", "人的今天卡片"),
    noteTodaySwitchButton("agent", "Agent", "Agent 的今天卡片"));
}

/** 分段按钮上的左右键 / Home / End：和滑动手势一样在两张卡片之间切。 */
function noteTodaySwitchKeys(ev) {
  const next = ({ ArrowLeft: "human", ArrowRight: "agent", Home: "human", End: "agent" })[ev.key];
  if (!next) return;
  ev.preventDefault();
  noteSwitchToday(next, { focus: true });
}

/* --------------------- 人的今天卡片：今日数据（消耗 / 部署 / 会话） --------------------- */
// 推荐任务下面的一块总览：每项一个大数字（总数为主），分项用弱化的小字跟在后面。
// 消耗以美元计：Pi 按 DeepSeek 用量 × 单价，Claude / Codex 按订阅月费摊到每小时（服务端 /api/platform/today-cost）；
// 部署取平台部署历史的今日统计；会话数 = 今天有新事件（最后活动在北京时间今天）的会话。
const NOTE_OVERVIEW_STALE_MS = 300_000;
function noteOverviewState() {
  return (ui.notesTodayOverview ||= {
    loading: false, loaded: false, at: 0,
    cost: null, costError: "", deploys: null, deploysError: "", sessions: null, sessionsError: ""
  });
}

function noteOverviewUsd(value) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(2)}` : "—";
}

/** 今天有新事件的会话数（含已归档的）和各 runtime 的拆分；目录里没有最后活动时间的不算。 */
function noteOverviewSessionStats() {
  const list = noteOverviewState().sessions;
  if (!Array.isArray(list)) return null;
  const today = noteBeijingDateKey(new Date());
  const stats = { total: 0, runtimes: {} };
  for (const entry of list) {
    if (!entry || !entry.lastActivityAt || noteBeijingDateKey(entry.lastActivityAt) !== today) continue;
    stats.total++;
    const kind = entry.runtimeKind || "unknown";
    stats.runtimes[kind] = (stats.runtimes[kind] || 0) + 1;
  }
  return stats;
}

function noteOverviewDeployStats() {
  const today = noteOverviewState().deploys?.periods?.today;
  if (!today) return null;
  const total = Math.max(0, Number(today.total) || 0), failed = Math.max(0, Number(today.failed) || 0);
  const ok = Math.max(0, Number(today.ok) || 0);
  // 失败率 = 失败 ÷（成功 + 失败）：取消、过期、已在线上的不算一次真正的部署结果；和统计应用的成功率同口径
  return { total, ok, failed, rate: ok + failed ? Math.round(failed / (ok + failed) * 100) : 0 };
}

function noteOverviewRetryButton() {
  return h("button", {
    type: "button", class: "notes-today-retry", "data-key": "notes-overview-retry",
    onclick: () => void noteLoadTodayOverview({ force: true })
  }, "重试");
}

function noteTodayOverviewSection() {
  const st = noteOverviewState();
  const cost = st.cost, sessions = noteOverviewSessionStats(), deploys = noteOverviewDeployStats();
  const costItems = cost
    ? NOTE_AGENT_RUNTIME_ORDER.map((kind) => noteAgentBreakdownItem(kind, noteRuntimeShort(kind), noteOverviewUsd(cost.runtimes?.[kind]?.usd)))
    : null;
  const sessionItems = sessions ? noteAgentRuntimeBreakdown(sessions.runtimes) : null;
  return h("section", { id: "notes-today-overview", class: "notes-today-row notes-agent-stats notes-today-overview", "aria-label": "今日数据" },
    h("div", { class: "notes-today-row-head" },
      h("div", { class: "notes-today-row-heading" },
        noteTodayHeadingIcon("overview"),
        h("h3", { class: "notes-today-row-title" }, "今日数据")),
      h("button", {
        type: "button", class: "notes-module-more", "data-key": "notes-overview-refresh", disabled: !!st.loading,
        title: "重新读取今日消耗、部署和会话", onclick: () => void noteLoadTodayOverview({ force: true })
      }, st.loading ? "刷新中…" : "刷新")),
    h("div", { class: "notes-agent-stat-list" },
      noteAgentStat({
        id: "cost", label: "消耗 (美元)", href: "#/stats/cost?m=usd&focus=trend",
        value: cost ? noteOverviewUsd(cost.total) : "—",
        rows: [
          cost ? noteAgentBreakdownRow(costItems) : st.costError ? [`消耗读取失败：${st.costError}`, noteOverviewRetryButton()] : "正在读取消耗…",
          cost?.partial ? "部分费用暂缺（汇率或单价不可用），合计偏低" : null
        ]
      }),
      noteAgentStat({
        id: "deploys", label: "部署次数", href: "#/stats/deploys?m=deploys&focus=trend",
        value: deploys ? String(deploys.total) : "—",
        rows: [
          deploys
            ? (deploys.total
              ? noteAgentBreakdownRow([
                noteAgentBreakdownItem("ok", "成功", deploys.ok),
                noteAgentBreakdownItem("failed", "失败", deploys.failed),
                noteAgentBreakdownItem("rate", "失败率", `${deploys.rate}%`)
              ])
              : "今天还没有部署")
            : st.deploysError ? [`部署读取失败：${st.deploysError}`, noteOverviewRetryButton()] : "正在读取部署…"
        ]
      }),
      noteAgentStat({
        id: "sessions", label: "活跃会话", href: "#/stats/sessions?focus=trend",
        value: sessions ? String(sessions.total) : "—",
        rows: [
          sessions
            ? (sessionItems?.length ? noteAgentBreakdownRow(sessionItems) : "今天还没有会话活动")
            : st.sessionsError ? [`会话读取失败：${st.sessionsError}`, noteOverviewRetryButton()] : "正在读取会话…"
        ]
      })));
}

function noteReplaceTodayOverview() {
  const el = document.getElementById("notes-today-overview");
  if (el && noteTodayMounted()) el.replaceWith(noteTodayOverviewSection());
}

let noteOverviewFlight = null;
/** 读「今日数据」的三块：今日消耗、部署统计、会话目录；各自失败各自提示，不连累其它两块。 */
function noteLoadTodayOverview({ force = true } = {}) {
  const st = noteOverviewState();
  if (noteOverviewFlight) return noteOverviewFlight;
  if (st.loaded && !force && Date.now() - st.at < NOTE_OVERVIEW_STALE_MS) return Promise.resolve();
  st.loading = true;
  noteReplaceTodayOverview();
  const read = (path) => api(path, { readTimeoutMs: NOTE_AGENT_READ_TIMEOUT_MS })
    .then((value) => ({ value }), (error) => ({ error }));
  const flight = Promise.all([
    read(`/api/platform/today-cost`),
    read(`/api/platform/deployments?limit=1&tz=${encodeURIComponent(NOTE_PLATFORM_TIME_ZONE)}`),
    // 已归档的也带上：今天有过事件、又被归档的会话照样算。
    read("/api/session-directory?source=chat&archived=include&limit=200")
  ]).then(([cost, deploys, dir]) => {
    if (cost.error) st.costError = cost.error.message || "读取失败";
    else { st.cost = cost.value || null; st.costError = ""; }
    if (deploys.error) st.deploysError = deploys.error.message || "读取失败";
    else { st.deploys = deploys.value || null; st.deploysError = ""; }
    if (dir.error) st.sessionsError = dir.error.message || "读取失败";
    else { st.sessions = Array.isArray(dir.value?.entries) ? dir.value.entries : []; st.sessionsError = ""; }
    st.loaded = true;
    st.at = Date.now();
  }).finally(() => {
    st.loading = false;
    if (noteOverviewFlight === flight) noteOverviewFlight = null;
    noteReplaceTodayOverview();
  });
  noteOverviewFlight = flight;
  return flight;
}

/** 停在人的卡片时，今日数据每 5 分钟重读一次；切走就停。 */
function noteRefreshOverviewIfStale() {
  if (noteTodayWho() !== "human") return;
  const st = noteOverviewState();
  if (st.loading || Date.now() - (st.at || 0) < NOTE_OVERVIEW_STALE_MS) return;
  void noteLoadTodayOverview({ force: true });
}

function noteTodayBodyChildren() {
  if (noteTodayWho() === "agent") return noteAgentTodayChildren();
  return [noteUpcomingSection(), h("section", { id: "notes-today-recs", class: "notes-today-col", "aria-label": "今日推荐" }, ...noteTodayRecChildren()), noteTodayOverviewSection()];
}

function noteTodayMounted() { return !!document.getElementById("notes-today"); }

function noteTodaySection() {
  const today = noteBeijingParts(new Date());
  const who = noteTodayWho();
  return h("section", { id: "notes-today", class: "notes-today", "aria-label": "今天" },
    h("div", { class: "notes-today-head" },
      h("h2", { class: "notes-section-title" }, "今天"),
      h("span", { class: "muted notes-today-date" }, `${today.month} 月 ${today.day} 日 · 周${NOTE_WEEKDAY[today.weekday]}`),
      noteTodaySwitch()),
    h("div", { id: "notes-today-body", class: `notes-today-body${who === "agent" ? " agent" : ""}`, role: "tabpanel", "aria-labelledby": `notes-today-tab-${who}` },
      ...noteTodayBodyChildren().filter(Boolean)));
}

/** 只重画卡片正文（数据刷新后再进来）：卡头分段按钮不重建，焦点不会丢。 */
function noteReplaceTodayBody() {
  const el = document.getElementById("notes-today-body");
  if (el && noteTodayMounted()) el.replaceChildren(...noteTodayBodyChildren().filter(Boolean));
}

/** 切换：整张卡片重建（两个范围的结构不同），切到 Agent 时顺手读三块数据。 */
function noteSwitchToday(who, { focus = false } = {}) {
  const next = who === "agent" ? "agent" : "human";
  const previous = noteTodayWho();
  const scopeChanged = noteSetCalendarScope(next);
  // 卡片切换不跳日期，也不打开手机浮层；可见的日历立即按新范围读取。
  if (scopeChanged && ui.view === "notes" && (noteCalendarInlineOpen() || ui.notesTab === "calendar")) void noteLoadCalendar();
  if (previous === next) {
    if (focus) document.getElementById(`notes-today-tab-${next}`)?.focus({ preventScroll: true });
    return;
  }
  ui.notesTodayWho = next;
  const old = document.getElementById("notes-today");
  if (!old || !noteTodayMounted()) return;
  const fresh = noteTodaySection();
  old.replaceWith(fresh);
  noteInstallTodaySwipe(fresh.querySelector("#notes-today-body"));
  // 新卡片从切换方向的那一侧滑入（人 → Agent 从右边来，反过来从左边来），不是一下子换掉
  noteTodaySlideIn(fresh, next === "agent" ? 1 : -1);
  if (focus) fresh.querySelector(`#notes-today-tab-${next}`)?.focus({ preventScroll: true });
  if (next === "agent") void noteLoadAgentToday();
  else {
    if (!noteUpcomingState().loaded && !noteUpcomingState().loading) void noteLoadUpcoming();
    noteLoadTodayRecsLater();
    void noteLoadTodayOverview({ force: false });
  }
}

const NOTE_TODAY_SLIDE_MS = 160;
function noteReducedMotion() {
  try { return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

/** 新的「今天」卡片正文从切换方向那一侧滑入并淡入；direction > 0 从右边来。系统要求减少动效时不播放。 */
function noteTodaySlideIn(section, direction) {
  const body = section?.querySelector?.("#notes-today-body");
  if (!body || !direction || noteReducedMotion()) return;
  section.classList.add("is-sliding");
  const cls = direction > 0 ? "today-slide-from-right" : "today-slide-from-left";
  body.classList.add(cls);
  const done = () => { body.classList.remove(cls); section.classList.remove("is-sliding"); };
  body.addEventListener("animationend", done, { once: true });
  // animationend 偶尔不触发（节点被替换、标签页在后台）：兜底收尾，别让卡片卡在裁切状态
  setTimeout(done, 600);
}

/** 手势方向指向的另一张「今天」卡片（人 → Agent 只能向左滑，Agent → 人只能向右滑）；竖滑、方向不对返回 null。 */
function noteTodaySwipeNext(dx, dy) {
  if (Math.abs(dx) < Math.abs(dy) * 1.4) return null;
  const who = noteTodayWho();
  return (who === "human" ? dx < 0 : dx > 0) ? (who === "human" ? "agent" : "human") : null;
}

/**
 * 手机上在卡片正文左右滑切换人 / Agent：正文跟手移动，松手过了阈值就滑出、换成另一张并从对面滑入，
 * 没过阈值弹回原位。人的卡片只能向左滑（去 Agent），Agent 的卡片只能向右滑（回到人）；
 * 横向滚动区里的手势不抢。
 */
function noteInstallTodaySwipe(body) {
  if (!body || body.dataset.todaySwipe) return;
  body.dataset.todaySwipe = "1";
  let drag = null;
  const section = () => body.closest("#notes-today");
  const setOffset = (dx, width) => {
    body.style.transform = dx ? `translateX(${dx}px)` : "";
    body.style.opacity = dx ? String(Math.max(0.25, 1 - Math.abs(dx) / (width * 0.9))) : "";
  };
  const clearOffset = () => { body.style.transition = ""; body.style.transform = ""; body.style.opacity = ""; section()?.classList.remove("is-sliding"); };
  body.addEventListener("pointerdown", (ev) => {
    drag = null;
    if (ev.pointerType !== "touch" || ev.target.closest?.(NOTE_TODAY_SWIPE_IGNORE) || body.dataset.todayLeaving) return;
    drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, width: body.clientWidth || window.innerWidth || 1, active: false };
  });
  body.addEventListener("pointermove", (ev) => {
    const s = drag;
    if (!s || ev.pointerId !== s.id) return;
    const dx = ev.clientX - s.x, dy = ev.clientY - s.y;
    if (!s.active) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
      // 竖滑留给页面滚动；方向不对（人的卡片往右、Agent 的卡片往左）也不接管
      if (!noteTodaySwipeNext(dx, dy)) { drag = null; return; }
      s.active = true;
      body.style.transition = "none";
      section()?.classList.add("is-sliding");
      // 横滑确认后捕获到正文，异步刷新子节点或手指移出卡片仍能收到抬起事件。
      try { body.setPointerCapture?.(ev.pointerId); } catch { /* 合成事件没有活动指针 */ }
    }
    // 只往允许的方向跟手，反向回拉最多回到原位
    const limited = noteTodayWho() === "human" ? Math.min(0, dx) : Math.max(0, dx);
    setOffset(limited, s.width);
  });
  body.addEventListener("pointerup", (ev) => {
    const s = drag; drag = null;
    try { body.releasePointerCapture?.(ev.pointerId); } catch { /* 没有捕获就忽略 */ }
    if (!s || !s.active || s.id !== ev.pointerId) return;
    const dx = ev.clientX - s.x;
    // 已经横滑：挡掉这次落在日程卡片 / 会话链接上的 click，免得顺手打开。
    body.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); }, { capture: true, once: true });
    const from = noteTodayWho();
    const commit = Math.abs(dx) >= NOTE_TODAY_SWIPE_MIN && (from === "human" ? dx < 0 : dx > 0);
    if (!commit) {
      // 弹回原位
      if (noteReducedMotion()) { clearOffset(); return; }
      body.style.transition = `transform ${NOTE_TODAY_SLIDE_MS}ms ease-out, opacity ${NOTE_TODAY_SLIDE_MS}ms ease-out`;
      body.style.transform = ""; body.style.opacity = "";
      setTimeout(clearOffset, NOTE_TODAY_SLIDE_MS + 40);
      return;
    }
    const next = from === "human" ? "agent" : "human";
    if (noteReducedMotion()) { clearOffset(); noteSwitchToday(next); return; }
    // 当前卡片继续往手指的方向滑出，滑完再换成另一张
    body.dataset.todayLeaving = "1";
    body.style.transition = `transform ${NOTE_TODAY_SLIDE_MS}ms ease-in, opacity ${NOTE_TODAY_SLIDE_MS}ms ease-in`;
    body.style.transform = `translateX(${from === "human" ? -s.width : s.width}px)`; body.style.opacity = "0";
    setTimeout(() => {
      delete body.dataset.todayLeaving;
      // 列表重绘可能换掉旧正文，但已提交的切换仍应应用到当前卡片。离页或已切换则取消。
      if (!noteTodayMounted() || noteTodayWho() !== from) return;
      noteSwitchToday(next);
    }, NOTE_TODAY_SLIDE_MS);
  });
  body.addEventListener("pointercancel", () => {
    const s = drag; drag = null;
    if (s?.active) clearOffset();
  });
}

function noteReplaceTodayRecs() {
  const el = document.getElementById("notes-today-recs");
  // 子节点里有 null（例如排满时没有去向提示、可选行、置顶行）：replaceChildren(null) 会把字面 “null” 渲染出来，
  // 而 h() 会过滤掉 null。这里统一过滤，卡片不再出现一个孤零零的 null。
  if (el && noteTodayMounted()) el.replaceChildren(...noteTodayRecChildren().filter(Boolean));
}

/**
 * 推荐任务创建会话成功：把缓存里的这条就地改成「已发起」，只重绘「今天」卡片的推荐栏与抽屉里的列表。
 * 手机提交后马上返回待办页，创建结果稍后才到；这时页面已经在了，不能等下次整页重绘才更新。
 */
function noteRecommendationLaunched(taskId, sessionId) {
  // 创建期间发出的读取可能带回旧快照，作废它，别把刚发起的任务覆盖回「待启动」。
  noteIterationsEpoch++;
  const task = ui.noteIterations?.tasks?.find((t) => t.id === taskId);
  const summary = ui.noteIterationSummary;
  const top = summary?.tasks?.find((t) => t.id === taskId);
  // 取一份快照再摘掉：手机上提交后会立即回到待办页，这时不能让它凭空消失，
  // 而是用这份快照先画一行「刷新中…」，等新摘要回来再收尾。
  const snapshot = task || top || (ui.noteIterationLaunchTasks || {})[taskId];
  if (task) {
    task.status = "started";
    if (sessionId) task.sessionId = sessionId;
    delete task.launch;
  }
  if (top) {
    summary.tasks = summary.tasks.filter((t) => t.id !== taskId);
    const c = summary.counts || (summary.counts = {});
    c.launchable = Math.max(0, (c.launchable || 0) - 1); c.ready = Math.max(0, (c.ready || 0) - 1); c.started = (c.started || 0) + 1;
  }
  if (!snapshot) return;
  noteIterationMarkLaunchRefreshing(snapshot, sessionId);
  ui.noteIterationsError = "";
  if (noteTodayMounted() || (ui.view === "notes" && !ui.notesManagement)) noteRefreshRecommended();
  // 摘要里已少了一条：重读一次，既补前 3 条又确认这条已发起；读回来后才收起「刷新中…」。
  void noteLoadTodaySummary();
}

/** 倒计时每 30 秒刷新一次；只在待办页上续约，离开页面后下一拍就停。 */
let noteCountdownTimer = null;
function noteStartCountdownTicker() {
  if (noteCountdownTimer) return;
  const tick = () => {
    noteCountdownTimer = null;
    if (!noteTodayMounted() && !noteCalendarInlineOpen()) return;
    noteReplaceUpcoming();
    if (noteCalendarInlineOpen()) { noteReplaceCalendarPanel(); void noteLoadCalendarRecent(); }
    noteReplaceAgentSchedule();
    noteRefreshAgentTodayIfStale();
    noteRefreshOverviewIfStale();
    noteCountdownTimer = setTimeout(tick, 30000);
  };
  noteCountdownTimer = setTimeout(tick, 30000);
}

function noteReplaceUpcoming() {
  const el = document.getElementById("notes-upcoming");
  if (el && noteTodayMounted()) el.replaceWith(noteUpcomingSection());
}

let noteUpcomingFlight = null, noteUpcomingAgain = false;
function noteLoadUpcoming() {
  if (noteUpcomingFlight) { noteUpcomingAgain = true; return noteUpcomingFlight; }
  const st = noteUpcomingState();
  st.loading = true;
  const flight = (async () => {
    try {
      // 外部日历单独读、慢或失败都不挡本地日程；边界取整到天，服务端缓存才能命中。
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart.getTime() + 3 * 86400000);
      const externalTask = api(`/api/calendar/google?${new URLSearchParams({ from: dayStart.toISOString(), to: dayEnd.toISOString() })}`, noteReadOptions())
        .then((d) => (Array.isArray(d?.google) ? d.google : [])).catch(() => null);
      const data = await api("/api/notes/upcoming?limit=10", noteReadOptions());
      st.events = Array.isArray(data?.events) ? data.events : [];
      st.total = typeof data?.total === "number" ? data.total : st.events.length;
      st.loaded = true; st.error = "";
      noteReplaceUpcoming();
      const external = await externalTask;
      if (external) st.external = external;
    } catch (e) {
      st.error = e?.message || "读取失败";
    } finally {
      st.loading = false;
      if (noteUpcomingFlight === flight) noteUpcomingFlight = null;
      noteReplaceUpcoming();
      noteLoadTodayRecsLater();
      if (noteUpcomingAgain) { noteUpcomingAgain = false; void noteLoadUpcoming(); }
    }
  })();
  noteUpcomingFlight = flight;
  return flight;
}

/**
 * 列表标题行：类型分段按钮（笔记 / 待办 / 日程）。
 * 大类只有这三类，没有混排的「全部」；从别处打开某条记录时切到它自己的大类。
 */
function noteListTitle() {
  const current = noteKindFilter();
  // 日历计数与实际列表共用来源、日期及其它筛选；读取前不显示未筛选的服务端总数。
  const calendar = noteCalendarState();
  const counts = { ...ui.notesKindCounts, event: calendar.data
    ? (current === "event" ? noteCalendarListEvents().length : noteCalendarVisibleEvents(calendar, noteCalendarEventsOf(calendar.data)).length)
    : undefined };
  return h("div", { id: "notes-list-title", class: "notes-list-head" },
    h("div", { class: "notes-kind-tabs", role: "radiogroup", "aria-label": "类型筛选", onkeydown: noteKindTabKeys },
      NOTE_KIND_FILTERS.map(({ key, label }) => h("button", {
        type: "button", role: "radio", class: `notes-kind-tab${current === key ? " active" : ""}`,
        "aria-checked": current === key ? "true" : "false", "data-kind-filter": key,
        title: counts && typeof counts[key] === "number" ? `${label}：${counts[key]} 条` : null,
        "aria-label": label,
        onclick: () => noteSetKindFilter(key)
      }, label, counts && typeof counts[key] === "number"
        ? h("span", { class: "notes-kind-count", "data-kind-count": key, "aria-hidden": "true" }, String(counts[key]))
        : null))));
}

/**
 * 类型分段按钮原地更新（只改选中状态 / 计数 / 提示），不换节点：切换时列表会连续刷新两次，
 * 整块换掉的话选中气泡的滑动过渡会被第二次刷新打断，键盘焦点也要靠补焦点；结构不一致（按钮数量或 key 变了）才整块替换。
 */
function noteMorphListTitle(title, fresh) {
  const oldButtons = [...title.querySelectorAll(".notes-kind-tab")], newButtons = [...fresh.querySelectorAll(".notes-kind-tab")];
  const same = oldButtons.length === newButtons.length && oldButtons.every((b, i) => b.dataset.kindFilter === newButtons[i].dataset.kindFilter);
  if (!same) { title.replaceWith(fresh); return; }
  oldButtons.forEach((button, i) => {
    const next = newButtons[i];
    button.className = next.className;
    for (const attr of ["aria-checked", "title", "aria-label"]) {
      const value = next.getAttribute(attr);
      if (value === null) button.removeAttribute(attr); else if (button.getAttribute(attr) !== value) button.setAttribute(attr, value);
    }
    const count = button.querySelector(".notes-kind-count"), nextCount = next.querySelector(".notes-kind-count");
    if (count && nextCount) { if (count.textContent !== nextCount.textContent) count.textContent = nextCount.textContent; }
    else if (count || nextCount) { button.replaceChildren(...next.childNodes); }
  });
}

/** 分段按钮上的左右键 / Home / End：和滑动手势一样在三个大类之间切，焦点跟着走（与「今天」卡片的分段按钮一致）。 */
function noteKindTabKeys(ev) {
  const keys = NOTE_KIND_FILTERS.map((o) => o.key);
  const index = keys.indexOf(noteKindFilter());
  const next = ({ ArrowRight: keys[(index + 1) % keys.length], ArrowLeft: keys[(index + keys.length - 1) % keys.length], Home: keys[0], End: keys[keys.length - 1] })[ev.key];
  if (!next) return;
  ev.preventDefault();
  if (next === noteKindFilter()) return;
  noteSetKindFilter(next);
  // 标题行随大类重绘：在新节点上补焦点
  requestAnimationFrame(() => document.querySelector(`.notes-kind-tab[data-kind-filter="${CSS.escape(next)}"]`)?.focus({ preventScroll: true }));
}

/** 编辑态「添加分类」目录里的勾选写回编辑草稿（确认按钮和直接保存共用）。 */
function noteApplyCategoryPicker(edit) {
  const picker = edit?.categoryPicker;
  if (!picker) return;
  edit.categoryIds = [...picker.ids];
  delete edit.categoryId;
  edit.reclassify = false;
  if (picker.newCategory) edit.newCategory = picker.newCategory; else delete edit.newCategory;
  delete edit.categoryPicker;
}

async function noteSaveEdit(id) {
  if (ui.notesBusy) return;
  const edit = ui.notesEdit;
  if (!edit) return;
  const text = (edit.text ?? "").trim();
  const images = noteDraftReadyIds(edit.images);
  if (!text && !images.length) return;
  // 目录还开着就点了保存：把已勾选的分类当作确认，免得白选。
  noteApplyCategoryPicker(edit);
  const epoch = noteOperationEpoch, submitted = JSON.stringify(edit);
  ui.notesBusy = id;
  ui.notesError = "";
  noteRenderCurrent();
  try {
    // 单选时继续发旧的 categoryId，多选才发 categoryIds：兼容既有接口与缓存。
    const categoryPatch = Array.isArray(edit.categoryIds)
      ? edit.categoryIds.length === 1 ? { categoryId: edit.categoryIds[0] } : { categoryIds: edit.categoryIds }
      : edit.categoryId ? { categoryId: edit.categoryId } : {};
    const note = await api(`/api/notes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ text, images, timeZone: noteTimeZone(), ...(edit.newCategory ? { newCategory: edit.newCategory, categoryVersion: ui.noteTaxonomy?.version, ...(Array.isArray(edit.categoryIds) && edit.categoryIds.length ? { categoryIds: edit.categoryIds } : {}) } : categoryPatch), ...(edit.reclassify ? { reclassify: true } : {}) }) });
    if (epoch !== noteOperationEpoch) return;
    ui.notes = (ui.notes || []).map((n) => (n.id === id ? noteKeepSessions(n, note) : n));
    // 编辑可能改动分类输入，具体分档以服务端事件后的全量计数为准
    ui.notesCounts = null; ui.notesCategoryCounts = null;
    if (ui.notesEdit === edit && JSON.stringify(edit) === submitted) ui.notesEdit = null;
    noteCalendarInvalidate();
    invalidateReads((key) => key === "/api/notes" || key.startsWith("/api/notes?"));
  } catch (e) {
    if (epoch === noteOperationEpoch) ui.notesError = e.message;
  } finally {
    if (epoch === noteOperationEpoch) { ui.notesBusy = ""; if (ui.view === 'notes') noteRefreshList(); }
  }
}

/** 只改正文 / 完成状态的接口不会回传关联会话；本地替换时保留原记录上已有的关联，避免跳转链接消失。 */
function noteKeepSessions(existing, updated) {
  if (!updated || !existing || updated.sessions !== undefined) return updated;
  return existing.sessions ? { ...updated, sessions: existing.sessions } : updated;
}

/** 标记／取消完成：先乐观更新并划线；标记后延迟 3 秒才从当前筛选移走，期间「取消完成」按钮显示倒计时。 */
function noteToggleDone(note) {
  const epoch = noteOperationEpoch;
  const next = !note.done;
  ui.notesError = "";
  noteDoneClear(note.id);
  noteCountsShift(note, {}, note.done ? "done" : "todo", next ? "done" : "todo");
  noteApplyDone(note, next);
  noteCalendarInvalidate();
  if (next) {
    noteDoneDeadline.set(note.id, Date.now() + NOTE_DONE_DELAY_MS);
    noteDoneRemoval.set(note.id, setTimeout(() => {
      noteDoneRemoval.delete(note.id);
      noteDoneDeadline.delete(note.id);
      if (ui.view === "notes") noteRefreshList();
    }, NOTE_DONE_DELAY_MS));
    noteDoneEnsureTicker();
  }
  // 局部刷新：输入框里的草稿与光标都留着
  noteRefreshList();
  void notePersistDone(note, epoch, next);
}

/** 清掉一条记录的延迟移除计时（取消完成、删除记录、保存失败回滚时用）。 */
function noteDoneClear(id) {
  const timer = noteDoneRemoval.get(id);
  if (timer) clearTimeout(timer);
  noteDoneRemoval.delete(id);
  noteDoneDeadline.delete(id);
}

/** 从「未完成」移走还剩几秒；不在倒计时里返回 null。 */
function noteDoneRemaining(id) {
  const deadline = noteDoneDeadline.get(id);
  if (!deadline) return null;
  return Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
}

// 只要还有记录在倒计时，就每秒只改倒计时按钮的文字（不动列表，免得打断正在编辑的草稿）。
let noteDoneTicker = null;
function noteDoneEnsureTicker() {
  if (noteDoneTicker || typeof setInterval !== "function") return;
  noteDoneTicker = setInterval(() => {
    if (!noteDoneDeadline.size) { clearInterval(noteDoneTicker); noteDoneTicker = null; return; }
    if (ui.view !== "notes") return;
    for (const id of noteDoneDeadline.keys()) {
      const remaining = noteDoneRemaining(id);
      const btn = document.querySelector(`.note-entry[data-note-id="${CSS.escape(id)}"] button[aria-label="取消完成"]`);
      if (btn && remaining != null) btn.textContent = `取消完成 ${remaining}s`;
    }
  }, 1000);
}

function noteApplyDone(note, done) {
  note.done = done;
  if (done) note.doneAt = note.doneAt || new Date().toISOString();
  else delete note.doneAt;
}

async function notePersistDone(note, epoch, done) {
  const version = (noteDoneVersion.get(note.id) || 0) + 1;
  noteDoneVersion.set(note.id, version);
  try {
    const updated = await api(`/api/notes/${encodeURIComponent(note.id)}`, { method: "PATCH", body: JSON.stringify({ done }) });
    if (epoch !== noteOperationEpoch || noteDoneVersion.get(note.id) !== version) return;
    ui.notes = (ui.notes || []).map((n) => (n.id === note.id ? noteKeepSessions(n, updated) : n));
    noteCalendarInvalidate();
    invalidateReads((key) => key === "/api/notes" || key.startsWith("/api/notes?"));
    if (ui.view === "notes") noteRefreshList();
  } catch (e) {
    if (epoch !== noteOperationEpoch || noteDoneVersion.get(note.id) !== version) return;
    noteCountsShift(note, {}, done ? "done" : "todo", done ? "todo" : "done");
    noteApplyDone(note, !done); // 保存失败：回滚乐观状态
    noteDoneClear(note.id);
    ui.notesError = e.message;
    if (ui.view === "notes") noteRefreshList();
  }
}

async function noteRemove(id) {
  if (ui.notesBusy) return;
  const epoch = noteOperationEpoch;
  noteDoneClear(id);
  ui.notesMore = null;
  ui.notesQuickCategory = null;
  ui.notesBusy = id;
  ui.notesError = "";
  noteRenderCurrent();
  try {
    await api(`/api/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (epoch !== noteOperationEpoch) return;
    const removed = (Array.isArray(ui.notes) ? ui.notes : []).find((n) => n.id === id);
    if (removed) noteCountsShift(removed, { all: -1 }, noteStatusDone(removed) ? "done" : "todo", null);
    ui.notes = (ui.notes || []).filter((n) => n.id !== id);
    noteCalendarInvalidate();
    invalidateReads((key) => key === "/api/notes" || key.startsWith("/api/notes?"));
  } catch (e) {
    if (epoch === noteOperationEpoch) ui.notesError = e.message;
  } finally {
    if (epoch === noteOperationEpoch) { ui.notesBusy = ""; noteRenderCurrent(); }
  }
}

function noteComposer() {
  const busy = ui.notesBusy === "new";
  const items = ui.notesImages || [];
  const uploading = noteDraftBusy(items);
  const failed = noteDraftBlocked(items);
  const hasContent = !!(ui.notesDraft || "").trim() || noteDraftHasImage(items);
  const canSave = !busy && !uploading && !failed && hasContent;
  const save = () => {
    const text = (ui.notesDraft || "").trim();
    const current = ui.notesImages || [];
    if ((!text && !noteDraftHasImage(current)) || ui.notesBusy || noteDraftBusy(current) || noteDraftBlocked(current)) return;
    void noteCreate(text);
  };
  const remove = (item) => { if (item.intakeId) { noteCancelIntake(item.intakeId); return; } const arr = ui.notesImages || []; const idx = arr.indexOf(item); if (idx >= 0) arr.splice(idx, 1); noteRenderCurrent(); };
  const picker = noteImagePicker(items, busy);
  const area = h("textarea", {
    class: "notes-input", "data-key": "notes-input", rows: "4",
    placeholder: "记笔记、待办或日程……AI 会自动归类，带时间的会进日程（可粘贴图片，⌘ / Ctrl + Enter 保存）",
    value: ui.notesDraft || "",
    "aria-label": "记下一条笔记、待办或日程",
    oncompositionstart: () => { ui.notesDraftRevision = (ui.notesDraftRevision || 0) + 1; },
    oninput: (e) => {
      ui.notesDraft = e.target.value;
      ui.notesDraftRevision = (ui.notesDraftRevision || 0) + 1;
      const btn = document.getElementById("notes-save-btn");
      if (btn) btn.disabled = !!ui.notesBusy || noteDraftBusy(items) || noteDraftBlocked(items) || (!e.target.value.trim() && !noteDraftHasImage(items));
    },
    onpaste: (e) => notePaste(items, e),
    ondrop: (e) => noteDropImage(items, e),
    ondragover: (e) => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); },
    onkeydown: (e) => { if (!e.isComposing && e.keyCode !== 229 && (e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); save(); } }
  });
  // 从别处（手机新建按钮上滑）跳进来时，把光标放进输入框；手机上的浮层由 renderNotes 拉起
  if (ui.notesFocusInput && !noteComposerPhone()) {
    ui.notesFocusInput = false;
    ui.notesComposerOpen = true;
    requestAnimationFrame(() => { if (area.isConnected) area.focus(); });
  }
  const open = noteComposerShouldOpen();
  return h("form", {
    class: "notes-composer" + (open ? " is-open" : ""),
    onsubmit: (e) => { e.preventDefault(); save(); },
    onfocusout: (e) => noteComposerFocusOut(e.currentTarget)
  },
    noteRelationComposerFields(),
    area,
    picker.input,
    noteImageDraftStrip(items, busy, remove),
    h("div", { class: "notes-composer-actions" },
      h("div", { class: "notes-composer-tools" }, picker.button,
        h("span", { class: "muted small notes-hint" }, "可粘贴图片，或从相册选择")),
      h("button", { id: "notes-save-btn", class: "btn primary", type: "submit", disabled: !canSave }, busy ? "保存中…" : "记下")));
}

/** 输入区有内容（文字/图片）或正在保存时一律保持展开，免得收起后看不到草稿。 */
function noteComposerHasContent() {
  const items = ui.notesImages || [];
  return !!String(ui.notesDraft || "").trim() || items.length > 0 || !!ui.notesBusy || !!(ui.notesRelationDraft?.start || ui.notesRelationDraft?.end);
}
function noteComposerShouldOpen() { return !!ui.notesComposerOpen || noteComposerHasContent(); }

/** 手机上输入区不占列表版式，改走底部浮层（同一个表单节点被移进 dialog），和会话列表的新建会话同一套表达。 */
const notePhoneQuery = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 760px)") : null;
function noteComposerPhone() { try { return !!(notePhoneQuery && notePhoneQuery.matches); } catch { return false; } }
/** 宽屏把日历固定在右侧（默认展示）；窄屏改成从待办列表左滑拉起的日历视图。 */
const noteCalendarDockQuery = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(min-width: 900px)") : null;
function noteCalendarDocked() { return false; }
function noteCalendarInlineOpen() { return ui.view === "notes" && !ui.notesManagement && noteKindFilter() === "event"; }

/**
 * 新建入口：PC 是大类 tab 行右端的主按钮，点了在下面展开输入框；
 * 手机是右下角圆形「＋」（位置同会话列表的新建会话），点了拉起新建浮层；
 * 按住后上滑松手则新建会话（与会话列表里「按住上滑进入待办」刚好相反）。
 * 两个按钮都渲染，按宽度用 CSS 只留一个，窗口变宽变窄时不用重绘也跟着换。
 */
function noteNewEntry() {
  const open = (ev) => { ev.preventDefault(); noteOpenComposer(); };
  const label = "记笔记、待办或日程";
  const fab = h("button", { type: "button", id: "notes-new-fab", class: "btn primary notes-new-fab", "aria-label": label, title: `${label}（按住上滑新建会话）`, draggable: "false",
    onclick: (ev) => {
      if (fab.__suppressClick) { fab.__suppressClick = false; ev.preventDefault(); return; }
      open(ev);
    },
    // 长按时不要弹出浏览器自带的菜单
    oncontextmenu: (ev) => ev.preventDefault()
  }, h("span", { "aria-hidden": "true" }, "＋"));
  const hint = h("span", { class: "notes-new-hint", "aria-hidden": "true" }, "上滑新建会话");
  fab.append(hint);
  noteInstallFabSwipeUp(fab, hint);
  return [
    h("button", { type: "button", id: "notes-new-btn", class: "btn primary notes-new-btn", "aria-label": label, title: label, onclick: open },
      h("span", { class: "notes-new-plus", "aria-hidden": "true" }, "＋"), h("span", { class: "notes-new-text" }, "记笔记 / 待办 / 日程")),
    fab
  ];
}

// 按住就绪的阈值压到 180ms：手指落下后很快就震动、给出「上滑」提示，不用等满一小段时间
// 马达从收到指令到真正震起来有几十毫秒延迟：震动指令比「上滑」提示提前 BUZZ_LEAD 发出，脉冲稍长一点更容易感到
const NOTE_FAB_HOLD_MS = 180, NOTE_FAB_BUZZ_LEAD_MS = 80, NOTE_FAB_HOLD_BUZZ = 20, NOTE_FAB_SWIPE_UP = 36, NOTE_FAB_DRIFT_X = 40;

/** 在待办页新建按钮上按住（180ms）再上滑超过阈值，松手进入新建会话；滑回来或横向跑偏则取消，松手仍是普通点击。 */
function noteInstallFabSwipeUp(fab, hint) {
  // 震动反馈：不支持的设备（例如 iOS Safari）静默跳过
  const buzz = (pattern) => { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* 忽略 */ } };
  let holdTimer = null, buzzTimer = null, startX = 0, startY = 0, holding = false, armed = false;
  const cleanup = () => {
    clearTimeout(holdTimer); holdTimer = null; clearTimeout(buzzTimer); buzzTimer = null;
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", cleanup, true);
    holding = false; armed = false;
    fab.classList.remove("notes-new-holding", "notes-new-armed");
  };
  const onMove = (ev) => {
    if (!holding) return;
    const dy = ev.clientY - startY, dx = Math.abs(ev.clientX - startX);
    if (dx > NOTE_FAB_DRIFT_X) { cleanup(); return; }
    if (dy <= -NOTE_FAB_SWIPE_UP) {
      if (!armed) { armed = true; hint.textContent = "松开新建会话"; fab.classList.add("notes-new-armed"); }
    } else if (armed) {
      armed = false; hint.textContent = "上滑新建会话"; fab.classList.remove("notes-new-armed");
    }
  };
  const onUp = (ev) => {
    const commit = armed;
    cleanup();
    if (!commit) return;
    fab.__suppressClick = true;
    buzz([10, 30, 10]);
    if (ev.cancelable) ev.preventDefault();
    noteCloseSheet();
    const href = typeof rtNewModeHref === "function" ? rtNewModeHref() : "#/rt/new";
    // 待办页上滑新建会话：不是会话列表的入口，提交后要问用户去哪
    if (typeof rtMarkNewEntry === "function") rtMarkNewEntry("notes");
    // 改地址即可：hashchange 会走路由进入新建页
    if (location.hash !== href) location.hash = href; else if (typeof route === "function") route();
  };
  fab.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    cleanup(); fab.__suppressClick = false; fab.__preBuzzed = false; startX = ev.clientX; startY = ev.clientY;
    // 手指可能滑出这个小小的圆形按钮，移动与松手都放在 window 上听
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", cleanup, true);
    holdTimer = setTimeout(() => { holdTimer = null; holding = true; hint.textContent = "上滑新建会话"; fab.classList.add("notes-new-holding"); }, NOTE_FAB_HOLD_MS);
    buzzTimer = setTimeout(() => { buzzTimer = null; fab.__preBuzzed = true; buzz(NOTE_FAB_HOLD_BUZZ); }, NOTE_FAB_HOLD_MS - NOTE_FAB_BUZZ_LEAD_MS);
  });
}

/** 点「新建」：PC 就地展开输入框；手机把输入区移进底部浮层。 */
function noteOpenComposer() {
  ui.notesComposerOpen = true;
  const form = document.querySelector("#main .notes-composer") || document.querySelector(".notes-composer");
  if (form) { noteComposerExpand(form, true); return; }
  // 输入区还没渲染（例如刚好收起了列表）时补一次渲染再展开
  noteRenderCurrent();
  const next = document.querySelector(".notes-composer");
  if (next) noteComposerExpand(next, true);
}

/** 展开输入区；focus 为真时把光标放进输入框。 */
function noteComposerExpand(form, focus) {
  ui.notesComposerOpen = true;
  const el = form || document.querySelector(".notes-composer");
  if (!el) return;
  if (noteComposerPhone()) { noteOpenSheet(el, focus); return; }
  noteKeepHeadInPlace(() => el.classList.add("is-open"));
  if (focus) {
    const input = el.querySelector(".notes-input");
    if (input) input.focus({ preventScroll: true });
    // 固顶状态下输入区在视口上方：把它滚进来（头部随之落回输入区下面）
    const top = noteTopbarHeight() + 8, rect = el.getBoundingClientRect();
    if (rect.top < top) window.scrollBy(0, rect.top - top);
  }
}

function noteTopbarHeight() { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--topbar-h")) || 0; }

/** 输入区在头部上面展开 / 收起会改变头部的页面位置：改完后补一次滚动，让「标签 + 新建」在屏幕上原地不动。 */
function noteKeepHeadInPlace(change) {
  const head = document.getElementById("notes-sticky-head");
  const before = head ? head.getBoundingClientRect().top : null;
  change();
  if (before == null) return;
  const delta = head.getBoundingClientRect().top - before;
  if (Math.abs(delta) >= 1) window.scrollBy(0, delta);
}

let noteSheet = null;
/** 手机浮层：把页面上那个输入区表单整块搬进 dialog，草稿、图片、保存按钮都还是同一份。 */
function noteOpenSheet(form, focus) {
  if (!form) return;
  form.classList.add("is-open");
  if (noteSheet) {
    const body = noteSheet.querySelector(".notes-sheet-body");
    // 浮层开着时又渲染了一张新表单（例如窗口宽度来回变）：用新的换掉旧的，保证页面上只有一份输入区
    if (body && !noteSheet.contains(form)) { body.querySelectorAll(".notes-composer").forEach((n) => n.remove()); body.append(form); }
    if (focus) form.querySelector(".notes-input")?.focus({ preventScroll: true });
    return;
  }
  const dialog = h("dialog", { class: "notes-sheet", "aria-label": "新建笔记、待办或日程", "data-key": "notes-sheet" },
    h("div", { class: "notes-sheet-panel" },
      h("header", { class: "notes-sheet-head" },
        h("strong", {}, "记下一条笔记 / 待办 / 日程"),
        h("button", { type: "button", class: "btn small", "data-key": "notes-sheet-close", onclick: () => noteDismissSheet() }, "关闭")),
      h("div", { class: "notes-sheet-body" },
        h("p", { id: "notes-sheet-error", class: "field-error", role: "alert", hidden: true }))));
  dialog.addEventListener("cancel", (e) => { e.preventDefault(); noteDismissSheet(); });
  // 点浮层外的遮罩关闭（dialog 自身没有内边距，点到它就是点在遮罩上）
  dialog.addEventListener("click", (e) => { if (e.target === dialog) noteDismissSheet(); });
  document.body.append(dialog);
  dialog.querySelector(".notes-sheet-body").append(form);
  noteSheet = dialog;
  ui.notesSheetOpen = true;
  document.body.classList.add("notes-sheet-open");
  dialog.showModal();
  if (focus) {
    const input = form.querySelector(".notes-input");
    input?.focus({ preventScroll: true });
    // showModal 自己会先聚焦弹窗里第一个可聚焦元素；若它盖掉了光标，下一帧再补一次
    requestAnimationFrame(() => { if (input && form.isConnected && document.activeElement !== input) input.focus({ preventScroll: true }); });
  }
}

/** 收起浮层（不动页面）：离开待办页、进分类管理时用。返回是否真的关掉了浮层。 */
function noteCloseSheet() {
  const dialog = noteSheet;
  noteSheet = null;
  ui.notesSheetOpen = false;
  document.body.classList.remove("notes-sheet-open");
  if (!dialog) return false;
  try { dialog.close(); } catch { /* 已关闭 */ }
  dialog.remove();
  return true;
}

/** 用户自己关浮层：没有草稿就顺势收起输入区，把焦点还给右下角的新建按钮。 */
function noteDismissSheet() {
  if (!noteCloseSheet()) return;
  ui.notesComposerOpen = noteComposerHasContent();
  if (!ui.notesComposerOpen) noteClearRelationDraft();
  if (ui.view !== "notes") return;
  noteRenderCurrent();
  document.getElementById("notes-new-fab")?.focus({ preventScroll: true });
}

/** 焦点离开输入区且没有内容时收起（浮层开着时不收：点浮层里的「关闭」按钮会先触发这里）。 */
function noteComposerFocusOut(form) {
  setTimeout(() => {
    if (noteSheet) return;
    if (!form || !form.isConnected || form.contains(document.activeElement)) return;
    if (noteComposerHasContent()) return;
    ui.notesComposerOpen = false;
    noteClearRelationDraft(); notePatchComposer();
    noteKeepHeadInPlace(() => form.classList.remove("is-open"));
  }, 0);
}

/** 快速跳到待办（手机新建按钮上滑）时调用：进入页面后展开输入框并把光标放进去 */
function notesFocusInput() {
  ui.notesFocusInput = true;
  ui.notesComposerOpen = true;
  if (noteComposerPhone()) {
    // 页面可能还在渲染：等下一次 renderNotes 把浮层拉起来再聚焦
    const form = document.querySelector("#main .notes-composer") || document.querySelector(".notes-composer");
    if (form) { ui.notesFocusInput = false; noteOpenSheet(form, true); }
    return;
  }
  const input = document.querySelector(".notes-input");
  if (input) { ui.notesFocusInput = false; noteComposerExpand(input.closest(".notes-composer"), true); }
}

const noteHoverYes = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(hover: hover)") : null;
/** 双击进入编辑只给 PC（有鼠标、能 hover）；触屏双击容易和横滑、图片缩放打架，仍走「编辑」按钮。 */
function noteDoubleClickEditEnabled() {
  try { return !!(noteHoverYes && noteHoverYes.matches); } catch { return false; }
}

/** 打开一条记录的编辑态；focus 为真时顺势把光标放进输入框（双击进入时用）。 */
function noteBeginEdit(note, focus) {
  if (!note || ui.notesEdit || ui.notesBusy) return false;
  for (const id of notePendingExpand.keys()) noteCancelPendingExpand(id);
  ui.notesQuickCategory = null;
  ui.notesEdit = { id: note.id, text: note.text, images: noteImageItems(note.images) };
  ui.notesEditFocus = focus ? note.id : null;
  renderMain();
  return true;
}

/**
 * 置顶确认弹窗：和系统 confirm 区分开，使用应用自己的卡片样式；手机从底部拉起，PC 居中。
 * 返回 Promise<boolean>：确认 / 取消 / Esc / 点遮罩都会结束。
 */
function notePinConfirm(note) {
  return new Promise((resolve) => {
    const label = NOTE_KIND_LABEL[noteDisplayKind(note)], pinned = !!note.pinned;
    const title = pinned ? `取消置顶这条${label}？` : `置顶这条${label}？`;
    const detailText = pinned ? "取消后会回到普通推荐顺序，仍可在「更多」里重新置顶。" : "置顶后会排在今日推荐最前面，方便随时继续。";
    let settled = false, working = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      try { dialog.close(); } catch { /* 已关闭 */ }
      dialog.remove();
      resolve(ok);
    };
    const detail = h("p", { id: "notes-pin-confirm-detail" }, detailText);
    const ok = h("button", {
      type: "button", class: "btn primary notes-pin-confirm-ok", "data-key": "notes-pin-confirm-ok",
      onclick: async () => {
        if (working || settled) return;
        working = true;
        ok.disabled = true; cancel.disabled = true;
        ok.setAttribute("aria-busy", "true");
        ok.textContent = pinned ? "取消置顶中" : "置顶中";
        const success = await noteSetPinned([note], !pinned, pinned ? "已取消置顶" : "已置顶：会排在今日推荐最前面");
        if (settled) return;
        if (!success) {
          working = false; ok.disabled = false; cancel.disabled = false;
          ok.removeAttribute("aria-busy"); ok.textContent = pinned ? "取消置顶" : "置顶";
          detail.textContent = ui.notesError || "操作失败，请稍后重试。";
          return;
        }
        ok.removeAttribute("aria-busy");
        ok.textContent = "已完成";
        // 让「已完成」停留一下再关闭，用户能看见这次操作真正落到了页面上。
        await new Promise((done) => setTimeout(done, 450));
        settle(true);
      }
    }, pinned ? "取消置顶" : "置顶");
    const cancel = h("button", { type: "button", class: "btn notes-pin-confirm-cancel", "data-key": "notes-pin-confirm-cancel", onclick: () => { if (!working) settle(false); } }, "取消");
    const dialog = h("dialog", { class: `notes-pin-confirm${pinned ? " is-unpin" : ""}`, "aria-labelledby": "notes-pin-confirm-title", "aria-describedby": "notes-pin-confirm-detail" },
      h("div", { class: "notes-pin-confirm-body" },
        h("div", { class: "notes-pin-confirm-icon", "aria-hidden": "true" }, notePinIcon("notes-pin-confirm-pin")),
        h("h2", { id: "notes-pin-confirm-title" }, title),
        detail,
        h("div", { class: "notes-pin-confirm-actions" }, cancel, ok)));
    dialog.addEventListener("cancel", (ev) => { ev.preventDefault(); if (!working) settle(false); });
    // 点弹窗外（dialog 自身区域）取消；进行中不允许关闭，避免操作结果更新到已经关掉的弹窗。
    dialog.addEventListener("click", (ev) => { if (!working && ev.target === dialog) settle(false); });
    (document.body || document.documentElement).append(dialog);
    dialog.showModal();
    requestAnimationFrame(() => { try { ok.focus({ preventScroll: true }); } catch { ok.focus(); } });
  });
}

/**
 * 长按整张卡片：震动一下并确认置顶 / 取消置顶。置顶后卡片左下角出现钉子，点钉子可直接取消。
 * 长按现在也能选中正文：一旦起了选区，这次长按是「选字复制」，不再弹置顶确认。
 * 手指移动（滚动 / 横滑）、点在按钮链接上都不触发；长按松手后的那次 click 也不再折叠正文。
 */
const NOTE_LONG_PRESS_MS = 500;
const NOTE_LONG_PRESS_MOVE_PX = 10;
function noteEntryLongPress(note, row) {
  let state = null;
  const selectionActive = () => { try { return !window.getSelection()?.isCollapsed; } catch { return false; } };
  const clear = () => {
    if (!state) return;
    clearTimeout(state.timer);
    document.removeEventListener("selectionchange", watchSelection);
    state = null;
  };
  const watchSelection = () => { if (selectionActive()) clear(); };
  const interactive = (target) => target instanceof Element && !!target.closest("button, a, input, textarea, select, img, .note-image, .note-actions, .note-expand-toggle");
  row.addEventListener("pointerdown", (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return;
    if (interactive(ev.target)) return;
    clear();
    const current = { pointerId: ev.pointerId, pointerType: ev.pointerType, x: ev.clientX, y: ev.clientY, timer: 0 };
    current.timer = setTimeout(() => {
      if (state !== current) return;
      clear();
      // 这 500ms 里已经选中了字：交还给系统的选区 / 复制菜单。
      if (selectionActive()) return;
      // 卡片在这 500ms 内被重绘掉了：不再对已经不在页面上的旧记录弹确认。
      if (!row.isConnected) return;
      try { navigator.vibrate?.(12); } catch { /* 没有 Vibration API 的浏览器跳过 */ }
      try { window.getSelection()?.removeAllRanges(); } catch { /* 老浏览器没有 Selection API */ }
      ui.noteLongPressAt = Date.now();
      noteCancelPendingExpand(note.id);
      void notePinConfirm(note);
    }, NOTE_LONG_PRESS_MS);
    document.addEventListener("selectionchange", watchSelection);
    state = current;
  });
  row.addEventListener("pointermove", (ev) => {
    if (!state || ev.pointerId !== state.pointerId) return;
    if (Math.abs(ev.clientX - state.x) > NOTE_LONG_PRESS_MOVE_PX || Math.abs(ev.clientY - state.y) > NOTE_LONG_PRESS_MOVE_PX) clear();
  });
  row.addEventListener("pointerup", clear);
  row.addEventListener("pointercancel", clear);
  row.addEventListener("pointerleave", (ev) => { if (state && ev.pointerType === "mouse") clear(); });
  // 长按不再拦系统菜单：正文要能选中后复制。只有置顶弹窗刚弹出来那一下挡掉系统菜单，
  // 免得两个弹层叠在一起。
  row.addEventListener("contextmenu", (ev) => {
    if (Date.now() - (ui.noteLongPressAt || 0) < 800) ev.preventDefault();
  });
}

/** 双击正文可编辑：按钮、链接、图片（双击用来缩放）保持原行为。 */
function noteEntryDoubleClick(note, row) {
  if (!noteDoubleClickEditEnabled()) return;
  row.addEventListener("dblclick", (ev) => {
    const target = ev.target;
    if (!(target instanceof Element) || target.closest("button, a, input, textarea, select, img, .note-image")) return;
    noteCancelPendingExpand(note.id);
    if (!noteBeginEdit(note, true)) return;
    ev.preventDefault();
    // 去掉双击选中的词，避免和编辑框里的光标混在一起
    try { window.getSelection()?.removeAllRanges(); } catch { /* 老浏览器没有 Selection API */ }
  });
}

function noteEditImages(items) {
  const remove = (item) => { const arr = ui.notesEdit.images || []; const idx = arr.indexOf(item); if (idx >= 0) arr.splice(idx, 1); renderMain(); };
  const picker = noteImagePicker(items, ui.notesBusy === ui.notesEdit.id);
  return { picker, remove };
}

/** 「引用到新会话」的首条消息：标注记下的时间，正文用 markdown 引用块。 */
function noteConversationPrompt(note) {
  const raw = String(note.text || "");
  const quote = raw ? raw.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n") : "> （无正文）";
  const parts = [`引用待办记录（记于 ${noteStamp(note.createdAt)}）：`, "", quote];
  if (note.schedule) parts.push("", `日程：${noteScheduleLabel(note.schedule)}`);
  if ((note.images || []).length) parts.push("", "（这条记录附带的图片见附件）");
  return parts.join("\n");
}

/** 「发起对话」：把这条记录引用进新建会话的首条消息；带图就一并复制成新会话附件。
 *  同时把记录 id 交给会话，创建后能在会话详情里显示这条待办并直接标记完成。 */
function noteStartConversation(note) {
  if (typeof rtStartNewSession !== "function") { announce("请到「对话」页新建会话"); return; }
  rtStartNewSession(noteConversationPrompt(note), { noteId: note.id });
  void noteCopyImages(note.images || []);
}

/* ------------------------------ 状态筛选 ------------------------------ */
// 待办按完成状态筛，日程没有完成概念、按有没有过当前时间筛：只筛当前列表，不发新请求；改状态后局部刷新。
const NOTE_STATUS_FILTERS = {
  todo: [
    { key: "all", label: "全部" },
    { key: "todo", label: "未完成" },
    { key: "done", label: "已完成" }
  ],
  event: [
    { key: "all", label: "全部" },
    { key: "todo", label: "未完成" },
    { key: "done", label: "已完成" }
  ]
};
const noteStatusFilters = (kind = noteKindFilter()) => NOTE_STATUS_FILTERS[kind === "event" ? "event" : "todo"];

/** 日程是否已经过去：只按时间判断，不看 done；进行中的日程仍算未过期。 */
function noteScheduleExpired(note, now = Date.now()) {
  const schedule = note?.schedule;
  if (!schedule) return false;
  if (schedule.repeat) {
    // 一直重复的周期日程没有终点；有 until / count 时按最后一次结束时间算。
    const end = noteRepeatLastEnd(schedule);
    return end !== null && now >= end;
  }
  const DAY = 24 * 60 * 60 * 1000;
  // 全天日程存 YYYY-MM-DD（北京时间）：end 当天仍在日程内，到次日零点才过期。
  const dayStart = (value) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) - NOTE_BEIJING_OFFSET_MS : NaN;
  };
  if (schedule.allDay) {
    const days = [schedule.start, schedule.end, ...(schedule.repeats || [])].map(dayStart).filter(Number.isFinite);
    return days.length ? now >= Math.max(...days) + DAY : false;
  }
  const start = Date.parse(schedule.start || "");
  const end = Date.parse(schedule.end || "");
  const hasStart = Number.isFinite(start), hasEnd = Number.isFinite(end);
  if (!hasStart && !hasEnd) return false;
  const from = hasStart ? start : end - 60 * 60 * 1000;
  const to = hasEnd && end > from ? end : from + 60 * 60 * 1000;
  const starts = [from, ...(schedule.repeats || []).map((v) => Date.parse(v)).filter(Number.isFinite)];
  return now >= Math.max(...starts) + (to - from);
}

/** 当前大类下这条记录算「已完成 / 已过期」还是「未完成 / 未过期」：日程只看时间。 */
function noteStatusDone(note, kind = noteDisplayKind(note)) {
  return kind === "event" ? noteScheduleExpired(note) : !!note.done;
}

// 关联对话：全部 / 有关联对话 / 无关联对话；同样只筛当前列表，不发新请求。
const NOTE_LINK_FILTERS = [
  { key: "all", label: "全部" },
  { key: "linked", label: "有关联对话" },
  { key: "unlinked", label: "无关联对话" }
];

// 大类（v3.17）：笔记 = 想法记录，待办 = 要做的事，日程 = 有时间的待办。
// 默认「待办」；日程在上方「最近日程」单独一行，这里也能切到「日程」以列表查看。
// 大类只有这三类，没有混排的「全部」：每条记录只属于一个大类，从别处打开某条记录时切到它自己的大类。
const NOTE_KIND_FILTERS = [
  { key: "note", label: "笔记" },
  { key: "todo", label: "待办" },
  { key: "event", label: "日历" }
];
// 每个大类各自有哪些筛选项；没列出的就是没有（笔记没有完成状态，所以不显示、也不按它筛）。
const NOTE_KIND_DIMENSIONS = {
  note: ["link", "category"],
  todo: ["status", "link", "category"],
  event: ["category"]
};
const noteKindHasDimension = (dimKey, kind = noteKindFilter()) => (NOTE_KIND_DIMENSIONS[kind] || NOTE_KIND_DIMENSIONS.todo).includes(dimKey);
const NOTE_KIND_LABEL = { note: "笔记", todo: "待办", event: "日程" };

function noteKindFilter() {
  return NOTE_KIND_FILTERS.some((o) => o.key === ui.notesKindFilter) ? ui.notesKindFilter : "todo";
}

/** 页面上的三类：没有 kind 的旧记录按待办；待办带时间就是日程。 */
function noteDisplayKind(note) {
  return note?.kind === "note" ? "note" : note?.schedule ? "event" : "todo";
}

function noteMatchesKind(note, filter = noteKindFilter()) {
  return noteDisplayKind(note) === filter;
}

/**
 * 分类分三套：笔记、待办、日程各自独立；二级跟随一级的 scope，缺省为待办。
 * 分类筛选展开后只有一级、二级两列，看的是当前类型 tab 那一套：大类已经由 tab 分开，目录里不再重复一列。
 */
function noteCategoryScopeOf(category, categories = ui.noteTaxonomy?.categories || []) {
  const root = category?.parentId ? categories.find((c) => c.id === category.parentId) : category;
  return root?.scope === "note" || root?.scope === "event" ? root.scope : "todo";
}
const noteScopeOfKind = (kind) => (kind === "note" || kind === "event" ? kind : "todo");
/** 一条记录用哪套分类（旧记录没有 kind = 待办）。 */
const noteScopeOfNote = (note) => noteDisplayKind(note);
function noteScopedCategories(scope, categories = ui.noteTaxonomy?.categories || []) {
  return categories.filter((c) => noteCategoryScopeOf(c, categories) === scope);
}
/** 目录当前在看哪个大类：笔记、日程各看自己那套，待办（默认）看待办那套。 */
function noteBrowseKind() {
  const kind = noteKindFilter();
  return kind === "note" || kind === "event" ? kind : "todo";
}

function noteFilter() {
  if (!noteKindHasDimension("status")) return "all";
  return ui.notesFilter === "all" || ui.notesFilter === "done" ? ui.notesFilter : "todo";
}

function noteLinkFilter() {
  if (!noteKindHasDimension("link")) return "all";
  return ui.notesLinkFilter === "linked" || ui.notesLinkFilter === "unlinked" ? ui.notesLinkFilter : "all";
}

/** 从这条待办发起的会话会记在 sessions 里；有 platformSessionId 才算真正关联。 */
function noteHasLinkedSession(note) {
  return Array.isArray(note?.sessions) && note.sessions.some((s) => s && s.platformSessionId);
}

function noteMatchesLinkFilter(note, filter = noteLinkFilter()) {
  if (filter === "linked") return noteHasLinkedSession(note);
  if (filter === "unlinked") return !noteHasLinkedSession(note);
  return true;
}

/* ------------------------------ 搜索（只读） ------------------------------ */
// 关键词按空白 / 逗号拆开，每个词都要出现在正文、分类、图片文件名或关联会话标题之一（忽略大小写与全半角）。
// 与服务端 apps/web/src/note-search.ts 同一套规则：服务端负责分页与计数，这里做本地即时筛选和高亮。

const NOTE_SEARCH_MAX_LENGTH = 200;
const NOTE_SEARCH_MAX_TERMS = 8;

function noteSearchNormalize(value) { return String(value || "").normalize("NFKC").toLowerCase(); }

function noteSearchTerms(raw = ui.notesSearch) {
  if (typeof raw !== "string") return [];
  const terms = noteSearchNormalize(raw.slice(0, NOTE_SEARCH_MAX_LENGTH)).split(/[\s,，、]+/).filter(Boolean);
  return [...new Set(terms)].slice(0, NOTE_SEARCH_MAX_TERMS);
}

/** 当前生效的搜索词（已去掉首尾空白）；没有搜索时是空串。 */
function noteSearchQuery() { return typeof ui.notesSearch === "string" ? ui.notesSearch.trim() : ""; }

/** 记录里可被搜索的各段文字，带上来源，供匹配与「命中于」提示共用。 */
function noteSearchFields(note) {
  const fields = [{ kind: "text", label: "正文", text: note?.text || "" }];
  for (const row of noteClassificationRows(note)) {
    for (const name of [row.primary, row.secondary]) if (typeof name === "string" && name) fields.push({ kind: "category", label: "分类", text: name });
  }
  for (const image of note?.images || []) if (image?.name) fields.push({ kind: "image", label: "图片", text: image.name });
  for (const session of note?.sessions || []) if (session?.title) fields.push({ kind: "session", label: "会话", text: session.title });
  return fields;
}

function noteMatchesSearch(note, terms = noteSearchTerms()) {
  if (!terms.length) return true;
  const haystack = noteSearchNormalize(noteSearchFields(note).map((f) => f.text).join("\n"));
  return terms.every((t) => haystack.includes(t));
}

/** 在原文里标出命中的片段：先按码点归一并记下对应位置，再合并重叠区间；返回 DOM 节点数组，原文不被改动。 */
function noteHighlight(text, terms = noteSearchTerms()) {
  const source = String(text ?? "");
  if (!terms.length || !source) return [source];
  let norm = "";
  const starts = [], ends = [];
  let at = 0;
  for (const ch of source) {
    const n = ch.normalize("NFKC").toLowerCase();
    for (let k = 0; k < n.length; k++) { starts.push(at); ends.push(at + ch.length); }
    norm += n;
    at += ch.length;
  }
  const ranges = [];
  for (const term of terms) {
    for (let from = norm.indexOf(term); from >= 0; from = norm.indexOf(term, from + term.length)) {
      ranges.push([starts[from], ends[from + term.length - 1]]);
    }
  }
  if (!ranges.length) return [source];
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push([...r]);
  }
  const out = [];
  let cursor = 0;
  for (const [a, b] of merged) {
    if (a > cursor) out.push(source.slice(cursor, a));
    out.push(h("mark", { class: "note-search-hit" }, source.slice(a, b)));
    cursor = b;
  }
  if (cursor < source.length) out.push(source.slice(cursor));
  return out;
}

/** 正文没有命中、是靠分类 / 图片名 / 会话标题命中的，要在记录下面说明命中在哪里。 */
function noteSearchOtherHits(note, terms = noteSearchTerms()) {
  if (!terms.length) return null;
  const [textField, ...others] = noteSearchFields(note);
  const textHit = terms.some((t) => noteSearchNormalize(textField.text).includes(t));
  const hits = others.filter((f) => terms.some((t) => noteSearchNormalize(f.text).includes(t)));
  if (!hits.length) return null;
  return h("p", { class: "note-search-hint muted small" },
    textHit ? "另外命中：" : "命中于：",
    hits.map((f, i) => [i ? "；" : "", `${f.label}「`, noteHighlight(f.text, terms), "」"]));
}

function noteMatchesFilter(note, filter = noteFilter()) {
  // 刚标记完成的 3 秒缓冲：仍留在列表里显示划线，计时结束才移走
  if (noteDoneRemoval.has(note.id)) return true;
  const done = noteStatusDone(note);
  if (filter === "done") return done;
  if (filter === "todo") return !done;
  return true;
}

/** 一条待办的所有分类（新数据是 categories 数组，旧数据只有单个 categoryId）。 */
function noteClassificationRows(note) {
  const c = note?.classification || {};
  if (Array.isArray(c.categories) && c.categories.length) return c.categories;
  return c.categoryId ? [{ categoryId: c.categoryId, primaryId: c.primaryId, primary: c.primary, secondary: c.secondary }] : [];
}

/** 一条待办参与筛选 / 计数的键：每个二级分类和它的一级各算一次；完全没有分类时算 pending。 */
function noteCategoryKeysFor(note) {
  const keys = new Set();
  for (const row of noteClassificationRows(note)) {
    if (row.categoryId) keys.add(row.categoryId);
    if (row.primaryId) keys.add(row.primaryId);
  }
  if ((note?.classification?.state || "pending") !== "classified") keys.add("pending");
  return keys.size ? [...keys] : ["pending"];
}

/** 当前分类筛选（可多选，任意命中即显示）。旧代码或测试可能只写 ui.notesCategory。 */
function noteCategoryFilterKeys() {
  if (Array.isArray(ui.notesCategories)) return ui.notesCategories.filter(Boolean);
  return ui.notesCategory ? [ui.notesCategory] : [];
}

/** 待办默认隐藏「平台 / debug」；笔记与日程保持原有范围。 */
// 三类计数同一响应返回：隐藏开关不能随当前 Tab 改变。
// 客户端与服务端都只对 todo 类型应用它，不影响笔记和日程记录。
function noteHideDebug() { return !ui.notesShowDebug; }
function noteMatchesDebugVisibility(note) {
  return !noteHideDebug() || noteDisplayKind(note) !== "todo" || !noteClassificationRows(note).some(row => row.primary === "平台" && row.secondary?.toLowerCase() === "debug");
}
function noteSetShowDebug(show) {
  ui.notesShowDebug = show;
  ui.notesCounts = null; ui.notesCategoryCounts = null; ui.notesFilteredCounts = null;
  noteQueryReload();
}
/** 当前筛选条件的稳定键，同时隔离开关切换前后的异步结果。 */
function noteQueryKey() {
  return `${noteKindFilter()}|${noteFilter()}|${noteLinkFilter()}|${noteCategoryFilterKeys().join(",")}|${noteSearchQuery()}|${noteHideDebug()}`;
}

function noteCategoryPathLabel(id) {
  const categories = ui.noteTaxonomy?.categories || [];
  if (id === "pending") return "待分类";
  const selected = categories.find((c) => c.id === id);
  if (!selected) return "";
  const parent = selected.parentId && categories.find((c) => c.id === selected.parentId);
  return `${parent ? parent.name + " / " : ""}${selected.name}`;
}

/** 当前筛选（完成状态 + 关联对话 + 分类）下的结果数；状态 + 分类优先用服务端全量计数，不随分页变化。 */
function noteFilteredCount() {
  if (noteKindFilter() === "event" && !ui.notesCalendarRecord) return noteCalendarListEvents().length;
  const status = noteFilter();
  const keys = noteCategoryFilterKeys();
  const filtered = ui.notesFilteredCounts;
  // 完成状态 + 单分类 / 全部分类优先用服务端全量计数，本地改完成状态后立即同步。
  if (noteLinkFilter() === "all" && keys.length === 1 && ui.notesCategoryCounts?.[status]) return ui.notesCategoryCounts[status][keys[0]] ?? 0;
  if (noteLinkFilter() === "all" && !keys.length && ui.notesCategoryCounts?.[status]) return ui.notesCategoryCounts[status][""] ?? 0;
  // 多分类或关联对话筛选：服务端按同一组条件算出的各状态计数。
  if (filtered && (keys.length || noteLinkFilter() !== "all")) return filtered[status] ?? 0;
  // 完成状态 / 关联对话 / 分类都随分页下推到服务端：total 就是当前筛选的全量结果数。
  if (typeof ui.notesTotal === "number") return ui.notesTotal;
  // 还没拿到服务端总数（例如刚切换筛选、第一页仍在路上）时按已加载记录现算。
  return (Array.isArray(ui.notes) ? ui.notes : []).filter((n) => noteMatchesKind(n) && noteMatchesFilter(n) && noteMatchesLinkFilter(n) && noteCategoryMatches(n) && noteMatchesSearch(n)).length;
}

/** 分类树每个节点在当前完成状态下的数量；优先用服务端的全量统计。 */
function noteCategoryCounts() {
  const server = ui.notesCategoryCounts;
  if (server && server[noteFilter()]) return server[noteFilter()];
  const counts = { "": 0, pending: 0 };
  for (const note of (Array.isArray(ui.notes) ? ui.notes : [])) {
    if (!noteMatchesFilter(note) || !noteMatchesDebugVisibility(note)) continue;
    counts[""]++;
    for (const key of noteCategoryKeysFor(note)) counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/** 本地增删或改完成状态时同步服务端计数，界面不必等下一次服务端事件。 */
function noteCountsShift(note, delta, from, to) {
  if (note && !noteMatchesDebugVisibility(note)) return;
  const counts = ui.notesCounts;
  if (counts) {
    if (delta.all) counts.all += delta.all;
    if (from === "todo") counts.todo -= 1; else if (from === "done") counts.done -= 1;
    if (to === "todo") counts.todo += 1; else if (to === "done") counts.done += 1;
  }
  const maps = ui.notesCategoryCounts;
  const keys = note ? noteCategoryKeysFor(note) : [];
  if (maps) {
    const shift = (f, sign) => {
      const map = maps[f]; if (!map) return;
      for (const k of keys) map[k] = Math.max(0, (map[k] || 0) + sign);
      map[""] = Math.max(0, (map[""] || 0) + sign);
    };
    if (delta.all) shift("all", delta.all);
    if (from) shift(from, -1);
    if (to) shift(to, 1);
  }
  const selected = noteCategoryFilterKeys();
  const matched = !selected.length || selected.some((key) => keys.includes(key));
  if (matched && ui.notesFilteredCounts) {
    const f = ui.notesFilteredCounts;
    if (delta.all) f.all = Math.max(0, f.all + delta.all);
    if (from === "todo") f.todo -= 1; else if (from === "done") f.done -= 1;
    if (to === "todo") f.todo += 1; else if (to === "done") f.done += 1;
  }
}

/**
 * 筛选条件已下推到服务端分页：换筛选（完成状态 / 关联对话 / 分类）后要用新条件重新取第一页，
 * 不能继续在旧筛选的游标上续读。epoch 用来丢弃切换前还在路上的续读 / 事件合并结果。
 */
let noteQueryEpoch = 0;
/** 最近一次 noteQueryReload 的完成 promise（没有网络刷新时为 undefined），给切大类后恢复固顶位置用。 */
let noteKindReloading;
function noteQueryReload() {
  noteKindReloading = undefined;
  noteQueryEpoch++;
  ui.notesCursor = null;
  ui.notesHasMore = false;
  ui.notesLoadingMore = false;
  ui.notesMore = null;
  noteFirstFlight = null;
  noteMoreFlight = null;
  // 新筛选的第一页回来前，先按本地已加载的记录即时筛一遍（不匹配的旧页会被本地筛选隐藏）；
  // 新页合并回列表，已经滚动加载过的记录不丢。
  ui.notesTotal = null;
  ui.notesMergeFor = null;
  if (ui.view !== "notes") return;
  ui.pageLoading = true;
  ui.notesMergeFor = noteListUrl();
  noteRefreshList();
  if (typeof refresh !== "function") return;
  noteKindReloading = Promise.resolve(refresh({ main: true, force: true })).finally(() => {
    if (ui.view !== "notes") return;
    ui.pageLoading = false;
    noteRefreshList();
    noteFocusPending();
  });
}

function noteSetFilter(filter) {
  const changed = noteFilter() !== filter;
  ui.notesFilter = filter;
  ui.notesMore = null;
  ui.notesFilterMenu = null;
  ui.notesQuickCategory = null;
  if (changed) noteQueryReload(); else noteRefreshList();
}

/** 用户最近一次手动切大类的时间点：定位某条记录时按 id 补切大类的请求，不能盖过它。 */
let noteKindManualEpoch = 0;

// 各 Tab 独立保留筛选；搜索及隐藏 debug 是页面范围。
function noteRememberTabFilters() {
  const filters = ui.notesTabFilters || (ui.notesTabFilters = {});
  filters[noteKindFilter()] = { status: noteFilter(), link: noteLinkFilter(), categories: [...noteCategoryFilterKeys()] };
  return Object.fromEntries(NOTE_KIND_FILTERS.map(({ key }) => [key, filters[key] || {
    status: key === "todo" ? "todo" : "all", link: "all", categories: []
  }]));
}

function noteSetKindFilter(filter, { keepOpen = false, automatic = false } = {}) {
  if (!automatic) noteKindManualEpoch += 1;
  // 大类只有笔记 / 待办 / 日程：遗留或外来的其他取值（如旧的 all）一律按默认的待办处理。
  const next = NOTE_KIND_FILTERS.some((o) => o.key === filter) ? filter : "todo";
  const previous = noteKindFilter();
  const changed = previous !== next;
  if (!automatic && next === "event") ui.notesCalendarRecord = null;
  if (changed && next === "event" && ui.notesCalendar) ui.notesCalendar.anchorToday = true;
  const filters = noteRememberTabFilters();
  ui.notesKindFilter = next;
  if (changed) { ui.notesCalendarRecord = null; if (ui.notesTab === "calendar") ui.notesTab = "records"; }
  if (changed) {
    const selected = filters[next];
    ui.notesFilter = selected.status;
    ui.notesLinkFilter = selected.link;
    ui.notesCategories = [...selected.categories];
    ui.notesCategory = selected.categories.length === 1 ? selected.categories[0] : "";
    ui.notesFilteredCounts = null;
  }
  ui.notesMore = null;
  if (!keepOpen) ui.notesFilterMenu = null;
  ui.notesQuickCategory = null;
  const direction = changed ? noteKindSlideDirection(previous, next) : 0;
  // 头部已固顶（列表滚过一段）时，换大类要停在固顶状态：新列表从头部下面开始，不跳回页面顶部。
  const pinned = changed && noteHeadStuck();
  const region = pinned ? document.getElementById("notes-list-region") : null;
  // 新大类的记录回来前列表区会变矮，页面高度缩水会把滚动位置夹回顶部：先按旧高度撑住；
  // 数据回来后列表可能不满一屏，再撑到至少一屏（头部下面的整块视口），页面才有滚动余量让头部继续固顶。
  if (region) { region.style.minHeight = `${region.offsetHeight}px`; region.dataset.pinFill = "1"; }
  if (changed) noteQueryReload(); else noteRefreshList();
  if (direction) noteKindSlide(direction);
  if (!pinned) return;
  noteScrollListToHead();
  Promise.resolve(noteKindReloading).finally(() => {
    const current = document.getElementById("notes-list-region");
    if (!current || ui.view !== "notes" || noteKindFilter() !== next) return;
    const bar = document.getElementById("notes-sticky-head");
    if (bar) current.style.minHeight = `${Math.ceil((window.innerHeight || 0) - bar.getBoundingClientRect().bottom)}px`;
    noteScrollListToHead();
  });
}

/** 切大类时撑高的列表区只在头部固顶期间保留；滚回头部离开顶部就放开，免得页面底部多出空白。 */
function noteReleasePinFill() {
  const region = document.getElementById("notes-list-region");
  if (!region?.dataset.pinFill) return;
  delete region.dataset.pinFill;
  region.style.removeProperty("min-height");
}

/** 固顶头部（大类 tab + 筛选行）此刻是否真的吸在页面顶部。 */
function noteHeadStuck() {
  const bar = document.getElementById("notes-sticky-head");
  return !!bar && bar.getBoundingClientRect().top <= noteTopbarHeight() + 0.5;
}

/** 固顶状态下把列表滚到「第一条紧贴头部下方」：头部保持固顶，列表回到开头。 */
function noteScrollListToHead() {
  const bar = document.getElementById("notes-sticky-head"), region = document.getElementById("notes-list-region");
  if (!bar || !region || !noteHeadStuck()) return;
  const gap = parseFloat(getComputedStyle(bar).marginBottom) || 0;
  const delta = region.getBoundingClientRect().top - bar.getBoundingClientRect().bottom - gap;
  if (Math.abs(delta) >= 1) window.scrollBy(0, delta);
}

function noteSetLinkFilter(filter) {
  const changed = noteLinkFilter() !== filter;
  ui.notesLinkFilter = filter;
  ui.notesMore = null;
  ui.notesFilterMenu = null;
  ui.notesQuickCategory = null;
  if (changed) noteQueryReload(); else noteRefreshList();
}

function noteSetCategoryFilter(value, { keepOpen = false } = {}) {
  const keys = Array.isArray(value) ? [...new Set(value.filter(Boolean))] : value ? [value] : [];
  const changed = noteCategoryFilterKeys().join(",") !== keys.join(",");
  ui.notesCategories = keys;
  ui.notesFilteredCounts = null;
  // 兼容只读 ui.notesCategory 的旧代码：单选时同步，多选时留空。
  ui.notesCategory = keys.length === 1 ? keys[0] : "";
  if (!keepOpen) ui.notesFilterMenu = null;
  ui.notesMore = null;
  ui.notesQuickCategory = null;
  if (changed) noteQueryReload(); else noteRefreshList();
}

// 三个筛选维度用同一套下拉交互：收起时只显示当前取值，点开再选；分类维度展开分类目录。
const NOTE_FILTER_DIMENSIONS = [
  { key: "status", label: "完成状态", menuLabel: "完成状态筛选", options: NOTE_STATUS_FILTERS.todo },
  { key: "link", label: "关联对话", menuLabel: "关联对话筛选", options: NOTE_LINK_FILTERS },
  { key: "category", label: "分类", menuLabel: "分类筛选" }
];
const noteFilterDimension = (key) => NOTE_FILTER_DIMENSIONS.find((d) => d.key === key);

/** 分类筛选项收起时显示的当前取值：多个分类之间用「｜」分隔。 */
function noteCategoryFilterLabel() {
  const keys = noteCategoryFilterKeys();
  if (!keys.length) return "全部分类";
  return keys.map(noteCategoryPathLabel).filter(Boolean).join("｜") || "全部分类";
}

function noteFilterDimensionOptions(dim, kind = noteKindFilter()) {
  return dim.key === "status" ? noteStatusFilters(kind) : dim.options;
}
const noteFilterDimensionLabel = (dim, kind = noteKindFilter()) => dim.label;
const noteFilterDimensionMenuLabel = (dim, kind = noteKindFilter()) => dim.menuLabel;

function noteFilterDimensionCurrent(dim) {
  if (dim.key === "kind") return noteKindFilter();
  if (dim.key === "status") return noteFilter();
  if (dim.key === "link") return noteLinkFilter();
  return noteCategoryFilterKeys().join(",");
}

function noteFilterDimensionOption(dim) {
  if (dim.key === "category") return { key: noteCategoryFilterKeys().join(","), label: noteCategoryFilterLabel() };
  const current = noteFilterDimensionCurrent(dim);
  const options = noteFilterDimensionOptions(dim);
  return options.find((o) => o.key === current) || options[0];
}

function noteFilterDimensionSet(dim, value) {
  if (dim.key === "kind") return noteSetKindFilter(value);
  if (dim.key === "status") return noteSetFilter(value);
  if (dim.key === "link") return noteSetLinkFilter(value);
  return noteSetCategoryFilter(value);
}

/** 一个下拉：点按钮展开当前维度的取值，选一项后收起并刷新；计数只给完成状态。分类维度的展开内容由目录单独渲染。 */
function noteFilterDropdown(dim, counts) {
  const current = noteFilterDimensionCurrent(dim);
  const selected = noteFilterDimensionOption(dim);
  const options = noteFilterDimensionOptions(dim);
  const label = noteFilterDimensionLabel(dim);
  const menuLabel = noteFilterDimensionMenuLabel(dim);
  const open = ui.notesFilterMenu === dim.key;
  const menu = dim.key === "category" ? null : h("div", { class: "notes-filter-menu", role: "listbox", "aria-label": menuLabel },
    options.map(({ key, label: optionLabel }) => {
      const count = dim.key === "status" && counts ? counts[key] : dim.key === "kind" && ui.notesKindCounts ? ui.notesKindCounts[key] : null;
      return h("button", {
        type: "button", role: "option", class: `notes-filter-option${current === key ? " active" : ""}`,
        "aria-selected": current === key ? "true" : "false", "data-filter-value": key,
        onclick: () => { ui.notesFilterMenu = null; noteFilterDimensionSet(dim, key); }
      },
        h("span", { class: "notes-filter-label" }, optionLabel),
        count != null ? h("span", { class: "notes-filter-count", "aria-hidden": "true" }, String(count)) : null);
    }));
  return h("div", { class: `notes-filter-dropdown${open ? " open" : ""}`, "data-filter-dim": dim.key },
    h("button", {
      type: "button", class: `notes-filter notes-filter-trigger${open ? " open" : ""}`,
      "aria-haspopup": "listbox", "aria-expanded": open ? "true" : "false",
      "aria-label": `${label}：${selected.label}`,
      "data-key": `notes-filter-${dim.key}`,
      onclick: () => {
        if (dim.key === 'category' && !open) {
          const state = noteCategoryBrowserState();
          state.primaryId = null; state.editingId = null; state.editDraft = ''; state.error = ''; state.notice = ''; state.draft = null;
        }
        ui.notesFilterMenu = open ? null : dim.key; noteRefreshList();
      }
    },
      h("span", { class: "notes-filter-label" }, selected.label),
      h("span", { class: "notes-filter-caret", "aria-hidden": "true" }, "▾")),
    open ? menu : null);
}

// 分类目录占一层同 URL 历史：返回先收起，主动关闭也退掉这一层。
const NOTE_CATEGORY_FILTER_HISTORY_KEY = "notesCategoryFilter";
let noteCategoryFilterHistoryClosing = false;
function noteSyncCategoryFilterHistory() {
  if (typeof history === "undefined" || noteCategoryFilterHistoryClosing) return;
  const open = ui.view === "notes" && !ui.notesManagement && ui.notesFilterMenu === "category";
  const marked = !!history.state?.[NOTE_CATEGORY_FILTER_HISTORY_KEY];
  try {
    if (open && !marked) history.pushState({ ...(history.state || {}), [NOTE_CATEGORY_FILTER_HISTORY_KEY]: true }, "", location.href);
    else if (!open && marked) {
      noteCategoryFilterHistoryClosing = true;
      history.back();
    }
  } catch { noteCategoryFilterHistoryClosing = false; }
}
if (typeof window !== "undefined") {
  window.addEventListener("popstate", (ev) => {
    if (noteCategoryFilterHistoryClosing) {
      noteCategoryFilterHistoryClosing = false;
      // 主动关闭后马上再次展开时，等旧历史退出后再补新的一层。
      if (ui.view === "notes") noteSyncCategoryFilterHistory();
      return;
    }
    if (ui.view !== "notes" || ui.notesManagement) return;
    const open = !!ev.state?.[NOTE_CATEGORY_FILTER_HISTORY_KEY];
    if (open === (ui.notesFilterMenu === "category")) return;
    ui.notesFilterMenu = open ? "category" : null;
    // 只换筛选条，保留列表节点、滚动位置及筛选条件。
    const x = window.scrollX, y = window.scrollY;
    document.getElementById("notes-filters")?.replaceWith(noteFilterBar());
    if (!open) document.querySelector('[data-filter-dim="category"] .notes-filter-trigger')?.focus({ preventScroll: true });
    // 宽屏目录占据正文高度；关闭后的滚动锚定和浏览器历史恢复不能挪动列表位置。
    window.scrollTo(x, y);
    requestAnimationFrame(() => window.scrollTo(x, y));
  });
}

// 筛选行右端数字前的日历图标：与「今天」卡片的日历图标同一图形，缩小到字号大小，跟着数字一起进日历。
const NOTE_COUNT_CALENDAR_ICON = '<svg class="notes-count-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="16.5" rx="3"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/></svg>';

/**
 * 筛选行右端的数字。
 *
 * 只有「日程」大类才把数字变成日历入口：日历里装的就是日程，在日程 tab 上点结果数进日历是同一件事；
 * 笔记 / 待办 跟日历没有对应关系，那里的数字只是「这个筛选下有几条」，保持原来的纯数字、不可点。
 * 两种情况都用同一个 #notes-count 装数字，局部刷新只改这一处文本。
 */
function noteCountEntry(count) {
  const entry = h("button", {
    type: "button", id: "notes-count-entry", class: "notes-count-entry", "data-key": "notes-count-calendar",
    "aria-haspopup": "dialog", title: `打开日历（不含 Agent 日程），当前筛选 ${count} 条`,
    onclick: () => noteOpenCalendarFor("human")
  },
    h("span", { class: "notes-count-icon-wrap", "aria-hidden": "true" }),
    h("span", { id: "notes-count", class: "muted small notes-count", "aria-hidden": "true" }, String(count)));
  entry.querySelector(".notes-count-icon-wrap").innerHTML = NOTE_COUNT_CALENDAR_ICON;
  noteSyncCountEntry(count, entry);
  return entry;
}

/** 结果数字变化时同步按钮的可访问名与提示，读屏念到的是「打开日历」而不是一个孤零零的数字。 */
function noteSyncCountEntry(count, node = document.getElementById("notes-count-entry")) {
  if (!node) return;
  const label = `打开日历，查看非 Agent 日程（当前筛选结果 ${count} 条）`;
  node.setAttribute("aria-label", label);
  node.title = `打开日历（不含 Agent 日程），当前筛选 ${count} 条`;
  node.dataset.count = String(count);
}

/** 笔记 / 待办 大类的行末数字：纯数字，不带图标也不可点（与 v3.38 之前一致）。 */
function noteCountNumber(count) {
  return h("span", {
    id: "notes-count", class: "muted small notes-count",
    title: `筛选结果 ${count} 条`, "aria-label": `筛选结果 ${count} 条`
  }, String(count));
}

/** 行末数字按当前大类决定形态：日程 → 日历入口按钮；笔记 / 待办 → 纯数字。 */
function noteCountNode(count) {
  return noteCountNumber(count);
}

/** 日历来源直接平铺，多选状态与日期网格、列表及计数共用。 */
function noteCalendarSourceFilters() {
  const st = noteCalendarState();
  return h("div", { class: "notes-filter-dropdown notes-calendar-sources", "data-filter-dim": "calendarSource",
    role: "listbox", "aria-multiselectable": "true", "aria-label": "日历来源筛选" },
    noteCalendarSources(st, noteCalendarEventsOf(st.data)).map(source => {
      const selected = !noteCalendarSourceHidden(st, source.key);
      return h("button", {
        type: "button", role: "option", class: `notes-filter notes-calendar-source${selected ? " active" : ""}`,
        "data-source": source.key, "data-key": "calendar-source-filter",
        "aria-selected": String(selected), "aria-pressed": String(selected),
        onclick: () => noteCalendarToggleSource(source)
      }, source.name);
    }));
}

/** 顶部三个筛选下拉同一套交互：完成状态、关联对话、分类（类型在列表标题行的分段按钮里）；分类展开分类目录，状态计数优先用服务端全量统计。 */
function noteFilterBar() {
  noteSyncCategoryFilterHistory();
  const scoped = (ui.notes || []).filter((n) => noteCategoryMatches(n) && noteMatchesKind(n) && noteMatchesSearch(n));
  const done = scoped.filter((n) => noteStatusDone(n)).length;
  const client = { all: scoped.length, todo: scoped.length - done, done };
  const cc = ui.notesCategoryCounts;
  const keys = noteCategoryFilterKeys();
  const selected = ui.notesFilteredCounts;
  let counts = selected && (keys.length || noteLinkFilter() !== "all")
    ? { all: selected.all ?? 0, todo: selected.todo ?? 0, done: selected.done ?? 0 }
    : noteLinkFilter() === "all" && keys.length === 1 && cc
      ? { all: cc.all?.[keys[0]] ?? 0, todo: cc.todo?.[keys[0]] ?? 0, done: cc.done?.[keys[0]] ?? 0 }
      : noteLinkFilter() === "all" && !keys.length && cc
        ? { all: cc.all?.[""] ?? 0, todo: cc.todo?.[""] ?? 0, done: cc.done?.[""] ?? 0 }
        : client;
  if (noteKindFilter() === "event" && !ui.notesCalendarRecord) counts = { all: noteCalendarListEvents("all").length, todo: noteCalendarListEvents("todo").length, done: noteCalendarListEvents("done").length };
  const filtered = noteFilteredCount();
  return h("div", { class: `notes-filters${noteCalendarInlineOpen() ? " notes-calendar-filters" : ""}`, id: "notes-filters", "aria-label": "待办筛选" },
    ui.notesFilterMenu === "category" ? h("div", { class: "notes-filter-backdrop", "aria-hidden": "true", onclick: () => { ui.notesFilterMenu = null; noteRefreshList(); } }) : null,
    // 日历数量已在 Tab 展示，筛选栏不重复计数。
    h("div", { class: "notes-filter-row" },
      h("div", { class: "notes-filter-groups" },
        noteCalendarInlineOpen() ? noteCalendarSourceFilters() : null,
        NOTE_FILTER_DIMENSIONS.filter((dim) => noteKindHasDimension(dim.key)).map((dim) => noteFilterDropdown(dim, counts))),
      noteCalendarInlineOpen() ? null : noteCountNode(filtered)),
    ui.notesFilterMenu === "category" ? noteCategoryDirectory() : null);
}

/** 当前筛选下的时间线（或空状态）；列表区域局部刷新时复用它 */
function noteListChildren() {
  if (noteKindFilter() === "event" && !ui.notesCalendarRecord) return noteCalendarListChildren();
  const terms = noteSearchTerms();
  const candidates = [...(ui.notes || [])];
  const record = ui.notesCalendarRecordNote;
  if (record && record.id === ui.notesCalendarRecord && !candidates.some(n => n.id === record.id)) candidates.push(record);
  const notes = candidates.filter((n) => (!ui.notesCalendarRecord || noteKindFilter() !== "event" || n.id === ui.notesCalendarRecord) && noteMatchesKind(n) && noteMatchesFilter(n) && noteMatchesLinkFilter(n) && noteCategoryMatches(n) && noteMatchesSearch(n, terms)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!notes.length) {
    const filter = noteFilter();
    const link = noteLinkFilter();
    const kind = noteKindFilter();
    if (terms.length && !ui.pageLoading) return [noteSearchEmpty(), noteLoadFooter()].filter(Boolean);
    const text = ui.pageLoading ? "正在读取记录…"
      : kind === "note" && filter !== "done" && !noteCategoryFilterKeys().length && link === "all" ? "还没有笔记。随手记下的想法会被 AI 归到这里。"
      : kind === "event" && filter !== "done" && !noteCategoryFilterKeys().length && link === "all" ? "还没有日程。写下带时间的事，例如「明天下午 3 点开会」。"
      : noteCategoryFilterKeys().length ? "当前分类下没有符合此状态的记录。"
      : link === "linked" ? "没有有关联对话的记录。"
      : link === "unlinked" ? "没有无关联对话的记录。"
      : filter === "done" && kind === "event" ? "还没有已过期的日程。"
      : filter === "done" ? "还没有已完成的记录。"
      : filter === "todo" ? "没有未完成的记录，都做完了。"
      : "还没有记录，在上面写下第一条想法吧。";
    return [h("p", { class: "notes-empty muted", role: "status" }, text), noteLoadFooter()].filter(Boolean);
  }
  const back = noteKindFilter() === "event" && ui.notesCalendarRecord ? h("button", { type: "button", class: "btn small", onclick: () => { ui.notesCalendarRecord = null; noteRefreshList(); } }, "‹ 返回日程列表") : null;
  const groups = [];
  for (const note of notes) {
    const key = noteDayLabel(note.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(note);
    else groups.push({ key, items: [note] });
  }
  return [back, h("ol", { class: "notes-timeline" }, groups.map((group) =>
    h("li", { class: "notes-day" },
      h("h2", { class: "notes-day-label" }, group.key),
      h("ol", { class: "notes-list" }, group.items.map(noteEntry))))), noteLoadFooter()].filter(Boolean);
}

/* ------------------------------ 分页与滚动续读 ------------------------------ */
// 待办页新的在前：首屏取一页，列表底部进入视口时自动续读更早的一页。
// 完成状态与分类筛选仍在前端做；计数优先用服务端对全部记录的全量统计。

function noteListUrl(cursor) {
  const params = new URLSearchParams();
  params.set("limit", String(NOTE_PAGE_SIZE));
  if (cursor) params.set("cursor", cursor);
  // 筛选条件随分页一起下推到服务端：翻页翻的是“当前筛选下的第 N 页”，
  // 不会出现某页没有命中、前端为了找命中把全部记录逐页拉完的情况。
  params.set("kind", noteKindFilter());
  params.set("tabFilters", JSON.stringify(noteRememberTabFilters()));
  if (noteHideDebug()) params.set("hideDebug", "1");
  params.set("status", noteFilter());
  const categories = noteCategoryFilterKeys();
  // 单选继续用旧的 category 参数，多选才用 categories，兼容既有服务端与测试替身。
  if (categories.length === 1) params.set("category", categories[0]);
  else if (categories.length > 1) params.set("categories", categories.join(","));
  if (noteLinkFilter() !== "all") params.set("link", noteLinkFilter());
  if (noteSearchQuery()) params.set("q", noteSearchQuery());
  return `/api/notes?${params.toString()}`;
}

/** 首页地址：pagePath / 缓存与滚动续读用同一套拼法。 */
function noteListPath() { return noteListUrl(); }

/**
 * 3 秒完成缓冲内的记录：迟到的服务端事件或旧缓存可能带回未完成快照，
 * 以本地刚标记的完成状态为准，避免划线回退、倒计时结束后记录留在列表里。
 */
function noteKeepPendingDone(next, local) {
  if (!next || !local) return next;
  if (!local.done || !noteDoneRemoval.has(next.id)) return next;
  return local.doneAt && !next.doneAt ? { ...next, done: true, doneAt: local.doneAt } : { ...next, done: true };
}

/** 把一页写进 ui.notes；返回是否真的是一页数据（测试里 api 可能给空对象）。 */
function noteApplyPage(page, reset) {
  if (!page || !Array.isArray(page.notes)) return false;
  const local = new Map((Array.isArray(ui.notes) ? ui.notes : []).map((n) => [n.id, n]));
  if (reset) ui.notes = page.notes.map((n) => noteKeepPendingDone(n, local.get(n.id)));
  else {
    const known = new Set((Array.isArray(ui.notes) ? ui.notes : []).map((n) => n.id));
    ui.notes = [...(Array.isArray(ui.notes) ? ui.notes : []), ...page.notes.filter((n) => !known.has(n.id))];
  }
  ui.notesCursor = page.nextCursor || null;
  ui.notesHasMore = !!page.nextCursor;
  ui.pageLoading = false;
  if (page.counts) ui.notesCounts = page.counts;
  if (page.categoryCounts) ui.notesCategoryCounts = page.categoryCounts;
  if (page.kindCounts) ui.notesKindCounts = page.kindCounts;
  if (page.filteredCounts !== undefined) ui.notesFilteredCounts = noteCategoryFilterKeys().length ? page.filteredCounts : null;
  if (typeof page.total === "number") ui.notesTotal = page.total;
  const created = page.notes.find(n => n.id === ui.notesCreatedFollow?.id);
  if (created) noteFollowCreatedKind(created);
  return true;
}

/** 整份列表（例如分类操作后重新拉全量）视为已加载完，关掉续读游标。 */
function noteUseFullList(list) {
  ui.notes = Array.isArray(list) ? list : [];
  ui.notesCursor = null; ui.notesHasMore = false; ui.notesTotal = ui.notes.length;
  ui.notesFilteredCounts = null;
}

/**
 * 服务端事件后的轻量刷新：只合并回第一页，保留已经滚动加载的更早记录与滚动位置。
 * 新增记录会被放在最前，已加载记录按 id 覆盖更新；游标不动（新记录插在前面只会让旧偏移重读一条，去重可处理）。
 * `syncCursor` 用于换筛选后的第一页：这时游标与“还有没有更早的页”必须以新筛选的响应为准。
 */
function noteMergePage(page, { syncCursor = false } = {}) {
  if (!page || !Array.isArray(page.notes)) return false;
  const incoming = new Map(page.notes.map((n) => [n.id, n]));
  const merged = (Array.isArray(ui.notes) ? ui.notes : []).map((n) => noteKeepPendingDone(incoming.get(n.id), n) || n);
  const known = new Set(merged.map((n) => n.id));
  const fresh = page.notes.filter((n) => !known.has(n.id));
  ui.notes = [...fresh, ...merged];
  if (syncCursor) {
    ui.notesCursor = page.nextCursor || null;
    ui.notesHasMore = !!page.nextCursor;
    ui.pageLoading = false;
  }
  if (page.counts) ui.notesCounts = page.counts;
  if (page.categoryCounts) ui.notesCategoryCounts = page.categoryCounts;
  if (page.kindCounts) ui.notesKindCounts = page.kindCounts;
  if (page.filteredCounts !== undefined) ui.notesFilteredCounts = noteCategoryFilterKeys().length ? page.filteredCounts : null;
  if (typeof page.total === "number") ui.notesTotal = page.total;
  return true;
}

/** 待办列表读取：超时 / 网关错误时页面可见则静默重试，换页或换筛选后停止（见 retryTransientRead）。 */
// 预算定义在 app.js；单独加载 notes.js 的测试页里没有它们，退回默认超时与默认重试间隔。
// 弱网（蜂窝/3G/省流）把单次预算从 6 秒放宽到 12 秒，避免每次都在重试里耗完。
function noteReadOptions() {
  if (typeof adaptiveReadTimeout === "function") return { readTimeoutMs: adaptiveReadTimeout("note") };
  return typeof NOTE_READ_TIMEOUT_MS === "number" ? { readTimeoutMs: NOTE_READ_TIMEOUT_MS } : {};
}
function noteReadWaits() { return typeof NOTE_READ_RETRY_WAITS === "undefined" ? undefined : NOTE_READ_RETRY_WAITS; }
function noteReadRetry(path, isCurrent) {
  const opts = noteReadOptions();
  return typeof retryTransientRead === "function" ? retryTransientRead(() => api(path, opts), isCurrent, noteReadWaits()) : api(path, opts);
}

/**
 * 后台读取（列表刷新 / 续读 / 分类）失败：不进红色错误条（那是留给用户操作失败的），
 * 只给一条不抢眼的提示和「重试」；之后任何一次待办读取成功就自动清掉。
 * 分类管理页里分类就是主内容，仍沿用页内错误条，但同样记下来源，读取成功后自动清掉。
 */
function noteReadFailed(e) {
  const message = e?.message || "读取失败，请重试";
  if (ui.notesManagement) { ui.notesError = message; ui.noteReadErrorMsg = message; return; }
  ui.noteReadError = message;
}
function noteReadRecovered() {
  ui.noteReadError = "";
  if (ui.noteReadErrorMsg && ui.notesError === ui.noteReadErrorMsg) ui.notesError = "";
  ui.noteReadErrorMsg = "";
}
function noteReadNoticeChildren() {
  if (!ui.noteReadError) return [];
  return [`${ui.noteReadError}，内容可能不是最新 `, h("button", { type: "button", class: "btn small", onclick: () => void noteRetryReads() }, "重试")];
}
function noteSyncReadNotice() {
  const box = document.getElementById("notes-read-notice");
  if (!box) return;
  box.replaceChildren(...noteReadNoticeChildren());
  box.hidden = !ui.noteReadError;
}
/** 用户点「重试」、或回到前台 / 网络恢复时：重读首页和分类。 */
function noteRetryReads() {
  if (ui.view !== "notes") return Promise.resolve();
  if (ui.notesManagement) return noteLoadCategories();
  return Promise.all([noteRefreshFirstPage(), noteLoadCategories()]);
}
let noteRecoverAt = 0;
/** 回到前台 / 网络恢复：上一次读取失败过，就静默重读一次（5 秒内不重复）。 */
function noteRecoverReads() {
  if (ui.view !== "notes" || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
  if (!ui.noteReadError && !ui.noteReadErrorMsg && !ui.pageError) return;
  const now = Date.now();
  if (now - noteRecoverAt < 5000) return;
  noteRecoverAt = now;
  if (ui.pageError && typeof refresh === "function") { ui.pageError = ""; void refresh({ main: true, force: true }); return; }
  void noteRetryReads();
}

let noteFirstFlight = null;
/** 服务端 notes 事件到达时调用：合并第一页并局部重绘，不把列表重置回第一页。 */
function noteRefreshFirstPage() {
  if (noteFirstFlight) return noteFirstFlight;
  const gen = ui.routeGeneration, view = ui.view, epoch = noteQueryEpoch;
  let flight;
  flight = (async () => {
    try {
      const page = await noteReadRetry(noteListPath(), () => epoch === noteQueryEpoch && gen === ui.routeGeneration && ui.view === "notes");
      // 筛选在请求期间变了：这份第一页属于旧条件，不能再合并回来。
      if (epoch !== noteQueryEpoch || gen !== ui.routeGeneration || view !== "notes" || ui.view !== "notes") return;
      noteMergePage(page);
      ui.notesError = ""; noteReadRecovered();
      void noteFollowPendingKinds();
      if (typeof noteLoadCategories === "function") void noteLoadCategories();
    } catch (e) {
      if (epoch === noteQueryEpoch && gen === ui.routeGeneration) noteReadFailed(e);
    } finally {
      if (noteFirstFlight === flight) noteFirstFlight = null;
      if (ui.view === "notes") { noteRefreshLive(); noteSyncReadNotice(); }
    }
  })();
  noteFirstFlight = flight;
  return flight;
}

let noteMoreFlight = null;
/** 续读更早的一页；同一时刻只发一次，重复触发共享同一请求。 */
function noteLoadMore() {
  if (ui.notesLoadingMore) return noteMoreFlight || Promise.resolve();
  if (!ui.notesHasMore || !ui.notesCursor) return Promise.resolve();
  ui.notesLoadingMore = true;
  const cursor = ui.notesCursor, gen = ui.routeGeneration, view = ui.view, epoch = noteQueryEpoch;
  let flight;
  flight = (async () => {
    try {
      const page = await noteReadRetry(noteListUrl(cursor), () => epoch === noteQueryEpoch && gen === ui.routeGeneration && ui.view === "notes");
      // 等这一页回来时筛选已经变了：旧条件的游标页直接丢弃，避免把别的分类/状态混进列表。
      if (epoch !== noteQueryEpoch || gen !== ui.routeGeneration || view !== "notes" || ui.view !== "notes") return;
      noteApplyPage(page, false);
      ui.notesError = ""; noteReadRecovered();
    } catch (e) {
      if (epoch === noteQueryEpoch && gen === ui.routeGeneration) noteReadFailed(e);
    } finally {
      if (epoch === noteQueryEpoch) ui.notesLoadingMore = false;
      if (noteMoreFlight === flight) noteMoreFlight = null;
      if (ui.view === "notes") { noteRefreshList(); noteSyncReadNotice(); }
    }
  })();
  noteMoreFlight = flight;
  noteRefreshList();
  return flight;
}

/** 列表底部接近视口就预取下一页；至少提前一屏，滚动时内容通常已经铺好。 */
function noteMaybeAutoLoad() {
  // 换筛选后的第一页还在路上：先别续读，否则会接着旧游标把上一组筛选的页拉进来。
  if (ui.view !== "notes" || !ui.notesHasMore || ui.notesLoadingMore || ui.pageLoading) return;
  // 正在编辑时列表不重绘（见 noteListEditorFocused）：底部的哨兵不会跟着往下走，
  // 这时续读会一页接一页地拉下去，等焦点离开、列表补上再说。
  if (noteListEditorFocused()) return;
  const sentinel = document.getElementById("notes-sentinel");
  if (!sentinel || !sentinel.isConnected) return;
  const gap = Math.max(600, (window.innerHeight || 0) * 1.2);
  if (sentinel.getBoundingClientRect().top <= (window.innerHeight || 0) + gap) void noteLoadMore();
}

function noteScheduleAutoLoad() {
  if (typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => { if (ui.view === "notes") noteMaybeAutoLoad(); });
}

let noteEventsInstalled = false;

/** 固顶头部（大类 tab + 筛选行）补一层分隔阴影：滚到下面、头部真正吸顶时才显示，静止时不抢视线。 */
function noteSyncTabBarStuck() {
  const bar = document.getElementById("notes-sticky-head");
  if (!bar) return;
  const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--topbar-h")) || 0;
  const stuck = bar.getBoundingClientRect().top <= top + 0.5;
  bar.classList.toggle("is-stuck", stuck);
  if (!stuck) noteReleasePinFill();
}

function noteViewportChanged(ev) {
  if (ui.view !== "notes") return;
  noteSyncCalendarView();
  noteSyncTabBarStuck();
  noteMaybeAutoLoad();
  // 宽度变了会影响换行和正文高度：只在 resize 时重新量一次，滚动手势不做多余布局。
  if (ev?.type === "resize") noteCollapseLater();
}
function noteInstallEvents() {
  if (noteEventsInstalled) return;
  noteEventsInstalled = true;
  window.addEventListener("scroll", noteViewportChanged, { passive: true });
  window.addEventListener("resize", noteViewportChanged);
  // 上次读取失败后，回到前台 / 网络恢复就静默重读一次，不用等用户自己点。
  document.addEventListener("visibilitychange", noteRecoverReads);
  window.addEventListener("online", noteRecoverReads);
  window.addEventListener("focus", noteRecoverReads);
  // 编辑中推迟的列表刷新：焦点一离开就补上
  document.addEventListener("focusout", noteListFocusOut);
}
function noteDeactivate() {
  // 离开待办页：手机日历视图的历史标记不能跟着带到下一条路由，否则返回时会莫名重新打开日历。
  if (noteCalendarHistoryState()) noteCalendarDropHistoryMarker();
  if (ui.notesTab === "calendar") ui.notesTab = "records";
  noteCloseSheet();
  if (!noteEventsInstalled) return;
  window.removeEventListener("scroll", noteViewportChanged);
  window.removeEventListener("resize", noteViewportChanged);
  document.removeEventListener("visibilitychange", noteRecoverReads);
  window.removeEventListener("online", noteRecoverReads);
  window.removeEventListener("focus", noteRecoverReads);
  document.removeEventListener("focusout", noteListFocusOut);
  noteEventsInstalled = false;
}

/** 列表底部：还有更早记录时给出哨兵（供自动续读）与一个手动按钮。 */
function noteLoadFooter() {
  if (noteKindFilter() === "event") return null;
  if (!ui.notesTotal) return null;
  // 换筛选时保留的旧页可能包含当前筛选不显示的记录：按当前筛选计已加载条数。
  const loaded = (Array.isArray(ui.notes) ? ui.notes : []).filter((n) => noteMatchesFilter(n) && noteMatchesLinkFilter(n) && noteCategoryMatches(n)).length;
  if (ui.notesHasMore) return h("div", { id: "notes-sentinel", class: "notes-more", role: "status" },
    h("span", { class: "muted small" }, ui.notesLoadingMore ? "正在加载更早的记录…" : `已加载 ${loaded} / ${ui.notesTotal} 条`),
    h("button", { type: "button", class: "btn small", disabled: !!ui.notesLoadingMore, onclick: () => void noteLoadMore() }, ui.notesLoadingMore ? "加载中…" : "加载更早的记录"));
  return loaded > NOTE_PAGE_SIZE ? h("p", { class: "muted small notes-more", role: "status" }, `已加载全部 ${ui.notesTotal} 条`) : null;
}

/** 切换类型时列表的滑入方向：往右边的类型切（笔记 → 待办）为 1，往左边切为 -1。 */
function noteKindSlideDirection(from, to) {
  const a = NOTE_KIND_SWIPE_ORDER.indexOf(from), b = NOTE_KIND_SWIPE_ORDER.indexOf(to);
  return a < 0 || b < 0 ? 0 : Math.sign(b - a);
}

/** 滑出用的时长，和「今天」卡片的人 / Agent 切换一致；滑入时长在 styles.css（.24s）。 */
const NOTE_KIND_SLIDE_MS = NOTE_TODAY_SLIDE_MS;

/** 清掉跟手 / 滑出留下的行内位移与裁切类：每次切换前都回到干净状态。 */
function noteKindClearDrag(region = document.getElementById("notes-list-region"), panel = document.getElementById("notes-records-panel")) {
  if (region) {
    region.style.removeProperty("transition");
    region.style.removeProperty("transform");
    region.style.removeProperty("opacity");
    delete region.dataset.kindLeaving;
  }
  panel?.classList.remove("kind-sliding");
}

/** 新类型的记录从切换方向的那一侧滑入（带淡入），位移 / 时长 / 缓动和「今天」卡片同一套；减少动效时不播放。 */
function noteKindSlide(direction) {
  const panel = document.getElementById("notes-records-panel"), region = document.getElementById("notes-list-region");
  if (!panel || !region) return;
  region.classList.remove("kind-slide-from-right", "kind-slide-from-left");
  // 滑出后跟手的行内位移还在：先清掉，否则新列表会顶着 translateX 停在屏外。
  noteKindClearDrag(region, panel);
  if (!direction || noteReducedMotion()) return;
  void region.offsetWidth; // 重新开始动画：连续快速切换时每次都从头滑入
  panel.classList.add("kind-sliding");
  region.classList.add(direction > 0 ? "kind-slide-from-right" : "kind-slide-from-left");
  region.addEventListener("animationend", () => {
    region.classList.remove("kind-slide-from-right", "kind-slide-from-left");
    panel.classList.remove("kind-sliding");
  }, { once: true });
}

/* --------------------------- 左右滑动：大类 tab / 手机日历 --------------------------- */
// 手机上在记录区左右滑动切换类型 tab（顺序同分段按钮：笔记 → 待办 → 日程）。卡片自身不再有左滑操作，删除走卡片「更多」菜单。
// 列表页没有左滑拉出日历的手势；日历从「今天」卡片的日历图标进入，日历视图里仍可从左边缘右滑返回。
const NOTE_KIND_SWIPE_ORDER = ["note", "todo", "event"];
const NOTE_KIND_SWIPE_MIN = 56;

/**
 * 应用级左右滑（app-swipe.js，底栏切换上一个 / 下一个应用）的让路判断：返回 true = 这次手势归待办页自己。
 * 记录区的大类 tab、「今天」卡片的 人 / Agent 在这个方向上还有下一项就归它们；
 * 已经滑到头（这个方向没有下一项）才返回 false，交给应用层切换。
 * 日历、编辑中、横向滚动 / 输入 / 表格等本来就不接管横滑的地方一律让路，不能被应用级切换打断。
 */
function noteAppSwipeClaims(target, dx, dy) {
  if (!(target instanceof Element)) return false;
  const today = target.closest("#notes-today-body");
  if (today) return !!target.closest(NOTE_TODAY_SWIPE_IGNORE) || !!noteTodaySwipeNext(dx, dy);
  if (ui.view !== "notes") return false;
  if (ui.notesEdit || ui.notesManagement) return true;
  if (target.closest(".notes-calendar-inline, .notes-calendar-view, .notes-calendar-overlay, .notes-sheet, .notes-composer")) return true;
  if (target.closest("#notes-records-panel")) return !!target.closest(NOTE_KIND_SWIPE_IGNORE) || !!noteKindSwipeNext(dx, dy);
  return false;
}
(window.piAppSwipeClaimers = window.piAppSwipeClaimers || []).push(noteAppSwipeClaims);

/** 手势方向指向的下一个大类（只判方向与两端，不判距离）；竖滑、已在两端都返回 null。 */
function noteKindSwipeNext(dx, dy, current = noteKindFilter()) {
  if (Math.abs(dx) < Math.abs(dy) * 1.5) return null;
  const index = NOTE_KIND_SWIPE_ORDER.indexOf(current);
  if (index < 0) return null;
  // 手指向左滑 = 看右边一个 tab
  return NOTE_KIND_SWIPE_ORDER[index + (dx < 0 ? 1 : -1)] || null;
}

/** 横向滑动的位移 → 要切到的大类；竖滑、滑得太短、已在两端都返回 null。 */
function noteKindSwipeTarget(dx, dy, current = noteKindFilter()) {
  if (Math.abs(dx) < NOTE_KIND_SWIPE_MIN) return null;
  return noteKindSwipeNext(dx, dy, current);
}

/** 这些地方的横向手势归它们自己（输入、可横滚的图片条、代码/表格、日历、分类目录拖动）。 */
const NOTE_KIND_SWIPE_IGNORE = "input, textarea, select, pre, table, .note-images, #notes-category-directory, .notes-filter-dropdown, .notes-calendar, .notes-calendar-inline";

/**
 * 记录区左右滑：和「今天」卡片的人 / Agent 切换一套手感——
 * 先跟手（带淡出、只往目标方向走），松手够远就把当前列表往手指方向滑出，换大类，
 * 新列表再从另一侧滑入；不够远就弹回原位。竖滑始终留给页面滚动。
 */
function noteInstallKindSwipe(panel) {
  if (!panel || panel.dataset.kindSwipe) return;
  panel.dataset.kindSwipe = "1";
  let drag = null;
  const regionEl = () => document.getElementById("notes-list-region");
  panel.addEventListener("pointerdown", (ev) => {
    drag = null;
    if (ev.pointerType !== "touch" || ui.notesEdit || ui.notesManagement) return;
    if (ev.target instanceof Element && ev.target.closest(NOTE_KIND_SWIPE_IGNORE)) return;
    const region = regionEl();
    // 上一条列表还在滑出：不接新手势，免得两段动画抢同一个节点
    if (!region || region.dataset.kindLeaving) return;
    drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, width: panel.clientWidth || window.innerWidth || 1, active: false };
  });
  panel.addEventListener("pointermove", (ev) => {
    const s = drag;
    if (!s || ev.pointerId !== s.id) return;
    const region = regionEl();
    if (!region) { drag = null; return; }
    const dx = ev.clientX - s.x, dy = ev.clientY - s.y;
    if (!s.active) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
      // 竖滑留给页面滚动；这个方向没有下一个大类（已在两端）也不接管，和「今天」卡片一样
      if (!noteKindSwipeNext(dx, dy)) { drag = null; return; }
      s.active = true;
      region.style.transition = "none";
      panel.classList.add("kind-sliding");
      // 确认是横滑之后再捕获指针：手指滑出面板、或记录被后台刷新换掉时也能收到 pointerup，
      // 否则跟手位移会卡住。按下就捕获会把 tap 也卷进来，所以放在这里。
      try { panel.setPointerCapture?.(ev.pointerId); } catch { /* 合成事件 / 老浏览器没有指针捕获也照常 */ }
    }
    // 只往目标方向跟手，反向回拉最多回到原位
    const forward = noteKindSwipeNext(dx, dy) ? dx : 0;
    region.style.transform = forward ? `translateX(${forward}px)` : "";
    region.style.opacity = forward ? String(Math.max(0.25, 1 - Math.abs(forward) / (s.width * 0.9))) : "";
  });
  panel.addEventListener("pointerup", (ev) => {
    const s = drag; drag = null;
    if (!s) return;
    try { panel.releasePointerCapture?.(ev.pointerId); } catch { /* 没有捕获就忽略 */ }
    if (!s.active || ev.pointerId !== s.id) return;
    const region = regionEl();
    if (!region) return;
    const dx = ev.clientX - s.x, dy = ev.clientY - s.y;
    // 已经横滑：挡掉这次落在记录 / 链接上的 click，免得顺手打开
    panel.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); }, { capture: true, once: true });
    const target = noteKindSwipeTarget(dx, dy);
    if (!target || noteReducedMotion()) {
      noteKindClearDrag(region, panel);
      if (target) noteSetKindFilter(target);
      return;
    }
    // 当前列表继续往手指的方向滑出，滑完再换大类，新列表从另一侧滑入
    region.dataset.kindLeaving = "1";
    region.style.transition = `transform ${NOTE_KIND_SLIDE_MS}ms ease-in, opacity ${NOTE_KIND_SLIDE_MS}ms ease-in`;
    region.style.transform = `translateX(${(dx < 0 ? -1 : 1) * s.width}px)`;
    region.style.opacity = "0";
    setTimeout(() => {
      delete region.dataset.kindLeaving;
      // 滑出期间已经换过大类（点了分段按钮）：不重复切换
      if (!region.isConnected || noteKindFilter() === target) return;
      noteSetKindFilter(target);
    }, NOTE_KIND_SLIDE_MS);
  });
  panel.addEventListener("pointercancel", () => {
    const s = drag; drag = null;
    if (s?.active) noteKindClearDrag(regionEl(), panel);
  });
}

if (typeof document !== "undefined") {
  // 侧边栏 / 手机日历视图不再是 modal dialog，Esc 仍按「先收浮层、再返回待办」的旧顺序处理。
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || ev.defaultPrevented) return;
    if (ui.view !== "notes" || ui.notesManagement) return;
    const docked = noteCalendarDocked();
    if (!docked && ui.notesTab !== "calendar") return;
    if (document.querySelector("dialog[open]")) return;
    const st = noteCalendarState();
    if (st.sheetOpen || st.pickerOpen || st.settingsOpen) {
      st.sheetOpen = false; st.pickerOpen = false; st.settingsOpen = false;
      noteReplaceCalendarPanel();
      ev.preventDefault();
      return;
    }
    if (!docked && ui.notesTab === "calendar" && !noteCalendarInlineOpen()) { noteDismissDrawer(); ev.preventDefault(); }
  });
}

function noteCalendarViewEl() { return document.getElementById("notes-calendar-view"); }
// 左滑打开后浏览器可能还会补一个 click：只挡住落在遮罩上的那一下，避免刚打开就被立刻关掉；
// 不拦页面上的按钮，用户滑完马上点别的仍然有效。
let noteCalendarBackdropGuardUntil = 0;
function noteCalendarGuardBackdrop() { noteCalendarBackdropGuardUntil = Date.now() + 500; }
function noteCalendarBackdropClick() {
  if (Date.now() < noteCalendarBackdropGuardUntil) { noteCalendarBackdropGuardUntil = 0; return; }
  noteDismissDrawer();
}
function noteCalendarDragOffset(view, offset, width) {
  const w = width || view.clientWidth || window.innerWidth || 1;
  const next = Math.max(0, Math.min(w, offset));
  view.style.setProperty("--notes-calendar-offset", `${next}px`);
  view.style.setProperty("--notes-calendar-backdrop", String(1 - next / w));
}
function noteCalendarClearDrag(view) {
  if (!view) return;
  view.classList.remove("is-dragging");
  view.style.removeProperty("--notes-calendar-offset");
  view.style.removeProperty("--notes-calendar-backdrop");
}
function noteCalendarResetDrag(view) {
  if (!view) return;
  view.classList.remove("is-dragging");
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!view.classList.contains("is-dragging")) {
      view.style.removeProperty("--notes-calendar-offset");
      view.style.removeProperty("--notes-calendar-backdrop");
    }
  }));
}

/** 手机日历视图右滑：面板跟着手指退出，超过 56px 松手回到待办。 */
function noteInstallCalendarCloseSwipe(view) {
  if (!view || view.dataset.calendarCloseSwipe) return;
  view.dataset.calendarCloseSwipe = "1";
  const panel = view.querySelector(".notes-calendar-view-panel");
  if (!panel) return;
  let drag = null;
  panel.addEventListener("pointerdown", (ev) => {
    drag = null;
    if (ev.pointerType !== "touch" || noteCalendarDocked() || !view.classList.contains("is-open")) return;
    if (ev.clientX > panel.getBoundingClientRect().left + 24) return;
    if (ev.target instanceof Element && ev.target.closest("button, a, input, textarea, select, [contenteditable='true'], [role='button']")) return;
    drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, width: view.clientWidth || window.innerWidth || 1, active: false };
  }, { passive: true });
  panel.addEventListener("pointermove", (ev) => {
    const s = drag;
    if (!s || ev.pointerId !== s.id) return;
    const dx = ev.clientX - s.x, dy = ev.clientY - s.y;
    if (!s.active) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.4 || dx <= 0) { drag = null; return; }
      s.active = true;
      view.classList.add("is-dragging");
    }
    noteCalendarDragOffset(view, dx, s.width);
  }, { passive: true });
  const finish = (ev) => {
    const s = drag; drag = null;
    if (!s?.active || ev.pointerId !== s.id) return;
    const offset = parseFloat(view.style.getPropertyValue("--notes-calendar-offset")) || 0;
    if (offset >= NOTE_KIND_SWIPE_MIN) {
      noteDismissDrawer();
    } else noteCalendarResetDrag(view);
  };
  panel.addEventListener("pointerup", finish);
  panel.addEventListener("pointercancel", () => { const s = drag; drag = null; if (s?.active) noteCalendarResetDrag(view); });
}

/** 日期区左右滑：右滑看上一段（上个月 / 上周），左滑看下一段；竖滑仍留给页面滚动。
 *  返回松手时该翻到哪一段（0 = 不翻）：拖过一小段，或是一次明显的快划。 */
function noteCalendarShiftSwipeTarget(dx, dy, elapsed = Infinity) {
  if (Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  const flick = elapsed > 0 && Math.abs(dx) >= 24 && Math.abs(dx) / elapsed >= 0.45;
  if (Math.abs(dx) < NOTE_KIND_SWIPE_MIN && !flick) return 0;
  return dx < 0 ? 1 : -1;
}

/** 相邻一段（delta = ±1）的日期网格：用已读到的数据画好，跟手滑动时和当前网格首尾相接。 */
function noteCalendarNeighborGrid(delta) {
  const st = noteCalendarState();
  const target = noteCalendarShiftDate(st, delta);
  const month = noteMonthKey(target);
  const data = month === st.month ? st.data : (noteCalendarCachedData(st, month) || st.data);
  const events = noteCalendarVisibleEvents(st, noteCalendarEventsOf(data));
  const grid = noteCalendarGrid({ ...st, month }, events, target);
  grid.classList.add("neighbor");
  grid.setAttribute("aria-hidden", "true");
  grid.setAttribute("inert", "");
  return grid;
}

/** 把当前网格装进一个裁切容器，滑动时相邻的月 / 周从侧面接上来，随手指一起移动。 */
function noteCalendarPagerOpen(view) {
  const grid = view.querySelector(".notes-calendar-grid");
  if (!grid || !grid.parentNode) return null;
  const wrap = document.createElement("div");
  wrap.className = "notes-calendar-pager";
  grid.parentNode.insertBefore(wrap, grid);
  wrap.append(grid);
  const pager = { wrap, grid, width: wrap.clientWidth || 1, height: wrap.offsetHeight, neighbors: {}, heights: {} };
  wrap.style.height = `${pager.height}px`;
  return pager;
}

/** 手指位移 dx（负 = 向左）时各段的位置；dx 超过一屏宽的部分不再跟。 */
function noteCalendarPagerMove(pager, dx) {
  const w = pager.width;
  const x = Math.max(-w, Math.min(w, dx));
  if (!x) {
    pager.grid.style.transform = "";
    for (const el of Object.values(pager.neighbors)) el.style.transform = `translateX(${el.dataset.dir * w}px)`;
    pager.wrap.style.height = `${pager.height}px`;
    return;
  }
  const dir = x < 0 ? 1 : -1;
  if (!pager.neighbors[dir]) {
    const el = noteCalendarNeighborGrid(dir);
    el.dataset.dir = String(dir);
    pager.wrap.append(el);
    pager.neighbors[dir] = el;
    pager.heights[dir] = el.offsetHeight + 2;
  }
  pager.grid.style.transform = `translateX(${x}px)`;
  for (const el of Object.values(pager.neighbors)) el.style.transform = `translateX(${x + el.dataset.dir * w}px)`;
  // 相邻月的周数可能不同（5 行 / 6 行）：容器高度随滑动进度过渡，下方日程不会跳。
  const progress = Math.abs(x) / w;
  pager.wrap.style.height = `${pager.height + (pager.heights[dir] - pager.height) * progress}px`;
}

/** 松手：翻页就滑到相邻那一段，否则弹回；动画结束后 done(翻页方向或 0)。 */
function noteCalendarPagerSettle(pager, target, done) {
  const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finish = () => { if (pager.settled) return; pager.settled = true; done(); };
  if (reduced) { finish(); return; }
  // 快划时可能还没来得及建出那一侧的相邻段：先补上，再一起滑过去。
  if (target && !pager.neighbors[target]) noteCalendarPagerMove(pager, -target);
  const ease = "transform .22s cubic-bezier(.2,.7,.3,1)";
  pager.grid.style.transition = ease;
  for (const el of Object.values(pager.neighbors)) el.style.transition = ease;
  pager.wrap.style.transition = "height .22s cubic-bezier(.2,.7,.3,1)";
  const w = pager.width;
  pager.grid.style.transform = target ? `translateX(${-target * w}px)` : "";
  for (const el of Object.values(pager.neighbors)) el.style.transform = `translateX(${(target ? el.dataset.dir * w - target * w : el.dataset.dir * w)}px)`;
  pager.wrap.style.height = `${target && pager.heights[target] ? pager.heights[target] : pager.height}px`;
  setTimeout(finish, 240);
}

/** 弹回后拆掉容器，把原来的网格放回去。 */
function noteCalendarPagerClose(pager) {
  if (!pager.wrap.isConnected) return;
  for (const el of Object.values(pager.neighbors)) el.remove();
  pager.grid.style.transform = ""; pager.grid.style.transition = "";
  pager.wrap.replaceWith(pager.grid);
}

/** 在日期格子上竖滑：下拉展开整月，上滑收起成一周。手指位移直接换算成 --cal-p（0 = 一周，1 = 整月），
 *  箭头与高度一起跟着变；松手按位置和速度决定展开还是收起，再走同一套过渡。 */
function noteCalendarFoldOpen(view) {
  const panel = view.querySelector("#notes-calendar-panel");
  const grid = panel?.querySelector(".notes-calendar-grid");
  const cell = grid?.querySelector(".notes-calendar-day");
  const rows = Number(grid?.style.getPropertyValue("--cal-rows")) || 0;
  if (!panel || !cell || rows < 2) return null;
  const st = noteCalendarState();
  if (st.sheetOpen || st.pickerOpen || st.settingsOpen) return null;
  const start = Number(panel.style.getPropertyValue("--cal-p"));
  panel.classList.add("is-dragging");
  return { panel, start: Number.isFinite(start) ? start : noteCalendarProgress(noteCalendarView(st)), extra: Math.max(1, (rows - 1) * cell.offsetHeight), progress: 0 };
}

function noteCalendarFoldMove(fold, dy) {
  fold.progress = Math.max(0, Math.min(1, fold.start + dy / fold.extra));
  fold.panel.style.setProperty("--cal-p", fold.progress.toFixed(3));
}

function noteCalendarFoldSettle(fold, release) {
  fold.panel.classList.remove("is-dragging");
  const flick = release && Math.abs(release.dy) >= 24 && release.elapsed > 0 && Math.abs(release.dy) / release.elapsed >= 0.4;
  const expanded = release ? (flick ? release.dy > 0 : fold.progress >= 0.5) : fold.start >= 0.5;
  const st = noteCalendarState();
  const view = expanded ? "month" : "week";
  if (noteCalendarView(st) !== view) noteCalendarSetView(view);
  else noteCalendarApplyProgress(noteCalendarProgress(view));
}

/** 在月历 / 周条的日期格子上左右滑切换月份或周，和顶部 ‹ › 的效果一致；
 *  滑动时相邻的月 / 周跟手接在旁边，能同时看到上个月和下个月的衔接。
 *  手机左边缘右滑仍是收起日历，那一段留给关闭手势；滑完松手后挡掉补发的 click，避免顺手选中日期。 */
function noteInstallCalendarGridSwipe(view) {
  if (!view || view.dataset.calendarGridSwipe) return;
  view.dataset.calendarGridSwipe = "1";
  let drag = null;
  let settling = false;
  // 滑完松手后浏览器会补一个 click：挡掉它，别让它顺手选中日期。
  // 用手动时间窗而不是 once 监听：合成事件 / 指针被取消时不会留下一个吞掉下一次点击的监听。
  let clickGuardUntil = 0;
  view.addEventListener("click", (ev) => {
    if (Date.now() >= clickGuardUntil) return;
    clickGuardUntil = 0;
    ev.preventDefault();
    ev.stopPropagation();
  }, { capture: true });
  view.addEventListener("pointerdown", (ev) => {
    drag = null;
    // 上一次滑动没有补发 click（触控被取消）：下一次按下先撤掉时间窗，后续点击照常生效。
    if (Date.now() < clickGuardUntil) clickGuardUntil = 0;
    if (settling || ev.pointerType !== "touch") return;
    if (ui.view !== "notes" || ui.notesManagement) return;
    if (!(ev.target instanceof Element) || !ev.target.closest(".notes-calendar-grid")) return;
    const st = noteCalendarState();
    if (st.sheetOpen || st.pickerOpen || st.settingsOpen) return;
    const panel = view.querySelector(".notes-calendar-view-panel");
    if (!noteCalendarDocked() && panel && ev.clientX <= panel.getBoundingClientRect().left + 24) return;
    drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, t: ev.timeStamp, active: false, pager: null };
  }, { passive: true });
  view.addEventListener("pointermove", (ev) => {
    const s = drag;
    if (!s || ev.pointerId !== s.id) return;
    const dx = ev.clientX - s.x, dy = ev.clientY - s.y;
    if (!s.active) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
      // 一开始就偏竖向：下拉展开整月、上滑收起到一周，跟手改展开程度；不再当横滑。
      if (Math.abs(dx) < Math.abs(dy) * 1.5) {
        const open = noteCalendarFoldOpen(view);
        if (!open) { drag = null; return; }
        s.fold = open;
        s.active = true;
        try { view.setPointerCapture?.(ev.pointerId); } catch { /* 合成事件 / 老浏览器没有指针捕获也照常 */ }
      } else {
        s.active = true;
      try { view.setPointerCapture?.(ev.pointerId); } catch { /* 合成事件 / 老浏览器没有指针捕获也照常 */ }
      s.pager = noteCalendarPagerOpen(view);
      }
    }
    if (s.fold) noteCalendarFoldMove(s.fold, dy);
    else if (s.pager) noteCalendarPagerMove(s.pager, dx);
  }, { passive: true });
  const end = (ev, cancelled) => {
    const s = drag; drag = null;
    if (!s || !s.active || ev.pointerId !== s.id) return;
    try { view.releasePointerCapture?.(ev.pointerId); } catch { /* 没有捕获就忽略 */ }
    if (s.fold) {
      clickGuardUntil = Date.now() + 500;
      noteCalendarFoldSettle(s.fold, cancelled ? null : { dy: ev.clientY - s.y, elapsed: ev.timeStamp - s.t });
      return;
    }
    const target = cancelled ? 0 : noteCalendarShiftSwipeTarget(ev.clientX - s.x, ev.clientY - s.y, ev.timeStamp - s.t);
    if (target) clickGuardUntil = Date.now() + 500;
    const commit = () => { settling = false; if (target) noteCalendarShift(target); else if (s.pager) noteCalendarPagerClose(s.pager); };
    if (!s.pager) { commit(); return; }
    settling = true;
    noteCalendarPagerSettle(s.pager, target, commit);
  };
  view.addEventListener("pointerup", (ev) => end(ev, false));
  view.addEventListener("pointercancel", (ev) => end(ev, true));
}

/** 点页面其他地方收起「更多」菜单与筛选下拉（触发元素自身在各自容器内，不会被误收）。 */
if (typeof document !== "undefined") {
  document.addEventListener("click", (ev) => {
    const target = ev.target;
    let changed = false;
    if (ui.notesMore && !(target instanceof Element && target.closest(".note-more"))) { ui.notesMore = null; changed = true; }
    if (ui.notesFilterMenu && !(target instanceof Element && target.closest(".notes-filter-dropdown, #notes-category-directory"))) { ui.notesFilterMenu = null; changed = true; }
    if (ui.notesQuickCategory && !(target instanceof Element && target.closest(".note-category-quick, .note-category-quick-toggle"))) { ui.notesQuickCategory = null; changed = true; }
    if (changed && ui.view === "notes") noteRefreshList();
  });
}

/** 局部刷新：只更新筛选 tab、计数、错误提示与列表区域，保留输入框里的草稿与焦点 */
function noteRefreshList({ keepDirectory = false } = {}) {
  if (ui.notesManagement) { renderMain(); return; }
  const active = document.activeElement;
  const filterFocus = active?.closest?.(".notes-filter-dropdown") ? { key: active.getAttribute("data-key"), source: active.getAttribute("data-source") } : null;
  const focusKey = active?.getAttribute('data-category-focus');
  // 大类分段按钮会被这一轮重绘换掉：记住它是哪一个，换完补回焦点（键盘左右键切换时不能丢焦点）
  const tabFocus = active?.classList?.contains("notes-kind-tab") ? active.getAttribute("data-kind-filter") : null;
  const selection = focusKey && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  noteSyncTabs();
  noteSyncSearch();
  const categories = document.getElementById("notes-category-controls");
  if (categories) {
    const next = noteCategoryControls();
    if (next) categories.replaceWith(next);
    else categories.remove();
  }
  const bar = document.getElementById("notes-filters");
  if (bar) {
    const next = noteFilterBar();
    const row = bar.querySelector(":scope > .notes-filter-row"), nextRow = next.querySelector(":scope > .notes-filter-row");
    // 分类目录开着时只换筛选行（下拉标签 + 结果数），目录本身原地保留：两列滚动位置、改名输入、拖动都不被打断。
    if (keepDirectory && row && nextRow && bar.querySelector("#notes-category-directory")) row.replaceWith(nextRow);
    else bar.replaceWith(next);
  }
  const title = document.getElementById("notes-list-title");
  if (title) noteMorphListTitle(title, noteListTitle());
  noteSyncKindResult();
  const count = document.getElementById("notes-count");
  if (count) {
    const n = noteFilteredCount();
    count.textContent = String(n);
    // 日程 tab 上是日历入口按钮（可访问名要带「打开日历」），笔记 / 待办 上是纯数字
    if (document.getElementById("notes-count-entry")?.contains(count)) noteSyncCountEntry(n);
    else {
      count.title = `筛选结果 ${n} 条`;
      count.setAttribute("aria-label", `筛选结果 ${n} 条`);
    }
  }
  const error = document.getElementById("notes-error");
  if (error) { error.textContent = ui.notesError || ""; error.hidden = !ui.notesError; }
  noteSyncReadNotice();
  const region = document.getElementById("notes-list-region");
  if (region && noteListEditorFocused()) {
    // 正在一条记录的输入框里打字：这一轮不换列表（见 noteListEditorFocused），先记下来等焦点离开后补。
    noteListRefreshPending = true;
  } else if (region) {
    region.replaceChildren(...noteListChildren().filter(Boolean)); noteSyncCollapse(region);
    noteListRefreshPending = false;
  }
  if (focusKey) {
    const restored = document.querySelector(`[data-category-focus="${CSS.escape(focusKey)}"]`);
    restored?.focus({ preventScroll: true });
    if (selection && restored?.setSelectionRange) restored.setSelectionRange(...selection);
  }
  if (filterFocus?.key) document.querySelector(`[data-key="${CSS.escape(filterFocus.key)}"]${filterFocus.source ? `[data-source="${CSS.escape(filterFocus.source)}"]` : ""}`)?.focus({ preventScroll: true });
  if (tabFocus) document.querySelector(`.notes-kind-tab[data-kind-filter="${CSS.escape(tabFocus)}"]`)?.focus({ preventScroll: true });
  noteFocusPending();
  if (noteCalendarInlineOpen()) { noteStartCountdownTicker(); noteCalendarAnchorToday(); }
  noteScheduleAutoLoad();
}

/**
 * 列表整块重绘会把正在输入的 textarea / input 从 DOM 上摘下来：手机上软键盘随之收起，
 * 用户没做任何操作就退出了输入。焦点还在列表里的输入框上（正在编辑一条记录）时，
 * 这一轮先不换列表，等焦点离开后的下一次刷新再补——后台刷新（AI 归类、推荐重算、
 * 另一台设备写入）、滚动续读、点菜单外部收起菜单都不再把键盘顶下去。
 */
function noteListEditorFocused() {
  const active = document.activeElement;
  if (!active || typeof active.matches !== "function") return false;
  if (!active.matches("textarea, input")) return false;
  return !!active.closest("#notes-list-region");
}

/** 编辑期间被推迟的列表刷新：焦点离开（收起键盘 / 点别处）之后补一次。 */
let noteListRefreshPending = false;
function noteListFocusOut() {
  if (!noteListRefreshPending) return;
  // focusout 时 activeElement 可能还指着旧输入框：等这一轮事件走完再判断
  setTimeout(() => {
    if (!noteListRefreshPending || noteListEditorFocused()) return;
    if (ui.view !== "notes" || ui.notesManagement) { noteListRefreshPending = false; return; }
    noteRefreshList();
  }, 0);
}

/**
 * 数据变了（分类改名 / 移动 / 合并 / 排序，或别处推来的更新）后的局部刷新：
 * 分类目录开着就原地更新目录（改名中或拖动中不碰它），再刷新筛选栏标签、结果数和列表里的分类标签；
 * 目录没开就等同 noteRefreshList。
 */
function noteRefreshLive() {
  if (ui.notesManagement) { renderMain(); return; }
  const dir = document.getElementById("notes-category-directory");
  if (!dir) { noteRefreshList(); return; }
  { const st = noteCategoryBrowserState(); if (!st.editingId && !st.adding && !dir.classList.contains("dragging") && !dir.classList.contains("pressing")) noteRefreshCategoryDirectory(); }
  noteRefreshList({ keepDirectory: true });
}

/** 已经为哪条记录试过按 id 读大类：同一次定位只补切一次。 */
const noteFocusKindTried = new Set();

/** 从会话提示「查看」跳过来时，定位并短暂高亮那条记录（列表可能还在分页，逐页找到为目标）。 */
function noteFocusPending() {
  const id = ui.notesFocusNote;
  if (!id) return;
  requestAnimationFrame(() => {
    if (ui.notesFocusNote !== id) return;
    const entry = document.querySelector(`.note-entry[data-note-id="${CSS.escape(id)}"]`);
    if (!entry) {
      // 新筛选的第一页还在路上：等它回来后再继续找，不要现在放弃定位。
      if (ui.pageLoading) return;
      // 目标可能在更早的页：继续续读；没有更多了才放弃，避免永久卡在定位中。
      if (ui.notesHasMore && !ui.notesCalendarRecord && !ui.notesLoadingMore) { void noteLoadMore(); return; }
      if (ui.notesLoadingMore) return;
      // 本地完全不知道这条（从会话 / 日历 / 外部跳进来）：按 id 读一次，切到它自己的大类（只试一次）。
      // 本地已经有它、只是被当前大类过滤掉的（例如 AI 刚把它改判为日程），不替用户切 tab。
      const known = (Array.isArray(ui.notes) && ui.notes.some((n) => n.id === id)) || ui.notesLastCreatedNote?.id === id;
      if (!known && !noteFocusKindTried.has(id)) { noteFocusKindTried.add(id); void noteSwitchKindOfFocused(id); return; }
      ui.notesFocusNote = null;
      return;
    }
    noteFocusKindTried.delete(id);
    ui.notesFocusNote = null;
    entry.scrollIntoView({ block: "center" });
    entry.classList.add("note-focus");
    setTimeout(() => entry.classList.remove("note-focus"), 2000);
  });
}

/**
 * 定位目标在本地完全没有时：读一次这条记录，切到它自己的大类。
 * 用户期间自己切了大类就不再插手（noteKindManualEpoch 变了）。
 */
async function noteSwitchKindOfFocused(id) {
  const epoch = noteKindManualEpoch;
  let note;
  try { note = await api(`/api/notes/${encodeURIComponent(id)}`, noteReadOptions()); } catch { return; }
  if (epoch !== noteKindManualEpoch || ui.view !== "notes" || ui.notesManagement || ui.notesFocusNote !== id) return;
  const kind = noteDisplayKind(note);
  if (kind === "event") { ui.notesCalendarRecord = id; ui.notesCalendarRecordNote = note; }
  if (noteKindFilter() === kind) { noteRefreshList(); return; }
  noteSetKindFilter(kind, { automatic: true });
  if (kind === "event") { ui.notesCalendarRecord = id; noteRefreshList(); }
}

/** 正文折叠：超过 CSS 里的最大高度就收起，点卡片正文 / 「展开全文」切换；展开状态按记录 id 记住。 */
// PC 正文先等待双击判定；触屏与显式展开按钮仍立即响应。
const NOTE_SINGLE_CLICK_MS = 400;
const notePendingExpand = new Map();
function noteCancelPendingExpand(id) {
  const timer = notePendingExpand.get(id);
  if (timer !== undefined) clearTimeout(timer);
  notePendingExpand.delete(id);
}
function noteExpandedSet() {
  if (!(ui.notesExpanded instanceof Set)) ui.notesExpanded = new Set();
  return ui.notesExpanded;
}
function noteEntryExpanded(id) { return noteExpandedSet().has(id); }
function noteCollapseMaxHeight() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--note-collapse-max");
  return parseFloat(raw) || 168;
}
function noteEntryToggle(entry) {
  if (!entry || !entry.classList.contains("note-collapsible")) return;
  const id = entry.dataset.noteId;
  if (!id) return;
  noteCancelPendingExpand(id);
  const expanded = !entry.classList.contains("is-expanded");
  if (expanded) noteExpandedSet().add(id);
  else noteExpandedSet().delete(id);
  entry.classList.toggle("is-expanded", expanded);
  const toggle = entry.querySelector(".note-expand-toggle");
  if (toggle) {
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    toggle.textContent = expanded ? "收起" : "展开全文";
  }
}

/** 列表插入 DOM 后量一次正文高度：只有真的超过最大高度才显示展开入口。 */
function noteSyncCollapse(root = document) {
  const max = noteCollapseMaxHeight();
  for (const entry of root.querySelectorAll(".note-entry[data-note-id]")) {
    const body = entry.querySelector(".note-body");
    if (!body) continue;
    const id = entry.dataset.noteId;
    const expanded = noteEntryExpanded(id);
    // scrollHeight 是内容完整高度，不受 max-height 裁剪影响；展开和收起都能量。
    const overflow = body.scrollHeight > max + 1;
    entry.classList.toggle("note-collapsible", overflow);
    entry.classList.toggle("is-expanded", overflow && expanded);
    const toggle = entry.querySelector(".note-expand-toggle");
    if (toggle) {
      toggle.hidden = !overflow;
      toggle.setAttribute("aria-expanded", overflow && expanded ? "true" : "false");
      toggle.textContent = overflow && expanded ? "收起" : "展开全文";
    }
  }
}
function noteCollapseLater() {
  requestAnimationFrame(() => { if (ui.view === "notes") noteSyncCollapse(); });
}

async function noteWritingAct(note, action) {
  if (ui.notesBusy) return false;
  if (ui.notesEdit?.id === note.id) { ui.notesError = "请先保存或取消正在编辑的正文"; return false; }
  const epoch = noteOperationEpoch;
  ui.notesBusy = note.id; ui.notesError = "";
  noteRefreshList();
  try {
    const updated = await api(`/api/notes/${encodeURIComponent(note.id)}`, { method: "PATCH", body: JSON.stringify({ writingAction: action, expectedText: note.text, ...(note.writing?.state === "ready" ? { writingId: note.writing.id } : {}) }) });
    if (epoch !== noteOperationEpoch) return false;
    noteReplaceLocal(updated);
    noteCalendarInvalidate();
    invalidateReads((key) => key === "/api/notes" || key.startsWith("/api/notes?"));
    return true;
  } catch (e) {
    if (epoch === noteOperationEpoch) ui.notesError = e.message;
    return false;
  } finally {
    if (epoch === noteOperationEpoch) { ui.notesBusy = ""; if (ui.view === "notes") noteRefreshList(); }
  }
}

function noteWritingPreview(note) {
  const result = note.writing;
  if (result?.state !== "ready") return;
  const error = h("p", { class: "error", role: "alert", hidden: true });
  const close = () => dialog.close();
  const action = (label, key) => h("button", { type: "button", class: "btn small", onclick: async () => {
    const buttons = dialog.querySelectorAll("button");
    for (const button of buttons) button.disabled = true;
    const ok = await noteWritingAct(note, key);
    if (ok) close();
    else { error.textContent = ui.notesError || "操作未完成，请重试"; error.hidden = false; }
    for (const button of buttons) button.disabled = false;
  } }, label);
  const advice = !!(result.refinedText || result.suggestion);
  const section = (label, text) => h("section", {}, h("h3", {}, label), h("p", {}, text));
  const dialog = h("dialog", { class: "notes-writing-dialog", "aria-label": "AI 整理结果", onclose: () => dialog.remove() },
    h("h2", {}, "AI 整理结果"),
    h("p", { class: "muted small" }, "基础格式化已应用；精炼和补充建议由你决定。"),
    section("原文", result.originalText), section("当前正文", result.formattedText),
    result.refinedText ? section("精炼表达", result.refinedText) : null,
    result.suggestion ? section("补充建议", result.suggestion) : null,
    error,
    h("div", { class: "notes-writing-actions" },
      advice ? action("替换正文", "replace") : null,
      advice ? action("追加到末尾", "append") : null,
      advice ? action("忽略建议", "ignore") : null,
      result.originalText !== result.formattedText ? action("恢复原文", "restore") : null,
      h("button", { type: "button", class: "btn small", onclick: close }, "关闭")));
  document.body.append(dialog);
  dialog.showModal();
}

function noteWritingControl(note, busy) {
  if (!note.text || noteDisplayKind(note) === "event") return null;
  if (note.writing?.state === "pending") return h("button", { type: "button", role: "menuitem", class: "btn small", disabled: true, "aria-busy": "true" }, "AI 整理中…");
  if (note.writing?.state === "ready") return h("button", { type: "button", role: "menuitem", class: "btn small", disabled: busy, onclick: () => noteWritingPreview(note) }, "AI 整理结果");
  return h("button", { type: "button", role: "menuitem", class: "btn small", disabled: busy, onclick: () => void noteWritingAct(note, "retry") }, note.writing?.state === "failed" ? "重试 AI 整理" : "AI 整理");
}

function noteEntry(note) {
  // 刷新 / 编辑会替换卡片，旧 DOM 的延迟动作不应再修改记录状态。
  noteCancelPendingExpand(note.id);
  const busy = ui.notesBusy === note.id;
  const images = note.images || [];
  if (ui.notesEdit && ui.notesEdit.id === note.id) {
    const edit = ui.notesEdit;
    const items = edit.images || [];
    const uploading = noteDraftBusy(items);
    const failed = noteDraftFailed(items);
    const canSave = !busy && !uploading && !failed && (!!(ui.notesEdit.text || "").trim() || items.some((i) => i.state === "ready"));
    const { picker, remove } = noteEditImages(items);
    const area = h("textarea", {
      class: "notes-edit", "data-key": `note-edit-${note.id}`, rows: "4", value: ui.notesEdit.text,
      "aria-label": "编辑这条记录",
      oninput: (e) => { ui.notesEdit.text = e.target.value; },
      onpaste: (e) => notePaste(items, e),
      ondrop: (e) => noteDropImage(items, e),
      ondragover: (e) => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); },
      onkeydown: (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void noteSaveEdit(note.id); }
        if (e.key === "Escape") { e.preventDefault(); ui.notesEdit = null; renderMain(); }
      }
    });
    if (ui.notesEditFocus === note.id) {
      ui.notesEditFocus = null;
      requestAnimationFrame(() => {
        if (!area.isConnected) return;
        area.focus();
        const end = area.value.length;
        try { area.setSelectionRange(end, end); } catch { /* 合成事件里没有选区 */ }
      });
    }
    return h("li", { class: "note-entry editing" }, area,
      picker.input,
      noteImageDraftStrip(items, busy, remove),
      noteCategoryEditor(note, busy),
      h("div", { class: "note-actions" },
        picker.button,
        h("button", { class: "btn small primary", type: "button", disabled: !canSave, onclick: () => void noteSaveEdit(note.id) }, busy ? "保存中…" : "保存"),
        h("button", { class: "btn small", type: "button", disabled: busy, onclick: () => { ui.notesEdit = null; renderMain(); } }, "取消")));
  }
  const kind = noteDisplayKind(note);
  // 笔记是想法记录，没有完成状态；日程没有完成概念，只看有没有过当前时间。
  const done = kind === "todo" && !!note.done;
  const expired = kind === "event" && noteScheduleExpired(note);
  const remaining = noteDoneRemaining(note.id);
  const moreOpen = ui.notesMore === note.id;
  const expanded = noteEntryExpanded(note.id);
  const pinPending = notePinPendingState(note.id);
  const pinPendingBusy = pinPending === "pinning" || pinPending === "unpinning";
  const li = h("li", { "data-kind": kind, class: `note-entry kind-${kind}${done ? " done" : ""}${note.pinned ? " pinned" : ""}${moreOpen ? " more-open" : ""}${expanded ? " is-expanded" : ""}`, "data-note-id": note.id, ...(note.pinned ? { "data-pinned": "true" } : {}) });
  // 「更多」菜单：标记完成 / 取消完成，以及删除；操作区不再平铺一排按钮
  const more = h("div", { class: "note-more" },
    h("button", { type: "button", class: "btn small", disabled: busy, "aria-haspopup": "menu", "aria-expanded": moreOpen ? "true" : "false", "aria-label": "更多操作", title: "更多操作", onclick: () => { ui.notesMore = moreOpen ? null : note.id; noteRefreshList(); } }, "更多"),
    moreOpen ? h("div", { class: "note-more-menu", role: "menu" },
      noteWritingControl(note, busy),
      kind !== "note" ? null : h("button", { type: "button", role: "menuitem", class: "btn small", disabled: busy, onclick: () => void noteChangeKind(note, { kind: "todo" }) }, "改为待办"),
      kind === "note" ? null : h("button", { type: "button", role: "menuitem", class: "btn small", disabled: busy, onclick: () => void noteChangeKind(note, { kind: "note" }) }, "改为笔记"),
      kind === "event" ? h("button", { type: "button", role: "menuitem", class: "btn small", disabled: busy, onclick: () => void noteChangeKind(note, { kind: "todo" }) }, "改为待办（去掉时间）") : null,
      noteChildRelationMenu(note, busy),
      h("button", { type: "button", role: "menuitem", class: "btn small", disabled: busy || !!note.kindPending, title: "让 AI 重新判断是笔记、待办还是日程", onclick: () => void noteChangeKind(note, { reclassifyKind: true }) }, "AI 重新判断类型"),
      kind === "todo" ? h("button", { type: "button", role: "menuitem", class: "btn small", disabled: busy, "aria-label": done ? "取消完成" : "标记完成", title: done ? (remaining != null ? `取消完成（${remaining} 秒后移出未完成）` : "取消完成") : "标记完成", onclick: () => noteToggleDone(note) }, done ? (remaining != null ? `取消完成 ${remaining}s` : "取消完成") : "标记完成") : null,
      // PC / 手机都从「更多」提供显式入口；手机也可以长按卡片。
      h("button", {
        type: "button", role: "menuitem", class: "btn small", disabled: busy || pinPendingBusy,
        "data-key": `note-pin-menu-${note.id}`, "aria-busy": pinPendingBusy ? "true" : null,
        "aria-label": pinPendingBusy ? (pinPending === "pinning" ? "置顶中" : "取消置顶中") : note.pinned ? "取消置顶" : "置顶",
        title: pinPendingBusy ? "正在刷新置顶状态…" : note.pinned ? "取消置顶（不再排在今日推荐最前面）" : "置顶（排在今日推荐最前面）",
        onclick: () => void noteTogglePin(note)
      }, pinPendingBusy ? (pinPending === "pinning" ? "置顶中" : "取消置顶中") : note.pinned ? "取消置顶" : "置顶"),
      h("button", { type: "button", role: "menuitem", class: "btn small danger", disabled: busy, "aria-label": "删除这条待办", onclick: () => void noteRemove(note.id) }, busy ? "删除中…" : "删除")) : null);
  const dblClick = noteDoubleClickEditEnabled();
  // 置顶后的钉子放在卡片左上角、第一行文字前面：点它直接取消置顶；取消过程中保持转动直到所有刷新完成。
  const unpinning = note.pinned && pinPending === "unpinning";
  const pinAction = note.pinned ? h("button", {
    type: "button", class: `note-pin-action${unpinning ? " is-busy" : ""}`, disabled: busy || unpinning,
    "data-key": `note-pin-action-${note.id}`, "aria-label": unpinning ? "取消置顶中" : "取消置顶", title: unpinning ? "正在取消置顶…" : "取消置顶",
    "aria-busy": unpinning ? "true" : null,
    onclick: () => void noteTogglePin(note)
  }, notePinIcon("note-pin-action-icon"), h("span", { class: "sr-only" }, unpinning ? "取消置顶中" : "取消置顶")) : null;
  // 折叠只作用于正文（文字 / 搜索命中 / 图片）：分类、会话标签、日程、诊断状态和完成信息放在 .note-meta 里，始终可见。
  const body = h("div", {
    class: "note-body",
    onclick: (ev) => {
      if (dblClick && ev.detail > 1) { noteCancelPendingExpand(note.id); return; }
      // 长按置顶松手时浏览器还会补一次 click：别让它顺手折叠正文。
      if (Date.now() - (ui.noteLongPressAt || 0) < 800) return;
      if (!li.classList.contains("note-collapsible")) return;
      if (!(ev.target instanceof Element)) return;
      // 卡片里的按钮 / 链接 / 图片有自己的操作；选中的文字也不该因为松手就折叠。
      if (ev.target.closest("button, a, input, textarea, select, summary, img, .note-image, .rt-attachment-card")) return;
      try { const selection = window.getSelection(); if (selection && !selection.isCollapsed && selection.toString().trim()) return; } catch { /* 没有 Selection API 就照常折叠 */ }
      noteCancelPendingExpand(note.id);
      if (!dblClick) { noteEntryToggle(li); return; }
      notePendingExpand.set(note.id, setTimeout(() => {
        notePendingExpand.delete(note.id);
        // 切页、后台重绘或进入编辑后，丢弃旧卡片上的单击。
        if (!li.isConnected || ui.view !== "notes" || ui.notesEdit) return;
        noteEntryToggle(li);
      }, NOTE_SINGLE_CLICK_MS));
    }
  },
    note.text
      ? h("p", { class: "note-text", title: dblClick ? "双击编辑这条记录" : null }, pinAction, noteSearchQuery() ? noteHighlight(note.text) : note.text)
      : pinAction,
    noteSearchOtherHits(note),
    noteImageStrip(images));
  const meta = h("div", { class: "note-meta" },
    note.schedule ? h("button", {
      type: "button", class: "note-schedule-badge",
      title: "在日历中查看这条日程", "aria-label": `在日历中查看日程：${noteScheduleLabel(note.schedule)}`,
      onclick: () => noteOpenNoteInCalendar(note)
    }, "日程 · " + noteScheduleLabel(note.schedule)) : null,
    noteCategoryBadge(note),
    noteSessionLinks(note.sessions, noteRelationBadge(note)),
    noteDiagnosticLine(note),
    done
      ? h("span", { class: "note-done muted small" }, note.doneAt ? `已完成 · ${noteStamp(note.doneAt)}` : "已完成")
      : expired ? h("span", { class: "note-done muted small" }, "已过期")
      : note.updatedAt ? h("span", { class: "muted small" }, `已编辑 · ${noteStamp(note.updatedAt)}`) : null);
  const toggle = h("button", {
    type: "button", class: "note-expand-toggle", hidden: true,
    "aria-expanded": expanded ? "true" : "false",
    onclick: (ev) => { ev.stopPropagation(); noteEntryToggle(li); }
  }, expanded ? "收起" : "展开全文");
  const row = h("div", { class: "note-entry-row" },
    h("div", { class: "note-main" }, body, toggle, meta),
    h("div", { class: "note-actions" },
      noteKindPendingBadge(note),
      h("time", { class: "note-time", datetime: note.createdAt, title: noteStamp(note.createdAt) }, noteClock(note.createdAt)),
      h("button", { class: "btn small", type: "button", disabled: busy, "aria-label": "用这条记录发起对话", title: "把这条记录引用到新建会话", onclick: () => noteStartConversation(note) }, "发起对话"),
      h("button", { class: "btn small", type: "button", disabled: busy, "aria-label": "编辑这条记录", title: dblClick ? "也可以直接双击这条记录" : null, onclick: () => noteBeginEdit(note, false) }, "编辑"),
      more));
  li.append(row);
  noteEntryDoubleClick(note, row);
  noteEntryLongPress(note, row);
  return li;
}


/* ------------------------------ 平台日历 ------------------------------ */
// 平台日历由两部分组成：本地待办按开始/结束时间派生出的日程，以及只读拉取的 Google 日历事件。
// 本地日程不单独存事件，改待办即改日程；Google 侧只读，不回写。

const NOTE_CALENDAR_WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

/** 北京时间「今天」的日期容器（本地字段就是北京年月日，方便月历做日期加减）。 */
function noteCalendarTodayDate() {
  const p = noteBeijingParts(new Date());
  return new Date(p.year, p.month - 1, p.day);
}

/** 日期容器的键：用本地字段读，不受绝对时刻换算影响。 */
function noteWallDateKey(value) {
  if (!value) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function noteMonthKey(date) {
  const d = date || noteCalendarTodayDate();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function noteMonthDate(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(key || "");
  const now = noteCalendarTodayDate();
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, 1) : new Date(now.getFullYear(), now.getMonth(), 1);
}

function noteMonthLabel(date) {
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`;
}

function noteCalendarWeekStart(date) {
  const d = new Date(date);
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** 从周一开始，只补齐含当月日期的首尾周；end 为末周之后的周一。 */
function noteCalendarRange(monthDate) {
  const start = noteCalendarWeekStart(new Date(monthDate.getFullYear(), monthDate.getMonth(), 1));
  const last = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
  const end = noteCalendarWeekStart(last); end.setDate(end.getDate() + 7);
  return { start, end };
}

function noteCalendarState() {
  if (!ui.notesCalendar) {
    ui.notesCalendar = {
      month: noteMonthKey(), data: null, status: null, calendars: null, calendarsError: "",
      loading: false, error: "", settingsOpen: false, notice: "", busy: "",
      // 默认显示本地与外部日历，Agent 可在来源筛选中显式开启。
      scope: "human", view: "week", dateFilter: "", anchorToday: true,
      sheetOpen: false, hiddenSources: [], pickerOpen: false, pickerYear: 0,
      clientIdDraft: "", clientSecretDraft: "", calendarIdsDraft: "", sharedUrlsDraft: "", token: 0,
      agentTasks: 0, agentWarnings: []
    };
  } else if (ui.notesCalendar.anchorToday === undefined) ui.notesCalendar.anchorToday = true;
  return ui.notesCalendar;
}

function noteCalendarDate(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split("-").map(Number);
    const out = new Date(y, m - 1, d); out.setHours(0, 0, 0, 0); return out;
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/** 绝对时刻 → 北京日期键；日期字符串原样返回。 */
function noteDateKey(value) {
  if (!value) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return noteBeijingDateKey(value);
}

/** 北京时间零点对应的绝对时刻；月历的日期容器用本地字段表示北京日期。 */
function noteCalendarBoundIso(d) {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - NOTE_BEIJING_OFFSET_MS).toISOString();
}

function noteClockDate(d) {
  const p = noteBeijingParts(d);
  return p ? `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}` : "";
}

/** 日期键（YYYY-MM-DD）加 n 天。 */
function noteDateKeyShift(key, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + days)).toISOString().slice(0, 10) : "";
}

/**
 * 带时刻的事件是否跨了北京日期：返回第一天和最后一天的日期键，同一天（或没有结束）返回 null。
 * 结束时刻是区间的开区间端点，所以正好落在零点的结束不算进那一天（22:00–次日 00:00 仍是一天）。
 */
function noteCalendarTimedSpan(event) {
  if (!event || event.allDay) return null;
  const s = noteCalendarDate(event.start), e = noteCalendarDate(event.end);
  if (!s || !e || e.getTime() <= s.getTime()) return null;
  const first = noteBeijingDateKey(s);
  // 最多算 62 天，防止异常数据把整个月历铺满
  const last = [noteBeijingDateKey(new Date(e.getTime() - 1)), noteDateKeyShift(first, 61)].sort()[0];
  return first && last > first ? { first, last } : null;
}

/** 北京日期键对应的当天零点（绝对时刻，毫秒）。 */
function noteDayStartMs(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) - NOTE_BEIJING_OFFSET_MS : NaN;
}

/**
 * 事件在日历上的位置：占哪几天 {first, last}（含两端），以及第一天里从几点开始 x0、最后一天里到几点结束 x1。
 * x0 / x1 是当天的比例：0 = 当天 00:00（格子最左），1 = 当天 24:00（格子最右）。
 * - 全天事件（end 是开区间）：整天，x0 = 0、x1 = 1；
 * - 带时刻：第一天从开始时刻起、最后一天到结束时刻止，结束正好在零点算前一天的 24:00；没有结束时间按 1 小时；
 * - 无效返回 null。
 */
function noteCalendarEventRange(event) {
  if (!event) return null;
  if (event.allDay) {
    const first = noteWallDateKey(event.start);
    if (!first) return null;
    const endKey = event.end ? noteWallDateKey(event.end) : "";
    const last = endKey ? noteDateKeyShift(endKey, -1) : first;
    return { first, last: last && last > first ? last : first, x0: 0, x1: 1 };
  }
  const s = noteCalendarDate(event.start);
  if (!s) return null;
  let e = noteCalendarDate(event.end);
  if (!e || e.getTime() <= s.getTime()) e = new Date(s.getTime() + 3600000);
  const first = noteBeijingDateKey(s);
  const span = noteCalendarTimedSpan({ start: s, end: e });
  const last = span ? span.last : first;
  const x0 = (s.getTime() - noteDayStartMs(first)) / 86400000;
  // 被 62 天上限截断的，最后一天画满；否则按结束时刻
  const x1 = span && span.last !== noteBeijingDateKey(new Date(e.getTime() - 1)) ? 1 : Math.min(1, (e.getTime() - noteDayStartMs(last)) / 86400000);
  // 单日事件的结束不会早于开始；跨天时 x1 是最后一天里的位置，和 x0 不在同一天，不能比
  return { first, last, x0, x1: first === last ? Math.max(x1, x0) : x1 };
}

/** 一行里最多画几条行道；再多的重叠事件退回到每天一个圆点。 */
const NOTE_CALENDAR_SPAN_LANES = 2;
/** 同一条行道里前后两个事件之间至少隔多少（占一天的比例，约 1.5 小时），免得首尾相碰看成一条。 */
const NOTE_CALENDAR_LANE_GAP = 0.06;

/**
 * 一周一行（月网格的每一行、周条）的时间轴排布。
 * 每个事件在这一行里是一段连续区间：横坐标 = 第几天 + 当天的比例（格子最左 = 当天开始，最右 = 当天结束）。
 * 按开始早、区间长的先排，放进第一条空得下的行道（同一天里时间不重叠的事件共用一条行道）；两条行道放不下的退回圆点。
 * keys 是这一行 7 天的日期键。返回 { lanes, barred }：
 *   lanes[行道][第几格] = 这一格里该行道的若干段 { event, kind, x0, x1, capLeft, capRight }（x0 / x1 是格内比例，capLeft / capRight 表示是不是整个事件的真正起点 / 终点，决定圆角还是接着前后一格）；
 *   barred = 已经画在行道里的事件。
 */
function noteCalendarSpanPlan(events, keys) {
  const rowFirst = keys[0], rowLast = keys[keys.length - 1];
  const items = [];
  for (const event of events) {
    const range = noteCalendarEventRange(event);
    if (!range || range.last < rowFirst || range.first > rowLast) continue;
    const a = range.first < rowFirst ? 0 : keys.indexOf(range.first);
    const b = range.last > rowLast ? keys.length - 1 : keys.indexOf(range.last);
    if (a < 0 || b < 0) continue;
    const start = range.first < rowFirst ? 0 : a + range.x0;
    const end = range.last > rowLast ? keys.length : b + range.x1;
    items.push({ event, range, a, b, start, end });
  }
  items.sort((x, y) => x.start - y.start || (y.end - y.start) - (x.end - x.start) || String(x.event.title).localeCompare(String(y.event.title)));
  const lanes = [], laneEnd = [], barred = new Set();
  for (const item of items) {
    let lane = -1;
    for (let i = 0; i < NOTE_CALENDAR_SPAN_LANES; i++) {
      if (laneEnd[i] === undefined || laneEnd[i] + NOTE_CALENDAR_LANE_GAP <= item.start) { lane = i; break; }
    }
    if (lane < 0) continue;
    laneEnd[lane] = Math.max(item.end, item.start);
    const row = lanes[lane] || (lanes[lane] = keys.map(() => []));
    for (let i = item.a; i <= item.b; i++) {
      // 第一格从开始时刻起、最后一格到结束时刻止；中间的格子整格。续接上一周 / 下一周的那一端平着接。
      const x0 = i === item.a && item.range.first === keys[i] ? item.range.x0 : 0;
      const x1 = i === item.b && item.range.last === keys[i] ? item.range.x1 : 1;
      row[i].push({ event: item.event, kind: noteCalendarSourceKind(item.event), x0, x1, capLeft: keys[i] === item.range.first, capRight: keys[i] === item.range.last });
    }
    barred.add(item.event);
  }
  for (let i = 0; i < lanes.length; i++) if (!lanes[i]) lanes[i] = keys.map(() => []);
  return { lanes, barred };
}

/**
 * 事件的时间文案。
 * - 全天 → 「全天」；带时刻 → 「22:00–06:00」；
 * - 跨天且不指定哪一天（详情、最近日程、无障碍标签）→ 「22:00–次日 06:00」，跨了不止一天写出日期「22:00–11 月 12 日 06:00」；
 * - 跨天且按某一天看（日历当天列表）→ 首日「22:00 起」、中间日「全天」、末日「至 06:00」。
 */
function noteCalendarEventTime(event, dayKey) {
  if (event.allDay) return "全天";
  const s = noteCalendarDate(event.start), e = noteCalendarDate(event.end);
  if (!s) return "";
  if (!e) return noteClockDate(s);
  const span = noteCalendarTimedSpan(event);
  if (!span) return `${noteClockDate(s)}–${noteClockDate(e)}`;
  if (dayKey) {
    if (dayKey === span.first) return `${noteClockDate(s)} 起`;
    // 结束正好在零点：最后一天从头到尾都在，写「全天」比「至 00:00」准确
    if (dayKey === span.last) return noteClockDate(e) === "00:00" ? "全天" : `至 ${noteClockDate(e)}`;
    return "全天";
  }
  const endKey = noteBeijingDateKey(e);
  const ep = noteBeijingParts(e);
  const endDay = endKey === noteDateKeyShift(noteBeijingDateKey(s), 1) ? "次日" : `${ep.month} 月 ${ep.day} 日`;
  return `${noteClockDate(s)}–${endDay} ${noteClockDate(e)}`;
}

function noteCalendarEventDateLabel(event) {
  const p = noteBeijingParts(event.start);
  if (!p) return "";
  return `${p.month} 月 ${p.day} 日 · 周${NOTE_WEEKDAY[p.weekday]}`;
}

function noteCalendarEventsByDay(events) {
  const map = new Map();
  const add = (key, event) => { if (!key) return; const list = map.get(key) || []; list.push(event); map.set(key, list); };
  for (const event of events) {
    if (event.allDay) {
      const start = noteCalendarDate(event.start);
      const endExclusive = noteCalendarDate(event.end);
      if (!start) continue;
      const end = endExclusive ? new Date(endExclusive) : new Date(start);
      if (endExclusive) end.setDate(end.getDate() - 1);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) add(noteWallDateKey(d), event);
    } else {
      // 带时刻的跨天事件经过的每一天都要出现（日历格子的圆点、当天列表），最多展开 62 天防止异常数据。
      const span = noteCalendarTimedSpan(event);
      if (span) {
        for (let key = span.first, i = 0; key && key <= span.last && i < 62; key = noteDateKeyShift(key, 1), i++) add(key, event);
      } else add(noteDateKey(event.start), event);
    }
  }
  for (const list of map.values()) list.sort((a, b) => String(a.start).localeCompare(String(b.start)) || a.title.localeCompare(b.title));
  return map;
}

function noteCalendarName(st, id, name) {
  const found = (st.calendars || []).find((c) => c.id === id);
  return name || found?.summary || id || "Google 日历";
}

/* 日历面板：宽屏是右侧常驻侧边栏，窄屏是从右侧滑入的日历视图。
   月历或收成一周，下面列出所选日期的日程，类似手机日历。
   顶部一行装下翻页、年月（点开跳月）、今天、收起 / 展开、返回待办；页脚右侧「更多」拉起底部浮层，
   里面放状态、刷新与日历来源设置；页脚来源可点，点了就隐藏 / 显示该来源的日程。 */
const NOTE_CALENDAR_MONTHS = ["1 月", "2 月", "3 月", "4 月", "5 月", "6 月", "7 月", "8 月", "9 月", "10 月", "11 月", "12 月"];

// 国务院年度放假调休通知；只使用已核实的日期，不推算其他年份的调休。
// 2026: https://www.beijing.gov.cn/fuwu/bmfw/sy/jrts/202511/t20251104_4258838.html
// 2027: https://www.news.cn/politics/20261105/f90cd6ad4df94ab4833b141e52ccfc13/c.html
const NOTE_CALENDAR_CN_HOLIDAYS = {
  2026: [
    ["元旦", "01-01", "01-03", ["01-04"]],
    ["春节", "02-15", "02-23", ["02-14", "02-28"]],
    ["清明节", "04-04", "04-06", []],
    ["劳动节", "05-01", "05-05", ["05-09"]],
    ["端午节", "06-19", "06-21", []],
    ["中秋节", "09-25", "09-27", []],
    ["国庆节", "10-01", "10-07", ["09-20", "10-10"]]
  ],
  2027: [
    ["元旦", "01-01", "01-03", []],
    ["春节", "02-05", "02-13", ["01-31", "02-14"]],
    ["清明节", "04-03", "04-05", []],
    ["劳动节", "05-01", "05-05", ["05-08"]],
    ["端午节", "06-09", "06-09", []],
    ["中秋节", "09-15", "09-15", []],
    ["国庆节", "10-01", "10-07", ["09-26", "10-09"]]
  ]
};

function noteCalendarDayInfo(key) {
  const date = noteCalendarDate(key);
  const weekend = !!date && [0, 6].includes(date.getDay());
  const md = key.slice(5);
  for (const [name, start, end, workdays] of NOTE_CALENDAR_CN_HOLIDAYS[key.slice(0, 4)] || []) {
    if (workdays.includes(md)) return { weekend, name, kind: "workday", label: `${name}调休补班` };
    if (md >= start && md <= end) return { weekend, name, kind: "holiday", label: `${name}假期，休息` };
  }
  return { weekend, name: "", kind: "", label: weekend ? "周末" : "" };
}

function noteCalendarDayMark(info) {
  return info.kind ? h("span", { class: `notes-calendar-day-mark ${info.kind}`, "aria-hidden": "true" }, info.kind === "holiday" ? "休" : "班") : null;
}

function noteCalendarView(st) { return st.view === "week" ? "week" : "month"; }

/** 当前选中的日期：必须落在已读取的月份里，否则回到本月的今天 / 该月 1 号。 */
function noteCalendarSelected(st) {
  const sel = noteCalendarDate(st.selected);
  if (sel && noteMonthKey(sel) === st.month) return sel;
  const now = noteCalendarTodayDate();
  return noteMonthKey(now) === st.month ? now : noteMonthDate(st.month);
}

/** 选日期：点格子（toggle）再点同一天取消筛选；翻页 / 回今天不切换，只把筛选带到新日期（没有筛选就不加）。
 *  回到没有筛选的状态时，日程列表重新定位到今天。 */
function noteCalendarSelect(date, { toggle = false, filter = true } = {}) {
  const st = noteCalendarState();
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  st.selected = noteWallDateKey(d);
  const next = !filter ? "" : toggle && st.dateFilter === st.selected ? "" : st.selected;
  if (!next) st.anchorToday = true;
  st.dateFilter = next; ui.notesCalendarRecord = null;
  st.sheetOpen = false; st.pickerOpen = false; st.settingsOpen = false;
  const month = noteMonthKey(d);
  // 换月先用滑动时已读好的相邻月份数据，避免圆点先消失再冒出来；随后照常重读。
  if (month !== st.month) { st.month = month; st.data = noteCalendarCachedData(st, month); void noteLoadCalendar(); }
  else noteReplaceCalendarPanel();
}

/** 面板上记着展开程度 --cal-p；重建面板内容时它还在，过渡不会被打断。 */
function noteCalendarProgress(view) { return view === "week" ? 0 : 1; }

function noteCalendarSetView(view) {
  const st = noteCalendarState();
  const next = view === "week" ? "week" : "month";
  if (noteCalendarView(st) === next) return;
  st.selected = noteWallDateKey(noteCalendarSelected(st));
  st.view = next;
  st.sheetOpen = false; st.pickerOpen = false; st.settingsOpen = false;
  // 整月撑得很高，不再跟着固顶（否则小屏上日程被挤出屏幕）：展开时先回到页面顶部看整月；收起一周后重新固顶并定位到今天。
  if (next === "month" && window.scrollY > 0) window.scrollTo(0, 0);
  if (next === "week" && !st.dateFilter) st.anchorToday = true;
  noteCalendarApplyProgress(noteCalendarProgress(next));
  noteReplaceCalendarPanel();
}

function noteCalendarApplyProgress(progress) {
  document.getElementById("notes-calendar-panel")?.style.setProperty("--cal-p", String(progress));
}

/** 翻一段（delta = ±1）之后会选中的日期：周视图走 7 天，月视图翻月并尽量保留「几号」。 */
function noteCalendarShiftDate(st, delta) {
  const sel = noteCalendarSelected(st);
  if (noteCalendarView(st) === "week") {
    const next = new Date(sel); next.setDate(sel.getDate() + delta * 7);
    return next;
  }
  const current = noteMonthDate(st.month);
  const target = new Date(current.getFullYear(), current.getMonth() + delta, 1);
  // 翻月时尽量保留「几号」；目标月是本月就回到今天，和手机日历一致。
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  const now = noteCalendarTodayDate();
  return noteMonthKey(target) === noteMonthKey(now)
    ? now
    : new Date(target.getFullYear(), target.getMonth(), Math.min(sel.getDate(), last));
}

function noteCalendarShift(delta) {
  const st = noteCalendarState();
  noteCalendarSelect(noteCalendarShiftDate(st, delta), { filter: !!st.dateFilter });
}

/** 回到今天并把今天选中为筛选条件。 */
function noteCalendarToday() { noteCalendarSelect(noteCalendarTodayDate()); }

/** 「今天」只在选中了别的日期、或翻到了不含今天的月 / 周时出现；选中今天或已在今天所在的一段就不需要。 */
function noteCalendarTodayVisible(st) {
  const today = noteWallDateKey(noteCalendarTodayDate());
  if (st.dateFilter) return st.dateFilter !== today;
  const sel = noteCalendarSelected(st);
  if (noteCalendarView(st) === "week") return noteWallDateKey(noteCalendarWeekStart(sel)) !== noteWallDateKey(noteCalendarWeekStart(noteCalendarTodayDate()));
  return st.month !== noteMonthKey(noteCalendarTodayDate());
}

/** 点年月：跳到该年该月；本月就选中今天，其他月选中 1 号。 */
function noteCalendarPickMonth(st, index) {
  const year = st.pickerYear || noteMonthDate(st.month).getFullYear();
  const target = new Date(year, index, 1);
  const now = noteCalendarTodayDate();
  st.month = noteMonthKey(target);
  st.selected = noteWallDateKey(noteMonthKey(target) === noteMonthKey(now) ? now : target);
  st.dateFilter = ""; st.anchorToday = true;
  st.data = null;
  st.pickerOpen = false;
  void noteLoadCalendar();
}

function noteCalendarPeriodLabel(st) {
  const sel = noteCalendarSelected(st);
  if (noteCalendarView(st) === "week") {
    const start = noteCalendarWeekStart(sel), end = new Date(start); end.setDate(start.getDate() + 6);
    return `${start.getMonth() + 1} 月 ${start.getDate()} 日 – ${end.getMonth() + 1} 月 ${end.getDate()} 日`;
  }
  return noteMonthLabel(noteMonthDate(st.month));
}

/** 顶部与页脚使用的小图标：翻页、年月下拉、更多展开 / 收起、关闭；展开 / 收起用同一个向下箭头旋转表达。 */
function noteCalendarGlyph(kind) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const [k, v] of Object.entries({ fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round" })) svg.setAttribute(k, v);
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", kind === "prev" ? "M10 3.5 5.5 8l4.5 4.5" : kind === "next" ? "M6 3.5 10.5 8 6 12.5" : kind === "close" ? "M4.5 4.5l7 7m0-7-7 7" : kind === "caret-up" ? "M3.5 10 8 5.5 12.5 10" : "M3.5 6 8 10.5 12.5 6");
  svg.append(path);
  return svg;
}

function noteCalendarCell(st, d, byDay, selected, monthDate, plan, column, hiddenRow = false) {
  const key = noteWallDateKey(d);
  const info = noteCalendarDayInfo(key);
  const dayEvents = byDay.get(key) || [];
  const isToday = key === noteDateKey(new Date());
  const outside = !!monthDate && d.getMonth() !== monthDate.getMonth();
  const isSelected = noteCalendarInlineOpen() ? key === st.dateFilter : key === noteWallDateKey(selected);
  // 格子下面是这一天的 24 小时时间轴：最左 = 当天 00:00，最右 = 当天 24:00，事件按开始时刻和时长画成一小段；
  // 跨天事件在相邻格子里首尾相接。两条行道放不下的重叠事件退回成圆点，按来源着色。
  const lanes = plan ? plan.lanes : [];
  const live = lanes.some((lane) => lane[column].length);
  const overflow = [...new Set(dayEvents.filter((event) => !(plan && plan.barred.has(event))).map((event) => noteCalendarSourceKind(event)))];
  // 日期下面一行：假期名称优先，其余日子显示农历（初一显示月名）。
  const lunar = noteLunarCellText(key);
  const lunarFull = noteLunarFullText(key);
  return h("button", {
    type: "button", role: "gridcell", "data-date": key, "aria-selected": String(isSelected), ...(hiddenRow ? { tabindex: "-1", "aria-hidden": "true" } : {}),
    class: `notes-calendar-day${info.weekend ? " weekend" : ""}${info.kind ? ` ${info.kind}` : ""}${outside ? " outside" : ""}${isToday ? " today" : ""}${isSelected ? " selected" : ""}`,
    "aria-label": `${d.getMonth() + 1} 月 ${d.getDate()} 日${info.label ? `，${info.label}` : ""}${lunarFull ? `，农历${lunarFull}` : ""}${dayEvents.length ? `，${dayEvents.length} 个日程` : ""}`,
    onclick: () => noteCalendarSelect(d, { toggle: true })
  },
    h("span", { class: "notes-calendar-day-num" }, String(d.getDate())),
    noteCalendarDayMark(info),
    h("span", { class: `notes-calendar-holiday-name${info.kind === "holiday" ? "" : ` lunar${lunar.month ? " lunar-month" : ""}`}`, "aria-hidden": "true" }, info.kind === "holiday" ? info.name : lunar.text),
    lanes.length ? h("span", { class: `notes-calendar-spans${live ? " live" : ""}`, "aria-hidden": "true" }, lanes.map((lane) =>
      h("span", { class: "notes-calendar-lane" }, lane[column].map((seg) => {
        const inset = (seg.capLeft ? 1 : 0) + (seg.capRight ? 1 : 0);
        const el = h("i", { class: `notes-calendar-span ${seg.kind}${seg.capLeft ? " first" : ""}${seg.capRight ? " last" : ""}` });
        // 位置与宽度必须走 CSSOM（el.style.x = …）：线上 CSP 是 style-src 'self'，setAttribute("style", …) 的内联样式会被浏览器直接忽略。
        el.style.left = `min(calc(${(seg.x0 * 100).toFixed(3)}% + ${seg.capLeft ? 1 : 0}px), calc(100% - 4px))`;
        el.style.width = `calc(${((seg.x1 - seg.x0) * 100).toFixed(3)}% - ${inset}px)`;
        return el;
      })))) : null,
    overflow.length ? h("span", { class: "notes-calendar-dots", "aria-hidden": "true" }, overflow.map((kind) => h("i", { class: `notes-calendar-dot ${kind}` }))) : null);
}

/** 日期网格始终画出当月全部周；收起成一周只是把裁切框缩到一行、把选中周移进来。
 *  展开程度由面板上的 --cal-p（0 = 一周，1 = 整月）一个变量驱动：高度、位移、箭头旋转同步过渡，下拉 / 上滑也直接改它。 */
function noteCalendarGrid(st, events, selected) {
  const byDay = noteCalendarEventsByDay(events);
  const view = noteCalendarView(st);
  const monthDate = noteMonthDate(st.month);
  const range = noteCalendarRange(monthDate);
  const weekStartKey = noteWallDateKey(noteCalendarWeekStart(selected));
  const rows = [];
  let weekRow = 0;
  for (const d = new Date(range.start); d < range.end; d.setDate(d.getDate() + 7)) {
    const week = Array.from({ length: 7 }, (_, i) => { const day = new Date(d); day.setDate(d.getDate() + i); return day; });
    const plan = noteCalendarSpanPlan(events, week.map(noteWallDateKey));
    if (noteWallDateKey(week[0]) === weekStartKey) weekRow = rows.length;
    rows.push({ week, plan });
  }
  const cells = rows.flatMap((row, index) => row.week.map((day, column) => noteCalendarCell(st, day, byDay, selected, monthDate, row.plan, column, view === "week" && index !== weekRow)));
  const body = h("div", { class: "notes-calendar-rows", role: "rowgroup" }, ...cells);
  body.style.setProperty("--cal-week-row", String(weekRow));
  const grid = h("div", { class: `notes-calendar-grid ${view}`, role: "grid", "aria-label": `${noteCalendarPeriodLabel(st)}日历` },
    h("div", { class: "notes-calendar-weekdays", role: "row" },
      NOTE_CALENDAR_WEEKDAYS.map((label, index) => h("div", { class: `notes-calendar-weekday${index >= 5 ? " weekend" : ""}`, role: "columnheader" }, label))),
    h("div", { class: "notes-calendar-body" }, body));
  grid.style.setProperty("--cal-rows", String(rows.length));
  return grid;
}

/** 日程行：标题占满整行（最多两行），时间与来源降为第二行小字，来源用左侧色条表达。 */
function noteCalendarSourceKind(event) {
  return event.source === "pi" ? "local" : event.source === "agent" ? "agent" : "google";
}

function noteCalendarSourceLabelFor(st, event) {
  if (event.source === "pi") return "本地";
  if (event.source === "agent") return "Agent";
  return noteCalendarName(st, event.calendarId, event.calendarName);
}

/** 日程结束后弱化显示；全天日程按北京时间的结束边界判断。 */
function noteCalendarEventDone(event, range = noteCalendarEventRange(event)) {
  if (event.done) return true;
  if (!range) return false;
  if (event.allDay) return noteDayStartMs(noteDateKeyShift(range.last, 1)) <= Date.now();
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  const effectiveEnd = Number.isFinite(end) && end > start ? end : start + 3600000;
  return effectiveEnd <= Date.now();
}

function noteCalendarAgendaItem(st, event, dayKey) {
  const kind = noteCalendarSourceKind(event);
  const time = noteCalendarEventTime(event, dayKey);
  return h("button", {
    type: "button", class: `notes-calendar-agenda-item ${kind}${event.done ? " done" : ""}${noteCalendarEventDone(event) ? " completed" : ""}`, "data-event-id": event.id, "data-note-id": event.noteId || "",
    "aria-label": `${event.title}，${time}，${noteCalendarSourceLabelFor(st, event)}`,
    onclick: () => event.source === "pi" ? noteOpenNoteById(event.noteId) : noteShowCalendarEvent(st, event)
  },
    h("span", { class: "notes-calendar-agenda-bar", "aria-hidden": "true" }),
    h("span", { class: "notes-calendar-agenda-main" },
      h("span", { class: "notes-calendar-agenda-title" }, event.title),
      h("span", { class: "notes-calendar-agenda-meta" },
        h("span", { class: "notes-calendar-agenda-time" }, time),
        h("span", { class: "notes-calendar-agenda-sep", "aria-hidden": "true" }, "·"),
        h("span", { class: "notes-calendar-agenda-source" }, noteCalendarSourceLabelFor(st, event)))));
}

/** 下方日程列表只列所选那一天；没有日程时给一句怎么让日程出现的提示。 */
function noteCalendarAgenda(st, events, selected) {
  const byDay = noteCalendarEventsByDay(events);
  const key = noteWallDateKey(selected);
  const list = byDay.get(key) || [];
  return h("section", { class: "notes-calendar-agenda", "aria-label": "当天日程" },
    h("div", { class: "notes-calendar-agenda-head" },
      h("h2", {}, `${selected.getMonth() + 1} 月 ${selected.getDate()} 日`),
      h("span", { class: "notes-calendar-agenda-weekday" }, `周${NOTE_WEEKDAY[selected.getDay()]}`),
      h("span", { class: "notes-calendar-agenda-count" }, `${list.length} 个日程`)),
    list.length
      ? h("div", { class: "notes-calendar-agenda-list" }, list.map((event) => noteCalendarAgendaItem(st, event, key)))
      : h("p", { class: "notes-calendar-agenda-empty" },
        noteCalendarReadScope(st) === "agent" ? "这一天没有 Agent 定时任务。" : "这一天没有日程。",
        noteCalendarReadScope(st) === "agent" ? h("span", {}, "平台定时任务都挂在 Agent 日历下，只读。") : h("span", {}, "在待办里写下带时间的事，会自动出现在这里。")));
}

/** 页脚只放得下短名字：地址 / 邮箱一类的日历 ID 统一显示成「Google 日历」。 */
function noteCalendarSourceLabel(st, id, name) {
  const label = noteCalendarName(st, id, name);
  return /^https?:\/\//.test(label) || label.includes("@") ? "Google 日历" : label;
}

/** 一条日程属于哪个可筛选来源：本地 / Agent / 每个 Google 日历各自一个 key。 */
function noteCalendarSourceKey(event) {
  if (event.source === "pi") return "local";
  if (event.source === "agent") return "agent";
  return `google:${event.calendarId || event.calendarName || ""}`;
}

/** 被点掉的来源（页脚点了就收起对应日程）：存 key + 名字，翻月后没有日程也能再点回来。 */
function noteCalendarHiddenSources(st) {
  return Array.isArray(st.hiddenSources) ? st.hiddenSources : [];
}

function noteCalendarSourceHidden(st, key) {
  if (noteCalendarHiddenSources(st).some((item) => item?.key === key)) return true;
  if ((st.shownSources || []).some((item) => item.key === key)) return false;
  const scope = noteCalendarScope(st);
  return key === "agent" ? scope === "human" : scope === "agent";
}

function noteCalendarToggleSource(source) {
  const st = noteCalendarState();
  const wasHidden = noteCalendarSourceHidden(st, source.key);
  st.hiddenSources = noteCalendarHiddenSources(st).filter((item) => item.key !== source.key);
  st.shownSources = (st.shownSources || []).filter((item) => item.key !== source.key);
  const defaultHidden = source.key === "agent" ? noteCalendarScope(st) === "human" : noteCalendarScope(st) === "agent";
  if (wasHidden && defaultHidden) st.shownSources.push({ ...source });
  if (!wasHidden && !defaultHidden) st.hiddenSources.push({ ...source });
  st.pickerOpen = false;
  // 开启另一个范围时补读数据；请求 token 防止旧范围响应覆盖外部切换。
  if (wasHidden) void noteLoadCalendar();
  else noteReplaceCalendarPanel();
}

/** 只留下没被点掉来源的日程；月历圆点与当天日程都按这个走。 */
function noteCalendarVisibleEvents(st, events) {
  return events.filter((event) => !noteCalendarSourceHidden(st, noteCalendarSourceKey(event)));
}

/** 从已读取的 Google 日程建立可独立筛选的来源入口。 */
function noteCalendarGoogleSources(st, events) {
  const ids = [...new Set(events.map((event) => event.calendarId || event.calendarName || ""))];
  return ids.map((id) => ({ key: `google:${id}`, name: noteCalendarSourceLabel(st, id, events.find((event) => (event.calendarId || event.calendarName || "") === id)?.calendarName), kind: "google" }));
}

/** 两类入口始终保留；Google 尚未重读时，保留同月已知入口供直接开启。 */
function noteCalendarSources(st, events) {
  const google = Array.isArray(st.data?.google)
    ? noteCalendarGoogleSources(st, events.filter((event) => event.source === "google"))
    : st.googleSources?.month === st.month ? st.googleSources.sources : [];
  const sources = [
    { key: "local", name: "本地", kind: "local" },
    ...google,
    { key: "agent", name: "Agent", kind: "agent" }
  ];
  for (const item of [...noteCalendarHiddenSources(st), ...(st.shownSources || [])]) {
    if (item?.key && !sources.some((source) => source.key === item.key)) sources.push(item);
  }
  return sources;
}

/** 外部上下文提供默认值，底部显式开启的来源可扩展读取范围。 */
function noteCalendarReadScope(st) {
  const human = noteCalendarScope(st) !== "agent" || (st.shownSources || []).some((item) => item.key !== "agent");
  const agent = !noteCalendarSourceHidden(st, "agent");
  return human ? (agent ? "all" : "human") : "agent";
}

function noteCalendarStatusParts(st) {
  const status = st.status || st.data?.googleStatus;
  const scope = noteCalendarReadScope(st);
  const agent = scope !== "human"
    ? [st.agentTasks ? `Agent 定时任务 ${st.agentTasks} 个` : "Agent 定时任务", ...(st.agentWarnings || [])].filter(Boolean)
    : [];
  if (!status) return [...agent, scope === "agent" ? "" : "正在读取 Google 日历状态…"].filter(Boolean);
  return [
    ...agent,
    ...(scope === "agent" ? [] : [
      status.sharedUrls?.length ? `分享日历 ${status.sharedUrls.length} 个` : "未添加分享日历",
      status.connected ? "私有日历已连接" : status.clientConfigured ? "私有日历未连接" : "",
      status.clientConfigured && status.calendarIds?.length ? `私有日历 ${status.calendarIds.length} 个` : "",
      status.lastSyncAt ? `上次同步 ${noteStamp(status.lastSyncAt)}` : ""
    ])
  ].filter(Boolean);
}

/** 页脚：来源（可点，点了隐藏 / 显示该来源的日程）+ 同步时间 + 右下角「更多」。 */
function noteCalendarFooter(st, events) {
  const status = st.status || st.data?.googleStatus;
  const sources = noteCalendarSources(st, events);
  // 页脚只写「同步于 时:分」，完整日期放在「更多」里的状态说明；Agent 日历不读 Google，写只读。
  const sync = noteCalendarReadScope(st) === "agent"
    ? "Agent 定时任务 · 只读"
    : status ? (status.lastSyncAt ? `同步于 ${noteStamp(status.lastSyncAt).slice(11)}` : "尚未同步") : "正在读取…";
  const sheetOpen = !!st.sheetOpen;
  return h("footer", { class: "notes-calendar-footer" },
    h("div", { class: "notes-calendar-sources", role: "group", "aria-label": "日历来源筛选" },
      sources.map((source) => {
        const hidden = noteCalendarSourceHidden(st, source.key);
        return h("button", {
          type: "button", class: `notes-calendar-source ${source.kind}${hidden ? " off" : ""}`,
          "data-key": "calendar-source-filter", "data-source": source.key,
          "aria-pressed": String(!hidden), title: hidden ? `显示${source.name}` : `隐藏${source.name}`,
          "aria-label": `${source.name}，${hidden ? "已隐藏" : "已显示"}，点击${hidden ? "显示" : "隐藏"}对应日程`,
          onclick: () => noteCalendarToggleSource(source)
        }, h("i", { "aria-hidden": "true" }), h("span", { class: "notes-calendar-source-name" }, source.name));
      })),
    h("span", { class: "notes-calendar-sync" }, sync),
    h("button", {
      type: "button", class: `notes-calendar-footer-link${sheetOpen ? " open" : ""}`, "data-key": "calendar-footer-toggle",
      "aria-label": sheetOpen ? "收起更多" : "展开更多", "aria-haspopup": "dialog", "aria-expanded": String(sheetOpen),
      onclick: () => { st.sheetOpen = !sheetOpen; st.pickerOpen = false; st.settingsOpen = false; noteReplaceCalendarPanel(); }
    }, "更多", noteCalendarGlyph(sheetOpen ? "caret-up" : "caret")));
}

/** 顶部一行：翻页 / 年月 / 今天 / 收起。手机日历视图靠左边缘右滑 / 系统返回退出，不再放「返回待办」按钮。 */
function noteCalendarTopbar(st) {
  const week = noteCalendarView(st) === "week";
  const showToday = noteCalendarTodayVisible(st);
  // 读取中：顶栏底边一条不占位的进度线 + 读屏文字，哪些来源还在读写在文字里。
  const reading = [st.localLoading ? "本地日程" : "", st.agentLoading ? "Agent 定时任务" : "", st.googleLoading ? "Google 日历" : ""].filter(Boolean);
  return h("header", { class: `notes-calendar-topbar${reading.length ? " loading" : ""}`, "aria-busy": String(reading.length > 0) },
    reading.length ? h("span", { class: "notes-calendar-progress", "data-key": "calendar-loading", role: "status", title: `正在读取${reading.join("、")}…` }, h("span", { class: "sr-only" }, `正在读取${reading.join("、")}…`)) : null,
    h("div", { class: "notes-calendar-nav" },
      h("button", { type: "button", class: "notes-calendar-icon", "data-key": "calendar-prev", "aria-label": week ? "上一周" : "上个月", onclick: () => noteCalendarShift(-1) }, noteCalendarGlyph("prev")),
      h("button", {
        type: "button", class: "notes-calendar-period", "data-key": "calendar-month", "aria-label": `${noteMonthLabel(noteMonthDate(st.month))}，选择月份`, "aria-haspopup": "dialog", "aria-expanded": String(!!st.pickerOpen),
        onclick: () => { st.pickerOpen = !st.pickerOpen; st.sheetOpen = false; st.settingsOpen = false; st.pickerYear = noteMonthDate(st.month).getFullYear(); noteReplaceCalendarPanel(); }
      }, h("span", { class: "notes-calendar-period-year" }, `${noteMonthDate(st.month).getFullYear()} 年 `), h("span", {}, `${noteMonthDate(st.month).getMonth() + 1} 月`), noteCalendarGlyph("caret")),
      h("button", { type: "button", class: "notes-calendar-icon", "data-key": "calendar-next", "aria-label": week ? "下一周" : "下个月", onclick: () => noteCalendarShift(1) }, noteCalendarGlyph("next"))),
    h("div", { class: "notes-calendar-tools" },
      // 「今天」按需出现，但位置始终占着（visibility），出现 / 消失不挤动旁边的图标。
      h("button", { type: "button", class: `notes-calendar-today${showToday ? "" : " is-idle"}`, "data-key": "calendar-today", tabindex: showToday ? null : "-1", "aria-hidden": showToday ? null : "true", onclick: noteCalendarToday }, "今天"),
      h("button", {
        type: "button", class: "notes-calendar-icon notes-calendar-toggle", "data-key": "calendar-toggle-week", "aria-label": week ? "展开月历" : "收起到本周",
        "aria-pressed": String(week), title: week ? "展开月历" : "收起到本周",
        onclick: () => noteCalendarSetView(week ? "month" : "week")
      }, noteCalendarGlyph("caret")),
      noteCalendarInlineOpen() ? h("button", { type: "button", class: "notes-calendar-icon", "data-key": "calendar-footer-toggle", "aria-label": "日历更多操作", "aria-haspopup": "dialog", "aria-expanded": String(!!st.sheetOpen),
        onclick: () => { st.sheetOpen = !st.sheetOpen; st.pickerOpen = false; noteReplaceCalendarPanel(); }
      }, "⋯") : null));
}

/** 页脚右下角「更多」：从顶栏三个点挪下来的状态、刷新与日历设置，浮在页脚上方。 */
function noteCalendarSheet(st) {
  return h("div", { class: "notes-calendar-overlay" },
    h("div", { class: "notes-calendar-overlay-backdrop", "aria-hidden": "true", onclick: () => { st.sheetOpen = false; noteReplaceCalendarPanel(); } }),
    h("div", { class: "notes-calendar-sheet", role: "dialog", "aria-label": "更多操作" },
      h("p", { class: "notes-calendar-menu-status notes-calendar-status", "data-key": "google-calendar-status", role: "status" }, noteCalendarStatusParts(st).join(" · ")),
      h("button", {
        type: "button", class: "notes-calendar-menu-item", "data-key": "calendar-refresh", disabled: st.loading,
        onclick: () => { st.sheetOpen = false; if (!st.loading) void noteLoadCalendar(true); }
      }, st.loading ? "刷新中…" : "刷新日历"),
      h("button", {
        type: "button", class: "notes-calendar-menu-item", "data-key": "calendar-menu-settings",
        onclick: () => { st.sheetOpen = false; st.settingsOpen = true; noteReplaceCalendarPanel(); }
      }, "日历来源与设置"),
      h("p", { class: "notes-calendar-sheet-hint" }, "在上方日历筛选中选择本地、Google 或 Agent 日程。")));
}

/** 点年月弹出月份选择：只负责跳月份，不改变月历的展开状态。 */
function noteCalendarPicker(st) {
  const year = st.pickerYear || noteMonthDate(st.month).getFullYear();
  const close = () => { st.pickerOpen = false; noteReplaceCalendarPanel(); };
  return h("div", { class: "notes-calendar-overlay" },
    h("div", { class: "notes-calendar-overlay-backdrop", "aria-hidden": "true", onclick: close }),
    h("div", { class: "notes-calendar-picker-pop", role: "dialog", "aria-label": "选择月份" },
      h("div", { class: "notes-calendar-picker-head" },
        h("button", { type: "button", class: "notes-calendar-icon", "data-key": "calendar-picker-prev-year", "aria-label": "上一年", onclick: () => { st.pickerYear = year - 1; noteReplaceCalendarPanel(); } }, noteCalendarGlyph("prev")),
        h("strong", {}, `${year} 年`),
        h("button", { type: "button", class: "notes-calendar-icon", "data-key": "calendar-picker-next-year", "aria-label": "下一年", onclick: () => { st.pickerYear = year + 1; noteReplaceCalendarPanel(); } }, noteCalendarGlyph("next")),
        h("button", { type: "button", class: "notes-calendar-icon", "data-key": "calendar-picker-close", "aria-label": "关闭", onclick: close }, "✕")),
      h("div", { class: "notes-calendar-picker-months" },
        NOTE_CALENDAR_MONTHS.map((label, i) => h("button", {
          type: "button",
          class: `notes-calendar-picker-month${st.month === `${year}-${String(i + 1).padStart(2, "0")}` ? " active" : ""}`,
          "data-key": "calendar-pick-month", "data-month": String(i + 1),
          onclick: () => noteCalendarPickMonth(st, i)
        }, label)))));
}

/** 日历设置改成独立一屏（从「更多 → 日历来源与设置」进入），不再和月历抢位置。 */
function noteGoogleSettings(st) {
  const status = st.status || st.data?.googleStatus || {};
  const ids = st.calendarIdsDraft || (status.calendarIds || []).join("\n");
  const sharedUrls = st.sharedUrlsDraft || (status.sharedUrls || []).join("\n");
  if (!st.clientIdDraft && status.clientId) st.clientIdDraft = status.clientId;
  if (!st.calendarIdsDraft && status.calendarIds?.length) st.calendarIdsDraft = status.calendarIds.join("\n");
  if (!st.sharedUrlsDraft && status.sharedUrls?.length) st.sharedUrlsDraft = status.sharedUrls.join("\n");
  const busy = !!st.busy;
  const save = () => void noteGoogleSaveSettings();
  return h("section", { class: "notes-calendar-settings" },
    h("h2", { class: "notes-calendar-settings-title" }, "日历设置（Google / iCloud）"),
    h("p", { class: "muted small" }, "Agent 日历会读取 pi-agent 平台自己的定时任务（Web 进程内定时任务与 launchd 平台任务），只读展示，不在平台里修改或删除；每小时及更频繁的任务按天显示为全天。"),
    h("p", { class: "muted small" }, "公开分享的 Google / iCloud 日历不需要 OAuth：把公开地址或 embed 链接贴进来即可。Google 私有日历也可以贴“秘密地址（iCal 格式）”，同样不需要 OAuth；如果拿不到秘密地址，再用下面的 OAuth。平台不会把本地日程写回外部日历，也不读写 Google 待办。"),
    h("label", { class: "notes-calendar-ids" }, "日历地址：Google / iCloud 公开链接或秘密 iCal（每行一个）",
      h("textarea", { rows: "3", value: sharedUrls, placeholder: "https://calendar.google.com/calendar/embed?src=...\nhttps://p204-caldav.icloud.com.cn/published/2/...", "data-key": "google-shared-urls", oninput: (e) => { st.sharedUrlsDraft = e.target.value; } })),
    h("p", { class: "muted small" }, "支持 Google embed / cid / 公开 ICS / 秘密 iCal，也支持 iCloud 已发布日历链接（/published/...）。保存后立即读取，不需要授权。"),
    h("div", { class: "note-actions" },
      h("button", { type: "button", class: "btn small primary", disabled: busy, "data-key": "google-save-shared", onclick: () => void noteGoogleSaveShared() }, busy === "shared" ? "保存中…" : "保存分享日历")),
    h("h3", { class: "notes-calendar-subhead" }, "Google 私有日历（可选，需要 OAuth）"),
    h("p", { class: "muted small" }, `OAuth 回调地址：${location.origin}/api/google-calendar/oauth/callback`),
    h("div", { class: "notes-calendar-settings-fields" },
      h("label", {}, "OAuth Client ID",
        h("input", { type: "text", value: st.clientIdDraft || "", autocomplete: "off", "data-key": "google-client-id", oninput: (e) => { st.clientIdDraft = e.target.value; } })),
      h("label", {}, "OAuth Client Secret",
        h("input", { type: "password", value: st.clientSecretDraft || "", autocomplete: "off", placeholder: status.clientConfigured ? "已保存，留空则不修改" : "在 Google Cloud 创建 OAuth Client 后填入", "data-key": "google-client-secret", oninput: (e) => { st.clientSecretDraft = e.target.value; } }))),
    h("div", { class: "note-actions" },
      h("button", { type: "button", class: "btn small", disabled: busy, "data-key": "google-save-client", onclick: save }, busy === "settings" ? "保存中…" : "保存 OAuth 配置"),
      status.clientConfigured ? h("button", { type: "button", class: "btn small primary", disabled: busy, "data-key": "google-connect", onclick: () => void noteGoogleConnect() }, status.connected ? "重新连接" : "连接 Google 日历") : null,
      status.connected ? h("button", { type: "button", class: "btn small", disabled: busy, "data-key": "google-disconnect", onclick: () => void noteGoogleDisconnect() }, "断开连接") : null),
    h("label", { class: "notes-calendar-ids" }, "Google 私有日历 ID（每行一个，需要 OAuth）",
      h("textarea", { rows: "3", value: ids, placeholder: "primary\nteam@group.calendar.google.com", "data-key": "google-calendar-ids", oninput: (e) => { st.calendarIdsDraft = e.target.value; } })),
    h("p", { class: "muted small" }, "可以是 primary、日历 ID，或含 cid= 的 Google 日历链接。保存后刷新日历。"),
    h("div", { class: "note-actions" },
      h("button", { type: "button", class: "btn small", disabled: busy, "data-key": "google-save-calendars", onclick: () => void noteGoogleSaveCalendars() }, busy === "calendars" ? "保存中…" : "保存日历地址"),
      status.connected ? h("button", { type: "button", class: "btn small", disabled: busy, "data-key": "google-load-calendars", onclick: () => void noteGoogleLoadCalendars() }, busy === "list" ? "读取中…" : "读取可选日历") : null),
    st.calendarsError ? h("p", { class: "field-error small", role: "alert" }, st.calendarsError) : null,
    st.calendars?.length ? h("div", { class: "notes-calendar-picker" },
      h("p", { class: "muted small" }, "勾选要显示的日历："),
      ...st.calendars.map((calendar) => h("label", { class: "notes-calendar-picker-item" },
        h("input", {
          type: "checkbox", checked: ids.split(/[\n,]+/).map((s) => s.trim()).includes(calendar.id),
          onchange: (e) => noteGoogleToggleCalendar(st, calendar.id, e.target.checked)
        }),
        h("span", {}, calendar.summary || calendar.id),
        calendar.primary ? h("span", { class: "muted small" }, "（主日历）") : null))) : null);
}

function noteGoogleToggleCalendar(st, id, checked) {
  const current = (st.calendarIdsDraft || "").split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  const next = checked ? [...new Set([...current, id])] : current.filter((x) => x !== id);
  st.calendarIdsDraft = next.join("\n");
  noteReplaceCalendarPanel();
}

/** 一份读取结果里所有来源的日程。 */
function noteCalendarEventsOf(data) {
  return [...(data?.local || []), ...(data?.google || []), ...(data?.agent || [])];
}

/** 已读过的月份数据（按读取范围 + 月份），供滑动时相邻月份并排显示、换月后立即有圆点。 */
function noteCalendarCacheKey(st, month) { return `${noteCalendarReadScope(st)}|${month}`; }
function noteCalendarCachedData(st, month) { return st.monthCache?.[noteCalendarCacheKey(st, month)] || null; }
function noteCalendarCacheStore(st, month, data) {
  if (!data) return;
  const cache = st.monthCache || (st.monthCache = {});
  cache[noteCalendarCacheKey(st, month)] = data;
  const keys = Object.keys(cache);
  for (const key of keys.slice(0, Math.max(0, keys.length - 8))) delete cache[key];
}

/** 当前月读完后悄悄把相邻两个月也读进缓存，滑动时两个月才能带着日程拼在一起。 */
function noteCalendarPrefetch(st) {
  if (noteCalendarView(st) !== "month") return;
  const scope = noteCalendarReadScope(st);
  const token = st.token;
  for (const delta of [-1, 1]) {
    const base = noteMonthDate(st.month);
    const month = noteMonthKey(new Date(base.getFullYear(), base.getMonth() + delta, 1));
    if (noteCalendarCachedData(st, month)) continue;
    const range = noteCalendarRange(noteMonthDate(month));
    const query = `?${new URLSearchParams({ from: noteCalendarBoundIso(range.start), to: noteCalendarBoundIso(range.end) }).toString()}`;
    const reads = [
      scope !== "agent" ? api(`/api/calendar/local${query}`) : null,
      scope !== "agent" ? api(`/api/calendar/google${query}`) : null,
      scope !== "human" ? api(`/api/calendar/agent${query}`) : null
    ];
    Promise.all(reads.map((read) => read && read.then((value) => value || {}))).then(([local, google, agent]) => {
      if (st.token !== token || noteCalendarReadScope(st) !== scope) return;
      if (google?.errors?.length) return;
      noteCalendarCacheStore(st, month, { from: (local || google || agent)?.from, to: (local || google || agent)?.to, local: local?.local || [], localRecords: local?.records || [], google: google?.google || [], agent: agent?.agent || [], agentRecords: agent?.records || [] });
    }).catch(() => { /* 预读失败不打扰：滑过去后照常重读 */ });
  }
}

/** Upcoming window is independent of the month and selected date. */
function noteCalendarRecentState() {
  const st = noteCalendarState();
  return st.recent || (st.recent = { events: [], loaded: false, loading: false, at: 0, token: 0, errors: [] });
}
async function noteLoadCalendarRecent(force = false) {
  const st = noteCalendarRecentState();
  if (st.loading || (!force && st.loaded && Date.now() - st.at < 60000)) return;
  st.loading = true;
  const token = ++st.token;
  const now = Date.now();
  // Whole Beijing days keep shared-calendar cache keys stable, including midnight crossings.
  const from = noteDayStartMs(noteBeijingDateKey(new Date(now)));
  const to = noteDayStartMs(noteBeijingDateKey(new Date(now + NOTE_TODAY_EVENT_WINDOW_MS))) + 86400000;
  const query = new URLSearchParams({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), ...(force ? { force: "1" } : {}) });
  const parts = await Promise.allSettled(["local", "google", "agent"].map(async (source) => {
    const data = await api(`/api/calendar/${source}?${query}`);
    if (st.token !== token) return;
    st[source] = Array.isArray(data?.[source]) ? data[source] : [];
    st[`${source}Errors`] = [...(data?.errors || []), ...(data?.warnings || [])];
    st.events = [...(st.local || []), ...(st.google || []), ...(st.agent || [])];
    if (noteCalendarInlineOpen()) noteReplaceCalendarRecent();
  }));
  if (st.token !== token) return;
  st.errors = parts.flatMap((part, i) => part.status === "rejected" ? [`${["本地", "Google", "Agent"][i]}：${part.reason?.message || "读取失败"}`] : (st[`${["local", "google", "agent"][i]}Errors`] || []));
  st.events = [...(st.local || []), ...(st.google || []), ...(st.agent || [])];
  st.loading = false; st.loaded = true; st.at = Date.now();
  if (noteCalendarInlineOpen()) noteReplaceCalendarRecent();
}
function noteCalendarRecentEvents(st, now = Date.now()) {
  return noteCalendarVisibleEvents(st, noteCalendarRecentState().events).filter(event => {
    const start = event.allDay ? noteDayStartMs(event.start) : Date.parse(event.start);
    const end = event.allDay ? noteDayStartMs(event.end || event.start) + (event.end ? 0 : 86400000) : Date.parse(event.end) || start + 3600000;
    return start < now + NOTE_TODAY_EVENT_WINDOW_MS && end > now;
  }).sort((a, b) => (noteCalendarDate(a.start)?.getTime() || 0) - (noteCalendarDate(b.start)?.getTime() || 0));
}
function noteReplaceCalendarRecent() {
  const el = document.querySelector(".notes-calendar-recent");
  if (!el) return;
  const left = el.querySelector(".notes-calendar-recent-track")?.scrollLeft || 0;
  const focusedKey = el.contains(document.activeElement) ? document.activeElement?.getAttribute("data-key") : null;
  const fresh = noteCalendarRecentSection(noteCalendarState());
  el.replaceWith(fresh);
  fresh.querySelector(".notes-calendar-recent-track").scrollLeft = left;
  if (focusedKey) fresh.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`)?.focus({ preventScroll: true });
}
function noteCalendarRecentSection(st) {
  const recent = noteCalendarRecentState(), events = noteCalendarRecentEvents(st);
  return h("section", { class: "notes-calendar-recent", "aria-label": "最近48h日程" },
    h("div", { class: "notes-calendar-recent-head" }, h("h2", {}, "最近 48h"), h("span", { class: "muted small" }, "进行中与未来 48 小时")),
    h("div", { class: "notes-calendar-recent-track", "data-key": "calendar-recent-track", tabindex: "0", role: "region", "aria-label": "横向滑动查看最近48h日程", "aria-busy": String(recent.loading) },
      events.length ? events.map(event => h("button", {
        type: "button", class: "notes-calendar-recent-card", "data-event-id": event.id, "data-key": `calendar-recent:${noteCalendarSourceKey(event)}:${event.id}`,
        onclick: () => noteShowCalendarEvent(st, event)
      }, h("span", { class: "notes-calendar-recent-day" }, noteUpcomingDay(event)), h("strong", {}, event.title),
      h("span", { class: "muted small" }, `${noteCalendarEventTime(event)} · ${noteCalendarSourceLabelFor(st, event)}`)))
      : h("p", { class: "muted small" }, recent.loading || !recent.loaded ? "正在读取日程…" : recent.errors.length ? "日程读取失败，请重试。" : "未来 48 小时没有日程")),
    recent.errors.length ? h("button", { type: "button", class: "notes-calendar-recent-retry", title: recent.errors.join("；"), onclick: () => void noteLoadCalendarRecent(true) }, "部分来源读取失败，重试") : null);
}

function noteCalendarListEvents(status = noteFilter()) {
  const st = noteCalendarState(), data = st.data;
  const records = new Map([...(ui.notes || []), ...(data?.localRecords || []), ...(data?.agentRecords || [])].map(n => [n.id, n]));
  const selected = st.dateFilter;
  return noteCalendarVisibleEvents(st, noteCalendarEventsOf(data)).filter(event => {
    const range = noteCalendarEventRange(event);
    if (!range || (selected && (selected < range.first || selected > range.last))) return false;
    const window = noteCalendarRange(noteMonthDate(st.month));
    if (range.last < noteWallDateKey(window.start) || range.first >= noteWallDateKey(window.end)) return false;
    const completed = noteCalendarEventDone(event, range);
    if ((status === "todo" && completed) || (status === "done" && !completed)) return false;
    const record = records.get(event.noteId);
    if (record) return noteMatchesLinkFilter(record) && noteCategoryMatches(record) && noteMatchesSearch(record);
    if (noteCategoryFilterKeys().length || noteLinkFilter() === "linked") return false;
    return noteMatchesSearch({ text: `${event.title || ""}\n${event.description || ""}\n${event.calendarName || ""}` });
  }).sort((a, b) => (noteCalendarDate(a.start)?.getTime() || 0) - (noteCalendarDate(b.start)?.getTime() || 0));
}
function noteCalendarDayHeading(day, today) {
  const date = noteCalendarDate(day);
  const info = noteCalendarDayInfo(day);
  const label = `${Number(day.slice(5, 7))} 月 ${Number(day.slice(8))} 日`;
  return h("h3", { class: `notes-calendar-day-title${day === today ? " today" : ""}` },
    day === today ? h("span", { class: "notes-calendar-day-tag" }, "今天") : null,
    h("span", {}, label), h("span", { class: "notes-calendar-day-weekday" }, `周${NOTE_WEEKDAY[date.getDay()]}`),
    noteLunarFullText(day) ? h("span", { class: "notes-calendar-day-lunar" }, `农历${noteLunarFullText(day)}`) : null,
    info.kind ? h("span", { class: `notes-calendar-day-caption ${info.kind}` }, info.kind === "holiday" ? `${info.name} · 休` : `${info.name}调休 · 班`) : null);
}

/** 日程列表：选了日期就只列那一天；没选日期则列出整个读取范围，按天分组，今天作锚点——
 *  今天之前的天已经结束，标题与日程弱化并在上面加「已结束」分隔，今天和之后保持正常。 */
function noteCalendarListChildren() {
  const st = noteCalendarState(), events = noteCalendarListEvents();
  const filter = st.dateFilter;
  const today = noteWallDateKey(noteCalendarTodayDate());
  // 日期筛选条件：右侧一个带 × 的小标签，点一下就取消；没有筛选时占位不显示，列表头高度不变。
  const chip = filter
    ? h("button", { type: "button", class: "notes-calendar-date-chip", "data-key": "calendar-date-chip", "aria-label": `取消日期筛选：${Number(filter.slice(5, 7))} 月 ${Number(filter.slice(8))} 日`, title: "取消日期筛选", onclick: () => noteCalendarClearDate() },
      h("span", {}, `${Number(filter.slice(5, 7))} 月 ${Number(filter.slice(8))} 日`), noteCalendarGlyph("close"))
    : null;
  const head = h("div", { class: "notes-calendar-list-head" }, h("h2", {}, "日程", h("span", { class: "muted small" }, ` ${events.length}`)),
    h("div", { class: "notes-calendar-date-slot" }, chip));
  const window = noteCalendarRange(noteMonthDate(st.month));
  const todayInWindow = !filter && today >= noteWallDateKey(window.start) && today < noteWallDateKey(window.end);
  if (!events.length && !todayInWindow) return [head, h("p", { class: "notes-empty muted", role: "status" }, st.loading ? "正在读取日程…" : st.error ? "日程读取失败，请在日历更多菜单中重试。" : filter ? "这一天没有符合筛选的日程。" : "当前月份没有符合筛选的日程。")];
  const byDay = new Map();
  for (const event of events) {
    const range = noteCalendarEventRange(event);
    // 跨天日程：今天还在进行中就挂在今天下面，不沉到已结束的那一段。
    const day = filter || (range.first < today && range.last >= today ? today : range.first);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(event);
  }
  if (todayInWindow && !byDay.has(today)) byDay.set(today, []);
  const days = [...byDay].sort((a, b) => a[0].localeCompare(b[0]));
  const sections = [];
  let pastMarked = false;
  for (const [day, items] of days) {
    const past = !filter && day < today;
    if (past && !pastMarked) { pastMarked = true; sections.push(h("p", { class: "notes-calendar-past-label", role: "separator" }, "已结束")); }
    sections.push(h("section", { class: `notes-calendar-list-day${past ? " past" : ""}${day === today && !filter ? " today" : ""}`, "data-list-date": day },
      noteCalendarDayHeading(day, today),
      ...(items.length ? items.map(event => noteCalendarAgendaItem(st, event, day)) : [h("p", { class: "notes-calendar-day-empty muted small" }, "今天没有日程")])));
  }
  // 末尾留出一屏的余量：未来的日程不多时，页面仍能滚到让「今天」贴着日历下沿。
  if (!filter) sections.push(h("div", { class: "notes-calendar-list-fill", "aria-hidden": "true" }));
  return [head, ...sections];
}

/** 取消日期筛选：回到全部日程并重新定位到今天。 */
function noteCalendarClearDate() {
  const st = noteCalendarState();
  if (!st.dateFilter) return;
  st.dateFilter = ""; st.anchorToday = true;
  noteReplaceCalendarPanel();
}

/** 没有日期筛选时，把页面滚到「今天」那一段，刚好停在固顶的筛选栏与日历下方；等读取结束、列表画好后只定位一次。 */
function noteCalendarAnchorToday() {
  const st = ui.notesCalendar;
  if (!st?.anchorToday || st.dateFilter || st.loading || !st.data || !noteCalendarInlineOpen()) return;
  st.anchorToday = false;
  requestAnimationFrame(() => {
    const section = document.querySelector("#notes-list-region .notes-calendar-list-day.today");
    if (!section) return;
    const head = document.getElementById("notes-sticky-head");
    const stuckTop = head ? parseFloat(getComputedStyle(head).top) || 0 : 0;
    // 页面本身已有 scroll-padding-top（给固顶头部留的）：边距只补它和真实固顶高度之间的差。
    const padding = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
    section.style.scrollMarginTop = `${Math.max(0, stuckTop + (head ? head.offsetHeight : 0) + 6 - padding)}px`;
    section.scrollIntoView({ block: "start" });
  });
}

function noteCalendarPanelChildren() {
  const st = noteCalendarState();
  const selected = noteCalendarSelected(st);
  const data = st.data;
  const allEvents = noteCalendarEventsOf(data);
  const events = noteCalendarVisibleEvents(st, allEvents);
  const alerts = [];
  const year = st.month.slice(0, 4);
  if (!NOTE_CALENDAR_CN_HOLIDAYS[year]) alerts.push(h("p", { class: "small muted notes-calendar-holiday-pending" }, `${year} 年放假调休安排待更新，当前仅标记周末`));
  if (st.notice) alerts.push(h("p", { class: "notes-calendar-notice", role: "status" },
    st.notice,
    h("button", { type: "button", class: "btn small", onclick: () => { st.notice = ""; noteReplaceCalendarPanel(); } }, "知道了")));
  if (st.error) alerts.push(h("p", { class: "error", role: "alert" }, st.error));
  if (st.googleError) alerts.push(h("p", { class: "error", role: "alert" }, st.googleError));
  if (data?.errors?.length) alerts.push(h("div", { class: "notes-calendar-errors" }, data.errors.map((error) => h("p", { class: "field-error small", role: "alert" }, error))));
  // 读取中的提示不再占一行（会把网格顶下去、读完又顶回来）：放在顶栏底边的细进度条里，见 noteCalendarTopbar。
  const alertBox = alerts.length ? h("div", { class: "notes-calendar-alerts" }, alerts) : null;

  const settingsView = st.settingsOpen
    ? h("div", { class: "notes-calendar-settings-view" },
        h("button", { type: "button", class: "notes-calendar-back", "data-key": "calendar-settings-close", onclick: () => { st.settingsOpen = false; noteReplaceCalendarPanel(); } }, "‹ 返回日历"),
        noteGoogleSettings(st))
    : null;

  return [
    noteCalendarTopbar(st),
    h("div", { class: "notes-calendar-scroll", role: "region", "aria-label": "日历内容" },
      alertBox,
      settingsView || noteCalendarGrid(st, events, selected)),
    noteCalendarInlineOpen() ? null : noteCalendarFooter(st, allEvents),
    st.sheetOpen ? noteCalendarSheet(st) : null,
    st.pickerOpen ? noteCalendarPicker(st) : null
  ].filter(Boolean);
}

function noteCalendarPanelShell() {
  const panel = h("section", { id: "notes-calendar-panel", class: "notes-calendar-shell", "aria-label": "日历" }, noteCalendarPanelChildren());
  panel.style.setProperty("--cal-p", String(noteCalendarProgress(noteCalendarView(noteCalendarState()))));
  return panel;
}

function noteReplaceCalendarPanel() {
  const panel = document.getElementById("notes-calendar-panel");
  if (!panel) return;
  // 局部刷新会重建整个面板：保留中间滚动区的滚动位置，避免选日期 / 刷新后跳回顶部。
  const focusedKey = panel.contains(document.activeElement) ? document.activeElement?.getAttribute("data-key") : null;
  const focusedSource = focusedKey === "calendar-source-filter" ? document.activeElement?.getAttribute("data-source") : null;
  const recentLeft = panel.querySelector(".notes-calendar-recent-track")?.scrollLeft || 0;
  const previous = panel.querySelector(".notes-calendar-scroll");
  const top = previous ? previous.scrollTop : 0;
  if (!panel.style.getPropertyValue("--cal-p")) panel.style.setProperty("--cal-p", String(noteCalendarProgress(noteCalendarView(noteCalendarState()))));
  panel.replaceChildren(...noteCalendarPanelChildren());
  const next = panel.querySelector(".notes-calendar-scroll");
  if (next && top) next.scrollTop = top;
  const recentTrack = panel.querySelector(".notes-calendar-recent-track");
  if (recentTrack) recentTrack.scrollLeft = recentLeft;
  if (noteCalendarInlineOpen()) noteRefreshList();
  if (focusedKey) panel.querySelector(`[data-key="${CSS.escape(focusedKey)}"]${focusedSource ? `[data-source="${CSS.escape(focusedSource)}"]` : ""}`)?.focus({ preventScroll: true });
}

async function noteLoadCalendar(force = false) {
  if (force) void noteLoadCalendarRecent(true);
  const st = noteCalendarState();
  if (force) st.monthCache = {};
  const scope = noteCalendarReadScope(st);
  const token = (st.token || 0) + 1;
  st.token = token;
  // 全部读取三个来源；人只读本地 / Google，Agent 只读定时任务。
  st.loading = true;
  st.localLoading = scope !== "agent"; st.agentLoading = scope !== "human"; st.googleLoading = scope !== "agent";
  st.error = ""; st.googleError = "";
  noteReplaceCalendarPanel();
  const range = noteCalendarRange(noteMonthDate(st.month));
  const bounds = { from: noteCalendarBoundIso(range.start), to: noteCalendarBoundIso(range.end) };
  const localUrl = `/api/calendar/local?${new URLSearchParams(bounds).toString()}`;
  const agentUrl = `/api/calendar/agent?${new URLSearchParams(bounds).toString()}`;
  const googleUrl = `/api/calendar/google?${new URLSearchParams({ ...bounds, ...(force ? { force: "1" } : {}) }).toString()}`;
  const apply = (patch) => {
    if (st.token !== token) return;
    st.data = { ...(st.data || {}), ...patch };
    noteReplaceCalendarPanel();
  };
  const localTask = scope !== "agent" ? api(localUrl).then((data) => {
    if (st.token !== token) return;
    st.localLoading = false;
    apply({ from: data?.from, to: data?.to, local: data?.local || [], localRecords: data?.records || [] });
  }).catch((e) => {
    if (st.token !== token) return;
    st.localLoading = false;
    st.error = e.message || "本地日程读取失败";
    apply({});
  }) : null;
  const agentTask = scope !== "human" ? api(agentUrl).then((data) => {
    if (st.token !== token) return;
    st.agentLoading = false;
    st.agentTasks = Number(data?.tasks) || 0;
    st.agentWarnings = Array.isArray(data?.warnings) ? data.warnings.filter(Boolean).slice(0, 3) : [];
    apply({ from: data?.from, to: data?.to, agent: data?.agent || [], agentRecords: data?.records || [] });
  }).catch((e) => {
    if (st.token !== token) return;
    // Agent 定时任务读不到：警告挂到「更多」里，不挡住其他内容打开。
    st.agentLoading = false;
    st.agentTasks = 0;
    st.agentWarnings = [e?.message || "Agent 定时任务读取失败"];
    apply({ agent: [] });
  }) : null;
  const googleTask = scope !== "agent" ? api(googleUrl).then((data) => {
    if (st.token !== token) return;
    st.googleLoading = false;
    if (data?.googleStatus) {
      st.status = data.googleStatus;
      if (!st.calendarIdsDraft && data.googleStatus.calendarIds?.length) st.calendarIdsDraft = data.googleStatus.calendarIds.join("\n");
    }
    st.googleSources = { month: st.month, sources: noteCalendarGoogleSources(st, data?.google || []) };
    apply({ from: data?.from, to: data?.to, google: data?.google || [], googleStatus: data?.googleStatus, errors: data?.errors || [], cached: data?.cached });
  }).catch((e) => {
    if (st.token !== token) return;
    st.googleLoading = false;
    st.googleError = e.message || "Google 日历读取失败";
    apply({});
  }) : null;
  await Promise.allSettled([localTask, agentTask, googleTask].filter(Boolean));
  if (st.token !== token) return;
  st.loading = false;
  noteReplaceCalendarPanel();
  if (!st.error && !st.googleError && !st.data?.errors?.length) {
    noteCalendarCacheStore(st, st.month, st.data);
    noteCalendarPrefetch(st);
  }
}

/**
 * 跳到记录页并定位某条记录：切到它自己的大类（大类只有笔记 / 待办 / 日程，没有混排的「全部」），
 * 筛选归零后按新条件重新取第一页；目标不在首页时继续续读找到它。
 * 类型未知时先停在当前大类；取完还没有这条，再按 id 读一次并切到它的大类（见 noteFocusPending）。
 */
function noteOpenNoteRecords(id, kind) {
  const before = noteQueryKey();
  ui.notesTab = "records";
  ui.notesCalendarRecord = kind === "event" ? id : null;
  ui.notesCalendarRecordNote = [...(ui.notes || []), ...(ui.notesCalendar?.data?.localRecords || []), ...(ui.notesCalendar?.data?.agentRecords || [])].find(n => n.id === id) || null;
  if (kind) ui.notesKindFilter = kind;
  ui.notesFilter = "all";
  ui.notesLinkFilter = "all";
  ui.notesSearch = ""; ui.notesSearchDraft = ""; ui.notesSearchOpen = false;
  ui.notesCategory = ""; ui.notesCategories = []; ui.notesFilteredCounts = null;
  ui.notesFocusNote = id || ui.notesFocusNote;
  noteSyncTabs();
  if (ui.view !== "notes") return;
  const after = noteQueryKey();
  if (before !== after) noteQueryReload();
  else noteRefreshList();
}

/** 打开一条记录；日历里的本地日程一定是「日程」大类。 */
function noteOpenNoteById(id, kind = "event") {
  if (!id) return;
  noteOpenNoteRecords(id, kind);
}

function noteOpenNoteInCalendar(note) {
  noteSetCalendarScope(note.automation?.taskId ? "agent" : "human");
  const st = noteCalendarState();
  const key = noteDateKey(note.schedule?.start || note.schedule?.end) || noteDateKey(new Date());
  const date = noteCalendarDate(key) || noteCalendarTodayDate();
  st.month = noteMonthKey(date);
  st.selected = noteWallDateKey(date); st.dateFilter = st.selected;
  ui.notesCalendarRecord = null;
  st.data = null;
  ui.notesTab = "calendar";
  ui.notesKindFilter = "event";
  noteSyncTabs();
  void noteLoadCalendar();
}

/** 最近日程 / Agent 日程：进入对应范围的日历，翻到那个月并打开这条日程的详情。 */
function noteOpenEventInCalendar(event, { scope = "human" } = {}) {
  if (ui.view !== "notes") {
    ui.notesPendingCalendarEvent = { event, scope };
    location.hash = "#/notes";
    return;
  }
  noteSetCalendarScope(scope);
  const st = noteCalendarState();
  const key = noteDateKey(event.start) || noteDateKey(new Date());
  const date = noteCalendarDate(key) || noteCalendarTodayDate();
  if (st.month !== noteMonthKey(date) || !st.data) { st.month = noteMonthKey(date); st.data = null; }
  st.selected = noteWallDateKey(date); st.dateFilter = st.selected;
  ui.notesCalendarRecord = null;
  ui.notesTab = "calendar";
  ui.notesKindFilter = "event";
  noteSyncTabs();
  noteReplaceCalendarPanel();
  if (!st.data) void noteLoadCalendar();
  requestAnimationFrame(() => {
    if (ui.view === "notes" && ui.notesTab === "calendar") noteShowCalendarEvent(st, event);
  });
}

function noteShowCalendarEvent(st, event) {
  const dialog = h("dialog", { class: "notes-calendar-dialog", "aria-label": event.title },
    h("div", { class: "notes-calendar-dialog-head" },
      h("h2", {}, event.title),
      h("button", { type: "button", class: "btn small", onclick: () => dialog.close() }, "关闭")),
    h("p", { class: "muted small" }, `${noteCalendarSourceLabelFor(st, event)} · ${noteCalendarEventDateLabel(event)} ${noteCalendarEventTime(event)}`),
    event.source === "agent" ? h("div", { class: "notes-calendar-agent-meta" },
      h("p", { class: "muted small" }, `应用：${event.agentApp || "-"} · 场景：${event.agentScene || "-"} · 任务：${event.agentName || event.title}`),
      event.agentStatus === "paused" ? h("p", { class: "muted small" }, "状态：已暂停") : null,
      event.agentStatus === "unknown" ? h("p", { class: "muted small" }, "状态：未在 launchd 中找到（按平台默认时间展示）") : null) : null,
    event.location ? h("p", { class: "muted small" }, `地点：${event.location}`) : null,
    event.description ? h("p", { class: "notes-calendar-dialog-desc" }, event.description) : null,
    h("div", { class: "note-actions" },
      event.noteId || event.relationRef ? noteRelationActions(event.relationRef || {kind:"note",noteId:event.noteId},event.relationCount,undefined,()=>dialog.close()) : h("span", {class:"muted small"}, "此自动任务没有本地记录，暂不支持条目关联"),
      event.noteId ? h("button", { type: "button", class: "btn small primary", onclick: () => { dialog.close(); noteOpenNoteById(event.noteId); } }, "打开记录") : null,
      event.htmlLink ? h("a", { class: "btn small", href: event.htmlLink, target: "_blank", rel: "noopener" }, "在 Google 日历中打开") : null));
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
}

/** Native widget links are consumed once, before normal calendar rendering. */
function noteWidgetEntry() {
  const match = location.hash.match(/^#\/notes\/widget\/(\d{4}-\d{2}-\d{2})(?:\/(n-[A-Za-z0-9_-]+))?$/);
  if (!match) return;
  const date = noteCalendarDate(match[1]);
  if (!date || noteWallDateKey(date) !== match[1]) return;
  history.replaceState(history.state, "", location.pathname + location.search + "#/notes");
  ui.currentHash = "#/notes";
  noteSetCalendarScope("human");
  const st = noteCalendarState();
  st.month = match[1].slice(0, 7); st.selected = match[1]; st.dateFilter = match[1]; st.view = "week";
  ui.notesTab = "calendar";
  ui.notesKindFilter = "event";
  noteCalendarInvalidate();
  if (match[2]) noteOpenNoteRecords(match[2], "event");
}

function noteCalendarNoticeFromUrl() {
  if (typeof location === "undefined") return;
  const params = new URLSearchParams(location.search || "");
  const result = params.get("google_calendar");
  if (!result) return;
  noteSetCalendarScope("human");
  const st = noteCalendarState();
  st.notice = result === "connected" ? "Google 日历已连接。" : `Google 日历连接失败：${params.get("reason") || "未知原因"}`;
  ui.notesTab = "calendar";
  ui.notesKindFilter = "event";
  st.month = noteMonthKey();
  noteCalendarInvalidate();
  try { history.replaceState(null, "", location.pathname + location.hash); } catch { /* 老浏览器不支持也继续 */ }
}

async function noteGoogleAction(path, body, key) {
  const st = noteCalendarState();
  if (st.busy) return null;
  st.busy = key; st.error = "";
  noteReplaceCalendarPanel();
  try {
    const result = await api(path, { method: "POST", body: JSON.stringify(body || {}) });
    return result;
  } catch (e) {
    st.error = e.message || "操作失败";
    return null;
  } finally {
    st.busy = "";
    noteReplaceCalendarPanel();
  }
}

function noteGoogleIdList(st) {
  return (st.calendarIdsDraft || "").split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
}

function noteSharedList(st) {
  return (st.sharedUrlsDraft || "").split(/\n+/).map((s) => s.trim()).filter(Boolean);
}

async function noteGoogleSaveShared() {
  const st = noteCalendarState();
  const status = await noteGoogleAction("/api/google-calendar/settings", { sharedUrls: noteSharedList(st) }, "shared");
  if (status) {
    st.status = status;
    st.sharedUrlsDraft = (status.sharedUrls || []).join("\n");
    st.notice = "分享日历已保存。";
    await noteLoadCalendar(true);
  }
}

async function noteGoogleSaveSettings() {
  const st = noteCalendarState();
  const body = { calendarIds: noteGoogleIdList(st) };
  if ((st.clientIdDraft || "").trim()) body.clientId = st.clientIdDraft.trim();
  if ((st.clientSecretDraft || "").trim()) body.clientSecret = st.clientSecretDraft.trim();
  const status = await noteGoogleAction("/api/google-calendar/settings", body, "settings");
  if (status) {
    st.status = status;
    st.clientSecretDraft = "";
    if (status.clientId) st.clientIdDraft = status.clientId;
    st.calendarIdsDraft = (status.calendarIds || []).join("\n");
    st.notice = "Google 私有日历设置已保存。";
    if (!status.clientConfigured) {
      st.error = "OAuth Client 未完整配置：请同时填写 Client ID 和 Client Secret。";
      noteReplaceCalendarPanel();
      return;
    }
    await noteLoadCalendar(true);
  }
}

async function noteGoogleSaveCalendars() {
  const st = noteCalendarState();
  const status = await noteGoogleAction("/api/google-calendar/settings", { calendarIds: noteGoogleIdList(st) }, "calendars");
  if (status) {
    st.status = status;
    st.calendarIdsDraft = (status.calendarIds || []).join("\n");
    st.notice = "日历地址已保存。";
    await noteLoadCalendar(true);
  }
}

async function noteGoogleConnect() {
  const st = noteCalendarState();
  if (st.busy) return;
  st.busy = "connect"; st.error = "";
  noteReplaceCalendarPanel();
  try {
    const result = await api("/api/google-calendar/oauth/start", {
      method: "POST",
      body: JSON.stringify({ redirectUri: `${location.origin}/api/google-calendar/oauth/callback` })
    });
    if (!result?.url) throw new Error("没有拿到 Google 授权地址");
    location.assign(result.url);
  } catch (e) {
    st.error = e.message || "无法开始 Google 授权";
  } finally {
    st.busy = "";
    noteReplaceCalendarPanel();
  }
}

async function noteGoogleDisconnect() {
  const st = noteCalendarState();
  const status = await noteGoogleAction("/api/google-calendar/disconnect", {}, "disconnect");
  if (status) {
    st.status = status;
    st.calendars = null;
    st.notice = "已断开 Google 日历；本地日程不受影响。";
    st.data = null;
    await noteLoadCalendar(true);
  }
}

async function noteGoogleLoadCalendars() {
  const st = noteCalendarState();
  if (st.busy) return;
  st.busy = "list"; st.calendarsError = "";
  noteReplaceCalendarPanel();
  try {
    const data = await api("/api/google-calendar/calendars");
    st.calendars = data?.calendars || [];
  } catch (e) {
    st.calendarsError = e.message || "读取日历列表失败";
  } finally {
    st.busy = "";
    noteReplaceCalendarPanel();
  }
}

/**
 * 搜索框默认收起成一个放大镜按钮，放在「最近 + 类型」这一行的右端；点开后在同一行展开输入框。
 * 展开时不随列表局部刷新被替换（否则输入中途会丢焦点 / 输入法组字），只同步清除按钮与结果提示。
 */
let noteSearchTimer = 0;
function noteApplySearch(value) {
  const next = String(value || "").slice(0, NOTE_SEARCH_MAX_LENGTH);
  ui.notesSearchDraft = next;
  if (next.trim() === noteSearchQuery()) { ui.notesSearch = next; return; }
  ui.notesSearch = next;
  ui.notesMore = null;
  ui.notesQuickCategory = null;
  noteQueryReload();
}
function noteScheduleSearch(value, immediate) {
  ui.notesSearchDraft = value;
  ui.notesSearchOpen = true;
  clearTimeout(noteSearchTimer);
  if (immediate) { noteApplySearch(value); return; }
  noteSearchTimer = setTimeout(() => { if (ui.view === "notes") noteApplySearch(ui.notesSearchDraft); }, 300);
}

/** 有草稿或已生效的搜索词时保持展开，避免收起后还留着看不见的搜索条件。 */
function noteSearchExpanded() {
  const draft = typeof ui.notesSearchDraft === "string" ? ui.notesSearchDraft.trim() : "";
  return !!ui.notesSearchOpen || !!draft || !!noteSearchQuery();
}

/** 放大镜图标：收起时是入口，展开时是输入框右端的提示（只作提示，不抢输入框的点击与焦点）。 */
const NOTE_SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4.2-4.2"/></svg>';
const NOTE_SEARCH_CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
function noteSearchIcon() {
  const icon = document.createElement("span");
  icon.className = "notes-search-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = NOTE_SEARCH_ICON;
  return icon;
}

/** 只替换搜索区域：展开 / 收起不会动列表，也不会把输入到一半的草稿丢掉。 */
function noteRefreshSearch(focus = "") {
  const current = document.getElementById("notes-search");
  if (!current || ui.view !== "notes") return;
  const next = noteSearchBox();
  current.replaceWith(next);
  if (focus === "input") next.querySelector("#notes-search-input")?.focus();
  else if (focus === "toggle") next.querySelector("#notes-search-toggle")?.focus();
}

/** 收起时一并清空搜索：输入框藏起来了，筛选条件也跟着撤掉，免得列表看起来莫名其妙。 */
function noteToggleSearch() {
  if (noteSearchExpanded()) {
    ui.notesSearchOpen = false;
    clearTimeout(noteSearchTimer);
    if (noteSearchQuery() || (typeof ui.notesSearchDraft === "string" && ui.notesSearchDraft)) noteApplySearch("");
    noteRefreshSearch("toggle");
    return;
  }
  ui.notesSearchOpen = true;
  if (typeof ui.notesSearchDraft !== "string") ui.notesSearchDraft = noteSearchQuery();
  noteRefreshSearch("input");
}

/** 输入框失焦且没有内容时自动收起；点到搜索区域里的按钮（清除 / 收起）不算失焦。 */
function noteSearchBlur(e) {
  const next = e.relatedTarget;
  if (next instanceof Node && e.currentTarget.contains(next)) return;
  setTimeout(() => {
    if (ui.view !== "notes") return;
    const box = document.getElementById("notes-search");
    if (!box || !box.classList.contains("open")) return;
    if (box.contains(document.activeElement)) return;
    if (noteSearchQuery() || (typeof ui.notesSearchDraft === "string" && ui.notesSearchDraft.trim())) return;
    ui.notesSearchOpen = false;
    noteRefreshSearch();
  }, 0);
}

function noteSearchBox() {
  const open = noteSearchExpanded();
  const value = typeof ui.notesSearchDraft === "string" ? ui.notesSearchDraft : noteSearchQuery();
  const toggle = h("button", {
    type: "button", class: `notes-search-toggle${open ? " open" : ""}`, id: "notes-search-toggle",
    "aria-label": open ? "收起搜索" : "搜索记录", title: open ? "收起搜索" : "搜索记录",
    "aria-expanded": open ? "true" : "false", ...(open ? { "aria-controls": "notes-search-field" } : {}),
    onclick: noteToggleSearch
  });
  toggle.innerHTML = open ? NOTE_SEARCH_CLOSE_ICON : NOTE_SEARCH_ICON;
  if (!open) return h("div", { id: "notes-search", class: "notes-search collapsed", role: "search" }, toggle);

  const input = h("input", {
    type: "search", class: "notes-search-input", id: "notes-search-input", "data-key": "notes-search",
    placeholder: "搜索记录：正文、分类、图片名、关联会话（多个词用空格分开）",
    "aria-label": "搜索记录", autocomplete: "off", enterkeyhint: "search", maxlength: String(NOTE_SEARCH_MAX_LENGTH), value,
    oninput: (e) => { if (e.isComposing) { ui.notesSearchDraft = e.target.value; return; } noteScheduleSearch(e.target.value, false); },
    oncompositionend: (e) => noteScheduleSearch(e.target.value, false),
    onkeydown: (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter") { e.preventDefault(); noteScheduleSearch(e.target.value, true); }
      else if (e.key === "Escape") {
        e.preventDefault();
        if (e.target.value) { e.target.value = ""; noteScheduleSearch("", true); }
        else noteToggleSearch();
      }
    }
  });
  return h("div", { id: "notes-search", class: "notes-search open", role: "search", onfocusout: noteSearchBlur },
    h("div", { class: "notes-search-field", id: "notes-search-field" },
      h("div", { class: "notes-search-box" }, input, noteSearchIcon()),
      h("button", {
        type: "button", class: "notes-search-clear btn small", id: "notes-search-clear", "aria-label": "清除搜索", hidden: !value,
        onclick: () => { input.value = ""; noteScheduleSearch("", true); input.focus(); }
      }, "清除")),
    toggle);
}

/** 有搜索词时的结果行：几条命中（按当前筛选范围），以及范围被其余筛选收窄时的提醒。 */
function noteSearchSummary() {
  const query = noteSearchQuery();
  if (!query) return "";
  if (ui.pageLoading) return `正在搜索「${query}」…`;
  const n = noteFilteredCount();
  return n ? `找到 ${n} 条包含「${query}」的记录${noteSearchScopeNarrowed() ? "（仅限当前筛选范围）" : ""}` : `没有找到包含「${query}」的记录`;
}

function noteSearchScopeNarrowed() {
  // 大类不算收窄：搜索始终只在当前大类里找，不跨大类混排。
  return noteFilter() !== "all" || noteLinkFilter() !== "all" || noteCategoryFilterKeys().length > 0;
}

function noteSyncSearch() {
  const box = document.getElementById("notes-search");
  if (!box) return;
  const open = noteSearchExpanded();
  const toggle = document.getElementById("notes-search-toggle");
  if (toggle) {
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.setAttribute("aria-label", open ? "收起搜索" : "搜索记录");
    toggle.title = open ? "收起搜索" : "搜索记录";
  }
  const input = document.getElementById("notes-search-input");
  const clear = document.getElementById("notes-search-clear");
  if (clear) clear.hidden = !(input && input.value);
  const summary = document.getElementById("notes-search-summary");
  if (summary) { const text = noteSearchSummary(); summary.textContent = text; summary.hidden = !text; }
}

/** 搜索无结果：明确提示；完成状态 / 关联对话 / 分类把范围收窄时，给出清掉这些筛选再搜的入口。 */
function noteSearchEmpty() {
  const query = noteSearchQuery();
  const narrowed = noteSearchScopeNarrowed();
  return h("div", { class: "notes-empty notes-search-empty muted", role: "status" },
    h("p", {}, `没有找到包含「${query}」的记录。`),
    h("p", { class: "small" }, narrowed ? "当前还有完成状态 / 关联对话 / 分类筛选，可能把命中的记录排除了。" : "换个关键词试试，或切到上方其它大类再搜。"),
    narrowed ? h("button", { type: "button", class: "btn small", onclick: () => noteSearchWidenScope() }, "清空其它筛选再搜索") : null);
}

/** 清掉完成状态 / 关联对话 / 分类筛选后重新搜；大类不变，搜索不会跨大类。 */
function noteSearchWidenScope() {
  ui.notesFilter = "all"; ui.notesLinkFilter = "all";
  ui.notesCategory = ""; ui.notesCategories = []; ui.notesFilteredCounts = null;
  ui.notesMore = null; ui.notesFilterMenu = null;
  noteQueryReload();
}

function renderNotes() {
  noteInstallEvents();
  if (ui.notesManagement) { noteCloseSheet(); return renderNoteCategoryManagement(); }
  noteWidgetEntry();
  noteCalendarNoticeFromUrl();
  if (ui.notesTab === "calendar") ui.notesKindFilter = "event";
  // 手机上的输入区在浮层里（同一个表单节点被移进 dialog），页面上不再渲染第二份。
  const pageComposer = noteComposerPhone() && ui.notesSheetOpen ? null : noteComposer();
  const records = h("div", { class: "notes-column" },
    h("header", { class: "notes-head" },
      h("div", {}, h("h1", {}, "笔记 · 待办 · 日程"))),
    h("div", { id: "notes-error", class: "error", role: "alert", hidden: !ui.notesError }, ui.notesError || ""),
    h("div", { id: "notes-read-notice", class: "muted small notes-read-notice", role: "status", hidden: !ui.noteReadError }, ...noteReadNoticeChildren()),
    h("section", { id: "notes-records-panel", class: "notes-records-panel", "aria-label": "记录" },
      // 大类 tab 占左边；搜索收成图标靠右，「新建」主按钮紧跟在它右边（手机换成右下角圆形按钮）。
      // 标题行 + 筛选行放进同一个固顶容器：列表往下滚时它们停在页面顶部。
      // 输入区在头部上面：新建不属于某个大类，展开时向上撑开、把「今天」卡片顶上去，标签行和新建按钮留在原处。
      pageComposer,
      h("div", { id: "notes-sticky-head", class: "notes-sticky-head" },
        h("div", { id: "notes-list-bar", class: "notes-list-bar" }, noteListTitle(), noteSearchBox(), ...noteNewEntry()),
        noteFilterBar(),
        // 日历跟标题、筛选一起固顶：下面的日程列表在它底下滚动，今天定位后日历仍在眼前。
        h("div", { id: "notes-calendar-view", class: "notes-calendar-inline", hidden: !noteCalendarInlineOpen() },
          noteCalendarPanelShell())),
      noteKindResult(),
      h("p", { id: "notes-search-summary", class: "notes-search-summary muted small", role: "status", "aria-live": "polite", hidden: !noteSearchQuery() }, noteSearchSummary()),
      noteCategoryControls(),
      h("div", { class: "notes-region", id: "notes-list-region" }, noteListChildren())));
  const node = h("div", { class: "notes" }, records);
  if (ui.notesPendingCalendarEvent) requestAnimationFrame(() => {
    if (ui.view !== "notes" || !ui.notesPendingCalendarEvent) return;
    const { event, scope } = ui.notesPendingCalendarEvent;
    ui.notesPendingCalendarEvent = null;
    noteOpenEventInCalendar(event, { scope });
  });
  noteInstallKindSwipe(node.querySelector("#notes-records-panel"));
  noteInstallTodaySwipe(node.querySelector("#notes-today-body"));
  noteInstallCalendarGridSwipe(node.querySelector("#notes-calendar-view"));
  // 整页已经用最新数据渲染过：编辑期间被推迟的局部刷新不必再补
  noteListRefreshPending = false;
  noteFocusPending();
  noteSyncDrawer();
  noteSyncCalendarView();
  requestAnimationFrame(noteSyncCalendarView);
  noteSyncSheet();
  // 从会话列表长按上滑跳进来：手机把浮层拉起来并聚焦（页面还没渲染好时，这次渲染接手）
  if (ui.notesFocusInput && noteComposerPhone()) {
    ui.notesFocusInput = false;
    const existing = noteSheet?.querySelector(".notes-input");
    const form = node.querySelector(".notes-composer");
    if (existing) existing.focus({ preventScroll: true });
    else if (form) noteOpenSheet(form, true);
  }
  if (noteCalendarInlineOpen()) noteStartCountdownTicker();
  noteScheduleAutoLoad();
  requestAnimationFrame(noteSyncTabBarStuck);
  noteCollapseLater();
  // 宽屏侧边栏默认展示，首次渲染就把日历读出来；窄屏只在视图打开时读。
  if ((noteCalendarDocked() || (ui.notesTab || "records") === "calendar") && !noteCalendarState().loading) {
    requestAnimationFrame(() => {
      if (ui.view === "notes" && (noteCalendarDocked() || (ui.notesTab || "records") === "calendar") && !noteCalendarState().data) void noteLoadCalendar();
    });
  }
  if (ui.notesRestoreManagementPosition && !ui.pageLoading) requestAnimationFrame(() => {
    if (ui.view !== 'notes' || ui.notesManagement) return;
    ui.notesRestoreManagementPosition = false;
    const pos = ui.notesManagementPosition;
    if (pos) { window.scrollTo(0, pos.window); const main = document.getElementById('main'); if (main) main.scrollTop = pos.main; }
  });
  return node;
}

let noteCategoryLoading = false;
async function noteLoadCategories() {
  if (noteCategoryLoading) return;
  noteCategoryLoading = true;
  try {
    const opts = noteReadOptions();
    // 分类只有 5KB 左右，一次失败多半是连接卡了一下：静默重试，别让它变成一条红色错误。
    const taxonomy = typeof retryTransientRead === 'function'
      ? await retryTransientRead(() => api('/api/note-categories', opts), () => ui.view === 'notes', noteReadWaits())
      : await api('/api/note-categories', opts);
    noteApplyTaxonomy(taxonomy);
    ui.notesError = ''; noteReadRecovered();
    if (ui.view === 'notes') { noteRefreshLive(); noteSyncReadNotice(); }
  } catch (e) {
    noteReadFailed(e);
    if (ui.view === 'notes') { if (ui.notesManagement) renderMain(); else noteSyncReadNotice(); }
  }
  finally { noteCategoryLoading = false; }
}

const NOTE_DIFFICULTY = { low: "低", medium: "中", high: "高", unknown: "待评估" };
const NOTE_ITERATION_STATUS = { ready: "待启动", decision: "待决策", started: "已发起", done: "已完成", ignored: "已忽略", invalid: "已失效" };
const NOTE_VALUE = { high: "高", medium: "中", low: "低", unknown: "待评估" };
const NOTE_REMOVAL = { done: "已完成", deleted: "已删除", edited: "已编辑，重新判断归属", session: "已单独发起会话", excluded: "改判为非开发", detached: "人工移出" };
/** 推荐任务排序：可发起的按推荐分（价值 ÷ 难度、等待时长、一次处理条数）在前，其余保持服务端顺序。 */
function noteIterationOrder(tasks) {
  const score = t => t.rank && t.status === 'ready' && t.launchable !== false && !t.deferred ? t.rank.score : -Infinity;
  return tasks.map((t, i) => [t, i]).sort((a, b) => (score(b[0]) - score(a[0])) || (a[1] - b[1])).map(([t]) => t);
}
/** 设置当前打开的面板：records = 都关着，calendar = 日历（宽屏侧边栏 / 窄屏左滑视图），recommended = 全部推荐任务。 */
function noteSetTab(v) {
  ui.notesTab = v;
  if (v === "calendar") ui.notesCalendarRecord = null;
  if (ui.view !== "notes") { location.hash = "#/notes"; return; }
  if (v === "calendar") noteSetKindFilter("event", { automatic: true });
  noteSyncTabs();
  if (v === 'recommended') void noteLoadIterations();
  if (v === 'calendar') {
    const st = noteCalendarState();
    // 宽屏侧边栏一直显示，这里只负责把数据读完；窄屏把日历视图滑进来。
    if (!st.data || st.error || st.googleError) void noteLoadCalendar();
  }
}

/** 外部上下文的默认范围；来源圆点可覆盖，外部切换会重设覆盖值。 */
function noteCalendarScope(st = noteCalendarState()) { return ["all", "human", "agent"].includes(st.scope) ? st.scope : "human"; }


function noteSetCalendarScope(scope) {
  const st = noteCalendarState();
  const next = ["all", "human", "agent"].includes(scope) ? scope : "human";
  if (noteCalendarScope(st) === next && !noteCalendarHiddenSources(st).length && !(st.shownSources || []).length) return false;
  st.scope = next;
  st.hiddenSources = []; st.shownSources = [];
  // 不同范围读取不同来源，旧数据和加载标记作废，按新范围重读。
  st.data = null; st.error = ""; st.googleError = ""; st.status = null; st.monthCache = {};
  st.loading = false; st.localLoading = false; st.googleLoading = false; st.agentLoading = false;
  st.agentTasks = 0; st.agentWarnings = [];
  st.token = (st.token || 0) + 1;
  if (ui.view === "notes" && (noteCalendarInlineOpen() || ui.notesTab === "calendar")) noteReplaceCalendarPanel();
  return true;
}

/** 从某张今天卡片进入日历：先定范围，再打开日历（窄屏滑入 / 宽屏读数据）。 */
function noteOpenCalendarFor(scope) {
  noteSetCalendarScope(scope);
  noteSetTab("calendar");
}
function noteSyncTabs() {
  if (ui.notesTab === "calendar" && noteKindFilter() !== "event") { ui.notesKindFilter = "event"; ui.notesFilter = "all"; }
  noteSyncDrawer();
  noteSyncCalendarView();
  noteSyncSheet();
}

/** 手机日历视图在浏览器历史里占一个同 URL 的条目：系统返回先关日历，而不是离开待办页。 */
const NOTE_CALENDAR_HISTORY_KEY = "notesCalendarView";
let noteCalendarHistoryClosing = false;
function noteCalendarHistoryState() {
  try { return !!(typeof history !== "undefined" && history.state && history.state[NOTE_CALENDAR_HISTORY_KEY]); } catch { return false; }
}
function noteCalendarPushHistory() {
  if (noteCalendarDocked() || ui.view !== "notes" || noteCalendarHistoryState()) return;
  try { history.pushState({ ...(history.state || {}), [NOTE_CALENDAR_HISTORY_KEY]: true }, "", location.href); } catch { /* 老浏览器不支持也照常展示日历 */ }
}
function noteCalendarDropHistoryMarker() {
  if (!noteCalendarHistoryState()) return;
  try {
    const next = { ...(history.state || {}) };
    delete next[NOTE_CALENDAR_HISTORY_KEY];
    history.replaceState(next, "", location.href);
  } catch { /* 忽略 */ }
}
function noteCalendarStepBackHistory() {
  if (!noteCalendarHistoryState() || noteCalendarHistoryClosing) return;
  noteCalendarHistoryClosing = true;
  try { history.back(); } catch { noteCalendarHistoryClosing = false; }
  setTimeout(() => { noteCalendarHistoryClosing = false; }, 0);
}

/** 浏览器前进 / 返回：回到带日历标记的条目就打开日历，退回普通待办条目就关日历。 */
if (typeof window !== "undefined") {
  window.addEventListener("popstate", (ev) => {
    if (ui.view !== "notes" || noteCalendarDocked() || document.getElementById("notes-calendar-view")?.classList.contains("notes-calendar-inline")) return;
    const marked = !!(ev.state && ev.state[NOTE_CALENDAR_HISTORY_KEY]) || noteCalendarHistoryState();
    if (marked) {
      if (ui.notesTab === "calendar") return;
      ui.notesTab = "calendar";
      noteSyncTabs();
      const st = noteCalendarState();
      if (!st.data || st.error || st.googleError) void noteLoadCalendar();
      return;
    }
    if (ui.notesTab === "calendar") {
      const view = document.getElementById("notes-calendar-view");
      // 系统返回时可能还停在左滑打开的拖拽态：先撤掉，否则 noteSyncCalendarView 会把它当成手势中而跳过。
      noteCalendarClearDrag(view);
      ui.notesTab = "records";
      noteSyncCalendarView();
      if (view?.contains(document.activeElement)) document.querySelector(".notes-kind-tab.active")?.focus({ preventScroll: true });
    }
  });
}

/** 日历面板：宽屏作为右侧侧边栏常驻；窄屏一直在 DOM 里（便于跟手滑动），打开时滑入，关闭后让读屏忽略。 */
function noteSyncCalendarView() {
  const inline = document.getElementById("notes-calendar-view");
  if (inline?.classList.contains("notes-calendar-inline")) {
    const open = noteCalendarInlineOpen();
    inline.hidden = !open;
    inline.setAttribute("aria-hidden", String(!open));
    const filters = document.getElementById("notes-filters"), head = document.getElementById("notes-sticky-head");
    if (filters && head && filters.parentElement !== head) head.append(filters);
    if (open && !noteCalendarState().data && !noteCalendarState().loading) void noteLoadCalendar();
    if (open) void noteLoadCalendarRecent();
    return;
  }
  const view = document.getElementById("notes-calendar-view");
  if (!view) return;
  const docked = noteCalendarDocked();
  const open = docked || (ui.view === "notes" && !ui.notesManagement && ui.notesTab === "calendar");
  const wasOpen = view.classList.contains("is-open");
  // 打开手势进行中：不要被滚动 / 刷新打断预览，松手后由 finish 统一收尾。
  if (!open && view.classList.contains("is-dragging")) return;
  if (wasOpen !== open) {
    view.classList.toggle("is-open", open);
  }
  // 手机打开日历：压一条同 URL 的历史；系统返回先关日历，不会直接跳回会话列表。
  // 放在过渡判断外：从宽屏缩到手机、或带日历状态重新渲染时也补上历史条目。
  if (open && !docked) noteCalendarPushHistory();
  const hidden = open ? "false" : "true";
  if (view.getAttribute("aria-hidden") !== hidden) view.setAttribute("aria-hidden", hidden);
  if (view.inert === open) view.inert = !open;
  if (!open && (wasOpen || view.classList.contains("is-dragging"))) {
    view.classList.remove("is-dragging");
    view.style.removeProperty("--notes-calendar-offset");
    view.style.removeProperty("--notes-calendar-backdrop");
    // 用户点日程跳到记录：连同历史条目一起退掉，避免留下一层空返回。
    if (!docked) noteCalendarStepBackHistory();
  }
}

/** 页面重绘后对齐浮层：离开待办页、进分类管理、或已经记完了就把手机上的新建浮层收起来。 */
function noteSyncSheet() {
  if (!!ui.notesSheetOpen && ui.view === "notes" && !ui.notesManagement) return;
  noteCloseSheet();
}

/* ------------------------------ 右侧抽屉：推荐任务 ------------------------------ */
// 「今天」卡片的推荐任务用模态抽屉展示；日历已改为宽屏侧边栏 / 窄屏滑入视图（见 noteSyncCalendarView）。
// 推荐面板仍是 #notes-recommended-panel，局部刷新按 id 找它。
let noteDrawer = null;
const NOTE_DRAWER_TITLES = { recommended: "推荐任务" };

function noteSyncDrawer() {
  // 日历不再走模态抽屉：宽屏固定在右侧，窄屏由 noteSyncCalendarView 负责滑入。
  const kind = ui.view === "notes" && !ui.notesManagement && ui.notesTab === "recommended" ? "recommended" : "";
  if (!kind) { noteCloseDrawer({ keepState: true }); return; }
  if (noteDrawer && noteDrawer.kind === kind && noteDrawer.dialog.isConnected) return;
  noteOpenDrawer(kind);
}

function noteOpenDrawer(kind) {
  noteCloseDrawer({ keepState: true, restoreFocus: false });
  const trigger = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  const close = h("button", { type: "button", class: "btn small", "data-key": "notes-drawer-close", "aria-label": "关闭", onclick: () => noteDismissDrawer() }, "关闭");
  const dialog = h("dialog", { class: "resource-drawer notes-drawer", "aria-label": NOTE_DRAWER_TITLES[kind], "data-drawer": kind },
    h("div", { class: "resource-drawer-panel" },
      h("header", { class: "resource-drawer-head" },
        h("div", { class: "resource-drawer-title" }, h("strong", {}, NOTE_DRAWER_TITLES[kind])),
        h("div", { class: "resource-drawer-tools" }, close)),
      h("div", { class: "resource-drawer-body" },
        h("section", { id: "notes-recommended-panel", "aria-label": "推荐任务" }, noteRecommendedChildren()))));
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    noteDismissDrawer();
  });
  // 点抽屉外的遮罩关闭（dialog 自身没有内边距，点到它就是点在遮罩上）
  dialog.addEventListener("click", (e) => { if (e.target === dialog) noteDismissDrawer(); });
  const onHash = () => { if (!/^#\/notes(\/|$|\?)/.test(location.hash) || /^#\/notes\/categories/.test(location.hash)) noteLeaveDrawer(); };
  window.addEventListener("hashchange", onHash);
  noteDrawer = { kind, dialog, trigger, onHash };
  document.body.append(dialog);
  dialog.showModal();
}

/** 用户主动关闭：抽屉 / 手机日历视图收起并把状态复位成「都关着」，焦点回到打开它的入口。 */
function noteDismissDrawer() {
  const view = document.getElementById("notes-calendar-view");
  const restoreList = !!view?.contains(document.activeElement);
  // 右滑关闭时面板正带着 is-dragging：先撤掉手势态，noteSyncCalendarView 才会真正收起它。
  noteCalendarClearDrag(view);
  noteCalendarBackdropGuardUntil = 0;
  ui.notesTab = "records";
  noteSyncCalendarView();
  noteCloseDrawer({ keepState: false });
  // 返回按钮就在刚被隐藏的面板里：焦点不能留在 inert 子树里。
  if (restoreList && !noteCalendarDocked()) document.querySelector(".notes-kind-tab.active")?.focus({ preventScroll: true });
}

/** 离开待办页 / 进入分类管理：抽屉收起；去分类管理时保留打开状态，回来再拉起，换到别的页就复位。 */
function noteLeaveDrawer() {
  if (!/^#\/notes\/categories/.test(location.hash)) ui.notesTab = "records";
  noteCloseDrawer({ keepState: true, restoreFocus: false });
}

function noteCloseDrawer({ keepState = false, restoreFocus = true } = {}) {
  const d = noteDrawer;
  if (!d) return;
  noteDrawer = null;
  window.removeEventListener("hashchange", d.onHash);
  try { d.dialog.close(); } catch { /* 已关闭 */ }
  d.dialog.remove();
  if (!keepState && restoreFocus && d.trigger?.isConnected) d.trigger.focus({ preventScroll: true });
}
const NOTE_ITERATIONS_RETRY_WAITS = [2000, 4000];
// 今日推荐摘要很小、也不是首屏关键内容：瞬时失败快速重试，避免按钮或推荐模块被 2s+4s 拖住。
const NOTE_SUMMARY_RETRY_WAITS = [600, 1500];
/** 浮层里的推荐任务按状态分页读：每页这么多条，点「加载更多」再读下一页。 */
const NOTE_ITERATIONS_PAGE = 10;
let noteIterationsToken = null;
let noteIterationsMoreBusy = false;
// 列表读取与本地操作可能同时在途：读取发出后如果本地操作成功写入了更新的快照，
// 这次读取的结果就作废，否则旧快照会把刚完成的任务覆盖回「待启动」，看起来像点击没反应。
let noteIterationsEpoch = 0;
/** 当前筛选下要读 / 回写的第一页范围：已经翻过几页就一次带回同样多条，保持列表不缩回去。 */
function noteIterationsQuery(offset, limit, status) {
  const f = status || ui.noteIterationFilter || 'ready';
  return `status=${encodeURIComponent(f)}&offset=${offset}&limit=${limit}${f === 'ready' ? `&scope=${encodeURIComponent(ui.noteIterationScope || 'window')}` : ''}`;
}
function noteIterationsViewQuery() {
  const f = ui.noteIterationFilter || 'ready', data = ui.noteIterations;
  const loaded = data?.page?.status === f ? data.tasks.length : 0;
  return noteIterationsQuery(0, Math.min(100, Math.max(NOTE_ITERATIONS_PAGE, loaded)), f);
}
async function noteLoadIterations() {
  const key = noteIterationsViewQuery();
  if (noteIterationsToken?.key === key && noteIterationsToken.epoch === noteIterationsEpoch) return;
  const epoch = noteIterationsEpoch, token = { key, epoch };
  noteIterationsToken = token;
  try {
    // 手机上偶尔一次卡顿就会超时：瞬时失败（408/502）页面可见时静默重试两次，再报错并给「重试」。
    const read = () => api(`/api/note-iterations?${key}`);
    const data = typeof retryTransientRead === 'function'
      ? await retryTransientRead(read, () => epoch === noteIterationsEpoch && ui.view === 'notes', NOTE_ITERATIONS_RETRY_WAITS)
      : await read();
    if (epoch !== noteIterationsEpoch || ui.noteIterationBusy) return;
    if (!data || !Array.isArray(data.tasks) || !Array.isArray(data.analyses) || !data.aggregate) throw new Error('推荐任务响应格式无效，请重试');
    // 重读总是从第 0 条起、条数取已加载的数量，所以逐条判定（只跟第一页）和列表都是齐的。
    const changed = JSON.stringify(data) !== JSON.stringify(ui.noteIterations);
    ui.noteIterations = data; ui.noteIterationsError = '';
    if (changed) { noteRefreshRecommended(); void noteLoadTodaySummary(); }
  } catch (e) {
    if (epoch !== noteIterationsEpoch) return;
    ui.noteIterationsError = e.message; noteRefreshRecommended();
  }
  finally { if (noteIterationsToken === token) noteIterationsToken = null; }
}
/** 浮层滚到底 / 点「加载更多」：续读下一页并接在已加载的后面。 */
async function noteLoadMoreIterations() {
  const data = ui.noteIterations;
  if (!data?.page?.hasMore || noteIterationsMoreBusy) return;
  const epoch = noteIterationsEpoch;
  noteIterationsMoreBusy = true; ui.noteIterationsMoreError = ''; noteRefreshRecommended();
  try {
    const next = await api(`/api/note-iterations?${noteIterationsQuery(data.tasks.length, NOTE_ITERATIONS_PAGE, data.page.status)}`);
    if (epoch !== noteIterationsEpoch || ui.noteIterations !== data) return;
    if (!next || !Array.isArray(next.tasks) || !next.page) throw new Error('推荐任务响应格式无效，请重试');
    const seen = new Set(data.tasks.map(t => t.id));
    data.tasks = [...data.tasks, ...next.tasks.filter(t => !seen.has(t.id))];
    data.page = next.page; data.counts = next.counts;
  } catch (e) {
    if (epoch === noteIterationsEpoch) ui.noteIterationsMoreError = e.message || '读取失败';
  }
  finally { noteIterationsMoreBusy = false; noteRefreshRecommended(); }
}
function noteRefreshRecommended() {
  if (typeof composing !== 'undefined' && composing || typeof pointerHeld !== 'undefined' && pointerHeld) { renderDeferred = true; return; }
  noteReplaceTodayRecs();
  const panel = document.getElementById('notes-recommended-panel'); if (!panel) return;
  const active = document.activeElement, key = panel.contains(active) ? active?.dataset?.key : null;
  const selection = key && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  panel.replaceChildren(...noteRecommendedChildren());
  if (key) { const next = panel.querySelector(`[data-key="${CSS.escape(key)}"]`); next?.focus({ preventScroll: true }); if (selection) next?.setSelectionRange(...selection); }
  if (ui.notesFocusIteration) { const el = panel.querySelector(`[data-iteration-id="${CSS.escape(ui.notesFocusIteration)}"]`); if (el) { el.scrollIntoView({ block: 'center' }); ui.notesFocusIteration = null; } else if (ui.noteIterations?.page?.hasMore && !ui.noteIterationsMoreError) void noteLoadMoreIterations(); }
}
function noteToggleIterationSection(id, section) {
  const sections = ui.noteIterationSection ||= {};
  sections[id] = sections[id] === section ? null : section;
  noteRefreshRecommended();
}
function noteIterationSectionKey(event, id, section) {
  const keys = ['requirement', 'sources', 'revision'];
  const index = keys.indexOf(section);
  const next = ({ ArrowRight: keys[(index + 1) % keys.length], ArrowLeft: keys[(index + keys.length - 1) % keys.length], Home: keys[0], End: keys[2] })[event.key];
  if (!next) return;
  event.preventDefault();
  (ui.noteIterationSection ||= {})[id] = next;
  noteRefreshRecommended();
  document.getElementById(`iteration-tab-${id}-${next}`)?.focus({ preventScroll: true });
}
let noteIterationNoticeTimer = null;
/** 操作成功后的可见提示：推荐任务可能因筛选从列表消失，不能只靠卡片状态变化让人确认。 */
function noteIterationShowNotice(text) {
  ui.noteIterationsNotice = text;
  if (noteIterationNoticeTimer) clearTimeout(noteIterationNoticeTimer);
  noteIterationNoticeTimer = setTimeout(() => {
    noteIterationNoticeTimer = null;
    if (ui.noteIterationsNotice !== text) return;
    ui.noteIterationsNotice = '';
    if (ui.view === 'notes') noteRefreshRecommended();
  }, 5000);
}
function noteActionSpinner() {
  return h('span', { class: 'note-action-spinner', 'aria-hidden': 'true' });
}
function noteActionBusyText(label) {
  return `正在${label || '处理'}…`;
}
async function noteIterationAct(path, body, { taskId = '', label = '', success = '' } = {}) {
  if (ui.noteIterationBusy) return;
  ui.noteIterationBusy = true;
  ui.noteIterationBusyTask = taskId;
  ui.noteIterationBusyLabel = label || '处理';
  ui.noteIterationsNotice = '';
  // 点击后立刻重绘：请求期间按钮保持禁用并显示 loading，不再等接口回来才变化。
  noteRefreshRecommended();
  try {
    const next = await api(`${path}?${noteIterationsViewQuery()}`, { method: 'POST', body: JSON.stringify(body || {}) });
    // 成功写入后让更早发出的列表读取作废：POST 返回的就是最新快照，不能被旧读取覆盖。
    noteIterationsEpoch++;
    ui.noteIterations = next; ui.noteIterationsError = '';
    ui.noteIterationMore = null;
    void noteLoadTodaySummary();
    if (success) {
      noteIterationShowNotice(success);
      if (typeof announce === 'function') announce(success);
    }
  } catch (e) {
    ui.noteIterationsError = e.message;
    // 错误提示在面板顶部可能不在视野内；用全局提示明确告诉用户操作失败了。
    if (typeof announce === 'function') announce(e.message || '操作失败，请重试');
  }
  finally {
    ui.noteIterationBusy = false;
    ui.noteIterationBusyTask = '';
    ui.noteIterationBusyLabel = '';
    // 这次局部刷新完成后再撤掉 loading，加载态覆盖整个操作周期。
    noteRefreshRecommended();
  }
}
function noteRecommendedChildren() {
  noteScheduleRoiExposure();
  const data = ui.noteIterations;
  if (!data || !Array.isArray(data.tasks)) return [h('p', { class: 'muted', role: 'status' }, ui.noteIterationsError || '正在读取推荐任务…'), h('button', { class: 'btn small', onclick: () => void noteLoadIterations() }, '刷新')];
  const filter = ui.noteIterationFilter || 'ready';
  // 分页形态：服务端已按状态筛好、排好序，只带一页；counts 是各状态的总数。没有 page 的整份快照（旧形态）仍在本地筛。
  const paged = !!data.page;
  const loadingFilter = paged && (data.page.status !== filter || (filter === 'ready' && data.page.scope && data.page.scope !== (ui.noteIterationScope || 'window')));
  const visibleAll = data.tasks.filter(t => t.status !== 'invalid' && t.noteIds.length > 0);
  const counts = data.counts || { all: visibleAll.length, ...Object.fromEntries(['ready', 'decision', 'started', 'done'].map(k => [k, visibleAll.filter(t => t.status === k).length])) };
  const tasks = loadingFilter ? [] : noteIterationOrder(paged ? visibleAll : visibleAll.filter(t => filter === 'all' || t.status === filter));
  const quality = data.quality;
  const feedbackTotal = quality ? quality.adopted + (quality.ignored || 0) + quality.split + quality.detached : 0;
  const mergeTotal = quality ? quality.adopted + quality.split + quality.detached : 0;
  const processing = ['pending', 'running'].includes(data.aggregate.state) || data.analyses.some(a => a.state === 'pending' || a.state === 'running');
  // 筛选数字与列表同一口径：当前筛选（含推荐范围）已读回来的条数优先，避免「待启动 28、列表只有 2 条」；
  // 优先推荐还没读回来时，用服务端给的窗口内可发起数 window（不是含已完成 / 已发起的 counts.ready）。
  const scope = ui.noteIterationScope || 'window';
  const count = state => {
    if (paged && !loadingFilter && data.page.status === state) return data.page.total;
    if (state === 'ready' && scope === 'window' && typeof counts.window === 'number') return counts.window;
    return counts[state] || 0;
  };
  const allTotal = count('all');
  const list = (title, values) => values?.length ? h('section', {}, h('strong', {}, title), h('ul', {}, values.map(v => h('li', {}, v)))) : null;
  return [
    h('p', { class: 'muted small', role: 'status' }, data.enabled ? `开发判定 ${data.analyses.filter(a => a.state === 'ready').length}/${data.analyses.length} · ${processing ? '推荐更新中' : data.aggregate.state === 'failed' ? '推荐生成失败，可重试' : '推荐已更新'}` : '自动推荐未启用'),
    !data.effectiveFeedback && feedbackTotal ? h('p', { class: 'muted small', 'data-key': 'note-iteration-quality', title: '采纳：从推荐发起会话或直接标记完成；忽略：不想现在做，后续推荐前移并用于校准排序；拆开／移出：人类认为合并不合适' }, `近 ${quality.days} 天反馈：采纳 ${quality.adopted} · 忽略 ${quality.ignored || 0} · 拆开 ${quality.split} · 移出 ${quality.detached} · 合并准确率 ${mergeTotal ? Math.round(quality.adopted / mergeTotal * 100) : 0}%`) : null,
    !data.roiRanking && data.ranking ? h('p', { class: 'muted small', 'data-key': 'note-iteration-ranking', title: 'AI 只负责逐条打标和语义聚合；排序、优先推荐由本机算法计算。每天北京时间 03:00 根据忽略、启动、完成记录小幅校准权重。' }, `排序算法 v${data.ranking.version} · ${data.ranking.source === 'learned' ? `已按行为校准${data.ranking.updatedAt ? `（${noteStamp(data.ranking.updatedAt)}）` : ''}` : '默认权重'} · 每天北京时间 03:00 校准${data.ranking.lastError ? ' · 上次校准失败，沿用原权重' : ''}`) : null,
    h('label', { class: 'muted small' }, '推荐范围 ', h('select', { 'aria-label': '推荐范围', 'data-key': 'note-roi-scope', value: ui.noteIterationScope || 'window', style: 'min-height:44px;max-width:100%', onchange: e => { noteIterationsEpoch++; noteIterationsToken = null; ui.noteIterationScope = e.target.value; ui.noteIterationFilter = 'ready'; ui.noteIterationsMoreError = ''; noteRefreshRecommended(); void noteLoadIterations(); } },
      [['window', '优先推荐（最多 10 项）'], ['backup', '备选任务'], ['assessment', '待评估 / 未过价值底线']].map(([value, text]) => h('option', { value, selected: value === (ui.noteIterationScope || 'window') }, text)))),
    data.recommendationWindow ? h('p', { class: 'muted small' }, `当前优先推荐 ${data.recommendationWindow.entries.length}/10 · 价值达到中等才入选，按价值与预计投入排序`) : null,
    data.effectiveFeedback ? h('p', { class: 'muted small' }, `近 30 天有效曝光 ${data.effectiveFeedback.exposed} 项 · 人工完成 ${data.effectiveFeedback.humanCompleted || 0} · 忽略 ${data.effectiveFeedback.ignored || 0} · 新结果 ${data.effectiveFeedback.fresh} 项；样本不足时不校准`) : null,
    data.roiRanking ? h('p', { class: 'muted small' }, `投入产出算法 v${data.roiRanking.version} · 每天 03:00 检查有效反馈${data.roiRanking.lastError ? ' · 上次校准失败，沿用原权重' : ''}`) : null,
    noteIterationFilters(filter, count, allTotal),
    ui.noteIterationsNotice ? h('p', { class: 'note-iteration-notice', role: 'status' }, ui.noteIterationsNotice) : null,
    ui.noteIterationsError || data.aggregate.error ? h('p', { class: 'error', role: 'alert' }, ui.noteIterationsError || data.aggregate.error) : null,
    ui.noteIterationBusy && !ui.noteIterationBusyTask ? h('p', { class: 'note-action-busy muted small', role: 'status' }, noteActionSpinner(), noteActionBusyText(ui.noteIterationBusyLabel)) : null,
    h('div', { class: 'note-actions' },
      data.aggregate.state === 'failed' || (data.counts?.blocked || 0) > 0 || data.analyses.some(a => a.state === 'failed' || (a.state === 'ready' && a.value?.kind === 'development' && !a.value?.assessment)) ? h('button', { class: 'btn small', disabled: !!ui.noteIterationBusy, 'aria-busy': ui.noteIterationBusy && !ui.noteIterationBusyTask && ui.noteIterationBusyLabel === '重试分析' ? 'true' : null, onclick: () => void noteIterationAct('/api/note-iterations/retry', undefined, { label: '重试分析', success: '已重新发起失败分析' }) }, ui.noteIterationBusy && !ui.noteIterationBusyTask && ui.noteIterationBusyLabel === '重试分析' ? [noteActionSpinner(), '重试分析中…'] : '重试失败分析') : null,
      data.enabled && ((counts.ready || 0) + (counts.decision || 0)) > 0 ? h('button', { class: 'btn small', disabled: !!ui.noteIterationBusy, 'aria-busy': ui.noteIterationBusy && !ui.noteIterationBusyTask ? 'true' : null, title: '放弃全部未发起的推荐，按当前待办重新整理；已发起、已完成的不受影响', onclick: () => { if (confirm('放弃全部未发起的推荐，按当前待办重新整理？已发起和已完成的推荐不受影响。')) void noteIterationAct('/api/note-iterations/regroup', undefined, { label: '重新整理', success: '已重新整理推荐任务' }); } }, ui.noteIterationBusy && !ui.noteIterationBusyTask ? [noteActionSpinner(), '重新整理中…'] : '重新整理全部') : null),
    ...tasks.map(t => {
      const section = (ui.noteIterationSection ||= {})[t.id];
      const input = (ui.noteIterationDecisions ||= {})[t.id] || '';
      const decision = (action, text, label, success) => void noteIterationAct(`/api/note-iterations/${encodeURIComponent(t.id)}/decision`, { revision: t.revision, action, text }, { taskId: t.id, label, success });
      const current = t.status === 'ready' || t.status === 'decision';
      const multi = t.noteIds.length > 1;
      const facts = current && t.rank ? t.rank.reasons.join(' · ') : `难度 ${NOTE_DIFFICULTY[t.difficulty]}`;
      const ownBusy = !!ui.noteIterationBusy && ui.noteIterationBusyTask === t.id;
      return h('article', { class: 'note-iteration-card', 'data-iteration-id': t.id, 'aria-busy': ownBusy ? 'true' : null },
        h('h2', {}, t.rank?.priority ? h('span', { class: 'note-iteration-priority', 'data-key': `iteration-priority-${t.id}` }, `优先推荐 ${t.rank.priority}`) : null, t.title), h('p', {}, t.goal),
        h('p', { class: 'muted small' }, `${multi ? `${t.noteIds.length} 条待办` : '单条待办'} · ${facts} · ${NOTE_ITERATION_STATUS[t.status]}${t.status === 'done' && t.completedAt ? ` · ${noteStamp(t.completedAt)}` : ''}${t.deferred ? ' · 已暂缓' : ''}`),
        t.assessment ? h('p', { class: 'muted small' }, `产出价值：${({ high: '高', medium: '中', low: '低', unknown: '待判断' })[t.assessment.value]} · ${t.assessment.valueBasis}；预计投入 ${t.assessment.effortHours.min}–${t.assessment.effortHours.max} 小时 · ${t.assessment.effortBasis}${t.assessment.confidence === 'low' ? ' · 置信度低，暂不入选' : ''}`) : data.recommendationWindow && current ? h('p', { class: 'muted small' }, '投入产出评估中，尚未进入优先推荐；仍可手动发起') : null,
        t.assessmentState === 'below-floor' ? h('p', { class: 'muted small' }, '未达到中等价值底线，保留原待办') : null,
        ownBusy ? h('p', { class: 'note-action-busy muted small', role: 'status' }, noteActionSpinner(), noteActionBusyText(ui.noteIterationBusyLabel)) : null,
        current && t.stale ? h('p', { class: 'muted small', role: 'status' }, '来源有变化，正在按当前来源更新，更新后可发起') : null,
        h('div', { class: 'note-iteration-tabs inpage-tabs', role: 'tablist', 'aria-label': `${t.title}详情` },
          [['requirement', '迭代需求'], ['sources', `关联待办（${t.noteIds.length}）`], ['revision', '修订']].map(([key, label], index) => h('button', {
            type: 'button', role: 'tab', id: `iteration-tab-${t.id}-${key}`, class: `note-iteration-tab${section === key ? ' active' : ''}`,
            'data-key': `iteration-tab-${t.id}-${key}`, 'aria-selected': String(section === key), 'aria-expanded': String(section === key),
            'aria-controls': `iteration-panel-${t.id}-${key}`, tabindex: section === key || !section && index === 0 ? 0 : -1,
            onclick: () => noteToggleIterationSection(t.id, key), onkeydown: e => noteIterationSectionKey(e, t.id, key)
          }, label))),
        h('section', { class: 'note-iteration-panel', role: 'tabpanel', id: `iteration-panel-${t.id}-requirement`, 'aria-labelledby': `iteration-tab-${t.id}-requirement`, hidden: section !== 'requirement' },
          list(multi ? '合并需求' : '需求', t.scope), list('分期交付与依赖', t.order), list('验收条件', t.acceptance), list('明确边界', t.excluded), list('开工前需确认', t.questions),
          h('p', { class: 'muted small' }, '可以分期交付；需求冲突由人类决策；需求改动须先找人类确认。'),
          ...t.conflicts.map((c, i) => h('section', { class: 'note-iteration-conflict' }, h('strong', {}, `需决策 ${i + 1}：${c.question}`), list('原文依据', c.evidence), h('p', { class: 'muted small' }, `涉及 ${c.noteIds.join('、')}`), ...c.options.map(option => h('button', { class: 'btn small', disabled: !current || ui.noteIterationBusy, onclick: () => { ui.noteIterationDecisions[t.id] = `${input ? input + '\n' : ''}${c.question}：${option}`; noteRefreshRecommended(); } }, option)))),
          current && t.status === 'decision' ? h('div', {}, h('textarea', { rows: 3, 'aria-label': '人工决定或补充约束', 'data-key': `iteration-decision-${t.id}`, value: input, oninput: e => { ui.noteIterationDecisions[t.id] = e.target.value; } }), h('button', { class: 'btn small', disabled: ui.noteIterationBusy, onclick: () => decision('resolve', ui.noteIterationDecisions[t.id], '提交决定', '已提交决定，正在重新生成') }, ui.noteIterationBusy ? [noteActionSpinner(), '提交中…'] : '提交决定并重新生成'), t.noteIds.length > 1 ? h('button', { class: 'btn small', disabled: ui.noteIterationBusy, onclick: () => decision('split', undefined, '拆分', '已拆成独立迭代') }, ui.noteIterationBusy ? [noteActionSpinner(), '拆分中…'] : '拆成独立迭代') : null) : null),
        h('section', { class: 'note-iteration-panel', role: 'tabpanel', id: `iteration-panel-${t.id}-sources`, 'aria-labelledby': `iteration-tab-${t.id}-sources`, hidden: section !== 'sources' },
          ...t.sources.map(n => { const a = t.analyses?.[n.id] || data.analyses.find(a => a.noteId === n.id)?.value; return h('div', { class: 'note-iteration-source' }, h('p', {}, n.text || '图片需求'), noteImageStrip(n.images || []), a ? h('p', { class: 'muted small' }, `开发 · 价值 ${NOTE_VALUE[a.value || 'unknown']} · 难度 ${NOTE_DIFFICULTY[a.difficulty]} · ${a.reason} · ${a.basis}`) : null,
            h('div', { class: 'note-actions' },
              h('button', { class: 'btn small', onclick: () => noteOpenNoteRecords(n.id, noteDisplayKind(n)) }, '查看待办'),
              current && multi ? h('button', { class: 'btn small', disabled: !!ui.noteIterationBusy || !!t.launch, title: '这条不该和其余待办放在一起：移出后单独推荐，并记为合并反馈', onclick: () => void noteIterationAct(`/api/note-iterations/${encodeURIComponent(t.id)}/decision`, { revision: t.revision, action: 'detach', noteId: n.id }, { taskId: t.id, label: '移出', success: '已移出这组' }) }, '移出这组') : null)); }),
          list('已移出的来源', (t.removed || []).map(r => `${r.text || '图片需求'}（${NOTE_REMOVAL[r.reason] || r.reason}）`))),
        h('section', { class: 'note-iteration-panel', role: 'tabpanel', id: `iteration-panel-${t.id}-revision`, 'aria-labelledby': `iteration-tab-${t.id}-revision`, hidden: section !== 'revision' },
          h('p', {}, `当前修订 ${t.revision}`), h('p', { class: 'muted small' }, `生成于 ${noteStamp(t.generatedAt)}`),
          multi ? h('p', { class: 'muted small' }, `合并理由：${t.mergeReason}`) : null),
        noteIterationActions(t, current, decision));
    }),
    loadingFilter ? h('p', { class: 'muted', role: 'status' }, ui.noteIterationsError ? '读取失败，请重试。' : '正在读取推荐任务…', ui.noteIterationsError ? h('button', { type: 'button', class: 'btn small', onclick: () => { ui.noteIterationsError = ''; noteRefreshRecommended(); void noteLoadIterations(); } }, '重试') : null) : null,
    !tasks.length && !loadingFilter ? h('p', { class: 'muted' }, '当前筛选下没有推荐任务。') : null,
    paged && !loadingFilter && data.page.hasMore ? h('div', { class: 'note-actions' },
      h('button', { type: 'button', class: 'btn small', 'data-key': 'note-iterations-more', disabled: noteIterationsMoreBusy, 'aria-busy': noteIterationsMoreBusy ? 'true' : null, onclick: () => void noteLoadMoreIterations() },
        noteIterationsMoreBusy ? [noteActionSpinner(), '加载中…'] : `加载更多（还有 ${Math.max(0, data.page.total - data.tasks.length)} 个）`),
      ui.noteIterationsMoreError ? h('span', { class: 'error small', role: 'alert' }, `读取失败：${ui.noteIterationsMoreError}`) : null) : null,
    h('details', {}, h('summary', {}, '逐条开发判定（可纠正）'), ...data.analyses.map(a => h('div', { class: 'note-iteration-source' },
      h('p', {}, a.text || (ui.notes || []).find(n => n.id === a.noteId)?.text || '图片待办'),
      h('p', { class: 'muted small' }, a.value ? `${({ development: '开发', other: '非开发', uncertain: '待判断' })[a.value.kind]} · ${a.value.reason} · 价值 ${NOTE_VALUE[a.value.value || 'unknown']} · 难度 ${NOTE_DIFFICULTY[a.value.difficulty]} · ${a.value.basis}${a.value.product ? ` · ${a.value.product}` : ''}${a.manual ? ' · 人工判定' : ''}` : a.error || ({ pending: '等待分析', running: '分析中', failed: '分析失败' })[a.state]),
      list('信息缺口', a.value?.questions),
      ...[['development', '开发'], ['other', '非开发'], ['uncertain', '待判断']].map(([kind, label]) => h('button', { class: 'btn small', disabled: ui.noteIterationBusy, onclick: () => void noteIterationAct(`/api/notes/${encodeURIComponent(a.noteId)}/development`, { inputHash: a.hash, kind }, { label: `改为${label}`, success: `已改为${label}` }) }, `改为${label}`)))))
  ].filter(Boolean);
}
function noteIterationFilters(filter, count, total) {
  const options = [['ready', '待启动'], ['decision', '待决策'], ['started', '已发起'], ['done', '已完成'], ['ignored', '已忽略'], ['all', '全部']];
  const open = !!ui.noteIterationFilterOpen;
  const label = options.find(([value]) => value === filter)?.[1] || '全部';
  const close = () => {
    ui.noteIterationFilterOpen = false;
    noteRefreshRecommended();
    document.getElementById('note-iteration-filter-toggle')?.focus({ preventScroll: true });
  };
  return h('div', { class: `note-iteration-filters${open ? ' open' : ''}`, onkeydown: e => { if (e.key === 'Escape' && open) { e.preventDefault(); close(); } } },
    h('button', { id: 'note-iteration-filter-toggle', type: 'button', class: 'note-iteration-filter-toggle', 'data-key': 'note-iteration-filter-toggle', 'aria-expanded': String(open), 'aria-controls': 'note-iteration-filter-options', onclick: () => { ui.noteIterationFilterOpen = !open; noteRefreshRecommended(); } },
      h('span', { class: 'muted' }, '状态筛选'), h('span', { class: 'note-iteration-filter-current' }, `${label} · ${filter === 'all' ? total : count(filter)}`), h('span', { 'aria-hidden': 'true' }, open ? '▴' : '▾')),
    h('div', { id: 'note-iteration-filter-options', class: 'note-iteration-filter-options', role: 'group', 'aria-label': '推荐任务筛选' }, options.map(([value, text]) => h('button', {
      type: 'button', class: `btn small${filter === value ? ' primary' : ''}`, 'data-key': `note-iteration-filter-${value}`, 'aria-pressed': String(filter === value),
      onclick: () => { ui.noteIterationFilter = value; ui.noteIterationsMoreError = ''; if (window.matchMedia('(max-width: 760px)').matches) close(); else noteRefreshRecommended(); void noteLoadIterations(); }
    }, h('span', {}, text), h('span', { class: 'note-iteration-filter-count' }, String(value === 'all' ? total : count(value)))))));
}
/**
 * 推荐任务操作区：待启动/待决策的卡片平铺「忽略 / 发起迭代对话」两个主操作，
 * 忽略后该卡片移出当前筛选、后面的推荐补位，并记录行为供每天 03:00 校准排序算法；
 * 查看会话、暂缓、标记完成／取消完成、重新推荐仍收进「更多」。
 */
function dataRoiEnabled() { return !!ui.noteIterations?.recommendationWindow; }
function noteIterationActions(t, current, decision) {
  const busy = !!ui.noteIterationBusy, pending = !!t.launch;
  const ownBusy = busy && ui.noteIterationBusyTask === t.id;
  const busyLabel = ownBusy ? (ui.noteIterationBusyLabel || '处理') : '';
  // 操作期间菜单保持展开：被点的那项就地换成 spinner，其他操作同时禁用，避免看起来没点上。
  const act = (path, body, label, success) => { void noteIterationAct(`/api/note-iterations/${encodeURIComponent(t.id)}/${path}`, body, { taskId: t.id, label, success }); };
  const menuItem = (label, busyKey, onclick, title) => {
    const active = ownBusy && busyLabel === busyKey;
    return h('button', { type: 'button', role: 'menuitem', class: 'btn small', disabled: busy || pending, title, 'aria-busy': active ? 'true' : null, onclick }, active ? [noteActionSpinner(), `${busyKey}中…`] : label);
  };
  const items = [
    current ? menuItem(t.deferred ? '恢复推荐' : '暂缓', t.deferred ? '恢复推荐' : '暂缓', () => decision(t.deferred ? 'resume' : 'defer', undefined, t.deferred ? '恢复推荐' : '暂缓', t.deferred ? '已恢复推荐' : '已暂缓推荐')) : null,
    (current || t.status === 'started') && !t.released ? menuItem('标记完成', '标记完成', () => act('done', { done: true }, '标记完成', '已标记完成'), '把这个推荐任务的全部来源待办标记完成') : null,
    t.status === 'done' ? menuItem('取消完成', '取消完成', () => act('done', { done: false }, '取消完成', '已取消完成'), '把这个推荐任务的来源待办恢复为未完成') : null,
    t.status === 'started' && t.sessionArchived && !t.released ? menuItem('重新推荐', '重新推荐', () => act('recommend-again', {}, '重新推荐', '已重新推荐'), '让来源待办重新参与推荐') : null,
    ...((current && dataRoiEnabled()) ? [['value', '收益不足'], ['effort', '投入过高'], ['irrelevant', '不相关'], ['other', '其他']].map(([reason, label]) => menuItem(`忽略：${label}`, '忽略', () => act('ignore', { revision: t.revision, reason }, '忽略', '已忽略，后面的推荐已前移'))) : []),
    current && t.noteIds.length > 1 ? menuItem('拆开（合并不合适）', '拆开', () => decision('split', undefined, '拆开', '已拆开并移出合并推荐'), '这几条不该合在一起：拆开后分别推荐，并记为合并反馈') : null
  ].filter(Boolean);
  const open = ui.noteIterationMore === t.id;
  const ignoreActive = ownBusy && busyLabel === '忽略';
  return h('div', { class: 'note-actions' },
    current ? h('button', { type: 'button', class: 'btn small note-iteration-ignore', disabled: busy || pending, 'aria-busy': ignoreActive ? 'true' : null, title: '忽略这份推荐；后面的推荐前移，并记入每天 03:00 的排序校准', onclick: () => act('ignore', { revision: t.revision }, '忽略', '已忽略，后面的推荐已前移') }, ignoreActive ? [noteActionSpinner(), '忽略中…'] : '忽略') : null,
    t.status === 'ready' ? h('button', { class: 'btn primary', disabled: t.launchable === false || !!t.deferred || busy || pending, onclick: () => void noteStartIteration(t) }, '发起迭代对话') : null,
    t.status === 'decision' ? h('span', { class: 'muted small' }, '先处理需求中的决策项，再发起迭代') : null,
    t.sessionId ? h('a', { class: 'btn small', href: `#/rt/${encodeURIComponent(t.sessionId)}` }, t.sessionArchived ? '查看会话（已归档）' : '查看会话') : null,
    items.length ? h('div', { class: 'note-more' },
      h('button', { type: 'button', class: 'btn small', disabled: busy, 'aria-busy': ownBusy ? 'true' : null, 'aria-haspopup': 'menu', 'aria-expanded': String(open), 'aria-label': '更多操作', onclick: () => { ui.noteIterationMore = open ? null : t.id; noteRefreshRecommended(); } }, '更多'),
      open ? h('div', { class: 'note-more-menu', role: 'menu' }, ...items) : null) : null,
    pending ? h('p', { class: 'muted small' }, '创建结果待核对，请在新建会话页使用原请求重试') : null);
}
/** 推荐任务在列表里已经带完整来源；这里只做一次去重，不要在点击后再读一遍。 */
function noteIterationSourceImages(t) {
  return [...new Map((t.sources || []).flatMap(n => n.images || []).map(i => [i.id, i])).values()];
}
/** 老快照没有 requirement 时的兜底：结构与服务端 requirement(t) 一致，服务端仍以自算正文为准。 */
function noteIterationPrompt(t) {
  if (t.requirement) return t.requirement;
  return [t.title, t.scope?.length ? `需求：\n${t.scope.map(x => `- ${x}`).join('\n')}` : '',
    t.order?.length ? `分期交付与依赖：\n${t.order.map(x => `- ${x}`).join('\n')}` : '',
    t.acceptance?.length ? `验收条件：\n${t.acceptance.map(x => `- ${x}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
}
/** 先打开新建页，图片在后台附上（服务端已有，按 id 直接建附件；不行再取回上传），不挡跳转。 */
async function noteAttachIterationImages(images, prep) {
  try {
    // 图片本来就在服务端：先按 id 直接附上，只有没附上的才下载再上传
    const rest = typeof rtAddNoteImages === 'function' ? await rtAddNoteImages('new', images) : images;
    const files = await Promise.all(rest.map(async image => {
      const res = await fetch(noteImageUrl(image), { credentials: 'same-origin' });
      if (!res.ok) throw new Error('来源图片无法读取，请刷新需求');
      return new File([await res.blob()], image.name, { type: image.mimeType });
    }));
    if (prep !== ui.rt.noteLaunch || location.hash !== '#/rt/new') return;
    if (files.length) await rtAddImages('new', files);
  } catch (e) {
    if (prep !== ui.rt.noteLaunch || location.hash !== '#/rt/new') return;
    ui.rt.formError = `来源图片未能附上：${e.message}`;
    announce(ui.rt.formError);
  } finally {
    if (prep === ui.rt.noteLaunch) {
      ui.rt.noteLaunch = null;
      if (ui.rt.busy === 'note-images') ui.rt.busy = '';
      ui.noteIterationBusy = false;
      if (ui.view === 'rt-new') renderMain();
    }
  }
}
/**
 * 发起迭代：列表里已有需求正文和来源（含图片 id），因此先同步切到新建页，图片在后台并行取回。
 * 跳转不再等接口和逐张图片；推荐版本仍由服务端在创建会话时核对，过期会按 409 提示。
 */
function noteStartIteration(t) {
  if (ui.noteIterationBusy) return;
  if (typeof rtStartNewSession !== 'function') { announce('请到「对话」页新建会话'); return; }
  // 记住这条推荐的样子：会话创建成功时待办页可能已重读过摘要，它已不在数据里，
  // 那时仍要能把它画成「刷新中…」而不是凭空消失。
  const launchTasks = (ui.noteIterationLaunchTasks ||= {});
  launchTasks[t.id] = { id: t.id, title: t.title, rank: t.rank, pinned: !!t.pinned };
  for (const id of Object.keys(launchTasks).slice(0, Math.max(0, Object.keys(launchTasks).length - 10))) delete launchTasks[id];
  const images = noteIterationSourceImages(t);
  if (images.length > 8) { ui.noteIterationsError = '来源超过 8 张图片，请拆分迭代后发起，图片不会被静默遗漏'; noteRefreshRecommended(); return; }
  // 取图 / 上传期间禁用发送，避免首条消息在附件还没挂上时就提交。
  const prep = images.length ? (ui.rt.noteLaunch = { taskId: t.id, title: t.title, count: images.length }) : null;
  ui.rt.newEnter = true;
  if (prep) {
    ui.noteIterationBusy = true;
    ui.rt.busy = 'note-images';
  }
  rtStartNewSession(noteIterationPrompt(t), { recommendationId: t.id, revision: t.revision });
  if (prep) void noteAttachIterationImages(images, prep);
}
/** 多选分类之间是「任意命中」：选中一级会带上其所有二级，选中多个分类时取并集。 */
function noteCategoryMatches(note) {
  if (!noteMatchesDebugVisibility(note)) return false;
  const selected = noteCategoryFilterKeys();
  if (!selected.length) return true;
  const own = new Set(noteCategoryKeysFor(note));
  return selected.some(id => own.has(id));
}
function noteSelectCategory(id, noteId) {
  ui.notesFocusNote = noteId || null;
  const keys = id ? [id] : [];
  if (noteCategoryFilterKeys().join(",") === keys.join(",")) {
    ui.notesFilterMenu = null;
    ui.notesMore = null;
    noteRefreshList();
    return;
  }
  // 分类筛选在服务端分页：重新取这个分类的第一页，而不是在旧列表里本地筛。
  noteSetCategoryFilter(keys);
}
/** 分类筛选展开后是两列目录：左列一级分类，右列跟随左列选中的二级分类。 */
const NOTE_CATEGORY_PENCIL = '✎';
/** 列标题固定写「一级分类 / 二级分类」；右列不拿选中一级的名字当标题，免得看成一行的分类。 */
function noteCategoryColumnTitle(level, scope, action) {
  return h('h2', {
    class: `category-browser-column-title category-browser-column-title-${level}`,
    ...(level === 'secondary' && scope ? { title: `${scope} 下的二级分类` } : {})
  }, h('span', { class: 'category-browser-column-title-text' }, level === 'secondary' ? '二级分类' : '一级分类'), action || null);
}
/**
 * 编辑态里的排序草稿：拖动只改这份草稿（order = 期望的全局顺序，parents = 二级的期望父级），点「保存」才写库。
 * 草稿按 ID 叠加在最新目录上，所以编辑态里改名 / 新增 / 删除（立即生效）不会冲掉它。
 */
function noteCategoryApplyDraft(categories, draft) {
  if (!draft) return categories;
  const ids = new Set(categories.map(c => c.id));
  const rank = new Map(draft.order.map((id, i) => [id, i]));
  return categories
    .map((c, i) => {
      const parentId = draft.parents[c.id];
      return { category: parentId && c.parentId && ids.has(parentId) ? { ...c, parentId } : c, key: rank.has(c.id) ? rank.get(c.id) : 1e9 + i };
    })
    .sort((a, b) => a.key - b.key)
    .map(item => item.category);
}
function noteCategoryDraftMove(view, sourceId, { parentId, beforeId }) {
  const list = view.map(c => ({ ...c }));
  const from = list.findIndex(c => c.id === sourceId);
  if (from < 0) return null;
  const [source] = list.splice(from, 1);
  if (parentId !== undefined) source.parentId = parentId;
  const at = beforeId ? list.findIndex(c => c.id === beforeId) : -1;
  if (at >= 0) list.splice(at, 0, source); else list.push(source);
  return { order: list.map(c => c.id), parents: Object.fromEntries(list.filter(c => c.parentId).map(c => [c.id, c.parentId])) };
}
/** 把「当前目录 → 草稿目标」拆成一步步 move：先换父级，再每组从后往前定位；没有变化就是空数组。 */
function noteCategoryDraftSteps(current, target) {
  const sim = current.map(c => ({ id: c.id, parentId: c.parentId || '' }));
  const steps = [];
  const apply = (id, parentId, beforeId) => {
    const from = sim.findIndex(c => c.id === id);
    const [item] = sim.splice(from, 1);
    if (parentId !== undefined) item.parentId = parentId;
    const at = beforeId ? sim.findIndex(c => c.id === beforeId) : -1;
    if (at >= 0) sim.splice(at, 0, item); else sim.push(item);
    steps.push({ path: `/api/note-categories/${encodeURIComponent(id)}`, body: { action: 'move', ...(parentId !== undefined ? { parentId } : {}), beforeId: beforeId || null } });
  };
  for (const c of target) {
    const now = sim.find(x => x.id === c.id);
    if (c.parentId && now && now.parentId !== c.parentId) apply(c.id, c.parentId, null);
  }
  const groups = new Map();
  for (const c of target) { const key = c.parentId || ''; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(c.id); }
  for (const [key, list] of groups) {
    // 当前顺序里「最长保持不动」的那批留着，其余的每个移一步：步数最少，且从后往前放时后继一定已就位。
    const rank = new Map(sim.filter(c => c.parentId === key).map((c, i) => [c.id, i]));
    const pos = list.map(id => rank.get(id) ?? -1);
    const best = pos.map(() => 1), prev = pos.map(() => -1);
    let end = 0;
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < i; j++) if (pos[j] < pos[i] && best[j] + 1 > best[i]) { best[i] = best[j] + 1; prev[i] = j; }
      if (best[i] > best[end]) end = i;
    }
    const stay = new Set();
    for (let i = pos.length ? end : -1; i >= 0; i = prev[i]) stay.add(list[i]);
    for (let i = list.length - 1; i >= 0; i--) if (!stay.has(list[i])) apply(list[i], undefined, list[i + 1] || null);
  }
  return steps;
}
/** 浏览态只存在前端：选中哪一级、是否在改名、哪一行正在改名。 */
function noteCategoryBrowserState() {
  const state = ui.noteCategoryBrowser ||= { primaryId: null, editing: false, editingId: null, editDraft: '', error: '', notice: '', busy: false };
  // 编辑态的合并勾选与新增表单：合并模式下勾选的分类、保留哪一个；新增表单挂在哪一列。
  state.merge ??= false; state.mergeIds ||= []; state.mergeTarget ||= ''; state.adding ??= null; state.addDraft ||= ''; state.draft ??= null;
  const categories = noteScopedCategories(noteScopeOfKind(noteBrowseKind()));
  // 右列联动保留用户手动切换的一级；只有没有有效选择时才从筛选值回填。
  if (!categories.some(c => c.id === state.primaryId && !c.parentId)) {
    const key = ui.notesCategory || noteCategoryFilterKeys()[0];
    const selected = categories.find(c => c.id === key);
    state.primaryId = selected ? selected.parentId || selected.id : categories.find(c => !c.parentId)?.id || null;
  }
  if (state.editingId && !categories.some(c => c.id === state.editingId)) { state.editingId = null; state.editDraft = ''; }
  state.mergeIds = state.mergeIds.filter(id => categories.some(c => c.id === id));
  if (state.mergeTarget && !state.mergeIds.includes(state.mergeTarget)) state.mergeTarget = '';
  if (state.adding?.level === 'secondary' && !categories.some(c => c.id === state.adding.parentId && !c.parentId)) state.adding = null;
  return state;
}
/** 只重绘目录本身，保留两列的滚动位置和正在改名的输入框。 */
function noteRefreshCategoryDirectory() {
  const current = document.getElementById('notes-category-directory');
  if (!current) return false;
  const scroll = {};
  current.querySelectorAll('[data-category-column]').forEach(el => { scroll[el.getAttribute('data-category-column')] = el.scrollTop; });
  const next = noteCategoryDirectory();
  current.replaceWith(next);
  next.querySelectorAll('[data-category-column]').forEach(el => { const top = scroll[el.getAttribute('data-category-column')]; if (top != null) el.scrollTop = top; });
  const focus = ui.noteCategoryBrowserFocus;
  if (focus) {
    ui.noteCategoryBrowserFocus = null;
    next.querySelector(`[data-category-focus="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
  }
  return true;
}
/**
 * 一次目录写入：按顺序提交若干步（合并多个分类时每个来源一步），每步都带上上一步返回的最新版本；
 * 写完重取当前筛选的第一页，目录、筛选栏标签、结果数和列表里的分类标签一起局部刷新。
 */
async function noteCategoryBrowseRun(steps, notice) {
  const state = noteCategoryBrowserState();
  if (state.busy) return;
  state.busy = true; state.error = ''; state.notice = '';
  noteRefreshCategoryDirectory();
  try {
    let snapshot = null;
    for (const step of steps) {
      snapshot = await api(step.path, { method: 'POST', body: JSON.stringify({ ...step.body, version: ui.noteTaxonomy?.version }) });
      if (!snapshot || !Array.isArray(snapshot.categories)) throw new Error('分类目录响应格式无效，请重试');
      noteApplyTaxonomy(snapshot);
      step.applied?.(snapshot);
    }
    state.editingId = null; state.editDraft = '';
    state.merge = false; state.mergeIds = []; state.mergeTarget = ''; state.adding = null; state.addDraft = '';
    invalidateReads(key => key === '/api/notes' || key.startsWith('/api/notes?') || key === '/api/note-categories');
    // 分类名、父级、计数和待办的归属都可能变：重取当前筛选的第一页，让列表与两列统计同步。
    try { noteMergePage(await api(noteListPath()), { syncCursor: true }); } catch { /* 目录已写入，列表下一轮事件会补齐 */ }
    state.notice = notice(snapshot);
    ui.notesError = '';
  } catch (e) {
    state.error = e.message;
    try { noteApplyTaxonomy(await api('/api/note-categories')); } catch { /* 保留原目录，等下一次读取 */ }
  } finally {
    state.busy = false;
    if (ui.view === 'notes') { if (!noteRefreshCategoryDirectory()) noteRefreshList(); else noteRefreshList({ keepDirectory: true }); }
  }
}
/**
 * 本机删除分类后，已加载的待办（含当前页之外的）立刻解绑：去掉被删的分类，一个都不剩就回到待打标。
 * 只在自己执行删除时按被删 ID 精确清除；不靠「目录里找不到」去推断，免得目录比列表旧时误清刚建的分类。
 */
function noteUnbindDeleted(removed) {
  for (const note of [...(ui.notes || []), ...(ui.rt?.linkedNote ? [ui.rt.linkedNote] : [])]) {
    const c = note.classification;
    if (!c) continue;
    const rows = noteClassificationRows(note);
    const kept = rows.filter(row => !removed.has(row.categoryId));
    if (kept.length === rows.length) continue;
    if (kept.length) {
      const first = kept[0];
      Object.assign(c, { categoryId: first.categoryId, primaryId: first.primaryId, primary: first.primary, secondary: first.secondary, categories: kept, categoryIds: kept.map(row => row.categoryId) });
    } else {
      for (const key of ['categoryId', 'primaryId', 'primary', 'secondary', 'categories', 'categoryIds', 'source']) delete c[key];
      c.state = 'pending';
    }
  }
}
function noteCategoryBrowseAction(id, body) {
  const notices = { move: '分类已调整。', merge: '已合并，关联待办已同步。', delete: null, update: '分类名称已更新。' };
  const all = ui.noteTaxonomy?.categories || [];
  const removed = body.action === 'delete' ? new Set([id, ...all.filter(c => c.parentId === id).map(c => c.id)]) : null;
  return noteCategoryBrowseRun([{ path: `/api/note-categories/${encodeURIComponent(id)}`, body, ...(removed ? { applied: () => noteUnbindDeleted(removed) } : {}) }], snapshot =>
    body.action === 'delete'
      ? (snapshot?.unbound ? `已删除，${snapshot.unbound} 条待办已解绑，等待重新打标。` : '已删除。')
      : notices[body.action] || '分类已更新。');
}
/** 编辑态新增分类：一级只要名字，二级挂在当前一级下；同名直接提示，不静默复用。 */
async function noteCategoryAdd(level, parentId, name) {
  const state = noteCategoryBrowserState();
  const scope = noteScopeOfKind(noteBrowseKind());
  const categories = noteScopedCategories(scope);
  const text = String(name || '').trim();
  if (!text) { state.error = '分类名称不能为空'; return noteRefreshCategoryDirectory(); }
  if (categories.some(c => (level === 'primary' ? !c.parentId : c.parentId === parentId) && c.name === text)) {
    state.error = `同级已有「${text}」`; return noteRefreshCategoryDirectory();
  }
  const body = level === 'primary' ? { primary: text, scope } : { primaryId: parentId, secondary: text, scope };
  await noteCategoryBrowseRun([{ path: '/api/note-categories', body }], () => `已新增「${text}」。`);
  // 新增的一级直接选中，右列马上可以往里加二级。
  if (level === 'primary' && !state.error) {
    const created = noteScopedCategories(scope).find(c => !c.parentId && c.name === text);
    if (created) { state.primaryId = created.id; if (ui.view === 'notes') noteRefreshCategoryDirectory(); }
  }
}
/** 删除前二次确认：说明连带删除的二级和会解绑的待办数量。 */
function noteCategoryConfirmDelete(category) {
  const categories = ui.noteTaxonomy?.categories || [];
  const kids = category.parentId ? 0 : categories.filter(c => c.parentId === category.id).length;
  const usage = ui.noteTaxonomy?.categoryUsage?.[category.id] || 0;
  const lines = [`删除分类「${category.name}」${kids ? `及其下 ${kids} 个二级分类` : ''}？`];
  lines.push(usage ? `关联的 ${usage} 条待办会解绑，回到待打标，之后自动重新打标。` : '没有关联的待办。');
  lines.push('此操作不可撤销。');
  if (!window.confirm(lines.join('\n'))) return;
  void noteCategoryBrowseAction(category.id, { action: 'delete' });
}
/** 合并勾选的分类：其余每个都并入保留的那个，关联待办一起迁入；一步一步提交，每步用最新版本。 */
function noteCategoryMergeSelected() {
  const state = noteCategoryBrowserState();
  const categories = ui.noteTaxonomy?.categories || [];
  const picked = state.mergeIds.map(id => categories.find(c => c.id === id)).filter(Boolean);
  if (picked.length < 2) { state.error = '至少勾选 2 个同级分类'; return noteRefreshCategoryDirectory(); }
  const target = picked.find(c => c.id === state.mergeTarget) || picked[0];
  const sources = picked.filter(c => c.id !== target.id);
  const label = c => c.parentId ? `${categories.find(x => x.id === c.parentId)?.name || ''} / ${c.name}` : c.name;
  if (!window.confirm(`把 ${sources.map(c => `「${label(c)}」`).join('、')} 合并到「${label(target)}」？\n关联待办会一起迁入，分类筛选和统计同步更新；此操作不可撤销。`)) return;
  return noteCategoryBrowseRun(
    sources.map(source => ({ path: `/api/note-categories/${encodeURIComponent(source.id)}`, body: { action: 'merge', targetId: target.id } })),
    () => `已合并 ${picked.length} 个分类到「${target.name}」。`);
}
function noteCategoryDirectory() {
  const state = noteCategoryBrowserState();
  const browseKind = noteBrowseKind();
  // 目录里不再单放一列「大类」：标题上标出当前 tab 的那一套，切换看上方类型 tab。
  const kindLabel = NOTE_KIND_LABEL[noteKindFilter()] || '';
  const stored = noteScopedCategories(noteScopeOfKind(browseKind));
  // 排序草稿只在编辑态存在；退出编辑态（保存 / 取消）后一律回到服务端顺序。
  const categories = state.editing ? noteCategoryApplyDraft(stored, state.draft) : stored;
  const draftSteps = state.editing && state.draft ? noteCategoryDraftSteps(stored, categories) : [];
  const dirty = draftSteps.length > 0;
  const counts = noteCategoryCounts();
  const count = id => counts[id] || 0;
  const primaries = categories.filter(c => !c.parentId);
  const selected = primaries.find(c => c.id === state.primaryId) || null;
  const children = selected ? categories.filter(c => c.parentId === selected.id) : [];
  const isSelected = id => noteCategoryFilterKeys().includes(id);
  const rowCategory = new Map();
  let suppressClick = false;
  let press = null;
  let drag = null;
  let hover = null;
  let ghost = null;
  let scrollTimer = null;
  let lastPoint = null;

  const directory = h('div', {
    class: 'notes-category-directory notes-category-browser', id: 'notes-category-directory',
    role: 'group', 'aria-label': '分类筛选',
    oncontextmenu: e => { if (drag) e.preventDefault(); }
  });

  const choose = (id, { keepOpen = false, primaryId } = {}) => {
    if (primaryId !== undefined) state.primaryId = primaryId;
    state.editingId = null; state.error = ''; state.notice = '';
    // 分类筛选一次只选中一个范围：一级就是整个一级，二级就是具体二级。
    noteSetCategoryFilter(id ? [id] : [], { keepOpen });
  };

  const startEdit = id => {
    state.editingId = id; state.editDraft = categories.find(c => c.id === id)?.name || state.editDraft; state.error = ''; state.notice = '';
    ui.noteCategoryBrowserFocus = `category-browser-${id}`;
    noteRefreshCategoryDirectory();
  };

  const clearHover = () => {
    if (hover?.row) hover.row.classList.remove('drop-before', 'drop-after', 'drop-inside');
    hover = null;
  };
  // 长按进入拖动后要拦住触摸滚动，否则手指一动页面就先滚、指针事件被取消。
  const preventTouchScroll = e => { if (drag) e.preventDefault(); };
  const removeDocumentListeners = () => {
    document.removeEventListener('pointermove', onPointerMove, { passive: false });
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerUp);
    document.removeEventListener('touchmove', preventTouchScroll, { passive: false });
  };
  const clearPress = () => {
    if (press?.timer) clearTimeout(press.timer);
    press = null;
    directory.classList.remove('pressing');
    removeDocumentListeners();
  };
  const moveGhost = () => {
    if (!ghost || !lastPoint) return;
    ghost.style.transform = `translate3d(${lastPoint.x + 12}px, ${lastPoint.y + 12}px, 0)`;
  };
  const dragAutoScroll = () => {
    if (!drag || !lastPoint) return;
    const el = document.elementFromPoint(lastPoint.x, lastPoint.y);
    const scroller = el?.closest?.('[data-category-column]') || directory;
    const rect = scroller.getBoundingClientRect();
    if (lastPoint.y < rect.top + 30) scroller.scrollTop -= 9;
    else if (lastPoint.y > rect.bottom - 30) scroller.scrollTop += 9;
  };
  const beginDrag = () => {
    if (!press) return;
    const { row, category, level } = press;
    drag = { row, category, level };
    press = null;
    directory.classList.remove('pressing');
    row.classList.add('drag-source');
    directory.classList.add('dragging');
    ghost = h('div', { class: 'category-browser-ghost' }, category.name);
    document.body.append(ghost);
    lastPoint = { x: row.getBoundingClientRect().left + 16, y: row.getBoundingClientRect().top + 16 };
    moveGhost();
    scrollTimer = setInterval(dragAutoScroll, 16);
  };
  const finishDrag = () => {
    clearHover();
    if (press?.timer) clearTimeout(press.timer);
    press = null;
    drag = null;
    removeDocumentListeners();
    if (scrollTimer) { clearInterval(scrollTimer); scrollTimer = null; }
    ghost?.remove(); ghost = null;
    directory.classList.remove('dragging');
    directory.querySelectorAll('.drag-source').forEach(el => el.classList.remove('drag-source'));
  };
  const placement = (row, source, target, level, y) => {
    const siblings = level === 'primary' ? categories.filter(c => !c.parentId) : categories.filter(c => c.parentId === target.parentId);
    const others = siblings.filter(c => c.id !== source.id);
    const index = others.findIndex(c => c.id === target.id);
    const rect = row.getBoundingClientRect();
    const before = y < rect.top + rect.height / 2;
    return { before, beforeId: before ? target.id : (others[index + 1]?.id ?? null) };
  };
  const setHover = (row, target) => {
    const source = drag.category;
    if (!target || target.id === source.id) { clearHover(); return; }
    const sourcePrimary = !source.parentId, targetPrimary = !target.parentId;
    let next;
    if (sourcePrimary) {
      if (!targetPrimary) { clearHover(); return; }
      // 一级排序：落在目标行上半区排它前面，下半区排它后面。
      const place = placement(row, source, target, 'primary', lastPoint.y);
      next = { row, target, source, kind: 'reorder', beforeId: place.beforeId, before: place.before };
    } else if (targetPrimary) {
      if (target.id === source.parentId) next = { row, target, source, kind: 'reorder', beforeId: null };
      else next = { row, target, source, kind: 'move', parentId: target.id, beforeId: null };
    } else {
      const sameParent = target.parentId === source.parentId;
      const place = placement(row, source, target, 'secondary', lastPoint.y);
      next = { row, target, source, kind: sameParent ? 'reorder' : 'move', beforeId: place.beforeId,
        ...(sameParent ? {} : { parentId: target.parentId }), before: place.before };
    }
    if (hover?.row !== row) { clearHover(); hover = next; }
    else { hover.kind = next.kind; hover.beforeId = next.beforeId; hover.before = next.before; hover.parentId = next.parentId; }
    row.classList.remove('drop-before', 'drop-after', 'drop-inside');
    if (hover.kind === 'move') row.classList.add('drop-inside');
    else row.classList.add(hover.before === false ? 'drop-after' : 'drop-before');
  };
  const onPointerMove = ev => {
    if (press) {
      if (Math.abs(ev.clientX - press.startX) > 8 || Math.abs(ev.clientY - press.startY) > 8) {
        if (press.handle) {
          // 抓手不参与页面滚动（touch-action: none）：按住后一动就直接拖，不必等满长按时间。
          clearTimeout(press.timer);
          beginDrag();
        } else {
          // 触屏滚动常从按钮上滑过：取消长按后还要屏蔽随后的 click，避免误选分类。
          suppressClick = true;
          setTimeout(() => { suppressClick = false; }, 400);
          clearPress();
          return;
        }
      } else return;
    }
    if (!drag) return;
    ev.preventDefault();
    lastPoint = { x: ev.clientX, y: ev.clientY };
    moveGhost();
    const row = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.category-browser-row');
    if (!row || !directory.contains(row)) { clearHover(); return; }
    setHover(row, rowCategory.get(row.getAttribute('data-category-row-id')));
  };
  const onPointerUp = ev => {
    if (press) { clearPress(); return; }
    if (!drag) return;
    const action = hover ? { ...hover } : null;
    finishDrag();
    if (!action) return;
    // 拖动结束后浏览器还会补一次 click：短暂屏蔽，避免顺手切换筛选。
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 400);
    // 拖动只改本地草稿，点「保存」才写库；草稿与服务端顺序一致时直接丢掉。
    const next = noteCategoryDraftMove(categories, action.source.id, { ...(action.kind === 'move' ? { parentId: action.parentId } : {}), beforeId: action.beforeId ?? null });
    if (!next) return;
    state.draft = noteCategoryDraftSteps(stored, noteCategoryApplyDraft(stored, next)).length ? next : null;
    state.error = ''; state.notice = '';
    noteRefreshCategoryDirectory();
  };
  const startPress = (ev, row, category, level, handle = false) => {
    if ((ev.button !== undefined && ev.button !== 0) || state.busy || !state.editing || state.merge) return;
    clearPress();
    press = { row, category, level, handle, startX: ev.clientX, startY: ev.clientY };
    // 按下到进入拖动之间面板不能被后台刷新换掉，否则手势的目标元素没了，拖动直接中断。
    directory.classList.add('pressing');
    // 抓手长按更短：它本来就是为拖动准备的；整行仍保持 420ms 长按。
    press.timer = setTimeout(beginDrag, handle ? 180 : 420);
    document.addEventListener('pointermove', onPointerMove, { passive: false });
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);
    document.addEventListener('touchmove', preventTouchScroll, { passive: false });
  };

  const pinnedRow = (label, value, option = {}) => {
    const active = value ? isSelected(value) : !noteCategoryFilterKeys().length;
    return h('div', { class: `category-browser-row pinned${active ? ' active' : ''}` },
      h('button', {
        type: 'button', class: 'category-browser-name', 'aria-pressed': String(active), 'aria-label': `${label} ${count(value)}`,
        onclick: () => choose(value, option)
      }, h('span', { class: 'category-browser-label' }, label)),
      h('span', { class: 'category-browser-count' }, String(count(value))));
  };
  const rowFor = (category, level) => {
    rowCategory.set(category.id, category);
    if (state.editingId === category.id) {
      const input = h('input', {
        type: 'text', value: state.editDraft, maxlength: '60', disabled: state.busy,
        'aria-label': level === 'primary' ? '一级分类名称' : '二级分类名称',
        'data-category-focus': `category-browser-${category.id}`,
        oninput: e => { state.editDraft = e.target.value; },
        onkeydown: e => { if (e.key === 'Escape') { e.preventDefault(); state.editingId = null; state.editDraft = ''; state.error = ''; noteRefreshCategoryDirectory(); } }
      });
      return h('form', {
        class: 'category-browser-edit',
        onsubmit: e => {
          e.preventDefault();
          const name = input.value.trim();
          if (!name) { state.error = '分类名称不能为空'; noteRefreshCategoryDirectory(); return; }
          void noteCategoryBrowseAction(category.id, { action: 'update', name });
        }
      }, input,
        h('div', { class: 'category-browser-edit-actions' },
          h('button', { type: 'submit', class: 'btn small primary', disabled: state.busy }, '保存'),
          h('button', { type: 'button', class: 'btn small', disabled: state.busy, onclick: () => { state.editingId = null; state.editDraft = ''; state.error = ''; noteRefreshCategoryDirectory(); } }, '取消')));
    }
    const active = isSelected(category.id);
    const merging = state.editing && state.merge;
    const picked = merging && state.mergeIds.includes(category.id);
    const row = h('div', {
      class: `category-browser-row${active ? ' active' : ''}${picked ? ' merge-picked' : ''}${state.editing && level === 'primary' && category.id === state.primaryId ? ' shown' : ''}`,
      'data-category-row-id': category.id,
      'data-category-level': level,
      ...(merging ? { title: '勾选后一起合并' } : state.editing ? { title: level === 'primary' ? '点击查看二级分类' : '点击名称修改' } : {})
    },
      // 合并模式：勾选框；编辑态：小抓手（按住或直接拖就能调顺序）；常规浏览态不提供拖动，避免误拖。
      merging ? h('input', {
        type: 'checkbox', class: 'category-browser-check', checked: picked, disabled: state.busy,
        'aria-label': `选择 ${category.name}`,
        onclick: ev => ev.stopPropagation(),
        onchange: () => toggleMerge(category, level)
      }) : !state.editing ? null : h('span', {
        class: 'category-browser-handle', 'aria-hidden': 'true', 'data-category-handle': category.id,
        title: '按住拖动排序',
        onclick: ev => { ev.stopPropagation(); },
        onpointerdown: ev => { ev.stopPropagation(); startPress(ev, row, category, level, true); }
      }, '⋮⋮'),
      h('button', {
        type: 'button', class: 'category-browser-name',
        'aria-label': merging ? (level === 'primary' ? `查看二级分类：${category.name}` : `合并选择：${category.name}`)
          : state.editing ? (level === 'primary' ? `查看二级分类：${category.name}` : category.name)
          : `${category.name} ${count(category.id)}`,
        'aria-pressed': String(active)
      },
        h('span', { class: 'category-browser-label' }, category.name)),
      // 编辑态：✎ 改名、🗑 删除并排放在名字后面；点它们都不触发整行的点击。
      state.editing && !merging ? h('button', {
        type: 'button', class: 'category-browser-pencil', disabled: state.busy,
        'aria-label': `编辑分类：${category.name}`, title: '改名',
        onclick: ev => { ev.stopPropagation(); startEdit(category.id); }
      }, NOTE_CATEGORY_PENCIL) : null,
      state.editing && !merging ? h('button', {
        type: 'button', class: 'category-browser-delete', disabled: state.busy,
        'aria-label': `删除分类：${category.name}`, title: '删除分类',
        onclick: ev => { ev.stopPropagation(); noteCategoryConfirmDelete(category); }
      }, '🗑') : null,
      h('span', { class: 'category-browser-count' }, String(count(category.id))));
    // 整行都可点：数量那一侧和空白处也要能切换第一列 / 选中二级。
    row.addEventListener('click', () => {
      if (suppressClick) { suppressClick = false; return; }
      if (merging) {
        // 合并模式下点一级名字只是切换右列去看它的二级；勾选一律用勾选框，二级整行都能点选。
        if (level === 'primary') { state.primaryId = category.id; noteRefreshCategoryDirectory(); } else toggleMerge(category, level);
        return;
      }
      if (state.editing) {
        // 编辑态：点一级切换右列（好去增删它的二级），点二级直接改名；一级改名用 ✎。
        if (level === 'primary') { state.primaryId = category.id; state.adding = null; state.error = ''; noteRefreshCategoryDirectory(); } else startEdit(category.id);
        return;
      }
      // 一级本身就是一个完整的筛选范围：点一级即选中它下面全部二级，可继续多选其他一级。
      // 点二级则进一步收窄到具体二级；一级点击同时联动右列。
      if (level === 'primary') choose(category.id, { keepOpen: true, primaryId: category.id });
      else choose(category.id, { keepOpen: false, primaryId: category.parentId });
    });
    if (!state.editing) row.addEventListener('pointerdown', watchScrollGesture);
    return row;
  };

  // 常规浏览态没有拖动，但触屏滚动常从按钮上滑过：位移超过阈值就屏蔽随后的 click，避免误选分类。
  const watchScrollGesture = ev => {
    const startX = ev.clientX, startY = ev.clientY;
    let moved = false;
    const onMove = e => { if (Math.abs(e.clientX - startX) > 8 || Math.abs(e.clientY - startY) > 8) moved = true; };
    const onEnd = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onEnd);
      document.removeEventListener('pointercancel', onEnd);
      if (moved) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 400); }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onEnd);
    document.addEventListener('pointercancel', onEnd);
  };

  // 合并只能在同级之间：换了层级就从头勾选。
  const toggleMerge = (category, level) => {
    const first = categories.find(c => c.id === state.mergeIds[0]);
    if (first && (first.parentId ? 'secondary' : 'primary') !== level) state.mergeIds = [];
    state.mergeIds = state.mergeIds.includes(category.id) ? state.mergeIds.filter(id => id !== category.id) : [...state.mergeIds, category.id];
    if (!state.mergeIds.includes(state.mergeTarget)) state.mergeTarget = '';
    state.error = '';
    noteRefreshCategoryDirectory();
  };
  const startAdd = (level, parentId) => {
    state.adding = { level, parentId }; state.addDraft = ''; state.error = ''; state.notice = '';
    ui.noteCategoryBrowserFocus = 'category-browser-add';
    noteRefreshCategoryDirectory();
    // 输入框在列表顶部：列表滚到下面时先回到顶，保证看得见。
    document.querySelectorAll('#notes-category-directory [data-category-column]').forEach(el => { el.scrollTop = 0; });
  };
  const closeAdd = () => { state.adding = null; state.addDraft = ''; state.error = ''; noteRefreshCategoryDirectory(); };
  const isAdding = (level, parentId) => !!state.adding && state.adding.level === level && state.adding.parentId === parentId;
  // 编辑态：新增入口在列标题栏右侧（与顶部按钮同款）；点开后输入框出现在该列列表顶部。
  const addButton = (level, parentId) => {
    if (!state.editing || state.merge) return null;
    const label = level === 'primary' ? '新增一级分类' : '新增二级分类';
    return h('button', {
      type: 'button', class: `category-browser-edit-toggle category-browser-title-add${isAdding(level, parentId) ? ' active' : ''}`,
      'aria-label': label, 'aria-expanded': String(isAdding(level, parentId)), title: label, disabled: state.busy,
      onclick: () => { if (isAdding(level, parentId)) closeAdd(); else startAdd(level, parentId); }
    }, '＋ 新增');
  };
  const addForm = (level, parentId) => {
    if (!state.editing || state.merge) return null;
    if (isAdding(level, parentId)) {
      const input = h('input', {
        type: 'text', value: state.addDraft, maxlength: '60', disabled: state.busy,
        'aria-label': level === 'primary' ? '新增一级分类名称' : '新增二级分类名称',
        'data-category-focus': 'category-browser-add',
        oninput: e => { state.addDraft = e.target.value; },
        onkeydown: e => { if (e.key === 'Escape') { e.preventDefault(); closeAdd(); } }
      });
      return h('form', {
        class: 'category-browser-edit category-browser-add-form',
        onsubmit: e => { e.preventDefault(); void noteCategoryAdd(level, parentId, input.value); }
      }, input,
        h('div', { class: 'category-browser-edit-actions' },
          h('button', { type: 'submit', class: 'btn small primary', disabled: state.busy }, '添加'),
          h('button', { type: 'button', class: 'btn small', disabled: state.busy, onclick: closeAdd }, '取消')));
    }
    return null;
  };
  // 合并模式底栏：选了几个、保留哪一个，提交后一次合并。
  const mergeBar = () => {
    const picked = state.mergeIds.map(id => categories.find(c => c.id === id)).filter(Boolean);
    const label = c => c.parentId ? `${categories.find(x => x.id === c.parentId)?.name || ''} / ${c.name}` : c.name;
    const target = picked.find(c => c.id === state.mergeTarget) || picked[0];
    const select = picked.length >= 2 ? h('select', {
      'aria-label': '合并后保留',
      onchange: e => { state.mergeTarget = e.target.value; }
    }, picked.map(c => h('option', { value: c.id }, label(c)))) : null;
    if (select && target) select.value = target.id;
    return h('div', { class: 'category-browser-merge-bar', role: 'region', 'aria-label': '合并操作' },
      h('span', { class: 'muted small' }, picked.length < 2 ? `已选 ${picked.length} 个，至少勾选 2 个同级分类` : `已选 ${picked.length} 个，合并后保留：`),
      select,
      h('div', { class: 'category-browser-edit-actions' },
        h('button', { type: 'button', class: 'btn small primary', disabled: state.busy || picked.length < 2, onclick: () => void noteCategoryMergeSelected() }, '合并'),
        h('button', { type: 'button', class: 'btn small', disabled: state.busy, onclick: () => { state.merge = false; state.mergeIds = []; state.mergeTarget = ''; state.error = ''; noteRefreshCategoryDirectory(); } }, '取消')));
  };

  const resetEditing = () => { state.editingId = null; state.editDraft = ''; state.merge = false; state.mergeIds = []; state.mergeTarget = ''; state.adding = null; state.addDraft = ''; state.error = ''; state.notice = ''; };
  directory.append(...[
    h('header', { class: 'category-browser-head' },
      h('div', { class: 'category-browser-heading' },
        h('strong', {}, kindLabel ? `分类 · ${kindLabel}` : '分类'),
        h('span', { class: 'muted small' }, state.editing
          ? (state.merge ? '勾选要合并的同级分类，选好保留哪一个再提交'
            : dirty ? '顺序已调整：点「保存」生效，「取消」放弃'
            : '点一级看二级，✎ 改名，🗑 删除，拖抓手调顺序')
          : '点一级选整个分类，点二级筛选；点「编辑」整理分类（分类跟着上方类型 tab 走）')),
      h('div', { class: 'category-browser-head-actions' },
        state.editing ? h('button', {
          type: 'button', class: `category-browser-edit-toggle${state.merge ? ' active' : ''}`,
          'aria-pressed': String(state.merge), disabled: state.busy,
          onclick: () => { const on = !state.merge; resetEditing(); state.merge = on; noteRefreshCategoryDirectory(); }
        }, '合并') : null,
        state.editing && dirty ? h('button', {
          type: 'button', class: 'category-browser-edit-toggle', disabled: state.busy,
          onclick: () => { resetEditing(); state.draft = null; state.editing = false; noteRefreshCategoryDirectory(); }
        }, '取消') : null,
        h('button', {
          type: 'button', class: `category-browser-edit-toggle${state.editing ? ' active' : ''}`,
          'aria-pressed': String(state.editing), disabled: state.busy,
          onclick: async () => {
            if (!state.editing) { resetEditing(); state.draft = null; state.editing = true; noteRefreshCategoryDirectory(); return; }
            if (!dirty) { resetEditing(); state.draft = null; state.editing = false; noteRefreshCategoryDirectory(); return; }
            // 保存排序：逐步提交（每步带最新版本），成功后退出编辑态；失败就留在编辑态显示原因，草稿作废、回到服务端顺序。
            await noteCategoryBrowseRun(draftSteps, () => '排序已保存。');
            state.draft = null;
            if (!state.error) state.editing = false;
            noteRefreshCategoryDirectory();
          }
        }, state.editing ? (dirty ? '保存' : '完成') : '编辑'))),
    noteKindFilter() === "todo" ? h("div", { class: "notes-debug-filter" },
      h("button", { type: "button", role: "switch", class: `notes-filter${ui.notesShowDebug ? " active" : ""}`,
        "aria-label": "显示 debug", "aria-checked": String(!!ui.notesShowDebug),
        onclick: () => noteSetShowDebug(!ui.notesShowDebug) }, "显示 debug"),
      h("span", { class: "muted small" }, ui.notesShowDebug ? "已显示 debug" : "已隐藏 debug")) : null,
    state.error ? h('p', { class: 'category-browser-feedback error', role: 'alert' }, state.error) : null,
    state.notice ? h('p', { class: 'category-browser-feedback success', role: 'status' }, state.notice) : null,
    h('div', { class: 'category-browser-columns' },
      h('section', { class: 'category-browser-column', 'data-category-column': 'primary', 'aria-label': '一级分类' },
        noteCategoryColumnTitle('primary', undefined, addButton('primary', '')),
        addForm('primary', ''),
        pinnedRow('全部分类', ''),
        counts.pending ? pinnedRow('待分类', 'pending') : null,
        ...primaries.map(c => rowFor(c, 'primary')),
        !primaries.length && !state.editing ? h('p', { class: 'muted small category-browser-empty' }, '分类将在记录自动打标后出现在这里。') : null),
      h('section', { class: 'category-browser-column', 'data-category-column': 'secondary', 'aria-label': '二级分类' },
        noteCategoryColumnTitle('secondary', selected?.name, selected ? addButton('secondary', selected.id) : null),
        selected ? addForm('secondary', selected.id) : null,
        selected ? pinnedRow('全部二级', selected.id, { keepOpen: true, primaryId: selected.id }) : null,
        ...children.map(c => rowFor(c, 'secondary')),
        selected && !children.length && !state.editing ? h('p', { class: 'muted small category-browser-empty' }, '这个一级分类下还没有二级分类。') : null,
        !selected ? h('p', { class: 'muted small category-browser-empty' }, '先选一个一级分类。') : null)),
    state.editing && state.merge ? mergeBar() : null,
  ].filter(Boolean));

  return directory;
}

/**
 * 分类待处理项（待确认 / 打标失败）只在卡片内处理：确认、修改、填写分类与重试分类都在卡片上，
 * 列表上方不再重复列一份。这里只保留「自动分类未启用」提示。
 */
function noteCategoryControls() {
  const taxonomy = ui.noteTaxonomy || { categories: [] };
  if (taxonomy.enabled !== false) return null;
  return h('section', { id: 'notes-category-controls', class: 'notes-category-controls', 'aria-label': '待办分类' },
    h('p', { class: 'muted small' }, '自动分类未启用'));
}
function noteApplyTaxonomy(taxonomy) {
  ui.noteTaxonomy = taxonomy;
  const categoryBefore = noteCategoryFilterKeys().join(",");
  const resolve = (id) => taxonomy.categories.find(x => x.id === (taxonomy.redirects?.[id] || id));
  for (const note of [...(ui.notes || []), ...(ui.rt?.linkedNote ? [ui.rt.linkedNote] : [])]) {
    const c = note.classification;
    if (!c) continue;
    const rows = noteClassificationRows(note).map(row => {
      const leaf = resolve(row.categoryId);
      const parent = leaf && taxonomy.categories.find(x => x.id === leaf.parentId);
      return leaf && parent ? { categoryId: leaf.id, primaryId: parent.id, primary: parent.name, secondary: leaf.name } : null;
    }).filter(Boolean);
    if (Array.isArray(c.categories) || rows.length) {
      const first = rows[0];
      Object.assign(c, {
        ...(first ? { categoryId: first.categoryId, primaryId: first.primaryId, primary: first.primary, secondary: first.secondary } : {}),
        ...(rows.length ? { categories: rows, categoryIds: rows.map(row => row.categoryId) } : {})
      });
    }
  }
  const keys = noteCategoryFilterKeys().map(key => key === 'pending' ? key : (taxonomy.redirects?.[key] || key));
  const valid = [...new Set(keys)].filter(key => key === 'pending' || taxonomy.categories.some(c => c.id === key));
  ui.notesCategories = valid;
  ui.notesCategory = valid.length === 1 ? valid[0] : '';
  // 选中的分类被合并 / 删除后条件变了：按新条件重新取第一页，别停在旧分类的空列表上。
  if (!ui.notesManagement && valid.join(",") !== categoryBefore && ui.view === "notes") noteQueryReload();
}
function noteRememberManagementPosition() {
  ui.notesManagementPosition = { window: window.scrollY, main: document.getElementById('main')?.scrollTop || 0 };
}
function noteManagementRefresh() { if (ui.view === 'notes') renderMain(); }
/** 分类管理页可分别查看笔记、待办、日程的独立目录。 */
function noteManagementScope() { return noteScopeOfKind(ui.noteCategoryManagement?.scope); }
function noteManagementState() {
  const state = ui.noteCategoryManagement ||= {};
  state.expanded ||= {};
  state.query ||= '';
  state.mergeMode = !!state.mergeMode;
  state.mergeSelection ||= [];
  state.mergeError ||= '';
  state.editingId ||= '';
  state.editName ||= '';
  state.editError ||= '';
  state.addOpen = !!state.addOpen;
  state.addLevel ||= 'primary';
  state.addPrimaryId ||= '';
  state.addName ||= '';
  state.addError ||= '';
  return state;
}
function noteManagementPath(category, categories) {
  const parent = category?.parentId && categories.find(c => c.id === category.parentId);
  return category ? `${parent ? parent.name + ' / ' : ''}${category.name}` : '';
}
function noteManagementLevel(category) { return category?.parentId ? 'secondary' : 'primary'; }
function noteManagementExpanded(state, id) { return state.expanded[id] !== false; }
async function noteManagementApplyResult(result) {
  if (result && Array.isArray(result.categories)) { noteApplyTaxonomy(result); return result; }
  const fresh = await api('/api/note-categories');
  noteApplyTaxonomy(fresh);
  return { ...fresh, createdCategoryId: result?.createdCategoryId };
}
function noteManagementFeedback() {
  if (ui.notesCategoryManageError) return h('div', { class: 'category-feedback error', role: 'alert' }, ui.notesCategoryManageError,
    h('p', { class: 'small' }, '目录已更新时，请重新选择分类后再提交。'));
  if (ui.notesCategoryManageSuccess) return h('p', { class: 'category-feedback success', role: 'status' }, ui.notesCategoryManageSuccess);
  return null;
}
function noteManagementToggleExpand(id) {
  const state = noteManagementState();
  state.expanded[id] = !noteManagementExpanded(state, id);
  noteManagementRefresh();
}
function noteManagementExpandAll(expand) {
  const state = noteManagementState();
  for (const category of noteScopedCategories(noteManagementScope()).filter(c => !c.parentId)) state.expanded[category.id] = expand;
  noteManagementRefresh();
}
function noteManagementStartEdit(category) {
  if (ui.notesClassificationBusy) return;
  const state = noteManagementState();
  state.editingId = category.id;
  state.editName = category.name;
  state.editError = '';
  state.mergeMode = false; state.mergeSelection = []; state.mergeError = '';
  ui.notesCategoryManageError = ''; ui.notesCategoryManageSuccess = '';
  noteManagementRefresh();
  requestAnimationFrame(() => {
    const input = document.getElementById('category-inline-name');
    input?.focus({ preventScroll: true });
    if (input && typeof input.select === 'function') input.select();
  });
}
function noteManagementCancelEdit() {
  const state = noteManagementState();
  state.editingId = ''; state.editName = ''; state.editError = '';
  noteManagementRefresh();
}
async function noteManagementSaveEdit(category) {
  if (ui.notesClassificationBusy) return;
  const state = noteManagementState();
  const name = state.editName.trim();
  if (!name) {
    state.editError = '分类名称必须为 1–60 字的单行文字';
    noteManagementRefresh();
    requestAnimationFrame(() => document.getElementById('category-inline-name')?.focus({ preventScroll: true }));
    return;
  }
  if (name === category.name) { noteManagementCancelEdit(); return; }
  const generation = ui.routeGeneration;
  ui.notesClassificationBusy = true; state.editError = '';
  noteManagementRefresh();
  try {
    const taxonomy = await noteManagementApplyResult(await api(`/api/note-categories/${encodeURIComponent(category.id)}`, { method: 'POST', body: JSON.stringify({ action: 'update', name, version: ui.noteTaxonomy?.version }) }));
    state.editingId = ''; state.editName = '';
    ui.notesCategoryManageSuccess = `已更新「${name}」，分类路径已同步。`;
    invalidateReads(key => key === '/api/notes' || key.startsWith('/api/notes?') || key === '/api/note-categories');
    try { noteMergePage(await api(noteListPath())); }
    catch { ui.notesError = '分类已更新，待办列表暂未刷新。返回待办后可重新读取。'; }
  } catch (e) {
    state.editError = e.message;
    try { noteApplyTaxonomy(await api('/api/note-categories')); } catch {}
  } finally {
    ui.notesClassificationBusy = false;
    if (generation === ui.routeGeneration && ui.view === 'notes') {
      noteManagementRefresh();
      if (state.editingId) requestAnimationFrame(() => document.getElementById('category-inline-name')?.focus({ preventScroll: true }));
    }
  }
}
function noteManagementOpenAdd() {
  if (ui.notesClassificationBusy) return;
  const state = noteManagementState();
  const primaries = noteScopedCategories(noteManagementScope()).filter(c => !c.parentId);
  state.addOpen = true;
  state.addLevel = 'primary';
  state.addPrimaryId = primaries[0]?.id || '';
  state.addName = '';
  state.addError = '';
  state.editingId = ''; state.editError = '';
  ui.notesCategoryManageError = ''; ui.notesCategoryManageSuccess = '';
  noteManagementRefresh();
  requestAnimationFrame(() => document.getElementById('category-add-name')?.focus({ preventScroll: true }));
}
function noteManagementCloseAdd() {
  if (ui.notesClassificationBusy) return;
  const state = noteManagementState();
  state.addOpen = false; state.addName = ''; state.addError = '';
  noteManagementRefresh();
}
function noteManagementSetAddLevel(level) {
  if (ui.notesClassificationBusy) return;
  const state = noteManagementState();
  const primaries = noteScopedCategories(noteManagementScope()).filter(c => !c.parentId);
  if (level === 'secondary' && !primaries.length) return;
  state.addLevel = level;
  state.addName = '';
  state.addError = '';
  if (level === 'secondary' && !primaries.some(p => p.id === state.addPrimaryId)) state.addPrimaryId = primaries[0]?.id || '';
  noteManagementRefresh();
  requestAnimationFrame(() => document.getElementById('category-add-name')?.focus({ preventScroll: true }));
}
async function noteManagementAddSubmit() {
  if (ui.notesClassificationBusy) return;
  const state = noteManagementState();
  const name = state.addName.trim();
  if (!name) {
    state.addError = state.addLevel === 'primary' ? '请填写一级分类名称' : '请填写二级分类名称';
    noteManagementRefresh();
    requestAnimationFrame(() => document.getElementById('category-add-name')?.focus({ preventScroll: true }));
    return;
  }
  if (state.addLevel === 'secondary' && !state.addPrimaryId) {
    state.addError = '请选择所属一级分类';
    noteManagementRefresh();
    return;
  }
  const generation = ui.routeGeneration;
  ui.notesClassificationBusy = true; state.addError = '';
  noteManagementRefresh();
  try {
    const body = state.addLevel === 'primary'
      ? { action: 'create', primary: name, scope: noteManagementScope(), version: ui.noteTaxonomy?.version }
      : { action: 'create', primaryId: state.addPrimaryId, secondary: name, scope: noteManagementScope(), version: ui.noteTaxonomy?.version };
    const taxonomy = await noteManagementApplyResult(await api('/api/note-categories', { method: 'POST', body: JSON.stringify(body) }));
    const categories = taxonomy.categories || [];
    const created = categories.find(c => c.id === taxonomy.createdCategoryId) || categories.find(c => c.parentId && c.name === name);
    if (created?.parentId) state.expanded[created.parentId] = true;
    else if (created) state.expanded[created.id] = true;
    state.addOpen = false; state.addName = ''; state.addError = '';
    ui.notesCategoryManageSuccess = created ? `已新增「${noteManagementPath(created, categories)}」。` : '已新增分类。';
    invalidateReads(key => key === '/api/notes' || key.startsWith('/api/notes?') || key === '/api/note-categories');
    try { noteMergePage(await api(noteListPath())); }
    catch { ui.notesError = '分类已更新，待办列表暂未刷新。返回待办后可重新读取。'; }
  } catch (e) {
    state.addError = e.message;
    try { noteApplyTaxonomy(await api('/api/note-categories')); } catch {}
  } finally {
    ui.notesClassificationBusy = false;
    if (generation === ui.routeGeneration && ui.view === 'notes') {
      noteManagementRefresh();
      if (state.addOpen) requestAnimationFrame(() => document.getElementById('category-add-name')?.focus({ preventScroll: true }));
    }
  }
}
function noteManagementToggleMerge() {
  if (ui.notesClassificationBusy) return;
  const state = noteManagementState();
  state.mergeMode = !state.mergeMode;
  state.mergeSelection = []; state.mergeError = '';
  state.editingId = ''; state.editError = '';
  ui.notesCategoryManageError = ''; ui.notesCategoryManageSuccess = '';
  noteManagementRefresh();
}
function noteManagementToggleMergeSelection(category) {
  if (!stateMergeAvailable()) return;
  const state = noteManagementState();
  const categories = ui.noteTaxonomy?.categories || [];
  const index = state.mergeSelection.indexOf(category.id);
  if (index >= 0) {
    state.mergeSelection.splice(index, 1); state.mergeError = '';
    noteManagementRefresh();
    return;
  }
  if (state.mergeSelection.length >= 2) return;
  if (state.mergeSelection.length === 1) {
    const first = categories.find(c => c.id === state.mergeSelection[0]);
    if (first && noteManagementLevel(first) !== noteManagementLevel(category)) {
      state.mergeError = '只能合并同一级分类';
      noteManagementRefresh();
      return;
    }
  }
  state.mergeSelection.push(category.id);
  state.mergeError = '';
  noteManagementRefresh();
}
function stateMergeAvailable() { return noteManagementState().mergeMode && !ui.notesClassificationBusy; }
function noteManagementSwapMergeSelection() {
  const state = noteManagementState();
  if (state.mergeSelection.length !== 2) return;
  state.mergeSelection.reverse();
  noteManagementRefresh();
}
async function noteManagementConfirmMerge() {
  if (ui.notesClassificationBusy) return;
  const state = noteManagementState();
  const categories = ui.noteTaxonomy?.categories || [];
  const [source, target] = state.mergeSelection.map(id => categories.find(c => c.id === id));
  if (!source || !target || noteManagementLevel(source) !== noteManagementLevel(target)) return;
  const generation = ui.routeGeneration;
  const name = noteManagementPath(source, categories);
  ui.notesClassificationBusy = true; state.mergeError = ''; ui.notesCategoryManageError = ''; ui.notesCategoryManageSuccess = '';
  noteManagementRefresh();
  try {
    const taxonomy = await noteManagementApplyResult(await api(`/api/note-categories/${encodeURIComponent(source.id)}`, { method: 'POST', body: JSON.stringify({ action: 'merge', targetId: target.id, version: ui.noteTaxonomy?.version }) }));
    if (target.parentId) state.expanded[target.parentId] = true;
    else state.expanded[target.id] = true;
    state.mergeMode = false; state.mergeSelection = []; state.mergeError = '';
    ui.notesCategoryManageSuccess = `已合并「${name}」，关联待办已同步。`;
    invalidateReads(key => key === '/api/notes' || key.startsWith('/api/notes?') || key === '/api/note-categories');
    try { noteMergePage(await api(noteListPath())); }
    catch { ui.notesError = '分类已更新，待办列表暂未刷新。返回待办后可重新读取。'; }
  } catch (e) {
    state.mergeError = e.message;
    try { noteApplyTaxonomy(await api('/api/note-categories')); } catch {}
  } finally {
    ui.notesClassificationBusy = false;
    if (generation === ui.routeGeneration && ui.view === 'notes') noteManagementRefresh();
  }
}
function noteManagementNode(category, categories, state, child = false) {
  const path = noteManagementPath(category, categories);
  const busy = !!ui.notesClassificationBusy;
  const editing = state.editingId === category.id;
  const checked = state.mergeSelection.includes(category.id);
  const first = state.mergeSelection.length === 1 && categories.find(c => c.id === state.mergeSelection[0]);
  const incompatible = !!first && noteManagementLevel(first) !== noteManagementLevel(category);
  const select = state.mergeMode ? h('input', {
    type: 'checkbox', class: 'category-select', checked, disabled: busy || (state.mergeSelection.length >= 2 && !checked) || incompatible,
    'aria-label': `选择 ${path}`,
    onchange: () => noteManagementToggleMergeSelection(category)
  }) : null;
  const children = categories.filter(c => c.parentId === category.id);
  const expanded = noteManagementExpanded(state, category.id);
  const disclosure = !child && children.length ? h('button', {
    type: 'button', class: 'category-expand', 'aria-label': `${expanded ? '折叠' : '展开'} ${category.name}`,
    'aria-expanded': String(expanded), onclick: () => noteManagementToggleExpand(category.id)
  }, expanded ? '▾' : '▸') : h('span', { class: 'category-expand-spacer', 'aria-hidden': 'true' });
  const name = editing ? h('span', { class: 'category-inline-edit' },
    h('input', {
      id: 'category-inline-name', class: 'category-inline-input', value: state.editName, maxlength: '60', required: true,
      'aria-label': '分类名称', 'data-key': 'category-inline-name', disabled: busy,
      oninput: e => { state.editName = e.target.value; },
      onkeydown: e => {
        if (e.key === 'Enter') { e.preventDefault(); void noteManagementSaveEdit(category); }
        if (e.key === 'Escape') { e.preventDefault(); noteManagementCancelEdit(); }
      }
    }),
    h('button', { type: 'button', class: 'btn small primary', disabled: busy, onclick: () => void noteManagementSaveEdit(category) }, busy ? '保存中…' : '保存修改'),
    h('button', { type: 'button', class: 'btn small', disabled: busy, onclick: noteManagementCancelEdit }, '取消')
  ) : h('button', {
    type: 'button', class: 'category-node-name', 'aria-label': category.name, title: `${path}（点击修改名称）`,
    disabled: busy, onclick: () => noteManagementStartEdit(category)
  }, category.name);
  const count = ui.noteTaxonomy?.categoryUsage?.[category.id] ?? 0;
  return h('li', { class: `category-node${child ? ' child' : ''}${editing ? ' editing' : ''}`, 'data-category-id': category.id, 'aria-label': path },
    h('div', { class: 'category-node-row' }, select, disclosure, name, h('span', { class: 'category-node-count', title: `关联 ${count} 条待办` }, String(count)),
      editing ? null : h('button', { type: 'button', class: 'btn small category-edit-button', disabled: busy, onclick: () => noteManagementStartEdit(category) }, '修改')),
    editing && state.editError ? h('p', { class: 'category-inline-error', role: 'alert' }, state.editError) : null);
}
function noteManagementTree(categories, state) {
  const query = state.query.trim().toLowerCase();
  const groups = categories.filter(c => !c.parentId).map(parent => {
    const children = categories.filter(c => c.parentId === parent.id);
    const parentHit = !query || parent.name.toLowerCase().includes(query);
    const shown = query ? (parentHit ? children : children.filter(c => c.name.toLowerCase().includes(query))) : (noteManagementExpanded(state, parent.id) ? children : []);
    if (query && !parentHit && !shown.length) return null;
    return h('li', { class: 'category-group' },
      h('ul', { class: 'category-group-list' }, noteManagementNode(parent, categories, state)),
      shown.length ? h('ul', { class: 'category-children' }, shown.map(c => noteManagementNode(c, categories, state, true))) : null);
  }).filter(Boolean);
  return h('ul', { class: 'category-tree', 'aria-label': '分类目录' }, groups.length ? groups : h('li', { class: 'category-tree-empty muted' }, categories.length ? '没有匹配的分类。' : '还没有分类，点击「新增」建立第一个分类。'));
}
function noteManagementMergeBar(categories, state) {
  const selected = state.mergeSelection.map(id => categories.find(c => c.id === id)).filter(Boolean);
  const [source, target] = selected;
  const ready = selected.length === 2 && source && target && noteManagementLevel(source) === noteManagementLevel(target);
  const text = selected.length === 0 ? '勾选两个同级分类开始合并'
    : selected.length === 1 ? `已选「${noteManagementPath(selected[0], categories)}」，再勾选一个同级分类`
      : ready ? `保留「${noteManagementPath(target, categories)}」，合并「${noteManagementPath(source, categories)}」` : '只能合并同一级分类';
  return h('section', { class: 'category-merge-bar', role: 'region', 'aria-label': '合并操作' },
    h('div', { class: 'category-merge-copy' }, h('strong', {}, '合并分类'), h('span', { class: 'muted small' }, text)),
    state.mergeError ? h('p', { class: 'category-inline-error', role: 'alert' }, state.mergeError) : null,
    h('div', { class: 'category-merge-actions' },
      ready ? h('button', { type: 'button', class: 'btn small', 'aria-label': '交换保留目标', onclick: noteManagementSwapMergeSelection }, '交换保留目标') : null,
      h('button', { type: 'button', class: 'btn primary small', 'aria-label': '确认合并', disabled: !ready || !!ui.notesClassificationBusy, onclick: () => void noteManagementConfirmMerge() }, ui.notesClassificationBusy ? '正在合并…' : '确认合并')));
}
function noteManagementAddDialog(categories, state) {
  if (!state.addOpen) return null;
  const primaries = categories.filter(c => !c.parentId);
  const busy = !!ui.notesClassificationBusy;
  const secondary = state.addLevel === 'secondary';
  const close = () => noteManagementCloseAdd();
  const fields = secondary ? [
    h('label', { for: 'category-add-parent', class: 'category-field-label' }, '所属一级分类'),
    h('select', {
      id: 'category-add-parent', class: 'category-modal-select', 'aria-label': '所属一级分类', 'data-key': 'category-add-parent', disabled: busy,
      onchange: e => { state.addPrimaryId = e.target.value; }
    }, primaries.map(p => h('option', { value: p.id, selected: p.id === state.addPrimaryId }, p.name))),
    h('label', { for: 'category-add-name', class: 'category-field-label' }, '二级分类名称'),
    h('input', {
      id: 'category-add-name', class: 'category-modal-input', value: state.addName, maxlength: '60', 'aria-label': '二级分类名称',
      'data-key': 'category-add-name', placeholder: '例如：清洁', autocomplete: 'off', disabled: busy,
      oninput: e => { state.addName = e.target.value; },
      onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); void noteManagementAddSubmit(); } }
    })
  ] : [
    h('label', { for: 'category-add-name', class: 'category-field-label' }, '一级分类名称'),
    h('input', {
      id: 'category-add-name', class: 'category-modal-input', value: state.addName, maxlength: '60', 'aria-label': '一级分类名称',
      'data-key': 'category-add-name', placeholder: '例如：家庭', autocomplete: 'off', disabled: busy,
      oninput: e => { state.addName = e.target.value; },
      onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); void noteManagementAddSubmit(); } }
    })
  ];
  return h('div', { class: 'category-modal-backdrop', onclick: close },
    h('div', {
      class: 'category-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '新增分类',
      onclick: e => e.stopPropagation(),
      onkeydown: e => { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    },
      h('div', { class: 'category-modal-head' }, h('h2', {}, '新增分类'), h('button', { type: 'button', class: 'category-modal-close', 'aria-label': '关闭新增窗口', disabled: busy, onclick: close }, '×')),
      h('div', { class: 'category-level-switch inpage-tabs', role: 'group', 'aria-label': '新增级别' },
        h('button', { type: 'button', class: secondary ? '' : 'active', 'aria-pressed': String(!secondary), disabled: busy, onclick: () => noteManagementSetAddLevel('primary') }, '一级分类'),
        h('button', { type: 'button', class: secondary ? 'active' : '', 'aria-pressed': String(secondary), disabled: busy || !primaries.length, onclick: () => noteManagementSetAddLevel('secondary') }, '二级分类')),
      fields,
      state.addError ? h('p', { class: 'category-inline-error', role: 'alert' }, state.addError) : null,
      h('div', { class: 'category-modal-actions' },
        h('button', { type: 'button', class: 'btn', disabled: busy, onclick: close }, '取消'),
        h('button', { type: 'button', class: 'btn primary', disabled: busy, onclick: () => void noteManagementAddSubmit() }, busy ? '正在新增…' : '确认'))));
}
/** 所有分类都在树上：一级可展开/折叠，行内改名，合并模式勾选两个同级分类。 */
function renderNoteCategoryManagement() {
  const state = noteManagementState();
  const categories = noteScopedCategories(noteManagementScope());
  if (state.editingId && !categories.some(c => c.id === state.editingId)) { state.editingId = ''; state.editName = ''; state.editError = ''; }
  state.mergeSelection = state.mergeSelection.filter(id => categories.some(c => c.id === id));
  if (state.mergeSelection.length > 2) state.mergeSelection = state.mergeSelection.slice(0, 2);
  const primaries = categories.filter(c => !c.parentId);
  return h('section', { class: 'notes category-management', 'aria-label': '分类管理' },
    h('a', { class: 'category-back', href: '#/notes' }, '← 返回待办'),
    h('header', { class: 'category-page-head' }, h('p', { class: 'category-eyebrow' }, '待办 / 分类'), h('h1', {}, '分类管理'),
      h('p', { class: 'muted' }, '展开或折叠分类，点分类名称直接改名；需要归档重复分类时进入合并模式。')),
    ui.pageLoading && !ui.noteTaxonomy ? h('p', { role: 'status', class: 'muted' }, '正在读取分类…') : null,
    ui.notesError ? h('div', { class: 'error', role: 'alert' }, ui.notesError,
      h('button', { type: 'button', class: 'btn small', onclick: () => void noteLoadCategories() }, '重新读取')) : null,
    h('div', { class: 'category-manager-scope', role: 'group', 'aria-label': '分类所属大类' },
      [['note', '笔记'], ['todo', '待办'], ['event', '日程']].map(([value, label]) => h('button', {
        type: 'button', class: `btn small${noteManagementScope() === value ? ' primary' : ''}`, 'aria-pressed': String(noteManagementScope() === value),
        disabled: !!ui.notesClassificationBusy,
        onclick: () => { state.scope = value; state.mergeMode = false; state.mergeSelection = []; state.addOpen = false; state.editingId = ''; noteManagementRefresh(); }
      }, label))),
    h('div', { class: 'category-overview' }, h('span', {}, `${primaries.length} 个一级分类`), h('span', {}, `${categories.filter(c => c.parentId).length} 个二级分类`)),
    noteManagementFeedback(),
    h('div', { class: 'category-manager' },
      h('div', { class: 'category-manager-toolbar' },
        h('input', {
          type: 'search', class: 'category-search', 'aria-label': '搜索分类', placeholder: '搜索一级或二级分类',
          value: state.query, 'data-key': 'category-management-search', autocomplete: 'off',
          oninput: e => { state.query = e.target.value; noteManagementRefresh(); }
        }),
        h('div', { class: 'category-toolbar-actions' },
          h('button', { type: 'button', class: 'btn small', onclick: () => noteManagementExpandAll(true) }, '全部展开'),
          h('button', { type: 'button', class: 'btn small', onclick: () => noteManagementExpandAll(false) }, '全部折叠'),
          h('button', {
            type: 'button', class: `btn small category-merge-toggle${state.mergeMode ? ' primary' : ''}`,
            'aria-pressed': String(state.mergeMode), 'aria-label': state.mergeMode ? '退出合并' : '合并',
            disabled: !!ui.notesClassificationBusy, onclick: noteManagementToggleMerge
          }, state.mergeMode ? '退出合并' : '合并'),
          h('button', { type: 'button', class: 'btn primary small', 'aria-label': '新增', disabled: !!ui.notesClassificationBusy, onclick: noteManagementOpenAdd }, '＋ 新增'))),
      state.mergeMode ? h('p', { class: 'category-merge-hint muted small' }, '合并模式：勾选两个同级分类；后勾选的分类会被保留，可以用「交换保留目标」调整。') : null,
      noteManagementTree(categories, state),
      state.mergeMode ? noteManagementMergeBar(categories, state) : null),
    noteManagementAddDialog(categories, state));
}
const NOTE_CATEGORY_STALE = '分类目录已变更';
/** 提交分类动作；目录版本过期时（多为同路径建议整组确认刚建出目录）重拉目录后自动重试一次。 */
async function noteClassificationPost(note, body) {
  const send = (payload) => api(`/api/notes/${encodeURIComponent(note.id)}/classification`, { method: 'POST', body: JSON.stringify({ ...payload, inputHash: note.classification?.inputHash, categoryVersion: ui.noteTaxonomy?.version }) });
  try { return await send(body); }
  catch (e) {
    if (body.action !== 'confirm' || !String(e?.message || '').includes(NOTE_CATEGORY_STALE)) throw e;
    noteApplyTaxonomy(await api('/api/note-categories'));
    return send(noteConfirmRetryBody(note, body));
  }
}
/** 目录刷新后建议路径可能已改名或合并：路径还在就沿用，否则换成最新建议名称，避免按旧名建出重复分类。 */
function noteConfirmRetryBody(note, body) {
  const categories = noteScopedCategories(noteScopeOfNote(note));
  const exists = (primary, secondary) => {
    const parent = categories.find(c => !c.parentId && c.name === primary);
    return !!parent && categories.some(c => c.parentId === parent.id && c.name === secondary);
  };
  const paths = Array.isArray(body.categories) ? body.categories : [{ primary: body.primary, secondary: body.secondary }];
  if (paths.every(p => exists(p.primary, p.secondary))) return body;
  const fresh = (ui.noteTaxonomy?.confirmations || []).find(n => n.id === note.id)?.classification;
  const suggestions = Array.isArray(fresh?.suggestions) && fresh.suggestions.length ? fresh.suggestions : fresh?.suggestion ? [fresh.suggestion] : [];
  if (!suggestions.length) return body;
  return Array.isArray(body.categories)
    ? { ...body, categories: suggestions.map(s => ({ primary: s.primary, secondary: s.secondary })) }
    : { ...body, primary: suggestions[0].primary, secondary: suggestions[0].secondary };
}
function noteSuggestionKey(classification) {
  const list = Array.isArray(classification?.suggestions) && classification.suggestions.length ? classification.suggestions : classification?.suggestion ? [classification.suggestion] : [];
  return list.map(s => `${s.primary}/${s.secondary}`).join('|');
}
async function noteClassificationAction(note, body) {
  if (ui.notesClassificationBusy) return;
  ui.notesClassificationBusy = true; ui.notesClassificationId = note.id;
  const epoch = noteOperationEpoch;
  if (ui.view === 'notes') noteRefreshList();
  try {
    const suggestionKey = noteSuggestionKey(note.classification);
    const updated = await noteClassificationPost(note, body);
    if (epoch !== noteOperationEpoch) return;
    invalidateReads(key => key === '/api/notes' || key.startsWith('/api/notes?') || key === '/api/note-categories');
    ui.notes = (ui.notes || []).map(n => {
      if (n.id === note.id) return noteKeepSessions(n, updated);
      // The confirmation API assigns identical proposals within the same record type.
      const c = n.classification;
      if (body.action !== 'confirm' || noteScopeOfNote(n) !== noteScopeOfNote(note) || !suggestionKey || c?.state !== 'confirmation' || noteSuggestionKey(c) !== suggestionKey) return n;
      const {suggestion: _suggestion, suggestions: _suggestions, error: _error, ...rest} = c;
      const confirmed = updated.classification || {};
      return {...n, classification: {...rest, ...confirmed}};
    });
    ui.notesCounts = null; ui.notesCategoryCounts = null; ui.notesFilteredCounts = null;
    ui.notesError = '';
    // A successful write is complete; independent taxonomy reconciliation cannot hold its button busy.
    void api('/api/note-categories').then(value => {
      if (epoch !== noteOperationEpoch) return;
      noteApplyTaxonomy(value); if (ui.view === 'notes') noteRefreshList();
    }).catch(() => {
      if (epoch !== noteOperationEpoch) return;
      ui.notesError = '分类已保存，分类目录更新失败，请重新读取';
      if (ui.view === 'notes') noteRefreshList();
    });
  } catch (e) { if (epoch === noteOperationEpoch) ui.notesError = e.message; }
  finally { if (epoch === noteOperationEpoch) { ui.notesClassificationBusy = false; ui.notesClassificationId = null; if (ui.view === 'notes') noteRefreshList(); } }
}
function noteClassificationFailureLabel(note) {
  return note.classification?.error?.startsWith('建议已拒绝') ? '分类建议已拒绝' : '打标失败';
}
/** 卡片内就地处理分类：建议直接给出确认按钮；没有建议时显示待确认，交给人类填写。 */
function noteCategoryBadge(note) {
  const c = note.classification;
  if (!c) return null;
  const rows = noteClassificationRows(note);
  const suggestions = c.state === 'confirmation' ? (Array.isArray(c.suggestions) && c.suggestions.length ? c.suggestions : c.suggestion ? [c.suggestion] : []) : [];
  const suggestionPaths = suggestions.map(s => `${s.primary} / ${s.secondary}`);
  const confirming = !!ui.notesClassificationBusy && ui.notesClassificationId === note.id;
  const busy = !!ui.notesClassificationBusy;
  const quickOpen = ui.notesQuickCategory === note.id;
  const editCategory = () => {
    ui.notesQuickCategory = null;
    ui.notesEdit = { id: note.id, text: note.text, images: noteImageItems(note.images) };
    ui.notesEdit.categoryPanelOpen = true;
    renderMain();
  };
  const toggleQuick = () => {
    ui.notesQuickCategory = quickOpen ? null : note.id;
    noteRefreshList();
  };
  const confirm = () => {
    const body = suggestions.length === 1
      ? { action: 'confirm', primary: suggestions[0].primary, secondary: suggestions[0].secondary }
      : { action: 'confirm', categories: suggestions.map(s => ({ primary: s.primary, secondary: s.secondary })) };
    void noteClassificationAction(note, body);
  };
  // 「修改」只在待确认（有建议或待人工填写）时出现；已归档的卡片回编辑态改分类，分类行保持简洁。
  const canQuick = c.state === 'confirmation' && !!(rows.length || suggestions.length);
  return h('div', { class: `note-category-badge${confirming ? ' loading' : ''}`, 'aria-busy': confirming ? 'true' : null },
    h('span', { class: 'note-category-paths' }, rows.flatMap((row, index) => [
      index ? h('span', { class: 'note-category-sep', 'aria-hidden': 'true' }, '｜') : null,
      h('button', { type: 'button', class: 'note-category-path', onclick: () => noteSelectCategory(row.categoryId, note.id) }, `${row.primary} / ${row.secondary}`)
    ])),
    c.state !== 'classified' ? h('span', { class: 'muted small note-category-pending' }, c.state === 'failed' ? noteClassificationFailureLabel(note) : '待确认') : null,
    suggestionPaths.length ? h('span', { class: 'note-category-suggestion small' }, `推荐：${suggestionPaths.join('｜')}`) : null,
    suggestions.length ? h('button', { type: 'button', class: 'btn small primary', disabled: busy, 'aria-label': `确认推荐分类：${suggestionPaths.join('｜')}`, onclick: confirm }, confirming ? '确认中…' : '确认') : null,
    canQuick ? h('button', { type: 'button', class: 'btn small note-category-quick-toggle', disabled: busy, 'aria-expanded': quickOpen ? 'true' : 'false', 'aria-label': '快速修改这条待办的分类', title: '确认前先换成已有分类，不用打开编辑', onclick: toggleQuick }, '修改') : null,
    c.state !== 'classified' && !suggestions.length ? h('button', { type: 'button', class: 'btn small', disabled: busy, 'aria-label': '填写这条待办的分类', onclick: editCategory }, '填写分类') : null,
    c.state === 'failed' ? h('button', { type: 'button', class: 'btn small', disabled: busy, onclick: () => void noteClassificationAction(note, { action: 'retry' }) }, '重试分类') : null,
    quickOpen ? noteCategoryQuick(note, busy, editCategory) : null);
}
/** 卡片内的「修改」：就地挑一个已有二级分类，选中即生效；新建分类仍走编辑态。 */
function noteCategoryQuick(note, busy, editCategory) {
  // 笔记只能换成笔记那套里的分类，待办和日程只能换成待办那套里的。
  const categories = noteScopedCategories(noteScopeOfNote(note));
  const primaries = new Map(categories.filter(c => !c.parentId).map(c => [c.id, c.name]));
  const currentIds = new Set(noteClassificationRows(note).map(row => row.categoryId));
  const leaves = categories.filter(c => c.parentId).map(c => ({ id: c.id, path: `${primaries.get(c.parentId) || ''} / ${c.name}` }));
  let query = '';
  const list = h('div', { class: 'note-category-quick-list', role: 'listbox', 'aria-label': '已有分类' });
  const apply = (categoryId) => {
    if (busy) return;
    ui.notesQuickCategory = null;
    void noteClassificationAction(note, { action: 'assign', categoryId });
  };
  const render = () => {
    const q = query.trim().toLowerCase();
    const matched = leaves.filter(c => !q || c.path.toLowerCase().includes(q));
    list.replaceChildren(...(matched.length ? matched.map(c => h('button', {
      type: 'button', role: 'option', class: `notes-category-link category-option${currentIds.has(c.id) ? ' selected' : ''}`,
      'aria-selected': String(currentIds.has(c.id)), 'aria-label': `改为 ${c.path}`, disabled: busy, onclick: () => apply(c.id)
    }, h('span', {}, c.path), currentIds.has(c.id) ? h('span', { class: 'category-check', 'aria-hidden': 'true' }, '✓') : null))
      : [h('p', { class: 'muted small category-empty' }, '没有匹配的分类，可在编辑里新建')]));
  };
  render();
  return h('div', { class: 'note-category-quick' },
    h('div', { class: 'note-category-quick-head' },
      h('span', { class: 'muted small' }, '换个已有分类，点一下即生效'),
      h('button', { type: 'button', class: 'btn small', disabled: busy, onclick: () => { ui.notesQuickCategory = null; noteRefreshList(); } }, '取消')),
    h('input', {
      type: 'search', class: 'category-search', 'aria-label': '搜索要改成的分类', placeholder: '搜索一级或二级分类', disabled: busy,
      oninput: (e) => { query = e.target.value; render(); },
      onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); ui.notesQuickCategory = null; noteRefreshList(); } }
    }),
    list,
    h('button', { type: 'button', class: 'notes-category-link category-create-open', disabled: busy, onclick: editCategory }, '＋ 新建分类（打开编辑）'));
}
/** 一条待办最多挂几个分类（与服务端 NOTE_MAX_CATEGORIES 一致）。 */
const NOTE_MAX_CATEGORIES = 4;
/**
 * 编辑态的分类：已选分类显示成可删除的标签；「＋ 添加分类」打开和筛选同款的两列目录，
 * 可多选、可新建，点「确认」后才写入编辑草稿，保存待办时一起提交。全部删掉 = 保存后重新打标。
 */
function noteCategoryEditor(note, busy) {
  const edit = ui.notesEdit;
  const categories = noteScopedCategories(noteScopeOfNote(note));
  const byId = (id) => categories.find(c => c.id === id);
  const rowLabels = new Map(noteClassificationRows(note).map(row => [row.categoryId, `${row.primary} / ${row.secondary}`]));
  const pathOf = (id) => {
    const c = byId(id);
    const p = c && byId(c.parentId);
    return c && p ? `${p.name} / ${c.name}` : rowLabels.get(id) || c?.name || id;
  };
  const ids = Array.isArray(edit.categoryIds)
    ? edit.categoryIds
    : edit.reclassify ? []
    : edit.categoryId ? [edit.categoryId]
    : noteClassificationRows(note).map(row => row.categoryId).filter(Boolean);
  const draft = edit.newCategory;
  const draftPath = draft ? `${draft.primary} / ${draft.secondary}` : '';
  const primaries = categories.filter(c => !c.parentId);
  const childrenOf = (pid) => categories.filter(c => c.parentId === pid);

  // 只重绘分类这一块：保留正文输入框的光标和两列目录各自的滚动位置。
  const rerender = () => {
    const current = document.querySelector(`.note-category-editor[data-note-id="${CSS.escape(note.id)}"]`);
    if (!current) { renderMain(); return; }
    const scroll = {};
    current.querySelectorAll('[data-category-column]').forEach(el => { scroll[el.getAttribute('data-category-column')] = el.scrollTop; });
    const next = noteCategoryEditor(note, busy);
    current.replaceWith(next);
    next.querySelectorAll('[data-category-column]').forEach(el => { const top = scroll[el.getAttribute('data-category-column')]; if (top != null) el.scrollTop = top; });
    const focus = edit.categoryFocus;
    if (focus) {
      delete edit.categoryFocus;
      next.querySelector(`[data-category-focus="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
    }
  };
  const setIds = (next) => {
    edit.categoryIds = next;
    delete edit.categoryId;
    edit.reclassify = false;
  };
  const openPicker = () => {
    const primaryId = byId(byId(ids[0])?.parentId)?.id || primaries[0]?.id || null;
    edit.categoryPicker = { ids: [...ids], newCategory: draft ? { ...draft } : null, primaryId, create: null, createError: '', notice: '' };
    return edit.categoryPicker;
  };
  // 卡片上的「填写分类」直接带着打开的目录进入编辑态。
  if (edit.categoryPanelOpen) { delete edit.categoryPanelOpen; if (!edit.categoryPicker) openPicker(); }
  const picker = edit.categoryPicker;
  const closePicker = () => { delete edit.categoryPicker; edit.categoryFocus = 'add'; rerender(); };

  const chip = (label, onRemove, extra = '') => h('span', { class: `note-category-chip${extra}` },
    h('span', { class: 'note-category-chip-label' }, label),
    h('button', { type: 'button', class: 'note-category-chip-remove', 'aria-label': `移除分类：${label}`, title: '移除', disabled: busy, onclick: onRemove }, '×'));
  const emptyLabel = edit.reclassify || Array.isArray(edit.categoryIds) ? '保存后重新打标' : '保存后自动打标';
  const tags = h('div', { class: 'note-category-tags', role: 'group', 'aria-label': '这条待办的分类' },
    ...ids.map(id => chip(pathOf(id), () => { setIds(ids.filter(x => x !== id)); edit.categoryFocus = 'add'; rerender(); })),
    draftPath ? chip(`新建：${draftPath}`, () => { delete edit.newCategory; if (!Array.isArray(edit.categoryIds)) setIds([...ids]); edit.categoryFocus = 'add'; rerender(); }, ' new') : null,
    !ids.length && !draftPath ? h('span', { class: 'note-category-empty' }, emptyLabel) : null,
    h('button', {
      type: 'button', class: 'note-category-add', 'data-category-focus': 'add', 'aria-expanded': String(!!picker), disabled: busy,
      onclick: () => { if (edit.categoryPicker) closePicker(); else { openPicker(); rerender(); } }
    }, '＋ 添加分类'));

  return h('div', { class: 'note-category-editor', 'data-note-id': note.id },
    h('span', { class: 'muted small note-category-editor-label' }, '分类'),
    tags,
    picker ? noteCategoryPicker(picker, { busy, byId, primaries, childrenOf, rerender, closePicker,
      confirm: () => {
        noteApplyCategoryPicker(edit);
        edit.categoryFocus = 'add';
        rerender();
      } }) : null);
}
/** 编辑态「添加分类」的两列目录：和顶部分类筛选同一套版式，左列一级、右列二级，二级可多选。 */
function noteCategoryPicker(picker, { busy, byId, primaries, childrenOf, rerender, closePicker, confirm }) {
  const selected = byId(picker.primaryId) && !byId(picker.primaryId).parentId ? byId(picker.primaryId) : null;
  const children = selected ? childrenOf(selected.id) : [];
  const total = () => picker.ids.length + (picker.newCategory ? 1 : 0);
  const pickedUnder = (pid) => picker.ids.filter(id => byId(id)?.parentId === pid).length + (picker.newCategory?.primaryId === pid ? 1 : 0);
  const toggle = (c) => {
    picker.notice = '';
    if (picker.ids.includes(c.id)) picker.ids = picker.ids.filter(id => id !== c.id);
    else if (total() >= NOTE_MAX_CATEGORIES) picker.notice = `一条待办最多 ${NOTE_MAX_CATEGORIES} 个分类，先取消一个再选`;
    else picker.ids = [...picker.ids, c.id];
    picker.focus = `pick-${c.id}`;
    rerender();
  };
  const openCreate = (parentId) => {
    picker.create = { parentId: parentId || '', primary: '', secondary: '' };
    picker.createError = ''; picker.notice = '';
    rerender();
  };
  const submitCreate = () => {
    const form = picker.create;
    if (!form) return;
    const parentRow = form.parentId ? byId(form.parentId) : null;
    const primary = parentRow ? parentRow.name : (form.primary || '').trim();
    const secondary = (form.secondary || '').trim();
    const valid = value => value.length > 0 && value.length <= 60 && !/[\r\n\x00-\x1f]/.test(value);
    if (!valid(primary) || !valid(secondary)) {
      picker.createError = parentRow ? '请填写 1–60 字的二级分类名称' : '一级和二级分类都需要填写 1–60 字的单行名称';
      rerender();
      return;
    }
    // 一次只能新建一条路径：再建一次会替换之前那条，不额外占名额。
    if (!picker.newCategory && total() >= NOTE_MAX_CATEGORIES) {
      picker.createError = `一条待办最多 ${NOTE_MAX_CATEGORIES} 个分类，先取消一个再新建`;
      rerender();
      return;
    }
    picker.newCategory = { ...(parentRow ? { primaryId: parentRow.id } : {}), primary, secondary };
    picker.create = null; picker.createError = '';
    rerender();
  };
  const createForm = () => {
    const form = picker.create;
    if (!form) return null;
    const parentRow = form.parentId ? byId(form.parentId) : null;
    if (form.parentId && !parentRow) return null;
    const first = h('input', { type: 'text', maxlength: '60', value: (parentRow ? form.secondary : form.primary) || '', 'aria-label': parentRow ? '二级分类名称' : '一级分类名称', disabled: busy, oninput: e => { if (parentRow) form.secondary = e.target.value; else form.primary = e.target.value; } });
    requestAnimationFrame(() => { if (first.isConnected && !first.value && document.activeElement?.tagName !== 'INPUT') first.focus({ preventScroll: true }); });
    return h('form', { class: 'category-create-form', onsubmit: e => { e.preventDefault(); submitCreate(); } },
      parentRow ? h('p', { class: 'category-create-path' }, `在「${parentRow.name}」下新建二级分类`) : null,
      parentRow
        ? h('label', { class: 'category-create-field' }, h('span', {}, '二级分类名称'), first)
        : h('label', { class: 'category-create-field' }, h('span', {}, '一级分类名称'), first),
      parentRow ? null : h('label', { class: 'category-create-field' }, h('span', {}, '二级分类名称'),
        h('input', { type: 'text', maxlength: '60', value: form.secondary || '', 'aria-label': '二级分类名称', disabled: busy, oninput: e => { form.secondary = e.target.value; } })),
      picker.createError ? h('p', { class: 'error', role: 'alert' }, picker.createError) : null,
      h('p', { class: 'category-helper' }, '同名分类会直接复用，不会重复建立；保存待办后生效。'),
      h('div', { class: 'category-create-actions' },
        h('button', { type: 'submit', class: 'btn small primary', disabled: busy }, '创建并选择'),
        h('button', { type: 'button', class: 'btn small', disabled: busy, onclick: () => { picker.create = null; picker.createError = ''; rerender(); } }, '取消')));
  };
  const primaryRow = (p) => {
    const active = p.id === picker.primaryId;
    const n = pickedUnder(p.id);
    return h('div', { class: `category-browser-row${active ? ' active' : ''}` },
      h('button', {
        type: 'button', class: 'category-browser-name', 'aria-pressed': String(active), 'aria-label': n ? `${p.name}（已选 ${n}）` : p.name, disabled: busy,
        'data-category-focus': `primary-${p.id}`,
        onclick: () => { picker.primaryId = p.id; picker.notice = ''; picker.focus = `primary-${p.id}`; rerender(); }
      }, h('span', { class: 'category-browser-label' }, p.name)),
      n ? h('span', { class: 'category-browser-count picked' }, String(n)) : null);
  };
  const childRow = (c) => {
    const on = picker.ids.includes(c.id);
    return h('div', { class: `category-browser-row${on ? ' active' : ''}` },
      h('button', {
        type: 'button', class: 'category-browser-name', 'aria-pressed': String(on), 'aria-label': `${selected.name} / ${c.name}`, disabled: busy,
        'data-category-focus': `pick-${c.id}`, onclick: () => toggle(c)
      }, h('span', { class: 'category-browser-label' }, c.name), on ? h('span', { class: 'category-check', 'aria-hidden': 'true' }, '✓') : null));
  };
  const createButton = (parentId, label) => h('button', { type: 'button', class: 'notes-category-link category-create-open', disabled: busy, onclick: () => openCreate(parentId) }, label);
  const newPath = picker.newCategory ? `${picker.newCategory.primary} / ${picker.newCategory.secondary}` : '';
  const n = total();
  const node = h('div', {
    class: 'notes-category-directory note-category-picker', role: 'group', 'aria-label': '添加分类',
    onkeydown: e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePicker(); } }
  },
    h('header', { class: 'category-browser-head' },
      h('div', { class: 'category-browser-heading' },
        h('strong', {}, '添加分类'),
        h('span', { class: 'muted small' }, `点一级看二级，二级可多选（最多 ${NOTE_MAX_CATEGORIES} 个），确认后加到这条待办`))),
    picker.notice ? h('p', { class: 'category-browser-feedback error', role: 'alert' }, picker.notice) : null,
    h('div', { class: 'category-browser-columns' },
      h('section', { class: 'category-browser-column', 'data-category-column': 'primary', 'aria-label': '一级分类' },
        noteCategoryColumnTitle('primary'),
        ...primaries.map(primaryRow),
        !primaries.length ? h('p', { class: 'muted small category-browser-empty' }, '还没有分类，可以新建一个。') : null,
        picker.create && !picker.create.parentId ? null : createButton('', '＋ 新建一级分类')),
      h('section', { class: 'category-browser-column', 'data-category-column': 'secondary', 'aria-label': '二级分类' },
        noteCategoryColumnTitle('secondary', selected?.name),
        ...children.map(childRow),
        selected && !children.length ? h('p', { class: 'muted small category-browser-empty' }, '这个一级分类下还没有二级分类。') : null,
        !selected ? h('p', { class: 'muted small category-browser-empty' }, '先选一个一级分类。') : null,
        selected && picker.create?.parentId !== selected.id ? createButton(selected.id, '＋ 新建二级分类') : null)),
    createForm(),
    newPath ? h('div', { class: 'category-draft-new' },
      h('span', {}, `将新建：${newPath}`),
      h('button', { type: 'button', class: 'category-draft-cancel', disabled: busy, onclick: () => { picker.newCategory = null; picker.notice = ''; rerender(); } }, '取消新建')) : null,
    h('div', { class: 'note-category-picker-foot' },
      h('span', { class: 'muted small' }, n ? `已选 ${n} 个分类` : '未选分类，保存后自动打标'),
      h('div', { class: 'note-category-picker-actions' },
        h('button', { type: 'button', class: 'btn small', disabled: busy, onclick: closePicker }, '取消'),
        h('button', { type: 'button', class: 'btn small primary', disabled: busy, onclick: confirm }, '确认'))));
  const focus = picker.focus;
  if (focus) {
    delete picker.focus;
    requestAnimationFrame(() => node.querySelector(`[data-category-focus="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true }));
  }
  return node;
}

// Registration does not fetch or mount; the current route owns activation.
window.piRouteModules?.register("notes", { render: renderNotes });


// Exposure is recorded from actual visibility, never from list reads or prefetches.
let noteRoiObserver = null, noteRoiScanTimer = null;
const noteRoiNodes = new Map(), noteRoiSent = new Set();
function noteScheduleRoiExposure() {
  if (noteRoiScanTimer || typeof IntersectionObserver === 'undefined') return;
  noteRoiScanTimer = setTimeout(() => {
    noteRoiScanTimer = null;
    if (!noteRoiObserver) {
      noteRoiObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          const state = noteRoiNodes.get(entry.target); if (!state) continue;
          clearTimeout(state.timer); state.timer = null;
          if (!entry.isIntersecting || entry.intersectionRatio < 0.5 || document.hidden || ui.view !== 'notes' || (document.querySelector('dialog[open]') && !document.querySelector('dialog[open]').contains(entry.target)) || noteRoiSent.has(state.key)) continue;
          state.timer = setTimeout(() => {
            state.timer = null;
            const css = getComputedStyle(entry.target);
            if (!entry.target.isConnected || document.hidden || ui.view !== 'notes' || (document.querySelector('dialog[open]') && !document.querySelector('dialog[open]').contains(entry.target)) || css.visibility === 'hidden' || css.display === 'none' || noteRoiSent.has(state.key)) return;
            noteRoiSent.add(state.key);
            if (noteRoiSent.size > 2000) noteRoiSent.delete(noteRoiSent.values().next().value);
            const batchId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
            void api('/api/note-iterations/exposures', { method: 'POST', body: JSON.stringify({ batchId, windowVersion: state.window.version, algorithmVersion: state.window.algorithmVersion, entries: [{ taskId: state.item.id, revision: state.item.revision, evaluationVersion: state.item.evaluationVersion, position: state.position }] }) }).catch(() => { noteRoiSent.delete(state.key); });
          }, 1000);
        }
      }, { threshold: [0, 0.5, 1] });
      window.addEventListener('hashchange', noteScheduleRoiExposure);
      document.addEventListener('close', () => {
        for (const [node, state] of noteRoiNodes) { clearTimeout(state.timer); noteRoiObserver.unobserve(node); }
        noteRoiNodes.clear(); noteScheduleRoiExposure();
      }, true);
      document.addEventListener('visibilitychange', () => {
        for (const [node, state] of noteRoiNodes) { clearTimeout(state.timer); noteRoiObserver.unobserve(node); }
        noteRoiNodes.clear();
        if (!document.hidden) noteScheduleRoiExposure();
      });
    }
    for (const [node, state] of noteRoiNodes) if (!node.isConnected || ui.view !== 'notes') { clearTimeout(state.timer); noteRoiObserver.unobserve(node); noteRoiNodes.delete(node); }
    if (ui.view !== 'notes' || document.hidden) return;
    for (const node of document.querySelectorAll('[data-iteration-id]')) {
      if (noteRoiNodes.has(node)) continue;
      const data = node.closest('#notes-today-recs') ? noteTodaySummaryData() : ui.noteIterations;
      const win = data?.recommendationWindow;
      const position = win?.entries.findIndex(e => e.id === node.dataset.iterationId) ?? -1;
      if (position < 0) continue;
      const item = win.entries[position];
      const key = `${win.version}:${win.algorithmVersion}:${item.id}:${item.revision}:${item.evaluationVersion}`;
      if (noteRoiSent.has(key)) continue;
      noteRoiNodes.set(node, { key, item, window: win, position: position + 1, timer: null });
      noteRoiObserver.observe(node);
    }
  }, 0);
}
