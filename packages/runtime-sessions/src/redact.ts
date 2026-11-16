/**
 * 来源内容按不可信数据处理（F14 / V28-17）：输出有界、敏感值脱敏。
 * 这里只做文本层面的处理；渲染端一律 textContent，不解释 HTML / Markdown 里的脚本。
 */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, "sk-ant-…[已脱敏]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "sk-…[已脱敏]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "gh_…[已脱敏]"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, "xox…[已脱敏]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA…[已脱敏]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "eyJ…[JWT 已脱敏]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[私钥已脱敏]"],
  // KEY=value / "token": "value" 形式：只遮值
  [/\b((?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|ACCESS_KEY)[A-Z0-9_]*)\s*[=:]\s*["']?([^\s"']{6,})/g, "$1=[已脱敏]"],
  [/("(?:api_?key|secret|token|password|access_token|refresh_token|authorization)"\s*:\s*")([^"]{6,})(")/gi, "$1[已脱敏]$3"],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/g, "$1 [已脱敏]"]
];

export interface Bounded { text: string; redactions: number; truncated?: { originalChars: number } }

export function redact(text: string): { text: string; redactions: number } {
  let n = 0;
  let out = text;
  for (const [re, rep] of SECRET_PATTERNS) {
    out = out.replace(re, (...args) => {
      n++;
      // 带分组的替换串需要手动展开
      return rep.replace(/\$(\d)/g, (_, i) => String(args[Number(i)] ?? ""));
    });
  }
  return { text: out, redactions: n };
}

/** 脱敏后截断：超过 limit 的部分不进页面，标明原长度 */
export function bounded(text: string | undefined | null, limit: number): Bounded {
  const raw = typeof text === "string" ? text : "";
  const { text: clean, redactions } = redact(raw);
  if (clean.length <= limit) return { text: clean, redactions };
  return { text: `${clean.slice(0, limit)}\n…（已截断，原文 ${clean.length} 字符）`, redactions, truncated: { originalChars: clean.length } };
}

export const LIMITS = { message: 20_000, toolInput: 4_000, toolOutput: 8_000, preview: 200 } as const;

/** 邮箱打码：只留首字母和域名 */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return "未知";
  const [user, domain] = email.split("@");
  if (!domain || !user) return "已脱敏";
  return `${user.slice(0, 1)}***@${domain}`;
}

export function stringifyInput(v: unknown): string {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
