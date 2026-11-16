/** Static, bounded component discovery. Never runs plugin code or contacts an MCP server. */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { RuntimeConfigEntry, RuntimeConfigKind } from "./runtime-configs.js";

type Obj = Record<string, unknown>;
type Enabled = NonNullable<RuntimeConfigEntry["enablement"]>;
export interface DesktopResourceScan {
  entries: RuntimeConfigEntry[];
  notes: Array<{ kind: RuntimeConfigKind; text: string }>;
}
const object = (v: unknown): Obj | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Obj : undefined;
const enabled = (v: unknown): Enabled => v === true ? "enabled" : v === false ? "disabled" : "unknown";
const canonical = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const contains = (root: string, path: string) => { const r = relative(canonical(root), canonical(path)); return !r.startsWith("..") && !isAbsolute(r); };

class Collector {
  result: DesktopResourceScan = { entries: [], notes: [] };
  private directories = 0;
  note(kind: RuntimeConfigKind, text: string) {
    text = text.replace(/[\u0000-\u001f]/g, " ").slice(0, 500);
    if (this.result.notes.length < 60 && !this.result.notes.some(n => n.kind === kind && n.text === text)) this.result.notes.push({ kind, text });
  }
  text(path: string): string | undefined {
    if (!existsSync(path)) return;
    try {
      if (!isFile(path) || statSync(path).size > 1_048_576) { this.note("extension", `${basename(path)} 超过读取上限或不是文件，未读取`); return; }
      return readFileSync(path, "utf8");
    } catch { this.note("extension", `${basename(path)} 无法读取`); return; }
  }
  json(path: string): Obj | undefined {
    const text = this.text(path); if (text === undefined) return;
    try { const v = object(JSON.parse(text)); if (!v) throw new Error(); return v; }
    catch { this.note("extension", `${basename(path)} 格式无效，未展开组件`); return; }
  }
  dirs(path: string): string[] {
    if (++this.directories > 2048) { this.note("extension", "插件目录扫描已达上限，部分资源未列出"); return []; }
    try {
      const all = readdirSync(path).filter(n => !n.startsWith(".")).sort();
      if (all.length > 500) this.note("extension", "单个目录超过 500 项，只扫描前 500 项");
      return all.slice(0, 500).map(n => join(path, n));
    } catch { if (existsSync(path)) this.note("extension", `${basename(path)} 目录无法读取`); return []; }
  }
  add(kind: RuntimeConfigKind, name: string, path: string, source: string, extra: Partial<RuntimeConfigEntry> = {}) {
    if (this.result.entries.length >= 1600) { this.note(kind, "资源扫描已达上限，部分资源未列出"); return; }
    this.result.entries.push({ kind, name, path, source, origin: "user", installation: "installed", enablement: "unknown", sessionAvailability: "unverified", ...extra });
  }
  skills(path: string, source: string, extra: Partial<RuntimeConfigEntry>, root?: string, prefix = "", seen = new Set<string>(), depth = 0) {
    if (root && !contains(root, path)) { this.note("extension", "插件组件路径越界，未读取"); return; }
    if (depth > 5 || seen.has(canonical(path))) return;
    seen.add(canonical(path));
    if (isFile(path) && basename(path) === "SKILL.md") { this.add("skill", prefix + basename(dirname(path)), dirname(path), source, extra); return; }
    if (!isDir(path)) return;
    if (isFile(join(path, "SKILL.md"))) { this.add("skill", prefix + basename(path), path, source, extra); return; }
    for (const child of this.dirs(path).filter(isDir)) this.skills(child, source, extra, root, prefix, seen, depth + 1);
  }
}

interface TomlMetadata { plugins: Map<string, Enabled>; mcp: Map<string, Enabled>; skills: Array<{ path?: string; enabled?: boolean }>; pluginMcp: Map<string, Map<string, Enabled>> }
/** Read only scalar metadata from TOML tables; never evaluate commands or interpolate values. */
function tomlMetadata(text: string | undefined): TomlMetadata {
  const out: TomlMetadata = { plugins: new Map(), mcp: new Map(), skills: [], pluginMcp: new Map() };
  let section: string[] = [], skill: { path?: string; enabled?: boolean } | undefined, multiline = "";
  const string = (v: string) => { try { return v.startsWith("'") && v.endsWith("'") ? v.slice(1, -1) : JSON.parse(v) as unknown; } catch { return undefined; } };
  for (const raw of (text ?? "").split(/\r?\n/)) {
    if (multiline) { if (raw.includes(multiline)) multiline = ""; continue; }
    let quote = "", escape = false, line = "";
    for (const ch of raw) {
      if (!quote && ch === "#") break;
      line += ch;
      if (escape) { escape = false; continue; }
      if (quote === '"' && ch === "\\") { escape = true; continue; }
      if (ch === quote) quote = ""; else if (!quote && (ch === '"' || ch === "'")) quote = ch;
    }
    line = line.trim();
    const triple = line.match(/=\s*("""|''')/);
    if (triple) { if (line.indexOf(triple[1]!, line.indexOf(triple[1]!) + 3) < 0) multiline = triple[1]!; continue; }
    const header = line.match(/^(\[\[?)(.*?)(\]\]?)$/);
    if (header) {
      const key = /\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*(\.|$)/gy;
      const parts: string[] = []; let offset = 0, match: RegExpExecArray | null;
      while ((match = key.exec(header[2]!))) {
        parts.push(match[1]!.startsWith('"') || match[1]!.startsWith("'") ? String(string(match[1]!)) : match[1]!);
        offset = key.lastIndex;
        if (!match[2]) break;
      }
      if (!parts.length || offset !== header[2]!.length || header[1]!.length !== header[3]!.length) { section = []; skill = undefined; continue; }
      section = parts;
      skill = section.join(".") === "skills.config" && header[1] === "[[" ? {} : undefined;
      if (skill) out.skills.push(skill);
      if (section[0] === "plugins" && section.length === 2 && !out.plugins.has(section[1]!)) out.plugins.set(section[1]!, "unknown");
      if (section[0] === "mcp_servers" && section.length === 2 && !out.mcp.has(section[1]!)) out.mcp.set(section[1]!, "enabled");
      continue;
    }
    const scalar = line.replace(/^("enabled"|'enabled')(?=\s*=)/, "enabled").replace(/^("path"|'path')(?=\s*=)/, "path");
    const pair = scalar.match(/^(enabled|path)\s*=\s*(.*?)\s*$/); if (!pair) continue;
    const value = pair[2] === "true" ? true : pair[2] === "false" ? false : string(pair[2]!);
    if (skill) { if (pair[1] === "path" && typeof value === "string") skill.path = value; if (pair[1] === "enabled" && typeof value === "boolean") skill.enabled = value; }
    if (pair[1] === "enabled") {
      if (section[0] === "plugins" && section.length === 2) out.plugins.set(section[1]!, enabled(value));
      if (section[0] === "mcp_servers" && section.length === 2) out.mcp.set(section[1]!, enabled(value));
      if (section[0] === "plugins" && section[2] === "mcp_servers" && section.length === 4) {
        const map = out.pluginMcp.get(section[1]!) ?? new Map(); map.set(section[3]!, enabled(value)); out.pluginMcp.set(section[1]!, map);
      }
    }
  }
  return out;
}

function pluginComponents(c: Collector, runtime: "codex" | "claude-code", root: string, id: string, state: Enabled, overrides?: Map<string, Enabled>) {
  const manifestPaths = runtime === "codex" ? [join(root, "plugin.json"), join(root, ".codex-plugin/plugin.json"), join(root, ".claude-plugin/plugin.json")] : [join(root, ".claude-plugin/plugin.json")];
  const manifestPath = manifestPaths.find(isFile);
  if (manifestPath && !contains(root, manifestPath)) { c.note("extension", `${id} 插件清单路径越界，未读取`); return; }
  const manifest = manifestPath ? c.json(manifestPath) : {};
  if (!manifest) return;
  const portable = runtime === "codex" && manifestPath === join(root, "plugin.json");
  const overlay = portable ? object(object(manifest.extensions)?.["com.openai"]) ?? (isFile(join(root, ".codex-plugin/plugin.json")) && contains(root, join(root, ".codex-plugin/plugin.json")) ? c.json(join(root, ".codex-plugin/plugin.json")) : {}) : manifest;
  const name = id.split("@")[0]!, prefix = `${name}:`, source = `插件 · ${id}`;
  const extra: Partial<RuntimeConfigEntry> = { origin: "plugin", pluginId: id, installation: "installed", enablement: state };
  const safe = (value: string): string | undefined => {
    const path = resolve(root, value.replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//, ""));
    if (isAbsolute(value) || !contains(root, path)) { c.note("extension", `${id} 插件组件路径越界，未读取`); return; }
    if (!existsSync(path)) { c.note("extension", `${id} 声明的组件路径不存在`); return; }
    return path;
  };
  const paths = (raw: unknown): string[] => (typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : []).map(safe).filter((p): p is string => !!p);
  const defaults = (path: string) => existsSync(join(root, path)) ? paths("./" + path) : [];
  const skills = [...(runtime === "claude-code" || portable || manifest.skills === undefined ? defaults("skills") : []), ...paths(manifest.skills)];
  if (!skills.length && manifest.skills === undefined && isFile(join(root, "SKILL.md"))) skills.push(root);
  for (const path of skills) c.skills(path, source, extra, root, prefix);
  const markdown = (path: string, kind: RuntimeConfigKind, base: string, depth = 0, visited = new Set<string>()) => {
    if (!contains(root, path)) { c.note("extension", `${id} 插件组件路径越界，未读取`); return; }
    if (depth > 5 || visited.has(canonical(path))) return; visited.add(canonical(path));
    if (isFile(path) && /\.md$/i.test(path)) c.add(kind, prefix + relative(base, path).replace(/\.md$/i, "").replaceAll("\\", "/"), path, source, extra);
    else if (isDir(path)) for (const child of c.dirs(path)) markdown(child, kind, base, depth + 1, visited);
  };
  for (const [key, kind] of [["commands", "prompt"], ["agents", "other"], ["outputStyles", "other"]] as const) {
    if (key === "commands" && object(manifest.commands)) {
      for (const [command, raw] of Object.entries(object(manifest.commands)!)) {
        const value = object(raw); if (!value) continue;
        const hasSource = typeof value.source === "string", hasContent = typeof value.content === "string";
        if (hasSource === hasContent) { c.note("extension", `${id} 的命令声明格式无效，未列出`); continue; }
        const path = hasSource ? safe(value.source as string) : manifestPath;
        if (path && isFile(path)) c.add("prompt", prefix + command, path, source, extra);
      }
    } else for (const path of manifest[key] === undefined ? defaults(key === "outputStyles" ? "output-styles" : key) : paths(manifest[key])) markdown(path, kind, isDir(path) ? path : dirname(path));
  }
  const components = (kind: "mcp" | "workflow" | "other", raw: unknown, path: string) => {
    if (Array.isArray(raw)) { for (const value of raw) components(kind, value, path); return; }
    if (typeof raw === "string") {
      if (/^https?:/i.test(raw) || /\.(mcpb|dxt)$/i.test(raw)) { c.note("mcp", `${id} 声明了 MCP bundle；只读扫描不下载或解包，未展开服务`); return; }
      for (const file of paths(raw)) components(kind, c.json(file), file); return;
    }
    const obj = object(raw); if (!obj) return;
    const wrapper = kind === "mcp" ? "mcpServers" : kind === "workflow" ? "hooks" : "lspServers";
    const body = wrapper in obj ? object(obj[wrapper]) ?? {} : obj;
    for (const key of Object.keys(body).filter(k => !k.startsWith("$") && (kind !== "workflow" ? !!object(body[k]) : Array.isArray(body[k]))).sort()) {
      c.add(kind, prefix + (kind === "other" ? "LSP:" : "") + key, path, source, { ...extra, ...(kind === "mcp" && state !== "disabled" && overrides?.has(key) ? { enablement: overrides.get(key)! } : {}) });
    }
  };
  // Claude merges defaults and declared maps; Codex portable components are canonical.
  for (const file of runtime === "claude-code" ? [".mcp.json"] : portable ? ["mcp.json"] : manifest.mcpServers === undefined ? [".mcp.json"] : []) {
    for (const path of defaults(file)) components("mcp", c.json(path), path);
  }
  components("mcp", manifest.mcpServers, manifestPath ?? root);
  const hookValue = portable ? overlay?.hooks : manifest.hooks;
  if (runtime === "claude-code" || hookValue === undefined) for (const path of defaults("hooks/hooks.json")) components("workflow", c.json(path), path);
  components("workflow", hookValue, manifestPath ?? root);
  for (const path of defaults(".lsp.json")) components("other", c.json(path), path);
  components("other", manifest.lspServers, manifestPath ?? root);
  if (runtime === "claude-code") {
    const files = (path: string, kind: RuntimeConfigKind, label: string, extension: RegExp, base: string, depth = 0, visited = new Set<string>()) => {
      if (!contains(root, path)) { c.note("extension", `${id} 插件组件路径越界，未读取`); return; }
      if (depth > 5 || visited.has(canonical(path))) return; visited.add(canonical(path));
      if (isFile(path) && extension.test(path)) c.add(kind, prefix + label + relative(base, path).replace(/\.[^.]+$/, "").replaceAll("\\", "/"), path, source, extra);
      else if (isDir(path)) for (const child of c.dirs(path)) files(child, kind, label, extension, base, depth + 1, visited);
    };
    for (const [value, fallback, kind, label, extension] of [
      [manifest.workflows, "workflows", "workflow", "workflow:", /\.js$/i],
      [object(manifest.experimental)?.themes, "themes", "other", "theme:", /\.json$/i]
    ] as const) for (const path of value === undefined ? defaults(fallback) : paths(value)) files(path, kind, label, extension, isDir(path) ? path : dirname(path));
  }
}

export function scanDesktopRuntimeResources(runtime: "codex" | "claude-code", dir: string, home: string): DesktopResourceScan {
  const c = new Collector(), settingsPath = join(dir, runtime === "codex" ? "config.toml" : "settings.json");
  const meta = runtime === "codex" ? tomlMetadata(c.text(settingsPath)) : undefined;
  const settings = runtime === "claude-code" ? c.json(settingsPath) ?? {} : {};
  if (runtime === "codex") {
    c.skills(join(dir, "skills"), "skills/", { enablement: "enabled" });
    c.skills(join(home, ".agents/skills"), "~/.agents/skills", { enablement: "enabled" });
    c.skills(join(dir, "skills/.system"), "Codex 系统技能", { origin: "builtin", enablement: "enabled" });
    for (const [name, state] of meta!.mcp) c.add("mcp", name, settingsPath, "config.toml mcp_servers", { installation: "declared", enablement: state });
    const caches = new Map<string, string[]>();
    for (const market of c.dirs(join(dir, "plugins/cache")).filter(isDir)) for (const name of c.dirs(market).filter(isDir)) {
      const versions = c.dirs(name).filter(isDir).filter(p => ["plugin.json", ".codex-plugin/plugin.json", ".claude-plugin/plugin.json"].some(file => isFile(join(p, file))));
      if (versions.length) caches.set(`${basename(name)}@${basename(market)}`, versions);
    }
    const ids = [...new Set([...meta!.plugins.keys(), ...caches.keys()])];
    if (ids.length > 200) c.note("extension", "插件超过 200 项，只列前 200 项");
    for (const id of ids.slice(0, 200)) {
      const versions = caches.get(id) ?? [], configured = meta!.plugins.has(id), state = meta!.plugins.get(id) ?? "unknown";
      const installation = !configured ? "cached" : versions.length === 1 ? "installed" : versions.length ? "cached" : "missing";
      c.add("extension", id, versions.length === 1 ? versions[0]! : settingsPath, configured ? "config.toml plugins" : "插件缓存（未确认安装）", { pluginId: id, origin: "plugin", installation, enablement: state,
        sources: [...(configured ? [{ source: "config.toml plugins", path: settingsPath }] : []), ...versions.map(path => ({ source: "插件缓存", path }))] });
      if (versions.length > 1) c.note("extension", `${id} 有多个缓存版本，无法确认所选版本，未展开组件`);
      if (configured && versions.length === 1) pluginComponents(c, runtime, versions[0]!, id, state, meta!.pluginMcp.get(id));
    }
    for (const row of meta!.skills) {
      if (!row.path) continue;
      const path = row.path.startsWith("~/") ? join(home, row.path.slice(2)) : isAbsolute(row.path) ? row.path : resolve(dir, row.path);
      const key = canonical(basename(path) === "SKILL.md" ? dirname(path) : path);
      for (const entry of c.result.entries) if (entry.kind === "skill" && canonical(entry.path) === key && (!entry.pluginId || meta!.plugins.get(entry.pluginId) !== "disabled")) entry.enablement = enabled(row.enabled ?? true);
    }

  } else {
    const registryPath = join(dir, "plugins/installed_plugins.json"), registry = object(c.json(registryPath)?.plugins) ?? {};
    const declared = object(settings.enabledPlugins) ?? {};
    const userRecords = new Map<string, Obj[]>();
    for (const [id, raw] of Object.entries(registry)) {
      if (!Array.isArray(raw)) continue;
      const records = raw.map(object).filter((v): v is Obj => !!v && (v.scope === "user" || v.scope === undefined));
      if (records.length) userRecords.set(id, records);
    }
    const ids = [...new Set([...Object.keys(declared), ...userRecords.keys()])];
    if (ids.length > 200) c.note("extension", "插件超过 200 项，只列前 200 项");
    for (const id of ids.slice(0, 200)) {
      const records = userRecords.get(id) ?? [], roots = [...new Set(records.map(r => r.installPath).filter((p): p is string => typeof p === "string" && isAbsolute(p)))];
      const paths = [...new Set(roots.filter(isDir).map(canonical))], state = enabled(declared[id]);
      c.add("extension", id, paths.length === 1 ? paths[0]! : registryPath, "Claude 插件安装与配置", { pluginId: id, origin: "plugin", enablement: state,
        installation: paths.length ? "installed" : roots.length || id in declared && !records.length ? "missing" : "unknown",
        sources: [...(id in declared ? [{ source: "settings.json enabledPlugins", path: settingsPath }] : []), ...(records.length ? [{ source: "installed_plugins.json（用户级）", path: registryPath }] : [])] });
      if (paths.length > 1) c.note("extension", `${id} 有多个用户级安装版本，无法确认所选版本，未展开组件`);
      if (paths.length === 1) pluginComponents(c, runtime, paths[0]!, id, state);
    }
    for (const [path, raw] of [[settingsPath, settings], [join(home, ".claude.json"), c.json(join(home, ".claude.json"))]] as const) {
      for (const name of Object.keys(object(raw?.mcpServers) ?? {}).sort()) c.add("mcp", name, path, `${basename(path)} mcpServers`, { installation: "declared", enablement: "unknown" });
    }
  }
  c.note("tool", "未读取当前会话工具清单，数量为 0 不表示运行时没有工具。资源页未绑定会话，当前会话可用性均未核验");
  c.note("extension", "安装、用户级启用配置与当前会话可用性分别展示；项目设置、组织策略、认证或会话模式可能改变实际可用性。缓存不等于已安装，未配置启用状态不作推断");
  return c.result;
}

/** Identity is scoped: plugin id for plugins/MCP; real path for file resources. */
export function deduplicateRuntimeEntries(entries: RuntimeConfigEntry[]): RuntimeConfigEntry[] {
  const unique = new Map<string, RuntimeConfigEntry>();
  for (const raw of entries) {
    const identity = raw.kind === "extension" ? raw.pluginId ?? raw.name : raw.kind === "mcp" || raw.kind === "workflow" || raw.kind === "prompt" && raw.pluginId ? raw.name : raw.kind === "other" ? `${canonical(raw.path)}\0${raw.name}` : canonical(raw.path);
    const key = `${raw.kind}\0${raw.pluginId ?? ""}\0${identity}`;
    const sources = raw.sources ?? [{ source: raw.source, path: raw.path }];
    const existing = unique.get(key);
    if (!existing) { unique.set(key, { ...raw, sources: [...sources] }); continue; }
    existing.sources = [...(existing.sources ?? []), ...sources].filter((s, i, all) => all.findIndex(v => v.path === s.path && v.source === s.source) === i);
    for (const field of ["installation", "enablement", "sessionAvailability", "pluginId"] as const) if (raw[field] !== undefined) Object.assign(existing, { [field]: raw[field] });
  }
  return [...unique.values()];
}
