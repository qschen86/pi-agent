/**
 * 来源 URL 校验（v1.8）：只接受 HTTPS 公网地址。
 *
 * 智谱 Reader 是远端抓取服务，不会碰到本机网络；但"平台替 Agent 去读某个地址"本身要有边界：
 * 用户信息、IP 字面量、本机与内网别名、非标准端口一律拒绝——判不清的也拒绝。
 */
export type UrlCheck = { ok: true; url: string; host: string } | { ok: false; reason: string };

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".corp", ".intranet", ".test", ".invalid", ".example"];
const HOST_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export function checkPublicHttpsUrl(raw: string): UrlCheck {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "不是合法的 URL" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "只接受 HTTPS" };
  if (u.username || u.password) return { ok: false, reason: "URL 不能带用户信息" };
  if (u.port && u.port !== "443") return { ok: false, reason: "只接受标准端口" };
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || /^[0-9.]+$/.test(host) || host.includes(":")) return { ok: false, reason: "不接受 IP 地址" };
  if (host === "localhost" || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return { ok: false, reason: "不接受本机或内网地址" };
  if (!HOST_RE.test(host)) return { ok: false, reason: "判不清的主机名" };
  u.hash = "";
  return { ok: true, url: u.toString(), host };
}
