import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const source = readFileSync(resolve('apps/homebrew/web/setup.js'), 'utf8');
const flush = () => new Promise(done => setTimeout(done, 5));

/** Minimal DOM: elements exist only for ids present in the last innerHTML and are re-created on every assignment, like the real wizard. */
function harness({ autofill, firstTaskFails = 0 }) {
  let html = '', elements = new Map(); const requests = [], assigned = []; let panelHtml = '', stepsHtml = '', failures = firstTaskFails;
  const make = () => ({ value: '', disabled: false, checked: false, listeners: {}, dataset: {}, addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }, fire(type, extra = {}) { if (type === 'click' && this.disabled) return; for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {}, target: this, ...extra }); } });
  const find = selector => { const id = /^#([\w-]+)$/.exec(selector)?.[1]; if (!id || !html.includes(`id="${id}"`)) return null; if (!elements.has(id)) elements.set(id, make()); return elements.get(id); };
  const panel = { querySelector: () => null, set innerHTML(value) {
    html = panelHtml = value; elements = new Map();
    // A browser's password manager fills a freshly inserted field once, after listeners are attached: here, the re-render while the check runs.
    if (autofill && /id="key"/.test(value) && value.includes('正在检查')) queueMicrotask(() => { const key = find('#key'); key.value = 'saved-admin-password'; key.fire('input'); });
  }, get innerHTML() { return html; } };
  const document = { querySelector: selector => selector === '#panel' ? panel : selector === '#steps' ? { set innerHTML(value) { stepsHtml = value; }, replaceChildren() {} } : find(selector), querySelectorAll: () => [] };
  const fetch = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined; requests.push({ path, body });
    if (path === '/api/local/first-task' && failures-- > 0) return { ok: false, json: async () => ({ error: '模型额度不足，请稍后重试' }) };
    const reply = path === '/api/local/first-task' ? { taskUrl: '/#/rt/rt-welcome' } : path === '/api/local/status' ? { configured: false, environment: { eligible: true, checks: [], facts: {} } } : path === '/api/local/model-check' ? { models: ['deepseek-chat'] } : { configured: true };
    return { ok: true, json: async () => reply };
  };
  vm.runInNewContext(source, { document, fetch, location: { hash: '', pathname: '/setup', assign: url => assigned.push(url), replace: url => assigned.push(url) }, history: { replaceState() {} }, window: { open() {} }, clearTimeout, setTimeout, console });
  return { find, requests, assigned, panel: () => panelHtml, steps: () => stepsHtml };
}
async function toKeyStep(h) {
  await flush(); h.find('#next').fire('click');
  h.find('#password').value = h.find('#confirm').value = 'synthetic-admin-pass-1'; h.find('#local').fire('submit'); await flush();
}

test('the API key field is not a password field, so password managers do not fill the admin password into it', async () => {
  const h = harness({ autofill: false }); await toKeyStep(h);
  const field = /<input id="key"[^>]*>/.exec(h.panel())?.[0] ?? '';
  assert.ok(field, 'step 3 renders the key field');
  assert.doesNotMatch(field, /type="password"/);
  assert.match(field, /autocomplete="off"/); assert.match(field, /data-secret/);
});

test('saving sends exactly the key that passed the check', async () => {
  const h = harness({ autofill: false }); await toKeyStep(h);
  const key = h.find('#key'); key.value = 'sk-correct'; key.fire('input');
  h.find('#connection').fire('click'); await flush();
  h.find('#next').fire('click'); await flush();
  assert.deepEqual(h.requests.find(r => r.path === '/api/local/model-check').body, { apiKey: 'sk-correct' });
  assert.equal(h.requests.find(r => r.path === '/api/local/initialize').body.model.apiKey, 'sk-correct');
});

test('if something still overwrites the key after the check, the wrong key is never saved', async () => {
  const h = harness({ autofill: true }); await toKeyStep(h);
  const key = h.find('#key'); key.value = 'sk-correct'; key.fire('input');
  h.find('#connection').fire('click'); await flush();
  h.find('#next').fire('click'); await flush();
  assert.equal(h.requests.find(r => r.path === '/api/local/model-check').body.apiKey, 'sk-correct');
  const saved = h.requests.find(r => r.path === '/api/local/initialize');
  assert.ok(!saved || saved.body.model.apiKey === 'sk-correct', 'a key that was not checked must not be submitted');
  assert.equal(JSON.stringify(h.requests).includes('saved-admin-password') && saved !== undefined, false);
});

async function saved(h) {
  await toKeyStep(h);
  const key = h.find('#key'); key.value = 'sk-correct'; key.fire('input');
  h.find('#connection').fire('click'); await flush();
  h.find('#next').fire('click'); await flush();
}

test('after saving, an API-key install starts the welcome session and goes straight into the app', async () => {
  const h = harness({ autofill: false }); await saved(h);
  const paths = h.requests.map(r => r.path);
  assert.ok(paths.indexOf('/api/local/first-task') > paths.indexOf('/api/local/initialize'), 'the welcome session is started after saving');
  assert.deepEqual(h.assigned, ['/#/rt/rt-welcome']);
  assert.doesNotMatch(h.panel(), /运行示例任务|完成设置/, 'the in-wizard sample task is gone');
});

test('if the welcome session cannot start, the saved setup is kept and the user can retry or enter the app', async () => {
  const h = harness({ autofill: false, firstTaskFails: 1 }); await saved(h);
  assert.deepEqual(h.assigned, []);
  assert.match(h.panel(), /模型额度不足/); assert.match(h.panel(), /id="retry-welcome"/); assert.match(h.panel(), /id="enter-app"/);
  assert.equal(h.requests.filter(r => r.path === '/api/local/initialize').length, 1, 'the configuration is not submitted again');
  h.find('#retry-welcome').fire('click'); await flush();
  assert.deepEqual(h.assigned, ['/#/rt/rt-welcome']);
});

test('the API-key flow shows three steps, not the old sample-task and finish pages', async () => {
  const h = harness({ autofill: false }); await saved(h);
  const labels = [...h.steps().matchAll(/<\/span>([^<]+)<\/li>/g)].map(m => m[1]);
  assert.deepEqual(labels, ['检查环境', '本机设置', '连接账号']);
});
