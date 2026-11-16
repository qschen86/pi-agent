/**
 * SSE 流的生命周期：连接中断或进程关停（SIGTERM 触发的 AbortSignal）任一发生就结束。
 *
 * 关停时主动结束流，而不是让进程直接退出把连接硬切：硬切会让反向代理记 "context canceled"、
 * 浏览器读到被截断的响应（表现为 502 / 「读取失败」「会话读取失败」）。主动收尾后，
 * 在途的普通请求有机会正常返回，SSE 客户端也能立即重连而不是在重启空窗里反复被拒。
 */
export interface AbortableStream { onAbort(cb: () => void): void }

export function streamLifetime(stream: AbortableStream, shutdown?: AbortSignal): { done: Promise<void>; finish: () => void } {
  let settle = () => {};
  const done = new Promise<void>((resolve) => {
    let settled = false;
    settle = () => {
      if (settled) return;
      settled = true;
      shutdown?.removeEventListener("abort", settle);
      resolve();
    };
    stream.onAbort(settle);
    if (shutdown) { if (shutdown.aborted) settle(); else shutdown.addEventListener("abort", settle, { once: true }); }
  });
  return { done, finish: () => settle() };
}

/** 平滑交接的重连间隔范围（毫秒）：所有手机的流在同一刻被关掉，错开重连，别一起砸向刚启动的新进程。 */
export const HANDOFF_RETRY_MIN_MS = 300;
export const HANDOFF_RETRY_SPAN_MS = 2700;

interface SseWriter { writeSSE(message: { event?: string; data: string; retry?: number }): Promise<void> }

/**
 * 因为进程关停（部署切换）而结束的流，在关闭前告诉客户端「这是计划内交接」：
 * 发一条 handoff 事件，并用 SSE 的 retry 字段给出随机重连间隔（浏览器自带的自动重连会照办）。
 * 客户端据此不把这次断开当故障展示，也不会和别的手机同时重连。
 * 不是关停（例如客户端自己断开）时什么都不做。
 */
export async function announceHandoff(stream: SseWriter, shutdown: AbortSignal | undefined, random: () => number = Math.random): Promise<void> {
  if (!shutdown?.aborted) return;
  const retryMs = HANDOFF_RETRY_MIN_MS + Math.floor(random() * HANDOFF_RETRY_SPAN_MS);
  try { await stream.writeSSE({ event: "handoff", data: JSON.stringify({ retryMs }), retry: retryMs }); } catch { /* 连接已经断了：没有人需要通知 */ }
}
