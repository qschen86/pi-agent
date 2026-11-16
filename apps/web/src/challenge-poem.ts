import type { ModelInvocationPort, ModelResponse, RoleModelConfig } from "@pi-agent/model-port";

/**
 * 打卡纪念卡小诗（v3.83）。
 *
 * 小朋友拍完照、挑好相框之后，请 DeepSeek 按「心愿 + 相框背景」写一段四句打油诗，
 * 印在卡片上。只发送心愿文字、相框主题与日期，**不上传照片、不带昵称**。
 * 服务端负责提示词与人设，客户端不能改；输出只当数据用：四句、每句 4~14 个汉字，
 * 不合规就失败，页面退回本机模板诗——绝不把不合规文本印到小朋友的照片上。
 */
export const CHALLENGE_POEM_CONFIG: RoleModelConfig = {
  role: "challengePoem",
  provider: "deepseek",
  model: "deepseek-flash",
  thinking: "off",
  promptVersion: "challenge-poem@1",
  schemaVersion: "challenge-poem@1",
  timeoutMs: 12_000,
  maxAttempts: 1,
};

export interface PoemFrame {
  id: string;
  name: string;
  scene: string;
}

/** 与页面 card.js 的相框一一对应；客户端只传 id。 */
export const POEM_FRAMES: Record<string, PoemFrame> = {
  starlight: { id: "starlight", name: "星光魔法", scene: "星星、闪光、彩虹、梦幻夜色" },
  champion: { id: "champion", name: "今日小冠军", scene: "皇冠、奖杯、彩带、金色光环" },
  forest: { id: "forest", name: "森林童话", scene: "小狐狸、蝴蝶、树叶、蘑菇" },
  cosmos: { id: "cosmos", name: "宇宙探险", scene: "火箭、行星、月亮、银河" },
  comic: { id: "comic", name: "漫画大冒险", scene: "漫画气泡、速度线、搞怪音效" },
  diary: { id: "diary", name: "快乐日记", scene: "手账、胶带、拍立得、贴纸本" },
};

export class ChallengePoemError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 429 | 503 = 400) {
    super(message);
    this.name = "ChallengePoemError";
  }
}

export interface ChallengePoem {
  lines: string[];
  theme: string;
  source: "deepseek";
}

const cleanText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
};

/** 四句、每句 4~10 个汉字（标点不算），没有链接与英文长串。 */
export function parsePoemLines(raw: string): string[] | null {
  if (typeof raw !== "string") return null;
  const lines = raw
    .replace(/```[a-z]*/gi, "")
    .split(/[\r\n]+/)
    .map((line) =>
      line
        .replace(/^\s*(?:[-*•·]|\d+[).、]|第[一二三四]句[:：]?)\s*/, "")
        .replace(/[*_`#>]/g, "")
        .trim()
    )
    .filter((line) => /[\u4e00-\u9fff]/.test(line))
    .slice(0, 4);
  if (lines.length < 4) return null;
  for (const line of lines) {
    const plain = line.replace(/[，。！？、；：,.!?;:…—\s]/g, "");
    if (plain.length < 4 || plain.length > 10) return null;
    if (/https?:|www\.|[a-z]{4,}|\d{7,}/i.test(line)) return null;
    if (/[<>{}[\]\\|]/.test(line)) return null;
  }
  return lines;
}

export interface ChallengePoemOptions {
  port?: ModelInvocationPort;
  now?: () => number;
}

export class ChallengePoemService {
  private readonly now: () => number;
  private readonly usage = new Map<string, number[]>();

  constructor(private readonly options: ChallengePoemOptions = {}) {
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
      "你给小学三年级（8~9 岁）的小朋友写照片上的四句打油诗。",
      "规则：",
      "- 只写四句，每句 5~9 个汉字；第 2、4 句尽量押韵，读起来有节奏。",
      "- 结合给出的心愿和相框背景写，出现画面里的东西（星星、树叶、火箭……）。",
      "- 夸具体的努力和这件事本身，不要空喊“你真棒”，不要编造没做到的成就。",
      "- 不评价长相、胖瘦、聪明与否；不写广告、链接、英文句子、数字串。",
      "- 不用 Markdown、不用引号、不写题目，不要解释。",
      "- 只输出四行诗句，每行一句，句末可以用「，」「。」。",
    ].join("\n");
  }

  async write(raw: unknown, clientKey = "local"): Promise<ChallengePoem> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ChallengePoemError("POEM_INPUT", "小诗请求格式不对");
    }
    const body = raw as Record<string, unknown>;
    const wish = cleanText(body["wish"], 40);
    if (!wish) throw new ChallengePoemError("POEM_INPUT", "先告诉我想写哪个心愿");
    const frameId = typeof body["theme"] === "string" && POEM_FRAMES[body["theme"]] ? body["theme"] : "starlight";
    const frame = POEM_FRAMES[frameId]!;
    const style = cleanText(body["style"], 12);
    const dateLabel = cleanText(body["dateLabel"], 24);
    // 只把心愿与相框主题发给模型：照片、昵称、记录一律不出本机。
    if (!this.allow(clientKey)) {
      throw new ChallengePoemError("POEM_RATE_LIMIT", "小诗写得有点快，歇一会儿再换一句吧。", 429);
    }
    const port = this.options.port;
    if (!port) throw new ChallengePoemError("POEM_UNAVAILABLE", "小诗服务还没准备好", 503);

    const prompt = [
      "【心愿】",
      wish,
      "",
      `【相框背景】${frame.name}（${frame.scene}）`,
      ...(style ? [`【照片风格】${style}`] : []),
      ...(dateLabel ? [`【日期】${dateLabel}`] : []),
      "",
      "请写四句打油诗，只输出四行。",
    ].join("\n");

    let response: ModelResponse;
    try {
      response = await port.complete(CHALLENGE_POEM_CONFIG, { system: this.systemPrompt(), prompt });
    } catch {
      throw new ChallengePoemError("POEM_UNAVAILABLE", "小诗现在写不出来", 503);
    }
    const lines = parsePoemLines(response.text);
    if (!lines) throw new ChallengePoemError("POEM_INVALID", "小诗没写好", 503);
    return { lines, theme: frameId, source: "deepseek" };
  }
}
