/**
 * 一级导航偏好：名称、展示位置（直接展示 / 更多 / 隐藏）与组内顺序。
 *
 * 导航偏好属于「这个平台账号」而不是某台浏览器：页面不再只写 localStorage，
 * 保存时整份写到服务端数据目录，其它设备打开或登录后读取同一份配置。
 * 浏览器缓存仍然保留，用于首帧立即按上次的样子排布，以及服务端暂时不可用时继续工作。
 *
 * 服务端只认稳定入口 ID 和受控字段，不执行任何名称内容；配置损坏时按空配置启动，
 * 不覆盖磁盘上的原文件，等下一次保存再重写。写入走「临时文件 → rename」，读者不会看到写了一半的 JSON。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type NavigationPosition = "main" | "more" | "hidden";

export interface NavigationItem {
  id: string;
  /** 自定义名称；空字符串表示沿用入口默认名称 */
  label: string;
  position: NavigationPosition;
}

export interface NavigationPreferencesView {
  version: 1;
  items: NavigationItem[];
  /** 每次保存 +1；多端据此判断是否已有更新 */
  revision: number;
  /** 服务端最近一次保存时间；从未保存过为 null */
  updatedAt: string | null;
}

interface StoredNavigationPreferences extends Omit<NavigationPreferencesView, "updatedAt"> {
  schema: 1;
  updatedAt: string | null;
}

export class NavigationPreferencesError extends Error {
  readonly code = "NAVIGATION_INPUT_INVALID";
}

const VERSION = 1;
const MAX_ITEMS = 50;
const MAX_LABEL = 12;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const emptyState = (): StoredNavigationPreferences => ({
  schema: 1,
  version: VERSION,
  items: [],
  revision: 0,
  updatedAt: null
});

const viewOf = (state: StoredNavigationPreferences): NavigationPreferencesView => ({
  version: VERSION,
  items: state.items.map((item) => ({ id: item.id, label: item.label, position: item.position })),
  revision: state.revision,
  updatedAt: state.updatedAt
});

function readState(file: string): StoredNavigationPreferences {
  if (!existsSync(file)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredNavigationPreferences>;
    if (!raw || raw.version !== VERSION || !Array.isArray(raw.items)) return emptyState();
    const items: NavigationItem[] = [];
    const seen = new Set<string>();
    for (const value of raw.items) {
      if (!value || typeof value.id !== "string" || seen.has(value.id) || !ID_PATTERN.test(value.id)) continue;
      seen.add(value.id);
      const position: NavigationPosition = value.position === "more" || value.position === "hidden" ? value.position : "main";
      const label = typeof value.label === "string" && !/[\r\n]/.test(value.label) && [...value.label.trim()].length <= MAX_LABEL ? value.label.trim() : "";
      items.push({ id: value.id, label, position });
    }
    return {
      schema: 1,
      version: VERSION,
      items,
      revision: Number.isInteger(raw.revision) && (raw.revision ?? -1) >= 0 ? raw.revision! : 0,
      updatedAt: typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt)) ? raw.updatedAt : null
    };
  } catch {
    return emptyState();
  }
}

function parseInput(input: unknown): NavigationItem[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new NavigationPreferencesError("导航配置格式不对");
  const raw = input as Record<string, unknown>;
  if (raw["version"] !== VERSION) throw new NavigationPreferencesError("不支持的导航配置版本");
  if (!Array.isArray(raw["items"])) throw new NavigationPreferencesError("导航配置缺少应用列表");
  if (raw["items"].length > MAX_ITEMS) throw new NavigationPreferencesError(`导航配置最多包含 ${MAX_ITEMS} 个应用`);
  const seen = new Set<string>();
  const items: NavigationItem[] = [];
  for (const value of raw["items"]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new NavigationPreferencesError("导航应用配置格式不对");
    const item = value as Record<string, unknown>;
    const id = item["id"];
    if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new NavigationPreferencesError("导航应用的标识格式不对");
    if (seen.has(id)) continue;
    seen.add(id);
    const position = item["position"];
    if (position !== "main" && position !== "more" && position !== "hidden") throw new NavigationPreferencesError("导航应用的展示位置不对");
    const rawLabel = item["label"] === undefined || item["label"] === null ? "" : item["label"];
    if (typeof rawLabel !== "string") throw new NavigationPreferencesError("导航应用的名称格式不对");
    const label = rawLabel.trim();
    if (/[\r\n]/.test(label) || [...label].length > MAX_LABEL) throw new NavigationPreferencesError(`导航名称最多 ${MAX_LABEL} 个字符，且不能换行`);
    items.push({ id, label, position });
  }
  return items;
}

export class NavigationPreferences {
  private state: StoredNavigationPreferences;

  constructor(private readonly file: string) {
    this.state = readState(file);
  }

  get(): NavigationPreferencesView {
    return viewOf(this.state);
  }

  /** 整份替换并落盘；返回保存后的视图（含新的 revision / updatedAt）。 */
  save(input: unknown): NavigationPreferencesView {
    const items = parseInput(input);
    const next: StoredNavigationPreferences = {
      schema: 1,
      version: VERSION,
      items,
      revision: this.state.revision + 1,
      updatedAt: new Date().toISOString()
    };
    // 先写盘再换内存状态：写入失败时继续使用原配置，不出现「内存已升级、磁盘没有」的假成功。
    this.write(next);
    this.state = next;
    return viewOf(next);
  }

  private write(state: StoredNavigationPreferences): void {
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
