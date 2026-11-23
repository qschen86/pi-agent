/**
 * 报错指纹的规则归一化（每晚错误统计，docs/requirements/error-stats-nightly）。
 *
 * 四类错误各自一套：
 * - 工具报错：`tool|<归一化工具名>|<主命令>|<退出码>|<错误签名>`，工具名先跨 runtime 对齐（Bash / bash / 命令 → shell），
 *   签名里的路径、数字、id、网址抹成占位符；
 * - 部署报错：`deploy|<失败类别>|<归一化原因>`，自动合并冲突按冲突文件拆开，一个文件一个指纹；
 * - 记忆强约束重试用尽：`memory|<ruleId>`；
 * - 门禁里「复跑才通过」的测试文件：`flaky|<测试文件路径>`（宿主机上的问题，没有 runtime 之分）。
 * 规则归一化只做「同一工具、同一种报错文案」的合并；不同 runtime 文案不同的同一根因，交给 merge.ts 里的 DeepSeek 归并。
 */
import { parseDeployHistoryLine } from "../deploy-history.js";

export type StatsRuntime = "pi" | "claude-code" | "codex";
export const RUNTIMES: readonly StatsRuntime[] = ["pi", "claude-code", "codex"];
export type ErrorKind = "tool" | "deploy" | "memory" | "flaky";

export interface Occurrence {
  kind: ErrorKind;
  runtime: StatsRuntime | "unknown";
  fingerprint: string;
  at: number;
  sessionId?: string;
  /** 一小段原始文字，给待办和 DeepSeek 看（已截断，不含完整输出） */
  sample: string;
  /** 去重键：同一条事件重读不会重复计数 */
  key: string;
}

export function runtimeOfParser(parserVersion: unknown): StatsRuntime | "unknown" {
  const p = String(parserVersion ?? "");
  if (p.startsWith("pi-rpc")) return "pi";
  if (p.startsWith("claude-agent-sdk")) return "claude-code";
  if (p.startsWith("codex-app-server")) return "codex";
  return "unknown";
}

/* ------------------------------ 工具名 ------------------------------ */

const TOOL_ALIAS: Record<string, string> = {
  bash: "shell", shell: "shell", "命令": "shell", exec_command: "shell",
  edit: "edit", multiedit: "edit", "文件修改": "edit", apply_patch: "edit",
  write: "write", read: "read", grep: "grep", glob: "glob", ls: "ls",
  websearch: "web-search", web_search: "web-search", "网页搜索": "web-search",
  webfetch: "web-fetch", web_fetch: "web-fetch"
};
export function canonicalToolName(name: string): string {
  const n = String(name ?? "").trim();
  return TOOL_ALIAS[n.toLowerCase()] ?? TOOL_ALIAS[n] ?? (n.toLowerCase() || "unknown");
}

/* ------------------------------ 主命令 ------------------------------ */

const SUBCOMMAND_PROGRAMS = new Set(["git", "npm", "npx", "pnpm", "yarn", "docker", "gh", "cargo", "go", "adb"]);
const WRAPPERS = new Set(["sudo", "time", "env", "nohup", "command", "builtin", "exec"]);

function commandText(input: string): string {
  const raw = String(input ?? "").trim();
  if (raw.startsWith("{")) { try { const j = JSON.parse(raw) as { command?: unknown; cmd?: unknown }; const c = j.command ?? j.cmd; if (typeof c === "string") return c; } catch { /* 当普通文本 */ } }
  // Codex：/bin/zsh -lc "<命令>"
  const m = /^(?:\/\S*\/)?(?:zsh|bash|sh)\s+-l?c\s+(["'])([\s\S]*)\1\s*$/.exec(raw);
  return m ? m[2]! : raw;
}

/** `cd x && FOO=1 git diff …` → `git diff`；识别不了返回 `-`。 */
export function mainProgram(input: string): string {
  let text = commandText(input).replace(/\\\n/g, " ").trim();
  for (let guard = 0; guard < 8; guard++) {
    const m = /^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)|export\s+\S+|source\s+\S+|set\s+[-+]\S+|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*))\s*(?:&&|;|\s)\s*/.exec(text);
    if (!m) break;
    text = text.slice(m[0].length);
  }
  const tokens = text.split(/\s+/).filter(Boolean);
  while (tokens.length && (WRAPPERS.has(tokens[0]!) || /^timeout$/.test(tokens[0]!))) { const t = tokens.shift()!; if (t === "timeout") tokens.shift(); }
  const first = tokens[0];
  if (!first) return "-";
  const base = first.replace(/^["'(]+/, "").split("/").pop() ?? first;
  if (!/^[A-Za-z0-9_.+-]+$/.test(base)) return "-";
  if (SUBCOMMAND_PROGRAMS.has(base)) { const sub = tokens.slice(1).find((t) => !t.startsWith("-")); return sub && /^[a-z][a-z0-9-]*$/i.test(sub) ? `${base} ${sub}` : base; }
  return base;
}

/* ------------------------------ 错误签名 ------------------------------ */

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function normalizeText(text: string): string {
  return String(text ?? "")
    .replace(ANSI, "")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/(?<![\w.<>-])(?:~|\.{1,2})?(?:\/[\w.@+-]+)+\/?/g, "<path>")
    .replace(/\b[\w.-]+(?:\/[\w.@+-]+){2,}\/?/g, "<path>")
    .replace(/\b[\w-]+\/[\w-]+\.[A-Za-z0-9]{1,6}\b/g, "<path>")
    .replace(/\brt-[0-9a-f]{8,}\b/g, "<id>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b[0-9a-f]{7,40}\b/gi, (m) => (/\d/.test(m) && /[a-f]/i.test(m) ? "<hex>" : m))
    .replace(/(["'`])([^"'`\n]{25,})\1/g, "$1<q>$1")
    .replace(/\d+(?:\.\d+)*/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

const ERROR_LINE = /(error|fatal|fail|cannot|can't|could not|couldn't|not found|no such|denied|timeout|timed out|exceeded|invalid|unexpected|refused|exception|traceback|✖|panic|unable|missing|not a git|conflict)/i;

export function exitCodeOf(output: string, exitCode?: unknown): number | undefined {
  if (typeof exitCode === "number" && Number.isFinite(exitCode)) return exitCode;
  const a = /^Exit code (\d+)/.exec(output); if (a) return Number(a[1]);
  const b = /Command exited with code (\d+)\s*$/.exec(output); if (b) return Number(b[1]);
  return undefined;
}

/** 去掉「退出码」包装文字后的输出正文。 */
function bodyOf(output: string): string {
  const body = String(output ?? "").replace(ANSI, "").replace(/^Exit code \d+\s*/, "").replace(/\s*Command exited with code \d+\s*$/, "").trim();
  if (body === "(no output)") return "";
  // 结构化输出（如 [{"type":"text","text":"…"}]）：取里面的文字
  if (body.startsWith("[") || body.startsWith("{")) {
    try {
      const v = JSON.parse(body) as unknown;
      const texts = (Array.isArray(v) ? v : [v]).map((x) => (x && typeof x === "object" ? (x as { text?: unknown }).text : undefined)).filter((t): t is string => typeof t === "string");
      if (texts.length) return texts.join("\n").trim();
    } catch { /* 当普通文本 */ }
  }
  return body;
}

export function errorSignature(output: string): string {
  const body = bodyOf(output);
  if (!body) return "(无输出)";
  // 栈帧、指示符、只有一个函数名的行不是报错信息
  const lines = body.split("\n").map((l) => l.trim()).filter((l) => l && !/^(?:at\s|\^|node:internal)/.test(l) && !/\($/.test(l));
  if (!lines.length) return "(无输出)";
  const pick = /Traceback \(most recent call last\)/.test(body) ? lines[lines.length - 1]!
    : lines.find((l) => ERROR_LINE.test(l)) ?? lines[lines.length - 1]!;
  return normalizeText(pick).slice(0, 120) || "(无输出)";
}

/* ------------------------------ 噪音 ------------------------------ */

const USER_STOP = /user (?:rejected|denied|declined|interrupted|cancel)|interrupted by user|request interrupted|aborted by user|operation was aborted|permission denied by user|用户(?:拒绝|取消|中断)/i;

/** 测试 / 类型检查 / 构建失败是开发过程里的正常反馈（红了再改），不是工具本身的报错。 */
const TEST_FAILURE = /Test Files\s+\d+ failed|Tests\s+\d+ failed|Failed Suites|❯ \S+ \(\d+ tests?|^\s*FAIL\s+\S+|AssertionError|ℹ fail [1-9]|error TS\d{4}|\d+ failed[,|]|✖ failing/m;

export function isNoiseTool(tool: { name: string; input?: string; output?: string; exitCode?: unknown }): boolean {
  const output = String(tool.output ?? "");
  if (USER_STOP.test(output)) return true;
  // 没有任何输出：看不出出了什么错，没法判断是不是同一个问题，不统计
  if (bodyOf(output) === "") return true;
  if (TEST_FAILURE.test(output)) return true;
  return false;
}

/* ------------------------------ 三类指纹 ------------------------------ */

export function toolFingerprint(tool: { name: string; input?: string; output?: string; exitCode?: unknown }): string {
  const name = canonicalToolName(tool.name);
  const output = String(tool.output ?? "");
  const code = exitCodeOf(output, tool.exitCode);
  const program = name === "shell" ? mainProgram(String(tool.input ?? "")) : "";
  return ["tool", name, ...(name === "shell" ? [program] : []), code === undefined ? "exit?" : `exit${code}`, errorSignature(output)].join("|");
}

export function sampleOfTool(tool: { name: string; input?: string; output?: string }): string {
  const cmd = canonicalToolName(tool.name) === "shell" ? commandText(String(tool.input ?? "")) : String(tool.input ?? "");
  const out = bodyOf(String(tool.output ?? ""));
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  return `${tool.name}｜输入：${clip(cmd.replace(/\s+/g, " "), 160)}｜输出：${clip(out.replace(/\s+/g, " "), 220) || "（无）"}`;
}

export function deployFingerprints(entry: { outcome: string; note: string }): string[] {
  const outcome = entry.outcome.trim();
  const conflict = /^(?:自动)?合并冲突[：:]\s*(.+)$/.exec(entry.note.trim());
  if (conflict) {
    const files = conflict[1]!.split(/[、,，]\s*/).map((f) => f.trim()).filter(Boolean);
    if (files.length) return files.map((f) => `deploy|${outcome}|conflict|${f}`);
  }
  return [`deploy|${outcome}|${normalizeText(entry.note) || "(无说明)"}`.slice(0, 200)];
}

export function memoryFingerprint(ruleId: string): string { return `memory|${ruleId}`; }

/** 一行 history.log → 部署失败的出现记录（失败才算；取消、过期、已在线不算报错）。 */
export function deployOccurrences(line: string, index: number, runtimeOfSession: (id: string) => StatsRuntime | "unknown", atMs: (stamp: string) => number): Occurrence[] {
  const e = parseDeployHistoryLine(line, index);
  if (!e || e.state !== "failed") return [];
  const runtime = e.runtimeKind !== "unknown" ? e.runtimeKind : e.sessionId ? runtimeOfSession(e.sessionId) : "unknown";
  const at = atMs(e.at);
  if (!Number.isFinite(at)) return [];
  const sample = `${e.outcome}｜${e.note}｜${e.subject}`.slice(0, 300);
  return deployFingerprints(e).map((fingerprint) => ({ kind: "deploy" as const, runtime, fingerprint, at, ...(e.sessionId ? { sessionId: e.sessionId } : {}), sample, key: `deploy:${e.at}|${e.sha}|${e.outcome}|${e.sessionId ?? ""}|${fingerprint}` }));
}

/** 门禁 flaky 记录（<guiRoot>/test-gates/flaky-tests.jsonl）的一行：每个复跑才通过的测试文件一条。 */
export function flakyOccurrences(line: string): Occurrence[] {
  let e: { at?: string; tree?: string; files?: unknown; details?: Array<{ file?: string; kind?: string; test?: string; error?: string }> };
  try { e = JSON.parse(line); } catch { return []; }
  const at = Date.parse(e.at ?? "");
  if (!Number.isFinite(at) || !Array.isArray(e.files)) return [];
  const out: Occurrence[] = [];
  for (const file of e.files) {
    if (typeof file !== "string" || !file) continue;
    const d = e.details?.find((x) => x.file === file);
    const sample = d ? `${d.kind ?? "unknown"}｜${d.test ?? ""}｜${d.error ?? ""}`.slice(0, 300) : "第一次没过，单独重跑通过";
    out.push({ kind: "flaky", runtime: "unknown", fingerprint: `flaky|${file}`, at, sample, key: `flaky:${e.at}|${e.tree ?? ""}|${file}` });
  }
  return out;
}
