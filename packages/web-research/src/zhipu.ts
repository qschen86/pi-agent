/**
 * 智谱 Coding Plan MCP 客户端：仅使用套餐搜索与阅读，不回退到普通计费 API。
 * 密钥只在这里使用：不进日志、不进返回值、不进错误信息。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { callMcp, object, protocolError } from "./mcp-http.js";
import type { McpOptions } from "./mcp-http.js";
export { UpstreamError } from "./mcp-http.js";

export const ZHIPU_SEARCH_MCP_URL = "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp";
export const ZHIPU_READER_MCP_URL = "https://open.bigmodel.cn/api/mcp/web_reader/mcp";

export interface ZhipuSearchRequest {
  search_query: string;
  search_engine: "search_std";
  count: number;
  search_recency_filter?: "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit";
  search_domain_filter?: string;
  request_id?: string;
}
export interface ZhipuSearchResult { title?: string; content?: string; link?: string; media?: string; publish_date?: string; refer?: string }
export interface ZhipuSearchResponse { request_id?: string; search_result?: ZhipuSearchResult[] }
export interface ZhipuReadRequest { url: string; return_format: "markdown" | "text"; retain_images: false; timeout: number; no_cache?: boolean }
export interface ZhipuReadResponse { request_id?: string; reader_result?: { content?: string; title?: string; url?: string; description?: string } }

export interface ZhipuToolsClient {
  search(req: ZhipuSearchRequest): Promise<ZhipuSearchResponse>;
  read(req: ZhipuReadRequest): Promise<ZhipuReadResponse>;
}

/**
 * 找密钥：先环境变量 ZHIPUAI_API_KEY，再 pi 的 auth.json 里 zhipu 的 API key。
 * 只返回找没找到与来源，调用方拿到的 key 只交给客户端。
 */
export function resolveZhipuKey(env: NodeJS.ProcessEnv = process.env, piAgentDir = env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent")): { key: string; source: string } | undefined {
  if (env["ZHIPUAI_API_KEY"]) return { key: env["ZHIPUAI_API_KEY"], source: "env:ZHIPUAI_API_KEY" };
  const auth = join(piAgentDir, "auth.json");
  if (existsSync(auth)) {
    try {
      const cred = (JSON.parse(readFileSync(auth, "utf8")) as Record<string, { type?: string; key?: string }>)["zhipu"];
      if (cred?.type === "api_key" && cred.key) return { key: cred.key, source: "pi-auth:zhipu" };
    } catch {
      /* 读不了就当没有 */
    }
  }
  return undefined;
}

/** Broker keeps its stable search/read contract; MCP transport stays on the host. */
export function createZhipuClient(options: McpOptions): ZhipuToolsClient {
  return {
    async search(req) {
      const data = await callMcp(ZHIPU_SEARCH_MCP_URL, "web_search_prime", {
        search_query: req.search_query, content_size: "medium",
        ...(req.search_domain_filter ? { search_domain_filter: req.search_domain_filter } : {}),
        ...(req.search_recency_filter ? { search_recency_filter: req.search_recency_filter } : {})
      }, options);
      const wrapper = Array.isArray(data) ? undefined : object(data);
      const rows = wrapper ? wrapper.search_result : data;
      if (!Array.isArray(rows)) throw protocolError();
      const search_result = rows.map(row => {
        const item = object(row);
        for (const key of ["title", "content", "link", "media", "publish_date", "refer"]) {
          if (item[key] !== undefined && typeof item[key] !== "string") throw protocolError();
        }
        if (typeof item.link !== "string") throw protocolError();
        return item as ZhipuSearchResult;
      });
      // Broker applies URL/domain filtering before limiting count.
      return { search_result, ...(typeof wrapper?.request_id === "string" ? { request_id: wrapper.request_id } : {}) };
    },
    async read(req) {
      const data = object(await callMcp(ZHIPU_READER_MCP_URL, "webReader", req, options));
      const page = object(data.reader_result ?? data);
      if (typeof page.content !== "string") throw protocolError();
      for (const key of ["title", "url", "description"]) {
        if (page[key] !== undefined && typeof page[key] !== "string") throw protocolError();
      }
      return { reader_result: page as NonNullable<ZhipuReadResponse["reader_result"]>, ...(typeof data.request_id === "string" ? { request_id: data.request_id } : {}) };
    }
  };
}
