/**
 * 产物里的「我的」内容：把会话里看到的图片、视频、Markdown / HTML 文档打成标签收进来。
 *
 * 分类就是标签：一个条目可以同时属于多个分类；分类分一级 / 二级两层（二级带 parentId，
 * 没有 parentId 的就是一级，旧数据不用迁移），可以新建、改名、删除、合并、拖动排序，
 * 和待办页的分类一样由人自己整理。条目保留原会话来源；会话文件图片独立保存副本，
 * 避免工作目录清理后失效，其他附件和文件仍沿用原来的受权限保护的读取接口。
 *
 * 写入走「临时文件 → rename」，读者要么看到旧版本、要么看到完整的新版本；
 * 文件权限 0600，和待办、股票账本等数据文件一致。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ArtifactItemKind = "image" | "video" | "document";

export type ArtifactSource =
  | {
      type: "attachment";
      sessionId: string;
      attachmentId: string;
      name?: string;
      sessionTitle?: string;
      eventKey?: string;
      eventSeq?: number;
    }
  | {
      type: "generated";
      sessionId: string;
      seq: number;
      name?: string;
      sessionTitle?: string;
      eventKey?: string;
      eventSeq?: number;
    }
  | {
      type: "file";
      sessionId: string;
      path: string;
      hints?: string[];
      name?: string;
      sessionTitle?: string;
      eventKey?: string;
      eventSeq?: number;
    };

/** 没有 parentId 就是一级分类；二级分类的 parentId 指向某个一级分类，不再往下分。 */
export type ArtifactCollectionCategory = { id: string; name: string; createdAt: string; parentId?: string; catalogRefs?: string[]; catalogGroups?: string[] };
export type ArtifactCollectionItem = {
  id: string;
  title: string;
  kind: ArtifactItemKind;
  categoryIds: string[];
  source: ArtifactSource;
  createdAt: string;
  updatedAt: string;
};

export type ArtifactCollectionsState = {
  schema: 1;
  categories: ArtifactCollectionCategory[];
  items: ArtifactCollectionItem[];
  catalogRefsSeen?: string[];
};

export type AddArtifactInput = {
  title?: unknown;
  categoryIds?: unknown;
  categoryNames?: unknown;
  source?: unknown;
};

const LIMITS = {
  categories: 200,
  items: 1200,
  title: 120,
  categoryName: 30,
  sessionId: 200,
  path: 4096,
  hints: 8,
  hint: 1024,
  name: 200,
  eventKey: 240,
  attachmentId: 120,
} as const;

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "m4v"]);
const DOC_EXT = new Set(["md", "markdown", "mdx", "html", "htm"]);
const CONTROL = /[\u0000-\u001f\u007f]/;

export class ArtifactCollectionError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "ARTIFACT_COLLECTION") {
    super(message);
    this.name = "ArtifactCollectionError";
  }
}

const fail = (message: string, status = 400, code = "ARTIFACT_COLLECTION"): never => {
  throw new ArtifactCollectionError(message, status, code);
};

const text = (value: unknown, field: string, max: number, required = true): string => {
  if (typeof value !== "string") {
    if (!required && (value === undefined || value === null)) return "";
    fail(`${field}必须是文字`);
  }
  const s = (value as string).trim().normalize("NFC");
  if (required && !s) fail(`${field}不能为空`);
  if (s.length > max) fail(`${field}最多 ${max} 个字`);
  if (CONTROL.test(s)) fail(`${field}不能包含换行或控制字符`);
  return s;
};

const optionalText = (value: unknown, field: string, max: number): string | undefined => {
  if (value === undefined || value === null) return undefined;
  return text(value, field, max, false) || undefined;
};

const sequence = (value: unknown, field: string, required: boolean): number | undefined => {
  if (value === undefined || value === null) {
    if (required) fail(`${field}缺失`);
    return undefined;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > Number.MAX_SAFE_INTEGER) fail(`${field}必须是正整数`);
  return n;
};

const extOf = (path: string): string => {
  const name = path.split("/").pop() || "";
  const at = name.lastIndexOf(".");
  return at < 0 ? "" : name.slice(at + 1).toLowerCase();
};

export function artifactKindOfPath(path: string): ArtifactItemKind | null {
  const ext = extOf(path);
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (DOC_EXT.has(ext)) return "document";
  return null;
}

const stableSourceKey = (source: ArtifactSource): string => {
  const base = {
    type: source.type,
    sessionId: source.sessionId,
    ...(source.type === "attachment" ? { attachmentId: source.attachmentId } : {}),
    ...(source.type === "generated" ? { seq: source.seq } : {}),
    ...(source.type === "file" ? { path: source.path } : {}),
  };
  return JSON.stringify(base);
};

function normalizeSource(value: unknown): { source: ArtifactSource; kind: ArtifactItemKind } {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("缺少来源信息");
  const raw = value as Record<string, unknown>;
  const type = raw["type"];
  if (type !== "attachment" && type !== "generated" && type !== "file") fail("不支持的来源类型");
  const sessionId = text(raw["sessionId"], "会话", LIMITS.sessionId);
  const sessionTitle = optionalText(raw["sessionTitle"], "会话标题", LIMITS.name);
  const name = optionalText(raw["name"], "文件名", LIMITS.name);
  const eventKey = optionalText(raw["eventKey"], "消息", LIMITS.eventKey);
  const eventSeq = sequence(raw["eventSeq"], "消息位置", false);
  const shared = { sessionId, ...(sessionTitle ? { sessionTitle } : {}), ...(name ? { name } : {}), ...(eventKey ? { eventKey } : {}), ...(eventSeq !== undefined ? { eventSeq } : {}) };
  if (type === "attachment") {
    const attachmentId = text(raw["attachmentId"], "附件", LIMITS.attachmentId);
    if (!/^[A-Za-z0-9_-]+$/.test(attachmentId)) fail("附件编号无效");
    return { kind: "image", source: { type: "attachment", ...shared, attachmentId } };
  }
  if (type === "generated") {
    const seq = sequence(raw["seq"], "图片位置", true)!;
    return { kind: "image", source: { type: "generated", ...shared, seq } };
  }
  const path = text(raw["path"], "文件路径", LIMITS.path);
  const kind = artifactKindOfPath(path);
  if (!kind) return fail("本期只支持 md / html 文档和图片、视频");
  let hints: string[] | undefined;
  const rawHints = raw["hints"];
  if (rawHints !== undefined) {
    if (!Array.isArray(rawHints) || rawHints.length > LIMITS.hints) return fail(`目录提示最多 ${LIMITS.hints} 条`);
    hints = rawHints.map((hint: unknown, i: number) => text(hint, `目录提示 ${i + 1}`, LIMITS.hint)).filter((hint): hint is string => !!hint);
    if (!hints?.length) hints = undefined;
  }
  return { kind, source: { type: "file", ...shared, path, ...(hints ? { hints } : {}) } };
}

/** 一条产物最多几个标签（和待办一致）。 */
export const ARTIFACT_MAX_TAGS = 4;
export const artifactDefaultCategoryName = (kind: ArtifactItemKind): string => kind === "document" ? "文档" : kind === "video" ? "视频" : "图片";
const defaultCategoryName = artifactDefaultCategoryName;

/** 智能打标的一条路径：一级沿用现有分类或该类型的默认一级，二级可复用或新建。 */
export type ArtifactTagPath = { primary: string; secondary: string };

const sameName = (a: string, b: string): boolean => a.normalize("NFC").toLocaleLowerCase() === b.normalize("NFC").toLocaleLowerCase();

export class ArtifactCollections {
  private data: ArtifactCollectionsState = { schema: 1, categories: [], items: [] };

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ArtifactCollectionsState>;
      if (!parsed || parsed.schema !== 1 || !Array.isArray(parsed.categories) || !Array.isArray(parsed.items)) throw new Error("产物分类数据损坏");
      this.data = { schema: 1, categories: parsed.categories, items: parsed.items, ...(parsed.catalogRefsSeen ? { catalogRefsSeen: parsed.catalogRefsSeen } : {}) };
      this.normalizeTree();
    }
  }

  /** 读盘后兜底：parentId 指向不存在的分类、或指向另一个二级时，当一级看待，不让坏引用把分类藏起来。 */
  private normalizeTree(): void {
    const primaries = new Set(this.data.categories.filter((c) => !c.parentId).map((c) => c.id));
    for (const category of this.data.categories) {
      if (category.parentId && !primaries.has(category.parentId)) delete category.parentId;
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  list(): ArtifactCollectionsState {
    return structuredClone(this.data);
  }

  /** 系统产物也进入同一棵可编辑目录；记录已导入引用，删掉后不自动长回来。 */
  syncCatalog(groups: { name: string; entries: { ref: string; name: string }[] }[]): void {
    const seen = new Set(this.data.catalogRefsSeen || []);
    let changed = !this.data.catalogRefsSeen;
    for (const group of groups) {
      const fresh = group.entries.filter((entry) => !seen.has(entry.ref));
      if (!fresh.length) continue;
      const parent = this.data.categories.find((c) => !c.parentId && c.catalogGroups?.includes(group.name)) || this.primaryByName(group.name) || this.insertCategory(group.name, undefined);
      parent.catalogGroups = [...new Set([...(parent.catalogGroups || []), group.name])];
      for (const entry of fresh) {
        const child = this.siblingClash(entry.name, parent.id) || this.insertCategory(entry.name, parent.id);
        child.catalogRefs = [...new Set([...(child.catalogRefs || []), entry.ref])];
        seen.add(entry.ref);
      }
      changed = true;
    }
    if (changed) { this.data.catalogRefsSeen = [...seen]; this.save(); }
  }

  /** 收藏图片独立保存；原会话工作目录清理后仍可读取。只由已校验的来源读取器写入。 */
  saveImage(id: string, image: { bytes: Uint8Array; mimeType: string }): void {
    if (!this.data.items.some((item) => item.id === id && item.kind === "image")) fail("图片产物不存在", 404);
    if (!/^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(image.mimeType) || !image.bytes.length || image.bytes.length > 25 * 1024 * 1024) fail("图片内容无效");
    const folder = join(dirname(this.file), "artifact-images");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const path = join(folder, id + ".json");
    writeFileSync(path + ".tmp", JSON.stringify({ mimeType: image.mimeType, data: Buffer.from(image.bytes).toString("base64") }), { mode: 0o600 });
    renameSync(path + ".tmp", path);
  }

  image(id: string): { bytes: Uint8Array; mimeType: string } | null {
    if (!this.data.items.some((item) => item.id === id && item.kind === "image")) fail("图片产物不存在", 404);
    const path = join(dirname(this.file), "artifact-images", id + ".json");
    if (!existsSync(path)) return null;
    const image = JSON.parse(readFileSync(path, "utf8")) as { mimeType: string; data: string };
    return { mimeType: image.mimeType, bytes: new Uint8Array(Buffer.from(image.data, "base64")) };
  }

  private categoryById(id: string): ArtifactCollectionCategory | undefined {
    return this.data.categories.find((c) => c.id === id);
  }

  private primaryByName(name: string): ArtifactCollectionCategory | undefined {
    return this.data.categories.find((c) => !c.parentId && sameName(c.name, name));
  }

  private childrenOf(id: string): ArtifactCollectionCategory[] {
    return this.data.categories.filter((c) => c.parentId === id);
  }

  private siblingClash(name: string, parentId: string | undefined, exceptId?: string): ArtifactCollectionCategory | undefined {
    return this.data.categories.find((c) => c.id !== exceptId && (c.parentId || undefined) === parentId && sameName(c.name, name));
  }

  private requireCategory(id: string): ArtifactCollectionCategory {
    return this.categoryById(id) ?? fail("分类不存在", 404, "ARTIFACT_CATEGORY_MISSING");
  }

  private touchItems(match: (item: ArtifactCollectionItem) => boolean, change: (ids: string[]) => string[]): void {
    const now = new Date().toISOString();
    for (const item of this.data.items) {
      if (!match(item)) continue;
      item.categoryIds = [...new Set(change(item.categoryIds))];
      item.updatedAt = now;
    }
  }

  private ensureCategoryByName(name: string): ArtifactCollectionCategory {
    const existing = this.primaryByName(name);
    if (existing) return existing;
    return this.insertCategory(name, undefined);
  }

  private insertCategory(name: string, parentId: string | undefined): ArtifactCollectionCategory {
    if (this.data.categories.length >= LIMITS.categories) fail(`分类最多 ${LIMITS.categories} 个`, 409, "ARTIFACT_CATEGORY_LIMIT");
    const now = new Date().toISOString();
    const created: ArtifactCollectionCategory = { id: randomUUID(), name: text(name, "分类名称", LIMITS.categoryName), createdAt: now, ...(parentId ? { parentId } : {}) };
    this.data.categories.push(created);
    return created;
  }

  /** 新建一级分类；带 parentId 就新建在那个一级下面。同级重名直接拒绝。 */
  createCategory(name: unknown, parentId?: unknown): ArtifactCollectionsState {
    const clean = text(name, "分类名称", LIMITS.categoryName);
    if (parentId === undefined || parentId === null || parentId === "") {
      if (this.siblingClash(clean, undefined)) fail(`已经有「${clean}」了`, 409, "ARTIFACT_CATEGORY_EXISTS");
      this.insertCategory(clean, undefined);
    } else {
      if (typeof parentId !== "string") fail("所属一级分类无效");
      const parent = this.requireCategory(parentId as string);
      if (parent.parentId) fail("二级分类下面不能再建分类", 400, "ARTIFACT_CATEGORY_DEPTH");
      if (this.siblingClash(clean, parent.id)) fail(`「${parent.name}」下已经有「${clean}」了`, 409, "ARTIFACT_CATEGORY_EXISTS");
      this.insertCategory(clean, parent.id);
    }
    this.save();
    return this.list();
  }

  renameCategory(id: string, name: unknown): ArtifactCollectionsState {
    const category = this.requireCategory(id);
    const next = text(name, "分类名称", LIMITS.categoryName);
    if (this.siblingClash(next, category.parentId, id)) fail("同级已经有同名分类了", 409, "ARTIFACT_CATEGORY_EXISTS");
    category.name = next;
    this.save();
    return this.list();
  }

  /** 删除一级会连带删除它下面的二级；条目只是去掉这些标签，不删条目。 */
  deleteCategory(id: string): ArtifactCollectionsState {
    this.requireCategory(id);
    const removed = new Set([id, ...this.childrenOf(id).map((c) => c.id)]);
    this.data.categories = this.data.categories.filter((c) => !removed.has(c.id));
    this.touchItems((item) => item.categoryIds.some((cid) => removed.has(cid)), (ids) => ids.filter((cid) => !removed.has(cid)));
    this.save();
    return this.list();
  }

  /** 把分类挪到 beforeId 之前；beforeId 为 null 时放到所在层级末尾。二级可以带 parentId 换到另一个一级下。 */
  moveCategory(id: string, beforeId: unknown, parentId?: unknown): ArtifactCollectionsState {
    const category = this.requireCategory(id);
    if (parentId !== undefined && parentId !== null && parentId !== "") {
      if (typeof parentId !== "string") fail("所属一级分类无效");
      const parent = this.requireCategory(parentId as string);
      if (parent.parentId) fail("二级分类下面不能再建分类", 400, "ARTIFACT_CATEGORY_DEPTH");
      if (!category.parentId) fail("一级分类不能放进别的分类", 400, "ARTIFACT_CATEGORY_DEPTH");
      if (parent.id !== category.parentId && this.siblingClash(category.name, parent.id, id)) fail(`「${parent.name}」下已经有「${category.name}」了`, 409, "ARTIFACT_CATEGORY_EXISTS");
      category.parentId = parent.id;
    }
    if (beforeId === id) { this.save(); return this.list(); }
    if (beforeId !== null && beforeId !== undefined) {
      if (typeof beforeId !== "string") fail("目标分类无效");
      const before = this.requireCategory(beforeId as string);
      if ((before.parentId || undefined) !== (category.parentId || undefined)) fail("只能排到同一层级的分类前面", 400, "ARTIFACT_CATEGORY_DEPTH");
    }
    const rest = this.data.categories.filter((c) => c.id !== category.id);
    const at = typeof beforeId === "string" ? rest.findIndex((c) => c.id === beforeId) : rest.length;
    rest.splice(at < 0 ? rest.length : at, 0, category);
    this.data.categories = rest;
    this.save();
    return this.list();
  }

  /**
   * 编辑态拖动完点「保存」：一次提交整份草稿。order 是期望的全局顺序，parents 是二级的期望父级。
   * 没出现在 order 里的分类（比如另一台设备刚建的）保持原相对位置排在最后；先全部校验、再一次写入，要么全成要么不动。
   */
  reorderCategories(order: unknown, parents: unknown): ArtifactCollectionsState {
    if (!Array.isArray(order) || order.some((id) => typeof id !== "string")) fail("排序数据无效");
    const wanted = (parents && typeof parents === "object" && !Array.isArray(parents) ? parents : {}) as Record<string, unknown>;
    const next = this.data.categories.map((c) => ({ ...c }));
    const byId = new Map(next.map((c) => [c.id, c]));
    for (const [id, parentId] of Object.entries(wanted)) {
      const category = byId.get(id);
      if (!category) continue;
      if (typeof parentId !== "string") fail("所属一级分类无效");
      const parent = byId.get(parentId as string);
      if (!parent) fail("所属一级分类不存在", 404, "ARTIFACT_CATEGORY_MISSING");
      if (!category.parentId) fail("一级分类不能放进别的分类", 400, "ARTIFACT_CATEGORY_DEPTH");
      if (parent!.parentId) fail("二级分类下面不能再建分类", 400, "ARTIFACT_CATEGORY_DEPTH");
      category.parentId = parent!.id;
    }
    const seen = new Set<string>();
    const rank = new Map<string, number>();
    for (const id of order as string[]) { if (byId.has(id) && !seen.has(id)) { seen.add(id); rank.set(id, rank.size); } }
    const sorted = next
      .map((c, i) => ({ c, key: rank.has(c.id) ? rank.get(c.id)! : 1e9 + i }))
      .sort((a, b) => a.key - b.key)
      .map((entry) => entry.c);
    const clash = new Set<string>();
    for (const c of sorted) {
      const key = `${c.parentId || ""}\u0000${c.name.normalize("NFC").toLocaleLowerCase()}`;
      if (clash.has(key)) fail(`同一层级已经有「${c.name}」了`, 409, "ARTIFACT_CATEGORY_EXISTS");
      clash.add(key);
    }
    this.data.categories = sorted;
    this.save();
    return this.list();
  }

  /**
   * 把 sourceId 合并进 targetId（只能同一层级）：打着 source 的条目改打 target；合并一级时，
   * 它的二级一起并到 target 下，同名的二级再合到 target 已有的那个里。
   */
  mergeCategory(sourceId: string, targetId: unknown): ArtifactCollectionsState {
    const source = this.requireCategory(sourceId);
    if (typeof targetId !== "string" || !targetId) fail("请选择要保留的分类");
    const target = this.requireCategory(targetId as string);
    if (source.id === target.id) fail("不能把分类合并到它自己", 400, "ARTIFACT_CATEGORY_MERGE");
    if (!!source.parentId !== !!target.parentId) fail("只能合并同一层级的分类", 400, "ARTIFACT_CATEGORY_MERGE");
    const retag = new Map<string, string>([[source.id, target.id]]);
    if (!source.parentId) {
      for (const child of this.childrenOf(source.id)) {
        const same = this.siblingClash(child.name, target.id);
        if (same) retag.set(child.id, same.id);
        else child.parentId = target.id;
      }
    }
    for (const [from, to] of retag) {
      const old = this.requireCategory(from), next = this.requireCategory(to);
      if (old.catalogRefs?.length) next.catalogRefs = [...new Set([...(next.catalogRefs || []), ...old.catalogRefs])];
      if (old.catalogGroups?.length) next.catalogGroups = [...new Set([...(next.catalogGroups || []), ...old.catalogGroups])];
    }
    this.data.categories = this.data.categories.filter((c) => !retag.has(c.id));
    this.touchItems((item) => item.categoryIds.some((cid) => retag.has(cid)), (ids) => ids.map((cid) => retag.get(cid) ?? cid));
    this.save();
    return this.list();
  }

  /** 给智能打标看的归一化输入：来源、类型、标题都与真正入库时同一套口径。 */
  describe(input: AddArtifactInput): { source: ArtifactSource; kind: ArtifactItemKind; title: string } {
    const { source, kind } = normalizeSource(input.source);
    return { source, kind, title: this.titleFor(input, source, kind) };
  }

  /** 可用的一级分类 = 现有的 + 该类型的默认一级；智能打标不允许新建一级。 */
  tagContext(kind: ArtifactItemKind): { categories: { name: string; secondaries: string[] }[]; allowedPrimary: string[]; defaultPrimary: string } {
    const categories = this.data.categories.filter((c) => !c.parentId).map((primary) => ({
      name: primary.name,
      secondaries: this.childrenOf(primary.id).map((child) => child.name),
    }));
    const fallback = defaultCategoryName(kind);
    return { categories, allowedPrimary: [...new Set([...categories.map((c) => c.name), fallback])], defaultPrimary: fallback };
  }

  private titleFor(input: AddArtifactInput, source: ArtifactSource, kind: ArtifactItemKind): string {
    return text(input.title, "标题", LIMITS.title, false) || source.name || (source.type === "file" ? source.path.split("/").pop() : "") || defaultCategoryName(kind);
  }

  /** 把一条智能打标路径落成分类：一级只复用（或默认一级），二级同名复用、没有就新建。 */
  private resolveTagPath(tag: ArtifactTagPath, kind: ArtifactItemKind): ArtifactCollectionCategory {
    const fallback = defaultCategoryName(kind);
    const primaryName = text(tag.primary, "一级分类", LIMITS.categoryName);
    if (!this.primaryByName(primaryName) && !sameName(primaryName, fallback)) fail("智能打标只能沿用现有分类或按类型建立一级分类", 400, "ARTIFACT_TAG_PRIMARY");
    const primary = this.primaryByName(primaryName) ?? this.insertCategory(primaryName, undefined);
    const secondaryName = text(tag.secondary, "二级分类", LIMITS.categoryName);
    return this.siblingClash(secondaryName, primary.id) ?? this.insertCategory(secondaryName, primary.id);
  }

  /**
   * 一次点击的智能打标：先用模型给出 1–4 条路径，再按「复用优先、在同级下新建二级」落库。
   * 没有拿到任何有效路径时退回该类型的默认一级，不让条目落在未分类里。
   */
  addTagged(input: AddArtifactInput, tags: ArtifactTagPath[]): { state: ArtifactCollectionsState; item: ArtifactCollectionItem; created: boolean; tags: { id: string; primary: string; secondary: string }[] } {
    const { source, kind } = normalizeSource(input.source);
    const title = this.titleFor(input, source, kind);
    const seen = new Set<string>();
    const picked: ArtifactCollectionCategory[] = [];
    for (const tag of tags.slice(0, 4)) {
      if (!tag || typeof tag !== "object") continue;
      const key = `${tag.primary}\u0000${tag.secondary}`.normalize("NFC").toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(this.resolveTagPath(tag, kind));
    }
    const ids = [...new Set(picked.map((c) => c.id))];
    if (!ids.length) ids.push(this.ensureCategoryByName(defaultCategoryName(kind)).id);
    if (ids.length > ARTIFACT_MAX_TAGS) fail(`一条产物最多 ${ARTIFACT_MAX_TAGS} 个标签`, 400, "ARTIFACT_TAG_LIMIT");
    const result = this.upsert(source, kind, title, ids);
    return {
      ...result,
      tags: result.item.categoryIds.map((id) => {
        const category = this.categoryById(id);
        const parent = category?.parentId ? this.categoryById(category.parentId) : undefined;
        return { id, primary: parent?.name ?? category?.name ?? "", secondary: parent ? category!.name : "" };
      }).filter((tag) => !!tag.primary),
    };
  }

  private upsert(source: ArtifactSource, kind: ArtifactItemKind, title: string, ids: string[]): { state: ArtifactCollectionsState; item: ArtifactCollectionItem; created: boolean } {
    const existing = this.data.items.find((item) => stableSourceKey(item.source) === stableSourceKey(source));
    if (existing) {
      existing.title = title;
      existing.kind = kind;
      existing.categoryIds = [...new Set([...existing.categoryIds, ...ids])].slice(0, ARTIFACT_MAX_TAGS);
      existing.source = source;
      existing.updatedAt = new Date().toISOString();
      this.save();
      return { state: this.list(), item: structuredClone(existing), created: false };
    }
    if (this.data.items.length >= LIMITS.items) fail(`产物最多 ${LIMITS.items} 个`, 409, "ARTIFACT_ITEM_LIMIT");
    const now = new Date().toISOString();
    const item: ArtifactCollectionItem = { id: randomUUID(), title, kind, categoryIds: ids, source, createdAt: now, updatedAt: now };
    this.data.items.unshift(item);
    this.save();
    return { state: this.list(), item: structuredClone(item), created: true };
  }

  add(input: AddArtifactInput): { state: ArtifactCollectionsState; item: ArtifactCollectionItem; created: boolean } {
    const { source, kind } = normalizeSource(input.source);
    const title = this.titleFor(input, source, kind);
    const requestedIds = Array.isArray(input.categoryIds) ? input.categoryIds.filter((id): id is string => typeof id === "string") : [];
    const requestedNames = Array.isArray(input.categoryNames) ? input.categoryNames.filter((name): name is string => typeof name === "string") : [];
    const ids: string[] = [];
    for (const id of requestedIds) {
      if (!this.categoryById(id)) continue;
      if (!ids.includes(id)) ids.push(id);
    }
    for (const name of requestedNames) {
      const clean = text(name, "分类名称", LIMITS.categoryName);
      const category = this.ensureCategoryByName(clean);
      if (!ids.includes(category.id)) ids.push(category.id);
    }
    if (ids.length > ARTIFACT_MAX_TAGS) fail(`一条产物最多 ${ARTIFACT_MAX_TAGS} 个标签`, 400, "ARTIFACT_TAG_LIMIT");
    if (!ids.length) {
      const fallback = this.ensureCategoryByName(defaultCategoryName(kind));
      ids.push(fallback.id);
    }
    return this.upsert(source, kind, title, ids);
  }

  update(id: string, patch: { title?: unknown; categoryIds?: unknown }): { state: ArtifactCollectionsState; item: ArtifactCollectionItem } {
    const item = this.data.items.find((entry) => entry.id === id) ?? fail("产物不存在", 404, "ARTIFACT_ITEM_MISSING");
    if (patch.title !== undefined) item.title = text(patch.title, "标题", LIMITS.title);
    if (patch.categoryIds !== undefined) {
      const rawIds = patch.categoryIds;
      if (!Array.isArray(rawIds)) return fail("分类必须是数组");
      const ids: string[] = [];
      for (const raw of rawIds) {
        if (typeof raw !== "string") continue;
        if (!this.categoryById(raw) || ids.includes(raw)) continue;
        ids.push(raw);
      }
      if (ids.length > ARTIFACT_MAX_TAGS) fail(`一条产物最多 ${ARTIFACT_MAX_TAGS} 个标签`, 400, "ARTIFACT_TAG_LIMIT");
      item.categoryIds = ids;
    }
    item.updatedAt = new Date().toISOString();
    this.save();
    return { state: this.list(), item: structuredClone(item) };
  }

  remove(id: string): ArtifactCollectionsState {
    const before = this.data.items.length;
    this.data.items = this.data.items.filter((item) => item.id !== id);
    if (this.data.items.length === before) fail("产物不存在", 404, "ARTIFACT_ITEM_MISSING");
    this.save();
    return this.list();
  }
}
