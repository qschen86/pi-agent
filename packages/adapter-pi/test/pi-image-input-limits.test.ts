import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_IMAGE_INPUT_LIMITS, preparePiRuntime } from "../src/pi-runtime-env.js";

const made: string[] = [];
const dir = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

function source(models?: unknown): string {
  const d = dir("pi-env-src-");
  if (models) writeFileSync(join(d, "models.json"), JSON.stringify(models));
  return d;
}
function agentModels(root: string): Record<string, any> | undefined {
  const file = join(root, "pi-agent", "models.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}
const FLASH = "deepseek-v4-flash";

describe("送给模型的图片预算", () => {
  it("给本轮模型写入模型级 inputLimits，内置 provider 也有", () => {
    const rt = preparePiRuntime(dir("pi-env-rt-"), { sourceAgentDir: source(), provider: "deepseek", model: FLASH });
    expect(agentModels(rt.root)).toEqual({
      providers: { deepseek: { modelOverrides: { [FLASH]: { inputLimits: PI_IMAGE_INPUT_LIMITS } } } }
    });
    expect(PI_IMAGE_INPUT_LIMITS.images.resize).toMatchObject({ maxWidth: 1568, maxHeight: 1568, maxBytes: 512 * 1024, jpegQuality: 75 });
  });

  it("自定义 provider 的定义原样保留，只追加模型覆盖", () => {
    const entry = {
      baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "FIXTURE_KEY",
      models: [{ id: "probe", input: ["text", "image"] }],
      modelOverrides: { other: { name: "用户自己的覆盖" } }
    };
    const rt = preparePiRuntime(dir("pi-env-rt-"), {
      sourceAgentDir: source({ providers: { fixture: entry } }), provider: "fixture", model: "probe"
    });
    const written = agentModels(rt.root)!;
    expect(written.providers.fixture).toMatchObject({
      baseUrl: entry.baseUrl, api: entry.api, apiKey: "FIXTURE_KEY", models: entry.models,
      modelOverrides: { other: { name: "用户自己的覆盖" }, probe: { inputLimits: PI_IMAGE_INPUT_LIMITS } }
    });
    expect(rt.passEnv).toEqual(["FIXTURE_KEY"]);
    expect(rt.carried.providers).toEqual(["fixture"]);
  });

  it("没有模型时不写覆盖，行为与原来一致", () => {
    const builtin = preparePiRuntime(dir("pi-env-rt-"), { sourceAgentDir: source(), provider: "deepseek" });
    expect(agentModels(builtin.root)).toBeUndefined();
    const custom = preparePiRuntime(dir("pi-env-rt-"), {
      sourceAgentDir: source({ providers: { fixture: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions" } } }), provider: "fixture"
    });
    expect(agentModels(custom.root)!.providers.fixture).toEqual({ baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions" });
  });

  it("预算按「一份镜像副本 + 帧开销」留在 2 MiB 单帧限额内", () => {
    const { maxBytes } = PI_IMAGE_INPUT_LIMITS.images.resize;
    // read 的结果会同时出现在 content 与 structuredContent：最坏情况是两份 base64。
    expect(2 * maxBytes + 128 * 1024).toBeLessThan(2 * 1024 * 1024);
  });

  it("相对 pi 默认的 4.5 MiB 预算明显收紧", () => {
    const { maxBytes, maxHeight } = PI_IMAGE_INPUT_LIMITS.images.resize;
    expect(maxBytes).toBeLessThanOrEqual(512 * 1024);
    expect(maxHeight).toBeLessThanOrEqual(1568);
  });
});
