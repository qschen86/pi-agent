import type { Hono } from "hono";

/**
 * 慢请求与事件循环停顿的带时间戳日志。
 *
 * 现场问题：浏览器报「读取超时」时，服务端日志没有时间戳，也没有耗时，无法分辨是服务端卡住、
 * 部署切换窗口，还是公网链路的问题。这里只记粗粒度信息：时间、方法、归一化路由、状态码、耗时。
 * 不含查询串、游标、资源 ID、Cookie 或正文。
 */
export type DiagnosticLog = (line: string) => void;
const defaultLog: DiagnosticLog = (line) => console.warn(line);

/** 把路径里像 ID 的片段（长字符串 / 含数字的 token）换成 :id，保证日志里没有资源标识。 */
export function routeShape(pathname: string): string {
  return pathname.replace(/^(\/api\/auth\/device-pairs)\/[^/]+(?=\/|$)/, "$1/:id").split("/").map((part) => (part && /^(?=.*\d)[A-Za-z0-9_-]{12,}$/.test(part) ? ":id" : part)).join("/");
}

/** 超过阈值的 /api 请求记一行。实时流等长连接按「响应头返回」计，不受影响。 */
export function mountSlowRequestLog(app: Hono, options: { thresholdMs?: number; log?: DiagnosticLog; now?: () => number; onSlow?: (e: { method: string; path: string; status: number; ms: number; requestId?: string | undefined }) => void } = {}): void {
  const threshold = options.thresholdMs ?? 1000, log = options.log ?? defaultLog, now = options.now ?? (() => performance.now());
  app.use("/api/*", async (c, next) => {
    const start = now();
    try { await next(); }
    finally {
      const elapsed = now() - start;
      if (elapsed >= threshold) {
        const path = routeShape(new URL(c.req.url).pathname);
        // 请求 ID 由诊断中间件写入（V1.4 §3.1）：前端同一请求的失败记录能和这一行对上
        const requestId = c.get("requestId" as never) as string | undefined;
        log(`[slow-request] ${new Date().toISOString()} ${c.req.method} ${path} status=${c.res?.status ?? 0} ms=${Math.round(elapsed)}${requestId ? ` rid=${requestId}` : ""} slot=${process.env["PI_AGENT_WEB_SLOT"] ?? "-"} pid=${process.pid}`);
        try { options.onSlow?.({ method: c.req.method, path, status: c.res?.status ?? 0, ms: elapsed, requestId }); } catch { /* 诊断失败不影响请求 */ }
      }
    }
  });
}

/**
 * 事件循环停顿监测：定时器本该 intervalMs 触发，实际晚了超过 thresholdMs 就记一行。
 * 同步读写大文件、JSON 解析等会让整个服务（含所有读取）一起停住，这里能看到它发生的时刻和时长。
 * 定时器 unref，不影响进程退出；同一秒内最多记一行，避免刷屏。
 */
export function startEventLoopLagMonitor(options: { thresholdMs?: number; intervalMs?: number; log?: DiagnosticLog; onLag?: (lagMs: number) => void } = {}): () => void {
  const threshold = options.thresholdMs ?? 500, interval = options.intervalMs ?? 100, log = options.log ?? defaultLog;
  let expected = Date.now() + interval, lastLogged = 0;
  const timer = setInterval(() => {
    const at = Date.now(), lag = at - expected;
    expected = at + interval;
    if (lag >= threshold && at - lastLogged >= 1000) {
      lastLogged = at;
      log(`[event-loop-lag] ${new Date(at).toISOString()} lagMs=${Math.round(lag)} slot=${process.env["PI_AGENT_WEB_SLOT"] ?? "-"} pid=${process.pid}`);
      try { options.onLag?.(lag); } catch { /* 诊断失败不影响服务 */ }
    }
  }, interval);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * 根文档导航日志。
 *
 * 现场问题：手机上「杀掉 PWA 再打开一次」在诊断日志里是空白——上面只记 `/api/*`，
 * 文档请求（含用 app shell 时的后台回源）从来不记，于是「这次是缓存秒开还是等网络」
 * 只能靠猜。这里每个文档导航记一行，只带路径 `/`、状态、耗时和请求目的，不含查询串。
 * 首屏多少毫秒、是不是从 app shell 启动，由页面自己的 `[launch]` 上报说明（见 launchTimingLine）。
 */
export function mountDocumentLog(app: Hono, options: { log?: DiagnosticLog; now?: () => number } = {}): void {
  const log = options.log ?? defaultLog, now = options.now ?? (() => performance.now());
  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" || new URL(c.req.url).pathname !== "/") { await next(); return; }
    const start = now();
    try { await next(); }
    finally {
      const elapsed = now() - start;
      log(`[document] ${new Date().toISOString()} GET / status=${c.res?.status ?? 0} ms=${Math.round(elapsed)}` +
        ` dest=${c.req.header("sec-fetch-dest") ?? "-"} slot=${process.env["PI_AGENT_WEB_SLOT"] ?? "-"} pid=${process.pid}`);
    }
  });
}

/**
 * 页面上报的一次启动：字段固定、全部有界，不含 UA / IP / URL。
 * 返回要写进日志的一行（JSON），格式不对时返回 null（调用方回 400，不落日志）。
 */
export function launchTimingLine(
  input: unknown, now: () => Date = () => new Date(), meta: { slot?: string; pid?: number } = {}
): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const digest = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
  const millis = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0 && x <= 600_000;
  if (!digest(value["release"])) return null;
  if (value["shell"] !== null && !digest(value["shell"])) return null;
  if (!millis(value["ttfbMs"]) || !millis(value["dclMs"])) return null;
  const fcp = value["fcpMs"];
  if (fcp !== null && !millis(fcp)) return null;
  const effectiveType = typeof value["effectiveType"] === "string" && /^(slow-2g|2g|3g|4g)$/.test(value["effectiveType"]) ? value["effectiveType"] : null;
  return JSON.stringify({
    ...(typeof value["pageInstanceId"] === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value["pageInstanceId"]) ? { page_instance_id: value["pageInstanceId"] } : {}),
    at: now().toISOString(), release: value["release"], shell: value["shell"] ?? null,
    ttfbMs: value["ttfbMs"], fcpMs: fcp ?? null, dclMs: value["dclMs"],
    online: value["online"] !== false, effectiveType, saveData: value["saveData"] === true,
    slot: meta.slot ?? process.env["PI_AGENT_WEB_SLOT"] ?? "-", pid: meta.pid ?? process.pid
  });
}
