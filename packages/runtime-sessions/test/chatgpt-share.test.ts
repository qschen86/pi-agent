import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import installPiBrowser from "../../pi-runtime/src/platform-browser-extension.js";
import { readChatGPTShare } from "../src/chatgpt-share.js";
import { startPlatformBrowser } from "../src/platform-browser.js";

const shareId = "01234567-89ab-cdef-0123-456789abcdef";
const url = `https://chatgpt.com/share/${shareId}?ogimg=plain`;

function sharePage(answer: string) {
  const message = (parent: string, role: string, text: string, metadata = {}) => ({
    parent, message: { author: { role }, recipient: "all", metadata, content: { content_type: "text", parts: [text] } },
  });
  const data = {
    current_node: "answer",
    mapping: {
      root: {},
      question: message("root", "user", "Question"),
      hidden: message("question", "assistant", "Hidden", { is_redacted: true }),
      tool: message("hidden", "tool", "Tool output"),
      answer: message("tool", "assistant", answer),
      otherBranch: message("question", "assistant", "Alternate answer"),
    },
  };
  const table: unknown[] = [];
  function encode(value: unknown): number {
    const index = table.length;
    table.push(null);
    if (Array.isArray(value)) table[index] = value.map(encode);
    else if (value && typeof value === "object") {
      table[index] = Object.fromEntries(Object.entries(value).map(([key, item]) => [`_${encode(key)}`, encode(item)]));
    } else table[index] = value;
    return index;
  }
  encode({ loaderData: { "routes/share.$shareId.($action)": { sharedConversationId: shareId, serverResponse: { data } } } });
  return `<script>window.__reactRouterContext.streamController.enqueue(${JSON.stringify(JSON.stringify(table))});</script>`;
}

const pageResponse = (html: string) => new Response(html, { headers: { "content-type": "text/html" } });
const signal = () => new AbortController().signal;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("requests the exact share once and returns the active visible conversation tail", async () => {
  const fetch = vi.fn(async () => pageResponse(sharePage("x".repeat(40_000) + "\n\nLast paragraph")));
  vi.stubGlobal("fetch", fetch);
  const result = await readChatGPTShare(url, signal());
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.truncated).toBe(true);
  expect(result.messages).toEqual([{ role: "assistant", text: "x".repeat(35_984) + "\n\nLast paragraph" }]);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(new URL(url), expect.objectContaining({ redirect: "manual" }));
});

it("reports unavailable shares, redirects, and pages without a matching conversation", async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(Response.redirect("https://example.com"))
    .mockResolvedValueOnce(pageResponse(sharePage("Wrong conversation")));
  vi.stubGlobal("fetch", fetch);
  expect(await readChatGPTShare("https://example.com/share/" + shareId, signal())).toMatchObject({ code: "INVALID_SHARE_URL" });
  expect(fetch).not.toHaveBeenCalled();
  expect(await readChatGPTShare(url, signal())).toMatchObject({ code: "SHARE_UNAVAILABLE" });
  expect(await readChatGPTShare(url, signal())).toMatchObject({ code: "SHARE_REDIRECTED" });
  expect(await readChatGPTShare(url.replace(shareId, shareId.replace(/^0/, "f")), signal())).toMatchObject({ code: "SHARE_TEXT_UNAVAILABLE" });
});

it("tries the document transport when ChatGPT only supplies link preview metadata", async () => {
  const path = mkdtempSync(join(tmpdir(), "share-document-"));
  try {
    writeFileSync(join(path, "page"), sharePage("Last paragraph"));
    writeFileSync(join(path, "curl"), '#!/bin/sh\nfor last do :; done\n[ "$last" = "$EXPECTED_SHARE_URL" ] || exit 1\n/bin/cat "${0%/*}/page"\n', { mode: 0o700 });
    vi.stubEnv("PATH", path);
    vi.stubEnv("EXPECTED_SHARE_URL", url);
    vi.stubGlobal("fetch", vi.fn(async () => pageResponse('<meta property="og:url"><meta property="og:description">')));
    const result = await readChatGPTShare(url, signal());
    expect(result).toMatchObject({
      ok: true,
      messages: [{ role: "user", text: "Question" }, { role: "assistant", text: "Last paragraph" }],
    });
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

it.each([false, true])("returns the same fallback through Pi and MCP with link-only mode set to %s", async (linkOnly) => {
  const fetch = vi.fn(async () => pageResponse(sharePage("Last paragraph")));
  vi.stubGlobal("fetch", fetch);
  const launch = vi.fn(async () => { throw new Error("Unexpected browser launch"); });
  const dir = mkdtempSync(join(tmpdir(), "share-test-"));
  const service = await startPlatformBrowser({ sessionId: "s", turnId: "t", workspace: dir, outputDir: dir, event() {}, launch, linkOnly });
  const bridge = spawn(process.execPath, [service.access.bridgePath, service.access.socketPath, ...(linkOnly ? ["--link-only"] : [])], { stdio: ["pipe", "pipe", "inherit"] });
  const replies = createInterface({ input: bridge.stdout })[Symbol.asyncIterator]();
  try {
    bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    const listing = JSON.parse((await replies.next()).value!);
    expect(listing.result.tools[0].inputSchema.properties.action.enum).toContain("read_chatgpt_share");
    expect(listing.result.tools[0].inputSchema.properties.action.enum).toContain("read_link");
    if (linkOnly) {
      expect(listing.result.tools[0].inputSchema.properties.action.enum).toEqual(["read_link", "read_chatgpt_share"]);
      bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser", arguments: { action: "open", url } } }) + "\n");
      expect(JSON.parse((await replies.next()).value!).result.isError).toBe(true);
    }
    bridge.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "browser", arguments: { action: "read_link", url: "http://localhost/" } },
    }) + "\n");
    const blocked = JSON.parse((await replies.next()).value!).result;
    expect(blocked.isError).toBe(true);
    expect(JSON.parse(blocked.content[0].text).code).toBe("LINK_NOT_PUBLIC");
    expect(fetch).not.toHaveBeenCalled();

    const args = { action: "read_link", url };
    vi.stubEnv("PI_PLATFORM_BROWSER_SOCKET", service.access.socketPath);
    const registerTool = vi.fn();
    installPiBrowser({ registerTool });
    const piResult = await registerTool.mock.calls[0]![0].execute("call", args);
    bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser", arguments: args } }) + "\n");
    const mcpResult = JSON.parse((await replies.next()).value!).result;
    const expected = {
      ok: true, requestedUrl: url, url, format: "chatgpt", truncated: false,
      messages: [{ role: "user", text: "Question" }, { role: "assistant", text: "Last paragraph" }],
    };
    expect(mcpResult.isError).toBe(false);
    expect(JSON.parse(mcpResult.content[0].text)).toEqual(expected);
    expect(JSON.parse(piResult.content[0].text)).toEqual(expected);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(launch).not.toHaveBeenCalled();
  } finally {
    const closed = once(bridge, "close");
    bridge.stdin.end();
    bridge.kill();
    await closed;
    await service.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
