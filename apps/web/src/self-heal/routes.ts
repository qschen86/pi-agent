/**
 * 自愈的 HTTP 接入（设置 → 自愈）：
 * - GET  /api/self-heal                         板块总览（最近一次检查、待处理数、下次夜检时间）
 * - GET  /api/self-heal/boards/:id              板块详情：策略、屏蔽规则、检查历史（含结论与结果状态）、归到这个板块的夜间任务
 * - POST /api/self-heal/run                     手动夜检（不受「20 小时内已跑过」限制）
 * - PUT  /api/self-heal/boards/:id/settings     这个板块的分析模型与推理强度
 * - POST /api/self-heal/boards/:id/ignore、DELETE /api/self-heal/ignore/:id   屏蔽 / 恢复一类报错
 * - POST /api/self-heal/findings/:id/decision   待人类审核的结论：批准修复 / 不修复
 * 登录、Host、Origin 校验沿用控制台已有中间件。
 */
import type { Context, Hono } from "hono";
import { catalogModel, effortProblem } from "@pi-agent/schemas";
import { scanAgentScheduledTasks } from "../agent-calendar.js";
import type { ServerDiagnostics } from "../diagnostics/server-diagnostics.js";
import { boardOfTask, isBoardId } from "./boards.js";
import { SelfHealError } from "./service.js";

/** 归到某个板块的夜间任务（来源与 Agent 日历是同一份清单）。 */
const scheduledTasks = () => { try { return scanAgentScheduledTasks().tasks; } catch { return []; } };
export const tasksOfBoard = (board: string) => scheduledTasks().filter((t) => boardOfTask(t.id) === board)
  .map((t) => ({ id: t.id, name: t.name, schedule: t.schedule, status: t.status, description: t.description }));

export function mountSelfHealRoutes(app: Hono, diagnostics: ServerDiagnostics | undefined): void {
  const service = () => diagnostics?.selfHeal;
  const off = (c: Context) => c.json({ error: "自愈没有接上", code: "SELF_HEAL_OFF" }, 404);
  const fail = (c: Context, e: unknown) => {
    if (e instanceof SelfHealError) return c.json({ error: e.message, code: e.code }, e.status as 404 | 409 | 502);
    throw e;
  };
  const body = async (c: Context): Promise<Record<string, unknown>> => { const b = await c.req.json().catch(() => ({})); return b && typeof b === "object" ? b as Record<string, unknown> : {}; };

  app.get("/api/self-heal", (c) => {
    c.header("Cache-Control", "private, no-store");
    const s = service(); if (!s) return off(c);
    const overview = s.overview() as { boards: Array<{ id: string }> };
    const tasks = scheduledTasks();
    return c.json({ ...overview, boards: overview.boards.map((b) => ({ ...b, taskCount: tasks.filter((t) => boardOfTask(t.id) === b.id).length })) });
  });
  app.get("/api/self-heal/boards/:id", (c) => {
    c.header("Cache-Control", "private, no-store");
    const s = service(); if (!s) return off(c);
    const id = c.req.param("id");
    if (!isBoardId(id)) return c.json({ error: "没有这个板块", code: "BOARD_NOT_FOUND" }, 404);
    return c.json({ ...s.boardDetail(id), running: s.isRunning(), tasks: tasksOfBoard(id) });
  });
  app.post("/api/self-heal/run", (c) => {
    c.header("Cache-Control", "private, no-store");
    const s = service(); if (!s) return off(c);
    const r = s.start("manual", true);
    if ("skipped" in r) return c.json({ error: "已经有一轮夜检在跑，等它跑完再点", code: "SELF_HEAL_RUNNING" }, 409);
    void r.done.catch((e) => diagnostics?.store.noteError(e));
    return c.json({ ok: true, started: true, runId: r.id }, 202);
  });
  app.put("/api/self-heal/boards/:id/settings", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const s = service(); if (!s) return off(c);
    const id = c.req.param("id");
    if (!isBoardId(id)) return c.json({ error: "没有这个板块", code: "BOARD_NOT_FOUND" }, 404);
    const b = await body(c);
    const model = typeof b["model"] === "string" ? b["model"].trim() : "", effort = typeof b["effort"] === "string" ? b["effort"].trim() : "";
    if (model && !catalogModel(model)) return c.json({ error: `${model} 不在平台模型目录里`, code: "SELF_HEAL_MODEL" }, 400);
    const problem = effort ? effortProblem(model || "deepseek/deepseek-flash", effort) : undefined;
    if (problem) return c.json({ error: problem, code: "SELF_HEAL_EFFORT" }, 400);
    return c.json({ settings: s.store.setBoardSettings(id, { model, effort }) });
  });
  app.post("/api/self-heal/boards/:id/ignore", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const s = service(); if (!s) return off(c);
    const id = c.req.param("id");
    if (!isBoardId(id)) return c.json({ error: "没有这个板块", code: "BOARD_NOT_FOUND" }, 404);
    const b = await body(c);
    const match = typeof b["match"] === "string" ? b["match"].trim() : "";
    if (match.length < 3 || match.length > 200) return c.json({ error: "屏蔽关键词需要 3 到 200 个字", code: "SELF_HEAL_IGNORE_INPUT" }, 400);
    const reason = typeof b["reason"] === "string" ? b["reason"].trim().slice(0, 200) : "";
    return c.json({ rule: s.store.addIgnore(id, match, reason) }, 201);
  });
  app.delete("/api/self-heal/ignore/:id", (c) => {
    c.header("Cache-Control", "private, no-store");
    const s = service(); if (!s) return off(c);
    return s.store.removeIgnore(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "没有这条屏蔽规则", code: "IGNORE_NOT_FOUND" }, 404);
  });
  app.post("/api/self-heal/findings/:id/decision", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const s = service(); if (!s) return off(c);
    const b = await body(c);
    if (b["decision"] !== "approve" && b["decision"] !== "reject") return c.json({ error: "decision 只能是 approve 或 reject", code: "SELF_HEAL_DECISION_INPUT" }, 400);
    try { return c.json({ finding: await s.decide(c.req.param("id"), b["decision"]) }); }
    catch (e) { return fail(c, e); }
  });
}
