import { serve } from '@hono/node-server';
import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import { isPrivateIPv4 } from './lan-probe.js';

/**
 * V3.53 局域网直连（docs/requirements/v3.52-lan-direct-detection）。
 *
 * 在 0.0.0.0:<port> 提供与对外入口同一个应用的明文 HTTP 入口，只给家里局域网里的 Android App 用。
 * 它不是新的应用，只是前面的一道门：
 *  - 只接受私网来源（10/8、172.16/12、192.168/16）：路由器端口转发、公网来源一律 403；
 *  - 必须带设备凭据（Authorization: Bearer 或设备 Cookie），没有就 401：不会出现「Host 不是对外域名所以当成本机、免登录」；
 *  - 客户端自带的转发头全部丢弃，再由这里把请求改写成对外入口的形态（Host 换成本机端口、同源 Origin 换成本机 Origin），
 *    之后的鉴权、权限、读写都与经公网访问完全相同——权限不会比公网更大。
 * 明文 HTTP：同一 Wi-Fi 里的人能看到设备令牌和会话内容，这是用户明确选择的取舍（见需求文档）。
 */
export const DEFAULT_LAN_APP_PORT = 8782;
/** 与 server.ts 的 DEVICE_SESSION_COOKIE 一致（测试里对照源码，防止改名后这里失效）。 */
export const DEVICE_COOKIE = 'pi_agent_device_session';

export function lanAppPort(env: Record<string, string | undefined>): number | undefined {
  const raw = env['PI_AGENT_LAN_APP_PORT']?.trim();
  if (raw === undefined || raw === '') return DEFAULT_LAN_APP_PORT;
  if (raw.toLowerCase() === 'off' || raw === '0') return undefined;
  const port = Number(raw);
  return Number.isInteger(port) && port > 1023 && port < 65536 ? port : DEFAULT_LAN_APP_PORT;
}

/** 连接对端是不是私网 IPv4（含 IPv4 映射的 IPv6 写法 ::ffff:192.168.x.x）。 */
export function isPrivatePeer(address: string | undefined): boolean {
  if (!address) return false;
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  return isPrivateIPv4(v4);
}

const STRIP = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'true-client-ip'];

function hasCredential(headers: Headers): boolean {
  const authorization = headers.get('authorization');
  if (authorization !== null && /^Bearer\s+\S+$/i.test(authorization)) return true;
  const cookie = headers.get('cookie') ?? '';
  return cookie.split(';').some((part) => { const [name, ...value] = part.trim().split('='); return name === DEVICE_COOKIE && value.join('=').length > 0; });
}

export interface GatewayOptions {
  /** 应用本身的端口：Host 改写成 127.0.0.1:<端口>，让应用现有的 Host/Origin 白名单照常工作。 */
  appPort: number;
  /** 读取连接对端地址；默认取 Node 的 socket。 */
  peer?: (env: unknown) => string | undefined;
}

type Fetch = (request: Request) => Response | Promise<Response>;

export function createLanGateway(app: Fetch, options: GatewayOptions): (request: Request, env?: unknown) => Promise<Response> {
  const peerOf = options.peer ?? ((env: unknown) => (env as { incoming?: IncomingMessage } | undefined)?.incoming?.socket?.remoteAddress);
  const deny = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  return async (request, env) => {
    if (!isPrivatePeer(peerOf(env))) return deny(403, '只接受局域网内的连接');
    const headers = new Headers(request.headers);
    for (const name of STRIP) headers.delete(name);
    if (!hasCredential(headers)) return deny(401, '请先连接设备');
    const incomingHost = headers.get('host') ?? '';
    const url = new URL(request.url);
    const local = `127.0.0.1:${options.appPort}`;
    headers.set('host', local);
    const origin = headers.get('origin');
    // 只有「就是这个局域网入口自己」的同源请求才改写成本机 Origin；别的来源原样交给应用的跨站检查拒绝。
    if (origin !== null && origin === `http://${incomingHost}`) headers.set('origin', `http://${local}`);
    const target = `http://${local}${url.pathname}${url.search}`;
    const init: RequestInit & { duplex?: 'half' } = { method: request.method, headers, redirect: 'manual', signal: request.signal };
    if (request.method !== 'GET' && request.method !== 'HEAD') { init.body = request.body; init.duplex = 'half'; }
    return app(new Request(target, init));
  };
}

export interface LanApp { close(): void; listening(): boolean }

/** 在 0.0.0.0:port 开局域网入口；端口被旧槽位占着就隔一会儿重试，其它错误只记日志，不影响主服务。 */
export function startLanApp(options: { port: number; appPort: number; fetch: Fetch; host?: string; retryMs?: number; log?: (m: string) => void; peer?: GatewayOptions['peer'] }): LanApp {
  const log = options.log ?? ((m) => console.warn(m));
  const gateway = createLanGateway(options.fetch, { appPort: options.appPort, ...(options.peer ? { peer: options.peer } : {}) });
  let server: Server | undefined, timer: NodeJS.Timeout | undefined, closed = false, up = false;
  const attempt = () => {
    if (closed) return;
    const s = serve({ fetch: gateway as never, port: options.port, hostname: options.host ?? '0.0.0.0' }) as Server;
    s.on('listening', () => { up = true; });
    s.on('error', (e: NodeJS.ErrnoException) => {
      up = false;
      try { s.close(); } catch { /* 没监听 */ }
      if (closed) return;
      if (e.code !== 'EADDRINUSE') log(`[lan-app] 局域网入口不可用：${e.message}`);
      timer = setTimeout(attempt, options.retryMs ?? 20000); timer.unref();
    });
    server = s;
  };
  attempt();
  return { listening: () => up, close: () => { closed = true; up = false; if (timer) clearTimeout(timer); try { server?.close(); (server as Server | undefined)?.closeAllConnections(); } catch { /* 已关 */ } } };
}
