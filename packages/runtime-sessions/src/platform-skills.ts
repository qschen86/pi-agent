import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 平台级技能：仓库 skills/platform/<id>/SKILL.md。与 skills/information-design 那类「钉进执行计划」的技能不同，
 * 这里的技能面向所有 runtime 会话（Pi / Codex / Claude Code）：用户在输入框里写 `/技能名`，
 * 发送给 runtime 之前由平台把技能说明展开到这一轮的提示词前面。展开只发生在派发那一刻，
 * 会话里记录的用户消息、幂等键与排队摘要都仍是用户原文。
 */
export const PLATFORM_SKILLS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../skills/platform");

export interface PlatformSkillInfo {
  /** 稳定 ASCII 标识，也可当触发词：/product-promo-video */
  id: string;
  /** 显示名，也是首选触发词：/产品宣传视频 */
  name: string;
  description: string;
  trigger: string;
}
interface LoadedSkill extends PlatformSkillInfo { dir: string; body: string; file: string }

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NAME_RE = /^[^\s/\\<>"'`]{1,32}$/u;
/**
 * 技能说明连同用户消息要放进 100000 字符的提示词上限；runtime 回显的用户消息还会被截到 20000 字符（redact.ts LIMITS.message），
 * 分隔线必须落在截断位置之前，展示层才能认出平台补的那一段，所以单个技能说明远小于它。
 */
export const PLATFORM_SKILL_MAX_CHARS = 12_000;

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return undefined;
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!] = kv[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { meta, body: m[2]! };
}

const cache = new Map<string, { stamp: string; skills: LoadedSkill[] }>();

/** 扫描技能目录。格式不对的技能被跳过（不抛错，坏技能不能拖垮会话派发）。 */
function load(root: string): LoadedSkill[] {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const files = entries.map((d) => join(root, d, "SKILL.md")).filter(existsSync);
  const stamp = files.map((f) => `${f}:${statSync(f).mtimeMs}:${statSync(f).size}`).join("|");
  const hit = cache.get(root);
  if (hit?.stamp === stamp) return hit.skills;
  const skills: LoadedSkill[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    try {
      const parsed = parseFrontmatter(readFileSync(file, "utf8"));
      if (!parsed) continue;
      const { id, name, description } = parsed.meta;
      if (!id || !name || !description || !ID_RE.test(id) || !NAME_RE.test(name)) continue;
      if (seen.has(id) || seen.has(name)) continue;
      const dir = realpathSync(dirname(file));
      const body = parsed.body.replace(/<SKILL_DIR>/g, dir).trim();
      if (!body || body.length > PLATFORM_SKILL_MAX_CHARS) continue;
      seen.add(id); seen.add(name);
      skills.push({ id, name, description, trigger: `/${name}`, dir, body, file: join(dir, "SKILL.md") });
    } catch { /* 读不了的技能当作不存在 */ }
  }
  cache.set(root, { stamp, skills });
  return skills;
}

/** 被用户在设置里禁用的技能 id：不进 `/` 菜单、不展开、不进首轮目录；技能目录和文件原样保留。 */
export type DisabledSkills = readonly string[];
const enabledSkills = (root: string, disabled: DisabledSkills = []): LoadedSkill[] => load(root).filter((s) => !disabled.includes(s.id));

export function listPlatformSkills(root = PLATFORM_SKILLS_ROOT, disabled: DisabledSkills = []): PlatformSkillInfo[] {
  return enabledSkills(root, disabled).map(({ id, name, description, trigger }) => ({ id, name, description, trigger }));
}

/** 平台补的技能文字与用户原文之间的分隔；用户原文一定在它后面。展示层靠它还原用户原文。 */
export const USER_MESSAGE_MARK = "\n\n【用户消息】\n";

/**
 * 用户消息的展示文字：发给 runtime 的提示词前面可能带着平台补的技能目录 / 技能说明，
 * runtime 的原生历史会把它们当成用户说的话原样记下来（Pi / Codex / Claude Code 都是）。
 * 会话里只显示用户自己写的那部分；不是平台补的（不以「【平台技能」开头、或没有分隔）原样返回。
 */
export function userVisiblePrompt(text: string): string {
  if (!text.startsWith("【平台技能") && !text.startsWith("【平台公共记忆")) return text;
  const at = text.indexOf(USER_MESSAGE_MARK);
  return at < 0 ? text : text.slice(at + USER_MESSAGE_MARK.length);
}

/**
 * 在提示词前补一段平台前言（如公共记忆）。已经带平台前缀的提示词（技能说明 / 目录）把前言放在最前面，
 * 用户原文仍在分隔符之后；前言里不允许出现分隔符本身，否则展示层会把用户原文切错位置。
 */
export function prependPlatformPreamble(preamble: string, prompt: string): string {
  const safe = preamble.split(USER_MESSAGE_MARK.trim()).join("").trim();
  if (!safe) return prompt;
  if ((prompt.startsWith("【平台技能") || prompt.startsWith("【平台公共记忆")) && prompt.includes(USER_MESSAGE_MARK)) return `${safe}\n\n${prompt}`;
  return `${safe}${USER_MESSAGE_MARK}${prompt}`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 提示词里以 `/技能名` 或 `/技能id` 开头的行（后面是空白或行尾）。返回按出现顺序去重的技能。 */
export function mentionedPlatformSkills(prompt: string, root = PLATFORM_SKILLS_ROOT, disabled: DisabledSkills = []): PlatformSkillInfo[] {
  return mentioned(prompt, enabledSkills(root, disabled)).map(({ id, name, description, trigger }) => ({ id, name, description, trigger }));
}
function mentioned(prompt: string, skills: LoadedSkill[]): LoadedSkill[] {
  if (!skills.length || !prompt.includes("/")) return [];
  const found: Array<{ at: number; skill: LoadedSkill }> = [];
  for (const skill of skills) {
    const re = new RegExp(`(?:^|\\n)[ \\t]*/(?:${escapeRe(skill.name)}|${escapeRe(skill.id)})(?=[\\s]|$)`, "u");
    const hit = re.exec(prompt);
    if (hit) found.push({ at: hit.index, skill });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.skill);
}

export interface SkillExpansion { prompt: string; skills: PlatformSkillInfo[] }

/**
 * 把提示词里调用的平台技能展开成「技能说明 + 用户原文」。没有调用时原样返回（同一个字符串）。
 * 用户原文逐字保留（含 `/技能名` 那一行），说明放在前面，由 runtime 的模型读取并执行。
 */
export function expandPlatformSkills(prompt: string, root = PLATFORM_SKILLS_ROOT, disabled: DisabledSkills = []): SkillExpansion {
  const used = mentioned(prompt, enabledSkills(root, disabled));
  if (!used.length) return { prompt, skills: [] };
  const blocks = used.map((s) => [
    `【平台技能：${s.name}】`,
    `用户在消息里用 ${s.trigger} 调用了这个平台技能。请先完整阅读下面的技能说明，再按它完成用户的请求；说明里的技能目录占位符已替换为真实路径；技能目录（只读）：${s.dir}。`,
    "<<<技能说明开始>>>",
    s.body,
    "<<<技能说明结束>>>"
  ].join("\n"));
  return { prompt: `${blocks.join("\n\n")}${USER_MESSAGE_MARK}${prompt}`, skills: used.map(({ id, name, description, trigger }) => ({ id, name, description, trigger })) };
}

/**
 * 技能目录：只在会话首轮告诉 runtime「平台有哪些技能、什么时候该用、说明文件在哪」，让模型自己判断要不要调用；
 * 用户用 `/技能名` 调用过的技能已经整段展开，不再重复列出。没有可列的技能时返回空串。
 * 只放名称、描述（写的是「何时使用」）和路径，每个技能约 100–150 个 token。
 */
export function platformSkillIndex(root = PLATFORM_SKILLS_ROOT, exclude: readonly string[] = [], disabled: DisabledSkills = []): string {
  const skills = enabledSkills(root, disabled).filter((s) => !exclude.includes(s.id));
  if (!skills.length) return "";
  return [
    "【平台技能】本平台为所有 runtime 提供下面的技能。遇到符合「何时使用」的任务时，先用读文件的工具读取它的 SKILL.md（只读），再按其中的流程执行；与当前任务无关就忽略本段。用户也可以在消息里用 /技能名 直接调用。",
    ...skills.map((s) => `- ${s.name}（${s.trigger}）：${s.description} 说明文件：${s.file}`)
  ].join("\n");
}

export interface PreparedPrompt extends SkillExpansion { indexed: PlatformSkillInfo[] }

/**
 * 派发前的提示词加工：`/技能名` 整段展开；首轮再补一份技能目录（排除已展开的技能）。
 * 非首轮、没有可列技能时原样返回。用户原文始终逐字保留在末尾。
 */
export function preparePlatformPrompt(prompt: string, opts: { firstTurn: boolean; root?: string; /** 首轮目录里不列出的技能 id（评测的「没装这个技能」基线用；用户自己写 /技能名 仍会展开） */ exclude?: readonly string[]; /** 用户在设置里禁用的技能 id：和不存在一样（连 `/技能名` 也不展开） */ disabled?: DisabledSkills }): PreparedPrompt {
  const root = opts.root ?? PLATFORM_SKILLS_ROOT;
  const disabled = opts.disabled ?? [];
  const expansion = expandPlatformSkills(prompt, root, disabled);
  if (!opts.firstTurn) return { ...expansion, indexed: [] };
  const skip = [...expansion.skills.map((k) => k.id), ...(opts.exclude ?? [])];
  const index = platformSkillIndex(root, skip, disabled);
  if (!index) return { ...expansion, indexed: [] };
  const indexed = listPlatformSkills(root, disabled).filter((k) => !skip.includes(k.id));
  return { prompt: expansion.skills.length ? `${index}\n\n${expansion.prompt}` : `${index}${USER_MESSAGE_MARK}${prompt}`, skills: expansion.skills, indexed };
}
