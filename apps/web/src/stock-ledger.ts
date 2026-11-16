/**
 * 股票账户记账（股东占比与动账）。
 *
 * 一个账户 = 一个股票账户的当前市值 + 各股东在其中的权益金额。
 * 股东占比不单独存，一律由「股东权益 / 账户市值」算出来，避免百分比和金额各存一份后对不上。
 *
 * 动账时先记下一份「动账前」快照，再按下面四种方式改权益，最后记「动账后」快照：
 *   - 入金 / 出金：账户市值变化 = 市值差 - 资金流；市值差按动账前占比分给所有股东，
 *     资金流只加减到动账股东身上。这样股票本身的涨跌由全体按原占比承担，
 *     新投入 / 取出的钱只影响操作人。用户填的「动账后市值」就是实际看到的最新市值。
 *   - 股东间转让：账户市值不变，权益从一方转给另一方。
 *   - 市值更新：只改市值，涨跌按动账前占比分摊，占比不变。
 *
 * 金额一律用「分」的整数保存，占比用 4 位小数展示。单进程内同步读写，
 * 写入走「临时文件 → rename」，读者不会看到写了一半的 JSON。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type LedgerTransactionKind = "deposit" | "withdraw" | "transfer" | "revalue";
export type LedgerActor = "manual" | "agent";
/** 账户类型：资产账户（市值 / 股东权益）或负债账户（未还余额 / 债权人）。旧数据没有这个字段，按资产账户读。 */
export type LedgerAccountKind = "asset" | "liability";

export class LedgerError extends Error {
  readonly code: string = "LEDGER_INPUT_INVALID";
  readonly status: 400 | 404 | 409 = 400;
}
export class LedgerNotFound extends LedgerError {
  override readonly code = "LEDGER_NOT_FOUND";
  override readonly status = 404;
}
export class LedgerConflict extends LedgerError {
  override readonly code = "LEDGER_CONFLICT";
  override readonly status = 409;
}

export interface LedgerShareholder {
  id: string;
  name: string;
  /** 权益金额（分） */
  equityCents: number;
}

interface StoredAccount {
  id: string;
  name: string;
  broker?: string;
  accountNo?: string;
  note?: string;
  /** 缺省 = asset（兼容 V3.20 / V3.22 写下的数据） */
  kind?: LedgerAccountKind;
  marketValueCents: number;
  shareholders: LedgerShareholder[];
  createdAt: string;
  updatedAt: string;
}

export interface LedgerPosition {
  shareholderId: string;
  name: string;
  /** 权益金额（元） */
  equity: number;
  /** 占比（百分数，4 位小数） */
  percent: number;
}

export interface LedgerTransaction {
  id: string;
  accountId: string;
  accountName: string;
  kind: LedgerTransactionKind;
  actor: LedgerActor;
  occurredAt: string;
  recordedAt: string;
  /** 动账股东（入金 / 出金 / 转让的转出方） */
  shareholderId?: string;
  shareholderName?: string;
  /** 转让的转入方 */
  counterpartyId?: string;
  counterpartyName?: string;
  /** 资金流或转让金额（元，正数） */
  amount: number;
  marketValueBefore: number;
  marketValueAfter: number;
  before: LedgerPosition[];
  after: LedgerPosition[];
  note?: string;
}

interface StoredPosition {
  shareholderId: string;
  name: string;
  equityCents: number;
  percent: number;
}

interface StoredTransaction extends Omit<LedgerTransaction, "amount" | "marketValueBefore" | "marketValueAfter" | "before" | "after"> {
  amountCents: number;
  marketValueBeforeCents: number;
  marketValueAfterCents: number;
  before: StoredPosition[];
  after: StoredPosition[];
  /** agent / 页面重试时用来识别同一笔动账；不对外展示 */
  idempotencyKey?: string;
}

interface LedgerState {
  schema: 1;
  accounts: StoredAccount[];
  /** 按记录顺序排列，最新的在最后；对外输出时倒序 */
  transactions: StoredTransaction[];
}

export interface LedgerAccountView {
  id: string;
  name: string;
  kind: LedgerAccountKind;
  broker?: string;
  accountNo?: string;
  note?: string;
  marketValue: number;
  shareholders: LedgerPosition[];
  createdAt: string;
  updatedAt: string;
  transactionCount: number;
  lastTransactionAt?: string;
}

export interface LedgerView {
  schema: 1;
  generatedAt: string;
  summary: {
    accountCount: number;
    assetAccountCount: number;
    liabilityAccountCount: number;
    /** 资产账户的股东人数（不含负债账户的债权人） */
    shareholderCount: number;
    /** 负债账户的债权人人数 */
    creditorCount: number;
    /** 资产合计 */
    totalMarketValue: number;
    /** 负债合计（正值，表示未还余额） */
    liabilityTotal: number;
    /** 净资产 = 资产合计 - 负债合计 */
    netMarketValue: number;
    transactionCount: number;
  };
  accounts: LedgerAccountView[];
  transactions: LedgerTransaction[];
  transactionTotal: number;
}

export interface CreateAccountInput {
  name: unknown;
  /** 不填 = asset */
  kind?: unknown;
  broker?: unknown;
  accountNo?: unknown;
  note?: unknown;
  marketValue: unknown;
  shareholders: unknown;
}

export interface UpdateAccountInput {
  name?: unknown;
  broker?: unknown;
  accountNo?: unknown;
  note?: unknown;
  /** 可选：当前股东的改名列表 [{ id, name }]；历史快照里的姓名同步更新 */
  shareholders?: unknown;
}

export interface TransactionInput {
  kind: unknown;
  shareholderId?: unknown;
  shareholderName?: unknown;
  counterpartyId?: unknown;
  counterpartyName?: unknown;
  amount?: unknown;
  marketValueAfter?: unknown;
  occurredAt?: unknown;
  note?: unknown;
  actor?: unknown;
  /** 同一笔动账的重试键；相同键只写入一次 */
  idempotencyKey?: unknown;
}

export interface RecordTransactionResult {
  transaction: LedgerTransaction;
  account: LedgerAccountView;
  /** 幂等键命中已有动账：没有重复写入 */
  duplicate?: boolean;
}

const MAX_NAME = 60;
const MAX_NOTE = 500;
const MAX_SHAREHOLDERS = 30;
const MAX_AMOUNT_CENTS = 1_000_000_000_000_00; // 1 万亿元
const PERCENT_TOTAL = 1_000_000; // 100.0000% 用整数表示
const TX_RESPONSE_LIMIT = 1000;

const nowIso = () => new Date().toISOString();

function cleanText(value: unknown, field: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new LedgerError(`请填写${field}`);
    return undefined;
  }
  if (typeof value !== "string") throw new LedgerError(`${field}格式不对`);
  const text = value.trim();
  if (!text) {
    if (required) throw new LedgerError(`请填写${field}`);
    return undefined;
  }
  if (text.length > max) throw new LedgerError(`${field}不能超过 ${max} 个字`);
  return text;
}

/** 元 → 分；接受 number 或最多两位小数的字符串。 */
export function moneyToCents(value: unknown, field: string): number {
  let n: number;
  if (typeof value === "string") {
    const text = value.trim().replace(/,/g, "").replace(/^¥|^￥/, "");
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new LedgerError(`${field}要填不小于 0 的金额，最多两位小数`);
    n = Number(text);
  } else if (typeof value === "number") {
    n = value;
  } else {
    throw new LedgerError(`请填写${field}`);
  }
  if (!Number.isFinite(n) || n < 0) throw new LedgerError(`${field}要填不小于 0 的金额`);
  const cents = Math.round(n * 100);
  if (!Number.isSafeInteger(cents) || cents > MAX_AMOUNT_CENTS) throw new LedgerError(`${field}超出可记录范围`);
  if (Math.abs(cents - n * 100) > 1e-6) throw new LedgerError(`${field}最多两位小数`);
  return cents;
}

const centsToMoney = (cents: number): number => Math.round(cents) / 100;

function percentOf(equityCents: number, totalCents: number): number {
  if (totalCents <= 0) return 0;
  return Math.round((equityCents / totalCents) * PERCENT_TOTAL) / 10_000;
}

function positionView(shareholder: LedgerShareholder, totalCents: number): LedgerPosition {
  return {
    shareholderId: shareholder.id,
    name: shareholder.name,
    equity: centsToMoney(shareholder.equityCents),
    percent: percentOf(shareholder.equityCents, totalCents),
  };
}

function positionSnapshot(shareholders: LedgerShareholder[], totalCents: number) {
  return shareholders.map((s) => ({ shareholderId: s.id, name: s.name, equityCents: s.equityCents, percent: percentOf(s.equityCents, totalCents) }));
}

/** 把一段市值差按当前权益占比分成整数分；余数给小数部分最大的股东，保证总和准确。 */
function allocateDelta(equities: number[], deltaCents: number): number[] {
  if (!equities.length || deltaCents === 0) return equities.map(() => 0);
  const total = equities.reduce((sum, value) => sum + value, 0);
  if (total <= 0) throw new LedgerConflict("当前市值为 0，无法按占比分摊市值变化；请先入金或直接填写动账后市值");
  const negative = deltaCents < 0;
  const amount = BigInt(Math.abs(deltaCents));
  const weight = BigInt(total);
  const raw = equities.map((value) => BigInt(value) * amount);
  const base = raw.map((value) => value / weight);
  const remainders = raw.map((value) => value % weight);
  let left = amount - base.reduce((sum, value) => sum + value, 0n);
  const order = equities.map((_, index) => index).sort((a, b) => {
    if (remainders[a] !== remainders[b]) return remainders[a] > remainders[b] ? -1 : 1;
    if (equities[a] !== equities[b]) return equities[b]! - equities[a]!;
    return a - b;
  });
  for (const index of order) {
    if (left <= 0n) break;
    base[index] = base[index]! + 1n;
    left -= 1n;
  }
  return base.map((value) => Number(value) * (negative ? -1 : 1));
}

function parsePercent(value: unknown, field: string): number {
  let n: number;
  if (typeof value === "string") {
    const text = value.trim().replace(/%$/, "");
    if (!/^\d+(?:\.\d{1,4})?$/.test(text)) throw new LedgerError(`${field}要填 0~100 的百分比，最多四位小数`);
    n = Number(text);
  } else if (typeof value === "number") {
    n = value;
  } else {
    throw new LedgerError(`请填写${field}`);
  }
  if (!Number.isFinite(n) || n <= 0 || n > 100) throw new LedgerError(`${field}要填大于 0、不超过 100 的百分比`);
  return Math.round(n * 10_000);
}

function parseTime(value: unknown): string {
  if (value === undefined || value === null || value === "") return nowIso();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new LedgerError("动账时间格式不对");
  const time = new Date(value);
  if (time.getUTCFullYear() < 1970) throw new LedgerError("动账时间早于 1970 年");
  return time.toISOString();
}

function parseKind(value: unknown): LedgerTransactionKind {
  if (value === "deposit" || value === "withdraw" || value === "transfer" || value === "revalue") return value;
  throw new LedgerError("动账类型只能是 deposit / withdraw / transfer / revalue");
}

function parseActor(value: unknown): LedgerActor {
  return value === "agent" ? "agent" : "manual";
}

function parseAccountKind(value: unknown): LedgerAccountKind {
  if (value === undefined || value === null || value === "") return "asset";
  if (value === "asset" || value === "liability") return value;
  throw new LedgerError("账户类型只能是资产（asset）或负债（liability）");
}

function findShareholder(account: StoredAccount, id: unknown, name: unknown): LedgerShareholder | undefined {
  if (typeof id === "string" && id) {
    const hit = account.shareholders.find((s) => s.id === id);
    if (!hit) throw new LedgerNotFound("找不到这个股东");
    return hit;
  }
  const text = cleanText(name, "股东姓名", MAX_NAME);
  if (!text) return undefined;
  return account.shareholders.find((s) => s.name === text);
}

/** 当前市值必须等于股东权益之和；每次改动后都校验，坏数据不落盘。 */
function assertBalanced(account: StoredAccount): void {
  const sum = account.shareholders.reduce((total, s) => total + s.equityCents, 0);
  if (sum !== account.marketValueCents) throw new LedgerConflict("股东权益与账户市值对不上，已停止记账");
  if (account.shareholders.some((s) => !Number.isSafeInteger(s.equityCents) || s.equityCents < 0)) throw new LedgerConflict("股东权益不能为负数");
}

export class StockLedger {
  private state: LedgerState;

  constructor(private readonly file: string, private readonly onChange?: () => void) {
    mkdirSync(dirname(file), { recursive: true });
    this.state = this.load();
  }

  private load(): LedgerState {
    if (!existsSync(this.file)) return { schema: 1, accounts: [], transactions: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<LedgerState>;
      if (!parsed || parsed.schema !== 1 || !Array.isArray(parsed.accounts) || !Array.isArray(parsed.transactions)) throw new Error("bad ledger file");
      const accounts = parsed.accounts.filter((account): account is StoredAccount => {
        if (!account || typeof account !== "object") return false;
        if (typeof account.id !== "string" || typeof account.name !== "string") return false;
        if (!Number.isSafeInteger(account.marketValueCents) || account.marketValueCents < 0) return false;
        if (account.kind !== undefined && account.kind !== "asset" && account.kind !== "liability") return false;
        if (!Array.isArray(account.shareholders) || !account.shareholders.length) return false;
        return account.shareholders.every((s) => s && typeof s.id === "string" && typeof s.name === "string" && Number.isSafeInteger(s.equityCents) && s.equityCents >= 0);
      });
      for (const account of accounts) assertBalanced(account);
      const ids = new Set(accounts.flatMap((account) => account.shareholders.map((s) => s.id)));
      const transactions = parsed.transactions.filter((tx): tx is StoredTransaction => !!tx && typeof tx === "object"
        && typeof tx.id === "string" && typeof tx.accountId === "string" && accounts.some((a) => a.id === tx.accountId)
        && Array.isArray(tx.before) && Array.isArray(tx.after)
        && tx.before.every((row: { shareholderId?: unknown }) => !!row && typeof row.shareholderId === "string" && ids.has(row.shareholderId)));
      return { schema: 1, accounts, transactions };
    } catch {
      // 文件坏了不能让整个记账页打不开；保留原文件，页面上看到空数据，人工排查。
      return { schema: 1, accounts: [], transactions: [] };
    }
  }

  private save(): void {
    const target = this.file;
    const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, target);
    this.onChange?.();
  }

  private account(id: string): StoredAccount {
    const hit = this.state.accounts.find((account) => account.id === id);
    if (!hit) throw new LedgerNotFound("找不到这个股票账户");
    return hit;
  }

  private accountView(account: StoredAccount): LedgerAccountView {
    const transactions = this.state.transactions.filter((tx) => tx.accountId === account.id);
    return {
      id: account.id,
      name: account.name,
      kind: account.kind ?? "asset",
      ...(account.broker ? { broker: account.broker } : {}),
      ...(account.accountNo ? { accountNo: account.accountNo } : {}),
      ...(account.note ? { note: account.note } : {}),
      marketValue: centsToMoney(account.marketValueCents),
      shareholders: account.shareholders.map((s) => positionView(s, account.marketValueCents)),
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      transactionCount: transactions.length,
      ...(transactions.length ? { lastTransactionAt: transactions[transactions.length - 1]!.occurredAt } : {}),
    };
  }

  private transactionView(tx: StoredTransaction): LedgerTransaction {
    return {
      id: tx.id,
      accountId: tx.accountId,
      accountName: tx.accountName,
      kind: tx.kind,
      actor: tx.actor,
      occurredAt: tx.occurredAt,
      recordedAt: tx.recordedAt,
      ...(tx.shareholderId ? { shareholderId: tx.shareholderId } : {}),
      ...(tx.shareholderName ? { shareholderName: tx.shareholderName } : {}),
      ...(tx.counterpartyId ? { counterpartyId: tx.counterpartyId } : {}),
      ...(tx.counterpartyName ? { counterpartyName: tx.counterpartyName } : {}),
      amount: centsToMoney(tx.amountCents),
      marketValueBefore: centsToMoney(tx.marketValueBeforeCents),
      marketValueAfter: centsToMoney(tx.marketValueAfterCents),
      before: tx.before.map((row) => ({ shareholderId: row.shareholderId, name: row.name, equity: centsToMoney(row.equityCents), percent: row.percent })),
      after: tx.after.map((row) => ({ shareholderId: row.shareholderId, name: row.name, equity: centsToMoney(row.equityCents), percent: row.percent })),
      ...(tx.note ? { note: tx.note } : {}),
    };
  }

  view(): LedgerView {
    const assets = this.state.accounts.filter((account) => (account.kind ?? "asset") === "asset");
    const liabilities = this.state.accounts.filter((account) => account.kind === "liability");
    const totalMarketValueCents = assets.reduce((sum, account) => sum + account.marketValueCents, 0);
    const liabilityTotalCents = liabilities.reduce((sum, account) => sum + account.marketValueCents, 0);
    return {
      schema: 1,
      generatedAt: nowIso(),
      summary: {
        accountCount: this.state.accounts.length,
        assetAccountCount: assets.length,
        liabilityAccountCount: liabilities.length,
        shareholderCount: assets.reduce((sum, account) => sum + account.shareholders.length, 0),
        creditorCount: liabilities.reduce((sum, account) => sum + account.shareholders.length, 0),
        totalMarketValue: centsToMoney(totalMarketValueCents),
        liabilityTotal: centsToMoney(liabilityTotalCents),
        netMarketValue: centsToMoney(totalMarketValueCents - liabilityTotalCents),
        transactionCount: this.state.transactions.length,
      },
      accounts: this.state.accounts.map((account) => this.accountView(account)),
      transactions: this.state.transactions.slice(-TX_RESPONSE_LIMIT).reverse().map((tx) => this.transactionView(tx)),
      transactionTotal: this.state.transactions.length,
    };
  }

  createAccount(input: CreateAccountInput): LedgerAccountView {
    const name = cleanText(input.name, "账户名称", MAX_NAME, true)!;
    if (this.state.accounts.some((account) => account.name === name)) throw new LedgerConflict("已经有同名账户了，换一个名字或直接使用原标题账户");
    const kind = parseAccountKind(input.kind);
    const amountLabel = kind === "liability" ? "负债余额" : "账户市值";
    const marketValueCents = moneyToCents(input.marketValue, amountLabel);
    if (!Array.isArray(input.shareholders) || !input.shareholders.length) throw new LedgerError("至少要有 1 个股东");
    if (input.shareholders.length > MAX_SHAREHOLDERS) throw new LedgerError(`一个账户最多 ${MAX_SHAREHOLDERS} 个股东`);
    const rows = input.shareholders.map((raw, index) => {
      if (!raw || typeof raw !== "object") throw new LedgerError(`第 ${index + 1} 个股东格式不对`);
      const item = raw as { name?: unknown; percent?: unknown };
      const shareholderName = cleanText(item.name, `第 ${index + 1} 个股东姓名`, MAX_NAME, true)!;
      return { name: shareholderName, units: parsePercent(item.percent, `${shareholderName} 的占比`) };
    });
    const names = new Set<string>();
    for (const row of rows) {
      if (names.has(row.name)) throw new LedgerError(`股东「${row.name}」重复了`);
      names.add(row.name);
    }
    const units = rows.reduce((sum, row) => sum + row.units, 0);
    if (units !== PERCENT_TOTAL) throw new LedgerError(`股东占比合计要是 100%，现在是 ${(units / 10_000).toFixed(4).replace(/\.?0+$/, "")}%`);
    if (marketValueCents === 0 && rows.length > 1) throw new LedgerError(kind === "liability"
      ? "余额为 0 时只能先建一个 100% 的债权人；等有借款后再拆分"
      : "市值为 0 时只能先建一个 100% 的股东；等有市值或入金后再添加其他股东");
    // 按占比把市值分成整数分，余数给占比最大的股东。
    const raw = rows.map((row) => BigInt(marketValueCents) * BigInt(row.units));
    const base = raw.map((value) => Number(value / BigInt(PERCENT_TOTAL)));
    let left = marketValueCents - base.reduce((sum, value) => sum + value, 0);
    const order = rows.map((row, index) => index).sort((a, b) => {
      const ra = raw[a]! % BigInt(PERCENT_TOTAL), rb = raw[b]! % BigInt(PERCENT_TOTAL);
      if (ra !== rb) return ra > rb ? -1 : 1;
      return b - a;
    });
    for (const index of order) {
      if (left <= 0) break;
      base[index] = base[index]! + 1;
      left -= 1;
    }
    const at = nowIso();
    const broker = cleanText(input.broker, "券商", MAX_NAME);
    const accountNo = cleanText(input.accountNo, "账号", MAX_NAME);
    const note = cleanText(input.note, "备注", MAX_NOTE);
    const account: StoredAccount = {
      id: `acc-${randomUUID()}`,
      name,
      kind,
      ...(broker ? { broker } : {}),
      ...(accountNo ? { accountNo } : {}),
      ...(note ? { note } : {}),
      marketValueCents,
      shareholders: rows.map((row, index) => ({ id: `sh-${randomUUID()}`, name: row.name, equityCents: base[index]! })),
      createdAt: at,
      updatedAt: at,
    };
    assertBalanced(account);
    this.state.accounts.push(account);
    this.save();
    return this.accountView(account);
  }

  updateAccount(id: string, input: UpdateAccountInput): LedgerAccountView {
    const account = this.account(id);
    // 在副本上完成全部校验，任何一项失败都不会留下改了一半的内存状态。
    const next: StoredAccount = { ...account, shareholders: account.shareholders.map((s) => ({ ...s })) };
    if (input.name !== undefined) {
      const name = cleanText(input.name, "账户名称", MAX_NAME, true)!;
      if (this.state.accounts.some((item) => item.id !== id && item.name === name)) throw new LedgerConflict("已经有同名账户了");
      next.name = name;
    }
    for (const [field, key, label] of [["broker", "broker", "券商"], ["accountNo", "accountNo", "账号"], ["note", "note", "备注"]] as const) {
      if (input[field] === undefined) continue;
      const value = cleanText(input[field], label, key === "note" ? MAX_NOTE : MAX_NAME);
      if (!value) delete next[key];
      else next[key] = value;
    }
    const renames = new Map<string, string>();
    if (input.shareholders !== undefined) {
      if (!Array.isArray(input.shareholders)) throw new LedgerError("股东列表格式不对");
      const seen = new Set<string>();
      for (const raw of input.shareholders) {
        if (!raw || typeof raw !== "object") throw new LedgerError("股东列表格式不对");
        const item = raw as { id?: unknown; name?: unknown };
        if (typeof item.id !== "string" || !item.id) throw new LedgerError("股东 id 格式不对");
        const target = next.shareholders.find((s) => s.id === item.id);
        if (!target) throw new LedgerNotFound("找不到要改名的股东");
        if (seen.has(target.id)) throw new LedgerError("同一个股东在列表里出现了两次");
        seen.add(target.id);
        const name = cleanText(item.name, "股东姓名", MAX_NAME, true)!;
        if (next.shareholders.some((s) => s.id !== target.id && s.name === name)) throw new LedgerConflict(`股东「${name}」已经存在`);
        if (target.name !== name) { renames.set(target.id, name); target.name = name; }
      }
    }
    // 历史快照里的账户名 / 股东姓名只是标签，跟着当前值一起改，回看时不会一个对象两个名字。
    for (const tx of this.state.transactions) {
      if (tx.accountId !== next.id) continue;
      tx.accountName = next.name;
      if (renames.size) {
        for (const row of [...tx.before, ...tx.after]) if (renames.has(row.shareholderId)) row.name = renames.get(row.shareholderId)!;
        if (tx.shareholderId && renames.has(tx.shareholderId)) tx.shareholderName = renames.get(tx.shareholderId)!;
        if (tx.counterpartyId && renames.has(tx.counterpartyId)) tx.counterpartyName = renames.get(tx.counterpartyId)!;
      }
    }
    next.updatedAt = nowIso();
    const index = this.state.accounts.findIndex((item) => item.id === id);
    this.state.accounts[index] = next;
    this.save();
    return this.accountView(next);
  }

  recordTransaction(accountId: string, input: TransactionInput): RecordTransactionResult {
    const account = this.account(accountId);
    const idempotencyKey = cleanText(input.idempotencyKey, "幂等键", 120);
    if (idempotencyKey) {
      const existing = this.state.transactions.find((tx) => tx.idempotencyKey === idempotencyKey);
      if (existing) {
        if (existing.accountId !== account.id) throw new LedgerConflict("这个幂等键已经用于另一个账户的动账，请换一个键");
        return { transaction: this.transactionView(existing), account: this.accountView(account), duplicate: true };
      }
    }
    const kind = parseKind(input.kind);
    const actor = parseActor(input.actor);
    const occurredAt = parseTime(input.occurredAt);
    const note = cleanText(input.note, "备注", MAX_NOTE);
    const recordedAt = nowIso();
    const marketValueBeforeCents = account.marketValueCents;
    const before = positionSnapshot(account.shareholders, marketValueBeforeCents);
    // 先在一份副本上算，校验通过后才写回账户；中途报错不会留下算了一半的权益。
    const nextShareholders = account.shareholders.map((s) => ({ ...s }));
    let amountCents = 0;
    let shareholder: LedgerShareholder | undefined;
    let counterparty: LedgerShareholder | undefined;

    if (kind === "deposit" || kind === "withdraw") {
      amountCents = moneyToCents(input.amount, "动账金额");
      if (amountCents <= 0) throw new LedgerError("动账金额要大于 0");
      shareholder = findShareholder(account, input.shareholderId, input.shareholderName);
      if (!shareholder) {
        const newName = cleanText(input.shareholderName, "股东姓名", MAX_NAME);
        if (!newName) throw new LedgerError("请选择股东，或填写新股东姓名");
        if (kind === "withdraw") throw new LedgerError("取钱只能从已有股东账户操作；新股东请先入金");
        if (nextShareholders.length >= MAX_SHAREHOLDERS) throw new LedgerError(`一个账户最多 ${MAX_SHAREHOLDERS} 个股东`);
        if (nextShareholders.some((s) => s.name === newName)) throw new LedgerConflict(`股东「${newName}」已经存在`);
        shareholder = { id: `sh-${randomUUID()}`, name: newName, equityCents: 0 };
        nextShareholders.push(shareholder);
      } else {
        shareholder = nextShareholders.find((s) => s.id === shareholder!.id) ?? shareholder;
      }
    } else if (kind === "transfer") {
      amountCents = moneyToCents(input.amount, "转让金额");
      if (amountCents <= 0) throw new LedgerError("转让金额要大于 0");
      shareholder = findShareholder(account, input.shareholderId, input.shareholderName);
      if (!shareholder) throw new LedgerError("请选择转出股东");
      counterparty = findShareholder(account, input.counterpartyId, input.counterpartyName);
      if (!counterparty) throw new LedgerError("请选择转入股东");
      if (counterparty.id === shareholder.id) throw new LedgerError("转出和转入不能是同一个股东");
      shareholder = nextShareholders.find((s) => s.id === shareholder!.id) ?? shareholder;
      counterparty = nextShareholders.find((s) => s.id === counterparty!.id) ?? counterparty;
    }

    let marketValueAfterCents: number;
    if (kind === "revalue") {
      if (input.marketValueAfter === undefined || input.marketValueAfter === null || input.marketValueAfter === "") throw new LedgerError("市值更新要填写动账后市值");
      marketValueAfterCents = moneyToCents(input.marketValueAfter, "动账后市值");
      if (marketValueAfterCents === marketValueBeforeCents) throw new LedgerError("市值没有变化，不用记账");
    } else if (kind === "transfer") {
      marketValueAfterCents = input.marketValueAfter === undefined || input.marketValueAfter === null || input.marketValueAfter === ""
        ? marketValueBeforeCents
        : moneyToCents(input.marketValueAfter, "动账后市值");
      if (marketValueAfterCents !== marketValueBeforeCents) throw new LedgerError("股东间转让不改变账户市值；股票涨跌请单独记一笔市值更新");
    } else {
      const fallback = kind === "deposit" ? marketValueBeforeCents + amountCents : marketValueBeforeCents - amountCents;
      if (fallback < 0) throw new LedgerError("动账金额大于账户当前市值");
      marketValueAfterCents = input.marketValueAfter === undefined || input.marketValueAfter === null || input.marketValueAfter === ""
        ? fallback
        : moneyToCents(input.marketValueAfter, "动账后市值");
    }

    // 市值差（含股票涨跌）按动账前占比分摊；资金流只落在操作的股东身上。
    const flow = kind === "deposit" ? amountCents : kind === "withdraw" ? -amountCents : 0;
    const delta = marketValueAfterCents - marketValueBeforeCents - flow;
    const allocated = allocateDelta(nextShareholders.map((s) => s.equityCents), delta);
    nextShareholders.forEach((s, index) => { s.equityCents += allocated[index]!; });
    if (kind === "deposit" && shareholder) shareholder.equityCents += amountCents;
    if (kind === "withdraw" && shareholder) shareholder.equityCents -= amountCents;
    if (kind === "transfer" && shareholder && counterparty) {
      shareholder.equityCents -= amountCents;
      counterparty.equityCents += amountCents;
    }
    if (nextShareholders.some((s) => s.equityCents < 0)) throw new LedgerConflict("这笔动账会让股东权益变成负数；请核对金额和动账后市值");
    const nextBalance = { ...account, shareholders: nextShareholders, marketValueCents: marketValueAfterCents, updatedAt: recordedAt };
    assertBalanced(nextBalance);
    const after = positionSnapshot(nextShareholders, marketValueAfterCents);

    account.shareholders = nextShareholders;
    account.marketValueCents = marketValueAfterCents;
    account.updatedAt = recordedAt;

    const transaction: StoredTransaction = {
      id: `tx-${randomUUID()}`,
      accountId: account.id,
      accountName: account.name,
      kind,
      actor,
      occurredAt,
      recordedAt,
      ...(shareholder ? { shareholderId: shareholder.id, shareholderName: shareholder.name } : {}),
      ...(counterparty ? { counterpartyId: counterparty.id, counterpartyName: counterparty.name } : {}),
      amountCents,
      marketValueBeforeCents,
      marketValueAfterCents,
      before,
      after,
      ...(note ? { note } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
    this.state.transactions.push(transaction);
    this.save();
    return { transaction: this.transactionView(transaction), account: this.accountView(account) };
  }

  /** 删除没有任何动账的账户；有历史记录的账户不允许删，避免把账目一起丢掉。 */
  deleteAccount(id: string): { id: string } {
    const account = this.account(id);
    if (this.state.transactions.some((tx) => tx.accountId === account.id)) throw new LedgerConflict("这个账户已经有动账记录，不能删除；记错了请用反方向的动账修正");
    this.state.accounts = this.state.accounts.filter((item) => item.id !== account.id);
    this.save();
    return { id: account.id };
  }

  /** 撤销账户最近记录的一笔动账；只允许最后一笔，避免把后续动账算错。 */
  undoLast(transactionId: string): { account: LedgerAccountView; undo: LedgerTransaction } {
    const transaction = this.state.transactions.find((tx) => tx.id === transactionId);
    if (!transaction) throw new LedgerNotFound("找不到这笔动账");
    const accountTransactions = this.state.transactions.filter((tx) => tx.accountId === transaction.accountId);
    if (accountTransactions[accountTransactions.length - 1]?.id !== transaction.id) throw new LedgerConflict("只能撤销这个账户最近的一笔动账；更早的请用反方向的动账调整");
    const account = this.account(transaction.accountId);
    account.marketValueCents = transaction.marketValueBeforeCents;
    account.shareholders = transaction.before.map((row) => ({ id: row.shareholderId, name: row.name, equityCents: row.equityCents }));
    account.updatedAt = nowIso();
    assertBalanced(account);
    this.state.transactions = this.state.transactions.filter((tx) => tx.id !== transaction.id);
    this.save();
    return { account: this.accountView(account), undo: this.transactionView(transaction) };
  }
}
