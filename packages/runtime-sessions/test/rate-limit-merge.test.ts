import { describe, expect, it } from "vitest";
import { mergeSampledRateLimit } from "../src/manager.js";

const NOW = Date.parse("2026-10-13T00:43:33.000Z");
const usageApi = {
  windows: [
    { label: "5 小时窗口", usedPercent: 37, resetsAt: "2026-10-13T04:19:59.969+00:00" },
    { label: "周窗口", usedPercent: 5, resetsAt: "2026-10-19T16:59:59.969+00:00" }
  ],
  plan: "pro", source: "Claude usage（实验接口，可能变化）", experimental: true, sampledAt: "2026-10-13T00:40:00.000Z", available: true
};
const event = (usedPercent: number | null, resetsAt = "2026-10-13T04:20:00.000Z", extra: Record<string, unknown> = {}) => ({
  windows: [{ label: "5 小时窗口", usedPercent, resetsAt }], source: "Claude rate_limit_event（运行中采样）", sampledAt: "2026-10-13T00:43:33.000Z", available: true, ...extra
});

describe("mergeSampledRateLimit", () => {
  it("同名窗口按模型组隔离，只更新对应模型组", () => {
    const original={...usageApi,windows:[{group:"Gemini",label:"周窗口",usedPercent:10,resetsAt:null},{group:"Claude / GPT",label:"周窗口",usedPercent:50,resetsAt:null}]};
    const next={...usageApi,windows:[{group:"Claude / GPT",label:"周窗口",usedPercent:75,resetsAt:null}]};
    expect(mergeSampledRateLimit(original,next,NOW).windows).toEqual([original.windows[0],next.windows[0]]);
  });
  it("keeps the known 5h percentage when a running sample carries no utilization", () => {
    const m = mergeSampledRateLimit(usageApi, event(null), NOW);
    expect(m.windows.map((w) => w.usedPercent)).toEqual([37, 5]);
    expect(m.windows[0]!.resetsAt).toBe("2026-10-13T04:20:00.000Z");
    // 没带新比例：不刷新采样时间和来源，定时查询照常补数
    expect(m.sampledAt).toBe(usageApi.sampledAt);
    expect(m.source).toBe(usageApi.source);
    expect(m.plan).toBe("pro");
  });

  it("takes a fresh percentage from the running sample", () => {
    const m = mergeSampledRateLimit(usageApi, event(41), NOW);
    expect(m.windows[0]!.usedPercent).toBe(41);
    expect(m.sampledAt).toBe("2026-10-13T00:43:33.000Z");
    expect(m.source).toContain("rate_limit_event");
  });

  it("does not carry a percentage across a window reset", () => {
    const rolled = { ...usageApi, windows: [{ label: "5 小时窗口", usedPercent: 90, resetsAt: "2026-10-13T00:00:00.000Z" }] };
    expect(mergeSampledRateLimit(rolled, event(null), NOW).windows[0]!.usedPercent).toBeNull();
  });

  it("stays unknown when nothing was known before", () => {
    const m = mergeSampledRateLimit(undefined, event(null), NOW);
    expect(m.windows[0]!.usedPercent).toBeNull();
    expect(m.sampledAt).toBe("2026-10-13T00:43:33.000Z");
  });

  it("clears a stale rejection reason once a later sample is not rejected", () => {
    const rejected = mergeSampledRateLimit(usageApi, event(100, undefined, { reason: "额度已用尽，请求被拒绝" }), NOW);
    expect(rejected.reason).toBe("额度已用尽，请求被拒绝");
    expect(mergeSampledRateLimit(rejected, event(null), NOW).reason).toBeUndefined();
  });
});
