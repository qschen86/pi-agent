import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createConnection } from 'node:net';
import { buildPiEnvironment, preparePiRuntime, sharedPlaywrightBrowsersPath } from "../../adapter-pi/src/pi-runtime-env.js";
import { canonicalPath, compileRuntimeGuardPolicy, isWithin } from "../../adapter-pi/src/runtime-guard-policy.js";
import { SeatbeltRuntimeGuard } from "../../adapter-pi/src/os-sandbox.js";
import { verifyRuntimeGuard } from "../../adapter-pi/src/runtime-guard.js";
import type { PreparedRuntimeGuard, RuntimeGuardProvider } from "@pi-agent/runtime-contracts";
import { PI_ISOLATION_ARGS, PI_TOOL_NAMES } from "./policy.js";
import { isPiPermissionMode } from "./policy.js";
import { piWorktreeAccess } from "./pi-worktree-access.js";
import type { PiWorktreeIdentity } from "./pi-worktree-access.js";
import { communityPermissionConfig, loadPiCommunityProfile } from "./pi-community-profile.js";
import { acquireBrowserProfile } from './browser-profile.js';
import { FACT_TOOLS } from './hermes-extension.js';
import { HERMES_TOOLS, detectHermesProject, assertFactActivation } from './hermes-profile.js';
import { loadEvidencePolicy } from './facts/evidence-policy.js';
import { hermesRuntimeConfig } from './hermes-startup.js';
import { startSessionWebResearch } from './web-research.js';
import type { SessionWebResearch } from './web-research.js';
import type { BrokerBudget, WebResearchProviderPreference } from '@pi-agent/web-research';

import type { EvaluationBoundary } from "./types.js";
export type { EvaluationBoundary } from "./types.js";

/** 本轮的联网检索授权：来源域名（`*` 开放）与预算；未给就不注册检索工具。 */
export interface PiWebResearchOptions {
  sourceDomains: string[];
  budget?: Partial<BrokerBudget>;
  prefer?: WebResearchProviderPreference;
}

export interface PiBoundaryOptions {
  workspace: string;
  worktree?: PiWorktreeIdentity;
  mode: string;
  provider: string;
  /** 本轮模型 ID：用于把图片编码预算压到平台单帧限额内（models.json modelOverrides）。 */
  model?: string;
  memorySource?: {platformSessionId?:string;turnId?:string};
  runtimeRoot: string;
  guardDir: string;
  sourceAgentDir?: string;
  guard?: RuntimeGuardProvider;
  roleInstructions?: string;
  recordReadRoots?: string[];
  platformBrowser?: {socketPath:string};
  evaluation?: EvaluationBoundary;
  communityProfilePath?: string;
  /** Operator-selected memory, independent of a legacy native assembly identity. */
  nativeMemoryProfilePath?: string;
  webResearch?: PiWebResearchOptions;
}
export interface PiChatBoundary {
  env: Record<string, string>;
  argsPrefix: string[];
  commandReadRoots: string[];
  commandWriteRoots: string[];
  communityFingerprint?: string;
  webResearch?: { provider?: string; tools: string[] };
  closeBrowser?():Promise<void>;
  wrap: PreparedRuntimeGuard["wrap"];
  dispose(): Promise<void>;
}

export async function preparePiChatBoundary(options: PiBoundaryOptions): Promise<PiChatBoundary> {
  if (!isPiPermissionMode(options.mode)) throw new Error("Invalid Pi permission mode");
  const workspace = canonicalPath(options.workspace), root = canonicalPath(options.runtimeRoot), guardDir = canonicalPath(options.guardDir);
  if (isWithin(root, workspace) || isWithin(workspace, root) || isWithin(guardDir, root) || isWithin(root, guardDir) || isWithin(guardDir, workspace) || isWithin(workspace, guardDir)) {
    throw new Error("Pi runtime and guard directories must be separate from the workspace");
  }
  const evaluation = options.evaluation;
  const community = options.communityProfilePath && options.mode === "pi-ask" && !evaluation
    ? loadPiCommunityProfile(options.communityProfilePath, workspace) : undefined;
  const nativeMemory = options.mode === "pi-native" && options.nativeMemoryProfilePath && !evaluation
    ? loadPiCommunityProfile(options.nativeMemoryProfilePath, workspace).profile.memory : undefined;
  const memory = community?.profile.memory ?? nativeMemory;
  const factsEnabled=!!memory&&existsSync(join(memory.storeRoot,'facts-policy.json'))&&loadEvidencePolicy(join(memory.storeRoot,'facts-policy.json')).enabled;
  if(memory)assertFactActivation(memory.storeRoot,factsEnabled);
  const factsReads=factsEnabled&&memory?[join(memory.storeRoot,'facts-policy.json')]:[];
  let report: string | undefined;
  let inputs: string[] = [];
  if (evaluation) {
    if (options.mode !== "pi-ask") throw new Error("Pi evaluation requires the dedicated guarded execution boundary");
    if (!isAbsolute(evaluation.reportDir) || !evaluation.inputRoots.length || evaluation.inputRoots.some((p) => !isAbsolute(p) || !existsSync(p))) throw new Error("Pi evaluation requires absolute, existing input roots and an absolute report directory");
    report = canonicalPath(evaluation.reportDir);
    inputs = evaluation.inputRoots.map((p) => canonicalPath(p));
    if (report === workspace || !isWithin(report, workspace)) throw new Error("Pi evaluation report directory must be strictly inside the job workspace");
    if (inputs.some((p) => [report!, root, guardDir].some((w) => isWithin(p, w) || isWithin(w, p)))) throw new Error("Pi evaluation input roots overlap writable runtime, guard or report roots");
  }
  let prepared: PreparedRuntimeGuard | undefined;
  let releaseBrowserProfile:(()=>void)|undefined;
  let browserControl:string|undefined;
  const WEB_TOOL_NAMES = ["web_search", "web_open"];
  let web: SessionWebResearch | undefined;
  try {
    const runtime = preparePiRuntime(root, { sourceAgentDir: options.sourceAgentDir, provider: options.provider, model: options.model });
    const sharedBrowsers = sharedPlaywrightBrowsersPath();
    // 共享浏览器目录只读放行：仅 pi-ask（评估边界不放）。只是浏览器二进制，不含任何凭据。
    // 同时放行所属仓库的 node_modules、根 package.json 与 packages/ 源码（只读，不可写）：
    // worktree 里的 Playwright 库从主检出的 node_modules 解析；Vite 向上找 PostCSS 配置时会读仓库根 package.json；worktree 里 import @pi-agent/* 会解析到主检出的 packages/。家目录默认拒读。
    const depsReads = options.worktree ? [join(options.worktree.repoRoot, "node_modules"), join(options.worktree.repoRoot, "package.json"), join(options.worktree.repoRoot, "packages")].filter((p) => existsSync(p)) : [];
    const browserReads = sharedBrowsers && options.mode === "pi-ask" && !evaluation ? [sharedBrowsers, ...depsReads] : [];
    const env = buildPiEnvironment(process.env, { passEnv: runtime.passEnv, set: {
      HOME: runtime.homeDir, TMPDIR: runtime.tmpDir, PI_CODING_AGENT_DIR: runtime.agentDir, PI_CHAT_PERMISSION_MODE: evaluation ? "pi-evaluation" : options.mode,
      PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1",
      // 会话在自己的 worktree 里时，write/edit 不许落到主仓库的其他位置（原生权限没有 OS 沙箱兜底）
      ...(options.worktree && !evaluation ? { PI_CHAT_WORKTREE_GUARD: JSON.stringify({ cwd: workspace, allow: canonicalPath(options.worktree.path), repoRoot: canonicalPath(options.worktree.repoRoot) }) } : {}),
      // 每轮 HOME 是一次性的：让 Playwright 用宿主机上已装好的共享浏览器，而不是去沙箱 HOME 里找/下载
      ...(sharedBrowsers ? { PLAYWRIGHT_BROWSERS_PATH: sharedBrowsers } : {})
    } });
    if (report) mkdirSync(report, { recursive: true, mode: 0o700 });
    mkdirSync(guardDir, { recursive: true, mode: 0o700 });
    const extension = join(guardDir, "pi-chat-approval.ts");
    writeFileSync(extension, readFileSync(fileURLToPath(new URL("./pi-approval-extension.ts", import.meta.url))), { mode: 0o400 });
    writeFileSync(join(guardDir,"screenshot-policy.mjs"),readFileSync(fileURLToPath(new URL("./screenshot-policy.mjs",import.meta.url))),{mode:0o400});
    writeFileSync(join(guardDir,"scan-policy.mjs"),readFileSync(fileURLToPath(new URL("./scan-policy.mjs",import.meta.url))),{mode:0o400});
    let browserEntry:string|undefined;
    if(options.platformBrowser&&!evaluation){
      env["PI_PLATFORM_BROWSER_SOCKET"]=options.platformBrowser.socketPath;
      browserEntry=join(guardDir,"platform-browser.ts");
      writeFileSync(browserEntry,readFileSync(fileURLToPath(new URL("./platform-browser-extension.ts",import.meta.url))),{mode:0o400});
    }
    let entry = extension;
    // 联网检索：Broker 跑在宿主（本进程）里，pi 只拿 socket 路径；密钥与来源台账都不进 pi。
    let webEntry: string | undefined;
    if (options.webResearch && !evaluation) {
      web = await startSessionWebResearch({
        socketDir: runtime.tmpDir,
        sourceDomains: options.webResearch.sourceDomains,
        ...(options.webResearch.budget ? { budget: options.webResearch.budget } : {}),
        ...(options.webResearch.prefer ? { prefer: options.webResearch.prefer } : {}),
        ...(options.sourceAgentDir ? { piAgentDir: options.sourceAgentDir } : {})
      });
      env["PI_WEB_RESEARCH_SOCKET"] = web.socketPath;
      env["PI_WEB_RESEARCH_TOOLS"] = WEB_TOOL_NAMES.join(",");
      webEntry = join(guardDir, "web-research.ts");
      writeFileSync(webEntry, readFileSync(fileURLToPath(new URL("./web-research-extension.ts", import.meta.url))), { mode: 0o400 });
    }
    const webTools = [...(web ? WEB_TOOL_NAMES : []),...(browserEntry?["platform_browser"]:[])];
    const writable = community ? [runtime.homeDir, runtime.tmpDir, join(runtime.agentDir, "sessions"), join(runtime.agentDir, "extensions", "pi-permission-system", "logs"), join(runtime.agentDir, "auth.json.lock")] : [root];
    for (const dir of writable.filter(p => !p.endsWith("auth.json.lock"))) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (memory) {
      writeFileSync(join(guardDir, 'hermes-provenance.ts'), readFileSync(fileURLToPath(new URL('./hermes-provenance.ts', import.meta.url))), { mode: 0o400 });
      writeFileSync(join(guardDir, 'hermes-guard.ts'), readFileSync(fileURLToPath(new URL('./hermes-extension.ts', import.meta.url))), { mode: 0o400 });
      if(factsEnabled){
        const packaged=fileURLToPath(new URL('./hermes-facts.mjs',import.meta.url));
        if(existsSync(packaged))writeFileSync(join(guardDir,'hermes-facts.mjs'),readFileSync(packaged),{mode:0o400});
        else {const {build}=await import('esbuild');await build({entryPoints:[fileURLToPath(new URL('./facts/runtime.ts',import.meta.url))],outfile:join(guardDir,'hermes-facts.mjs'),bundle:true,platform:'node',target:'node24',format:'esm'});}
      }
      symlinkSync(join(memory.storeRoot, 'data/projects-memory'), join(runtime.agentDir, 'projects-memory'));
      writeFileSync(join(runtime.agentDir, 'hermes-memory-config.json'), JSON.stringify(
        hermesRuntimeConfig(memory.storeRoot, detectHermesProject(workspace, memory.storeRoot),factsEnabled)
      ), { mode: 0o400 });
    }
    if (nativeMemory) {
      entry = join(guardDir, "pi-native-memory.ts");
      writeFileSync(entry, `import install from './pi-chat-approval.ts';
import memory from ${JSON.stringify(join(nativeMemory.packageRoot,'src/index.ts'))};
import {guardedHermesApi} from './hermes-guard.ts';
import {installHermesProvenance,withHermesFactCommit} from './hermes-provenance.ts';
import {DatabaseManager} from ${JSON.stringify(join(nativeMemory.packageRoot,'src/store/db.ts'))};
${factsEnabled ? "import {installFactRuntime} from './hermes-facts.mjs';\nimport {MemoryStore} from "+JSON.stringify(join(nativeMemory.packageRoot,'src/store/memory-store.ts'))+";\nimport {reconcileMarkdownMemoryScope as reconcile} from "+JSON.stringify(join(nativeMemory.packageRoot,'src/store/sqlite-memory-store.ts'))+";" : ''}
export default async function(pi) {
  process.umask(0o077);
  let memoryApi=installHermesProvenance(DatabaseManager,guardedHermesApi(pi,${JSON.stringify(join(nativeMemory.storeRoot,'data/.runtime-memory.lock'))},${factsEnabled}),${JSON.stringify(options.memorySource??{})});
  ${factsEnabled ? 'memoryApi=await installFactRuntime({MemoryStore,DatabaseManager,reconcile,publishContext:withHermesFactCommit,pi:memoryApi,storeRoot:'+JSON.stringify(nativeMemory.storeRoot)+',source:'+JSON.stringify(options.memorySource??{})+'});' : ''}
  memory(memoryApi);
  // Register readiness last, after Hermes has initialized its session hooks.
  install(pi,undefined,true,${factsEnabled});
}`, {mode:0o400});
    }
    if (community) {
      // Pi takes a lock even for credential reads; permit only its lock directory, not credential edits.
      if (!existsSync(join(runtime.agentDir, "auth.json"))) writeFileSync(join(runtime.agentDir, "auth.json"), "{}", { mode: 0o400 });
      // Mirror the OS guard's read/write roots so the community layer neither asks about what the OS
      // allows nor asks about what it will refuse anyway (see communityPermissionConfig).
      const worktreeAccess = piWorktreeAccess(workspace, options.worktree);
      const browserData = community.profile.browser?.profileRoot ? join(community.profile.browser.profileRoot, "data") : undefined;
      writeFileSync(join(runtime.agentDir, "extensions", "pi-permission-system", "config.json"), JSON.stringify(communityPermissionConfig(community.tools, {
        home: canonicalPath(homedir()),
        readRoots: [root, ...runtime.readable, ...(options.recordReadRoots ?? []), ...browserReads, ...community.readable, ...factsReads, guardDir, ...(worktreeAccess?.readRoots ?? [])].map(p => canonicalPath(p)),
        writeRoots: [...writable, ...(browserData ? [browserData] : []), ...(memory ? [join(memory.storeRoot, "data")] : []), ...(worktreeAccess?.writeRoots ?? [])].map(p => canonicalPath(p)),
        persistentBrowser: !!community.profile.browser?.profileRoot,
        platformBrowser: !!browserEntry,
        webResearch: !!web
      })), { mode: 0o400 });
      // Config parents are not writable. Logs and sessions have separate writable roots.
      entry = join(guardDir, "pi-community.ts");
      writeFileSync(entry, `import install from './pi-chat-approval.ts';
import permissions from ${JSON.stringify(community.permissionEntry)};
import {getPermissionsService} from ${JSON.stringify(community.serviceEntry)};
${memory ? `import memory from ${JSON.stringify(join(memory.packageRoot, 'src/index.ts'))};
import {guardedHermesApi} from './hermes-guard.ts';
import {installHermesProvenance,withHermesFactCommit} from './hermes-provenance.ts';
import {DatabaseManager} from ${JSON.stringify(join(memory.packageRoot, 'src/store/db.ts'))};` : ''}
${factsEnabled&&memory ? "import {installFactRuntime} from './hermes-facts.mjs';\nimport {MemoryStore} from "+JSON.stringify(join(memory.packageRoot,'src/store/memory-store.ts'))+";\nimport {reconcileMarkdownMemoryScope as reconcile} from "+JSON.stringify(join(memory.packageRoot,'src/store/sqlite-memory-store.ts'))+";" : ''}
export default async function(pi) {
  let ready = false;
  install(pi, {tools:${JSON.stringify(community.tools)},ready:()=>ready});
  permissions(pi);
  ${memory ? `process.umask(0o077);
  let memoryApi=installHermesProvenance(DatabaseManager,guardedHermesApi(pi,${JSON.stringify(join(memory.storeRoot,'data/.runtime-memory.lock'))},${factsEnabled}),${JSON.stringify(options.memorySource??{})});
  ${factsEnabled ? 'memoryApi=await installFactRuntime({MemoryStore,DatabaseManager,reconcile,publishContext:withHermesFactCommit,pi:memoryApi,storeRoot:'+JSON.stringify(memory.storeRoot)+',source:'+JSON.stringify(options.memorySource??{})+'});' : ''}
  memory(memoryApi);` : ''}
  pi.on('session_start', (_event,ctx)=>{
    if(!getPermissionsService(ctx.sessionManager.getSessionId())) throw new Error('Community permission service unavailable');
    ready=true;
    if(process.env.PI_RUNTIME_BROWSER_PROFILE) pi.appendEntry('pi-runtime-browser',{id:process.env.PI_RUNTIME_BROWSER_PROFILE});
    if(process.env.PI_RUNTIME_ASSEMBLY) pi.appendEntry('pi-runtime-assembly',{fingerprint:process.env.PI_RUNTIME_ASSEMBLY});
    ctx.ui.notify('pi-chat-gate:'+process.env.PI_CHAT_GATE_TOKEN,'info');
  });
}`, { mode: 0o400 });
      const mcpServers:Record<string,unknown>={};
      if (community.profile.browser) {
        const browser = community.profile.browser;
        if(browser.profileRoot)releaseBrowserProfile=acquireBrowserProfile(browser.profileRoot);
        const lifecycle=join(guardDir,'browser-mcp-lifecycle.mjs');
        if(browser.profileRoot){browserControl=join(runtime.tmpDir,'browser-control.sock');writeFileSync(lifecycle,readFileSync(fileURLToPath(new URL('./browser-mcp-lifecycle.mjs',import.meta.url))),{mode:0o400});}
        mcpServers.playwright = {
          // Chromium cannot install a nested Seatbelt profile. The verified outer Pi process-tree
          // guard remains mandatory; this does not disable the runtime filesystem boundary.
          command: process.execPath, args: [...(browser.profileRoot?[lifecycle]:[]),join(browser.packageRoot, "cli.js"), "--headless", ...(browser.profileRoot?['--runtime-state-dir',join(browser.profileRoot,'data'),'--runtime-control-socket',browserControl!]:["--isolated"]), "--no-sandbox", "--browser", "chromium", "--executable-path", browser.executable],
          exposure: "direct", timeout: 60, env: { MAC_CHROMIUM_TMPDIR: runtime.tmpDir }
        };
      }
      if(community.profile.testing){
        const testing=community.profile.testing;
        const bridge=join(guardDir,'playwright-test-mcp.mjs'),preload=join(guardDir,'playwright-test-preload.mjs');
        for(const file of ['playwright-test-mcp.mjs','playwright-test-preload.mjs'])writeFileSync(join(guardDir,file),readFileSync(fileURLToPath(new URL('./'+file,import.meta.url))),{mode:0o400});
        mcpServers.playwright_test={command:process.execPath,args:[bridge,testing.packageRoot,workspace],exposure:'direct',timeout:300,env:{PI_RUNTIME_TEST_PACKAGE:testing.packageRoot,NODE_OPTIONS:'--import='+pathToFileURL(preload).href,MAC_CHROMIUM_TMPDIR:runtime.tmpDir,...(testing.browserRoot?{PLAYWRIGHT_BROWSERS_PATH:testing.browserRoot}:{})}};
      }
      if(Object.keys(mcpServers).length)writeFileSync(join(runtime.agentDir,'mcp.json'),JSON.stringify({mcpServers}),{mode:0o400});
    }
    const roleArgs: string[] = [];
    if (options.roleInstructions) {
      const roleFile = join(guardDir, "role-instructions.md");
      writeFileSync(roleFile, options.roleInstructions, { mode: 0o400 });
      roleArgs.push("--append-system-prompt", roleFile);
    }
    if (options.mode !== "pi-native") {
      const guard = options.guard ?? new SeatbeltRuntimeGuard({ chromium: !!(community?.profile.browser||community?.profile.testing) || browserReads.length > 0 });
      if (!guard.available()) throw new Error("Pi guard unavailable: cannot enforce the requested boundary");
      const gitRead = evaluation ? [] : piWorktreeAccess(workspace, options.worktree)?.readRoots ?? [];
      const browserData=community?.profile.browser?.profileRoot?join(community.profile.browser.profileRoot,'data'):undefined;
      const policy = compileRuntimeGuardPolicy({ workspaceRoot: workspace, writeSubPaths: report ? [relative(workspace, report)] : options.mode === "pi-read-only" ? [] : ["."], runtimeWritable: [...writable,...(browserData?[browserData]:[]), ...(community?.profile.memory ? [join(community.profile.memory.storeRoot, 'data')] : [])], runtimeReadable: [root, ...runtime.readable, ...(options.recordReadRoots ?? []), ...browserReads, ...(community?.readable ?? []), ...factsReads, guardDir, ...inputs, ...gitRead] });
      prepared = await guard.prepare({ policy, guardDir, runtimeTmp: runtime.tmpDir });
      const check = await verifyRuntimeGuard(prepared, { policy, runtimeTmp: runtime.tmpDir, guardDir });
      if (!check.passed) throw new Error(`Pi guard self-check failed: ${check.failures.join("; ")}`);
    }
    return {
      env,
      commandReadRoots: [root, ...runtime.readable, ...(options.recordReadRoots ?? []), ...browserReads, ...(community?.readable ?? [])],
      commandWriteRoots: writable,
      ...(community ? { communityFingerprint: community.fingerprint } : {}),
      ...(web ? { webResearch: { ...(web.provider ? { provider: web.provider.id } : {}), tools: WEB_TOOL_NAMES } } : {}),
      closeBrowser:async()=>{
        if(!browserControl||!existsSync(browserControl))return;
        await new Promise<void>((resolve,reject)=>{
          const socket=createConnection(browserControl!),timer=setTimeout(()=>{socket.destroy(new Error('Browser state flush timed out'));},5000);
          let reply='';socket.setEncoding('utf8');socket.once('connect',()=>socket.write('close\n'));
          socket.on('data',chunk=>{reply+=chunk;if(reply.length>1024)socket.destroy(new Error('Invalid browser flush response'));});
          socket.once('error',error=>{clearTimeout(timer);reject(error);});
          socket.once('end',()=>{clearTimeout(timer);socket.destroy();if(reply==='closed\n')resolve();else reject(new Error('Browser state flush failed'));});
        });
      },
      argsPrefix: [...roleArgs, ...PI_ISOLATION_ARGS, "--no-approve", ...(community?.profile.browser||community?.profile.testing ? ["--extension", "builtin:mcp"] : ["--no-mcp"]), "--extension", entry, ...(webEntry ? ["--extension", webEntry] : []), ...(browserEntry ? ["--extension", browserEntry] : []), "--tools", (options.mode === "pi-read-only" ? [...PI_TOOL_NAMES.slice(0, 4), ...webTools] : !evaluation && options.mode === "pi-ask" ? [...PI_TOOL_NAMES, "bash_escalated", ...(community?.tools ?? []), ...webTools] : [...PI_TOOL_NAMES, ...(nativeMemory ? [...HERMES_TOOLS,...(factsEnabled?FACT_TOOLS:[])] : []), ...webTools]).join(",")],
      wrap: prepared ? prepared.wrap.bind(prepared) : async (command, args) => ({ command, args }),
      dispose: async () => { try{await prepared?.dispose();}finally{try{await web?.close();}finally{releaseBrowserProfile?.();rmSync(root, { recursive: true, force: true }); rmSync(guardDir, { recursive: true, force: true });}} }
    };
  } catch (error) {
    try{await prepared?.dispose();}finally{try{await web?.close();}finally{releaseBrowserProfile?.();rmSync(root, { recursive: true, force: true }); rmSync(guardDir, { recursive: true, force: true });}}throw error;
  }
}
