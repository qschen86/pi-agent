import { expect, it } from "vitest";
import { ClaudeDriver } from "../src/claude.js";
import { CLAUDE_EVALUATION_TOOLS } from "../src/claude-evaluation-policy.js";
it("test SDK doubles and injected guards never declare a formal evaluation policy", () => {
  expect(new ClaudeDriver({ sdk: { query: () => { throw new Error("unused"); } } as never }).evaluationPolicy()).toBeUndefined();
  expect(new ClaudeDriver({ guard: { name: "fake", available: () => true, prepare: async () => { throw new Error("unused"); } } as never }).evaluationPolicy()).toBeUndefined();
});
it.skipIf(process.platform !== "darwin")("the real SDK under the production guard declares a stable policy over exactly the protected tool channels", () => {
  const a = new ClaudeDriver().evaluationPolicy(), b = new ClaudeDriver().evaluationPolicy();
  expect(a?.version).toMatch(/^claude-evaluation@1:sha256:[a-f0-9]{64}$/);
  expect(a?.version).toBe(b?.version);
  expect(a?.channels).toEqual([...CLAUDE_EVALUATION_TOOLS.map((t) => `claude:builtin:${t}`), "claude:child-process", "claude:host-tool-gate"]);
});
