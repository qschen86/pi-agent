/** Durable per-device Web Push outbox. Delivery is independent of open pages.
 * Host mutex protects publication; a renewable sender lease serializes blue/green
 * processes. A timeout/retry can still redeliver, so the worker deduplicates IDs.
 */
import { createHash, ECDH, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import webpush from "web-push";
import { withHostMutex } from "@pi-agent/runtime-sessions";
import type { ProjectedEvent, RuntimeSessionManager, SessionBinding } from "@pi-agent/runtime-sessions";

export type NotificationKind = "reply" | "completed" | "failed" | "approval" | "reminder";
export interface NotificationPreferences {
  reply: boolean; completed: boolean; failed: boolean; approval: boolean; reminder: boolean;
  currentSession: boolean; preview: boolean;
}
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  reply: true, completed: true, failed: true, approval: true, reminder: true, currentSession: false, preview: false
};
export interface PushSubscription { endpoint: string; keys: { p256dh: string; auth: string } }
interface Device {
  id: string; owner: string; public: boolean; subscription: PushSubscription;
  preferences: NotificationPreferences; since: number; updatedAt: number;
  lastSuccess?: number; lastError?: string;
  ready: boolean;
  presence?: Record<string, { sessionId: string; at: number }>;
}
interface Notice {
  id: string; sessionId: string; turnNo?: number; kind: NotificationKind;
  title: string; text: string; at: number; expires: number; messageId?: string;
  /** 日程提醒：“全端推送”的自定义标题 / 正文 / 深链；其它通知没有这个字段 */
  reminder?: { title: string; body: string; url: string };
}
interface Job { id: string; deviceId: string; notice: Notice; due: number; attempts: number }
interface State {
  version: 1; devices: Record<string, Device>; jobs: Record<string, Job>;
  seen: Record<string, number>; sender?: { id: string; until: number };
  sent?: Record<string, number>;
}
type RecoverySnapshot = { devices: Pick<Device, "id" | "since">[]; seen: State["seen"] };
export interface PushPayload {
  id: string; sessionId: string; kind: NotificationKind; title: string; body: string;
  url: string; expiresAt: number; currentSession: boolean; test?: boolean;
  binding: string;
}
export interface DeviceStatus { subscribed: boolean; binding?: string; preferences?: NotificationPreferences; lastSuccess?: number; lastError?: string }
type Send = (subscription: PushSubscription, payload: string, options: webpush.RequestOptions) => Promise<unknown>;
interface Options {
  dir: string; runtime: RuntimeSessionManager; subject: string;
  authorized: (owner: string, publicDevice: boolean) => boolean;
  send?: Send; now?: () => number; autoStart?: boolean;
}
export type WebPushConfig = Pick<Options, "dir" | "subject" | "send" | "now" | "autoStart">;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const labels: Record<NotificationKind, string> = { reply: "助手消息生成完成", completed: "本轮完成", failed: "本轮失败", approval: "需要审批", reminder: "日程提醒" };
const RETENTION = 24 * 3600_000;
const TTL = 15 * 60_000;
// 2 秒只是扫描节拍：恢复扫描与空闲 flush 按更低频率执行，少和页面读取争抢主机互斥锁。
const TICK_MS = 2000;
const RECOVERY_MS = 10_000;
const IDLE_FLUSH_MS = 15_000;
// 部署切换期间旧槽位仍在服务：进一步降低维护频率，让新槽位和页面请求先拿到互斥锁。
const DRAIN_RECOVERY_MS = 60_000;
const DRAIN_IDLE_FLUSH_MS = 60_000;

/** 主机互斥被占用。读取方应降级到快照/调用方 fallback，HTTP 层应回 503 + Retry-After，而不是 500。 */
export class PushStorageBusyError extends Error {
  readonly code = "PUSH_STORAGE_BUSY";
  constructor() { super("推送存储忙，请稍后重试"); this.name = "PushStorageBusyError"; }
}

function atomic(file: string, value: unknown): void {
  const tmp = `${file}.${randomUUID()}.tmp`, fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  const parent = openSync(join(file, ".."), "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
export function notificationPreferences(value: unknown): NotificationPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("通知设置格式无效");
  const out = { ...DEFAULT_NOTIFICATION_PREFERENCES };
  for (const key of Object.keys(out) as Array<keyof NotificationPreferences>) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined && typeof v !== "boolean") throw new Error("通知设置必须为开关值");
    if (typeof v === "boolean") out[key] = v;
  }
  return out;
}
export function validatePushSubscription(value: unknown): PushSubscription {
  const s = value as PushSubscription;
  if (!s || typeof s.endpoint !== "string" || s.endpoint.length > 2048) throw new Error("推送订阅无效");
  const u = new URL(s.endpoint);
  // Never turn a browser-supplied endpoint into an arbitrary server-side request.
  const host = u.hostname;
  if (u.protocol !== "https:" || u.port || u.username || u.password || u.hash || !(
    host === "fcm.googleapis.com" || host === "updates.push.services.mozilla.com" ||
    host === "web.push.apple.com" || host.endsWith(".push.apple.com") ||
    host === "wns.windows.com" || host.endsWith(".notify.windows.com")
  )) throw new Error("不支持的浏览器推送地址");
  if (!s.keys || typeof s.keys.p256dh !== "string" || typeof s.keys.auth !== "string" || s.keys.p256dh.length > 100 || s.keys.auth.length > 30 ||
      !/^[A-Za-z0-9_-]+={0,2}$/.test(s.keys.p256dh) || !/^[A-Za-z0-9_-]+={0,2}$/.test(s.keys.auth) ||
      Buffer.from(s.keys.p256dh, "base64url").length !== 65 || Buffer.from(s.keys.p256dh, "base64url")[0] !== 4 ||
      Buffer.from(s.keys.auth, "base64url").length !== 16) throw new Error("推送订阅密钥无效");
  try { ECDH.convertKey(Buffer.from(s.keys.p256dh, "base64url"), "prime256v1"); }
  catch { throw new Error("推送订阅公钥无效"); }
  return { endpoint: u.href, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
}

export class WebPushService {
  readonly publicKey: string;
  private keys: { publicKey: string; privateKey: string };
  private readonly instance = randomUUID();
  private timer?: NodeJS.Timeout;
  private busy = false;
  private closed = false;
  private recovery?: Promise<void>;
  private lastRecovery = 0;
  private nextIdleFlush = 0;
  private lastCommitted?: State;
  private pendingJobs = 0;
  private readonly now: () => number;
  private readonly send: Send;
  constructor(private readonly opts: Options) {
    this.now = opts.now ?? Date.now;
    this.send = opts.send ?? ((s, p, o) => webpush.sendNotification(s, p, o));
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    const keyFile = join(opts.dir, "vapid.json");
    // Existing keys are immutable and atomically published. Reading them must not
    // compete with normal outbox transactions in the still-serving slot.
    const result = existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, "utf8")) as typeof this.keys : withHostMutex(join(opts.dir, "vapid-init"), () => {
      if (existsSync(keyFile)) return JSON.parse(readFileSync(keyFile, "utf8")) as typeof this.keys;
      const keys = webpush.generateVAPIDKeys(); atomic(keyFile, keys); return keys;
    });
    if ("status" in result) throw new Error("推送密钥正在由另一个服务初始化");
    this.keys = result; this.publicKey = result.publicKey;
    // Validate persisted keys and subject without exposing secrets.
    webpush.generateRequestDetails({ endpoint: "https://fcm.googleapis.com/fcm/send/validate", keys: { p256dh: "", auth: "" } }, undefined,
      { vapidDetails: { subject: opts.subject, ...this.keys } });
    if (opts.autoStart !== false) {
      opts.runtime.on("event", this.onEvent); opts.runtime.on("session", this.onSession);
      this.timer = setInterval(() => this.tick(), TICK_MS);
      this.timer.unref();
    }
  }
  private transaction<T>(fn: (s: State) => T): T {
    const result = withHostMutex(this.opts.dir, () => {
      const file = join(this.opts.dir, "outbox.json");
      const s: State = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { version: 1, devices: {}, jobs: {}, seen: {} };
      if (s.version !== 1 || !s.devices || !s.jobs || !s.seen) throw new Error("推送存储格式无效");
      const before = JSON.stringify(s), result = fn(s);
      if (JSON.stringify(s) !== before) atomic(file, s);
      return { value: result, state: s };
    });
    if ("status" in result) throw new PushStorageBusyError();
    this.lastCommitted = result.state;
    this.pendingJobs = Object.keys(result.state.jobs).length;
    return result.value;
  }
  /** 只读快照：outbox.json 由原子 rename 发布，无锁读到的是一次完整提交（本进程或另一槽位）。 */
  private snapshot(): State | undefined {
    const file = join(this.opts.dir, "outbox.json");
    try {
      if (!existsSync(file)) return this.lastCommitted;
      const s = JSON.parse(readFileSync(file, "utf8")) as State;
      if (!s || s.version !== 1 || !s.devices || !s.jobs || !s.seen) return this.lastCommitted;
      this.lastCommitted = s;
      this.pendingJobs = Object.keys(s.jobs).length;
      return s;
    } catch { return this.lastCommitted; }
  }
  /** 2 秒扫描节拍：恢复与空闲 flush 各自有下限间隔，有待发送任务时才每次心跳都 flush。 */
  private tick(): void {
    if (this.closed) return;
    const now = this.now(), draining = this.opts.runtime.isDraining?.() === true;
    if (now - this.lastRecovery >= (draining ? DRAIN_RECOVERY_MS : RECOVERY_MS)) {
      this.lastRecovery = now;
      void this.recover().catch(() => { console.error("会话通知恢复暂不可用，将重试"); });
    }
    if (this.pendingJobs === 0 && now < this.nextIdleFlush) return;
    this.nextIdleFlush = now + (draining ? DRAIN_IDLE_FLUSH_MS : IDLE_FLUSH_MS);
    void this.flush().catch(() => {});
  }
  private safe(fn: () => void): void { try { fn(); } catch { console.error("会话通知暂未入队，将从持久化事件重试"); } }
  private onEvent = (u: { platformSessionId: string; event: ProjectedEvent }) => this.safe(() => this.collectEvent(u.platformSessionId, u.event));
  private onSession = (u: { platformSessionId: string }) => this.safe(() => this.collectSession(u.platformSessionId));
  subscribe(owner: string, publicDevice: boolean, subscription: unknown, preferences: unknown): string {
    const sub = validatePushSubscription(subscription), prefs = notificationPreferences(preferences), id = digest(sub.endpoint);
    return this.transaction(s => {
      const old = s.devices[id];
      if (!old && Object.keys(s.devices).length >= 100) throw new Error("推送设备数量已达上限");
      // Re-login on the same device replaces its former login, never shares it.
      if (old?.owner !== owner) for (const [key, job] of Object.entries(s.jobs)) if (job.deviceId === id) delete s.jobs[key];
      s.devices[id] = { id, owner, public: publicDevice, subscription: sub, preferences: prefs,
        since: old?.owner === owner ? old.since : this.now(), updatedAt: this.now(),
        ready: old?.owner === owner && old.ready,
        ...(old?.owner === owner ? { presence: old.presence } : {}) };
      return id;
    });
  }
  status(owner: string, id: string, fallback: DeviceStatus = { subscribed: false }): DeviceStatus {
    // 只读路径不进入主机互斥：互斥忙时读最后一次成功提交的快照；连快照都没有才用调用方 fallback。
    const s = this.snapshot();
    if (!s) return fallback;
    const d = s.devices[id];
    return d?.owner === owner ? { subscribed: true, binding: digest(`${d.owner}|${d.since}`), preferences: d.preferences, lastSuccess: d.lastSuccess, lastError: d.lastError } : { subscribed: false };
  }
  unsubscribe(owner: string, id: string): void {
    this.transaction(s => { if (s.devices[id]?.owner === owner) this.remove(s, id); });
  }
  activate(owner: string, id: string, binding: string): void {
    this.transaction(s => {
      const d = s.devices[id];
      if (!d || d.owner !== owner || digest(`${d.owner}|${d.since}`) !== binding) throw new Error("设备订阅已变化，请重新开启");
      d.ready = true;
    });
  }
  heartbeat(owner: string, id: string, client: string, sessionId: string): void {
    if (!/^[A-Za-z0-9-]{8,80}$/.test(client) || sessionId.length > 100) throw new Error("设备状态无效");
    this.transaction(s => {
      const d = s.devices[id]; if (!d || d.owner !== owner) return;
      d.presence ??= {};
      for (const [key, p] of Object.entries(d.presence)) if (p.at + 45_000 < this.now()) delete d.presence[key];
      if (!sessionId) delete d.presence[client];
      else if (Object.keys(d.presence).length < 30 || d.presence[client]) d.presence[client] = { sessionId, at: this.now() };
    });
  }
  private remove(s: State, id: string): void {
    delete s.devices[id];
    for (const [key, job] of Object.entries(s.jobs)) if (job.deviceId === id) delete s.jobs[key];
  }
  async test(owner: string, id: string): Promise<void> {
    const d = this.transaction(s => s.devices[id]?.owner === owner ? s.devices[id] : undefined);
    if (!d || !this.opts.authorized(d.owner, d.public)) throw new Error("请先开启本设备通知");
    const payload: PushPayload = { id: `test:${randomUUID()}`, binding: digest(`${d.owner}|${d.since}`), sessionId: "", kind: "reply", title: "测试通知", body: "本设备可以接收会话通知", url: "/#/rt", expiresAt: this.now() + TTL, currentSession: true, test: true };
    await this.deliver(d, payload);
  }
  /**
   * 日程提醒：发给所有已开启通知的设备（Web Push / 已安装的 PWA），与管理会话无关。
   * 进持久队列，和设备上的任务通知同一套重试与去重；到点前由 NoteReminders 调用。
   */
  remind(input: { id: string; title: string; body: string; url: string; at: number; expires: number }): void {
    if (!/^note-reminder:/.test(input.id) || input.id.length > 500) throw new Error("提醒标识无效");
    if (!input.title.trim() || !input.body.trim()) throw new Error("提醒内容为空");
    if (!/^\/#\/notes(?:\/widget\/\d{4}-\d{2}-\d{2}(?:\/[A-Za-z0-9_-]+)?)?$/.test(input.url)) throw new Error("提醒链接无效");
    if (!Number.isFinite(input.at) || !Number.isFinite(input.expires) || input.expires <= this.now()) return;
    this.enqueue({ id: input.id, sessionId: "", kind: "reminder", title: input.title, text: input.body, at: input.at, expires: input.expires,
      reminder: { title: input.title.slice(0, 120), body: input.body.slice(0, 300), url: input.url } });
  }
  private binding(id: string): SessionBinding | undefined {
    const b = this.opts.runtime.store.binding(id);
    return b && this.eligible(b) ? b : undefined;
  }
  private eligible(b: SessionBinding): boolean {
    return !b.archived && !b.evaluation && b.sourceMode === "platform-managed";
  }
  private relevant(e: ProjectedEvent): boolean {
    return e.source !== "history" && !e.subagent && !e.partial && (
      e.kind === "message" && e.role === "assistant" && !!(e.text?.trim() || e.attachments?.length) ||
      e.kind === "approval" && e.status === "pending" ||
      e.kind === "turn-status" && e.status === "waiting-input");
  }
  collectEvent(id: string, e: ProjectedEvent): void {
    // Reject tool/reasoning/partial events before the authoritative full-table read.
    if (!this.relevant(e)) return;
    const b = this.binding(id);
    if (b) this.collectBindingEvent(b, e);
  }
  private collectBindingEvent(b: SessionBinding, e: ProjectedEvent, snapshot?: RecoverySnapshot): void {
    const id = b.platformSessionId;
    if (e.kind === "message" && e.role === "assistant" && (e.text?.trim() || e.attachments?.length)) {
      this.enqueue({ id: `reply:${id}:${e.key}`, sessionId: id, turnNo: e.turnNo, kind: "reply", title: b.title,
        text: e.text?.slice(0, 300) || "回复包含图片", at: Date.parse(e.recordedAt), expires: Date.parse(e.recordedAt) + TTL }, snapshot);
    } else if (e.kind === "approval" && e.status === "pending") {
      const a = this.opts.runtime.pendingApprovals().find(a => a.approvalId === e.approvalId);
      if (a) this.enqueue({ id: `approval:${a.approvalId}`, sessionId: id, turnNo: a.turnNo, kind: "approval", title: b.title,
        text: a.title, at: Date.parse(a.createdAt), expires: Math.min(a.expiresAt ? Date.parse(a.expiresAt) : Infinity, Date.parse(a.createdAt) + TTL) }, snapshot);
    } else if (e.kind === "turn-status" && e.status === "waiting-input" && !this.opts.runtime.pendingApprovals().some(a => a.platformSessionId === id)) {
      this.enqueue({ id: `input:${id}:${e.key}`, sessionId: id, turnNo: e.turnNo, kind: "approval", title: b.title,
        text: "等待你的回复或处理", at: Date.parse(e.recordedAt), expires: Date.parse(e.recordedAt) + TTL }, snapshot);
    }
  }
  collectSession(id: string): void {
    const b = this.binding(id); if (!b) return;
    this.collectBindingSession(b);
  }
  private collectBindingSession(b: SessionBinding, snapshot?: RecoverySnapshot): void {
    const id = b.platformSessionId;
    for (const turn of b.turns) {
      if (!["completed", "failed"].includes(turn.status) || !turn.endedAt) continue;
      const at = Date.parse(turn.endedAt);
      if (at + TTL <= this.now()) continue;
      const message = this.opts.runtime.store.events(id).filter(e => e.turnNo === turn.turnNo && e.role === "assistant" && e.kind === "message" && !e.partial && !e.subagent && e.source !== "history").at(-1);
      const merged = turn.status === "completed" && message && at - Date.parse(message.recordedAt) <= 5000;
      this.enqueue({ id: `turn:${id}:${turn.turnNo}:${turn.status}`, sessionId: id, turnNo: turn.turnNo,
        kind: turn.status as "completed" | "failed", title: b.title, text: message?.text?.slice(0, 300) ?? turn.statusReason ?? "",
        at, expires: at + TTL, ...(merged ? { messageId: `reply:${id}:${message.key}` } : {}) }, snapshot);
    }
  }
  recover(): Promise<void> {
    if (this.closed) return Promise.resolve();
    // A large recovery pass must yield to HTTP reads without overlapping the next tick.
    return this.recovery ??= this.recoverPending().finally(() => { this.recovery = undefined; });
  }
  private async recoverPending(): Promise<void> {
    const snapshot = this.transaction(s => ({ devices: Object.values(s.devices).map(({ id, since }) => ({ id, since })), seen: s.seen }));
    if (!snapshot.devices.length) return;
    const cutoff = Math.max(Math.min(this.now(), ...snapshot.devices.map(d => d.since)), this.now() - TTL);
    let work = 0, started = performance.now();
    for (const b of this.opts.runtime.store.allBindings()) {
      if (this.closed) return;
      if (!this.eligible(b) || Math.max(Date.parse(b.lastActivityAt.at), ...b.turns.map(t => Date.parse(t.endedAt ?? t.startedAt ?? "") || 0)) < cutoff) continue;
      // One authoritative binding snapshot per pass, not one disk read per event.
      for (const e of this.opts.runtime.store.events(b.platformSessionId).slice()) {
        if (Date.parse(e.recordedAt) >= cutoff && this.relevant(e)) this.collectBindingEvent(b, e, snapshot);
        if (++work >= 50 || performance.now() - started >= 8) {
          await new Promise<void>(resolve => setImmediate(resolve));
          if (this.closed) return;
          work = 0; started = performance.now();
        }
      }
      this.collectBindingSession(b, snapshot);
    }
  }
  private enqueue(notice: Notice, snapshot?: RecoverySnapshot): void {
    if (!Number.isFinite(notice.at) || notice.expires <= this.now()) return;
    // Persisted per-device dedupe is also the recovery checkpoint. A new device
    // is picked up next pass; restarts, replaced events and approvals remain replayable.
    if (snapshot && snapshot.devices.every(d => notice.at <= d.since || snapshot.seen[digest(`${d.id}|${d.since}|${notice.id}`)])) return;
    this.transaction(s => {
      for (const d of Object.values(s.devices)) {
        if (notice.at <= d.since || !this.opts.authorized(d.owner, d.public)) continue;
        const key = digest(`${d.id}|${d.since}|${notice.id}`);
        if (s.seen[key]) continue;
        if (notice.kind === "reply" && notice.turnNo !== undefined) {
          const completedKey = digest(`${d.id}|${d.since}|turn:${notice.sessionId}:${notice.turnNo}:completed`);
          // Some runtimes settle before the last complete message is projected.
          if (s.jobs[completedKey] || s.sent?.[completedKey]) {
            const terminal = s.jobs[completedKey];
            if (terminal) terminal.notice.text = notice.text;
            s.seen[key] = this.now(); continue;
          }
        }
        const replyKey = notice.messageId ? digest(`${d.id}|${d.since}|${notice.messageId}`) : undefined;
        const merge = notice.kind === "completed" && !!replyKey;
        const allowed = notice.kind === "reminder" ? d.preferences.reminder !== false : d.preferences[notice.kind] || merge && d.preferences.reply;
        s.seen[key] = this.now();
        if (!allowed) continue;
        // Suppress at the server: a userVisibleOnly push must display a notification.
        // A final reply already delivered in the coalescing window needs no second alert.
        if (replyKey && s.sent?.[replyKey] && d.preferences.reply) continue;
        if (replyKey) { delete s.jobs[replyKey]; s.seen[replyKey] = this.now(); }
        s.jobs[key] = { id: key, deviceId: d.id, notice, due: this.now() + (notice.kind === "reply" || notice.id.startsWith("input:") ? 2000 : 500), attempts: 0 };
      }
    });
  }
  private async deliver(d: Device, payload: PushPayload): Promise<void> {
    await this.send(d.subscription, JSON.stringify(payload), {
      vapidDetails: { subject: this.opts.subject, ...this.keys }, timeout: 10_000,
      TTL: Math.max(1, Math.ceil((payload.expiresAt - this.now()) / 1000)),
      urgency: payload.kind === "approval" || payload.kind === "failed" ? "high" : "normal",
      topic: digest(payload.id).slice(0, 32)
    });
  }
  async flush(): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      for (let n = 0; n < 20 && !this.closed; n++) {
        const next = this.transaction(s => {
          const now = this.now();
          if (s.sender && s.sender.id !== this.instance && s.sender.until > now) return undefined;
          for (const [id, time] of Object.entries(s.seen)) if (time + RETENTION < now) delete s.seen[id];
          for (const [id, time] of Object.entries(s.sent ?? {})) if (time + RETENTION < now) delete s.sent![id];
          for (const d of Object.values(s.devices)) if (!this.opts.authorized(d.owner, d.public)) this.remove(s, d.id);
          for (const [id, job] of Object.entries(s.jobs)) if (job.notice.expires <= now) delete s.jobs[id];
          const job = Object.values(s.jobs).filter(j => j.due <= now && s.devices[j.deviceId]?.ready).sort((a, b) => a.due - b.due)[0];
          if (job) s.sender = { id: this.instance, until: now + 30_000 };
          return job ? { job, device: s.devices[job.deviceId] } : undefined;
        });
        if (!next) break;
        const { job, device } = next;
        const b = job.notice.sessionId ? this.binding(job.notice.sessionId) : undefined;
        const reminder = job.notice.reminder;
        const approvalValid = job.notice.kind !== "approval" || (job.notice.id.startsWith("input:")
          ? b?.status === "waiting-input" && !this.opts.runtime.pendingApprovals().some(a => a.platformSessionId === b.platformSessionId)
          : this.opts.runtime.pendingApprovals().some(a => `approval:${a.approvalId}` === job.notice.id));
        const kindEnabled = device && (job.notice.kind === "reminder" ? device.preferences.reminder !== false
          : device.preferences[job.notice.kind] || job.notice.kind === "completed" && job.notice.messageId && device.preferences.reply);
        // Only a reading acknowledgement after this event suppresses it. A stale
        // heartbeat from a page just closed must not hide a new background message.
        const reading = device && job.notice.sessionId && !device.preferences.currentSession
          && Object.values(device.presence ?? {}).some(p => p.sessionId === job.notice.sessionId && p.at >= job.notice.at && p.at + 45_000 > this.now());
        if (!device || (!reminder && !b) || !approvalValid || !kindEnabled || reading || !this.opts.authorized(device.owner, device.public)) {
          this.transaction(s => { delete s.jobs[job.id]; }); continue;
        }
        try {
          await this.deliver(device, { id: job.notice.id, binding: digest(`${device.owner}|${device.since}`), sessionId: job.notice.sessionId, kind: job.notice.kind,
            title: reminder ? reminder.title : job.notice.id.startsWith("input:") ? "需要你的处理" : labels[job.notice.kind],
            body: reminder ? reminder.body : `${b!.title || "会话"}${device.preferences.preview && job.notice.text ? `：${job.notice.text.slice(0, 160)}` : ""}`,
            url: reminder ? reminder.url : `/#/rt/${encodeURIComponent(job.notice.sessionId)}`, expiresAt: job.notice.expires, currentSession: reminder ? false : device.preferences.currentSession });
          this.transaction(s => { delete s.jobs[job.id]; (s.sent ??= {})[job.id] = this.now(); const d = s.devices[device.id]; if (d) { d.lastSuccess = this.now(); delete d.lastError; } });
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          this.transaction(s => {
            if (status === 404 || status === 410) { this.remove(s, device.id); return; }
            const d = s.devices[device.id]; if (d) d.lastError = status ? `推送服务返回 ${status}` : "推送网络暂不可用";
            const j = s.jobs[job.id]; if (!j) return;
            j.attempts++;
            if (j.attempts >= 5 || status === 400 || status === 401 || status === 403) delete s.jobs[job.id];
            else j.due = this.now() + Math.min(120_000, 5000 * 2 ** (j.attempts - 1));
          });
        }
      }
    } finally {
      this.busy = false;
      this.transaction(s => { if (s.sender?.id === this.instance) delete s.sender; });
    }
  }
  close(): void {
    this.closed = true; if (this.timer) clearInterval(this.timer);
    this.opts.runtime.off("event", this.onEvent); this.opts.runtime.off("session", this.onSession);
  }
}
