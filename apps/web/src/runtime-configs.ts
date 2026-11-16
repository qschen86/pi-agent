/**
 * V3.14「运行时配置也是资源」：把 Pi / Codex / Claude Code 用户级配置目录里的
 * 工具、技能、MCP、扩展/插件、提示词、工作流与自动化、其他自定义列到「外部资源」页。
 *
 * 边界：
 * - 只读。只读取资源发现所需元数据，返回名称、来源与路径，不回传配置正文、凭据或环境变量值。
 * - 只扫用户级配置目录（~/.pi/agent、~/.codex、~/.claude）与其中配置声明的路径；
 *   另读取独立 Pi 的 connection.json → profile.json；项目目录下的 .pi / .codex / .claude 不扫。
 * - 目录读不到、配置格式坏了不影响其他 runtime；页面显示原因，不把「读不到」当成「没有」。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { scanDesktopRuntimeResources, deduplicateRuntimeEntries } from "./runtime-plugin-resources.js";
import { scanPiRuntimeResources, type PiRuntimeResourceOptions } from "./pi-runtime-resources.js";
import { RUNTIME_KINDS, RUNTIME_LABEL, type RuntimeKind } from "@pi-agent/runtime-sessions";

export const RUNTIME_CONFIG_KINDS = ["tool", "skill", "mcp", "extension", "prompt", "workflow", "other"] as const;
export type RuntimeConfigKind = (typeof RUNTIME_CONFIG_KINDS)[number];

export const RUNTIME_CONFIG_KIND_LABEL: Record<RuntimeConfigKind, string> = {
  tool: "工具",
  skill: "技能",
  mcp: "MCP 服务",
  extension: "扩展 / 插件",
  prompt: "提示词",
  workflow: "工作流 / 自动化",
  other: "其他自定义"
};

export interface RuntimeConfigEntry {
  kind: RuntimeConfigKind;
  /** 给人看的名字（技能名、MCP 服务名、插件名…），不是路径 */
  name: string;
  /** 本机路径；Pi 的 package 源可能是一段 npm / git 源而不是路径 */
  path: string;
  /** 来自哪里：skills/、settings.json、mcp.json、config.toml… */
  source: string;
  origin?: "user" | "runtime" | "builtin" | "plugin";
  pluginId?: string;
  installation?: "installed" | "declared" | "cached" | "missing" | "unknown";
  /** 用户级配置状态，不代表合并项目/组织策略后的会话状态。 */
  enablement?: "enabled" | "disabled" | "unknown";
  /** 全局资源页没有绑定会话，不能从静态配置推断实际可用性。 */
  sessionAvailability?: "unverified";
  sources?: Array<{ source: string; path: string }>;
  updatedAt?: string;
}

export interface RuntimeConfigCategory {
  kind: RuntimeConfigKind;
  label: string;
  items: RuntimeConfigEntry[];
  /** 这一类的读取失败、截断或平台差异说明 */
  note?: string;
}

export interface RuntimeConfigRuntime {
  runtimeKind: RuntimeKind;
  label: string;
  configDir: string;
  state: "ok" | "missing" | "unreadable";
  stateReason?: string;
  categories: RuntimeConfigCategory[];
  /** 列出的配置项总数（受单项上限约束） */
  total: number;
}

export interface RuntimeConfigsView {
  generatedAt: string;
  timezone: string;
  scope: string;
  runtimes: RuntimeConfigRuntime[];
  /** 与具体 runtime 无关的读取说明 */
  notes: string[];
}

export interface RuntimeConfigScanOptions {
  /** 测试或自定义部署时指定三个运行时的用户级配置目录 */
  dirs?: Partial<Record<RuntimeKind, string>>;
  /** 用户主目录（默认 os.homedir()）；用于 ~ 展开和 ~/.claude.json */
  home?: string;
  /** 固定生成时间（测试用） */
  now?: number;
  /** Pi 独立运行时注册与装配路径；默认遵循 runtime 的环境覆盖。 */
  piRuntime?: PiRuntimeResourceOptions;
}

const MAX_ITEMS_PER_KIND = 200;
const MAX_DIR_ENTRIES = 500;
const MAX_CONFIG_BYTES = 1_048_576;
const HIDDEN = new Set([".DS_Store"]);

type EntryType = "file" | "dir" | "other";

function typeOf(path: string): EntryType | undefined {
  try {
    const s = statSync(path);
    return s.isDirectory() ? "dir" : s.isFile() ? "file" : "other";
  } catch {
    return undefined;
  }
}

function updatedAt(path: string): string | undefined {
  try { return statSync(path).mtime.toISOString(); } catch { return undefined; }
}

function clean(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 300);
}

function cleanPath(value: string): string {
  return value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 500);
}

function readText(path: string, notes: Map<RuntimeConfigKind, string[]>): string | undefined {
  try {
    const size = statSync(path).size;
    if (size > MAX_CONFIG_BYTES) {
      addNote(notes, "other", `${basename(path)} 超过 ${Math.round(MAX_CONFIG_BYTES / 1024)} KiB，未读取内容（只列路径）`);
      return undefined;
    }
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function readJson(path: string, notes: Map<RuntimeConfigKind, string[]>): Record<string, unknown> | undefined {
  const text = readText(path, notes);
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    addNote(notes, "other", `${basename(path)} 不是有效的 JSON，已跳过内容`);
    return undefined;
  }
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function addNote(notes: Map<RuntimeConfigKind, string[]>, kind: RuntimeConfigKind, text: string): void {
  const list = notes.get(kind) ?? [];
  if (!list.includes(text)) list.push(text);
  notes.set(kind, list);
}

function add(items: Map<RuntimeConfigKind, RuntimeConfigEntry[]>, seen: Set<string>, kind: RuntimeConfigKind, name: unknown, path: string, source: string): void {
  const label = clean(name);
  if (!label || items.get(kind)!.length >= MAX_ITEMS_PER_KIND) return;
  // 同一个配置文件里可以有多个 MCP / 插件 / 市场条目；路径相同但名字不同都要保留。
  const key = `${kind}\0${path}\0${label}`;
  if (seen.has(key)) return;
  seen.add(key);
  const at = updatedAt(path);
  items.get(kind)!.push({ kind, name: label, path: cleanPath(path), source, origin: "user", ...(at ? { updatedAt: at } : {}) });
}

function addNoteOnlyIfRoom(items: Map<RuntimeConfigKind, RuntimeConfigEntry[]>, notes: Map<RuntimeConfigKind, string[]>, kind: RuntimeConfigKind): void {
  if (items.get(kind)!.length >= MAX_ITEMS_PER_KIND) addNote(notes, kind, `只列出前 ${MAX_ITEMS_PER_KIND} 项`);
}

function listDir(path: string): { entries: Array<{ name: string; path: string; type: EntryType }>; truncated: boolean } | undefined {
  try {
    const names = readdirSync(path).filter((name) => !name.startsWith(".") && !HIDDEN.has(name)).sort((a, b) => a.localeCompare(b));
    const entries: Array<{ name: string; path: string; type: EntryType }> = [];
    for (const name of names.slice(0, MAX_DIR_ENTRIES)) {
      const full = join(path, name);
      const type = typeOf(full);
      if (type) entries.push({ name, path: full, type });
    }
    return { entries, truncated: names.length > MAX_DIR_ENTRIES };
  } catch {
    return undefined;
  }
}

function globRe(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/** 只展开最后一段里的 * / ?；更复杂的 glob 交给平台之外的工具，页面里说明未展开。 */
function expandPath(raw: unknown, base: string, home: string, notes: Map<RuntimeConfigKind, string[]>, kind: RuntimeConfigKind): string[] {
  if (typeof raw !== "string") return [];
  let value = raw.trim();
  if (!value) return [];
  if (value.startsWith("!")) {
    addNote(notes, kind, `排除规则未参与统计：${clean(value)}`);
    return [];
  }
  if (value.startsWith("+") || value.startsWith("-")) value = value.slice(1);
  // Pi 的内置扩展名（builtin:mcp 等）不是文件路径。
  if (value.startsWith("builtin:")) return [];
  if (value === "~") value = home;
  else if (value.startsWith("~/")) value = join(home, value.slice(2));
  if (!isAbsolute(value)) value = join(base, value);
  if (!/[*?]/.test(value)) return [value];
  const slash = value.lastIndexOf("/");
  if (slash < 0) return [];
  const dir = value.slice(0, slash) || "/";
  const pattern = value.slice(slash + 1);
  const listed = listDir(dir);
  if (!listed) {
    addNote(notes, kind, `无法展开路径：${clean(value)}`);
    return [];
  }
  const re = globRe(pattern);
  const matches = listed.entries.filter((entry) => re.test(entry.name)).map((entry) => entry.path);
  if (!matches.length) addNote(notes, kind, `路径没有匹配项：${clean(value)}`);
  return matches;
}

/** 配置里写的一个路径本身就是一项资源（文件或目录），不再展开目录内容。 */
function addConfiguredPath(
  items: Map<RuntimeConfigKind, RuntimeConfigEntry[]>, seen: Set<string>, notes: Map<RuntimeConfigKind, string[]>,
  kind: RuntimeConfigKind, raw: unknown, base: string, home: string, source: string
): void {
  for (const path of expandPath(raw, base, home, notes, kind)) {
    const type = typeOf(path);
    if (!type) {
      addNote(notes, kind, `配置里的路径不存在：${clean(path)}`);
      continue;
    }
    // 路径可以指向「一个技能目录」，也可以指向「存放多个技能的目录」；有 SKILL.md 才算前者。
    if (kind === "skill" && type === "dir" && typeOf(join(path, "SKILL.md")) !== "file") {
      addDirectory(items, seen, notes, "skill", path, source);
      continue;
    }
    if (kind === "prompt" && type === "dir") {
      addDirectory(items, seen, notes, "prompt", path, source);
      continue;
    }
    const name = kind === "prompt" ? basename(path).replace(/\.(md|markdown)$/i, "") : basename(path);
    add(items, seen, kind, name, path, source);
  }
}

function addDirectory(
  items: Map<RuntimeConfigKind, RuntimeConfigEntry[]>, seen: Set<string>, notes: Map<RuntimeConfigKind, string[]>,
  kind: RuntimeConfigKind, dir: string, source: string
): void {
  const listed = listDir(dir);
  if (!listed) return;
  if (listed.truncated) addNote(notes, kind, `${source} 目录超过 ${MAX_DIR_ENTRIES} 项，只读取前 ${MAX_DIR_ENTRIES} 项`);
  for (const entry of listed.entries) {
    if (kind === "skill") {
      // 技能是「含 SKILL.md 的目录」；skills/ 里的 LEGAL_*.md 之类说明文件不算技能。
      if (entry.type === "dir" && typeOf(join(entry.path, "SKILL.md")) === "file") add(items, seen, kind, entry.name, entry.path, source);
    } else if (kind === "prompt") {
      if (entry.type === "file" && /\.(md|markdown)$/i.test(entry.name)) add(items, seen, kind, entry.name.replace(/\.(md|markdown)$/i, ""), entry.path, source);
    } else {
      add(items, seen, kind, entry.name, entry.path, source);
    }
    addNoteOnlyIfRoom(items, notes, kind);
  }
}

function addFile(
  items: Map<RuntimeConfigKind, RuntimeConfigEntry[]>, seen: Set<string>,
  kind: RuntimeConfigKind, path: string, source: string
): void {
  if (typeOf(path) !== "file") return;
  const name = kind === "prompt" ? basename(path).replace(/\.(md|markdown)$/i, "") : basename(path);
  add(items, seen, kind, name, path, source);
}

function addConfigFile(
  items: Map<RuntimeConfigKind, RuntimeConfigEntry[]>, seen: Set<string>,
  path: string
): void {
  if (typeOf(path) === "file") add(items, seen, "other", basename(path), path, "配置文件");
}

function addStringList(
  items: Map<RuntimeConfigKind, RuntimeConfigEntry[]>, seen: Set<string>, notes: Map<RuntimeConfigKind, string[]>,
  kind: RuntimeConfigKind, value: unknown, base: string, home: string, source: string
): void {
  if (!Array.isArray(value)) return;
  for (const raw of value) addConfiguredPath(items, seen, notes, kind, raw, base, home, source);
}

function addNamesFromObject(
  items: Map<RuntimeConfigKind, RuntimeConfigEntry[]>, seen: Set<string>,
  kind: RuntimeConfigKind, value: unknown, path: string, source: string
): void {
  const object = objectOf(value);
  if (!object) return;
  for (const name of Object.keys(object).sort((a, b) => a.localeCompare(b))) add(items, seen, kind, name, path, source);
}

function addNamesFromObjectArray(
  items: Map<RuntimeConfigKind, RuntimeConfigEntry[]>, seen: Set<string>,
  kind: RuntimeConfigKind, value: unknown, path: string, source: string
): void {
  if (!Array.isArray(value)) return;
  for (const raw of value) {
    const name = clean(raw);
    if (name) add(items, seen, kind, name, path, source);
  }
}

function defaultConfigDir(kind: RuntimeKind, home: string): string {
  if (kind === "pi") return process.env["PI_CODING_AGENT_DIR"] ?? join(home, ".pi", "agent");
  if (kind === "claude-code") return process.env["CLAUDE_CONFIG_DIR"] ?? join(home, ".claude");
  return process.env["CODEX_HOME"] ?? join(home, ".codex");
}

function newItems(): Map<RuntimeConfigKind, RuntimeConfigEntry[]> {
  return new Map(RUNTIME_CONFIG_KINDS.map((kind) => [kind, [] as RuntimeConfigEntry[]]));
}

function categoriesOf(
  items: Map<RuntimeConfigKind, RuntimeConfigEntry[]>, notes: Map<RuntimeConfigKind, string[]>
): RuntimeConfigCategory[] {
  return RUNTIME_CONFIG_KINDS.map((kind) => {
    const list = items.get(kind)!;
    const note = notes.get(kind)?.join("；");
    return {
      kind,
      label: RUNTIME_CONFIG_KIND_LABEL[kind],
      items: list,
      ...(note ? { note } : {})
    };
  });
}

function scanPi(dir: string, home: string, items: Map<RuntimeConfigKind, RuntimeConfigEntry[]>, seen: Set<string>, notes: Map<RuntimeConfigKind, string[]>): void {
  const settingsPath = join(dir, "settings.json");
  const settings = readJson(settingsPath, notes) ?? {};
  addStringList(items, seen, notes, "skill", settings["skills"], dir, home, "settings.json skills");
  addStringList(items, seen, notes, "extension", settings["extensions"], dir, home, "settings.json extensions");
  addStringList(items, seen, notes, "prompt", settings["prompts"], dir, home, "settings.json prompts");
  addStringList(items, seen, notes, "other", settings["themes"], dir, home, "settings.json themes");
  if (Array.isArray(settings["packages"])) {
    for (const raw of settings["packages"]) {
      if (typeof raw === "string" && raw.trim()) add(items, seen, "extension", raw.trim(), raw.trim(), "settings.json packages");
    }
  }
  addDirectory(items, seen, notes, "skill", join(dir, "skills"), "skills/");
  addDirectory(items, seen, notes, "extension", join(dir, "extensions"), "extensions/");
  addDirectory(items, seen, notes, "prompt", join(dir, "prompts"), "prompts/");
  addDirectory(items, seen, notes, "other", join(dir, "themes"), "themes/");

  addNamesFromObject(items, seen, "mcp", readJson(join(dir, "mcp.json"), notes)?.["mcpServers"], join(dir, "mcp.json"), "mcp.json");
  addNamesFromObject(items, seen, "mcp", settings["mcpServers"], settingsPath, "settings.json mcpServers");

  for (const name of ["AGENTS.md", "AGENTS.override.md", "SYSTEM.md", "APPEND_SYSTEM.md"]) addFile(items, seen, "prompt", join(dir, name), "指令文件");
  addConfigFile(items, seen, settingsPath);
  addConfigFile(items, seen, join(dir, "mcp.json"));
  addConfigFile(items, seen, join(dir, "models.json"));
  addConfigFile(items, seen, join(dir, "keybindings.json"));
  addNote(notes, "workflow", "Pi 没有独立的工作流目录；自动化通常由扩展或技能实现");
}

function scanClaude(dir: string, home: string, items: Map<RuntimeConfigKind, RuntimeConfigEntry[]>, seen: Set<string>, notes: Map<RuntimeConfigKind, string[]>): void {
  const settingsPath = join(dir, "settings.json");
  const settings = readJson(settingsPath, notes) ?? {};
  const claudeJsonPath = join(home, ".claude.json");

  addDirectory(items, seen, notes, "skill", join(dir, "skills"), "skills/");
  addDirectory(items, seen, notes, "prompt", join(dir, "commands"), "commands/");
  addDirectory(items, seen, notes, "other", join(dir, "agents"), "agents/");

  addNamesFromObject(items, seen, "other", settings["extraKnownMarketplaces"], settingsPath, "settings.json extraKnownMarketplaces");
  addNamesFromObject(items, seen, "workflow", settings["hooks"], settingsPath, "settings.json hooks");


  addFile(items, seen, "prompt", join(dir, "CLAUDE.md"), "指令文件");
  addConfigFile(items, seen, settingsPath);
  addConfigFile(items, seen, claudeJsonPath);
  addConfigFile(items, seen, join(dir, "plugins", "installed_plugins.json"));
  if (!items.get("workflow")!.length) addNote(notes, "workflow", "用户设置中没有发现 hooks；插件内的 hooks 另行列出");
}

interface CodexConfig {
  hooks: boolean;
  marketplaces: string[];
}

function parseCodexConfig(text: string | undefined): CodexConfig {
  const out: CodexConfig = { hooks: false, marketplaces: [] };
  if (!text) return out;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const market = line.match(/^\[marketplaces\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_@./-]+))\]$/);
    if (market) { const name = market[1] ?? market[2] ?? market[3]; if (name) out.marketplaces.push(name); continue; }
    if (/^\[hooks(?:\.|\])/.test(line)) out.hooks = true;
  }
  return out;
}

function scanCodex(dir: string, items: Map<RuntimeConfigKind, RuntimeConfigEntry[]>, seen: Set<string>, notes: Map<RuntimeConfigKind, string[]>): void {
  const configPath = join(dir, "config.toml");
  const config = parseCodexConfig(readText(configPath, notes));
  for (const name of config.marketplaces) add(items, seen, "other", name, configPath, "config.toml marketplaces");
  if (config.hooks) add(items, seen, "workflow", "hooks", configPath, "config.toml hooks");

  addDirectory(items, seen, notes, "skill", join(dir, "skills"), "skills/");
  addDirectory(items, seen, notes, "prompt", join(dir, "prompts"), "prompts/");
  addDirectory(items, seen, notes, "workflow", join(dir, "automations"), "automations/");

  addFile(items, seen, "prompt", join(dir, "AGENTS.md"), "指令文件");
  addConfigFile(items, seen, configPath);
  addNote(notes, "workflow", "Codex 工作流来自 hooks 与 automations；AGENTS.md 作为提示词列出，项目级 .codex 未扫描");
}

function scanRuntime(kind: RuntimeKind, dir: string, home: string, piOptions?: PiRuntimeResourceOptions): RuntimeConfigRuntime {
  const items = newItems();
  const seen = new Set<string>();
  const notes = new Map<RuntimeConfigKind, string[]>();
  const type = typeOf(dir);
  let state: RuntimeConfigRuntime["state"] = type === "dir" ? "ok" : type ? "unreadable" : "missing";
  let stateReason = type === "dir" ? undefined : type ? "配置目录不是目录" : "没有找到用户级配置目录（可能尚未安装或未登录）";
  if (type === "dir") {
    try {
      if (kind === "pi") scanPi(dir, home, items, seen, notes);
      else if (kind === "claude-code") scanClaude(dir, home, items, seen, notes);
      else scanCodex(dir, items, seen, notes);
    } catch {
      state = "unreadable";
      stateReason = "配置目录读取失败";
    }
  }
  if (kind === "pi") {
    const assembly = scanPiRuntimeResources(home, piOptions);
    for (const entry of assembly.entries) {
      add(items, seen, entry.kind, entry.name, entry.path, entry.source);
      const added = items.get(entry.kind)!.find(item => item.name === entry.name && item.path === cleanPath(entry.path));
      if (added) added.origin = entry.origin;
    }
    for (const note of assembly.notes) addNote(notes, "other", note);
    if (assembly.state === "ok" && state === "missing") {
      state = "ok";
      stateReason = "未找到用户级配置目录；已读取独立 pi-runtime 注册与装配";
    } else if (assembly.state === "unreadable") {
      if (state === "missing") state = "unreadable";
      stateReason = "独立 pi-runtime 注册读取失败；用户配置仍单独列出";
    }
    if (items.get("tool")!.length) addNote(notes, "tool", "按已安装包与装配配置列出，适用于普通 pi-ask 模式；不是当前会话的实时工具清单。只读、评测及历史会话的工具可能不同");
    addNote(notes, "other", "用户配置与 pi-runtime 装配分别标识来源；用户配置存在不表示已被隔离运行时加载");
  }
  if (kind !== "pi") {
    const desktop = scanDesktopRuntimeResources(kind, dir, home);
    for (const entry of desktop.entries) {
      // Bound and sanitize through the same path as user configuration entries.
      const list = items.get(entry.kind)!;
      list.push({ ...entry, name: clean(entry.name), path: cleanPath(entry.path), source: clean(entry.source),
        ...(entry.pluginId ? { pluginId: clean(entry.pluginId) } : {}),
        ...(entry.sources ? { sources: entry.sources.map(s => ({ source: clean(s.source), path: cleanPath(s.path) })) } : {}) });
    }
    for (const note of desktop.notes) addNote(notes, note.kind, clean(note.text));
    for (const [category, list] of items) {
      const unique = deduplicateRuntimeEntries(list);
      if (unique.length > MAX_ITEMS_PER_KIND) addNote(notes, category, `只列出前 ${MAX_ITEMS_PER_KIND} 项`);
      const merged = unique.slice(0, MAX_ITEMS_PER_KIND);
      for (const entry of merged) if (category !== "other" || entry.pluginId) {
        entry.installation ??= category === "mcp" ? "declared" : "installed";
        entry.enablement ??= "unknown";
        entry.sessionAvailability = "unverified";
      }
      items.set(category, merged);
    }
    if (state === "missing" && desktop.entries.length) { state = "ok"; stateReason = "未找到用户级配置目录；已读取其他用户级技能来源"; }
  }
  const categories = categoriesOf(items, notes);
  return {
    runtimeKind: kind,
    label: RUNTIME_LABEL[kind],
    configDir: dir,
    state,
    ...(stateReason ? { stateReason } : {}),
    categories,
    total: categories.reduce((n, category) => n + category.items.length, 0)
  };
}

/** 扫描三个运行时的用户级配置与 Pi 独立装配；不返回配置正文。 */
export function scanRuntimeConfigs(options: RuntimeConfigScanOptions = {}): RuntimeConfigsView {
  const home = options.home ?? homedir();
  const notes: string[] = [];
  const runtimes = RUNTIME_KINDS.map((kind) => scanRuntime(kind, options.dirs?.[kind] ?? defaultConfigDir(kind, home), home, options.piRuntime));
  if (runtimes.every((runtime) => runtime.state !== "ok")) notes.push("三个运行时的用户级配置目录都不可读；只显示目录状态");
  return {
    generatedAt: new Date(options.now ?? Date.now()).toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    scope: "本机用户级配置与 Pi 独立运行时装配（未扫描项目目录）",
    runtimes,
    notes
  };
}
