/**
 * Codex reset 的 HTTP 接入：
 * - GET  /api/codex-resets        可用张数、过去 7 / 30 天用掉几张、最近扫描与流水
 * - POST /api/codex-resets/scan   立即扫描一轮（已有一轮在跑时 409）
 * 登录、Host、Origin 校验沿用控制台 /api 已有的中间件。
 */
import type { Hono } from "hono";
import type { CodexResetService } from "./service.js";

export function mountCodexResetRoutes(app: Hono, service: CodexResetService | undefined): void {
  const off = (c: { json: (body: unknown, status: 404) => Response }) => c.json({ error: "Codex reset 没有接上", code: "CODEX_RESET_OFF" }, 404);

  app.get("/api/codex-resets", (c) => {
    c.header("Cache-Control", "private, no-store");
    if (!service) return off(c);
    return c.json(service.overview());
  });

  app.post("/api/codex-resets/scan", (c) => {
    c.header("Cache-Control", "private, no-store");
    if (!service) return off(c);
    const started = service.start("manual");
    if ("skipped" in started) return c.json({ error: "已经有一轮扫描在跑，等它跑完再点", code: "CODEX_RESET_RUNNING" }, 409);
    void started.done.catch(() => undefined);
    return c.json({ ok: true, started: true }, 202);
  });
}
