"use strict";
/*
 * 夜间模式开关：放在竖栏底部「设置」上方。
 * 没手动选过就跟随系统（prefers-color-scheme）；点一下记住为浅色 / 深色，只存在本浏览器。
 * 本文件在 <head> 里同步加载，先给 <html> 打上 data-theme，避免首屏先亮后暗地闪一下。
 */
(function () {
  const KEY = "pi-agent.theme.v1";
  const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const saved = () => { try { const v = localStorage.getItem(KEY); return v === "dark" || v === "light" ? v : null; } catch { return null; } };
  const apply = (theme) => { if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme; };
  const isDark = () => (saved() || (media && media.matches ? "dark" : "light")) === "dark";
  // 状态栏颜色 = 页面在屏幕最上缘实际画的颜色（styles.css 的 --system-bar-top：顶栏实色 / 页面底色 / 设置页白底）。
  // 首屏、主题切换、切换页面（body 的 class 变化）、窄屏 / 宽屏切换都同步，不再固定用顶栏色。
  function syncChrome() {
    const meta = document.querySelector('meta[name="theme-color"]');
    const color = getComputedStyle(document.documentElement).getPropertyValue("--system-bar-top").trim();
    if (meta && color && meta.getAttribute("content") !== color) meta.setAttribute("content", color);
  }
  apply(saved());
  syncChrome();
  function watchBody() {
    if (!document.body || typeof MutationObserver !== "function") return;
    new MutationObserver(syncChrome).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    syncChrome();
  }
  if (document.body) watchBody(); else document.addEventListener("DOMContentLoaded", watchBody, { once: true });
  if (window.matchMedia) { const narrow = window.matchMedia("(max-width: 760px)"); if (narrow.addEventListener) narrow.addEventListener("change", syncChrome); }

  const MOON = '<svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>';
  let button = null;
  function sync() {
    syncChrome();
    if (!button) return;
    const on = isDark();
    button.setAttribute("aria-pressed", String(on));
    button.classList.toggle("on", on);
    button.title = `夜间模式：${on ? "开" : "关"}${saved() ? "" : "（跟随系统）"}——点一下${on ? "关闭" : "打开"}`;
  }
  function toggle() {
    const next = isDark() ? "light" : "dark";
    try { localStorage.setItem(KEY, next); } catch { /* 存储不可用时只在本页生效 */ }
    apply(next); sync(); report();
  }
  /** 用户此刻的选择：dark / light，没手动选过是 system（跟随系统）。 */
  const mode = () => saved() || "system";
  /*
   * 深浅选择是「设备级」的。同一个应用会从公网、局域网直连、中继等不同的源加载，而 localStorage 按源隔离——
   * 用户选一次深色，不该因为换了入口源就变回白天。所以原生壳听着这个事件，把同一个选择带进每个源
   * （在页面脚本之前写进那个源的 localStorage）。浏览器里没有壳，事件没人接，行为与以前一致。
   */
  function report() {
    try { window.dispatchEvent(new CustomEvent("pi-theme-change", { detail: { mode: mode() } })); } catch { /* 老浏览器没有 CustomEvent：只是不同步给壳 */ }
  }
  function mount() {
    if (button || !document.querySelector(".topbar")) return;
    button = document.createElement("button");
    button.type = "button";
    button.className = "tab-more theme-toggle";
    button.setAttribute("aria-label", "夜间模式");
    button.innerHTML = `${MOON}<span class="tab-label">夜间</span>`;
    button.addEventListener("click", toggle);
    const anchor = document.querySelector(".topbar .nav-settings-button") || document.getElementById("conn");
    if (anchor) anchor.before(button); else document.querySelector(".topbar").append(button);
    if (window.syncNavLayout) window.syncNavLayout();
    sync();
  }
  window.piTheme = { isDark, toggle, mode };
  if (media && media.addEventListener) media.addEventListener("change", sync);
  // 有没有装到顶栏都不影响上报：主题是整页的，壳要的是「用户选了什么」。
  const boot = () => { mount(); report(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();

/*
 * 长按菜单交给浏览器：正文可以选中后复制，系统的「全选 / 复制」菜单直接可用。
 * 这里不再拦 contextmenu / selectstart，否则长按起不了系统选词。
 * 控件自己的手势（如长按置顶、长按排序）在自己的监听里 preventDefault，不依赖全局拦截。
 */
