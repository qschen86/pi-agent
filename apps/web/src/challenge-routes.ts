/**
 * 心愿挑战岛 HTTP 接口。
 *
 * 页面操作全部走 `POST /ops`（可离线排队、重试幂等），照片单独走二进制上传。
 * 同一个挂载函数既服务控制台内打开的页面（/api/challenge），也服务分享链接
 * （/share/<id>/challenge，由 share-routes 先校验分享密码与设备绑定）。
 */
import { readFileSync } from "node:fs";
import type { Context, Hono } from "hono";
import { ChallengeIconError, type ChallengeIconService } from "./challenge-icon.js";
import { ChallengePoemError, type ChallengePoemService } from "./challenge-poem.js";
import { ChallengeError, type ChallengeStore } from "./challenge-store.js";

const noStore = (c: Context) => {
  c.header("Cache-Control", "private, no-store");
};

function fail(c: Context, error: unknown): Response {
  if (error instanceof ChallengeError) return c.json({ error: error.message, code: error.code }, error.status);
  throw error;
}

export function mountChallengeRoutes(
  app: Hono,
  store: ChallengeStore,
  options: {
    base?: string;
    authorize?: (c: Context) => boolean;
    poem?: ChallengePoemService;
    icon?: ChallengeIconService;
  } = {}
): void {
  const base = options.base ?? "/api/challenge";
  if (options.authorize) {
    const authorize = options.authorize;
    app.use(`${base}/*`, async (c, next) => {
      if (!authorize(c)) return c.json({ error: "需要分享密码" }, 401);
      await next();
    });
  }

  app.get(`${base}/state`, (c) => {
    noStore(c);
    return c.json(store.snapshot());
  });

  app.post(`${base}/ops`, async (c) => {
    noStore(c);
    try {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw new ChallengeError("INPUT_INVALID", "请求内容不是合法的 JSON");
      }
      const ops = (body as { ops?: unknown } | null)?.ops;
      return c.json(store.applyOps(ops));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post(`${base}/photos`, async (c) => {
    noStore(c);
    try {
      const childId = c.req.query("child") ?? "";
      const declared = Number(c.req.header("content-length") ?? 0);
      if (declared > 8 * 1024 * 1024) throw new ChallengeError("PHOTO_TOO_LARGE", "照片太大了（最大 8MB）", 413);
      const body = await c.req.arrayBuffer();
      const photo = store.savePhoto(childId, body, c.req.query("id") || undefined);
      return c.json({ photo: { id: photo.id, childId: photo.childId, bytes: photo.bytes, at: photo.at } }, 201);
    } catch (error) {
      return fail(c, error);
    }
  });

  // 纪念卡小诗：只把心愿文字与相框主题发给模型，照片不出本机。
  app.post(`${base}/poem`, async (c) => {
    noStore(c);
    const poem = options.poem;
    if (!poem) return c.json({ error: "小诗服务还没准备好", code: "POEM_UNAVAILABLE" }, 503);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "请求内容不是合法的 JSON", code: "POEM_INPUT" }, 400);
    }
    const client = c.req.header("cf-connecting-ip") ?? "local";
    try {
      return c.json(await poem.write(body, `challenge-poem:${client}`));
    } catch (error) {
      if (error instanceof ChallengePoemError) return c.json({ error: error.message, code: error.code }, error.status);
      return c.json({ error: "小诗现在写不出来", code: "POEM_UNAVAILABLE" }, 503);
    }
  });

  // 按名字现配一个图标：只把名字与类别发给模型，照片和昵称不出本机。
  app.post(`${base}/icon`, async (c) => {
    noStore(c);
    const icon = options.icon;
    if (!icon) return c.json({ error: "配图标的服务还没准备好", code: "ICON_UNAVAILABLE" }, 503);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "请求内容不是合法的 JSON", code: "ICON_INPUT" }, 400);
    }
    const client = c.req.header("cf-connecting-ip") ?? "local";
    try {
      return c.json(await icon.pick(body, `challenge-icon:${client}`));
    } catch (error) {
      if (error instanceof ChallengeIconError) return c.json({ error: error.message, code: error.code }, error.status);
      return c.json({ error: "图标现在配不出来", code: "ICON_UNAVAILABLE" }, 503);
    }
  });

  app.get(`${base}/photos/:photoId`, (c) => {
    const found = store.photo(c.req.param("photoId"));
    if (!found) return c.json({ error: "照片不存在" }, 404);
    return c.body(new Uint8Array(readFileSync(found.path)), 200, {
      "content-type": found.photo.mime,
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff"
    });
  });
}
