import { execFile } from "node:child_process";
import { promisify } from "node:util";

const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_LENGTH = 36_000;
const SHARE_PATH = /^\/share\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\/?$/i;
const runFile = promisify(execFile);

type ShareMessage = { role: "user" | "assistant"; text: string };
type ShareFailure = { ok: false; code: string; error: string };

export function isChatGPTShareUrl(url: URL): boolean {
  return url.origin === "https://chatgpt.com" && !url.username && !url.password && SHARE_PATH.test(url.pathname);
}

function failure(code: string, error: string): ShareFailure {
  return { ok: false, code, error };
}

// Read only the fields needed from the share route's flattened React Router data.
// The page is external data. Its scripts and serialization plugins are never executed.
export function extractChatGPTShare(html: string, shareId: string): ShareMessage[] {
  const chunks = html.matchAll(/<script\b[^>]*>\s*window\.__reactRouterContext\.streamController\.enqueue\(("(?:[^"\\]|\\.)*")\)\s*;?\s*<\/script\s*>/g);
  for (const chunk of chunks) {
    const payload = JSON.parse(chunk[1]!) as string;
    if (!payload.trimStart().startsWith("[")) continue;
    const table = JSON.parse(payload) as unknown[];
    const field = (value: unknown, key: string): unknown => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      for (const [index, ref] of Object.entries(value)) {
        if (/^_\d+$/.test(index) && table[Number(index.slice(1))] === key && typeof ref === "number") return table[ref];
      }
      return undefined;
    };

    const route = field(field(table[0], "loaderData"), "routes/share.$shareId.($action)");
    if (field(route, "sharedConversationId") !== shareId) continue;
    const data = field(field(route, "serverResponse"), "data");
    const mapping = field(data, "mapping");
    const messages: ShareMessage[] = [];
    const visited = new Set<string>();
    let current = field(data, "current_node");
    while (typeof current === "string") {
      if (visited.has(current)) return [];
      visited.add(current);
      const node = field(mapping, current);
      if (!node) return [];
      const message = field(node, "message");
      const role = field(field(message, "author"), "role");
      const metadata = field(message, "metadata");
      const content = field(message, "content");
      const recipient = field(message, "recipient");
      const parts = field(content, "parts");
      if ((role === "user" || role === "assistant")
        && (recipient === "all" || recipient === undefined)
        && field(metadata, "is_visually_hidden_from_conversation") !== true
        && field(metadata, "is_redacted") !== true
        && field(metadata, "is_user_system_message") !== true
        && ["text", "multimodal_text"].includes(String(field(content, "content_type")))
        && Array.isArray(parts)) {
        const text = parts.flatMap(ref => typeof ref === "number" && typeof table[ref] === "string" ? [table[ref] as string] : []).join("\n\n");
        if (text.trim()) messages.push({ role, text });
      }
      current = field(node, "parent");
    }
    return messages.reverse();
  }
  return [];
}

async function readHtml(response: Response): Promise<string | undefined> {
  if (!response.body || !/^text\/html\b/i.test(response.headers.get("content-type") ?? "")) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = "";
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return html + decoder.decode();
      size += value.byteLength;
      if (size > MAX_HTML_BYTES) return undefined;
      html += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function shareMessages(html: string, shareId: string): ShareMessage[] {
  try { return extractChatGPTShare(html, shareId); }
  catch { return []; }
}

async function readShareDocument(url: URL, signal: AbortSignal): Promise<string> {
  // A preview-only response can differ from the document returned to a browser-style request.
  // Disable curl config and redirects so this request stays within the validated share URL.
  const { stdout } = await runFile("curl", [
    "-q", "--silent", "--show-error", "--fail", "--proto", "=https",
    "--max-filesize", String(MAX_HTML_BYTES), "--max-time", "15", "--compressed",
    "--user-agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "--", url.href,
  ], { signal, maxBuffer: MAX_HTML_BYTES, encoding: "utf8" });
  return stdout;
}

export async function readChatGPTShare(raw: unknown, cancellation: AbortSignal) {
  const url = typeof raw === "string" && raw.length <= 2048 ? URL.parse(raw) : null;
  if (!url || !isChatGPTShareUrl(url)) {
    return failure("INVALID_SHARE_URL", "补读工具只支持 https://chatgpt.com/share/ 的对话分享链接。");
  }
  url.hash = "";
  const timeout = AbortSignal.timeout(15_000);
  const signal = AbortSignal.any([timeout, cancellation]);
  try {
    const response = await fetch(url, {
      headers: { accept: "text/html" },
      redirect: "manual",
      signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      if (response.status === 404 || response.status === 410) return failure("SHARE_UNAVAILABLE", "ChatGPT 返回分享不存在或已不可用。");
      if (response.status === 401 || response.status === 403) return failure("SHARE_ACCESS_DENIED", `ChatGPT 拒绝了本次读取（HTTP ${response.status}）。`);
      if (response.status >= 300 && response.status < 400) return failure("SHARE_REDIRECTED", "ChatGPT 将分享链接重定向，未返回原分享对话。");
      return failure("SHARE_HTTP_ERROR", `ChatGPT 未返回对话（HTTP ${response.status}）。`);
    }
    const html = await readHtml(response);
    if (html === undefined) {
      void response.body?.cancel().catch(() => undefined);
      return failure("UNSUPPORTED_SHARE_RESPONSE", "ChatGPT 返回的页面类型不受支持，或页面超过读取大小限制。");
    }
    const shareId = url.pathname.split("/")[2]!;
    let messages = shareMessages(html, shareId);
    if (!messages.length && html.includes('property="og:url"') && html.includes('property="og:description"')) {
      const document = await readShareDocument(url, signal).catch(() => "");
      messages = shareMessages(document, shareId);
    }
    if (cancellation.aborted) return failure("SHARE_CANCELLED", "分享补读已取消。");
    if (timeout.aborted) return failure("SHARE_TIMEOUT", "读取 ChatGPT 分享页超时。");
    if (!messages.length) return failure("SHARE_TEXT_UNAVAILABLE", "打开了 ChatGPT 分享页，但未能提取可见的对话正文。");

    const tail: ShareMessage[] = [];
    let remaining = MAX_TEXT_LENGTH;
    for (const message of messages.reverse()) {
      if (remaining <= 0) break;
      tail.push({ ...message, text: message.text.slice(-remaining) });
      remaining -= message.text.length;
    }
    return { ok: true, url: url.href, truncated: tail.length < messages.length || remaining < 0, messages: tail.reverse() };
  } catch {
    if (cancellation.aborted) return failure("SHARE_CANCELLED", "分享补读已取消。");
    if (timeout.aborted) return failure("SHARE_TIMEOUT", "读取 ChatGPT 分享页超时。");
    return failure("SHARE_CONNECTION_FAILED", "平台未能连接或读完 ChatGPT 分享页。");
  }
}
