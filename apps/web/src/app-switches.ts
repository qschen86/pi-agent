/**
 * 可选应用开关：设置里启用 / 关闭笔记、小游戏等（需求 v3.123）。
 *
 * - 只有清单里 `switchable` 的应用能开关；基础应用始终开启，私有应用不在这里出现。
 * - 默认值按实例类型：完整实例（维护者自己的）沿用现状全部开启；公开版（homebrew）默认只开基础，可选应用要自己打开。
 * - 关闭只是隐藏入口、拒绝请求、停掉后台任务，**不删任何数据**；重新打开后数据原样回来。
 * - 有硬依赖的应用跟着走：关掉笔记，依赖它的日程一起不可用；打开日程依赖的笔记会一并打开。
 * - 配置属于这个实例（所有设备共用），整份落盘：临时文件 → rename；文件损坏时按默认值启动，不覆盖原文件，等下一次保存再重写。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { APPS, appById, switchableApps, withDependents } from "./app-manifest.mjs";
import type { AppEntry, InstanceEdition } from "./app-manifest.mjs";

export class AppSwitchError extends Error {
  constructor(message: string, readonly code: "APP_SWITCH_INVALID" | "APP_SWITCH_UNKNOWN" = "APP_SWITCH_INVALID") { super(message); }
}

export interface AppSwitchItem {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  /** 打开它会连带打开的应用名（硬依赖） */
  needs: string[];
  /** 关掉它会连带不可用的应用名 */
  alsoOff: string[];
}

export interface AppSwitchesView {
  version: 1;
  edition: InstanceEdition;
  revision: number;
  updatedAt: string | null;
  apps: AppSwitchItem[];
  /** 当前不可用的应用（含连带的）所对应的前端入口：客户端据此隐藏底栏按钮、不加载路由模块 */
  disabled: { apps: string[]; views: string[]; routeModules: string[] };
}

interface Stored { schema: 1; enabled: Record<string, boolean>; revision: number; updatedAt: string | null }

const empty = (): Stored => ({ schema: 1, enabled: {}, revision: 0, updatedAt: null });

function read(file: string): Stored {
  try {
    if (!existsSync(file)) return empty();
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Stored>;
    const enabled: Record<string, boolean> = {};
    for (const [id, value] of Object.entries(raw.enabled ?? {})) if (typeof value === "boolean" && appById(id)) enabled[id] = value;
    return {
      schema: 1, enabled,
      revision: Number.isInteger(raw.revision) && raw.revision! >= 0 ? raw.revision! : 0,
      updatedAt: typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt)) ? raw.updatedAt : null
    };
  } catch { return empty(); }
}

export class AppSwitches {
  private state: Stored;
  private readonly switchable: AppEntry[];

  /**
   * @param defaultOn 'all'：可选应用默认全开（完整实例，保持现状）；'core'：默认只开基础（公开版）
   */
  constructor(private readonly file: string, private readonly options: { edition: InstanceEdition; defaultOn: "all" | "core"; apps?: AppEntry[] }) {
    this.switchable = switchableApps(options.edition, options.apps ?? APPS);
    this.state = read(file);
  }

  private isOn(id: string): boolean { return this.state.enabled[id] ?? this.options.defaultOn === "all"; }

  /** 当前不可用的应用 id：用户关掉的，加上依赖它们的。 */
  disabledIds(): Set<string> {
    const off = this.switchable.filter((app) => !this.isOn(app.id)).map((app) => app.id);
    return withDependents(off, this.options.apps ?? APPS);
  }

  enabled(id: string): boolean { return !this.disabledIds().has(id); }

  get(): AppSwitchesView {
    const apps = this.options.apps ?? APPS;
    const disabled = this.disabledIds();
    const name = (id: string) => appById(id, apps)?.name ?? id;
    const items = this.switchable.map((app): AppSwitchItem => ({
      id: app.id, name: app.name, description: app.description ?? "", enabled: !disabled.has(app.id),
      needs: (app.requires ?? []).filter((id) => this.switchable.some((s) => s.id === id)).map(name),
      alsoOff: [...withDependents([app.id], apps)].filter((id) => id !== app.id).map(name)
    }));
    const off = apps.filter((app) => disabled.has(app.id));
    return {
      version: 1, edition: this.options.edition, revision: this.state.revision, updatedAt: this.state.updatedAt, apps: items,
      disabled: { apps: off.map((app) => app.id), views: off.flatMap((app) => app.views), routeModules: off.flatMap((app) => app.routeModules) }
    };
  }

  /** 开或关一个应用；打开时把它依赖的应用一并打开。返回保存后的视图。 */
  set(id: string, enabled: unknown): AppSwitchesView {
    if (typeof enabled !== "boolean") throw new AppSwitchError("enabled 必须是 true 或 false");
    const app = appById(id, this.options.apps ?? APPS);
    if (!app) throw new AppSwitchError(`没有这个应用：${id}`, "APP_SWITCH_UNKNOWN");
    if (!this.switchable.some((item) => item.id === id)) throw new AppSwitchError(`${app.name}不能在设置里开关`);
    const next: Record<string, boolean> = { ...this.state.enabled, [id]: enabled };
    if (enabled) for (const need of app.requires ?? []) if (this.switchable.some((item) => item.id === need)) next[need] = true;
    const stored: Stored = { schema: 1, enabled: next, revision: this.state.revision + 1, updatedAt: new Date().toISOString() };
    // 先写盘再换内存状态：写入失败时继续用原配置，不出现「内存已变、磁盘没有」的假成功。
    this.write(stored);
    this.state = stored;
    return this.get();
  }

  private write(state: Stored): void {
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
