/**
 * 每晚分诊的定时（V1.4 §6.1）：北京时间 03:30 跑一次；服务在那之后才启动、当天还没跑过的，启动 5 分钟后补一次。
 * 只在前置代理实际转发给本进程时跑（蓝绿切换期间另一个进程不跑），同一天只跑一次由 runNightly 内的锁保证。
 *
 * 北京时间 03:30 = UTC 19:30，落在 DeepSeek 的波谷（峰时是 UTC 01:00–04:00、06:00–10:00 的工作日）。
 * 补跑不受计划时刻约束，可能落在峰时，所以补跑前先判峰谷：在峰时就等到下一个波谷起点再跑。
 */
import { isPeak, nextOffPeak } from "../deepseek-peak.js";
import { beijingRunToday, nextBeijingRunAt } from "../platform-time.js";
import { dailyBeijingSchedule, registerPlatformScheduledTask } from "../platform-scheduled-tasks.js";
import type { DiagnosticTriage } from "./triage.js";

/** 下一次北京时间 hour:minute（测试与页面说明都按北京时间）。 */
export function nextRunAt(now: Date, hour: number, minute: number): Date {
  return nextBeijingRunAt(now, hour, minute);
}

/** 补跑要等多久：不在峰时就按 base 延迟；在峰时就等到下一个波谷起点。 */
export function catchUpWait(now: Date, baseMs: number, peak: (at: Date) => boolean = isPeak, offPeak: (at: Date) => Date = nextOffPeak): number {
  if (!peak(now)) return baseMs;
  return Math.max(baseMs, offPeak(now).getTime() - now.getTime());
}

export function startTriageScheduler(options: {
  triage: DiagnosticTriage;
  isServing: () => Promise<boolean>;
  log?: (m: string) => void;
  now?: () => Date;
  catchUpDelayMs?: number;
  before?: () => Promise<unknown>;
  /** 测试注入：默认真实峰谷判定 */
  peak?: (at: Date) => boolean;
  offPeak?: (at: Date) => Date;
}): () => void {
  const now = options.now ?? (() => new Date());
  const peak = options.peak ?? isPeak;
  const offPeak = options.offPeak ?? nextOffPeak;
  const { hour, minute } = options.triage.settings;
  // 登记到平台定时任务清单：时间以实际设置为准（设置里改过就按新的画），Agent 日历不用改代码就会跟上。
  registerPlatformScheduledTask({
    id: "diagnostics-triage",
    schedule: dailyBeijingSchedule(hour, minute),
    source: "apps/web/src/diagnostics/scheduler.ts"
  });
  let timer: NodeJS.Timeout | undefined, catchUp: NodeJS.Timeout | undefined, stopped = false;
  const fire = async () => {
    try {
      if (!(await options.isServing())) { options.log?.("分诊：本进程不是当前在线槽位，跳过"); return; }
      // D 期：先核对修复上线与验证，复发的问题本轮分诊就能另起 episode
      try { await options.before?.(); } catch (e) { options.log?.(`修复验证失败：${(e as Error).message}`); }
      const r = await options.triage.runNightly();
      if (r.triaged || r.created.length) options.log?.(`分诊：处理 ${r.triaged} 个问题，新建待办 ${r.created.length} 条${r.skipped ? `（${r.skipped}）` : ""}`);
    } catch (e) { options.log?.(`分诊失败：${(e as Error).message}`); }
  };
  const schedule = () => {
    if (stopped) return;
    const at = nextRunAt(now(), hour, minute);
    timer = setTimeout(() => { void fire().finally(schedule); }, Math.max(1_000, at.getTime() - now().getTime()));
    timer.unref?.();
  };
  // 漏跑补偿：北京今天已过计划时刻、而且今天还没有完成的运行记录
  const today = now();
  const due = beijingRunToday(today, hour, minute);
  const startCatchUp = () => {
    if (stopped) return;
    const at = now();
    const base = options.catchUpDelayMs ?? 5 * 60_000;
    const wait = catchUpWait(at, base, peak, offPeak);
    if (wait > base) options.log?.(`分诊：补跑落在峰时，推迟到 ${new Date(at.getTime() + wait).toISOString()}（波谷）`);
    catchUp = setTimeout(() => { void fire(); }, Math.max(1_000, wait));
    catchUp.unref?.();
  };
  if (today.getTime() > due.getTime()) startCatchUp();
  schedule();
  return () => { stopped = true; clearTimeout(timer); clearTimeout(catchUp); };
}
