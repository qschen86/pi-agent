import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBraveSearchClient, createFirecrawlReader, memoryLedger, resolveFirecrawlKey, WebResearchBroker } from "../src/index.js";

const pageUrl = "https://example.org/report";
const page = (metadata: Record<string, unknown> = { sourceURL: pageUrl, statusCode: 200 }) =>
  new Response(JSON.stringify({ success: true, data: { markdown: "# Evidence\nVerified", metadata: { title: "Report", ...metadata } } }), { status: 200 });

describe("Firecrawl web.open", () => {
  it("sends only the searched URL to v2 scrape and maps Markdown into the existing Broker contract", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const reader = createFirecrawlReader({ apiKey: "fc-FAKE-SECRET", fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return page();
    }) as typeof fetch });
    const client = createBraveSearchClient({ apiKey: "brave-fake", reader, fetch: (async () =>
      new Response(JSON.stringify({ web: { results: [{ title: "Hit", url: pageUrl }] } }), { status: 200 })) as typeof fetch });
    const ledger = memoryLedger();
    const broker = new WebResearchBroker({ client, ledger, decideDomain: () => ({ effect: "ALLOW", reason: "test" }) });
    const search = await broker.search({ query: "report" });
    const opened = await broker.open({ searchId: search.searchId, resultId: "R1" }, "call-1");
    expect(opened).toMatchObject({ sourceId: "S1", url: pageUrl, title: "Report", content: "# Evidence\nVerified" });
    expect(ledger.list()).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(calls[0].init.method).toBe("POST");
    expect(new Headers(calls[0].init.headers).get("Authorization")).toBe("Bearer fc-FAKE-SECRET");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ url: pageUrl, formats: ["markdown"], onlyMainContent: true, maxAge: 0 });
  });

  it("rejects an out-of-scope final URL before recording a source", async () => {
    const reader = createFirecrawlReader({ apiKey: "fc-test", fetch: (async () => page({ sourceURL: pageUrl, url: "https://outside.example.net/", statusCode: 200 })) as typeof fetch });
    const ledger = memoryLedger();
    const broker = new WebResearchBroker({ client: { search: async () => ({ search_result: [{ link: pageUrl }] }), read: reader.read }, ledger,
      decideDomain: (domain) => ({ effect: domain === "example.org" ? "ALLOW" : "DENY", reason: "scope" }) });
    const search = await broker.search({ query: "report" });
    await expect(broker.open({ searchId: search.searchId, resultId: "R1" }, "call-1")).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(ledger.list()).toHaveLength(0);
  });

  it("rejects a page-level 404 even if the API request succeeded", async () => {
    const reader = createFirecrawlReader({ apiKey: "fc-test", fetch: (async () => page({ sourceURL: pageUrl, statusCode: 404 })) as typeof fetch });
    await expect(reader.read({ url: pageUrl, return_format: "markdown", retain_images: false, timeout: 20 })).rejects.toMatchObject({ kind: "PAGE_STATUS" });
  });

  it("keeps upstream error text and the key out of Broker errors", async () => {
    const key = "fc-FAKE-SECRET";
    const reader = createFirecrawlReader({ apiKey: key, fetch: (async () => new Response(JSON.stringify({ error: key }), { status: 401 })) as typeof fetch });
    const broker = new WebResearchBroker({ client: { search: async () => ({ search_result: [{ link: pageUrl }] }), read: reader.read },
      ledger: memoryLedger(), decideDomain: () => ({ effect: "ALLOW", reason: "test" }) });
    const search = await broker.search({ query: "report" });
    const error = await broker.open({ searchId: search.searchId, resultId: "R1" }, "call-1").catch((e: Error) => e);
    expect(error).toMatchObject({ code: "AUTH_FAILED" });
    expect(String(error)).not.toContain(key);
  });

  it("resolves the 0600 key file and prefers the host environment", () => {
    const file = join(mkdtempSync(join(tmpdir(), "firecrawl-key-")), "key");
    writeFileSync(file, "  fc-file-key\n");
    chmodSync(file, 0o600);
    expect(resolveFirecrawlKey({}, file)).toEqual({ key: "fc-file-key", source: "file" });
    expect(resolveFirecrawlKey({ FIRECRAWL_API_KEY: "fc-env-key" }, file)).toEqual({ key: "fc-env-key", source: "env:FIRECRAWL_API_KEY" });
    chmodSync(file, 0o644);
    expect(resolveFirecrawlKey({}, file)).toBeUndefined();
  });
});
