"use strict";
/*
 * 顶部光韵：会话（智力球）收在屏幕上方，人停在别的一级应用里时，顶边常驻一团智力球颜色的光，告诉人「球在上面，点按或下拉进入」。
 *   · 平时（calm）：冷色（青 / 紫 / 洋红）的光沿顶边缓慢流动、呼吸，不画任何形体，不遮页头内容；顶部正中光晕核心常驻透明可点热区，点按直接进入会话，按住往下拉照常触发下拉手势；
 *   · 有会话未读 / 待处理（unread）：光变暖变高，像心跳一样跳动；最新那个会话的 logo 从屏幕顶边里面冒出来、跳两下、再缩回去，
 *     隔几秒重复一次（多个会话时 logo 旁带数量）；logo 缩回去时不占位，点光晕核心同样进入会话；
 *   · 有会话在等人处理 / 失败 / 被中断 / 有待审批（urgent）：偏琥珀红，跳得更快；
 *   · 这次打开页面之后新到的消息：光先猛地一亮（burst），logo 立刻冒出来跳两下；点光晕或冒出来的 logo = 进入会话（下拉同样进入）；
 *   · 进入会话列表就算看过，光恢复平静；同一条未读不会因为回到应用再次提醒，新到一轮才再亮；
 *   · 在别处已读（跨设备已读同步）或会话被归档，对应条目自动撤掉。
 * 会话列表中，同一团光停在底栏后方；上推退出时从底栏升回顶部，取消手势则回到原位。
 * 下拉手势本身在 session-drawer.js：拖动时光韵让位给帘子下沿的流光。数据来自 runtime.js 的未读目录（rtRenderNavStatus 刷新后调用 piSessionIsland.sync）。
 * 文件名沿用旧的「灵动岛胶囊」，对外接口 piSessionIsland 不变。
 */
(function () {
  if (window.piSessionIsland) return;
  const BURST_MS = 1500;
  const POP_MS = 2800;        // logo 冒出来 → 跳两下 → 缩回去 的一轮时长（与 CSS 的 session-halo-pop 一致）
  const POP_EVERY = 7000;     // 有未读期间每隔多久再冒一次
  const FLIGHT_MS = 340;      // 智能球光印跨屏迁移（底 ↔ 顶）的默认时长
  const HANDOFF_MS = 150;     // 抵达终点后与静态光晕交棒淡出的时长
  const OVERLAYS = "dialog[open], .rt-lightbox, .image-zoom, #nav-more:not([hidden]), body.notes-sheet-open";
  const known = new Map();    // 会话 id → 本页见过的最后已结束轮次
  const unseen = new Map();   // 还没在会话列表里看过的未读 / 待处理：会话 id → 展示用信息
  const seen = new Map();     // 在会话列表里看过的：会话 id → 看过时的状态键，键不变就不再提醒
  const URGENT = { "waiting-input": "等待你处理", failed: "运行失败", interrupted: "被中断" };
  const root = document.documentElement;
  const reduced = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  let ready = false, el = null, hit = null, logo = null, flightEl = null, burstTimer = 0, popEnd = 0, popCycle = 0, signature = "", announced = "";
  let wasSessionList = null;

  const phoneHome = () => {
    const b = document.body;
    return b.classList.contains("nav-bottom") && !b.classList.contains("rt-phone-list") && !b.classList.contains("settings-mode") && !b.classList.contains("stats-mode");
  };
  const phoneSessionList = () => {
    const b = document.body;
    return b.classList.contains("nav-bottom") && b.classList.contains("rt-phone-list") && !b.classList.contains("settings-mode") && !b.classList.contains("stats-mode");
  };
  const inSession = () => /^#\/rt(?:\/|$)/.test(location.hash);

  /* ---------------- 智能球光印迁移动画（底边光晕 ↔ 顶边光韵） ---------------- */
  const flight = { active: false, kind: "", phase: "idle", y: 0, arrived: false, pageReady: false, arriveTimer: 0, handoffTimer: 0, fallbackTimer: 0 };
  // Android 全屏时原位光韵整体下移了一个状态栏高度（见 styles.css 的 data-android-edge 规则），
  // 迁移终点跟着一起走，否则光印会落在状态栏里、和原位光晕接不上。
  const safeTop = () => {
    const v = parseFloat(getComputedStyle(root).getPropertyValue("--android-safe-top"));
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  const topAnchorY = () => -24 + safeTop();
  // 迁移层高 68px，光心落在屏幕底边，和底部常驻光晕交接；不跟随底栏悬浮间距。
  const bottomAnchorY = () => Math.max(0, (window.innerHeight || 812) - 34);
  const startAnchorY = (kind) => (kind === "exit" ? bottomAnchorY() : topAnchorY());
  const endAnchorY = (kind) => (kind === "exit" ? topAnchorY() : bottomAnchorY());

  function ensureFlight() {
    if (flightEl) return flightEl;
    flightEl = document.createElement("div");
    flightEl.id = "session-glow-flight";
    flightEl.className = "session-glow-flight";
    flightEl.setAttribute("aria-hidden", "true");
    flightEl.hidden = true;
    flightEl.innerHTML = '<i class="session-glow-flight-g"></i><i class="session-glow-flight-g2"></i>';
    document.body.append(flightEl);
    return flightEl;
  }

  function clearFlightTimers() {
    clearTimeout(flight.arriveTimer); flight.arriveTimer = 0;
    clearTimeout(flight.handoffTimer); flight.handoffTimer = 0;
    clearTimeout(flight.fallbackTimer); flight.fallbackTimer = 0;
  }

  function applyFlight(node, y, sx, sy, opacity) {
    flight.y = Math.round(y);
    node.style.setProperty("--flight-y", `${Math.round(y)}px`);
    node.style.setProperty("--flight-sx", String(sx));
    node.style.setProperty("--flight-sy", String(sy));
    node.style.setProperty("--flight-o", String(opacity));
  }

  function resetFlight() {
    clearFlightTimers();
    flight.active = false;
    flight.kind = "";
    flight.phase = "idle";
    flight.arrived = false;
    flight.pageReady = false;
    root.classList.remove("session-glow-flying");
    if (flightEl) {
      flightEl.hidden = true;
      flightEl.style.transition = "";
      delete flightEl.dataset.kind;
      delete flightEl.dataset.phase;
    }
  }

  function handoffFlight() {
    if (!flight.active || flight.phase === "handoff") return;
    clearFlightTimers();
    flight.phase = "handoff";
    const node = ensureFlight();
    node.dataset.phase = "handoff";
    // 先释放原位光晕（.session-halo），再淡出迁移层，确保零闪烁交棒
    root.classList.remove("session-glow-flying");
    node.style.transition = `opacity ${HANDOFF_MS}ms ease-out`;
    requestAnimationFrame(() => {
      if (!flight.active || flight.phase !== "handoff") return;
      node.style.setProperty("--flight-o", "0");
    });
    flight.handoffTimer = setTimeout(resetFlight, HANDOFF_MS + 30);
  }

  function flightStart(kind) {
    if (reduced() || (kind !== "enter" && kind !== "exit")) return false;
    clearFlightTimers();
    const node = ensureFlight();
    flight.active = true;
    flight.kind = kind;
    flight.phase = "drag";
    flight.arrived = false;
    flight.pageReady = false;
    node.dataset.kind = kind;
    node.dataset.phase = "drag";
    node.style.transition = "none";
    applyFlight(node, startAnchorY(kind), 1, 1, 1);
    node.hidden = false;
    root.classList.add("session-glow-flying");
    return true;
  }

  function flightMove(kind, offset, isReady) {
    if (!flight.active || flight.kind !== kind || reduced()) return;
    const node = ensureFlight();
    const dist = Math.max(0, Number(offset) || 0);
    const progress = Math.min(1, dist / 72);
    const y = kind === "exit" ? bottomAnchorY() - dist : topAnchorY() + dist;
    flight.phase = isReady ? "ready" : "drag";
    node.dataset.phase = flight.phase;
    node.style.transition = "none";
    applyFlight(node, y, 1 + progress * 0.06, isReady ? 1.32 : 1 + progress * 0.2, 0.92 + progress * 0.08);
  }

  function flightCancel(kind, ms = 200) {
    if (!flight.active || (kind && flight.kind !== kind)) return;
    if (reduced()) { resetFlight(); return; }
    clearFlightTimers();
    const node = ensureFlight();
    flight.phase = "cancel";
    node.dataset.phase = "cancel";
    node.style.transition = `transform ${ms}ms ease-out, opacity ${ms}ms ease-out`;
    applyFlight(node, startAnchorY(flight.kind), 1, 1, 0.92);
    flight.arriveTimer = setTimeout(handoffFlight, ms);
  }

  function flightCommit(kind, ms = FLIGHT_MS) {
    if (reduced() || (kind !== "enter" && kind !== "exit")) { resetFlight(); return false; }
    if (!flight.active || flight.kind !== kind) flightStart(kind);
    clearFlightTimers();
    const node = ensureFlight();
    // 强制提交起点样式，保证点击直接触发（未经过拖动）也从起点平滑滑到终点
    void node.offsetWidth;
    flight.phase = "flying";
    flight.arrived = false;
    node.dataset.phase = "flying";
    node.style.transition = `transform ${ms}ms cubic-bezier(.22, .86, .3, 1), opacity ${Math.min(180, ms)}ms ease`;
    applyFlight(node, endAnchorY(kind), 1.02, 1.08, 0.96);
    flight.arriveTimer = setTimeout(() => {
      flight.arriveTimer = 0;
      flight.arrived = true;
      if (flight.pageReady) handoffFlight();
    }, ms);
    flight.fallbackTimer = setTimeout(handoffFlight, ms + 220);
    return true;
  }

  function flightFinish() {
    if (!flight.active) return;
    flight.pageReady = true;
    if (flight.arrived) handoffFlight();
  }

  function flightAuto(kind) {
    if (reduced() || document.hidden) return false;
    if (!flightStart(kind)) return false;
    flightCommit(kind, FLIGHT_MS);
    flightFinish();
    return true;
  }

  function markSeen() { for (const [id, x] of unseen) seen.set(id, x.key); unseen.clear(); }

  function sync(entries) {
    const present = new Set();
    for (const e of entries) {
      present.add(e.id);
      const ended = rtLastEndedTurn(e), unread = rtUnreadTurns(e), approvals = e.pendingApprovals || 0;
      if (!ready) known.set(e.id, ended);
      const prev = known.get(e.id) ?? 0;
      if (ended > prev) known.set(e.id, ended);
      if (unread <= 0 && approvals <= 0) { unseen.delete(e.id); seen.delete(e.id); continue; }
      const key = `${ended}:${approvals}`;
      if (seen.get(e.id) === key) { unseen.delete(e.id); continue; }
      const old = unseen.get(e.id);
      const arrived = ready && (ended > prev || (!old && approvals > 0));
      unseen.set(e.id, { id: e.id, key, title: e.title || "新会话", kind: e.runtimeKind, model: e.model, status: e.status, approvals, urgent: approvals > 0 || !!URGENT[e.status], fresh: !!old?.fresh || arrived });
    }
    for (const id of [...unseen.keys()]) if (!present.has(id)) unseen.delete(id);
    ready = true;
    render();
  }

  function enterSession() {
    if (document.querySelector(OVERLAYS)) return;
    const drawer = window.piSessionDrawer;
    if (drawer) drawer.enter(); else location.hash = "#/rt";
  }

  function ensure() {
    if (el) return el;
    el = document.createElement("div");
    el.id = "session-halo"; el.className = "session-halo off"; el.dataset.state = "calm";
    el.innerHTML = '<i class="session-halo-g" aria-hidden="true"></i><i class="session-halo-g2" aria-hidden="true"></i>';
    hit = document.createElement("button");
    hit.type = "button"; hit.className = "session-halo-hit";
    hit.setAttribute("aria-label", "进入会话");
    hit.addEventListener("click", enterSession);
    el.append(hit);
    document.body.append(el);
    return el;
  }

  /** 光里的 logo：优先等人处理的，其次本页新到的，最后是最新的一个 */
  function pick(list) {
    const urgent = list.filter((x) => x.urgent), fresh = list.filter((x) => x.fresh);
    const pool = urgent.length ? urgent : fresh.length ? fresh : list;
    return pool[pool.length - 1];
  }

  function summaryLabel(list) {
    if (!list.length) return "进入会话";
    const lead = pick(list);
    const what = lead.urgent ? (URGENT[lead.status] || "有待审批") : "有新回复";
    return list.length === 1 ? `${lead.title}：${what}，点按进入会话` : `${list.length} 个会话有新消息，最新：${lead.title}，点按进入会话`;
  }

  function buildLogo(list, label) {
    const lead = pick(list);
    const node = document.createElement("button");
    node.type = "button"; node.className = "session-halo-logo";
    const face = document.createElement("span");
    face.className = "session-halo-face";
    face.append(rtAvatar(lead.kind, lead.model, "sm"));
    node.append(face);
    if (list.length > 1) {
      const n = document.createElement("span");
      n.className = "session-halo-count"; n.textContent = list.length > 99 ? "99+" : String(list.length);
      node.append(n);
    }
    node.setAttribute("aria-label", label);
    node.addEventListener("click", enterSession);
    return node;
  }

  /** logo 从顶边里冒出来跳两下再缩回去；冒出来的这段时间才可点 */
  function pop() {
    if (!logo || document.hidden) return;
    logo.classList.remove("pop"); void logo.offsetWidth; logo.classList.add("pop");
    const node = logo;
    clearTimeout(popEnd); popEnd = setTimeout(() => node.classList.remove("pop"), POP_MS);
  }

  function dropLogo() {
    if (logo) { logo.remove(); logo = null; }
    signature = "";
    clearTimeout(popEnd); clearInterval(popCycle); popCycle = 0;
  }

  function render() {
    const nowList = phoneSessionList();
    const nowHome = phoneHome();
    if (wasSessionList !== null && nowList !== wasSessionList && (nowList || nowHome)) {
      if (!window.piSessionDrawer?.busy?.() && !flight.active && !reduced() && !document.hidden) {
        flightAuto(wasSessionList ? "exit" : "enter");
      }
    }
    if (nowList || nowHome) wasSessionList = nowList;
    else wasSessionList = null;
    if (inSession()) markSeen();
    const on = (nowList || (nowHome && !inSession())) && !document.hidden;
    if (!on && !el) return;
    const halo = ensure();
    halo.classList.toggle("at-bottom", nowList);
    halo.classList.toggle("off", !on);
    hit.hidden = nowList;
    hit.disabled = nowList;
    if (!on) { dropLogo(); hit?.setAttribute("aria-label", "进入会话"); return; }
    if (nowList) {
      halo.dataset.state = "calm";
      halo.classList.remove("burst");
      dropLogo();
      return;
    }
    const list = [...unseen.values()];
    const label = summaryLabel(list);
    hit?.setAttribute("aria-label", label);
    halo.dataset.state = !list.length ? "calm" : list.some((x) => x.urgent) ? "urgent" : "unread";
    if (!list.length) { announced = ""; dropLogo(); return; }
    const sig = list.map((x) => `${x.id}:${x.key}`).join("|");
    // 内容没变：保持现状，不重建
    if (logo?.isConnected && sig === signature) return;
    signature = sig;
    // 只有这次页面打开后真正新到的消息才猛亮一下；启动时已有的未读、切页后重新出现只是安静地跳动
    const freshSig = list.filter((x) => x.fresh).map((x) => `${x.id}:${x.key}`).join("|");
    const burst = !!freshSig && freshSig !== announced;
    if (freshSig) announced = freshSig;
    const node = buildLogo(list, label);
    if (logo?.isConnected) logo.replaceWith(node); else halo.append(node);
    logo = node;
    if (burst) {
      halo.classList.remove("burst"); void halo.offsetWidth; halo.classList.add("burst");
      clearTimeout(burstTimer); burstTimer = setTimeout(() => halo.classList.remove("burst"), BURST_MS);
    }
    // 新到的立刻冒出来；回到应用时稍等光出现后再冒；之后每隔一阵再冒一次
    setTimeout(pop, burst ? 0 : 600);
    clearInterval(popCycle); popCycle = setInterval(pop, POP_EVERY);
  }

  // 页面切换（body 上的 nav-bottom / rt-phone-list 等类）、回前台、路由变化后重新判断该不该显示
  new MutationObserver(render).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("hashchange", render);
  document.addEventListener("visibilitychange", render);

  window.piSessionIsland = {
    sync, render, pop,
    count: () => unseen.size,
    state: () => el?.dataset.state || "calm",
    flightStart, flightMove, flightCancel, flightCommit, flightFinish, flightAuto,
    flightState: () => ({ active: flight.active, kind: flight.kind, phase: flight.phase, y: flight.y, hidden: !flightEl || flightEl.hidden }),
  };
})();
