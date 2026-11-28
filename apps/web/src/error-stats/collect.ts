/**
 * 增量读取三类报错来源（只读，不改源文件）：
 * - 会话事件 <dataDir>/runtime/events/<会话>.jsonl：`kind=tool` 且 `status=failed` 的事件；
 * - 部署日志 <guiRoot>/when-idle/history.log：失败的部署；
 * - 审计 <dataDir>/runtime/audit.jsonl：`memory-enforcement-exhausted`（强约束重试用尽）；
 * - 门禁 <guiRoot>/test-gates/flaky-tests.jsonl：复跑才通过的测试文件。
 * 每个文件只读游标之后追加的部分；第一次（没有游标）只回填 sinceMs 之后有改动的文件。
 * 整份事件目录有几百 MB，所以按块读、行级先用字符串过滤再解析 JSON，并且每个文件之间让出事件循环。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseLocalStamp } from "../diagnostics/triage.js";
import { deployOccurrences, flakyOccurrences, type GateResult, isNoiseTool, memoryFingerprint, runtimeOfParser, sampleOfTool, toolFingerprint, type Occurrence, type StatsRuntime } from "./normalize.js";
import type { ErrorStatsStore } from "./store.js";

const CHUNK = 1 << 20;
const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** 从 offset 起读到最后一个换行；返回行和新的 offset（半行留到下次）。 */
async function readLines(file: string, offset: number, size: number, onLine: (line: string) => void): Promise<number> {
  const fh = await open(file, "r");
  try {
    let pos = offset, carry = "", consumed = 0;
    const decoder = new StringDecoder("utf8");
    const buf = Buffer.alloc(CHUNK);
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - pos), pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const parts = (carry + decoder.write(buf.subarray(0, bytesRead))).split("\n");
      carry = parts.pop() ?? "";
      for (const line of parts) { onLine(line); consumed += Buffer.byteLength(line) + 1; }
      await yieldLoop();
    }
    // carry 是没有换行结尾的半行：不消费，offset 停在它前面
    return offset + consumed;
  } finally { await fh.close(); }
}

export interface CollectOptions {
  store: ErrorStatsStore;
  runtimeDir: string;
  guiRoot: string;
  /** 回填 / 入库的最早时间（毫秒）；更早的事件忽略 */
  sinceMs: number;
  runtimeOfSession: (id: string) => StatsRuntime | "unknown";
}

export async function collectToolFailures(o: CollectOptions): Promise<number> {
  const dir = join(o.runtimeDir, "events");
  if (!existsSync(dir)) return 0;
  let added = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = join(dir, name), sid = name.slice(0, -6);
    let st; try { st = statSync(file); } catch { continue; }
    const cur = o.store.state.cursors.events[sid];
    if (!cur && st.mtimeMs < o.sinceMs) { o.store.state.cursors.events[sid] = { offset: st.size, size: st.size }; continue; }
    const from = cur && st.size >= cur.offset ? cur.offset : 0;
    if (cur && st.size === cur.size && from === cur.offset) continue;
    const next = await readLines(file, from, st.size, (line) => {
      if (!line.includes('"status":"failed"')) return;
      let e: { kind?: string; key?: string; parserVersion?: string; occurredAt?: string; recordedAt?: string; tool?: { name: string; input?: string; output?: string; exitCode?: unknown } };
      try { e = JSON.parse(line); } catch { return; }
      if (e.kind !== "tool" || !e.tool || (e.tool as { status?: string }).status !== "failed") return;
      const at = Date.parse(e.occurredAt ?? e.recordedAt ?? "");
      if (!Number.isFinite(at) || at < o.sinceMs) return;
      const runtime = runtimeOfParser(e.parserVersion);
      if (runtime === "unknown" || isNoiseTool(e.tool)) return;
      const occ: Occurrence = { kind: "tool", runtime, fingerprint: toolFingerprint(e.tool), at, sessionId: sid, sample: sampleOfTool(e.tool), key: `tool:${sid}:${e.key ?? at}` };
      if (o.store.add(occ)) added++;
    });
    o.store.state.cursors.events[sid] = { offset: next, size: st.size };
  }
  return added;
}

/**
 * 按部署记录找到当时门禁落盘的失败结果。
 * 门禁文件名里的 sha 是「叠加集成后」的提交（请求被合进暂存栈后会换一个新 sha），不一定等于请求的 sha；
 * 所以：请求之后 15 分钟内起的、记录时间之前结束的失败门禁里，sha 相同的优先，否则取离请求最近的一份。
 * 日志本身没有被清理（stage 日志保留至今），找不到只会是这段时间里没有失败的门禁。
 */
export function gateResultFinder(dir: string): (e: { sha: string; requestId?: string; atMs: number }) => GateResult | null {
  let names: string[] | null = null;
  const cache = new Map<string, GateResult>();
  const stampMs = (ts: string) => Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10), +ts.slice(10, 12), +ts.slice(12, 14));
  return (e) => {
    try {
      names ??= readdirSync(dir).filter((n) => n.startsWith("stage-") && n.endsWith(".log.gate.json")).sort();
      const reqTs = /^(\d{14})/.exec(e.requestId ?? "")?.[1];
      if (!reqTs) return null;
      let best: { g: GateResult; sameSha: boolean; dist: number } | null = null;
      for (const n of names) {
        const m = /^stage-(\d{14})-([0-9a-f]+)\.log\.gate\.json$/.exec(n);
        if (!m || m[1]! < reqTs) continue;
        const dist = stampMs(m[1]!) - stampMs(reqTs);
        if (dist > 15 * 60_000) break; // names 已按时间排序
        const g = cache.get(n) ?? (JSON.parse(readFileSync(join(dir, n), "utf8")) as GateResult);
        cache.set(n, g);
        const at = Date.parse(g.at ?? "");
        if (!Number.isFinite(at) || at > e.atMs + 120_000 || g.status !== "failed") continue;
        const sameSha = m[2] === e.sha;
        if (!best || (sameSha && !best.sameSha) || (sameSha === best.sameSha && dist < best.dist)) best = { g, sameSha, dist };
      }
      return best?.g ?? null;
    } catch { return null; }
  };
}

export async function collectDeploys(o: CollectOptions): Promise<number> {
  const file = join(o.guiRoot, "when-idle", "history.log");
  if (!existsSync(file)) return 0;
  const st = statSync(file);
  const cur = o.store.state.cursors.deploy;
  const from = st.size >= cur.offset ? cur.offset : 0;
  if (from === st.size) return 0;
  let added = 0, index = 0;
  const gateOf = gateResultFinder(join(o.guiRoot, "when-idle"));
  const next = await readLines(file, from, st.size, (line) => {
    for (const occ of deployOccurrences(line, index++, o.runtimeOfSession, parseLocalStamp, gateOf)) {
      if (occ.at < o.sinceMs) continue;
      if (o.store.add(occ)) added++;
    }
  });
  cur.offset = next;
  return added;
}

/** 强约束用尽重试那回合的「哪里没通过」原文，取自会话时间线里的 enforcement 通知；找不到就空。 */
function exhaustedProblem(runtimeDir: string, sessionId: string, turnNo: number): string {
  try {
    const text = readFileSync(join(runtimeDir, "events", `${sessionId}.jsonl`), "utf8");
    const marker = `"key":"memory-enforce:${turnNo}"`;
    for (const line of text.split("\n")) {
      if (!line.includes(marker) || !line.includes('"phase":"exhausted"')) continue;
      const e = JSON.parse(line) as { text?: string };
      return String(e.text ?? "").replace(/\s+/g, " ").slice(0, 260);
    }
  } catch { /* 会话文件没了就只记规则 */ }
  return "";
}

export async function collectEnforcementExhausted(o: CollectOptions): Promise<number> {
  const file = join(o.runtimeDir, "audit.jsonl");
  if (!existsSync(file)) return 0;
  const st = statSync(file);
  const cur = o.store.state.cursors.audit;
  const from = st.size >= cur.offset ? cur.offset : 0;
  if (from === st.size) return 0;
  let added = 0;
  const next = await readLines(file, from, st.size, (line) => {
    if (!line.includes("memory-enforcement-exhausted")) return;
    let e: { at?: string; type?: string; platformSessionId?: string; turnNo?: number; rules?: string[] };
    try { e = JSON.parse(line); } catch { return; }
    const at = Date.parse(e.at ?? "");
    if (e.type !== "memory-enforcement-exhausted" || !Number.isFinite(at) || at < o.sinceMs || !e.platformSessionId) return;
    const runtime = o.runtimeOfSession(e.platformSessionId);
    const problem = exhaustedProblem(o.runtimeDir, e.platformSessionId, e.turnNo ?? 0);
    for (const rule of e.rules ?? []) {
      const occ: Occurrence = { kind: "memory", runtime, fingerprint: memoryFingerprint(rule), at, sessionId: e.platformSessionId, sample: problem || `规则 ${rule}｜第 ${e.turnNo ?? "?"} 回合`, key: `memory:${e.at}|${e.platformSessionId}|${rule}` };
      if (o.store.add(occ)) added++;
    }
  });
  cur.offset = next;
  return added;
}

export async function collectFlaky(o: CollectOptions): Promise<number> {
  const file = join(o.guiRoot, "test-gates", "flaky-tests.jsonl");
  if (!existsSync(file)) return 0;
  const st = statSync(file);
  const cur = (o.store.state.cursors.flaky ??= { offset: 0 });
  const from = st.size >= cur.offset ? cur.offset : 0;
  if (from === st.size) return 0;
  let added = 0;
  const next = await readLines(file, from, st.size, (line) => {
    for (const occ of flakyOccurrences(line)) {
      if (occ.at < o.sinceMs) continue;
      if (o.store.add(occ)) added++;
    }
  });
  cur.offset = next;
  return added;
}
