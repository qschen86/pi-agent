import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { addWorktree, applyPatch, bounded, COMPARE_DIR, COMPARE_WORKTREE_PERMISSION_MODES, gitWorkspaceInfo, insideRepo, laneDiff, readOnlyPermissionMode, removeWorktree, RuntimeError, RUNTIME_KINDS, underRoots } from "@pi-agent/runtime-sessions";
import type { LaneDiff } from "@pi-agent/runtime-sessions";
import type { CreateInput, RuntimeSessionManager } from "@pi-agent/runtime-sessions";
import type { Room, RoomCreateInput, RoomDelivery, RoomMember, RoomMemberInput, RoomMessage, RoomPostInput, RoomRound, RoomSettings } from "./room-types.js";
import { renderRoomDelivery, roomHash, roomInstructions } from "./room-prompts.js";
import { checkSnapshotPath, deleteRoomSnapshot, ROUND_DONE, writeRoomSnapshot } from "./room-snapshot.js";

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const fail = (message: string, status: 400 | 404 | 409 | 410 = 400, code = "ROOM_INPUT"): never => { throw new RuntimeError(message, status, code); };
const keyOf = (key: string) => { if (!/^[A-Za-z0-9_-]{8,80}$/.test(key ?? "")) fail("缺少有效的 idempotencyKey"); return key; };
const activeTurn = (s: string) => ["queued", "running", "waiting-input"].includes(s);

export class RoomService {
  private displayRevisions = new WeakMap<RoomMessage, {hash:string;revision:number}>();
  private displayVersion = 0;
  private mutationCount = 0;
  private projectionHealthy = true;
  projectionVersion(): number { return this.displayVersion; }
  projectionRevision(message: RoomMessage): number { return this.displayRevisions.get(message)?.revision ?? 0; }
  projectionComplete(): boolean { return this.projectionHealthy && this.mutationCount === 0; }
  projectionContains(roomId: string, id: string): boolean { return this.rooms[roomId]?.messages.some(message => String(message.seq) === id) ?? false; }
  private rooms: Record<string, Room>;
  private readonly file: string;
  private mutations: Promise<unknown> = Promise.resolve();
  private pumping = new Set<string>();
  private closed = false;
  readonly ready: Promise<void>;
  private readonly onSession = (u: { platformSessionId: string }) => {
    const ref = this.mgr.store.binding(u.platformSessionId)?.roomRef;
    if (ref && this.rooms[ref.roomId]) queueMicrotask(() => { if (!this.closed) this.refresh(ref.roomId); });
  };
  constructor(readonly mgr: RuntimeSessionManager) {
    this.file = join(mgr.store.dir, "rooms.json");
    // 损坏存储不静默丢弃讨论记录。
    this.rooms = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {};
    this.ready = mgr.recovered.then(() => {
      for (const room of Object.values(this.rooms)) {
        for (const msg of room.messages) for (const d of msg.deliveries) {
          if (d.status === "dispatching") {
            const op = mgr.store.operationByKey(d.key);
            if (op) { d.operationId = op.operationId; d.turnNo = op.turnNo; d.status = "running"; }
            else { d.status = "queued"; }
          }
        }
        this.save(); this.refresh(room.roomId);
      }
    });
    mgr.on("session", this.onSession);
    mgr.once("shutdown", () => this.close());
  }
  close(): void { this.closed = true; this.mgr.off("session", this.onSession); }
  private save(): void {
    const tmp = `${this.file}.tmp-${randomUUID()}`;
    try { writeFileSync(tmp, JSON.stringify(this.rooms), { mode: 0o600 }); renameSync(tmp, this.file); }
    catch (error) { this.projectionHealthy = false; throw error; }
    // Hash only at the existing persistence boundary, never during polling reads.
    this.displayVersion++;
    for (const room of Object.values(this.rooms)) for (const message of room.messages) {
      const hash = roomHash(JSON.stringify(message)), old = this.displayRevisions.get(message);
      if (old?.hash !== hash) this.displayRevisions.set(message,{hash,revision:this.displayVersion});
    }
  }
  private serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.mutations.then(() => this.ready).then(async () => { this.mutationCount++; try { return await fn(); } finally { this.mutationCount--; } }); this.mutations = result.catch(() => {}); return result;
  }
  private room(roomId: string): Room { return this.rooms[roomId] ?? fail("群聊不存在", 404, "RT_NOT_FOUND"); }
  private writable(roomId: string): Room { const r = this.room(roomId); if (r.archived) fail("群聊已归档，请先恢复", 409); return r; }
  private notify(roomId: string, type: "room-message" | "member-status" | "delivery"): void { this.mgr.emit("room", { roomId, type }); this.mgr.emit("directory", {}); }
  list(): Room[] { return Object.values(this.rooms).map((r) => ({ ...r, messages: [] })); }
  view(roomId: string, q: { before?: number; limit?: number } = {}) {
    const room = this.room(roomId);
    const limit = Math.min(100, Math.max(1, Math.floor(q.limit ?? 50) || 50));
    const filtered = room.messages.filter((m) => q.before === undefined || m.seq < q.before);
    const messages = filtered.slice(-limit);
    return { room: { ...room, messages: undefined }, latestReplies: room.members.flatMap((member) => { const last = room.messages.filter((m) => m.kind === "member" && m.memberId === member.memberId).at(-1); return last ? [last] : []; }), messages, hasMore: filtered.length > messages.length, total: room.messages.length,
      members: room.members.map((m) => {
        const session = this.mgr.store.binding(m.platformSessionId);
        const queue = room.messages.flatMap((msg) => msg.deliveries.filter((d) => d.memberId === m.memberId && d.status === "queued"));
        return { ...m, session, approvals: this.mgr.pendingApprovals().filter((a) => a.platformSessionId === m.platformSessionId), queuePosition: this.mgr.queuePosition(m.platformSessionId), pendingDeliveries: queue.length };
      }) };
  }
  private settings(input?: Partial<RoomSettings>): RoomSettings {
    const s: RoomSettings = { attribution: "shown", shareScope: "summary", ...input };
    if (!["shown", "anonymous"].includes(s.attribution) || !["replies", "summary", "full"].includes(s.shareScope)) fail("群聊设置无效"); return s;
  }
  private memberInput(room: Pick<Room, "roomId" | "workspace" | "members" | "title" | "worktree">, input: RoomMemberInput, versions?: RoomCreateInput["confirmedProfileVersions"]) {
    if (!input || typeof input.alias !== "string" || input.alias !== input.alias.trim() || !/^[^@/\\<>\x00-\x1f\x7f]{1,32}$/.test(input.alias) || [".", "..", "全部"].includes(input.alias)) fail("成员别名无效（1–32 字符，不含 @、路径或控制字符）");
    if (room.members.some((m) => m.alias === input.alias)) fail(`成员 @${input.alias} 的别名已存在`);
    const kind = input.runtimeKind; if (!RUNTIME_KINDS.includes(kind)) fail(`成员 @${input.alias} 的 runtime 无效`);
    // 只读成员在原目录；可写成员各自一个 worktree（群聊工作目录须在 git 仓库里，权限不能越出工作区）
    const readOnly = readOnlyPermissionMode(kind), permissionMode = input.permissionMode ?? readOnly;
    const writable = permissionMode !== readOnly;
    if (writable) {
      if (!room.worktree) fail(`成员 @${input.alias}：群聊工作目录不是有 commit 的 git 仓库，成员只能只读`);
      if (!COMPARE_WORKTREE_PERMISSION_MODES[kind].includes(permissionMode)) fail(`成员 @${input.alias}：可写成员只能用不越出工作区的权限（不支持 ${permissionMode}）`);
      if (!underRoots(room.worktree!.repoRoot, this.mgr.workspaceRoots(kind))) fail(`成员 @${input.alias}：仓库根 ${room.worktree!.repoRoot} 不在这个运行时的允许工作目录里，放不下 worktree`);
    }
    const profile = this.mgr.profile(kind);
    const member: RoomMember = { memberId: id("mem"), alias: input.alias,
      binding: { runtimeKind: kind, ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}), permissionMode }, platformSessionId: "", joinedAt: now() };
    if (writable) {
      const path = join(room.worktree!.repoRoot, COMPARE_DIR, room.roomId, member.memberId);
      if (!insideRepo(room.worktree!.repoRoot, path)) fail(`成员 @${input.alias}：worktree 路径越出仓库`);
      member.worktree = { path, workspace: room.worktree!.subdir ? join(path, room.worktree!.subdir) : path };
    }
    const args: CreateInput = { idempotencyKey: `room-${room.roomId}-${member.memberId}`, workspace: room.workspace, prompt: "等待人类 @", title: `${room.title} · @${member.alias}`, ...member.binding,
      roomRef: { roomId: room.roomId, memberId: member.memberId }, deferFirstTurn: true,
      confirmedProfileVersion: input.confirmedProfileVersion ?? versions?.[kind] ?? profile?.checkedAt ?? "",
      role: { definitionRef: "room-member@1", templateVersion: "room@1", instructions: roomInstructions(room.roomId, member.alias, writable) } };
    try { this.mgr.preflightCreate(args); } catch (e) { const err = e as RuntimeError; throw new RuntimeError(`成员 @${member.alias}：${err.message}`, err.status ?? 400, err.code ?? "ROOM_ELIGIBILITY"); }
    return { member, args };
  }
  create(input: RoomCreateInput, actor: string): Promise<{ room: Room; replayed: boolean }> {
    return this.serial(async () => {
      keyOf(input.idempotencyKey); const hash = roomHash(JSON.stringify(input));
      const previous = Object.values(this.rooms).find((r) => r.idempotencyKey === input.idempotencyKey);
      if (previous) { if (previous.requestHash !== hash) fail("幂等键已用于不同的新建请求", 409); return { room: previous, replayed: true }; }
      if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 120) fail("标题需要 1–120 字符");
      if (!Array.isArray(input.members) || !input.members.length || input.members.length > 8) fail("群聊需要 1–8 名成员");
      const room: Room = { roomId: id("room"), title: input.title.trim(), workspace: input.workspace, idempotencyKey: input.idempotencyKey, requestHash: hash, createdAt: now(), createdBy: actor, archived: false, members: [], messages: [], settings: this.settings(input.settings) };
      // 工作目录在有 commit 的 git 仓库里：记下起点，可写成员的 worktree 都从这里切出
      const git = typeof input.workspace === "string" && input.workspace.startsWith("/") && existsSync(input.workspace) ? await gitWorkspaceInfo(input.workspace) : undefined;
      if (git) room.worktree = { repoRoot: git.repoRoot, subdir: git.subdir, baseCommit: git.head, ...(git.branch ? { baseBranch: git.branch } : {}), dirtyAtCreate: git.dirty };
      const checked = input.members.map((m) => { const checked = this.memberInput(room, m, input.confirmedProfileVersions); room.members.push(checked.member); return checked; });
      const writers = checked.filter((c) => c.member.worktree);
      if (writers.length && input.confirmedBaseCommit !== git!.head) fail("仓库的 HEAD 在你确认之后变了（或没有确认起点），请重新确认后再建群", 409, "ROOM_BASE_CHANGED");
      // 用 runtime 已核验的 realpath，避免 workspace 经符号链接漂移。
      room.workspace = realpathSync(input.workspace);
      checkSnapshotPath(room.workspace, room.roomId);
      const made: string[] = [];
      try {
        for (const { member } of writers) { await addWorktree(room.worktree!.repoRoot, member.worktree!.path, room.worktree!.baseCommit); made.push(member.worktree!.path); }
      } catch (e) { for (const p of made) await removeWorktree(room.worktree!.repoRoot, p).catch(() => undefined); fail((e as Error).message, 409, "ROOM_WORKTREE"); }
      writeRoomSnapshot(room, this.mgr);
      try {
        for (const { member, args } of checked) { const r = await this.mgr.create({ ...args, workspace: member.worktree?.workspace ?? args.workspace }, actor); member.platformSessionId = r.session.platformSessionId; }
      } catch (e) {
        for (const m of room.members) if (m.platformSessionId) this.mgr.deletePlatformData(m.platformSessionId, actor, { roomControl: true });
        for (const p of made) await removeWorktree(room.worktree!.repoRoot, p).catch(() => undefined);
        deleteRoomSnapshot(room); throw e;
      }
      this.rooms[room.roomId] = room; this.save(); writeRoomSnapshot(room, this.mgr); this.notify(room.roomId, "member-status");
      return { room, replayed: false };
    });
  }
  post(roomId: string, input: RoomPostInput, actor: string): Promise<{ message: RoomMessage; replayed: boolean }> {
    return this.serial(() => {
      const room = this.writable(roomId); keyOf(input.idempotencyKey);
      const hash = roomHash(JSON.stringify({ text: input.text, quotes: input.quotes ?? [], mentions: input.mentions ?? [] }));
      const previous = room.messages.find((m) => m.idempotencyKey === input.idempotencyKey);
      if (previous) { if (previous.requestHash !== hash) fail("幂等键已用于不同的消息内容、引用或成员", 409); return { message: previous, replayed: true }; }
      if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 12000) fail("人类指令需要 1–12000 字符");
      if (!Array.isArray(input.quotes ?? []) || (input.quotes?.length ?? 0) > 8) fail("每次最多引用 8 条消息");
      if (input.mentions !== undefined && input.mentions !== "all" && (!Array.isArray(input.mentions) || input.mentions.some((m) => typeof m !== "string"))) fail("mentions 必须是成员 ID 数组或 all");
      const mentions = input.mentions === "all" ? room.members.filter((m) => !m.removedAt).map((m) => m.memberId) : [...new Set(input.mentions ?? [])];
      for (const memberId of mentions) if (!room.members.some((m) => m.memberId === memberId && !m.removedAt)) fail("@ 的成员不存在或已移出");
      const quotes = (input.quotes ?? []).map((q) => {
        if (!q || !Number.isInteger(q.seq)) fail("引用消息号无效");
        const msg = room.messages.find((m) => m.seq === q.seq) ?? fail(`引用 #${q.seq} 不属于此群聊`);
        let text = msg.text;
        if (q.span) { const { start, end } = q.span; if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) fail("引用片段区间无效"); text = text.slice(start, end); }
        const hash = roomHash(text); if (q.hash && q.hash !== hash) fail("引用片段哈希不匹配，请刷新", 409);
        return { seq: q.seq, ...(q.span ? { span: { ...q.span } } : {}), hash, text: text.slice(0, 20000), author: msg.author, ...(msg.source ? { source: { ...msg.source } } : {}), ...(text.length > 20000 ? { truncated: true } : {}) };
      });
      const message: RoomMessage = { seq: (room.messages.at(-1)?.seq ?? 0) + 1, kind: "human", author: actor, text: input.text, createdAt: now(), idempotencyKey: input.idempotencyKey, requestHash: hash, quotes, mentions, deliveries: [] };
      const cutoffs = Object.fromEntries(room.members.map((m) => [m.memberId, this.mgr.store.events(m.platformSessionId).at(-1)?.seq ?? 0]));
      message.deliveries = mentions.map((memberId) => ({ memberId, key: `${room.roomId}-m${message.seq}-${memberId}`, prompt: renderRoomDelivery(room, room.members.find((m) => m.memberId === memberId)!, message, cutoffs), cutoff: message.seq, eventCutoffs: cutoffs, status: "queued" }));
      if (message.deliveries.some((d) => d.prompt.length > 100000)) fail("投递正文超过 runtime 上限，请减少引用");
      room.messages.push(message); this.save(); writeRoomSnapshot(room, this.mgr); this.notify(roomId, "room-message"); this.pump(room);
      return { message, replayed: false };
    });
  }
  private pump(room: Room): void {
    if (this.closed || room.archived || this.mgr.isDraining()) return;
    for (const member of room.members) {
      const pid = member.platformSessionId;
      if (member.removedAt || this.pumping.has(pid)) continue;
      const b = this.mgr.store.binding(pid); if (!b || b.turns.some((t) => activeTurn(t.status)) || b.status === "unknown") continue;
      const d = room.messages.flatMap((m) => m.deliveries).find((d) => d.memberId === member.memberId && d.status === "queued"); if (!d) continue;
      // 不绕过同一成员的未核对操作。
      if (room.messages.some((m) => m.deliveries.some((x) => x.memberId === member.memberId && ["dispatching", "running", "unknown"].includes(x.status)))) continue;
      this.pumping.add(pid); d.status = "dispatching"; this.save();
      void this.mgr.sendTurn(pid, { idempotencyKey: d.key, prompt: d.prompt, expectedRevision: b.bindingRevision, roomDelivery: true, canDeliver: () => !member.removedAt && !room.archived && !this.closed }, room.createdBy).then(async (r) => {
        d.operationId = r.operation.operationId; d.turnNo = r.operation.turnNo; d.status = "running"; delete d.error; this.save();
        if (member.removedAt && r.session.turns.some((t) => t.turnNo === d.turnNo && t.status === "queued")) await this.mgr.interrupt(pid, room.createdBy);
      }).catch((e) => { d.status = member.removedAt || (e as RuntimeError).code === "ROOM_CANCELLED" ? "cancelled" : "failed"; d.error = bounded((e as Error).message, 500).text; this.save(); }).finally(() => {
        this.pumping.delete(pid); this.notify(room.roomId, "delivery"); this.refresh(room.roomId);
      });
    }
  }
  private refresh(roomId: string): void {
    const room = this.rooms[roomId]; if (!room || this.closed) return;
    let changed = false;
    for (const message of [...room.messages]) for (const d of message.deliveries) {
      if (d.status !== "running" && d.status !== "unknown") continue;
      const member = room.members.find((m) => m.memberId === d.memberId)!;
      const b = this.mgr.store.binding(member.platformSessionId), turn = b?.turns.find((t) => t.turnNo === d.turnNo);
      if (!turn || activeTurn(turn.status) || (d.status === "unknown" && turn.status === "unknown")) continue;
      const events = this.mgr.store.events(member.platformSessionId).filter((e) => e.turnNo === turn.turnNo);
      const answer = events.filter((e) => e.kind === "message" && e.role === "assistant" && !e.subagent && !e.partial && e.text).at(-1);
      const successful = turn.status === "completed" && !!answer;
      const reason = turn.statusReason ?? (successful ? "" : turn.status === "completed" ? "本轮没有主 Agent 正文" : turn.status);
      const seq = (room.messages.at(-1)?.seq ?? 0) + 1;
      const text = successful ? answer!.text! : `@${member.alias} 第 ${turn.turnNo} 轮：${reason}`;
      const source = { memberId: member.memberId, alias: member.alias, ...(member.agentRef ? { agentRef: member.agentRef } : {}), runtimeKind: member.binding.runtimeKind, model: b?.effectiveModel ?? member.binding.model, platformSessionId: member.platformSessionId, turnNo: turn.turnNo, seqStart: events[0]?.seq ?? 0, seqEnd: events.at(-1)?.seq ?? 0 };
      room.messages.push({ seq, kind: successful ? "member" : "system", author: `@${member.alias}`, memberId: member.memberId, replyTo: message.seq, text: b?.nativeSessionId ? text.split(b.nativeSessionId).join("[原生会话 ID 已隐藏]") : text, createdAt: now(), source, quotes: [], mentions: [], deliveries: [] });
      const op = d.operationId ? this.mgr.store.operation(d.operationId) : undefined;
      d.retryable = !!op && op.state === "failed" && op.steps.some((s) => ["create-failed", "role-missing", "cancelled"].includes(s.step) || (s.step === "restart" && /未发出|未送达/.test(s.detail)) || (s.step === "shared-slot-terminal" && s.detail === "not-executed"));
      d.resultSeq = seq; d.status = successful ? "completed" : turn.status === "unknown" ? "unknown" : "failed"; if (!successful) d.error = reason;
      changed = true;
    }
    if (changed) { this.save(); try { writeRoomSnapshot(room, this.mgr); } catch (e) { console.error("群聊快照更新失败", e); } this.notify(roomId, "room-message"); }
    this.notify(roomId, "member-status"); this.pump(room);
  }
  /** 一轮：人类消息 + 被 @ 成员的投递与回复，指标按这一轮计算（轮内对比视图） */
  round(roomId: string, seq: number): RoomRound {
    const room = this.room(roomId);
    const message = room.messages.find((m) => m.seq === seq && m.kind === "human") ?? fail("这一轮不存在", 404, "RT_NOT_FOUND");
    if (message.deliveries.length < 2) fail("这一轮只 @ 了一个成员，没有可对比的回复");
    const members = message.deliveries.map((d) => {
      const member = room.members.find((m) => m.memberId === d.memberId);
      const binding = member ? this.mgr.store.binding(member.platformSessionId) : undefined;
      const reply = d.resultSeq ? room.messages.find((m) => m.seq === d.resultSeq && m.kind === "member") : undefined;
      const qp = member && d.status === "queued" ? this.mgr.queuePosition(member.platformSessionId) : undefined;
      return {
        memberId: d.memberId, alias: member?.alias ?? d.memberId, ...(member?.roleName ? { roleName: member.roleName } : {}),
        runtimeKind: member?.binding.runtimeKind ?? "codex", ...(binding?.effectiveModel ?? member?.binding.model ? { model: binding?.effectiveModel ?? member?.binding.model } : {}),
        ...(binding?.effectiveEffort ?? member?.binding.effort ? { effort: binding?.effectiveEffort ?? member?.binding.effort } : {}),
        platformSessionId: member?.platformSessionId ?? "", removed: !member || !!member.removedAt,
        status: d.status, ...(d.error ? { error: d.error } : {}), ...(d.turnNo ? { turnNo: d.turnNo } : {}), ...(qp ? { queuePosition: qp } : {}),
        approvals: member ? this.mgr.pendingApprovals().filter((a) => a.platformSessionId === member.platformSessionId && a.turnNo === d.turnNo).length : 0,
        ...(reply ? { reply: { seq: reply.seq, text: reply.text } } : {}),
        metrics: member && d.turnNo ? this.mgr.turnMetrics(member.platformSessionId, d.turnNo) : { toolCalls: 0, toolFailures: 0, errors: 0, usage: {}, usageCoverage: "unknown" as const }
      };
    });
    return { roomId, seq, message: { ...message, deliveries: message.deliveries.map(({ prompt: _p, ...d }) => ({ ...d, prompt: "" })) }, settled: message.deliveries.every((d) => ROUND_DONE.includes(d.status)), members, ...(message.verdict ? { verdict: message.verdict } : {}) };
  }
  setRoundVerdict(roomId: string, seq: number, input: { memberId: string | null; note?: string }, actor: string) {
    return this.serial(() => {
      const room = this.writable(roomId);
      const message = room.messages.find((m) => m.seq === seq && m.kind === "human") ?? fail("这一轮不存在", 404, "RT_NOT_FOUND");
      if (message.deliveries.length < 2) fail("这一轮只 @ 了一个成员，没有可对比的回复");
      if (input.memberId !== null && (typeof input.memberId !== "string" || !message.deliveries.some((d) => d.memberId === input.memberId))) fail("最佳回复只能选这一轮被 @ 的成员");
      const note = typeof input.note === "string" ? input.note.trim().slice(0, 2000) : "";
      message.verdict = { memberId: input.memberId, note, at: now(), by: actor };
      this.save(); this.notify(roomId, "room-message");
      return this.round(roomId, seq);
    });
  }
  private async cleanupWorktrees(room: Room): Promise<void> {
    if (!room.worktree || room.worktree.cleanedAt) return;
    for (const m of room.members) if (m.worktree) await removeWorktree(room.worktree.repoRoot, m.worktree.path).catch((e) => console.error("群聊 worktree 清理失败", e));
    if (room.members.some((m) => m.worktree)) room.worktree.cleanedAt = now();
  }
  private writer(roomId: string, memberId: string) {
    const room = this.room(roomId), member = room.members.find((m) => m.memberId === memberId);
    if (!member) fail("成员不存在", 404, "RT_NOT_FOUND");
    if (!member!.worktree || !room.worktree) fail(`@${member!.alias} 是只读成员，没有代码改动`);
    if (room.worktree!.cleanedAt) fail("群聊归档时已删除各成员的 worktree", 410, "RT_GONE");
    return { room, member: member!, wt: room.worktree! };
  }
  /** 可写成员相对群聊起点的全部改动（已提交、未提交、未跟踪；不含 .pi-room 快照） */
  async memberDiff(roomId: string, memberId: string): Promise<Omit<LaneDiff, "patch"> & { patch: string; memberId: string; alias: string; truncated?: { originalChars: number }; adopted: boolean }> {
    const { room, member, wt } = this.writer(roomId, memberId);
    let d: LaneDiff;
    try { d = await laneDiff(wt.repoRoot, member.worktree!.path, wt.baseCommit); }
    catch (e) { return fail((e as Error).message, 409, "ROOM_WORKTREE"); }
    const long = d.patch.length > 400_000;
    return { ...d, memberId, alias: member.alias, patch: long ? d.patch.slice(0, 400_000) : d.patch, ...(long ? { truncated: { originalChars: d.patch.length } } : {}), adopted: !!room.adoptions?.some((a) => a.patchHash === d.patchHash) };
  }
  /**
   * 采用：把成员相对起点的完整补丁应用到原仓库的工作区（不暂存、不 commit）。二次确认带上查看时的 patchHash，
   * 之后改动又变了就拒绝；成员还在运行不能采用；同一份补丁只采用一次；先 --check，冲突时整体不应用。
   */
  adoptMember(roomId: string, memberId: string, patchHash: string, actor: string) {
    return this.serial(async () => {
      const { room, member, wt } = this.writer(roomId, memberId);
      if (typeof patchHash !== "string" || !patchHash.startsWith("sha256:")) fail("缺少查看时的 patchHash");
      if (this.mgr.store.binding(member.platformSessionId)?.turns.some((t) => activeTurn(t.status))) fail(`@${member.alias} 还在运行，结束后再采用`, 409, "RT_BUSY");
      let d: LaneDiff;
      try { d = await laneDiff(wt.repoRoot, member.worktree!.path, wt.baseCommit); }
      catch (e) { return fail((e as Error).message, 409, "ROOM_WORKTREE"); }
      if (d.patchHash !== patchHash) fail(`@${member.alias} 的改动在你查看之后又变了，请重新查看再确认`, 409, "RT_CONFLICT");
      if (room.adoptions?.some((a) => a.patchHash === patchHash)) fail("这份改动已经采用过", 409, "RT_CONFLICT");
      try { await applyPatch(wt.repoRoot, d.patch); }
      catch (e) { fail((e as Error).message, 409, "RT_APPLY"); }
      (room.adoptions ??= []).push({ memberId, alias: member.alias, patchHash, files: d.files.length, at: now(), by: actor });
      this.mgr.store.audit({ type: "room-adopt", roomId, memberId, patchHash, files: d.files.length, repoRoot: wt.repoRoot, actor });
      this.save(); this.notify(roomId, "member-status");
      return { adoptions: room.adoptions };
    });
  }
  retry(roomId: string, seq: number, memberId: string, _actor: string) {
    return this.serial(() => {
      const room = this.writable(roomId), d = room.messages.find((m) => m.seq === seq)?.deliveries.find((d) => d.memberId === memberId);
      if (!d || d.status !== "failed" || (d.operationId && !d.retryable)) return fail("只能重试明确未发送的失败投递；已运行或未知结果请新发指令", 409);
      if (!room.members.some((m) => m.memberId === memberId && !m.removedAt)) fail("成员已移出", 409);
      if (d.operationId) { d.retryNo = (d.retryNo ?? 0) + 1; d.key = `${d.key.replace(/-r[0-9]+$/, "")}-r${d.retryNo}`; }
      d.status = "queued"; delete d.error; delete d.operationId; delete d.turnNo; delete d.resultSeq; delete d.retryable; this.save(); this.pump(room); return d;
    });
  }
  addMember(roomId: string, input: RoomMemberInput, actor: string) {
    return this.serial(async () => {
      const room = this.writable(roomId); if (room.members.filter((m) => !m.removedAt).length >= 8) fail("最多 8 名活跃成员");
      const { member, args } = this.memberInput(room, input);
      if (member.worktree) {
        try { await addWorktree(room.worktree!.repoRoot, member.worktree.path, room.worktree!.baseCommit); }
        catch (e) { fail((e as Error).message, 409, "ROOM_WORKTREE"); }
      }
      try { member.platformSessionId = (await this.mgr.create({ ...args, workspace: member.worktree?.workspace ?? args.workspace }, actor)).session.platformSessionId; }
      catch (e) { if (member.worktree) await removeWorktree(room.worktree!.repoRoot, member.worktree.path).catch(() => undefined); throw e; }
      room.members.push(member); this.save(); writeRoomSnapshot(room, this.mgr); this.notify(roomId, "member-status"); return member;
    });
  }
  removeMember(roomId: string, memberId: string, actor: string) {
    return this.serial(async () => {
      const room = this.writable(roomId), member = room.members.find((m) => m.memberId === memberId && !m.removedAt); if (!member) return fail("成员不存在", 404);
      member.removedAt = now(); for (const msg of room.messages) for (const d of msg.deliveries) if (d.memberId === memberId && d.status === "queued") { d.status = "cancelled"; d.error = "成员已移出"; }
      this.save();
      if (this.mgr.store.binding(member.platformSessionId)?.turns.some((t) => t.status === "queued")) await this.mgr.interrupt(member.platformSessionId, actor);
      // 移出的可写成员：没在运行就删掉它的 worktree（未采用的改动随之删除）；还在运行的留到归档或删除群聊时清理
      if (member.worktree && room.worktree && !this.mgr.store.binding(member.platformSessionId)?.turns.some((t) => activeTurn(t.status))) await removeWorktree(room.worktree.repoRoot, member.worktree.path).catch(() => undefined);
      writeRoomSnapshot(room, this.mgr); this.notify(roomId, "member-status"); return member;
    });
  }
  updateSettings(roomId: string, input: Partial<RoomSettings>, _actor: string) {
    return this.serial(() => { const r = this.writable(roomId); r.settings = this.settings({ ...r.settings, ...input }); this.save(); writeRoomSnapshot(r, this.mgr); this.notify(roomId, "member-status"); return r.settings; });
  }
  /** 改群名称：只改群自己的标题；成员会话的标题保持创建时的样子 */
  rename(roomId: string, title: unknown, _actor: string) {
    return this.serial(() => {
      if (typeof title !== "string" || !title.trim() || title.trim().length > 120) return fail("标题需要 1–120 字符");
      const r = this.writable(roomId); r.title = title.trim(); this.save(); writeRoomSnapshot(r, this.mgr); this.notify(roomId, "member-status"); return { title: r.title };
    });
  }
  private checkIdle(room: Room): void {
    if (room.members.some((m) => this.pumping.has(m.platformSessionId) || this.mgr.store.binding(m.platformSessionId)?.turns.some((t) => activeTurn(t.status))) || room.messages.some((m) => m.deliveries.some((d) => ["dispatching", "running"].includes(d.status)))) fail("请先停止所有成员，再归档或删除", 409, "RT_BUSY");
  }
  archive(roomId: string, archived: boolean, actor: string) {
    return this.serial(async () => {
      const room = this.room(roomId); this.checkIdle(room);
      if (archived) { deleteRoomSnapshot(room); for (const m of room.messages) for (const d of m.deliveries) if (d.status === "queued") { d.status = "cancelled"; d.error = "群聊已归档"; } }
      // 归档即删除可写成员的 worktree（未采用的改动随之删除）；恢复时从群聊起点重新切出（之前的改动不会回来）
      if (archived) await this.cleanupWorktrees(room);
      else if (room.worktree?.cleanedAt) {
        for (const m of room.members) if (m.worktree && !m.removedAt) await addWorktree(room.worktree.repoRoot, m.worktree.path, room.worktree.baseCommit).catch((e) => fail((e as Error).message, 409, "ROOM_WORKTREE"));
        delete room.worktree.cleanedAt;
      }
      room.archived = archived; for (const m of room.members) if (this.mgr.store.binding(m.platformSessionId)) await this.mgr.archive(m.platformSessionId, archived, actor, { roomControl: true });
      this.save(); if (!archived) writeRoomSnapshot(room, this.mgr); this.notify(roomId, "member-status"); return room;
    });
  }
  delete(roomId: string, actor: string) {
    return this.serial(async () => {
      const room = this.room(roomId); this.checkIdle(room); await this.cleanupWorktrees(room); deleteRoomSnapshot(room);
      for (const m of room.members) if (this.mgr.store.binding(m.platformSessionId)) this.mgr.deletePlatformData(m.platformSessionId, actor, { roomControl: true });
      delete this.rooms[roomId]; this.save(); this.notify(roomId, "member-status"); return { ok: true };
    });
  }
}
