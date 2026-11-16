/** Wire schema shared by the native reader and private communications API. No message bodies. */
/** Keep in sync with Android CommunicationsReader.MAX_PHONES_PER_CONTACT. Page and snapshot byte limits still apply. */
export const MAX_PHONES_PER_CONTACT = 1000;
export type Kind = 'contacts' | 'calls' | 'sms';
export type Window = 30 | 90 | 'all';
export interface Phone {
    key: string;
    number: string;
    label: string;
}
export interface Contact {
    id: string;
    name: string;
    phones: Phone[];
}
export interface CallDay {
    date: string;
    key: string;
    incoming: number;
    outgoing: number;
    missed: number;
    rejected: number;
    other: number;
    incomingSeconds: number;
    outgoingSeconds: number;
}
export interface SmsDay {
    date: string;
    key: string;
    received: number;
    sent: number;
}
export type Row = Contact | CallDay | SmsDay;
export interface SnapshotMeta {
    schemaVersion: 1;
    kind: Kind;
    window: Window;
    fromDate: string | null;
    throughDate: string;
    scannedAt: string;
    minObservedAt: string | null;
    maxObservedAt: string | null;
    rowCount: number;
    pageCount: number;
}
export class CommunicationsError extends Error {
    constructor(message: string, public code = 'COMMUNICATIONS_INVALID', public status: 400 | 401 | 403 | 404 | 409 | 413 = 400) { super(message); }
}
export function invalid(message = '通讯数据格式不正确'): never { throw new CommunicationsError(message); }
export function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v))
    invalid(); return v as Record<string, unknown>; }
export function exact(v: unknown, fields: string[]): Record<string, unknown> { const o = object(v); if (Object.keys(o).some(k => !fields.includes(k)) || fields.some(k => !(k in o)))
    invalid('包含未知字段或缺少字段'); return o; }
export function str(v: unknown, max = 200): string { if (typeof v !== 'string' || v.length > max || /[\u0000-\u001f]/.test(v))
    invalid(); return v; }
export function integer(v: unknown, max = Number.MAX_SAFE_INTEGER): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > max)
    invalid(); return v; }
export function dateKey(v: unknown): string { const s = str(v, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s)
    invalid('日期不正确'); return s; }
export function instant(v: unknown): string { const s = str(v, 40); if (!/^\d{4}-\d\d-\d\dT/.test(s) || !Number.isFinite(Date.parse(s)))
    invalid('时间不正确'); return s; }
export function normalizeNumber(v: string): string | null { const s = v.replace(/[\s()\-]/g, ''); if (!/^\+?[0-9*#]{2,100}$/.test(s) || /^0+$/.test(s))
    return null; return s; }
export function parseSnapshotMeta(v: unknown): SnapshotMeta {
    const o = exact(v, ['schemaVersion', 'kind', 'window', 'fromDate', 'throughDate', 'scannedAt', 'minObservedAt', 'maxObservedAt', 'rowCount', 'pageCount']);
    if (o.schemaVersion !== 1 || !['contacts', 'calls', 'sms'].includes(String(o.kind)) || ![30, 90, 'all'].includes(o.window as Window))
        invalid();
    const throughDate = dateKey(o.throughDate), fromDate = o.fromDate === null ? null : dateKey(o.fromDate), kind = o.kind as Kind;
    if (o.window === 'all') {
        if (fromDate !== null)
            invalid();
    }
    else if (kind !== 'contacts') {
        const expected = new Date(Date.parse(throughDate) - (Number(o.window) - 1) * 86400000).toISOString().slice(0, 10);
        if (fromDate !== expected)
            invalid('统计窗口不匹配');
    }
    const rowCount = integer(o.rowCount, 200000), pageCount = integer(o.pageCount, 200000);
    if ((rowCount === 0 && pageCount !== 0) || (rowCount > 0 && (pageCount < Math.ceil(rowCount / 500) || pageCount > rowCount)))
        invalid('批次数量不匹配');
    const scannedAt = instant(o.scannedAt);
    if (new Date(Date.parse(scannedAt) + 8 * 3600000).toISOString().slice(0, 10) !== throughDate)
        invalid('扫描日期不匹配');
    const minObservedAt = o.minObservedAt === null ? null : instant(o.minObservedAt), maxObservedAt = o.maxObservedAt === null ? null : instant(o.maxObservedAt);
    if ((minObservedAt === null) !== (maxObservedAt === null) || (minObservedAt && maxObservedAt && Date.parse(minObservedAt) > Date.parse(maxObservedAt)))
        invalid();
    return { schemaVersion: 1, kind, window: o.window as Window, fromDate, throughDate, scannedAt, minObservedAt, maxObservedAt, rowCount, pageCount };
}
export function rowKey(kind: Kind, row: Row): string { return kind === 'contacts' ? (row as Contact).id : JSON.stringify([(row as CallDay).date, (row as CallDay).key]); }
export function parseRows(kind: Kind, v: unknown): Row[] {
    if (!Array.isArray(v) || v.length > 500)
        invalid('每页最多 500 行');
    const seen = new Set<string>();
    return v.map(raw => {
        let row: Row;
        if (kind === 'contacts') {
            const o = exact(raw, ['id', 'name', 'phones']);
            const id = str(o.id, 300);
            if (!id || !Array.isArray(o.phones) || o.phones.length > MAX_PHONES_PER_CONTACT)
                invalid();
            const keys = new Set<string>();
            row = { id, name: str(o.name), phones: o.phones.map(p => { const a = exact(p, ['key', 'number', 'label']); const number = str(a.number, 100), key = str(a.key, 100); if (!key || normalizeNumber(number) !== key || keys.has(key))
                    invalid('号码关联不正确'); keys.add(key); return { key, number, label: str(a.label) }; }) };
        }
        else {
            const counts = kind === 'calls' ? ['incoming', 'outgoing', 'missed', 'rejected', 'other', 'incomingSeconds', 'outgoingSeconds'] : ['received', 'sent'];
            const o = exact(raw, ['date', 'key', ...counts]);
            const key = str(o.key, 100);
            if (key !== '@private' && normalizeNumber(key) !== key)
                invalid('号码不正确');
            const values = Object.fromEntries(counts.map(k => [k, integer(o[k])]));
            row = { date: dateKey(o.date), key, ...values } as unknown as Row;
        }
        const key = rowKey(kind, row);
        if (seen.has(key))
            invalid('重复数据');
        seen.add(key);
        return row;
    });
}
