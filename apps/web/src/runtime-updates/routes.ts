/**
 * runtime 版本更新的 HTTP 接入（设置 → 运行时更新）：
 * - GET  /api/runtime-updates                  各 runtime 的已装版本、最新稳定版、新增功能、更新记录、分析报告
 * - GET  /api/runtime-updates/summary          只有红点需要的小结（轻量）
 * - POST /api/runtime-updates/check            立即检测一轮（已有一轮在跑时 409）
 * - POST /api/runtime-updates/:kind/analyze    重新分析：{ force: true } 重新生成；后台跑，立即返回 202，页面轮询概览看进度
 * - POST /api/runtime-updates/:kind/ignore     忽略当前最新版；{ undo: true } 取消忽略
 * - POST /api/runtime-updates/:kind/upgrade    人点「升级」：返回由另一个 runtime 执行的会话方案（工作目录、首条消息、权限）；Codex 400
 * - POST /api/runtime-updates/auto-upgrade     自动夜间升级开关 { enabled }；打开后按条件重新评估并排队
 * - POST /api/runtime-updates/:kind/auto-upgrade  取消这个 runtime 还没开始的自动升级
 * 平台不直接执行升级：方案由设置页交给新建会话流程，在另一个 runtime 的会话里跑。登录、Host、Origin 校验沿用控制台 /api 已有的中间件。
 */
import type { Hono } from "hono";
import type { RuntimeUpdatesService } from "./service.js";
import { UPDATE_KINDS, type UpdateKind } from "./sources.js";

export function mountRuntimeUpdatesRoutes(app: Hono, service: RuntimeUpdatesService | undefined): void {
  const off = (c: { json: (body: unknown, status: 404) => Response }) => c.json({ error: "版本更新检测没有接上", code: "RUNTIME_UPDATES_OFF" }, 404);
  const kindOf = (raw: string): UpdateKind | undefined => (UPDATE_KINDS as string[]).includes(raw) ? raw as UpdateKind : undefined;

  app.get("/api/runtime-updates/summary", (c) => {
    c.header("Cache-Control", "private, no-store");
    return service ? c.json(service.summary()) : off(c);
  });
  app.get("/api/runtime-updates", (c) => {
    c.header("Cache-Control", "private, no-store");
    return service ? c.json(service.overview()) : off(c);
  });
  app.post("/api/runtime-updates/check", (c) => {
    c.header("Cache-Control", "private, no-store");
    if (!service) return off(c);
    const started = service.start("manual");
    if ("skipped" in started) return c.json({ error: "已经有一轮检测在跑，等它跑完再点", code: "RUNTIME_UPDATES_RUNNING" }, 409);
    void started.done.catch(() => undefined);
    return c.json({ ok: true, started: true }, 202);
  });
  app.post("/api/runtime-updates/:kind/analyze", async (c) => {
    c.header("Cache-Control", "private, no-store");
    if (!service) return off(c);
    const kind = kindOf(c.req.param("kind"));
    if (!kind) return c.json({ error: "未知的 runtime", code: "RUNTIME_KIND" }, 400);
    const body = await c.req.json<{ force?: unknown }>().catch(() => ({} as { force?: unknown }));
    // 分析要几十秒到几分钟：后台跑，接口立即返回，避免网关超时（504）
    const result = service.startAnalyze(kind, "manual", body.force === true);
    if (result.ok) return c.json({ ok: true, started: result.started, ...(result.started ? {} : { cached: true, analysis: result.analysis }) }, result.started ? 202 : 200);
    return c.json({ error: result.error, code: result.code }, result.code === "ANALYZING" ? 409 : result.code === "NO_UPDATE" ? 400 : 502);
  });
  app.post("/api/runtime-updates/auto-upgrade", async (c) => {
    c.header("Cache-Control", "private, no-store");
    if (!service) return off(c);
    const body = await c.req.json<{ enabled?: unknown }>().catch(() => ({} as { enabled?: unknown }));
    const enabled = body.enabled !== false;
    service.setAutoUpgradeEnabled(enabled);
    if (enabled) void service.runAutoUpgradePass().catch(() => undefined);
    return c.json({ ok: true, enabled });
  });
  app.post("/api/runtime-updates/:kind/auto-upgrade", (c) => {
    c.header("Cache-Control", "private, no-store");
    if (!service) return off(c);
    const kind = kindOf(c.req.param("kind"));
    if (!kind) return c.json({ error: "未知的 runtime", code: "RUNTIME_KIND" }, 400);
    return service.cancelAutoUpgrade(kind) ? c.json({ ok: true }) : c.json({ error: "这个版本没有待执行的自动升级", code: "NO_AUTO_UPGRADE" }, 400);
  });
  app.post("/api/runtime-updates/:kind/upgrade", (c) => {
    c.header("Cache-Control", "private, no-store");
    if (!service) return off(c);
    const kind = kindOf(c.req.param("kind"));
    if (!kind) return c.json({ error: "未知的 runtime", code: "RUNTIME_KIND" }, 400);
    const result = service.upgradePlan(kind);
    return result.ok ? c.json({ ok: true, plan: result.plan }) : c.json({ error: result.error, code: result.code }, result.code === "NO_REPO" ? 503 : 400);
  });
  app.post("/api/runtime-updates/:kind/ignore", async (c) => {
    c.header("Cache-Control", "private, no-store");
    if (!service) return off(c);
    const kind = kindOf(c.req.param("kind"));
    if (!kind) return c.json({ error: "未知的 runtime", code: "RUNTIME_KIND" }, 400);
    const body = await c.req.json<{ undo?: unknown }>().catch(() => ({} as { undo?: unknown }));
    return service.ignore(kind, body.undo === true) ? c.json({ ok: true }) : c.json({ error: "还没有检测到最新版本", code: "NO_LATEST" }, 400);
  });
}
