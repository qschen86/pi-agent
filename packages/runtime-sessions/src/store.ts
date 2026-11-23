/**
 * 外部会话的平台持久化（<dataDir>/runtime/）。
 *
 * - bindings.json / operations.json / approvals.json：整体原子写（先写临时文件再改名）
 * - events/<platformSessionId>.jsonl：投影事件追加写；同一 key 后写覆盖前写、保留首次 seq
 * - audit.jsonl：脱敏审计（创建、续聊、中断、审批、授权撤销、强制部署）
 *
 * 只保存受管会话重启查看所需的脱敏消息与事件；已发现的历史会话默认不复制 transcript（§8 历史读取）。
 */
import { userVisiblePrompt } from "./platform-skills.js";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, openSync, closeSync, fsyncSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { withHostMutex } from "./host-mutex.js";
import { RUNTIME_KINDS } from "./types.js";
import { compactUsage, usageFingerprint, usageNeedsCompaction } from "./usage.js";
import type { ApprovalRequest, ComparisonGroup, OperationRecord, ProjectedEvent, RateLimitSnapshot, RuntimeProfile, RuntimeSettings, SessionBinding, UsageRecord } from "./types.js";

export const DEFAULT_SETTINGS: RuntimeSettings = {
  workspaceRoots: [],
  history: { codex: { enabled: false, roots: [] }, "claude-code": { enabled: false, roots: [] }, pi: { enabled: false, roots: [] }, antigravity: { enabled: false, roots: [] } },
  publicControl: false,
  publicHistory: false,
  maxRunningPerProfile: 2
};

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, "utf8")) as T; }
  catch {
    // 坏文件不静默清空：留一份副本再从默认值起步
    try { renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* 忽略 */ }
    return fallback;
  }
}

/** Authority corruption never becomes an empty pool or a new host identity. */
function readAuthority<T>(file: string): Record<string, T> {
 if (!existsSync(file)) return Object.create(null);
 let value: unknown;
 try { value = JSON.parse(readFileSync(file, "utf8")); }
 catch { throw Object.assign(new Error(`原生会话权威记录损坏：${file}`), {code: "RT_STORE_CORRUPT"}); }
 if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error(`原生会话权威记录格式无效：${file}`), {code: "RT_STORE_CORRUPT"});
 return value as Record<string, T>;
}
function writeJson(file: string, value: unknown, compact = false): void {
 const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`, fd = openSync(tmp, "wx", 0o600);
 try {
  try { writeFileSync(fd, compact ? JSON.stringify(value) : JSON.stringify(value, null, 1)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  const parent = openSync(dirname(file), "r"); try { fsyncSync(parent); } finally { closeSync(parent); }
 } finally { rmSync(tmp, {force: true}); }
}
/**
 * 文件身份：inode + 大小 + 修改/变更时间（纳秒）。所有权威文件都经临时文件改名整体写入，任何一次写都会换 inode，
 * 外部进程（另一个槽位、CLI）写入也一样能看出来。读不到返回 null（不缓存）。
 */
function fileStamp(file: string): string | null {
 try { const s = statSync(file, {bigint: true}); return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }
 catch { return null; }
}
/**
 * usage.json 的磁盘形状：不缩进；sourceRef 与 requestId 相同时不重复存（读回时补上）。
 * 旧版本读到缺 sourceRef 的记录也能工作：去重和求和都优先用 requestId。
 */
function usageOnDisk(table: Record<string, UsageRecord[]>): Record<string, unknown[]> {
 const out: Record<string, unknown[]> = {};
 for (const [id, list] of Object.entries(table)) out[id] = list.map((r) => {
  if (r.requestId === undefined || r.sourceRef !== r.requestId) return r;
  const { sourceRef: _same, ...rest } = r; return rest;
 });
 return out;
}
function conflict(): Error { return Object.assign(new Error("会话记录已被其他宿主更新，存在写入冲突，请刷新后再操作"), {code: "RT_CONFLICT"}); }
function latestActivity(current: SessionBinding["lastActivityAt"], pending: SessionBinding["lastActivityAt"]): SessionBinding["lastActivityAt"] {
 const next = Date.parse(pending.at), previous = Date.parse(current.at);
 return Number.isFinite(next) && (!Number.isFinite(previous) || next >= previous) ? pending : current;
}

interface SessionPublication {
 version: 1; transactionId: string; hostId: string;
 binding: {beforeHash: string | null; after: SessionBinding};
 operation: {beforeHash: null; after: OperationRecord};
}
const recordHash = (value: unknown): string => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
export interface EventLog { events: ProjectedEvent[]; byKey: Map<string, number>; nextSeq: number; unsorted?: boolean }

export class RuntimeStore {
  private projectionListeners = new Set<(change: {sessionId:string; type:'before-event'|'event'|'reset';event?:ProjectedEvent}) => void>();
  subscribeProjectionChanges(listener: (change: {sessionId:string;type:'before-event'|'event'|'reset';event?:ProjectedEvent}) => void): () => void {
    this.projectionListeners.add(listener); return () => this.projectionListeners.delete(listener);
  }
  private projectionChanged(change: {sessionId:string;type:'before-event'|'event'|'reset';event?:ProjectedEvent}): void {
    for (const listener of this.projectionListeners) { try { listener(change); } catch { /* Observers cannot break business commits. */ } }
  }
  reloadProjection(id: string): void { this.eventLogs.delete(id); this.projectionChanged({sessionId:id,type:'reset'}); }
  readonly dir: string;
  private bindings: Record<string, SessionBinding> = Object.create(null);
  private operations: Record<string, OperationRecord> = Object.create(null);
  private approvals: Record<string, ApprovalRequest> = Object.create(null);
  private usage: Record<string, UsageRecord[]> = Object.create(null);
  private comparisons: Record<string, ComparisonGroup> = Object.create(null);
  private sources = new WeakMap<object, string>();
  private inCriticalSection = false;
  private activity = new Map<string, SessionBinding["lastActivityAt"]>();
  private eventLogs = new Map<string, EventLog>();
  /** 每个权威文件最后一次完整同步进内存时的文件身份；文件没变就不再重读、解析、逐条比对（usage.json 已有十几 MB）。 */
  private stamps = new Map<string, string>();
  readonly host: { hostId: string; label: string };

  constructor(dataDir: string) {
    this.dir = join(dataDir, "runtime");
    mkdirSync(join(this.dir, "events"), { recursive: true });
    mkdirSync(join(this.dir, "roles"), { recursive: true });
    this.refreshBindings(); this.refreshOperations(); this.refreshApprovals(); this.refreshUsage();
    this.host = this.exclusive(() => {
      const hostFile = join(this.dir, "host.json"), host = readAuthority<unknown>(hostFile);
      if (existsSync(hostFile)) {
        if (typeof host.hostId !== "string" || !host.hostId) throw Object.assign(new Error("原生宿主身份损坏，不能创建替代身份"), {code: "RT_STORE_CORRUPT"});
        return {hostId: host.hostId, label: typeof host.label === "string" ? host.label : hostname()};
      }
      const created = {hostId: `host-${randomUUID().slice(0, 12)}`, label: hostname()}; writeJson(hostFile, created); return created;
    });
  }

  private exclusive<T>(fn: () => T): T {
    const result = withHostMutex(this.dir, () => {
      this.inCriticalSection = true;
      try { this.recoverSessionPublication(); return {value: fn()}; }
      finally { this.inCriticalSection = false; }
    });
    if ("status" in result) throw Object.assign(new Error("原生会话存储正由其他宿主写入，请稍后重试"), {code: "RT_STORE_BUSY"});
    return result.value;
  }
  private table<T>(name: string, id: string): Record<string, T> {
    return this.stableRead(() => {
      const value = readAuthority<T>(join(this.dir, name));
      for (const [key, row] of Object.entries(value)) if (!row || typeof row !== "object" || Array.isArray(row) || (row as Record<string, unknown>)[id] !== key) throw Object.assign(new Error(`原生会话记录身份损坏：${name}`), {code: "RT_STORE_CORRUPT"});
      return value;
    });
  }
  private get publicationFile(): string { return join(this.dir, "session-publication.json"); }
  /** Readers either see a completed publication or wait; they do not consume a half tuple. */
  private stableRead<T>(read: () => T): T {
    if (this.inCriticalSection) return read();
    if (existsSync(this.publicationFile)) return this.exclusive(read);
    const value = read();
    return existsSync(this.publicationFile) ? this.exclusive(read) : value;
  }
  private validatePublication(value: unknown): asserts value is SessionPublication {
    const t = value as SessionPublication;
    const exact = (v: unknown, keys: string[]) => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === keys.sort().join(",");
    const invalid = () => { throw Object.assign(new Error("会话事务意图损坏，保持阻塞等待核对"), {code: "RT_STORE_CORRUPT"}); };
    if (!exact(t,["version","transactionId","hostId","binding","operation"]) || t.version !== 1 || typeof t.transactionId !== "string" || !/^[a-f0-9-]{36}$/.test(t.transactionId) || !exact(t.binding,["beforeHash","after"]) || !exact(t.operation,["beforeHash","after"]) || t.operation.beforeHash !== null) invalid();
    const b=t.binding.after,o=t.operation.after,host=readAuthority<unknown>(join(this.dir,"host.json"));
    const idleRoom = o?.kind === "create" && !!b?.roomRef && b.status === "idle" && Array.isArray(b.turns) && b.turns.length === 0 && o.state === "confirmed" && o.turnNo === undefined;
    // 普通单聊在部署排空时先建会话、首条消息进排队；没有 turn 的 confirmed create 也是合法事务。
    const deferredCreate = o?.kind === "create" && !!b && b.status === "idle" && Array.isArray(b.turns) && b.turns.length === 0 && o.state === "confirmed" && o.turnNo === undefined;
    if (!b || !o || t.hostId !== host.hostId || b.hostId !== t.hostId || typeof b.platformSessionId !== "string" || !b.platformSessionId || typeof o.operationId !== "string" || !o.operationId || typeof o.idempotencyKey !== "string" || !RUNTIME_KINDS.includes(b.runtimeKind) || b.sourceMode !== "platform-managed" || b.executionMode !== "runtime-native" || o.platformSessionId !== b.platformSessionId || (o.state !== "prepared" && !idleRoom && !deferredCreate) || !["create","turn"].includes(o.kind) || !/^[A-Za-z0-9_-]{8,80}$/.test(o.idempotencyKey) || !Number.isSafeInteger(b.bindingRevision) || b.bindingRevision < 1 || !Array.isArray(b.turns) || b.turns.some(turn=>!turn||!Number.isSafeInteger(turn.turnNo)||turn.turnNo<1||typeof turn.operationId!=="string"||!turn.operationId||typeof turn.clientMessageId!=="string"||!turn.clientMessageId||!["queued","running","waiting-input","completed","failed","cancelled","interrupted","unknown"].includes(turn.status)) || new Set(b.turns.map(turn=>turn.turnNo)).size !== b.turns.length || new Set(b.turns.map(turn=>turn.clientMessageId)).size !== b.turns.length || !Array.isArray(o.steps) || o.steps.some(step=>!step||typeof step.at!=="string"||typeof step.step!=="string"||typeof step.detail!=="string")) invalid();
    if (idleRoom || deferredCreate) {
      if (t.binding.beforeHash !== null || b.creationOperationId !== o.operationId || b.nativeSessionId !== undefined) invalid();
      if (idleRoom && (!b.roomRef?.roomId || !b.roomRef?.memberId)) invalid();
      return;
    }
    const firstRoomTurn = o.kind === "turn" && !!b.roomRef && b.nativeSessionId === undefined && b.turns.slice(0, -1).every(turn => turn.status === "failed" || turn.status === "cancelled");
    // 部署排空中先建出来的普通会话没有原生 ID；排队消息就是它的第一轮。
    const firstDeferredTurn = o.kind === "turn" && !b.roomRef && b.nativeSessionId === undefined && b.turns.length === 1 && b.turns[0]!.operationId === o.operationId && b.turns[0]!.turnNo === o.turnNo && b.turns[0]!.status === "queued";
    const firstTurn = firstRoomTurn || firstDeferredTurn;
    const last=b.turns.at(-1);
    if (!last || last.operationId !== o.operationId || last.turnNo !== o.turnNo || last.status !== "queued" || !last.clientMessageId || !/^[a-f0-9-]{36}$/.test(last.clientMessageId)) invalid();
    if (o.kind === "create" ? t.binding.beforeHash !== null || b.creationOperationId !== o.operationId || o.turnNo !== 1 || b.turns.length !== 1 || b.status !== "creating" || b.nativeSessionId !== undefined : typeof t.binding.beforeHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(t.binding.beforeHash) || (!firstTurn && (typeof b.nativeSessionId !== "string" || !b.nativeSessionId)) || b.status !== "running" || !Number.isSafeInteger(o.turnNo) || o.turnNo! < (firstTurn ? 1 : 2)) invalid();
  }
  /** Called only under the host mutex. Validate both sources before writing either file. */
  private recoverSessionPublication(): void {
    if (!existsSync(this.publicationFile)) return;
    let publication: unknown;
    try { publication=JSON.parse(readFileSync(this.publicationFile,"utf8")); }
    catch { throw Object.assign(new Error("会话事务意图无法读取，保持阻塞"), {code:"RT_STORE_CORRUPT"}); }
    this.validatePublication(publication);
    const t=publication,b=this.table<SessionBinding>("bindings.json","platformSessionId"),o=this.table<OperationRecord>("operations.json","operationId");
    const matches = (current: unknown, patch: {beforeHash: string|null; after: unknown}) => current === undefined ? patch.beforeHash === null : recordHash(current) === patch.beforeHash || recordHash(current) === recordHash(patch.after);
    if (!matches(b[t.binding.after.platformSessionId],t.binding) || !matches(o[t.operation.after.operationId],t.operation) || Object.values(o).some(other=>other.operationId!==t.operation.after.operationId&&other.idempotencyKey===t.operation.after.idempotencyKey)) throw Object.assign(new Error("会话事务来源冲突，不能覆盖新记录或重建身份"),{code:"RT_STORE_CORRUPT"});
    if (recordHash(b[t.binding.after.platformSessionId] ?? null) !== recordHash(t.binding.after)) { b[t.binding.after.platformSessionId]=t.binding.after; writeJson(join(this.dir,"bindings.json"),b); }
    if (recordHash(o[t.operation.after.operationId] ?? null) !== recordHash(t.operation.after)) { o[t.operation.after.operationId]=t.operation.after; writeJson(join(this.dir,"operations.json"),o); }
    rmSync(this.publicationFile);
    const parent=openSync(this.dir,"r");try{fsyncSync(parent);}finally{closeSync(parent);}
    this.sync(this.bindings,b);this.sync(this.operations,o);
  }
  private publishSession(binding: SessionBinding, operation: OperationRecord, before: SessionBinding | undefined): void {
    const t:SessionPublication={version:1,transactionId:randomUUID(),hostId:this.host.hostId,binding:{beforeHash:before===undefined?null:recordHash(before),after:binding},operation:{beforeHash:null,after:operation}};
    this.validatePublication(t);
    writeJson(this.publicationFile,t); // Complete durable intent precedes either projection.
    this.recoverSessionPublication();
  }
  createSessionOperation(binding: SessionBinding, operation: OperationRecord): {session:SessionBinding;operation:OperationRecord;replayed:boolean} {
    const incoming=structuredClone(binding),op=structuredClone(operation);
    return this.exclusive(()=>{
      const b=this.refreshBindings(),o=this.refreshOperations(),existing=Object.values(o).find(record=>record.idempotencyKey===op.idempotencyKey);
      if(existing){if(existing.kind!=="create"||!b[existing.platformSessionId])throw conflict();return{session:this.bindings[existing.platformSessionId]!,operation:this.operations[existing.operationId]!,replayed:true};}
      if(b[incoming.platformSessionId]||o[op.operationId]||op.kind!=="create")throw conflict();
      this.publishSession(incoming,op,undefined);
      return{session:this.bindings[incoming.platformSessionId]!,operation:this.operations[op.operationId]!,replayed:false};
    });
  }
  appendSessionOperation(id:string,expectedRevision:number,update:(binding:SessionBinding)=>void,operation:OperationRecord): {session:SessionBinding;operation:OperationRecord;replayed:boolean} {
    const op=structuredClone(operation);
    return this.exclusive(()=>{
      const b=this.refreshBindings(),o=this.refreshOperations(),existing=Object.values(o).find(record=>record.idempotencyKey===op.idempotencyKey);
      if(existing){if(existing.kind!=="turn"||existing.platformSessionId!==id||!b[id])throw conflict();return{session:this.bindings[id]!,operation:this.operations[existing.operationId]!,replayed:true};}
      const before=b[id];if(!before)throw Object.assign(new Error(`会话不存在：${id}`),{code:"RT_NOT_FOUND"});
      if(before.bindingRevision!==expectedRevision||o[op.operationId]||op.kind!=="turn"||op.platformSessionId!==id||before.turns.some(turn=>["queued","running","waiting-input"].includes(turn.status)))throw conflict();
      const next=structuredClone(before);update(next);next.bindingRevision=before.bindingRevision+1;
      const identity=["platformSessionId","runtimeKind","runtimeProfileId","browserProfileId","hostId","identityScopeId","nativeSessionId","sourceMode","executionMode","workspace","role","evaluation","evaluationPolicyHash","projectRef","admissionClass","permissionMode","permissionLabel","piPermissionPolicyVersion","requestedModel","creationOperationId"] as const;
      if(identity.some(key=>JSON.stringify(next[key])!==JSON.stringify(before[key]))||next.turns.length!==before.turns.length+1||JSON.stringify(next.turns.slice(0,-1))!==JSON.stringify(before.turns))throw conflict();
      this.publishSession(next,op,before);this.activity.delete(id);
      return{session:this.bindings[id]!,operation:this.operations[op.operationId]!,replayed:false};
    });
  }
  /** Retain live manager references, while every read observes persisted authority. */
  private sync<T extends object>(cache: Record<string, T>, current: Record<string, T>, track = true): void {
    for (const id of Object.keys(cache)) if (!Object.hasOwn(current, id)) delete cache[id];
    for (const [id, value] of Object.entries(current)) {
      const previous = cache[id];
      if (previous && !Array.isArray(previous)) {
        for (const key of Object.keys(previous)) if (!Object.hasOwn(value, key)) delete (previous as Record<string, unknown>)[key];
        Object.assign(previous, value);
      } else cache[id] = value;
      // 原始序列化只给 putRecord 做冲突检测；用量不走 putRecord，不必把十几 MB 再序列化一遍
      if (track) this.sources.set(cache[id]!, JSON.stringify(value));
    }
  }
  /**
   * 读权威文件并同步进内存缓存。临界区外（只读路径）若文件身份和上次完整同步时相同，直接用内存缓存：
   * 会话画面每次都要读绑定、审批、用量，整份重读 + 解析 + 逐条序列化比对曾让事件循环每次停顿数百毫秒。
   * 返回值在命中时就是内存缓存本身，只读路径不得修改；临界区内（写路径）总是重读磁盘，返回可修改的新对象。
   */
  private refreshed<T extends object>(name: string, cache: Record<string, T>, read: () => Record<string, T>, opts: {track?: boolean; reuseInCriticalSection?: boolean} = {}): Record<string, T> {
    const file = join(this.dir, name), track = opts.track ?? true;
    const before = (this.inCriticalSection && !opts.reuseInCriticalSection) || existsSync(this.publicationFile) ? null : fileStamp(file);
    if (before !== null && this.stamps.get(name) === before) return cache;
    this.stamps.delete(name);
    const current = read(); this.sync(cache, current, track);
    // 读的过程中文件被换掉：这次结果不算稳定，下次照常重读
    if (before !== null && fileStamp(file) === before) this.stamps.set(name, before);
    return current;
  }
  /** 写路径：整体写入并同步缓存，记下写后的文件身份，后续只读路径不必再把自己刚写的文件读一遍。 */
  private persist<T extends object>(name: string, current: Record<string, T>, cache: Record<string, T>, track = true): void {
    this.stamps.delete(name);
    const file = join(this.dir, name);
    if (name === "usage.json") writeJson(file, usageOnDisk(current as unknown as Record<string, UsageRecord[]>), true);
    else writeJson(file, current);
    this.sync(cache, current, track);
    const after = fileStamp(file); if (after !== null) this.stamps.set(name, after);
  }
  private refreshBindings(): Record<string, SessionBinding> {
    const current = this.refreshed("bindings.json", this.bindings, () => this.table<SessionBinding>("bindings.json", "platformSessionId"));
    for (const [id, pending] of this.activity) if (this.bindings[id]) this.bindings[id]!.lastActivityAt = latestActivity(this.bindings[id]!.lastActivityAt, pending);
    return current;
  }
  private refreshOperations(): Record<string, OperationRecord> { return this.refreshed("operations.json", this.operations, () => this.table<OperationRecord>("operations.json", "operationId")); }
  private refreshComparisons(): Record<string, ComparisonGroup> { return this.refreshed("comparisons.json", this.comparisons, () => this.table<ComparisonGroup>("comparisons.json", "groupId")); }
  private refreshApprovals(): Record<string, ApprovalRequest> { return this.refreshed("approvals.json", this.approvals, () => this.table<ApprovalRequest>("approvals.json", "approvalId")); }
  /**
   * 用量表：writable 时（addUsage 在主机互斥锁内）文件没变也直接复用内存里的表，省掉十几 MB 的重读与解析。
   * 用量数组只由本类整体替换或追加；写盘失败时 persist 已清掉文件身份，下次读取会用磁盘内容整体替换回来。
   */
  private refreshUsage(writable = false): Record<string, UsageRecord[]> {
    return this.refreshed("usage.json", this.usage, () => {
      const current = readAuthority<UsageRecord[]>(join(this.dir, "usage.json"));
      if (Object.values(current).some(list => !Array.isArray(list))) throw Object.assign(new Error("原生用量记录损坏"), {code: "RT_STORE_CORRUPT"});
      for (const list of Object.values(current)) for (const r of list) if (r && r.sourceRef === undefined && typeof r.requestId === "string") r.sourceRef = r.requestId;
      return current;
    }, {track: false, reuseInCriticalSection: writable});
  }
  private putRecord<T extends object>(name: string, idField: string, record: T, cache: Record<string, T>, prepare?: (incoming: T, current: Record<string, T>) => void): void {
    const incoming = structuredClone(record), id = (incoming as Record<string, unknown>)[idField];
    if (typeof id !== "string" || !id) throw new Error("Missing native record identity");
    const expected = this.sources.get(record);
    try {
      this.exclusive(() => {
        const current = this.table<T>(name, idField), previous = current[id], source = previous === undefined ? undefined : JSON.stringify(previous);
        if (source !== expected && JSON.stringify(incoming) !== source) throw conflict();
        prepare?.(incoming, current);
        current[id] = incoming; this.persist(name, current, cache);
      });
    } catch (e) {
      // 调用方可能已就地改了缓存里的对象：写入失败后下一次读取必须回到磁盘上的权威内容
      this.stamps.delete(name); throw e;
    }
  }

  /* ---------------- V3.0 角色正文（续聊与重启恢复时重新注入） ---------------- */

  role(id: string): string | undefined {
    const f = join(this.dir, "roles", `${id}.txt`);
    return existsSync(f) ? readFileSync(f, "utf8") : undefined;
  }
  putRole(id: string, text: string): void {
    const f = join(this.dir, "roles", `${id}.txt`);
    const tmp = `${f}.tmp-${process.pid}`;
    writeFileSync(tmp, text);
    renameSync(tmp, f);
  }

  /* ---------------- 设置 ---------------- */
  settings(): RuntimeSettings {
    const s = readJson<Partial<RuntimeSettings>>(join(this.dir, "settings.json"), {});
    return {
      ...DEFAULT_SETTINGS, ...s,
      history: Object.fromEntries(RUNTIME_KINDS.map((kind) => [kind, { ...DEFAULT_SETTINGS.history[kind], ...s.history?.[kind] }])) as RuntimeSettings["history"]
    };
  }
  saveSettings(s: RuntimeSettings): void { writeJson(join(this.dir, "settings.json"), { ...s, updatedAt: new Date().toISOString() }); }

  /* ---------------- profile ---------------- */
  profiles(): Record<string, RuntimeProfile> { return readJson(join(this.dir, "profiles.json"), {}); }
  saveProfile(p: RuntimeProfile): void {
    const all = this.profiles();
    all[p.profileId] = p;
    writeJson(join(this.dir, "profiles.json"), all);
  }
  /** Opaque identity comes from non-secret fingerprints, never credential bytes. */
  identityPartitions(): Record<string, {fingerprint:string;partitionId:string;createdAt:string}> {
    const all=readAuthority<{fingerprint:string;partitionId:string;createdAt:string}>(join(this.dir,"identity-partitions.json"));
    if(Object.values(all).some(p=>!p||typeof p.fingerprint!=="string"||!/^[a-f0-9]{24}$/.test(p.fingerprint)||typeof p.partitionId!=="string"||!/^id1:p-[a-f0-9-]+$/.test(p.partitionId)||typeof p.createdAt!=="string"||!Number.isFinite(Date.parse(p.createdAt))))throw Object.assign(new Error("账号分区记录损坏，不能重新分配身份或名额"),{code:"RT_STORE_CORRUPT"});
    return all;
  }
  getOrCreateIdentityPartition(key:string,fingerprint:string): {fingerprint:string;partitionId:string;createdAt:string} {
    if(!key||!/^[a-f0-9]{24}$/.test(fingerprint))throw new Error("Invalid identity partition source");
    return this.exclusive(()=>{
      const all=this.identityPartitions(),previous=all[key];
      if(previous?.fingerprint===fingerprint)return previous;
      const next={fingerprint,partitionId:`id1:p-${randomUUID().slice(0,18)}`,createdAt:new Date().toISOString()};
      all[key]=next;writeJson(join(this.dir,"identity-partitions.json"),all);return next;
    });
  }
  rateLimits(): Record<string, RateLimitSnapshot> { return readJson(join(this.dir, "rate-limits.json"), {}); }
  saveRateLimit(s: RateLimitSnapshot): void {
    const all = this.rateLimits();
    all[s.identityScopeId] = s;
    writeJson(join(this.dir, "rate-limits.json"), all);
  }

  /* ---------------- 绑定 ---------------- */
  allBindings(): SessionBinding[] { this.refreshBindings(); return Object.values(this.bindings); }
  /**
   * 绑定表的廉价变更指纹：bindings.json 的 inode / 大小 / 纳秒修改时间，加上尚未落盘的活动时间补丁。
   * 指纹不变，allBindings() 的结果就不会变，读者可以复用自己的派生结果，不必每次重读并解析整张表。
   * 会话事务发布中（半写状态）返回空串，表示「现在不要缓存」。读到的指纹要先于读数据取得：
   * 数据在中途变了，旧指纹下次就对不上，只会多算一次，不会用到过期结果。
   */
  bindingsStamp(): string {
    if (existsSync(this.publicationFile)) return "";
    let file: string;
    try { const st = statSync(join(this.dir, "bindings.json"), { bigint: true }); file = `${st.ino}:${st.size}:${st.mtimeNs}`; }
    catch { return ""; }
    const pending = [...this.activity].map(([id, at]) => `${id}=${JSON.stringify(at)}`).sort().join(",");
    return `${file}|${pending}`;
  }
  migratePiNativePermissions(): string[] {
    return this.exclusive(() => {
      const current = this.table<SessionBinding>("bindings.json", "platformSessionId");
      const ops = this.table<OperationRecord>("operations.json", "operationId");
      const pending = new Set(Object.values(ops).filter(o => !["confirmed", "failed"].includes(o.state)).map(o => o.platformSessionId));
      const migrated: string[] = [];
      for (const b of Object.values(current)) {
        if (b.runtimeKind !== "pi" || b.sourceMode !== "platform-managed" || b.piPermissionPolicyVersion || b.evaluation || b.evaluationPolicyHash || b.projectRef || b.role || b.comparisonRef || b.roomRef ||
          /[\\/]\.evaluation-qualification[\\/]/.test(b.workspace) || !["idle", "failed", "completed", "interrupted"].includes(b.status) || pending.has(b.platformSessionId) || b.turns.some(t => ["queued", "running", "waiting-input"].includes(t.status)) ||
          (b.permissionMode !== undefined && b.permissionMode !== "pi-ask")) continue;
        b.permissionMode = "pi-native"; b.permissionLabel = "原生工具权限"; b.piPermissionPolicyVersion = 1; b.bindingRevision++;
        migrated.push(b.platformSessionId);
      }
      if (migrated.length) writeJson(join(this.dir, "bindings.json"), current);
      this.sync(this.bindings, current);
      return migrated;
    });
  }
  binding(id: string): SessionBinding | undefined { this.refreshBindings(); return this.bindings[id]; }
  findByNative(runtimeKind: string, hostId: string, nativeSessionId: string): SessionBinding | undefined {
    return this.allBindings().find(b => b.runtimeKind === runtimeKind && b.hostId === hostId && b.nativeSessionId === nativeSessionId);
  }
  putBinding(b: SessionBinding): void { this.putRecord("bindings.json", "platformSessionId", b, this.bindings); }
  /** Persist only bookkeeping patches, never a stale copy of confirmed authority. */
  flushBindings(): void {
    if (!this.activity.size) return;
    this.exclusive(() => {
      const current = this.table<SessionBinding>("bindings.json", "platformSessionId"); let changed = false;
      for (const [id, pending] of this.activity) if (current[id]) {
        const latest = latestActivity(current[id]!.lastActivityAt, pending);
        if (latest !== current[id]!.lastActivityAt) { current[id]!.lastActivityAt = latest; changed = true; }
      }
      if (changed) writeJson(join(this.dir, "bindings.json"), current);
      this.activity.clear(); this.sync(this.bindings, current);
    });
  }
  /** Revisions guard human writes; unpersisted changes are limited to activity time. */
  updateBinding(id: string, fn: (b: SessionBinding) => void, expectedRevision?: number, opts: {bump?: boolean; persist?: boolean; guard?: (b: SessionBinding) => boolean} = {}): SessionBinding {
    const update = () => {
      const current = this.refreshBindings(), b = this.bindings[id];
      if (!b) throw Object.assign(new Error(`会话不存在：${id}`), {code: "RT_NOT_FOUND"});
      // Check asynchronous metadata ownership against the latest record under the host mutex.
      if (opts.guard && !opts.guard(b)) return b;
      if (expectedRevision !== undefined && b.bindingRevision !== expectedRevision) throw conflict();
      const next = structuredClone(b); fn(next);
      if (next.platformSessionId !== id) throw conflict();
      if (opts.persist === false) {
        if (opts.bump !== false || JSON.stringify({...next, lastActivityAt: b.lastActivityAt}) !== JSON.stringify(b)) throw new Error("延迟刷新仅允许更新活动时间");
        this.activity.set(id, next.lastActivityAt); b.lastActivityAt = latestActivity(b.lastActivityAt, next.lastActivityAt); return b;
      }
      if (opts.bump !== false) next.bindingRevision++;
      current[id] = next; this.persist("bindings.json", current, this.bindings); this.activity.delete(id); return this.bindings[id]!;
    };
    return opts.persist === false ? update() : this.exclusive(update);
  }
  deleteBinding(id: string): void {
    this.exclusive(() => {
      const current = this.table<SessionBinding>("bindings.json", "platformSessionId");
      if (current[id]?.roomRef) {
        rmSync(join(this.dir, "roles", `${id}.txt`), {force: true});
        const operations = this.refreshOperations();
        for (const [key, op] of Object.entries(operations)) if (op.platformSessionId === id) delete operations[key];
        this.persist("operations.json", operations, this.operations);
        const approvals = this.refreshApprovals();
        for (const [key, approval] of Object.entries(approvals)) if (approval.platformSessionId === id) delete approvals[key];
        this.persist("approvals.json", approvals, this.approvals);
      }
      delete current[id]; this.persist("bindings.json", current, this.bindings); this.activity.delete(id);
      const usage = this.refreshUsage(); delete usage[id]; this.persist("usage.json", usage, this.usage, false);
      rmSync(join(this.dir, "events", `${id}.jsonl`), {force: true}); this.eventLogs.delete(id);
    });
  }

  /* ---------------- 操作记录（幂等） ---------------- */
  operation(id: string): OperationRecord | undefined { this.refreshOperations(); return this.operations[id]; }
  operationByKey(key: string): OperationRecord | undefined { return this.allOperations().find(o => o.idempotencyKey === key); }
  allOperations(): OperationRecord[] { this.refreshOperations(); return Object.values(this.operations); }
  putOperation(o: OperationRecord): void {
    this.putRecord("operations.json", "operationId", o, this.operations, (incoming, current) => {
      if (Object.values(current).some(other => other.operationId !== incoming.operationId && other.idempotencyKey === incoming.idempotencyKey)) throw Object.assign(new Error("幂等操作身份冲突"), {code: "RT_CONFLICT"});
      incoming.updatedAt = new Date().toISOString();
    });
  }
  stepOperation(id: string, step: string, detail: string, state?: OperationRecord["state"], reason?: string): OperationRecord {
    return this.exclusive(() => {
      const current = this.refreshOperations(), o = current[id]; if (!o) throw new Error(`操作不存在：${id}`);
      o.steps.push({at: new Date().toISOString(), step, detail}); if (state) o.state = state; if (reason !== undefined) o.stateReason = reason;
      o.updatedAt = new Date().toISOString(); this.persist("operations.json", current, this.operations); return this.operations[id]!;
    });
  }

  /* ---------------- 对比组 ---------------- */
  comparison(id: string): ComparisonGroup | undefined { this.refreshComparisons(); return this.comparisons[id]; }
  comparisonByKey(key: string): ComparisonGroup | undefined { this.refreshComparisons(); return Object.values(this.comparisons).find((g) => g.idempotencyKey === key); }
  allComparisons(): ComparisonGroup[] { this.refreshComparisons(); return Object.values(this.comparisons); }
  /** 新建对比组（同一 ID 只能建一次） */
  putComparison(g: ComparisonGroup): void { this.putRecord("comparisons.json", "groupId", g, this.comparisons); }
  deleteComparison(id: string): void {
    this.exclusive(() => { const current = this.refreshComparisons(); delete current[id]; this.persist("comparisons.json", current, this.comparisons); });
  }
  /** 在宿主临界区内读最新记录、修改并写回 */
  updateComparison(id: string, fn: (g: ComparisonGroup) => void): ComparisonGroup {
    return this.exclusive(() => {
      const current = this.refreshComparisons(), g = current[id];
      if (!g) throw Object.assign(new Error(`对比组不存在：${id}`), {code: "RT_NOT_FOUND"});
      const next = structuredClone(g); fn(next);
      if (next.groupId !== id) throw conflict();
      current[id] = next; this.persist("comparisons.json", current, this.comparisons); return this.comparisons[id]!;
    });
  }

  /* ---------------- 审批 ---------------- */
  approval(id: string): ApprovalRequest | undefined { this.refreshApprovals(); return this.approvals[id]; }
  allApprovals(): ApprovalRequest[] { this.refreshApprovals(); return Object.values(this.approvals); }
  putApproval(a: ApprovalRequest): void { this.putRecord("approvals.json", "approvalId", a, this.approvals); }

  /* ---------------- 用量 ---------------- */
  usageFor(id: string): UsageRecord[] { this.refreshUsage(); return this.usage[id] ?? []; }
  /** 一次刷新拿全部会话用量：跨会话汇总不要逐会话调用 usageFor（每次都会重读 usage.json）。 */
  allUsage(): Record<string, UsageRecord[]> { return this.refreshUsage(); }
  /**
   * Exact request/source deduplication happens in the same host critical section.
   * 已压缩进合计行的请求（回补会把原生历史里的用量整份再报一遍）直接丢弃；和已存的一模一样也不重写文件。
   */
  addUsage(id: string, r: UsageRecord): void {
    this.exclusive(() => {
      const current = this.refreshUsage(true), list = current[id] ?? [];
      if (list.some((x) => x.aggregate) && this.foldedUsage(list).has(usageFingerprint(r))) return;
      const sameKey = (x: UsageRecord) => x.usageScope === r.usageScope && x.counterMode === r.counterMode && (r.requestId ? x.requestId === r.requestId : x.sourceRef === r.sourceRef && x.subagent === r.subagent);
      const i = list.findIndex(sameKey);
      if (i >= 0) { if (JSON.stringify(list[i]) === JSON.stringify(r)) return; list[i] = r; } else list.push(r);
      current[id] = list;
      this.persist("usage.json", current, this.usage, false);
    });
  }
  private foldedCache = new WeakMap<UsageRecord[], Set<string>>();
  /** 一个会话所有合计行里记下的指纹；按数组缓存（合计行只在压缩时整体替换数组）。 */
  private foldedUsage(list: UsageRecord[]): Set<string> {
    let set = this.foldedCache.get(list);
    if (!set) { set = new Set(list.flatMap((x) => x.aggregate?.folded ?? [])); this.foldedCache.set(list, set); }
    return set;
  }
  /**
   * 把已归档会话的逐次用量压缩成「每小时 × 模型」的合计行（见 usage.ts compactUsage）。
   * 不传 ids 时处理所有已归档会话；第一次真正改动前把原文件备份为 usage.json.before-compact。返回压缩的会话数。
   */
  compactArchivedUsage(ids?: string[]): number {
    return this.exclusive(() => {
      this.refreshBindings();
      const current = this.refreshUsage(true);
      const targets = (ids ?? Object.keys(current)).filter((id) => this.bindings[id]?.archived && current[id] && usageNeedsCompaction(current[id]!));
      if (!targets.length) return 0;
      const file = join(this.dir, "usage.json"), backup = join(this.dir, "usage.json.before-compact");
      if (existsSync(file) && !existsSync(backup)) copyFileSync(file, backup);
      for (const id of targets) current[id] = compactUsage(current[id]!);
      this.persist("usage.json", current, this.usage, false);
      return targets.length;
    });
  }

  /* ---------------- 事件 ---------------- */
  private log(id: string): EventLog {
    let log = this.eventLogs.get(id);
    if (log) return log;
    log = { events: [], byKey: new Map(), nextSeq: 1 };
    const file = join(this.dir, "events", `${id}.jsonl`);
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let e: ProjectedEvent;
        try { e = JSON.parse(line) as ProjectedEvent; } catch { continue; } // 半行（写到一半崩溃）跳过
        if (e.role === "user" && e.text) e = { ...e, text: userVisiblePrompt(e.text) };   // 早先落盘的事件里带着平台补的技能文字
        const i = log.byKey.get(e.key);
        if (i === undefined) { log.byKey.set(e.key, log.events.length); log.events.push(e); }
        else log.events[i] = { ...e, ...platformSourceOf(log.events[i]!, e), seq: log.events[i]!.seq };   // 同 key 重复记录保留 platform（见 platformSourceOf）
        log.nextSeq = Math.max(log.nextSeq, Math.floor(e.seq) + 1);
      }
    }
    log.unsorted = true;
    this.eventLogs.set(id, log);
    return log;
  }

  /** 按 seq 排好的事件（回补可能插入小数序号） */
  events(id: string): ProjectedEvent[] {
    const log = this.log(id);
    if (log.unsorted) {
      log.events.sort((a, b) => a.seq - b.seq);
      log.byKey = new Map(log.events.map((e, i) => [e.key, i]));
      log.unsorted = false;
    }
    return log.events;
  }

  /**
   * 写入/合并一条事件：按 key 去重；返回 null 表示内容没变（不必推送）。
   * 已完成的事件不会被迟到的流式片段覆盖。
   */
  upsertEvent(id: string, e: Omit<ProjectedEvent, "seq">, seqHint?: number): ProjectedEvent | null {
    // 用户消息只记用户自己写的部分：runtime 原生历史里的提示词前面会带平台补的技能目录 / 说明，不该出现在对话里
    if (e.role === "user" && e.text) e = { ...e, text: userVisiblePrompt(e.text) };
    this.projectionChanged({sessionId:id,type:'before-event'});
    const log = this.log(id);
    const i = log.byKey.get(e.key);
    let out: ProjectedEvent;
    if (i === undefined) {
      // seqHint：回补的事件按原生顺序插在已知事件之间（小数序号）；页面按 seq 排序
      out = { ...e, seq: seqHint ?? log.nextSeq++ };
      log.byKey.set(e.key, log.events.length);
      log.events.push(out);
      if (seqHint !== undefined) log.unsorted = true;
    } else {
      const prev = log.events[i]!;
      // 已完成的内容不被迟到的流式片段覆盖
      if (e.partial && !prev.partial) return null;
      out = mergeEvent(prev, e);
      if (JSON.stringify(out) === JSON.stringify(prev)) return null;
      log.events[i] = out;
    }
    // 流式片段只在内存里：每个 token 都落盘会让文件按平方增长；完成记录到达才写入
    try { if (!out.partial) appendFileSync(join(this.dir, "events", `${id}.jsonl`), `${JSON.stringify(out)}\n`); }
    catch (error) { this.projectionChanged({sessionId:id,type:"reset"}); throw error; }
    this.projectionChanged({sessionId:id,type:'event',event:out});
    return out;
  }

  audit(entry: Record<string, unknown>): void {
    appendFileSync(join(this.dir, "audit.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  }
}

/** 加载已落盘事件时的同 key 去重：平台回显的 source=platform 不被原生回读覆盖（与 mergeEvent 同一规则，但落盘顺序相反时也成立）。 */
const platformSourceOf = (prev: ProjectedEvent, next: ProjectedEvent): { source?: ProjectedEvent["source"] } =>
  prev.source === "platform" && next.source !== "platform" ? { source: "platform" } : {};

/** 同一 key 的后续记录合并进来：工具结果只补输出与状态，不抹掉名称与参数；空值不覆盖已有值 */
export function mergeEvent(prev: ProjectedEvent, next: Omit<ProjectedEvent, "seq">): ProjectedEvent {
  const out: ProjectedEvent = { ...prev, seq: prev.seq };
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined || v === "") continue;
    if (k === "text" && prev.attachments?.length && next.source !== "platform") continue;
    // 同一条用户消息：平台回显（source=platform）与原生投影回读（stream / history）共用 key。
    // 谁发的只有平台账本知道，回读不能把它改写成 stream；下游（公共记忆即时通道）按 platform 取本轮用户原话。
    if (k === "source" && prev.source === "platform" && v !== "platform") continue;
    if (k === "tool" && prev.tool && v && typeof v === "object") {
      const t = { ...prev.tool };
      for (const [tk, tv] of Object.entries(v as Record<string, unknown>)) if (tv !== undefined && tv !== "") (t as Record<string, unknown>)[tk] = tv;
      out.tool = t;
    } else (out as unknown as Record<string, unknown>)[k] = v;
  }
  // 完整记录到达：去掉片段标记
  if (next.partial === false) out.partial = false;
  return out;
}
