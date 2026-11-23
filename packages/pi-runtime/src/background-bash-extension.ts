/**
 * Pi bash 后台运行（独立扩展，与 pi-approval-extension 同样复制进宿主管的只读 guard 目录，由 `pi --extension` 显式加载）。
 *
 * - 用同名 `bash` 覆盖内置工具，只多一个可选参数 `background`：不带它时原样转给内置 bash，行为不变；
 *   带上它时命令照样由内置 bash 执行（同一条 spawn 路径、同一层 OS 沙箱），只是不等它结束，立刻返回任务号。
 *   工具名没变，所以闸门、community 命令规则、扫描拦截、审批弹层看到的仍是一条普通的 bash 调用，原样生效。
 * - `bash_output`：查看任务输出，可等它结束（比 `sleep N` 轮询更早返回，且等待期间随输出回传进度）。
 * - `bash_kill`：终止任务。这两个工具只能碰本进程自己登记的任务，不执行任何新命令。
 *
 * 任务随 pi 进程结束而终止（一轮一个 pi 进程）；不做跨轮常驻。
 */
// guard 目录里两个文件并排放、由 pi 的 jiti 直接加载，所以只能写 .ts 后缀；仓库的 tsc 不允许这种写法，类型照常解析。
// @ts-ignore TS5097
import { BackgroundJobs, MAX_RUNNING_JOBS, MAX_WAIT_SECONDS, describeJob, type RunResult } from "./background-jobs.ts";

type Content = { type: "text"; text: string };
interface ToolResult { content: Content[]; details?: unknown; isError?: boolean; structuredContent?: { exit_code?: number } }
type OnUpdate = (partial: ToolResult) => void;
interface BashDefinition {
  name: string; description?: string; promptGuidelines?: string[]; parameters: Record<string | symbol, unknown> & { properties?: Record<string, unknown> };
  execute(id: string, params: { command: string; timeout?: number }, signal: AbortSignal | undefined, onUpdate: OnUpdate | undefined, ctx: unknown): Promise<ToolResult>;
  [key: string]: unknown;
}
interface PiApi { registerTool(tool: unknown): void; on(event: "session_shutdown", handler: () => unknown): void }

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const kind = Symbol.for("TypeBox.Kind");
const textOf = (r: ToolResult): string => r.content.map((c) => c.text).join("\n");
const text = (value: string, isError = false): ToolResult => ({ content: [{ type: "text", text: value }], details: undefined, ...(isError ? { isError } : {}) });

export default async function install(pi: PiApi): Promise<void> {
  const mod = await import(PI_PACKAGE) as { createBashToolDefinition(cwd: string): BashDefinition };
  const builtin = mod.createBashToolDefinition(process.cwd());
  const jobs = new BackgroundJobs();
  pi.on("session_shutdown", () => jobs.killAll());

  const properties = {
    ...(builtin.parameters.properties ?? {}),
    background: { [kind]: "Boolean", type: "boolean", description: `Run the command in the background and return a job id immediately instead of waiting. Use for anything expected to take more than a minute (test suites, builds, uploads, deploys), then follow it with bash_output. At most ${MAX_RUNNING_JOBS} jobs run at once; they end when this turn ends.` }
  };
  pi.registerTool({
    ...builtin,
    description: `${builtin.description ?? ""} Set background:true for long-running commands: it returns a job id at once; read progress with bash_output (it can wait for the job to finish) and stop it with bash_kill. Do not wait for a long command by running \`sleep N\` in the foreground.`.trim(),
    parameters: { ...builtin.parameters, properties },
    execute: async (id: string, params: { command: string; timeout?: number; background?: boolean }, signal: AbortSignal | undefined, onUpdate: OnUpdate | undefined, ctx: unknown) => {
      const { background, ...rest } = params;
      if (!background) return builtin.execute(id, rest, signal, onUpdate, ctx);
      const view = jobs.start(rest.command, async (jobSignal, onOutput): Promise<RunResult> => {
        const result = await builtin.execute(id, rest, jobSignal, (partial) => onOutput(textOf(partial), fullPathOf(partial)), ctx);
        return { text: textOf(result), isError: result.isError === true, ...(result.structuredContent?.exit_code !== undefined ? { exitCode: result.structuredContent.exit_code } : {}), ...(fullPathOf(result) ? { fullOutputPath: fullPathOf(result)! } : {}) };
      });
      if (!view) return text(`后台任务已达上限（${MAX_RUNNING_JOBS} 个同时运行）。先用 bash_output 看看已有任务，结束的会释放名额，或用 bash_kill 终止不需要的。`, true);
      return text(`已在后台启动 ${view.id}。用 bash_output 查看进度（wait_seconds 可等它结束，最长 ${MAX_WAIT_SECONDS} 秒），bash_kill 终止；本轮结束时仍在跑的任务会被终止。\n命令：${view.command.length > 200 ? `${view.command.slice(0, 200)}…` : view.command}`);
    }
  });

  pi.registerTool({
    name: "bash_output", label: "后台任务输出",
    description: `Show the status and latest output of a background job started with bash background:true. With wait_seconds it waits (up to ${MAX_WAIT_SECONDS}) until the job ends or time runs out, returning early the moment it finishes — use this instead of sleeping in the foreground.`,
    promptSnippet: "Check or wait for a background bash job.",
    parameters: { [kind]: "Object", type: "object", additionalProperties: false, required: ["id"], properties: {
      id: { [kind]: "String", type: "string", description: "Job id returned by bash background:true, e.g. job-1" },
      wait_seconds: { [kind]: "Number", type: "number", minimum: 0, maximum: MAX_WAIT_SECONDS, description: "Wait up to this many seconds for the job to finish (default 0: return the current state)" }
    } },
    execute: async (_id: string, params: { id: string; wait_seconds?: number }, signal: AbortSignal | undefined, onUpdate: OnUpdate | undefined) => {
      const view = await jobs.output(params.id, params.wait_seconds ?? 0, signal, (v) => onUpdate?.(text(describeJob(v))));
      return view ? text(describeJob(view)) : text(unknownJob(params.id, jobs), true);
    }
  });

  pi.registerTool({
    name: "bash_kill", label: "终止后台任务",
    description: "Stop a background job started with bash background:true (the whole process tree).",
    promptSnippet: "Stop a background bash job.",
    parameters: { [kind]: "Object", type: "object", additionalProperties: false, required: ["id"], properties: { id: { [kind]: "String", type: "string", description: "Job id, e.g. job-1" } } },
    execute: async (_id: string, params: { id: string }) => {
      const view = await jobs.kill(params.id);
      return view ? text(describeJob(view)) : text(unknownJob(params.id, jobs), true);
    }
  });
}

function fullPathOf(result: ToolResult): string | undefined {
  const details = result.details as { fullOutputPath?: unknown } | undefined;
  return typeof details?.fullOutputPath === "string" ? details.fullOutputPath : undefined;
}
function unknownJob(id: string, jobs: BackgroundJobs): string {
  const known = jobs.list().map((j) => j.id);
  return `没有这个后台任务：${id}。${known.length ? `当前有：${known.join("、")}` : "本轮还没有启动过后台任务"}。`;
}
