/**
 * 服务端诊断（V1.4 §3.1–§4）：请求 ID、服务端结构化事件、前端事件接收、链路证据包。
 *
 * 一个进程一个实例，由 main.ts 创建并传给 createWebApp；测试按需传入。
 * 任何一步失败都只记进 health，不影响业务请求本身。
 */
import { appData } from "../app-data.js";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DiagnosticsStore, type Limits } from "./store.js";
import { ACTIVE, FindingStore, STATUS_LABEL } from "./findings.js";
import type { DiagnosticTriage } from "./triage.js";
import type { RepairSessions } from "./repair.js";
import type { ErrorStatsService } from "../error-stats/service.js";
import type { SelfHealService } from "../self-heal/service.js";
import type { FixVerifier } from "./verify.js";
import { eventFingerprint, fingerprint, redactStack, redactText, shapePath, boundedJson } from "./redact.js";
import { isBundleTrigger, isSuccessClass, normalizeClientEvent, routeTemplate } from "./events.js";

export const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/;
export const newRequestId = () => randomBytes(16).toString("base64url");
/** 证据包附带的日志范围：出事前 2.5 分钟到之后 30 秒（再早的与这次问题基本无关，只会让包变长）。 */
const EVIDENCE_WINDOW = { before: 150_000, after: 30_000 };

export type ReleaseIdentity = { release?: string; gitCommit?: string; dirty?: boolean };
export type ServerIdentity = { server_release: string | null; server_commit: string | null; slot: string; pid: number };
export type BundleInfo = { id: string; fingerprint: string; manual: boolean; source: "client" | "server"; createdAt: string };

type ServerEvent = Record<string, unknown> & { event_name: string };

export class ServerDiagnostics {
  readonly store: DiagnosticsStore;
  private identity: () => ServerIdentity;
  private now: () => Date;
  private seenIds = new Map<string, number>();
  private sessionRate = new Map<string, { minute: number; count: number }>();
  private fpDaily = new Map<string, number>();
  private serverFpMinute = new Map<string, number>();
  /** 新证据包落盘后的可选回调；生产统一由自愈夜检分析 */
  onBundle: ((info: BundleInfo) => void) | undefined;
  readonly findings: FindingStore;
  /** 自愈夜检使用的链路分诊引擎（main.ts 接上；测试可不接） */
  triage: DiagnosticTriage | undefined;
  /** C 期修复会话（createWebApp 在有 runtime 时接上） */
  repair: RepairSessions | undefined;
  /** D 期修复效果验证（main.ts 接上） */
  verifier: FixVerifier | undefined;
  /** 每晚错误统计建的待办 id（main.ts 接上）：不进推荐任务整理的合并池 */
  errorStatsNoteIds: (() => Set<string>) | undefined;
  /** 每晚错误统计：设置页「错误统计」的手动触发与运行历史（main.ts 接上） */
  errorStats: ErrorStatsService | undefined;
  selfHeal: SelfHealService | undefined;

  private manifest: () => ReleaseIdentity | undefined;

  constructor(options: { dir: string; release?: () => ReleaseIdentity | undefined; commit?: string | null; slot?: string; now?: () => Date; limits?: Partial<Limits>; refreshMs?: number }) {
    this.now = options.now ?? (() => new Date());
    const slot = options.slot ?? process.env["PI_AGENT_WEB_SLOT"] ?? "dev";
    this.store = new DiagnosticsStore({ dir: options.dir, slot, now: this.now, ...(options.limits ? { limits: options.limits } : {}), ...(options.refreshMs !== undefined ? { refreshMs: options.refreshMs } : {}) });
    const commit = options.commit ?? process.env["PI_AGENT_WEB_SHA"] ?? null;
    this.manifest = options.release ?? (() => undefined);
    this.findings = new FindingStore(options.dir, this.now);
    // 关联待办还没关闭、或问题还在处理中的证据包延长保留（最长 90 天）
    this.store.protectBundle = (id) => this.findings.all().some((f) => f.bundleIds.includes(id) && (ACTIVE.has(f.status) || (!!f.noteId && !f.noteDone && f.status !== "note_deleted")));
    this.identity = () => ({ server_release: this.manifest()?.release ?? null, server_commit: commit && /^[a-f0-9]{7,40}$/.test(commit) ? commit : null, slot, pid: process.pid });
  }
  /** createWebApp 读到静态 release 之后接上：服务端身份里带上当前页面 release。 */
  attachRelease(get: () => ReleaseIdentity | undefined): void { this.manifest = get; }

  stop(): void { this.store.stop(); }
  server(): ServerIdentity { return this.identity(); }

  /* ------------------------------ 服务端事件 ------------------------------ */

  private record(event: ServerEvent, success = false): ServerEvent {
    const full = { at: this.now().toISOString(), schema: "server-event@1", ...event, ...this.identity() } as ServerEvent;
    for (const k of Object.keys(full)) if (full[k] === null || full[k] === undefined) delete full[k];
    this.store.append("server", [{ line: JSON.stringify(full), success }]);
    return full;
  }

  slowRequest(e: { method: string; path: string; status: number; ms: number; requestId?: string | undefined }): void {
    this.record({ event_name: "slow_request", method: e.method, route: shapePath(e.path), status: e.status, ms: Math.round(e.ms), request_id: e.requestId });
  }
  lag(lagMs: number): void { this.record({ event_name: "event_loop_lag", lag_ms: Math.round(lagMs) }); }
  launch(report: Record<string, unknown>): void { this.record({ event_name: "launch", ...report }, true); }

  /** 接口 500 / onError：记一条事件，并（限流后）生成服务端证据包。 */
  serverError(e: { method: string; path: string; status: number; requestId?: string | undefined; error: unknown }): void {
    const err = e.error as { name?: string; code?: unknown; message?: string; stack?: string } | undefined;
    const stack = redactStack(err?.stack ?? "");
    const route = shapePath(e.path);
    const event = this.record({
      event_name: "server_error", method: e.method, route, status: e.status, request_id: e.requestId,
      error_type: (err?.name || "Error").slice(0, 40), error_code: typeof err?.code === "string" ? err.code.slice(0, 40) : undefined,
      error_detail: redactText(err?.message ?? String(e.error), 300), stack
    });
    const fp = eventFingerprint(event);
    // 同一指纹每分钟最多一个包、每天最多 5 个（与前端的限流一致）
    const minute = Math.floor(this.now().getTime() / 60_000);
    if (this.serverFpMinute.get(fp) === minute) return;
    this.serverFpMinute.set(fp, minute);
    if (this.serverFpMinute.size > 2000) this.serverFpMinute.clear();
    if (!this.allowFingerprint(fp, false)) return;
    setImmediate(() => { void this.assembleServerBundle(event, fp).catch((x) => this.store.noteError(x)); });
  }

  /** 进程级未捕获异常：同步写一行（进程可能马上退出），不改原来的退出行为。 */
  processError(error: unknown, origin: string): void {
    try {
      const err = error as { name?: string; message?: string; stack?: string } | undefined;
      const stack = redactStack(err?.stack ?? "");
      const event = this.record({ event_name: "process_error", origin: origin.slice(0, 40), error_type: (err?.name || "Error").slice(0, 40), error_detail: redactText(err?.message ?? String(error), 300), stack });
      const fp = eventFingerprint(event);
      const id = `s${newRequestId()}`;
      this.store.writeBundle(id, { schema: "bundle@1", bundle_id: id, created_at: this.now().toISOString(), source: "server",
        trigger: { kind: "auto", event_name: "process_error", error_type: event["error_type"], fingerprint: fp },
        client: null, server: { ...this.identity(), events: [event], releases: this.recentReleases(), collected_at: this.now().toISOString() },
        data_quality: "partial", completeness: { reason: "process-exiting" } }, false);
      this.store.flushHealth();
    } catch { /* 进程正在崩溃，不能再抛 */ }
  }

  private allowFingerprint(fp: string, manual: boolean): boolean {
    const key = `${this.now().toISOString().slice(0, 10)}|${fp}`;
    const n = this.fpDaily.get(key) ?? 0;
    if (!manual && n >= 5) { this.store.drop("bundle-rate-limited"); return false; }
    this.fpDaily.set(key, n + 1);
    if (this.fpDaily.size > 5000) this.fpDaily.clear();
    return true;
  }

  private recentReleases(at = this.now().getTime()) {
    return this.store.readReleases().filter((r) => Math.abs(Date.parse(r.activatedAt) - at) <= 3_600_000).slice(-10);
  }

  private async serverPart(at: number, requestIds: Set<string>) {
    const events = await this.store.eventsAround("server", at, EVIDENCE_WINDOW, requestIds, 200);
    const health = this.store.readAllHealth().map((h) => ({ slot: h.slot, updatedAt: h.updatedAt, lastClientIngestAt: h.lastClientIngestAt, dropped: h.dropped, writeErrors: h.writeErrors }));
    return { ...this.identity(), events, releases: this.recentReleases(at), health, collected_at: this.now().toISOString() };
  }

  private async assembleServerBundle(event: ServerEvent, fp: string): Promise<void> {
    const at = Date.parse(String(event["at"]));
    const requestIds = new Set(typeof event["request_id"] === "string" ? [event["request_id"]] : []);
    const server = await this.serverPart(at, requestIds);
    // 同一请求的前端事件可能已经到了（前端先收到 500 再上报，一般晚于这里）；之后到的前端包会通过 request_id 关联
    const client = await this.store.eventsAround("client", at, EVIDENCE_WINDOW, requestIds, 100);
    const id = `s${newRequestId()}`;
    const result = this.store.writeBundle(id, {
      schema: "bundle@1", bundle_id: id, created_at: this.now().toISOString(), source: "server",
      trigger: { kind: "auto", event_name: event.event_name, error_type: event["error_type"], route: event["route"], request_id: event["request_id"], fingerprint: fp },
      client: client.length ? { events: client } : null, server, data_quality: server.health.some((h) => Object.keys(h.dropped ?? {}).length) ? "partial" : "complete"
    }, false);
    if (result.ok) this.onBundle?.({ id, fingerprint: fp, manual: false, source: "server", createdAt: this.now().toISOString() });
  }

  /* ------------------------------ 前端事件 ------------------------------ */

  /** 接收一批前端事件。返回已处理的 event_id（含重复、不合格、容量丢弃的——前端都应删掉，不再重发）。 */
  ingestClient(body: unknown, ingress = 'unknown'): { status: 200 | 400 | 429; accepted: string[]; rejected: number; written: number } {
    const events = (body as { events?: unknown })?.events;
    if (!Array.isArray(events) || events.length === 0 || events.length > 50) return { status: 400, accepted: [], rejected: 0, written: 0 };
    const accepted: string[] = [], lines: Array<{ line: string; success: boolean }> = [];
    let rejected = 0;
    const session = typeof (events[0] as { telemetry_session_id?: unknown })?.telemetry_session_id === "string" ? String((events[0] as { telemetry_session_id: string }).telemetry_session_id).slice(0, 64) : "-";
    const minute = Math.floor(this.now().getTime() / 60_000);
    const rate = this.sessionRate.get(session);
    const count = rate && rate.minute === minute ? rate.count : 0;
    if (count + events.length > 600) { this.store.drop("rate-limited", events.length); return { status: 429, accepted: [], rejected: 0, written: 0 }; }
    this.sessionRate.set(session, { minute, count: count + events.length });
    if (this.sessionRate.size > 1000) this.sessionRate.clear();
    const ingestedAt = this.now().toISOString(), identity = this.identity();
    for (const raw of events) {
      const rawId = (raw as { event_id?: unknown })?.event_id;
      const e = normalizeClientEvent(raw);
      if (!e) { rejected++; if (typeof rawId === "string" && rawId.length <= 64) accepted.push(rawId); this.store.drop("invalid"); continue; }
      accepted.push(e.event_id);
      if (this.seenIds.has(e.event_id)) { this.store.drop("duplicate"); continue; }
      this.seenIds.set(e.event_id, 1);
      lines.push({ line: JSON.stringify({ at: ingestedAt, schema: "client-event@1", ...e, ingress_entry: ['primary','backup','local'].includes(ingress) ? ingress : 'unknown', server_release: identity.server_release, slot: identity.slot }), success: isSuccessClass(e) });
    }
    if (this.seenIds.size > 20_000) { const keep = [...this.seenIds.keys()].slice(-10_000); this.seenIds = new Map(keep.map((k) => [k, 1])); }
    const { written } = lines.length ? this.store.append("client", lines) : { written: 0 };
    return { status: 200, accepted, rejected, written };
  }

  /**
   * 前端证据包（自动或手动）。服务端补齐：同 request_id 与出事前 2.5 分钟～后 30 秒的服务端事件、前后 1 小时的 release、健康摘要。
   * 返回 ok 时前端删掉本地副本；手动包放不下时返回 capacity，前端提示用户。
   */
  async ingestBundle(body: unknown, ingress = 'unknown'): Promise<{ status: 200 | 400; ok: boolean; id?: string; reason?: string; duplicate?: boolean }> {
    const b = (body as { bundle?: unknown })?.bundle as Record<string, unknown> | undefined;
    if (!b || typeof b !== "object" || b["schema"] !== "bundle@1") return { status: 400, ok: false, reason: "invalid" };
    const clientId = typeof b["bundle_id"] === "string" && /^[A-Za-z0-9_-]{16,40}$/.test(b["bundle_id"]) ? b["bundle_id"] : null;
    if (!clientId) return { status: 400, ok: false, reason: "invalid" };
    const trigger = (b["trigger"] && typeof b["trigger"] === "object" ? b["trigger"] : {}) as Record<string, unknown>;
    const manual = trigger["kind"] === "manual";
    const id = `${manual ? "m" : "a"}${clientId}`;
    if (this.store.hasBundle(id)) return { status: 200, ok: true, id, duplicate: true };

    const events = (Array.isArray(b["events"]) ? b["events"] : []).slice(-300).map(normalizeClientEvent).filter((e): e is NonNullable<typeof e> => !!e);
    const triggerEvent = events.find((e) => e.event_id === trigger["event_id"]);
    if (!manual && triggerEvent?.environment === "test") return { status: 200, ok: false, reason: "test" };
    if (!manual && triggerEvent && !isBundleTrigger(triggerEvent)) return { status: 200, ok: false, reason: "not-a-trigger" };
    const fp = manual || !triggerEvent ? fingerprint({ component: "manual-report", errorType: "report", route: routeTemplate(b["route_template"]) ?? null }) : eventFingerprint(triggerEvent);
    if (!this.allowFingerprint(fp, manual)) return { status: 200, ok: false, reason: "rate-limited" };

    // 报告刷新前的上一页时，以那一页最后的记录时间为准，而不是现在
    const prevAt = b["page_source"] === "previous" && b["completeness"] && typeof b["completeness"] === "object"
      ? (b["completeness"] as Record<string, unknown>)["last_event_at"] ?? (b["completeness"] as Record<string, unknown>)["persisted_at"] : undefined;
    const at = Date.parse(String(triggerEvent?.occurred_at ?? prevAt ?? b["created_at"] ?? "")) || this.now().getTime();
    const requestIds = new Set<string>(events.map((e) => e.request_id).filter((x): x is string => typeof x === "string"));
    const state = boundedJson(b["state"], 4, 200) as Record<string, unknown> | null;
    for (const r of (Array.isArray(state?.["failed_requests"]) ? state!["failed_requests"] as Array<Record<string, unknown>> : [])) if (typeof r?.["request_id"] === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(r["request_id"])) requestIds.add(r["request_id"]);
    const server = await this.serverPart(at, requestIds);
    const completeness = boundedJson(b["completeness"], 2, 80) as Record<string, unknown> | null;
    const partial = completeness?.["partial"] === true || server.health.some((h) => Object.keys(h.dropped ?? {}).length > 0);
    const bundle = {
      schema: "bundle@1", bundle_id: id, created_at: this.now().toISOString(), source: "client", ingress_entry: ['primary','backup','local'].includes(ingress) ? ingress : 'unknown',
      trigger: { kind: manual ? "manual" : "auto", event_id: triggerEvent?.event_id ?? null, event_name: triggerEvent?.event_name ?? (manual ? "manual_report" : null), error_type: triggerEvent?.error_type ?? null, component_id: triggerEvent?.component_id ?? null, fingerprint: fp, page_source: b["page_source"] === "previous" ? "previous" : "current" },
      note: manual && typeof b["note"] === "string" ? redactText(b["note"], 500) : null,
      client: {
        telemetry_session_id: typeof b["telemetry_session_id"] === "string" ? String(b["telemetry_session_id"]).slice(0, 64) : null,
        page_instance_id: typeof b["page_instance_id"] === "string" ? String(b["page_instance_id"]).slice(0, 64) : null,
        page_release: typeof b["page_release"] === "string" && /^[a-f0-9]{64}$/.test(b["page_release"]) ? b["page_release"] : null,
        route_template: routeTemplate(b["route_template"]), state, events, completeness
      },
      server, data_quality: partial ? "partial" : "complete"
    };
    let result = this.store.writeBundle(id, bundle, manual);
    if (!result.ok && result.reason === "too-large") {
      // 先砍前端事件，再砍服务端事件，保证一定能放下有代表性的部分
      bundle.client.events = events.slice(-80); bundle.server = { ...server, events: server.events.slice(-60) }; bundle.data_quality = "partial";
      result = this.store.writeBundle(id, bundle, manual);
    }
    if (!result.ok) return { status: 200, ok: false, reason: result.reason };
    this.onBundle?.({ id, fingerprint: fp, manual, source: "client", createdAt: bundle.created_at });
    return { status: 200, ok: true, id };
  }

  /** 待办列表上显示的一行诊断状态（V1.4 §7.3）；不是诊断待办返回 undefined。 */
  noteDecoration(noteId: string): { findingId: string; status: string; label: string; bundleIds: string[]; ignoredUntil?: string; source: string; repairSessions?: number; repair?: { disposition: string; agreesWithTriage: boolean | null; importedAt: string }; verification?: Record<string, unknown> } | undefined {
    const f = this.findings.noteIds().get(noteId);
    if (!f) return undefined;
    return { findingId: f.id, status: f.status, label: STATUS_LABEL[f.status], bundleIds: f.bundleIds.slice(-5), source: f.source, ...(f.ignoredUntil ? { ignoredUntil: f.ignoredUntil } : {}),
      ...(f.repairSessions?.length ? { repairSessions: f.repairSessions.length } : {}),
      ...(f.repair ? { repair: { disposition: f.repair.disposition, agreesWithTriage: f.repair.agreesWithTriage, importedAt: f.repair.importedAt } } : {}),
      ...(f.verification?.progress && ["observing", "verified", "insufficient", "recurred"].includes(f.status) ? { verification: { ...f.verification.progress, detail: f.verification.detail } } : {}) };
  }
  /** 显式忽略（只有这个操作会触发抑制）；undo 取消忽略，回到分诊结论 */
  ignore(findingId: string, days: number, undo = false): { ok: boolean; status?: string } {
    return this.findings.withLock((store) => {
      const f = store.byId(findingId);
      if (!f) return { ok: false };
      if (undo) { delete f.ignoredUntil; store.setStatus(f, f.triage?.verdict === "fix" ? "fix_proposed" : f.triage?.verdict === "no_fix" ? "no_fix" : f.triage ? "uncertain" : "pending_triage", "取消忽略"); }
      else { f.ignoredUntil = new Date(this.now().getTime() + Math.min(365, Math.max(1, days)) * 86_400_000).toISOString(); store.setStatus(f, "ignored", `用户忽略 ${days} 天`); }
      return { ok: true, status: f.status };
    });
  }

  /** 部署实际生效后记一条 release ↔ commit（同一槽位同一 release 只记一次）。 */
  recordActivation(manifest: ReleaseIdentity | undefined = this.manifest()): boolean {
    const identity = this.identity();
    if (!manifest?.release) return false;
    return this.store.appendRelease({ release: manifest.release, gitCommit: manifest.gitCommit ?? identity.server_commit, dirty: manifest.dirty ?? null, slot: identity.slot, activatedAt: this.now().toISOString() });
  }
}

export function diagnosticsDir(dataDir: string): string { return appData(dataDir, "deploy-ops").path("diagnostics"); }
