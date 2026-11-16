import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPiEnvironment, sharedPlaywrightBrowsersPath } from "../src/pi-runtime-env.js";

function fakeHome(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "pw-home-")));
}

describe("sharedPlaywrightBrowsersPath", () => {
  it("macOS 默认指向宿主家目录的 ms-playwright 缓存", () => {
    const home = fakeHome();
    const dir = join(home, "Library", "Caches", "ms-playwright");
    mkdirSync(dir, { recursive: true });
    expect(sharedPlaywrightBrowsersPath({}, home, "darwin")).toBe(dir);
  });

  it("其他平台用 ~/.cache/ms-playwright", () => {
    const home = fakeHome();
    const dir = join(home, ".cache", "ms-playwright");
    mkdirSync(dir, { recursive: true });
    expect(sharedPlaywrightBrowsersPath({}, home, "linux")).toBe(dir);
  });

  it("目录不存在时不注入", () => {
    expect(sharedPlaywrightBrowsersPath({}, fakeHome(), "darwin")).toBeUndefined();
  });

  it("宿主显式设置的绝对路径优先；\"0\" 与相对路径被忽略", () => {
    const home = fakeHome();
    const custom = join(home, "custom-browsers");
    mkdirSync(custom);
    const fallback = join(home, "Library", "Caches", "ms-playwright");
    mkdirSync(fallback, { recursive: true });
    expect(sharedPlaywrightBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: custom }, home, "darwin")).toBe(custom);
    expect(sharedPlaywrightBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: "0" }, home, "darwin")).toBe(fallback);
    expect(sharedPlaywrightBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: "rel/path" }, home, "darwin")).toBe(fallback);
  });

  it("即使 HOME 被换成一次性目录，set 里的值也会进入 pi 环境", () => {
    const home = fakeHome();
    const dir = join(home, "Library", "Caches", "ms-playwright");
    mkdirSync(dir, { recursive: true });
    const env = buildPiEnvironment({ PATH: "/bin", HOME: home }, { set: { HOME: "/tmp/sandbox-home", PLAYWRIGHT_BROWSERS_PATH: sharedPlaywrightBrowsersPath({}, home, "darwin")! } });
    expect(env["HOME"]).toBe("/tmp/sandbox-home");
    expect(env["PLAYWRIGHT_BROWSERS_PATH"]).toBe(dir);
  });
});
