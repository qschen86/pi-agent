/**
 * 平台公共记忆「按需查阅」识别（只读观察）。
 *
 * agent 查公共记忆有两条路：直接读 index/ 下的文件（Codex、Claude 主要走这条），或 curl 索引接口（Pi 沙盒兜底）。
 * 平台会话的工具事件里有命令原文，所以用本文件的纯函数判断「这条工具调用是不是在查公共记忆、怎么查的」：
 * 统计使用率（apps/web 的 PublicMemoryService）和会话侧栏「记忆」卡片里的查阅记录都用它。
 *
 * 只观察，不拦截、不改写任何 runtime 的行为；识别不出来就当没有（宁漏勿误：统计偏低，不会虚高）。
 * 判断按「命令」「管道段」进行：同一条命令里读了别的 .md、或者写了别的文件（如 > /tmp/out.txt），都不影响对索引文件那一段的判断；
 * 只有落在 memory-public/index 下的文件才算，对索引目录的写 / 改 / 删和版本控制类调用不算查阅。
 */
import type { ProjectedEvent } from "./types.js";

export type LookupKind = "map" | "catalog" | "details" | "api";
export const LOOKUP_KINDS: readonly LookupKind[] = ["map", "catalog", "details", "api"];
/** read：整份读取（cat / head / Read 工具）；search：带检索词或编号（grep / rg / Grep 工具 / 接口 q=）。 */
export type LookupHow = "read" | "search";

export interface IndexOp {
  kind: LookupKind;
  how: LookupHow;
  /** 详情查阅里出现的条目编号前缀（`### 256ed5`） */
  ids: string[];
  /** 人看的检索词（grep 的模式或接口的 q），截断 */
  query?: string;
}

/** 一处文件检索的原始模式（grep / rg / Grep 工具），用来把输出里属于这次检索的行挑出来。 */
interface SearchSpec { op: number; pattern: string; ignoreCase: boolean; fixed: boolean; ere: boolean }

export interface IndexRead {
  kinds: LookupKind[];
  ids: string[];
  query?: string;
}

const WRITE_TOOL = /^(?:write|edit|multiedit|notebookedit|apply_patch|patch)$/i;
const READ_TOOL = /^(?:read|view|cat)$/i;
const GREP_TOOL = /^(?:grep|search|rg)$/i;

const API_PATH = /\/api\/memory\/public\/index/;
const SEARCH_VERB = /\b(?:grep|egrep|fgrep|rg|ag|ack)\b/;
const READ_VERB = /\b(?:cat|head|tail|sed|less|more|bat|nl|awk|cut)\b/;
/** 改动类动词：这一段如果动的是索引目录，就是写 / 改 / 删，不是查阅。`<<` 是 heredoc（写给别的文件或脚本的内容）。 */
const MUTATION = /<<|\b(?:tee|cp|mv|rm|touch|install|ln|truncate|dd)\s|\bsed\s+(?:-[A-Za-z]*i|--in-place)|\bapply_patch\b/;
/** 版本控制类：提到索引路径也只是在开发这套功能，不算查阅。 */
const VCS = /\bgit\s+(?:diff|show|log|add|commit|apply|status|checkout|restore|stash)\b/;
/**
 * 没有读到内容的调用：输出被丢弃（curl -o /dev/null、-I、`> /dev/null`）、只数行数 / 只判断有没有（grep -c / -q）。
 * 这类调用提到了索引，但模型什么内容都没拿到（比如部署后只探测接口返回码），不算查阅。
 */
const DISCARDS = /(?:\bcurl\b|\bwget\b)[^|;]*(?:\s-o\s*\/dev\/null|--output\s+\/dev\/null|\s-[A-Za-z]*I\b|--head\b)|(?<![0-9&<>])>\s*\/dev\/null(?!\s*2?>&)|\b(?:grep|egrep|fgrep|rg|ag|ack)\s+(?:-[-A-Za-z0-9]*\s+)*(?:-[A-Za-z]*[cq][A-Za-z]*|--count|--quiet)\b/;
/** 输出重定向的目标（不含 /dev/null、2>&1、<<）。 */
const REDIRECT = /(?<![0-9&<>])>>?(?!&)\s*(?!\/dev\/null)([^\s>|&;]+)/g;
const MD_TOKEN = /[\w./~-]*[\w-]\.md\b/g;
const IN_INDEX = /memory-public\/index\/|memory-public\/[\w.-]+\.(?:catalog|details)\.md$/;
/** 这一段是不是在改索引目录里的文件：改动类动词涉及索引路径，或输出重定向的目标落在索引里。只写别处（如 > /tmp/out.txt）不算。 */
function writesIndex(stage: string, cwdIndex: boolean): boolean {
  const touchesIndex = /memory-public/.test(stage) || (cwdIndex && /\.md\b/.test(stage));
  if (MUTATION.test(stage) && touchesIndex) return true;
  for (const m of stage.matchAll(REDIRECT)) { const target = m[1]!.replace(/^['"]|['"]$/g, ''); if (IN_INDEX.test(target) || (cwdIndex && /\.md$/.test(target) && !target.includes('/'))) return true; }
  return false;
}

function kindOfFile(name: string): "map" | "catalog" | "details" {
  if (/\.details\.md$/.test(name)) return "details";
  if (/\.catalog\.md$/.test(name)) return "catalog";
  return "map";
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
function parseObject(input: string): Record<string, unknown> | undefined {
  const t = input.trim();
  if (!t.startsWith("{")) return undefined;
  try { const v = JSON.parse(t) as unknown; return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined; } catch { return undefined; }
}
function safeDecode(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }

/** grep / rg 的检索词：第一个带引号的参数，或第一个不是选项也不是文件的裸词。 */
function searchQuery(stage: string): string | undefined {
  const quoted = stage.match(/\b(?:grep|egrep|fgrep|rg|ag|ack)\b[^"'\\]*\\?["']#?([^"'\\]{1,40})/)?.[1];
  if (quoted && !/^#{2,}/.test(quoted)) return quoted;
  if (quoted) return undefined;   // `### 编号` 是按编号看详情，编号另外记，不当检索词
  // 没有引号的检索词：跳过选项后的第一个词（`grep 部署`、`rg -n foo`），不是文件
  const bare = stage.match(/\b(?:grep|egrep|fgrep|rg|ag|ack)\b(?:\s+-[-\w=]+)*\s+([^\s'"|<>-][^\s'"|<>]*)/)?.[1];
  return bare && !/\.md$/.test(bare) ? bare : undefined;
}
/** 这一段 grep / rg 的原始模式和选项（只认第一个模式；-e 取其参数）。认不出就不给，调用方退回「不过滤」。 */
function searchSpec(stage: string): Omit<SearchSpec, "op"> | undefined {
  const m = /\b(grep|egrep|fgrep|rg|ag|ack)\b((?:\s+-[ABCm]\s+\d+|\s+-e\s+\S+|\s+-[-\w=.,:]+)*)\s+(?:(["'])(.*?)\3|([^\s'"|<>-]\S*))/.exec(stage);
  if (!m) return undefined;
  const flags = m[2] ?? "";
  const eflag = /\s-e\s+(\S+)/.exec(flags)?.[1];
  const pattern = eflag?.replace(/^["']|["']$/g, "") ?? m[4] ?? m[5];
  if (!pattern || pattern.length > 120 || /\.md$/.test(pattern) && !m[4]) return undefined;
  return { pattern, ignoreCase: /(?:^|\s)-[A-Za-z]*i|--ignore-case/.test(flags), fixed: m[1] === "fgrep" || /(?:^|\s)-[A-Za-z]*F/.test(flags), ere: ["egrep", "rg", "ag", "ack"].includes(m[1]!) || /(?:^|\s)-[A-Za-z]*[EP]/.test(flags) };
}
/** grep 的模式 → 判断一段文字是否命中。基本正则里 `\|` `\(` `\+` 是特殊含义、裸的 `|` `(` `+` 是字面（GNU）；扩展正则（-E / rg）相反。写不成正则就退回子串匹配。 */
function matcherOf(spec: Omit<SearchSpec, "op">): (text: string) => boolean {
  const esc = (c: string): string => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let source: string;
  if (spec.fixed) source = esc(spec.pattern);
  else if (spec.ere) source = spec.pattern;
  else {
    source = "";
    for (let i = 0; i < spec.pattern.length; i++) {
      const c = spec.pattern[i]!;
      if (c === "\\" && i + 1 < spec.pattern.length && "|()+?{}".includes(spec.pattern[i + 1]!)) { source += spec.pattern[++i]; }
      else if ("|()+?{}".includes(c)) source += `\\${c}`;
      else source += c;
    }
  }
  try { const re = new RegExp(source, spec.ignoreCase ? "i" : ""); return (t) => re.test(t); }
  catch { const needle = spec.ignoreCase ? spec.pattern.toLowerCase() : spec.pattern; return (t) => (spec.ignoreCase ? t.toLowerCase() : t).includes(needle); }
}
function entryIds(stage: string): string[] {
  return [...stage.matchAll(/###\s*\\?["']?([0-9a-f]{4,12})\b/g)].map(m => m[1]!);
}

/** 去掉 heredoc 正文：里面是写给别的文件 / 脚本的内容，不是命令。输入被截断时 heredoc 可能没有结束标记，这时到末尾都算正文。 */
function stripHeredocs(text: string): string {
  let out = "", at = 0;
  const start = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n/g;
  for (let m = start.exec(text); m; m = start.exec(text)) {
    out += text.slice(at, m.index + m[0].length - 1);   // 保留 `<<'EOF'` 这一行，换行留给后面
    const end = new RegExp(`\\n[ \\t]*${m[2]}[ \\t]*(?=\\n|$)`).exec(text.slice(m.index + m[0].length - 1));
    if (!end) { at = text.length; break; }   // 没有结束标记：被截断了，到末尾都是正文
    at = m.index + m[0].length - 1 + end.index + end[0].length;
    start.lastIndex = at;
  }
  return out + text.slice(at);
}

/**
 * 工具输入太长时平台会截成前 4000 字符并追加「…（已截断，原文 N 字符）」，JSON 就不完整了。
 * 这种情况从 `"command": "…` 里把已有的部分取出来（按 JSON 字符串解码，最后一个转义被截断就丢掉）。
 */
function commandOfBrokenJson(input: string): string | undefined {
  const m = /^\s*\{\s*"(?:command|cmd)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(input);
  if (!m) return undefined;
  let body = m[1]!.replace(/\n…（已截断[^）]*）$/, "");
  while (body.endsWith("\\") && !body.endsWith("\\\\")) body = body.slice(0, -1);
  try { return JSON.parse(`"${body}"`) as string; } catch { return undefined; }
}

function shellOps(command: string, ops: IndexOp[], specs: SearchSpec[] = []): void {
  let cwdIndex = false;
  for (const cmd of stripHeredocs(command).split(/&&|\|\||;|\n/)) {
    const cd = cmd.match(/\bcd\s+["']?([^\s"'&;|\\]+)/);   // Codex 的命令带 /bin/zsh -lc '…' 外壳，cd 不一定在开头
    if (cd) { cwdIndex = /memory-public\/index\/?$/.test(cd[1]!); continue; }
    const stages = cmd.split(/\s\|\s/);
    // 管道里任何一段是 grep / rg：前面 cat 出来的索引文件实际是在检索（`cat x.md | grep 部署`）
    const searching = stages.find(s => SEARCH_VERB.test(s));
    for (const stage of stages) {
      if (VCS.test(stage) || DISCARDS.test(stage) || writesIndex(stage, cwdIndex)) continue;
      if (API_PATH.test(stage) && /\bcurl\b|\bwget\b|\bhttp/.test(stage)) {
        const q = stage.match(/[?&]q=([^&'"\s\\]{1,60})/)?.[1];
        ops.push({ kind: "api", how: q ? "search" : "read", ids: [], ...(q ? { query: safeDecode(q) } : {}) });
        continue;
      }
      if (!SEARCH_VERB.test(stage) && !READ_VERB.test(stage)) continue;
      const tokens = [...stage.matchAll(MD_TOKEN)].map(t => t[0]).filter(tok => tok.includes("/") ? IN_INDEX.test(tok) : cwdIndex);
      if (!tokens.length) continue;
      const how: LookupHow = SEARCH_VERB.test(stage) || searching ? "search" : "read";
      const ids = entryIds(stage);
      const query = searchQuery(stage) ?? (searching ? searchQuery(searching) : undefined);
      const spec = how === "search" ? searchSpec(stage) ?? (searching ? searchSpec(searching) : undefined) : undefined;
      for (const tok of tokens) {
        if (spec && !ids.length) specs.push({ op: ops.length, ...spec });
        ops.push({ kind: kindOfFile(tok), how, ids, ...(query ? { query: query.slice(0, 40) } : {}) });
      }
    }
  }
}

/** 一次工具调用里对公共记忆索引的每一处查阅（没有则空数组）。 */
export function classifyIndexOps(toolName: string | undefined, input: string | undefined): IndexOp[] { return analyze(toolName, input).ops; }

function analyze(toolName: string | undefined, input: string | undefined): { ops: IndexOp[]; specs: SearchSpec[] } {
  const ops: IndexOp[] = [], specs: SearchSpec[] = [];
  if (!input || input.length > 20_000) return { ops, specs };
  if (toolName && WRITE_TOOL.test(toolName)) return { ops, specs };
  if (!input.includes("memory-public") && !API_PATH.test(input)) return { ops, specs };
  const obj = parseObject(input);
  const path = str(obj?.["file_path"]) ?? str(obj?.["path"]);
  const command = str(obj?.["command"]) ?? str(obj?.["cmd"]);
  if (command) shellOps(command, ops, specs);
  else if (obj && path) {
    // 文件工具：Read（整份读）/ Grep（带 pattern 检索）。没有 shell 动词，路径在 file_path / path 里。
    if (IN_INDEX.test(path) && /\.md$/.test(path)) {
      const pattern = str(obj["pattern"]);
      const grep = (toolName && GREP_TOOL.test(toolName)) || pattern !== undefined;
      if (grep && pattern) specs.push({ op: ops.length, pattern, ignoreCase: obj["-i"] === true, fixed: false, ere: true });
      if (grep || !toolName || READ_TOOL.test(toolName) || /^[a-z_]+$/i.test(toolName)) ops.push({ kind: kindOfFile(path), how: grep ? "search" : "read", ids: pattern ? entryIds(`"${pattern}"`) : [], ...(pattern ? { query: pattern.replace(/^#/, "").slice(0, 40) } : {}) });
    }
  } else if (!obj) {
    // 以 { 开头但解析不了 = 被截断的 JSON：只认其中的 command，认不出就不猜（宁漏勿误）
    if (input.trimStart().startsWith("{")) { const cut = commandOfBrokenJson(input); if (cut) shellOps(cut, ops, specs); }
    else shellOps(input, ops, specs);
  }
  return { ops, specs };
}

/** 汇总视图（使用率统计用）：这条调用查了哪几类、哪些条目编号、检索词。 */
export function classifyIndexRead(toolName: string | undefined, input: string | undefined): IndexRead | null {
  const ops = classifyIndexOps(toolName, input);
  if (!ops.length) return null;
  const query = ops.find(o => o.query)?.query;
  return { kinds: [...new Set(ops.map(o => o.kind))], ids: [...new Set(ops.flatMap(o => o.ids))], ...(query ? { query } : {}) };
}

/* ------------------------------ 会话里的查阅记录 ------------------------------ */

/** 查阅返回给 runtime 的一条公共记忆（从工具输出里还原，是当时的内容，不是现在的）。 */
export interface RecalledEntry {
  /** 索引里的编号（8 位，详情里可能是前缀） */
  id: string;
  /** 常驻（已在首轮注入过）/ 按需 */
  tier?: "常驻" | "按需";
  /** 个人偏好·性质 / 项目·模块 */
  scope?: string;
  text: string;
}

export interface PlatformLookupItem {
  key: string;
  /** 原始工具名，用于详情里的「调用工具」 */
  tool: string;
  ops: IndexOp[];
  /** 这次查阅实际收到的条目（目录行 / 详情 / 接口命中），最多 MAX_RECALLED 条；解析不出（输出被截断、整份目录）就是空 */
  recalled: RecalledEntry[];
  /** 输出里能数到的条目总数（可能大于 recalled.length） */
  recalledTotal: number;
  /** 同一条命令里除了检索 / 按编号查看，还整份读取了目录（那部分输出不属于查询结果，recalled 里没有） */
  alsoRead: boolean;
  /** 命令原文（压成一行、截断）；文件工具给路径 */
  command: string;
  turnNo?: number;
  at: string;
}

const MAX_COMMAND = 300;
const okTool = (t: NonNullable<ProjectedEvent["tool"]>): boolean => {
  const s = (t.status ?? "").toLowerCase();
  if (["failed", "error", "declined", "cancelled", "canceled", "aborted", "inprogress", "in_progress", "running", "pending"].includes(s)) return false;
  return !(typeof t.exitCode === "number" && t.exitCode !== 0);
};

const MAX_RECALLED = 40;
const MAX_ENTRY_TEXT = 200;
const MAX_OUTPUT = 120_000;
const clipText = (t: string): string => { const flat = t.replace(/\uFFFD+$/u, "…").replace(/\s+/g, " ").trim(); return Array.from(flat).length > MAX_ENTRY_TEXT ? `${Array.from(flat).slice(0, MAX_ENTRY_TEXT - 1).join("")}…` : flat; };

/**
 * 从查阅命令的输出里还原模型实际收到的条目。索引文件有两种条目写法：
 *  - 目录 / grep 目录行：`<8 位编号> [常驻|按需] #<模块或 个人偏好/性质> | <摘要> | <归属>`（grep -n 会带 `行号:` 前缀）；
 *  - 详情 / 接口搜索：`### <编号> · <归属> · <模块或性质> · <常驻|按需>`，下一段是正文。
 * 同一编号只取一次（详情的正文比目录摘要完整，优先详情）。输出里没有这些形状（读的是主题目录、或被截断）就返回空。
 */
type ParsedEntry = RecalledEntry & { raw: string };
function parseEntries(output: string | undefined): ParsedEntry[] {
  if (!output) return [];
  const text = output.length > MAX_OUTPUT ? output.slice(0, MAX_OUTPUT) : output;
  const byId = new Map<string, ParsedEntry>();
  const blocks = [...text.matchAll(/^###\s+([0-9a-f]{4,12}) · ([^\n·]+?) · ([^\n·]+?) · (常驻|按需)[ \t]*\n[ \t]*\n([^\n]+)/gm)];
  for (const [i, m] of blocks.entries()) {
    const end = blocks[i + 1]?.index ?? text.length;
    byId.set(m[1]!, { id: m[1]!, tier: m[4] as "常驻" | "按需", scope: m[2] === "个人偏好" ? `个人偏好·${m[3]}` : `${m[2]}·${m[3]}`, text: clipText(m[5]!), raw: text.slice(m.index, Math.min(end, m.index! + 2000)) });
  }
  for (const m of text.matchAll(/^(?:\d+[:-])?([0-9a-f]{8}) \[(常驻|按需)\] #(\S+) \| (.+?)(?: \| ([^|\n]*))?$/gm)) {
    if (byId.has(m[1]!)) continue;
    const scope = m[3]!.startsWith("个人偏好/") ? m[3]!.replace("/", "·") : m[5] && m[5] !== "个人偏好" ? `${m[5]}·${m[3]}` : m[3]!;
    byId.set(m[1]!, { id: m[1]!, tier: m[2] as "常驻" | "按需", scope, text: clipText(m[4]!), raw: m[0] });
  }
  return [...byId.values()];
}
const publicEntry = ({ raw: _raw, ...e }: ParsedEntry): RecalledEntry => e;

/**
 * 从查阅命令的输出里还原返回给 runtime 的条目。索引文件有两种条目写法：
 *  - 目录 / grep 目录行：`<8 位编号> [常驻|按需] #<模块或 个人偏好/性质> | <摘要> | <归属>`（grep -n 会带 `行号:` 前缀）；
 *  - 详情 / 接口搜索：`### <编号> · <归属> · <模块或性质> · <常驻|按需>`，下一段是正文。
 * 同一编号只取一次（详情的正文比目录摘要完整，优先详情）。输出里没有这些形状（读的是主题目录、或被截断）就返回空。
 */
export function recalledFromOutput(output: string | undefined): { entries: RecalledEntry[]; total: number } {
  const all = parseEntries(output);
  return { entries: all.slice(0, MAX_RECALLED).map(publicEntry), total: all.length };
}

/**
 * 一次调用的「查询结果」：同一条命令里可能既整份读了目录（head / cat）又做了检索（grep），输出是混在一起的。
 * 有检索 / 按编号查看时，只留命中它的条目——检索按 grep 的模式（含 -i / -F / -E 语义）逐条判断，按编号看详情按编号，接口检索的输出本身就是命中结果；
 * 整份读取的那部分不算查询结果（alsoRead 标出来）。只有整份读取就全部列出；只有一处检索且没有别的读取，输出就是它的结果，不再过滤。
 */
function selectResults(entries: ParsedEntry[], ops: readonly IndexOp[], specs: readonly SearchSpec[]): { entries: ParsedEntry[]; alsoRead: boolean } {
  const isResult = (o: IndexOp): boolean => o.how === "search" || o.ids.length > 0;
  const resultOps = ops.map((op, i) => ({ op, i })).filter(({ op }) => isResult(op));
  const alsoRead = ops.some(o => !isResult(o));
  if (!resultOps.length) return { entries, alsoRead: false };
  if (!alsoRead && resultOps.length === 1) return { entries, alsoRead: false };
  const claims = resultOps.map(({ op, i }) => {
    if (op.kind === "api") return (): boolean => !ops.some(o => o.kind !== "api" && !isResult(o));
    if (op.ids.length) return (e: ParsedEntry): boolean => op.ids.some(id => e.id.startsWith(id) || id.startsWith(e.id));
    const spec = specs.find(sp => sp.op === i);
    if (!spec) return (): boolean => true;   // 认不出模式：不过滤
    const match = matcherOf(spec);
    return (e: ParsedEntry): boolean => match(e.raw);
  });
  return { entries: entries.filter(e => claims.some(c => c(e))), alsoRead };
}

export function platformLookupItem(e: ProjectedEvent): PlatformLookupItem | undefined {
  if (e.kind !== "tool" || !e.tool || e.partial || !okTool(e.tool)) return undefined;
  const { ops, specs } = analyze(e.tool.name, e.tool.input);
  if (!ops.length) return undefined;
  const obj = parseObject(e.tool.input ?? "");
  const raw = str(obj?.["command"]) ?? str(obj?.["cmd"]) ?? str(obj?.["file_path"]) ?? str(obj?.["path"]) ?? (e.tool.input?.trimStart().startsWith("{") ? commandOfBrokenJson(e.tool.input) : undefined) ?? e.tool.input ?? "";
  const flat = raw.replace(/\s+/g, " ").trim();
  const picked = selectResults(parseEntries(e.tool.output), ops, specs);
  return {
    key: e.key, tool: e.tool.name, ops,
    recalled: picked.entries.slice(0, MAX_RECALLED).map(publicEntry), recalledTotal: picked.entries.length, alsoRead: picked.alsoRead,
    command: flat.length > MAX_COMMAND ? `${flat.slice(0, MAX_COMMAND - 1)}…` : flat,
    ...(e.turnNo !== undefined ? { turnNo: e.turnNo } : {}),
    at: e.occurredAt ?? e.recordedAt
  };
}

export function platformLookups(events: readonly ProjectedEvent[]): PlatformLookupItem[] {
  const out: PlatformLookupItem[] = [];
  for (const e of events) { const item = platformLookupItem(e); if (item) out.push(item); }
  return out;
}
