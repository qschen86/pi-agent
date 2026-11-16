/**
 * 错题本 HTTP 接口（/api/wrong-book/*）。
 * 照片走二进制上传（一次一张，带 batch 参数把几张拍成一个批次）；其余都是 JSON。
 */
import type { Context, Hono } from "hono";
import { WrongBookError } from "./wrong-book-store.js";
import type { WrongBookService } from "./wrong-book-service.js";
import { preparePaperPhoto } from "./wrong-book-photo.js";

const noStore = (c: Context) => { c.header("Cache-Control", "private, no-store"); };

function fail(c: Context, error: unknown): Response {
  if (error instanceof WrongBookError) return c.json({ error: error.message, code: error.code }, error.status);
  throw error;
}

const param = (c: Context, name: string): string => c.req.param(name) ?? "";

async function json(c: Context): Promise<unknown> {
  try { return await c.req.json(); } catch { throw new WrongBookError("INPUT_INVALID", "请求内容不是合法的 JSON"); }
}

/** 看讲解：可以带 { again, feedback } 让孩子反馈后换一种讲法；不带就当普通读缓存。 */
async function explainOptions(c: Context): Promise<{ again?: boolean; feedback?: unknown }> {
  if (!(c.req.header("content-type") ?? "").includes("application/json")) return {};
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  return { again: body?.["again"] === true, feedback: body?.["feedback"] };
}

export function mountWrongBookRoutes(app: Hono, service: WrongBookService, base = "/api/wrong-book"): void {
  const route = <T>(handler: (c: Context) => T | Promise<T>) => async (c: Context) => {
    noStore(c);
    try { return c.json((await handler(c)) as never); } catch (e) { return fail(c, e); }
  };

  app.get(`${base}/state`, route(() => service.snapshot()));
  app.put(`${base}/settings`, route(async (c) => service.updateSettings(await json(c))));

  // 录入：一次上传一个批次。多张照片用 multipart；字段 source / date，文件字段 photo。
  app.post(`${base}/batches`, async (c) => {
    noStore(c);
    try {
      if (Number(c.req.header("content-length") ?? 0) > 100 * 1024 * 1024) throw new WrongBookError("PHOTO_TOO_LARGE", "上传的内容太大了", 413);
      const form = await c.req.formData().catch(() => { throw new WrongBookError("INPUT_INVALID", "上传内容不对"); });
      const raw: Buffer[] = [];
      for (const value of form.getAll("photo")) {
        if (typeof value === "string") continue;
        raw.push(Buffer.from(await (value as File).arrayBuffer()));
      }
      // 提交之后再决定要不要压：相机拍好的原样存，只有手机相册里的超大图重新编码一次
      const photos = (await Promise.all(raw.map((bytes) => preparePaperPhoto(bytes)))).map((photo) => photo.bytes);
      const batch = service.createBatch({ source: form.get("source"), date: form.get("date"), photos });
      return c.json({ batch: service.batchDetail(batch.id) }, 201);
    } catch (e) { return fail(c, e); }
  });
  app.get(`${base}/batches/:id`, route((c) => service.batchDetail(param(c, "id"))));
  app.post(`${base}/batches/:id/confirm`, route((c) => service.confirmBatch(param(c, "id"))));
  app.delete(`${base}/batches/:id`, route((c) => { service.deleteBatch(param(c, "id")); return { ok: true }; }));
  app.post(`${base}/batches/:id/photos/:photoId/retry`, route((c) => service.batchDetail(service.retryPhoto(param(c, "id"), param(c, "photoId")).id)));

  app.get(`${base}/photos/:id`, (c) => {
    const hit = service.store.photoPath(param(c, "id"));
    if (!hit) return c.json({ error: "没有这张照片" }, 404);
    // 本机文件直接读出；照片只在控制台登录态下可取
    const body = service.store.readPhoto(hit.photo.id);
    if (!body) return c.json({ error: "没有这张照片" }, 404);
    return c.body(new Uint8Array(body.bytes), 200, { "content-type": hit.photo.mime, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" });
  });

  app.get(`${base}/items`, route((c) => ({ items: service.listItems({ result: c.req.query("result"), tag: c.req.query("tag"), source: c.req.query("source") }) })));
  app.patch(`${base}/items/:id`, route(async (c) => ({ item: service.updateItem(param(c, "id"), await json(c)) })));
  app.delete(`${base}/items/:id`, route((c) => { service.discardItem(param(c, "id")); return { ok: true }; }));
  app.post(`${base}/items/:id/explain`, route(async (c) => service.explain({ itemId: param(c, "id") }, await explainOptions(c))));

  app.post(`${base}/quizzes`, route(() => ({ quiz: service.quizView(service.startQuiz("manual").id) })));
  app.get(`${base}/quizzes/:id`, route((c) => service.quizView(param(c, "id"))));
  app.post(`${base}/quizzes/:id/answer`, route(async (c) => {
    const body = ((await json(c)) ?? {}) as { questionId?: string; given?: unknown };
    return service.answerQuestion(param(c, "id"), String(body.questionId ?? ""), body.given);
  }));
  app.post(`${base}/quizzes/:id/questions/:qid/explain`, route(async (c) => service.explain({ quizId: param(c, "id"), questionId: param(c, "qid") }, await explainOptions(c))));
}
