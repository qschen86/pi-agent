/**
 * Codex「reset 卡」（rate-limit reset credits）的只读取数。
 *
 * 数据来自 Codex 自己用的用量接口，凭据是本机 Codex 客户端的登录态（默认 ~/.codex/auth.json）：
 * - GET /backend-api/wham/rate-limit-reset-credits         现在有几张可用、每张的说明与过期时间
 * - GET /backend-api/wham/rate-limit-reset-credits/history 发放 / 使用流水（后端只保留 30 天）
 *
 * 取舍：
 * - 不操作桌面、不点客户端按钮：客户端那个按钮背后就是同一组接口，读它不会惊动正在跑的客户端。
 * - 解析全部写成纯函数（parseAvailable / parseHistory / mergeLedger / windowStats），
 *   字段名兼容后端可能改的 snake_case ↔ camelCase，缺字段只是变成 null，不抛错。
 * - 历史接口只有 30 天窗口，所以本地要把每张卡的 granted / used 时刻沉淀下来（见 store.ts），
 *   否则「过去 7 天用了几张」在窗口滚过去之后就查不到了。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const BASE_URL = "https://chatgpt.com/backend-api";
export const AVAILABLE_PATH = "/wham/rate-limit-reset-credits";
export const HISTORY_PATH = "/wham/rate-limit-reset-credits/history";
export const DAY_MS = 86_400_000;

export interface CodexAuth {
  accessToken: string;
  accountId: string | null;
  /** access_token 自带 exp；拿不到时为 null（交给服务端 401 兜底）。 */
  expiresAtMs: number | null;
}

/** Codex 客户端默认的登录态位置；PI_CODEX_HOME / CODEX_HOME 可覆盖。 */
export function codexAuthPath(home = process.env["PI_CODEX_HOME"] ?? process.env["CODEX_HOME"] ?? join(homedir(), ".codex")): string {
  return join(home, "auth.json");
}

/** JWT 的 exp（秒）→ 毫秒；解不开返回 null。 */
export function jwtExpiryMs(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { exp?: unknown };
    return typeof json.exp === "number" && Number.isFinite(json.exp) ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** auth.json → 取数需要的字段；没有 chatgpt 登录态（例如用 API key）时返回 null。 */
export function parseCodexAuth(raw: string): CodexAuth | null {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  const root = data as { auth_mode?: unknown; tokens?: { access_token?: unknown; account_id?: unknown } };
  const token = typeof root?.tokens?.access_token === "string" ? root.tokens.access_token : "";
  if (!token) return null;
  const accountId = typeof root?.tokens?.account_id === "string" ? root.tokens.account_id : null;
  return { accessToken: token, accountId, expiresAtMs: jwtExpiryMs(token) };
}

export function readCodexAuth(path = codexAuthPath()): CodexAuth | null {
  try { return parseCodexAuth(readFileSync(path, "utf8")); } catch { return null; }
}

export interface ResetCredit {
  id: string;
  /** available / redeeming / redeemed / unknown */
  status: string;
  grantedAt: string | null;
  expiresAt: string | null;
  title: string | null;
  description: string | null;
}

export interface ResetEvent {
  id: string;
  /** granted / used */
  kind: string;
  at: string;
}

export interface ResetSnapshot {
  at: string;
  availableCount: number;
  totalEarnedCount: number;
  credits: ResetCredit[];
  events: ResetEvent[];
  historyWindowStart: string | null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const pick = (row: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const key of keys) if (row[key] !== undefined && row[key] !== null) return row[key];
  return null;
};
const isoFromSeconds = (value: unknown): string | null => (typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : null);
const isoFromValue = (value: unknown): string | null => {
  if (typeof value === "number") return isoFromSeconds(value);
  const raw = text(value);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const int = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);

/** GET /wham/rate-limit-reset-credits 的响应。 */
export function parseAvailable(body: unknown): { availableCount: number; totalEarnedCount: number; credits: ResetCredit[] } {
  const root = (body ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(root["credits"]) ? root["credits"] : [];
  const credits: ResetCredit[] = [];
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = text(pick(row, "id", "credit_id", "creditId"));
    if (!id) continue;
    credits.push({
      id,
      status: text(pick(row, "status")) ?? "unknown",
      grantedAt: isoFromValue(pick(row, "granted_at", "grantedAt")),
      expiresAt: isoFromValue(pick(row, "expires_at", "expiresAt")),
      title: text(pick(row, "title")),
      description: text(pick(row, "description"))
    });
  }
  return {
    availableCount: typeof pick(root, "available_count", "availableCount") === "number"
      ? int(pick(root, "available_count", "availableCount"))
      : credits.filter((c) => c.status === "available").length,
    totalEarnedCount: int(pick(root, "total_earned_count", "totalEarnedCount")),
    credits
  };
}

/** GET /wham/rate-limit-reset-credits/history 的响应。 */
export function parseHistory(body: unknown): { events: ResetEvent[]; windowStart: string | null } {
  const root = (body ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(root["events"]) ? root["events"] : [];
  const events: ResetEvent[] = [];
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = text(pick(row, "id"));
    const at = isoFromValue(pick(row, "occurred_at", "occurredAt"));
    if (!id || !at) continue;
    events.push({ id, kind: text(pick(row, "kind")) ?? "unknown", at });
  }
  return { events, windowStart: isoFromValue(pick(root, "window_start", "windowStart")) };
}

/** 事件 ID 形如 `RateLimitResetCredit_xxx:used`，冒号前就是卡 ID。 */
export function creditIdOf(eventId: string): string {
  const at = eventId.lastIndexOf(":");
  return at > 0 ? eventId.slice(0, at) : eventId;
}

export interface CreditLedgerEntry { grantedAt: string | null; usedAt: string | null }
export type CreditLedger = Record<string, CreditLedgerEntry>;

/** 把一次拉到的流水并进本地台账；返回本次新出现的发放 / 使用（用于「有新卡」的提示）。 */
export function mergeLedger(prev: CreditLedger, events: ResetEvent[]): { ledger: CreditLedger; newGranted: string[]; newUsed: string[] } {
  const ledger: CreditLedger = { ...prev };
  const newGranted: string[] = [];
  const newUsed: string[] = [];
  for (const event of events) {
    const id = creditIdOf(event.id);
    const entry = ledger[id] ?? { grantedAt: null, usedAt: null };
    if (event.kind === "granted") {
      if (!entry.grantedAt) newGranted.push(id);
      if (!entry.grantedAt || Date.parse(event.at) < Date.parse(entry.grantedAt)) entry.grantedAt = event.at;
    } else if (event.kind === "used") {
      if (!entry.usedAt) newUsed.push(id);
      if (!entry.usedAt || Date.parse(event.at) < Date.parse(entry.usedAt)) entry.usedAt = event.at;
    }
    ledger[id] = entry;
  }
  return { ledger, newGranted: unique(newGranted), newUsed: unique(newUsed) };
}

const unique = (list: string[]): string[] => [...new Set(list)];

export interface LedgerStats {
  used24h: number; used7d: number; used30d: number; usedTotal: number;
  granted7d: number; granted30d: number; grantedTotal: number;
  /** 最近一次使用（ISO），没有则 null */
  lastUsedAt: string | null;
}

/** 按「现在」往前数，统计用掉的 / 发放的卡。时刻一律按绝对时间比较，展示时再换北京时间。 */
export function windowStats(ledger: CreditLedger, now: Date | number = new Date()): LedgerStats {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const stats: LedgerStats = { used24h: 0, used7d: 0, used30d: 0, usedTotal: 0, granted7d: 0, granted30d: 0, grantedTotal: 0, lastUsedAt: null };
  for (const entry of Object.values(ledger)) {
    if (entry.usedAt) {
      const ms = Date.parse(entry.usedAt);
      if (Number.isFinite(ms)) {
        stats.usedTotal += 1;
        if (nowMs - ms <= DAY_MS) stats.used24h += 1;
        if (nowMs - ms <= 7 * DAY_MS) stats.used7d += 1;
        if (nowMs - ms <= 30 * DAY_MS) stats.used30d += 1;
        if (!stats.lastUsedAt || ms > Date.parse(stats.lastUsedAt)) stats.lastUsedAt = entry.usedAt;
      }
    }
    if (entry.grantedAt) {
      const ms = Date.parse(entry.grantedAt);
      if (Number.isFinite(ms)) {
        stats.grantedTotal += 1;
        if (nowMs - ms <= 7 * DAY_MS) stats.granted7d += 1;
        if (nowMs - ms <= 30 * DAY_MS) stats.granted30d += 1;
      }
    }
  }
  return stats;
}

export type FetchJson = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; json: () => Promise<unknown> }>;

export class CodexResetFetchError extends Error {
  constructor(message: string, readonly code: "no-auth" | "expired" | "http" | "network") { super(message); this.name = "CodexResetFetchError"; }
}

export interface CollectOptions {
  authPath?: string;
  fetchImpl?: FetchJson;
  now?: () => Date;
  timeoutMs?: number;
}

async function getJson(fetchImpl: FetchJson, auth: CodexAuth, path: string, timeoutMs: number): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: "application/json",
    origin: "https://chatgpt.com",
    referer: "https://chatgpt.com/",
    "User-Agent": "pi-agent/codex-reset"
  };
  if (auth.accountId) headers["chatgpt-account-id"] = auth.accountId;
  let response: { status: number; json: () => Promise<unknown> };
  try {
    response = await fetchImpl(`${BASE_URL}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new CodexResetFetchError(`连不上 Codex 用量接口：${(error as Error).message}`, "network");
  }
  if (response.status === 401 || response.status === 403) throw new CodexResetFetchError("Codex 登录态已失效，需要在本机重新登录 Codex 客户端", "expired");
  if (response.status < 200 || response.status >= 300) throw new CodexResetFetchError(`Codex 用量接口返回 ${response.status}`, "http");
  try { return await response.json(); } catch (error) { throw new CodexResetFetchError(`Codex 用量接口返回的不是 JSON：${(error as Error).message}`, "http"); }
}

const defaultFetch: FetchJson = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchJson>;

/** 额度刷新只读当前可用卡，不重复拉取历史流水。 */
export async function collectAvailableCredits(options: CollectOptions = {}): Promise<ReturnType<typeof parseAvailable>> {
  const auth = readCodexAuth(options.authPath ?? codexAuthPath());
  if (!auth) throw new CodexResetFetchError("没有找到 Codex 登录态", "no-auth");
  const now = options.now ?? (() => new Date());
  if (auth.expiresAtMs && auth.expiresAtMs < now().getTime()) throw new CodexResetFetchError("Codex 登录态已过期", "expired");
  const body = await getJson(options.fetchImpl ?? defaultFetch, auth, AVAILABLE_PATH, options.timeoutMs ?? 5_000);
  const root = body as Record<string, unknown> | null;
  const count = root && pick(root, "available_count", "availableCount");
  if (!root || (typeof count !== "number" && !Array.isArray(root["credits"]))) {
    throw new CodexResetFetchError("Codex 重置卡接口缺少可用卡数据", "http");
  }
  return parseAvailable(body);
}

/** 拉一次当前可用卡 + 最近 30 天流水。读不到登录态时抛 no-auth（页面据此提示怎么处理）。 */
export async function collectResetSnapshot(options: CollectOptions = {}): Promise<ResetSnapshot> {
  const authPath = options.authPath ?? codexAuthPath();
  const auth = readCodexAuth(authPath);
  if (!auth) throw new CodexResetFetchError(`没有找到 Codex 登录态（${authPath}）`, "no-auth");
  const now = options.now ?? (() => new Date());
  if (auth.expiresAtMs && auth.expiresAtMs < now().getTime()) throw new CodexResetFetchError("Codex 登录态已过期，需要在本机重新登录", "expired");
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const available = parseAvailable(await getJson(fetchImpl, auth, AVAILABLE_PATH, timeoutMs));
  const history = parseHistory(await getJson(fetchImpl, auth, HISTORY_PATH, timeoutMs));
  return {
    at: now().toISOString(),
    availableCount: available.availableCount,
    totalEarnedCount: available.totalEarnedCount,
    credits: available.credits,
    events: history.events,
    historyWindowStart: history.windowStart
  };
}
