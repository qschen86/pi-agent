import type { Hono, Context } from "hono";
import { PushStorageBusyError, type WebPushService } from "./web-push.js";
// 推送存储忙是部署互斥造成的瞬时状态：告诉页面稍后重试，别落进通用 500 或误报成参数错误。
function retryLater(c: Context, body: Record<string, unknown>) {
  c.header("Retry-After", "2");
  return c.json({ error: "推送存储忙，请稍后重试", retry: true, ...body }, 503);
}
export function mountNotificationRoutes(app: Hono, push: WebPushService, ctx: {
  owner: (c: Context) => string | undefined;
  isPublic: (c: Context) => boolean;
  canRead: (c: Context) => boolean;
}): void {
  app.use("/api/notifications/*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    if (!ctx.owner(c)) return c.json({ error: "请先登录" }, 401);
    if (!ctx.canRead(c)) return c.json({ error: "未启用会话查看权限" }, 403);
    await next();
  });
  app.get("/api/notifications/capabilities", c => c.json({ supported: true, publicKey: push.publicKey }));
  app.get("/api/notifications/device", c => {
    try { return c.json(push.status(ctx.owner(c)!, c.req.query("id") ?? "", { subscribed: false })); }
    catch (error) {
      if (error instanceof PushStorageBusyError) return retryLater(c, { subscribed: false });
      throw error;
    }
  });
  app.put("/api/notifications/device", async c => {
    try {
      const body = await c.req.json();
      const id = push.subscribe(ctx.owner(c)!, ctx.isPublic(c), body.subscription, body.preferences ?? {});
      return c.json({ id, ...push.status(ctx.owner(c)!, id) });
    } catch (error) { return c.json({ error: (error as Error).message }, 400); }
  });
  app.delete("/api/notifications/device", async c => {
    const body = await c.req.json().catch(() => ({}));
    push.unsubscribe(ctx.owner(c)!, typeof body.id === "string" ? body.id : "");
    return c.json({ ok: true });
  });
  app.post("/api/notifications/test", async c => {
    try {
      const body = await c.req.json();
      await push.test(ctx.owner(c)!, typeof body.id === "string" ? body.id : "");
      return c.json({ ok: true });
    } catch { return c.json({ error: "测试推送未发送成功，请检查订阅和服务端网络" }, 502); }
  });
  app.post("/api/notifications/presence", async c => {
    try {
      const body = await c.req.json();
      push.heartbeat(ctx.owner(c)!, String(body.id ?? ""), String(body.client ?? ""), String(body.sessionId ?? ""));
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof PushStorageBusyError) return retryLater(c, {});
      return c.json({ error: "设备状态无效" }, 400);
    }
  });
  app.post("/api/notifications/activate", async c => {
    try {
      const body = await c.req.json();
      push.activate(ctx.owner(c)!, String(body.id ?? ""), String(body.binding ?? ""));
      return c.json({ ok: true });
    } catch (error) { return c.json({ error: (error as Error).message }, 400); }
  });
}
