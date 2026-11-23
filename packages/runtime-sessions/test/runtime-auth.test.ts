import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  RuntimeAuthFlowManager,
  extractOfficialAuthUrl,
  validateOfficialAuthUrl,
  type CodexAppServerClient,
  type RuntimeProfile,
} from "../src/index.js";

function executableProfile(kind: RuntimeProfile["runtimeKind"], summary: string): RuntimeProfile {
  return {
    profileId: `${kind}@local`,
    runtimeKind: kind,
    hostId: "local",
    hostLabel: "本机",
    transport: kind === "codex" ? "app-server-stdio" : kind === "pi" ? "pi-rpc" : kind === "antigravity" ? "acp-stdio" : "agent-sdk",
    state: "executable",
    stateReason: "已就绪",
    capabilities: {} as RuntimeProfile["capabilities"],
    models: [{ id: "m1", label: "M1", isDefault: true }],
    identity: {
      identityScopeId: `${kind}:id`,
      derivation: "stable-account-id",
      accountKnown: true,
      authMode: "oauth",
      summary,
      source: "test",
    },
    permissions: { label: "默认", detail: "" },
    configSummary: [],
    checkedAt: new Date().toISOString(),
  };
}

function fakeChild(): {
  child: ChildProcessWithoutNullStreams;
  stdinChunks: string[];
  emitStdout: (text: string) => void;
  exitWith: (code: number) => void;
} {
  const ee = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdinChunks: string[] = [];
  stdin.on("data", (d) => stdinChunks.push(d.toString("utf8")));
  const proc = Object.assign(ee, {
    stdin,
    stdout,
    stderr,
    exitCode: null as number | null,
    killed: false,
    kill() {
      proc.killed = true;
      proc.exitCode = 143;
      ee.emit("close", 143);
      return true;
    },
  });
  return {
    child: proc as unknown as ChildProcessWithoutNullStreams,
    stdinChunks,
    emitStdout: (text) => stdout.write(text),
    exitWith: (code) => {
      proc.exitCode = code;
      ee.emit("close", code);
    },
  };
}

describe("RuntimeAuthFlowManager", () => {
  it("enforces strict HTTPS official domain allowlists per runtime", () => {
    expect(validateOfficialAuthUrl("codex", "https://auth.openai.com/authorize?x=1")).toBe("https://auth.openai.com/authorize?x=1");
    expect(validateOfficialAuthUrl("claude-code", "https://claude.com/cai/oauth/authorize?code=true")).toBe("https://claude.com/cai/oauth/authorize?code=true");
    expect(validateOfficialAuthUrl("antigravity", "https://accounts.google.com/o/oauth2/auth?client_id=abc")).toBe("https://accounts.google.com/o/oauth2/auth?client_id=abc");
    expect(() => validateOfficialAuthUrl("codex", "http://auth.openai.com/authorize")).toThrow();
    expect(() => validateOfficialAuthUrl("antigravity", "https://evil.example.com/oauth")).toThrow();
    expect(extractOfficialAuthUrl("antigravity", "Open: https://evil.example.com and https://accounts.google.com/o/oauth2/auth?a=1.")).toBe("https://accounts.google.com/o/oauth2/auth?a=1");
  });

  it("handles Codex callback OAuth login and auto-verifies on account/login/completed", async () => {
    const client = Object.assign(new EventEmitter(), {
      alive: true,
      start: vi.fn(async () => ({})),
      stop: vi.fn(() => { client.alive = false; }),
      request: vi.fn(async (method: string) => {
        if (method === "account/login/start") return { loginId: "login-1", authUrl: "https://auth.openai.com/oauth/start" };
        return {};
      }),
    });
    const verifyProfile = vi.fn(async () => executableProfile("codex", "ChatGPT Plus · u***@example.com"));
    const mgr = new RuntimeAuthFlowManager({
      cwd: "/tmp",
      resolveBinary: () => "/opt/codex",
      envFor: () => ({ CODEX_HOME: "/tmp/codex" }),
      verifyProfile,
      codexClientFactory: () => client as unknown as CodexAppServerClient,
    });

    const started = await mgr.start("codex");
    expect(started.mode).toBe("callback");
    expect(started.phase).toBe("awaiting-auth");
    expect(started.authUrl).toBe("https://auth.openai.com/oauth/start");

    client.emit("notification", { method: "account/login/completed", params: { loginId: "login-1", success: true } });
    await vi.waitFor(() => {
      expect(mgr.status("codex", started.flowId)?.phase).toBe("succeeded");
    });
    const done = mgr.status("codex", started.flowId)!;
    expect(done.identitySummary).toContain("ChatGPT Plus");
    expect(done.modelCount).toBe(1);
    expect(verifyProfile).toHaveBeenCalledWith("codex");
  });

  it("handles Antigravity code-paste login without exposing submitted code", async () => {
    const fake = fakeChild();
    const verifyProfile = vi.fn(async () => executableProfile("antigravity", "Google 登录 · Google AI Pro"));
    const mgr = new RuntimeAuthFlowManager({
      cwd: "/tmp",
      resolveBinary: () => "/opt/agy",
      envFor: () => ({ HOME: "/tmp/agy-isolated" }),
      verifyProfile,
      spawnLoginProcess: (_cmd, args, opts) => {
        expect(args).toEqual(["acp", "--login"]);
        expect(opts.env.BROWSER).toBe("/usr/bin/true");
        queueMicrotask(() => {
          fake.emitStdout("Open this link:\n  https://accounts.google.com/o/oauth2/auth?state=xyz\nThen paste:\n");
        });
        return fake.child;
      },
    });

    const started = await mgr.start("antigravity");
    expect(started.mode).toBe("code-paste");
    expect(started.phase).toBe("awaiting-auth");
    expect(started.authUrl).toBe("https://accounts.google.com/o/oauth2/auth?state=xyz");

    const secretCode = "4/0SECRET_AUTH_CODE_DO_NOT_ECHO";
    const submitting = await mgr.submit("antigravity", started.flowId, { code: secretCode });
    expect(submitting.phase).toBe("submitting");
    expect(JSON.stringify(submitting)).not.toContain(secretCode);
    expect(fake.stdinChunks.join("")).toBe(`${secretCode}\n`);

    fake.exitWith(0);
    await vi.waitFor(() => {
      expect(mgr.status("antigravity", started.flowId)?.phase).toBe("succeeded");
    });
    const done = mgr.status("antigravity", started.flowId)!;
    expect(done.identitySummary).toBe("Google 登录 · Google AI Pro");
    expect(JSON.stringify(done)).not.toContain(secretCode);
  });

  it("handles Claude Code hybrid login with stdin paste fallback and cancel", async () => {
    const fake = fakeChild();
    const verifyProfile = vi.fn(async () => executableProfile("claude-code", "Max · c***@example.com"));
    const mgr = new RuntimeAuthFlowManager({
      cwd: "/tmp",
      resolveBinary: () => "/opt/claude",
      envFor: () => ({ CLAUDE_CONFIG_DIR: "/tmp/claude-isolated" }),
      verifyProfile,
      spawnLoginProcess: (_cmd, args) => {
        expect(args).toEqual(["auth", "login"]);
        queueMicrotask(() => {
          fake.emitStdout("Opening browser...\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\nPaste code here if prompted > ");
        });
        return fake.child;
      },
    });

    const started = await mgr.start("claude-code");
    expect(started.mode).toBe("hybrid");
    expect(started.authUrl).toBe("https://claude.com/cai/oauth/authorize?code=true&state=abc");

    await mgr.submit("claude-code", started.flowId, { code: "claude-code-123" });
    expect(fake.stdinChunks.join("")).toBe("claude-code-123\n");
    fake.exitWith(0);
    await vi.waitFor(() => {
      expect(mgr.status("claude-code", started.flowId)?.phase).toBe("succeeded");
    });
  });

  it("handles Pi API Key configuration without echoing the submitted secret", async () => {
    const configurePiApiKey = vi.fn(async () => ({ models: ["deepseek-chat"], modelId: "deepseek-chat" }));
    const verifyProfile = vi.fn(async () => executableProfile("pi", "Pi · deepseek"));
    const mgr = new RuntimeAuthFlowManager({
      cwd: "/tmp",
      resolveBinary: () => undefined,
      envFor: () => ({}),
      verifyProfile,
      configurePiApiKey,
    });

    const started = await mgr.start("pi");
    expect(started.mode).toBe("api-key");
    const done = await mgr.submit("pi", started.flowId, { provider: "deepseek", apiKey: "sk-synthetic-secret-key" });
    expect(done.phase).toBe("succeeded");
    expect(configurePiApiKey).toHaveBeenCalledWith({ provider: "deepseek", apiKey: "sk-synthetic-secret-key" });
    expect(JSON.stringify(done)).not.toContain("sk-synthetic-secret-key");
  });
});
