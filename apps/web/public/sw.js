// Production embeds the store before this worker; development imports it at install time.
if (!self.piImageIntakeStore) { try { importScripts('/image-intake-store.js'); } catch { /* Shares report storage unavailable; other worker features still operate. */ } }
// The release builder supplies an exact current/previous code allowlist.
//
// Two caches, two jobs:
// - static code: the exact release files, verified by digest, reused offline.
// - app shell: the last authenticated document, so a cold start paints the app
//   without waiting for a network round trip. It is a cache, not an authority: the
//   server's answer still wins whenever it arrives in time, login redirects and
//   denials drop the shell, and it is only ever a complete release whose files this
//   worker can still serve. That can be the previous release (the builder keeps it),
//   which a page opened across a deploy already runs; the next network answer swaps
//   in the current release.
const STATIC_CACHE = "pi-agent-static-v1";
const SHELL_CACHE = "pi-agent-shell-v1";
// The release this worker was built from; the builder writes it next to the allowlist.
const RELEASE = typeof self.__PI_WEB_RELEASE === "string" ? self.__PI_WEB_RELEASE : "";
const SHELL_KEY = "/__pi-app-shell";
// How long the network may take before the stored document is used. A faster answer
// keeps today's network-first behaviour; a slower one no longer holds the launch.
const SHELL_GRACE_MS = 400;
// The document's own security headers travel with it; a stored page must not be weaker than a live one.
const SHELL_HEADERS = ["content-security-policy", "referrer-policy", "x-frame-options", "x-content-type-options"];
const staticAssets = new Set(Array.isArray(self.__PI_STATIC_ASSETS) ? self.__PI_STATIC_ASSETS : []);
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
// 个别 Chromium 会把装好的新 worker 一直挂在 waiting（install 里的 skipWaiting 没生效）。
// 页面发现它停在 waiting 会再要求一次，离线功能自己恢复，不用等失败后由用户点重试。
self.addEventListener("message", event => { if (event.data === "pi-skip-waiting") event.waitUntil(self.skipWaiting()); });
self.addEventListener("activate", (event) => event.waitUntil((async () => {
  try {
    const cache = await caches.open(STATIC_CACHE);
    for (const key of await cache.keys()) {
      const url = new URL(key.url);
      if (url.origin !== self.location.origin || url.search || !staticAssets.has(url.pathname)) await cache.delete(key);
    }
  } catch { /* Storage failure leaves ordinary network loading available. */ }
  // A shell stays usable while every file it references is still in this worker's
  // allowlist. The release builder keeps exactly the previous release, so the document
  // from before a deploy is a complete release of its own: a page that stayed open
  // across the deploy runs that same code. Dropping it here made the next phone launch
  // on a slow link download the document again (observed 0.9–25 s TTFB instead of the
  // stored shell's ~0.4 s), once per deploy. Only a shell whose code is gone is dropped.
  const shell = await readShell();
  if (shell && shell.assets.some(url => !staticAssets.has(url))) await dropShell();
  await self.clients.claim();
})()));

/* ---------- App shell ---------- */
const shellStore = () => caches.open(SHELL_CACHE);
async function readShell() {
  try {
    const cached = await (await shellStore()).match(SHELL_KEY);
    const record = cached ? await cached.json() : null;
    if (!record || typeof record.html !== "string" || !/^[a-f0-9]{64}$/.test(record.release || "") ||
        !Array.isArray(record.assets) || !record.assets.every(url => typeof url === "string") ||
        !record.headers || typeof record.headers !== "object") return null;
    return record;
  } catch { return null; }
}
async function writeShell(record) {
  try {
    await (await shellStore()).put(SHELL_KEY, new Response(JSON.stringify(record), { headers: { "content-type": "application/json" } }));
    return true;
  } catch { return false; }
}
async function dropShell() {
  try { await (await shellStore()).delete(SHELL_KEY); } catch { /* Storage failure leaves ordinary loading available. */ }
}
/** Accepts a document only when it is an authenticated release page whose code this worker can verify. */
async function shellRecord(response) {
  if (!response || response.status !== 200 || response.redirected) return null;
  if ((response.headers.get("content-type") || "").split(";")[0].trim() !== "text/html") return null;
  const release = (response.headers.get("x-pi-web-release") || "").trim();
  // Only the document that belongs to this worker's code: a mismatch would mix releases.
  if (!RELEASE || release !== RELEASE) return null;
  let html;
  try { html = await response.clone().text(); } catch { return null; }
  const assets = [...new Set(html.match(/\/assets\/[a-f0-9]{64}\/[a-z][a-z0-9-]*\.(?:js|css)/g) || [])];
  // Unknown code means a release this worker cannot cache or verify: keep the older shell.
  if (!assets.length || assets.length > 96 || !assets.every(url => staticAssets.has(url))) return null;
  const headers = {};
  for (const name of SHELL_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  // Every console document is served under our CSP; a page without one is not this app's document.
  if (!headers["content-security-policy"]) return null;
  return { release, assets, html, headers, savedAt: Date.now() };
}
/** Stores the document, or drops the shell when the server says the session is over. */
async function storeShell(response) {
  const record = await shellRecord(response);
  if (record) return writeShell(record);
  // 0 is the opaque redirect a navigation request yields; 401/403 mean the session ended.
  // A 5xx or a network error is a blip and keeps the shell usable.
  if (response.redirected || response.status === 0 || response.status === 401 || response.status === 403) await dropShell();
  return false;
}
function offlineDocument() {
  return new Response(self.__PI_OFFLINE_SHELL.html, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "content-security-policy": self.__PI_OFFLINE_SHELL.csp, "x-content-type-options": "nosniff",
      "x-frame-options": "DENY", "referrer-policy": "no-referrer", "x-pi-offline": "1" }
  });
}
// Marks the document as delivered from the shell. The page reads the attribute to report whether
// this launch waited for the network, and it shows up in DevTools at a glance.
function shellDocument(record) {
  const html = record.html.includes("<html ")
    ? record.html.replace("<html ", `<html data-pi-shell="${record.release}" `)
    : record.html;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      ...record.headers, "x-pi-shell-release": record.release }
  });
}
/** A 304 carries no document to keep, so ask for the bytes again instead of losing the shell. */
async function networkDocument(request) {
  const response = await fetch(request);
  if (response.status !== 304) return response;
  const headers = new Headers(request.headers);
  headers.delete("if-none-match"); headers.delete("if-modified-since");
  return await fetch(new Request(request.url, { method: "GET", headers, credentials: "same-origin", cache: "reload", redirect: "follow", mode: "same-origin" }));
}
// A URL allowlist proves identity, not that the browser retained the bytes.
// Ignore inert route descriptors: their modules load/retry through the route loader.
async function shellCodeComplete(record) {
  const eager = record.html.replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, '');
  const urls = [...new Set(eager.match(/\/assets\/[a-f0-9]{64}\/[a-z][a-z0-9-]*\.(?:js|css)/g) || [])];
  if (!urls.length || urls.length > 96 || urls.some(url => !staticAssets.has(url) || !record.assets.includes(url))) return false;
  try {
    const cache = await caches.open(STATIC_CACHE);
    return (await Promise.all(urls.map(async path => {
      const url = new URL(path, self.location.origin), response = await cache.match(url.href);
      return !!response && await verifiedStatic(response, url);
    }))).every(Boolean);
  } catch { return false; }
}
async function rootNavigation(event) {
  const started = Date.now(), network = networkDocument(event.request);
  // Settle failures immediately even while storage is being checked.
  const networkDone = network.then(() => false, () => false);
  // Without connectivity the launch keeps the generated offline document, as before.
  const stored = self.navigator?.onLine === false ? null : await Promise.race([readShell(), networkDone.then(() => null)]);
  // A previous release's document is served like the current one while the network
  // answer is on its way; the response below replaces the stored shell with this
  // worker's release, so the old page lives for exactly one launch.
  // Applying an update must fetch today's document, even on a slow connection.
  // Ordinary launches may still use a complete previous release while fetching.
  const reload = ['reload', 'no-cache', 'no-store'].includes(event.request.cache);
  const reusable = stored && stored.assets.every(url => staticAssets.has(url));
  // The controlling worker may itself still be the previous release.
  let shell = null;
  if (reusable && !reload) {
    // Storage may stall; it must not delay a usable network document indefinitely.
    let timer;
    const complete = await Promise.race([
      shellCodeComplete(stored), networkDone,
      new Promise(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, SHELL_GRACE_MS - (Date.now() - started))); })
    ]).finally(() => clearTimeout(timer));
    if (complete) shell = stored;
  }
  if (!shell) {
    try { const response = await network; event.waitUntil(storeShell(response.clone())); return response; }
    catch { return offlineDocument(); }
  }
  const first = await Promise.race([
    network.then(response => ({ response }), () => ({ failed: true })),
    new Promise(resolve => setTimeout(() => resolve({ pending: true }), Math.max(0, SHELL_GRACE_MS - (Date.now() - started))))
  ]);
  if (first.response) { event.waitUntil(storeShell(first.response.clone())); return first.response; }
  // Offline keeps the generated document; a slow network gets the last good shell at once.
  if (first.failed) return offlineDocument();
  event.waitUntil(network.then(storeShell, () => false));
  return shellDocument(shell);
}

async function verifiedStatic(response, url) {
  const type = response.headers.get("content-type")?.split(";")[0].trim();
  if (response.status !== 200 || response.redirected ||
      !(/^(?:text|application)\/javascript$/.test(type || "") || type === "text/css") ||
      !response.headers.get("cache-control")?.includes("immutable")) return false;
  const bytes = await response.clone().arrayBuffer();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
  return digest === url.pathname.split("/")[2];
}
async function staticResponse(request, url, event) {
  let cache;
  try {
    cache = await caches.open(STATIC_CACHE);
    const cached = await cache.match(request);
    if (cached && await verifiedStatic(cached, url)) return cached;
    if (cached) await cache.delete(request);
  } catch { /* Quota/unavailable/corrupt storage must not block network. */ }
  const response = await fetch(request);
  // Validation and persistence do not delay the first network response.
  if (cache) {
    const copy = response.clone();
    event.waitUntil((async () => {
      if (await verifiedStatic(copy, url)) await cache.put(request, copy);
    })().catch(() => {}));
  }
  return response;
}
// System sharing writes only to bounded local storage, never to the network.
async function receiveImageShare(request) {
  const redirect = query => Response.redirect(new URL('/?' + query + '#/notes', self.location.origin).href, 303);
  try {
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data')) return redirect('shareError=invalid');
    const length = Number(request.headers.get('content-length') || 0);
    if (length > 30 * 1024 ** 2) return redirect('shareError=invalid');
    const form = await request.formData();
    const files = form.getAll('image').filter(value => typeof value !== 'string');
    if (!files.length) return redirect('shareError=invalid');
    // Production bundles this exact source into the worker. Development loads it only for a share.
    if (!self.piImageIntakeStore) throw new Error('临时图片存储不可用');
    const shareId = await self.piImageIntakeStore.put({ file: files[0], ownerBinding: null, extraCount: files.length - 1 });
    return redirect('shareId=' + shareId);
  } catch (error) {
    const code = /格式|内容|图片不能为空|解码|只支持/.test(error?.message || '') ? 'invalid' : /已满/.test(error?.message || '') ? 'full' : 'storage';
    return redirect('shareError=' + code);
  }
}
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/communications/")) return; // private network-only data

  if (url.origin === self.location.origin && url.pathname === '/share-target' && event.request.method === 'POST') {
    event.respondWith(receiveImageShare(event.request)); return;
  }
  const shareIds = url.searchParams.getAll('shareId'), shareErrors = url.searchParams.getAll('shareError');
  const shareQuery = [...url.searchParams.keys()].length === 1 && ((shareIds.length === 1 && /^[a-f0-9]{32}$/.test(shareIds[0])) || (shareErrors.length === 1 && ['invalid','full','storage'].includes(shareErrors[0])));
  const notificationTarget = url.searchParams.getAll('notification-session');
  const rootQuery = !url.search || shareQuery || (notificationTarget.length === 1 && /^[A-Za-z0-9_-]+$/.test(notificationTarget[0]) && [...url.searchParams.keys()].length === 1);
  if (event.request.method === 'GET' && event.request.mode === 'navigate' && url.origin === self.location.origin && url.pathname === '/' && rootQuery && self.__PI_OFFLINE_SHELL) {
    event.respondWith(rootNavigation(event));
    return;
  }
  if (event.request.method !== "GET" || event.request.headers.has("range") || url.origin !== self.location.origin || url.search ||
      !/^\/assets\/[a-f0-9]{64}\/[a-z][a-z0-9-]*\.(?:js|css)$/.test(url.pathname) || !staticAssets.has(url.pathname)) return;
  event.respondWith(staticResponse(event.request, url, event));
});

function notificationStore(mode, action) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("pi-agent-notifications", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("state");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction("state", mode), result = action(tx.objectStore("state"));
      tx.oncomplete = () => { db.close(); resolve(result?.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
self.addEventListener("message", event => {
  // 故障诊断：页面问「控制我的是哪个版本的 worker」（V1.4 §3.3，sw_release）
  if (event.data?.type === "release-identity") { event.ports[0]?.postMessage({ release: RELEASE || null }); return; }
  if (event.data?.type !== "notification-settings") return;
  event.waitUntil(notificationStore("readwrite", store => store.put(event.data.settings, "settings"))
    .then(() => event.ports[0]?.postMessage({ ok: true })).catch(() => event.ports[0]?.postMessage({ ok: false })));
});
// Serial delivery prevents two simultaneous pushes racing the ID check.
let delivery = Promise.resolve();
async function showPush(event) {
  let data;
  try { data = event.data.json(); } catch { return; }
  if (!data || typeof data.id !== "string" || data.id.length > 500 || typeof data.title !== "string" || !Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now()) return;
  const settings = await notificationStore("readonly", store => store.get("settings"));
  if (!settings?.enabled || settings.mode !== "push" || settings.binding !== data.binding) return;
  const url = new URL(data.url, self.location.origin);
  if (url.origin !== self.location.origin || url.pathname !== "/" || !/^#\/(?:rt(?:\/[A-Za-z0-9_-]+)?|notes(?:\/widget\/\d{4}-\d{2}-\d{2}(?:\/[A-Za-z0-9_-]+)?)?)$/.test(url.hash)) return;
  const key = `seen:${data.binding}:${data.id}`;
  if (await notificationStore("readonly", store => store.get(key))) return;
  await self.registration.showNotification(data.title.slice(0, 120), {
    body: String(data.body || "").slice(0, 300), icon: "/icons/icon-192.png", badge: "/icons/icon-192.png",
    tag: data.id, data: { url: url.href, expiresAt: data.expiresAt, binding: data.binding }
  });
  await notificationStore("readwrite", store => {
    store.put(Date.now(), key);
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result; if (!c) return;
      if (typeof c.key === "string" && c.key.startsWith("seen:") && c.value + 86400000 < Date.now()) c.delete();
      c.continue();
    };
  });
}
self.addEventListener("push", event => {
  delivery = delivery.catch(() => {}).then(() => showPush(event));
  event.waitUntil(delivery);
});
function clickStep(promise, timeout = 3000) {
  let timer;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeout); })])
    .catch(() => null).finally(() => clearTimeout(timer));
}
async function routeDesktopNotification(client, url) {
  // Mobile keeps its existing system navigation/launch path. A live desktop page
  // must acknowledge the route before we skip navigation (old/suspended pages fall back).
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(self.navigator.userAgent) || !client.postMessage) return false;
  const channel = new MessageChannel();
  try {
    return await clickStep(new Promise(resolve => {
      channel.port1.onmessage = event => resolve(event.data?.routed === true);
      client.postMessage({ type: "notification-route-desktop", url: url.href }, [channel.port2]);
    }), 600) === true;
  } finally { channel.port1.close(); channel.port2.close(); }
}
async function finishNotificationOpen(url) {
  // Prefer the already-open app window (desktop tab, installed app on Android) so
  // a notification opens the session in place instead of spawning another tab.
  // Bound the probe so a suspended window cannot block indefinitely or consume the
  // click's short-lived activation before the system launch below.
  const windows = await clickStep(self.clients.matchAll({ type: "window", includeUncontrolled: true }), 1200) || [];
  const candidates = windows.filter(c => new URL(c.url).origin === self.location.origin && "navigate" in c)
    .sort((a, b) => Number(b.visibilityState === "visible") - Number(a.visibilityState === "visible"));
  for (const client of candidates) {
    if (await routeDesktopNotification(client, url)) { await clickStep(client.focus()); return; }
    const navigated = await clickStep(client.navigate(url.href));
    if (navigated) { await clickStep(navigated.focus()); return; }
  }
  // No reusable window: ask the system to focus the installed app or open a new
  // window. Called right after the bounded probe so the click still counts as the
  // user gesture. Payload binding is checked before display; page/API login and
  // session authorization remain authoritative when opening an existing notice.
  let opening;
  try { opening = self.clients.openWindow(url.href); } catch { opening = Promise.resolve(null); }
  const opened = await clickStep(opening);
  if (opened) await clickStep(opened.focus());
}
const PRIMARY_ORIGIN = "https://primary.example.com";
const DESKTOP_CLICK_ORIGIN = "https://console.example.com";
self.addEventListener("notificationclick", event => {
  const data = event.notification.data;
  let url;
  try { url = new URL(data?.url, self.location.origin); } catch { return; }
  if (url.origin !== self.location.origin || url.pathname !== "/" || !/^#\/(?:rt(?:\/[A-Za-z0-9_-]+)?|notes(?:\/widget\/\d{4}-\d{2}-\d{2}(?:\/[A-Za-z0-9_-]+)?)?)$/.test(url.hash)) return;
  if (url.hash.startsWith("#/rt/")) url.searchParams.set("notification-session", url.hash.slice("#/rt/".length));
  event.notification.close();
  // PC：主域名上收到的推送，点击后改到备用域名打开（跨源，不能复用当前窗口，直接开新窗口）。
  if (self.location.origin === PRIMARY_ORIGIN && !/Android|iPhone|iPad|iPod|Mobile/i.test(self.navigator.userAgent)) {
    const target = new URL(url.pathname + url.search + url.hash, DESKTOP_CLICK_ORIGIN);
    event.waitUntil(clickStep((() => { try { return self.clients.openWindow(target.href); } catch { return Promise.resolve(null); } })())
      .then(opened => opened && clickStep(opened.focus())));
    return;
  }
  event.waitUntil(finishNotificationOpen(url));
});
