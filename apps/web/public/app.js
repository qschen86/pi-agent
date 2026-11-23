"use strict";
/*
 * pi-agent 控制台前端（无框架）。
 * 安全约定：所有动态内容一律经 h() 以 textContent 写入，从不拼接 HTML 字符串——
 * 交付物来自模型输出，可能包含任何内容。
 */

// Legacy embedders may load app.js alone; production includes navigation.js first.
if (typeof navigationMark === "undefined") window.navigationMark = () => {};
if (typeof readResource === "undefined") window.readResource = (path) => api(path);
if (typeof peekRead === "undefined") window.peekRead = () => null;
if (typeof invalidateReads === "undefined") window.invalidateReads = () => {};

const ui = {
  view: "rt",
  pageError: "",
  // 本机文件夹选择器：正在等哪个按钮的结果；各按钮自己的出错信息
  picking: "", pickError: {},
  // 待办记录（大备忘录）：列表新的在前、正在写的内容、正在带的上传图片、正在编辑/忙碌的记录；左侧滑开的记录 id
  notes: [], notesDraft: "", notesImages: [], notesEdit: null, notesBusy: "", notesError: "", notesFocusInput: false, notesComposerOpen: false, notesFilter: "todo", notesLinkFilter: "all", notesFilterMenu: null, notesMore: null, notesExpanded: null, notesCategories: null, notesFilteredCounts: null,
  // 待办页签 / 日历视图状态（具体形状由 notes.js 初始化）
  notesTab: "records", notesCalendar: null,
  // 待办分页：续读游标 / 是否还有更早的记录 / 状态与分类的全量计数
  notesCursor: null, notesHasMore: false, notesLoadingMore: false, notesCounts: null, notesCategoryCounts: null, notesTotal: 0,
  // 平台设置：独立页面；导航设置与部署历史都放在这里
  settings: { section: "home", extra: null, returnHash: "#/rt", deployments: null, deployError: "", deployLoading: false, deployLoadingMore: false, deployMoreError: "", deployAttempted: false, deployStale: false, deploySnapshotAt: "", deployHydrated: false, deploySentinel: null, deployFolds: {}, deployFoldAt: 0, heatRuntime: "all" },
  // 股票账户记账：GET /api/ledger 的最近一次结果（由 ledger.js 负责渲染）
  ledger: null
};

// Read-only sampling after DOM commits; it never grants permission or starts reads.
window.piStartupRead = () => {
  const main = document.getElementById('main');
  const module = pageModule(ui.view), pending = window.piRouteModules?.has(module) && window.piRouteModules.state(module) !== 'ready';
  const error = !!ui.authRequired || !!ui.pageError || (ui.view === 'rt-compare' && !!ui.rtc?.error) || (['rt-new', 'runtimes', 'rt-room-new'].includes(ui.view) && !!ui.rt?.error) || (pending && window.piRouteModules.state(module) === 'error');
  const single = ui.view === 'rt' && !!ui.rt?.id, room = ui.view === 'rt-room' && !!ui.room?.id;
  const r = single ? ui.rt : room ? ui.room : null;
  const kind = single ? 'single' : room ? 'room' : ui.view === 'rt' ? 'list' : 'other';
  const target = ui.currentHash || ui.view + ':' + (r?.id || '');
  if (pending || !main?.children.length) return { target, kind, display: false, confirmed: false, error };
  if (r) {
    const live = single ? r.view?.session?.platformSessionId === r.id && r.messagesFor === r.id : r.view?.room?.roomId === r.id || r.view?.room?.id === r.id;
    const display = !!main.querySelector(single ? '.rt-transcript' : '.room-timeline') && (!!r.diskDisplay || !!live);
    const confirmed = !!live && r.statusConfirmed === true && !r.diskDisplay && !r.syncError && !r.viewError && !r.messageSyncError;
    const send = main.querySelector('[data-startup-send-ready="true"]') !== null;
    const entity = single ? r.view?.session : r.view?.room;
    const sendApplicable = !(r.view?.readOnly || entity?.archived || (single && (entity?.sourceMode !== 'platform-managed' || entity?.worktree?.removedAt)) || ui.rt?.access?.control === false);
    return { target, kind, display, cached: display && !confirmed && !!(r.diskDisplay || r.memoryDisplay), cacheSource: r.diskDisplay ? 'disk' : 'memory', confirmed, send: confirmed && send && sendApplicable, sendApplicable,
      error: error || !!(r.syncError || r.viewError || r.messageSyncError) };
  }
  // A shared-image composer is usable before the unrelated list request completes.
  // Its upload/write gates stay in notes.js; this only releases the startup cover.
  const shareEditor = ui.view === 'notes' && ui.notesComposerOpen && ui.notesImages?.some(item => item.source === 'share') && !!document.querySelector('.notes-composer');
  const display = kind === 'list' ? !!ui.rt?.dir : !!shareEditor || !ui.pageLoading || ui.pageStale;
  // Other routes expose their surface, but do not claim chat-state or write readiness.
  return { target, kind, display, cached: !!ui.pageStale, confirmed: kind === 'list' && display && !ui.pageLoading && !ui.pageStale, surfaceOnly: kind === 'other', send: false, sendApplicable: false, error };
};

/* ------------------------------- 工具 ------------------------------- */

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked" || k === "disabled" || k === "selected") el[k] = Boolean(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(path, options = {}) {
  if ((!options.method || options.method === "GET") && typeof shareRead === "function") return shareRead(path, () => requestJson(path, options));
  let result = await requestJson(path, options);
  if (result?.deploymentQueued && /^[a-f0-9]{64}$/.test(result.ticket || '')) {
    const ticket = result.ticket;
    options.onDeploymentWait?.();
    announce("消息已排队，部署完成后自动发送");
    // Only poll an accepted durable ticket. Never blindly retry an uncertain POST.
    while (result?.deploymentQueued) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      try { result = await requestJson(`/api/runtime-submissions/${ticket}`, { readPriority: 0 }); }
      catch (error) { if (error.status && ![408, 502, 503, 504].includes(error.status)) throw error; }
    }
  }
  return result;
}

/*
 * 有界读取预算：HTTP/1.1 的连接数、h2/h3 的共享带宽、隧道与源站容量都可能造成等待。
 * 从 3 开始，实际同源 API 确认 h2/h3 后放宽到 6；确认降到 HTTP/1.1 时恢复原有 3 个读取槽位。
 * PI_AGENT_READ_MAX 是有上限的实验覆盖值，HTTP/1.1 或协议未知仍保持保守预算。
 * 前台优先、后台公平派发；排队等待不计入请求超时，写请求不进入此预算。
 */
const readGate = { active: 0, max: readBudgetOverride() || 3, override: readBudgetOverride(), protocol:'unknown', waiting: [], criticalStreak:0, scheduled:false };
function readBudgetOverride() {
  const value=Number(window.PI_AGENT_READ_MAX);
  return value>0 ? Math.min(16, Math.max(1, Math.floor(value))) : null;
}
function readGateObserveProtocol() {
  if(readGate.override || typeof location==='undefined')return;
  const entries=performance.getEntriesByType('resource');
  // Use completed API fetches, not the document (which may be served by a SW).
  const entry=entries.slice().reverse().find(e=>e.initiatorType==='fetch' && e.name.startsWith(location.origin+'/api/') && e.nextHopProtocol);
  if(!entry)return;
  if(entry.nextHopProtocol==='http/1.1'||entry.nextHopProtocol==='http/1.0'){
    // 单条共享实时流占一个连接；恢复原有三个读取槽位，仍给写入和静态资源留余量。
    readGate.protocol='http/1.1';readGate.max=3;
  }else if(['h2','h3'].includes(entry.nextHopProtocol)&&readGate.protocol!=='http/1.1'){
    readGate.protocol=entry.nextHopProtocol;readGate.max=6;
  }
}
window.piReadBusy=()=>readGate.active>0||readGate.waiting.length>0;
window.piReadBudget=()=>({max:readGate.max,override:readGate.override,protocol:readGate.protocol});
function readPriority(path) {
  if(path==='/api/session-sync/capabilities')return 0;
  const state=typeof ui==='undefined'?null:ui.view==='rt'?ui.rt:ui.view==='rt-room'?ui.room:null;
  const prefix=state?.id?(ui.view==='rt'?'/api/runtime-sessions/':'/api/rooms/')+encodeURIComponent(state.id):null;
  const base=path.split('?')[0];
  // 快速从列表进入对话时，普通启动读取可能仍占槽；恢复与审批共享一个有界紧急槽。
  if(prefix && base===prefix+'/restore')return -1;
  if(prefix && (base===prefix || ['bootstrap','restore','sync','messages'].some(s=>base===prefix+'/'+s)))return 0;
  if(typeof ui!=='undefined'&&ui.view==='rt'&&!state?.id&&base==='/api/session-directory')return 0;
  if(/\/(bootstrap|restore|sync)$/.test(base) || /^\/api\/(session-directory|resources|runtime-(profiles|settings|notifications))/.test(base))return 2;
  // 轮询类后台读取（部署状态、未读标记、快捷回复）：不跟发送 / 接收 / 看图抢前台名额。
  if(/^\/api\/runtime-sessions\/[^/]+\/(deploy|quick-replies)$/.test(base) || base==='/api/runtime/read-state')return 2;
  return 1;
}
const readTimings=[];
// 只给出粗粒度类别，不含资源 ID、查询串或游标。
function readKind(path){
  const base=path.split('?')[0];
  if(base.endsWith('/restore'))return 'restore';
  if(base.endsWith('/bootstrap'))return 'bootstrap';
  if(base.endsWith('/sync'))return 'sync';
  if(path.startsWith('/api/session-directory'))return 'directory';
  if(base==='/api/notes')return 'notes';
  if(base==='/api/note-categories')return 'note-categories';
  if(base.startsWith('/api/note-iterations'))return 'note-iterations';
  return 'other';
}
/*
 * 链路预算：手机蜂窝 / 3G / 省流模式下的高 RTT 与首包重传，不该被当成"服务端慢"。
 * 这里只做保守分类（可用就分慢/快，不可用按默认），不读取带宽估值为业务排序。
 * navigator.connection 只在部分浏览器可用（Chrome/Android；iOS Safari 多数版本没有）。
 */
function readLinkProfile() {
  const c = typeof navigator === 'undefined' ? null : (navigator.connection || navigator.mozConnection || navigator.webkitConnection);
  const type = c?.type || '';
  const effectiveType = c?.effectiveType || '';
  const saveData = c?.saveData === true;
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const slow = offline || saveData || type === 'cellular' || type === 'wimax' || /^(slow-2g|2g|3g)$/.test(effectiveType);
  return { slow, type: type || null, effectiveType: effectiveType || null, saveData, offline };
}
const READ_TIMEOUT_FAST_MS = 15000, READ_TIMEOUT_SLOW_MS = 30000;
const NOTE_READ_TIMEOUT_FAST_MS = 6000, NOTE_READ_TIMEOUT_SLOW_MS = 12000;
/*
 * 故障诊断 f0e1c2c58c5126dd2：navigator.connection 会把实际很慢的链路报成 4g（事故里它报 4g，实测 2g、
 * launch 首屏 13.8 秒），只信它就会拿 15 秒预算去读会话目录，连续打穿后整个会话列表 30 秒才报错。
 * 这里用最近几次真实读取的结果校正预算：近 2 分钟内最近 3 次里至少 2 次超时或网络阶段超过 8 秒，
 * 就按弱网（30 秒）算，直到新的读取把窗口刷回快网。被取消（换页 / 回前台重建）的读取不算证据。
 */
const READ_SLOW_OBSERVE_MS = 8000, READ_SLOW_MEMORY = 3, READ_SLOW_WINDOW_MS = 120000;
function readLinkLooksSlow() {
  const recent = readTimings.filter((entry) => typeof entry.at === 'number' && Date.now() - entry.at <= READ_SLOW_WINDOW_MS).slice(-READ_SLOW_MEMORY);
  if (recent.length < READ_SLOW_MEMORY) return false;
  const slow = recent.filter((entry) => entry.timedOut === true || (!entry.aborted && (Number(entry.totalMs) || 0) - (Number(entry.queueMs) || 0) >= READ_SLOW_OBSERVE_MS));
  return slow.length >= 2;
}
// 待办是"小读取 + 静默重试"，预算比普通读取短；弱网放宽到 12 秒，仍留重试余量。
function adaptiveReadTimeout(kind = 'read') {
  const override = Number(window.PI_AGENT_READ_TIMEOUT_MS);
  if (override > 0) return override;
  const slow = readLinkProfile().slow || readLinkLooksSlow();
  if (kind === 'note') return slow ? NOTE_READ_TIMEOUT_SLOW_MS : NOTE_READ_TIMEOUT_FAST_MS;
  return slow ? READ_TIMEOUT_SLOW_MS : READ_TIMEOUT_FAST_MS;
}
window.piReadLink = () => ({ ...readLinkProfile(), observedSlow: readLinkLooksSlow() });
// 读取超时留一条带时间的本机记录：下次出现时能对上服务端慢请求 / 事件循环停顿日志，区分服务端与链路。
function readTimeoutNote(kind,queueMs,sentMs,budgetMs){
  const link=readLinkProfile(),observedSlow=readLinkLooksSlow();
  try{console.warn('[read-timeout]',new Date().toISOString(),JSON.stringify({kind,queueMs:Math.round(queueMs),sentMs:Math.round(sentMs),budgetMs:Math.round(budgetMs||0),link:link.slow||observedSlow?'slow':'fast',observedSlow,effectiveType:link.effectiveType,online:typeof navigator==='undefined'?null:navigator.onLine,visible:typeof document==='undefined'?null:document.visibilityState}));}catch{}
}
window.piReadTimings=()=>readTimings.map(entry=>({...entry}));
// Access expires independently of the application session. Keep drafts on this page while
// the user re-authenticates in another tab; never turn its login redirect into a read retry.
let guiAuthExpired = false, guiAuthEpoch = 0;
function noteGuiAuthFailure(path) {
  if (guiAuthExpired) return;
  guiAuthExpired = true; guiAuthEpoch++;
  if (typeof ui !== "undefined") ui.authRequired = true;
  if (typeof sessionCachesClear === "function") sessionCachesClear();
  window.sessionNotifications?.noteAuthFailure?.(path);
  if (typeof document !== "undefined") document.dispatchEvent(new Event("gui-auth-required"));
  if (typeof syncPageStatus === "function") syncPageStatus();
}
function noteGuiAuthRestored(epoch = guiAuthEpoch) {
  if (!guiAuthExpired || epoch !== guiAuthEpoch) return;
  guiAuthExpired = false;
  if (typeof ui !== "undefined") ui.authRequired = false;
  if (typeof document !== "undefined") document.dispatchEvent(new Event("gui-auth-restored"));
  if (typeof syncPageStatus === "function") syncPageStatus();
}

function readGateAcquire(controller,priority=1) {
  return new Promise((resolve) => { readGate.waiting.push({ controller, resolve, priority }); readGateSchedule(); });
}
// Collect the current startup/navigation burst before assigning free slots.
// This lets foreground priority apply even when ordinary reads were called first.
function readGateSchedule() {
  if(readGate.scheduled)return;
  readGate.scheduled=true;
  queueMicrotask(()=>{readGate.scheduled=false;
    while(readGate.active<readGate.max && readGate.waiting.length){
      let index=readGatePick();
      if(readGate.active>=readGateLimit(readGate.waiting[index].priority)){
        // 公平规则挑中的后台读取被预留槽位挡住时，前台读取（队列里优先级最高的）仍可用这个槽位。
        index=readGateTop();
        if(readGate.active>=readGateLimit(readGate.waiting[index].priority))break;
      }
      readGateDispatch(index);
    }
    // 紧急读取（优先级 < 0，如审批卡片核对最新状态）不排在慢的后台读取后面：可多占一个槽位。
    while(readGate.active<readGate.max+READ_GATE_URGENT_EXTRA && readGate.waiting.some(w=>w.priority<0))readGateDispatch(readGateTop());});
}
const READ_GATE_URGENT_EXTRA=1;
/*
 * 前台读取预留名额：会话列表 / 详情页里，普通与后台读取最多占 max-1 个槽位，最后一个只给前台关键读取（优先级 ≤ 0：
 * 当前会话的恢复、同步、消息，列表目录）。手机走备用入口时一个读取要等好几秒，以前前台读取只能排在已经发出的
 * 后台读取后面（实测 sync / messages 排队 3–4 秒，而它前面是 runtime/access、auth/sessions）；优先级只管排队顺序，
 * 管不了已经占着槽位的请求，所以要留位置。显式预算覆盖值、预算小于 3、非会话页面不预留，保持原有吞吐。
 */
const READ_GATE_FOREGROUND_RESERVE=1;
function readGateReserveApplies() {
  return !readGate.override && readGate.max>=3 && typeof ui!=='undefined' && (ui.view==='rt' || ui.view==='rt-room');
}
function readGateLimit(priority) {
  return priority<=0 || !readGateReserveApplies() ? readGate.max : readGate.max-READ_GATE_FOREGROUND_RESERVE;
}
function readGateTop() {
  let index=-1;
  for(let i=0;i<readGate.waiting.length;i++)if(index<0 || readGate.waiting[i].priority<readGate.waiting[index].priority)index=i;
  return index;
}
function readGatePick() {
  let index=readGateTop();
  if(index>=0 && readGate.waiting[index].priority>=0 && readGate.criticalStreak>=3){const other=readGate.waiting.findIndex(w=>w.priority>0);if(other>=0)index=other;}
  return index;
}
function readGateDispatch(index) {
  const next=index>=0?readGate.waiting.splice(index,1)[0]:null;
  if(next?.priority<0){readGate.active++;next.resolve(true);return;}
  readGate.criticalStreak=next?.priority===0?readGate.criticalStreak+1:0;
  if (next) { readGate.active++; next.resolve(true); }
}
function readGateRelease() {
  readGate.active=Math.max(0,readGate.active-1);
  if(!readGate.active && !readGate.waiting.length)readGate.criticalStreak=0;
  readGateSchedule();
}
/*
 * 回前台请求协调（故障诊断 f1010dec59eab3d5e）。
 * 手机从后台恢复时网络栈可能还没就绪，而目录、增量同步、额度、通知心跳等 visibilitychange
 * 监听会在同一瞬间各发一条请求：证据里 app_resumed 后 100ms 内 7 条请求全部 Failed to fetch，
 * 随后几分钟的目录 / 同步轮询也都在 6–17ms 内立刻失败。这里在恢复瞬间先做一次单飞、短超时的
 * 连通性探测：探测成功前 API 请求排队（排队不计入读取超时），成功后才按 2 条小并发放行；
 * 探测失败按指数退避重试，超过等待上限就放弃，交给调用方自己的超时与重试。离线时不探测也不排队
 * （请求会快速失败），等 online 事件再统一探测并通知页面补数据。
 * 目录与增量同步优先放行；同一路径的在飞请求在恢复窗口内合并。
 */
const RESUME_PROBE_PATH = '/api/session-sync/capabilities';
const RESUME_PROBE_TIMEOUT_MS = 3000;
const RESUME_PROBE_BACKOFF_MS = [400, 800, 1600, 3200];
const RESUME_HOLD_MAX_MS = 12000;
const RESUME_WINDOW_MS = 4000;
const RESUME_MAX_ACTIVE = 2;
const RESUME_CRITICAL = [/^\/api\/session-directory(?:\?|$)/, /^\/api\/runtime-sessions\/[^/]+\/(?:sync|restore|bootstrap|messages)(?:\?|$)/];
const RESUME_DEDUPE = [/^\/api\/session-directory(?:\?|$)/, /^\/api\/runtime-sessions\/[^/]+\/sync(?:\?|$)/];
const resumeGate = { armed: false, notify: false, epoch: 0, at: 0, limitedUntil: 0, active: 0, waiting: [], probe: null, timer: null, attempt: 0, inflight: new Map(), dedupe: false };
const resumeVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
const resumeOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;
function resumePriority(path) {
  return RESUME_CRITICAL.some((re) => re.test(String(path || ''))) ? 0 : 1;
}
function resumeProbeWaits() {
  const override = typeof window === 'undefined' ? null : window.PI_AGENT_RESUME_PROBE_BACKOFF_MS;
  return Array.isArray(override) ? override : RESUME_PROBE_BACKOFF_MS;
}
function resumeHoldLimit() {
  const override = typeof window === 'undefined' ? NaN : Number(window.PI_AGENT_RESUME_HOLD_MS);
  return Number.isFinite(override) && override >= 0 ? override : RESUME_HOLD_MAX_MS;
}
function resumeProbeTimeout() {
  const override = typeof window === 'undefined' ? NaN : Number(window.PI_AGENT_RESUME_PROBE_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : RESUME_PROBE_TIMEOUT_MS;
}
function resumeGateActive() {
  return resumeGate.armed || resumeGate.waiting.length > 0 || resumeGate.active > 0 || Date.now() < resumeGate.limitedUntil;
}
function resumeGateBegin(options = {}) {
  if (!resumeVisible()) return;
  if (!resumeOnline()) {
    // 离线：业务请求会快速失败（遥测按 offline 归类），不排队等网络；上线时再统一探测补数据。
    resumeGate.notify = true;
    resumeGate.armed = false;
    resumeGate.limitedUntil = 0;
    resumeGateGiveUp();
    return;
  }
  if (resumeGate.armed) { if (options.notify) resumeGate.notify = true; return; }
  // 普通回前台由各模块自己的可见性处理补数据；只有从离线恢复才额外广播 pi-network-ready。
  resumeGate.notify = options.notify === true;
  resumeGate.armed = true;
  resumeGate.epoch++;
  resumeGate.at = Date.now();
  resumeGate.limitedUntil = 0;
  resumeGate.attempt = 0;
  resumeGate.dedupe = true;
  void resumeGateProbe(resumeGate.epoch);
}
function resumeGateProbe(epoch) {
  if (!resumeGate.armed || epoch !== resumeGate.epoch) return resumeGate.probe;
  if (resumeGate.probe) return resumeGate.probe;
  if (!resumeOnline()) return null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer;
  const request = (async () => {
    try {
      const response = await Promise.race([
        fetch(RESUME_PROBE_PATH, { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, ...(controller ? { signal: controller.signal } : {}) }),
        new Promise((_, reject) => { timer = setTimeout(() => { controller?.abort(); reject(new Error('resume probe timeout')); }, resumeProbeTimeout()); })
      ]);
      // 5xx 说明链路通但服务暂时不可用：继续退避，别把整批业务请求立刻放出去。
      if (response.status >= 500) throw new Error(`resume probe ${response.status}`);
      return true;
    } finally { clearTimeout(timer); }
  })();
  resumeGate.probe = request;
  resumeGateProbeSettle(request, epoch);
  return request;
}
function resumeGateProbeSettle(request, epoch) {
  request.then(() => {
    if (epoch !== resumeGate.epoch) return;
    resumeGate.armed = false;
    resumeGate.limitedUntil = Date.now() + RESUME_WINDOW_MS;
    resumeGate.attempt = 0;
    resumeGateDispatch();
    setTimeout(resumeGateDispatch, RESUME_WINDOW_MS + 20);
    if (!resumeGate.notify) return;
    resumeGate.notify = false;
    try { window.dispatchEvent(new Event('pi-network-ready')); } catch { /* 测试替身 / 旧浏览器没有 window 事件 */ }
  }, () => {
    if (epoch !== resumeGate.epoch || !resumeGate.armed) return;
    if (!resumeOnline()) { resumeGateGiveUp(); return; }
    const waited = Date.now() - resumeGate.at;
    if (waited >= resumeHoldLimit()) { resumeGateGiveUp(); return; }
    const waits = resumeProbeWaits();
    const wait = waits[Math.min(resumeGate.attempt, waits.length - 1)];
    resumeGate.attempt++;
    clearTimeout(resumeGate.timer);
    resumeGate.timer = setTimeout(() => { resumeGate.timer = null; void resumeGateProbe(epoch); }, Math.max(0, Math.min(wait, resumeHoldLimit() - waited)));
  }).finally(() => {
    if (resumeGate.probe === request) resumeGate.probe = null;
  }).catch(() => {});
}
function resumeGateGiveUp() {
  clearTimeout(resumeGate.timer); resumeGate.timer = null;
  resumeGate.armed = false;
  resumeGate.limitedUntil = 0;
  resumeGate.dedupe = false;
  resumeGateDispatch();
}
function resumeGateDispatch() {
  if (resumeGate.armed) return;
  const limited = Date.now() < resumeGate.limitedUntil;
  const limit = limited ? RESUME_MAX_ACTIVE : Infinity;
  while (resumeGate.active < limit && resumeGate.waiting.length) {
    let index = 0;
    for (let i = 1; i < resumeGate.waiting.length; i++) if (resumeGate.waiting[i].priority < resumeGate.waiting[index].priority) index = i;
    const next = resumeGate.waiting.splice(index, 1)[0];
    // 等探测期间被取消的读取不再占槽位；requestJson 会在发出前看到 aborted。
    if (next.controller?.signal?.aborted) { next.resolve(false); continue; }
    resumeGate.active++;
    next.resolve(true);
  }
  if (!limited && !resumeGate.waiting.length) resumeGate.dedupe = false;
}
function resumeGateAcquire(path, controller) {
  // 平常不排队时返回 false（不是 Promise），调用方可以同步进入读取闸门，不额外让出一个微任务。
  if (!resumeGateActive() || controller?.signal?.aborted) return false;
  return new Promise((resolve) => { resumeGate.waiting.push({ resolve, priority: resumePriority(path), controller }); resumeGateDispatch(); });
}
function resumeGateRelease() {
  resumeGate.active = Math.max(0, resumeGate.active - 1);
  resumeGateDispatch();
}
function resumeGateDedupe(path) {
  return resumeGate.dedupe && RESUME_DEDUPE.some((re) => re.test(String(path || '')));
}
/* 在飞的 GET：换页时按路径取消上一条会话遗留的翻页/同步请求，别让它继续占连接。 */
const inFlightReads = new Map();
function abortReads(predicate = () => true) {
  for (const [path, controller] of inFlightReads) {
    if (!predicate(path)) continue;
    controller.abort();
    // 还在闸门外排队的：从队列里摘掉并唤醒，别占着下一个人的位置
    const i = readGate.waiting.findIndex((w) => w.controller === controller);
    if (i >= 0) readGate.waiting.splice(i, 1)[0].resolve(false);
    // 还停在恢复探测闸门外的读取也一并唤醒；requestJson 会在发出前看到 aborted。
    const j = resumeGate.waiting.findIndex((w) => w.controller && w.controller === controller);
    if (j >= 0) resumeGate.waiting.splice(j, 1)[0].resolve(false);
  }
}
window.abortReads = abortReads;
const readAbortError = () => new DOMException("Aborted", "AbortError");
// 响应体读取中断（断网 / 连接被复用重置）和「收到了格式错误的内容」是两类失败：
// 前者保留原始错误、按瞬时失败重试（status 502 仍走 retryTransientRead），后者说明响应确实不完整。
// 遥测用 code 区分两者，不再都记成同一条「响应内容不完整」。
function incompleteReadError(read, cause) {
  if (!read) return new Error("提交响应不完整，请核对真实状态");
  const invalid = cause instanceof SyntaxError;
  const error = new Error(invalid ? "响应格式错误，请重新读取" : "响应读取中断，请重新读取");
  error.code = invalid ? "RESPONSE_INVALID" : "READ_INTERRUPTED";
  error.status = 502;
  error.cause = cause;
  return error;
}

/*
 * 幂等 GET 的链路级重试：网关 502/503/504、网络层断开、响应体读到一半被切断（status 502）
 * 先静默退避再试一次（默认 0.7 秒 + 抖动；覆盖数组最多可配到 2 次）。4xx（含 401）、408 读取超时、主动取消都不重试——
 * 超时本身已等了一整个预算；写请求绝不重试（不是幂等的）。
 * 默认只补一次而不是两次：运行时页 / 目录 / 同步 / 待办的读取外面已经包了 retryTransientRead（2–3 次），
 * 两层叠加时最坏是 2×(1+外层次数)，不能再放大服务端过载时的请求量。没有外层重试的读取
 * （翻页、会话详情、入口权限之外的零散 GET）由这一层兜底。
 * window.PI_AGENT_READ_RETRY_DELAYS_MS（数组，长度即次数）与 retryTransientRead 共用同一个测试覆盖。
 */
const LINK_READ_RETRY_WAITS = [700];
function linkRetryableError(error) {
  if (error?.name === 'AbortError' || error?.status === 408) return false;
  return [502, 503, 504].includes(error?.status) || (!error?.status && (typeof TypeError === 'undefined' || error instanceof TypeError));
}
async function requestJsonWithRetry(path, options) {
  const override = window.PI_AGENT_READ_RETRY_DELAYS_MS;
  const waits = options.retry === false ? [] : Array.isArray(override) ? override : LINK_READ_RETRY_WAITS;
  for (let attempt = 0; ; attempt++) {
    try { return await requestJsonOnce(path, options); }
    catch (error) {
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      if (attempt >= waits.length || !linkRetryableError(error) || options.signal?.aborted || hidden || (typeof readRetryOffline === 'function' && readRetryOffline())) throw error;
      // 退避期间也登记成「在飞读取」，换页时 abortReads 能把它叫醒，不会在旧页面上补发请求。
      const waiter = new AbortController();
      inFlightReads.set(path, waiter);
      const wait = Math.max(Number(waits[attempt]) || 0, Number(error?.retryAfter) || 0);
      const jitter = wait ? Math.round(Math.random() * Math.min(300, wait * 0.25)) : 0;
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, wait + jitter);
          waiter.signal.addEventListener('abort', () => { clearTimeout(timer); reject(readAbortError()); }, { once: true });
          options.signal?.addEventListener?.('abort', () => waiter.abort(), { once: true });
        });
      } finally { if (inFlightReads.get(path) === waiter) inFlightReads.delete(path); }
    }
  }
}
async function requestJson(path, options = {}) {
  const read = !options.method || options.method === "GET";
  const run = () => read ? requestJsonWithRetry(path, options) : requestJsonOnce(path, options);
  // 恢复窗口内同一目录 / 同步只发一条：各模块各自触发的重复读取共用这次飞行。
  if (!read || options.signal || !resumeGateDedupe(path)) return run();
  const existing = resumeGate.inflight.get(path);
  if (existing) return existing;
  const flight = run().finally(() => { if (resumeGate.inflight.get(path) === flight) resumeGate.inflight.delete(path); });
  resumeGate.inflight.set(path, flight);
  return flight;
}

async function requestJsonOnce(path, options = {}) {
  let networkToken;
  try {networkToken=window.piTelemetry?.requestBegin?.(path);} catch {}
  const read = !options.method || options.method === "GET";
  if (!read) window.piPwaWrites = (Number(window.piPwaWrites) || 0) + 1;
  const queuedAt=performance.now(),priority=Number.isInteger(options.readPriority)?options.readPriority:readPriority(path);
  let acquiredAt=queuedAt,headersMs=null,bodyMs=null,decodeMs=null,serverMs=null,status=0,timedOut=false,failure=null;
  // 故障诊断：每个请求一个 x-request-id，服务端同一请求的慢请求 / 500 记录用它对上（V1.4 §3.1）
  const requestId=window.piTelemetry?.requestId?.()||null;
  const controller = read ? new AbortController() : null;
  let timer, held = false, resumeHeld = false;
  // 超时只覆盖网络阶段：发出 → 响应头 → 响应体读完。JSON 解析和主线程排队不计入，
  // 否则手机解析大响应时会把已经到达的数据判成超时。页面在后台时暂停计时，
  // 回前台用剩余时间继续，而不是把挂起的那几分钟算进超时。
  let timeoutRemaining = 0, timeoutDeadline = 0, timeoutHiddenAt = null, timeoutSettled = false;
  let rejectTimeout;
  const hiddenNow = () => typeof document !== "undefined" && document.visibilityState === "hidden";
  const clearReadTimer = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
  const failTimeout = () => {
    if (timeoutSettled || timedOut) return;
    timedOut = true; timeoutSettled = true; clearReadTimer();
    controller?.abort();
    const error = new Error("读取超时，请局部重试"); error.status = 408;
    rejectTimeout?.(error);
  };
  const armReadTimer = (ms) => {
    timeoutRemaining = Math.max(1, ms);
    timeoutDeadline = Date.now() + timeoutRemaining;
    clearReadTimer();
    timer = setTimeout(() => {
      timer = undefined;
      // 后台节流让定时器晚到时，不把挂起时间算进这一次读取。
      if (hiddenNow()) { timeoutHiddenAt = Date.now(); timeoutRemaining = Math.max(1, timeoutRemaining); return; }
      failTimeout();
    }, timeoutRemaining);
  };
  const pauseReadTimer = () => {
    if (timer === undefined) return;
    if (timeoutHiddenAt === null) timeoutHiddenAt = Date.now();
    timeoutRemaining = Math.max(1, timeoutDeadline - timeoutHiddenAt);
    clearReadTimer();
  };
  const resumeReadTimer = () => {
    timeoutHiddenAt = null;
    if (!read || timeoutSettled || timedOut || timer !== undefined) return;
    armReadTimer(timeoutRemaining);
  };
  const onVisibility = () => { if (hiddenNow()) pauseReadTimer(); else resumeReadTimer(); };
  const stopReadTimer = () => {
    timeoutSettled = true; clearReadTimer();
    if (typeof document !== "undefined") document.removeEventListener?.("visibilitychange", onVisibility);
  };
  // 优先级：全局实验覆盖 > 调用方显式预算 > 按链路自适应（蜂窝/弱网/实测慢 30 秒，否则 15 秒）。
  const timeoutOverride = Number(window.PI_AGENT_READ_TIMEOUT_MS);
  const timeoutExplicit = Number(options.readTimeoutMs);
  const observedSlow = readLinkLooksSlow();
  const timeoutMs = Math.max(1, timeoutOverride > 0 ? timeoutOverride : timeoutExplicit > 0 ? timeoutExplicit : adaptiveReadTimeout('read'));
  const timeout = read ? new Promise((_, reject) => { rejectTimeout = reject; }) : null;
  // 回前台恢复窗口：读写都要先等连通性探测，再按小并发放行（写原先不进入读取闸门）。
  // 必须在读取超时起算之前排队，恢复等待才不会被算成一次读取超时。
  if (read) {
    // 先登记在飞读取，换页时 abortReads 才能把还在恢复探测门外排队的读取也摘掉。
    inFlightReads.set(path, controller);
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      // 调用方取消时若仍在闸门外排队，立刻出队，别等轮到自己才发现已取消
      else options.signal.addEventListener("abort", () => {
        controller.abort();
        const i = readGate.waiting.findIndex((w) => w.controller === controller);
        if (i >= 0) readGate.waiting.splice(i, 1)[0].resolve(false);
        const j = resumeGate.waiting.findIndex((w) => w.controller && w.controller === controller);
        if (j >= 0) resumeGate.waiting.splice(j, 1)[0].resolve(false);
      }, { once: true });
    }
  }
  const resumeSlot = resumeGateAcquire(path, controller);
  if (resumeSlot !== false) resumeHeld = await resumeSlot;
  if (read) {
    held = await readGateAcquire(controller,priority);
    acquiredAt=performance.now();
    // 超时从真正发出开始算，不包含排队等待（浏览器连接上限或上面的闸门）。
    // 默认 15 秒；待办等小读取可用 readTimeoutMs 缩短，window.PI_AGENT_READ_TIMEOUT_MS 仍优先。
    if (hiddenNow()) { timeoutHiddenAt = Date.now(); timeoutRemaining = timeoutMs; }
    else armReadTimer(timeoutMs);
    if (typeof document !== "undefined") document.addEventListener?.("visibilitychange", onVisibility);
  }
  try {
    // 排到闸门外时被取消：不占槽位，也不必真的发出去。
    if (read && (!held || controller.signal.aborted)) throw readAbortError();
    const request = (async () => {
      const authEpoch = guiAuthEpoch, fetchAt=performance.now();
      try {window.piTelemetry?.requestDispatched?.(networkToken);} catch {}
      const res = await fetch(path, { ...options, ...(controller ? {signal:controller.signal} : {}), credentials: "same-origin", headers: { "content-type": "application/json", ...(options.headers || {}), "X-Requested-With": "XMLHttpRequest", ...(requestId ? { "x-request-id": requestId } : {}) } });
      headersMs=performance.now()-fetchAt;status=res.status;
      const handler=/\bhandler;dur=([\d.]+)/.exec(res.headers?.get('server-timing')||'');if(handler && Number.isFinite(Number(handler[1])))serverMs=Number(handler[1]);
      // Access's 401 may have an HTML body. Handle it before attempting JSON decoding.
      if (res.status === 401) {
        if (typeof window.dispatchEvent === "function") window.dispatchEvent(new Event("pi-gui-auth-failure"));
        noteGuiAuthFailure(path);
        const error = new Error("登录已失效，请重新登录"); error.status = 401; throw error;
      }
      // 响应体读取仍属于网络阶段；读完立即停表，后面的 JSON 解析是本地 CPU 成本。
      const bodyAt=performance.now();
      let body;
      if (typeof res.text === "function") {
        let text;
        try { text = await res.text(); }
        catch (error) {
          if (error?.name === "AbortError" || timedOut) throw error;
          if (res.ok) throw incompleteReadError(read, error);
          text = "";
        }
        finally { bodyMs=performance.now()-bodyAt; stopReadTimer(); }
        const decodeAt=performance.now();
        try { if (!text) throw new SyntaxError("empty response"); body = JSON.parse(text); }
        catch (error) { if (res.ok) throw incompleteReadError(read, error); body = {}; }
        finally { decodeMs=performance.now()-decodeAt; }
      } else {
        // 测试替身 / 旧 embedder 只实现了 json()：退回旧语义，仍受超时保护。
        try { body = await res.json(); }
        catch (error) { if (res.ok) throw incompleteReadError(read, error); body = {}; }
        finally { bodyMs = 0; decodeMs=performance.now()-bodyAt; stopReadTimer(); }
      }
      if (!res.ok) {
        const err = new Error(body.error || `请求失败（${res.status}）`);
        err.code = body.code;
        err.status = res.status;
        err.issues = Array.isArray(body.issues) ? body.issues : [];
        // 503 / 429 可能带 Retry-After（秒或 HTTP 日期）：重试前按它等，别贴着限流再打一次。
        err.retryAfter = retryAfterMs(res.headers?.get?.('retry-after'));
        throw err;
      }
      noteGuiAuthRestored(authEpoch);
      if (path === '/api/auth/sessions' && typeof sessionAuthObserve === 'function') sessionAuthObserve(body);
      if (path === '/api/auth/sessions' && body?.current) window.piTelemetry?.setIdentity?.(body.current);
      return body;
    })();
    try { return await (timeout ? Promise.race([request,timeout]) : request); }
    finally { stopReadTimer(); }
  } catch (error) { failure = error; throw error; } finally {
    try {window.piTelemetry?.requestFinished?.(networkToken,{status:failure?.status||status,timedOut,aborted:!!controller?.signal.aborted||failure?.name==='AbortError',error:failure,timings:{queue_ms:acquiredAt-queuedAt,headers_ms:headersMs}});} catch {}
    if (read) stopReadTimer();
    const finalStatus = failure ? (failure.status || status || 0) : status;
    // 调用方可用 expectedStatuses 声明「可预期的瞬时状态」（如推送存储忙 503），遥测不记为故障指纹。
    const expected = Array.isArray(options.expectedStatuses) && options.expectedStatuses.includes(finalStatus);
    try { window.piTelemetry?.requestDone?.({ requestId, path, method: options.method || 'GET', status: finalStatus, timedOut, aborted: !!controller?.signal.aborted || failure?.name === 'AbortError', error: failure, expected, ms: performance.now() - queuedAt,
      ...(read?{timings:{queue_ms:acquiredAt-queuedAt,headers_ms:headersMs,body_ms:bodyMs,decode_ms:decodeMs,server_ms:serverMs,timeout_ms:timeoutMs}}:{}) }); } catch {}
    if (!read) window.piPwaWrites = Math.max(0, (Number(window.piPwaWrites) || 0) - 1);
    if(read){readGateObserveProtocol();const kind=readKind(path);readTimings.push({kind,priority,budget:readGate.max,protocol:readGate.protocol,link:readLinkProfile().slow||observedSlow?'slow':'fast',observedSlow,timeoutMs,queueMs:acquiredAt-queuedAt,headersMs,bodyMs,decodeMs,serverMs,status,aborted:!!controller?.signal.aborted,timedOut,at:Date.now(),totalMs:performance.now()-queuedAt});if(readTimings.length>128)readTimings.shift();
      if(timedOut)readTimeoutNote(kind,acquiredAt-queuedAt,performance.now()-acquiredAt,timeoutMs);}
    if (read) { if (inFlightReads.get(path) === controller) inFlightReads.delete(path); if (held) readGateRelease(); }
    if (resumeHeld) resumeGateRelease();
  }
}

/*
 * 待办页的读取（列表 / 分类）：单次 6 秒就放弃卡住的连接，间隔 1 / 2 / 4 秒再试三次，
 * 最坏约 31 秒才报错；比原先 15 秒 × 3 次更早换连接，也不会把一次卡顿拖成近一分钟。
 */
const NOTE_READ_TIMEOUT_MS = 6000;
const NOTE_READ_RETRY_WAITS = [1000, 2000, 4000];
// 408 超时、502/503/504 网关与过载都是链路瞬时失败：GET 可安全重试。
const TRANSIENT_READ_STATUS = [408, 502, 503, 504];
// 网络层 TypeError（Failed to fetch）同样是瞬时失败：手机恢复 / 切网时请求可能还没到服务端。
function transientReadError(error) {
  if (error?.name === 'AbortError') return false;
  if (TRANSIENT_READ_STATUS.includes(error?.status)) return true;
  return !error?.status && (typeof TypeError === 'undefined' || error instanceof TypeError);
}
function readRetryOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}
function retryAfterMs(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, Math.round(seconds * 1000));
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.min(30_000, Math.max(0, at - Date.now())) : 0;
}

/*
 * 读取遇到瞬时失败（超时 408 / 网关 502、503、504）时，页面可见的情况下静默重试几次再报错。
 * 只给幂等 GET 用；`isCurrent` 返回 false（已换页/换筛选）或页面转入后台就停止，不替用户悄悄发请求。
 * 测试可用 window.PI_AGENT_READ_RETRY_DELAYS_MS 覆盖间隔（数组，长度即重试次数）。
 */
async function retryTransientRead(run, isCurrent = () => true, defaultWaits = [1000, 3000], isRetryable = transientReadError) {
  const override = window.PI_AGENT_READ_RETRY_DELAYS_MS;
  const waits = Array.isArray(override) ? override : defaultWaits;
  const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
  for (let attempt = 0; ; attempt++) {
    try { return await run(attempt); }
    catch (error) {
      // 离线时不重试：等 online 事件统一补数据，避免在确实没有网络时制造请求风暴。
      if (attempt >= waits.length || !isRetryable(error) || hidden() || readRetryOffline() || !isCurrent()) throw error;
      // Retry-After 比默认退避更长时用它：服务端已经说了别马上再来。
      const wait = Math.max(Number(waits[attempt]) || 0, Number(error?.retryAfter) || 0);
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (hidden() || !isCurrent()) throw error;
    }
  }
}

const badge = (text, kind = "") => h("span", { class: `badge ${kind}` }, text);
/*
 * 回前台 / 恢复监听必须早于 runtime.js、notifications.js 的恢复处理注册（脚本顺序见 index.html），
 * 这样各模块的 visibilitychange 处理发请求时，恢复协调闸门已经处于「探测中」。
 */
if (typeof document !== 'undefined' && document.addEventListener) {
  let lastResumeVisibility = document.visibilityState;
  document.addEventListener('visibilitychange', () => {
    const state = document.visibilityState;
    if (state === 'visible' && lastResumeVisibility === 'hidden') resumeGateBegin();
    else if (state === 'hidden') resumeGateGiveUp();
    lastResumeVisibility = state;
  });
  document.addEventListener('resume', () => resumeGateBegin());
}
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('pageshow', (event) => { if (event?.persisted) resumeGateBegin(); });
  window.addEventListener('online', () => {
    if (!resumeVisible()) return;
    if (resumeGate.armed) {
      // 仍在恢复等待里：立即探测并把成功后的补数据通知留给各页面模块。
      resumeGate.notify = true;
      resumeGate.at = Date.now();
      clearTimeout(resumeGate.timer); resumeGate.timer = null;
      void resumeGateProbe(resumeGate.epoch);
    } else resumeGateBegin({ notify: true });
  });
}
function minutesLeft(iso) {
  if (!iso) return "等待你处理，不自动超时";
  const ms = Date.parse(iso) - Date.now();
  if (!(ms > 0)) return "即将按拒绝处理";
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
  return `${m} 分 ${String(s).padStart(2, "0")} 秒内未处理将按拒绝`;
}

/**
 * 「选择文件夹…」按钮：请本机服务端弹出系统的文件夹选择器，选中后回调。
 * 浏览器拿不到本机绝对路径，所以只能由服务端弹；同一时刻只开一个。取消什么都不做。
 */
function pickButton(key, label, body, onPicked) {
  const busy = ui.picking === key;
  const btn = h("button", {
    class: "btn small-btn", type: "button", disabled: Boolean(ui.picking),
    title: "打开本机的文件夹选择器",
    onclick: async () => {
      ui.picking = key;
      delete ui.pickError[key];
      renderMain();
      try {
        const { picked } = await api("/api/pick-folder", { method: "POST", body: JSON.stringify(body()) });
        if (picked) onPicked(picked);
      } catch (e) { ui.pickError[key] = e.message; }
      ui.picking = "";
      renderMain();
    }
  }, busy ? "等待选择…" : label);
  const err = ui.pickError[key];
  return [btn, err ? h("span", { class: "field-error" }, err) : null];
}

/* --------------------------- 离开时的页面 --------------------------- */
/*
 * 切到其他应用再切回、或系统在后台回收页面后重新启动时，地址栏里的 # 路由不一定还在：
 * 安装到桌面的 PWA 会从 start_url 重新打开（hash 为空）。记住用户离开前真正在看的页面，
 * 只在「没有 hash 的冷启动」且上一次是切到后台后离开时恢复；普通刷新（地址仍带着 hash /
 * navigation type = reload）和真正首次进入都不受这条逻辑影响。
 */
const ROUTE_RESTORE_KEY = 'pi-agent:last-route:v1';
const ROUTE_RESTORE_TTL = 60 * 60 * 1000;
let routeRememberHidden = false;
function routeRestorable(hash) {
  return typeof hash === 'string' && hash.length <= 512 && /^#\/[A-Za-z0-9_\-./?=&%~]+$/.test(hash);
}
/** 只有安装到桌面的 PWA 会从 start_url 冷启动；浏览器标签页的刷新与导航仍以地址栏为准。 */
function routeStandalone() {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
    return navigator.standalone === true;
  } catch { return false; }
}
/** 记住当前页面：hidden 为真表示是切到后台时留下的，冷启动时可用于恢复。 */
function routeSave(hidden) {
  try {
    const hash = location.hash;
    if (!routeRestorable(hash)) return;
    localStorage.setItem(ROUTE_RESTORE_KEY, JSON.stringify({ hash, at: Date.now(), hidden: !!hidden }));
  } catch { /* 存储不可用时只影响这次恢复 */ }
}
function routeRemember(hidden) {
  routeRememberHidden = !!hidden;
  // 后台完成创建等非用户导航不能覆盖「离开前」的页面，否则恢复出来又会被带走。
  if (!hidden && (document.visibilityState === 'hidden' || !document.hasFocus())) return;
  routeSave(hidden);
}
/*
 * 一级 tab：每次进入 App 回到上次退出时所在的 tab（不分时长，只记 tab、不记里面的二级页）。
 * 会话 / 待办 / 产物等一级入口各记一个根地址；设置、统计等不是 tab 的页面不覆盖它。
 */
const TAB_RESTORE_KEY = 'pi-agent:last-tab:v1';
// 记忆 / 资源已经搬进设置（#/settings/memory、#/settings/resources），不再是可恢复的一级 tab。
const TAB_RESTORE_VIEWS = ['rt', 'notes', 'artifacts', 'ledger', 'communications', 'web-x'];
function tabRemember(tab) {
  if (!TAB_RESTORE_VIEWS.includes(tab)) return;
  try { localStorage.setItem(TAB_RESTORE_KEY, tab); } catch { /* 存储不可用时只影响下次恢复 */ }
}
function tabRestorable() {
  try {
    const tab = localStorage.getItem(TAB_RESTORE_KEY);
    return TAB_RESTORE_VIEWS.includes(tab) ? `#/${tab}` : '';
  } catch { return ''; }
}
/** 冷启动时若地址没有 hash，回到上一次切到后台前的页面（没有就回到上次的 tab）。普通刷新与首次进入保持原行为。 */
function restoreLaunchRoute() {
  if (/^[a-f0-9]{32}$/.test(new URLSearchParams(location.search).get("shareId") || "") || new URLSearchParams(location.search).has("shareError")) { location.hash = "#/notes"; return; }
  const standalone = routeStandalone();
  // 桌面 PWA 与 Android 客户端是「App」；浏览器标签页以地址栏为准。
  if (!standalone && !window.piAndroidShell?.available) return;
  if (location.hash && location.hash !== '#' && location.hash !== '#/') return;
  let navigationType = '';
  try { navigationType = performance.getEntriesByType?.('navigation')?.[0]?.type || ''; } catch { /* 老浏览器没有 Navigation Timing */ }
  // 刷新会保留原来的 hash；能从 reload 辨别时不要用更旧的记录覆盖它。
  if (navigationType === 'reload') return;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(ROUTE_RESTORE_KEY) || 'null'); } catch { /* 记录损坏：只用上次的 tab */ }
  const deep = standalone && saved && saved.hidden === true && routeRestorable(saved.hash) && Date.now() - Number(saved.at) < ROUTE_RESTORE_TTL;
  const target = deep ? saved.hash : tabRestorable();
  if (!target) return;
  try { history.replaceState(null, '', target); } catch { location.replace(target); }
  if (deep) routeSave(false);
}
document.addEventListener('visibilitychange', () => routeRemember(document.visibilityState === 'hidden'));
window.addEventListener('pagehide', () => routeSave(routeRememberHidden));
window.addEventListener('pageshow', () => { if (document.visibilityState === 'visible') routeRemember(false); });

/* ------------------------------- 路由 ------------------------------- */

/**
 * 首页是对话。旧的任务、项目、Golden、回放、盲评、Agent 页面已于 2026-10-18 删除：
 * 那些地址（以及任何认不出的地址）一律回到对话。
 */
const HOME_ROUTE = "#/rt";

function route() {
  // 换地址会触发 hashchange，再走一次路由
  if (!location.hash || location.hash === "#" || location.hash === "#/") { location.replace(HOME_ROUTE); return; }
  const hash = location.hash;
  const relationRoute = hash.match(/^#\/notes\/relations\/(.+)$/);
  const previousHash = ui.currentHash && ui.currentHash !== hash ? ui.currentHash : null;
  const previousNotesManagement = ui.notesManagement;
  const previousView = ui.view;
  if (previousView === "note-relations" && typeof noteRelationsDispose === "function") noteRelationsDispose();
  if (typeof rtDisposeMessageNavigators === 'function') rtDisposeMessageNavigators();
  if (typeof rtCloseLightbox === 'function') rtCloseLightbox();
  if (previousView === 'rt' && typeof rtRemember === 'function') rtRemember();
  if (previousView === 'rt-room' && typeof roomRemember === 'function') roomRemember();
  // 离开会话就掐掉它的在途读取（翻页、增量同步、详情）：它们对旧画面已无意义，只会占着连接让新页面排队。
  if (typeof abortReads === 'function') {
    // 用分隔符卡住前缀，别误伤 id 是它前缀的另一个会话
    const under = (prefix) => (path) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`);
    if (previousView === 'rt' && ui.rt?.id) abortReads(under(`/api/runtime-sessions/${ui.rt.id}`));
    if (previousView === 'rt-room' && ui.room?.id) abortReads(under(`/api/rooms/${ui.room.id}`));
  }
  if (previousView === "rt-compare" && typeof rtcStop === "function") rtcStop();
  // 故障诊断：离开正在加载的会话（去别的页面或别的会话）算正常取消，不让它在后台被判超时
  if (typeof rtContentOpEnd === 'function' && hash.match(/^#\/rt\/(r[tx]-[a-z0-9]+)$/)?.[1] !== ui.rt?.id) rtContentOpEnd('navigate');
  if (ui.rt) { rtStop(); ui.rt.gen++; }
  if (ui.room) { roomStop(); ui.room.generation++; }
  const rt = hash.match(/^#\/rt(?:\/(new|r[tx]-[a-z0-9]+))?$/);
  const rtRoom = hash.match(/^#\/rt\/room\/(new|room-[a-z0-9]+)$/);
  const rtCompare = hash.match(/^#\/rt\/compare\/(cmp-[a-z0-9]+)$/);
  const notesManagement = hash.match(/^#\/notes\/categories(?:\/(add|update|merge))?$/);
  const artifactEval = hash.match(/^#\/artifacts\/evals\/([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)(?:\/compare\/([a-z0-9][a-z0-9-]*(?:\+[a-z0-9][a-z0-9-]*){0,3}))?$/);
  const artifact = hash.match(/^#\/artifacts(?:\/([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*))?$/);
  const settingsRoute = hash.match(/^#\/settings(?:\/([a-z-]+))?(?:\/([a-z-]+))?$/);
  if (previousView === "notes" && !previousNotesManagement && notesManagement && typeof noteRememberManagementPosition === "function") noteRememberManagementPosition();
  ui.notesManagement = notesManagement ? (notesManagement[1] || "home") : null;
  ui.notesKeepPagesOnReturn = !!(previousNotesManagement && hash === "#/notes");
  if (previousNotesManagement && hash === "#/notes") { ui.notesKeepPagesOnReturn = true; ui.notesRestoreManagementPosition = true; }
  ui.routeGeneration = (ui.routeGeneration || 0) + 1;
  navigationMark("intent");
  // V2.8：外部 runtime 会话工作台、新建运行时会话、运行时配置
  if (rt && rt[1] === "new") { ui.view = "rt-new"; if (typeof rtTrackNewOrigin === "function") rtTrackNewOrigin(previousView, previousHash); }
  else if (rtRoom) { ui.view = rtRoom[1] === "new" ? "rt-room-new" : "rt-room"; if (rtRoom[1] === "new" && typeof rtTrackNewOrigin === "function") rtTrackNewOrigin(previousView, previousHash); roomSelect(rtRoom[1] === "new" ? null : rtRoom[1], previousView !== "rt-room"); }
  else if (rtCompare) { ui.view = "rt-compare"; rtcSelect(rtCompare[1]); }
  else if (rt) { ui.view = "rt"; if (ui.rt.id !== (rt[1] || null) || previousView !== "rt") rtSelect(rt[1] || null); }
  else if (hash === "#/runtimes") { ui.view = "runtimes"; ui.rt.settingsDraft = null; }
  else if (settingsRoute) {
    const raw = settingsRoute[1] || "home", extra = settingsRoute[2] || null;
    // 旧地址转到合并后的页：错误统计 / Codex Reset → 定时任务；安装历史挪到「平台 APP 版本」下面。
    const alias = { errorstats: "scheduled", codexreset: "scheduled" }[raw];
    if (alias) { location.replace(`#/settings/${alias}`); return; }
    if (raw === "version" && extra === "installs") { location.replace("#/settings/appversion/installs"); return; }
    if (!["home", "capabilities", "navigation", "cache", "apps", "resources", "runtimes", "runtimeupdates", "login", "memory", "scheduled", "version", "appversion"].includes(raw) || (extra && !((raw === "version" && extra === "all") || (raw === "appversion" && extra === "installs")))) { location.replace("#/settings"); return; }
    const wanted = raw;
    if (previousView !== "settings") {
      ui.settings.returnHash = previousHash || "#/rt";
      // 每次从其它页面回到设置都重新读一次部署历史：先显示本机存的上次快照，再后台同步最新，避免空白等待。
      ui.settings.authLoaded = false;
      ui.settings.rtLoaded = false;
      ui.settings.resourcesLoaded = false;
      ui.settings.appsLoaded = false;
      ui.settings.deployments = null;
      ui.settings.deployAttempted = false;
      ui.settings.deployStale = false;
      ui.settings.deployHydrated = false;
      ui.settings.deployError = "";
      ui.settings.deployMoreError = "";
      ui.settings.deployLoadingMore = false;
      ui.settings.deploySentinel = null;
    }
    ui.view = "settings";
    ui.settings.section = wanted;
    ui.settings.extra = extra;
  }
  // 外部资源主要入口已接进设置（#/settings/resources）；旧的 #/resources 仍然能直接打开同一个页面。
  else if (hash === "#/resources") { ui.view = "resources"; }
  // 统计应用：#/stats、#/stats/<cost|sessions|deploys>?m=&focus=；返回键回到进来之前的页面
  else if (/^#\/stats(?:\/(?:cost|sessions|deploys))?(?:\?[\w=&%.-]*)?$/.test(hash)) {
    ui.view = "stats";
    ui.stats ||= {};
    if (previousView !== "stats" && previousHash) ui.stats.returnHash = previousHash;
  }
  else if (/^#\/communications(?:\/contact\/[^/]+)?$/.test(hash)) { ui.view = "communications"; }
  else if (hash === "#/ledger") { ui.view = "ledger"; }
  else if (hash === "#/open-source-release" && window.piRouteModules?.has("open-source-release")) { ui.view = "open-source-release"; }
  else if (hash === "#/web-x") { ui.view = "web-x"; }
  else if (artifactEval) { ui.view = "artifacts"; ui.artifactGame = null; ui.artifactEval = { suite: artifactEval[1], case: artifactEval[2], compare: artifactEval[3] ? artifactEval[3].split("+") : null }; }
  // 记忆设置已合并进设置页（#/settings/memory）：旧地址转过去。#/memory 本身保留，会话里的记忆出处链接和架构页还用它。
  else if (hash === "#/memory/settings") { location.replace("#/settings/memory"); return; }
  else if (hash === "#/memory" || hash === "#/memory/architecture" || /^#\/memory\/t\/[\w-]+$/.test(hash)) { ui.view = "memory"; }
  else if (artifact) { ui.view = "artifacts"; ui.artifactEval = null; ui.artifactGame = artifact[1] && artifact[1] !== "evals" ? { category: artifact[1], id: artifact[2] } : null; }
  else if (relationRoute) { try { ui.relationRootKey=decodeURIComponent(relationRoute[1]); } catch { location.replace("#/notes"); return; } ui.view="note-relations"; }
  else if (hash === "#/notes" || /^#\/notes\/widget\/\d{4}-\d{2}-\d{2}(?:\/n-[A-Za-z0-9_-]+)?$/.test(hash) || notesManagement) { ui.view = "notes"; }
  else { location.replace(HOME_ROUTE); return; }
  // 可选应用被关闭（设置 → 应用）：它的页面不再可达，直接回到首页，不留空白页。
  if (window.piApps?.blocksView(ui.view)) { location.replace(HOME_ROUTE); return; }
  const tab = ui.view === "note-relations" ? "notes" : ui.view.startsWith("rt") || ui.view === "runtimes" ? "rt" : ui.view;
  // Record real entry, including cold/deep links; native owns timestamps and deduplication.
  if (window.piAndroidShell?.available && (!ui.currentHash || tab !== previousView) &&
      ["rt", "resources", "notes", "artifacts", "ledger", "communications", "memory", "web-x", "open-source-release"].includes(tab)) {
    void window.piAndroidShell.call("widget.appVisit", { id: tab }).catch(() => {});
  }
  if (typeof rtRefreshDetailOrigin === "function") {
    const detailId = ui.view === "rt" ? (ui.rt?.id || null) : null;
    if (!detailId || ui.currentHash !== hash) rtRefreshDetailOrigin(detailId, previousView, previousHash);
  }
  ui.currentHash = hash;
  if (typeof tabRemember === 'function') tabRemember(tab);
  // 会话应用最后停留的地址：新建页 / 群聊 / 对比页不能靠 ui.rt.id 还原（那里可能还是上一个单聊会话）。
  if (ui.rt && ["rt", "rt-new", "rt-room", "rt-room-new", "rt-compare"].includes(ui.view)) ui.rt.lastChatHash = hash;
  routeRemember(false);
  window.piStartup?.target?.(hash, ui.view === "rt" ? (ui.rt?.id ? "single" : "list") : ui.view === "rt-room" ? "room" : "other");
  // 「创建中」详情页只属于新建页这个地址；离开后不留着，免得下次点新建会话又看到它
  if (ui.view !== "rt-new" && ui.rt?.launch?.req) ui.rt.launch = null;
  document.querySelector(".layout").classList.toggle("rt-mode", ui.view === "rt" || ui.view === "rt-new" || ui.view === "rt-compare" || ui.view === "rt-room" || ui.view === "rt-room-new");
  document.body.classList.toggle("settings-mode", ui.view === "settings");
  document.body.classList.toggle("stats-mode", ui.view === "stats");
  document.querySelector(".nav-settings-button")?.classList.toggle("active", ui.view === "settings" || ui.view === "stats");
  if (tab !== "rt" && typeof rtStop === "function") rtStop();
  if (ui.view !== "rt-room" && typeof roomStop === "function") roomStop();
  if (!["rt-room", "rt-room-new"].includes(ui.view) && typeof roomDeactivate === "function") roomDeactivate();
  if (ui.view !== "rt-compare" && typeof rtcStop === "function") rtcStop();
  if (ui.view !== "open-source-release" && window.piRouteModules?.has("open-source-release") && window.piRouteModules.state("open-source-release") === "ready") window.piRouteModules.module("open-source-release").deactivate();
  if (ui.view !== "communications" && window.piRouteModules?.has("communications") && window.piRouteModules.state("communications") === "ready") window.piRouteModules.module("communications").deactivate();
  if (ui.view !== "notes" && typeof noteDeactivate === "function") noteDeactivate();
  window.navNoteVisit?.(tab);
  // 手机会话列表：会话不在底栏里，底栏选中的是进入会话前的应用（session-drawer.js），点别的入口直接切过去
  const shownTab = tab === "rt" && rtPhone.matches && ui.view === "rt" && !ui.rt?.id ? (window.piSessionDrawer?.originView?.() || tab) : tab;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === shownTab));
  syncNavMore();
  window.navSyncActive?.();
  window.scrollTo(0, 0);
  ui.pageError = ""; ui.pageLoading = true;
  if (typeof rtSyncPageEffects === 'function') rtSyncPageEffects();
  restorePageCache();
  renderMain(); navigationMark("target-shell");
  refresh({ main: true });
}

/* ------------------------------ 数据刷新 ------------------------------ */

function pageModule(view) { if (view === "rt") return ui.rt.id ? "rt-detail" : "rt-list"; if (["rt-room", "rt-room-new"].includes(view)) return "room"; return view; }
function pageContext() { return { generation: ui.routeGeneration || 0, view: ui.view }; }
function contextCurrent(c) { const now = pageContext(); return now.generation === c.generation && now.view === c.view; }
function pagePath() {
  if (ui.view === "resources") return "/api/resources";
  if (ui.view === "ledger") return "/api/ledger";
  if (ui.view === "notes") return ui.notesManagement ? "/api/note-categories" : typeof noteListPath === "function" ? noteListPath() : "/api/notes";
  return null;
}
function commitPage(path, value) {
  if (path === "/api/resources") ui.resources = value;
  else if (path === "/api/ledger") ui.ledger = value;
  else if (path === "/api/note-categories") { if (typeof noteApplyTaxonomy === "function") noteApplyTaxonomy(value); else ui.noteTaxonomy = value; if (typeof noteReadRecovered === "function") noteReadRecovered(); }
  else if (path === "/api/notes" || path.startsWith("/api/notes?")) {
    // 分页响应（含 notes/nextCursor）与旧的完整数组都接：前端按页累积。
    // 换筛选后的第一页合并回列表（已加载的更早记录不丢），但游标以新筛选的响应为准。
    const mergeForQuery = !!ui.notesMergeFor && ui.notesMergeFor === path;
    if (mergeForQuery) ui.notesMergeFor = null;
    if ((mergeForQuery || ui.notesKeepPagesOnReturn) && typeof noteMergePage === "function") { noteMergePage(value, { syncCursor: mergeForQuery }); }
    else if (typeof noteApplyPage !== "function" || !noteApplyPage(value, true)) ui.notes = value;
    if (typeof noteReadRecovered === "function") noteReadRecovered();
    // 推荐任务响应有几百 KB，只有「推荐任务」页签用得上：筛选 / 翻页读列表时不要再下载一遍，
    // 手机网慢时它会和列表抢带宽，把列表读取拖到超时。切到该页签时 noteSetTab 会自己读。
    if (ui.notesTab === 'recommended' && typeof noteLoadIterations === 'function') void noteLoadIterations();
    // 分类目录只在还没读过时补读；改分类 / 其它设备的变更靠服务端事件刷新，换筛选不会改目录。
    if (!ui.noteTaxonomy && typeof noteLoadCategories === "function") void noteLoadCategories();
  }
}
function restorePageCache() {
  const path = pagePath(); const hit = path && peekRead(path);
  ui.pageStale = !!hit?.stale;
  if (hit) { commitPage(path, hit.value); ui.pageLoading = hit.stale; }
}
const pageRefreshes = new Map();
function refresh(options = {}) {
  if (!options.main) return Promise.resolve();
  const c = pageContext();
  const key = `${c.generation}:${c.view}`;
  const existing = pageRefreshes.get(key);
  if (existing) { existing.dirty ||= !!options.force; return existing.promise; }
  const entry = {dirty:false,promise:null};
  entry.promise = refreshPage(options).finally(()=>{
    pageRefreshes.delete(key);
    if(entry.dirty && contextCurrent(c)) void refresh({main:true,force:true});
  });
  pageRefreshes.set(key,entry);return entry.promise;
}
async function refreshPage({ force = false } = {}) {
  const c = pageContext();
  let path = null;
  try {
    const module = pageModule(c.view);
    if (window.piRouteModules?.has(module)) {
      const firstLoad = window.piRouteModules.state(module) !== 'ready';
      const loading = window.piRouteModules.ensure(module);
      if (firstLoad) renderMain();
      await loading;
      if (!contextCurrent(c)) return;
      if (firstLoad) renderMain();
    }
    path = pagePath();
    if (path) {
      const value = ui.view === "notes" && (path.startsWith("/api/notes?") || path === "/api/note-categories")
        // 待办列表 / 分类：超时/502 时静默重试（重试一律绕过缓存），页面上仍是「正在读取…」，全失败才报错
        ? await retryTransientRead((attempt) => readResource(path, { force: force || attempt > 0, timeoutMs: adaptiveReadTimeout("note") }), () => contextCurrent(c) && path === pagePath(), NOTE_READ_RETRY_WAITS)
        : await readResource(path, { force });
      if (!contextCurrent(c)) return;
      // 待办页的筛选条件变了（path 带 status / category / link）：旧条件的响应不能再写回列表，
      // 否则会把上一组筛选的页覆盖到新筛选上。
      if (ui.view === "notes" && path !== pagePath()) return;
      commitPage(path, value); ui.pageError = ""; ui.pageStale = false;
    }
    if (!contextCurrent(c)) return;
    if ((ui.view === "rt" || ui.view === "rt-new" || ui.view === "rt-compare" || ui.view === "rt-room" || ui.view === "rt-room-new" || ui.view === "runtimes") && typeof rtRefresh === "function") await rtRefresh();
  } catch (e) {
    // 读取期间换了筛选 / 换到分类管理（path 变了）：这条读取已经过期，它的超时或失败不该挂成
    // 新条件下的页面错误条——换筛选时派生的那次 refresh（pageRefreshes 的 dirty 重跑）会用自己的
    // 结果说话，它真失败仍会照常报错。故障 fd55cd4e2a9f76719：待办首屏读取中途换大类，
    // 过期读取的 6 秒超时被当成页面错误「读取超时，请局部重试」闪在已经换了条件的列表上。
    const stale = path !== null && path !== pagePath();
    if (contextCurrent(c) && !stale) { ui.pageError = e.message; ui.pageStale = !!peekRead(path); }
  }
  finally {
    if (contextCurrent(c)) { ui.pageLoading = false;
      if (ui.view === 'notes' && document.querySelector('.notes') && !composing && !pointerHeld) { noteRefreshList(); if (typeof noteRefreshRecommended === 'function') noteRefreshRecommended(); }
      else if (ui.view === 'rt' && ui.rt.view && document.querySelector('.rt-center[data-ro]')) rtRenderSoft();
      else if (ui.view === 'rt-room' && ui.room.view && document.querySelector('.room-center')) roomRenderSoft(false);
      else renderMain();
      syncPageStatus();
      navigationMark("target-data"); }
  }
}

function onServerUpdate(ev) {
  let u = {}; try { u = JSON.parse(ev.data); } catch { return; }
  if (u.kind === "balances") {
    invalidateReads(key => key === "/api/resources");
    if (typeof rtBalancesChanged === "function") void rtBalancesChanged();
    if (ui.view === "resources") void refresh({ main: true, force: true });
    return;
  }
  if (u.kind === "ledger") {
    invalidateReads(key => key === "/api/ledger");
    if (ui.view === "ledger") void refresh({ main: true, force: true });
    return;
  }
  if (u.kind === "navigation") {
    invalidateReads(key => key === "/api/navigation");
    if (typeof window.navSettingsRemoteUpdate === "function") void window.navSettingsRemoteUpdate();
    return;
  }
  if (u.kind === "notes") {
    invalidateReads(key => key === "/api/notes" || key.startsWith("/api/notes?") || key === "/api/note-categories");
    // A notification can precede deferred code. Coalesce it into the route's
    // existing load, and keep failed code retries explicitly user-driven.
    if (ui.view === "notes" && window.piRouteModules?.has("notes") && window.piRouteModules.state("notes") !== "ready") {
      if (window.piRouteModules.state("notes") !== "error") void refresh({ main: true, force: true });
      return;
    }
    if (ui.view === "rt" && typeof rtLoadLinkedNote === "function") { ui.rt.linkedNoteFor = null; void rtLoadLinkedNote(rtId(), ui.rt.gen); }
    if (ui.view === "note-relations" && typeof noteRelationsLoad === "function") { void noteRelationsLoad(true); return; }
    if (ui.view === "notes" && ui.notesTab === "calendar" && typeof noteLoadCalendar === "function") { void noteLoadCalendar(true); return; }
    if (typeof noteCalendarInvalidate === "function") noteCalendarInvalidate();
    if (typeof noteTodayMounted === "function" && noteTodayMounted()) void noteLoadTodaySummary();
    if (ui.view === "notes" && ui.notesTab === "recommended" && typeof noteLoadIterations === "function") void noteLoadIterations();
    // 待办页已按页加载：只合并回第一页并局部重绘，不要把列表重置回第一页、丢掉滚动位置。
    if (ui.view === "notes" && ui.notesManagement) { void noteLoadCategories(); return; }
    if (ui.view === "notes" && typeof noteRefreshFirstPage === "function") { void noteRefreshFirstPage(); return; }
  }
}

/* -------------------------------- 渲染 -------------------------------- */

// 输入法组词期间（拼音还没上屏）不重绘：重绘会替换输入框，组到一半的词就丢了。上屏后补一次。
let composing = false;
let pointerHeld = false;
document.addEventListener("pointerdown", () => {pointerHeld=true;});
// 触摸指针登记：三指截图这类系统手势会吞掉一部分 pointerup / pointercancel，浏览器那头的「主指针」状态可能卡住，
// 之后新的单指触摸 isPrimary 一直是 false（要杀掉 APP 才恢复）。手势代码不再看 isPrimary，改问这里「除我以外还有没有别的手指按着」；
// 登记 2.5 秒后自动过期，丢了抬起事件的指针不会一直占着。
{
  const down = new Map();
  const live = (now) => { for (const [id, at] of down) if (now - at > 2500) down.delete(id); };
  document.addEventListener("pointerdown", (ev) => { if (ev.pointerType !== "touch") return; live(ev.timeStamp); if (!down.has(ev.pointerId)) down.set(ev.pointerId, ev.timeStamp); }, { capture: true, passive: true });
  const up = (ev) => { down.delete(ev.pointerId); };
  document.addEventListener("pointerup", up, { capture: true, passive: true });
  document.addEventListener("pointercancel", up, { capture: true, passive: true });
  window.piOtherTouchDown = (ev) => { live(ev.timeStamp); for (const id of down.keys()) if (id !== ev.pointerId) return true; return false; };
}
const releasePointer = () => {pointerHeld=false;if(renderDeferred&&!composing){renderDeferred=false;setTimeout(renderMain,0);}};
document.addEventListener("pointerup", releasePointer);
document.addEventListener("pointercancel", releasePointer);
let renderDeferred = false;
document.addEventListener("compositionstart", () => { composing = true; });
document.addEventListener("compositionend", () => {
  composing = false;
  if (renderDeferred) { renderDeferred = false; setTimeout(renderMain, 0); }
});

// The loader owns downloads; route generations own data reads and mounting.
function renderRouteFeature(view, fallback) {
  const loader = window.piRouteModules;
  if (!loader?.has(view)) return fallback();
  const state = loader.state(view);
  if (state === 'ready') return loader.module(view).render();
  if (view === 'rt-detail' && state !== 'error') return renderRtLoadingWorkbench();
  return h('section', { class: 'card route-loading', 'aria-label': '页面加载' },
    h('p', { role: state === 'error' ? 'alert' : 'status' }, state === 'error' ? '页面未能加载，请重试。若版本已过期，请先保存草稿再更新页面。' : '正在打开页面…'),
    state === 'error' ? h('button', { class: 'btn', type: 'button', onclick: () => { ui.pageError = ''; void refresh({ main: true }); } }, '重试加载') : null);
}

function renderMain() {
  if (composing || pointerHeld) { renderDeferred = true; return; }
  clearTimeout(renderMain.todayTimer);
  renderMain.todayTimer = null;
  // 抬指后卡片仍在提交切换，等待动画收尾再重建页面。
  if (ui.view === "rt" && document.querySelector("#notes-today.is-sliding")) {
    renderMain.todayTimer = setTimeout(renderMain, 200);
    return;
  }
  // 手机详情页会隐藏全局顶栏：先切换 chrome，再量顶栏高度
  if (typeof rtSyncChrome === "function") rtSyncChrome();
  syncViewport();
  const main = document.getElementById("main");
  const priorDraft = ui.view === 'rt' ? main.querySelector('.rt-composer textarea') : null;
  const priorMention = priorDraft?.closest('.rt-mention-input');
  // 重绘前记下焦点与光标，重绘后还原（带 data-key 的输入框）
  const active = document.activeElement;
  const key = active && active.dataset ? active.dataset.key : undefined;
  const sel = key && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
  // 重绘不丢滚动位置
  const scrolls = {};
  main.querySelectorAll("[data-keep-scroll]").forEach((el) => { scrolls[el.dataset.keepScroll] = el.scrollTop; });
  // 横向滚动的条（运行事件的阶段条）同样保留左右位置
  const scrollsX = {};
  main.querySelectorAll("[data-keep-scroll-x]").forEach((el) => { scrollsX[el.dataset.keepScrollX] = el.scrollLeft; });
  if (typeof rtDisposeMessageNavigators === 'function') rtDisposeMessageNavigators();
  const next =
    ui.view === "resources" ? renderRouteFeature("resources", () => renderResources())
      : ui.view === "artifacts" ? (typeof renderArtifacts === "function" ? renderArtifacts() : h("div", { class: "empty" }, "加载中…"))
      : ui.view === "communications" ? renderRouteFeature("communications", () => h("div", {class:"empty"}, "正在打开通讯录…"))
      : ui.view === "ledger" ? renderRouteFeature("ledger", () => typeof renderLedger === "function" ? renderLedger() : h("div", { class: "empty" }, "加载中…"))
      : ui.view === "open-source-release" ? renderRouteFeature("open-source-release", () => h("div", { class: "empty" }, "加载中…"))
      : ui.view === "web-x" ? renderRouteFeature("web-x", () => h("div", { class: "empty" }, "加载中…"))
      : ui.view === "stats" ? renderRouteFeature("stats", () => h("div", { class: "empty" }, "加载中…"))
      : ui.view === "memory" ? renderRouteFeature("memory", () => h("div", { class: "empty" }, "加载中…"))
      : ui.view === "note-relations" ? renderRouteFeature("note-relations", () => typeof renderNoteRelations === "function" ? renderNoteRelations() : h("p", {}, "加载中…"))
      : ui.view === "notes" ? renderRouteFeature("notes", () => typeof renderNotes === "function" ? renderNotes() : h("div", { class: "empty" }, "加载中…"))
      : ui.view === "rt-new" ? renderRouteFeature("rt-new", () => renderRtNewWorkbench())
      : ui.view === "rt-room" ? renderRouteFeature("room", () => renderRoom())
      : ui.view === "rt-room-new" ? renderRouteFeature("room", () => renderRoomNew())
      : ui.view === "rt-compare" ? renderRouteFeature("rt-compare", () => renderRtCompareWorkbench())
      : ui.view === "runtimes" ? renderRouteFeature("runtimes", () => renderRuntimes())
      : ui.view === "settings" ? renderRouteFeature("settings", () => h("div", { class: "empty" }, "正在打开设置…"))
      : renderRouteFeature(pageModule("rt"), () => renderRtWorkbench());
  // 游戏播放层会返回已经在页面上的同一个节点：摘下再装回 iframe 会重新加载，游戏状态就丢了
  if (!(main.childNodes.length === 1 && main.firstChild === next)) main.replaceChildren(next);
  window.imageIntake?.refresh?.();
  // Loading, disk display and live view share the input node; update its bindings
  // before reusing it so Enter cannot call an old session/revision closure.
  const nextDraft = ui.view === 'rt' ? main.querySelector('.rt-composer textarea') : null;
  const nextMention = nextDraft?.closest('.rt-mention-input');
  if (priorDraft && nextDraft && priorDraft.dataset.key === nextDraft.dataset.key && priorMention?.updateMentionAttrs && nextMention) {
    priorMention.updateMentionAttrs(nextMention.mentionAttrs);
    priorDraft.disabled = nextDraft.disabled;
    priorDraft.readOnly = nextDraft.readOnly;
    priorDraft.placeholder = nextDraft.placeholder;
    priorDraft.dataset.phonePlaceholder = nextDraft.dataset.phonePlaceholder || '';
    priorDraft.dataset.desktopPlaceholder = nextDraft.dataset.desktopPlaceholder || '';
    if (!priorDraft.isComposing && priorDraft.value !== nextDraft.value) {
      priorDraft.value = nextDraft.value;
      if (typeof rtRefreshComposer === "function") rtRefreshComposer(priorDraft);
    }
    nextMention.replaceWith(priorMention);
  }
  if (typeof rtSyncPageEffects === "function") rtSyncPageEffects();
  syncPageStatus();
  navigationMark("render-commit");
  main.querySelectorAll("[data-keep-scroll]").forEach((el) => {
    if (scrolls[el.dataset.keepScroll] !== undefined) el.scrollTop = scrolls[el.dataset.keepScroll];
  });
  main.querySelectorAll("[data-keep-scroll-x]").forEach((el) => {
    if (scrollsX[el.dataset.keepScrollX] !== undefined) el.scrollLeft = scrollsX[el.dataset.keepScrollX];
  });
  if (key) {
    const again = main.querySelector(`[data-key="${key}"]`);
    if (again) { again.focus(); if (sel) again.setSelectionRange(sel[0], sel[1]); }
  }
}

/**
 * 页面读取状态。对话工作台自带加载状态并先显示缓存，只在读取失败时浮在右上角；
 * 其它页面读取 / 后台更新时，只在页标题后转一个小圈（.page-status-inline），不占一行、不挡内容；
 * 读取失败或登录失效仍用底部提示（.page-status-toast）承载说明和重试按钮。
 * 局部刷新（待办列表、会话正文）不走 renderMain，读取结束时也要单独收掉这条提示。
 */
function syncPageStatus() {
  const main = document.getElementById("main");
  if (!main) return;
  main.setAttribute("aria-busy", String(!!ui.pageLoading));
  const rtMode = ui.view === "rt" || ui.view === "rt-new" || ui.view === "rt-compare" || ui.view === "rt-room" || ui.view === "rt-room-new";
  const old = main.querySelector(".page-status") || document.querySelector("#rt-mobile-header .page-status");
  const modulePending = window.piRouteModules?.has(pageModule(ui.view)) && window.piRouteModules.state(pageModule(ui.view)) !== 'ready';
  const alert = ui.authRequired || (!modulePending && ui.pageError);
  const loading = !alert && !rtMode && !modulePending && (ui.pageLoading || ui.pageStale);
  const label = ui.pageStale ? "正在更新；当前为之前读取的内容" : "正在读取…";
  const next = alert
    ? h("div", { class: `page-status error${rtMode ? " page-status-float" : " page-status-toast"}${ui.authRequired ? " auth-required" : ""}`, role: ui.authRequired ? "alert" : "status" },
      ui.authRequired ? "登录已失效；请在新标签页重新登录，当前输入仍保留。" : `${ui.pageStale ? "保留之前内容；" : ""}读取失败：${ui.pageError}`,
      ui.authRequired ? h("a", {class:"btn small",href:location.href,target:"_blank",rel:"noopener"},"重新登录") : null,
      h("button", {class:"btn small",onclick:()=>refresh({main:true,force:true})},ui.authRequired ? "已登录，重试" : "重试读取"))
    : loading ? h("span", { class: "page-status page-status-inline", role: "status", title: label }, h("span", { class: "sr-only" }, label)) : null;
  // 同一种提示还在就不动它，免得每次局部重绘都重播入场动画
  const same = old && next && old.className === next.className && old.textContent === next.textContent && old.getAttribute("aria-label") === next.getAttribute("aria-label") && old.title === next.title;
  if (same) return;
  if (old && next) old.replaceWith(next);
  else if (old) old.remove();
  else if (next) {
    // 读取中转圈跟在页标题后面；没有标题的页面才退回内容区顶部，仍然不占一整行
    const heading = document.querySelector("#rt-mobile-header h1") || main.querySelector("h1");
    if (loading && heading) heading.append(next);
    else if (loading) { next.classList.add("page-status-top"); main.prepend(next); }
    else main.prepend(next);
  }
}

/* -------------------------------- 动作 -------------------------------- */

// v2.5 F08.3：操作结果写入读屏播报区（不抢焦点）
function announce(text) {
  const el = document.getElementById("live-status");
  if (!el) return;
  el.textContent = "";
  setTimeout(() => { el.textContent = text; }, 50);
}

/* -------------------------------- 启动 -------------------------------- */

/*
 * 部署切换的计划内交接：旧进程关停前，实时流先收到一条 handoff（带服务端随机出的 retryMs），
 * 浏览器随后按这个间隔自动重连。这段时间的断开不是故障：不弹「连接中断」，重连成功后核对一次。
 * 窗口 = retryMs + 6 秒；超过窗口还没连上，就按普通断线处理。
 */
function liveHandoffNote(event) {
  let retryMs = 0;
  try { retryMs = Number(JSON.parse(event?.data || "{}").retryMs) || 0; } catch { /* 没带间隔：用基础窗口 */ }
  window.piLiveHandoffUntil = Date.now() + Math.min(10_000, Math.max(0, retryMs)) + 6000;
}
function liveHandoffActive() { return Date.now() < (window.piLiveHandoffUntil || 0); }

/*
 * 主实时流。手机把 PWA 放到后台后，系统会冻结页面并掐断连接，这里负责回到前台后尽快恢复：
 * - 回到前台 / pageshow / 网络恢复时，连接不健康就立刻重建，不等浏览器自己的重试节奏；
 * - 浏览器放弃重连（readyState 变成 CLOSED：502、网络不可达、登录过期）后自己按退避重试；
 * - 服务端每 15 秒发一次 ping，超过 35 秒什么都没收到就当作假活连接重建。
 */
/*
 * 主实时流。手机把 PWA 放到后台后，系统会冻结页面并掐断连接，这里负责回到前台后尽快恢复：
 * - 回到前台 / pageshow / 网络恢复时，连接不健康就立刻重建，不等浏览器自己的重试节奏；
 * - 浏览器放弃重连（readyState 变成 CLOSED：502、网络不可达、登录过期）后自己按退避重试；
 * - 服务端每 15 秒发一次 ping，超过 35 秒什么都没收到就当作假活连接重建。
 *
 * 同一条流也承载运行时会话订阅（session-sync 通过 window.piLiveClaim 注册 watch 参数和
 * 事件挂载函数），页面级通知与同步通知不再各开一条 SSE：HTTP/1.1 同源只有 6 条连接。
 */
function connect() {
  const liveLink = { params: "", attach: null, es: null };
  const liveLinkUrl = () => (liveLink.params ? `/api/runtime/stream?${liveLink.params}` : "/api/stream");
  const STREAM_STALE_MS = 35_000;
  const conn = document.getElementById("conn");
  const text = conn.querySelector(".conn-text");
  const detail = document.getElementById("conn-detail");
  // 说明文字单独一个节点：弹层里还有原生壳（Android）放进来的「网络」一行，不能被整块 textContent 覆盖。
  const detailText = document.getElementById("conn-detail-text") ?? detail;
  const setStatus = (state, label, explanation) => {
    conn.classList.toggle("live", state === "live");
    conn.classList.toggle("reconnecting", state === "reconnecting");
    conn.classList.toggle("connecting", state === "connecting");
    text.textContent = label;
    const menuStatus = document.querySelector('.nav-connection-status');
    if (menuStatus) menuStatus.textContent = label;
    conn.title = label;
    conn.setAttribute("aria-label", conn.disabled ? label : `${label}，查看连接说明`);
    detailText.textContent = explanation;
  };
  setStatus("connecting", "连接中…", "连接中：正在建立实时连接。");
  detail.addEventListener("beforetoggle", event => {
    conn.setAttribute("aria-expanded", String(event.newState === "open"));
    if (event.newState === "open") {
      document.getElementById("nav-more").hidden = true;
      if (typeof syncNavMore === "function") syncNavMore();
    }
  });
  let es = null, lastSeen = 0, retryTimer = null, retryDelay = 1000, loggedOut = false, closedProbe = null;
  let handoffReconcile = false, handoffTimer = null;
  const visible = () => document.visibilityState !== "hidden";
  const requireLogin = () => {
    closedProbe?.controller.abort(); closedProbe = null;
    loggedOut = true; clearTimeout(retryTimer); retryTimer = null; conn.dataset.lost = "1";
    es?.close?.();
    setStatus("reconnecting", "需要重新登录", "登录已失效；在新标签页重新登录后，回到此页恢复连接，当前输入仍保留。");
  };
  document.addEventListener("gui-auth-required", requireLogin);
  document.addEventListener("gui-auth-restored", () => { if (loggedOut) { loggedOut = false; open(); } });
  const markLost = () => {
    if (!conn.dataset.lost) announce("实时连接中断，正在重连；已输入的内容不会丢");
    conn.dataset.lost = "1";
    setStatus("reconnecting", "连接中断，重连中…", "实时连接中断，正在自动重连；已输入的内容不会丢失。");
  };
  /*
   * 断线恢复后的核对只做一次。回前台、浏览器的自动重连和这里的退避可能在同一两秒内
   * 各触发一次 open；如果每次都 invalidateReads + force refresh，手机会同时重读目录、
   * 会话和待办页。这里用单飞 + 短冷却合并成一次；首次连接不核对。
   */
  let reconnectReconcile = null, reconciledAt = 0;
  const reconcileAfterReconnect = () => {
    if (reconnectReconcile) return reconnectReconcile;
    if (Date.now() - reconciledAt < 1500) return null;
    reconciledAt = Date.now();
    reconnectReconcile = (async () => {
      invalidateReads();
      try { await refresh({ main: true, force: true }); } catch { /* 页面自己会显示读取错误 */ }
    })().finally(() => { reconnectReconcile = null; });
    return reconnectReconcile;
  };
  const open = () => {
    closedProbe?.controller.abort(); closedProbe = null;
    clearTimeout(retryTimer); retryTimer = null;
    es?.close?.();
    const stream = es = new EventSource(liveLinkUrl());
    try {window.piTelemetry?.trackStream?.(stream);} catch {}
    liveLink.es = stream;
    lastSeen = Date.now();
    const seen = () => { if (stream === es) lastSeen = Date.now(); };
    stream.addEventListener("open", () => {
      if (stream !== es || loggedOut) return;
      seen(); retryDelay = 1000;
      clearTimeout(handoffTimer); handoffTimer = null;
      const reconnecting = !!conn.dataset.lost || handoffReconcile;
      handoffReconcile = false;
      if (reconnecting) announce("实时连接已恢复");
      delete conn.dataset.lost;
      setStatus("live", "实时连接", "实时连接正常：页面会自动接收最新状态。");
      // 首次打开由 route() 加载；只有真断过才重新核对，避免启动时拉取两轮。
      // 多次 open 在冷却窗口内只核对一次，不再让目录 / 会话 / 待办各自重读。
      if (reconnecting) void reconcileAfterReconnect();
    });
    stream.addEventListener("ping", seen);
    stream.addEventListener("handoff", liveHandoffNote);
    stream.addEventListener("update", event => { if (stream !== es || loggedOut) return; seen(); onServerUpdate(event); });
    // session-sync 把 sync-notice / ready / directory / profiles 挂到同一条流上。
    try { liveLink.attach?.(stream, () => stream === es); } catch { /* 挂载失败不能拖垮连接状态 */ }
    stream.addEventListener("error", () => {
      if (stream !== es || loggedOut) return;
      // 计划内交接且浏览器正按服务端给的间隔自己重连：保持安静；超过窗口还没连上才算断线。
      if (liveHandoffActive() && stream.readyState === 0) {
        handoffReconcile = true;
        clearTimeout(handoffTimer);
        handoffTimer = setTimeout(() => { handoffTimer = null; if (stream === es && !loggedOut && stream.readyState !== 1) markLost(); }, Math.max(0, (window.piLiveHandoffUntil || 0) - Date.now()) + 50);
        return;
      }
      markLost();
      // CONNECTING 表示浏览器还在自己重试；CLOSED 表示它放弃了，只能由我们新建。
      if (stream.readyState === 2) void retryClosed(stream);
    });
  };
  const retryClosed = async stream => {
    if (retryTimer || closedProbe || loggedOut || !visible() || navigator.onLine === false) return;
    // 独立于读取队列，避免探测排在卡住的业务读取后面。每条流只有一次有界探测。
    const probe = closedProbe = { controller: new AbortController() };
    let deadline;
    try {
      const res = await Promise.race([
        fetch("/api/auth/sessions", { cache: "no-store", credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" }, signal: probe.controller.signal }),
        new Promise((_, reject) => { deadline = setTimeout(() => { probe.controller.abort(); reject(new Error("probe timeout")); }, 8000); })
      ]);
      // 切网/回前台可能已替换了流；旧连接的迟到 401 不能影响新连接。
      if (stream !== es || closedProbe !== probe || loggedOut) return;
      if (res.status === 401) {
        if (typeof noteGuiAuthFailure === "function") noteGuiAuthFailure("/api/auth/sessions（实时连接）");
        else window.sessionNotifications?.noteAuthFailure?.("/api/auth/sessions（实时连接）");
        requireLogin();
        return;
      }
    } catch {} finally { clearTimeout(deadline); }
    if (stream !== es || closedProbe !== probe || loggedOut) return;
    closedProbe = null;
    retryTimer = setTimeout(() => { retryTimer = null; if (visible() && navigator.onLine !== false) open(); }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30_000);
  };
  // 回到前台时核对：已关闭或长时间没消息就立刻重建（并把圆点先标成重连中，恢复后会重新拉取）。
  let loginProbe = false;
  const revive = () => {
    if (!visible() || !es) return;
    if (loggedOut) {
      if (loginProbe) return;
      loginProbe = true;
      const authEpoch = typeof guiAuthEpoch === "undefined" ? null : guiAuthEpoch;
      void fetch("/api/auth/sessions", { cache: "no-store", credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" }, signal: AbortSignal.timeout(10000) })
        .then(res => {
          if (!res.ok || (typeof guiAuthEpoch !== "undefined" && authEpoch !== guiAuthEpoch)) return;
          if (typeof noteGuiAuthRestored === "function") noteGuiAuthRestored(authEpoch);
          if (loggedOut) { loggedOut = false; open(); }
        }).catch(() => {}).finally(() => { loginProbe = false; });
      return;
    }
    const stale = Date.now() - lastSeen > STREAM_STALE_MS;
    if (es.readyState !== 2 && !stale) return;
    if (stale && es.readyState === 1) markLost();
    open();
  };
  document.addEventListener("visibilitychange", revive);
  window.addEventListener("pi-native-resume", revive);
  window.addEventListener("pageshow", revive);
  window.addEventListener("online", revive);
  window.addEventListener("focus", revive);
  setInterval(revive, 10_000);
  /*
   * 会话订阅（session-sync）把 watch 参数注册到这条流上。
   * 返回是否改变了连接参数：调用方不需要自己重建。
   */
  window.piLiveClaim = (params, attach) => {
    params = params || "";
    const changed = liveLink.params !== params || liveLink.attach !== attach;
    liveLink.params = params; liveLink.attach = attach;
    if (changed && liveLink.es) open();
    return changed;
  };
  window.piLiveRelease = (attach) => {
    if (attach && liveLink.attach !== attach) return;
    if (!liveLink.params && !liveLink.attach) return;
    liveLink.params = ""; liveLink.attach = null;
    if (liveLink.es) open();
  };
  window.piLiveStreamUrl = liveLinkUrl;
  open();
}

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  // PC 恢复对话应用上次页面；手机一级入口始终进入应用主页。
  if (t.dataset.view === "rt" && typeof rtMarkDetailEntry === "function") rtMarkDetailEntry("nav");
  location.hash = t.dataset.view === "rt" && !rtPhone.matches
    ? (ui.rt?.lastChatHash || (ui.rt && ui.rt.id ? `#/rt/${ui.rt.id}` : "#/rt"))
    : `#/${t.dataset.view}`;
}));
// 「更多」：默认收起；收起时若当前页在里面，按钮本身高亮，让人知道在哪
function syncNavMore() {
  const btn = document.getElementById("nav-more-btn"), box = document.getElementById("nav-more");
  if (!btn || !box) return;
  btn.setAttribute("aria-expanded", String(!box.hidden));
  btn.classList.toggle("active", box.hidden && !!box.querySelector(".tab.active"));
}
document.getElementById("nav-more-btn")?.addEventListener("click", () => {
  const box = document.getElementById("nav-more");
  box.hidden = !box.hidden;
  syncNavMore();
});
window.addEventListener("hashchange", route);

// Deferred code finishes before DOMContentLoaded, so that is the earliest moment every module the
// console needs is defined. `load` covers a script that was added after that event already fired.
let consoleStarted = false;
function startConsole() {
  if (consoleStarted) return;
  consoleStarted = true;
  restoreLaunchRoute();
  connect(); route();
}
if (document.readyState === "complete") startConsole();
else {
  document.addEventListener("DOMContentLoaded", startConsole, { once: true });
  window.addEventListener("load", startConsole, { once: true });
}

/* 顶栏换行后的实际高度写进 --topbar-h，主体从实际底边开始。
   除了 resize 事件，每次重绘也核对一次（有的环境不派发这些事件）。 */
function syncViewport() {
  const bar = document.querySelector(".topbar");
  // 宽于手机时导航是左侧竖栏（宽度见 --rail-w），上方不占高度；手机宽度仍是顶栏
  const rail = window.matchMedia("(min-width: 701px)").matches && !document.body.classList.contains("primary-phone");
  if (bar) document.documentElement.style.setProperty("--topbar-h", rail ? "0px" : `${Math.ceil(bar.getBoundingClientRect().height)}px`);
}
syncViewport();
if (window.ResizeObserver) new ResizeObserver(() => syncViewport()).observe(document.querySelector(".topbar"));
window.addEventListener("resize", syncViewport);
