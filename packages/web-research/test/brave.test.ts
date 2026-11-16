import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBraveSearchClient, resolveBraveKey, WebResearchBroker, memoryLedger } from "../src/index.js";
import type { ZhipuToolsClient } from "../src/index.js";

const KEY = "FAKE_BRAVE_SECRET";
const reader: ZhipuToolsClient = {
  search: async () => { throw new Error("Zhipu search must not run"); },
  read: async (req) => ({ reader_result: { url: req.url, title: "Page", content: "# Source page\nVerified content" } })
};

describe("Brave search with the existing web reader", () => {
  it("maps Brave results to the Broker and keeps web.open on the reader", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ web: { results: [
        { title: "Blocked", url: "https://evil.example.net/a", description: "no" },
        { title: "Official", url: "https://example.org/report", description: "Evidence", page_age: "2026-09-20" }
      ] } }), { status: 200 });
    }) as typeof fetch;
    const client = createBraveSearchClient({ apiKey: KEY, reader, fetch: fetcher });
    const broker = new WebResearchBroker({ client, ledger: memoryLedger(), decideDomain: (d) => ({ effect: d === "example.org" ? "ALLOW" : "DENY", reason: "scope" }) });
    const search = await broker.search({ query: "香港 PayLater", sourceDomain: "example.org", recency: "week", count: 1 });
    expect(search.results).toMatchObject([{ resultId: "R1", title: "Official", url: "https://example.org/report", snippet: "Evidence", publishedAt: "2026-09-20" }]);
    expect(search.filtered).toBe(1);
    const request = requests[0];
    expect(request.url).toContain("https://api.search.brave.com/res/v1/web/search?");
    const params = new URL(request.url).searchParams;
    expect(params.get("q")).toBe("香港 PayLater site:example.org");
    expect(params.get("freshness")).toBe("pw");
    expect(params.get("result_filter")).toBe("web");
    expect(new Headers(request.init.headers).get("X-Subscription-Token")).toBe(KEY);
    const opened = await broker.open({ searchId: "q1", resultId: "R1" }, "call-1");
    expect(opened).toMatchObject({ sourceId: "S1", url: "https://example.org/report", content: "# Source page\nVerified content" });
  });

  it("does not expose the API key in upstream errors", async () => {
    const client = createBraveSearchClient({ apiKey: KEY, reader, fetch: (async () => new Response(JSON.stringify({ error: KEY }), { status: 401 })) as typeof fetch });
    const broker = new WebResearchBroker({ client, ledger: memoryLedger(), decideDomain: () => ({ effect: "ALLOW", reason: "test" }) });
    await expect(broker.search({ query: "test" })).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await expect(broker.search({ query: "test" })).rejects.not.toThrow(KEY);
  });

  it("treats a valid empty search response as zero results", async () => {
    const client = createBraveSearchClient({ apiKey: KEY, reader, fetch: (async () => new Response(JSON.stringify({ type: "search", query: { original: "nothing" } }), { status: 200 })) as typeof fetch });
    expect(await client.search({ search_query: "nothing", search_engine: "search_std", count: 5 })).toEqual({ search_result: [] });
  });

  it("reads the local ignored key file and prefers the host environment", () => {
    const file = join(mkdtempSync(join(tmpdir(), "brave-key-")), "key");
    writeFileSync(file, "  file-key\n");
    chmodSync(file, 0o600);
    expect(resolveBraveKey({}, file)).toEqual({ key: "file-key", source: "file" });
    expect(resolveBraveKey({ BRAVE_SEARCH_API_KEY: "env-key" }, file)).toEqual({ key: "env-key", source: "env:BRAVE_SEARCH_API_KEY" });
    chmodSync(file, 0o644);
    expect(resolveBraveKey({}, file)).toBeUndefined();
  });
});
