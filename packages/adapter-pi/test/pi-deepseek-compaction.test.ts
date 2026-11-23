import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_DEEPSEEK_COMPACTION, preparePiRuntime } from "../src/pi-runtime-env.js";

const made: string[] = [];
const dir = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

function source(settings?: unknown): string {
  const d = dir("pi-compact-src-");
  if (settings) writeFileSync(join(d, "settings.json"), JSON.stringify(settings));
  return d;
}
function written(root: string): Record<string, any> | undefined {
  const file = join(root, "pi-agent", "settings.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

describe("DeepSeek 会话的上下文压缩默认值", () => {
  it("开启后给两个 DeepSeek 模型写入触发线和保留量，触发线约 15 万", () => {
    const rt = preparePiRuntime(dir("pi-compact-rt-"), { sourceAgentDir: source(), provider: "deepseek", compactionDefaults: true });
    const overrides = written(rt.root)!.compaction.modelOverrides;
    expect(overrides["deepseek/deepseek-flash"]).toEqual(PI_DEEPSEEK_COMPACTION);
    expect(overrides["deepseek/deepseek-v4-pro"]).toEqual(PI_DEEPSEEK_COMPACTION);
    // 原生窗口 100 万：触发线 = 窗口 − reserveTokens
    expect(1_000_000 - PI_DEEPSEEK_COMPACTION.reserveTokens).toBe(150_000);
    expect(PI_DEEPSEEK_COMPACTION.keepRecentTokens).toBe(40_000);
    expect(rt.carried.settingsKeys).toContain("compaction");
  });

  it("本轮指定的模型也会覆盖到", () => {
    const rt = preparePiRuntime(dir("pi-compact-rt-"), { sourceAgentDir: source(), provider: "deepseek", model: "deepseek-next", compactionDefaults: true });
    expect(written(rt.root)!.compaction.modelOverrides["deepseek/deepseek-next"]).toEqual(PI_DEEPSEEK_COMPACTION);
  });

  it("用户 settings.json 里写了同名项就以用户的为准，其余设置原样保留", () => {
    const rt = preparePiRuntime(dir("pi-compact-rt-"), {
      sourceAgentDir: source({
        theme: "dark", defaultProvider: "deepseek",
        compaction: { enabled: true, modelOverrides: { "deepseek/deepseek-flash": { reserveTokens: 700_000 }, "other/model": { keepRecentTokens: 1 } } }
      }),
      compactionDefaults: true
    });
    const s = written(rt.root)!;
    expect(s.theme).toBe("dark");
    expect(s.compaction.enabled).toBe(true);
    expect(s.compaction.modelOverrides["deepseek/deepseek-flash"]).toEqual({ reserveTokens: 700_000, keepRecentTokens: 40_000 });
    expect(s.compaction.modelOverrides["other/model"]).toEqual({ keepRecentTokens: 1 });
  });

  it("不开 compactionDefaults（如评测装配）不写任何压缩设置", () => {
    const rt = preparePiRuntime(dir("pi-compact-rt-"), { sourceAgentDir: source(), provider: "deepseek" });
    expect(written(rt.root)).toBeUndefined();
  });

  it("非 DeepSeek provider 不受影响", () => {
    const rt = preparePiRuntime(dir("pi-compact-rt-"), { sourceAgentDir: source(), provider: "openai", compactionDefaults: true });
    expect(written(rt.root)).toBeUndefined();
  });

  it("没传 provider 时按用户 defaultProvider 判断", () => {
    const rt = preparePiRuntime(dir("pi-compact-rt-"), { sourceAgentDir: source({ defaultProvider: "deepseek" }), compactionDefaults: true });
    expect(written(rt.root)!.compaction.modelOverrides["deepseek/deepseek-flash"]).toEqual(PI_DEEPSEEK_COMPACTION);
  });
});
