/**
 * 角色模型调用端口（v2.0 评审 C4）。
 *
 * 规划、合约评审、语义验收、实验评分各是一个「角色」：各自登记 provider/model、提示词与输出 schema 版本、
 * 时限与尝试次数。调用方只拿到结构化结果和逐次调用记录，不共享任何聊天历史——每次调用都是一次独立的
 * 无工具补全。首版实现适配 runPiCompletion（与真机任务同一套运行时隔离）；以后换直连 API 只换端口实现。
 *
 * 约束：
 * - 模型只能产出数据。输出先解析、再按 schema 校验；不合格最多按配置修复有限次，仍不合格就失败，不降级放行。
 * - 凭据不进提示词与记录；记录只存输入/输出的哈希、用量、耗时与状态。
 * - 用量来自 pi 报告的真实 token；价格未知时不填金额（不写 0 元）。
 */
import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import { catalogModel } from "@pi-agent/schemas";
import { checkImages, imageDigest, type ImageLimits } from "./images.js";
import type { ImageMeta, ModelImage } from "./images.js";

export * from "./images.js";
import { runPiCompletion, THINKING_LEVELS } from "@pi-agent/adapter-pi";
import type { PiCompletion, PiTextOptions, ThinkingLevel } from "@pi-agent/adapter-pi";

/** visualReviewer（v2.6）：看渲染截图、提出可定位的视觉问题；不改计划、不签发通过 */
export type ModelRole = "planner" | "contractCritic" | "acceptanceJudge" | "benchmarkJudge" | "probe" | "visualReviewer" | "sessionTitle" | "memoryTitle" | "memoryCategory" | "memoryCandidate" | "quickReply" | "noteCategory" | "noteKind" | "noteDevelopment" | "noteIteration" | "noteRanking" | "gameCompanion" | "ledgerChat" | "challengePoem" | "challengeIcon" | "diagnosticTriage" | "errorStatsMerge" | "errorStatsAssess" | "wrongBookRead" | "wrongBookQuiz" | "wrongBookVerify" | "wrongBookExplain" | "artifactCategory";

/** 平台登记的角色配置：模型输出不能改它，也不能指定服务地址或凭据。 */
export interface RoleModelConfig {
  role: ModelRole;
  provider: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  /** 单次调用时限 */
  timeoutMs: number;
  /** 总尝试次数（含首次）；解析或校验不合格时用剩余次数修复 */
  maxAttempts: number;
  /** 推理强度（v2.3）：不写就用 pi 对该模型的默认值；写了才进配置哈希 */
  thinking?: ThinkingLevel;
}

/** 这次调用请求的推理强度：显式配置优先，其次是模型名的「:级别」后缀，都没有就是「默认」。 */
export function requestedThinking(config: Pick<RoleModelConfig, "model" | "thinking">): ThinkingLevel | "default" {
  if (config.thinking) return config.thinking;
  const suffix = config.model.includes(":") ? config.model.slice(config.model.lastIndexOf(":") + 1) : "";
  return (THINKING_LEVELS as readonly string[]).includes(suffix) ? suffix as ThinkingLevel : "default";
}

export interface ModelCall {
  system: string;
  prompt: string;
  /**
   * 随本次调用交给模型的图片（v2.6）：只接受宿主生成或核对过的字节。
   * 图片的类型、顺序与内容哈希计入调用身份；模型不支持图片输入时直接报错，不丢图改走纯文本。
   */
  images?: ModelImage[];
  /** 放宽单张图片的尺寸 / 字节上限（竖拍的作业照片等）；不写就用默认的 IMAGE_LIMITS。 */
  imageLimits?: ImageLimits;
}

/**
 * 调用前核对图片：格式、张数、尺寸在上限内，且模型目录声明该模型接受图片输入。
 * 目录里查不到的模型（测试夹具、临时模型）只核对图片本身。
 */
export function prepareImages(config: Pick<RoleModelConfig, "provider" | "model">, images: ModelImage[] | undefined, limits?: ImageLimits): ImageMeta[] {
  if (!images || images.length === 0) return [];
  const meta = checkImages(images, limits);
  const ref = `${config.provider}/${config.model.includes(":") ? config.model.slice(0, config.model.lastIndexOf(":")) : config.model}`;
  const entry = catalogModel(ref);
  if (entry && !entry.input.includes("image")) throw new Error(`模型 ${ref} 不支持图片输入（模型目录 input: ${entry.input.join("、")}）`);
  return meta;
}

/** 一次调用输入的身份：system + prompt，有图片时再加按顺序的图片类型与哈希。 */
export function callInputHash(system: string, prompt: string, images: ImageMeta[] = []): string {
  return sha256(`${system}\n\n${prompt}${imageDigest(images)}`);
}

export type ModelResponse = Omit<PiCompletion, "durationMs"> & { durationMs: number };

export interface ModelInvocationPort {
  complete(config: RoleModelConfig, call: ModelCall): Promise<ModelResponse>;
}

export type AttemptStatus = "ok" | "call-error" | "parse-error" | "schema-error";

/** 一次调用的审计记录：不含原文，只有哈希、状态、用量与耗时。 */
export interface InvocationAttempt {
  attempt: number;
  startedAt: string;
  durationMs: number;
  status: AttemptStatus;
  error?: string;
  inputHash: string;
  outputHash?: string;
  model?: string;
  usage?: ModelResponse["usage"];
}

export interface StructuredResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
  role: ModelRole;
  /** 这次角色调用的身份：配置 + 输入决定，便于幂等与追溯 */
  roleRunId: string;
  configHash: string;
  attempts: InvocationAttempt[];
  /** 全部尝试的 token 合计（失败的尝试同样计入成本）；缓存读写按 pi 的报告累加 */
  usage: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; totalTokens: number };
  durationMs: number;
}

const sha256 = (s: string): string => `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;
const stable = (v: unknown): string => JSON.stringify(v, Object.keys(v as object).sort());

export function configHashOf(config: RoleModelConfig): string {
  return sha256(stable(config));
}

/**
 * 从模型输出里取 JSON：优先 ```json 代码块，否则取第一个配平的 {...} 或 [...]。
 * 取不到或解析失败都抛错——不猜、不修补内容。
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : balanced(text);
  if (body === undefined) throw new Error("输出里没有 JSON");
  return JSON.parse(body);
}

function balanced(text: string): string | undefined {
  const start = text.search(/[[{]/);
  if (start < 0) return undefined;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === "\"") inString = false;
      continue;
    }
    if (c === "\"") inString = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

/** 按 JSON Schema（2020-12）生成校验函数：返回错误列表，空表示合格。 */
export function schemaValidator(schema: object): (value: unknown) => string[] {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);
  return (value) => (validate(value) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()));
}

/**
 * 结构化调用：调用 → 解析 → 校验；不合格时把错误告诉模型再试（总次数不超过 maxAttempts）。
 * 修复提示只带错误说明和上次输出的开头，不带任何平台内部状态。
 */
export async function invokeStructured<T>(
  port: ModelInvocationPort,
  config: RoleModelConfig,
  call: ModelCall,
  validate: (value: unknown) => string[],
  now: () => Date = () => new Date()
): Promise<StructuredResult<T>> {
  const configHash = configHashOf(config);
  // 图片不合格（缺、错、超限、模型不收图）是调用方的错：不发起调用，直接失败
  const images = prepareImages(config, call.images, call.imageLimits);
  const roleRunId = `rr_${sha256(`${configHash}|${call.system}|${call.prompt}${imageDigest(images)}`).slice(7, 23)}`;
  const attempts: InvocationAttempt[] = [];
  const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  const started = now().getTime();
  let prompt = call.prompt;
  for (let attempt = 1; attempt <= Math.max(1, config.maxAttempts); attempt++) {
    const startedAt = now();
    const inputHash = callInputHash(call.system, prompt, images);
    let response: ModelResponse;
    try {
      // 修复重试同样带上图片：改的只是提示词
      response = await port.complete(config, { system: call.system, prompt, ...(call.images?.length ? { images: call.images, ...(call.imageLimits ? { imageLimits: call.imageLimits } : {}) } : {}) });
    } catch (e) {
      attempts.push({ attempt, startedAt: startedAt.toISOString(), durationMs: now().getTime() - startedAt.getTime(), status: "call-error", error: (e as Error).message.slice(0, 400), inputHash });
      continue;
    }
    if (response.usage) {
      usage.input += response.usage.input;
      usage.output += response.usage.output;
      usage.reasoning += response.usage.reasoning ?? 0;
      usage.cacheRead += response.usage.cacheRead ?? 0;
      usage.cacheWrite += response.usage.cacheWrite ?? 0;
      usage.totalTokens += response.usage.totalTokens;
    }
    const base = {
      attempt, startedAt: startedAt.toISOString(), durationMs: response.durationMs, inputHash, outputHash: sha256(response.text),
      ...(response.model ? { model: response.model } : {}), ...(response.usage ? { usage: response.usage } : {})
    };
    let value: unknown;
    try {
      value = extractJson(response.text);
    } catch (e) {
      attempts.push({ ...base, status: "parse-error", error: (e as Error).message.slice(0, 200) });
      prompt = repairPrompt(call.prompt, response.text, [`无法解析为 JSON：${(e as Error).message}`]);
      continue;
    }
    const errors = validate(value);
    if (errors.length > 0) {
      attempts.push({ ...base, status: "schema-error", error: errors.slice(0, 8).join("; ").slice(0, 400) });
      prompt = repairPrompt(call.prompt, response.text, errors);
      continue;
    }
    attempts.push({ ...base, status: "ok" });
    return { ok: true, value: value as T, role: config.role, roleRunId, configHash, attempts, usage, durationMs: now().getTime() - started };
  }
  const last = attempts[attempts.length - 1];
  return {
    ok: false, error: `${config.role} 在 ${attempts.length} 次尝试内没有产出合格结果：${last?.status ?? "no-attempt"}${last?.error ? `（${last.error}）` : ""}`,
    role: config.role, roleRunId, configHash, attempts, usage, durationMs: now().getTime() - started
  };
}

function repairPrompt(original: string, previous: string, errors: string[]): string {
  return [
    original,
    "",
    "---",
    "你上一次的输出不合格，问题如下：",
    ...errors.slice(0, 8).map((e) => `- ${e}`),
    "上一次输出的开头：",
    previous.slice(0, 600),
    "请只输出一个符合要求的 JSON（可放在 ```json 代码块里），不要输出其它内容。"
  ].join("\n");
}

/** 首版端口实现：runPiCompletion（无工具、独立临时环境、OS 边界、不继承会话）。 */
export function piModelPort(options: Omit<PiTextOptions, "systemPrompt" | "prompt" | "provider" | "model" | "timeoutMs"> = {}): ModelInvocationPort {
  return {
    complete: async (config, call) => {
      // 直接用端口（不经 invokeStructured）时同样先核对图片
      if (call.images?.length) prepareImages(config, call.images, call.imageLimits);
      return runPiCompletion({
        ...options, provider: config.provider, model: config.model, timeoutMs: config.timeoutMs,
        ...(config.thinking ? { thinking: config.thinking } : {}),
        systemPrompt: call.system, prompt: call.prompt,
        ...(call.images?.length ? { images: call.images } : {})
      });
    }
  };
}

/* ------------------------------ 调用登记（v2.3 P1） ------------------------------ */

/** 调用发生在哪里：会话或规划、模块、验收作业与交付版本。 */
export interface ModelCallScope {
  /** 模块：需求填充、标准起草、合约评审、交付验收……（由调用方登记，不从模型正文猜） */
  module: string;
  sessionId?: string;
  planId?: string;
  jobId?: string;
  deliveryRevision?: number;
}

/** 一次模型调用的元数据：不含正文，进性能记录。 */
export interface ModelCallRecord {
  callId: string;
  /** 同一登记范围内的调用顺序（从 1 开始；修复重试也各算一次调用） */
  seq: number;
  startedAt: string;
  durationMs: number;
  role: ModelRole;
  scope: ModelCallScope;
  provider: string;
  model: string;
  /** 响应里报告的模型；没报告就不写 */
  respondedModel?: string;
  /** 请求的推理强度与实际生效值（pi 不回报生效值，记 not_collected） */
  thinking: { requested: ThinkingLevel | "default"; effective: "not_collected" };
  configHash: string;
  promptVersion: string;
  status: "ok" | "call-error";
  /** 稳定的错误类别（不含正文） */
  errorClass?: string;
  usage: NonNullable<ModelResponse["usage"]> | "not_collected";
  stopReason?: string;
  inputHash: string;
  outputHash?: string;
  /** 随调用传入的图片（v2.6）：类型、尺寸、字节数与哈希；不保存图片字节 */
  images?: ImageMeta[];
}

/** 一次模型调用的正文：只进受保护的事件详情（脱敏、长度上限由存放方负责），不进性能记录。 */
export interface ModelCallContent {
  callId: string;
  system: string;
  prompt: string;
  response?: string;
  error?: string;
}

export interface ModelCallSink {
  record(meta: ModelCallRecord, content: ModelCallContent): void;
}

/** 错误类别：只取可公开的稳定前缀，不带正文。 */
export function errorClassOf(message: string): string {
  if (/timed? ?out|超时|TIMEOUT/i.test(message)) return "timeout";
  if (/401|403|unauthori[sz]ed|api key|密钥|凭据/i.test(message)) return "auth";
  if (/429|rate limit|限流/i.test(message)) return "rate-limit";
  if (/POLICY_FAIL_CLOSED|OS 边界/.test(message)) return "sandbox";
  if (/没有产出助手消息|模型调用失败/.test(message)) return "model-error";
  return "call-error";
}

/**
 * 给端口加上调用登记：每次 complete 记一条元数据 + 一份正文。登记失败不影响调用本身。
 * 调用方按登记范围（一次规划、一次验收作业……）各包一层。
 */
export function observedPort(port: ModelInvocationPort, sink: ModelCallSink, scope: ModelCallScope, now: () => Date = () => new Date()): ModelInvocationPort {
  let seq = 0;
  return {
    async complete(config, call) {
      seq += 1;
      const mySeq = seq;
      const started = now();
      // 图片不合格时 prepareImages 抛错，由下面的 catch 按调用失败登记
      let images: ImageMeta[] = [];
      let imageError: Error | undefined;
      try { images = prepareImages(config, call.images, call.imageLimits); } catch (e) { imageError = e as Error; }
      const inputHash = callInputHash(call.system, call.prompt, images);
      const callId = `mc_${sha256(`${scope.sessionId ?? scope.planId ?? ""}|${scope.module}|${scope.jobId ?? ""}|${mySeq}|${started.toISOString()}|${inputHash}`).slice(7, 23)}`;
      const base = {
        callId, seq: mySeq, startedAt: started.toISOString(), role: config.role, scope, provider: config.provider, model: config.model,
        thinking: { requested: requestedThinking(config), effective: "not_collected" as const },
        configHash: configHashOf(config), promptVersion: config.promptVersion, inputHash,
        ...(images.length ? { images } : {})
      };
      const emit = (meta: ModelCallRecord, content: ModelCallContent): void => {
        try { sink.record(meta, content); } catch { /* 登记失败不改变调用结果 */ }
      };
      try {
        if (imageError) throw imageError;
        const res = await port.complete(config, call);
        emit({
          ...base, durationMs: res.durationMs, status: "ok",
          ...(res.model ? { respondedModel: res.model } : {}), ...(res.stopReason ? { stopReason: res.stopReason } : {}),
          usage: res.usage ?? "not_collected", outputHash: sha256(res.text)
        }, { callId, system: call.system, prompt: call.prompt, response: res.text });
        return res;
      } catch (e) {
        const message = (e as Error).message ?? String(e);
        emit({ ...base, durationMs: now().getTime() - started.getTime(), status: "call-error", errorClass: errorClassOf(message), usage: "not_collected" },
          { callId, system: call.system, prompt: call.prompt, error: message.slice(0, 400) });
        throw e;
      }
    }
  };
}
