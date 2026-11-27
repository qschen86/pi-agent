/**
 * 本地验证引擎的 HTTP 薄代理路由与类型契约（无脚本依赖，便于开源导出与 homebrew 打包独立编译）。
 */
import type { Context, Hono } from "hono";

export interface VerifyStepView {
  name: string;
  state: string;
  exitCode: number | null;
  startedAt: string | null;
  endedAt: string | null;
  reason: string | null;
}

export interface VerifyReportSummary {
  result: string;
  errorClass: string | null;
  summary: string;
  suggestedAction: string;
  retryable: boolean;
  stale: boolean | null;
  locations: Array<{ file: string; line: number; col?: number; code?: string }>;
}

export interface SessionVerifyView {
  jobId: string;
  profile: string;
  target: string;
  state: string;
  active: boolean;
  stateReason: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  totalMs: number | null;
  currentStep: string | null;
  steps: VerifyStepView[];
  cancelRequested: boolean;
  workerStale: boolean;
  report?: VerifyReportSummary;
}

export interface VerifyService {
  start(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  status(id: string): Promise<Record<string, unknown>>;
  report(id: string, opts?: { checkCurrent?: boolean }): Record<string, unknown>;
  logs(id: string, opts?: { step?: string; offset?: number; limit?: number }): Record<string, unknown>;
  cancel(id: string, opts?: { by?: string; reason?: string | null }): Record<string, unknown>;
  list(opts?: { target?: string; limit?: number; sessionId?: string }): Record<string, unknown>;
  signature(): string;
  bySession(): Map<string, SessionVerifyView>;
  forSession(sessionId: string): SessionVerifyView | null;
}

const HTTP_STATUS: Record<string, 400 | 404 | 409 | 503> = {
  BAD_REQUEST: 400,
  UNKNOWN_PROFILE: 400,
  UNKNOWN_TARGET: 400,
  NOT_FOUND: 404,
  CORRUPT: 503,
  NOT_FINISHED: 409,
  LOCK_TIMEOUT: 503,
  NOT_WRITABLE: 503,
};

function handleVerifyError(c: Context, e: unknown) {
  const err = e as { name?: string; code?: string; message?: string };
  if (err?.name === "VerifyError" && err.code) {
    const status = HTTP_STATUS[err.code] ?? 400;
    return c.json({ ok: false, error: { code: err.code, message: err.message ?? err.code } }, status);
  }
  if (err?.code === "EACCES" || err?.code === "EPERM" || err?.code === "EROFS") {
    return c.json({ ok: false, error: { code: "NOT_WRITABLE", message: `验证目录不可写：${err.message ?? ""}` } }, 503);
  }
  return c.json({ ok: false, error: { code: "GENERIC", message: err?.message ?? String(e) } }, 500);
}

/** 挂载 /api/verify/* 薄代理路由（安全边界与 /api/runtime-sessions/* 一致：本机回环放行，对外入口由全局认证中间件保护）。 */
export function mountVerifyRoutes(app: Hono, service: VerifyService): void {
  app.post("/api/verify/jobs", async (c) => {
    try {
      const body = await c.req.json<Record<string, unknown>>().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return c.json({ ok: false, error: { code: "BAD_REQUEST", message: "请求体必须是 JSON 对象" } }, 400);
      }
      const out = await service.start(body);
      return c.json(out, out["created"] ? 201 : 200);
    } catch (e) {
      return handleVerifyError(c, e);
    }
  });

  app.get("/api/verify/jobs", (c) => {
    try {
      const target = c.req.query("target") || undefined;
      const sessionId = c.req.query("sessionId") || undefined;
      const limitRaw = c.req.query("limit");
      const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
      if (limitRaw !== undefined && (!Number.isInteger(limit) || (limit as number) < 1)) {
        return c.json({ ok: false, error: { code: "BAD_REQUEST", message: "limit 必须是正整数" } }, 400);
      }
      c.header("Cache-Control", "private, no-store");
      return c.json(service.list({ ...(target ? { target } : {}), ...(sessionId ? { sessionId } : {}), ...(limit ? { limit } : {}) }));
    } catch (e) {
      return handleVerifyError(c, e);
    }
  });

  app.get("/api/verify/jobs/:id", async (c) => {
    try {
      c.header("Cache-Control", "private, no-store");
      return c.json(await service.status(c.req.param("id")));
    } catch (e) {
      return handleVerifyError(c, e);
    }
  });

  app.get("/api/verify/jobs/:id/report", (c) => {
    try {
      c.header("Cache-Control", "private, no-store");
      return c.json(service.report(c.req.param("id"), { checkCurrent: c.req.query("checkCurrent") === "1" }));
    } catch (e) {
      return handleVerifyError(c, e);
    }
  });

  app.get("/api/verify/jobs/:id/logs", (c) => {
    try {
      const step = c.req.query("step") || undefined;
      const offsetRaw = c.req.query("offset");
      const limitRaw = c.req.query("limit");
      const offset = offsetRaw !== undefined ? Number(offsetRaw) : undefined;
      const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
      if (offsetRaw !== undefined && (!Number.isInteger(offset) || (offset as number) < 0)) {
        return c.json({ ok: false, error: { code: "BAD_REQUEST", message: "offset 必须是非负整数" } }, 400);
      }
      if (limitRaw !== undefined && (!Number.isInteger(limit) || (limit as number) < 1)) {
        return c.json({ ok: false, error: { code: "BAD_REQUEST", message: "limit 必须是正整数" } }, 400);
      }
      c.header("Cache-Control", "private, no-store");
      return c.json(service.logs(c.req.param("id"), { ...(step ? { step } : {}), ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) }));
    } catch (e) {
      return handleVerifyError(c, e);
    }
  });

  app.post("/api/verify/jobs/:id/cancel", async (c) => {
    try {
      const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
      const by = typeof body["by"] === "string" && body["by"] ? body["by"] : "web";
      const reason = typeof body["reason"] === "string" ? body["reason"] : null;
      return c.json(service.cancel(c.req.param("id"), { by, reason }));
    } catch (e) {
      return handleVerifyError(c, e);
    }
  });
}
