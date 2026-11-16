/**
 * 对外「入口链接」的首选源（分享链接等服务端生成的外链都从这里取）。
 *
 * 默认国内备用入口；PI_AGENT_PREFERRED_ORIGIN 可覆盖，设为 "off" 则退回旧行为
 * （第一个对外域名，没有就用请求自身的源）。
 * 该入口的 Caddy 会把 Host 改写成备用主机，所以它不必出现在 PI_AGENT_WEB_PUBLIC_HOSTS 里。
 */
export const DEFAULT_PREFERRED_ORIGIN = "https://gui-backup-cn.harness.fund";

export function preferredOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env["PI_AGENT_PREFERRED_ORIGIN"] ?? DEFAULT_PREFERRED_ORIGIN).trim();
  if (!raw || raw.toLowerCase() === "off") return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch { return null; }
}
