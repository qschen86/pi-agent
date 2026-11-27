import type { Hono, Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import type { AuthSessions } from './auth-sessions.js';
import { DevicePairing, PairingError } from './device-pairing.js';

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function anonymousDevicePairRequest(method: string, path: string): boolean {
  return method === 'POST' && (path === '/api/auth/device-pairs' || /^\/api\/auth\/device-pairs\/[a-f0-9]{32}\/token$/.test(path));
}
export function mountDevicePairRoutes(app: Hono, auth: AuthSessions, file: string): void {
  const pairs = new DevicePairing({ file, auth });
  app.use('/api/auth/device-pairs/*', bodyLimit({ maxSize: 4096 }));
  app.use('/api/auth/device-pairs', bodyLimit({ maxSize: 4096 }));
  const run = async (c: Context, fn: () => Response | Promise<Response>) => {
    c.header('Cache-Control', 'private, no-store'); c.header('Referrer-Policy', 'no-referrer');
    try { return await fn(); }
    catch (e) {
      if (e instanceof PairingError) { if (e.status === 429) c.header('Retry-After', '60'); return c.json({ error: e.code, code: e.code }, e.status); }
      if (e instanceof SyntaxError || e instanceof TypeError) return c.json({ error: 'PAIR_INPUT', code: 'PAIR_INPUT' }, 400);
      // Fail closed without exposing credentials, pairing IDs or filesystem details.
      return c.json({ error: '设备配对暂不可用，请稍后重试', code: 'PAIR_UNAVAILABLE' }, 503);
    }
  };
  app.post('/api/auth/device-pairs', c => run(c, async () => {
    const input = await c.req.json();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PairingError(400, 'PAIR_INPUT');
    const source = c.req.header('cf-connecting-ip') ?? 'shared-entry';
    const pair = pairs.start(input, source);
    return c.json({ ...pair, verificationUri: `/device-pair?id=${pair.pairId}`, intervalSeconds: 3 }, 201);
  }));
  app.post('/api/auth/device-pairs/:id/token', c => run(c, async () => {
    const body = await c.req.json();
    const result = pairs.exchange(c.req.param('id'), body?.proof);
    return result.state === 'ready' ? c.json(result) : c.json(result, result.state === 'pending' ? 202 : 410);
  }));
  app.get('/device-pair', c => run(c, () => {
    // Browser form POST needs its same-origin Origin, including after login.
    c.header('Referrer-Policy', 'same-origin');
    if (c.req.header('authorization') !== undefined || !auth.check(getCookie(c, 'pi_agent_session')) || auth.check(getCookie(c, 'pi_agent_session'))?.kind === 'device') return c.json({ error: '请在浏览器登录后核对设备' }, 403);
    const pair = pairs.view(c.req.query('id') ?? '');
    if (!pair) throw new PairingError(410, 'PAIR_EXPIRED');
    return c.html(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接 Android · pi-agent</title><link rel="stylesheet" href="/styles.css"><main class="login-page"><form class="login-card" method="post" action="/api/auth/device-pairs/${pair.pairId}/approve"><h1>连接 Android 设备</h1><p>设备：${escapeHtml(pair.deviceName)}</p><p>请核对手机显示的六位码：</p><h2>${pair.userCode}</h2><p>仅在你本人刚刚发起连接，且手机核对码相同时批准。设备可获得当前实例允许的公网读取和控制权限，可在登录会话中吊销。</p><button type="submit">核对一致，批准连接</button><p>批准后返回手机完成连接。配对五分钟后过期。</p></form></main></html>`);
  }));
  // 批准、拒绝、列待批准请求都只认「本人登录的浏览器」：设备令牌、跨站请求一律不行。
  const requireBrowser = (c: Context, needSameOrigin: boolean) => {
    const origin = c.req.header('origin'), host = c.req.header('host');
    let same = false;
    try { const url = new URL(origin ?? ''); same = url.host === host && (url.protocol === 'https:' || (url.protocol === 'http:' && /^(localhost|127\.0\.0\.1):\d+$/.test(host ?? ''))); } catch { /* absent origin is not approval */ }
    // 部分浏览器同源 POST 会带 Origin: null，此时以浏览器不可伪造的 Sec-Fetch-Site 为准。
    if (!same && (origin === undefined || origin === 'null') && c.req.header('sec-fetch-site') === 'same-origin') same = true;
    const browser = auth.check(getCookie(c, 'pi_agent_session'));
    if ((needSameOrigin && !same) || !browser || browser.kind === 'device' || c.req.header('authorization') !== undefined) throw new PairingError(403, 'PAIR_BROWSER_REQUIRED');
    return browser;
  };
  app.get('/api/auth/device-pairs/pending', c => run(c, () => {
    requireBrowser(c, false);
    return c.json({ pairs: pairs.pending() });
  }));
  app.post('/api/auth/device-pairs/:id/reject', c => run(c, () => {
    requireBrowser(c, true);
    pairs.reject(c.req.param('id'));
    return c.json({ ok: true });
  }));
  app.post('/api/auth/device-pairs/:id/approve', c => run(c, () => {
    const browser = requireBrowser(c, true);
    pairs.approve(c.req.param('id'), browser.id);
    if ((c.req.header('accept') ?? '').includes('text/html')) return c.html('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>已批准 · pi-agent</title><p>已批准设备连接，请返回手机。</p></html>');
    return c.json({ ok: true });
  }));
}
