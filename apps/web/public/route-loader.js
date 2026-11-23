"use strict";
// Immutable document descriptors include eager and deferred code in one release.
// Loading registers definitions only; route generations decide whether to mount.
(() => {
  // 可选应用开关（设置 → 应用）：本机缓存上次从服务端读到的「已关闭应用」清单，首帧同步生效——
  // 已关闭应用的底栏按钮不显示、路由模块不加载（piRouteModules.has 为 false，依赖它的软依赖自动跳过）。
  // 服务端 /api/apps 才是准的：启动后读一次，变了就缓存并刷新一次页面（同一份清单只刷新一次，避免循环）。
  const APPS_KEY = 'pi-agent:apps:v1', RELOAD_KEY = 'pi-agent:apps:reloaded';
  const strings = value => (Array.isArray(value) ? value : []).filter(item => typeof item === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(item));
  const offOf = raw => ({ apps: strings(raw?.apps), views: strings(raw?.views), routeModules: strings(raw?.routeModules) });
  const signature = off => [...off.apps].sort().join(',');
  // 优先读服务端放的 Cookie（首次进入新设备也准），其次是本机缓存；都没有就按全部开启。
  const fromCookie = () => { try { const hit = document.cookie.match(/(?:^|;\s*)pi_apps_off=([^;]*)/); return hit ? JSON.parse(decodeURIComponent(hit[1])) : null; } catch { return null; } };
  let applied = offOf(null);
  const cookie = fromCookie();
  if (cookie) applied = offOf(cookie);
  else try { applied = offOf(JSON.parse(localStorage.getItem(APPS_KEY))?.disabled); } catch { /* 缓存不可用就按全部开启 */ }
  const offViews = new Set(applied.views), offModules = new Set(applied.routeModules);
  for (const view of offViews) for (const tab of document.querySelectorAll('.tab[data-view]')) if (tab.dataset.view === view) tab.setAttribute('data-offline', '');
  const entries = new Map();
  const descriptors = document.getElementById('route-modules')?.content;
  for (const tag of descriptors?.querySelectorAll('script[data-route-module][src]') || []) {
    const name = tag.dataset.routeModule, url = new URL(tag.getAttribute('src'), location.href);
    if (name && offModules.has(name)) continue;
    if (!name || entries.has(name) || url.origin !== location.origin || url.searchParams.has('callback')) throw new Error('Invalid route module');
    const digest = url.pathname.match(/^\/assets\/([a-f0-9]{64})\/[a-z][a-z0-9-]*\.js$/)?.[1];
    if (document.querySelector('meta[name="pi-web-release"]') && (!digest || url.search || url.hash)) throw new Error('Unversioned route module');
    if (tag.dataset.routeKind && tag.dataset.routeKind !== 'shared') throw new Error('Invalid route module kind');
    entries.set(name, { url: url.href, digest, shared: tag.dataset.routeKind === 'shared', dependencies: (tag.dataset.routeDependencies || '').split(/\s+/).filter(Boolean), softDependencies: (tag.dataset.routeSoftDependencies || '').split(/\s+/).filter(Boolean), status: 'idle', promise: null, definition: null });
  }
  const validated = new Set();
  function validate(name, ancestors = new Set()) {
    if (ancestors.has(name) || !entries.has(name)) throw new Error('Invalid route dependencies');
    if (validated.has(name)) return;
    const next = new Set(ancestors); next.add(name);
    for (const dependency of entries.get(name).dependencies) validate(dependency, next);
    validated.add(name);
  }
  for (const name of entries.keys()) validate(name);
  // Fetch the share editor alongside eager scripts, but execute it only through
  // ensure() once the app and its helpers exist. Use this document's exact release.
  if (/^[a-f0-9]{32}$/.test(new URLSearchParams(location.search).get('shareId') || '') && entries.has('notes')) {
    const item = entries.get('notes'), link = document.createElement('link');
    link.rel = 'preload'; link.as = 'script'; link.href = item.url;
    if (item.digest) {
      link.integrity = 'sha256-' + btoa(String.fromCharCode(...item.digest.match(/../g).map(v => parseInt(v, 16))));
      link.crossOrigin = 'anonymous';
    }
    document.head.append(link);
  }
  const entry = name => { const item = entries.get(name); if (!item) throw new Error('Unknown route module'); return item; };
  const saveApps = view => { try { localStorage.setItem(APPS_KEY, JSON.stringify({ revision: view.revision, disabled: offOf(view.disabled) })); } catch { /* 缓存不可用时下次启动再同步 */ } };
  // 拿到服务端最新清单：写缓存；实际不可用的应用变了就刷新一次页面，让入口与模块按新清单重新装配。
  const commit = (view, reload = true) => {
    if (!view || typeof view !== 'object' || !view.disabled) return false;
    saveApps(view);
    const changed = signature(offOf(view.disabled)) !== signature(applied);
    if (changed && reload) {
      let again = false;
      try { again = sessionStorage.getItem(RELOAD_KEY) === signature(offOf(view.disabled)); sessionStorage.setItem(RELOAD_KEY, signature(offOf(view.disabled))); } catch { /* 无法记录就当没刷新过 */ }
      if (!again) location.reload();
    }
    return changed;
  };
  window.piApps = Object.freeze({
    /** 这个页面（ui.view）属于已关闭的应用 */
    blocksView: view => offViews.has(view) || offModules.has(view),
    /** 当前缓存里已关闭的应用 id */
    disabled: () => [...applied.apps],
    isOff: id => applied.apps.includes(id),
    commit,
  });
  const syncSoon = () => fetch('/api/apps', { credentials: 'same-origin', headers: { accept: 'application/json' }, cache: 'no-store' })
    .then(response => (response.ok ? response.json() : null)).then(view => { if (view) commit(view); }).catch(() => { /* 未登录或离线：沿用缓存 */ });
  // 首屏不等它：页面加载完、浏览器空闲后再读一次。
  addEventListener('load', () => { if (window.requestIdleCallback) requestIdleCallback(() => void syncSoon(), { timeout: 5000 }); else setTimeout(() => void syncSoon(), 2000); }, { once: true });
  window.piRouteModules = Object.freeze({
    has: name => entries.has(name),
    state: name => entry(name).status,
    module: name => entry(name).definition,
    register(name, definition) {
      const item = entry(name);
      if (item.definition || !definition || typeof definition !== 'object' || (!item.shared && typeof definition.render !== 'function')) throw new Error('Invalid route registration');
      item.definition = Object.freeze(definition);
    },
    ensure(name) {
      const item = entry(name);
      if (item.status === 'ready') return Promise.resolve(item.definition);
      if (item.promise) return item.promise;
      item.status = 'loading';
      const script = document.createElement('script');
      script.src = item.url; script.async = true; script.dataset.routeModule = name;
      if (item.digest) {
        script.integrity = 'sha256-' + btoa(String.fromCharCode(...item.digest.match(/../g).map(v => parseInt(v, 16))));
        script.crossOrigin = 'anonymous';
      }
      item.promise = Promise.resolve().then(async () => {
        await Promise.all(item.dependencies.map(dependency => window.piRouteModules.ensure(dependency)));
        // 软依赖：这个构建带了就先加载（行为与硬依赖一致），没带（可选应用未发布）或加载失败都不影响本模块。
        await Promise.all(item.softDependencies.filter(dependency => entries.has(dependency)).map(dependency => window.piRouteModules.ensure(dependency).catch(() => undefined)));
        return new Promise((resolve, reject) => {
          const finish = error => {
            script.onload = script.onerror = null;
            if (error) { item.status = 'error'; item.definition = null; script.remove(); reject(new Error('Route module unavailable')); }
            else { item.status = 'ready'; resolve(item.definition); }
          };
          script.onload = () => finish(!item.definition);
          script.onerror = () => finish(true);
          document.head.append(script);
        });
      }).catch(error => {
        item.status = 'error'; item.definition = null; throw error;
      }).finally(() => {
        item.promise = null;
      });
      return item.promise;
    }
  });
})();
