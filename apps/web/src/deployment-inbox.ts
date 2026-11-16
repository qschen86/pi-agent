import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { RuntimeError } from '@pi-agent/runtime-sessions';

export type DeploymentSubmission = { action: 'create' | 'turn' | 'outbox'; sessionId?: string; body: Record<string, unknown>; actor: string; public: boolean };
type Entry = DeploymentSubmission & { id: string; hash: string; at: number; result?: unknown; failure?: { error: string; code: string; status: number } };
const pending = (e: Entry) => !('result' in e) && !e.failure;
/** A separate per-request journal: old-process admission never writes candidate business stores. */
export class DeploymentInbox {
  private busy = false;
  constructor(private dir: string, private execute: (entry: DeploymentSubmission) => Promise<unknown>, private blocked: () => boolean, private serving: () => Promise<boolean> = async () => true, private retain: (entry: DeploymentSubmission) => void = () => {}) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  private path(id: string) { return join(this.dir, `${id}.json`); }
  private read(id: string): Entry | undefined {
    if (!/^[a-f0-9]{64}$/.test(id)) return;
    try { return JSON.parse(readFileSync(this.path(id), 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  }
  private save(e: Entry) {
    const file = this.path(e.id), tmp = `${file}.${randomUUID()}.tmp`, fd = openSync(tmp, 'wx', 0o600);
    try { try { writeFileSync(fd, JSON.stringify(e)); fsyncSync(fd); } finally { closeSync(fd); } renameSync(tmp, file);
      const parent = openSync(this.dir, 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
    } finally { rmSync(tmp, { force: true }); }
  }
  submit(input: DeploymentSubmission): unknown {
    const key = String(input.body['idempotencyKey'] ?? input.body['messageId'] ?? '').trim();
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw new RuntimeError('缺少有效的请求键', 400, 'RT_INPUT');
    if (JSON.stringify(input.body).length > 200_000) throw new RuntimeError('消息过长', 400, 'RT_INPUT');
    const id = createHash('sha256').update(JSON.stringify([input.actor, input.action, input.sessionId, key])).digest('hex');
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    let entry = this.read(id);
    if (entry && entry.hash !== hash) throw new RuntimeError('请求键已用于其他消息或配置', 409, 'RT_CONFLICT');
    const files = readdirSync(this.dir).filter(n => n.endsWith('.json'));
    // 创建会话不再排队：先建记录（首条消息另行排队），用户不必等部署结束才能看到会话/建下一个。
    if (!entry && input.action === 'create') return undefined;
    if (!entry && !this.blocked() && !files.some(n => { const e = this.read(n.slice(0, -5)); return e && pending(e); })) return undefined;
    if (!entry) {
      // 校验发生在受理时；部署结束时允许已受理的预约过期到点，不能把它当作新的过去时间拒绝。
      if (input.action === 'outbox' && input.body['scheduledFor'] !== undefined) {
        const value = input.body['scheduledFor'];
        if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now()) throw new RuntimeError('预约时间必须是未来的有效时间', 400, 'RT_INPUT');
      }
      if (files.length >= 2000) throw new RuntimeError('部署等待队列已满，请稍后重试', 503, 'RT_QUEUE_FULL');
      this.retain(input);
      entry = { ...input, id, hash, at: Math.max(Date.now(), ...files.map(n => (this.read(n.slice(0, -5))?.at ?? 0) + 1)) }; this.save(entry);
    }
    return this.response(entry);
  }
  list(sessionId: string, actor: string) {
    return readdirSync(this.dir).filter(n => n.endsWith('.json'))
      .map(n => this.read(n.slice(0, -5)))
      .filter((e): e is Entry => !!e && pending(e) && e.sessionId === sessionId && e.actor === actor)
      .sort((a, b) => a.at - b.at)
      .map(e => ({ messageId: `deployment:${e.id}`, deployment: true, key: String(e.body['idempotencyKey'] ?? e.body['messageId'] ?? ''),
        prompt: String(e.body['prompt'] ?? ''), attachmentCount: Array.isArray(e.body['attachmentIds']) ? e.body['attachmentIds'].length : 0,
        effort: typeof e.body['effort'] === 'string' ? e.body['effort'] : undefined,
        scheduledFor: typeof e.body['scheduledFor'] === 'string' ? e.body['scheduledFor'] : undefined }));
  }
  status(id: string, actor: string) {
    const e = this.read(id);
    if (!e || e.actor !== actor) throw new RuntimeError('等待中的消息不存在', 404, 'RT_NOT_FOUND');
    return this.response(e);
  }
  private response(e: Entry): unknown {
    if (e.failure) throw new RuntimeError(e.failure.error, e.failure.status as RuntimeError['status'], e.failure.code);
    return 'result' in e ? e.result : { deploymentQueued: true, ticket: e.id, message: '部署完成后自动发送' };
  }
  async flush(): Promise<void> {
    if (this.busy || this.blocked()) return;
    this.busy = true;
    try {
      const entries = readdirSync(this.dir).filter(n => n.endsWith('.json')).map(n => this.read(n.slice(0, -5))!).sort((a, b) => a.at - b.at);
      if (entries.some(pending) && (!(await this.serving()) || this.blocked())) return;
      for (const e of entries) {
        if (this.blocked()) break;
        if (!pending(e)) { if (Date.now() - e.at > 7 * 86400_000) rmSync(this.path(e.id), { force: true }); continue; }
        try {
          if (Date.now() - e.at > 86400_000) throw new RuntimeError('等待部署已超过一天，请核对后重新发送', 409, 'RT_QUEUE_EXPIRED');
          e.result = await this.execute({ action: e.action, sessionId: e.sessionId, body: e.body, actor: e.actor, public: e.public });
        } catch (error) {
          const err = error as { code?: string; status?: number; message: string };
          if (err.code === 'RT_DRAINING') break;
          // Unknown failures preserve the same request key for explicit status recovery.
          e.failure = { error: err.message, code: err.code ?? 'INTERNAL', status: err.status ?? 500 };
        }
        e.body = {}; this.save(e);
      }
    } finally { this.busy = false; }
  }
}
