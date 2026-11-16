import { Hono } from 'hono';
import type { Context } from 'hono';
import type { CommunicationsStore } from './communications-store.js';
import { CommunicationsError, exact, object, str, integer } from './communications-types.js';
export interface CommunicationsAccess {
    reader(c: Context): boolean;
    device(c: Context): string | undefined;
}
async function body(c: Context, fields: string[]) { const reader = c.req.raw.body?.getReader(); let size = 0; const parts: Uint8Array[] = []; if (reader)
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > 524288) {
                await reader.cancel();
                throw new CommunicationsError('同步页过大', 'COMMUNICATIONS_TOO_LARGE', 413);
            }
            parts.push(value);
        }
    }
    finally {
        reader.releaseLock();
    } try {
    return exact(JSON.parse(Buffer.concat(parts).toString('utf8')), fields);
}
catch (e) {
    if (e instanceof CommunicationsError)
        throw e;
    throw new CommunicationsError('请求不是合法 JSON');
} }
export function mountCommunicationsRoutes(app: Hono, store: CommunicationsStore, access: CommunicationsAccess) {
    const routes = new Hono();
    routes.onError((e, c) => { c.header('Cache-Control', 'private, no-store'); return e instanceof CommunicationsError ? c.json({ error: e.message, code: e.code }, e.status) : c.json({ error: '通讯数据操作失败，请稍后重试', code: 'COMMUNICATIONS_STORAGE' }, 500); });
    routes.use('/api/communications/*', async (c, next) => { c.header('Cache-Control', 'private, no-store'); await next(); });
    const read = (c: Context) => { if (!access.reader(c))
        throw new CommunicationsError('请先配置登录并连接设备', 'COMMUNICATIONS_LOGIN_REQUIRED', 401); };
    const device = (c: Context) => { const id = access.device(c); if (!id)
        throw new CommunicationsError('请使用已配对的 Android 设备', 'COMMUNICATIONS_DEVICE_REQUIRED', 401); return id; };
    routes.get('/api/communications/devices', c => { read(c); return c.json({ devices: store.devices() }); });
    routes.post('/api/communications/sync/enable', c => c.json(store.enable(device(c))));
    routes.post('/api/communications/sync/stop', c => c.json(store.stop(device(c))));
    routes.post('/api/communications/sync/status', async (c) => { device(c); const b = await body(c, ['epoch', 'kind', 'state', 'errorCode']); return c.json(store.updateStatus(device(c), str(b.epoch, 100), str(b.kind, 20), str(b.state, 20), b.errorCode)); });
    routes.post('/api/communications/sync/begin', async (c) => { device(c); const b = await body(c, ['epoch', 'requestId', 'meta']); return c.json(store.begin(device(c), str(b.epoch, 100), str(b.requestId, 100), b.meta)); });
    routes.put('/api/communications/sync/batches/:batchId/pages/:page', async (c) => { device(c); const b = await body(c, ['rows']); const page = c.req.param('page'); if (!/^\d{1,6}$/.test(page))
        throw new CommunicationsError('页号不正确'); return c.json(store.putPage(device(c), c.req.param('batchId'), Number(page), b.rows)); });
    routes.post('/api/communications/sync/batches/:batchId/commit', c => c.json(store.commit(device(c), c.req.param('batchId'))));
    routes.get('/api/communications/contacts', c => { read(c); const q = c.req.query(); if (q.cursor && q.cursor.length > 2048)
        throw new CommunicationsError('分页标识过长'); return c.json(store.contacts({ deviceId: q.deviceId ?? '', q: q.q ? str(q.q, 200) : '', cursor: q.cursor, limit: q.limit === undefined ? 50 : integer(Number(q.limit), 100) })); });
    routes.get('/api/communications/stats', c => { read(c); const q = c.req.query(); return c.json(store.stats({ deviceId: q.deviceId ?? '', from: q.from, through: q.through, numberKey: q.numberKey ? str(q.numberKey, 100) : undefined })); });
    routes.delete('/api/communications/devices/:deviceId/data', c => { read(c); return c.json(store.deleteData(c.req.param('deviceId'))); });
    app.route('/', routes);
}
