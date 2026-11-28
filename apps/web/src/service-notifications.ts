import { mkdirSync, chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { DirectoryEntry } from '@pi-agent/runtime-sessions';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
export const SERVICE_SESSION_ID = 'service-notifications';
/** 能进通知服务会话的场景；设置 → 通知服务按这个清单逐项开关，新增场景在这里登记。 */
export const SERVICE_SCENES = [
  { id: 'schedule-reminder', name: '日程到点提醒', description: '日程到提醒时间时记一条；系统推送不受这个开关影响。' },
  { id: 'todo-ranking', name: '待办推荐排序校准', description: '根据忽略、启动和完成记录校准推荐排序后的结果。' },
  { id: 'error-analysis', name: '故障联合分析', description: '后台分析跑完后汇总已分析条数和新建待办。' },
  { id: 'self-heal', name: '自愈', description: '每晚自愈夜检的汇总、需要你审核的结论，以及修复完成 / 失败的结果。' },
  { id: 'automation-alert', name: '自动任务告警待办', description: '定时任务生成的告警待办（失败、需要人处理等）。' },
  { id: 'nightly-regression', name: '每日完整回归', description: '每日完整回归通过时记一条；失败由告警待办承接。' }
] as const;
export type ServiceScene = typeof SERVICE_SCENES[number]['id'];
export interface ServiceNoticeInput { id: string; app: string; title: string; body: string; href: string; at?: string; scene?: ServiceScene; }
export interface ServiceNotice extends Omit<ServiceNoticeInput, 'scene'> { seq: number; at: string; }
export interface ServiceSceneItem { id: ServiceScene; name: string; description: string; enabled: boolean; }
export interface ServiceNoticeSettings { revision: number; updatedAt: string | null; scenes: ServiceSceneItem[]; }
export class ServiceSceneError extends Error {
  constructor(message: string, readonly code: 'SCENE_UNKNOWN' | 'SCENE_INVALID') { super(message); }
}
const isScene = (id: unknown): id is ServiceScene => SERVICE_SCENES.some(scene => scene.id === id);
interface StoredScenes { enabled: Partial<Record<ServiceScene, boolean>>; revision: number; updatedAt: string | null }
/** One durable inbox. SQLite serializes blue/green writers and deduplicates retries atomically. */
export class ServiceNotifications {
  constructor(private file?: string, private changed: () => void = () => {}) {
    this.prefsFile = file ? join(dirname(file), 'service-notification-scenes.json') : undefined;
  }
  private memory: ServiceNotice[] = [];
  private prefsFile: string | undefined;
  private prefsMemory: StoredScenes = { enabled: {}, revision: 0, updatedAt: null };
  /** 每次都读盘：蓝绿两个实例共用同一份文件，任一边改了另一边立刻生效；文件缺失或损坏按默认（全部开启）。 */
  private readScenes(): StoredScenes {
    if (!this.prefsFile) return this.prefsMemory;
    try {
      if (!existsSync(this.prefsFile)) return { enabled: {}, revision: 0, updatedAt: null };
      const raw = JSON.parse(readFileSync(this.prefsFile, 'utf8')) as Partial<StoredScenes>;
      const enabled: StoredScenes['enabled'] = {};
      for (const [id, value] of Object.entries(raw.enabled ?? {})) if (isScene(id) && typeof value === 'boolean') enabled[id] = value;
      return { enabled, revision: Number.isInteger(raw.revision) && raw.revision! >= 0 ? raw.revision! : 0,
        updatedAt: typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt)) ? raw.updatedAt : null };
    } catch { return { enabled: {}, revision: 0, updatedAt: null }; }
  }
  sceneEnabled(scene: ServiceScene): boolean { return this.readScenes().enabled[scene] ?? true; }
  settings(): ServiceNoticeSettings {
    const stored = this.readScenes();
    return { revision: stored.revision, updatedAt: stored.updatedAt,
      scenes: SERVICE_SCENES.map(scene => ({ ...scene, enabled: stored.enabled[scene.id] ?? true })) };
  }
  /** 开或关一个场景，只影响之后的新通知；先写临时文件再 rename，写失败时保持原配置。 */
  setScene(id: string, enabled: unknown): ServiceNoticeSettings {
    if (!isScene(id)) throw new ServiceSceneError(`没有这个通知场景：${id}`, 'SCENE_UNKNOWN');
    if (typeof enabled !== 'boolean') throw new ServiceSceneError('enabled 必须是 true 或 false', 'SCENE_INVALID');
    const current = this.readScenes();
    const next: StoredScenes = { enabled: { ...current.enabled, [id]: enabled }, revision: current.revision + 1, updatedAt: new Date().toISOString() };
    if (this.prefsFile) {
      mkdirSync(dirname(this.prefsFile), { recursive: true, mode: 0o700 });
      const tmp = `${this.prefsFile}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify({ schema: 1, ...next }, null, 1), { mode: 0o600 });
      renameSync(tmp, this.prefsFile);
    } else this.prefsMemory = next;
    return this.settings();
  }
  private db<T>(operation: (db: InstanceType<typeof DatabaseSync>) => T): T {
    mkdirSync(dirname(this.file!), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.file!);
    try {
      chmodSync(this.file!, 0o600);
      db.exec('PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS notices (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, app TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, href TEXT NOT NULL, at TEXT NOT NULL)');
      return operation(db);
    } finally { db.close(); }
  }
  /** 场景被关掉时返回 null（不写入）；没带 scene 的通知不受开关影响。 */
  publish(input: ServiceNoticeInput): ServiceNotice | null {
    if (!input || typeof input !== 'object') throw new Error('通知格式无效');
    if (input.scene !== undefined && !isScene(input.scene)) throw new Error('通知场景无效');
    for (const key of ['id', 'app', 'title', 'body', 'href'] as const) {
      if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > (key === 'body' ? 8000 : 512)) throw new Error('通知内容无效');
    }
    // Navigation stays inside the application; reject protocol-relative URLs and encoded controls.
    if (!/^\/?#\/[A-Za-z0-9]/.test(input.href) || /[\r\n\\]/.test(input.href)) throw new Error('通知跳转地址无效');
    const at = input.at ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(at))) throw new Error('通知时间无效');
    if (input.scene && !this.sceneEnabled(input.scene)) return null;
    const data = { id: input.id, app: input.app, title: input.title, body: input.body, href: input.href.replace(/^\//, ''), at: new Date(at).toISOString() };
    let inserted = false;
    const notice = this.file ? this.db(db => {
      const result = db.prepare('INSERT INTO notices (id,app,title,body,href,at) SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM notices WHERE id=?)').run(data.id,data.app,data.title,data.body,data.href,data.at,data.id);
      inserted = Number(result.changes) > 0;
      return db.prepare('SELECT * FROM notices WHERE id=?').get(data.id) as unknown as ServiceNotice;
    }) : (() => {
      const old = this.memory.find(n => n.id === data.id); if (old) return old;
      inserted = true; const n = { ...data, seq: (this.memory.at(-1)?.seq ?? 0) + 1 }; this.memory.push(n); return n;
    })();
    if (inserted) this.changed();
    return notice;
  }
  list(before?: number, limit = 50): ServiceNotice[] {
    const end = Number.isSafeInteger(before) && before! > 0 ? before! : Number.MAX_SAFE_INTEGER;
    const size = Math.max(1, Math.min(100, Math.floor(limit) || 50));
    return this.file ? this.db(db => (db.prepare('SELECT * FROM notices WHERE seq < ? ORDER BY seq DESC LIMIT ?').all(end, size) as unknown as ServiceNotice[]).reverse())
      : this.memory.filter(n => n.seq < end).slice(-size).map(n => ({...n}));
  }
  entry(): DirectoryEntry & { serviceNotifications: true; preview: string } {
    const last = this.list(undefined, 1)[0];
    return { id: SERVICE_SESSION_ID, title: '通知服务', serviceNotifications: true,
      runtimeKind: 'pi', sourceMode: 'platform-managed', executionMode: 'contract-governed', accountKnown: true,
      status: 'idle', purpose: 'chat', href: `#/rt/${SERVICE_SESSION_ID}`, archived: false,
      preview: last ? `${last.app} · ${last.title}` : '定时任务、日程提醒与应用消息',
      ...(last ? { lastActivityAt: last.at, lastTurnEndedAt: last.at, latestTurn: { turnNo: last.seq, status: 'completed', endedAt: last.at } } : {}) };
  }
}
