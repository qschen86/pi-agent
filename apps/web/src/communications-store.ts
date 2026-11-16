import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CommunicationsError, parseSnapshotMeta, parseRows, rowKey, type Kind, type Row, type SnapshotMeta, type Contact, integer, str } from './communications-types.js';
import { queryContacts, queryStats, type Query } from './communications-query.js';
export interface Snapshot {
    collectedAtByDate?: Record<string, string>;
    meta: SnapshotMeta;
    rows: Row[];
    revision: number;
    lastSuccess: string;
}
export interface KindStatus {
    state: 'success' | 'denied' | 'restricted' | 'failed';
    errorCode: string | null;
    lastAttempt: string;
}
export interface DeviceData {
    statuses?: Partial<Record<Kind, KindStatus>>;
    deviceId: string;
    enabled: boolean;
    epoch: string;
    revision: number;
    snapshots: Partial<Record<Kind, Snapshot>>;
}
interface Batch {
    deviceId: string;
    epoch: string;
    requestId: string;
    batchId: string;
    revision: number;
    meta: SnapshotMeta;
    pages: Map<number, Row[]>;
    hashes: Map<number, string>;
    expires: number;
    result?: {
        revision: number;
        lastSuccess: string;
    };
}
export class CommunicationsStore {
    private data = new Map<string, DeviceData>();
    private batches = new Map<string, Batch>();
    constructor(private root: string, private now: () => number = Date.now) { mkdirSync(root, { recursive: true, mode: 0o700 }); for (const name of readdirSync(root)) {
        if (!/^[A-Za-z0-9_-]+\.json$/.test(name))
            continue;
        const d = JSON.parse(readFileSync(join(root, name), 'utf8')) as DeviceData;
        if (d.deviceId !== name.slice(0, -5) || !d.epoch || !d.snapshots)
            throw new Error('通讯数据文件损坏，请保留原文件并恢复备份');
        this.data.set(d.deviceId, d);
    } }
    private id(id: string) { if (!/^[A-Za-z0-9_-]{1,100}$/.test(id))
        throw new CommunicationsError('设备标识不正确'); return id; }
    private get(id: string): DeviceData { this.id(id); const d = this.data.get(id); if (!d)
        throw new CommunicationsError('尚未启用同步', 'COMMUNICATIONS_NOT_FOUND', 404); return d; }
    private save(d: DeviceData) { const file = join(this.root, this.id(d.deviceId) + '.json'), tmp = file + '.' + randomUUID() + '.tmp'; try {
        writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 });
        renameSync(tmp, file);
        this.data.set(d.deviceId, d);
    }
    catch (e) {
        if (existsSync(tmp))
            unlinkSync(tmp);
        throw e;
    } }
    private clear(id: string) { for (const [k, b] of this.batches)
        if (b.deviceId === id)
            this.batches.delete(k); }
    private public(d: DeviceData) { return { deviceId: d.deviceId, enabled: d.enabled, epoch: d.epoch, revision: d.revision, statuses: d.statuses ?? {}, revisionByKind: Object.fromEntries(Object.entries(d.snapshots).map(([k, s]) => [k, s.revision])), lastSuccessByKind: Object.fromEntries(Object.entries(d.snapshots).map(([k, s]) => [k, s.lastSuccess])), coverage: Object.fromEntries(Object.entries(d.snapshots).map(([k, s]) => [k, s.meta])) }; }
    devices() { return [...this.data.values()].map(d => this.public(d)); }
    enable(id: string) { this.id(id); const d = this.data.get(id); if (d?.enabled)
        return this.public(d); const next: DeviceData = d ? { ...structuredClone(d), enabled: true, epoch: randomUUID() } : { deviceId: id, enabled: true, epoch: randomUUID(), revision: 0, snapshots: {} }; this.save(next); this.clear(id); return this.public(next); }
    stop(id: string) { const d = structuredClone(this.get(id)); d.enabled = false; d.epoch = randomUUID(); d.revision++; this.save(d); this.clear(id); return this.public(d); }
    deleteData(id: string) { const d = structuredClone(this.get(id)); d.enabled = false; d.epoch = randomUUID(); d.revision++; d.snapshots = {}; d.statuses = {}; this.save(d); this.clear(id); return this.public(d); }
    updateStatus(id: string, epoch: string, kind: string, state: string, errorCode: unknown) {
        if (!['contacts', 'calls', 'sms'].includes(kind) || !['denied', 'restricted', 'failed'].includes(state) || (errorCode !== null && (typeof errorCode !== 'string' || !/^COMMUNICATIONS_[A-Z0-9_]{1,64}$/.test(errorCode))))
            throw new CommunicationsError('同步状态不正确');
        const d = structuredClone(this.get(id));
        if (!d.enabled || d.epoch !== epoch)
            throw new CommunicationsError('同步已停止', 'COMMUNICATIONS_EPOCH', 409);
        d.statuses ??= {};
        d.statuses[kind as Kind] = { state: state as KindStatus['state'], errorCode: errorCode as string | null, lastAttempt: new Date(this.now()).toISOString() };
        d.revision++;
        this.save(d);
        return { ok: true };
    }
    begin(id: string, epoch: string, requestId: string, input: unknown) {
        const d = this.get(id);
        if (!d.enabled || d.epoch !== epoch)
            throw new CommunicationsError('同步已停止或数据已删除，请重新启用', 'COMMUNICATIONS_EPOCH', 409);
        str(requestId, 100);
        if (!/^[A-Za-z0-9_-]+$/.test(requestId))
            throw new CommunicationsError('请求标识不正确');
        const meta = parseSnapshotMeta(input);
        for (const [key, b] of this.batches) {
            if (b.expires < this.now()) {
                this.batches.delete(key);
                continue;
            }
            if (b.deviceId === id && b.requestId === requestId) {
                if (b.epoch !== epoch || JSON.stringify(b.meta) !== JSON.stringify(meta))
                    throw new CommunicationsError('批次内容冲突', 'COMMUNICATIONS_CONFLICT', 409);
                return { batchId: b.batchId, revision: b.revision };
            }
        }
        const next = structuredClone(d);
        next.revision++;
        this.save(next);
        for (const [key, b] of this.batches)
            if (b.deviceId === id && b.meta.kind === meta.kind && !b.result)
                this.batches.delete(key);
        const b: Batch = { deviceId: id, epoch, requestId, batchId: randomUUID(), revision: next.revision, meta, pages: new Map(), hashes: new Map(), expires: this.now() + 86400000 };
        this.batches.set(b.batchId, b);
        // Bound completed retry receipts independently of uploaded rows.
        const receipts = [...this.batches.values()].filter(x => x.deviceId === id && x.result);
        for (const old of receipts.slice(0, -12))
            this.batches.delete(old.batchId);
        return { batchId: b.batchId, revision: b.revision };
    }
    private batch(id: string, batchId: string) { const d = this.get(id), b = this.batches.get(batchId); if (!b || b.deviceId !== id || b.epoch !== d.epoch || !d.enabled || b.expires < this.now())
        throw new CommunicationsError('同步批次失效，请重新读取', 'COMMUNICATIONS_BATCH_EXPIRED', 409); return b; }
    putPage(id: string, batchId: string, page: number, input: unknown) { const b = this.batch(id, batchId); integer(page, 200000); if (page >= b.meta.pageCount)
        throw new CommunicationsError('页号不正确'); const rows = parseRows(b.meta.kind, input); const digest = createHash('sha256').update(JSON.stringify(rows)).digest('hex'); const old = b.pages.get(page); if (b.hashes.has(page) && b.hashes.get(page) !== digest)
        throw new CommunicationsError('重复页内容不同', 'COMMUNICATIONS_CONFLICT', 409); if (b.result) {
        if (!b.hashes.has(page))
            throw new CommunicationsError('批次已提交', 'COMMUNICATIONS_CONFLICT', 409);
        return { ok: true };
    } const total = [...b.pages].reduce((n, [p, r]) => n + (p === page ? 0 : r.length), rows.length); if (total > b.meta.rowCount)
        throw new CommunicationsError('行数超出声明'); b.pages.set(page, rows); b.hashes.set(page, digest); return { ok: true }; }
    commit(id: string, batchId: string) {
        const b = this.batch(id, batchId);
        if (b.result)
            return b.result;
        if (b.pages.size !== b.meta.pageCount)
            throw new CommunicationsError('同步页不完整', 'COMMUNICATIONS_INCOMPLETE', 409);
        const rows: Row[] = [];
        for (let n = 0; n < b.meta.pageCount; n++) {
            const page = b.pages.get(n);
            if (!page)
                throw new CommunicationsError('缺少同步页', 'COMMUNICATIONS_INCOMPLETE', 409);
            rows.push(...page);
        }
        if (rows.length !== b.meta.rowCount)
            throw new CommunicationsError('行数不一致');
        const keys = new Set<string>();
        for (const r of rows) {
            const k = rowKey(b.meta.kind, r);
            if (keys.has(k))
                throw new CommunicationsError('跨页重复数据');
            keys.add(k);
            if (b.meta.kind !== 'contacts') {
                const date = (r as {
                    date: string;
                }).date;
                if (date > b.meta.throughDate || (b.meta.fromDate && date < b.meta.fromDate))
                    throw new CommunicationsError('记录超出统计范围');
            }
        }
        const d = structuredClone(this.get(id)), old = d.snapshots[b.meta.kind];
        if (old && old.revision >= b.revision)
            throw new CommunicationsError('已存在更新快照', 'COMMUNICATIONS_STALE', 409);
        const retained = b.meta.kind === 'contacts' || b.meta.window === 'all' ? [] : (old?.rows ?? []).filter(r => { const date = (r as {
            date: string;
        }).date; return date < b.meta.fromDate! || date > b.meta.throughDate; });
        if (retained.length + rows.length > 200000)
            throw new CommunicationsError('历史数据超出容量', 'COMMUNICATIONS_TOO_LARGE', 413);
        const lastSuccess = new Date(this.now()).toISOString();
        const collectedAtByDate: Record<string, string> = {};
        if (b.meta.kind !== 'contacts') {
            for (const r of retained) {
                const date = (r as {
                    date: string;
                }).date;
                collectedAtByDate[date] = old?.collectedAtByDate?.[date] ?? old!.lastSuccess;
            }
            for (const r of rows)
                collectedAtByDate[(r as {
                    date: string;
                }).date] = lastSuccess;
        }
        d.snapshots[b.meta.kind] = { collectedAtByDate, meta: b.meta, rows: [...retained, ...rows], revision: b.revision, lastSuccess };
        d.statuses ??= {};
        d.statuses[b.meta.kind] = { state: 'success', errorCode: null, lastAttempt: lastSuccess };
        this.save(d);
        b.pages.clear();
        b.result = { revision: b.revision, lastSuccess };
        return b.result;
    }
    contacts(query: Query) { return queryContacts([...this.data.values()], query); }
    stats(query: Query) { return queryStats([...this.data.values()], query); }
}
