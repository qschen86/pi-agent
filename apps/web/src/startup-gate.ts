/** 与 @hono/node-server 的 FetchCallback 兼容（该类型未从包根导出）。 */
export type AppFetch = (request: Request, env: unknown) => Response | Promise<Response>;

/**
 * 启动门控：端口一绑定就先对外服务，初始化（读数据、恢复会话、编译路由）期间统一回 503，
 * 就绪后转发到真实 app。
 *
 * 目的：重启时旧进程退出、新进程还没 listen 的这段时间，反向代理和浏览器会撞到
 * connection refused（502）。先绑定端口后，这段时间变成可重试的 503，桥接一次部署重启。
 */
export function createStartupGate(): { fetch: AppFetch; ready: (fetch: AppFetch) => void } {
  let app: AppFetch | undefined;
  return {
    fetch: (request, env) =>
      app
        ? app(request, env)
        : new Response(JSON.stringify({ error: "服务正在启动，请稍后重试", code: "STARTING" }), {
            status: 503,
            headers: { "content-type": "application/json; charset=UTF-8", "retry-after": "1", "cache-control": "no-store" }
          }),
    ready: (fetch) => { app = fetch; }
  };
}
