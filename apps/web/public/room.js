/* Shared room state and directory actions; detail UI loads on its route. */
/* V3.3 群聊：群聊式界面。只有发送才发出人类投递；@、引用、快捷指令和建议都只改草稿。 */
const ROOM_SIDE_STORAGE = "pi-agent-room-members-collapsed";
/* app.js 先于本文件执行（同一批 defer，按文档顺序），群聊状态挂在全局 ui 上。
 * 基础脚本加载失败时本文件仍会执行：顶层直接写 ui 会变成 Uncaught ReferenceError，
 * 把真正的 resource_error 埋掉（诊断 f0f4421f56e9e4618）。所以这里守卫式初始化：
 * ui 不存在就只记录一次、不建状态；群聊页由 splash.js 的恢复提示兜底。 */
function roomInit() {
  if (typeof ui === "undefined") { console.warn("[shell] room.js: app.js 未执行（ui 未定义），跳过群聊状态初始化"); return null; }
  if (!ui.room) ui.room = { id: null, view: null, draft: { text: "", quotes: [] }, new: { title: "", prompt: "", members: [], settings: { attribution: "shown", shareScope: "summary" } }, error: "", busy: false, membersOpen: false, membersHidden: false, subOpen: false, pick: 0, expanded: {}, roundView: {}, rounds: {}, atBottom: true, es: null, timer: null, key: null, generation: 0 };
  try { ui.room.membersHidden = localStorage.getItem(ROOM_SIDE_STORAGE) === "true"; } catch { /* in-memory preference */ }
  return ui.room;
}
const roomState = roomInit();
function roomStop() { ui.room.es?.close(); ui.room.es = null; clearTimeout(ui.room.timer); }
function roomRemember() {
  const r = ui.room;
  if (!r.id || !r.view) return;
  if (ui.view === 'rt-room') r.reading = sessionReadingCapture(document.querySelector('.room-timeline'), r.atBottom);
  sessionSnapshotPut(`room:${r.id}`, { view: r.view, atBottom: r.atBottom, reading: r.reading, expanded: r.expanded, roundView: r.roundView, rounds: r.rounds, newCount: r.newCount || 0, trimmedTail: r.trimmedTail });
}
function roomSelect(id, force = false) {
  if (ui.room.id === id && !force) return;
  roomRemember(); roomStop();
  const r = ui.room, hit = id ? sessionSnapshotGet(`room:${id}`) : null;
  r.diskDisplay = null; r.diskAuthorized = false; r.diskRestorePending = false; r.diskRestoreFlight = null; r.memoryDisplay = !!hit;
  r.generation++; r.id = id; r.view = hit?.view || null; r.error = ''; r.key = null; r.atBottom = hit ? hit.atBottom : true;
  r.subOpen = false; ui.rt.moreOpen = false;
  r.reading = hit?.reading || { atBottom: r.atBottom, top: 0 }; r.expanded = { ...hit?.expanded }; r.roundView = { ...hit?.roundView }; r.rounds = { ...hit?.rounds }; r.diffs = {}; r.diffOpen = null;
  r.newCount = hit?.newCount || 0; r.trimmedTail = hit?.trimmedTail || false; r.syncing = !!id && !hit; r.syncError = ''; r.statusConfirmed = false;
  if(id&&!hit&&typeof sessionUseWarmDisplay==='function')sessionUseWarmDisplay({kind:'room',id},r);
  try { const d = JSON.parse(sessionStorage.getItem(`pi-room-draft:${id}`)); r.draft = { text: d?.text || '', quotes: d?.quotes || [] }; } catch { r.draft = { text: '', quotes: [] }; }
  navigationMark('session-cache', { hit: !!hit, type: 'room' });
}
function roomCurrent(id, gen) { return ui.view === 'rt-room' && ui.room.id === id && ui.room.generation === gen; }
/**
 * 微信式群头像：一个方框里拼接成员头像。1 人整格；2–4 人 2 列；5–9 人 3 列；
 * 从底行往上排满，最上一行人少时居中。只显示模型家族图标（太小放不下 runtime 角标）。
 */
function roomLogoSrc(id) { return typeof piLogoSrc === "function" ? piLogoSrc(id) : `/logos/${id}.svg`; }
function roomGroupAvatar(list, size = 40) {
  // 尺寸、列数走 CSS 类（页面 CSP 不允许内联 style）
  const items = list.slice(0, 9), n = Math.max(items.length, 1), cols = n === 1 ? 1 : n <= 4 ? 2 : 3;
  const rows = [], rest = items.slice();
  rows.push(rest.splice(0, items.length % cols || cols)); while (rest.length) rows.push(rest.splice(0, cols));
  const tile = (x) => {
    const f = rtFamily(x.model, x.kind), mono = (rtModelShort(x.model) || RT_KIND[x.kind] || "?").slice(0, 1).toUpperCase();
    return h("span", { class: "room-ga-cell" }, f ? h("img", { src: roomLogoSrc(f.id), alt: "", draggable: "false" }) : h("span", { class: "room-ga-mono" }, mono));
  };
  return h("span", { class: `room-ga s${size} c${cols}`, "aria-hidden": "true" }, rows.map((row) => h("span", { class: "room-ga-row" }, row.map(tile))));
}
/* ------------------------------ 新建：和「对比多个」同一个新建页，成员一行一个 ------------------------------ */

const ROOM_MAX_MEMBERS = 8;
const ROOM_NEW_KEY = "pi-agent.room-new.v1";
if (roomState) {
  // 上次的成员配置：别名、运行时、角色、模型、推理强度
  try {
    const d = JSON.parse(localStorage.getItem(ROOM_NEW_KEY) || "null");
    // runtime.js 比本文件先执行；它也加载失败时没有 RT_KINDS，直接用默认成员。
    const kinds = typeof RT_KINDS === "undefined" ? [] : RT_KINDS;
    if (d && d.version === 1 && Array.isArray(d.members) && d.members.length) {
      roomState.new.members = d.members.filter((m) => m && kinds.includes(m.runtimeKind)).slice(0, ROOM_MAX_MEMBERS).map((m) => ({ alias: String(m.alias || "").slice(0, 32), aliasAuto: m.aliasAuto !== false, runtimeKind: m.runtimeKind, model: String(m.model || ""), effort: String(m.effort || ""), permissionMode: String(m.permissionMode || "") }));
      if (d.settings) roomState.new.settings = { ...roomState.new.settings, ...d.settings };
    }
  } catch { /* 忽略损坏的本地记录 */ }
  if (!roomState.new.members.length) roomState.new.members = [{ alias: "", aliasAuto: true, runtimeKind: "codex", model: "", effort: "" }];
  roomState.new.prompt = "";
}
/** 手机返回：群聊列表是全屏浮层（不换地址，浏览器返回仍回到本群聊） */
function roomOpenList() { if (!rtPhone.matches) return; ui.rt.listOpen = true; ui.rt.moreOpen = false; renderMain(); }
function roomFold(entries) {
  const out = [], groups = new Map();
  for (const e of entries) {
    if (!e.roomRef) { out.push(e); continue; }
    const id = e.roomRef.roomId; let g = groups.get(id);
    if (!g) { g = { ...e, id, room: true, title: e.roomTitle || e.title.split(" · @")[0] || "群聊", href: `#/rt/room/${id}`, archived: true, members: [] }; groups.set(id, g); out.push(g); }
    g.members.push(e); if (!e.archived) g.archived = false;
    if ((e.lastTurnEndedAt || "") > (g.lastTurnEndedAt || "")) g.lastTurnEndedAt = e.lastTurnEndedAt;
    if ((e.lastActivityAt || "") > (g.lastActivityAt || "")) g.lastActivityAt = e.lastActivityAt;
  }
  // 任一成员在等部署 / 部署中，整个群聊就标出来
  for (const g of groups.values()) g.deploy = g.members.map((m) => m.deploy).find(Boolean);
  return out;
}
/** 列表里归档 / 恢复整个群聊（成员会话一起）；成员运行中时服务端会拒绝 */
/** 归档会删除可写成员的 worktree：还有没采用的改动时先确认 */
async function roomConfirmArchive(roomId) {
  const v = ui.room.id === roomId && ui.room.view ? ui.room.view : await api(`/api/rooms/${roomId}?limit=1`).catch(() => null);
  const wt = v && v.room.worktree, writers = v ? v.members.filter((m) => m.worktree && !m.removedAt) : [];
  if (!wt || wt.cleanedAt || !writers.length) return true;
  return confirm(`归档会删除 ${writers.map((m) => `@${m.alias}`).join("、")} 的 worktree，还没采用到原目录的改动会丢失（恢复群聊时从起点重新切出）。确定归档？`);
}
async function roomArchive(g, archived) {
  if (archived && !(await roomConfirmArchive(g.id))) return;
  try {
    await api(`/api/rooms/${g.id}/archive`, { method: "POST", body: JSON.stringify({ archived }) });
    rtArchiveInvalidate();
    announce(archived ? `已归档群聊：${g.title}` : `已恢复群聊：${g.title}`);
    ui.rt.archiveFlash = { text: `${archived ? "已归档" : "已恢复"}群聊「${g.title}」` };
    if (ui.room.id === g.id && ui.room.view) ui.room.view.room.archived = archived;
    await rtLoadDir(); renderMain();
  } catch (err) { ui.rt.archiveFlash = { text: `${archived ? "归档" : "恢复"}失败：${err.message}`, error: true }; announce(`${archived ? "归档" : "恢复"}失败：${err.message}`); rtRenderListOnly(); }
}
function roomListItem(e, a = ui.rt.access) {
  const active = ui.view === "rt-room" && ui.room.id === e.id;
  const busy = e.members.some((m) => ["creating", "running", "waiting-input", "stopping"].includes(m.status));
  const unread = rtUnread(e);
  const orderAt = rtTurnOrderAt(e) || e.lastActivityAt;
  const item = h("a", { class: `rt-item room-item${active ? " active" : ""}${unread ? " unread" : ""}`, href: e.href, "aria-current": active ? "page" : null, onclick: () => { ui.rt.listOpen = false; } },
      rtAvatarUnread(roomGroupAvatar(e.members.map((m) => ({ kind: m.runtimeKind, model: m.model })), 40), rtUnreadCount(e), e.members.reduce((n, m) => n + (m.pendingApprovals || 0), 0), e.members.some((m) => m.status === "waiting-input")),
      h("span", { class: "rt-item-main" },
        h("span", { class: "rt-item-top" }, h("span", { class: "rt-item-title" }, unread ? h("span", { class: "sr-only" }, "未读：") : null, e.title),
          orderAt ? h("time", { class: "rt-item-time", datetime: orderAt }, rtAgo(orderAt).replace(" 分钟前", " 分钟").replace(" 小时前", " 小时")) : null),
        h("span", { class: "rt-item-sub" }, h("span", { class: "rt-item-model" }, `群聊 · ${e.members.length} 名成员`), e.members.some((m) => ["creating", "running", "stopping"].includes(m.status)) ? badge("回复中", "") : null, e.deploy ? rtDeployBadge(e.deploy) : null)));
  const act = a && a.control && !busy ? h("button", {
    type: "button", class: `rt-item-act ${e.archived ? "restore" : "archive"}`, title: e.archived ? "恢复到列表" : "归档群聊", "aria-label": `${e.archived ? "恢复" : "归档"}群聊：${e.title}`,
    // 点左滑露出的入口直接归档
    onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); void roomArchive(e, !e.archived); }
  }, e.archived ? "恢复" : "归档") : null;
  // 群聊里有人在运行：左滑照样露出入口，点它给一句提示，而不是没反应
  const note = a && a.control && busy ? "群聊里有会话正在运行，停止后才能归档" : "";
  return rtSessionRow(e.id, item, act, note);
}
