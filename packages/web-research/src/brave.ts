/** Brave Web Search on the host; the reader is supplied independently. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ZhipuToolsClient, ZhipuSearchResponse } from "./zhipu.js";

export const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_KEY_FILE = fileURLToPath(new URL("../../../.pi-agent/brave-search-api-key", import.meta.url));
const FRESHNESS: Record<string, string> = { oneDay: "pd", oneWeek: "pw", oneMonth: "pm", oneYear: "py" };

export class BraveSearchError extends Error {
  constructor(readonly status: number, readonly kind: "PROTOCOL" | "TIMEOUT" | "NETWORK" | "HTTP") {
    super(`Brave Search ${kind.toLowerCase()} failure`);
  }
}

export function resolveBraveKey(
  env: NodeJS.ProcessEnv = process.env,
  keyFile = env["PI_AGENT_BRAVE_KEY_FILE"] ?? DEFAULT_KEY_FILE
): { key: string; source: string } | undefined {
  const fromEnv = env["BRAVE_SEARCH_API_KEY"]?.trim();
  if (fromEnv) return { key: fromEnv, source: "env:BRAVE_SEARCH_API_KEY" };
  if (!existsSync(keyFile)) return undefined;
  try {
    const st = statSync(keyFile);
    if (!st.isFile() || (st.mode & 0o077) !== 0) return undefined;
    const key = readFileSync(keyFile, "utf8").trim();
    return key ? { key, source: "file" } : undefined;
  } catch {
    return undefined;
  }
}

export function createBraveSearchClient(options: {
  apiKey: string;
  reader: Pick<ZhipuToolsClient, "read">;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): ZhipuToolsClient {
  return {
    async search(req): Promise<ZhipuSearchResponse> {
      const url = new URL(BRAVE_SEARCH_URL);
      url.searchParams.set("q", req.search_domain_filter ? `${req.search_query} site:${req.search_domain_filter}` : req.search_query);
      url.searchParams.set("count", "20"); // Filter unsafe/out-of-scope URLs before the Broker takes count.
      url.searchParams.set("result_filter", "web");
      url.searchParams.set("text_decorations", "false");
      const freshness = req.search_recency_filter && FRESHNESS[req.search_recency_filter];
      if (freshness) url.searchParams.set("freshness", freshness);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), options.timeoutMs ?? 30_000);
      try {
        const res = await (options.fetch ?? fetch)(url.toString(), {
          method: "GET", redirect: "error", signal: ctrl.signal,
          headers: { "X-Subscription-Token": options.apiKey, Accept: "application/json" }
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          throw new BraveSearchError(res.status, "HTTP");
        }
        const body = await res.json().catch(() => { throw new BraveSearchError(res.status, "PROTOCOL"); }) as unknown;
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new BraveSearchError(res.status, "PROTOCOL");
        const web = (body as Record<string, unknown>).web;
        if (web === undefined && typeof ((body as Record<string, unknown>).query as { original?: unknown } | undefined)?.original === "string") return { search_result: [] };
        if (!web || typeof web !== "object" || Array.isArray(web)) throw new BraveSearchError(res.status, "PROTOCOL");
        const rows = (web as Record<string, unknown>).results;
        if (!Array.isArray(rows)) throw new BraveSearchError(res.status, "PROTOCOL");
        const search_result = rows.map((row) => {
          if (!row || typeof row !== "object" || Array.isArray(row)) throw new BraveSearchError(res.status, "PROTOCOL");
          const item = row as Record<string, unknown>;
          if (typeof item.url !== "string") throw new BraveSearchError(res.status, "PROTOCOL");
          return {
            link: item.url,
            ...(typeof item.title === "string" ? { title: item.title } : {}),
            ...(typeof item.description === "string" ? { content: item.description } : {}),
            ...(typeof item.page_age === "string" && /^\d{4}-\d\d-\d\d/.test(item.page_age) ? { publish_date: item.page_age } : {})
          };
        });
        return { search_result };
      } catch (e) {
        if (e instanceof BraveSearchError) throw e;
        throw new BraveSearchError(0, ctrl.signal.aborted ? "TIMEOUT" : "NETWORK");
      } finally {
        clearTimeout(timer);
      }
    },
    read: options.reader.read
  };
}
