/**
 * 应用数据目录：每个应用只经由自己的 AppData 取得数据路径（需求 v3.123）。
 *
 * 物理布局由 data-layout.mjs 决定：现有实例是 flat（<dataDir>/<名字>，不动线上数据），新实例（公开版）是
 * apps（<dataDir>/apps/<应用 id>/<名字>）。调用方不用关心，路径一律从这里取；这里管的是归属：
 *   - path()    只能取清单里该应用 `data` 登记的名字，否则抛错；
 *   - foreign() 读别的应用的数据，必须先在清单的 `dataReads` 登记；
 *   - ensureDataSkeleton() 首次启动按发布版本建出空骨架（只建该版本发布的应用的目录）；
 *   - strayDataNames() 找出数据目录里不属于该版本发布应用的条目，公开版验收用。
 * 数据一律是私有数据：发布包不带，也不进公开仓库。
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { APPS, appById, dataName, isDataDir, shippedApps } from "./app-manifest.mjs";
import { LAYOUT_MARKER, adoptAppsLayout, appRoot, ensureAppRoot, layoutOf } from "./data-layout.mjs";
import type { DataLayout } from "./data-layout.mjs";
import type { AppEdition, AppEntry } from "./app-manifest.mjs";

export class AppData {
  readonly app: AppEntry;

  constructor(readonly dataDir: string, appId: string, private readonly apps: AppEntry[] = APPS) {
    const app = appById(appId, apps);
    if (!app) throw new Error(`应用清单里没有这个应用：${appId}`);
    this.app = app;
  }

  /** 本应用自己的数据：name 必须是清单登记的条目（目录不用写尾斜杠），rest 是其下的子路径。 */
  path(name: string, ...rest: string[]): string {
    if (!this.app.data.some((entry) => dataName(entry) === name)) {
      throw new Error(`应用 ${this.app.id} 没有登记数据 "${name}"（见 app-manifest.mjs 的 data）`);
    }
    return join(ensureAppRoot(this.dataDir, this.app.id), name, ...rest);
  }

  /** 交给「自己拼路径」的代码（如会话运行时包）的根目录：它在这个根下面按登记的名字建目录，结果和 path() 一致。 */
  root(): string { return ensureAppRoot(this.dataDir, this.app.id); }

  /** 读别的应用的数据：必须在本应用的 dataReads 里登记 `<应用id>:<名字>`。 */
  foreign(ownerId: string, name: string, ...rest: string[]): string {
    if (!this.app.dataReads?.includes(`${ownerId}:${name}`)) {
      throw new Error(`应用 ${this.app.id} 没有登记读取 ${ownerId}:${name}（见 app-manifest.mjs 的 dataReads）`);
    }
    return join(appRoot(this.dataDir, ownerId), name, ...rest);
  }

  /** 建出本应用登记的数据目录（权限 0700）。文件由各 store 按需创建。 */
  ensureDirs(): string[] {
    const created: string[] = [];
    for (const entry of this.app.data) {
      if (!isDataDir(entry)) continue;
      const dir = join(appRoot(this.dataDir, this.app.id), dataName(entry));
      if (!existsSync(dir)) { mkdirSync(dir, { recursive: true, mode: 0o700 }); created.push(dataName(entry)); }
    }
    return created;
  }
}

export const appData = (dataDir: string, appId: string): AppData => new AppData(dataDir, appId);

/**
 * 首次启动：给该发布版本带出的每个应用建出空的数据目录，返回新建的目录名。
 * layout 为 'apps' 且数据目录是全新的，就按应用分目录（写布局标记）；已有数据的目录保持原布局。
 */
export function ensureDataSkeleton(dataDir: string, edition: AppEdition, options: { layout?: DataLayout } = {}): string[] {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (options.layout === "apps") adoptAppsLayout(dataDir);
  return shippedApps(edition).flatMap((app) => new AppData(dataDir, app.id).ensureDirs());
}

/** 数据目录里不属于该发布版本任何应用的条目（私有应用的数据、历史备份等）；apps 布局下按 apps/<id>/<名字> 报告。 */
export function strayDataNames(dataDir: string, edition: AppEdition): string[] {
  if (!existsSync(dataDir)) return [];
  const shipped = shippedApps(edition);
  const isOwned = (known: Set<string>, name: string) => known.has(name) || [...known].some((k) => name.startsWith(`${k}.`));
  if (layoutOf(dataDir) !== "apps") {
    const known = new Set(shipped.flatMap((app) => app.data.map(dataName)));
    return readdirSync(dataDir).filter((name) => !isOwned(known, name)).sort();
  }
  const stray: string[] = readdirSync(dataDir).filter((name) => name !== "apps" && name !== LAYOUT_MARKER);
  const appsDir = join(dataDir, "apps");
  if (existsSync(appsDir)) for (const id of readdirSync(appsDir)) {
    const app = shipped.find((item) => item.id === id);
    if (!app) { stray.push(`apps/${id}`); continue; }
    const known = new Set(app.data.map(dataName));
    for (const name of readdirSync(join(appsDir, id))) if (!isOwned(known, name)) stray.push(`apps/${id}/${name}`);
  }
  return stray.sort();
}
