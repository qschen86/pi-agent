/* Push devices use one delivery path in both foreground and background. */
window.sessionNotifications = (() => {
  navigator.serviceWorker?.addEventListener?.("message", event => {
    if (event.data?.type !== "notification-route-desktop") return;
    let routed = false;
    const mobile = navigator.userAgentData?.mobile || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
      || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    try {
      const url = new URL(event.data.url, location.origin);
      if (!mobile && location.pathname === "/" && url.origin === location.origin && url.pathname === "/"
        && /^#\/rt(?:\/[A-Za-z0-9_-]+)?$/.test(url.hash)) {
        // Use the normal hash router so in-memory sessions, drafts and scroll
        // positions survive. Repeated clicks on the current session need no render.
        if (location.hash !== url.hash) location.hash = url.hash;
        routed = true;
      }
    } catch { /* invalid target: let the worker use its normal opening path */ }
    event.ports[0]?.postMessage({ routed });
  });
  function notificationEntry() {
    const url = new URL(location.href), id = url.searchParams.get("notification-session");
    if (!id || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) return;
    url.searchParams.delete("notification-session");
    url.hash = "#/rt";
    // Back from a notification-opened conversation always lands on the chat home,
    // including a cold launch or returning through login.
    history.replaceState(null, "", url);
    url.hash = `#/rt/${id}`;
    history.pushState(null, "", url);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }
  const native = window.piAndroidShell;
  let nativeState = { registered: false, permission: false };
  const storage = "pi-agent.notifications.v2";
  const defaults = { reply: true, completed: true, failed: true, approval: true, reminder: true, currentSession: false, preview: false };
  let settings = { enabled: false, mode: "push", preferences: { ...defaults } };
  const storedSettings = localStorage.getItem(storage);
  try { const saved = JSON.parse(storedSettings || "null"); if (saved) settings = { ...settings, ...saved, preferences: { ...defaults, ...saved.preferences } }; } catch { /* fresh device */ }
  // Diagnostics: why this device's bell went off, and recent 401s. Kept in its own key so
  // settings writes never drop it. A cookie mirrors "opted in": site-storage eviction clears
  // localStorage but not cookies, so cookie-without-settings means the browser wiped our data.
  const diagKey = "pi-agent.notifications.diag", optInCookie = "pi_notif_on";
  const OFF_REASONS = { user: "你手动关闭", logout: "点了退出登录", permission: "系统通知权限不是“允许”", "subscription-missing": "浏览器里的推送订阅没了", "enable-failed": "开启失败", "storage-cleared": "本机网站数据被清除，铃铛设置丢失" };
  const readDiag = () => { try { const d = JSON.parse(localStorage.getItem(diagKey) || "null"); return { offs: Array.isArray(d?.offs) ? d.offs : [], auth401: Array.isArray(d?.auth401) ? d.auth401 : [] }; } catch { return { offs: [], auth401: [] }; } };
  const writeDiag = update => { try { const d = readDiag(); update(d); d.offs = d.offs.slice(-5); d.auth401 = d.auth401.slice(-5); localStorage.setItem(diagKey, JSON.stringify(d)); } catch { /* storage full or blocked */ } };
  const optedInCookie = () => document.cookie.split("; ").includes(`${optInCookie}=1`);
  const setOptInCookie = on => { document.cookie = `${optInCookie}=${on ? "1; max-age=31536000" : "; max-age=0"}; path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`; };
  // A late recovery must never undo a newer explicit shutdown or logout.
  let intentRevision = 0, recoveryNeeded = !!settings.recoveryPending;
  function turnOff(reason, detail) {
    intentRevision++; recoveryNeeded = false; delete settings.recoveryPending;
    settings.enabled = false; save(); setOptInCookie(false);
    writeDiag(d => d.offs.push({ reason, at: Date.now(), ...(detail ? { detail: String(detail).slice(0, 160) } : {}) }));
  }
  function noteAuthFailure(path) { writeDiag(d => d.auth401.push({ at: Date.now(), path: String(path).split("?")[0].slice(0, 120) })); renderPanel(); }
  let status = settings.enabled ? "正在核对本设备通知…" : "通知未开启", busy = false, dialog, embeddedPanel, restoring, lastRestoreAt = 0;
  const client = crypto.randomUUID?.() ?? `page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const supported = () => !!native || isSecureContext && "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
  const enabled = () => native ? nativeState.registered === true && nativeState.permission === true : supported() && Notification.permission === "granted" && settings.enabled;
  const save = () => localStorage.setItem(storage, JSON.stringify(settings));
  if (storedSettings === null && optedInCookie()) turnOff("storage-cleared");
  async function registration() {
    const reg = await navigator.serviceWorker.register("/sw.js");
    let timer;
    try {
      await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("通知服务未就绪，请刷新后重试")), 10000); })]);
      const installing = reg.installing || reg.waiting;
      if (installing && installing.state !== "activated") await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("通知服务更新未完成，请刷新后重试")), 10000);
        installing.addEventListener("statechange", () => {
          if (installing.state === "activated" || installing.state === "redundant") {
            clearTimeout(timeout); installing.state === "activated" ? resolve() : reject(new Error("通知服务更新失败"));
          }
        });
      });
      return reg;
    } finally { clearTimeout(timer); }
  }
  async function workerSettings(reg) {
    const worker = reg.active || navigator.serviceWorker.controller;
    if (!worker) throw new Error("通知服务未就绪");
    await new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => { channel.port1.close(); reject(new Error("通知设置保存失败，请重试")); }, 5000);
      channel.port1.onmessage = e => { clearTimeout(timeout); channel.port1.close(); e.data?.ok ? resolve() : reject(new Error("浏览器无法保存通知设置")); };
      worker.postMessage({ type: "notification-settings", settings }, [channel.port2]);
    });
  }
  function keyBytes(key) {
    const s = atob(key.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(key.length / 4) * 4, "="));
    return Uint8Array.from(s, c => c.charCodeAt(0));
  }
  const currentSession = () => document.visibilityState === "visible" && document.hasFocus() ? (location.hash.match(/^#\/rt\/([A-Za-z0-9_-]{1,100})$/)?.[1] || "") : "";
  let presenceAt = 0, presenceSession = null, presenceFlight = null;
  async function presence() {
    if (!enabled() || !settings.id) return;
    // 回前台时 visibilitychange / focus / restore 常在同一秒各叫一次；同内容心跳 5 秒内只发一条。
    if (presenceFlight) return presenceFlight;
    // 心跳参数信任边界：client 必须是服务端接受的 8–80 个字母/数字/连字符（crypto.randomUUID 满足）；
    // 不合法时不发必然 400 的请求。
    if (!/^[A-Za-z0-9-]{8,80}$/.test(client)) return;
    const sessionId = currentSession();
    // 后台且已经没有前台标记时不发空心跳：服务端 45 秒后自行过期，少一次无谓的互斥竞争。
    if (!sessionId && !presenceSession) return;
    const now = Date.now();
    if (sessionId === presenceSession && now - presenceAt < 5000) return;
    presenceSession = sessionId; presenceAt = now;
    presenceFlight = api("/api/notifications/presence", { method: "POST", body: JSON.stringify({ id: settings.id, client, sessionId }) })
      .catch(() => { /* short-lived heartbeat expires */ })
      .finally(() => { presenceFlight = null; });
    return presenceFlight;
  }
  let readingTimer;
  function readingUpdated() { clearTimeout(readingTimer); readingTimer = setTimeout(() => void presence(), 80); }
  // 推送存储忙（503 + Retry-After）是部署互斥下的瞬时状态：最多短退避重试一次，
  // 并把 503 声明为 expectedStatuses，让它不落入 request_failed http_5xx 指纹。
  const DEVICE_RETRY_MS = 2000, DEVICE_RETRY_MAX_MS = 5000;
  async function deviceRequest(path, options = {}) {
    for (let attempt = 0; ; attempt++) {
      try { return await api(path, { ...options, expectedStatuses: [503] }); }
      catch (error) {
        if (error?.status !== 503 || attempt >= 1) throw error;
        const wait = Number(error.retryAfter) || DEVICE_RETRY_MS;
        await new Promise(resolve => setTimeout(resolve, Math.min(wait, DEVICE_RETRY_MAX_MS)));
      }
    }
  }
  async function subscribe(reg, revision = intentRevision) {
    const current = () => revision === intentRevision && Notification.permission === "granted";
    const caps = await api("/api/notifications/capabilities");
    if (!current()) return;
    if (!caps.supported || !caps.publicKey || !reg.pushManager) throw new Error("当前服务或浏览器未支持后台推送");
    const publicKey = keyBytes(caps.publicKey);
    let sub = await reg.pushManager.getSubscription();
    if (!current()) return;
    if (sub?.options.applicationServerKey) {
      const old = new Uint8Array(sub.options.applicationServerKey);
      if (old.length !== publicKey.length || !old.every((v, i) => publicKey[i] === v)) { await sub.unsubscribe(); sub = null; }
    }
    if (!current()) return;
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
    if (!current()) return;
    const result = await deviceRequest("/api/notifications/device", { method: "PUT", body: JSON.stringify({ subscription: sub.toJSON(), preferences: settings.preferences }) });
    if (!current()) return;
    if (!result.subscribed || !result.id || !result.binding) throw new Error("设备订阅未保存成功");
    settings = { ...settings, enabled: true, mode: "push", id: result.id, binding: result.binding };
    save(); setOptInCookie(true); await workerSettings(reg);
    if (!current()) return;
    await api("/api/notifications/activate", { method: "POST", body: JSON.stringify({ id: settings.id, binding: settings.binding }) });
    if (!current()) return;
    await presence();
    if (!current()) return;
    recoveryNeeded = false; delete settings.recoveryPending; save();
    status = "后台通知已开启，可在锁屏和关闭窗口后接收";
  }
  async function nativeOperation(method) {
    if (busy) return; busy = true; renderPanel();
    try { nativeState = await native.call(method); status = enabled() ? "Android 后台通知已开启" : nativeState.configured === false ? "此安装包未配置正式客户端推送" : method === "notifications.enable" ? (nativeState.permission === false ? "系统通知权限未允许，请到系统通知设置中授权。" : "通知尚未注册成功，请重试。") : "Android 通知未开启"; }
    catch (error) { status = error.message; }
    finally { busy = false; renderPanel(); refreshButton(); }
  }
  async function enable() {
    if (native) return nativeOperation("notifications.enable");
    if (busy) return;
    if (!supported()) { status = "当前浏览器不支持推送；iPhone 请从主屏幕应用打开"; renderPanel(); return; }
    const revision = ++intentRevision;
    busy = true; renderPanel();
    try {
      // Request directly from the click, before any network operation.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("通知权限未允许，请在系统或浏览器设置中开启");
      if (restoring) await restoring;
      await subscribe(await registration(), revision);
    } catch (error) { if (revision === intentRevision) { status = `开启失败：${error.message}`; turnOff("enable-failed", error.message); } }
    finally { busy = false; renderPanel(); refreshButton(); }
  }
  async function disable() {
    if (native) return nativeOperation("notifications.disable");
    if (busy) return; busy = true;
    turnOff("user"); renderPanel();
    try {
      const reg = await registration(); await workerSettings(reg);
      if (settings.id) await deviceRequest("/api/notifications/device", { method: "DELETE", body: JSON.stringify({ id: settings.id }) });
      await (await reg.pushManager?.getSubscription())?.unsubscribe();
      delete settings.id; delete settings.binding; save(); status = "通知已关闭";
      for (const n of await reg.getNotifications()) n.close();
    } catch { status = "本设备已关闭通知；取消订阅未确认，下次打开会重试"; }
    finally { busy = false; renderPanel(); refreshButton(); }
  }
  async function stopForLogout() {
    if (native) { nativeState = { registered: false, permission: false }; await native.call("session.logout").catch(() => {}); refreshButton(); return; }
    if (settings.enabled) turnOff("logout");
    else { intentRevision++; recoveryNeeded = false; setOptInCookie(false); }
    refreshButton();
    try {
      const reg = await navigator.serviceWorker?.getRegistration("/");
      if (reg?.active) { await workerSettings(reg); for (const n of await reg.getNotifications()) n.close(); }
    } catch { /* server revocation is authoritative; startup retries local cleanup */ }
  }
  async function restore() {
    if (native) return nativeOperation("notifications.status");
    if (busy) return;
    if (restoring) return restoring;
    restoring = (async () => {
      const revision = intentRevision;
      if (!supported()) return;
      try {
        const reg = await registration();
        if (revision !== intentRevision) return;
        if (!settings.enabled || Notification.permission !== "granted") {
          if (Notification.permission !== "granted") { if (settings.enabled) turnOff("permission", Notification.permission); status = "通知权限未允许，请重新开启"; }
          const cleanupRevision = intentRevision;
          await workerSettings(reg);
          if (cleanupRevision !== intentRevision) return;
          if (settings.id) { await deviceRequest("/api/notifications/device", { method: "DELETE", body: JSON.stringify({ id: settings.id }) }); if (cleanupRevision !== intentRevision) return; delete settings.id; delete settings.binding; save(); }
          renderPanel(); refreshButton(); return;
        }
        const sub = await reg.pushManager?.getSubscription();
        if (revision !== intentRevision) return;
        // The preference is still on: repair the subscription without asking for permission again.
        if (!sub || settings.recoveryPending) {
          // Keep this across reloads: a rebuilt browser subscription may still need its server PUT.
          settings.recoveryPending = true; save();
          await subscribe(reg, revision);
        }
        else {
          const result = await deviceRequest(`/api/notifications/device?id=${encodeURIComponent(settings.id || "")}`);
          if (revision !== intentRevision) return;
          if (!result.subscribed) await subscribe(reg, revision);
          else { settings.binding = result.binding; settings.preferences = result.preferences; save(); await workerSettings(reg);
            if (revision !== intentRevision) return;
            await api("/api/notifications/activate", { method: "POST", body: JSON.stringify({ id: settings.id, binding: settings.binding }) });
            if (revision !== intentRevision) return;
            recoveryNeeded = false;
            status = result.lastError ? `通知已开启；最近发送异常：${result.lastError}` : "后台通知已开启"; await presence(); }
        }
      } catch (error) {
        if (revision !== intentRevision) return;
        recoveryNeeded = enabled();
        status = recoveryNeeded ? `通知暂未恢复：${error.message}。请重试恢复通知` : `通知状态未确认：${error.message}`;
      }
      renderPanel(); refreshButton();
    })().finally(() => { restoring = null; lastRestoreAt = Date.now(); });
    return restoring;
  }
  async function change(key, value) {
    if (busy) return; busy = true;
    const revision = intentRevision;
    const previous = settings.preferences[key]; settings.preferences[key] = value; renderPanel();
    try {
      save();
      if (enabled()) await subscribe(await registration(), revision);
      else if (supported()) await workerSettings(await registration());
    } catch (error) { settings.preferences[key] = previous; save(); status = `设置未保存：${error.message}`; }
    finally { busy = false; renderPanel(); }
  }
  async function test() {
    if (busy) return; busy = true; renderPanel();
    try { await api("/api/notifications/test", { method: "POST", body: JSON.stringify({ id: settings.id }) }); status = "测试推送已提交，请确认系统通知栏是否收到"; }
    catch (error) { status = error.message; }
    finally { busy = false; renderPanel(); }
  }
  function refreshButton() {
    window.dispatchEvent(new Event("pi-capabilities-change"));
    const button = document.querySelector('[data-notification-button]');
    if (button) button.replaceWith(createButton());
  }
  function renderPanel() {
    window.dispatchEvent(new Event("pi-capabilities-change"));
    if (dialog?.open) drawPanel(dialog, true);
    if (embeddedPanel?.isConnected) drawPanel(embeddedPanel, false);
  }
  function notificationHeading(container, closable) {
    if (closable) return h("div", { class: "notification-heading" }, h("strong", {}, "本设备会话通知"), h("button", { type: "button", class: "btn small", onclick: () => dialog.close(), "aria-label": "关闭通知设置" }, "关闭"));
    const heading = container.querySelector('.settings-switch-row') || h('div', { class: 'notification-heading settings-switch-row' },
      h('strong', {}, '本设备会话通知'), h('input', { type: 'checkbox', role: 'switch', class: 'settings-switch', 'aria-label': '本设备会话通知', onchange: () => enabled() ? void disable() : void enable() }));
    const control = heading.querySelector('input'); control.checked = !!enabled(); control.disabled = busy || !supported();
    return heading;
  }
  function updatePanel(container, heading, ...children) {
    if (heading.parentNode === container) {
      while (container.children.length > 1) container.lastElementChild.remove();
      container.append(...children.filter(Boolean));
    } else container.replaceChildren(heading, ...children.filter(Boolean));
  }
  function notificationStatus(closable) {
    const routine = new Set(['通知未开启', '通知已关闭', 'Android 通知未开启', 'Android 后台通知已开启', '后台通知已开启', '后台通知已开启，可在锁屏和关闭窗口后接收']);
    const message = busy ? '正在处理…' : !supported() ? '当前浏览器不支持推送；iPhone 请从主屏幕应用打开' : status;
    return h('p', { role: 'status', class: 'notification-status', hidden: !closable && routine.has(message) }, message);
  }
  function drawPanel(container, closable) {
    if (native) {
      updatePanel(container, notificationHeading(container, closable),
        notificationStatus(closable),
        closable ? h("button", { type: "button", class: "btn primary", disabled: busy, onclick: () => enabled() ? disable() : enable() }, enabled() ? "关闭本设备通知" : "开启本设备通知") : null,
        h("button", { type: "button", class: "btn", disabled: busy, onclick: () => void nativeOperation("notifications.settings") }, "打开系统通知设置"),
        h("p", { class: "muted" }, "通过 Android 接收任务完成、失败和待审批提醒，不发送聊天正文。声音与震动后续测试；退出登录后停止推送。"));
      return;
    }
    const focused = document.activeElement?.getAttribute("data-notification-setting");
    updatePanel(container, notificationHeading(container, closable),
      notificationStatus(closable),
      closable ? h("button", { type: "button", class: "btn primary", disabled: busy, onclick: () => enabled() ? disable() : enable() }, enabled() ? "关闭本设备通知" : "开启本设备通知") : null,
      ...Object.entries({ reply: "助手消息生成完成", completed: "本轮完成", failed: "本轮失败", approval: "需要审批或人工处理", reminder: "日程提醒（提前多久见日程）", currentSession: "正在阅读的会话也提醒", preview: "在系统通知中显示消息摘要" }).map(([key, label]) =>
        h("label", { class: "notification-setting" }, h("span", {}, label), h("input", { type: "checkbox", class: "settings-switch sm", checked: settings.preferences[key], disabled: busy, "data-notification-setting": key, onchange: e => void change(key, e.target.checked) }))),
      h("p", { class: "muted" }, "助手消息生成完成指一条面向你的消息生成结束；本轮完成或失败指一次执行结束。默认只显示会话标题，最后一条消息与紧接着的本轮完成会合并提醒。退出登录后停止推送。"),
      recoveryNeeded ? h("button", { type: "button", class: "btn", disabled: busy, onclick: () => void restore() }, "重试恢复通知") : null,
      h("button", { type: "button", class: "btn", disabled: busy || !enabled() || recoveryNeeded, onclick: () => void test() }, "发送测试通知"),
      h("p", { class: "muted" }, "收不到测试通知时，请检查系统通知权限及网络。系统强制停止应用后可能无法接收。"),
      ...diagnostics()
    );
    if (focused) container.querySelector(`[data-notification-setting="${focused}"]`)?.focus();
  }
  function diagnostics() {
    const d = readDiag(), when = at => new Date(at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    if (!d.offs.length && !d.auth401.length) return [];
    return [h("div", { class: "notification-diagnostics muted", "data-notification-diagnostics": "" },
      h("strong", {}, "诊断记录"),
      ...d.offs.slice(-3).reverse().map(o => h("p", {}, `${when(o.at)} 关闭：${OFF_REASONS[o.reason] || o.reason}${o.detail ? `（${o.detail}）` : ""}`)),
      ...d.auth401.slice(-3).reverse().map(a => h("p", {}, `${when(a.at)} 登录失效（401）：${a.path}`)))];
  }
  function open() {
    if (!dialog) {
      dialog = h("dialog", { class: "notification-dialog", "aria-label": "本设备会话通知" });
      dialog.addEventListener("click", e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } });
      document.body.append(dialog);
    }
    if (!dialog.open) dialog.showModal(); renderPanel(); void restore();
  }
  function createButton() {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [key, value] of Object.entries({ width: "18", height: "18", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) icon.setAttribute(key, value);
    for (const d of ["M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4", ...(!enabled() ? ["M3 3l18 18"] : [])]) { const path = document.createElementNS(icon.namespaceURI, "path"); path.setAttribute("d", d); icon.append(path); }
    return h("button", { type: "button", class: "rt-icon-link", "data-notification-button": "", "aria-label": "通知设置", title: enabled() ? (recoveryNeeded ? "会话通知待恢复" : "会话通知已开启") : "开启会话通知", onclick: open }, icon);
  }
  window.addEventListener("load", () => { notificationEntry(); void restore(); });
  // 只由 visibilitychange 触发一次设备核对：focus 紧跟着到达时不重复 GET / activate。
  document.addEventListener("visibilitychange", () => { void presence(); if (document.visibilityState === "visible" && Date.now() - lastRestoreAt > 10_000) void restore(); });
  window.addEventListener("hashchange", () => void presence());
  window.addEventListener("focus", () => void presence());
  window.addEventListener("blur", () => void presence());
  window.addEventListener("storage", e => {
    if (e.key !== storage) return;
    intentRevision++; recoveryNeeded = false;
    try { settings = JSON.parse(e.newValue) || { enabled: false, preferences: { ...defaults } }; recoveryNeeded = !!settings.recoveryPending; refreshButton(); renderPanel(); } catch { /* invalid storage */ }
  });
  setInterval(() => void presence(), 20000);
  function panel() {
    embeddedPanel = h("section", { class: "card settings-card notification-settings-panel", "aria-label": "本设备通知" });
    drawPanel(embeddedPanel, false); void restore(); return embeddedPanel;
  }
  return { supported, panel, enabled, button: createButton, open, disable, restore, stopForLogout, readingUpdated, noteAuthFailure };
})();
