import { expect, it } from "vitest";
import { projectPiMessage } from "../src/pi-projection.js";

it("projects Pi content in its original order so thinking stays before the reply text", () => {
  const kinds = (content: unknown) => projectPiMessage({ role: "assistant", timestamp: 1, content }, "stream").map((e) => e.kind);
  expect(kinds([{ type: "thinking", thinking: "先想" }, { type: "text", text: "回答" }])).toEqual(["reasoning", "message"]);
  expect(kinds([{ type: "thinking", thinking: "先想" }, { type: "toolCall", id: "c1", name: "bash", arguments: {} }])).toEqual(["reasoning", "tool"]);
  expect(kinds([{ type: "text", text: "说明" }, { type: "toolCall", id: "c2", name: "bash", arguments: {} }])).toEqual(["message", "tool"]);
  // 多段正文合成一条消息，位置在第一段正文处
  const multi = projectPiMessage({ role: "assistant", timestamp: 2, content: [{ type: "text", text: "a" }, { type: "thinking", thinking: "t" }, { type: "text", text: "b" }] }, "stream");
  expect(multi.map((e) => [e.kind, e.text])).toEqual([["message", "a\nb"], ["reasoning", "t"]]);
  // 字符串内容（用户消息）照旧
  expect(projectPiMessage({ role: "user", timestamp: 3, content: "你好" }, "stream").map((e) => [e.kind, e.text])).toEqual([["message", "你好"]]);
});
