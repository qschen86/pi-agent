/**
 * pi-runtime 的联网检索接线：扩展文件、socket、--tools 白名单与来源授权。
 * 不碰真实上游：只验证「装配」与 Broker 的拒绝面（UNKNOWN_RESULT / CONFIG_MISSING）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callBroker } from "@pi-agent/web-research";
import { preparePiChatBoundary } from "../src/pi-boundary.js";
import { PiRuntimeSupervisor } from "../src/supervisor.js";
import { brokerSocketPath, sourceDomainDecision, startSessionWebResearch } from "../src/web-research.js";

const roots: string[] = [];
const boundaries: Array<Awaited<ReturnType<typeof preparePiChatBoundary>>> = [];
afterEach(async () => {
  await Promise.all(boundaries.splice(0).map((boundary) => boundary.dispose().catch(() => {})));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function layout() {
  const root = mkdtempSync(join(tmpdir(), "pi-web-boundary-")); roots.push(root);
  const workspace = join(root, "workspace"), sourceAgentDir = join(root, "source");
  mkdirSync(workspace); mkdirSync(sourceAgentDir);
  writeFileSync(join(sourceAgentDir, "auth.json"), JSON.stringify({}));
  return { workspace, sourceAgentDir, runtimeRoot: join(root, "runtime"), guardDir: join(root, "guard"), provider: "deepseek" };
}
const toolList = (argsPrefix: string[]) => argsPrefix[argsPrefix.indexOf("--tools") + 1].split(",");
const extensions = (argsPrefix: string[]) => argsPrefix.flatMap((arg, index) => (arg === "--extension" ? [argsPrefix[index + 1]] : []));

describe("来源范围判定", () => {
  it("`*` 开放公网；否则精确或子域匹配；空列表一律拒绝", () => {
    expect(sourceDomainDecision(["*"])("anything.example")).toMatchObject({ effect: "ALLOW" });
    const scoped = sourceDomainDecision(["example.com"]);
    expect(scoped("example.com").effect).toBe("ALLOW");
    expect(scoped("news.example.com").effect).toBe("ALLOW");
    expect(scoped("EXAMPLE.COM.").effect).toBe("ALLOW");
    expect(scoped("example.com.evil.test").effect).toBe("DENY");
    expect(scoped("other.test").effect).toBe("DENY");
    expect(sourceDomainDecision([])("example.com").effect).toBe("DENY");
    expect(sourceDomainDecision(["*.example.com"])("a.example.com").effect).toBe("ALLOW");
  });
});

describe("Broker socket 路径", () => {
  it("运行目录路径过长时退回短目录，关闭后把自带目录一起删掉", async () => {
    const long = join(tmpdir(), "x".repeat(120), "runtime", "tmp");
    const chosen = brokerSocketPath(long);
    try {
      expect(chosen.cleanupDir).toBeTruthy();
      expect(Buffer.byteLength(chosen.socketPath)).toBeLessThan(100);
    } finally {
      rmSync(chosen.cleanupDir!, { recursive: true, force: true });
    }
    const broker = await startSessionWebResearch({ socketDir: long, sourceDomains: ["*"] });
    const ownDir = dirname(broker.socketPath);
    expect(existsSync(broker.socketPath)).toBe(true);
    await broker.close();
    expect(existsSync(ownDir)).toBe(false);
  });
  it("短目录保持原位；只有超长目录才退回短路径", async () => {
    const root = mkdtempSync(join(tmpdir(), "piwr-test-")); roots.push(root);
    const short = brokerSocketPath(root);
    expect(short.cleanupDir).toBeUndefined();
    expect(short.socketPath).toBe(join(root, "web-research.sock"));
    const longDir = join(root, "x".repeat(120));
    const fallback = brokerSocketPath(longDir);
    expect(fallback.cleanupDir).toBeTruthy();
    expect(Buffer.byteLength(fallback.socketPath)).toBeLessThan(100);
    rmSync(fallback.cleanupDir!, { recursive: true, force: true });
  });
});

describe("preparePiChatBoundary 的联网检索装配", () => {
  it("默认聊天边界：注册 web_search / web_open，Broker socket 在临时目录里，Pi 侧只有一个路径", async () => {
    const args = layout();
    const boundary = await preparePiChatBoundary({ ...args, mode: "pi-native", webResearch: { sourceDomains: ["*"] } });
    boundaries.push(boundary);
    const socketPath = boundary.env["PI_WEB_RESEARCH_SOCKET"]!;
    // 路径超长时边界会退回短目录：两种位置都允许，但必须是能 listen 的短路径。
    expect(Buffer.byteLength(socketPath)).toBeLessThan(100);
    expect(existsSync(socketPath)).toBe(true);
    expect(boundary.env["PI_WEB_RESEARCH_TOOLS"]).toBe("web_search,web_open");
    expect(boundary.webResearch?.tools).toEqual(["web_search", "web_open"]);
    const entries = extensions(boundary.argsPrefix);
    expect(entries).toHaveLength(2);
    const webEntry = entries[1]!;
    // 边界会把 guard 目录规范化（macOS 上 /var 是 /private/var 的符号链接）。
    expect(webEntry).toBe(join(realpathSync(args.guardDir), "web-research.ts"));
    expect(readFileSync(webEntry, "utf8")).toContain("web_search");
    expect(toolList(boundary.argsPrefix)).toEqual(["read", "grep", "find", "ls", "write", "edit", "bash", "web_search", "web_open"]);
    // 密钥不在 pi 的环境里：只多了一个 socket 路径。
    expect(Object.keys(boundary.env).some((name) => /API_KEY|BRAVE|FIRECRAWL|DEEPSEEK/i.test(name))).toBe(false);
    // Broker 真的在这条 socket 上应答并拒绝：没有凭据时是 CONFIG_MISSING，
    // 有凭据（宿主环境或 key 文件）时是 UNKNOWN_RESULT——两种都不能编造结果。
    const response = await callBroker(socketPath, { tool: "web.open", toolCallId: "c1", params: { searchId: "q1", resultId: "R1", basis: "official", why: "接线检查" } });
    expect(response.ok).toBe(false);
    expect(response.ok ? "" : response.code).toMatch(/^(UNKNOWN_RESULT|CONFIG_MISSING)$/);
  });

  it("pi-read-only 也保留只读的检索工具；dispose 之后 socket 被删掉", async () => {
    const args = layout();
    const boundary = await preparePiChatBoundary({ ...args, mode: "pi-read-only", webResearch: { sourceDomains: ["*"] } });
    boundaries.push(boundary);
    expect(toolList(boundary.argsPrefix)).toEqual(["read", "grep", "find", "ls", "web_search", "web_open"]);
    const socketPath = boundary.env["PI_WEB_RESEARCH_SOCKET"]!;
    expect(existsSync(socketPath)).toBe(true);
    await boundary.dispose();
    boundaries.splice(boundaries.indexOf(boundary), 1);
    expect(existsSync(socketPath)).toBe(false);
  });

  it("未授权（没给 webResearch）就完全不加工具、不起 Broker", async () => {
    const args = layout();
    const boundary = await preparePiChatBoundary({ ...args, mode: "pi-native" });
    boundaries.push(boundary);
    expect(boundary.env["PI_WEB_RESEARCH_SOCKET"]).toBeUndefined();
    expect(boundary.webResearch).toBeUndefined();
    expect(toolList(boundary.argsPrefix)).toEqual(["read", "grep", "find", "ls", "write", "edit", "bash"]);
    expect(extensions(boundary.argsPrefix)).toHaveLength(1);
  });

  it("缺凭据时工具照常注册，调用如实报 CONFIG_MISSING", async () => {
    const args = layout();
    const names = ["DEEPSEEK_API_KEY", "BRAVE_SEARCH_API_KEY", "FIRECRAWL_API_KEY", "PI_AGENT_BRAVE_KEY_FILE", "PI_AGENT_FIRECRAWL_KEY_FILE", "PI_AGENT_DEEPSEEK_KEY_FILE"] as const;
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]])) as Record<(typeof names)[number], string | undefined>;
    delete process.env["DEEPSEEK_API_KEY"]; delete process.env["BRAVE_SEARCH_API_KEY"]; delete process.env["FIRECRAWL_API_KEY"];
    for (const name of ["PI_AGENT_BRAVE_KEY_FILE", "PI_AGENT_FIRECRAWL_KEY_FILE", "PI_AGENT_DEEPSEEK_KEY_FILE"] as const) process.env[name] = join(args.sourceAgentDir, "missing-key");
    try {
      const boundary = await preparePiChatBoundary({ ...args, mode: "pi-native", webResearch: { sourceDomains: ["example.com"] } });
      boundaries.push(boundary);
      const response = await callBroker(boundary.env["PI_WEB_RESEARCH_SOCKET"]!, { tool: "web.search", toolCallId: "c1", params: { query: "q" } });
      expect(response).toMatchObject({ ok: false, code: "CONFIG_MISSING" });
      expect(response.ok ? "" : response.text).toContain("CONFIG_MISSING");
    } finally {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
      }
    }
  });
});

describe("runtime 启动参数校验", () => {
  const spec = (webResearch: unknown) => ({
    version: 1 as const, binary: "/bin/echo", workspace: "/tmp", provider: "deepseek", model: "deepseek-flash",
    mode: "pi-native", sessionId: "00000000-0000-4000-8000-000000000000", webResearch: webResearch as never
  });
  it("拒绝空的来源列表与非整数预算", async () => {
    await expect(new PiRuntimeSupervisor().start(spec({ sourceDomains: [] }))).rejects.toThrow(/web research authorization/i);
    await expect(new PiRuntimeSupervisor().start(spec({ sourceDomains: ["*"], budget: { searches: 0 } }))).rejects.toThrow(/web research budget/i);
    await expect(new PiRuntimeSupervisor().start(spec({ sourceDomains: [""] }))).rejects.toThrow(/web research authorization/i);
  });
});
