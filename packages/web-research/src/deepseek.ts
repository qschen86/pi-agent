/**
 * DeepSeek Search & Fetch（2026-10 开放）：搜索与抓取都在同一把 API key 下。
 *
 * Broker 的稳定契约仍然是 search/read；这里只做协议映射：
 *   - POST /v1/tools/search → search_result（link/title/content/media/publish_date）
 *   - POST /v1/tools/fetch  → reader_result（content/title，URL 由 Broker 提供）
 * 上游错误正文包含请求上下文，不能透给 Agent；这里只保留 HTTP 状态与稳定类别。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ZhipuSearchResult, ZhipuToolsClient } from "./zhipu.js";

export const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
export const DEEPSEEK_FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";
const DEFAULT_KEY_FILE = fileURLToPath(new URL("../../../.pi-agent/deepseek-api-key", import.meta.url));
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

export class DeepSeekError extends Error {
  constructor(
    readonly status: number,
    readonly kind: "PROTOCOL" | "TIMEOUT" | "NETWORK" | "HTTP",
    readonly operation: "search" | "read"
  ) {
    super(`DeepSeek ${operation} ${kind.toLowerCase()} failure`);
  }
}

/**
 * 找密钥：DEEPSEEK_API_KEY → 受权限保护的本地文件 → Pi 的 models.json/auth.json。
 * 与模型 provider 的凭据查找顺序一致；只返回来源类别，密钥只交给客户端。
 */
export function resolveDeepSeekKey(
  env: NodeJS.ProcessEnv = process.env,
  keyFile = env["PI_AGENT_DEEPSEEK_KEY_FILE"] ?? DEFAULT_KEY_FILE,
  piAgentDir = env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent")
): { key: string; source: string } | undefined {
  const fromEnv = env["DEEPSEEK_API_KEY"]?.trim();
  if (fromEnv) return { key: fromEnv, source: "env:DEEPSEEK_API_KEY" };

  if (existsSync(keyFile)) {
    try {
      const st = statSync(keyFile);
      if (st.isFile() && (st.mode & 0o077) === 0) {
        const key = readFileSync(keyFile, "utf8").trim();
        if (key) return { key, source: "file" };
      }
    } catch {
      /* 读不了就当没有 */
    }
  }

  const models = readJson(join(piAgentDir, "models.json"));
  const apiKey = (models?.["providers"] as Record<string, Record<string, unknown>> | undefined)?.["deepseek"]?.["apiKey"];
  if (typeof apiKey === "string" && apiKey) {
    if (!ENV_NAME.test(apiKey)) return { key: apiKey, source: "pi-config:models.json" };
    const value = env[apiKey]?.trim();
    if (value) return { key: value, source: `env:${apiKey}` };
  }

  const auth = readJson(join(piAgentDir, "auth.json"));
  const cred = auth?.["deepseek"] as { type?: string; key?: string } | undefined;
  if (cred?.type === "api_key" && typeof cred.key === "string" && cred.key.trim()) {
    return { key: cred.key.trim(), source: "pi-config:auth.json" };
  }
  return undefined;
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(file)) return undefined;
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const RECENCY_DAYS: Record<string, number> = { oneDay: 1, oneWeek: 7, oneMonth: 30, oneYear: 365 };

/** DeepSeek 没有独立的 recency 字段，用官方查询运算符 after: 表达。 */
function recencyClause(filter: string | undefined, now: Date): string {
  const days = filter ? RECENCY_DAYS[filter] : undefined;
  if (!days) return "";
  return `after:${new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10)}`;
}

function record(value: unknown, operation: "search" | "read", status: number): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DeepSeekError(status, "PROTOCOL", operation);
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, operation: "search" | "read", status: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new DeepSeekError(status, "PROTOCOL", operation);
  return value;
}

function mapResult(row: unknown, status: number): ZhipuSearchResult {
  const item = record(row, "search", status);
  if (typeof item["url"] !== "string") throw new DeepSeekError(status, "PROTOCOL", "search");
  const title = optionalString(item["title"], "search", status);
  const snippet = optionalString(item["snippet"], "search", status);
  const summary = optionalString(item["summary"], "search", status);
  const siteName = optionalString(item["site_name"], "search", status);
  const date = optionalString(item["date"], "search", status);
  if (item["authority"] !== undefined && item["authority"] !== null && !Number.isInteger(item["authority"])) {
    throw new DeepSeekError(status, "PROTOCOL", "search");
  }
  // Broker 把 content 当作结果摘要（最长截 300 字）；优先用官方说明「给模型读」的 summary。
  const content = summary || snippet || "";
  return {
    link: item["url"],
    ...(title ? { title } : {}),
    ...(content ? { content } : {}),
    ...(siteName ? { media: siteName } : {}),
    ...(date ? { publish_date: date } : {})
  };
}

export function createDeepSeekClient(options: { apiKey: string; fetch?: typeof fetch; timeoutMs?: number; now?: () => Date }): ZhipuToolsClient {
  return {
    async search(req) {
      const now = (options.now ?? (() => new Date()))();
      const parts = [req.search_query];
      if (req.search_domain_filter) parts.push(`site:${req.search_domain_filter}`);
      const after = recencyClause(req.search_recency_filter, now);
      if (after) parts.push(after);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), options.timeoutMs ?? 30_000);
      try {
        const res = await (options.fetch ?? fetch)(DEEPSEEK_SEARCH_URL, {
          method: "POST",
          redirect: "error",
          signal: ctrl.signal,
          headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            query: parts.join(" "),
            // 与 Brave 一样多取一些：Broker 会先剔除不安全/范围外结果，再截到调用方要的 count。
            count: Math.min(50, Math.max(20, req.count)),
            need_content: false
          })
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          throw new DeepSeekError(res.status, "HTTP", "search");
        }
        const payload = record(await res.json().catch(() => { throw new DeepSeekError(res.status, "PROTOCOL", "search"); }), "search", res.status);
        if (!Array.isArray(payload["results"])) throw new DeepSeekError(res.status, "PROTOCOL", "search");
        return { search_result: payload["results"].map((row) => mapResult(row, res.status)) };
      } catch (error) {
        if (error instanceof DeepSeekError) throw error;
        throw new DeepSeekError(0, ctrl.signal.aborted ? "TIMEOUT" : "NETWORK", "search");
      } finally {
        clearTimeout(timer);
      }
    },

    async read(req) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), options.timeoutMs ?? req.timeout * 1000 + 5_000);
      try {
        const res = await (options.fetch ?? fetch)(DEEPSEEK_FETCH_URL, {
          method: "POST",
          redirect: "error",
          signal: ctrl.signal,
          headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ url: req.url })
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          throw new DeepSeekError(res.status, "HTTP", "read");
        }
        const payload = record(await res.json().catch(() => { throw new DeepSeekError(res.status, "PROTOCOL", "read"); }), "read", res.status);
        if (typeof payload["content"] !== "string" || typeof payload["title"] !== "string") {
          throw new DeepSeekError(res.status, "PROTOCOL", "read");
        }
        return { reader_result: {
          content: payload["content"],
          url: req.url,
          ...(payload["title"] ? { title: payload["title"] } : {})
        } };
      } catch (error) {
        if (error instanceof DeepSeekError) throw error;
        throw new DeepSeekError(0, ctrl.signal.aborted ? "TIMEOUT" : "NETWORK", "read");
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
