import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDeepSeekClient,
  memoryLedger,
  resolveDeepSeekKey,
  resolveWebResearchKeys,
  resolveWebResearchProvider,
  WebResearchBroker
} from "../src/index.js";
import type { WebOpRecord } from "@pi-agent/runtime-contracts";

const KEY = "sk-FAKE-DEEPSEEK-SECRET";
const now = () => new Date("2026-10-17T12:00:00.000Z");
const pageUrl = "https://example.org/report";

const searchBody = (results: unknown[]) => JSON.stringify({ results });
const fetchBody = (title: string, content: string) => JSON.stringify({ title, content });

function brokerWith(fetchImpl: typeof fetch, options: { services?: { search: string; fetch: string }; opLog?: { record(op: WebOpRecord): void }; retries?: number } = {}) {
  const client = createDeepSeekClient({ apiKey: KEY, fetch: fetchImpl, now, timeoutMs: 5_000 });
  return new WebResearchBroker({
    client,
    ledger: memoryLedger(),
    decideDomain: (domain) => ({ effect: domain === "example.org" ? "ALLOW" : "DENY", reason: "scope" }),
    sleep: async () => {},
    retries: options.retries ?? 0,
    ...(options.services ? { services: options.services } : {}),
    ...(options.opLog ? { opLog: options.opLog } : {})
  });
}

describe("DeepSeek Search & Fetch", () => {
  it("maps DeepSeek search results into the Broker contract; opens through the fetch endpoint", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      if (String(url).endsWith("/search")) {
        return new Response(searchBody([
          { title: "Blocked", url: "https://evil.example.net/a", snippet: "no", summary: "no", site_name: "Evil", date: null },
          { title: "Official", url: pageUrl, snippet: "BNPL evidence", summary: "longer summary", site_name: "Example Org", date: "2026-09-20T00:00:00+00:00", authority: 3 }
        ]), { status: 200 });
      }
      return new Response(fetchBody("Report", "# Evidence\nVerified"), { status: 200 });
    }) as typeof fetch;
    const broker = brokerWith(fetcher, { services: { search: "deepseek-search", fetch: "deepseek-fetch" } });

    const search = await broker.search({ query: "香港 PayLater", sourceDomain: "example.org", recency: "week", count: 1 });
    expect(search.results).toMatchObject([{
      resultId: "R1", title: "Official", url: pageUrl, snippet: "longer summary", media: "Example Org", publishedAt: "2026-09-20T00:00:00+00:00"
    }]);
    expect(search.filtered).toBe(1);

    const request = requests[0]!;
    expect(request.url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(request.init.method).toBe("POST");
    expect(new Headers(request.init.headers).get("Authorization")).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(request.init.body))).toEqual({
      query: "香港 PayLater site:example.org after:2026-10-10",
      count: 20,
      need_content: false
    });

    const opened = await broker.open({ searchId: search.searchId, resultId: "R1" }, "call-1");
    expect(opened).toMatchObject({ sourceId: "S1", url: pageUrl, title: "Report", content: "# Evidence\nVerified" });
    expect(requests[1]!.url).toBe("https://api.deepseek.com/v1/tools/fetch");
    expect(JSON.parse(String(requests[1]!.init.body))).toEqual({ url: pageUrl });
  });

  it("treats an empty results array as a valid empty search", async () => {
    const client = createDeepSeekClient({ apiKey: KEY, fetch: (async () => new Response(searchBody([]), { status: 200 })) as typeof fetch, now });
    expect(await client.search({ search_query: "nothing", search_engine: "search_std", count: 5 })).toEqual({ search_result: [] });
  });

  it("classifies upstream failures without leaking the key or response body", async () => {
    const cases: Array<{ status: number; operation: "search" | "read"; code: string }> = [
      { status: 401, operation: "search", code: "AUTH_FAILED" },
      { status: 402, operation: "search", code: "QUOTA_EXHAUSTED" },
      { status: 403, operation: "read", code: "UNREADABLE" },
      { status: 404, operation: "read", code: "UNREADABLE" },
      { status: 429, operation: "search", code: "RATE_LIMITED" },
      { status: 500, operation: "search", code: "UPSTREAM_ERROR" }
    ];
    for (const c of cases) {
      const fetcher = (async () => new Response(JSON.stringify({ error: { message: KEY } }), { status: c.status })) as typeof fetch;
      const client = createDeepSeekClient({ apiKey: KEY, fetch: fetcher, now });
      const call = c.operation === "search"
        ? client.search({ search_query: "x", search_engine: "search_std", count: 5 })
        : client.read({ url: pageUrl, return_format: "markdown", retain_images: false, timeout: 5 });
      const error = await call.catch((e: Error) => e);
      expect(String(error), `${c.status} ${c.operation}`).not.toContain(KEY);
      expect((error as { message?: string }).message).not.toContain(KEY);
      const broker = brokerWith((async () => new Response(JSON.stringify({ error: { message: KEY } }), { status: c.status })) as typeof fetch);
      const brokered = c.operation === "search"
        ? broker.search({ query: "x" })
        : (async () => {
            const brokerWithSearch = brokerWith((async (url: string) => String(url).endsWith("/search")
              ? new Response(searchBody([{ title: "T", url: pageUrl, snippet: "s" }]), { status: 200 })
              : new Response(JSON.stringify({ error: KEY }), { status: c.status })) as typeof fetch);
            const s = await brokerWithSearch.search({ query: "x" });
            return brokerWithSearch.open({ searchId: s.searchId, resultId: "R1" }, "call-1");
          })();
      await expect(brokered).rejects.toMatchObject({ code: c.code });
    }
  });

  it("rejects malformed responses as protocol errors", async () => {
    const fetcher = (async (url: string) => String(url).endsWith("/search")
      ? new Response(JSON.stringify({ results: [{ title: "no url" }] }), { status: 200 })
      : new Response(JSON.stringify({ title: "missing content" }), { status: 200 })) as typeof fetch;
    const client = createDeepSeekClient({ apiKey: KEY, fetch: fetcher, now });
    await expect(client.search({ search_query: "x", search_engine: "search_std", count: 5 })).rejects.toMatchObject({ kind: "PROTOCOL" });
    await expect(client.read({ url: pageUrl, return_format: "markdown", retain_images: false, timeout: 5 })).rejects.toMatchObject({ kind: "PROTOCOL" });
    await expect(brokerWith(fetcher).search({ query: "x" })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });

  it("records which upstream service each operation used", async () => {
    const ops: WebOpRecord[] = [];
    const fetcher = (async (url: string) => String(url).endsWith("/search")
      ? new Response(searchBody([{ title: "T", url: pageUrl, snippet: "s" }]), { status: 200 })
      : new Response(fetchBody("T", "body"), { status: 200 })) as typeof fetch;
    const broker = brokerWith(fetcher, {
      services: { search: "deepseek-search", fetch: "deepseek-fetch" },
      opLog: { record: (op) => { const i = ops.findIndex((x) => x.opId === op.opId); if (i >= 0) ops[i] = op; else ops.push(op); } }
    });
    const search = await broker.search({ query: "x" }, "call-1");
    await broker.open({ searchId: search.searchId, resultId: "R1" }, "call-2");
    expect(ops.map((o) => [o.kind, o.service, o.status])).toEqual([
      ["search", "deepseek-search", "ok"],
      ["open", "deepseek-fetch", "ok"]
    ]);
  });

  it("resolves the key from env, protected file, or Pi config", () => {
    const dir = mkdtempSync(join(tmpdir(), "deepseek-key-"));
    const file = join(dir, "key");
    writeFileSync(file, "  file-key\n");
    chmodSync(file, 0o600);
    expect(resolveDeepSeekKey({}, file, dir)).toEqual({ key: "file-key", source: "file" });
    expect(resolveDeepSeekKey({ DEEPSEEK_API_KEY: "env-key" }, file, dir)).toEqual({ key: "env-key", source: "env:DEEPSEEK_API_KEY" });
    chmodSync(file, 0o644);
    expect(resolveDeepSeekKey({}, file, dir)).toBeUndefined();

    writeFileSync(join(dir, "auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: "auth-key" } }));
    expect(resolveDeepSeekKey({}, join(dir, "none"), dir)).toEqual({ key: "auth-key", source: "pi-config:auth.json" });
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { deepseek: { apiKey: "DEEPSEEK_MODEL_KEY" } } }));
    expect(resolveDeepSeekKey({ DEEPSEEK_MODEL_KEY: "from-models-env" }, join(dir, "none"), dir)).toEqual({ key: "from-models-env", source: "env:DEEPSEEK_MODEL_KEY" });
  });
});

describe("system-level web research provider selection", () => {
  const keys = {
    deepseek: { key: "ds-key", source: "env:DEEPSEEK_API_KEY" },
    brave: { key: "brave-key", source: "env:BRAVE_SEARCH_API_KEY" },
    firecrawl: { key: "fc-key", source: "env:FIRECRAWL_API_KEY" }
  };

  it("keeps Brave + Firecrawl as the auto default, and can be switched explicitly", () => {
    const auto = resolveWebResearchProvider({ keys, fetch: (async () => new Response("{}")) as typeof fetch })!;
    expect(auto).toMatchObject({ id: "brave", services: { search: "brave", fetch: "firecrawl" } });
    expect(auto.credentials.map((c) => c.key)).toEqual(["brave-key", "fc-key"]);

    const ds = resolveWebResearchProvider({ keys, prefer: "deepseek", fetch: (async () => new Response("{}")) as typeof fetch })!;
    expect(ds).toMatchObject({ id: "deepseek", services: { search: "deepseek-search", fetch: "deepseek-fetch" } });
    expect(ds.credentials).toEqual([keys.deepseek]);
  });

  it("uses DeepSeek when Brave/Firecrawl are incomplete; explicit choice does not fall back", () => {
    const onlyDeepSeek = { deepseek: keys.deepseek };
    expect(resolveWebResearchProvider({ keys: onlyDeepSeek, fetch: (async () => new Response("{}")) as typeof fetch })?.id).toBe("deepseek");
    expect(resolveWebResearchProvider({ keys: onlyDeepSeek, prefer: "brave", fetch: (async () => new Response("{}")) as typeof fetch })).toBeUndefined();
    expect(resolveWebResearchProvider({ keys: { brave: keys.brave }, prefer: "deepseek", fetch: (async () => new Response("{}")) as typeof fetch })).toBeUndefined();
  });

  it("respects PI_AGENT_WEB_PROVIDER and rejects unknown values", () => {
    expect(resolveWebResearchProvider({ env: { PI_AGENT_WEB_PROVIDER: "deepseek" }, keys, fetch: (async () => new Response("{}")) as typeof fetch })?.id).toBe("deepseek");
    expect(resolveWebResearchProvider({ env: { PI_AGENT_WEB_PROVIDER: "brave-firecrawl" }, keys, fetch: (async () => new Response("{}")) as typeof fetch })?.id).toBe("brave");
    expect(() => resolveWebResearchProvider({ env: { PI_AGENT_WEB_PROVIDER: "other" }, keys })).toThrow(/PI_AGENT_WEB_PROVIDER/);
  });

  it("does not fill missing injected keys from the host environment", () => {
    const keys = resolveWebResearchKeys({ env: { DEEPSEEK_API_KEY: "must-not-read" }, keys: { brave: { key: "b", source: "test" } } });
    expect(keys).toEqual({ brave: { key: "b", source: "test" } });
  });
});
