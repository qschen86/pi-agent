import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

/**
 * 发起端（统计应用的拆解维度）：按「轮次」算，一轮的第一条消息从哪个端发来，这一轮就算哪个端。
 *
 * 轮次本身不带来源，所以在收到「新建会话 / 发消息 / 排队消息」请求时，按请求头判断手机还是 PC，
 * 以这条消息的幂等键为索引追加到 turn-origins.jsonl；统计时由轮次的操作键反查。
 * - 记录开始之后产生、却查不到记录的轮次 = 自动（定时任务、额度恢复、群聊投递等无人发起的）；
 * - 记录开始之前的轮次 = 未知（当时没有记）。
 */
export type DeviceOrigin = "mobile" | "desktop" | "auto" | "unknown";

const MOBILE_UA = /Mobile|Android|iPhone|iPod|iPad|HarmonyOS|MiuiBrowser/i;

/** 请求头 → 手机 / PC：Client Hints 说是手机就是手机，否则看 User-Agent（安卓 APK 的 WebView 也带 Android / Mobile）。 */
export function deviceOfRequest(header: (name: string) => string | undefined): "mobile" | "desktop" {
  return header("sec-ch-ua-mobile") === "?1" || MOBILE_UA.test(header("user-agent") ?? "") ? "mobile" : "desktop";
}

const sha32 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

/** 一条消息可能经过的几种操作键：直接发、进部署等待箱后转排队（q-<哈希>）、新建的首条消息。 */
export function originKeys(action: "create" | "turn" | "outbox", body: Record<string, unknown>): string[] {
  const key = String(body["idempotencyKey"] ?? ""), messageId = String(body["messageId"] ?? "");
  if (action === "outbox") return messageId ? [`q-${messageId}`] : [];
  if (!key) return [];
  return action === "create" ? [key, `q-${sha32(`first:${key}`)}`] : [key, `q-${sha32(key)}`];
}

export class TurnOrigins {
  private map = new Map<string, "mobile" | "desktop">();
  private stamp = "";
  private sinceIso: string | undefined;

  constructor(private readonly file: string) {}

  private load(): void {
    let stamp = "-";
    try { const st = statSync(this.file); stamp = `${st.mtimeMs}:${st.size}`; } catch { /* 还没有记录 */ }
    if (stamp === this.stamp) return;
    this.stamp = stamp; this.map = new Map(); this.sinceIso = undefined;
    let text = "";
    try { text = readFileSync(this.file, "utf8"); } catch { return; }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const r = JSON.parse(line) as { k?: string; o?: string; at?: string };
        if (!this.sinceIso && r.at) this.sinceIso = r.at;
        if (r.k && (r.o === "mobile" || r.o === "desktop")) this.map.set(r.k, r.o);
      } catch { /* 跳过坏行 */ }
    }
  }

  record(keys: string[], origin: "mobile" | "desktop", at = new Date()): void {
    if (!keys.length) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, keys.map((k) => JSON.stringify({ k, o: origin, at: at.toISOString() })).join("\n") + "\n");
    } catch { /* 记不进去只是这一轮的发起端变成「自动 / 未知」，不能影响发消息 */ }
  }

  /** 这一轮的发起端：按操作键查；查不到时看是否在开始记录之后（自动）还是之前（未知）。 */
  deviceOfTurn(operationKey: string | undefined, startedAt: string | undefined): DeviceOrigin {
    this.load();
    const hit = operationKey ? this.map.get(operationKey) : undefined;
    if (hit) return hit;
    if (!this.sinceIso || !startedAt) return "unknown";
    return startedAt >= this.sinceIso ? "auto" : "unknown";
  }
}

const shared = new Map<string, TurnOrigins>();
/** 同一个文件共用一个读缓存。 */
export function turnOriginsAt(file: string): TurnOrigins {
  let value = shared.get(file);
  if (!value) { value = new TurnOrigins(file); shared.set(file, value); }
  return value;
}
