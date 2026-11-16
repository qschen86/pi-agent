"use strict";
// Immutable document descriptors include eager and deferred code in one release.
// Loading registers definitions only; route generations decide whether to mount.
(() => {
  const entries = new Map();
  const descriptors = document.getElementById('route-modules')?.content;
  for (const tag of descriptors?.querySelectorAll('script[data-route-module][src]') || []) {
    const name = tag.dataset.routeModule, url = new URL(tag.getAttribute('src'), location.href);
    if (!name || entries.has(name) || url.origin !== location.origin || url.searchParams.has('callback')) throw new Error('Invalid route module');
    const digest = url.pathname.match(/^\/assets\/([a-f0-9]{64})\/[a-z][a-z0-9-]*\.js$/)?.[1];
    if (document.querySelector('meta[name="pi-web-release"]') && (!digest || url.search || url.hash)) throw new Error('Unversioned route module');
    if (tag.dataset.routeKind && tag.dataset.routeKind !== 'shared') throw new Error('Invalid route module kind');
    entries.set(name, { url: url.href, digest, shared: tag.dataset.routeKind === 'shared', dependencies: (tag.dataset.routeDependencies || '').split(/\s+/).filter(Boolean), status: 'idle', promise: null, definition: null });
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
