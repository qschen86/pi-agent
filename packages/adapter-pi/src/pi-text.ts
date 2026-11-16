/**
 * 纯文本调用 pi（ADR-0810）：不带任何工具，只让模型产出一段文本（例如 AI 辅助生成的 agent 定义）。
 *
 * 与真机任务同一套运行时隔离（ADR-0808）：独立的家目录 / 临时目录 / 状态目录、环境变量白名单、
 * OS 级边界 + 实测自检、进程树收尾。工作区是一个空的临时目录，没有任何写授权——
 * 就算模型想做什么，也只有它自己的运行时目录可写。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PlatformError } from "@pi-agent/domain";
import type { RuntimeGuardProvider } from "@pi-agent/runtime-contracts";
import { SeatbeltRuntimeGuard } from "./os-sandbox.js";
import { compileRuntimeGuardPolicy } from "./runtime-guard-policy.js";
import { verifyRuntimeGuard } from "./runtime-guard.js";
import { buildPiEnvironment, preparePiRuntime } from "./pi-runtime-env.js";
import { killProcessGroup, killProcessTree, trackProcessGroup } from "./process-tree.js";

export interface PiTextOptions {
  systemPrompt: string;
  prompt: string;
  provider?: string;
  model?: string;
  /** 推理强度（v2.3）：显式传给 pi；不写就用 pi 对该模型的默认值 */
  thinking?: ThinkingLevel;
  /** pi 可执行文件（默认 PI_BIN，再默认 pi） */
  bin?: string;
  timeoutMs?: number;
  runtimeGuard?: RuntimeGuardProvider;
  /** 显式 false 才不加 OS 边界（仅供诊断与夹具测试） */
  osSandbox?: boolean;
  piConfigDir?: string;
  passEnv?: string[];
  /**
   * 随本次调用交给模型的图片（v2.6）：由调用方核对过格式与尺寸。写进本次调用的临时工作区，
   * 以 pi 的 `@文件` 参数传入，调用结束随临时目录删除；不接受路径或网址，只接受字节。
   */
  images?: PiImage[];
}

/** 一张图片：字节与媒体类型（只允许 PNG / JPEG / WebP）。 */
export interface PiImage {
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  bytes: Uint8Array;
}

const IMAGE_EXT: Record<PiImage["mediaType"], string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/**
 * pi 的命令行参数（v2.6 起可带图片）：`pi [options] -- [@图片…] 文本`。
 * 图片路径必须是本次调用临时工作区里的文件；文本放最后，避免被当成文件参数。
 */
export function piArgv(options: Pick<PiTextOptions, "provider" | "model" | "thinking" | "systemPrompt" | "prompt">, mode: "text" | "json", imagePaths: string[] = []): string[] {
  return [
    "--print", "--mode", mode,
    ...(options.provider && options.model ? ["--provider", options.provider, "--model", options.model] : []),
    ...(options.thinking ? ["--thinking", options.thinking] : []),
    "--system-prompt", options.systemPrompt,
    "--no-tools", "--no-session", "--no-extensions", "--no-skills", "--no-context-files",
    "--", ...imagePaths.map((p) => `@${p}`), options.prompt
  ];
}

/** pi 支持的推理强度。 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export async function runPiText(options: PiTextOptions): Promise<string> {
  return runPi(options, "text");
}

/** 一次纯文本补全的结果（json 事件流解析而来）：真实用量取自 pi 的 message_end。 */
export interface PiCompletion {
  /** 助手消息里的正文（不含思考过程） */
  text: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  /** pi 报告的 token 用量；cost 为 0 时表示价格未知，不代表免费 */
  usage?: { input: number; output: number; reasoning?: number; cacheRead: number; cacheWrite: number; totalTokens: number };
  /** 从启动 pi（含 OS 边界自检）到进程结束的墙钟耗时 */
  durationMs: number;
}

/**
 * 与 runPiText 相同的隔离与无工具约束，改用 json 事件流：拿到正文、模型、停止原因与真实用量（v2.0 C4）。
 * 不保存思考过程。
 */
export async function runPiCompletion(options: PiTextOptions): Promise<PiCompletion> {
  const started = Date.now();
  const out = await runPi(options, "json");
  return { ...parsePiJson(out), durationMs: Date.now() - started };
}

/** 解析 pi --mode json 的事件流：取最后一条助手 message_end。 */
export function parsePiJson(stdout: string): Omit<PiCompletion, "durationMs"> {
  let last: Record<string, any> | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const e = JSON.parse(line) as { type?: string; message?: Record<string, any> };
      if (e.type === "message_end" && e.message?.role === "assistant") last = e.message;
    } catch {
      /* 非 JSON 行（极少见的诊断输出）跳过 */
    }
  }
  if (!last) throw new PlatformError("RUNTIME_UNSUPPORTED", "pi 没有产出助手消息");
  if (last.stopReason === "error") throw new PlatformError("RUNTIME_UNSUPPORTED", `模型调用失败：${String(last.errorMessage ?? "未知原因").slice(0, 400)}`);
  const text = (Array.isArray(last.content) ? last.content : [])
    .filter((c: { type?: string }) => c.type === "text")
    .map((c: { text?: string }) => c.text ?? "")
    .join("");
  const u = last.usage as Record<string, number> | undefined;
  return {
    text,
    ...(last.provider ? { provider: String(last.provider) } : {}),
    ...(last.model ? { model: String(last.model) } : {}),
    ...(last.stopReason ? { stopReason: String(last.stopReason) } : {}),
    ...(u ? { usage: {
      input: u.input ?? 0, output: u.output ?? 0, ...(u.reasoning !== undefined ? { reasoning: u.reasoning } : {}),
      cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, totalTokens: u.totalTokens ?? 0
    } } : {})
  };
}

async function runPi(options: PiTextOptions, mode: "text" | "json"): Promise<string> {
  const bin = options.bin ?? process.env["PI_BIN"] ?? "pi";
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "pi-text-ws-")));
  const runDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-text-run-")));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-text-rt-")));
  // OS 边界的 guardDir（含 sandbox.sb）也在这里登记：prepared.dispose() 是空操作，
  // 之前任何退出路径都不删它，每次调用在 $TMPDIR 留一个 pi-text-guard-* 目录。
  let guardDir: string | undefined;
  const cleanup = (): void => {
    for (const d of [workspace, runDir, root, ...(guardDir ? [guardDir] : [])]) rmSync(d, { recursive: true, force: true });
  };
  try {
    const rt = preparePiRuntime(root, {
      ...(options.piConfigDir ? { sourceAgentDir: options.piConfigDir } : {}),
      ...(options.provider ? { provider: options.provider } : {})
    });
    let wrap = async (command: string, args: string[]) => ({ command, args, env: undefined as Record<string, string> | undefined });
    let dispose = async (): Promise<void> => {};
    if (options.osSandbox !== false) {
      const provider = options.runtimeGuard ?? new SeatbeltRuntimeGuard();
      if (!provider.available()) {
        throw new PlatformError("RUNTIME_UNSUPPORTED", `OS 级边界（${provider.name}）在本机不可用，拒绝以无边界方式运行`);
      }
      const policy = compileRuntimeGuardPolicy({
        workspaceRoot: workspace,
        writeSubPaths: [],
        runtimeWritable: [runDir, rt.root],
        runtimeReadable: [...rt.readable, ...installRoots(bin)]
      });
      const guard = mkdtempSync(join(tmpdir(), "pi-text-guard-"));
      guardDir = guard;
      const prepared = await provider.prepare({ policy, guardDir: guard, runtimeTmp: rt.tmpDir });
      const check = await verifyRuntimeGuard(prepared, { policy, runtimeTmp: rt.tmpDir, guardDir: guard });
      if (!check.passed) {
        await prepared.dispose();
        throw new PlatformError("POLICY_FAIL_CLOSED", `OS 边界自检未通过（${check.failures.join("；")}），拒绝启动`);
      }
      wrap = async (command, args) => {
        const w = await prepared.wrap(command, args);
        return { command: w.command, args: w.args, env: w.env };
      };
      dispose = () => prepared.dispose();
    }
    // 图片写进临时工作区（沙箱对它只读可见），按顺序编号；文件名不含任何外部输入
    const imagePaths = (options.images ?? []).map((img, i) => {
      const ext = IMAGE_EXT[img.mediaType];
      if (!ext) throw new PlatformError("RUNTIME_UNSUPPORTED", `不支持的图片类型：${String(img.mediaType)}`);
      const file = join(workspace, `image-${String(i + 1).padStart(2, "0")}.${ext}`);
      writeFileSync(file, img.bytes, { mode: 0o600 });
      return file;
    });
    const argv = piArgv(options, mode, imagePaths);
    const env = buildPiEnvironment(process.env, {
      passEnv: [...rt.passEnv, ...(options.passEnv ?? [])],
      set: { HOME: rt.homeDir, TMPDIR: rt.tmpDir, PI_CODING_AGENT_DIR: rt.agentDir }
    });
    try {
      const w = await wrap(bin, argv);
      return await collect(w.command, w.args, workspace, { ...env, ...(w.env ?? {}) }, options.timeoutMs ?? 180_000);
    } finally {
      await dispose();
    }
  } finally {
    cleanup();
  }
}

function collect(command: string, args: string[], cwd: string, env: Record<string, string>, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const pid = child.pid;
    const untrack = pid !== undefined ? trackProcessGroup(pid) : () => {};
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      if (pid !== undefined) killProcessTree(pid);
      untrack();
      reject(new PlatformError("RUNTIME_UNSUPPORTED", `pi 生成超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => { out += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { err += c.toString("utf8"); });
    child.on("error", (e) => {
      clearTimeout(timer);
      untrack();
      reject(new PlatformError("RUNTIME_UNSUPPORTED", `PI_UNAVAILABLE：无法启动 pi（${command}）：${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (pid !== undefined) killProcessGroup(pid);
      untrack();
      if (code !== 0) reject(new PlatformError("RUNTIME_UNSUPPORTED", `pi 生成失败（退出码 ${code}）：${err.trim().slice(-400)}`));
      else resolve(out);
    });
  });
}

function resolveExecutable(name: string): string | undefined {
  if (name.includes("/")) return existsSync(name) ? resolve(name) : undefined;
  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return undefined;
}

/**
 * pi 与 node 的安装位置：装在家目录下（nvm、npm 全局前缀……）时必须放行读取，否则进程起不来。
 * pi 若装在某个 node_modules 里，放行整个包（它自己的依赖在包内）；否则只放行它所在的目录
 * （例如测试夹具），不顺带放开上层——那可能是整个仓库。
 */
export function installRoots(bin: string): string[] {
  const roots: string[] = [];
  for (const [name, isNode] of [[bin, false], ["node", true]] as const) {
    const found = resolveExecutable(name);
    if (!found) continue;
    let real: string;
    try {
      real = realpathSync(found);
    } catch {
      continue;
    }
    if (isNode) {
      roots.push(dirname(dirname(real))); // <prefix>/bin/node → <prefix>
      continue;
    }
    const m = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(real);
    roots.push(m ? m[1] : dirname(real));
  }
  return roots;
}
