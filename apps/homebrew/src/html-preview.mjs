import { createHash, randomUUID } from 'node:crypto';

export const PREVIEW_WRAPPER_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

export function previewWrapperPolicy(policy) {
  return policy.split(';').map(directive => directive.trim())
    .filter(directive => directive && !directive.startsWith('sandbox'))
    .map(directive => directive === "frame-src 'none'" ? "frame-src 'self'" : directive).join('; ');
}

export function previewPersistencePolicy(policy, persistence) {
  if (!persistence) return policy;
  return policy.replace(/connect-src[^;]*/, directive => directive.replace(/ 'none'/g, '') + ' ' + persistence.url.replace(/^https?:\/\//, ''));
}

export function previewStorageId(path, html, sessionId = '') {
  return createHash('sha256').update(JSON.stringify([sessionId, path, html])).digest('hex');
}

function serialize(value) {
  return JSON.stringify(value).replace(/[<\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// Runs before the generated document's scripts, inside its opaque-origin sandbox.
export function installPreviewStorage(channel, initialValues, persistence) {
  const values = new Map(Object.entries(initialValues));
  const maxKeys = 128;
  const maxBytes = 131072;
  const quotaError = () => new DOMException('此产物的保存内容超过限制', 'QuotaExceededError');
  function notify(operation, key, value) {
    if (persistence) {
      try {
        // localStorage is synchronous: return only after the host has durably saved.
        const request = new XMLHttpRequest();
        request.open('POST', persistence.url, false);
        request.withCredentials = true;
        request.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        request.send(JSON.stringify({ operation, key, value }));
        if (request.status !== 200) throw new Error('保存失败');
      } catch {
        parent.postMessage({ channel, operation: 'error' }, '*');
        throw new DOMException('未能保存此页面的操作，请重试', 'InvalidStateError');
      }
    }
    parent.postMessage({ channel, operation, key, value }, '*');
  }
  const methods = {
    getItem(key) { return values.get(String(key)) ?? null; },
    setItem(key, value) {
      key = String(key);
      value = String(value);
      const next = new Map(values).set(key, value);
      const bytes = new TextEncoder().encode(JSON.stringify(Object.fromEntries(next))).length;
      if (key.length > 256 || value.length > 32768 || next.size > maxKeys || bytes > maxBytes) throw quotaError();
      notify('set', key, value);
      values.set(key, value);
    },
    removeItem(key) { key = String(key); notify('remove', key); values.delete(key); },
    clear() { notify('clear'); values.clear(); },
    key(index) { return [...values.keys()][Number(index)] ?? null; }
  };
  const storage = new Proxy(Object.create(null), {
    get(_target, key) {
      if (key === 'length') return values.size;
      if (Object.hasOwn(methods, key)) return methods[key];
      return typeof key === 'string' ? values.get(key) : undefined;
    },
    set(_target, key, value) { methods.setItem(key, value); return true; },
    deleteProperty(_target, key) { methods.removeItem(key); return true; },
    ownKeys() { return [...values.keys()]; },
    has(_target, key) { return Object.hasOwn(methods, key) || values.has(key); },
    getOwnPropertyDescriptor(_target, key) {
      return values.has(key) ? { enumerable: true, configurable: true, value: values.get(key), writable: true } : undefined;
    }
  });
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.channel !== channel || event.data.operation !== 'sync') return;
    values.clear();
    for (const [key, value] of Object.entries(event.data.values)) values.set(key, value);
    window.dispatchEvent(new Event('storage'));
  });
}

// Only this trusted outer document can access browser storage. Each artifact has one namespace.
export function startPreviewStorage(scope, html, channel, childSource, persistence) {
  if (persistence) persistence = { ...persistence, url: new URL(new URL(persistence.url).pathname, window.location.href).href };
  const frame = document.getElementById('artifact-preview');
  const status = document.getElementById('preview-storage-status');
  function unavailable() {
    status.hidden = false;
    status.textContent = '浏览器未能保存此页面的操作，刷新后可能丢失。';
  }
  function valid(values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return false;
    const entries = Object.entries(values);
    return entries.length <= 128 && entries.every(([key, value]) => key.length <= 256 && typeof value === 'string' && value.length <= 32768)
      && new TextEncoder().encode(JSON.stringify(values)).length <= 131072;
  }
  function read(silent = false) {
    try {
      const values = JSON.parse(localStorage.getItem(scope) || '{}');
      if (valid(values)) return values;
    } catch { /* Storage may be disabled by the browser. */ }
    if (!silent) unavailable();
    return {};
  }
  function safeJson(value) { return JSON.stringify(value).replace(/</g, '\\u003c'); }
  let initial = persistence ? persistence.values : read();
  if (persistence && !persistence.initialized) {
    // Migrate previously saved browser-local values once. Empty saved files are authoritative.
    const legacy = read(true);
    if (Object.keys(legacy).length) {
      try {
        const request = new XMLHttpRequest();
        request.open('POST', persistence.url, false);
        request.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        request.send(JSON.stringify({ operation: 'seed', values: legacy }));
        if (request.status !== 200) throw new Error('保存失败');
        initial = JSON.parse(request.responseText);
      } catch { unavailable(); }
    }
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== frame.contentWindow || !message || message.channel !== channel) return;
    if (message.operation === 'error') { unavailable(); return; }
    if (persistence) return;
    const values = Object.assign(Object.create(null), read());
    if (message.operation === 'set') {
      if (typeof message.key !== 'string' || typeof message.value !== 'string') return;
      values[message.key] = message.value;
    } else if (message.operation === 'remove') {
      if (typeof message.key !== 'string') return;
      delete values[message.key];
    } else if (message.operation === 'clear') {
      for (const key of Object.keys(values)) delete values[key];
    } else return;
    if (!valid(values)) return;
    try { localStorage.setItem(scope, JSON.stringify(values)); }
    catch { unavailable(); }
  });
  window.addEventListener('storage', event => {
    if (persistence) return;
    if (event.key === scope || event.key === null) frame.contentWindow.postMessage({ channel, operation: 'sync', values: read() }, '*');
  });
  const bootstrap = '<' + 'script>(' + childSource + ')(' + safeJson(channel) + ',' + safeJson(initial) + ',' + safeJson(persistence || null) + ');<' + '/script>';
  // A standards-mode prefix also supports generated fragments that omit their document head.
  frame.srcdoc = '<!doctype html><meta http-equiv="Content-Security-Policy" content="frame-src \'none\'">' + bootstrap + html;
}

export function renderStatefulPreview(html, artifactId, interactive = false, persistence) {
  const channel = randomUUID();
  const scope = `pi-agent:artifact-storage:v1:${artifactId}`;
  // Bundlers can fold split closing-tag literals inside the serialized functions.
  const script = `(${startPreviewStorage.toString()})(${serialize(scope)},${serialize(html)},${serialize(channel)},${serialize(installPreviewStorage.toString())},${serialize(persistence || null)});`.replace(/<\/script/gi, '<\\/script');
  const sandbox = interactive ? 'allow-scripts allow-popups allow-forms allow-modals' : 'allow-scripts';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>产物预览</title><style>html,body{margin:0;height:100%;overflow:hidden}body{display:flex;flex-direction:column}#artifact-preview{border:0;width:100%;flex:1;min-height:0}#preview-storage-status{margin:0;padding:8px 12px;background:#fff5d6;color:#5c4200;font:14px/1.5 system-ui}</style></head><body><p id="preview-storage-status" role="status" hidden></p><iframe id="artifact-preview" title="产物内容" sandbox="${sandbox}"></iframe><script>${script}</script></body></html>`;
}
