import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLocalService } from '../src/local-service.mjs';
import { checkModel } from '../src/model-check.mjs';
import { PREVIEW_WRAPPER_CSP } from '../src/preview-storage.mjs';

const origin = 'http://127.0.0.1:45123', token = 'a'.repeat(64);
async function fixture(t, overrides = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'pi-local-service-')); const root = join(parent, 'instance');
  const service = createLocalService({ root, origin, bootstrapToken: token, webRoot: resolve('apps/homebrew/web'), environment: () => ({ eligible: true, checks: [] }), modelCheck: async () => ['synthetic-model'], coreFactory: async () => { throw Error('test must explicitly inject its core'); }, ...overrides });
  t.after(async () => { await service.close(); rmSync(parent, { recursive: true, force: true }); });
  const call = (path, data, headers = {}) => service.fetch(new Request(origin + path, { method: data === undefined ? 'GET' : 'POST', headers: { host: new URL(origin).host, ...(data === undefined ? {} : { origin, 'content-type': 'application/json' }), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }));
  const response = await call('/api/local/bootstrap', {}, { authorization: `Bearer ${token}` });
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const authenticated = (path, data, headers) => call(path, data, { cookie, ...headers });
  return { root, call, authenticated };
}
const input = { password: 'synthetic-password-123', passwordConfirmation: 'synthetic-password-123', model: { provider: 'deepseek', id: 'synthetic-model', apiKey: 'synthetic-not-real-key' } };

test('unauthenticated and cross-origin calls cannot initialize or read private status', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/local/status')).status, 401);
  assert.equal((await f.authenticated('/api/local/initialize', input, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await f.authenticated('/api/local/status', undefined, { host: 'untrusted.example' })).status, 403);
});
test('model proof is required, bound to the tested key and returned model list', async t => {
  const f = await fixture(t);
  assert.equal((await f.authenticated('/api/local/initialize', input)).status, 409);
  assert.equal((await f.authenticated('/api/local/model-check', { apiKey: input.model.apiKey })).status, 200);
  assert.equal((await f.authenticated('/api/local/initialize', { ...input, model: { ...input.model, apiKey: 'different-key' } })).status, 409);
  assert.equal((await f.authenticated('/api/local/initialize', { ...input, model: { ...input.model, id: 'invented-model' } })).status, 409);
  assert.equal((await f.authenticated('/api/local/initialize', input)).status, 200);
  const status = await (await f.authenticated('/api/local/status')).json();
  assert.equal(status.acceptance.modelConnection, 'passed');
  assert.equal(status.acceptance.firstTask, 'pending');
  assert.equal(JSON.stringify(status).includes(input.model.apiKey), false);
  assert.equal((await f.authenticated('/api/local/initialize', input)).status, 409);
});
test('password login works after initialization without exposing stored credentials', async t => {
  const f = await fixture(t); await f.authenticated('/api/local/model-check', { apiKey: input.model.apiKey }); await f.authenticated('/api/local/initialize', input);
  assert.equal((await f.call('/api/local/login', { password: 'wrong' })).status, 401);
  const response = await f.call('/api/local/login', { password: input.password });
  assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const config = readFileSync(join(f.root, 'installation.json'), 'utf8'); assert.equal(config.includes(input.password), false);
});
test('a reported completed task without a real output file is not accepted', async t => {
  const binding = { status: 'idle', turns: [{ status: 'completed' }] };
  const checkedAt = '2026-11-15T01:00:00.000Z';
  let created = 0;
  let previewRequest;
  const runtime = {
    probe: async () => ({ checkedAt }),
    create: async input => {
      assert.equal(input.confirmedProfileVersion, checkedAt, 'first task must confirm the freshly probed runtime profile');
      created++;
      return { session: { platformSessionId: 'synthetic-session' } };
    },
    store: { binding: () => binding }
  };
  const previewPolicy = "default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; sandbox allow-scripts";
  const f = await fixture(t, { coreFactory: async () => ({ runtime, close() {}, fetch(request) {
    previewRequest = new URL(request.url);
    return new Response('<html>session preview</html>', { headers: { 'content-security-policy': previewPolicy, 'content-type': 'text/html; charset=utf-8' } });
  } }) });
  await f.authenticated('/api/local/model-check', { apiKey: input.model.apiKey }); await f.authenticated('/api/local/initialize', input);
  assert.equal((await f.authenticated('/api/local/first-task', {})).status, 202);
  assert.equal((await f.authenticated('/api/local/first-task', {})).status, 202);
  assert.equal(created, 1, 'retries must retain the original task session');
  let status = await (await f.authenticated('/api/local/status')).json(); assert.notEqual(status.acceptance.firstTask, 'passed');
  writeFileSync(join(f.root, 'workspaces/first-plan.html'), '<!doctype html><h1>synthetic fixture</h1>');
  binding.turns[0].status = 'failed';
  status = await (await f.authenticated('/api/local/status')).json(); assert.notEqual(status.acceptance.firstTask, 'passed');
  binding.turns[0].status = 'completed';
  status = await (await f.authenticated('/api/local/status')).json(); assert.equal(status.acceptance.firstTask, 'passed');
  const preview = await f.authenticated('/api/local/first-preview');
  assert.equal(preview.status, 200);
  assert.equal(previewRequest.pathname, '/api/runtime-sessions/synthetic-session/file-content');
  assert.equal(previewRequest.searchParams.get('path'), 'first-plan.html');
  assert.equal(preview.headers.get('content-security-policy'), PREVIEW_WRAPPER_CSP);
  assert.match(await preview.text(), /sandbox="allow-scripts"/);
});
test('vendor errors do not echo credentials or raw response bodies', async t => {
  const f = await fixture(t, { modelCheck: async () => { throw Error('raw vendor body synthetic-key'); } });
  const result = await f.authenticated('/api/local/model-check', { apiKey: 'synthetic-key' });
  assert.equal(result.status, 400); assert.equal((await result.text()).includes('synthetic-key'), false);
});
test('runtime record clients reach only the existing capability verifier without browser cookies', async t => {
  const f = await fixture(t, { coreFactory: async () => ({ fetch: async () => Response.json({ error: 'invalid scoped capability' }, { status: 401 }), close() {} }) });
  await f.authenticated('/api/local/model-check', { apiKey: input.model.apiKey }); await f.authenticated('/api/local/initialize', input);
  const headers = { origin: '', 'x-pi-record-capability': 'synthetic-invalid' };
  assert.equal((await f.call('/api/runtime-sessions/rt-synthetic/records', {}, headers)).status, 401);
  assert.equal((await f.call('/api/notes', {}, headers)).status, 403);
});
test('opaque preview writes reach only the scoped state verifier without opening other APIs', async t => {
  let forwarded=0;
  const f = await fixture(t, { coreFactory: async () => ({ fetch: async () => {forwarded++;return Response.json({error:'invalid capability'},{status:403});}, close() {} }) });
  await f.authenticated('/api/local/model-check', { apiKey: input.model.apiKey }); await f.authenticated('/api/local/initialize', input);
  assert.equal((await f.call('/api/preview-storage/'+'a'.repeat(64), {operation:'clear'}, {origin:'null'})).status,403);
  assert.equal(forwarded,1);
  assert.equal((await f.call('/api/preview-storage/invalid', {}, {origin:'null'})).status,403);
  assert.equal((await f.call('/api/notes', {}, {origin:'null'})).status,403);
  assert.equal(forwarded,1);
});
test('model check uses a fixed HTTPS supplier endpoint, refuses redirects and filters model IDs', async () => {
  const models = await checkModel('synthetic-key', async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/models'); assert.equal(options.redirect, 'error');
    return Response.json({ data: [{ id: 'model-a' }, { id: '<script>' }, { id: 'model-a' }] });
  });
  assert.deepEqual(models, ['model-a']);
  await assert.rejects(() => checkModel('synthetic-key', async () => new Response('synthetic-sensitive-body', { status: 401 })), /拒绝/);
});

const networkFixture = (runtime, allowed = true) => ({ networkId: 'fixture-network', report: {
  runtime, networkId: 'fixture-network', checkedAt: Date.now(), checks: {
    region: { status: allowed ? 'passed' : 'unknown', source: 'fixture' }, connectivity: { status: 'passed', source: 'fixture' },
    networkType: { status: 'passed', source: 'fixture', value: 'non-datacenter' }
  }
} });
for (const runtimeKind of ['codex', 'claude-code']) {
  test(`${runtimeKind}: optional initialization does not require DeepSeek; every side effect rechecks network`, async t => {
    let allowed = true, installations = 0, logins = 0, tasks = 0;
    const runtime = { probe: async () => ({ state: 'executable', checkedAt: 'fresh-profile', models: [{ id: 'synthetic-native', isDefault: true }] }),
      create: async args => { assert.equal(args.runtimeKind, runtimeKind); tasks++; return {session:{platformSessionId:'optional-test-session'}}; },
      store: { binding: () => ({status:'idle',turns:[{status:'completed'}]}) } };
    const f = await fixture(t, { networkInspector: async (kind, key) => { assert.equal(key, 'own-network-key'); return networkFixture(kind, allowed); },
      componentInstall: async kind => { assert.equal(kind, runtimeKind); installations++; return {installed:true}; },
      coreFactory: async () => ({runtime, beginLogin: async () => {logins++;return {authUrl:'https://auth.openai.com/test-fixture'};}, close() {}}) });
    const init = {password:input.password,passwordConfirmation:input.passwordConfirmation,runtimeKind};
    const check = await f.authenticated('/api/local/network-check',{runtimeKind,apiKey:'own-network-key'});
    assert.equal(check.status,200); assert.equal((await check.text()).includes('own-network-key'),false);
    allowed=false;
    assert.equal((await f.authenticated('/api/local/initialize',init)).status,409,'a client-side pass cannot bypass a fresh check');
    allowed=true;
    assert.equal((await f.authenticated('/api/local/initialize',init)).status,200);
    assert.deepEqual(JSON.parse(readFileSync(join(f.root,'credentials/pi/auth.json'))),{});
    assert.equal((await f.authenticated('/api/runtime-sessions')).status,409,'workbench API cannot bypass onboarding');
    assert.equal((await f.authenticated('/api/local/first-task',{})).status,409);
    allowed=false;
    assert.equal((await f.authenticated('/api/local/runtime-install',{})).status,409);assert.equal(installations,0);
    allowed=true;
    assert.equal((await f.authenticated('/api/local/runtime-install',{})).status,200);assert.equal(installations,1);
    allowed=false;
    assert.equal((await f.authenticated('/api/local/runtime-login',{})).status,409);assert.equal(logins,0);
    allowed=true;
    assert.equal((await f.authenticated('/api/local/runtime-login',{})).status,200);
    assert.equal((await f.authenticated('/api/local/runtime-account',{})).status,200);
    allowed=false;
    assert.equal((await f.authenticated('/api/local/first-task',{})).status,409);assert.equal(tasks,0);
    allowed=true;
    assert.equal((await f.authenticated('/api/local/first-task',{})).status,202);assert.equal(tasks,1);
    let status=await(await f.authenticated('/api/local/status')).json();assert.notEqual(status.acceptance.firstTask,'passed');
    writeFileSync(join(f.root,'workspaces/first-plan.html'),'<!doctype html><input type="checkbox">');
    status=await(await f.authenticated('/api/local/status')).json();assert.equal(status.acceptance.firstTask,'passed');
  });
}
test('network check is authenticated, fixed to installed selection and secrets are never returned', async t => {
  let kind, key;
  const f=await fixture(t,{networkInspector:async(k,value)=>{kind=k;key=value;return networkFixture(k);}});
  assert.equal((await f.call('/api/local/network-check',{runtimeKind:'codex'})).status,401);
  assert.equal((await f.authenticated('/api/local/network-check',{runtimeKind:'other'})).status,400);
  await f.authenticated('/api/local/network-check',{runtimeKind:'codex',apiKey:'first-private-key'});
  await f.authenticated('/api/local/initialize',{password:input.password,passwordConfirmation:input.passwordConfirmation,runtimeKind:'codex'});
  const result=await f.authenticated('/api/local/network-check',{runtimeKind:'claude-code',apiKey:'replacement-private-key'});
  assert.equal(kind,'codex');assert.equal(key,'replacement-private-key');
  assert.equal((await result.text()).includes('replacement-private-key'),false);
  assert.equal(JSON.parse(readFileSync(join(f.root,'credentials/network.json'))).ipapiKey,'replacement-private-key');
});
