/**
 * 股票账户记账的 HTTP 接口。
 *
 * 页面和 agent 用的是同一套接口：
 * - 页面在浏览器里带同源 Origin，走控制台的登录 / CSRF 中间件；
 * - agent 在本机通过 127.0.0.1 调用，不带 Origin（见 skills/platform/stock-ledger/ledger.mjs）。
 *   本机进程本来就能读写数据目录，所以不为它再加一套密钥。
 */
import type { Hono } from "hono";
import type { Context } from "hono";
import { LedgerError, StockLedger } from "./stock-ledger.js";
import { LEDGER_CHAT_CONFIG, LedgerChatError, type LedgerChatService } from "./ledger-chat.js";

const noStore = (c: Context) => { c.header("Cache-Control", "private, no-store"); };

async function body(c: Context): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await c.req.json(); }
  catch { throw new LedgerError("请求内容不是合法的 JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LedgerError("请求内容格式不对");
  return value as Record<string, unknown>;
}

function fail(c: Context, error: unknown): Response {
  if (error instanceof LedgerError) return c.json({ error: error.message, code: error.code }, error.status);
  throw error;
}

export function mountStockLedgerRoutes(app: Hono, ledger: StockLedger, options: { chat?: LedgerChatService } = {}): void {
  app.get("/api/ledger", (c) => {
    noStore(c);
    return c.json(ledger.view());
  });

  app.post("/api/ledger/accounts", async (c) => {
    noStore(c);
    try {
      const input = await body(c);
      const account = ledger.createAccount({
        name: input["name"], kind: input["kind"], broker: input["broker"], accountNo: input["accountNo"], note: input["note"],
        marketValue: input["marketValue"], shareholders: input["shareholders"]
      });
      return c.json({ account, ledger: ledger.view() }, 201);
    } catch (error) { return fail(c, error); }
  });

  app.patch("/api/ledger/accounts/:id", async (c) => {
    noStore(c);
    try {
      const input = await body(c);
      const account = ledger.updateAccount(c.req.param("id"), {
        ...(input["name"] !== undefined ? { name: input["name"] } : {}),
        ...(input["broker"] !== undefined ? { broker: input["broker"] } : {}),
        ...(input["accountNo"] !== undefined ? { accountNo: input["accountNo"] } : {}),
        ...(input["note"] !== undefined ? { note: input["note"] } : {}),
        ...(input["shareholders"] !== undefined ? { shareholders: input["shareholders"] } : {})
      });
      return c.json({ account, ledger: ledger.view() });
    } catch (error) { return fail(c, error); }
  });

  app.delete("/api/ledger/accounts/:id", (c) => {
    noStore(c);
    try {
      const result = ledger.deleteAccount(c.req.param("id"));
      return c.json({ ...result, ledger: ledger.view() });
    } catch (error) { return fail(c, error); }
  });

  app.post("/api/ledger/accounts/:id/transactions", async (c) => {
    noStore(c);
    try {
      const input = await body(c);
      const result = ledger.recordTransaction(c.req.param("id"), {
        kind: input["kind"], shareholderId: input["shareholderId"], shareholderName: input["shareholderName"],
        counterpartyId: input["counterpartyId"], counterpartyName: input["counterpartyName"],
        amount: input["amount"], marketValueAfter: input["marketValueAfter"], occurredAt: input["occurredAt"],
        note: input["note"],
        idempotencyKey: input["idempotencyKey"] ?? c.req.header("idempotency-key"),
        // 只有本机 agent 在请求头里声明来源时才记成 agent；网页正文里写 actor 不算数。
        actor: c.req.header("x-ledger-actor") === "agent" ? "agent" : "manual"
      });
      return c.json({ ...result, ledger: ledger.view() }, 201);
    } catch (error) { return fail(c, error); }
  });

  app.post("/api/ledger/transactions/:id/undo", (c) => {
    noStore(c);
    try {
      const result = ledger.undoLast(c.req.param("id"));
      return c.json({ ...result, ledger: ledger.view() });
    } catch (error) { return fail(c, error); }
  });

  // 页面左侧的记账助手：模型只产出「reply + actions」，账本口径由服务端执行。
  // 没有注入模型端口时仍然挂 GET，让页面显示「暂时不可用」，而不是把整个页面打挂。
  const chat = options.chat;
  app.get("/api/ledger/chat", (c) => {
    noStore(c);
    if (!chat) return c.json({ available: false, promptVersion: LEDGER_CHAT_CONFIG.promptVersion, defaultModel: "", defaultThinking: "high", models: [] });
    return c.json(chat.info());
  });
  app.post("/api/ledger/chat", async (c) => {
    noStore(c);
    if (!chat) return c.json({ error: "记账助手还没有配置模型，暂时不能对话。", code: "LEDGER_CHAT_UNAVAILABLE" }, 503);
    let input: unknown;
    try { input = await c.req.json(); }
    catch { return c.json({ error: "请求内容不是合法的 JSON", code: "LEDGER_CHAT_INPUT" }, 400); }
    const client = c.req.header("cf-connecting-ip") ?? "local";
    try {
      return c.json(await chat.chat(input, `ledger-chat:${client}`));
    } catch (error) {
      if (error instanceof LedgerChatError) return c.json({ error: error.message, code: error.code }, error.status);
      if (error instanceof LedgerError) return fail(c, error);
      throw error;
    }
  });
}
