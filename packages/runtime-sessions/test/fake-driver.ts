/**
 * 测试替身：可编排的 runtime 驱动。每次 startTurn 生成一个可由测试推进的 turn。
 */
import { randomUUID } from "node:crypto";
import type { DriverEvent, HistoryItem, HistoryRead, NativeFingerprint, ProbeOutcome, RuntimeDriver, StartTurnArgs, TurnHandle, TurnResult, TurnSink } from "../src/driver.js";
import { cap } from "../src/driver.js";
import type { CapabilityName, RuntimeKind } from "../src/types.js";

export interface FakeTurn {
  args: StartTurnArgs;
  sink: TurnSink;
  nativeId: string;
  turnId: string;
  finish: (r: TurnResult) => void;
  interrupted: boolean;
  /** 收到的插话（driver.steerable 时才有 steer） */
  steers: Array<{ clientMessageId: string; prompt: string; images?: unknown[] }>;
}

export class FakeDriver implements RuntimeDriver {
  readContinuation?: RuntimeDriver["readContinuation"];
  evaluationPolicy?: () => { version: string; channels: string[] } | undefined;
  turns: FakeTurn[] = [];
  history: HistoryItem[] = [];
  reads = new Map<string, HistoryRead>();
  fingerprints = new Map<string, string>();
  delivered = new Map<string, boolean | undefined>();
  probeState: ProbeOutcome["state"] = "executable";
  stableAccountId: string | undefined = "acct-1";
  identityFingerprint = "chatgpt|a@b.c|plus";
  failNext?: { stage: "spawn" | "create" | "dispatch"; message: string; nativeId?: string; notExecuted?: boolean; processEnded?: string } | { stage: "unknown"; message: string };
  readCalls = 0;
  startCalls = 0;
  shutdowns = 0;
  /** 模拟 runtime 回报的实际模型与目录 ID 不同（如 Claude：目录 opus，实际 claude-opus-5-5） */
  effectiveModelOverride?: string;
  /** 模拟支持运行中插话（Pi steer）；steerFail 时插话被 runtime 拒绝 */
  steerable = false;
  steerFail?: string;

  /** 测试：模拟 CLI 二进制指纹（不设就没有独立二进制） */
  binaryStamp?: () => { path: string; mtimeMs: number } | undefined;

  constructor(readonly kind: RuntimeKind) {}

  async probe(): Promise<ProbeOutcome> {
    const caps = Object.fromEntries((["create", "read", "stream", "resume", "interrupt", "approval", "usage", "rateLimits", "roleInstructions"] as CapabilityName[]).map((k) => [k, cap("supported", "fake")])) as ProbeOutcome["capabilities"];
    return {
      state: this.probeState, stateReason: "fake", binaryVersion: "fake-1", capabilities: caps,
      models: [{ id: "m-1", label: "Model 1", isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "low" }, { id: "m-2", label: "Model 2" }],
      identity: { ...(this.stableAccountId ? { stableAccountId: this.stableAccountId } : {}), authMode: "chatgpt", summary: "fake", source: "fake", fingerprint: this.identityFingerprint },
      configSummary: ["fake config"], permissions: { label: "fake-perm", detail: "fake" },
      rateLimit: { windows: [{ label: "5 小时窗口", usedPercent: 10, resetsAt: null }], source: "fake", sampledAt: new Date().toISOString(), available: true }
    };
  }

  async startTurn(args: StartTurnArgs, sink: TurnSink): Promise<TurnHandle> {
    this.startCalls++;
    const f = this.failNext;
    if (f) {
      this.failNext = undefined;
      if (f.stage === "unknown") throw new Error(f.message);
      const { DriverStageError } = await import("../src/driver.js");
      if (f.stage === "dispatch" && f.nativeId) sink.nativeSession(f.nativeId, { modelSource: "fake" });
      throw new DriverStageError(f.message, f.stage, (f as { nativeId?: string }).nativeId, f.notExecuted ?? true, f.processEnded);
    }
    const nativeId = args.nativeSessionId ?? args.presetSessionId ?? `native-${randomUUID().slice(0, 8)}`;
    sink.nativeSession(nativeId, { effectiveModel: this.effectiveModelOverride ?? args.model ?? "m-1", modelSource: "fake 响应" });
    const turnId = `turn-${this.turns.length + 1}`;
    sink.nativeTurn(turnId);
    sink.status("running");
    let finish!: (r: TurnResult) => void;
    const done = new Promise<TurnResult>((r) => { finish = result => r({ ...result, terminalObserved: result.terminalObserved ?? result.status !== "unknown" }); });
    const t: FakeTurn = { args, sink, nativeId, turnId, finish, interrupted: false, steers: [] };
    this.turns.push(t);
    return {
      done,
      ...(this.steerable ? { steer: async (input: FakeTurn["steers"][number]) => { if (this.steerFail) throw new Error(this.steerFail); t.steers.push(input); } } : {}),
      interrupt: async () => { t.interrupted = true; setTimeout(() => finish({ status: "interrupted", reason: "fake interrupted" }), 5); }
    };
  }

  lastOriginators: string[] | undefined;
  async listHistory(opts: { roots: string[]; limit: number; originators?: string[] }): Promise<{ items: HistoryItem[]; coverage: "complete" | "partial"; notes: string[] }> {
    const { underRoots } = await import("../src/codex.js");
    this.lastOriginators = opts.originators;
    return { items: this.history.filter((h) => underRoots(h.workspace, opts.roots) && (!opts.originators?.length || (!!h.originator && opts.originators.includes(h.originator)))).slice(0, opts.limit), coverage: "complete", notes: [] };
  }

  async readHistory(nativeSessionId: string): Promise<HistoryRead> {
    this.readCalls++;
    return this.reads.get(nativeSessionId) ?? { events: [], usage: [], status: "unknown", coverage: "unknown", notes: ["fake: no data"] };
  }

  async fingerprint(nativeSessionId: string, _opts: { workspace?: string; previous?: string } = {}): Promise<NativeFingerprint | undefined> {
    const v = this.fingerprints.get(nativeSessionId);
    return v === undefined ? { value: `fp-${nativeSessionId}` } : { value: v };
  }

  async findClientMessage(nativeSessionId: string, clientMessageId: string): Promise<boolean | undefined> {
    const k = `${nativeSessionId}|${clientMessageId}`;
    return this.delivered.has(k) ? this.delivered.get(k) : true;
  }

  async rateLimits(): Promise<ProbeOutcome["rateLimit"]> {
    return { windows: [{ label: "5 小时窗口", usedPercent: 12, resetsAt: null }], source: "fake", sampledAt: new Date().toISOString(), available: true };
  }

  shutdown(): void { this.shutdowns++; }
}

export function ev(key: string, text: string, extra: Partial<DriverEvent> = {}): DriverEvent {
  return { key, kind: "message", role: "assistant", text, source: "stream", parserVersion: "fake", availability: "recorded", ...extra };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

export async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("等待超时");
    await tick(5);
  }
}
