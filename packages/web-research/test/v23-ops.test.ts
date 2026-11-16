/**
 * v2.3 P4：联网操作记录。进入预算即登记（编号在调用上游之前分配），完成回填；上游失败也有记录并计入次数；
 * 参数校验、权限拦截、预算耗尽没有进入预算，不记。阅读同理，失败的不伪装成已读。
 */
import { describe, expect, it } from "vitest";
import { memoryLedger, UpstreamError, WebResearchBroker } from "@pi-agent/web-research";
import type { ZhipuSearchResponse, ZhipuToolsClient } from "@pi-agent/web-research";
import type { WebOpRecord } from "@pi-agent/runtime-contracts";

const results = (n: number): ZhipuSearchResponse => ({ request_id: "r", search_result: [
  ...Array.from({ length: n }, (_, i) => ({ title: `T${i}`, link: `https://site${i}.example.com/p`, content: "x" })),
  { title: "内网", link: "https://10.0.0.1/x", content: "x" }
] });

function setup(client: Partial<ZhipuToolsClient>) {
  const ops: WebOpRecord[] = [];
  const log = { record: (op: WebOpRecord) => { const i = ops.findIndex((x) => x.opId === op.opId); if (i >= 0) ops[i] = op; else ops.push(op); } };
  const b = new WebResearchBroker({
    client: { search: async () => results(3), read: async (r) => ({ request_id: "rr", reader_result: { title: "页", url: r.url, content: "正文" } }), ...client },
    decideDomain: () => ({ effect: "ALLOW", reason: "ok" }), ledger: memoryLedger(), opLog: log, sleep: async () => {}, retries: 0,
    now: () => new Date("2026-09-27T08:00:00Z")
  });
  return { b, ops };
}

describe("联网操作记录", () => {
  it("成功搜索记返回数与剔除数；上游失败同样编号、记录、计入次数；校验失败与预算耗尽不记", async () => {
    let fail = false;
    const { b, ops } = setup({ search: async () => { if (fail) throw new UpstreamError(503, "BUSY", "busy"); return results(3); } });
    await b.search({ query: "a" }, "call-1");
    fail = true;
    await expect(b.search({ query: "b" }, "call-2")).rejects.toBeDefined();
    fail = false;
    await expect(b.search({ query: "" }, "call-3")).rejects.toThrowError(/不能为空/);
    const r = await b.search({ query: "c" }, "call-4");
    expect(r.searchId).toBe("q3");
    expect(ops.map((o) => [o.opId, o.kind, o.status, o.returned ?? null, o.filtered ?? null, o.toolCallId])).toEqual([
      ["q1", "search", "ok", 3, 1, "call-1"], ["q2", "search", "failed", null, null, "call-2"], ["q3", "search", "ok", 3, 1, "call-4"]
    ]);
    expect(ops[1].errorClass).toBeTruthy();
    expect(b.usage().searches).toBe(3);
  });

  it("阅读：成功记来源编号；失败记类别、不进台账", async () => {
    const { b, ops } = setup({ read: async (r) => { if (r.url.includes("site1")) throw new UpstreamError(500, "ERR", "x"); return { request_id: "rr", reader_result: { title: "页", url: r.url, content: "正文" } }; } });
    await b.search({ query: "a" }, "s");
    const ok = await b.open({ searchId: "q1", resultId: "R1" }, "o-1");
    await expect(b.open({ searchId: "q1", resultId: "R2" }, "o-2")).rejects.toBeDefined();
    expect(ops.filter((o) => o.kind === "open").map((o) => [o.opId, o.status, o.sourceId ?? null, o.resultId])).toEqual([["o1", "ok", ok.sourceId, "R1"], ["o2", "failed", null, "R2"]]);
  });
});
