import type { ProjectedEvent } from "./types.js";

/**
 * 会话里用到的联网搜索 / 网页抓取记录。
 *
 * 不另存一份台账：工具调用本来就是会话事件，这里只是从事件里挑出三个 runtime 的
 * 搜索 / 抓取工具（Pi web_search·web_open、Claude WebSearch·WebFetch、Codex 网页搜索），
 * 按 runtime 各自的输入输出格式抽出关键字、网址、标题与结果条数。会话更新用到了就多一条，没用到就没有。
 */
export type WebActivityKind = "search" | "fetch";
export type WebActivityStatus = "ok" | "failed" | "running";
export interface WebActivityResult { title: string; url: string }
export interface WebActivityItem {
  key: string;
  seq: number;
  kind: WebActivityKind;
  /** 原始工具名，用于详情里的「调用工具」 */
  tool: string;
  status: WebActivityStatus;
  query?: string;
  url?: string;
  title?: string;
  resultCount?: number;
  /** 搜索返回的前几条结果（只有能可靠解析的格式才有） */
  results?: WebActivityResult[];
  /** 失败原因，或没有结构化信息时的输出开头 */
  note?: string;
  turnNo?: number;
  occurredAt?: string;
}

const MAX_RESULTS = 5;
const MAX_NOTE = 200;

/** 工具名归一：忽略大小写、空白、连字符；MCP 工具（server.tool / mcp__server__tool）只看最后一段。 */
export function classifyWebTool(name: string | undefined): WebActivityKind | undefined {
  if (!name) return undefined;
  const n = name.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (n === "网页搜索" || n === "联网搜索") return "search";
  if (n === "网页读取" || n === "网页抓取") return "fetch";
  const last = n.split(/\.|__/).pop() ?? n;
  if (/^web_?search$/.test(last)) return "search";
  if (/^web_?(fetch|open)$/.test(last)) return "fetch";
  return undefined;
}

function parseObject(input: string | undefined): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const text = input.trim();
  if (!text.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

const str = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const clip = (text: string, max: number): string => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };

function status(e: ProjectedEvent): WebActivityStatus {
  const t = e.tool;
  if (!t) return "running";
  const s = (t.status ?? "").toLowerCase();
  if (["failed", "error", "declined", "cancelled", "canceled", "aborted"].includes(s)) return "failed";
  if (typeof t.exitCode === "number" && t.exitCode !== 0) return "failed";
  if (e.partial || ["running", "inprogress", "in_progress", "pending"].includes(s)) return "running";
  // 平台检索服务的错误以 [CODE] 开头返回
  if (/^\[[A-Z_]+\]/.test((t.output ?? "").trim())) return "failed";
  return "ok";
}

/** Pi 的搜索应答：`搜索 q1「词」…共 N 条` 之后是 `R1. 标题\n   网址 · …` */
function parsePiSearch(output: string): { count?: number; results: WebActivityResult[] } {
  const count = /搜索 q\d+「[\s\S]*?」[^\n]*?共 (\d+) 条/.exec(output)?.[1];
  const results: WebActivityResult[] = [];
  const re = /^R\d+\. (.+?)(?: 〔[^〕]*〕)*(?: 〔本轮已读[^\n]*)?\n\s+(\S+)/gm;
  for (let m = re.exec(output); m && results.length < MAX_RESULTS; m = re.exec(output)) results.push({ title: m[1]!.trim(), url: m[2]! });
  return { ...(count !== undefined ? { count: Number(count) } : {}), results };
}

export function webActivityItem(e: ProjectedEvent): WebActivityItem | undefined {
  if (e.kind !== "tool" || !e.tool) return undefined;
  const kind = classifyWebTool(e.tool.name);
  if (!kind) return undefined;
  const st = status(e);
  const obj = parseObject(e.tool.input);
  const output = e.tool.output ?? "";
  const item: WebActivityItem = {
    key: e.key, seq: e.seq, kind, tool: e.tool.name, status: st,
    ...(e.turnNo !== undefined ? { turnNo: e.turnNo } : {}),
    ...(e.occurredAt || e.recordedAt ? { occurredAt: e.occurredAt || e.recordedAt } : {})
  };
  if (kind === "search") {
    // Codex 的搜索输入就是查询文本本身，其余 runtime 是 JSON 参数
    const query = str(obj?.["query"]) ?? str(obj?.["q"]) ?? (obj ? undefined : str(e.tool.input));
    if (query) item.query = clip(query, 300);
    const parsed = parsePiSearch(output);
    if (parsed.count !== undefined) item.resultCount = parsed.count;
    if (parsed.results.length) item.results = parsed.results;
  } else {
    const url = str(obj?.["url"]) ?? /^URL[：:]\s*(\S+)/m.exec(output)?.[1];
    if (url) item.url = url;
    const title = /^来源 \[S\d+\][：:]\s*(.+)$/m.exec(output)?.[1];
    if (title) item.title = clip(title, 200);
    // Pi 的 web_open 没有网址参数，只有「为什么读它」；留作说明
    const why = str(obj?.["why"]) ?? str(obj?.["prompt"]);
    if (why) item.note = clip(why, MAX_NOTE);
  }
  if (st === "failed" && output.trim()) item.note = clip(output, MAX_NOTE);
  return item;
}

export function webActivity(events: readonly ProjectedEvent[]): WebActivityItem[] {
  const out: WebActivityItem[] = [];
  for (const e of events) {
    const item = webActivityItem(e);
    if (item) out.push(item);
  }
  return out;
}
