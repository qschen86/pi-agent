"use strict";
/*
 * 会话应用收在上方、人正停在别的一级应用里时，有会话来了新的未读消息：在当前页顶栏上方浮出一颗类灵动岛的胶囊。
 *   · 新消息到达时先展开几秒（头像 + 会话名 + 状态），之后收成一颗小胶囊，一直留在那里，不会自己消失；
 *   · 点它 = 会话层落下进入会话应用（session-drawer.js）；进入会话应用就算看过，胶囊随之收走；
 *   · 在别处已读（跨设备已读同步）或会话被归档，对应条目自动撤掉；
 *   · 只提醒这次打开页面之后才出现的新未读：启动时已有的历史未读不弹，免得一开就是一串。
 * 数据来自 runtime.js 的未读目录（rtRenderNavStatus 每次刷新后调用 piSessionIsland.sync）。
 */
(function () {
  if (window.piSessionIsland) return;
  const EXPAND_MS = 3600;
  const known = new Map();   // 会话 id → 本页见过的最后已结束轮次
  const fresh = new Map();   // 悬浮提醒里的会话 id → 展示用信息
  let ready = false, el = null, collapseTimer = 0, signature = "", announced = "";

  const phoneHome = () => {
    const b = document.body;
    return b.classList.contains("nav-bottom") && !b.classList.contains("rt-phone-list") && !b.classList.contains("settings-mode") && !b.classList.contains("stats-mode");
  };
  const inSession = () => /^#\/rt(?:\/|$)/.test(location.hash);
  const STATUS_TEXT = { "waiting-input": "等待你处理", failed: "运行失败", interrupted: "被中断" };

  function sync(entries) {
    const present = new Set();
    for (const e of entries) {
      present.add(e.id);
      const ended = rtLastEndedTurn(e), unread = rtUnreadTurns(e);
      if (!ready) { known.set(e.id, ended); continue; }
      const prev = known.get(e.id) ?? 0;
      if (ended > prev) known.set(e.id, ended);
      if (unread <= 0) { fresh.delete(e.id); continue; }
      if (ended > prev || fresh.has(e.id)) {
        fresh.set(e.id, { id: e.id, title: e.title || "新会话", kind: e.runtimeKind, model: e.model, status: e.status, ended, unread });
      }
    }
    for (const id of fresh.keys()) if (!present.has(id)) fresh.delete(id);
    ready = true;
    render();
  }

  function build(list) {
    const latest = list[list.length - 1];
    const single = list.length === 1;
    const node = document.createElement("button");
    node.type = "button"; node.id = "session-island"; node.className = "session-island";
    const avatar = document.createElement("span");
    avatar.className = "session-island-avatar";
    avatar.append(rtAvatar(latest.kind, latest.model, "sm"));
    const text = document.createElement("span");
    text.className = "session-island-text";
    const title = document.createElement("b");
    title.textContent = single ? latest.title : `${list.length} 个会话有新消息`;
    const sub = document.createElement("span");
    sub.textContent = single ? (STATUS_TEXT[latest.status] || "有新回复") : `最新：${latest.title}`;
    text.append(title, sub);
    const tag = document.createElement("span");
    tag.className = "session-island-tag";
    tag.textContent = single ? "新回复" : `${list.length} 个新消息`;
    node.append(avatar, text, tag);
    node.setAttribute("aria-label", single ? `${latest.title}：${sub.textContent}，点按进入会话` : `${list.length} 个会话有新消息，点按进入会话`);
    node.addEventListener("click", () => {
      if (!window.piSessionDrawer?.enter()) location.hash = "#/rt";
    });
    return node;
  }

  function hide() {
    clearTimeout(collapseTimer); collapseTimer = 0;
    signature = "";
    const node = el; el = null;
    if (!node) return;
    node.classList.add("leaving");
    const done = () => node.remove();
    node.addEventListener("animationend", done, { once: true });
    setTimeout(done, 400);
  }

  function render() {
    if (inSession()) fresh.clear();
    const list = [...fresh.values()];
    if (!list.length) announced = "";
    if (!list.length || !phoneHome() || document.hidden) { if (el) hide(); return; }
    const sig = list.map((x) => `${x.id}:${x.ended}`).join("|");
    // 内容没变：保持当前的展开 / 收起状态，不重建
    if (el?.isConnected && sig === signature) return;
    signature = sig;
    // 只有真正有新消息到达才展开；切页后重新浮出、回前台只以小胶囊出现
    const isNew = sig !== announced;
    announced = sig;
    const node = build(list), reuse = !!el?.isConnected;
    if (reuse) el.replaceWith(node); else document.body.append(node);
    el = node;
    node.classList.add(isNew ? "expanded" : "compact");
    if (!reuse) node.classList.add("entering");
    clearTimeout(collapseTimer); collapseTimer = 0;
    if (isNew) collapseTimer = setTimeout(() => { node.classList.remove("expanded"); node.classList.add("compact"); }, EXPAND_MS);
  }

  // 页面切换（body 上的 nav-bottom / rt-phone-list 等类）、回前台、路由变化后重新判断该不该显示
  new MutationObserver(render).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("hashchange", render);
  document.addEventListener("visibilitychange", render);

  window.piSessionIsland = { sync, render, count: () => fresh.size };
})();
