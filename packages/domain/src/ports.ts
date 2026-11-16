/**
 * Repository Ports（09 计划 §6 模块 8）+ 内存实现。
 * - 事件追加与 aggregate_version 唯一键在同一临界区（单聚合本地 ACID，ADR-0601）。
 * - 事件去重键：(session_id, aggregate_version) + event_id（AP-STATE-007 §6）。
 * - outbox 租约：Worker 崩溃后未确认消息可被重新租约；消费方按 event_id 幂等去重。
 * 内存实现证明端口契约；后续替换 PostgreSQL 不改领域代码。
 */
import type { EventEnvelope } from "./task-session.js";
import type { StoredEvent } from "./journal.js";
import { sha256Hex } from "./canonical.js";
import { PlatformError } from "./errors.js";

export class EventStore {
  private byStream = new Map<string, StoredEvent[]>();
  private seenStreamVersion = new Set<string>();
  private seenEventId = new Set<string>();
  private globalSeq = 0;
  private outbox = new Map<string, StoredEvent>();
  private outboxAcked = new Set<string>();
  private lease: { workerId: string; expiresAtMs: number; eventIds: string[] } | null = null;

  /**
   * 原子追加：同一 session 的 aggregate_version 唯一；重复 event_id 直接忽略
   * （恢复重放场景）。追加与 outbox 入队在同一个同步临界区，无半提交。
   */
  append(streamId: string, events: EventEnvelope[]): { appended: StoredEvent[]; duplicates: number } {
    const list = this.byStream.get(streamId) ?? [];
    const appended: StoredEvent[] = [];
    let duplicates = 0;
    for (const e of events) {
      const streamKey = `${streamId}:${e.aggregateVersion}`;
      if (this.seenStreamVersion.has(streamKey) || this.seenEventId.has(e.eventId)) {
        duplicates += 1;
        continue;
      }
      this.seenStreamVersion.add(streamKey);
      this.seenEventId.add(e.eventId);
      this.globalSeq += 1;
      const stored: StoredEvent = { ...e, streamId, globalSequence: this.globalSeq };
      list.push(stored);
      appended.push(stored);
      this.outbox.set(stored.eventId, stored);
    }
    if (appended.length > 0) this.byStream.set(streamId, list);
    return { appended, duplicates };
  }

  readStream(streamId: string, fromVersion = 1): StoredEvent[] {
    return (this.byStream.get(streamId) ?? []).filter((e) => e.aggregateVersion >= fromVersion);
  }

  currentVersion(streamId: string): number {
    const list = this.byStream.get(streamId);
    return list && list.length > 0 ? list[list.length - 1].aggregateVersion : 0;
  }

  allEvents(): StoredEvent[] {
    return [...this.byStream.values()].flat().sort((a, b) => a.globalSequence - b.globalSequence);
  }

  /* -------------------------- outbox：租约与幂等投递 -------------------------- */

  leaseOutbox(workerId: string, nowMs: number, ttlMs = 5000): StoredEvent[] {
    // 过期租约回收：崩溃 Worker 的未确认事件可被重新租约。
    if (this.lease && this.lease.workerId !== workerId && this.lease.expiresAtMs > nowMs) {
      return [];
    }
    const ids = [...this.outbox.keys()].filter((id) => !this.outboxAcked.has(id));
    this.lease = { workerId, expiresAtMs: nowMs + ttlMs, eventIds: ids };
    return ids.map((id) => this.outbox.get(id) as StoredEvent);
  }

  ackOutbox(eventIds: string[]): void {
    for (const id of eventIds) this.outboxAcked.add(id);
    if (this.lease) {
      this.lease.eventIds = this.lease.eventIds.filter((id) => !this.outboxAcked.has(id));
    }
  }
}

export interface ArtifactRecord {
  sha256: string;
  content: string;
  size: number;
  mediaType: string;
  path?: string;
  provenance: string;
}

export class ArtifactStore {
  private byHash = new Map<string, ArtifactRecord>();
  /**
   * 新记录的持久化钩子：在 put 返回之前同步调用。
   * 这保证了"先落内容、再落引用它的 ArtifactCreated 事件"——
   * 顺序反过来，恢复后就会出现事件指向一份不存在的制品。
   */
  onPut?: (record: ArtifactRecord) => void;

  /** 内容寻址存储：同内容天然去重；大小用字节长度计算。 */
  put(content: string, meta: { mediaType: string; path?: string; provenance: string }): ArtifactRecord {
    const sha256 = `sha256:${sha256Hex(content)}`;
    const existing = this.byHash.get(sha256);
    if (existing) return existing;
    const record: ArtifactRecord = {
      sha256,
      content,
      size: Buffer.byteLength(content, "utf8"),
      mediaType: meta.mediaType,
      path: meta.path,
      provenance: meta.provenance
    };
    this.onPut?.(record);
    this.byHash.set(sha256, record);
    return record;
  }

  /** 恢复：按内容重算哈希核对，不一致的记录拒收（防止磁盘上的记录被篡改后混进来）。 */
  restore(records: ArtifactRecord[]): void {
    for (const r of records) {
      if (`sha256:${sha256Hex(r.content)}` !== r.sha256) continue;
      this.byHash.set(r.sha256, r);
    }
  }

  get(sha256: string): ArtifactRecord | undefined {
    return this.byHash.get(sha256);
  }

  all(): ArtifactRecord[] {
    return [...this.byHash.values()];
  }
}

export interface EvidenceMeta {
  /** 证据对应的验收条件（verification 证据必填） */
  criterionId?: string;
  /** 证据产生的会话（verification 证据必填） */
  sessionId?: string;
  /** 证据产生时的编译计划（verification 证据必填） */
  planHash?: string;
  /** 证据产生时的交付 revision（verification 证据必填） */
  deliveryRevision?: number;
  /** 人工判定（v2.0 S1）：谁、判了什么、为什么——随证据落盘，审计与页面据此展示 */
  judgement?: HumanJudgementMeta;
  /** 语义验收（v2.0 S3）：验收助手的结论、理由、证据引用与配置 */
  assessment?: SemanticAssessmentMeta;
  /** 程序检查的测量明细（v2.0 S3d）：不通过时整改请求据此写明具体问题 */
  measured?: Record<string, string | number | boolean | null>;
}

export interface SemanticAssessmentMeta {
  verdict: "satisfied" | "partial" | "unsatisfied" | "inconclusive";
  agreementId: string;
  rationale: string;
  unmet: string[];
  evidence: Array<{ kind: string; ref: string; contentHash?: string; locator?: string }>;
  judgeConfigHash: string;
  reportId: string;
  recordedAt: string;
}

export interface HumanJudgementMeta {
  verdict: "PASS" | "FAIL";
  signer: { userId: string; role: string };
  note: string;
  /** 引擎逻辑时钟（与领域事件同一口径） */
  decidedAt: string;
  /** 墙钟时间 */
  recordedAt: string;
}

export interface EvidenceRecord {
  ref: string;
  kind: "tool-result" | "verification" | "policy-decision" | "test-report";
  contentHash: string;
  summary: string;
  linkedDecisionId?: string;
  meta: EvidenceMeta;
}

export class EvidenceStore {
  private items = new Map<string, EvidenceRecord>();
  private counter = new Map<string, number>();
  /** 新记录的持久化钩子：在 put 返回之前同步调用（先落证据，再落引用它的事件）。 */
  onPut?: (record: EvidenceRecord) => void;

  put(kind: EvidenceRecord["kind"], summary: string, content: unknown, linkedDecisionId?: string, meta: EvidenceMeta = {}): EvidenceRecord {
    const n = (this.counter.get(kind) ?? 0) + 1;
    this.counter.set(kind, n);
    const ref = `evidence://runs/self/${kind}/${n}`;
    const record: EvidenceRecord = {
      ref,
      kind,
      contentHash: `sha256:${sha256Hex(JSON.stringify(content ?? null))}`,
      summary,
      linkedDecisionId,
      meta: { ...meta }
    };
    this.onPut?.(record);
    this.items.set(ref, record);
    return record;
  }

  /**
   * 恢复：还原记录，并把每类证据的计数器推进到已用过的最大编号。
   * 计数器不还原的话，恢复后新证据会从 1 重新编号，和崩溃前的引用撞号、互相覆盖。
   */
  restore(records: EvidenceRecord[]): void {
    for (const r of records) {
      this.items.set(r.ref, r);
      const n = Number(r.ref.slice(r.ref.lastIndexOf("/") + 1));
      if (Number.isInteger(n) && n > (this.counter.get(r.kind) ?? 0)) this.counter.set(r.kind, n);
    }
  }

  get(ref: string): EvidenceRecord | undefined {
    return this.items.get(ref);
  }
}

/** 幂等命令入口的并发控制器：100 个竞争命令仅一个成功（AP-STATE-007 §7）。 */
export class CommandDeduplicator {
  private winners = new Map<string, string>();

  /** 返回 true 表示该 commandId 首次出现；false 表示已有并发赢家。 */
  claim(sessionId: string, commandId: string): boolean {
    const key = `${sessionId}:${commandId}`;
    if (this.winners.has(key)) return false;
    this.winners.set(key, commandId);
    return true;
  }
}

export function assertDefined<T>(v: T | undefined | null, msg: string): T {
  if (v === undefined || v === null) throw new PlatformError("GUARD_FAILED", msg);
  return v;
}
