"use strict";
/*
 * 原生壳（Android WebView）里的客户端更新：
 * - 定期问一次实例有没有新的 APK；有就在后台下载到本机并校验，不等用户点「安装」才下载。
 * - 有更新时把红点文字「新版本」挂到「版本」「设置」和导航栏的「更多」上。
 * 浏览器里没有 window.piAndroidShell，本模块整体不生效（window.piNativeUpdate === null），行为与以前一致。
 */
(() => {
  const shell = window.piAndroidShell;
  if (!shell?.available) { window.piNativeUpdate = null; return; }
  const CHECK_MS = 30 * 60 * 1000, RETRY_MS = 5 * 60 * 1000;
  // available: 服务器上有更高版本；downloaded: 已经下到本机并通过包名 / 版本 / 摘要 / 签名校验。
  const state = { available: false, downloaded: false, versionName: "", versionCode: 0, checking: false, prepared: false, checkedAt: 0, error: "" };
  const nodes = new Set(), listeners = new Set();
  let timer = 0, running = null, canPrepare = false;

  const badgeTitle = () => !state.available ? "" : state.downloaded ? `新版本 ${state.versionName} 已下载到本机` : `新版本 ${state.versionName} 正在后台下载`;
  function paint() {
    for (const node of nodes) {
      if (!node.isConnected) { nodes.delete(node); continue; }
      node.hidden = !state.available;
      node.title = badgeTitle();
    }
    for (const fn of listeners) { try { fn(state); } catch { /* 订阅方自己出错不影响更新流程 */ } }
    window.dispatchEvent(new Event("pi-native-update"));
  }
  /** 页面自己的位置（版本页标题、设置导航项）放这个红点文字；隐藏由本模块统一控制。 */
  function badge(onIcon) {
    const node = document.createElement("span");
    node.className = onIcon ? "pi-new-version on-icon" : "pi-new-version";
    node.textContent = "新版本";
    node.hidden = !state.available;
    nodes.add(node);
    return node;
  }
  function apply(result) {
    const available = result?.available === true;
    state.available = available;
    state.downloaded = available && result?.ready === true;
    state.versionName = available ? String(result?.versionName || "") : "";
    state.versionCode = available ? Number(result?.versionCode) || 0 : 0;
    state.prepared = false;
  }
  async function prepare() {
    if (!canPrepare || !state.available || state.downloaded || state.prepared) return;
    state.prepared = true;
    try { apply(await shell.call("updates.prepare")); }
    catch (error) { state.prepared = false; state.error = error?.message || "后台下载失败，稍后重试"; }
    finally { paint(); }
  }
  function schedule(delay = CHECK_MS) { clearTimeout(timer); timer = setTimeout(() => void check(true), delay); }
  async function check(force = false) {
    if (running) return running;
    if (document.visibilityState === "hidden" && !force) return null;
    if (navigator.onLine === false) { schedule(RETRY_MS); return null; }
    state.checking = true; paint();
    running = (async () => {
      try {
        const result = await shell.call("updates.check");
        apply(result); state.error = "";
        if (state.available && !state.downloaded) await prepare();
        if (state.available && !state.downloaded) { schedule(RETRY_MS); return null; }
        schedule();
        return state.available;
      } catch (error) {
        state.error = error?.message || "检查更新失败";
        schedule(RETRY_MS);
        return null;
      } finally { state.checking = false; state.checkedAt = Date.now(); running = null; paint(); }
    })();
    return running;
  }
  function mount() {
    const more = document.getElementById("nav-more-btn");
    if (more) more.append(badge(true));
    // nav-settings.js 在脚本解析时就建好了「设置」按钮，这里直接挂上去（放在图标右上角）。
    const settings = document.querySelector(".nav-settings-button");
    if (settings) settings.append(badge(true));
    paint();
  }
  window.addEventListener("pi-native-resume", () => void check(true));
  window.addEventListener("online", () => void check(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!state.checkedAt || Date.now() - state.checkedAt >= CHECK_MS) void check(true);
  });
  window.piNativeUpdate = { available: true, state: () => ({ ...state }), check, badge, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
  mount();
  // 先问一次能力：老 APK 没有 updates.prepare，就不自动下载（版本页里仍可手动更新）。
  void shell.call("shell.status").then(result => {
    canPrepare = Array.isArray(result?.capabilities) && result.capabilities.includes("updates.prepare");
  }).catch(() => {}).finally(() => void check(true));
})();
