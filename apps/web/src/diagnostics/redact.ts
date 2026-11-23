/**
 * 诊断数据的脱敏与规范化（V1.4 §3.3「隐私」）。
 *
 * 客户端在序列化前已经脱敏一次；服务端这里再做一次，按白名单收字段，不信任客户端。
 * 只保留定位问题需要的形状：路由模板、错误类、截短的错误文字、本站资源的文件名与行列号。
 */
import { createHash } from "node:crypto";

const AUTH_SCHEME = /\b(Bearer|Basic)(\s+)[^\s,;"']+/gi;
const SECRET_PAIR = /\b(token|apikey|api_key|access_token|refresh_token|password|passwd|secret|cookie|session|authorization)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 长随机串：令牌、签名、会话 ID 等。至少 24 个字符且同时含字母与数字。
const LONG_TOKEN = /\b(?=[A-Za-z0-9_\-+/=]*\d)(?=[A-Za-z0-9_\-+/=]*[A-Za-z])[A-Za-z0-9_\-+/=]{24,}\b/g;
const URL_QUERY = /(https?:\/\/[^\s?#"']+|\/[\w\-./]*)[?#][^\s"')]*/g;

/** 错误文字：去掉凭据样式、邮箱、长随机串与 URL 查询串，最后截短。 */
export function redactText(input: unknown, max = 300): string {
  if (input === undefined || input === null) return "";
  let text = String(input);
  text = text.replace(URL_QUERY, "$1?…");
  text = text.replace(AUTH_SCHEME, (_m, key: string, sep: string) => `${key}${sep}[redacted]`);
  text = text.replace(SECRET_PAIR, (_m, key: string, sep: string) => `${key}${sep}[redacted]`);
  text = text.replace(EMAIL, "[email]");
  text = text.replace(LONG_TOKEN, "[id]");
  text = text.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 路径里像资源 ID 的片段换成 :id；不带查询串与 hash。和 slow-diagnostics 的 routeShape 一致。 */
export function shapePath(pathname: string): string {
  const path = pathname.split(/[?#]/)[0] ?? "";
  return path.split("/").map((part) => (part && (/^(?=.*\d)[A-Za-z0-9_-]{12,}$/.test(part) || /^[A-Za-z0-9_-]{24,}$/.test(part)) ? ":id" : part)).join("/").slice(0, 120);
}

/**
 * 栈：只留帧位置（文件名:行:列），不留函数名以外的上下文。
 * - 浏览器：/assets/<digest>/app.js:12:3 → app.js@<digest 前 12 位>:12:3；/app.js?v=x:12:3 → app.js:12:3
 * - 服务端：只留仓库内相对路径（apps/…、packages/…），node: 内部帧与依赖帧丢掉
 * 外站脚本（浏览器扩展、注入脚本）的帧记成 [external]，方便分诊时识别噪音。
 */
export function redactStack(input: unknown, maxFrames = 12): string {
  if (typeof input !== "string" || !input) return "";
  const frames: string[] = [];
  for (const raw of input.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/(?:^|[\s(@])node:/.test(line)) continue; // Node 内部帧
    const loc = /((?:[a-z][a-z-]*:\/\/)[^\s()]+?|\/[^\s()]+?|[\w.-]+\.(?:js|ts|mjs|cjs)):(\d+)(?::(\d+))?(?=[)\s]|$)/.exec(line);
    if (!loc) continue;
    const fn = /^(?:at\s+)?([\w$.<>\[\] ]{1,60}?)\s*[(@]/.exec(line)?.[1]?.trim();
    const where = frameLocation(loc[1]!);
    if (!where) continue;
    frames.push(`${fn && !/^(?:async|new)$/.test(fn) ? `${fn.replace(/\s+/g, " ")} ` : ""}${where}:${loc[2]}${loc[3] ? `:${loc[3]}` : ""}`);
    if (frames.length >= maxFrames) break;
  }
  return frames.join("\n");
}

function frameLocation(raw: string): string | null {
  let path = raw;
  if (/^[a-z][a-z-]*:\/\//.test(path) && !/^(?:https?|file):\/\//.test(path)) return "[external]";
  if (/^https?:\/\//.test(path)) {
    try {
      const url = new URL(path);
      if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(url.host) && !url.host.endsWith(".example.com") && !/^[\w.-]+\.(?:test|local)(?::\d+)?$/.test(url.host)) return "[external]";
      path = url.pathname;
    } catch { return null; }
  }
  path = path.replace(/^file:\/\//, "").split("?")[0]!;
  const asset = /^\/assets\/([a-f0-9]{64})\/([\w-]+\.(?:js|css))$/.exec(path);
  if (asset) return `${asset[2]}@${asset[1]!.slice(0, 12)}`;
  if (/^\/[\w-]+\.js$/.test(path)) return path.slice(1);
  if (path.startsWith("node:") || path.includes("/node_modules/")) return null;
  const repo = /(?:^|\/)((?:apps|packages|scripts)\/.+)$/.exec(path);
  if (repo) return repo[1]!;
  if (/^[\w.-]+\.(?:js|ts|mjs|cjs)$/.test(path)) return path;
  return "[external]";
}

/** 栈顶第一帧（不含函数名），给指纹用。 */
export function topFrame(stack: string): string {
  const first = stack.split("\n").find((l) => l && !l.includes("[external]")) ?? "";
  // 去掉函数名与列号；资源 digest 也去掉，换版本不换指纹
  const loc = first.split(" ").pop() ?? "";
  return loc.replace(/@[a-f0-9]{12}/, "").replace(/:(\d+):\d+$/, ":$1");
}

/** 稳定指纹（V1.4 §6.1）：组件/操作 + 错误类型 + 规范化栈顶或接口模板；不含时间、ID、release。 */
export function fingerprint(parts: { component?: string | null; errorType?: string | null; frame?: string | null; route?: string | null }): string {
  const key = ["v1", parts.component || "-", parts.errorType || "unknown", parts.frame || parts.route || "-"].join("|");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** 任意 JSON 值的有界拷贝：限制深度、键数、数组长度与字符串长度，字符串一律脱敏。 */
export function boundedJson(value: unknown, depth = 4, maxString = 300): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return redactText(value, maxString);
  if (depth <= 0) return null;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => boundedJson(v, depth - 1, maxString));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      if (!/^[A-Za-z_][\w-]{0,40}$/.test(k)) continue;
      out[k] = boundedJson(v, depth - 1, maxString);
    }
    return out;
  }
  return null;
}

/** 一条前端或服务端事件的指纹：打包限流、每晚分诊、复发判断都用这一个函数，保证口径一致。 */
export function eventFingerprint(e: Record<string, unknown>): string {
  const stack = typeof e["stack"] === "string" ? e["stack"] : "";
  if (e["event_name"] === "server_error") return fingerprint({ component: `server:${String(e["route"] ?? "-")}`, errorType: String(e["error_type"] ?? "Error"), frame: topFrame(stack) });
  if (e["event_name"] === "process_error") return fingerprint({ component: "server:process", errorType: String(e["error_type"] ?? "Error"), frame: topFrame(stack) });
  const str = (k: string) => (typeof e[k] === "string" ? e[k] as string : null);
  // 读取超时 / 网络断开多半是连接层的问题（机器负载、部署切换、链路），不按接口拆成很多个问题
  if (e["event_name"] === "request_failed" && (e["error_type"] === "timeout" || e["error_type"] === "network")) return fingerprint({ component: "requests", errorType: str("error_type") });
  return fingerprint({ component: str("component_id"), errorType: str("error_type") ?? str("event_name"), frame: stack ? topFrame(stack) : null, route: str("api_route") ?? str("route_template") });
}
