import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BinaryFrameLink,
  createEncryptedFrameLink,
  generateStaticKeyPair,
  MacRemoteAdapter,
  MuxSession,
  NoiseHandshake,
  type ResHeadPayload,
} from "../src/index.js";

function createInMemoryPipe(): [BinaryFrameLink, BinaryFrameLink] {
  const listenersA = new Set<(f: Uint8Array) => void>();
  const listenersB = new Set<(f: Uint8Array) => void>();
  let closed = false;
  const linkA: BinaryFrameLink = {
    send(frame) {
      if (closed) return;
      const copy = new Uint8Array(frame);
      queueMicrotask(() => {
        if (!closed) for (const fn of listenersB) fn(copy);
      });
    },
    onFrame(fn) {
      listenersA.add(fn);
      return () => listenersA.delete(fn);
    },
    close() {
      closed = true;
      listenersA.clear();
      listenersB.clear();
    },
  };
  const linkB: BinaryFrameLink = {
    send(frame) {
      if (closed) return;
      const copy = new Uint8Array(frame);
      queueMicrotask(() => {
        if (!closed) for (const fn of listenersA) fn(copy);
      });
    },
    onFrame(fn) {
      listenersB.add(fn);
      return () => listenersB.delete(fn);
    },
    close() {
      closed = true;
      listenersA.clear();
      listenersB.clear();
    },
  };
  return [linkA, linkB];
}

describe("MacRemoteAdapter end-to-end HTTP / SSE / large binary / cancellation / revocation", () => {
  const DEVICE_TOKEN = "trusted-device-token-0123456789abcdef012345";
  const BIG_DOWNLOAD = randomBytes(4 * 1024 * 1024); // 4 MiB download fixture
  const BIG_ETAG = `"${createHash("sha256").update(BIG_DOWNLOAD).digest("hex").slice(0, 16)}"`;
  let baseUrl = "";
  let sseAbortedCount = 0;
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      // Verify trusted device token injection and spoofed header stripping.
      if (url.pathname === "/api/echo-auth") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            authorization: req.headers["authorization"] ?? null,
            cookie: req.headers["cookie"] ?? null,
            forwardedFor: req.headers["x-forwarded-for"] ?? null,
            requestId: req.headers["x-heji-request-id"] ?? null,
          }),
        );
        return;
      }

      // Real SSE streaming endpoint with cancellation detection.
      if (url.pathname === "/api/runtime/stream") {
        const count = Number(url.searchParams.get("count") ?? "5");
        const hold = url.searchParams.get("hold") === "1";
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        let sent = 0;
        let closed = false;
        const timer = setInterval(() => {
          if (closed) return;
          if (sent < count) {
            sent += 1;
            res.write(`id: ${sent}\nevent: delta\ndata: {"seq":${sent}}\n\n`);
          } else if (!hold) {
            clearInterval(timer);
            res.end();
          }
        }, 15);
        req.on("close", () => {
          closed = true;
          clearInterval(timer);
          if (hold) sseAbortedCount += 1;
        });
        return;
      }

      // 和线上控制台一样：客户端声明支持压缩就返回压缩内容 + content-encoding。
      if (url.pathname === "/assets/app.js") {
        const text = Buffer.from("console.log('heji');\n".repeat(2000));
        if (String(req.headers["accept-encoding"] ?? "").includes("gzip")) {
          const zipped = gzipSync(text);
          res.writeHead(200, { "content-type": "text/javascript", "content-encoding": "gzip", "content-length": zipped.length });
          res.end(zipped);
        } else {
          res.writeHead(200, { "content-type": "text/javascript" });
          res.end(text);
        }
        return;
      }

      // Large binary upload (returns byte count + sha256)
      if (url.pathname === "/api/upload" && req.method === "POST") {
        const hash = createHash("sha256");
        let total = 0;
        for await (const chunk of req) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buf.length;
          hash.update(buf);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ bytes: total, sha256: hash.digest("hex") }));
        return;
      }

      // Large binary download with Range + If-Range support
      if (url.pathname === "/api/download") {
        const range = req.headers["range"];
        const ifRange = req.headers["if-range"];
        if (range && (!ifRange || ifRange === BIG_ETAG)) {
          const m = /^bytes=(\d+)-(\d*)$/.exec(range);
          if (m) {
            const start = Number(m[1]);
            const end = m[2] ? Number(m[2]) : BIG_DOWNLOAD.length - 1;
            const slice = BIG_DOWNLOAD.subarray(start, end + 1);
            res.writeHead(206, {
              "content-type": "application/octet-stream",
              etag: BIG_ETAG,
              "content-range": `bytes ${start}-${end}/${BIG_DOWNLOAD.length}`,
            });
            res.end(slice);
            return;
          }
        }
        res.writeHead(200, { "content-type": "application/octet-stream", etag: BIG_ETAG });
        res.end(BIG_DOWNLOAD);
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "NOT_FOUND" }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function setupPair(authorized: () => boolean = () => true) {
    const host = generateStaticKeyPair();
    const client = generateStaticKeyPair();
    const init = new NoiseHandshake({
      role: "initiator",
      staticPrivateKey: client.privateKey,
      remoteStaticPublicKey: host.publicKey,
    });
    const resp = new NoiseHandshake({
      role: "responder",
      staticPrivateKey: host.privateKey,
    });
    resp.readMessage(init.writeMessage());
    init.readMessage(resp.writeMessage());
    const cChan = init.finish();
    const hChan = resp.finish();

    const [rawClient, rawHost] = createInMemoryPipe();
    const clientLink = createEncryptedFrameLink(cChan, rawClient);
    const hostLink = createEncryptedFrameLink(hChan, rawHost);

    const adapter = new MacRemoteAdapter(hChan, hostLink, {
      targetOrigin: baseUrl,
      resolveDeviceToken: () => (authorized() ? DEVICE_TOKEN : null),
    });
    const clientMux = new MuxSession({ link: clientLink });
    return { adapter, clientMux, close: () => { clientMux.close(); adapter.close(); rawClient.close(); } };
  }

  function request(
    clientMux: MuxSession,
    opts: { method: string; path: string; headers?: Record<string, string>; body?: Uint8Array; requestId?: string },
  ): Promise<{ head: ResHeadPayload; body: Buffer }> {
    return new Promise((resolve, reject) => {
      let head: ResHeadPayload | undefined;
      const chunks: Buffer[] = [];
      const stream = clientMux.openRequest(
        {
          method: opts.method,
          path: opts.path,
          headers: opts.headers ?? {},
          requestId: opts.requestId ?? "req-1",
          hasBody: Boolean(opts.body && opts.body.length > 0),
        },
        {
          onResHead(h, end) {
            head = h;
            if (end) resolve({ head: h, body: Buffer.concat(chunks) });
          },
          onResBody(chunk, end) {
            if (chunk.length > 0) chunks.push(Buffer.from(chunk));
            if (end && head) resolve({ head, body: Buffer.concat(chunks) });
          },
          onReset(rst) {
            reject(new Error(`stream_reset:${rst.code}:${rst.message ?? ""}`));
          },
        },
      );
      if (opts.body && opts.body.length > 0) {
        void stream.sendBody(opts.body, true).catch(reject);
      }
    });
  }

  it("strips spoofed auth/proxy headers, injects trusted device token, and enforces live revocation", async () => {
    let allowed = true;
    const env = setupPair(() => allowed);
    try {
      const res = await request(env.clientMux, {
        method: "GET",
        path: "/api/echo-auth",
        headers: {
          authorization: "Bearer evil",
          cookie: "pi_agent_session=spoofed",
          "x-forwarded-for": "1.2.3.4",
        },
        requestId: "req-auth-1",
      });
      expect(res.head.status).toBe(200);
      const data = JSON.parse(res.body.toString("utf8"));
      expect(data.authorization).toBe(`Bearer ${DEVICE_TOKEN}`);
      expect(data.cookie).toBeNull();
      expect(data.forwardedFor).toBeNull();
      expect(data.requestId).toBe("req-auth-1");

      // Revoke device immediately -> next request gets 401 without waiting for tunnel expiry.
      allowed = false;
      const rev = await request(env.clientMux, { method: "GET", path: "/api/echo-auth" });
      expect(rev.head.status).toBe(401);
      expect(JSON.parse(rev.body.toString("utf8")).error).toBe("DEVICE_REVOKED");
    } finally {
      env.close();
    }
  });

  it("压缩过的静态资源经隧道到手机时已是解压后的内容，不能再带 content-encoding（否则 WebView 报 ERR_CONTENT_DECODING_FAILED）", async () => {
    const env = setupPair();
    try {
      const res = await request(env.clientMux, { method: "GET", path: "/assets/app.js", headers: { "accept-encoding": "gzip, deflate, br" } });
      expect(res.head.status).toBe(200);
      expect(res.head.headers["content-encoding"]).toBeUndefined();
      expect(res.head.headers["content-length"]).toBeUndefined();
      expect(res.body.toString("utf8")).toBe("console.log('heji');\n".repeat(2000));
    } finally {
      env.close();
    }
  });

  it("streams SSE events incrementally without buffering and propagates STREAM_RST cancellation", async () => {
    const env = setupPair();
    try {
      // 1. Finite SSE stream arrives chunk by chunk
      const receivedEvents: string[] = [];
      await new Promise<void>((resolve, reject) => {
        env.clientMux.openRequest(
          {
            method: "GET",
            path: "/api/runtime/stream?count=4",
            headers: { accept: "text/event-stream" },
            requestId: "sse-1",
            hasBody: false,
          },
          {
            onResHead(h) {
              expect(h.status).toBe(200);
              expect(h.isSse).toBe(true);
            },
            onResBody(chunk, end) {
              if (chunk.length > 0) receivedEvents.push(Buffer.from(chunk).toString("utf8"));
              if (end) resolve();
            },
            onReset(rst) {
              reject(new Error(rst.code));
            },
          },
        );
      });
      const joined = receivedEvents.join("");
      expect(joined).toContain('data: {"seq":1}');
      expect(joined).toContain('data: {"seq":4}');
      expect(receivedEvents.length).toBeGreaterThanOrEqual(2);

      // 2. Open-ended SSE stream cancelled via STREAM_RST aborts upstream handler promptly.
      const beforeAbort = sseAbortedCount;
      await new Promise<void>((resolve) => {
        let gotFirst = false;
        const stream = env.clientMux.openRequest(
          {
            method: "GET",
            path: "/api/runtime/stream?count=2&hold=1",
            headers: { accept: "text/event-stream" },
            requestId: "sse-cancel",
            hasBody: false,
          },
          {
            onResHead() {},
            onResBody(chunk) {
              if (!gotFirst && chunk.length > 0) {
                gotFirst = true;
                stream.reset("client_cancelled");
                setTimeout(resolve, 60);
              }
            },
            onReset() {},
          },
        );
      });
      expect(sseAbortedCount).toBe(beforeAbort + 1);
      expect(env.adapter.activeStreams).toBe(0);
    } finally {
      env.close();
    }
  });

  it("transfers 10 MiB upload and 4 MiB Range resumable download accurately under flow control", async () => {
    const env = setupPair();
    try {
      // 10 MiB upload
      const uploadBytes = randomBytes(10 * 1024 * 1024);
      const expectedUploadSha = createHash("sha256").update(uploadBytes).digest("hex");
      const up = await request(env.clientMux, {
        method: "POST",
        path: "/api/upload",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(uploadBytes),
        requestId: "up-10m",
      });
      expect(up.head.status).toBe(200);
      expect(JSON.parse(up.body.toString("utf8"))).toEqual({
        bytes: uploadBytes.length,
        sha256: expectedUploadSha,
      });

      // Full 4 MiB download + 2-part Range resumable download
      const full = await request(env.clientMux, { method: "GET", path: "/api/download" });
      expect(full.head.status).toBe(200);
      expect(full.head.headers["etag"]).toBe(BIG_ETAG);
      expect(createHash("sha256").update(full.body).digest("hex")).toBe(
        createHash("sha256").update(BIG_DOWNLOAD).digest("hex"),
      );

      const mid = 1_500_000;
      const part1 = await request(env.clientMux, {
        method: "GET",
        path: "/api/download",
        headers: { range: `bytes=0-${mid - 1}`, "if-range": BIG_ETAG },
      });
      const part2 = await request(env.clientMux, {
        method: "GET",
        path: "/api/download",
        headers: { range: `bytes=${mid}-`, "if-range": BIG_ETAG },
      });
      expect(part1.head.status).toBe(206);
      expect(part2.head.status).toBe(206);
      const combined = Buffer.concat([part1.body, part2.body]);
      expect(createHash("sha256").update(combined).digest("hex")).toBe(
        createHash("sha256").update(BIG_DOWNLOAD).digest("hex"),
      );
      expect(env.adapter.activeStreams).toBe(0);
    } finally {
      env.close();
    }
  });
});
