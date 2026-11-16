import { describe, expect, it } from "vitest";
import { classifyWebTool, webActivity } from "../src/web-activity.js";
import type { ProjectedEvent } from "../src/types.js";

const tool = (seq: number, name: string, input: string | undefined, extra: Partial<NonNullable<ProjectedEvent["tool"]>> = {}, e: Partial<ProjectedEvent> = {}): ProjectedEvent =>
  ({ key: `k${seq}`, seq, kind: "tool", tool: { name, ...(input !== undefined ? { input } : {}), status: "completed", ...extra }, recordedAt: "2026-10-26T00:00:00Z", source: "stream", parserVersion: "t", availability: "recorded", ...e });

describe("web activity", () => {
  it("recognises search and fetch tools of all three runtimes and ignores the rest", () => {
    expect(["web_search", "WebSearch", "网页搜索", "mcp__brave__web_search", "brave.web-search"].map(classifyWebTool)).toEqual(Array(5).fill("search"));
    expect(["web_open", "WebFetch", "web_fetch", "mcp__x__web_fetch"].map(classifyWebTool)).toEqual(Array(4).fill("fetch"));
    expect(["bash", "read", "grep", "", undefined, "websearching"].map(n => classifyWebTool(n as string))).toEqual(Array(6).fill(undefined));
  });

  it("records nothing for a session that never searched", () => {
    expect(webActivity([tool(1, "bash", "ls"), { ...tool(2, "x", undefined), kind: "message" }])).toEqual([]);
  });

  it("parses a Pi search with its result count and top results", () => {
    const output = [
      "平台本轮预算（不是套餐余额）：剩余搜索 9 次",
      "搜索 q1「部署 流程」，检索时间 2026-10-26T00:00:00Z，共 2 条：",
      "UNTRUSTED",
      "R1. 官方文档 〔政府或监管机构官网〕\n   https://example.gov/doc · 发布时间 2026",
      "R2. 博客文章\n   https://blog.example.com/a · 发布时间 未知"
    ].join("\n");
    const [item] = webActivity([tool(3, "web_search", JSON.stringify({ query: "部署 流程", count: 5 }), { output }, { turnNo: 2, occurredAt: "2026-10-26T01:00:00Z" })]);
    expect(item).toMatchObject({ kind: "search", status: "ok", query: "部署 流程", resultCount: 2, turnNo: 2, occurredAt: "2026-10-26T01:00:00Z" });
    expect(item!.results).toEqual([{ title: "官方文档", url: "https://example.gov/doc" }, { title: "博客文章", url: "https://blog.example.com/a" }]);
  });

  it("takes the URL and title of a Pi web_open from its reply", () => {
    const output = "来源 [S1]：定价页面\nURL：https://example.com/pricing\n网页发布时间：未知";
    const [item] = webActivity([tool(4, "web_open", JSON.stringify({ searchId: "q1", resultId: "R1", basis: "official", why: "官方定价" }), { output })]);
    expect(item).toMatchObject({ kind: "fetch", url: "https://example.com/pricing", title: "定价页面", note: "官方定价" });
  });

  it("reads Claude WebFetch input and Codex plain-text search input", () => {
    const items = webActivity([
      tool(5, "WebFetch", JSON.stringify({ url: "https://a.example/x", prompt: "总结" })),
      tool(6, "网页搜索", "vitest 超时", { status: "" })
    ]);
    expect(items[0]).toMatchObject({ kind: "fetch", url: "https://a.example/x", note: "总结" });
    expect(items[1]).toMatchObject({ kind: "search", query: "vitest 超时", status: "ok" });
  });

  it("marks failures and in-flight calls and keeps the reason", () => {
    const items = webActivity([
      tool(7, "web_search", JSON.stringify({ query: "q" }), { status: "failed", output: "[TIMEOUT] 检索服务没有在时限内应答" }),
      tool(8, "web_search", JSON.stringify({ query: "r" }), { status: "running" }, { partial: true }),
      tool(9, "web_open", "{}", { status: "completed", output: "[UNKNOWN_RESULT] 没有 q9/R1" })
    ]);
    expect(items.map(i => i.status)).toEqual(["failed", "running", "failed"]);
    expect(items[0]!.note).toContain("TIMEOUT");
    expect(items[2]!.note).toContain("UNKNOWN_RESULT");
  });
});
