import { describe, expect, it } from "vitest";
import { createZhipuClient, memoryLedger, WebResearchBroker } from "../src/index.js";
const query = { search_query: "TypeScript", search_engine: "search_std" as const, count: 1 };
const hit = { title: "Docs", link: "https://www.typescriptlang.org/docs/", content: "summary" };
function server(result: unknown, sse = false) {
  const calls: Array<{ url: string; body: any; headers: Headers }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body, headers: new Headers(init.headers) });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const payload = { jsonrpc: "2.0", id: body.id, result: body.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: {} } : result };
    const text = JSON.stringify(payload);
    return new Response(sse ? `: heartbeat\r\n\r\nevent: message\r\ndata: ${text}\r\n\r\n` : text,
      { headers: { "content-type": sse ? "text/event-stream" : "application/json", "mcp-session-id": "session-test" } });
  }) as typeof fetch;
  return { calls, fetcher };
}
const content = (v: unknown) => ({ content: [{ type: "text", text: JSON.stringify(JSON.stringify(v)) }], isError: false });
describe("Coding Plan MCP", () => {
  it.each([false, true])("default search uses MCP, initializes session and decodes nested JSON (SSE %s)", async sse => {
    const s = server(content([hit]), sse);
    const c = createZhipuClient({ apiKey: "secret", fetch: s.fetcher });
    expect(await c.search({ ...query, search_domain_filter: "typescriptlang.org", search_recency_filter: "oneWeek" })).toEqual({ search_result: [hit] });
    expect(s.calls.map(x => x.body.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(s.calls.every(x => x.url === "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp")).toBe(true);
    expect(s.calls[2].headers.get("mcp-session-id")).toBe("session-test");
    expect(s.calls[2].body.params).toEqual({ name: "web_search_prime", arguments: { search_query: "TypeScript", search_domain_filter: "typescriptlang.org", search_recency_filter: "oneWeek", content_size: "medium" } });
  });
  it("reader maps final URL and content for Broker safety checks", async () => {
    const page = { title: "Docs", url: hit.link, content: "Body" };
    const s = server(content(page), true);
    const c = createZhipuClient({ apiKey: "secret", fetch: s.fetcher });
    expect(await c.read({ url: hit.link, return_format: "markdown", retain_images: false, timeout: 20 })).toEqual({ reader_result: page });
    expect(s.calls[2].url).toBe("https://open.bigmodel.cn/api/mcp/web_reader/mcp");
    expect(s.calls[2].body.params.name).toBe("webReader");
    expect(s.calls[2].body.params.arguments.retain_images).toBe(false);
  });
  it("structured results work without text blocks", async () => {
    const s = server({ structuredContent: { search_result: [hit], request_id: "request-1" } });
    expect(await createZhipuClient({ apiKey: "secret", fetch: s.fetcher }).search(query)).toEqual({ search_result: [hit], request_id: "request-1" });
  });
  it.each([null, { content: [{ type: "text", text: "not-json" }] }, content({ wrong: [] }), content([{ link: 42 }])])("rejects malformed results instead of reporting empty search", async result => {
    const s = server(result);
    await expect(createZhipuClient({ apiKey: "secret", fetch: s.fetcher }).search(query)).rejects.toMatchObject({ upstreamCode: "PROTOCOL" });
  });
  it("MCP tool errors are sanitized and never fall back to paid API", async () => {
    const s = server({ isError: true, content: [{ type: "text", text: 'error secret 1113 余额不足' }] });
    const b = new WebResearchBroker({ client: createZhipuClient({ apiKey: "secret", fetch: s.fetcher }), ledger: memoryLedger(), decideDomain: () => ({ effect: "ALLOW", reason: "ok" }), sleep: async () => {} });
    const e = await b.search({ query: "q" }).catch(e => e);
    expect(e.code).toBe("QUOTA_EXHAUSTED");
    expect(String(e)).not.toContain("secret");
    expect(s.calls.filter(x => x.body.method === "tools/call")).toHaveLength(1);
    expect(s.calls.every(x => x.url.includes("/api/mcp/"))).toBe(true);
  });
  it("HTTP 429 with 1113 is quota exhausted, not transient rate limiting", async () => {
    let calls = 0;
    const c = createZhipuClient({ apiKey: "secret", fetch: (async () => { calls++; return new Response(JSON.stringify({ error: { code: "1113", message: "secret" } }), { status: 429 }); }) as typeof fetch });
    const b = new WebResearchBroker({ client: c, ledger: memoryLedger(), decideDomain: () => ({ effect: "ALLOW", reason: "ok" }), sleep: async () => {} });
    await expect(b.search({ query: "q" })).rejects.toMatchObject({ code: "QUOTA_EXHAUSTED" });
    expect(calls).toBe(1);
  });
  it("reads a chunked SSE reply without waiting for server disconnect", async () => {
    let canceled = false;
    const s = server(content([hit]));
    const fetcher = (async (url: string, init: RequestInit) => {
      const req = JSON.parse(String(init.body));
      if (req.method !== "tools/call") return s.fetcher(url, init);
      const bytes = new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: content([{ ...hit, title: "中文" }]) })}\n\n`);
      return new Response(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); }, cancel() { canceled = true; } }), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const result = await createZhipuClient({ apiKey: "secret", fetch: fetcher, timeoutMs: 1000 }).search(query);
    expect(result.search_result?.[0].title).toBe("中文");
    expect(canceled).toBe(true);
  });
  it("deadline covers initialization and sanitizes transport failures", async () => {
    const fetcher = (async (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("secret")), { once: true });
    })) as typeof fetch;
    await expect(createZhipuClient({ apiKey: "secret", fetch: fetcher, timeoutMs: 5 }).search(query)).rejects.toMatchObject({ upstreamCode: "TIMEOUT" });
  });
  it("rejects a JSON-RPC reply for a different request", async () => {
    const fetcher = (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 900, result: { protocolVersion: "2024-11-05" } }))) as typeof fetch;
    await expect(createZhipuClient({ apiKey: "secret", fetch: fetcher }).search(query)).rejects.toMatchObject({ upstreamCode: "PROTOCOL" });
  });

});

describe("Broker approval checkpoint", () => {
  it("restores result references and consumed budget without a new search", async () => {
    let searches=0;
    const client={search:async()=>{searches++;return {search_result:[hit]};},read:async()=>({reader_result:{url:hit.link,content:"body"}})};
    const ledger=memoryLedger();const options={client,ledger,decideDomain:()=>({effect:"ALLOW",reason:"ok"}),budget:{searches:1}};
    const first=new WebResearchBroker(options);const found=await first.search({query:"docs"});
    const resumed=new WebResearchBroker({...options,checkpoint:first.checkpoint()});
    expect((await resumed.open({searchId:found.searchId,resultId:"R1"},"read-after-approval")).content).toBe("body");
    await expect(resumed.search({query:"again"})).rejects.toMatchObject({code:"BUDGET_EXHAUSTED"});
    expect(searches).toBe(1);
  });
});
