/**
 * 平台定时任务清单：Agent 日历的唯一来源。
 *
 * 两处登记：
 * - 下面的静态清单：平台承诺的固定时间（含 launchd 包装的任务），进程还没启动调度器时也能列出；
 * - 运行时登记 `registerPlatformScheduledTask()`：调度器启动时把自己的实际时间写进来。
 *
 * 新增平台定时任务只要在调度器启动时登记一次，就默认进 Agent 日历，不用再改 agent-calendar.ts；
 * 已经装好的 launchd `com.pi-agent.*` 任务仍由 agent-calendar.ts 自动扫描补充。
 * 同一 id 以运行时登记的为准（例如分诊时间在设置里改过），新 id 追加在后面。
 *
 * 平台内定时器与平台承诺的固定时间一律按北京时间解释（见 platform-time.ts）；
 * launchd 的 StartCalendarInterval 仍按宿主机本地时间触发，扫描时再换算。
 */
export interface PlatformScheduledTaskDefinition {
  id: string;
  /** 平台应用：平台 / 待办 / 会话 / 资源 / 产物 */
  app: string;
  /** 场景：故障诊断、质量保障、可用性、备份、待办推荐… */
  scene: string;
  /** 任务名 */
  name: string;
  /** 标准 RRULE；间隔任务用 FREQ=SECONDLY / MINUTELY 表示 cadence（按北京时间解释） */
  schedule: string;
  /** 平台承诺的固定时间：launchd 用间隔轮询时，日历仍按这个时间展示 */
  canonicalSchedule?: string;
  /** 对应的 launchd 标签；有标签但本机没装时状态记为 unknown */
  launchdLabel?: string;
  description: string;
  /** 本机来源文件 / launchd 标签，只用于诊断，不展示在日历里 */
  source: string;
  /** 这条任务会调模型时标明供应商，事件里会写峰 / 谷计费时段 */
  billing?: "deepseek";
  /** 关闭时（例如 PI_AGENT_TRIAGE=off）不出现在日历里 */
  enabled?: () => boolean;
}

/** 调度器启动时登记自己的时间；只写要覆盖 / 新增的字段。 */
export interface PlatformScheduledTaskRegistration {
  id: string;
  schedule: string;
  app?: string;
  scene?: string;
  name?: string;
  description?: string;
  source?: string;
  canonicalSchedule?: string;
  launchdLabel?: string;
  billing?: "deepseek";
  enabled?: () => boolean;
}

/** 每天北京时间 hour:minute 的 RRULE（平台定时任务的统一写法）。 */
export function dailyBeijingSchedule(hour: number, minute: number): string {
  const h = Number.isFinite(hour) ? Math.max(0, Math.min(23, Math.floor(hour))) : 0;
  const m = Number.isFinite(minute) ? Math.max(0, Math.min(59, Math.floor(minute))) : 0;
  return `RRULE:FREQ=DAILY;BYHOUR=${h};BYMINUTE=${m};BYSECOND=0`;
}

/** 平台自己注册 / 运行的固定时间任务（静态清单）。 */
export function defaultPlatformScheduledTasks(): PlatformScheduledTaskDefinition[] {
  return [
    {
      id: "error-stats-nightly",
      app: "平台",
      scene: "故障诊断",
      name: "每晚故障联合分析",
      schedule: dailyBeijingSchedule(23, 50),
      // 北京 23:50 = UTC 15:50，不在 DeepSeek 峰时；补跑若落在峰时会等到波谷。
      description: "每天北京时间 23:50 联合分析前端、服务端、工具、部署与记忆报错；同根因关联已有待办，值得修复才生成平台 / debug 待办，结果统一在设置的错误统计查看。",
      billing: "deepseek",
      source: "apps/web/src/error-stats/service.ts"
    },
    {
      id: "note-ranking-calibration",
      app: "平台",
      scene: "待办推荐",
      name: "排序校准",
      schedule: dailyBeijingSchedule(3, 0),
      // 北京 03:00 = UTC 19:00，同样在 DeepSeek 波谷。
      description: "Web 进程每天北京时间 03:00 按最近的忽略 / 启动 / 完成记录校准推荐排序权重；服务在 03:00 之后才启动、当天还没跑过时，启动 5 分钟后补一次。",
      billing: "deepseek",
      source: "apps/web/src/note-ranking.ts"
    },
    {
      id: "nightly-regression",
      launchdLabel: "com.pi-agent.nightly-regression",
      app: "平台",
      scene: "质量保障",
      name: "每日完整回归",
      schedule: dailyBeijingSchedule(4, 0),
      canonicalSchedule: dailyBeijingSchedule(4, 0),
      description: "每天北京时间 04:00 执行完整回归；launchd 每小时检查一次，过了北京时间 04:00 且当天还没跑过才启动。",
      source: "com.pi-agent.nightly-regression"
    },
    {
      id: "nightly-regression-check",
      launchdLabel: "com.pi-agent.nightly-regression-check",
      app: "平台",
      scene: "质量保障",
      name: "回归未完成检查",
      schedule: "RRULE:FREQ=HOURLY;INTERVAL=1",
      description: "每小时检查每日完整回归是否按时完成，未完成时建待办。",
      source: "com.pi-agent.nightly-regression-check"
    },
    {
      id: "health-guard",
      launchdLabel: "com.pi-agent.health-guard",
      app: "平台",
      scene: "可用性",
      name: "健康守护",
      schedule: "RRULE:FREQ=SECONDLY;INTERVAL=30",
      description: "每 30 秒检查 Web 服务健康状态，异常时恢复。",
      source: "com.pi-agent.health-guard"
    },
    {
      id: "backup-host-activation",
      launchdLabel: "com.pi-agent.backup-host-activation",
      app: "平台",
      scene: "备份",
      name: "备份主机激活",
      schedule: "RRULE:FREQ=SECONDLY;INTERVAL=60",
      description: "每 60 秒检查备份主机是否需要在空闲时激活。",
      source: "com.pi-agent.backup-host-activation"
    }
  ];
}

const registered = new Map<string, PlatformScheduledTaskRegistration>();

/**
 * 调度器启动时登记自己的实际时间。增量任务只走这一步就默认进 Agent 日历：
 * 不在静态清单里的 id 按「平台 · 平台任务 · id」补充，说明写默认文案。
 */
export function registerPlatformScheduledTask(task: PlatformScheduledTaskRegistration): void {
  if (!task || typeof task.id !== "string" || !task.id.trim()) return;
  if (typeof task.schedule !== "string" || !/^RRULE:/i.test(task.schedule.trim())) return;
  registered.set(task.id, { ...task, id: task.id.trim(), schedule: task.schedule.trim() });
}

/** 已登记的运行时任务（按 id 排序，便于测试与诊断）。 */
export function registeredPlatformScheduledTasks(): PlatformScheduledTaskDefinition[] {
  const defaults = new Map(defaultPlatformScheduledTasks().map((task) => [task.id, task]));
  return [...registered.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((task) => mergePlatformTask(task, defaults.get(task.id)));
}

/** 静态清单 + 运行时登记；同一 id 以运行时登记的时间为准，新 id 追加在后面。 */
export function platformScheduledTasks(): PlatformScheduledTaskDefinition[] {
  const merged = new Map<string, PlatformScheduledTaskDefinition>();
  for (const task of defaultPlatformScheduledTasks()) merged.set(task.id, task);
  for (const task of [...registered.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    merged.set(task.id, mergePlatformTask(task, merged.get(task.id)));
  }
  return [...merged.values()];
}

/** 测试用：清掉运行时登记，回到静态清单。 */
export function resetPlatformScheduledTaskRegistry(): void {
  registered.clear();
}

function mergePlatformTask(
  task: PlatformScheduledTaskRegistration,
  base: PlatformScheduledTaskDefinition | undefined
): PlatformScheduledTaskDefinition {
  const launchdLabel = task.launchdLabel ?? base?.launchdLabel;
  const canonicalSchedule = task.canonicalSchedule ?? base?.canonicalSchedule;
  const billing = task.billing ?? base?.billing;
  const enabled = task.enabled ?? base?.enabled;
  return {
    id: task.id,
    app: task.app ?? base?.app ?? "平台",
    scene: task.scene ?? base?.scene ?? "平台任务",
    name: task.name ?? base?.name ?? task.id,
    schedule: task.schedule,
    ...(launchdLabel ? { launchdLabel } : {}),
    ...(canonicalSchedule ? { canonicalSchedule } : {}),
    description: task.description ?? base?.description ?? `平台定时任务 ${task.id}（按北京时间）`,
    source: task.source ?? base?.source ?? task.id,
    ...(billing ? { billing } : {}),
    ...(enabled ? { enabled } : {})
  };
}
