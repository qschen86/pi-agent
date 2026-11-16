import { existsSync, readFileSync, writeFileSync, renameSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { initializeInstallation, readInstallation, verifyPassword } from './initialization.mjs';
import { inspectEnvironment } from './preflight.mjs';
import { checkModel } from './model-check.mjs';
import { PREVIEW_WRAPPER_CSP, renderStatefulPreview } from './preview-storage.mjs';
import { evaluateRuntimeNetwork, withRuntimeNetworkGate } from './runtime-network-gate.mjs';

const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const hash = text => createHash('sha256').update(text).digest('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const safeHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };

export function createLocalService({ root, origin, bootstrapToken, webRoot, coreFactory, setAutoStart, networkInspector, componentInstall, environment = () => inspectEnvironment(root), modelCheck = checkModel }) {
  const sessions = new Set(); let proof; let corePromise; let busy = false; let attempts = 0; let loginWindow = Date.now();
  let networkKey;
  const installed = () => existsSync(join(root, 'installation.json'));
  const core = () => corePromise ??= Promise.resolve().then(() => coreFactory({ root, port: Number(new URL(origin).port) })).catch(error => { corePromise = undefined; throw error; });
  const cookie = request => /(?:^|;\s*)pi_local_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get('cookie') ?? '')?.[1];
  const authenticated = request => sessions.has(cookie(request));
  const issueSession = () => { const token = randomBytes(32).toString('hex'); if (sessions.size >= 32) sessions.delete(sessions.values().next().value); sessions.add(token); return token; };
  const responseWithSession = () => { const result = json({ ok: true }); result.headers.set('set-cookie', `pi_local_session=${issueSession()}; HttpOnly; SameSite=Strict; Path=/`); return result; };
  const saveConfig = config => {
    const temporary = join(root, `.installation-${randomBytes(8).toString('hex')}`);
    writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temporary, join(root, 'installation.json'));
  };
  const body = async request => { const text = await request.text(); if (Buffer.byteLength(text) > 16_384) throw Error('输入内容过大'); try { return JSON.parse(text); } catch { throw Error('请求格式无效'); } };
  const optionalKind = kind => ['codex', 'claude-code'].includes(kind);
  const inspectNetwork = async kind => {
    if (!optionalKind(kind) || !networkInspector) throw Error('网络检测暂不可用');
    let key = networkKey;
    if (key === undefined && installed() && existsSync(join(root, 'credentials/network.json'))) key = JSON.parse(readFileSync(join(root, 'credentials/network.json'), 'utf8')).ipapiKey;
    return networkInspector(kind, key);
  };
  const gated = (runtime, stage, operation) => withRuntimeNetworkGate({ runtime, stage, inspect: inspectNetwork, operation });
  async function status() {
    if (!installed()) return { configured: false, environment: environment() };
    const config = readInstallation(root);
    const task = config.acceptance.taskSession;
    if (task && config.acceptance.firstTask !== 'passed') {
      const app = await core(); const session = app.runtime.store.binding(task);
      const turn = session?.turns?.at(-1);
      const file = join(root, 'workspaces/first-plan.html');
      if (session?.status === 'idle' && turn?.status === 'completed' && existsSync(file) && lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink() && lstatSync(file).size > 0 && lstatSync(file).size <= 5 * 1024 ** 2) {
        config.acceptance.firstTask = 'passed'; config.state = 'ready'; saveConfig(config);
      }
      return { configured: true, acceptance: config.acceptance, taskStatus: turn?.status ?? session?.status, taskUrl: `/#/rt/${encodeURIComponent(task)}`, previewUrl: '/api/local/first-preview', model: config.model, runtimeKind: config.runtimeKind || 'pi', onboarding: config.onboarding };
    }
    return { configured: true, acceptance: config.acceptance, model: config.model, runtimeKind: config.runtimeKind || 'pi', onboarding: config.onboarding };
  }
  async function handle(request) {
    const url = new URL(request.url);
    if (url.origin !== origin || request.headers.get('host') && request.headers.get('host') !== new URL(origin).host) return json({ error: '访问地址无效' }, 403);
    // Single-artifact capability is validated by core; no platform cookie is exposed to the sandbox.
    if (installed() && /^\/api\/preview-storage\/[a-f0-9]{64}$/.test(url.pathname)) return (await core()).fetch(request);
    // The existing per-turn record protocol authenticates its own scoped capability, not browser cookies.
    if (installed() && request.method === 'POST' && /^\/api\/runtime-sessions\/rt-[\w-]+\/records$/.test(url.pathname) && request.headers.has('x-pi-record-capability')) return (await core()).fetch(request);
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers.get('origin') !== origin) return json({ error: '跨站请求被拒绝' }, 403);
    if (url.pathname === '/api/local/bootstrap' && request.method === 'POST') {
      if (!same(request.headers.get('authorization'), `Bearer ${bootstrapToken}`)) return json({ error: '请从本机应用重新打开工作台' }, 401);
      return responseWithSession();
    }
    if (url.pathname === '/api/local/login' && request.method === 'POST') {
      if (Date.now() - loginWindow > 15 * 60_000) { attempts = 0; loginWindow = Date.now(); }
      if (++attempts > 10) return json({ error: '登录尝试过多，请稍后重试' }, 429);
      const input = await body(request);
      if (!installed() || !verifyPassword(input.password, JSON.parse(readFileSync(join(root, 'credentials/admin.json'), 'utf8')))) return json({ error: '密码不正确' }, 401);
      attempts = 0; return responseWithSession();
    }
    if (url.pathname === '/setup' || url.pathname === '/login' || url.pathname === '/setup.js' || url.pathname === '/setup.css') {
      const file = url.pathname === '/setup.js' ? 'setup.js' : url.pathname === '/setup.css' ? 'setup.css' : 'setup.html';
      return new Response(readFileSync(join(webRoot, file)), { headers: { ...safeHeaders, 'content-type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8' } });
    }
    if (!authenticated(request)) {
      if (url.pathname.startsWith('/api/')) return json({ error: '请先登录' }, 401);
      return Response.redirect(`${origin}/login`, 302);
    }
    if (url.pathname === '/api/local/status' && request.method === 'GET') return json(await status());
    if (url.pathname === '/api/local/network-check' && request.method === 'POST') {
      const input = await body(request);
      const kind = installed() ? readInstallation(root).runtimeKind : input.runtimeKind;
      if (!optionalKind(kind)) return json({ error: '请选择 Codex 或 Claude Code' }, 400);
      if (input.apiKey !== undefined) {
        if (typeof input.apiKey !== 'string' || input.apiKey.length > 4096 || /[\r\n\0]/.test(input.apiKey)) return json({ error: '网络检测 Key 无效' }, 400);
        networkKey = input.apiKey.trim() || undefined;
        if (installed() && networkKey) {
          const temporary = join(root, 'credentials', `.network-${randomBytes(8).toString('hex')}`);
          writeFileSync(temporary, JSON.stringify({ ipapiKey: networkKey }) + '\n', { mode: 0o600, flag: 'wx' });
          renameSync(temporary, join(root, 'credentials/network.json')); networkKey = undefined;
        }
      }
      const result = await inspectNetwork(kind);
      return json({ ...result, decision: evaluateRuntimeNetwork({ runtime: kind, ...result }) });
    }
    if (['/api/local/runtime-install', '/api/local/runtime-login', '/api/local/runtime-account'].includes(url.pathname) && request.method === 'POST') {
      if (!installed()) return json({ error: '请先保存本机设置' }, 409);
      if (busy) return json({ error: '正在处理，请稍后重试' }, 409);
      const config = readInstallation(root); const kind = config.runtimeKind;
      if (!optionalKind(kind)) return json({ error: '当前实例未选择可选运行时' }, 409);
      busy = true;
      try {
        if (url.pathname.endsWith('runtime-install')) {
          if (!componentInstall) return json({ error: '安装工具未就绪' }, 409);
          const result = await gated(kind, 'install', () => componentInstall(kind));
          config.onboarding.component = 'installed'; saveConfig(config);
          return json(result);
        }
        if (config.onboarding?.component !== 'installed') return json({ error: '请先安装运行时组件' }, 409);
        return await gated(kind, 'login', async () => {
          const app = await core();
          if (url.pathname.endsWith('runtime-login')) return json(await app.beginLogin(kind));
          const profile = await app.runtime.probe(kind);
          if (profile.state !== 'executable' || !profile.models?.length) return json({ error: '账号尚未就绪，请完成官方登录后重试' }, 409);
          const model = profile.models.find(model => model.isDefault) || profile.models[0];
          config.model = { provider: kind, id: model.id }; config.onboarding.login = 'passed';
          config.acceptance.modelConnection = 'passed'; saveConfig(config);
          return json({ connected: true, model: config.model });
        });
      } finally { busy = false; }
    }
    if (url.pathname === '/api/local/autostart' && request.method === 'POST') {
      if (!installed()) return json({ error: '请先完成初始化' }, 409);
      const input = await body(request);
      if (typeof input.enabled !== 'boolean' || !setAutoStart) return json({ error: '自动启动暂不可用' }, 400);
      await setAutoStart(input.enabled);
      const config = readInstallation(root); config.autoStart = input.enabled; saveConfig(config);
      return json({ enabled: input.enabled });
    }
    if (url.pathname === '/api/local/model-check' && request.method === 'POST') {
      if (installed()) return json({ error: '实例已经初始化' }, 409);
      const input = await body(request); const models = await modelCheck(input.apiKey);
      proof = { keyHash: hash(input.apiKey.trim()), models, expires: Date.now() + 10 * 60_000 };
      return json({ models });
    }
    if (url.pathname === '/api/local/initialize' && request.method === 'POST') {
      if (busy || installed()) return json({ error: '实例已初始化或正在处理' }, 409);
      busy = true;
      try {
        const input = await body(request);
        if (optionalKind(input.runtimeKind)) {
          await gated(input.runtimeKind, 'install', async () => {
            initializeInstallation({ ...input, root, environment: environment(), networkApiKey: networkKey });
          });
          networkKey = undefined;
          return json({ configured: true });
        }
        if (!proof || proof.expires < Date.now() || !same(proof.keyHash, hash(String(input.model?.apiKey ?? '').trim())) || !proof.models.includes(input.model?.id)) return json({ error: '请先完成模型连接检查' }, 409);
        initializeInstallation({ ...input, root, environment: environment() });
        const config = readInstallation(root); config.model = { provider: input.model.provider, id: input.model.id }; config.acceptance.modelConnection = 'passed'; saveConfig(config);
        proof = undefined;
        return json({ configured: true });
      } finally { busy = false; }
    }
    if (url.pathname === '/api/local/first-task' && request.method === 'POST') {
      if (!installed()) return json({ error: '请先完成初始化' }, 409);
      if (busy) return json({ error: '正在处理，请稍后查看结果' }, 409);
      busy = true;
      try {
        const config = readInstallation(root); const kind = config.runtimeKind || 'pi';
        if (optionalKind(kind) && (config.onboarding?.login !== 'passed' || config.acceptance.modelConnection !== 'passed')) return json({ error: '请先完成组件安装和账号连接检查' }, 409);
        if (!config.acceptance.taskSession) {
          const createTask = async () => {
          const app = await core(); const profile = await app.runtime.probe(kind);
          return app.runtime.create({ runtimeKind: kind, confirmedProfileVersion: profile.checkedAt, workspace: join(root, 'workspaces'), model: kind === 'pi' ? `deepseek/${config.model.id}` : config.model.id, permissionMode: kind === 'pi' ? 'pi-ask' : kind === 'codex' ? 'ask' : 'default', worktree: false, prompt: '请生成一份中文的本周计划清单，保存为工作目录内 first-plan.html，使用自包含 HTML 和可勾选的复选框。不要访问外部网站，不要读取其他文件。在回复中引用这个文件，方便我预览。', idempotencyKey: 'installation-first-task-v1' }, 'local-installer');
          };
          const result = optionalKind(kind) ? await gated(kind, 'first-task', createTask) : await createTask();
          config.acceptance.taskSession = result.session.platformSessionId; config.acceptance.firstTask = 'running'; saveConfig(config);
        }
        return json(await status(), 202);
      } finally { busy = false; }
    }
    if (url.pathname === '/api/local/first-preview' && request.method === 'GET' && installed()) {
      const task = readInstallation(root).acceptance.taskSession;
      if (!task) return json({ error: '产物尚未生成' }, 404);
      // Reuse the session's path validation and isolated HTML policy, including inline interactions.
      const preview = new URL(`/api/runtime-sessions/${encodeURIComponent(task)}/file-content`, origin);
      preview.searchParams.set('path', 'first-plan.html');
      const response = await (await core()).fetch(new Request(preview, { headers: request.headers }));
      if (response.headers.get('x-pi-html-preview') === 'stateful-v1') return response;
      if (!response.ok || !response.headers.get('content-type')?.startsWith('text/html')) return response;
      const html = await response.text();
      const artifactId = hash(`${root}\n${task}\n${html}`);
      return new Response(renderStatefulPreview(html, artifactId), { headers: {
        ...safeHeaders, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PREVIEW_WRAPPER_CSP
      } });
    }
    if (!installed()) return Response.redirect(`${origin}/setup`, 302);
    const installation = readInstallation(root);
    if (optionalKind(installation.runtimeKind) && !installation.acceptance.taskSession) {
      if (url.pathname.startsWith('/api/')) return json({ error: '请先在初始化向导完成账号连接并启动首次任务' }, 409);
      return Response.redirect(`${origin}/setup`, 302);
    }
    return (await core()).fetch(request);
  }
  return {
    async fetch(request) {
      try { return await handle(request); }
      catch (error) {
        if (error.code === 'RUNTIME_NETWORK_BLOCKED') return json({ error: '网络检查未通过，已阻止此操作。请重新检查网络。', decision: error.decision }, 409);
        // Never return vendor bodies, stack traces, filesystem contents or submitted credentials.
        const known = /^(请输入|模型服务|账号没有|无法连接|两次密码|管理员密码|设备检查|数据位置|数据目录|模型配置|输入内容|请求格式)/.test(error.message ?? '');
        return json({ error: known ? error.message : '操作未完成，请检查设置或导出本机诊断后重试' }, 400);
      }
    },
    async close() { if (corePromise) await (await corePromise).close(); }
  };
}
