import { describe, expect, it } from "vitest";
import { platformInjectionItem, platformInjections } from "../src/platform-injection.js";
import type { ProjectedEvent } from "../src/types.js";

const event = (patch: Partial<ProjectedEvent>): ProjectedEvent => ({
  key: "platform-memory:1", seq: 1, kind: "notice", text: "已载入平台公共记忆：9 条", source: "platform",
  parserVersion: "v1", availability: "recorded", recordedAt: "2026-10-31T12:00:00.000Z", ...patch
});
const BODY = "【平台公共记忆】\n全局：\n- 用中文沟通。";

describe("platformInjections", () => {
  it("把首轮注入事件还原成卡片条目：正文、常驻条数、按需条数、轮次", () => {
    const item = platformInjectionItem(event({ turnNo: 1, injection: { label: "平台公共记忆", text: BODY, count: 9, onDemand: 82 } }))!;
    expect(item).toMatchObject({
      key: "platform-memory:1", label: "平台公共记忆", notice: "已载入平台公共记忆：9 条",
      count: 9, onDemand: 82, turnNo: 1, at: "2026-10-31T12:00:00.000Z"
    });
    expect(item.text).toBe(BODY);
    expect(item.chars).toBe(Array.from(BODY).length);
  });

  it("没有正文的事件不出条目（改造前的老会话只有那句通知），其他事件不混进来", () => {
    const items = platformInjections([
      event({}),                                                                                   // 改造前的老通知：只有条数
      event({ key: "user:1", kind: "message", text: "你好" }),                                      // 用户消息
      event({ key: "platform-memory:2", injection: { label: "平台公共记忆", text: "  ", count: 1 } }), // 空正文
      event({ key: "platform-memory:3", seq: 3, injection: { label: "平台公共记忆", text: "- A", count: 0, onDemand: 7 }, occurredAt: "2026-10-31T12:05:00.000Z" })
    ]);
    expect(items.map((i) => i.key)).toEqual(["platform-memory:3"]);
    // 发生时间优先：卡片按它排序
    expect(items[0]!.at).toBe("2026-10-31T12:05:00.000Z");
    expect(items[0]!.count).toBe(0);
    expect(items[0]!.onDemand).toBe(7);
  });

  it("异常超长正文截断到上限，长度仍按原文报", () => {
    const huge = "字".repeat(20_010);
    const item = platformInjectionItem(event({ injection: { label: "平台公共记忆", text: huge, count: 1 } }))!;
    expect(Array.from(item.text)).toHaveLength(20_000);
    expect(item.chars).toBe(20_010);
  });
});
