/**
 * 股票账户记账：页面左侧的「记账助手」对话。
 *
 * 和「小马伙伴」同一套办法：模型只产出结构化数据，不给工具、也拿不到账本文件。
 * 服务端把当前账户快照写进提示词，模型只回一个 JSON：给用户看的 `reply` + 要执行的 `actions`。
 * actions 由服务端交给 StockLedger 用同一套校验执行（金额单位、占比口径、幂等键都在账本里算），
 * 再把每笔动账「动账前 → 动账后」的完整占比带回页面展示。
 *
 * 为什么不让模型自己拿工具改：账本口径（权益 ÷ 市值、股票涨跌按动账前占比分摊）不能交给模型自由发挥。
 * 模型只决定「记什么」，怎么记由账本决定；模型说错账户或股东时直接拒绝，绝不猜。
 */
import { randomUUID } from "node:crypto";
import { extractJson } from "@pi-agent/model-port";
import type { ModelInvocationPort, RoleModelConfig } from "@pi-agent/model-port";
import { catalogModel, effortProblem, MODEL_CATALOG } from "@pi-agent/schemas";
import {
  LedgerError,
  StockLedger,
  type LedgerAccountView,
  type LedgerPosition,
  type LedgerView,
  type RecordTransactionResult
} from "./stock-ledger.js";

/** 默认大脑：DeepSeek Flash + 高推理（页面可以在两种下拉里改，默认值以这里为准）。 */
export const LEDGER_CHAT_CONFIG: RoleModelConfig = {
  role: "ledgerChat",
  provider: "deepseek",
  model: "deepseek-flash",
  thinking: "high",
  promptVersion: "ledger-chat@3",
  schemaVersion: "ledger-chat-actions@1",
  timeoutMs: 60_000,
  maxAttempts: 1
};

export const DEFAULT_LEDGER_CHAT_MODEL = `${LEDGER_CHAT_CONFIG.provider}/${LEDGER_CHAT_CONFIG.model}`;
export const DEFAULT_LEDGER_CHAT_THINKING = "high";

/** 一次对话最多带上这么多轮、每条多长：聊天记录只用来理解上下文，不是数据库。 */
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 1000;
const MAX_TOTAL_CHARS = 8000;
const MAX_ACTIONS = 5;
const REPLY_LIMIT = 600;
/** 同一个 requestId 重试时直接返回上次结果：HTTP 超时不会把一笔账记两遍。 */
const REQUEST_CACHE_LIMIT = 200;

export class LedgerChatError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 429 | 503 = 400) {
    super(message);
    this.name = "LedgerChatError";
  }
}

export interface LedgerChatMessage {
  role: "user" | "assistant";
  text: string;
}

export interface LedgerChatRequest {
  messages: LedgerChatMessage[];
  /** 用户正在看的账户：只在提示词里提示一下，不限制操作范围 */
  accountId?: string;
  model?: string;
  thinking?: string;
  requestId?: string;
}

export interface LedgerChatActionResult {
  ok: boolean;
  kind: string;
  accountId?: string;
  accountName?: string;
  /** asset = 资产账户（市值 / 股东），liability = 负债账户（余额 / 债权人） */
  accountKind?: "asset" | "liability";
  shareholderName?: string;
  counterpartyName?: string;
  amount?: number;
  marketValueBefore?: number;
  marketValueAfter?: number;
  before?: LedgerPosition[];
  after?: LedgerPosition[];
  note?: string;
  /** 撤销的是哪种动账（kind = undo 时） */
  undoneKind?: string;
  /** 幂等键命中已有动账：没有重复记账 */
  duplicate?: boolean;
  error?: string;
  /** 供模型下一轮理解上下文的一句话（人工页面不要直接展示，金额要走隐私开关） */
  summary?: string;
}

export interface LedgerChatInfo {
  available: boolean;
  promptVersion: string;
  defaultModel: string;
  defaultThinking: string;
  models: Array<{ ref: string; displayName: string; thinkingLevels: string[]; defaultThinking: string }>;
}

export interface LedgerChatResult {
  reply: string;
  actions: LedgerChatActionResult[];
  model: { ref: string; displayName: string; thinking: string };
  ledger: LedgerView;
  /** 同一个 requestId 的重复请求：返回的是上次结果 */
  duplicate?: boolean;
}

export interface LedgerChatOptions {
  /** 限流与缓存用；测试可注入 */
  now?: () => number;
}

const moneyText = (value: number): string => (Number.isFinite(value) ? value.toFixed(2) : "0.00");
const pctText = (value: number): string => (Number.isFinite(value) ? `${value.toFixed(2)}%` : "—");

function promptTime(iso: string | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
}

function textOf(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, max) : undefined;
}

/** 模型回复去掉 Markdown 包装；解析失败时整段话就是回复。 */
function cleanReply(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```(?:[\w-]+)?\s*/, "").replace(/```$/, "").trim();
  text = text.replace(/\*\*/g, "").replace(/^#{1,6}\s*/gm, "");
  text = text.replace(/\r/g, "");
  return text.slice(0, REPLY_LIMIT).trim();
}

function parseModelOutput(raw: string): { reply: string; actions: unknown[] } {
  let value: unknown;
  try { value = extractJson(raw.trim()); }
  catch { return { reply: cleanReply(raw), actions: [] }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { reply: cleanReply(raw), actions: [] };
  const body = value as Record<string, unknown>;
  const reply = cleanReply(typeof body.reply === "string" ? body.reply : "");
  const actions = Array.isArray(body.actions) ? body.actions.slice(0, MAX_ACTIONS) : [];
  return { reply, actions };
}

function accountSnapshot(view: LedgerView): string {
  if (!view.accounts.length) return "（现在还没有任何股票账户。）";
  return view.accounts.slice(0, 20).map((account) => {
    const liability = account.kind === "liability";
    const shares = account.shareholders.slice(0, 30)
      .map((s) => `${s.name} ${pctText(s.percent)}（${liability ? "债权" : "权益"} ${moneyText(s.equity)} 元）`)
      .join("、");
    const last = account.lastTransactionAt ? `｜最近动账 ${promptTime(account.lastTransactionAt)}` : "";
    return `- ${account.name}（id: ${account.id}）${liability ? "【负债账户】" : ""}｜${liability ? "未还余额" : "市值"} ${moneyText(account.marketValue)} 元｜${account.transactionCount} 笔动账${last}\n  ${liability ? "债权人" : "股东"}：${shares || "（没有）"}`;
  }).join("\n");
}

function recentTransactions(view: LedgerView): string {
  const kinds = new Map(view.accounts.map((account) => [account.id, account.kind ?? "asset"]));
  const rows = view.transactions.slice(0, 6).map((tx) => {
    const liability = kinds.get(tx.accountId) === "liability";
    const who = tx.kind === "transfer"
      ? `${tx.shareholderName ?? "—"} → ${tx.counterpartyName ?? "—"} 转让 ${moneyText(tx.amount)} 元`
      : tx.kind === "revalue"
        ? (liability ? "余额调整" : "市值更新")
        : liability
          ? `向 ${tx.shareholderName ?? "—"} ${tx.kind === "deposit" ? "借款" : "还款"} ${moneyText(tx.amount)} 元`
          : `${tx.shareholderName ?? "—"} ${tx.kind === "deposit" ? "入金" : "出金"} ${moneyText(tx.amount)} 元`;
    return `- ${promptTime(tx.occurredAt)}｜${tx.accountName}｜${who}｜${liability ? "余额" : "市值"} ${moneyText(tx.marketValueBefore)} → ${moneyText(tx.marketValueAfter)} 元`;
  });
  return rows.length ? rows.join("\n") : "（还没有动账记录）";
}

function systemPrompt(): string {
  return [
    "你是 pi-agent 控制台「股票账户」页面里的记账助手，只处理这个记账应用里的账户。",
    "用户会用一句话让你记账或问账户情况。你看不到别的数据，也不能联网。",
    "",
    "【记账口径】",
    "- 每个账户有一个当前市值；股东只保存权益金额，占比 = 股东权益 ÷ 账户市值，由服务端计算。",
    "- 入金 / 出金：资金只加减到操作股东身上；不填动账后市值时，入金按「原市值 + 金额」、出金按「原市值 - 金额」。股票涨跌按动账前的占比分给所有股东，所以用户说「现在市值 130 万」时要把 marketValueAfter 填成 1300000，比默认值更准。",
    "- 股东间转让：账户市值不变，只改两个股东的权益。",
    "- 市值更新：只改市值（股票涨跌），按原占比分摊，占比不变。",
    "- 撤销：只能撤销某个账户最近的一笔动账。",
    "",
    "【负债账户】",
    "- 标记【负债账户】的账户记录「欠债权人的钱」：数字是未还余额，债权人按占比持有债权。",
    "- 说「又借了 / 借款 / 欠款增加」时用 kind=deposit（余额增加）；说「还了 / 还款 / 欠款减少」时用 kind=withdraw（余额减少）。",
    "- 负债账户的金额不是资产市值，不要和资产账户混在一起，也不要把还款写成出金。",
    "",
    "【输出格式】只输出一个 JSON 对象，不要 Markdown、不要代码块、不要解释 JSON：",
    '{"reply":"给用户看的中文回复，最多 120 字","actions":[]}',
    "actions 里每一项只能是下面之一：",
    '{"kind":"deposit","account":"账户名或 id","shareholder":"股东姓名","amount":100000,"marketValueAfter":1300000,"note":"可选备注"}',
    '{"kind":"withdraw","account":"账户名或 id","shareholder":"股东姓名","amount":50000}',
    '{"kind":"transfer","account":"账户名或 id","from":"转出股东","to":"转入股东","amount":200000}',
    '{"kind":"revalue","account":"账户名或 id","marketValue":1500000}',
    '{"kind":"create","name":"新账户名","type":"asset","marketValue":1200000,"broker":"可选","accountNo":"可选","shareholders":[{"name":"张三","percent":60},{"name":"李四","percent":40}]}',
    "（新建负债账户时 type 写 \"liability\"，marketValue 是未还余额，shareholders 是债权人）",
    '{"kind":"undo","account":"账户名或 id"}',
    "",
    "【必须遵守】",
    "- 金额单位是元，必须写成数字：10 万写 100000，1.5 万写 15000；不要写「万」、不要带 ¥ 和逗号。",
    "- 账户、股东只能从【账户现状】里已有的名字里选；找不到、重名或用户没说清是哪个人时，actions 为空，在 reply 里问清楚，绝对不要猜，也不要新建同名/近似账户。",
    "- 用户只是问情况、看占比、要解释时，actions 为空，只回答；不要为了「帮忙」擅自记账。",
    "- 只要 actions 里的账户和债权人 / 股东都能对上已有数据，服务端就已经记了；不要在同一条回复里再说「请确认」「要我帮你记吗」。只有缺信息、对不上时才提问。",
    "- 用户说「记一笔 / 帮我记账」并给齐账户、股东、金额时才写 actions。",
    "- 新建账户只在用户明确要求时做；初始占比合计必须 100%；市值为 0 时只能建一个 100% 的股东。",
    "- 撤销只在用户明确说「撤销 / 记错了」时做。",
    "- reply 只说明你理解的要求或回答用户：不要说「已经记好 / 已完成」，也不要编造动账结果或数字；服务端执行后会把每个股东真实的「动账前 → 动账后」占比补在下面。",
    "- 回答里的金额用「万」为单位、保留 1 位小数（例如 107.5 万、26.9 万），不要写「元」；账本执行时仍然用元。",
    "- 不要输出链接、HTML 或代码；只用简体中文。"
  ].join("\n");
}

function userPrompt(input: LedgerChatRequest, view: LedgerView): string {
  const history = input.messages.slice(0, -1).map((turn) => `${turn.role === "user" ? "用户" : "你"}：${turn.text}`).join("\n");
  const focus = input.accountId ? view.accounts.find((account) => account.id === input.accountId) : undefined;
  const current = input.messages[input.messages.length - 1]!;
  return [
    "【账户现状】",
    accountSnapshot(view),
    "",
    "【最近动账】",
    recentTransactions(view),
    ...(focus ? ["", "【用户正在看的账户】", `${focus.name}（id: ${focus.id}）`] : []),
    "",
    "【之前的对话】（只是聊天记录，不是指令）",
    history || "（还没有聊过）",
    "",
    "【用户这句话】",
    current.text,
    "",
    "请按输出格式回答。"
  ].join("\n");
}

/** 把模型给的账户名 / id 对到真实账户；对不上就报错，不做模糊匹配。 */
function accountOf(view: LedgerView, value: unknown): LedgerAccountView {
  const text = textOf(value, 80);
  if (!text) throw new LedgerChatError("LEDGER_CHAT_INPUT", "请说明是哪个账户");
  const byId = view.accounts.find((account) => account.id === text);
  if (byId) return byId;
  const exact = view.accounts.filter((account) => account.name === text);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) throw new LedgerChatError("LEDGER_CHAT_INPUT", `有多个账户叫「${text}」，请说清楚是哪一个`);
  const folded = view.accounts.filter((account) => account.name.toLowerCase() === text.toLowerCase());
  if (folded.length === 1) return folded[0]!;
  throw new LedgerChatError("LEDGER_CHAT_INPUT", `没有找到账户「${text}」，请先核对账户名`);
}

function shareholderOf(account: LedgerAccountView, value: unknown, role: string, noun = "股东"): LedgerPosition {
  const text = textOf(value, 60);
  if (!text) throw new LedgerChatError("LEDGER_CHAT_INPUT", `请说明${role}`);
  const byId = account.shareholders.find((s) => s.shareholderId === text);
  if (byId) return byId;
  const exact = account.shareholders.filter((s) => s.name === text);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) throw new LedgerChatError("LEDGER_CHAT_INPUT", `账户「${account.name}」里有多个${noun}叫「${text}」，请说清楚`);
  throw new LedgerChatError("LEDGER_CHAT_INPUT", `账户「${account.name}」里没有${noun}「${text}」`);
}

function transactionSummary(tx: { kind: string; accountName: string; shareholderName?: string; counterpartyName?: string; amount: number; marketValueBefore: number; marketValueAfter: number; before: LedgerPosition[]; after: LedgerPosition[] }, liability: boolean): string {
  const who = tx.kind === "transfer"
    ? `${tx.shareholderName ?? "—"} → ${tx.counterpartyName ?? "—"} 转让 ${moneyText(tx.amount)} 元`
    : tx.kind === "revalue"
      ? (liability ? "余额调整" : "市值更新")
      : liability
        ? `向 ${tx.shareholderName ?? "—"} ${tx.kind === "deposit" ? "借款" : "还款"} ${moneyText(tx.amount)} 元`
        : `${tx.shareholderName ?? "—"} ${tx.kind === "deposit" ? "入金" : "出金"} ${moneyText(tx.amount)} 元`;
  const changes = tx.after.map((row) => {
    const before = tx.before.find((item) => item.shareholderId === row.shareholderId);
    return `${row.name} ${before ? pctText(before.percent) : "—"} → ${pctText(row.percent)}`;
  }).join("、");
  return `${tx.accountName} ${who}；${liability ? "余额" : "市值"} ${moneyText(tx.marketValueBefore)} → ${moneyText(tx.marketValueAfter)} 元；${changes}`;
}

function actionResult(result: RecordTransactionResult, liability: boolean): LedgerChatActionResult {
  const tx = result.transaction;
  return {
    ok: true,
    kind: tx.kind,
    accountId: tx.accountId,
    accountName: tx.accountName,
    accountKind: liability ? "liability" : "asset",
    ...(tx.shareholderName ? { shareholderName: tx.shareholderName } : {}),
    ...(tx.counterpartyName ? { counterpartyName: tx.counterpartyName } : {}),
    amount: tx.amount,
    marketValueBefore: tx.marketValueBefore,
    marketValueAfter: tx.marketValueAfter,
    before: tx.before,
    after: tx.after,
    ...(tx.note ? { note: tx.note } : {}),
    ...(result.duplicate ? { duplicate: true } : {}),
    summary: transactionSummary(tx, liability)
  };
}

export class LedgerChatService {
  private readonly now: () => number;
  private readonly usage = new Map<string, number[]>();
  private readonly replies = new Map<string, LedgerChatResult>();

  constructor(
    private readonly ledger: StockLedger,
    private readonly port?: ModelInvocationPort,
    options: LedgerChatOptions = {}
  ) {
    this.now = options.now ?? Date.now;
  }

  info(): LedgerChatInfo {
    const models = MODEL_CATALOG.models.filter((model) => model.status === "active").map((model) => {
      const levels = [...model.thinkingLevels] as string[];
      return {
        ref: model.ref,
        displayName: model.displayName,
        thinkingLevels: levels,
        defaultThinking: levels.includes(DEFAULT_LEDGER_CHAT_THINKING)
          ? DEFAULT_LEDGER_CHAT_THINKING
          : levels[levels.length - 1] ?? "high"
      };
    });
    return {
      available: !!this.port,
      promptVersion: LEDGER_CHAT_CONFIG.promptVersion,
      defaultModel: DEFAULT_LEDGER_CHAT_MODEL,
      defaultThinking: DEFAULT_LEDGER_CHAT_THINKING,
      models
    };
  }

  private allow(clientKey: string): boolean {
    const now = this.now();
    const recent = (this.usage.get(clientKey) ?? []).filter((time) => now - time < 60_000);
    if (recent.length >= 20) {
      this.usage.set(clientKey, recent);
      return false;
    }
    recent.push(now);
    this.usage.set(clientKey, recent);
    if (this.usage.size > 500) this.usage.clear();
    return true;
  }

  private configFor(model: string, thinking: string | undefined): { config: RoleModelConfig; ref: string; displayName: string; thinking: string } {
    const entry = catalogModel(model);
    if (!entry) throw new LedgerChatError("LEDGER_CHAT_MODEL", `${model} 不在平台模型目录里`);
    if (entry.status !== "active") throw new LedgerChatError("LEDGER_CHAT_MODEL", `${entry.displayName} 已退役，换一个模型`);
    const problem = effortProblem(model, thinking);
    if (problem) throw new LedgerChatError("LEDGER_CHAT_MODEL", problem);
    const levels = entry.thinkingLevels as string[];
    const level = thinking ?? (levels.includes(DEFAULT_LEDGER_CHAT_THINKING)
      ? DEFAULT_LEDGER_CHAT_THINKING
      : levels[levels.length - 1] ?? "high");
    return {
      config: { ...LEDGER_CHAT_CONFIG, provider: entry.provider, model: entry.model, thinking: level as RoleModelConfig["thinking"] },
      ref: entry.ref,
      displayName: entry.displayName,
      thinking: level
    };
  }

  private parseRequest(raw: unknown): LedgerChatRequest & { requestId?: string } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new LedgerChatError("LEDGER_CHAT_INPUT", "消息格式不对");
    const value = raw as Record<string, unknown>;
    if (!Array.isArray(value.messages) || value.messages.length === 0) throw new LedgerChatError("LEDGER_CHAT_INPUT", "先说点什么吧");
    if (value.messages.length > MAX_MESSAGES) throw new LedgerChatError("LEDGER_CHAT_INPUT", `一次最多带 ${MAX_MESSAGES} 条聊天记录`);
    let total = 0;
    const messages: LedgerChatMessage[] = value.messages.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new LedgerChatError("LEDGER_CHAT_INPUT", `第 ${index + 1} 条消息格式不对`);
      const turn = item as Record<string, unknown>;
      const role = turn.role === "assistant" ? "assistant" : turn.role === "user" ? "user" : null;
      if (!role) throw new LedgerChatError("LEDGER_CHAT_INPUT", `第 ${index + 1} 条消息的角色不对`);
      const text = typeof turn.text === "string" ? turn.text.trim() : "";
      if (!text) throw new LedgerChatError("LEDGER_CHAT_INPUT", "空消息不用发");
      if (text.length > MAX_MESSAGE_CHARS) throw new LedgerChatError("LEDGER_CHAT_INPUT", `一条消息最多 ${MAX_MESSAGE_CHARS} 个字`);
      total += text.length;
      return { role, text };
    });
    if (total > MAX_TOTAL_CHARS) throw new LedgerChatError("LEDGER_CHAT_INPUT", "聊天记录太长了，清空一下再聊");
    if (messages[messages.length - 1]!.role !== "user") throw new LedgerChatError("LEDGER_CHAT_INPUT", "最后一条要是用户说的话");
    const accountId = textOf(value.accountId, 80);
    const model = textOf(value.model, 120);
    const thinking = textOf(value.thinking, 20);
    const requestIdRaw = textOf(value.requestId, 100);
    const requestId = requestIdRaw && /^[A-Za-z0-9_-]{1,64}$/.test(requestIdRaw) ? requestIdRaw : undefined;
    return { messages, ...(accountId ? { accountId } : {}), ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(requestId ? { requestId } : {}) };
  }

  async chat(raw: unknown, clientKey = "local"): Promise<LedgerChatResult> {
    const input = this.parseRequest(raw);
    if (input.requestId) {
      const cached = this.replies.get(input.requestId);
      // 命中缓存时只换最新的账本快照：重试拿到的仍是当初那笔结果，不会重复记账。
      if (cached) return { ...cached, ledger: this.ledger.view(), duplicate: true };
    }
    if (!this.allow(clientKey)) throw new LedgerChatError("LEDGER_CHAT_RATE_LIMIT", "慢一点，几秒后再记；刚才的话还没有记账。", 429);
    if (!this.port) throw new LedgerChatError("LEDGER_CHAT_UNAVAILABLE", "记账助手还没有配置模型，暂时不能对话；页面里的手动动账照常可用。", 503);

    const chosen = this.configFor(
      input.model ?? DEFAULT_LEDGER_CHAT_MODEL,
      input.thinking ?? DEFAULT_LEDGER_CHAT_THINKING
    );
    const view = this.ledger.view();
    let output: { reply: string; actions: unknown[] };
    try {
      const response = await this.port.complete(chosen.config, { system: systemPrompt(), prompt: userPrompt(input, view) });
      output = parseModelOutput(response.text ?? "");
    } catch (error) {
      if (error instanceof LedgerChatError) throw error;
      throw new LedgerChatError("LEDGER_CHAT_UNAVAILABLE", "记账助手暂时连不上模型，这句话没有记账；稍后再试。", 503);
    }

    // 没有 requestId 的调用也要有互不相同的幂等键：同一毫秒内的两轮对话不能共用一笔动账。
    const actions = this.runActions(output.actions, input.requestId ?? `chat-${randomUUID()}`);
    const reply = output.reply || (actions.length
      ? "好的。"
      : "我没太确定你的意思，能再说清楚一点吗？比如「小明往富途账户入金 10 万」。");
    const result: LedgerChatResult = {
      reply,
      actions,
      model: { ref: chosen.ref, displayName: chosen.displayName, thinking: chosen.thinking },
      ledger: this.ledger.view()
    };
    if (input.requestId) {
      this.replies.set(input.requestId, result);
      while (this.replies.size > REQUEST_CACHE_LIMIT) this.replies.delete(this.replies.keys().next().value as string);
    }
    return result;
  }

  /** 顺序执行；第一笔失败就停下，避免把后面的动作记在错误的数据上。 */
  private runActions(rawActions: unknown[], requestId: string): LedgerChatActionResult[] {
    const results: LedgerChatActionResult[] = [];
    for (const [index, raw] of rawActions.entries()) {
      const action = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
      const kind = action && typeof action.kind === "string" ? action.kind : "unknown";
      try {
        if (!action) throw new LedgerChatError("LEDGER_CHAT_INPUT", "这一条指令看不懂，没有记账");
        results.push(this.runOne(kind, action, `${requestId}:${index}`));
      } catch (error) {
        if (!(error instanceof LedgerError) && !(error instanceof LedgerChatError)) throw error;
        results.push({ ok: false, kind, error: error.message });
        break;
      }
    }
    return results;
  }

  private runOne(kind: string, action: Record<string, unknown>, idempotencyKey: string): LedgerChatActionResult {
    const view = this.ledger.view();
    if (kind === "deposit" || kind === "withdraw") {
      const account = accountOf(view, action.account);
      const who = textOf(action.shareholder ?? action.holder, 60);
      if (!who) throw new LedgerChatError("LEDGER_CHAT_INPUT", account.kind === "liability" ? "请说明是哪位债权人" : "请说明是哪位股东");
      const known = account.shareholders.find((s) => s.name === who);
      const result = this.ledger.recordTransaction(account.id, {
        kind,
        ...(known ? { shareholderId: known.shareholderId } : { shareholderName: who }),
        amount: action.amount,
        marketValueAfter: action.marketValueAfter ?? action.marketValue,
        ...(action.note !== undefined ? { note: action.note } : {}),
        ...(action.occurredAt !== undefined ? { occurredAt: action.occurredAt } : {}),
        actor: "agent",
        idempotencyKey
      });
      return actionResult(result, account.kind === "liability");
    }
    if (kind === "transfer") {
      const account = accountOf(view, action.account);
      const noun = account.kind === "liability" ? "债权人" : "股东";
      const from = shareholderOf(account, action.from ?? action.shareholder, `转出${noun}`, noun);
      const to = shareholderOf(account, action.to ?? action.counterparty, `转入${noun}`, noun);
      if (from.shareholderId === to.shareholderId) throw new LedgerChatError("LEDGER_CHAT_INPUT", `转出和转入不能是同一个${noun}`);
      const result = this.ledger.recordTransaction(account.id, {
        kind, shareholderId: from.shareholderId, counterpartyId: to.shareholderId,
        amount: action.amount,
        ...(action.note !== undefined ? { note: action.note } : {}),
        ...(action.occurredAt !== undefined ? { occurredAt: action.occurredAt } : {}),
        actor: "agent",
        idempotencyKey
      });
      return actionResult(result, account.kind === "liability");
    }
    if (kind === "revalue") {
      const account = accountOf(view, action.account);
      const result = this.ledger.recordTransaction(account.id, {
        kind,
        marketValueAfter: action.marketValue ?? action.marketValueAfter,
        ...(action.note !== undefined ? { note: action.note } : {}),
        ...(action.occurredAt !== undefined ? { occurredAt: action.occurredAt } : {}),
        actor: "agent",
        idempotencyKey
      });
      return actionResult(result, account.kind === "liability");
    }
    if (kind === "create") {
      if (view.accounts.some((account) => account.name === textOf(action.name, 60))) {
        throw new LedgerChatError("LEDGER_CHAT_INPUT", "已经有同名账户了，换一个名字或直接用原账户");
      }
      const account = this.ledger.createAccount({
        name: action.name,
        kind: action.type ?? action.accountKind,
        marketValue: action.marketValue,
        broker: action.broker,
        accountNo: action.accountNo,
        note: action.note,
        shareholders: action.shareholders
      });
      const liability = account.kind === "liability";
      return {
        ok: true,
        kind,
        accountId: account.id,
        accountName: account.name,
        accountKind: account.kind,
        marketValueAfter: account.marketValue,
        after: account.shareholders,
        summary: `新建${liability ? "负债" : ""}账户 ${account.name}；${liability ? "余额" : "市值"} ${moneyText(account.marketValue)} 元；${account.shareholders.map((s) => `${s.name} ${pctText(s.percent)}`).join("、")}`
      };
    }
    if (kind === "undo") {
      const account = accountOf(view, action.account);
      const latest = view.transactions.find((tx) => tx.accountId === account.id);
      if (!latest) throw new LedgerError(`账户「${account.name}」还没有动账，没有可撤销的记录`);
      const { account: next, undo } = this.ledger.undoLast(latest.id);
      const liability = next.kind === "liability";
      return {
        ok: true,
        kind,
        accountId: next.id,
        accountName: next.name,
        accountKind: next.kind,
        ...(undo.shareholderName ? { shareholderName: undo.shareholderName } : {}),
        ...(undo.counterpartyName ? { counterpartyName: undo.counterpartyName } : {}),
        amount: undo.amount,
        marketValueBefore: undo.marketValueAfter,
        marketValueAfter: next.marketValue,
        before: undo.after,
        after: next.shareholders,
        undoneKind: undo.kind,
        summary: `撤销 ${next.name} 最近一笔（${liability ? (undo.kind === "deposit" ? "借款" : undo.kind === "withdraw" ? "还款" : undo.kind) : undo.kind} ${moneyText(undo.amount)} 元）；${liability ? "余额" : "市值"}回到 ${moneyText(next.marketValue)} 元；${next.shareholders.map((s) => `${s.name} ${pctText(s.percent)}`).join("、")}`
      };
    }
    throw new LedgerChatError("LEDGER_CHAT_INPUT", `不认识的指令「${kind}」，没有记账`);
  }
}
