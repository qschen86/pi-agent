/* Room detail and creation definitions; effects belong to the active room route. */

const roomSideMedia = matchMedia("(max-width: 1100px)");
function roomMembersExpanded() { return roomSideMedia.matches ? ui.room.membersOpen : !ui.room.membersHidden; }
function roomSyncMembersHandle() {
  const handle = document.querySelector(".room-side-handle");
  if (!handle) return;
  const expanded = roomMembersExpanded();
  handle.setAttribute("aria-expanded", String(expanded));
  handle.title = `${expanded ? "收起" : "展开"}群聊成员`;
  handle.querySelector(".rt-side-handle-chevron").textContent = expanded ? "›" : "‹";
}
function roomToggleMembers() {
  const r = ui.room;
  if (roomSideMedia.matches) r.membersOpen = !r.membersOpen;
  else {
    r.membersHidden = !r.membersHidden;
    try { localStorage.setItem(ROOM_SIDE_STORAGE, String(r.membersHidden)); } catch { /* in-memory preference */ }
  }
  const layout = document.querySelector(".room-layout");
  if (layout) {
    layout.classList.toggle("members-open", r.membersOpen);
    layout.classList.toggle("members-hidden", r.membersHidden);
  }
  roomSyncMembersHandle();
}
const ROOM_DELIVERY = { queued: "排队中", dispatching: "投递中", running: "回复中", completed: "已回复", failed: "投递失败", unknown: "结果未知", cancelled: "已取消" };
/** 长回复先折叠：按字数或行数（列表、表格行数多时渲染很高） */
const roomIsLong = (text) => text.length > 1200 || text.split("\n").length > 24;
// 局域网 http（非安全上下文）没有 crypto.randomUUID，退回 getRandomValues。
function roomKey() { return `room-${(globalThis.crypto?.randomUUID?.() ?? [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("")).replace(/-/g, "")}`; }
function roomDraftChanged() { ui.room.key = null; if (ui.room.id) try { sessionStorage.setItem(`pi-room-draft:${ui.room.id}`, JSON.stringify(ui.room.draft)); } catch { /* Keep the in-memory draft. */ } }
function roomConnect(id, gen, legacy = false) {
  const r = ui.room;
  if(!legacy&&r.view&&roomCurrent(id,gen)&&typeof sessionLiveConnect==='function'){
    roomStop();void sessionLiveConnect().then(ok=>{if(!ok&&roomCurrent(id,gen))roomConnect(id,gen,true);}).catch(()=>{if(roomCurrent(id,gen))roomConnect(id,gen,true);});return;
  }
  if (r.es || !roomCurrent(id, gen) || !r.view) return;
  const es = new EventSource(`/api/runtime/stream?room=${encodeURIComponent(id)}`); r.es = es;
  try {window.piTelemetry?.trackStream?.(es);} catch {}
  const soon = () => {
    if (!roomCurrent(id, gen) || r.es !== es) return;
    clearTimeout(r.timer); r.timer = setTimeout(() => {
      if (roomCurrent(id, gen) && r.es === es) void roomRefresh().catch(() => {});
    }, 120);
  };
  for (const event of ['room-message', 'member-status', 'delivery', 'approvals', 'ready', 'gap']) es.addEventListener(event, soon);
  es.onerror = () => { if (roomCurrent(id, gen) && r.es === es) { r.statusConfirmed = false; r.syncError = '实时连接中断，正在重连'; roomRenderSoft(false); } };
}
async function roomRefresh() {
  const r = ui.room, id = r.id, gen = r.generation;
  const restoring=ui.view==='rt-room'&&id&&!r.diskAuthorized&&!r.memoryDisplay&&!r.trimmedTail&&(r.view?.messages?.length||0)<=50&&typeof sessionDisk!=='undefined'&&typeof sessionPersistenceCandidate==='function'&&typeof sessionAuthorityRestorePrepare==='function'?sessionAuthorityRestorePrepare({kind:'room',id},gen):null;
  if(restoring)void restoring.promise.catch(()=>{});
  const background=()=>{if(gen!==r.generation)return;if (!ui.rt.dir || Date.now() - (ui.rt.dirAt || 0) > 60_000) void rtLoadDir().then(() => { if (roomCurrent(id, gen)) rtRenderListOnly(); });};
  if(restoring)void restoring.dispatched.then(background);else background();
  if (ui.view === 'rt-room-new') {
    await Promise.all([rtLoadProfiles(), rtLoadSettings()]);
    if (ui.view !== 'rt-room-new' || gen !== r.generation) return;
    const f = rtForm(), roots = rtWorkspaceRoots((r.new.members[0] || {}).runtimeKind || 'codex');
    if (!f.workspace.trim() && roots.length === 1) f.workspace = roots[0];
    return;
  }
  if (!id) return;
  if (!restoring && typeof sessionRestoreDisplay === 'function' && !r.diskAuthorized && !r.memoryDisplay) void sessionRestoreDisplay({kind:'room',id},gen);
  else if (!restoring && !r.memoryDisplay && !r.diskDisplay && typeof sessionRestorePreparedDisplay === 'function') void sessionRestorePreparedDisplay({kind:'room',id},gen);
  if (!roomCurrent(id,gen)) return;
  return sessionRefreshOnce(`room:${id}:${gen}`, async () => {
    try {
      const latestWindow = !r.trimmedTail && (r.view?.messages?.length || 0) <= 50;
      const delta = typeof sessionSyncRead === 'function' && latestWindow ? await sessionSyncRead({kind:'room',id},{limit:50},gen) : null;
      const v = delta ? {...delta.state,messages:delta.items.map(i=>i.value),...delta.window} : await api(`/api/rooms/${id}`);
      if (!roomCurrent(id, gen)) return;
      const latestSeq = v.messages.at(-1)?.seq || 0;
      const previous = r.view, box = document.querySelector('.room-timeline');
      const reading = sessionReadingCapture(box, r.atBottom);
      if (!delta && !(latestWindow&&r.deltaEnabled) && previous?.messages?.length && v.messages?.length) {
        const known = new Map(previous.messages.map(m => [m.seq, m]));
        for (const m of v.messages) known.set(m.seq, m);
        const gap = v.messages[0].seq > previous.messages.at(-1).seq + 1;
        let messages = [...known.values()].filter(m => m.seq <= (v.lastSeq ?? v.messages.at(-1).seq)).sort((a, b) => a.seq - b.seq);
        if (gap) messages = r.atBottom ? v.messages : previous.messages.map(m => v.messages.find(x => x.seq === m.seq) || m);
        const trimmed = messages.length > 200;
        if (trimmed) messages = r.atBottom ? messages.slice(-200) : messages.slice(0, 200);
        const firstSeq = v.messages[0]?.seq;
        v.messages = messages; v.hasMore = messages[0]?.seq < firstSeq ? previous.hasMore : v.hasMore || (trimmed && r.atBottom);
        r.trimmedTail = messages.at(-1)?.seq < latestSeq;
      }
      const oldSeq = new Set(previous?.messages?.map(m => m.seq) || []);
      if (!r.atBottom) r.newCount += v.messages.filter(m => !oldSeq.has(m.seq)).length;
      const changed = JSON.stringify(previous) !== JSON.stringify(v);
      r.deltaEnabled=!!delta;
      r.view = changed ? v : previous; r.syncing = false; r.syncError = ''; r.statusConfirmed = true;
      r.diskDisplay = null;
      r.appliedSyncCursor=delta?.cursor;r.appliedSyncEpoch=delta?.epoch;
      if ((!delta?.unchanged || !previous) && typeof sessionPersistCurrent === 'function') sessionPersistCurrent({kind:'room',id});
      roomConnect(id, gen); rtRenderNavStatus();
      if (changed && previous) roomRenderSoft(true, previous, reading); else if (previous) roomRenderSoft(false);
      for (const seq of Object.keys(r.roundView)) if (r.roundView[seq] === 'compare') void roomRoundLoad(Number(seq), true);
    } catch (e) {
      if (!roomCurrent(id, gen)) return;
      r.syncing = false; r.syncError = e.message; r.statusConfirmed = false;
      if ([401,403,404,410].includes(e.status)) {
        if (typeof sessionSyncInvalidate === 'function') sessionSyncInvalidate({kind:'room',id});
        if (typeof sessionPersistenceInvalidate === 'function') void sessionPersistenceInvalidate(e.status === 401 ? undefined : {kind:'room',id});
        r.diskDisplay = null; r.diskAuthorized = false; r.diskRestorePending = false;
        sessionSnapshotDrop(`room:${id}`); r.view = null; r.error = e.message; roomStop(); r.generation++;
        document.getElementById('main')?.replaceChildren(h('p',{class:'field-error',role:'alert'},e.message));
        if (e.status === 401) sessionCachesClear();
        renderMain();
      } else if (r.view) roomRenderSoft(false);
      else { r.error = e.message; renderMain(); }
    }
  });
}
function roomRenderSoft(changed, previous, reading) {
  if (typeof composing !== 'undefined' && composing) { renderDeferred = true; return; }
  const r = ui.room, v = r.view, center = document.querySelector('.room-center');
  if (!v || !center) return;
  const oldBox = center.querySelector('.room-timeline');
  reading ||= sessionReadingCapture(oldBox, r.atBottom);
  if (changed) {
    // Keep rows whose full payload and member display context are unchanged.
    const messagesSame = previous && JSON.stringify(previous.messages) === JSON.stringify(v.messages);
    const membersSame = previous && JSON.stringify(previous.members) === JSON.stringify(v.members);
    if (!messagesSame || !membersSame) {
      const next = roomTimeline(v);
      if (membersSame && !Object.values(r.roundView).includes('compare')) {
        const oldMessages = new Map(previous.messages.map(m => [m.seq, m]));
        for (const row of next.querySelectorAll('[data-room-seq]')) {
          const seq = Number(row.dataset.roomSeq), message = v.messages.find(m => m.seq === seq);
          if (JSON.stringify(oldMessages.get(seq)) === JSON.stringify(message)) {
            const old = oldBox?.querySelector(`[data-room-seq="${seq}"]`); if (old) row.replaceWith(old);
          }
        }
      }
      oldBox?.replaceWith(next); sessionReadingWatch(next, reading);
    } else {
      const typing = oldBox?.querySelector('.room-typing');
      if (typing) typing.replaceWith(roomTyping(v), r.newCount ? h('button', {class:'btn small', onclick: () => { r.atBottom = true; r.newCount = 0; box.scrollTop = box.scrollHeight; }}, `${r.newCount} 条新内容 ↓`) : null);
    }
    center.querySelector('.room-head')?.replaceWith(roomHead(v));
    const side = document.querySelector('.room-members'); if (side) side.replaceWith(roomSide(v));
  }
  const side = document.querySelector('.room-members'); if (side) side.replaceWith(roomSide(v));
  const sync = center.querySelector('#room-sync'); if (sync) sync.replaceWith(sessionSyncNote(r, () => roomRefresh(), 'room-sync'));
  center.querySelector('.room-approvals')?.replaceWith(roomApprovals(v));
  // Editing permissions and archival changes patch the composer only when necessary.
  const composer = center.querySelector('.room-composer');
  if (!composer && !v.room.archived) { center.querySelector('.room-archived-note')?.remove(); center.append(roomComposer()); }
  if (v.room.archived && !center.querySelector('.room-archived-note')) center.append(h('p',{class:'muted room-archived-note'},'群聊已归档，恢复后可以继续发言。'));
  if (composer) {
    composer.hidden = !!v.room.archived;
    const enabled = roomEditable();
    composer.dataset.startupSendReady = String(enabled);
    composer.querySelectorAll('button, textarea').forEach(el => { if (el.matches('textarea')) { el.disabled = !!r.busy || !ui.rt.access?.control; return; } if (el.textContent.trim() === '发送') el.disabled = !enabled || !r.draft.text.trim(); });
  }
}
async function roomAction(fn) { if (ui.room.busy) return; ui.room.busy = true; ui.room.error = ""; renderMain(); try { await fn(); } catch (e) { ui.room.error = e.message; } finally { ui.room.busy = false; renderMain(); } }
function roomActiveMembers() { return (ui.room.view?.members || []).filter((m) => !m.removedAt); }
function roomMember(id) { return (ui.room.view?.members || []).find((m) => m.memberId === id); }
function roomEditable() { return ui.room.statusConfirmed !== false && !!ui.rt.access?.control && !ui.room.view?.room.archived && !ui.room.busy; }
function roomModel(m) { return m?.session?.effectiveModel || m?.binding.model; }
function roomAvatar(m, size) { return m ? rtAvatar(m.binding.runtimeKind, roomModel(m), size) : h("span", { class: `rt-avatar${size ? ` ${size}` : ""}`, "aria-hidden": "true" }, h("span", { class: "rt-avatar-mono" }, "?")); }
const roomAvatarSpec = (m) => ({ kind: m.binding.runtimeKind, model: roomModel(m) });
function roomName(m) { return m.kind === "human" ? "你" : m.author.replace(/^@/, ""); }
function roomClock(iso) { return iso ? new Date(iso).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" }) : ""; }
/** 预览用纯文本：去掉 markdown 标记 */
function roomSnippet(text, n = 60) { const t = String(text || "").replace(/```[\s\S]*?```/g, " [代码] ").replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "").replace(/[*_`|]+/g, "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; }
const roomEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 正文里的 @别名 → 成员 ID（@全部 = 所有在场成员）；长别名优先，避免「计」吞掉「计划」 */
function roomMentionsIn(text, members = roomActiveMembers()) {
  const end = "(?=$|[\\s，。、,.!?！？:：;；)）\\]】])";
  if (new RegExp(`(^|[^\\w@])@全部${end}`).test(text)) return members.map((m) => m.memberId);
  let rest = text; const out = [];
  for (const m of [...members].sort((a, b) => b.alias.length - a.alias.length)) {
    const re = new RegExp(`(^|[^\\w@])@${roomEscape(m.alias)}(?![\\w])`, "g");
    if (re.test(rest)) { out.push(m.memberId); rest = rest.replace(re, "$1"); }
  }
  return out;
}
/** 消息正文里的 @别名 高亮 */
function roomTextWithMentions(text) {
  const names = [...roomActiveMembers().map((m) => m.alias), "全部"].sort((a, b) => b.length - a.length).map(roomEscape);
  if (!names.length) return [text];
  const parts = String(text).split(new RegExp(`(@(?:${names.join("|")}))`, "g"));
  return parts.map((p, i) => i % 2 ? h("span", { class: "room-at" }, p) : p);
}

/* ------------------------------ 新建 ------------------------------ */

function roomMemberEditor(member, index, onRemove) {
  const profiles = ui.rt.profiles || [], p = profiles.find((p) => p.runtimeKind === member.runtimeKind), model = p?.models.find((m) => m.id === member.model) || p?.models.find((m) => m.isDefault);
  const field = (label, node) => h("label", {}, h("span", {}, label), node);
  const select = (label, value, options, change) => h("select", { "aria-label": label, value, onchange: (e) => { change(e.target.value); renderMain(); } }, options.map(([value, text]) => h("option", { value }, text)));
  // h() 设置 select.value 早于添加 options，显式在添加后设置。
  const choice = (label, value, options, change) => { const el = select(label, value, options, change); el.value = value; return el; };
  return h("fieldset", { class: "room-member-editor" }, h("legend", {}, rtAvatar(member.runtimeKind, member.model || model?.id, "sm"), ` 成员 ${index + 1}`),
    field("别名（群里 @ 它用）", h("input", { value: member.alias, "aria-label": `成员 ${index + 1} 别名`, "data-key": `room-alias-${index}`, maxlength: 32, oninput: (e) => { member.alias = e.target.value; ui.room.createKey = null; } })),
    field("运行时", choice(`成员 ${index + 1} 运行时`, member.runtimeKind, RT_KINDS.map((k) => [k, RT_KIND[k]]), (v) => { member.runtimeKind = v; member.model = ""; member.effort = ""; member.permissionMode = ""; ui.room.createKey = null; })),
    field("模型", choice(`成员 ${index + 1} 模型`, member.model || "", [["", "运行时默认"], ...(p?.models || []).map((m) => [m.id, m.label])], (v) => { member.model = v; member.effort = ""; ui.room.createKey = null; })),
    field("推理强度", choice(`成员 ${index + 1} 推理强度`, member.effort || "", [["", "默认"], ...(model?.efforts || []).map((v) => [v, v])], (v) => { member.effort = v; ui.room.createKey = null; })),
    ui.room.view?.room?.worktree && !ui.room.view.room.worktree.cleanedAt ? field("权限", roomPermSelect(member, `成员 ${index + 1} 权限`, (v) => { member.permissionMode = v; renderMain(); })) : null,
    p?.state !== "executable" || p?.capabilities.roleInstructions?.status !== "supported" ? h("p", { class: "small field-error" }, "请检查连接：群聊需要运行时支持系统级角色注入") : null,
    onRemove ? h("button", { type: "button", class: "btn small", onclick: onRemove }, "移除") : null);
}
function roomMemberPayload(m) { const p = (ui.rt.profiles || []).find((p) => p.runtimeKind === m.runtimeKind); return { alias: m.alias, runtimeKind: m.runtimeKind, ...(m.model ? { model: m.model } : {}), ...(m.effort ? { effort: m.effort } : {}), ...(m.permissionMode ? { permissionMode: m.permissionMode } : {}), confirmedProfileVersion: p?.checkedAt }; }
/** 可写成员可选的权限（不越出工作区，和对比组 worktree 的规则一致）；空串 = 只读 */
const ROOM_WRITE_MODES = { codex: ["ask", "auto-review"], "claude-code": ["default", "acceptEdits"], pi: ["pi-ask"], antigravity: ["default", "acceptEdits", "auto"] };
function roomPermLabel(kind, mode) {
  if (!mode) return "只读";
  const p = (ui.rt.profiles || []).find((x) => x.runtimeKind === kind), opt = p && p.permissionOptions ? p.permissionOptions.find((x) => x.id === mode) : null;
  return `可写 · ${opt ? opt.label : mode}`;
}
/** 权限下拉：只读，或在独立 worktree 里可写 */
function roomPermSelect(m, label, onChange) {
  const el = h("select", { "aria-label": label, onchange: (ev) => onChange(ev.target.value) }, h("option", { value: "" }, "只读"), (ROOM_WRITE_MODES[m.runtimeKind] || []).map((id) => h("option", { value: id }, roomPermLabel(m.runtimeKind, id))));
  el.value = m.permissionMode || ""; return el;
}
function roomListToggle() { return h("button", { type: "button", class: "btn small rt-list-toggle", "aria-expanded": String(ui.rt.listOpen), onclick: () => { ui.rt.listOpen = !ui.rt.listOpen; renderMain(); } }, "会话列表"); }
const ROOM_KIND_ALIAS = { codex: "codex", "claude-code": "claude", pi: "pi", antigravity: "agy" };
function roomNewSave() {
  const f = ui.room.new;
  try { localStorage.setItem(ROOM_NEW_KEY, JSON.stringify({ version: 1, members: f.members.map(({ alias, aliasAuto, runtimeKind, model, effort, permissionMode }) => ({ alias, aliasAuto, runtimeKind, model, effort, permissionMode })), settings: f.settings })); } catch { /* 存储不可用时只保留页面内的草稿 */ }
}
/** 自动别名：用运行时名；重名时加序号。手动改过的别名不动 */
function roomAutoAliases() {
  const f = ui.room.new, used = new Set(f.members.filter((m) => !m.aliasAuto && m.alias.trim()).map((m) => m.alias.trim()));
  for (const m of f.members.filter((m) => m.aliasAuto || !m.alias.trim())) {
    const base = ROOM_KIND_ALIAS[m.runtimeKind] || "成员";
    let alias = base, n = 2; while (used.has(alias)) alias = `${base}${n++}`;
    m.alias = alias; m.aliasAuto = true; used.add(alias);
  }
}
function roomMemberProblem(m) {
  const p = (ui.rt.profiles || []).find((x) => x.runtimeKind === m.runtimeKind);
  if (!p) return ui.rt.profiles === null ? "正在读取连接状态…" : "尚未检查连接";
  if (p.state !== "executable") return `当前不可执行：${p.stateReason}`;
  if (p.capabilities?.roleInstructions?.status !== "supported") return "这个运行时版本不支持系统级角色注入，不能进群聊，需要到运行时配置重新检查连接";
  if (!rtWorkspaceRoots(m.runtimeKind).length) return "尚未配置允许的工作目录根";
  const sel = rtSelectableModels(m.runtimeKind, p);
  if (!m.model && !sel.defaultAllowed && !sel.models.length) return "运行时配置里没有勾选可用的模型";
  if (!m.alias.trim()) return "别名不能为空";
  if (/[\s@/\\]/.test(m.alias)) return "别名不能含空格、@ 或斜杠";
  if (ui.room.new.members.filter((x) => x.alias.trim() === m.alias.trim()).length > 1) return "别名重复";
  return "";
}
/** 新建前看工作目录：git 仓库才能有可写成员（各自一个 worktree，从当前 HEAD 切出） */
function roomNewGitKey() { const f = ui.room.new; return `${rtForm().workspace.trim()}|${[...new Set(f.members.map((m) => m.runtimeKind))].sort().join(",")}`; }
async function roomNewLoadGit() {
  const r = ui.room, key = roomNewGitKey(), ws = rtForm().workspace.trim();
  if (!ws.startsWith("/")) { r.newGit = null; return; }
  r.newGit = { key, loading: true };
  try { const data = await api(`/api/runtime-comparisons/workspace-info?cwd=${encodeURIComponent(ws)}&runtimes=${encodeURIComponent(key.split("|")[1])}`); if (r.newGit?.key === key) r.newGit = { key, data }; }
  catch (e) { if (r.newGit?.key === key) r.newGit = { key, error: e.message }; }
  if (ui.view === "rt-room-new") renderMain();
}
/** 当前工作目录能否放可写成员：返回 git 信息，不能时返回 null */
function roomNewWritable() {
  const st = ui.room.newGit;
  if (!st || st.key !== roomNewGitKey()) { if (rtForm().workspace.trim().startsWith("/") && !(st && st.loading && st.key === roomNewGitKey())) void roomNewLoadGit(); return null; }
  const g = st.data && st.data.git;
  return g && g.worktreeAllowed ? g : null;
}
function roomNewRow(m, i, members) {
  const p = (ui.rt.profiles || []).find((x) => x.runtimeKind === m.runtimeKind), sel = rtSelectableModels(m.runtimeKind, p);
  if (p && m.model && !sel.models.some((x) => x.id === m.model)) m.model = "";
  if (p && !m.model && !sel.defaultAllowed && sel.models.length) m.model = sel.models[0].id;
  const mo = rtModelOption(p, m.model);
  if (p && m.effort && !(mo?.efforts || []).includes(m.effort)) m.effort = "";
  const problem = roomMemberProblem(m), n = i + 1;
  const change = () => { ui.room.error = ""; ui.room.createKey = null; roomAutoAliases(); roomNewSave(); renderMain(); };
  const perm = roomNewWritable() ? roomPermLabel(m.runtimeKind, m.permissionMode) : "只读";
  const effortText = m.effort ? (RT_EFFORT[m.effort] || m.effort) : "";
  const advSummary = [effortText, m.permissionMode ? perm : ""].filter(Boolean).join(" · ");
  return h("div", { class: `rtc-lane-row room-new-row${problem ? " problem" : ""}`, role: "group", "aria-label": `成员 ${n}` },
    rtAvatar(m.runtimeKind, m.model || (mo && mo.id)),
    h("span", { class: "room-new-alias", title: "群里 @ 它用的名字，按运行时自动起", "data-key": `room-alias-${i}` }, `@${m.alias}`),
    h("label", { class: "rt-new-control" }, h("select", { "aria-label": `成员 ${n} 运行时`, "data-key": `room-kind-${i}`, onchange: (ev) => { m.runtimeKind = ev.target.value; m.model = ""; m.effort = ""; m.permissionMode = ""; if (i === 0) { ui.rt.wsOpen = false; ui.rt.folders = null; } change(); } },
      RT_KINDS.map((k) => h("option", { value: k, selected: k === m.runtimeKind }, RT_KIND[k])))),
    h("label", { class: "rt-new-control" }, h("select", { "aria-label": `成员 ${n} 模型`, "data-key": `room-model-${i}`, onchange: (ev) => { m.model = ev.target.value; m.effort = ""; change(); } },
      sel.defaultAllowed ? h("option", { value: "", selected: !m.model }, "默认模型") : null,
      sel.models.map((x) => h("option", { value: x.id, selected: m.model === x.id }, x.label)))),
    h("button", { type: "button", class: `room-new-adv${m.advOpen ? " open" : ""}`, "aria-expanded": String(!!m.advOpen), title: "推理强度、读写权限", onclick: () => { m.advOpen = !m.advOpen; renderMain(); } }, advSummary ? `高级 · ${advSummary}` : "高级"),
    m.advOpen ? h("div", { class: "room-new-adv-panel" },
      mo && mo.efforts && mo.efforts.length ? h("label", { class: "rt-new-control" }, h("span", { class: "muted small" }, "推理强度"), h("select", { "aria-label": `成员 ${n} 推理强度`, "data-key": `room-effort-${i}`, onchange: (ev) => { m.effort = ev.target.value; change(); } },
        h("option", { value: "", selected: !m.effort }, rtDefaultEffortLabel(mo)),
        mo.efforts.map((e) => h("option", { value: e, selected: m.effort === e }, `${RT_EFFORT[e] || e}`)))) : null,
      roomNewWritable() ? h("label", { class: "rt-new-control", title: "可写成员在自己的 git worktree 里改文件，采用前不影响原目录" }, h("span", { class: "muted small" }, "权限"), roomPermSelect(m, `成员 ${n} 权限`, (v) => { m.permissionMode = v; change(); }))
        : h("span", { class: "rtc-perm small", title: "工作目录不是有 commit 的 git 仓库时，成员只能只读" }, "只读（工作目录不是 git 仓库）")) : null,
    problem ? h("span", { class: "rtc-lane-problem small", role: "note" }, problem, / 重新检查/.test(problem) ? [" ", h("a", { href: "#/runtimes" }, "去运行时配置")] : null) : null,
    h("button", { type: "button", class: "rtc-lane-remove", "aria-label": `移除成员 ${n}`, title: members.length <= 1 ? "至少保留 1 名成员" : "移除", disabled: members.length <= 1,
      onclick: () => { members.splice(i, 1); if (i === 0) { ui.rt.wsOpen = false; ui.rt.folders = null; } change(); } }, "×"));
}
/** 群名称没填：取第一条消息的第一句，没有消息就用成员别名 */
function roomAutoTitle(f) {
  const first = String(f.prompt || "").replace(/@\S+\s*/g, "").split(/[\n。！？!?]/)[0].trim();
  return (first ? first.slice(0, 24) : `${f.members.map((m) => m.alias.trim()).join("、")} 的讨论`).slice(0, 120);
}
async function roomCreateAndSend() {
  const r = ui.room, f = r.new, rf = rtForm(), workspace = rf.workspace.trim();
  if (r.busy) return;
  roomAutoAliases();
  const bad = f.members.map(roomMemberProblem).find(Boolean);
  if (bad) { r.error = bad; renderMain(); return; }
  if (!workspace.startsWith("/")) { r.error = "请先选择工作目录"; ui.rt.wsOpen = true; renderMain(); return; }
  const prompt = f.prompt.trim();
  r.busy = true; r.error = ""; renderMain();
  let room;
  try {
    const git = roomNewWritable();
    const members = f.members.map((m) => roomMemberPayload(git ? m : { ...m, permissionMode: "" }));
    const writers = members.some((m) => m.permissionMode);
    const result = await api("/api/rooms", { method: "POST", body: JSON.stringify({ idempotencyKey: r.createKey || (r.createKey = roomKey()), title: f.title.trim() || roomAutoTitle(f), workspace, members, settings: f.settings, ...(writers ? { confirmedBaseCommit: git.head } : {}) }) });
    room = result.room; r.createKey = null;
  } catch (e) { r.error = e.message; r.busy = false; renderMain(); return; }
  let sendError = "";
  if (prompt) {
    // 第一条消息：@ 了谁就发给谁；一个都没 @ 就发给全部成员
    const mentions = roomMentionsIn(prompt, room.members);
    try { await api(`/api/rooms/${room.roomId}/messages`, { method: "POST", body: JSON.stringify({ idempotencyKey: roomKey(), text: prompt, quotes: [], mentions: mentions.length ? mentions : "all" }) }); }
    catch (e) { sendError = e.message; try { sessionStorage.setItem(`pi-room-draft:${room.roomId}`, JSON.stringify({ text: prompt, quotes: [] })); } catch { /* 草稿只保留在页面里 */ } }
  }
  f.prompt = ""; f.title = ""; r.busy = false; ui.rt.dir = null;
  rtEnterCreated(`#/rt/room/${room.roomId}`);
  if (sendError) setTimeout(() => { ui.room.error = `群聊已创建，但第一条消息没有发出：${sendError}。消息留在输入框里，可以直接重发`; renderMain(); }, 300);
}
function renderRoomNew() {
  rtSyncChrome();
  const layout = h("div", { class: `rt-layout rt-layout-new${ui.rt.listOpen ? " list-open" : ""}` }, rtList(), h("section", { class: "rt-center rt-new-center", "aria-label": "新建群聊" }, roomNewPage()));
  return h("div", { class: "rt-page rt-page-new" }, rtAccessNote(), layout);
}
function roomNewGitNote() {
  const st = ui.room.newGit, g = roomNewWritable(), writers = ui.room.new.members.filter((m) => m.permissionMode).length;
  if (!st || st.loading) return null;
  if (!g) return h("p", { class: "muted small room-git-note" }, st.data && st.data.git && !st.data.git.worktreeAllowed ? "仓库根不在所有成员运行时的允许工作目录里：成员只能只读" : "工作目录不是有 commit 的 git 仓库：成员全部只读");
  return h("p", { class: `small room-git-note${writers ? "" : " muted"}` },
    `git 仓库 ${g.repoRoot}${g.branch ? `（${g.branch}）` : ""}：可写成员各自在 .pi-compare/ 下的 worktree 里改文件，都从 ${g.head.slice(0, 10)} 切出，采用前原目录不变。`,
    g.dirty ? ` 原目录现有 ${g.dirty} 个未提交改动，不会带进 worktree。` : "",
    writers ? ` 当前 ${writers} 名可写成员。` : " 把成员权限改成「可写」就能让它改文件。");
}
function roomNewOptionsSummary(rf, f, members) {
  const workspace = (rf.workspace || "").trim();
  return h("span", { class: "rt-new-options-summary" },
    h("span", { class: "rt-new-options-line rt-new-options-workspace" },
      h("span", { class: "rt-new-options-path", title: workspace || "没有选择工作目录" }, workspace || "没有选择")),
    h("span", { class: "rt-new-options-line rt-new-options-mode" },
      h("span", { class: "rt-new-options-text" }, `${members.length} 名成员`)));
}
function roomNewPage() {
  const r = ui.room, f = r.new, a = ui.rt.access, rf = rtForm();
  if (a && !a.control) return h("div", { class: "rt-form-page" }, h("h1", {}, "新建群聊"), rtAccessNote() || h("p", { class: "muted" }, "当前入口没有控制权限"));
  roomAutoAliases();
  const members = f.members, roots = rtWorkspaceRoots(members[0].runtimeKind);
  const ready = members.every((m) => !roomMemberProblem(m)) && !!rf.workspace.trim();
  return h("div", { class: "rt-new-page" },
    h("div", { class: "rt-new-nav" }, roomListToggle(), rtNewBackLink(), h("a", { href: "#/runtimes" }, "运行时配置")),
    h("div", { class: "rt-new-scroll", "data-keep-scroll": "room-new-scroll" },
      h("div", { class: "rt-new-intro" }, h("span", { class: "rt-new-eyebrow" }, "新建群聊"), h("h1", {}, "拉几个 Agent 一起讨论"),
        h("p", { class: "muted" }, "像群聊一样：@ 谁谁回复，引用别人的发言，被 @ 的成员就能看到。适合方案互审、多角度评估。")),
      h("ul", { class: "rtc-intro-points muted small" },
        h("li", {}, "成员按运行时自动起名（@codex、@claude、@pi），同一运行时拉多个会自动加序号；群名称也自动生成，进群后可以改。"),
        h("li", {}, "第一条消息没有 @ 任何人时发给全部成员；不写也可以，先建群再说。"),
        h("li", {}, "成员默认只读，需要更多上下文时会读工作目录 .pi-room/ 下的讨论快照；要让谁改文件，在它的「高级」里选可写。"))),
    h("section", { class: "rt-new-dock", "aria-label": "新建群聊" },
      rtNewModeSwitch(),
      h("div", { class: "rt-new-composer" },
        h("div", { class: "rtc-lanes room-new-lanes" }, members.map((m, i) => roomNewRow(m, i, members)),
          h("button", { type: "button", class: "btn small rtc-lane-add room-new-add", disabled: members.length >= ROOM_MAX_MEMBERS, title: members.length >= ROOM_MAX_MEMBERS ? `最多 ${ROOM_MAX_MEMBERS} 名成员` : "",
            onclick: () => { const last = members[members.length - 1]; members.push({ alias: "", aliasAuto: true, runtimeKind: last.runtimeKind === "codex" ? "claude-code" : last.runtimeKind === "claude-code" ? "pi" : "codex", model: "", effort: "" }); r.createKey = null; roomAutoAliases(); roomNewSave(); renderMain(); } }, "＋ 添加成员")),
        h("textarea", { class: "rt-new-prompt", rows: "3", "aria-label": "第一条消息", "data-key": "room-prompt", value: f.prompt,
          placeholder: "第一条消息（可选）：发给全部成员，也可以 @ 指定。比如：@全部 分析下 v3.5 的设计是否合理",
          oninput: (ev) => { f.prompt = ev.target.value; r.error = ""; },
          onkeydown: (ev) => { if (!rtIsSendKey(ev)) return; ev.preventDefault(); void roomCreateAndSend(); } }),
        h("div", { class: "rt-new-toolbar" },
          rtNewOptions(roomNewOptionsSummary(rf, f, members), rtWorkspacePicker(rf, roots, a),
            h("button", { type: "button", class: `rt-new-control room-settings-toggle${r.newSettingsOpen ? " open" : ""}`, "aria-expanded": String(!!r.newSettingsOpen), onclick: () => { r.newSettingsOpen = !r.newSettingsOpen; renderMain(); } }, "⚙ 设置")),
          h("button", { type: "button", class: "rt-new-send", "aria-label": "创建群聊", title: f.prompt.trim() ? "建群并发出第一条消息（Enter）" : "建群（Enter）", disabled: r.busy || !ready, onclick: () => void roomCreateAndSend() }, r.busy ? "…" : "↑"))),
      r.newSettingsOpen ? roomSettings(f.settings, (s) => { f.settings = s; r.createKey = null; roomNewSave(); renderMain(); }) : null,
      r.error ? h("p", { class: "field-error", role: "alert" }, r.error) : null,
      roomNewGitNote(),
      h("p", { class: "rt-new-footnote muted small" }, `${members.length} 名成员 · 快照写在工作目录的 .pi-room/ 中，git 仓库会自动本地忽略`)));
}
/** 群名称：进群后在群聊设置里改（新建页不再填） */
function roomTitleEditor(room, control) {
  const r = ui.room, disabled = !control || room.archived;
  // 后台刷新（SSE 触发的 roomRefresh）会整块重绘：没保存的群名称先记在 r.renameDraft 里，重绘后接着显示
  const input = h("input", { value: typeof r.renameDraft === "string" ? r.renameDraft : room.title, maxlength: 120, "aria-label": "群名称", "data-key": "room-rename", disabled,
    oninput: (ev) => { r.renameDraft = ev.target.value; } });
  const save = () => { const t = input.value.trim(); if (!t || t === room.title) { r.renameDraft = ""; input.value = room.title; return; } r.renameDraft = ""; void roomAction(async () => { await api(`/api/rooms/${r.id}/title`, { method: "PATCH", body: JSON.stringify({ title: t }) }); await roomRefresh(); await rtLoadDir(); }); };
  input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); save(); } });
  return h("label", { class: "room-rename" }, "群名称", input, h("button", { type: "button", class: "btn small", disabled, onclick: save }, "保存"));
}
function roomSettings(settings, change, disabled = false) {
  const options = (label, value, pairs, key) => { const el = h("select", { "aria-label": label, disabled, onchange: (e) => change({ ...settings, [key]: e.target.value }) }, pairs.map(([v, title]) => h("option", { value: v }, title))); el.value = value; return h("label", {}, label, el); };
  return h("div", { class: "room-settings" }, options("来源显示", settings.attribution, [["shown", "向成员显示 runtime 和模型"], ["anonymous", "向成员隐藏 runtime 和模型"]], "attribution"), options("快照共享范围", settings.shareScope, [["replies", "只共享回复"], ["summary", "回复 + 工具摘要"], ["full", "完整过程（包含工具输出）"]], "shareScope"));
}

/* ------------------------------ 草稿：引用、回复、快捷指令 ------------------------------ */

/** 草稿被程序改写后（选成员、回复、快捷指令）：聚焦输入框，光标放到末尾 */
function roomFocusInput() { requestAnimationFrame(() => { const el = document.querySelector('[data-key="room-input"]'); if (!el) return; el.focus(); el.setSelectionRange(el.value.length, el.value.length); }); }
async function roomQuote(message, selected = false) {
  const r = ui.room; if (!roomEditable()) return;
  let quote = { seq: message.seq };
  if (selected) {
    const sel = window.getSelection(), box = document.querySelector(`[data-room-text="${message.seq}"]`);
    if (!sel?.rangeCount || !box || sel.isCollapsed || !box.contains(sel.anchorNode) || !box.contains(sel.focusNode)) { r.error = "先在这条消息里选中要引用的文字"; renderMain(); return; }
    const range = sel.getRangeAt(0), before = document.createRange(), picked = range.toString(); before.selectNodeContents(box); before.setEnd(range.startContainer, range.startOffset);
    // 纯文本显示时按显示偏移；排版显示（markdown）时在原文里找这段文字，找不到就请人切到原文再选
    let start = before.toString().length;
    if (message.text.slice(start, start + picked.length) !== picked) start = message.text.indexOf(picked);
    if (start < 0 || !picked) { r.error = "选中的文字带了排版，和原文对不上：点这条消息的「原文」再选"; renderMain(); return; }
    const end = start + picked.length;
    quote = { seq: message.seq, span: { start, end } };
    if (crypto.subtle) {
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message.text.slice(start, end)));
      quote.hash = `sha256:${Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    }
  }
  r.draft.quotes = r.draft.quotes.filter((q) => q.seq !== message.seq); r.draft.quotes.push(quote); roomDraftChanged(); renderMain(); roomFocusInput();
}
/** 回复成员：引用这条，并在开头 @ 它 */
function roomReply(message) {
  const r = ui.room, member = roomMember(message.memberId); if (!roomEditable()) return;
  r.draft.quotes = r.draft.quotes.filter((q) => q.seq !== message.seq); r.draft.quotes.push({ seq: message.seq });
  if (member && !roomMentionsIn(r.draft.text).includes(member.memberId)) r.draft.text = `@${member.alias} ${r.draft.text}`;
  roomDraftChanged(); renderMain(); roomFocusInput();
}
function roomShortcut(kind, targetId) {
  const r = ui.room, members = roomActiveMembers(), messages = r.view?.messages || [];
  if (!roomEditable()) return;
  if (kind === "review") {
    r.draft.quotes = members.flatMap((member) => { const msg = (r.view.latestReplies || messages).filter((m) => m.kind === "member" && m.memberId === member.memberId).at(-1); return msg ? [{ seq: msg.seq }] : []; });
    r.draft.text = "@全部 评审其他成员的方案，按 blocker / major / minor 列出问题，每条给出证据（文件:行）和建议；不要评自己的方案。";
  } else {
    const target = members.find((m) => m.memberId === targetId) || members[0]; if (!target) return;
    const others = messages.filter((m) => m.kind === "member" && m.memberId !== target.memberId);
    const targeted = others.filter((m) => m.text.includes(`@${target.alias}`) || m.quotes?.some((q) => q.source?.memberId === target.memberId) || messages.find((x) => x.seq === m.replyTo)?.mentions?.includes(target.memberId));
    r.draft.quotes = (targeted.length ? targeted : others).slice(-8).map((m) => ({ seq: m.seq }));
    r.draft.text = `@${target.alias} 逐条回应：接受 / 拒绝 / 部分接受，并给出理由，最后给出修订后的方案。`;
  }
  roomDraftChanged(); renderMain(); roomFocusInput();
}
/** 输入框当前的弹出菜单：@ 成员，或行首 / 快捷指令 */
function roomPopup() {
  const r = ui.room, text = r.draft.text, members = roomActiveMembers();
  const at = text.match(/(?:^|\s)@([^\s@]*)$/);
  if (at) return { kind: "at", items: [{ memberId: "all", alias: "全部" }, ...members].filter((m) => m.alias.startsWith(at[1])).map((m) => ({ label: `@${m.alias}`, hint: m.memberId === "all" ? "所有成员都回复" : m.roleName || "纯 runtime", member: m.memberId === "all" ? null : m, run: () => { r.draft.text = text.replace(/@[^\s@]*$/, `@${m.alias} `); } })) };
  if (/^\/\S*$/.test(text)) return { kind: "slash", items: [
    { label: "/互评", hint: "引用每位成员最新的发言，@全部 互相评审", run: () => roomShortcut("review") },
    ...members.map((m) => ({ label: `/答辩 @${m.alias}`, hint: `引用别人对 @${m.alias} 的评审，请它逐条回应`, member: m, run: () => roomShortcut("rebuttal", m.memberId) }))
  ].filter((x) => x.label.startsWith(text)) };
  return null;
}
function roomPick(item) { item.run(); ui.room.pick = 0; roomDraftChanged(); renderMain(); roomFocusInput(); }
async function roomSend() {
  const r = ui.room, id = r.id, gen = r.generation, draft = r.draft;
  if (!roomEditable() || !draft.text.trim()) return;
  await roomAction(async () => {
    const mentions = roomMentionsIn(draft.text), key = r.key || (r.key = roomKey());
    await api(`/api/rooms/${id}/messages`, { method: 'POST', body: JSON.stringify({ idempotencyKey: key, text: draft.text, quotes: draft.quotes, mentions }) });
    sessionSnapshotDrop(`room:${id}`);
    try { sessionStorage.removeItem(`pi-room-draft:${id}`); } catch { /* Draft storage unavailable. */ }
    if (!roomCurrent(id, gen)) return;
    r.draft = { text: '', quotes: [] }; roomDraftChanged(); r.atBottom = true; r.reading = { atBottom: true }; announce('已发送'); void roomRefresh();
  });
  if (roomCurrent(id, gen)) roomFocusInput();
}

/* ------------------------------ 群聊页 ------------------------------ */

function renderRoom() {
  // 与单聊一致：手机上详情页隐藏全局顶栏，由头部导航栏接管
  if (typeof rtSyncChrome === "function") rtSyncChrome();
  const r = ui.room, v = r.view;
  const center = !v && r.diskDisplay && typeof sessionDiskPanel === 'function' ? sessionDiskPanel({kind:'room',id:r.id},r.diskDisplay) : !v ? h("section", { class: "rt-center" }, rtPhone.matches && r.id ? rtHeadLoading("room") : roomListToggle(), r.error ? h("p", { class: "field-error", role: "alert" }, r.error) : h("p", { class: "muted" }, "正在读取群聊…"))
    : h("section", { class: "rt-center room-center", "aria-label": "群聊" }, roomHead(v), sessionSyncNote(r, () => roomRefresh(), 'room-sync'), r.error ? h("div", { class: "rt-banner warn", role: "alert" }, r.error, " ", h("button", { class: "btn small", onclick: () => roomRefresh() }, "刷新")) : null, roomTimeline(v), roomApprovals(v), r.diffOpen ? roomDiffDrawer(r.diffOpen) : null, v.room.archived ? h("p", { class: "muted room-archived-note" }, "群聊已归档，恢复后可以继续发言。") : roomComposer());
  const side = v ? roomSide(v) : null;
  const handle = v ? rtSideHandle({ collapsed: !roomMembersExpanded(), label: "群聊成员", controls: "room-members", className: "room-side-handle", onclick: roomToggleMembers }) : null;
  return h("div", { class: "rt-page" }, rtAccessNote(), h("div", { class: `rt-layout room-layout${ui.rt.listOpen ? " list-open" : ""}${r.membersOpen ? " members-open" : ""}${r.membersHidden ? " members-hidden" : ""}` }, rtList(), center, side, handle, v ? h("button", { type: "button", class: "room-members-backdrop", tabindex: "-1", "aria-label": "关闭群聊成员浮层", onclick: roomToggleMembers }) : null));
}
/** 头部状态标签行：归档 + 成员运行/审批状态；手机与桌面共用同一份，保证两处一致（对齐单聊的状态标签） */
function roomTitleTags(v) {
  const members = (v.members || []).filter((m) => !m.removedAt);
  const busy = members.some((m) => ["creating", "running", "waiting-input", "stopping"].includes(m.session?.status));
  const waiting = members.reduce((n, m) => n + (m.approvals?.length || 0), 0);
  return h("div", { class: "rt-title-tags" },
    v.room.archived ? badge("已归档", "") : null,
    busy ? badge("回复中", "accent") : null,
    waiting ? badge(`等待审批 ${waiting}`, "warn") : null);
}
/**
 * 手机头部（与单聊一致）：返回 / 标题 / ⋮ 一行，第二行状态标签；
 * 点标题展开群聊信息（成员、工作目录与各自会话），成员、设置与归档收进 ⋮ 菜单。
 */
function roomHeadPhone(v, members) {
  const subOpen = !!ui.room.subOpen;
  const toggleSub = () => { if (ui.view !== "rt-room") return; ui.room.subOpen = !subOpen; renderMain(); };
  const control = !!(ui.rt.access && ui.rt.access.control) && ui.room.statusConfirmed !== false;
  const titleText = h("span", { class: "rt-title-text" }, v.room.title);
  const header = h("header", { class: "rt-head rt-head-phone room-head" },
    h("div", { class: "rt-head-nav" },
      h("button", { type: "button", class: "btn small rt-list-toggle rt-back", "aria-label": "会话列表", "aria-expanded": String(ui.rt.listOpen), onclick: () => roomOpenList() }, "‹"),
      h("div", { class: "rt-title-line" },
        h("h1", { class: "rt-title" },
          h("span", { class: "rt-title-toggle", role: "button", tabindex: "0", "aria-expanded": String(subOpen), "aria-controls": "room-sub-body", title: subOpen ? "收起群聊信息" : "展开群聊信息", onclick: toggleSub, onkeydown: (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggleSub(); } } }, titleText))),
      h("div", { class: `rt-more${ui.rt.moreOpen ? " open" : ""}` },
        h("button", { type: "button", class: "btn small rt-more-btn", "aria-label": "更多", "aria-expanded": String(!!ui.rt.moreOpen), "aria-controls": "room-more-sheet", onclick: () => rtToggleMore(!ui.rt.moreOpen) }, "⋮"),
        h("button", { type: "button", class: "rt-more-backdrop", tabindex: "-1", "aria-label": "关闭菜单", onclick: () => rtToggleMore(false) }),
        roomMoreSheet(v, control)),
      roomTitleTags(v)),
    subOpen ? h("div", { class: "rt-sub-block room-sub-block", id: "room-sub-body" },
      h("p", { class: "rt-sub-full-title" }, v.room.title),
      h("div", { class: "room-sub-top" }, roomGroupAvatar(members.map(roomAvatarSpec), 40),
        h("p", { class: "rt-sub muted small" }, roomSubText(v, members))),
      roomSubLinks(v)) : null);
  // 标题被单行截断时，展开的详情里补显示完整标题（与单聊一致）
  requestAnimationFrame(() => rtSyncSubTitle());
  return header;
}
function roomHead(v) {
  const members = roomActiveMembers();
  if (rtPhone.matches) return roomHeadPhone(v, members);
  return h("header", { class: "rt-head room-head" }, roomListToggle(),
    h("div", { class: "rt-title-row" },
      roomGroupAvatar(members.map(roomAvatarSpec), 40),
      h("div", { class: "rt-title-main" }, h("h1", { class: "rt-title" }, v.room.title),
        h("p", { class: "rt-sub muted small" }, roomSubText(v, members))),
      roomTitleTags(v)));
}
/** 副标题：成员数、可写成员（全部只读时点明）、工作目录；手机展开信息与桌面共用 */
function roomSubText(v, members) {
  const writers = members.filter((m) => m.worktree).length;
  return [`${members.length} 名成员`, writers ? `${writers} 名可写` : "全部只读", v.room.workspace].filter(Boolean).join(" · ");
}
/** 展开后的成员会话入口：手机头部不再放头像，改为这里的链接与群头像 */
function roomSubLinks(v) {
  const members = roomActiveMembers();
  if (!members.length) return null;
  return h("p", { class: "small room-sub-members" }, members.map((m) => h("a", { href: `#/rt/${m.platformSessionId}` }, `@${m.alias}`)));
}
function roomMoreSheet(v, control) {
  const room = v.room, busy = !!ui.room.busy;
  return h("div", { class: "rt-more-sheet", id: "room-more-sheet", role: "menu", "aria-label": "群聊菜单" },
    h("p", { class: "rt-more-title" }, "查看"),
    h("button", { type: "button", role: "menuitem", class: "rt-more-item", onclick: () => { rtToggleMore(false); roomToggleMembers(); } },
      h("span", { class: "rt-more-check", "aria-hidden": "true" }, roomMembersExpanded() ? "✓" : ""), h("span", { class: "rt-more-label" }, "群聊成员")),
    h("div", { class: "rt-more-sep", role: "separator" }),
    h("p", { class: "rt-more-title" }, "群聊设置"),
    h("div", { class: "rt-more-deploy" }, roomTitleEditor(room, control),
      roomSettings(room.settings, (settings) => roomAction(async () => { await api(`/api/rooms/${ui.room.id}/settings`, { method: "PATCH", body: JSON.stringify(settings) }); await roomRefresh(); }), !control || room.archived)),
    control && !busy ? h("div", { class: "rt-more-sep", role: "separator" }) : null,
    control && !busy ? h("button", { type: "button", role: "menuitem", class: "rt-more-item", onclick: async () => { rtToggleMore(false); if (!room.archived && !(await roomConfirmArchive(ui.room.id))) return; void roomAction(async () => { await api(`/api/rooms/${ui.room.id}/archive`, { method: "POST", body: JSON.stringify({ archived: !room.archived }) }); rtArchiveInvalidate(); await roomRefresh(); }); } },
      h("span", { class: "rt-more-check", "aria-hidden": "true" }), h("span", { class: "rt-more-label" }, room.archived ? "恢复" : "归档")) : null,
    h("div", { class: "rt-more-sep", role: "separator" }),
    h("button", { type: "button", role: "menuitem", class: "rt-more-item rt-more-cancel", onclick: () => rtToggleMore(false) }, h("span", { class: "rt-more-label" }, "取消")));
}
function roomTimeline(v) {
  const r = ui.room, rows = [];
  let last = null;
  for (const m of v.messages) {
    const t = m.createdAt ? Date.parse(m.createdAt) : NaN;
    if (Number.isFinite(t) && (last === null || t - last > 10 * 60_000 || new Date(t).toDateString() !== new Date(last).toDateString())) rows.push(h("div", { class: "room-time-sep" }, new Date(t).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })));
    if (Number.isFinite(t)) last = t;
    // 切到对比视图的轮次：这一轮的成员回复在对比块里显示，不再单独成气泡
    if (m.replyTo && r.roundView[m.replyTo] === "compare") continue;
    rows.push(m.kind === "human" ? roomHumanRow(m, v) : m.kind === "member" ? roomMemberRow(m, v) : roomSystemRow(m));
    if (m.kind === "human" && r.roundView[m.seq] === "compare") rows.push(roomRoundView(m));
  }
  const box = h("div", { class: "rt-transcript room-timeline", role: "log", "aria-label": "讨论记录", "data-keep-scroll": `room-${r.id}`, tabindex: "0",
    onscroll: (ev) => { const el = ev.target; r.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60; r.reading = sessionReadingCapture(el, r.atBottom); if (r.atBottom) r.newCount = 0; } },
    r.trimmedTail ? h('button', {class:'btn small rt-earlier', onclick: async () => { r.view = null; r.trimmedTail = false; r.atBottom = true; r.reading = {atBottom:true}; await roomRefresh(); if (ui.view === 'rt-room') renderMain(); }}, '回到最新的消息') : null,
    v.hasMore ? h("button", { class: "btn small rt-earlier", onclick: () => roomLoadEarlier(v) }, "加载更早的消息") : null,
    v.messages.length ? rows : h("div", { class: "room-empty" }, roomGroupAvatar(roomActiveMembers().map(roomAvatarSpec), 64), h("p", {}, `${roomActiveMembers().map((m) => `@${m.alias}`).join("、")} 已入群`), h("p", { class: "muted small" }, "@ 一个成员请它发言，或输入 @全部 让大家都回复。不 @ 的消息只记为备注。")),
    roomTyping(v), r.newCount ? h('button', {class:'btn small', onclick: () => { r.atBottom = true; r.newCount = 0; box.scrollTop = box.scrollHeight; }}, `${r.newCount} 条新内容 ↓`) : null);
  // 手机下拉／PC 向上滚：在讨论区顶端加载更早的消息，别让浏览器整页刷新
  sessionPullEarlier(box, { hasMore: () => !!v.hasMore, onLoad: () => roomLoadEarlier(v) });
  // 渲染时就决定是否贴底：重绘恢复旧滚动位置会先触发一次 scroll，不能等它再判断
  const stick = r.atBottom;
  requestAnimationFrame(() => { if (box.isConnected) sessionReadingWatch(box, r.reading || { atBottom: stick }); });
  return box;
}
/** 群聊里往上翻一页更早的消息（按钮与手机下拉共用），保持当前阅读位置 */
function roomLoadEarlier(v) {
  const r = ui.room;
  if (!v || !v.messages.length) return Promise.resolve();
  const first = v.messages[0].seq;
  return roomAction(async () => {
    const id = r.id, gen = r.generation, reading = sessionReadingCapture(document.querySelector('.room-timeline'), false);
    const older = await api(`/api/rooms/${id}?before=${first}&limit=50`);
    if (!roomCurrent(id, gen)) return;
    const combined = [...older.messages, ...v.messages];
    v.messages = combined.slice(0, 200);
    r.trimmedTail ||= combined.length > 200;
    v.hasMore = older.hasMore;
    r.atBottom = false; r.reading = reading;
  });
}
function roomQuoteBlock(q, v) {
  const member = q.source ? roomMember(q.source.memberId) : null;
  const name = q.source ? q.source.alias : q.author?.startsWith("@") ? q.author.slice(1) : "你";
  return h("button", { type: "button", class: "room-quote", title: `跳到 #${q.seq}`, onclick: () => roomJump(q.seq) },
    h("span", { class: "room-quote-name" }, member ? roomAvatar(member, "sm") : null, name, q.span ? " · 片段" : ""), h("span", { class: "room-quote-text" }, roomSnippet(q.text, 120)));
}
function roomJump(seq) {
  const el = document.querySelector(`[data-room-seq="${seq}"]`); if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" }); el.classList.add("room-flash"); setTimeout(() => el.classList.remove("room-flash"), 1600);
}
function roomActions(m) {
  const editable = roomEditable(), member = roomMember(m.memberId);
  return h("div", { class: "rt-row-meta room-actions" },
    m.kind === "member" && member && !member.removedAt ? h("button", { type: "button", class: "rt-copy", disabled: !editable, onclick: () => roomReply(m) }, "回复") : null,
    h("button", { type: "button", class: "rt-copy", disabled: !editable, "aria-label": `引用 #${m.seq}`, onclick: () => roomQuote(m) }, "引用"),
    h("button", { type: "button", class: "rt-copy", disabled: !editable, "aria-label": `引用选区 #${m.seq}`, onmousedown: (e) => e.preventDefault(), onclick: () => roomQuote(m, true) }, "引用选中"),
    rtCopyButton(m.text, "复制", { announce: "已复制消息" }),
    m.source ? h("a", { class: "rt-copy", href: `#/rt/${m.source.platformSessionId}`, title: `${m.source.runtimeKind}/${m.source.model || "默认"} · 第 ${m.source.turnNo} 轮 · seq ${m.source.seqStart}–${m.source.seqEnd}` }, "查看过程") : null,
    h("span", { class: "room-seq" }, `#${m.seq}`));
}
function roomHumanRow(m, v) {
  const receipts = (m.deliveries || []).map((d) => {
    const member = roomMember(d.memberId);
    return h("span", { class: `room-receipt ${d.status}` }, member ? roomAvatar(member, "sm") : null, `${member ? member.alias : d.memberId} ${ROOM_DELIVERY[d.status] || d.status}`,
      d.error ? h("span", { class: "muted" }, `：${roomSnippet(d.error, 60)}`) : null,
      d.status === "failed" && (!d.operationId || d.retryable) ? h("button", { class: "rt-copy", disabled: !roomEditable(), onclick: () => roomAction(async () => { await api(`/api/rooms/${ui.room.id}/messages/${m.seq}/deliveries/${d.memberId}/retry`, { method: "POST" }); await roomRefresh(); }) }, "重试") : null);
  });
  return h("div", { class: "room-row human", "data-room-seq": String(m.seq) },
    h("div", { class: "room-meta-line" }, h("span", { class: "room-time" }, roomClock(m.createdAt)), h("strong", {}, "你")),
    h("div", { class: "room-bubble human" }, (m.quotes || []).map((q) => roomQuoteBlock(q, v)),
      typeof fileDecorate === "function" ? fileDecorate(h("div", { class: "room-text", "data-room-text": String(m.seq) }, roomTextWithMentions(m.text)), {roomId:ui.room.id}) : h("div", { class: "room-text", "data-room-text": String(m.seq) }, roomTextWithMentions(m.text))),
    receipts.length ? h("div", { class: "room-receipts" }, receipts) : !m.mentions?.length ? h("div", { class: "room-receipts" }, h("span", { class: "muted small" }, "备注 · 没有 @ 成员")) : null,
    (m.deliveries || []).length >= 2 ? roomRoundToggle(m) : null,
    roomActions(m));
}
function roomMemberRow(m, v) {
  const r = ui.room, member = roomMember(m.memberId), long = roomIsLong(m.text), open = !!r.expanded[m.seq], raw = r.expanded[`raw${m.seq}`];
  const replyTo = m.replyTo ? v.messages.find((x) => x.seq === m.replyTo) : null;
  const suggestions = roomActiveMembers().filter((x) => x.memberId !== m.memberId && m.text.includes(`@${x.alias}`));
  return h("div", { class: "room-row member", "data-room-seq": String(m.seq) },
    h("div", { class: "room-avatar-col" }, roomAvatar(member, "")),
    h("div", { class: "room-body" },
      h("div", { class: "room-meta-line" }, h("strong", {}, roomName(m)), member?.roleName ? h("span", { class: "room-role" }, member.roleName) : null,
        h("span", { class: "muted small" }, rtModelShort(m.source?.model || roomModel(member))), h("span", { class: "room-time" }, roomClock(m.createdAt))),
      h("div", { class: `room-bubble member${long && !open ? " clipped" : ""}` },
        replyTo ? h("button", { type: "button", class: "room-reply-to", onclick: () => roomJump(replyTo.seq) }, `回复 ${roomName(replyTo)}：${roomSnippet(replyTo.text, 40)}`) : null,
        raw ? h("div", {},h("div", { class: "room-text room-raw", "data-room-text": String(m.seq) }, m.text),typeof fileCodeReferences === "function" ? fileCodeReferences(m.text,{roomId:r.id,memberId:m.memberId}) : null) : h("div", { class: "room-md", "data-room-text": String(m.seq) }, rtMarkdown(m.text, {roomId:r.id,memberId:m.memberId})),
        long ? h("button", { type: "button", class: "room-more", onclick: () => { r.expanded[m.seq] = !open; renderMain(); } }, open ? "收起" : `展开全文（${m.text.length} 字）`) : null),
      suggestions.length ? h("div", { class: "room-suggest" }, suggestions.map((x) => h("button", { class: "btn small", disabled: !roomEditable(), onclick: () => { r.draft.quotes = [{ seq: m.seq }]; r.draft.text = `@${x.alias} 请接着回应 ${roomName(m)} 的发言。`; roomDraftChanged(); renderMain(); roomFocusInput(); } }, `建议转给 @${x.alias}`))) : null,
      h("div", { class: "room-actions-line" }, roomActions(m), h("button", { type: "button", class: "rt-copy room-raw-toggle", onclick: () => { r.expanded[`raw${m.seq}`] = !raw; renderMain(); } }, raw ? "看排版" : "原文"))));
}
/* ------------------------------ 轮内对比视图：一轮 = 人类消息 + 被 @ 成员的回复 ------------------------------ */

function roomRoundToggle(m) {
  const r = ui.room, cur = r.roundView[m.seq] === "compare" ? "compare" : "chat";
  const btn = (k, label) => h("button", { type: "button", class: `rtc-mode${cur === k ? " active" : ""}`, "aria-pressed": String(cur === k), "aria-label": `第 #${m.seq} 轮：${label}视图`,
    onclick: () => { if (k === cur) return; if (k === "compare") { r.roundView[m.seq] = "compare"; void roomRoundLoad(m.seq); } else delete r.roundView[m.seq]; renderMain(); } }, label);
  return h("div", { class: "rtc-modes room-round-toggle", role: "group", "aria-label": `第 #${m.seq} 轮的视图` }, btn("chat", "聊天"), btn("compare", "对比"));
}
async function roomRoundLoad(seq, silent = false) {
  const r = ui.room, id = r.id, gen = r.generation, st = r.rounds[seq] || (r.rounds[seq] = { tab: "side", active: null, draft: null });
  if (!silent) { st.loading = true; st.error = ""; }
  try { const data = await api(`/api/rooms/${id}/rounds/${seq}`); if (!roomCurrent(id, gen)) return; const changed = JSON.stringify(st.data) !== JSON.stringify(data); st.data = data; st.changed = changed; st.error = ""; }
  catch (e) { if (roomCurrent(id, gen)) st.error = e.message; }
  st.loading = false;
  if (roomCurrent(id, gen) && (!silent || st.changed || st.error)) {
    const row = document.querySelector(`[data-room-seq="${seq}"]`), current = row?.nextElementSibling;
    const message = r.view?.messages.find(m => m.seq === seq);
    if (current?.classList.contains('room-round') && message) { const reading = sessionReadingCapture(document.querySelector('.room-timeline'), r.atBottom); current.replaceWith(roomRoundView(message)); sessionReadingRestore(document.querySelector('.room-timeline'), reading); }
    else if (!silent) renderMain();
  }
}
function roomRoundState(x) {
  if (x.removed && x.status === "queued") return badge("已移出", "");
  if (x.status === "completed") return badge("已回复", "ok");
  if (x.status === "queued") return badge(x.queuePosition ? `排队第 ${x.queuePosition} 位` : "排队中", "warn");
  if (x.status === "dispatching" || x.status === "running") return badge(x.approvals ? `等待审批 ${x.approvals}` : "回复中", "accent");
  return badge(ROOM_DELIVERY[x.status] || x.status, x.status === "cancelled" ? "" : "bad");
}
function roomRoundView(m) {
  const r = ui.room, st = r.rounds[m.seq] || {}, d = st.data;
  if (!d) return h("section", { class: "room-round", "aria-label": `第 #${m.seq} 轮对比` }, st.error ? h("p", { class: "field-error small", role: "alert" }, st.error) : h("p", { class: "muted small" }, "读取这一轮…"));
  const members = d.members, canAct = roomEditable();
  if (!members.some((x) => x.memberId === st.active)) st.active = members[0].memberId;
  const writers = members.filter((x) => roomMember(x.memberId)?.worktree);
  const tabs = [["side", "并排回复"], ["metrics", "指标"], ["diff", "文本差异"], ...(writers.length ? [["code", "代码改动"]] : [])];
  const best = d.verdict && d.verdict.memberId;
  return h("section", { class: "room-round", "aria-label": `第 #${m.seq} 轮对比` },
    h("div", { class: "room-round-head" },
      h("strong", {}, `对比 · ${members.length} 位成员`),
      d.settled ? badge("全部结束", "ok") : badge("还有成员在回复", "accent"),
      d.verdict ? badge(d.verdict.memberId === null ? "都不满意" : `最佳：@${(members.find((x) => x.memberId === d.verdict.memberId) || {}).alias || "?"}`, d.verdict.memberId === null ? "" : "ok") : null,
      h("div", { class: "rt-tabs room-round-tabs", role: "tablist", "aria-label": "对比方式" }, tabs.map(([k, label]) => h("button", { type: "button", role: "tab", class: `rt-tab${(st.tab || "side") === k ? " active" : ""}`, "aria-selected": String((st.tab || "side") === k), onclick: () => { st.tab = k; if (k === "code") for (const x of writers) void roomLoadDiff(x.memberId); renderMain(); } }, label)))),
    st.tab === "code" && writers.length ? h("div", { class: "room-code-list" }, h("p", { class: "muted small" }, "可写成员相对群聊起点的全部改动（不只这一轮）。采用会把改动应用到原目录（不暂存、不提交）。"), writers.map((x) => roomDiffPanel(x.memberId)))
      : st.tab === "metrics" ? roomRoundMetrics(members)
      : st.tab === "diff" ? roomRoundDiff(st, members)
      : h("div", {},
        h("div", { class: "rtc-lane-tabs room-round-member-tabs", role: "tablist", "aria-label": "成员" }, members.map((x) => h("button", { type: "button", role: "tab", class: `rtc-lane-tab${st.active === x.memberId ? " active" : ""}`, "aria-selected": String(st.active === x.memberId), onclick: () => { st.active = x.memberId; renderMain(); } }, rtAvatar(x.runtimeKind, x.model, "sm"), `@${x.alias}`))),
        h("div", { class: `room-round-cards n${Math.min(members.length, 4)}` }, members.map((x) => {
          const isBest = best === x.memberId, open = !!(st.open && st.open[x.memberId]);
          return h("article", { class: `room-round-card${st.active === x.memberId ? " active" : ""}${isBest ? " best" : ""}`, "aria-label": `@${x.alias} 的回复` },
            h("header", { class: "room-round-card-head" }, rtAvatar(x.runtimeKind, x.model),
              h("div", { class: "room-round-card-title" }, h("strong", {}, `@${x.alias}`), h("span", { class: "muted small" }, [x.roleName, rtModelShort(x.model)].filter(Boolean).join(" · ") || RT_KIND[x.runtimeKind])),
              isBest ? badge("最佳", "ok") : null, roomRoundState(x)),
            h("div", { class: `room-round-card-body${x.reply && roomIsLong(x.reply.text) && !open ? " clipped" : ""}` },
              x.reply ? rtMarkdown(x.reply.text, {roomId:r.id,memberId:x.memberId}) : h("p", { class: "muted small" }, x.error ? x.error : x.status === "queued" ? "排队中：等同一运行时有空位" : x.status === "cancelled" ? "已取消，没有回复" : "还没有回复"),
              x.reply && roomIsLong(x.reply.text) ? h("button", { type: "button", class: "room-more", onclick: () => { st.open = { ...(st.open || {}), [x.memberId]: !open }; renderMain(); } }, open ? "收起" : `展开全文（${x.reply.text.length} 字）`) : null),
            h("footer", { class: "room-round-card-foot" },
              x.reply && canAct ? h("button", { type: "button", class: `btn small${isBest ? " primary" : ""}`, disabled: isBest, onclick: () => roomRoundVerdict(m.seq, x.memberId) }, isBest ? "已选为最佳" : "选为最佳") : null,
              x.reply && canAct && !x.removed ? h("button", { type: "button", class: "btn small", onclick: () => { const msg = r.view.messages.find((y) => y.seq === x.reply.seq); if (msg) roomReply(msg); } }, "回复它") : null,
              x.platformSessionId ? h("a", { class: "btn small", href: `#/rt/${x.platformSessionId}` }, "查看过程") : null));
        }))),
    roomRoundVerdictBar(m.seq, d, canAct));
}
function roomRoundMetrics(members) {
  const done = members.filter((x) => x.status === "completed");
  const pick = (val) => { const xs = done.map((x) => [x.memberId, val(x)]).filter(([, n]) => typeof n === "number"); return xs.length >= 2 ? xs.reduce((a, b) => b[1] < a[1] ? b : a)[0] : null; };
  const fastest = pick((x) => x.metrics.durationMs), cheapest = pick((x) => x.metrics.usage.total);
  const tok = (x, k) => x.metrics.usage[k] === undefined ? (x.metrics.usageCoverage === "unknown" ? "未知" : "—") : rtNum(x.metrics.usage[k]);
  const rows = [
    ["状态", (x) => [roomRoundState(x), x.error ? h("div", { class: "small muted" }, roomSnippet(x.error, 80)) : null]],
    ["运行时", (x) => RT_KIND[x.runtimeKind]],
    ["模型", (x) => rtModelShort(x.model) || "runtime 默认"],
    ["推理强度", (x) => x.effort || "默认"],
    ["本轮耗时", (x) => [rtcDuration(x.metrics.durationMs), x.memberId === fastest ? badge("最快", "ok") : null]],
    ["输入 token", (x) => tok(x, "input")],
    ["缓存读 / 写 token", (x) => `${tok(x, "cachedInput")} / ${tok(x, "cacheCreation")}`],
    ["输出 token", (x) => tok(x, "output")],
    ["合计 token", (x) => [tok(x, "total"), x.memberId === cheapest ? badge("最省", "ok") : null]],
    ["工具调用", (x) => `${x.metrics.toolCalls}${x.metrics.toolFailures ? `（失败 ${x.metrics.toolFailures}）` : ""}`],
    ["错误", (x) => String(x.metrics.errors)]
  ];
  return h("div", {}, h("div", { class: "rtc-table-wrap", "data-keep-scroll-x": "room-round-metrics" },
    h("table", { class: "rtc-table" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "指标"), members.map((x) => h("th", { scope: "col" }, h("span", { class: "rtc-th" }, rtAvatar(x.runtimeKind, x.model, "sm"), `@${x.alias}`))))),
      h("tbody", {}, rows.map(([label, cell]) => h("tr", {}, h("th", { scope: "row" }, label), members.map((x) => h("td", {}, cell(x)))))))),
    h("p", { class: "muted small" }, "指标只算这一轮：耗时为这一轮的开始到结束，token 为这一轮内各 runtime 回报的用量（口径因 runtime 而异），未回报的显示「未知」。"));
}
function roomRoundDiff(st, members) {
  const withReply = members.filter((x) => x.reply);
  if (withReply.length < 2) return h("p", { class: "muted small" }, "至少两位成员回复后才能比较");
  if (!st.diff || !withReply.some((x) => x.memberId === st.diff.a) || !withReply.some((x) => x.memberId === st.diff.b)) st.diff = { a: withReply[0].memberId, b: withReply[1].memberId };
  const d = st.diff, A = withReply.find((x) => x.memberId === d.a), B = withReply.find((x) => x.memberId === d.b);
  const sel = (k, label) => h("label", { class: "rtc-diff-pick" }, label, (() => { const el = h("select", { "aria-label": `差异 ${label}`, onchange: (ev) => { d[k] = ev.target.value; renderMain(); } }, withReply.map((x) => h("option", { value: x.memberId }, `@${x.alias}`))); el.value = d[k]; return el; })());
  const diff = d.a === d.b ? null : rtcLineDiff(A.reply.text, B.reply.text);
  return h("section", { class: "rtc-diff-panel", "aria-label": "文本差异" },
    h("div", { class: "rtc-diff-head" }, sel("a", "−"), h("button", { type: "button", class: "btn small", "aria-label": "交换两侧", onclick: () => { st.diff = { a: d.b, b: d.a }; renderMain(); } }, "⇄"), sel("b", "+")),
    d.a === d.b ? h("p", { class: "muted small" }, "请选择两位不同的成员")
      : !diff ? h("p", { class: "muted small" }, "回复太长，不做逐行差异；请用并排回复查看")
      : diff.every(([op]) => op === "=") ? h("p", { class: "muted small" }, "两条回复完全相同")
      : h("div", { class: "rtc-diff", role: "region", "aria-label": "逐行差异" }, rtcDiffRows(diff)));
}
async function roomRoundVerdict(seq, memberId, note) {
  const r = ui.room, st = r.rounds[seq];
  try {
    st.data = await api(`/api/rooms/${r.id}/rounds/${seq}/verdict`, { method: "POST", body: JSON.stringify({ memberId, note: note ?? st.draftNote ?? "" }) });
    st.error = ""; announce(memberId === null ? "已记录：都不满意" : "已选为最佳回复");
  } catch (e) { st.error = e.message; }
  renderMain();
}
function roomRoundVerdictBar(seq, d, canAct) {
  const st = ui.room.rounds[seq], v = d.verdict;
  if (st.draftNote === undefined) st.draftNote = v ? v.note : "";
  return h("div", { class: "room-round-verdict" },
    v ? h("span", { class: "small" }, v.memberId === null ? "结论：都不满意" : `结论：最佳是 @${(d.members.find((x) => x.memberId === v.memberId) || {}).alias || "?"}`, v.note ? `。${v.note}` : "", h("span", { class: "muted" }, ` · ${rtTime(v.at)}`)) : h("span", { class: "muted small" }, "还没有结论：在回复卡片上「选为最佳」，或者都不满意"),
    canAct ? h("input", { type: "text", class: "room-round-note", "aria-label": `第 #${seq} 轮结论备注`, maxlength: "2000", placeholder: "理由（可选，选最佳时一起记录）", value: st.draftNote, oninput: (ev) => { st.draftNote = ev.target.value; } }) : null,
    canAct && v && v.memberId ? h("button", { type: "button", class: "btn small", onclick: () => roomRoundVerdict(seq, v.memberId, st.draftNote) }, "更新理由") : null,
    canAct ? h("button", { type: "button", class: "btn small", onclick: () => roomRoundVerdict(seq, null, st.draftNote) }, "都不满意") : null,
    st.error ? h("span", { class: "field-error small", role: "alert" }, st.error) : null);
}
/* ------------------------------ 审批：可写成员按所选权限请求批准 ------------------------------ */

function roomApprovals(v) {
  const pending = v.members.flatMap((m) => (m.approvals || []).map((ap) => ({ m, ap })));
  if (!pending.length) return h("section", { class: "room-approvals", "aria-label": "待你审批", hidden: true });
  const gate = rtApprovalGate(ui.rt.access, ui.room.statusConfirmed, ui.room.syncError);
  const decide = (m, ap, approve, answers) => roomAction(async () => {
    await api(`/api/runtime-sessions/${m.platformSessionId}/approvals/${ap.approvalId}`, { method: "POST", body: JSON.stringify({ approve, paramsDigest: ap.paramsDigest, turnNo: ap.turnNo, ...(answers ? { answers } : {}) }) });
    rtQuestionDrafts.delete(ap.approvalId);
    announce(ap.kind === "question" ? (approve ? "已回答" : "已跳过") : approve ? "已批准" : "已拒绝"); await roomRefresh();
  });
  return h("section", { class: "room-approvals", "aria-label": "待你审批" }, pending.map(({ m, ap }) => ap.kind === "question"
    ? rtQuestionCard(ap, { label: `@${m.alias}`, gate, busy: ui.room.busy, onSubmit: (answers) => decide(m, ap, true, answers), onSkip: () => decide(m, ap, false) })
    : h("div", { class: "room-approval" },
    h("div", { class: "room-approval-head" }, roomAvatar(m, "sm"), h("strong", {}, `@${m.alias}`), h("span", {}, ap.title), h("span", { class: "muted small" }, ap.scope)),
    h("pre", { class: "room-approval-action" }, ap.action),
    rtApprovalActionRow(gate, "当前入口没有控制权限", (waiting) => [h("button", { type: "button", class: "btn small primary", disabled: waiting, onclick: () => decide(m, ap, true) }, "批准"), h("button", { type: "button", class: "btn small", disabled: waiting, onclick: () => decide(m, ap, false) }, "拒绝")], "room-approval-acts"))));
}

/* ------------------------------ 代码改动：可写成员相对群聊起点的全部改动，查看后二次确认采用 ------------------------------ */

async function roomLoadDiff(memberId) {
  const r = ui.room, id = r.id, gen = r.generation, st = (r.diffs ||= {})[memberId] || (r.diffs[memberId] = {});
  st.loading = true; st.error = '';
  try { const d = await api(`/api/rooms/${id}/members/${memberId}/diff`); if (!roomCurrent(id, gen)) return; st.data = d; st.error = ''; }
  catch (e) { if (roomCurrent(id, gen)) st.error = e.message; }
  st.loading = false; if (roomCurrent(id, gen)) renderMain();
}
function roomDiffPanel(memberId) {
  const r = ui.room, m = roomMember(memberId), st = (r.diffs || {})[memberId] || {}, d = st.data, wt = r.view.room.worktree;
  const canAct = roomEditable();
  const adopt = () => roomAction(async () => {
    await api(`/api/rooms/${r.id}/members/${memberId}/adopt`, { method: "POST", body: JSON.stringify({ patchHash: d.patchHash }) });
    st.confirm = false; announce(`已把 @${m.alias} 的改动应用到原目录`); await roomRefresh(); await roomLoadDiff(memberId);
  });
  return h("article", { class: "room-diff", "aria-label": `@${m ? m.alias : memberId} 的代码改动` },
    h("header", { class: "room-diff-head" }, m ? roomAvatar(m, "sm") : null, h("strong", {}, `@${m ? m.alias : memberId}`),
      d ? h("span", { class: "muted small" }, d.files.length ? `${d.files.length} 个文件 · +${d.added} −${d.deleted}` : "还没有改动") : null,
      d && d.adopted ? badge("已采用", "ok") : null,
      h("button", { type: "button", class: "rt-copy", onclick: () => void roomLoadDiff(memberId) }, st.loading ? "读取中…" : "刷新")),
    st.error ? h("p", { class: "field-error small", role: "alert" }, st.error) : null,
    !d ? (st.loading ? h("p", { class: "muted small" }, "读取改动…") : null) : [
      d.files.length ? h("ul", { class: "room-diff-files" }, d.files.map((f) => h("li", {}, h("code", {}, f.path), h("span", { class: "muted small" }, f.binary ? " 二进制" : ` +${f.added} −${f.deleted}`)))) : null,
      d.files.length ? h("details", { class: "room-diff-patch" }, h("summary", {}, d.truncated ? `完整补丁（已截断显示，原文 ${d.truncated.originalChars} 字符）` : "完整补丁"), rtcPatchView(d.patch)) : null,
      d.files.length && canAct && !d.adopted ? (st.confirm
        ? h("div", { class: "rt-banner warn room-adopt-confirm", role: "alertdialog", "aria-label": "确认采用" },
          h("p", {}, `将把 @${m.alias} 的 ${d.files.length} 个文件改动（+${d.added} −${d.deleted}）应用到 ${wt ? wt.repoRoot : "原目录"} 的工作区：不暂存、不提交；原目录已有冲突的改动时整体不应用。`),
          h("div", { class: "rt-actions" }, h("button", { type: "button", class: "btn small", onclick: () => { st.confirm = false; renderMain(); } }, "取消"), h("button", { type: "button", class: "btn small primary", onclick: adopt }, "确认采用")))
        : h("button", { type: "button", class: "btn small primary", onclick: () => { st.confirm = true; renderMain(); } }, "采用到原目录")) : null]);
}
function roomDiffDrawer(memberId) {
  const r = ui.room, m = roomMember(memberId);
  if (!m || !m.worktree) { r.diffOpen = null; return null; }
  return h("section", { class: "room-diff-drawer", "aria-label": "代码改动" },
    h("div", { class: "room-diff-drawer-head" }, h("strong", {}, "代码改动"), h("span", { class: "muted small" }, `相对群聊起点 ${r.view.room.worktree ? r.view.room.worktree.baseCommit.slice(0, 10) : ""}`), h("button", { type: "button", class: "btn small", onclick: () => { r.diffOpen = null; renderMain(); } }, "关闭")),
    roomDiffPanel(memberId));
}
function roomSystemRow(m) { return h("div", { class: "room-row system", "data-room-seq": String(m.seq) }, h("span", { class: "room-system" }, `${m.author?.startsWith("@") ? `${m.author} · ` : ""}${m.text}`)); }
/** 正在回复 / 排队 / 等待审批的成员：像群聊里的「正在输入」 */
function roomTyping(v) {
  const rows = roomActiveMembers().map((m) => {
    const s = m.session?.status, approvals = m.approvals?.length || 0;
    const state = approvals ? `等待你审批 ${approvals} 项` : ["running", "creating", "dispatching"].includes(s) ? "正在回复" : s === "stopping" ? "正在停止" : m.queuePosition || m.pendingDeliveries ? "排队中" : null;
    if (!state) return null;
    return h("div", { class: "room-row member typing", "aria-live": "polite" }, h("div", { class: "room-avatar-col" }, roomAvatar(m, "")),
      h("div", { class: "room-body" }, h("div", { class: "room-meta-line" }, h("strong", {}, m.alias)),
        h("div", { class: "room-bubble member room-typing" }, h("span", {}, state), state === "正在回复" ? h("span", { class: "room-dots", "aria-hidden": "true" }, h("i"), h("i"), h("i")) : null,
          approvals ? h("a", { class: "rt-copy", href: `#/rt/${m.platformSessionId}` }, "去审批") : null)));
  }).filter(Boolean);
  return rows.length ? h("div", { class: "room-typing-list" }, rows) : null;
}
function roomComposer() {
  const r = ui.room, draft = r.draft, editable = roomEditable(), members = roomActiveMembers();
  const popup = editable ? roomPopup() : null, items = popup?.items || [];
  if (r.pick >= items.length) r.pick = 0;
  const targets = roomMentionsIn(draft.text).map(roomMember).filter(Boolean);
  const quoted = (seq) => r.view.messages.find((m) => m.seq === seq);
  return h("div", { class: "rt-composer room-composer", "data-startup-send-ready": String(editable) },
    draft.quotes.length ? h("div", { class: "room-quote-bar" }, draft.quotes.map((q) => { const m = quoted(q.seq); return h("span", { class: "room-quote-chip" },
      h("span", { class: "room-quote-chip-text" }, `↩ ${m ? roomName(m) : `#${q.seq}`}：${m ? roomSnippet(q.span ? m.text.slice(q.span.start, q.span.end) : m.text, 50) : ""}`),
      h("button", { type: "button", class: "rt-copy", "aria-label": `移除引用 #${q.seq}`, disabled: r.busy || !ui.rt.access?.control, onclick: () => { draft.quotes = draft.quotes.filter((x) => x !== q); roomDraftChanged(); renderMain(); } }, "×")); })) : null,
    items.length ? h("div", { class: "room-popup", role: "listbox", "aria-label": popup.kind === "at" ? "选择成员" : "快捷指令" }, items.map((it, i) => h("button", { type: "button", role: "option", class: `room-popup-item${i === r.pick ? " active" : ""}`, "aria-selected": String(i === r.pick), onmousedown: (e) => e.preventDefault(), onclick: () => roomPick(it) },
      it.member ? roomAvatar(it.member, "sm") : h("span", { class: "room-popup-icon", "aria-hidden": "true" }, popup.kind === "at" ? "@" : "/"), h("span", { class: "room-popup-label" }, it.label), h("span", { class: "muted small" }, it.hint)))) : null,
    h("div", { class: "rt-compose-row" },
      h("textarea", { rows: 2, class: "rt-input", value: draft.text, maxlength: 12000, disabled: r.busy || !ui.rt.access?.control, "aria-label": "人类指令", "data-key": "room-input",
        placeholder: members.length ? `发消息，@${members[0].alias} 或 @全部 请成员回复；输入 / 用快捷指令` : "发消息",
        oninput: (e) => { draft.text = e.target.value; r.pick = 0; roomDraftChanged(); renderMain(); },
        onkeydown: (ev) => {
          if (items.length && ["ArrowDown", "ArrowUp"].includes(ev.key)) { ev.preventDefault(); r.pick = (r.pick + (ev.key === "ArrowDown" ? 1 : items.length - 1)) % items.length; renderMain(); return; }
          if (items.length && (ev.key === "Tab" || (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing))) { ev.preventDefault(); roomPick(items[r.pick]); return; }
          if (rtIsSendKey(ev)) { ev.preventDefault(); void roomSend(); }
        } }),
      h("button", { type: "button", class: "btn primary", disabled: !editable || !draft.text.trim(), onclick: () => void roomSend() }, r.busy ? "发送中…" : "发送")),
    h("p", { class: "small muted room-hint" }, !editable && !ui.rt.access?.control ? "当前入口没有控制权限" : targets.length ? `发给 ${targets.map((m) => `@${m.alias}`).join("、")}${draft.quotes.length ? ` · 附带 ${draft.quotes.length} 条引用` : ""}；正在回复的成员会排队` : "没有 @ 成员：只记为备注。Enter 发送，Shift + Enter 换行"));
}
function roomSide(v) {
  const r = ui.room, room = v.room, control = r.statusConfirmed !== false && ui.rt.access?.control && !r.busy;
  // 后台刷新（SSE 触发的 roomRefresh）会整块重绘：重绘前先把「群聊设置」的展开状态从旧 DOM 接过来，不接就会自己收起
  const prevAdvanced = document.querySelector(".room-members .room-advanced");
  if (prevAdvanced) r.advancedOpen = prevAdvanced.open;
  const status = (m) => m.removedAt ? "已移出" : m.approvals?.length ? `等待审批 ${m.approvals.length}` : ({ running: "回复中", creating: "回复中", "waiting-input": "等待审批", stopping: "停止中", idle: "空闲", unknown: "结果未知", failed: "失败", interrupted: "被中断" })[m.session?.status] || "空闲";
  return h("aside", { id: "room-members", class: "rt-side room-members", "aria-label": "群聊成员" },
    h("div", { class: "room-side-head" }, h("h3", {}, `成员 · ${roomActiveMembers().length}`),
      h("button", { type: "button", class: "btn small room-members-close", "aria-label": "关闭群聊成员", onclick: roomToggleMembers }, "关闭")),
    h("ul", { class: "room-member-list" }, v.members.map((m) => h("li", { class: `room-member${m.removedAt ? " removed" : ""}` },
      roomAvatar(m),
      h("div", { class: "room-member-main" },
        h("div", {}, h("strong", {}, `@${m.alias}`), m.roleName ? h("span", { class: "room-role" }, m.roleName) : null),
        h("div", { class: "muted small" }, `${rtModelShort(roomModel(m)) || "默认模型"} · ${status(m)}${m.queuePosition ? ` · 排队 ${m.queuePosition}` : ""}`),
        h("div", { class: "small" }, m.worktree ? h("span", { class: "room-perm write" }, roomPermLabel(m.binding.runtimeKind, m.binding.permissionMode)) : h("span", { class: "room-perm" }, "只读")),
        m.session?.role?.evidence.runtimeConfirmed?.result ? h("div", { class: "small muted" }, `角色核对：${m.session.role.evidence.runtimeConfirmed.result === "confirmed" ? "已确认" : "不一致"}`) : null,
        h("div", { class: "room-member-acts" },
          h("a", { class: "rt-copy", href: `#/rt/${m.platformSessionId}` }, `查看 @${m.alias} 会话`),
          m.worktree && room.worktree && !room.worktree.cleanedAt ? h("button", { class: "rt-copy", onclick: () => { r.diffOpen = m.memberId; r.membersOpen = false; void roomLoadDiff(m.memberId); renderMain(); } }, "代码改动") : null,
          !m.removedAt && roomEditable() ? h("button", { class: "rt-copy", onclick: () => { if (!roomMentionsIn(r.draft.text).includes(m.memberId)) r.draft.text = `@${m.alias} ${r.draft.text}`; roomDraftChanged(); renderMain(); roomFocusInput(); } }, "@它") : null,
          control && ["running", "creating", "waiting-input", "stopping"].includes(m.session?.status) ? h("button", { class: "rt-copy", onclick: () => roomAction(async () => { await api(`/api/runtime-sessions/${m.platformSessionId}/interrupt`, { method: "POST", body: JSON.stringify({ idempotencyKey: roomKey(), expectedRevision: m.session.bindingRevision }) }); await roomRefresh(); }) }, "停止") : null,
          control && !m.removedAt && !room.archived ? h("button", { class: "rt-copy", onclick: () => roomAction(async () => { await api(`/api/rooms/${r.id}/members/${m.memberId}`, { method: "DELETE" }); await roomRefresh(); }) }, "移出") : null))))),
    control && !room.archived ? (r.join
      ? h("div", { class: "room-join" }, roomMemberEditor(r.join, roomActiveMembers().length), h("button", { class: "btn small primary", disabled: !control, onclick: () => roomAction(async () => { await api(`/api/rooms/${r.id}/members`, { method: "POST", body: JSON.stringify(roomMemberPayload(r.join)) }); r.join = null; await roomRefresh(); }) }, "确认邀请"), h("button", { class: "btn small", onclick: () => { r.join = null; renderMain(); } }, "取消"))
      : h("button", { class: "btn small room-invite", onclick: () => roomAction(async () => { await rtLoadProfiles(); r.join = { alias: "新成员", runtimeKind: "codex", model: "", effort: "" }; }) }, "＋ 邀请成员")) : null,
    // 展开状态记在 r.advancedOpen：后台刷新重绘后不会自己收起（收起时正在改的群名称也点不到）
    h("details", { class: "room-advanced", open: !!r.advancedOpen, ontoggle: (ev) => { r.advancedOpen = ev.target.open; } }, h("summary", {}, "群聊设置"),
      h("p", { class: "small muted room-workspace" }, room.workspace),
      roomTitleEditor(room, control),
      roomSettings(room.settings, (settings) => roomAction(async () => { await api(`/api/rooms/${r.id}/settings`, { method: "PATCH", body: JSON.stringify(settings) }); await roomRefresh(); }), !control || room.archived),
      control ? h("button", { class: "btn small", onclick: async () => { if (!room.archived && !(await roomConfirmArchive(r.id))) return; void roomAction(async () => { await api(`/api/rooms/${r.id}/archive`, { method: "POST", body: JSON.stringify({ archived: !room.archived }) }); rtArchiveInvalidate(); await roomRefresh(); }); } }, room.archived ? "恢复群聊" : "归档群聊") : null,
      control ? h("button", { class: "btn small danger", onclick: () => { r.deleteConfirm = !r.deleteConfirm; renderMain(); } }, "删除群聊") : null,
      r.deleteConfirm ? h("div", {}, h("p", { class: "small" }, "删除群聊、成员平台记录和快照；原生记录保留。"), h("button", { class: "btn danger small", disabled: !control, onclick: () => roomAction(async () => { await api(`/api/rooms/${r.id}`, { method: "DELETE" }); r.deleteConfirm = false; ui.rt.dir = null; location.hash = "#/rt"; }) }, "确认删除")) : null));
}
let roomEventsInstalled = false;
function roomPhoneChanged() {
  if (ui.view !== "rt-room" || !ui.room.view) return;
  if (typeof rtSyncChrome === "function") rtSyncChrome();
  document.querySelector(".room-head")?.replaceWith(roomHead(ui.room.view));
}
function roomInstallEvents() {
  if (roomEventsInstalled) return;
  roomEventsInstalled = true;
  roomSideMedia.addEventListener("change", roomSyncMembersHandle);
  rtPhone.addEventListener("change", roomPhoneChanged);
}
function roomDeactivate() {
  if (!roomEventsInstalled) return;
  roomEventsInstalled = false;
  roomSideMedia.removeEventListener("change", roomSyncMembersHandle);
  rtPhone.removeEventListener("change", roomPhoneChanged);
}
globalThis.piRouteModules?.register("room", { render: () => {
  roomInstallEvents();
  return ui.view === "rt-room-new" ? renderRoomNew() : renderRoom();
} });
