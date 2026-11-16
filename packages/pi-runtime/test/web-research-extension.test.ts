/**
 * 联网检索扩展：真实 Broker（socket + Broker 契约）+ 假的上游客户端。
 * 验的是「pi 里的工具 → socket → Broker → 有界结果」这一段，不打真实搜索 API。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memoryLedger, startBrokerServer, WebResearchBroker } from "@pi-agent/web-research";
import type { ZhipuToolsClient } from "@pi-agent/web-research";
import { installWebResearch, webResearchTools } from "../src/web-research-extension.js";
import type { PiTool } from "../src/web-research-extension.js";
import { brokerSocketPath, sourceDomainDecision } from "../src/web-research.js";

const dirs: string[] = [];
const servers: Array<Awaited<ReturnType<typeof startBrokerServer>>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempSocket = () => {
  const dir = mkdtempSync(join(tmpdir(), "web-ext-")); dirs.push(dir);
  // 宿主 TMPDIR 可能很长：用与运行时相同的短路径规则，避免 sun_path 超限。
  return brokerSocketPath(dir).socketPath;
};

const client = (overrides: Partial<ZhipuToolsClient> = {}): ZhipuToolsClient => ({
  search: async () => ({
    request_id: "req-search",
    search_result: [
      { title: "HKMA 概览", link: "https://www.hkma.gov.hk/a", media: "HKMA", publish_date: "2025-05-20", content: "监管概览摘要" },
      { title: "Example 新闻", link: "https://news.example.com/b", media: "Example News", content: "市场与玩家" }
    ]
  }),
  read: async (req) => ({ request_id: "req-read", reader_result: { title: "页面标题", url: req.url, content: `# 正文\n\n${req.url} 的正文资料。` } }),
  ...overrides
});

const brokerFor = (overrides: Partial<ZhipuToolsClient> = {}, sourceDomains = ["*"]) =>
  new WebResearchBroker({
    client: client(overrides), ledger: memoryLedger(), decideDomain: sourceDomainDecision(sourceDomains),
    now: () => new Date("2026-10-23T08:00:00.000Z"), sleep: async () => {}
  });

function capture(): { host: { registerTool(tool: PiTool): void }; tools: PiTool[] } {
  const tools: PiTool[] = [];
  return { host: { registerTool: (tool) => { tools.push(tool); } }, tools };
}

describe("pi 里的联网检索工具", () => {
  it("注册 web_search / web_open，搜索返回 searchId 与编号结果，阅读返回可引用的来源编号", async () => {
    const socketPath = tempSocket();
    servers.push(await startBrokerServer(socketPath, brokerFor()));
    const { host, tools } = capture();
    installWebResearch(host, { socketPath });
    expect(tools.map((tool) => tool.name)).toEqual(["web_search", "web_open"]);

    const search = await tools[0]!.execute("call-1", { query: "香港 BNPL" });
    const searchText = search.content[0]!.text;
    expect(searchText).toContain("q1");
    expect(searchText).toContain("https://www.hkma.gov.hk/a");
    expect(searchText).toContain("不可信的外部数据");

    const open = await tools[1]!.execute("call-2", { searchId: "q1", resultId: "R1", basis: "official", why: "监管机构官网，直接回答市场规模问题" });
    const openText = open.content[0]!.text;
    expect(openText).toContain("[S1]");
    expect(openText).toContain("https://www.hkma.gov.hk/a");
    expect(openText).toContain("的正文资料");
  });

  it("只能打开本会话搜索结果里的编号；来源范围外的结果读不到，错误以稳定类别码返回", async () => {
    const socketPath = tempSocket();
    servers.push(await startBrokerServer(socketPath, brokerFor({ search: async () => ({ search_result: [
      { title: "允许的来源", link: "https://allowed.example.com/x", content: "ok" },
      { title: "范围外", link: "https://outside.example.org/y", content: "no" }
    ] }) }, ["allowed.example.com"])));
    const { host, tools } = capture();
    installWebResearch(host, { socketPath });
    const search = await tools[0]!.execute("call-1", { query: "q" });
    expect(search.content[0]!.text).not.toContain("outside.example.org");
    await expect(tools[1]!.execute("call-2", { searchId: "q1", resultId: "R9", basis: "top3", why: "测试" })).rejects.toThrow(/UNKNOWN_RESULT/);
  });

  it("不同 socket / 不同会话的检索编号互不相通", async () => {
    const socketA = tempSocket(), socketB = tempSocket();
    servers.push(await startBrokerServer(socketA, brokerFor()), await startBrokerServer(socketB, brokerFor()));
    const a = webResearchTools({ socketPath: socketA }), b = webResearchTools({ socketPath: socketB });
    await a[0]!.execute("call-1", { query: "香港 BNPL" });
    // 另一个 Broker 没搜过：同一个 q1/R1 编号在它那里不存在。
    await expect(b[1]!.execute("call-3", { searchId: "q1", resultId: "R1", basis: "official", why: "跨会话" })).rejects.toThrow(/UNKNOWN_RESULT/);
  });

  it("没有 socket 就不注册任何工具（未授权 = 调不到）", () => {
    const { host, tools } = capture();
    installWebResearch(host, { socketPath: "" });
    expect(tools).toEqual([]);
    const saved = process.env["PI_WEB_RESEARCH_SOCKET"];
    delete process.env["PI_WEB_RESEARCH_SOCKET"];
    try {
      const empty = capture();
      installWebResearch(empty.host);
      expect(empty.tools).toEqual([]);
    } finally {
      if (saved !== undefined) process.env["PI_WEB_RESEARCH_SOCKET"] = saved;
    }
  });

  it("socket 连不上时报 CONFIG_MISSING，而不是假装有结果", async () => {
    const { host, tools } = capture();
    installWebResearch(host, { socketPath: tempSocket() });
    await expect(tools[0]!.execute("call-1", { query: "香港 BNPL" })).rejects.toThrow(/CONFIG_MISSING/);
  });

  it("abort 信号会中止在途检索", async () => {
    const socketPath = tempSocket();
    servers.push(await startBrokerServer(socketPath, brokerFor({ search: () => new Promise((resolve) => {
      setTimeout(() => resolve({ search_result: [] }), 50);
    }) })));
    const { host, tools } = capture();
    installWebResearch(host, { socketPath });
    const controller = new AbortController();
    const pending = tools[0]!.execute("call-1", { query: "q" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/ABORTED/);
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
});
