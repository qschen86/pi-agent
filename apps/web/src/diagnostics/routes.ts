/**
 * 诊断相关的 HTTP 接入（V1.4 §3.1、§3.3、§4）：
 * - 每个请求一个 x-request-id（合法的沿用前端给的，否则服务端生成），响应头回传
 * - POST /api/client-events          前端事件批量上报，逐条确认
 * - POST /api/client-events/bundle   前端证据包
 * - GET  /api/diagnostics/bundles/:id 只读查看证据包（待办里放的是这个链接）
 * - GET  /api/error-stats、POST /api/error-stats/run  每晚错误统计的运行历史与手动触发
 * 登录、Host、Origin 校验沿用控制台已有中间件（这些路由都在 /api 下）。
 */
import type { Context, Hono } from "hono";
import { REQUEST_ID, newRequestId, type ServerDiagnostics } from "./server-diagnostics.js";
import { ingressEntry } from './events.js';

export const requestIdOf = (c: Context): string | undefined => c.get("requestId" as never) as string | undefined;
export const diagnosticsOf = (c: Context): ServerDiagnostics | undefined => c.get("diagnostics" as never) as ServerDiagnostics | undefined;

export function mountRequestIds(app: Hono, diagnostics: ServerDiagnostics | undefined): void {
  app.use("*", async (c, next) => {
    const given = c.req.header("x-request-id");
    const id = given && REQUEST_ID.test(given) ? given : newRequestId();
    c.set("requestId" as never, id as never);
    if (diagnostics) c.set("diagnostics" as never, diagnostics as never);
    await next();
    try { c.res.headers.set("x-request-id", id); } catch { /* 不可变响应（如静态流）不强求 */ }
  });
}

async function boundedJson(c: Context, maxBytes: number): Promise<unknown | typeof TOO_LARGE | typeof BAD_JSON> {
  const declared = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return TOO_LARGE;
  const text = await c.req.text();
  if (Buffer.byteLength(text) > maxBytes) return TOO_LARGE;
  try { return JSON.parse(text); } catch { return BAD_JSON; }
}
const TOO_LARGE = Symbol("too-large"), BAD_JSON = Symbol("bad-json");

export function mountDiagnosticsRoutes(app: Hono, diagnostics: ServerDiagnostics | undefined): void {
  const off = (c: Context) => c.json({ error: "诊断采集没有开启", code: "DIAGNOSTICS_OFF" }, 404);
  app.post("/api/client-events", async (c) => {
    c.header("Cache-Control", "private, no-store");
    if (!diagnostics) return off(c);
    const body = await boundedJson(c, 64 * 1024);
    if (body === TOO_LARGE) return c.json({ error: "批次太大", code: "CLIENT_EVENTS_TOO_LARGE" }, 413);
    if (body === BAD_JSON) return c.json({ error: "格式不对", code: "CLIENT_EVENTS_INPUT" }, 400);
    const result = diagnostics.ingestClient(body, ingressEntry(c.req.header('host') ?? new URL(c.req.url).host));
    if (result.status === 429) { c.header("Retry-After", "60"); return c.json({ error: "上报太频繁", code: "CLIENT_EVENTS_RATE" }, 429); }
    if (result.status === 400) return c.json({ error: "格式不对", code: "CLIENT_EVENTS_INPUT" }, 400);
    return c.json({ accepted: result.accepted, rejected: result.rejected });
  });
  app.post("/api/client-events/bundle", async (c) => {
    c.header("Cache-Control", "private, no-store");
    if (!diagnostics) return off(c);
    const body = await boundedJson(c, 320 * 1024);
    if (body === TOO_LARGE) return c.json({ error: "证据包太大", code: "BUNDLE_TOO_LARGE" }, 413);
    if (body === BAD_JSON) return c.json({ error: "格式不对", code: "BUNDLE_INPUT" }, 400);
    const result = await diagnostics.ingestBundle(body, ingressEntry(c.req.header('host') ?? new URL(c.req.url).host));
    if (result.status === 400) return c.json({ error: "格式不对", code: "BUNDLE_INPUT" }, 400);
    // 旧页面的手动包仍接收，和自动包一起留到自愈夜检分析
    const manual = typeof result.id === "string" && result.id.startsWith("m");
    return c.json(result.ok ? { ok: true, id: result.id, ...(result.duplicate ? { duplicate: true } : {}), ...(manual ? { note: "queued" } : {}) } : { ok: false, reason: result.reason });
  });
  app.post("/api/diagnostics/findings/:id/ignore", async (c) => {
    if (!diagnostics) return off(c);
    const body = await c.req.json<{ days?: unknown; undo?: unknown }>().catch(() => ({} as { days?: unknown; undo?: unknown }));
    const days = typeof body.days === "number" && Number.isFinite(body.days) ? body.days : 30;
    const r = diagnostics.ignore(c.req.param("id"), days, body.undo === true);
    return r.ok ? c.json(r) : c.json({ error: "没有这个诊断记录", code: "FINDING_NOT_FOUND" }, 404);
  });
  // 导入修复会话写在工作目录 .diagnostics/<findingId>/report.md 里的报告（平台每轮结束也会自动导入）
  app.post("/api/diagnostics/findings/:id/import", (c) => {
    if (!diagnostics?.repair) return c.json({ error: "修复会话没有接上", code: "REPAIR_OFF" }, 404);
    const r = diagnostics.repair.importReport(c.req.param("id"));
    if (r.ok) return c.json(r);
    const message = r.reason === "missing" ? "还没有找到修复会话写的报告（.diagnostics/<诊断编号>/report.md）" : r.reason === "not-found" ? "没有这个诊断记录" : r.reason === "invalid" ? "报告没通过校验" : "报告读取失败";
    return c.json({ error: message, code: `REPORT_${r.reason.toUpperCase().replace(/-/g, "_")}`, ...(r.ok === false && r.errors ? { issues: r.errors } : {}) }, r.reason === "not-found" ? 404 : 409);
  });
  // D 期：立即核对一遍修复是否上线 / 是否已验证（每晚分诊前与每次 release 生效后也会自动跑）
  app.post("/api/diagnostics/verify/run", async (c) => {
    if (!diagnostics?.verifier) return c.json({ error: "修复验证没有接上", code: "VERIFY_OFF" }, 404);
    return c.json({ changes: await diagnostics.verifier.run() });
  });
  // 不经修复会话完成的修复：人工登记修复提交与回归测试
  app.post("/api/diagnostics/findings/:id/fix", async (c) => {
    if (!diagnostics?.verifier) return c.json({ error: "修复验证没有接上", code: "VERIFY_OFF" }, 404);
    const body = await c.req.json<{ commit?: unknown; tests?: unknown }>().catch(() => ({} as { commit?: unknown; tests?: unknown }));
    const tests = Array.isArray(body.tests) ? body.tests.filter((t): t is string => typeof t === "string" && t.length <= 300) : [];
    const r = diagnostics.verifier.registerFix(c.req.param("id"), typeof body.commit === "string" ? body.commit.trim() : "", tests);
    return r.ok ? c.json(r) : c.json({ error: r.reason, code: "FIX_INPUT" }, 400);
  });
  // 立即跑一轮分诊（运维 / 验收用）；分诊关闭或没有模型时直接说明原因
  app.post("/api/diagnostics/triage/run", (c) => {
    if (!diagnostics?.triage) return c.json({ error: "分诊没有接上", code: "TRIAGE_OFF" }, 404);
    if (!diagnostics.triage.settings.enabled) return c.json({ error: "每晚分诊已关闭（PI_AGENT_TRIAGE=off）", code: "TRIAGE_DISABLED" }, 409);
    if (diagnostics.errorStats) {
      const r = diagnostics.errorStats.start("manual", true);
      if ("skipped" in r) return c.json({ error: "已经有一轮联合分析在跑", code: "ERROR_STATS_RUNNING" }, 409);
      void r.done.catch(e => diagnostics.store.noteError(e));
    } else void diagnostics.triage.runNightly(true).catch((e) => diagnostics.store.noteError(e));
    return c.json({ ok: true, started: true }, 202);
  });
  // 每晚错误统计：运行历史 + 手动触发（设置 → 错误统计）。手动跑不受「20 小时内已跑过」限制，已有一轮在跑时不叠加。
  app.get("/api/error-stats", (c) => {
    c.header("Cache-Control", "private, no-store");
    if (!diagnostics?.errorStats) return c.json({ error: "错误统计没有接上", code: "ERROR_STATS_OFF" }, 404);
    return c.json(diagnostics.errorStats.overview());
  });
  app.post("/api/error-stats/run", (c) => {
    c.header("Cache-Control", "private, no-store");
    const svc = diagnostics?.errorStats;
    if (!svc) return c.json({ error: "错误统计没有接上", code: "ERROR_STATS_OFF" }, 404);
    const r = svc.start("manual", true);
    if ("skipped" in r) return c.json({ error: "已经有一轮统计在跑，等它跑完再点", code: "ERROR_STATS_RUNNING" }, 409);
    void r.done.catch((e) => diagnostics?.store.noteError(e));
    return c.json({ ok: true, started: true, runId: r.id }, 202);
  });
  app.get("/api/diagnostics/bundles/:id", (c) => {
    c.header("Cache-Control", "private, no-store");
    if (!diagnostics) return off(c);
    const bundle = diagnostics.store.readBundle(c.req.param("id"));
    return bundle ? c.json(bundle) : c.json({ error: "没有这个证据包（可能已过保留期）", code: "BUNDLE_NOT_FOUND" }, 404);
  });
}
