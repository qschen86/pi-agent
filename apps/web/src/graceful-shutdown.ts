import type { Server } from "node:http";

/**
 * 优雅关停 HTTP 服务：
 * 1. 触发 shutdown 信号，让长连接（SSE）主动收尾；
 * 2. 停止接受新连接并在途请求继续返回，同时持续回收刚变成空闲的 keep-alive 连接；
 * 3. 超过 graceMs 仍有连接没结束才强制断开。
 *
 * 不这样做，SIGTERM 后直接退出会把在途响应截断，反向代理记 "context canceled"，
 * 浏览器看到 502 / 「读取失败」。返回值是幂等的关停函数，可直接注册到 SIGTERM/SIGINT。
 */
export function createGracefulShutdown(server: Server, options: {
  shutdown: AbortController;
  graceMs: number;
  onFinish: () => void;
}): () => void {
  let stopping = false, finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined, sweep: ReturnType<typeof setInterval> | undefined;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (sweep) clearInterval(sweep);
    if (timer) clearTimeout(timer);
    options.onFinish();
  };
  return () => {
    if (stopping) return;
    stopping = true;
    options.shutdown.abort();
    server.close();
    server.closeIdleConnections?.();
    // 连接是在响应结束之后才变成空闲的：持续回收，避免为了等 keep-alive 拖满整个 grace。
    sweep = setInterval(() => server.closeIdleConnections?.(), 50);
    sweep.unref?.();
    timer = setTimeout(() => { try { server.closeAllConnections?.(); } catch { /* 已经没有连接 */ } finish(); }, options.graceMs);
    timer.unref();
    server.once("close", finish);
  };
}
