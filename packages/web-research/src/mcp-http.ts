/** Minimal request/response Streamable HTTP MCP transport; no background SSE connection. */
export class UpstreamError extends Error {
  constructor(readonly status: number, readonly upstreamCode: string, message: string) { super(message); }
}
export const protocolError = () => new UpstreamError(200, "PROTOCOL", "智谱 MCP 返回格式不正确");
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw protocolError();
  return value as Record<string, unknown>;
}
function upstream(status: number, error: unknown): UpstreamError {
  const code = error && typeof error === "object" ? String((error as { code?: unknown }).code ?? status) : String(status);
  return new UpstreamError(status, /^\d{1,10}$/.test(code) ? code : String(status), `智谱 MCP 请求失败（HTTP ${status}）`);
}
export interface McpOptions { apiKey: string; timeoutMs?: number; fetch?: typeof fetch }

async function readReply(res: Response, id: number): Promise<Record<string, unknown>> {
  if (!res.headers.get("content-type")?.includes("text/event-stream")) {
    return object(await res.json().catch(() => { throw protocolError(); }));
  }
  const reader = res.body?.getReader();
  if (!reader) throw protocolError();
  const decoder = new TextDecoder();
  let buffer = "", size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8 * 1024 * 1024) throw protocolError();
      buffer += decoder.decode(value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = event.split(/\r?\n/).filter(x => x.startsWith("data:")).map(x => x.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue;
        let parsed: Record<string, unknown>;
        try { parsed = object(JSON.parse(data)); } catch { throw protocolError(); }
        if (parsed.id === id) return parsed;
      }
    }
    throw protocolError();
  } finally { await reader.cancel().catch(() => {}); }
}

export async function callMcp(url: string, name: string, args: unknown, options: McpOptions): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs ?? 30_000);
  const headers: Record<string, string> = { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
  const send = async (method: string, params: unknown, id?: number): Promise<Record<string, unknown>> => {
    const res = await (options.fetch ?? fetch)(url, {
      method: "POST", headers, redirect: "error", signal: ctrl.signal,
      body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params })
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({})) as { error?: unknown };
      throw upstream(res.status, json.error);
    }
    const session = res.headers.get("mcp-session-id");
    if (session) headers["mcp-session-id"] = session;
    if (id === undefined) { await res.body?.cancel(); return {}; }
    const reply = await readReply(res, id);
    if (reply.error) throw upstream(res.status, reply.error);
    if (reply.jsonrpc !== "2.0" || reply.id !== id) throw protocolError();
    return object(reply.result);
  };
  try {
    const init = await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pi-agent", version: "0.1.0" } }, 1);
    if (typeof init.protocolVersion !== "string" || !["2024-11-05", "2025-03-26", "2025-06-18"].includes(init.protocolVersion)) throw protocolError();
    headers["mcp-protocol-version"] = init.protocolVersion;
    await send("notifications/initialized", {});
    const result = await send("tools/call", { name, arguments: args }, 2);
    if (result.isError) {
      // Never expose provider text (it can echo credentials); only recognize known codes.
      const text = JSON.stringify(result);
      const code = /\b1113\b|余额不足|资源包|quota.*exceed/i.test(text) ? "1113" : "TOOL_ERROR";
      throw new UpstreamError(200, code, "智谱 MCP 工具调用失败");
    }
    let data: unknown = result.structuredContent;
    if (data === undefined) {
      const blocks = result.content;
      if (!Array.isArray(blocks)) throw protocolError();
      const texts = blocks.filter(x => x?.type === "text" && typeof x.text === "string");
      if (texts.length !== 1) throw protocolError();
      data = texts[0].text;
    }
    // Current Zhipu tools encode JSON twice inside content[].text.
    for (let i = 0; i < 4 && typeof data === "string"; i++) {
      try { data = JSON.parse(data); } catch { throw protocolError(); }
    }
    if (!data || typeof data !== "object") throw protocolError();
    return data;
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    if (ctrl.signal.aborted) throw new UpstreamError(0, "TIMEOUT", "请求智谱 MCP 超时");
    throw new UpstreamError(0, "NETWORK", "无法连接智谱 MCP 服务");
  } finally { clearTimeout(timer); }
}
