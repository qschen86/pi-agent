import { createHash } from 'node:crypto';
import type { DeviceData } from './communications-store.js';
import { CommunicationsError, dateKey, integer, type CallDay, type SmsDay, type Contact } from './communications-types.js';
export interface Query {
    deviceId?: string;
    from?: string;
    through?: string;
    numberKey?: string;
    q?: string;
    cursor?: string;
    limit?: number;
}
function select(all: DeviceData[], q: Query) { if (q.from)
    dateKey(q.from); if (q.through)
    dateKey(q.through); if (q.from && q.through && q.from > q.through)
    throw new CommunicationsError('起止日期不正确'); return all.filter(d => q.deviceId === 'all' || d.deviceId === q.deviceId); }
function revision(ds: DeviceData[]) { return createHash('sha256').update(JSON.stringify(ds.map(d => [d.deviceId, d.revision]))).digest('hex'); }
export function queryContacts(all: DeviceData[], q: Query) {
    const ds = select(all, q), rev = revision(ds);
    const signature = JSON.stringify([q.deviceId, q.q ?? '', q.limit ?? 50]);
    let offset = 0;
    if (q.cursor) {
        try {
            const c = JSON.parse(Buffer.from(q.cursor, 'base64url').toString());
            if (c.rev !== rev || c.signature !== signature)
                throw Error();
            offset = integer(c.offset);
        }
        catch {
            throw new CommunicationsError('通讯录已更新，请重新加载', 'COMMUNICATIONS_CURSOR', 409);
        }
    }
    const limit = integer(q.limit ?? 50, 100);
    if (limit < 1)
        throw new CommunicationsError('页大小不正确');
    const items = ds.flatMap(d => (d.snapshots.contacts?.rows as Contact[] ?? []).map(c => ({ ...c, deviceId: d.deviceId }))).filter(c => !q.q || c.name.includes(q.q) || c.phones.some(p => p.number.includes(q.q!) || p.key.includes(q.q!))).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id));
    const end = offset + limit;
    return { items: items.slice(offset, end), total: items.length, revision: rev, nextCursor: end < items.length ? Buffer.from(JSON.stringify({ rev, signature, offset: end })).toString('base64url') : null };
}
export function queryStats(all: DeviceData[], q: Query) {
    const ds = select(all, q);
    const totals = { contacts: 0, numbers: 0, incoming: 0, outgoing: 0, missed: 0, rejected: 0, other: 0, incomingSeconds: 0, outgoingSeconds: 0, received: 0, sent: 0 };
    const days = new Map<string, typeof totals>();
    const ranks = new Map<string, {
        key: string;
        deviceId: string;
        names: string[];
        calls: number;
        seconds: number;
        received: number;
        sent: number;
    }>();
    const coverage: Record<string, unknown> = {};
    for (const d of ds) {
        const contacts = (d.snapshots.contacts?.rows ?? []) as Contact[];
        totals.contacts += contacts.length;
        totals.numbers += contacts.reduce((n, c) => n + c.phones.length, 0);
        coverage[d.deviceId] = Object.fromEntries(['contacts', 'calls', 'sms'].filter(k => d.snapshots[k as keyof typeof d.snapshots] || d.statuses?.[k as keyof typeof d.statuses]).map(k => { const s = d.snapshots[k as keyof typeof d.snapshots]; return [k, { ...(s?.meta ?? {}), ...(d.statuses?.[k as keyof typeof d.statuses] ?? { state: 'unknown' }), lastSuccess: s?.lastSuccess ?? null, collectedAtByDate: s?.collectedAtByDate ?? {}, retainedFrom: s?.rows.length && k !== 'contacts' ? s.rows.reduce((a, r) => a < (r as CallDay).date ? a : (r as CallDay).date, '9999-12-31') : null }]; }));
        const names = new Map<string, Set<string>>();
        for (const c of contacts)
            for (const p of c.phones) {
                if (!names.has(p.key))
                    names.set(p.key, new Set());
                if (c.name)
                    names.get(p.key)!.add(c.name);
            }
        for (const kind of ['calls', 'sms'] as const)
            for (const raw of d.snapshots[kind]?.rows ?? []) {
                const r = raw as CallDay & SmsDay;
                if ((q.from && r.date < q.from) || (q.through && r.date > q.through) || (q.numberKey && r.key !== q.numberKey))
                    continue;
                const day = days.get(r.date) ?? { ...totals, contacts: 0, numbers: 0, incoming: 0, outgoing: 0, missed: 0, rejected: 0, other: 0, incomingSeconds: 0, outgoingSeconds: 0, received: 0, sent: 0 };
                days.set(r.date, day);
                const key = JSON.stringify([d.deviceId, r.key]);
                const rank = ranks.get(key) ?? { key: r.key, deviceId: d.deviceId, names: [...(names.get(r.key) ?? [])], calls: 0, seconds: 0, received: 0, sent: 0 };
                ranks.set(key, rank);
                for (const field of kind === 'calls' ? ['incoming', 'outgoing', 'missed', 'rejected', 'other', 'incomingSeconds', 'outgoingSeconds'] as const : ['received', 'sent'] as const) {
                    totals[field] += r[field];
                    day[field] += r[field];
                    if (!Number.isSafeInteger(totals[field]))
                        throw new CommunicationsError('统计超出安全整数范围');
                }
                if (kind === 'calls') {
                    rank.calls += r.incoming + r.outgoing + r.missed + r.rejected + r.other;
                    rank.seconds += r.incomingSeconds + r.outgoingSeconds;
                }
                else {
                    rank.received += r.received;
                    rank.sent += r.sent;
                }
            }
    }
    return { totals, days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, values]) => ({ date, ...values })), rankings: [...ranks.values()].sort((a, b) => b.calls - a.calls || b.received + b.sent - a.received - a.sent || a.key.localeCompare(b.key)).slice(0, 20), coverage, revision: revision(ds), aggregation: q.deviceId === 'all' ? 'device-sum' : 'single-device' };
}
