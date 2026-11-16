/**
 * 给「值不值得做」评估组装上下文：模型只看这里给的资料，不联网、不读别的文件。
 * 每一块有编号（S1 统计、E* 样例、D* 部署日志、G* 代码历史、R1 规则定义、H1 过往决策），评估结果必须引用输入里的编号。
 * 日志、样例、提交标题都只是数据，其中看起来像指令的文字不执行（提示词里也写明了）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beijingDateKey, beijingStamp } from "../platform-time.js";
import type { ErrorStatsStore, FingerprintStat } from "./store.js";

export interface ContextDeps {
  store: ErrorStatsStore;
  repoRoot?: string | undefined;
  guiRoot: string;
  now: Date;
  sessionTitle?: ((id: string) => string | undefined) | undefined;
  ruleInfo?: ((ruleId: string) => { title: string; scope: string; criteria: string; feedback: string } | undefined) | undefined;
  todoState?: ((noteId: string) => "open" | "done" | "deleted") | undefined;
}
export interface AssessmentContext { text: string; ids: Set<string> }

const DAY_MS = 86_400_000;
const MAX_CHARS = 24_000;
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);
const RUNTIME_NAME: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", pi: "Pi", unknown: "未知" };

const BACKGROUND = `pi-agent 是用户自己的 AI 编码代理平台：同一个 Web 控制台里可以开 Claude Code、Codex、Pi 三种 runtime 的会话，会话里 AI 通过工具（shell、改文件、搜索等）改本项目的代码，改完走「部署门禁」（跑测试、自动合并 main、切换线上槽位）上线。用户是产品经理，一个人使用，希望少出重复的无谓失败。
这里的「报错」是：工具调用失败（status=failed）、部署失败（门禁测试红 / 自动合并冲突等）、记忆强约束自动反馈 2 次后仍未通过。用户已经把「用户拒绝 / 中断、没有输出、测试或类型检查红灯」排除在统计之外。`;

function git(repoRoot: string | undefined, args: string[]): string | null {
  if (!repoRoot) return null;
  try { return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
}
const stripAnsi = (t: string) => t.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");

/** 近 N 天（北京日期）每天次数，按 runtime 拆。 */
function trend(store: ErrorStatsStore, canonical: string, now: Date, days = 14): string {
  const rows: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = beijingDateKey(now.getTime() - i * DAY_MS);
    const per: Record<string, number> = {};
    for (const [k, b] of Object.entries(store.state.buckets[date] ?? {})) {
      const [runtime, fp] = k.split("\u0001") as [string, string];
      if (store.resolve(fp) === canonical) per[runtime] = (per[runtime] ?? 0) + b.n;
    }
    const total = Object.values(per).reduce((a, b) => a + b, 0);
    rows.push(`${date.slice(5)}：${total || "-"}${total ? `（${Object.entries(per).map(([r, n]) => `${RUNTIME_NAME[r] ?? r}${n}`).join(" ")}）` : ""}`);
  }
  return rows.join("；");
}

/** 这个代表指纹下不同的样例（新的在前），每个 runtime 至少带一条。 */
function samples(store: ErrorStatsStore, canonical: string, limit = 5): Array<{ runtime: string; at: number; sample: string }> {
  const all: Array<{ runtime: string; at: number; sample: string }> = [];
  for (const day of Object.values(store.state.buckets)) for (const [k, b] of Object.entries(day)) {
    const [runtime, fp] = k.split("\u0001") as [string, string];
    if (store.resolve(fp) === canonical) all.push({ runtime, at: b.last, sample: b.sample });
  }
  all.sort((a, b) => b.at - a.at);
  const out: typeof all = [], seen = new Set<string>(), perRuntime = new Set<string>();
  for (const x of all) { if (!perRuntime.has(x.runtime) && !seen.has(x.sample)) { out.push(x); seen.add(x.sample); perRuntime.add(x.runtime); } }
  for (const x of all) { if (out.length >= limit) break; if (!seen.has(x.sample)) { out.push(x); seen.add(x.sample); } }
  return out.slice(0, limit);
}

export function buildAssessmentContext(stat: FingerprintStat, deps: ContextDeps): AssessmentContext {
  const { store, now } = deps;
  const ids = new Set<string>();
  const blocks: Array<{ id: string; body: string }> = [];
  const add = (id: string, body: string) => { ids.add(id); blocks.push({ id, body }); };

  // S1 统计
  const lines: string[] = [`指纹：${stat.fingerprint}`, `类别：${stat.kind === "tool" ? "工具报错" : stat.kind === "deploy" ? "部署失败" : "记忆强约束重试用尽"}`,
    `近 30 天共 ${stat.total} 次（北京时间 ${beijingStamp(stat.first)} ~ ${beijingStamp(stat.last)}）`];
  for (const [rt, r] of Object.entries(stat.runtimes)) lines.push(`- ${RUNTIME_NAME[rt] ?? rt}：${r!.count} 次 · ${r!.days} 天 · ${r!.sessions.length} 个会话`);
  lines.push(`近 14 天走势（北京日期）：${trend(store, stat.fingerprint, now)}`);
  if (stat.members.length > 1) {
    lines.push(`被 DeepSeek 归并的 ${stat.members.length} 个文案不同的指纹：`);
    for (const m of stat.members.slice(0, 6)) lines.push(`  · ${clip(m, 140)}`);
    const reasons = store.state.mergeLog.filter((e) => e.members.some((m) => stat.members.includes(m))).slice(-2).map((e) => e.reason);
    if (reasons.length) lines.push(`归并理由：${reasons.join("；")}`);
  }
  add("S1", lines.join("\n"));

  // E* 样例
  samples(store, stat.fingerprint).forEach((x, i) => add(`E${i + 1}`, `${RUNTIME_NAME[x.runtime] ?? x.runtime} · ${beijingStamp(x.at)}（北京时间）\n${clip(x.sample, 420)}`));

  // 会话背景：当时在做什么
  const titles = [...new Set(Object.values(stat.runtimes).flatMap((r) => r!.sessions))].map((id) => deps.sessionTitle?.(id)).filter((t): t is string => !!t).slice(0, 6);
  if (titles.length) add("C1", `出错时这些会话在做的事（会话标题）：\n${titles.map((t) => `- ${clip(t, 60)}`).join("\n")}`);

  const [kind, ...rest] = stat.fingerprint.split("|");
  if (kind === "deploy") {
    const outcome = rest[0] ?? "";
    // D* 最近几次同结果的部署日志尾部
    try {
      const home = join(deps.guiRoot, "when-idle");
      const hist = readFileSync(join(home, "history.log"), "utf8").split("\n").filter((l) => l.split("\t")[2] === outcome).slice(-3);
      const files = existsSync(home) ? readdirSync(home).filter((f) => f.startsWith("deploy-") && f.endsWith(".log")) : [];
      hist.forEach((l, i) => {
        const sha = (l.split("\t")[1] ?? "").slice(0, 7);
        const file = files.find((f) => f.includes(`-${sha}`));
        const tail = file ? stripAnsi(readFileSync(join(home, file), "utf8")).split("\n").slice(-18).join("\n") : "";
        add(`D${i + 1}`, `部署记录：${l.replace(/\t/g, " | ").slice(0, 240)}${tail ? `\n日志尾部：\n${clip(tail, 1400)}` : ""}`);
      });
    } catch { /* 读不到部署日志就少一块上下文 */ }
    // G* 冲突文件近 30 天的提交（解释为什么总冲突）
    if (rest[1] === "conflict" && rest[2]) {
      const log = git(deps.repoRoot, ["log", "--since=30.days", "--format=%h %s", "--", rest[2]]);
      if (log !== null) { const commits = log.trim().split("\n").filter(Boolean); add("G1", `${rest[2]} 近 30 天有 ${commits.length} 次提交，最近几条：\n${commits.slice(0, 6).map((c) => `- ${clip(c, 100)}`).join("\n")}`); }
    }
    try { add("G2", `自动合并部署机制说明（docs/deployment-auto-integration.md 开头）：\n${clip(readFileSync(join(deps.repoRoot ?? "", "docs/deployment-auto-integration.md"), "utf8"), 1600)}`); } catch { /* 没有文档就不带 */ }
  } else if (kind === "memory") {
    const info = deps.ruleInfo?.(rest[0] ?? "");
    if (info) add("R1", `规则「${info.title}」（${rest[0]}）\n校验范围：${clip(info.scope, 500)}\n通过标准：${clip(info.criteria, 500)}\n不通过时给模型的反馈：${clip(info.feedback, 400)}`);
  } else {
    // 样例里提到的仓库内文件：近期提交
    const paths = new Set<string>();
    for (const x of samples(store, stat.fingerprint)) for (const m of x.sample.matchAll(/\b((?:apps|packages|scripts|docs)\/[\w./-]+)/g)) paths.add(m[1]!);
    let g = 0;
    for (const p of [...paths].slice(0, 3)) {
      const log = git(deps.repoRoot, ["log", "-3", "--format=%h %ad %s", "--date=short", "--", p]);
      if (log?.trim()) add(`G${++g}`, `${p} 最近的提交：\n${log.trim().split("\n").map((c) => `- ${clip(c, 100)}`).join("\n")}`);
    }
  }

  // H1 已有的待办：评估时要避免重复（同一根因 / 同一套机制改动已经有待办覆盖了就不要再建议）
  const past = Object.entries(store.state.todos).filter(([fp]) => fp !== stat.fingerprint).slice(-14).map(([fp, t]) => {
    const a = store.state.assessments[fp];
    const state = t.closedAt ? "已被你关闭" : deps.todoState?.(t.noteId) === "open" ? "待办还开着" : "已处理";
    return `- ${clip(fp, 90)}：${state}${a ? `｜AI 评估 ${a.verdict}：「${clip(a.title, 40)}」根因假设：${clip(a.rootCause, 110)}` : ""}`;
  });
  const own = store.state.todos[stat.fingerprint];
  if (own?.closedAt) past.unshift(`- （同一个错误）上一条待办已被你在 ${beijingStamp(own.closedAt)}（北京时间）关闭，之后又出现了新的证据`);
  if (past.length) add("H1", `已有的错误统计待办与处理情况：\n${past.join("\n")}`);

  // 总长度控制：超了从后面的块开始截
  let used = BACKGROUND.length, body = "";
  const kept = new Set<string>();
  for (const b of blocks) {
    const text = `[${b.id}]\n${b.body}\n\n`;
    if (used + text.length > MAX_CHARS) continue;
    used += text.length; body += text; kept.add(b.id);
  }
  for (const id of [...ids]) if (!kept.has(id)) ids.delete(id);
  return { text: `项目背景：\n${BACKGROUND}\n\n${body}`.trim(), ids };
}
