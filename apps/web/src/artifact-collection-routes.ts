/**
 * 产物的「我的内容」接口：分类与条目都只在本机数据目录，不对外分享。
 *
 * 读：GET /api/artifact-collections
 * 加：POST /api/artifact-collections/items
 * 改：PATCH /api/artifact-collections/items/:id
 * 删：DELETE /api/artifact-collections/items/:id
 * 分类（一级 / 二级两层，二级带 parentId）：
 *   POST /categories {name, parentId?}、PATCH /categories/:id、DELETE /categories/:id（一级连带删二级）、
 *   POST /categories/:id/move {beforeId, parentId?}、POST /categories/:id/merge {targetId}、
 *   PUT /categories/order {order, parents}（编辑态拖动后点「保存」一次提交整份草稿）
 *
 * 来源里的 sessionId 是加入时的原会话；会话后来被删除时，条目保留，打开时由页面提示「原会话已删除」。
 * 加入时如果还能查到会话，就顺手拒绝已经不存在的会话，避免把坏引用存进来。
 */
import type { Context, Hono } from "hono";
import type { ModelImage } from "@pi-agent/model-port";
import { ArtifactCollectionError, type ArtifactCollections, type AddArtifactInput, type ArtifactSource } from "./artifact-collections.js";
import { compressImage, compressedImageHeaders, imageSizeParam } from "./image-compress.js";
import { ARTIFACT_IMAGE_LIMITS, type ArtifactTagger } from "./artifact-tagging.js";

type Options = {
  /** 生产环境由运行时管理器确认会话还在；测试替身不传就不校验。 */
  sessionExists?: (sessionId: string) => boolean;
  /** 智能打标端口；不传时 /items/auto 明确返回 503。 */
  tagging?: ArtifactTagger;
  readImage?: (source: ArtifactSource) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;
};

/** 客户端随打标请求带来的图片：已经是等比缩小后的 JPEG/PNG/WebP。 */
type AutoImage = { mediaType?: unknown; data?: unknown };
type AutoAddInput = AddArtifactInput & { excerpt?: unknown; image?: AutoImage };

function modelImage(raw: unknown): ModelImage | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const input = raw as AutoImage;
  const mediaType = input.mediaType;
  if (mediaType !== "image/png" && mediaType !== "image/jpeg" && mediaType !== "image/webp") throw new ArtifactCollectionError("图片格式只支持 PNG / JPEG / WebP", 400, "ARTIFACT_TAG_IMAGE");
  if (typeof input.data !== "string" || !input.data) throw new ArtifactCollectionError("图片内容缺失", 400, "ARTIFACT_TAG_IMAGE");
  const max = Math.ceil(ARTIFACT_IMAGE_LIMITS.maxBytes * 4 / 3) + 4;
  if (input.data.length > max) throw new ArtifactCollectionError("图片太大，无法打标", 413, "ARTIFACT_TAG_IMAGE");
  const bytes = Buffer.from(input.data, "base64");
  if (!bytes.length || bytes.length > ARTIFACT_IMAGE_LIMITS.maxBytes) throw new ArtifactCollectionError("图片太大，无法打标", 413, "ARTIFACT_TAG_IMAGE");
  return { mediaType, bytes: new Uint8Array(bytes) };
}

const error = (c: Context, e: unknown) => {
  if (e instanceof ArtifactCollectionError) return c.json({ error: e.message, code: e.code }, e.status as 400);
  throw e;
};

export function mountArtifactCollectionRoutes(app: Hono, store: ArtifactCollections, options: Options = {}): void {
  const sessionGone = (body: AddArtifactInput): string | undefined => {
    if (!options.sessionExists) return undefined;
    const source = body.source;
    if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
    const sessionId = (source as { sessionId?: unknown }).sessionId;
    if (typeof sessionId !== "string" || !sessionId) return undefined;
    return options.sessionExists(sessionId) ? undefined : sessionId;
  };

  app.get("/api/artifact-collections", (c) => {
    c.header("Cache-Control", "private, no-store");
    return c.json(store.list());
  });

  app.get("/api/artifact-collections/items/:id/image", async (c) => {
    try {
      const id = c.req.param("id");
      const item = store.list().items.find((item) => item.id === id && item.kind === "image");
      if (!item) throw new ArtifactCollectionError("图片产物不存在", 404);
      let image = store.image(id);
      if (!image && options.readImage) {
        try { image = await options.readImage(item.source); } catch { /* 旧会话目录可能已清理 */ }
        if (image) store.saveImage(id, image);
      }
      if (!image) throw new ArtifactCollectionError("原图片文件已失效，且尚无保存副本。请从原会话重新加入图片。", 404, "ARTIFACT_IMAGE_GONE");
      const size = imageSizeParam(c.req.query("size"));
      const result = size ? await compressImage(`artifact|${id}`, image.mimeType, size, () => Buffer.from(image!.bytes)) : image;
      return c.body(new Uint8Array(result.bytes), 200, {
        "Content-Type": result.mimeType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox", ...("compressed" in result ? compressedImageHeaders(result) : {}),
      });
    } catch (e) { return error(c, e); }
  });

  app.post("/api/artifact-collections/items", async (c) => {
    try {
      const body = await c.req.json<AddArtifactInput>().catch(() => ({} as AddArtifactInput));
      const gone = sessionGone(body);
      if (gone) throw new ArtifactCollectionError("原会话已删除，无法加入产物", 404, "ARTIFACT_SESSION_GONE");
      const described = store.describe(body);
      const image = described.kind === "image" && options.readImage ? await options.readImage(described.source) : null;
      const result = store.add(body);
      if (image) store.saveImage(result.item.id, image);
      return c.json({ ...result.state, item: result.item, created: result.created });
    } catch (e) { return error(c, e); }
  });

  app.post("/api/artifact-collections/items/auto", async (c) => {
    try {
      const body = await c.req.json<AutoAddInput>().catch(() => ({} as AutoAddInput));
      const gone = sessionGone(body);
      if (gone) throw new ArtifactCollectionError("原会话已删除，无法加入产物", 404, "ARTIFACT_SESSION_GONE");
      if (!options.tagging?.enabled) throw new ArtifactCollectionError("智能打标暂时不可用，请稍后再试", 503, "ARTIFACT_TAG_UNAVAILABLE");
      const described = store.describe(body);
      const originalImage = described.kind === "image" && options.readImage ? await options.readImage(described.source) : null;
      const context = store.tagContext(described.kind);
      const classification = await options.tagging.classify({
        title: described.title,
        kind: described.kind,
        sessionTitle: described.source.sessionTitle,
        excerpt: typeof body.excerpt === "string" ? body.excerpt : undefined,
        image: described.kind === "image" ? modelImage(body.image) : undefined,
        ...context,
      });
      const result = store.addTagged({ ...body, title: classification.title }, classification.tags);
      if (originalImage) store.saveImage(result.item.id, originalImage);
      return c.json({ ...result.state, item: result.item, created: result.created, tags: result.tags });
    } catch (e) { return error(c, e); }
  });

  app.patch("/api/artifact-collections/items/:id", async (c) => {
    try {
      const body = await c.req.json<{ title?: unknown; categoryIds?: unknown }>().catch(() => ({}));
      const result = store.update(c.req.param("id"), body);
      return c.json({ ...result.state, item: result.item });
    } catch (e) { return error(c, e); }
  });

  app.delete("/api/artifact-collections/items/:id", (c) => {
    try { return c.json(store.remove(c.req.param("id"))); }
    catch (e) { return error(c, e); }
  });

  app.post("/api/artifact-collections/categories", async (c) => {
    try {
      const body = await c.req.json<{ name?: unknown; parentId?: unknown }>().catch(() => ({} as { name?: unknown; parentId?: unknown }));
      return c.json(store.createCategory(body.name, body.parentId));
    } catch (e) { return error(c, e); }
  });

  app.patch("/api/artifact-collections/categories/:id", async (c) => {
    try {
      const body = await c.req.json<{ name?: unknown }>().catch(() => ({} as { name?: unknown }));
      return c.json(store.renameCategory(c.req.param("id"), body.name));
    } catch (e) { return error(c, e); }
  });

  app.delete("/api/artifact-collections/categories/:id", (c) => {
    try { return c.json(store.deleteCategory(c.req.param("id"))); }
    catch (e) { return error(c, e); }
  });

  app.post("/api/artifact-collections/categories/:id/move", async (c) => {
    try {
      const body = await c.req.json<{ beforeId?: unknown; parentId?: unknown }>().catch(() => ({} as { beforeId?: unknown; parentId?: unknown }));
      return c.json(store.moveCategory(c.req.param("id"), body.beforeId ?? null, body.parentId));
    } catch (e) { return error(c, e); }
  });

  app.post("/api/artifact-collections/categories/:id/merge", async (c) => {
    try {
      const body = await c.req.json<{ targetId?: unknown }>().catch(() => ({} as { targetId?: unknown }));
      return c.json(store.mergeCategory(c.req.param("id"), body.targetId));
    } catch (e) { return error(c, e); }
  });

  app.put("/api/artifact-collections/categories/order", async (c) => {
    try {
      const body = await c.req.json<{ order?: unknown; parents?: unknown }>().catch(() => ({} as { order?: unknown; parents?: unknown }));
      return c.json(store.reorderCategories(body.order, body.parents));
    } catch (e) { return error(c, e); }
  });
}
