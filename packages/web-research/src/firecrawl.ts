/** Firecrawl v2 scrape adapter for the host-side web.open tool. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ZhipuToolsClient } from "./zhipu.js";

export const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
const DEFAULT_KEY_FILE = fileURLToPath(new URL("../../../.pi-agent/firecrawl-api-key", import.meta.url));

export class FirecrawlError extends Error {
  constructor(readonly status: number, readonly kind: "PROTOCOL" | "TIMEOUT" | "NETWORK" | "HTTP" | "PAGE_STATUS" | "REJECTED") {
    super(`Firecrawl ${kind.toLowerCase()} failure`);
  }
}

export function resolveFirecrawlKey(
  env: NodeJS.ProcessEnv = process.env,
  keyFile = env["PI_AGENT_FIRECRAWL_KEY_FILE"] ?? DEFAULT_KEY_FILE
): { key: string; source: string } | undefined {
  const fromEnv = env["FIRECRAWL_API_KEY"]?.trim();
  if (fromEnv) return { key: fromEnv, source: "env:FIRECRAWL_API_KEY" };
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

export function createFirecrawlReader(options: { apiKey: string; fetch?: typeof fetch; timeoutMs?: number }): Pick<ZhipuToolsClient, "read"> {
  return {
    async read(req) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), options.timeoutMs ?? req.timeout * 1000 + 5_000);
      try {
        const response = await (options.fetch ?? fetch)(FIRECRAWL_SCRAPE_URL, {
          method: "POST", redirect: "error", signal: ctrl.signal,
          headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ url: req.url, formats: ["markdown"], onlyMainContent: true, maxAge: 0, timeout: req.timeout * 1000 })
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new FirecrawlError(response.status, "HTTP");
        }
        const payload = await response.json().catch(() => { throw new FirecrawlError(response.status, "PROTOCOL"); }) as unknown;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new FirecrawlError(response.status, "PROTOCOL");
        const envelope = payload as Record<string, unknown>;
        if (envelope.success === false) throw new FirecrawlError(response.status, "REJECTED");
        if (envelope.success !== true || !envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) {
          throw new FirecrawlError(response.status, "PROTOCOL");
        }
        const data = envelope.data as Record<string, unknown>;
        if (typeof data.markdown !== "string" || !data.metadata || typeof data.metadata !== "object" || Array.isArray(data.metadata)) {
          throw new FirecrawlError(response.status, "PROTOCOL");
        }
        const metadata = data.metadata as Record<string, unknown>;
        const pageStatus = metadata.statusCode;
        if (pageStatus !== undefined && (typeof pageStatus !== "number" || !(pageStatus >= 200 && pageStatus < 300 || pageStatus === 304))) {
          throw new FirecrawlError(typeof pageStatus === "number" ? pageStatus : 0, "PAGE_STATUS");
        }
        const sourceUrl = typeof metadata.url === "string" ? metadata.url : metadata.sourceURL;
        if (typeof sourceUrl !== "string") throw new FirecrawlError(response.status, "PROTOCOL");
        return { reader_result: {
          content: data.markdown,
          url: sourceUrl,
          ...(typeof metadata.title === "string" ? { title: metadata.title } : {}),
          ...(typeof metadata.description === "string" ? { description: metadata.description } : {})
        } };
      } catch (error) {
        if (error instanceof FirecrawlError) throw error;
        throw new FirecrawlError(0, ctrl.signal.aborted ? "TIMEOUT" : "NETWORK");
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
