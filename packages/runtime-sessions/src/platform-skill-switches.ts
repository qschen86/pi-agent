import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PLATFORM_SKILLS_ROOT, listPlatformSkills, type PlatformSkillInfo } from "./platform-skills.js";

/**
 * 平台技能开关：用户可以禁用某个技能（设置里 / 接口）。默认全部启用，只存被禁用的 id。
 * 禁用 = 不进 `/` 菜单、不展开 `/技能名`、不进首轮技能目录，等于这个技能不存在；技能目录与它产生的数据一概不动。
 * 配置属于这个实例（所有设备共用），写盘方式同 app-switches：临时文件 → rename；文件损坏按「全部启用」处理，不覆盖原文件，等下一次保存再重写。
 * 记下的 id 即使技能目录暂时不存在也保留（卸载后重装仍是禁用状态）。
 */
export class PlatformSkillSwitchError extends Error {
  constructor(message: string, readonly code: "SKILL_SWITCH_INVALID" | "SKILL_SWITCH_UNKNOWN" = "SKILL_SWITCH_INVALID") { super(message); }
}

export interface PlatformSkillSwitchItem extends PlatformSkillInfo { enabled: boolean }
export interface PlatformSkillSwitchesView { version: 1; revision: number; updatedAt: string | null; skills: PlatformSkillSwitchItem[] }
interface Stored { schema: 1; disabled: string[]; revision: number; updatedAt: string | null }

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const empty = (): Stored => ({ schema: 1, disabled: [], revision: 0, updatedAt: null });

function read(file: string): Stored {
  try {
    if (!existsSync(file)) return empty();
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Stored>;
    return {
      schema: 1,
      disabled: [...new Set((Array.isArray(raw.disabled) ? raw.disabled : []).filter((x): x is string => typeof x === "string" && ID_RE.test(x)))].sort(),
      revision: Number.isInteger(raw.revision) && raw.revision! >= 0 ? raw.revision! : 0,
      updatedAt: typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt)) ? raw.updatedAt : null
    };
  } catch { return empty(); }
}

export class PlatformSkillSwitches {
  private state: Stored;
  constructor(private readonly file: string, private readonly root = PLATFORM_SKILLS_ROOT) { this.state = read(file); }

  disabledIds(): readonly string[] { return this.state.disabled; }
  enabled(id: string): boolean { return !this.state.disabled.includes(id); }

  get(): PlatformSkillSwitchesView {
    return {
      version: 1, revision: this.state.revision, updatedAt: this.state.updatedAt,
      skills: listPlatformSkills(this.root).map((s) => ({ ...s, enabled: this.enabled(s.id) }))
    };
  }

  /** 启用或禁用一个技能；只接受目录里真实存在的技能。返回保存后的视图。 */
  set(id: string, enabled: unknown): PlatformSkillSwitchesView {
    if (typeof enabled !== "boolean") throw new PlatformSkillSwitchError("enabled 必须是 true 或 false");
    if (!listPlatformSkills(this.root).some((s) => s.id === id)) throw new PlatformSkillSwitchError(`没有这个技能：${id}`, "SKILL_SWITCH_UNKNOWN");
    const next = new Set(this.state.disabled);
    if (enabled) next.delete(id); else next.add(id);
    const stored: Stored = { schema: 1, disabled: [...next].sort(), revision: this.state.revision + 1, updatedAt: new Date().toISOString() };
    // 先写盘再换内存状态：写入失败时继续用原配置。
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
