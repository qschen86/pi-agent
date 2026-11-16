import type { ModelInvocationPort, ModelResponse, RoleModelConfig } from "@pi-agent/model-port";

/**
 * 心愿挑战岛：按名字现配一个图标（v3.113）。
 *
 * 家长写目标 / 礼物 / 惩罚任务时，固定的 12 个 emoji 里常常没有合适的（整理书包、背古诗、
 * 练口算……）。这里请 DeepSeek 照着名字挑**一个** emoji 当图标，客户端把它插到图标行最前面。
 *
 * 只发送「名字 + 类别」两样东西，不带昵称、照片、星星数；输出只当数据用：必须恰好一个
 * emoji，带字母、数字、多个 emoji 或解释文字都判失败，客户端再退回本机关键词表。
 */
export const CHALLENGE_ICON_CONFIG: RoleModelConfig = {
  role: "challengeIcon",
  provider: "deepseek",
  model: "deepseek-flash",
  thinking: "off",
  promptVersion: "challenge-icon@1",
  schemaVersion: "challenge-icon@1",
  timeoutMs: 6_000,
  maxAttempts: 1,
};

/** 客户端的三个图标选择区；未知值一律按挑战目标处理。 */
export const ICON_KINDS = {
  goal: "挑战目标（每天 / 每周重复做的打卡任务）",
  gift: "心愿礼物（攒够星星兑换的奖励）",
  penalty: "惩罚任务（做错事要扣星星）",
} as const;

export type IconKind = keyof typeof ICON_KINDS;

export class ChallengeIconError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 429 | 503 = 400
  ) {
    super(message);
    this.name = "ChallengeIconError";
  }
}

export interface ChallengeIconPick {
  emoji: string;
  kind: IconKind;
  source: "deepseek";
}

const cleanText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
};

const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });

/** 一个可以被当作图标的 emoji：不含字母、数字、汉字、井号（键帽 emoji 也一并挡掉）。 */
function isIcon(grapheme: string): boolean {
  if (!grapheme) return false;
  if (/[A-Za-z0-9\u4e00-\u9fff#*]/.test(grapheme)) return false;
  return /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/u.test(grapheme);
}

/**
 * 模型输出 → 一个 emoji。允许前后有引号、反引号、句号这类标点；出现两个以上不同的 emoji、
 * 或者夹着文字，都算没配好（不猜、不截取），交给客户端兜底。
 */
export function parseIconEmoji(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw
    .replace(/```[a-z]*/gi, " ")
    .replace(/[`*_"'\u200b]/g, " ")
    .trim();
  if (!text) return null;
  const found = new Set<string>();
  let rest = "";
  for (const { segment } of segmenter.segment(text)) {
    if (isIcon(segment)) found.add(segment);
    else rest += segment;
  }
  if (found.size !== 1) return null;
  // 除标点、空白之外还夹着别的东西，说明模型在解释或写了字：当作没配好。
  if (/[^\s\p{P}]/u.test(rest)) return null;
  return [...found][0]!;
}

export interface ChallengeIconOptions {
  port?: ModelInvocationPort;
  now?: () => number;
}

export class ChallengeIconService {
  private readonly now: () => number;
  private readonly usage = new Map<string, number[]>();

  constructor(private readonly options: ChallengeIconOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  private allow(key: string): boolean {
    const now = this.now();
    const recent = (this.usage.get(key) ?? []).filter((time) => now - time < 60_000);
    if (recent.length >= 20) {
      this.usage.set(key, recent);
      return false;
    }
    recent.push(now);
    this.usage.set(key, recent);
    if (this.usage.size > 500) this.usage.clear();
    return true;
  }

  private systemPrompt(): string {
    return [
      "你给小学三年级（8~9 岁）小朋友的打卡 App 配图标。",
      "规则：",
      "- 只输出 1 个 emoji，不要文字、不要解释、不要标点、不要引号。",
      "- 挑具体、一眼能看出在做什么的那个（跳绳→🤸、整理书包→🎒、背古诗→📜）。",
      "- 不用字母、数字、键帽、国旗、手势、人物肤色、品牌标志。",
      "- 想不出很贴切的，就挑一个孩子能看懂的近似物，不要留空。",
    ].join("\n");
  }

  async pick(raw: unknown, clientKey = "local"): Promise<ChallengeIconPick> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ChallengeIconError("ICON_INPUT", "图标请求格式不对");
    }
    const body = raw as Record<string, unknown>;
    const text = cleanText(body["text"], 20);
    if (!text) throw new ChallengeIconError("ICON_INPUT", "先写上名字，我照着配一个");
    const kindValue = typeof body["kind"] === "string" ? body["kind"] : "";
    const kind: IconKind = kindValue in ICON_KINDS ? (kindValue as IconKind) : "goal";
    // 只把名字与类别发给模型：昵称、星星数、照片一律不出本机。
    if (!this.allow(clientKey)) {
      throw new ChallengeIconError("ICON_RATE_LIMIT", "配得有点快，歇一会儿再配吧。", 429);
    }
    const port = this.options.port;
    if (!port) throw new ChallengeIconError("ICON_UNAVAILABLE", "配图标的服务还没准备好", 503);

    const prompt = ["【类别】" + ICON_KINDS[kind], "【名字】" + text, "", "只输出 1 个 emoji。"].join("\n");

    let response: ModelResponse;
    try {
      response = await port.complete(CHALLENGE_ICON_CONFIG, { system: this.systemPrompt(), prompt });
    } catch {
      throw new ChallengeIconError("ICON_UNAVAILABLE", "图标现在配不出来", 503);
    }
    const emoji = parseIconEmoji(response.text);
    if (!emoji) throw new ChallengeIconError("ICON_INVALID", "图标没配好", 503);
    return { emoji, kind, source: "deepseek" };
  }
}
