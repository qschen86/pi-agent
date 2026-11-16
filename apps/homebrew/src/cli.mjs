#!/usr/bin/env node
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dataParent, privateDirectory, readControl, inspectService, acquireInstanceLock, publishControl, removeControl, rejectLegacyOwner } from './service-control.mjs';

const payloadRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const version = JSON.parse(readFileSync(join(payloadRoot, 'package.json'), 'utf8')).version;

export function parseArgs(args) {
  const command = args.shift() || 'help';
  if (!['open', 'status', '--version', 'serve', 'help', '--help'].includes(command)) throw Error('未知命令；使用 pi-agent --help');
  let base = dataParent(), json = false;
  while (args.length) {
    const option = args.shift();
    if (option === '--data-parent' && args[0] && !args[0].startsWith('--')) base = resolve(args.shift());
    else if (option === '--json' && command === 'status') json = true;
    else throw Error(`无效参数：${option}`);
  }
  return { command, base, json };
}
const scrubEnvironment = () => {
  for (const name of Object.keys(process.env)) {
    if (/^(?:PI_|PI_AGENT_|PI_RUNTIME_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|DEEPSEEK_|GOOGLE_API_|GEMINI_|ZHIPU_|DASHSCOPE_|AZURE_OPENAI_)/.test(name) || /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN)$/.test(name) || ['NODE_OPTIONS', 'NODE_PATH'].includes(name)) delete process.env[name];
  }
};
async function serve(base) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Homebrew 首发仅支持 Apple Silicon macOS');
  privateDirectory(base);
  const unlock = acquireInstanceLock(base);
  try { await rejectLegacyOwner(base); } catch (error) { unlock(); throw error; }
  scrubEnvironment();
  const root = join(base, 'instance'), token = randomBytes(32).toString('hex'), instanceId = randomBytes(16).toString('hex');
  let origin, service, closing = false;
  const server = createServer(async (req, res) => {
    try {
      if (!service) { res.writeHead(503); res.end('服务正在启动'); return; }
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 32 * 1024 ** 2) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
      if (req.url === '/api/local/identity') {
        const authorization = req.headers.authorization || '', expected = `Bearer ${token}`;
        if (req.method !== 'POST' || req.headers.origin !== origin || req.headers.host !== new URL(origin).host ||
          authorization.length !== expected.length || !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))) {
          res.writeHead(403); res.end(); return;
        }
        const { challenge } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!/^[a-f0-9]{32}$/.test(challenge ?? '')) { res.writeHead(400); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ pid: process.pid, root, instanceId, version, challenge })); return;
      }
      const controller = new AbortController(); res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      const request = new Request(origin + req.url, { method: req.method, headers: req.headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}), signal: controller.signal });
      const response = await service.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).on('error', () => res.destroy()).pipe(res); else res.end();
    } catch { if (!res.headersSent) res.writeHead(500); res.end('本机服务暂不可用'); }
  });
  const close = async () => {
    if (closing) return; closing = true;
    const timeout = setTimeout(() => process.exit(1), 5000); timeout.unref();
    try { await service?.close(); }
    finally {
      server.closeAllConnections(); await new Promise(yes => server.close(yes));
      removeControl(base, instanceId); unlock(); clearTimeout(timeout);
    }
  };
  try {
    const { createLocalService } = await import('./local-service.mjs');
    const { checkModel } = await import('./model-check.mjs');
    const { createNetworkInspector } = await import('./network-host.mjs');
    const { installOptionalRuntime } = await import('./optional-installer.mjs');
    server.listen(0, '127.0.0.1');
    await new Promise((yes, no) => { server.once('listening', yes); server.once('error', no); });
    origin = `http://127.0.0.1:${server.address().port}`;
    service = createLocalService({ root, origin, bootstrapToken: token, webRoot: join(payloadRoot, 'apps/homebrew/web'),
      networkInspector: createNetworkInspector({ root, manifestRoot: join(payloadRoot, 'apps/homebrew/runtime-manifests') }),
      componentInstall: runtime => installOptionalRuntime({ root, runtime, manifestRoot: join(payloadRoot, 'apps/homebrew/runtime-manifests'), npmCli: join(payloadRoot, 'node_modules/npm/bin/npm-cli.js') }),
      modelCheck: async key => {
        const available = await checkModel(key);
        const supported = JSON.parse(readFileSync(join(payloadRoot, 'runtime-locations.json'), 'utf8')).supportedModels;
        const models = available.filter(id => supported.includes(id));
        if (!models.length) throw Error('账号没有当前发行版支持的模型，请升级后重试');
        return models;
      },
      // Homebrew owns autostart. Do not install a second LaunchAgent.
      coreFactory: async options => (await import(join(payloadRoot, 'bundle/core.mjs'))).createCore({ ...options, payloadRoot })
    });
    publishControl(base, { schema: 2, pid: process.pid, root, origin, token, instanceId });
    console.log(`pi-agent ${version} 已启动：${origin}`);
    process.once('SIGTERM', () => close().catch(() => { process.exitCode = 1; }));
    process.once('SIGINT', () => close().catch(() => { process.exitCode = 1; }));
  } catch (error) { await close(); throw error; }
}
async function openBrowser(url) {
  const child = spawn('/usr/bin/open', [url], { stdio: 'ignore' });
  await new Promise((yes, no) => { child.once('error', no); child.once('exit', code => code === 0 ? yes() : no(Error('浏览器打开失败，请检查系统默认浏览器'))); });
}
export async function main(args = process.argv.slice(2), deps = {}) {
  const { command, base, json } = parseArgs([...args]);
  if (command === '--version') { console.log(version); return; }
  if (command === 'help' || command === '--help') {
    console.log('pi-agent --version | open | status [--json] | serve\n实例选项：--data-parent <目录>\n启动后台服务：brew services start pi-agent'); return;
  }
  if (command === 'serve') return serve(base);
  const state = await inspectService(base);
  if (command === 'status') { console.log(json ? JSON.stringify(state) : state.state === 'running' ? `running · ${state.version} · PID ${state.pid} · ${state.origin}` : state.state === 'unverified' ? 'unverified · 进程仍存在但服务身份未确认，请检查后再操作数据' : 'stopped'); if (state.state === 'unverified') process.exitCode = 2; return; }
  if (state.state !== 'running') throw Error('服务未运行，请先执行 brew services start pi-agent');
  const record = readControl(base);
  if (!record || record.origin !== state.origin || record.pid !== state.pid) throw Error('服务状态已变化，请重试');
  await (deps.openBrowser ?? openBrowser)(`${record.origin}/setup#${record.token}`);
  console.log('已在默认浏览器打开 pi-agent');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
