/**
 * 诊断数据的读取与统计（V1.4 §3.3「分母」、A9 查询脚本、B 期分诊、D 期验证共用）。
 *
 * failure_rate = distinct(failure ∪ timeout attempt) / distinct(success ∪ failure ∪ timeout attempt)
 * - 事件按 event_id 去重，终态按 attempt 去重；cancelled 与 incomplete 单独计
 * - 采集中断、发生过丢弃时 data_quality = partial，不给确定的失败率结论
 */
import type { DiagnosticsStore, Health } from "./store.js";

export type Row = Record<string, unknown> & { at?: string; event_id?: string; event_name?: string };

/** Completion windows, never a claim of packet-level bandwidth or complete network capture. */
export function networkStats(rows: Row[]): Array<Record<string, unknown> & {page:string}> {
  const groups = new Map<string, Record<string, unknown> & {page:string}>();
  const sums = ['api_started','api_dispatched','api_finished','api_failed','api_cancelled','api_timeouts','resource_count','zero_transfer_resources','transfer_bytes','encoded_bytes','decoded_bytes','headers_ms','queue_ms','sse_created','sse_opens','sse_reconnects','sse_errors','sse_messages','sse_data_bytes','sse_untracked'];
  for (const r of dedupe(rows)) {
    if (r.event_name !== 'network_window' || !r['extra'] || typeof r['extra'] !== 'object') continue;
    const c = (r['context'] ?? {}) as Record<string, unknown>, x = r['extra'] as Record<string, unknown>;
    const page = String(r['page_instance_id'] ?? 'unknown'), browser = String(r['telemetry_session_id'] ?? 'unknown');
    const entry = String(c['entry'] ?? 'unknown'), ingress = String(r['ingress_entry'] ?? 'unknown');
    const key = JSON.stringify([entry,ingress,browser,page]);
    let g = groups.get(key);
    if (!g) {
      g = {page,browser,entry,ingress,os:c['os'] ?? 'unknown',entry_mismatch:entry !== 'unknown' && ingress !== 'unknown' && entry !== ingress,windows:0,resource_timing_unavailable_windows:0,window_ms:0,peak_inflight:0,peak_network:0};
      for (const field of sums) g[field] = 0;
      groups.set(key,g);
    }
    g['windows'] = Number(g['windows'])+1;
    if (x['resource_timing'] !== true) g['resource_timing_unavailable_windows'] = Number(g['resource_timing_unavailable_windows'])+1;
    const value = (field:string) => typeof x[field] === 'number' && Number.isFinite(x[field]) && Number(x[field]) >= 0 ? Number(x[field]) : 0;
    g['window_ms'] = Number(g['window_ms'])+value('window_ms');
    for (const field of sums) g[field] = Number(g[field])+value(field);
    for (const field of ['peak_inflight','peak_network']) g[field] = Math.max(Number(g[field]),value(field));
    const start = typeof x['window_start'] === 'string' ? x['window_start'] : null;
    if (start && (!g['first_window'] || start < String(g['first_window']))) g['first_window'] = start;
    const at = String(r['occurred_at'] ?? r.at ?? '');
    if (!g['last_window'] || at > String(g['last_window'])) {
      g['last_window'] = at;
      for (const field of ['inflight_end','network_end','sse_open','sse_connecting']) g[field] = value(field);
    }
  }
  return [...groups.values()];
}

export function parseLines(text: string): Row[] {
  const out: Row[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* 半截行：另一个进程正在写 */ }
  }
  return out;
}

export function dedupe(rows: Row[]): Row[] {
  const seen = new Set<string>(), out: Row[] = [];
  for (const r of rows) {
    const id = typeof r.event_id === "string" ? r.event_id : null;
    if (id) { if (seen.has(id)) continue; seen.add(id); }
    out.push(r);
  }
  return out;
}

const days = (from: number, to: number) => {
  const list: string[] = [];
  for (let t = Date.parse(new Date(from).toISOString().slice(0, 10)); t <= to; t += 86_400_000) list.push(new Date(t).toISOString().slice(0, 10));
  return list;
};

/** 按接收时间（at）读一段时间的前端与服务端事件。 */
export async function readRange(store: DiagnosticsStore, from: number, to: number): Promise<{ client: Row[]; server: Row[] }> {
  const client: Row[] = [], server: Row[] = [];
  for (const d of days(from, to)) {
    for (const r of parseLines(await store.readDay("client", d))) { const t = Date.parse(String(r.at)); if (t >= from && t <= to) client.push(r); }
    for (const r of parseLines(await store.readDay("server", d))) { const t = Date.parse(String(r.at)); if (t >= from && t <= to) server.push(r); }
  }
  return { client: dedupe(client), server };
}

export type OpStats = {
  component: string; started: number; success: number; failure: number; timeout: number; recovered: number; cancelled: number; incomplete: number;
  completed: number; failed: number; failureRate: number | null; sessions: number; byRelease: Record<string, { completed: number; failed: number }>;
};

/** 关键操作的分母统计。incomplete：有开始、超过 graceMs 仍没有任何终态。 */
export function opStats(client: Row[], now = Date.now(), graceMs = 60_000): OpStats[] {
  type Attempt = { component: string; startAt: number; terminals: Set<string>; session: string | null; release: string };
  const attempts = new Map<string, Attempt>();
  for (const r of client) {
    const attempt = typeof r["attempt_id"] === "string" ? r["attempt_id"] : null;
    const component = typeof r["component_id"] === "string" ? r["component_id"] : null;
    if (!attempt || !component || r["environment"] === "test") continue;
    const a = attempts.get(attempt) ?? { component, startAt: Number.NaN, terminals: new Set<string>(), session: (r["telemetry_session_id"] as string) ?? null, release: String(r["page_release"] ?? "unknown").slice(0, 12) };
    if (r.event_name === "op_start") a.startAt = Date.parse(String(r["occurred_at"] ?? r.at));
    else if (typeof r["result"] === "string") a.terminals.add(r["result"]);
    attempts.set(attempt, a);
  }
  const by = new Map<string, OpStats & { sessionSet: Set<string> }>();
  for (const a of attempts.values()) {
    const s = by.get(a.component) ?? { component: a.component, started: 0, success: 0, failure: 0, timeout: 0, recovered: 0, cancelled: 0, incomplete: 0, completed: 0, failed: 0, failureRate: null, sessions: 0, byRelease: {}, sessionSet: new Set<string>() };
    if (Number.isFinite(a.startAt)) s.started++;
    const failed = a.terminals.has("failure") || a.terminals.has("timeout");
    const done = failed || a.terminals.has("success") || a.terminals.has("recovered");
    if (a.terminals.has("timeout")) s.timeout++;
    if (a.terminals.has("failure")) s.failure++;
    if (a.terminals.has("recovered")) s.recovered++;
    if (a.terminals.has("success")) s.success++;
    if (a.terminals.has("cancelled") && !done) s.cancelled++;
    if (!a.terminals.size && Number.isFinite(a.startAt) && now - a.startAt > graceMs) s.incomplete++;
    if (done) {
      s.completed++; if (failed) s.failed++;
      const rel = (s.byRelease[a.release] ??= { completed: 0, failed: 0 });
      rel.completed++; if (failed) rel.failed++;
      if (failed && a.session) s.sessionSet.add(a.session);
    }
    by.set(a.component, s);
  }
  return [...by.values()].map(({ sessionSet, ...s }) => ({ ...s, sessions: sessionSet.size, failureRate: s.completed ? s.failed / s.completed : null }));
}

/** 这段时间的数据质量：任一槽位有丢弃 / 写入错误，或前端事件接收中断超过 gapMs，都算 partial。 */
export function dataQuality(health: Health[], client: Row[], from: number, to: number, gapMs = 6 * 3_600_000): { quality: "complete" | "partial"; reasons: string[] } {
  const reasons: string[] = [];
  for (const h of health) {
    const dropped = Object.entries(h.dropped ?? {}).filter(([k, n]) => n && !["duplicate", "invalid", "bundle-rate-limited"].includes(k));
    if (dropped.length) reasons.push(`${h.slot}: 丢弃 ${dropped.map(([k, n]) => `${k}=${n}`).join(",")}`);
    if (h.writeErrors) reasons.push(`${h.slot}: 写入错误 ${h.writeErrors}`);
  }
  const times = client.map((r) => Date.parse(String(r.at))).filter(Number.isFinite).sort((a, b) => a - b);
  let prev = from;
  for (const t of [...times, to]) { if (t - prev > gapMs && times.length) { reasons.push(`前端事件中断 ${Math.round((t - prev) / 3_600_000)} 小时`); break; } prev = t; }
  return { quality: reasons.length ? "partial" : "complete", reasons };
}

/** 一个请求 ID 的前后端时间线。 */
export function requestTimeline(client: Row[], server: Row[], requestId: string): Row[] {
  return [...client.filter((r) => r["request_id"] === requestId).map((r): Row => ({ ...r, side: "client" })), ...server.filter((r) => r["request_id"] === requestId).map((r): Row => ({ ...r, side: "server" }))]
    .sort((a, b) => Date.parse(String(a["occurred_at"] ?? a.at)) - Date.parse(String(b["occurred_at"] ?? b.at)));
}

/** 时间线的一行文字（查询脚本输出用）。 */
export function describe(r: Row): string {
  const at = String(r["occurred_at"] ?? r.at ?? "").replace("T", " ").replace(/\.\d+Z$/, "Z");
  const bits = [r["side"] ?? (r["schema"] === "server-event@1" ? "server" : "client"), r.event_name, r["component_id"], r["result"], r["error_type"], r["status"], r["route"] ?? r["api_route"] ?? r["route_template"], r["request_id"] ? `rid=${r["request_id"]}` : null, r["active_ms"] != null ? `active=${r["active_ms"]}ms` : null, r["ms"] != null ? `${r["ms"]}ms` : null, r["error_detail"]]
    .filter((x) => x !== undefined && x !== null && x !== "");
  return `${at}  ${bits.join("  ")}`;
}
