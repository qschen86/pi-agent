import { createServer, type Server } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { dirname, join } from 'node:path';
import type { Context, Hono } from 'hono';

/**
 * V3.52 局域网直连识别（docs/requirements/v3.52-lan-direct-detection）。
 *
 * 一个只回答「这台实例在不在你身边」的探针：监听 0.0.0.0 的固定端口，GET /api/lan/ping?n=<随机数> 只返回
 * HMAC(key, n)。key 只通过已登录的 /api/android/network 发给手机，局域网里没有 key 的人既不能冒充，也读不到任何数据。
 * 不改变现有任何连接路径：应用流量仍走原来的 HTTPS 入口。
 */
export const DEFAULT_PROBE_PORT = 8781;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

export interface LanCandidate { address: string; prefix: number }

/** 探针端口：PI_AGENT_LAN_PROBE_PORT 设成 off / 0 关闭；非法值回落到默认端口。 */
export function probePort(env: Record<string, string | undefined>): number | undefined {
  const raw = env['PI_AGENT_LAN_PROBE_PORT']?.trim();
  if (raw === undefined || raw === '') return DEFAULT_PROBE_PORT;
  if (raw.toLowerCase() === 'off' || raw === '0') return undefined;
  const port = Number(raw);
  return Number.isInteger(port) && port > 1023 && port < 65536 ? port : DEFAULT_PROBE_PORT;
}

export function isPrivateIPv4(address: string): boolean {
  const p = address.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return p[0] === 10 || (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) || (p[0] === 192 && p[1] === 168);
}

// 隧道、虚拟机、容器、AirDrop 一类接口的地址不是手机能到达的局域网。
const VIRTUAL = /^(lo|utun|awdl|llw|bridge|vmenet|vnic|docker|veth|gif|stf|anpi|ap)\d*$/i;

/** 本机可作为局域网入口的私网 IPv4 地址（含前缀长度），去重、按接口顺序。 */
export function lanCandidates(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): LanCandidate[] {
  const out: LanCandidate[] = [];
  for (const [name, list] of Object.entries(interfaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal || !isPrivateIPv4(info.address)) continue;
      const prefix = Number(info.cidr?.split('/')[1]);
      if (!Number.isInteger(prefix) || prefix < 8 || prefix > 30) continue;
      if (!out.some((c) => c.address === info.address)) out.push({ address: info.address, prefix });
    }
  }
  return out;
}

export function proofFor(key: string, nonce: string): string {
  return createHmac('sha256', Buffer.from(key, 'hex')).update(nonce).digest('hex');
}

/** 数据目录里的探针密钥：缺就生成（0600），各槽位共用同一份，部署切换不换密钥。 */
export function loadProbeKey(dataDir: string): string {
  const file = join(dataDir, 'lan-probe.json');
  try {
    const key = (JSON.parse(readFileSync(file, 'utf8')) as { key?: unknown }).key;
    if (typeof key === 'string' && /^[a-f0-9]{64}$/.test(key)) return key;
  } catch { /* 缺或坏：重新生成 */ }
  const key = randomBytes(32).toString('hex');
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ key }), { mode: 0o600 });
  try {
    // 硬链接是「文件不存在才创建」：两个槽位同时第一次启动，谁先落盘谁赢，后到的读回已有的那份。
    linkSync(temp, file);
    return key;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    try { const existing = (JSON.parse(readFileSync(file, 'utf8')) as { key?: unknown }).key; if (typeof existing === 'string' && /^[a-f0-9]{64}$/.test(existing)) return existing; } catch { /* 坏文件：覆盖 */ }
    renameSync(temp, file);
    return key;
  } finally { try { unlinkSync(temp); } catch { /* 已改名 */ } }
}

export function pingResponse(key: string, url: string): { status: number; body: Record<string, unknown> } {
  const u = new URL(url, 'http://probe.local');
  if (u.pathname !== '/api/lan/ping') return { status: 404, body: { error: 'not found' } };
  const nonce = u.searchParams.get('n') ?? '';
  if (!NONCE.test(nonce)) return { status: 400, body: { error: 'bad nonce' } };
  return { status: 200, body: { service: 'pi-agent-lan', proof: proofFor(key, nonce) } };
}

export function proofMatches(key: string, nonce: string, proof: string): boolean {
  const a = Buffer.from(proofFor(key, nonce)), b = Buffer.from(proof);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface LanProbe { close(): void; listening(): boolean }

/**
 * 在 0.0.0.0:port 开探针。蓝绿部署时新旧槽位会短暂同时存在：端口被占就隔一会儿重试，旧槽位退出后由新槽位接手。
 * 其它错误只记日志，探针不可用不影响主服务。
 */
export function startLanProbe(options: { port: number; key: string; host?: string; retryMs?: number; log?: (m: string) => void }): LanProbe {
  const host = options.host ?? '0.0.0.0';
  const log = options.log ?? ((m) => console.warn(m));
  let server: Server | undefined, timer: NodeJS.Timeout | undefined, closed = false, up = false;
  const attempt = () => {
    if (closed) return;
    const s = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json');
      if (req.method !== 'GET') { res.statusCode = 405; res.end('{"error":"method"}'); return; }
      const r = pingResponse(options.key, req.url ?? '/');
      res.statusCode = r.status; res.end(JSON.stringify(r.body));
    });
    s.headersTimeout = 5000; s.requestTimeout = 5000; s.keepAliveTimeout = 1000; s.maxHeadersCount = 40;
    s.on('error', (e: NodeJS.ErrnoException) => {
      up = false;
      try { s.close(); } catch { /* 没监听 */ }
      if (closed) return;
      if (e.code !== 'EADDRINUSE') log(`[lan-probe] 局域网探针不可用：${e.message}`);
      timer = setTimeout(attempt, options.retryMs ?? 20000); timer.unref();
    });
    s.listen(options.port, host, () => { up = true; });
    server = s;
  };
  attempt();
  return { listening: () => up, close: () => { closed = true; up = false; if (timer) clearTimeout(timer); try { server?.close(); server?.closeAllConnections(); } catch { /* 已关 */ } } };
}

/** 已登录设备读取：本机的局域网候选地址 + 探针端口 + 验证密钥。 */
export function mountLanNetworkRoute(app: Hono, options: { canRead: (c: Context) => boolean; key: string; port: number | undefined; appPort?: number | undefined; interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]> }): void {
  app.get('/api/android/network', (c) => {
    c.header('Cache-Control', 'private, no-store');
    if (!options.canRead(c)) return c.json({ error: '请先登录并启用会话读取权限' }, 401);
    if (options.port === undefined) return c.json({ enabled: false });
    return c.json({ enabled: true, port: options.port, ...(options.appPort !== undefined ? { appPort: options.appPort } : {}), key: options.key, candidates: lanCandidates(options.interfaces?.()) });
  });
}
