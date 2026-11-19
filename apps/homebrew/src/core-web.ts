import { ConsoleService } from '../../web/src/console.js';
import { createWebApp } from '../../web/src/server.js';
import { RuntimeSessionManager } from '../../../packages/runtime-sessions/src/manager.js';
import { PiDriver } from '../../../packages/runtime-sessions/src/pi.js';
import { CodexDriver } from '../../../packages/runtime-sessions/src/codex.js';
import { CodexAppServerClient } from '../../../packages/runtime-sessions/src/codex-client.js';
import { ClaudeDriver, type ClaudeSdkPort } from '../../../packages/runtime-sessions/src/claude.js';
import { nativeModelPort } from './native-model-port.js';
import { componentBinary, componentPath } from './optional-installer.mjs';
import { isolatedEnv } from './network-host.mjs';
import { onboardingRepliesFor } from './onboarding.mjs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { piModelPort } from '../../../packages/model-port/src/index.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { RuntimeDriver } from '../../../packages/runtime-sessions/src/driver.js';

const omitted = /^\/(?:share(?:\/|$)|artifacts\/(?!collections)|api\/(?:ledger|communications|android|native-notifications|lan|game-companion|challenge|wrong-book|artifact-shares|eval)(?:\/|$))/;
const disabledDriver = (kind: 'codex' | 'claude-code') => ({
  kind, probe: async () => ({ state: 'not-installed', stateReason: '此运行时为可选组件，基础安装未启用', models: [], capabilities: {}, configSummary: [], permissions: { label: '', detail: '' } }),
  listHistory: async () => ({ items: [], coverage: 'complete', notes: [] }), fingerprint: async () => undefined,
  findClientMessage: async () => undefined, rateLimits: async () => undefined, shutdown() {},
  startTurn: async () => { throw Error('运行时未安装'); }, readHistory: async () => { throw Error('运行时未安装'); }
}) as unknown as RuntimeDriver;

export async function createCore({ root, port, payloadRoot }: { root: string; port: number; payloadRoot: string }) {
  const config = JSON.parse(readFileSync(join(root, 'credentials/pi/settings.json'), 'utf8'));
  const installation = () => JSON.parse(readFileSync(join(root, 'installation.json'), 'utf8'));
  const selected = installation().runtimeKind || 'pi';
  const locations = JSON.parse(readFileSync(join(payloadRoot, 'runtime-locations.json'), 'utf8'));
  const piBinary = join(payloadRoot, locations.pi);
  process.env.PATH = `${join(payloadRoot, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`;
  const piConfigDir = join(root, 'credentials/pi');
  process.env.PI_CODING_AGENT_DIR = piConfigDir;
  process.env.PI_AGENT_PI_CONFIG = piConfigDir;
  process.env.PI_AGENT_CONSOLE_PORT = String(port);
  process.env.PI_AGENT_PREFERRED_ORIGIN = 'off';
  process.env.PI_AGENT_GUI_ROOT = root;
  process.env.CODEX_HOME = join(root, 'credentials/codex');
  process.env.CLAUDE_CONFIG_DIR = join(root, 'credentials/claude');
  process.env.PI_RUNTIME_REGISTRATION = join(root, 'runtime/connection.json');
  process.env.PI_RUNTIME_STATE_DIR = join(root, 'runtime/state');
  process.env.PI_RUNTIME_PI_BINARY = piBinary;
  let optional: RuntimeDriver | undefined;
  const env: Record<string, string> = { ...isolatedEnv(root), PI_AGENT_CONSOLE_PORT: String(port) };
  if (selected === 'codex') optional = new CodexDriver({ binaryPath: componentBinary(root, selected), candidates: [], codexHome: env.CODEX_HOME, evaluationRoot: join(root, 'runtime/codex-evaluation'),
    clientFactory: (binaryPath, options) => {
      const client = new CodexAppServerClient({ binaryPath, ...options, env: { ...env, ...options?.env }, cwd: options?.cwd || join(root, 'workspaces') });
      const request = client.request.bind(client);
      client.request = (method, params) => {
        const input = params as { cwd?: string; config?: Record<string, unknown> } | undefined;
        if (method === 'thread/start' && input?.cwd?.startsWith(join(root, 'runtime/completions') + '/')) {
          return request(method, { ...input, ephemeral: true, dynamicTools: [], selectedCapabilityRoots: [], environments: [], config: { ...input.config,
            'features.shell_tool': false, 'features.unified_exec': false, 'features.view_image': false, 'features.multi_agent': false,
            'features.multi_agent_v2': false, 'features.hooks': false, 'features.plugins': false, 'web_search': 'disabled',
            'apps._default.enabled': false, mcp_servers: {}, project_doc_max_bytes: 0
          } });
        }
        return request(method, params);
      };
      return client;
    } });
  if (selected === 'claude-code') {
    const req = createRequire(join(componentPath(root, selected), 'package.json'));
    const loaded = await import(pathToFileURL(req.resolve('@anthropic-ai/claude-agent-sdk')).href) as ClaudeSdkPort;
    const sdk: ClaudeSdkPort = { ...loaded, query: args => loaded.query({ ...args, options: { ...args.options,
      ...(args.options?.cwd?.startsWith(join(root, 'runtime/completions') + '/') ? { tools: [], mcpServers: {}, plugins: [], strictMcpConfig: true } : {}),
      env: { ...args.options?.env, ...env }, settingSources: [], executable: 'node', executableArgs: [] } }) };
    const sdkRoot = dirname(req.resolve('@anthropic-ai/claude-agent-sdk'));
    const sdkVersion = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8')).version;
    let cliVersion = '未知';
    try { cliVersion = JSON.parse(readFileSync(join(sdkRoot, 'manifest.json'), 'utf8')).version; } catch { /* Do not invent a native version. */ }
    optional = new ClaudeDriver({ sdk, home: env.HOME, versions: { sdk: sdkVersion, cli: cliVersion }, evaluationRoot: join(root, 'runtime/claude-evaluation') });
  }
  const raw = piModelPort({ piConfigDir, bin: piBinary });
  const modelPort = optional ? nativeModelPort(root, optional, () => installation().model?.id) : { complete: (role: Parameters<typeof raw.complete>[0], call: Parameters<typeof raw.complete>[1]) => raw.complete({ ...role, provider: config.defaultProvider, model: config.defaultModel }, call) };
  const dataDir = join(root, 'data');
  const svc = new ConsoleService({ dataDir, repoRoot: payloadRoot, pi: { configDir: piConfigDir, bin: piBinary }, runtimeConfigs: { home: root, dirs: { pi: piConfigDir, codex: join(root, 'credentials/codex'), 'claude-code': join(root, 'credentials/claude') } }, noteClassification: { port: modelPort } });
  const runtime = new RuntimeSessionManager({ dataDir, titlePort: modelPort, drivers: {
    codex: selected === 'codex' ? optional! : disabledDriver('codex'), 'claude-code': selected === 'claude-code' ? optional! : disabledDriver('claude-code'),
    pi: new PiDriver({ sourceAgentDir: piConfigDir, sessionDir: join(dataDir, 'runtime/pi-sessions'), binaryPath: piBinary, runtimeExecutable: join(payloadRoot, 'bin/pi-runtime') })
  } });
  await runtime.recovered;
  // The install-time welcome session offers preset first tasks until the user replies; every other session keeps normal extraction.
  runtime.setQuickReplyOverride((id, context) => onboardingRepliesFor(installation(), id, context.turnCount));
  const workspace = join(root, 'workspaces');
  if (!runtime.settings().workspaceRoots.length) runtime.updateSettings({ ...runtime.settings(), workspaceRoots: [workspace] }, 'local-installer');
  const shutdown = new AbortController();
  const app = createWebApp(svc, { dataDir, port, runtime, memoryTitlePort: modelPort, shutdownSignal: shutdown.signal, memorySyncEnabled: false, agentCalendar: { home: root, launchAgentsDir: join(root, 'runtime/launchagents'), timeZone: 'Asia/Shanghai' } });
  let loginClient: CodexAppServerClient | undefined;
  let claudeLogin: ReturnType<typeof spawn> | undefined;
  return {
    runtime,
    async beginLogin(kind: string) {
      if (kind !== selected) throw Error('运行时选择无效');
      if (kind === 'codex') {
        if (loginClient) throw Error('登录正在进行，请先完成官方登录');
        loginClient = new CodexAppServerClient({ binaryPath: componentBinary(root, 'codex'), env, cwd: join(root, 'workspaces') });
        const pending = loginClient;
        const release = () => { pending.stop(); if (loginClient === pending) loginClient = undefined; };
        const timeout = setTimeout(release, 6 * 60_000); timeout.unref();
        pending.on('notification', message => { if (message.method === 'account/login/completed') { clearTimeout(timeout); release(); } });
        try {
          await pending.start();
          const result = await pending.request('account/login/start', { type: 'chatgpt', useHostedLoginSuccessPage: true }) as { authUrl?: string };
          const url = new URL(result.authUrl || '');
          if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname)) throw Error('官方登录地址无效');
          return { authUrl: url.href };
        } catch (error) { clearTimeout(timeout); release(); throw error; }
      }
      if (claudeLogin && claudeLogin.exitCode === null) throw Error('登录正在进行，请先完成官方登录');
      claudeLogin = spawn(componentBinary(root, 'claude-code'), ['auth', 'login'], { env, cwd: join(root, 'workspaces'), stdio: 'ignore' });
      claudeLogin.on('error', () => {});
      return { browserOpened: true };
    },
    async fetch(request: Request) {
      const path = new URL(request.url).pathname;
      if (omitted.test(path)) return Response.json({ error: '此功能未包含在基础版中' }, { status: 404 });
      return app.fetch(request);
    },
    async close() { shutdown.abort(); loginClient?.stop(); claudeLogin?.kill(); await runtime.shutdown(); }
  };
}
