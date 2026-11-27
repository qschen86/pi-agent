import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { PairingQrError } from "../../../packages/remote-link/src/index.js";
import type { RemoteConnectService } from "./remote-connect-service.js";

/**
 * Mounts Mac-side Remote Connect management APIs under /api/remote-connect/*.
 * Management mutations are restricted to browser/local owner sessions (never remote device Bearer tokens).
 */
export function mountRemoteConnectRoutes(app: Hono, service: RemoteConnectService): void {
  app.use("/api/remote-connect/*", bodyLimit({ maxSize: 16 * 1024 }));

  const ensureOwnerSession = (c: Context): Response | null => {
    const source = c.get("authSource" as never) as string | undefined;
    if (source === "bearer" || c.req.header("authorization") !== undefined) {
      return c.json({ error: "请在电脑端或浏览器中管理远程连接设备", code: "BROWSER_OWNER_REQUIRED" }, 403);
    }
    return null;
  };

  const run = async (c: Context, fn: () => Response | Promise<Response>) => {
    c.header("Cache-Control", "private, no-store");
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PairingQrError) {
        return c.json({ error: err.message, code: err.code }, 400);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message, code: "REMOTE_CONNECT_ERROR" }, 400);
    }
  };

  app.get("/api/remote-connect/status", (c) =>
    run(c, () => c.json(service.status())),
  );

  app.post("/api/remote-connect/config", (c) =>
    run(c, async () => {
      const denied = ensureOwnerSession(c);
      if (denied) return denied;
      const body = (await c.req.json()) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return c.json({ error: "配置格式无效", code: "INVALID_CONFIG" }, 400);
      }
      const next = service.updateConfig({
        ...(typeof body["enabled"] === "boolean" ? { enabled: body["enabled"] } : {}),
        ...(body["relayMode"] === "official" || body["relayMode"] === "custom"
          ? { relayMode: body["relayMode"] }
          : {}),
        ...(typeof body["customRelayUrl"] === "string" ? { customRelayUrl: body["customRelayUrl"] } : {}),
        ...(typeof body["hostName"] === "string" ? { hostName: body["hostName"] } : {}),
      });
      return c.json(next);
    }),
  );

  // 新增设备时选定线路：routeId 缺省或 "public" 为公共中继，其余为已保存的自建中继线路。
  app.post("/api/remote-connect/pairings", (c) =>
    run(c, async () => {
      const denied = ensureOwnerSession(c);
      if (denied) return denied;
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const routeId = typeof body?.["routeId"] === "string" ? (body["routeId"] as string) : undefined;
      const pairing = service.startPairing(routeId ? service.relayUrlForRoute(routeId) : undefined);
      return c.json(pairing, 201);
    }),
  );

  // 自有域名线路：返回供手机扫码的二维码，手机提交后沿用 /api/auth/device-pairs 的批准流程。
  app.post("/api/remote-connect/domain-qr", (c) =>
    run(c, async () => {
      const denied = ensureOwnerSession(c);
      if (denied) return denied;
      const body = (await c.req.json()) as Record<string, unknown>;
      const origin = typeof body?.["routeId"] === "string" ? service.domainUrlForRoute(body["routeId"] as string) : String(body?.["url"] ?? "");
      return c.json(service.startDomainQr(origin), 201);
    }),
  );

  app.post("/api/remote-connect/routes", (c) =>
    run(c, async () => {
      const denied = ensureOwnerSession(c);
      if (denied) return denied;
      const body = (await c.req.json()) as Record<string, unknown>;
      const type = body?.["type"];
      if ((type !== "custom_relay" && type !== "domain") || typeof body["url"] !== "string") {
        return c.json({ error: "线路类型或地址无效", code: "INVALID_ROUTE" }, 400);
      }
      const route = service.addRoute({ type, url: body["url"], ...(typeof body["name"] === "string" ? { name: body["name"] } : {}) });
      return c.json({ route, status: service.status() }, 201);
    }),
  );

  app.delete("/api/remote-connect/routes/:id", (c) =>
    run(c, () => {
      const denied = ensureOwnerSession(c);
      if (denied) return denied;
      if (!service.removeRoute(c.req.param("id"))) return c.json({ error: "线路不存在", code: "ROUTE_NOT_FOUND" }, 404);
      return c.json({ ok: true, status: service.status() });
    }),
  );

  app.post("/api/remote-connect/pairings/:id/approve", (c) =>
    run(c, () => {
      const denied = ensureOwnerSession(c);
      if (denied) return denied;
      const device = service.approvePairing(c.req.param("id"));
      return c.json({ ok: true, device, status: service.status() });
    }),
  );

  app.post("/api/remote-connect/pairings/:id/reject", (c) =>
    run(c, () => {
      const denied = ensureOwnerSession(c);
      if (denied) return denied;
      service.rejectPairing(c.req.param("id"));
      return c.json({ ok: true, status: service.status() });
    }),
  );

  app.delete("/api/remote-connect/devices/:id", (c) =>
    run(c, () => {
      const denied = ensureOwnerSession(c);
      if (denied) return denied;
      const revoked = service.revokeDevice(c.req.param("id"));
      if (!revoked) return c.json({ error: "设备不存在或已撤销", code: "DEVICE_NOT_FOUND" }, 404);
      return c.json({ ok: true, status: service.status() });
    }),
  );

  // 历史重复记录清理：旧版本每次配对都新建一条，这里按手机归并后只留最近活跃的一条。
  app.post("/api/remote-connect/devices/cleanup", (c) =>
    run(c, () => {
      const denied = ensureOwnerSession(c);
      if (denied) return denied;
      const result = service.cleanupDuplicateDevices(true);
      return c.json({ ok: true, ...result, status: service.status() });
    }),
  );
}
