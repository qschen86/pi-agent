import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

const MAX_BYTES = 8 * 1024 * 1024;
const privateNames = /(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|corp|intranet|onion|invalid|test)$/i;
const excluded = new BlockList();
for (const [ip, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 3], ["168.63.129.16", 32],
] as const) excluded.addSubnet(ip, bits, "ipv4");
for (const [ip, bits] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) excluded.addSubnet(ip, bits, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export class LinkReadError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function parsePublicLink(raw: unknown): URL {
  const url = typeof raw === "string" && raw.length <= 4096 ? URL.parse(raw) : null;
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) {
    throw new LinkReadError("INVALID_LINK_URL", "补读需要使用标准端口且不含登录凭据的 HTTP(S) 链接。");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare) ? !isPublicAddress(bare) : !hostname.includes(".") || privateNames.test(hostname)) {
    throw new LinkReadError("LINK_NOT_PUBLIC", "平台补读仅访问公开互联网地址。");
  }
  url.hash = "";
  return url;
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !excluded.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !excluded.check(address, "ipv6");
}

type Address = { address: string; family: number };

async function lookupAddresses(hostname: string, signal: AbortSignal): Promise<Address[]> {
  signal.throwIfAborted();
  const ip = hostname.replace(/^\[|\]$/g, "");
  const family = isIP(ip);
  if (family) return [{ address: ip, family }];
  // The trailing dot prevents resolver search suffixes from turning a domain into an internal name.
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    lookup(hostname.endsWith(".") ? hostname : hostname + ".", { all: true }).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

type LinkReply =
  | { location: string }
  | { contentType: string; bytes: Buffer };

export async function downloadLink(url: URL, signal: AbortSignal): Promise<LinkReply> {
  const addresses = await lookupAddresses(url.hostname, signal);
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new LinkReadError("LINK_NOT_PUBLIC", "链接域名解析到了本机、内网或保留地址。");
  }
  const { address, family } = addresses.find(candidate => candidate.family === 4) ?? addresses[0]!;
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise<LinkReply>((resolve, reject) => {
    // Pin the verified IP for this connection. URL still supplies Host, TLS SNI and certificate identity.
    const req = request(url, {
      signal, agent: false, family,
      lookup: (_host, _options, callback) => callback(null, address, family),
      headers: { accept: "text/html,application/pdf,text/plain,*/*;q=0.5", "accept-encoding": "identity" },
    }, response => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      const fail = (code: string, message: string) => {
        response.destroy();
        reject(new LinkReadError(code, message));
      };
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        response.destroy();
        resolve({ location });
        return;
      }
      if (status === 401 || status === 403) return fail("LINK_ACCESS_DENIED", `站点拒绝访问或要求登录（HTTP ${status}）。`);
      if (status === 404 || status === 410) return fail("LINK_UNAVAILABLE", `链接不存在或已失效（HTTP ${status}）。`);
      if (status !== 200) return fail("LINK_HTTP_ERROR", `站点未返回完整正文（HTTP ${status}）。`);
      const encoding = response.headers["content-encoding"];
      if (encoding && encoding !== "identity") return fail("LINK_UNSUPPORTED_ENCODING", "站点返回了暂不支持的压缩格式。");
      if (Number(response.headers["content-length"]) > MAX_BYTES) return fail("LINK_TOO_LARGE", "页面超过补读的 8 MB 限制。");

      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("error", reject);
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) return fail("LINK_TOO_LARGE", "页面超过补读的 8 MB 限制。");
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ contentType: response.headers["content-type"] ?? "", bytes: Buffer.concat(chunks, bytes) }));
    });
    req.on("error", reject);
    req.end();
  });
}
