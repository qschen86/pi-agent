/**
 * v2.6 WP1：模型调用携带图片——格式与尺寸核对、调用身份、修复重试、调用记录、pi 参数。
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { piArgv } from "@pi-agent/adapter-pi";
import {
  checkImages, configHashOf, invokeStructured, observedPort, prepareImages, sniffImage
} from "../src/index.js";
import type { ModelCall, ModelCallContent, ModelCallRecord, ModelInvocationPort, RoleModelConfig } from "../src/index.js";

/** 只含文件头的最小图片：足够识别格式与宽高（不是可解码的完整图片）。 */
function png(width: number, height: number, salt = 0): Uint8Array {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  b[32] = salt;
  return new Uint8Array(b);
}
function jpeg(width: number, height: number): Uint8Array {
  // SOI + APP0（长度 16）+ SOF0
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8; sof.writeUInt16BE(height, 5); sof.writeUInt16BE(width, 7);
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]));
}
function webpVp8x(width: number, height: number): Uint8Array {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(22, 4); b.write("WEBP", 8, "ascii"); b.write("VP8X", 12, "ascii");
  b.writeUIntLE(width - 1, 24, 3); b.writeUIntLE(height - 1, 27, 3);
  return new Uint8Array(b);
}
function webpVp8l(width: number, height: number): Uint8Array {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii"); b.write("WEBP", 8, "ascii"); b.write("VP8L", 12, "ascii");
  b[20] = 0x2f; b.writeUInt32LE(((height - 1) << 14) | (width - 1), 21);
  return new Uint8Array(b);
}

const CONFIG: RoleModelConfig = { role: "visualReviewer", provider: "deepseek", model: "deepseek-flash", promptVersion: "vr@1", schemaVersion: "vr-out@1", timeoutMs: 1000, maxAttempts: 2 };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };
const sha = (s: string): string => `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;

function recordingPort(texts: string[]): { port: ModelInvocationPort; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  return { calls, port: { complete: async (_c, call) => { calls.push(call); return { text: texts.shift() ?? "{}", usage, durationMs: 1 }; } } };
}

describe("图片识别与核对", () => {
  it("按文件头识别 PNG / JPEG / WebP 并读出宽高", () => {
    expect(sniffImage(png(1600, 900))).toEqual({ mediaType: "image/png", width: 1600, height: 900 });
    expect(sniffImage(jpeg(1280, 720))).toEqual({ mediaType: "image/jpeg", width: 1280, height: 720 });
    expect(sniffImage(webpVp8x(800, 450))).toEqual({ mediaType: "image/webp", width: 800, height: 450 });
    expect(sniffImage(webpVp8l(390, 844 - 400))).toEqual({ mediaType: "image/webp", width: 390, height: 444 });
    expect(sniffImage(new Uint8Array(Buffer.from("<svg></svg>")))).toBeUndefined();
  });

  it("缺图、错图、超限都拒绝，不退化为纯文本调用", () => {
    expect(() => checkImages([{ mediaType: "image/png", bytes: new Uint8Array() }])).toThrow(/空的/);
    expect(() => checkImages([{ mediaType: "image/png", bytes: jpeg(10, 10) }])).toThrow(/声称 image\/png，实际是 image\/jpeg/);
    expect(() => checkImages([{ mediaType: "image/png", bytes: new Uint8Array(Buffer.from("not an image at all, nope")) }])).toThrow(/不是可识别/);
    expect(() => checkImages([{ mediaType: "image/png", bytes: png(1601, 900) }])).toThrow(/超过单张上限 1600×900/);
    expect(() => checkImages(Array.from({ length: 9 }, () => ({ mediaType: "image/png" as const, bytes: png(10, 10) })))).toThrow(/单次上限 8 张/);
    const [meta] = checkImages([{ mediaType: "image/png", bytes: png(1600, 900) }]);
    expect(meta).toMatchObject({ mediaType: "image/png", width: 1600, height: 900, bytes: 33 });
    expect(meta?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("模型目录里声明收图的模型放行；目录外的模型只核对图片本身", () => {
    expect(prepareImages(CONFIG, [{ mediaType: "image/png", bytes: png(10, 10) }])).toHaveLength(1);
    expect(prepareImages({ provider: "zhipu", model: "glm-5.3-flash:high" }, [{ mediaType: "image/png", bytes: png(10, 10) }])).toHaveLength(1);
    expect(prepareImages({ provider: "fixture", model: "any" }, [{ mediaType: "image/png", bytes: png(10, 10) }])).toHaveLength(1);
    expect(prepareImages(CONFIG, undefined)).toEqual([]);
  });
});

describe("结构化调用携带图片", () => {
  const validate = (v: unknown): string[] => ((v as { ok?: boolean }).ok === true ? [] : ["/ok 必须为 true"]);

  it("首次调用与修复重试都带上同样的图片", async () => {
    const images = [{ mediaType: "image/png" as const, bytes: png(1600, 900) }];
    const { port, calls } = recordingPort(['{"ok": false}', '{"ok": true}']);
    const r = await invokeStructured(port, CONFIG, { system: "s", prompt: "看图", images }, validate);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.images).toBe(images);
    expect(calls[1]?.images).toBe(images);
    expect(calls[1]?.prompt).toContain("你上一次的输出不合格");
    // 两次尝试的输入身份都包含图片：与不带图的同文字调用不同
    expect(r.attempts[0]?.inputHash).not.toBe(sha("s\n\n看图"));
  });

  it("没有图片时调用身份与 v2.6 之前一致；相同文字配不同截图得到不同身份", async () => {
    const run = async (images?: ModelCall["images"]) => invokeStructured(recordingPort(['{"ok": true}']).port, CONFIG, { system: "s", prompt: "p", ...(images ? { images } : {}) }, validate);
    const plain = await run();
    expect(plain.roleRunId).toBe(`rr_${sha(`${configHashOf(CONFIG)}|s|p`).slice(7, 23)}`);
    expect(plain.attempts[0]?.inputHash).toBe(sha("s\n\np"));
    const a = await run([{ mediaType: "image/png", bytes: png(100, 100, 1) }]);
    const b = await run([{ mediaType: "image/png", bytes: png(100, 100, 2) }]);
    const ab = await run([{ mediaType: "image/png", bytes: png(100, 100, 1) }, { mediaType: "image/png", bytes: png(100, 100, 2) }]);
    const ba = await run([{ mediaType: "image/png", bytes: png(100, 100, 2) }, { mediaType: "image/png", bytes: png(100, 100, 1) }]);
    expect(new Set([plain.roleRunId, a.roleRunId, b.roleRunId, ab.roleRunId, ba.roleRunId]).size).toBe(5);
  });

  it("图片不合格时不发起调用，直接失败", async () => {
    const { port, calls } = recordingPort(['{"ok": true}']);
    await expect(invokeStructured(port, CONFIG, { system: "s", prompt: "p", images: [{ mediaType: "image/png", bytes: png(2000, 900) }] }, validate)).rejects.toThrow(/超过单张上限/);
    expect(calls).toHaveLength(0);
  });

  it("放宽的 imageLimits 会传到端口：经登记端口的大图也能通过", async () => {
    const { port, calls } = recordingPort(['{"ok": true}']);
    const limits = { maxImages: 1, maxWidth: 3200, maxHeight: 3200, maxBytes: 12 * 1024 * 1024 };
    const observed = observedPort(port, { record: () => {} } as never, { module: "t" } as never);
    const r = await invokeStructured(observed, CONFIG, { system: "s", prompt: "p", images: [{ mediaType: "image/png", bytes: png(1500, 2000) }], imageLimits: limits }, validate);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.imageLimits).toEqual(limits);
  });
});

describe("调用记录与 pi 参数", () => {
  it("调用记录有图片元数据、没有图片字节；不合格图片登记为调用失败且不调用模型", async () => {
    const records: Array<{ meta: ModelCallRecord; content: ModelCallContent }> = [];
    const sink = { record: (meta: ModelCallRecord, content: ModelCallContent) => { records.push({ meta, content }); } };
    const { port, calls } = recordingPort(["{}"]);
    const observed = observedPort(port, sink, { module: "visual-review", sessionId: "s1" });
    await observed.complete(CONFIG, { system: "s", prompt: "p", images: [{ mediaType: "image/png", bytes: png(1600, 900) }] });
    expect(records[0]?.meta.images).toEqual([expect.objectContaining({ mediaType: "image/png", width: 1600, height: 900, bytes: 33 })]);
    expect(JSON.stringify(records[0])).not.toMatch(/"bytes":\{|"0":137/);
    expect(records[0]?.meta.inputHash).not.toBe(sha("s\n\np"));

    await expect(observed.complete(CONFIG, { system: "s", prompt: "p", images: [{ mediaType: "image/webp", bytes: png(10, 10) }] })).rejects.toThrow(/实际是 image\/png/);
    expect(records[1]?.meta.status).toBe("call-error");
    expect(calls).toHaveLength(1);
  });

  it("pi 参数：图片以 @文件 放在 -- 之后、文本之前；没有图片时参数与原来一致", () => {
    const base = { provider: "deepseek", model: "deepseek-flash", systemPrompt: "sys", prompt: "看图" };
    const argv = piArgv(base, "json", ["/tmp/ws/image-01.png", "/tmp/ws/image-02.png"]);
    expect(argv.slice(argv.indexOf("--"))).toEqual(["--", "@/tmp/ws/image-01.png", "@/tmp/ws/image-02.png", "看图"]);
    expect(piArgv(base, "json")).toEqual([
      "--print", "--mode", "json", "--provider", "deepseek", "--model", "deepseek-flash", "--system-prompt", "sys",
      "--no-tools", "--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--", "看图"
    ]);
  });
});
