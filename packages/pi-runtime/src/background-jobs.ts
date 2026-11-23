/**
 * Pi 的 bash 后台运行：任务登记与查询，不带任何 import（与 pi-approval-extension 一起复制进宿主管的只读 guard 目录）。
 *
 * 为什么存在：Pi 的 bash 是同步的，没有 Claude 那样的 run_in_background，模型想等一个几分钟的任务（测试、上传、部署）
 * 只能前台 `sleep 150; 查日志` 轮询，整条命令占住这一轮，也让平台的卡住看门狗没法分辨「在等」和「卡死」。
 *
 * 权限与写入限制不在这里另起一套：后台启动走的就是 `bash` 工具本身（带 background:true），模型发出的调用和前台完全一样地
 * 经过 tool_call 闸门、community 的命令规则、扫描拦截；真正执行也还是 pi 内置 bash 的同一条 spawn 路径，继承同一层 OS 沙箱。
 * 本模块只负责「已经被放行并启动」的任务：记录输出、等待结束、终止。bash_output / bash_kill 只能碰本进程里自己登记的任务，
 * 不执行任何新命令。
 */

export interface RunResult { text: string; isError: boolean; exitCode?: number; fullOutputPath?: string }
/** 一次 bash 执行：把输出的最新快照通过 onOutput 推出来，结束时 resolve；被 signal 终止时 reject。 */
export type RunBash = (signal: AbortSignal, onOutput: (text: string, fullOutputPath?: string) => void) => Promise<RunResult>;

export type JobStatus = "running" | "exited" | "failed" | "killed";
export interface JobView {
  id: string;
  command: string;
  status: JobStatus;
  elapsedSeconds: number;
  exitCode?: number;
  output: string;
  fullOutputPath?: string;
}

interface Job {
  id: string;
  command: string;
  startedAt: number;
  endedAt?: number;
  status: JobStatus;
  exitCode?: number;
  output: string;
  fullOutputPath?: string;
  controller: AbortController;
  done: Promise<void>;
  /** 每次输出变化 +1，等待方据此判断有没有新内容 */
  version: number;
}

/** 同时在跑的后台任务上限：防止模型一口气起一堆把机器打满。 */
export const MAX_RUNNING_JOBS = 4;
/** 单次 bash_output 最长等待：到点还没结束就返回「仍在运行」，由模型决定继续等还是干别的。 */
export const MAX_WAIT_SECONDS = 300;
/** 返回给模型的输出尾部上限（字符）：完整输出另存在 fullOutputPath。 */
const OUTPUT_TAIL_CHARS = 12_000;
const POLL_MS = 500;

const now = (): number => Date.now();

export class BackgroundJobs {
  private readonly jobs = new Map<string, Job>();
  private seq = 0;

  running(): number {
    let n = 0;
    for (const j of this.jobs.values()) if (j.status === "running") n++;
    return n;
  }

  /** 启动一个后台任务并立刻返回；超过并发上限返回 undefined。 */
  start(command: string, run: RunBash): JobView | undefined {
    if (this.running() >= MAX_RUNNING_JOBS) return undefined;
    const id = `job-${++this.seq}`;
    const controller = new AbortController();
    const job: Job = { id, command, startedAt: now(), status: "running", output: "", controller, done: Promise.resolve(), version: 0 };
    job.done = run(controller.signal, (text, fullOutputPath) => {
      if (text === job.output && fullOutputPath === job.fullOutputPath) return;
      job.output = text; job.version++;
      if (fullOutputPath) job.fullOutputPath = fullOutputPath;
    }).then((result) => {
      job.output = result.text; job.version++;
      if (result.fullOutputPath) job.fullOutputPath = result.fullOutputPath;
      if (result.exitCode !== undefined) job.exitCode = result.exitCode;
      job.status = controller.signal.aborted ? "killed" : result.isError ? "failed" : "exited";
    }, (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // 内置 bash 被终止时把已有输出放进错误信息里
      job.output = message || job.output; job.version++;
      job.status = controller.signal.aborted ? "killed" : "failed";
    }).finally(() => { job.endedAt = now(); });
    this.jobs.set(id, job);
    return this.view(job);
  }

  get(id: string): JobView | undefined {
    const job = this.jobs.get(id);
    return job ? this.view(job) : undefined;
  }

  list(): JobView[] { return [...this.jobs.values()].map((j) => this.view(j)); }

  /**
   * 取任务当前状态；waitSeconds>0 且任务还在跑时，等到它结束、等够时间、有新输出（onProgress）或被 signal 打断。
   * 等待期间每有新输出就回调一次：调用方把它转成工具进度，平台据此知道「没卡住」。
   */
  async output(id: string, waitSeconds: number, signal?: AbortSignal, onProgress?: (view: JobView) => void): Promise<JobView | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const deadline = now() + Math.min(Math.max(waitSeconds, 0), MAX_WAIT_SECONDS) * 1000;
    let seen = job.version;
    while (job.status === "running" && now() < deadline && !signal?.aborted) {
      await Promise.race([sleep(Math.min(POLL_MS, Math.max(0, deadline - now())), signal), job.done]);
      if (job.version !== seen) { seen = job.version; onProgress?.(this.view(job)); }
    }
    return this.view(job);
  }

  /** 终止任务（整棵进程树由内置 bash 的 abort 路径负责）；返回终止后的状态。 */
  async kill(id: string): Promise<JobView | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status === "running") { job.controller.abort(); await job.done; }
    return this.view(job);
  }

  /** pi 进程收尾：把还在跑的都停掉。 */
  async killAll(): Promise<void> {
    await Promise.all([...this.jobs.values()].filter((j) => j.status === "running").map((j) => { j.controller.abort(); return j.done; }));
  }

  private view(job: Job): JobView {
    return {
      id: job.id, command: job.command, status: job.status,
      elapsedSeconds: Math.round(((job.endedAt ?? now()) - job.startedAt) / 1000),
      ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
      output: job.output.length > OUTPUT_TAIL_CHARS ? `…（只显示最后 ${OUTPUT_TAIL_CHARS} 字符）\n${job.output.slice(-OUTPUT_TAIL_CHARS)}` : job.output,
      ...(job.fullOutputPath ? { fullOutputPath: job.fullOutputPath } : {})
    };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    function done(): void { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });
}

const STATUS_TEXT: Record<JobStatus, string> = { running: "运行中", exited: "已结束", failed: "失败", killed: "已终止" };

/** 给模型看的文本：状态行 + 命令 + 输出尾部。 */
export function describeJob(view: JobView): string {
  const exit = view.exitCode !== undefined ? `，退出码 ${view.exitCode}` : "";
  const lines = [`${view.id} ${STATUS_TEXT[view.status]}（已 ${view.elapsedSeconds} 秒${exit}）`, `命令：${view.command.length > 200 ? `${view.command.slice(0, 200)}…` : view.command}`];
  if (view.fullOutputPath) lines.push(`完整输出：${view.fullOutputPath}`);
  lines.push(view.output ? `--- 输出 ---\n${view.output}` : "（暂无输出）");
  return lines.join("\n");
}
