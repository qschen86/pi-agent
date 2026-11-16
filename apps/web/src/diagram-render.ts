/**
 * 消息里的图表预览（Mermaid / PlantUML）的服务端部分。
 *
 * - Mermaid 在浏览器里渲染，但不放进控制台页面：页面 CSP 不允许内联样式，Mermaid 量文字、套样式都会失真。
 *   这里提供一个隔离的渲染页（sandbox、不同源、不能联网），前端用隐藏 iframe + postMessage 把源码送进去、
 *   把 SVG 字符串取回来，之后只当图片（blob:）显示，SVG 不会进入控制台页面的 DOM。
 * - PlantUML 用本机 Java 渲染（SANDBOX 安全档：禁止 !include 读本机文件和访问网络），结果按源码缓存。
 *   没装 Java / plantuml.jar 时接口返回 501，前端退回显示源码。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";
import type { Context, Hono } from "hono";

export const DIAGRAM_SOURCE_MAX = 100_000;
const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), "../vendor");
const PLANTUML_TIMEOUT_MS = 20_000;
const PLANTUML_OUTPUT_MAX = 8 * 1024 * 1024;
const PLANTUML_CACHE_MAX = 100;
const PLANTUML_PARALLEL = 2;

export class DiagramError extends Error {
  constructor(message: string, public status: 400 | 413 | 422 | 501 | 503 | 504, public code: string) { super(message); }
}

export interface PlantUmlRenderer { render(source: string): Promise<string> }

/** 本机 Java / plantuml.jar 的位置：环境变量优先，其次常见安装位置。每次渲染前才查，装好后无需重启。 */
export function plantUmlTools(env: NodeJS.ProcessEnv = process.env, home = homedir()): { java: string; jar: string } | null {
  const jar = env["PI_PLANTUML_JAR"] || join(home, ".pi-agent-gui", "tools", "plantuml.jar");
  if (!existsSync(jar)) return null;
  const javaHome = env["JAVA_HOME"];
  const candidates = [
    env["PI_PLANTUML_JAVA"],
    javaHome ? join(javaHome, "bin", "java") : undefined,
    "/opt/homebrew/opt/openjdk/bin/java", "/opt/homebrew/opt/openjdk@21/bin/java", "/opt/homebrew/opt/openjdk@17/bin/java",
    "/usr/local/opt/openjdk/bin/java", "/usr/local/opt/openjdk@17/bin/java", "/usr/lib/jvm/default-java/bin/java"
  ];
  const java = candidates.find((path): path is string => !!path && existsSync(path));
  return java ? { java, jar } : null;
}

/** 补 @startuml / @enduml，并默认用内置的 smetana 布局（不依赖本机装了 Graphviz） */
export function preparePlantUmlSource(source: string): string {
  let text = source.replace(/\r\n?/g, "\n").trim();
  if (!/^\s*@start\w+/m.test(text)) text = `@startuml\n${text}\n@enduml`;
  if (!/^\s*!pragma\s+layout\b/m.test(text)) text = text.replace(/^(\s*@start\w+[^\n]*)/m, "$1\n!pragma layout smetana");
  return text;
}

export class LocalPlantUml implements PlantUmlRenderer {
  private readonly cache = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string>>();
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly tools: () => { java: string; jar: string } | null = plantUmlTools) {}

  async render(source: string): Promise<string> {
    if (!source.trim()) throw new DiagramError("图表源码为空", 400, "DIAGRAM_INPUT");
    if (source.length > DIAGRAM_SOURCE_MAX) throw new DiagramError("图表源码过长", 413, "DIAGRAM_TOO_LARGE");
    const tools = this.tools();
    if (!tools) throw new DiagramError("服务器没有安装 PlantUML（需要 Java 和 plantuml.jar）", 501, "PLANTUML_UNAVAILABLE");
    const prepared = preparePlantUmlSource(source), key = createHash("sha256").update(prepared).digest("hex");
    const hit = this.cache.get(key);
    if (hit) { this.cache.delete(key); this.cache.set(key, hit); return hit; }
    const running = this.pending.get(key);
    if (running) return running;
    const job = this.slot(() => this.run(tools, prepared)).then(svg => {
      this.cache.set(key, svg);
      for (const old of this.cache.keys()) { if (this.cache.size <= PLANTUML_CACHE_MAX) break; this.cache.delete(old); }
      return svg;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    return job;
  }

  private async slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= PLANTUML_PARALLEL) await new Promise<void>(resolve => this.waiting.push(resolve));
    this.running++;
    try { return await work(); } finally { this.running--; this.waiting.shift()?.(); }
  }

  private run(tools: { java: string; jar: string }, source: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(tools.java, ["-Djava.awt.headless=true", "-Dfile.encoding=UTF-8", "-Xmx512m", "-jar", tools.jar, "-tsvg", "-pipe", "-charset", "UTF-8"], {
        // SANDBOX：!include 不能读本机文件，也不能访问网络
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", LANG: "en_US.UTF-8", PLANTUML_SECURITY_PROFILE: "SANDBOX" },
        stdio: ["pipe", "pipe", "pipe"]
      });
      const chunks: Buffer[] = [];
      let size = 0, settled = false;
      const finish = (error: Error | null, svg = "") => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(svg); };
      const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new DiagramError("PlantUML 渲染超时", 504, "DIAGRAM_TIMEOUT")); }, PLANTUML_TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > PLANTUML_OUTPUT_MAX) { child.kill("SIGKILL"); finish(new DiagramError("渲染结果过大", 413, "DIAGRAM_TOO_LARGE")); return; }
        chunks.push(chunk);
      });
      child.on("error", () => finish(new DiagramError("无法启动 PlantUML（检查 Java 是否可用）", 501, "PLANTUML_UNAVAILABLE")));
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString("utf8"); });
      child.on("close", (code) => {
        const svg = Buffer.concat(chunks).toString("utf8");
        // 语法错误时 PlantUML 仍会输出一张写着错误的图，但退出码非 0（stderr 形如 ERROR / 行号 / 说明）
        if (code !== 0 || !/<svg[\s>]/.test(svg)) {
          const detail = stderr.split("\n").map(line => line.trim()).filter(Boolean).filter(line => line !== "ERROR" && !/^\d+$/.test(line))[0]?.slice(0, 120);
          return finish(new DiagramError(`PlantUML 语法错误${detail ? `：${detail}` : ""}`, 422, "DIAGRAM_SYNTAX"));
        }
        finish(null, svg);
      });
      child.stdin.on("error", () => { /* 进程提前退出：由 close 事件给出结果 */ });
      child.stdin.end(source);
    });
  }
}

/** 隔离渲染页的 CSP：不能联网、不同源（sandbox 没有 allow-same-origin）；脚本只有页面自带的内联脚本 */
export const MERMAID_FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts";

const FRAME_GLUE = `
(function(){
 var font='-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",Roboto,sans-serif';
 // htmlLabels:false：文字用纯 SVG，之后只当图片显示，Safari 里 <img> 中的 foreignObject 不可靠
 mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'default',htmlLabels:false,fontFamily:font,
  flowchart:{htmlLabels:false},class:{htmlLabels:false},state:{htmlLabels:false},er:{useMaxWidth:false},sequence:{useMaxWidth:false}});
 var chain=Promise.resolve();
 addEventListener('message',function(ev){
  var d=ev.data;if(ev.source!==parent||!d||d.type!=='render'||typeof d.source!=='string')return;
  chain=chain.then(function(){
   var id='dm'+String(d.id).replace(/[^a-zA-Z0-9_-]/g,'');
   return mermaid.render(id,d.source).then(function(r){parent.postMessage({type:'result',id:d.id,svg:r.svg},'*');},
    function(e){parent.postMessage({type:'result',id:d.id,error:String(e&&e.message||e).slice(0,500)},'*');})
    .then(function(){var left=document.getElementById(id)||document.getElementById('d'+id);if(left)left.remove();});
  });
 });
 parent.postMessage({type:'ready'},'*');
})();`;

let frameHtml: Buffer | undefined, frameDigest = "";
const frameEncodings = new Map<string, Buffer>();
function mermaidFrame(): { body: Buffer; etag: string } {
  if (!frameHtml) {
    const mermaid = readFileSync(join(VENDOR_DIR, "mermaid.min.js"), "utf8").replace(/<\/script/gi, "<\\/script");
    frameHtml = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>Mermaid</title></head><body><script>${mermaid}</script><script>${FRAME_GLUE}</script></body></html>`);
    frameDigest = createHash("sha256").update(frameHtml).digest("hex").slice(0, 16);
  }
  return { body: frameHtml, etag: `"mf-${frameDigest}"` };
}
function encodeFrame(body: Buffer, accept: string | undefined): { bytes: Buffer; encoding?: "br" | "gzip" } {
  const accepted = (accept ?? "").toLowerCase();
  const encoding = /\bbr\b/.test(accepted) ? "br" : /\bgzip\b/.test(accepted) ? "gzip" : undefined;
  if (!encoding) return { bytes: body };
  let bytes = frameEncodings.get(encoding);
  if (!bytes) {
    bytes = encoding === "br" ? brotliCompressSync(body, { params: { 1: 5 } }) : gzipSync(body, { level: 6 });
    frameEncodings.set(encoding, bytes);
  }
  return { bytes, encoding };
}

export function mountDiagramRoutes(app: Hono, options: { plantuml?: PlantUmlRenderer } = {}): void {
  const plantuml = options.plantuml ?? new LocalPlantUml();
  app.get("/api/diagrams/mermaid-frame", (c: Context) => {
    const { body, etag } = mermaidFrame();
    const headers: Record<string, string> = {
      "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": MERMAID_FRAME_CSP, "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=86400", ETag: etag, Vary: "Accept-Encoding"
    };
    if (c.req.header("if-none-match") === etag) return c.body(null, 304, headers);
    const { bytes, encoding } = encodeFrame(body, c.req.header("accept-encoding"));
    return c.body(new Uint8Array(bytes), 200, { ...headers, ...(encoding ? { "Content-Encoding": encoding } : {}), "Content-Length": String(bytes.length) });
  });
  app.post("/api/diagrams/plantuml", async (c: Context) => {
    const headers = { "Cache-Control": "private, no-store" };
    try {
      const body = await c.req.json().catch(() => null) as { source?: unknown } | null;
      if (typeof body?.source !== "string") throw new DiagramError("缺少图表源码", 400, "DIAGRAM_INPUT");
      return c.json({ svg: await plantuml.render(body.source) }, 200, headers);
    } catch (e) {
      if (e instanceof DiagramError) return c.json({ error: e.message, code: e.code }, e.status, headers);
      return c.json({ error: "PlantUML 渲染失败", code: "DIAGRAM_FAILED" }, 503, headers);
    }
  });
}
