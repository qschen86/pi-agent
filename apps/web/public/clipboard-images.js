(() => {
  'use strict';
  const preferenceKey = 'pi-agent:clipboard-images:enabled:v1';
  let optedIn = false, permissionState = 'unknown', revision = 0;
  try { optedIn = localStorage.getItem(preferenceKey) === '1'; } catch {}
  const changed = () => window.dispatchEvent(new Event('pi-capabilities-change'));
  // Accept the first web URL in copied text, not just a clipboard containing a URL alone.
  function link(raw) {
    if (typeof raw !== 'string' || raw.length > 16384) return null;
    for (const match of raw.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
      let text = match[0].replace(/[.,!;:，。！；：、）】》]+$/u, '');
      while (text.endsWith(')') && (text.match(/\)/g) || []).length > (text.match(/\(/g) || []).length) text = text.slice(0, -1);
      try { const url = new URL(text); if (url.hostname && !url.username && !url.password && !/[\\\u0000-\u001f]/u.test(text) && text.length <= 8192) return url.href; } catch {}
    }
    return null;
  }
  let nativeReady = false, nativeLinks = false;
  const nativeStatus = window.piAndroidShell?.available ? window.piAndroidShell.call('shell.status').then(status => { nativeReady = status.capabilities?.includes('clipboard.read') === true; nativeLinks = status.capabilities?.includes('clipboard.links') === true; changed(); }).catch(() => {}) : Promise.resolve();
  const supported = () => nativeReady || isSecureContext && !!navigator.clipboard?.read && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) && !(/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1) && /Chrome|Chromium/i.test(navigator.userAgent);
  const enabled = () => supported() && optedIn && !['denied', 'prompt'].includes(permissionState);
  function setEnabled(on) {
    optedIn = on; revision++;
    try { localStorage.setItem(preferenceKey, on ? '1' : '0'); } catch {}
    changed();
  }
  if (!window.piAndroidShell?.available && supported()) void navigator.permissions?.query({ name: 'clipboard-read' }).then(permission => {
    permissionState = permission.state; changed();
    permission.addEventListener?.('change', () => { permissionState = permission.state; changed(); });
  }).catch(() => {});
  window.addEventListener('storage', event => {
    if (event.key === preferenceKey || event.key === null) { optedIn = event.key !== null && event.newValue === '1'; revision++; changed(); }
  });
  window.piClipboardImages = Object.freeze({ supported, enabled, link, linksSupported: () => nativeReady ? nativeLinks : !window.piAndroidShell?.available && supported(), disable: () => setEnabled(false), create({ binding, onImage, onUnavailable }) {
    const clipboard = navigator.clipboard;
    const key = 'pi-agent:clipboard-images:' + binding;
    const canRead = supported;
    let disposed = false, left = false, retry = false, timer, expiry, running = false, manualReading = false, again = false, epoch = 0, current = null, readAt = 0;
    let seen = [];
    try { seen = JSON.parse(localStorage.getItem(key) || '[]'); if (!Array.isArray(seen)) seen = []; } catch { seen = []; }
    const active = () => !disposed && document.visibilityState === 'visible' && document.hasFocus();
    const remember = hash => {
      seen = seen.filter(row => typeof row?.hash === 'string' && row.at > Date.now() - 86400000 && row.hash !== hash).slice(-63);
      seen.push({ hash, at: Date.now() });
      try { localStorage.setItem(key, JSON.stringify(seen)); } catch { /* Session still deduplicates in memory. */ }
    };
    async function read(manual) {
      if (!canRead() || !active() || (!manual && !enabled())) return false;
      if (running) { again = true; return; }
      running = true; manualReading = manual; if (!manual) readAt = Date.now(); let generation = epoch, settingRevision = revision;
      try {
        if (!manual && !nativeReady) {
          const permission = await navigator.permissions?.query({ name: 'clipboard-read' });
          if (permission?.state !== 'granted' || !active()) return;
        }
        let items, url;
        if (nativeReady) {
          const result = await window.piAndroidShell.call('clipboard.read');
          const mime = result.mime;
          if (['image/png', 'image/jpeg', 'image/webp'].includes(mime) && typeof result.data === 'string' && result.data.length <= 14 * 1024 ** 2) {
            const bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0));
            items = [{ types: [mime], getType: async () => new Blob([bytes], { type: mime }) }];
          } else { items = []; url = link(result.url); }
        } else items = await clipboard.read();
        if (!active() || (!manual && generation !== epoch) || settingRevision !== revision) return false;
        if (manual) generation = epoch;
        if (manual) { permissionState = 'granted'; setEnabled(true); settingRevision = revision; }
        const item = items.find(i => i.types.some(type => ['image/png', 'image/jpeg', 'image/webp'].includes(type)));
        const mime = item?.types.find(type => ['image/png', 'image/jpeg', 'image/webp'].includes(type));
        if (!item && !url) {
          const textItem = items.find(i => i.types.includes('text/plain'));
          if (textItem) { const text = await textItem.getType('text/plain'); if (text.size <= 16384) url = link(await text.text()); }
        }
        if (!item && !url) { clearTimeout(expiry); if (current) { current = null; onImage(null); } return; }
        if (!active() || generation !== epoch || settingRevision !== revision || !enabled()) return;
        // Every foreground read of a copied link becomes one device-local history row; the store deduplicates by URL.
        if (url) window.piClipboardHistory?.record?.(url);
        const blob = item ? await item.getType(mime) : new Blob([url], { type: 'text/plain' });
        if (!blob.size || blob.size > 10 * 1024 ** 2 || settingRevision !== revision || !enabled()) return;
        // The Android LAN entrance uses HTTP: reuse the attachment flow's SHA-256 fallback there.
        const data = await blob.arrayBuffer();
        const hash = globalThis.crypto?.subtle
          ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('')
          : rtSha256(new Uint8Array(data));
        if (!active() || generation !== epoch || settingRevision !== revision || !enabled()) return;
        if (seen.some(row => row.hash === hash && row.at > Date.now() - 86400000)) {
          if (current && current.intakeId !== 'clipboard-' + hash) { current = null; clearTimeout(expiry); onImage(null); }
          return;
        }
        remember(hash); clearTimeout(expiry);
        current = { intakeId: 'clipboard-' + hash, ...(url ? { kind: 'link', url, title: new URL(url).hostname, favicon: '' } : { file: new File([blob], '剪贴板.' + ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[mime]), { type: mime }) }), expiresAt: Date.now() + 600000 };
        onImage(current);
        expiry = setTimeout(() => { current = null; onImage(null); }, 600000);
      } catch { if (current) { current = null; clearTimeout(expiry); onImage(null); } if (manual) onUnavailable?.('无法读取剪贴板，请允许访问，或直接粘贴图片'); return false; }
      finally { running = false; manualReading = false; if (again && !disposed) { again = false; schedule(); } }
    }
    // One read per behaviour trigger, coalescing bursts (resume + focus + clipboardchange) within 300 ms.
    function schedule() { if (!canRead() || !active() || !enabled()) return; clearTimeout(timer); timer = setTimeout(() => void read(false), Math.max(30, readAt + 300 - Date.now())); }
    const blur = () => { left = true; epoch++; };
    // Android can resume before its WebView receives focus, including on a cold start: wait for focus once.
    const trigger = () => { if (active()) schedule(); else retry = true; };
    const focus = () => { if (!active() || (!left && !retry)) return; left = false; retry = false; schedule(); };
    const visibility = () => { if (document.visibilityState === 'hidden') blur(); else trigger(); };
    // clipboardchange is a capability enhancement, focus recovery works without it.
    const change = trigger;
    window.addEventListener('pi-native-resume', change); window.addEventListener('pi-native-clipboard-change', change);
    void nativeStatus.then(trigger);
    window.addEventListener('blur', blur); window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visibility); clipboard?.addEventListener?.('clipboardchange', change);
    const settingChanged = () => { if (!enabled() && (!manualReading || permissionState === 'denied')) { epoch++; clearTimeout(timer); clearTimeout(expiry); if (current) { current = null; onImage(null); } } };
    window.addEventListener('pi-capabilities-change', settingChanged);
    const release = id => { if (current?.intakeId === id) { current = null; clearTimeout(expiry); } };
    return Object.freeze({
      async enable() { await nativeStatus; if (!canRead()) { onUnavailable?.('此浏览器不支持截图检测，请直接粘贴或从相册上传'); return; } await read(true); },
      dismiss: release, imported: release,
      dispose({ clear = true } = {}) {
        window.removeEventListener('pi-capabilities-change', settingChanged);
        disposed = true; epoch++; current = null;
        window.removeEventListener('pi-native-resume', change); window.removeEventListener('pi-native-clipboard-change', change); clearTimeout(timer); clearTimeout(expiry);
        window.removeEventListener('blur', blur); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', visibility); clipboard?.removeEventListener?.('clipboardchange', change);
        if (clear) { try { localStorage.removeItem(key); } catch {} }
      }
    });
  } });
})();
