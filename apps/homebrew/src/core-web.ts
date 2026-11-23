import { ConsoleService } from '../../web/src/console.js';
import { createWebApp } from '../../web/src/server.js';
import { omittedPathPattern } from '../../web/src/app-manifest.mjs';
import { appData, ensureDataSkeleton, strayDataNames } from '../../web/src/app-data.js';
import type { RuntimeAuthCapability, RuntimeAuthService } from '../../web/src/runtime-routes.js';
import { RuntimeSessionManager } from '../../../packages/runtime-sessions/src/manager.js';
import { PiDriver } from '../../../packages/runtime-sessions/src/pi.js';
import { CodexDriver } from '../../../packages/runtime-sessions/src/codex.js';
import { CodexAppServerClient } from '../../../packages/runtime-sessions/src/codex-client.js';
import { ClaudeDriver, type ClaudeSdkPort } from '../../../packages/runtime-sessions/src/claude.js';
import { AntigravityDriver } from '../../../packages/runtime-sessions/src/antigravity.js';
import { RuntimeAuthFlowManager, type RuntimeAuthSubmitInput } from '../../../packages/runtime-sessions/src/runtime-auth.js';
import type { RuntimeKind } from '../../../packages/runtime-sessions/src/types.js';
import { nativeModelPort } from './native-model-port.js';
import { componentBinary, componentPath, isComponentInstalled } from './optional-installer.mjs';
import { antigravityEnv, isolatedEnv } from './network-host.mjs';
import { evaluateRuntimeNetwork, withRuntimeNetworkGate } from './runtime-network-gate.mjs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { piModelPort } from '../../../packages/model-port/src/index.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import type { RuntimeDriver } from '../../../packages/runtime-sessions/src/driver.js';

const omitted = omittedPathPattern('homebrew');
type OptionalRuntimeKind = 'codex' | 'claude-code' | 'antigravity';
const OPTIONAL_KINDS: readonly OptionalRuntimeKind[] = ['codex', 'claude-code', 'antigravity'];
const isOptionalKind = (kind: RuntimeKind): kind is OptionalRuntimeKind => (OPTIONAL_KINDS as readonly string[]).includes(kind);

const disabledDriver = (kind: OptionalRuntimeKind) => ({
  kind,
  probe: async () => ({
    state: 'not-installed',
    stateReason: '尚未启用此运行时组件，可在界面中一键安装并完成官方登录',
    models: [],
    capabilities: {},
    configSummary: [],
    permissions: { label: '', detail: '' }
  }),
  listHistory: async () => ({ items: [], coverage: 'complete', notes: [] }),
  fingerprint: async () => undefined,
  findClientMessage: async () => undefined,
  rateLimits: async () => undefined,
  shutdown() {},
  startTurn: async () => { throw Error('运行时未安装'); },
  readHistory: async () => { throw Error('运行时未安装'); }
}) as unknown as RuntimeDriver;

export interface CreateCoreOptions {
  root: string;
  port: number;
  payloadRoot: string;
  networkInspector?: (kind: string, apiKey?: string) => Promise<{ report: unknown; networkId: string; failure?: string }>;
  componentInstall?: (kind: string) => Promise<{ installed: boolean; reused?: boolean; version?: string }>;
  modelCheck?: (apiKey: string) => Promise<string[]>;
}

export async function createCore({ root, port, payloadRoot, networkInspector, componentInstall, modelCheck }: CreateCoreOptions) {
  const installationPath = join(root, 'installation.json');
  const readInstallation = () => JSON.parse(readFileSync(installationPath, 'utf8')) as {
    runtimeKind?: RuntimeKind;
    enabledRuntimes?: RuntimeKind[];
    model?: { provider: string; id: string };
    onboarding?: { component?: string; login?: string };
    acceptance?: { modelConnection?: string; firstTask?: string; taskSession?: string };
  };
  const saveInstallation = (next: Record<string, unknown>) => {
    const tmp = join(root, `.installation-${randomBytes(8).toString('hex')}`);
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(tmp, installationPath);
  };
  const readPiSettings = () => {
    try { return JSON.parse(readFileSync(join(root, 'credentials/pi/settings.json'), 'utf8')) as { defaultProvider?: string; defaultModel?: string }; }
    catch { return {}; }
  };

  // 确保隔离凭据目录齐备（升级已有实例也能无缝补齐 credentials/antigravity）
  for (const dir of ['credentials/pi', 'credentials/codex', 'credentials/claude', 'credentials/antigravity', 'runtime/home', 'runtime/tmp']) {
    mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
  }

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

  const env: Record<string, string> = { ...isolatedEnv(root), PI_AGENT_CONSOLE_PORT: String(port) };
  const agyEnv: Record<string, string> = { ...antigravityEnv(root), PI_AGENT_CONSOLE_PORT: String(port) };

  const buildOptionalDriver = async (kind: OptionalRuntimeKind): Promise<RuntimeDriver> => {
    if (!isComponentInstalled(root, kind)) return disabledDriver(kind);
    if (kind === 'codex') {
      return new CodexDriver({
        binaryPath: componentBinary(root, 'codex'),
        candidates: [],
        codexHome: env.CODEX_HOME,
        evaluationRoot: join(root, 'runtime/codex-evaluation'),
        clientFactory: (binaryPath, options) => {
          const client = new CodexAppServerClient({ binaryPath, ...options, env: { ...env, ...options?.env }, cwd: options?.cwd || join(root, 'workspaces') });
          const request = client.request.bind(client);
          client.request = (method, params) => {
            const input = params as { cwd?: string; config?: Record<string, unknown> } | undefined;
            if (method === 'thread/start' && input?.cwd?.startsWith(join(root, 'runtime/completions') + '/')) {
              return request(method, {
                ...input, ephemeral: true, dynamicTools: [], selectedCapabilityRoots: [], environments: [],
                config: {
                  ...input.config,
                  'features.shell_tool': false, 'features.unified_exec': false, 'features.view_image': false, 'features.multi_agent': false,
                  'features.multi_agent_v2': false, 'features.hooks': false, 'features.plugins': false, 'web_search': 'disabled',
                  'apps._default.enabled': false, mcp_servers: {}, project_doc_max_bytes: 0
                }
              });
            }
            return request(method, params);
          };
          return client;
        }
      });
    }
    if (kind === 'claude-code') {
      const req = createRequire(join(componentPath(root, 'claude-code'), 'package.json'));
      const loaded = await import(pathToFileURL(req.resolve('@anthropic-ai/claude-agent-sdk')).href) as ClaudeSdkPort;
      const sdk: ClaudeSdkPort = {
        ...loaded,
        query: args => loaded.query({
          ...args,
          options: {
            ...args.options,
            ...(args.options?.cwd?.startsWith(join(root, 'runtime/completions') + '/') ? { tools: [], mcpServers: {}, plugins: [], strictMcpConfig: true } : {}),
            env: { ...args.options?.env, ...env }, settingSources: [], executable: 'node', executableArgs: []
          }
        })
      };
      const sdkRoot = dirname(req.resolve('@anthropic-ai/claude-agent-sdk'));
      const sdkVersion = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8')).version;
      let cliVersion = '未知';
      try { cliVersion = JSON.parse(readFileSync(join(sdkRoot, 'manifest.json'), 'utf8')).version; } catch { /* Do not invent a native version. */ }
      return new ClaudeDriver({ sdk, home: env.HOME, versions: { sdk: sdkVersion, cli: cliVersion }, evaluationRoot: join(root, 'runtime/claude-evaluation') });
    }
    return new AntigravityDriver({
      binaryPath: componentBinary(root, 'antigravity'),
      home: join(root, 'credentials/antigravity'),
      env: agyEnv,
      stateDir: join(root, 'runtime/antigravity-probe')
    });
  };

  // 支持多 runtime 共存：启动时凡是已安装组件的可选运行时全部装配真实驱动，未安装的按占位驱动等待按需启用
  const [codexDriver, claudeDriver, antigravityDriver] = await Promise.all([
    buildOptionalDriver('codex'),
    buildOptionalDriver('claude-code'),
    buildOptionalDriver('antigravity')
  ]);
  const initialSelected = readInstallation().runtimeKind || 'pi';
  const primaryDriver = initialSelected === 'codex'
    ? (isComponentInstalled(root, 'codex') ? codexDriver : undefined)
    : initialSelected === 'claude-code'
      ? (isComponentInstalled(root, 'claude-code') ? claudeDriver : undefined)
      : initialSelected === 'antigravity'
        ? (isComponentInstalled(root, 'antigravity') ? antigravityDriver : undefined)
        : undefined;

  const raw = piModelPort({ piConfigDir, bin: piBinary });
  const modelPort = primaryDriver
    ? nativeModelPort(root, primaryDriver, () => readInstallation().model?.id)
    : {
        complete: (role: Parameters<typeof raw.complete>[0], call: Parameters<typeof raw.complete>[1]) => {
          const piSettings = readPiSettings();
          return raw.complete({ ...role, provider: piSettings.defaultProvider ?? role.provider, model: piSettings.defaultModel ?? role.model }, call);
        }
      };

  const dataDir = join(root, 'data');
  // 首次启动：只建出公开版发布的应用的空数据目录；私有应用的数据目录不会出现在这里。
  // 公开版是新实例：从第一天起每个应用一个子目录（<data>/apps/<应用>/…），程序与数据、应用与应用之间都分开。
  ensureDataSkeleton(dataDir, 'homebrew', { layout: 'apps' });
  const svc = new ConsoleService({
    dataDir,
    repoRoot: payloadRoot,
    pi: { configDir: piConfigDir, bin: piBinary },
    runtimeConfigs: {
      home: root,
      dirs: {
        pi: piConfigDir,
        codex: join(root, 'credentials/codex'),
        'claude-code': join(root, 'credentials/claude'),
        antigravity: join(root, 'credentials/antigravity/.gemini/antigravity-cli')
      }
    },
    noteClassification: { port: modelPort }
  });

  const runtime = new RuntimeSessionManager({
    dataDir: appData(dataDir, 'runtime-sessions').root(),
    titlePort: modelPort,
    drivers: {
      codex: codexDriver,
      'claude-code': claudeDriver,
      antigravity: antigravityDriver,
      pi: new PiDriver({
        sourceAgentDir: piConfigDir,
        sessionDir: appData(dataDir, 'runtime-sessions').path('runtime', 'pi-sessions'),
        binaryPath: piBinary,
        runtimeExecutable: join(payloadRoot, 'bin/pi-runtime')
      })
    }
  });
  await runtime.recovered;
  const workspace = join(root, 'workspaces');
  if (!runtime.settings().workspaceRoots.length) runtime.updateSettings({ ...runtime.settings(), workspaceRoots: [workspace] }, 'local-installer');

  // 强隔离网络检测与门禁工具（与 /setup 共用同一份 credentials/network.json）
  const readNetworkKey = (): string | undefined => {
    const file = join(root, 'credentials/network.json');
    if (!existsSync(file)) return undefined;
    try { return (JSON.parse(readFileSync(file, 'utf8')) as { ipapiKey?: string }).ipapiKey; }
    catch { return undefined; }
  };
  const saveNetworkKey = (key: string) => {
    const tmp = join(root, 'credentials', `.network-${randomBytes(8).toString('hex')}`);
    writeFileSync(tmp, JSON.stringify({ ipapiKey: key }) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(tmp, join(root, 'credentials/network.json'));
  };
  const inspectNetwork = async (kind: string, overrideKey?: string) => {
    if (!networkInspector) throw Error('网络检测暂不可用');
    if (overrideKey !== undefined) {
      const trimmed = overrideKey.trim();
      if (trimmed.length > 4096 || /[\r\n\0]/.test(trimmed)) throw Error('网络检测 Key 无效');
      if (trimmed) saveNetworkKey(trimmed);
    }
    return networkInspector(kind, readNetworkKey());
  };
  const recordEnabledRuntime = (kind: RuntimeKind) => {
    const cfg = readInstallation();
    const list = new Set<RuntimeKind>(Array.isArray(cfg.enabledRuntimes) ? cfg.enabledRuntimes : [cfg.runtimeKind || 'pi']);
    list.add(kind);
    saveInstallation({ ...cfg, enabledRuntimes: [...list] });
  };
  const enabledSet = (): Set<RuntimeKind> => {
    const cfg = readInstallation();
    const list = new Set<RuntimeKind>(Array.isArray(cfg.enabledRuntimes) ? cfg.enabledRuntimes : [cfg.runtimeKind || 'pi']);
    for (const kind of OPTIONAL_KINDS) {
      if (isComponentInstalled(root, kind)) list.add(kind);
    }
    return list;
  };

  const authFlows = new RuntimeAuthFlowManager({
    cwd: workspace,
    resolveBinary: kind => isComponentInstalled(root, kind) ? componentBinary(root, kind) : undefined,
    envFor: kind => kind === 'antigravity' ? agyEnv : env,
    verifyProfile: async kind => {
      const profile = await runtime.probe(kind, { reloggedIn: true });
      if (profile.state === 'executable') recordEnabledRuntime(kind);
      return profile;
    },
    configurePiApiKey: async ({ provider, apiKey, modelId }) => {
      if (provider !== 'deepseek') throw Error('当前开源版仅支持 DeepSeek API Key');
      if (!modelCheck) throw Error('当前实例不支持在此检查模型连接');
      const models = await modelCheck(apiKey);
      if (!models.length) throw Error('账号没有可用的模型');
      const chosen = modelId && models.includes(modelId)
        ? modelId
        : (models.includes('deepseek-chat') ? 'deepseek-chat' : models[0]!);
      const authTmp = join(piConfigDir, `.auth-${randomBytes(8).toString('hex')}`);
      writeFileSync(authTmp, JSON.stringify({ deepseek: { type: 'api_key', key: apiKey } }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(authTmp, join(piConfigDir, 'auth.json'));
      const setTmp = join(piConfigDir, `.settings-${randomBytes(8).toString('hex')}`);
      writeFileSync(setTmp, JSON.stringify({ defaultProvider: 'deepseek', defaultModel: chosen }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(setTmp, join(piConfigDir, 'settings.json'));
      recordEnabledRuntime('pi');
      return { models, modelId: chosen };
    }
  });

  const capFor = (kind: RuntimeKind): RuntimeAuthCapability => {
    const enabled = enabledSet().has(kind);
    const installed = kind === 'pi' ? true : isComponentInstalled(root, kind);
    return {
      managedInstall: isOptionalKind(kind) && Boolean(componentInstall),
      requiresNetworkGate: isOptionalKind(kind) && Boolean(networkInspector),
      installed,
      enabled,
      isolatedCredentials: true,
      supportsApiKey: kind === 'pi' || kind === 'codex',
      loginMode: kind === 'pi' ? 'api-key' : kind === 'codex' ? 'callback' : kind === 'antigravity' ? 'code-paste' : 'hybrid',
    };
  };

  const runtimeAuth: RuntimeAuthService = {
    capabilities: () => ({
      isolatedCredentials: true,
      runtimes: {
        codex: capFor('codex'),
        'claude-code': capFor('claude-code'),
        pi: capFor('pi'),
        antigravity: capFor('antigravity'),
      }
    }),
    ...(networkInspector ? {
      networkCheck: async (kind: RuntimeKind, apiKey?: string) => {
        if (!isOptionalKind(kind)) throw Error('此运行时不需要网络门禁检查');
        const result = await inspectNetwork(kind, apiKey);
        return { ...result, decision: evaluateRuntimeNetwork({ runtime: kind, ...result }) };
      }
    } : {}),
    ...(componentInstall ? {
      installComponent: async (kind: RuntimeKind) => {
        if (!isOptionalKind(kind)) throw Error('此运行时已内置，无需单独安装');
        const runInstall = async () => {
          const result = await componentInstall(kind);
          const nextDriver = await buildOptionalDriver(kind);
          runtime.setDriver(kind, nextDriver);
          recordEnabledRuntime(kind);
          return result;
        };
        if (networkInspector) {
          return withRuntimeNetworkGate({ runtime: kind, stage: 'install', inspect: inspectNetwork, operation: runInstall });
        }
        return runInstall();
      }
    } : {}),
    startLogin: async (kind: RuntimeKind) => {
      if (isOptionalKind(kind)) {
        if (!isComponentInstalled(root, kind)) throw Error('请先安装运行时组件');
        // 若此前未热注册真实驱动（例如刚完成 /setup 安装），立即挂载
        runtime.setDriver(kind, await buildOptionalDriver(kind));
        if (networkInspector) {
          return withRuntimeNetworkGate({ runtime: kind, stage: 'login', inspect: inspectNetwork, operation: () => authFlows.start(kind) });
        }
      }
      return authFlows.start(kind);
    },
    loginStatus: (kind: RuntimeKind, flowId?: string) => authFlows.status(kind, flowId),
    submitLogin: (kind: RuntimeKind, flowId: string, input: RuntimeAuthSubmitInput) => authFlows.submit(kind, flowId, input),
    verifyLogin: (kind: RuntimeKind, flowId?: string) => authFlows.verify(kind, flowId),
    cancelLogin: (kind: RuntimeKind, flowId?: string) => authFlows.cancel(kind, flowId),
    shutdown: () => authFlows.shutdown(),
  };

  const shutdown = new AbortController();
  const app = createWebApp(svc, {
    dataDir,
    port,
    appSwitches: { edition: 'homebrew' },
    runtime,
    runtimeAuth,
    memoryTitlePort: modelPort,
    shutdownSignal: shutdown.signal,
    memorySyncEnabled: false,
    agentCalendar: { home: root, launchAgentsDir: join(root, 'runtime/launchagents'), timeZone: 'Asia/Shanghai' }
  });

  return {
    runtime,
    runtimeAuth,
    /** 数据目录里不属于公开版任何应用的条目；验收要求为空。 */
    strayData: () => strayDataNames(dataDir, 'homebrew'),
    async activateRuntime(kind: RuntimeKind) {
      if (isOptionalKind(kind) && isComponentInstalled(root, kind)) {
        runtime.setDriver(kind, await buildOptionalDriver(kind));
        recordEnabledRuntime(kind);
      }
    },
    async beginLogin(kind: string) {
      const k = kind as RuntimeKind;
      if (isOptionalKind(k)) {
        if (!isComponentInstalled(root, k)) throw Error('请先安装运行时组件');
        runtime.setDriver(k, await buildOptionalDriver(k));
      }
      return authFlows.start(k);
    },
    loginStatus(kind: string, flowId?: string) {
      return authFlows.status(kind as RuntimeKind, flowId);
    },
    submitLogin(kind: string, flowId: string, input: RuntimeAuthSubmitInput) {
      return authFlows.submit(kind as RuntimeKind, flowId, input);
    },
    cancelLogin(kind: string, flowId?: string) {
      return authFlows.cancel(kind as RuntimeKind, flowId);
    },
    async fetch(request: Request) {
      const path = new URL(request.url).pathname;
      if (omitted.test(path)) return Response.json({ error: '此功能未包含在基础版中' }, { status: 404 });
      return app.fetch(request);
    },
    async close() {
      shutdown.abort();
      authFlows.shutdown();
      await runtime.shutdown();
    }
  };
}
