/**
 * 联网检索扩展（独立文件，除 node:net 不带任何 import）：pi-runtime 把它复制到宿主管的只读 guard 目录，
 * 由 `pi --extension` 显式加载。密钥、上游请求、来源授权、预算与来源台账都在宿主侧的 Broker 里；
 * 本文件只拿到一个 Unix socket 路径，把工具调用转过去。
 *
 * 工具名是 pi 的命名：web_search / web_open；Broker 协议名是 web.search / web.open。
 * Broker 的应答文本已经是有界的、给模型看的格式，这里不加工，原样返回。
 */
import { createConnection } from "node:net";

interface BrokerRequest { tool: "web.search" | "web.open"; toolCallId: string; params: Record<string, unknown> }
export interface BrokerResponse { ok: boolean; text: string; code?: string; result?: unknown }

export interface ToolResult { content: Array<{ type: "text"; text: string }>; details: undefined }
export interface PiTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
}
export interface PiToolHost { registerTool(tool: PiTool): void }

const REQUEST_TIMEOUT_MS = 90_000;

/** 一次连接一个请求：与 Broker 的 IPC 契约一致，一行 JSON 请求 → 一行 JSON 应答。 */
export function callBrokerSocket(socketPath: string, request: BrokerRequest, timeoutMs = REQUEST_TIMEOUT_MS, signal?: AbortSignal): Promise<BrokerResponse> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (response: BrokerResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(response);
    };
    const onAbort = (): void => done({ ok: false, code: "ABORTED", text: "[ABORTED] 本轮已取消，检索请求中止" });
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => done({ ok: false, code: "TIMEOUT", text: "[TIMEOUT] 检索服务没有在时限内应答" }), timeoutMs);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try { done(JSON.parse(buffer.slice(0, newline)) as BrokerResponse); }
      catch { done({ ok: false, code: "PROTOCOL_ERROR", text: "[PROTOCOL_ERROR] 检索服务应答无法解析" }); }
    });
    socket.on("error", (error) => done({ ok: false, code: "CONFIG_MISSING", text: `[CONFIG_MISSING] 连不上检索服务：${error.message}` }));
  });
}

function responseText(response: BrokerResponse): string {
  return typeof response.text === "string" ? response.text : `[${response.code ?? "UPSTREAM_ERROR"}] 检索服务没有返回结果`;
}

const SEARCH_PARAMETERS: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: { type: "string", minLength: 1, maxLength: 70, description: "搜索词，最多 70 个字符；需要更多角度就再搜一次" },
    count: { type: "integer", minimum: 1, maximum: 10, description: "结果条数，默认 5" },
    recency: { type: "string", enum: ["day", "week", "month", "year", "any"], description: "只看最近一段时间的结果" },
    sourceDomain: { type: "string", description: "只搜这个域名（须在授权范围内）" }
  }
};

const OPEN_PARAMETERS: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["searchId", "resultId", "basis", "why"],
  properties: {
    searchId: { type: "string", minLength: 1, description: "web_search 返回的 searchId，如 q1" },
    resultId: { type: "string", minLength: 1, description: "结果编号，如 R1" },
    basis: { type: "string", enum: ["official", "media", "top3"], description: "挑选依据：official 官网（政府、监管机构或对象自己的官网）；media 权威媒体（结果里标了〔权威媒体〕的）；top3 相关结果里没有官网和权威媒体时按顺序从前三条里选" },
    why: { type: "string", minLength: 1, maxLength: 200, description: "一句话：它与调研的哪个问题相关、为什么选它" },
    part: { type: "integer", minimum: 1, maximum: 50, description: "第几段：正文超过每页上限时分段，接着读后面的段写 2、3……；不写就是第 1 段" }
  }
};

/** 按 socket 组装 web_search / web_open；tools 控制本会话注册哪几个。 */
export function webResearchTools(options: { socketPath: string; tools?: string[] }): PiTool[] {
  const enabled = options.tools ?? ["web_search", "web_open"];
  const run = (tool: "web.search" | "web.open") =>
    async (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> => {
      const response = await callBrokerSocket(options.socketPath, { tool, toolCallId, params }, REQUEST_TIMEOUT_MS, signal);
      if (!response.ok) throw new Error(responseText(response));
      return { content: [{ type: "text", text: responseText(response) }], details: undefined };
    };
  const tools: PiTool[] = [];
  if (enabled.includes("web_search")) tools.push({
    name: "web_search",
    label: "Web search",
    description: "搜索公开网页（经平台检索服务）。返回本会话的 searchId 与编号结果 R1…，含标题、URL、摘要、网页发布时间。",
    promptSnippet: "Search the public web; returns numbered results with URLs",
    promptGuidelines: [
      "Use web_search with a short query (at most 70 characters); refine the query and search again to cross-check important facts.",
      "Use web_open to read a result before citing it; web_open only accepts a searchId and resultId returned by web_search.",
      "Choose what to read: judge which results are relevant first; among relevant ones prefer official sites (government/regulator, or the organization's own site), then authoritative media; only if neither exists, pick from the first three results in order. Do not read the same page twice."
    ],
    parameters: SEARCH_PARAMETERS,
    execute: run("web.search")
  });
  if (enabled.includes("web_open")) tools.push({
    name: "web_open",
    label: "Web open",
    description: "阅读本会话 web_search 结果里的一个页面，返回来源编号 [S#]、URL、读取时间与正文节选。不接受任意 URL。basis 是挑它的依据：official 官网（政府、监管机构或对象自己的官网）；media 权威媒体（结果里标了〔权威媒体〕的）；top3 相关结果里没有官网和权威媒体时，按顺序从前三条里选。",
    promptSnippet: "Read one web_search result by searchId and resultId; returns a citable source [S#]",
    parameters: OPEN_PARAMETERS,
    execute: run("web.open")
  });
  return tools;
}

/** 没有 socket（未授权 / 未配置）就一个工具都不注册：未注册的工具调不到。 */
export function installWebResearch(pi: PiToolHost, options?: { socketPath?: string; tools?: string[] }): void {
  const socketPath = options?.socketPath ?? process.env["PI_WEB_RESEARCH_SOCKET"];
  if (!socketPath) return;
  const tools = options?.tools ?? (process.env["PI_WEB_RESEARCH_TOOLS"] ?? "web_search,web_open").split(",").map((name) => name.trim()).filter(Boolean);
  for (const tool of webResearchTools({ socketPath, tools })) pi.registerTool(tool);
}

export default function (pi: PiToolHost): void {
  installWebResearch(pi);
}
