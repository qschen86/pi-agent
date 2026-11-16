import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { invokeStructured, type ModelInvocationPort, type RoleModelConfig, type ModelImage } from "@pi-agent/model-port";
import { noteDisplayKind, type Note, type NoteStore } from "./notes.js";
import { NOTE_CATEGORY_POLICY, NOTE_CATEGORY_SYSTEM, NOTE_CATEGORY_MODULES, NOTE_MAX_CATEGORIES, NOTE_TOPIC_POLICY, NOTE_TOPIC_SYSTEM, NOTE_TOPIC_MAX_CATEGORIES, NOTE_EVENT_POLICY, NOTE_EVENT_SYSTEM, allowedNotePrimary, validateNoteCategories, validateNoteTopicCategories, reuseNoteModule } from "./note-category-policy.js";

export const NOTE_TOPIC_CONFIG: RoleModelConfig = { role: "noteCategory", provider: "deepseek", model: "deepseek-flash", thinking: "off", promptVersion: `${NOTE_TOPIC_POLICY}-confidence-v1`, schemaVersion: "note-category@2", timeoutMs: 30_000, maxAttempts: 1 };
export const NOTE_CATEGORY_CONFIG: RoleModelConfig = { role: "noteCategory", provider: "deepseek", model: "deepseek-flash", thinking: "off", promptVersion: `${NOTE_CATEGORY_POLICY}-confidence-v1`, schemaVersion: "note-category@2", timeoutMs: 30_000, maxAttempts: 1 };
/** 三套独立目录；没有 scope 的旧分类仍属于待办。 */
export type NoteCategoryScope = "note" | "todo" | "event";
type Category = { id: string; name: string; parentId?: string; scope?: "note" | "event" };
export const noteCategoryScope = (n: Pick<Note, "kind" | "schedule">): NoteCategoryScope => noteDisplayKind(n);
const parseScope = (v: unknown): NoteCategoryScope | undefined => v === "note" || v === "todo" || v === "event" ? v : undefined;
export const NOTE_EVENT_CONFIG: RoleModelConfig = { ...NOTE_TOPIC_CONFIG, promptVersion: `${NOTE_EVENT_POLICY}-confidence-v1` };
type Choice = { primary: string; secondary: string; reason: string; newModuleReason?: string; confidence?: "high" | "uncertain" };
type Job = { policyVersion?: string; source?: "manual" | "model"; hash: string; state: "pending" | "running" | "confirmation" | "failed" | "classified"; attempts: number; categoryId?: string; categoryIds?: string[]; suggestion?: Choice; suggestions?: Choice[]; error?: string; audit?: unknown[] };
type State = { eventCategoryPolicy?: string; categories: Category[]; jobs: Record<string, Job>; redirects?: Record<string, string>; primaryAliases?: Record<string, string>; pathAliases?: Record<string, string> };
// 待办那套的哈希保持不变（不让已有分类作废）；笔记多带一个范围标记，改类型后会按新的一套重新分类。
const hash = (n: Note) => createHash("sha256").update(JSON.stringify(noteCategoryScope(n) === "event"
  ? [NOTE_EVENT_POLICY, n.text, (n.images ?? []).map(i => i.id), "event"]
  : noteCategoryScope(n) === "note"
  ? [NOTE_CATEGORY_POLICY, n.text, (n.images ?? []).map(i => i.id), "note"]
  : [NOTE_CATEGORY_POLICY, n.text, (n.images ?? []).map(i => i.id)])).digest("hex");
const unique = <T>(items: T[]): T[] => [...new Set(items)];
/** 一个分类属于哪一套：二级跟着它的一级，一级自己带 scope 标记（没有 = 待办那套）。 */
const catScope = (c: Category | undefined, cats: Category[]): NoteCategoryScope => parseScope((c?.parentId ? cats.find(x => x.id === c.parentId) : c)?.scope) ?? "todo";
const newPrimary = (name: string, scope: NoteCategoryScope): Category => ({ id: randomUUID(), name, ...(scope !== "todo" ? { scope } : {}) });
// 保留待办历史别名键；其他类型用带范围的键，避免同名改名互相覆盖。
const primaryAliasKey = (scope: NoteCategoryScope, name: string) => scope === "todo" ? name : JSON.stringify([scope, name]);
const pathAliasKey = (scope: NoteCategoryScope, primary: string, secondary: string) => JSON.stringify(scope === "todo" ? [primary, secondary] : [scope, primary, secondary]);
const jobIds = (job: Job | undefined): string[] => job ? unique(job.categoryIds?.length ? job.categoryIds : job.categoryId ? [job.categoryId] : []) : [];
const jobSuggestions = (job: Job | undefined): Choice[] => job ? (job.suggestions?.length ? job.suggestions : job.suggestion ? [job.suggestion] : []) : [];
function setJobIds(job: Job, ids: string[]): void {
  const next = unique(ids);
  if (next.length) { job.categoryIds = next; job.categoryId = next[0]; }
  else { delete job.categoryIds; delete job.categoryId; }
}
function setJobSuggestions(job: Job, suggestions: Choice[]): void {
  if (suggestions.length) { job.suggestions = suggestions; job.suggestion = suggestions[0]; }
  else { delete job.suggestions; delete job.suggestion; }
}
/** 模型可以返回新的多分类数组，也接受旧的单分类对象。 */
function choiceList(value: unknown): Choice[] {
  const raw = value as (Partial<Choice> & { categories?: unknown; confidence?: Choice["confidence"] }) | null;
  if (!raw || typeof raw !== "object") return [];
  const list = Array.isArray(raw.categories) ? raw.categories : (typeof raw.primary === "string" || typeof raw.secondary === "string") ? [raw] : [];
  return list
    .filter((item): item is Choice => !!item && typeof item === "object" && typeof (item as Choice).primary === "string" && typeof (item as Choice).secondary === "string")
    .map(item => ({ ...item, confidence: item.confidence ?? raw.confidence }));
}
const clean = (v: unknown): string => { if (typeof v !== "string" || !v.trim() || v.trim().length > 60 || /[\r\n\x00-\x1f]/.test(v)) throw new Error("分类名称必须为 1–60 字的单行文字"); return v.trim().normalize("NFC"); };

/** One durable job per note; uncertain suggestions require human confirmation. */
export class NoteCategories {
  private data: State = { categories: [], jobs: {} };
  private active = new Set<string>();
  private timer?: NodeJS.Timeout;
  constructor(private file: string, private notes: NoteStore, private port: ModelInvocationPort | undefined, private changed: () => void) {
    if (existsSync(file)) {
      this.data = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(this.data.categories) || !this.data.jobs) throw new Error("待办分类数据损坏");
    }
    this.initializeEventCategories();
    for (const job of Object.values(this.data.jobs)) if (job.state === "running") job.state = job.attempts >= 2 ? "failed" : "pending";
    this.sync(); this.save();
    if (port) { this.timer = setInterval(() => { try { this.wake(); } catch { /* Retry storage on next tick. */ } }, 1000); this.timer.unref(); }
  }
  /** 首次启用独立日程目录：原文件备份成功后才迁移；标记与新任务一起持久化。 */
  private initializeEventCategories() {
    if (this.data.eventCategoryPolicy === NOTE_EVENT_POLICY) return;
    if (existsSync(this.file)) {
      const backup = `${this.file}.before-event-topic-v1.bak`;
      if (!existsSync(backup)) writeFileSync(backup, readFileSync(this.file), { flag: "wx", mode: 0o600 });
      else {
        // 崩溃后重试保留首次备份；备份不完整时拒绝迁移。
        const saved = JSON.parse(readFileSync(backup, "utf8"));
        if (!saved || !Array.isArray(saved.categories) || !saved.jobs || typeof saved.jobs !== "object" || Array.isArray(saved.jobs)) throw new Error("日程分类初始化备份损坏，请先恢复备份");
      }
    }
    const removed = new Set(this.data.categories.filter(c => catScope(c, this.data.categories) === "event").map(c => c.id));
    this.data.categories = this.data.categories.filter(c => !removed.has(c.id));
    for (const [from, to] of Object.entries(this.data.redirects ?? {})) if (removed.has(from) || removed.has(to)) delete this.data.redirects![from];
    for (const aliases of [this.data.primaryAliases, this.data.pathAliases]) if (aliases) for (const [name, to] of Object.entries(aliases)) if (removed.has(to)) delete aliases[name];
    // 旧日程无论人工分类还是待确认建议都重新归纳，审计记录保留且不进入模型输入。
    for (const n of this.notes.list()) if (noteCategoryScope(n) === "event") {
      const old = this.data.jobs[n.id];
      this.data.jobs[n.id] = { policyVersion: NOTE_EVENT_POLICY, hash: hash(n), state: "pending", attempts: 0, ...(old?.audit ? { audit: old.audit } : {}) };
    }
    this.data.eventCategoryPolicy = NOTE_EVENT_POLICY;
  }
  private projectNames: () => string[] = () => [];
  setProjectNames(read: () => string[]) { this.projectNames = read; }
  stop() { if (this.timer) clearInterval(this.timer); this.port = undefined; }
  private save() { const tmp = `${this.file}.tmp`; writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 }); renameSync(tmp, this.file); }
  sync() {
    let dirty = false;
    const notes = this.notes.list(), ids = new Set(notes.map(n => n.id));
    for (const id of Object.keys(this.data.jobs)) if (!ids.has(id)) { delete this.data.jobs[id]; dirty = true; }
    for (const n of notes) {
      const old = this.data.jobs[n.id];
      if (!old || old.hash !== hash(n)) {
        // 记录换了一套分类（笔记 / 待办 / 日程）时，旧套的分类不能留在新套里。
        const keptIds = jobIds(old).filter(id => catScope(this.data.categories.find(c => c.id === id), this.data.categories) === noteCategoryScope(n));
        this.data.jobs[n.id] = { policyVersion: noteCategoryScope(n) === "event" ? NOTE_EVENT_POLICY : NOTE_CATEGORY_POLICY, hash: hash(n), state: "pending", attempts: 0, ...(old?.audit ? { audit: old.audit } : {}), ...(keptIds.length ? { categoryIds: keptIds, categoryId: keptIds[0] } : {}) }; dirty = true;
      }
    }
    if (dirty) this.save();
  }
  /**
   * 导入的外部笔记（flomo 等）：先把原文放进来、暂不交给分类模型。
   * 写入一条「已归类但没有分类」的记录，让 sync / 重启都不会把它们排进模型队列；
   * 之后人工打标或编辑正文（hash 变化）仍会正常重新分类。
   */
  /**
   * 导入的外部笔记（flomo 等）：默认先把原文放进来、暂不交给分类模型——
   * 写入一条「已归类但没有分类」的记录，让 sync / 重启都不会把它们排进模型队列；
   * 之后人工打标或编辑正文（hash 变化）仍会正常重新分类。
   * state 传 "pending" 时则是显式重新排队（例如之后又想让 AI 给这批历史笔记分类）。
   */
  adoptImported(ids: string[], state: "classified" | "pending" = "classified"): void {
    let dirty = false;
    for (const id of ids) {
      const n = this.notes.get(id);
      if (!n) continue;
      const old = this.data.jobs[id];
      this.data.jobs[id] = {
        policyVersion: noteCategoryScope(n) === "event" ? NOTE_EVENT_POLICY : NOTE_CATEGORY_POLICY,
        hash: hash(n), state, attempts: 0,
        ...(old?.audit ? { audit: old.audit } : {})
      };
      dirty = true;
    }
    if (dirty) this.save();
  }
  snapshot() {
    this.sync();
    const counts = { total: 0, classified: 0, pending: 0, running: 0, confirmation: 0, failed: 0 };
    for (const j of Object.values(this.data.jobs)) { counts.total++; counts[j.state]++; }
    // 待确认建议随快照下发：待办列表分页后，卡片仍能看到全部待确认项。
    const confirmations = this.notes.list().filter(n => this.data.jobs[n.id]?.state === "confirmation").map(n => this.decorate(n));
    const categoryUsage: Record<string, number> = {};
    for (const j of Object.values(this.data.jobs)) {
      const touched = new Set<string>();
      for (const id of jobIds(j)) {
        const leaf = this.data.categories.find(c => c.id === id && c.parentId);
        if (!leaf) continue;
        touched.add(leaf.id); touched.add(leaf.parentId!);
      }
      // 一条待办在同一个分类节点下只算一次，即使它同时属于该一级下的多个二级分类。
      for (const id of touched) categoryUsage[id] = (categoryUsage[id] ?? 0) + 1;
    }
    const failures = this.notes.list().filter(n => this.data.jobs[n.id]?.state === "failed").map(n => this.decorate(n));
    return { categories: structuredClone(this.data.categories), counts, categoryUsage, enabled: !!this.port, confirmations, failures, version: this.version(), redirects: { ...this.data.redirects } };
  }
  private version() { return createHash("sha256").update(JSON.stringify(this.data.categories)).digest("hex"); }
  /** Resolve a primary/secondary path, creating missing entities without persisting. */
  private ensurePath(primaryId: unknown, primary: unknown, secondary: unknown, scope: NoteCategoryScope = "todo"): { parent: Category; category: Category } {
    const leafName = clean(secondary);
    let parent: Category | undefined;
    if (primaryId !== undefined && primaryId !== "") {
      parent = this.data.categories.find(c => c.id === primaryId && !c.parentId);
      if (!parent) throw new Error("请选择有效一级分类");
      if (catScope(parent, this.data.categories) !== scope) throw new Error("这个一级分类不属于这条记录的类型");
    } else {
      const primaryName = clean(primary);
      parent = this.data.categories.find(c => !c.parentId && c.name === primaryName && catScope(c, this.data.categories) === scope);
      if (!parent) { parent = newPrimary(primaryName, scope); this.data.categories.push(parent); }
    }
    let category = this.data.categories.find(c => c.parentId === parent!.id && c.name === leafName);
    if (!category) { category = { id: randomUUID(), name: leafName, parentId: parent.id }; this.data.categories.push(category); }
    return { parent, category };
  }
  /** Add a primary or secondary from the management page; same names reuse existing entities. */
  create(input: { primaryId?: unknown; primary?: unknown; secondary?: unknown; version?: unknown; scope?: unknown }) {
    this.sync();
    const scope = parseScope(input.scope) ?? "todo";
    if (input.version !== this.version()) throw new Error("分类目录已变更，请刷新后再操作");
    const previous = this.data, next = structuredClone(previous);
    this.data = next;
    let categoryId: string;
    try {
      const secondary = typeof input.secondary === "string" ? input.secondary.trim() : "";
      if (!secondary) {
        // 只新增一级分类：一级可以暂时没有二级，后续再往里加。
        let parent: Category | undefined;
        if (input.primaryId !== undefined && input.primaryId !== "") {
          parent = next.categories.find(c => c.id === input.primaryId && !c.parentId);
          if (!parent) throw new Error("请选择有效一级分类");
        } else {
          const primaryName = clean(input.primary);
          parent = next.categories.find(c => !c.parentId && c.name === primaryName && catScope(c, next.categories) === scope);
          if (!parent) { parent = newPrimary(primaryName, scope); next.categories.push(parent); }
        }
        categoryId = parent.id;
      } else {
        categoryId = this.ensurePath(input.primaryId, input.primary, input.secondary, scope).category.id;
      }
      this.save();
    } catch (e) {
      this.data = previous;
      throw e;
    }
    this.changed();
    return { ...this.snapshot(), createdCategoryId: categoryId };
  }
  /** Update the directory and all live references in one durable write. */
  manage(id: string, input: { action?: unknown; name?: unknown; parentId?: unknown; targetId?: unknown; beforeId?: unknown; version?: unknown }) {
    this.sync();
    if (input.version !== this.version()) throw new Error("分类目录已变更，请刷新后再操作");
    if (input.action === "delete") return this.remove(id);
    const previous = this.data, next = structuredClone(previous);
    const source = next.categories.find(c => c.id === id);
    if (!source) throw new Error("分类不存在，请刷新后再操作");
    const redirects: Record<string, string> = {};
    // 纯排序只改数组顺序；只有改名 / 改父级 / 合并才让在途分类结果失效。
    let semanticChange = false;
    if (input.action === "update") {
      const name = clean(input.name);
      const parentId = input.parentId === undefined ? source.parentId : input.parentId;
      if (source.parentId) {
        if (!next.categories.some(c => c.id === parentId && !c.parentId)) throw new Error("请选择有效一级分类");
      } else if (parentId !== undefined) throw new Error("一级分类不能设置父级");
      if (parentId !== source.parentId && source.parentId && catScope(next.categories.find(c => c.id === parentId), next.categories) !== catScope(source, next.categories)) throw new Error("不能把分类挪到另一类记录的分类下");
      if (next.categories.some(c => c.id !== id && c.parentId === parentId && c.name === name && (parentId !== undefined || catScope(c, next.categories) === catScope(source, next.categories)))) throw new Error("同级已有同名分类，请使用合并");
      semanticChange = source.name !== name || source.parentId !== parentId;
      source.name = name;
      if (source.parentId) source.parentId = parentId as string;
    } else if (input.action === "merge") {
      const target = next.categories.find(c => c.id === input.targetId);
      if (!target || target.id === id || !!target.parentId !== !!source.parentId || catScope(target, next.categories) !== catScope(source, next.categories)) throw new Error("请选择另一个同级分类作为合并目标");
      redirects[id] = target.id;
      if (!source.parentId) {
        for (const child of next.categories.filter(c => c.parentId === id)) {
          const same = next.categories.find(c => c.parentId === target.id && c.name === child.name);
          if (same) redirects[child.id] = same.id;
          else child.parentId = target.id;
        }
      }
      next.categories = next.categories.filter(c => !redirects[c.id]);
      semanticChange = true;
    } else if (input.action === "move") {
      // 一级：只排序；二级：可换父级（挪到其他一级分类），再按 beforeId 插入。
      // beforeId 为空表示放到该层末尾；一级和二级的排序互不影响。
      const beforeId = input.beforeId === undefined ? null : input.beforeId;
      if (beforeId !== null && typeof beforeId !== "string") throw new Error("请选择有效的排序位置");
      if (source.parentId) {
        const parentId = input.parentId === undefined ? source.parentId : input.parentId;
        if (typeof parentId !== "string" || !next.categories.some(c => c.id === parentId && !c.parentId)) throw new Error("请选择有效一级分类");
        if (catScope(next.categories.find(c => c.id === parentId), next.categories) !== catScope(source, next.categories)) throw new Error("不能把分类挪到另一类记录的分类下");
        if (next.categories.some(c => c.id !== id && c.parentId === parentId && c.name === source.name)) throw new Error("同级已有同名分类，请使用合并");
        semanticChange = source.parentId !== parentId;
        source.parentId = parentId;
      } else if (input.parentId !== undefined) throw new Error("一级分类不能设置父级");
      const before = beforeId === null ? undefined : next.categories.find(c => c.id === beforeId);
      if (beforeId !== null && (!before || before.id === id || !!before.parentId !== !!source.parentId || (!!source.parentId && before.parentId !== source.parentId) || catScope(before, next.categories) !== catScope(source, next.categories))) throw new Error("请选择同级的排序目标");
      next.categories.splice(next.categories.indexOf(source), 1);
      if (before) next.categories.splice(next.categories.indexOf(before), 0, source);
      else next.categories.push(source);
    } else throw new Error("分类操作无效");

    // Translate pending paths as well as IDs; unknown leaves follow renamed/merged parents.
    for (const [noteId, job] of Object.entries(next.jobs)) {
      setJobIds(job, jobIds(job).map(ref => redirects[ref] ?? ref));
      const suggestions = jobSuggestions(job);
      const jobScope = this.scopeOfNote(noteId);
      for (const suggestion of suggestions) {
        const oldParent = previous.categories.find(c => !c.parentId && c.name === suggestion.primary && catScope(c, previous.categories) === jobScope);
        const oldLeaf = oldParent && previous.categories.find(c => c.parentId === oldParent.id && c.name === suggestion.secondary);
        const leaf = oldLeaf && next.categories.find(c => c.id === (redirects[oldLeaf.id] ?? oldLeaf.id));
        const parent = leaf ? next.categories.find(c => c.id === leaf.parentId) : oldParent && next.categories.find(c => c.id === (redirects[oldParent.id] ?? oldParent.id));
        if (parent) suggestion.primary = parent.name;
        if (leaf) suggestion.secondary = leaf.name;
      }
      if (suggestions.length) setJobSuggestions(job, suggestions);
      // Cloned jobs invalidate in-flight responses based on the previous directory.
      if (semanticChange && job.state === "running") { job.state = "pending"; job.attempts = 0; }
    }
    next.redirects = { ...next.redirects, ...redirects };
    for (const [old, target] of Object.entries(next.redirects)) next.redirects[old] = redirects[target] ?? target;
    next.primaryAliases ??= {}; next.pathAliases ??= {};
    for (const aliases of [next.primaryAliases, next.pathAliases]) for (const [name, target] of Object.entries(aliases)) aliases[name] = redirects[target] ?? target;
    for (const old of previous.categories) {
      const current = next.categories.find(c => c.id === (redirects[old.id] ?? old.id))!;
      if (!old.parentId) {
        if (old.name !== current.name) next.primaryAliases[primaryAliasKey(catScope(old, previous.categories), old.name)] = current.id;
      } else {
        const oldParent = previous.categories.find(c => c.id === old.parentId)!;
        const parent = next.categories.find(c => c.id === current.parentId)!;
        if (old.name !== current.name || oldParent.name !== parent.name) next.pathAliases[pathAliasKey(catScope(old, previous.categories), oldParent.name, old.name)] = current.id;
      }
    }
    this.data = next;
    try { this.save(); } catch (e) { this.data = previous; throw e; }
    this.changed();
    return this.snapshot();
  }
  /**
   * 删除一个分类（一级会连带删除它的全部二级）。关联的待办解绑：没有别的分类可留时回到「待打标」
   * （pending，之后由后台重新打标），还有其它分类的多分类待办只去掉被删的那一个。
   */
  private remove(id: string) {
    const previous = this.data, next = structuredClone(previous);
    const target = next.categories.find(c => c.id === id);
    if (!target) throw new Error("分类不存在，请刷新后再操作");
    const removed = new Set<string>([id]);
    if (!target.parentId) for (const c of next.categories) if (c.parentId === id) removed.add(c.id);
    next.categories = next.categories.filter(c => !removed.has(c.id));
    let unbound = 0;
    for (const [noteId, job] of Object.entries(next.jobs)) {
      const ids = jobIds(job), kept = ids.filter(ref => !removed.has(ref));
      if (kept.length === ids.length) continue;
      if (kept.length) { setJobIds(job, kept); if (job.state === "running") { job.state = "pending"; job.attempts = 0; } continue; }
      unbound++;
      next.jobs[noteId] = { policyVersion: NOTE_CATEGORY_POLICY, hash: job.hash, state: "pending", attempts: 0, ...(job.audit ? { audit: job.audit } : {}) };
    }
    // 指向被删分类的重定向 / 别名一起清掉，否则之后按旧名字或旧 ID 还会解析到一个不存在的分类。
    for (const [from, to] of Object.entries(next.redirects ?? {})) if (removed.has(to) || removed.has(from)) delete next.redirects![from];
    for (const aliases of [next.primaryAliases, next.pathAliases]) if (aliases) for (const [name, to] of Object.entries(aliases)) if (removed.has(to)) delete aliases[name];
    this.data = next;
    try { this.save(); } catch (e) { this.data = previous; throw e; }
    this.changed();
    return { ...this.snapshot(), unbound };
  }
  /** 记录用哪一套分类：笔记、待办和日程各自一套。 */
  private scopeOfNote(id: string): NoteCategoryScope {
    const n = this.notes.get(id);
    return n ? noteCategoryScope(n) : "todo";
  }
  private scopeOfId(id: string): NoteCategoryScope { return catScope(this.data.categories.find(c => c.id === id), this.data.categories); }
  private primaryNamed(name: string, scope: NoteCategoryScope): Category | undefined {
    return this.data.categories.find(c => !c.parentId && c.name === name && catScope(c, this.data.categories) === scope);
  }
  private canonicalChoice(choice: Choice, scope: NoteCategoryScope = "todo"): Choice {
    const primary = clean(choice.primary), secondary = clean(choice.secondary);
    const inScope = (c: Category | undefined) => c && catScope(c, this.data.categories) === scope ? c : undefined;
    const exactParent = this.primaryNamed(primary, scope);
    const exactLeaf = exactParent && this.data.categories.find(c => c.parentId === exactParent.id && c.name === secondary);
    const leaf = exactLeaf
      ?? inScope(this.data.categories.find(c => c.id === this.data.pathAliases?.[pathAliasKey(scope, primary, secondary)]))
      ?? inScope(this.data.categories.find(c => c.id === this.data.pathAliases?.[JSON.stringify([primary, secondary])]));
    const parent = leaf ? this.data.categories.find(c => c.id === leaf.parentId) : exactParent
      ?? inScope(this.data.categories.find(c => c.id === this.data.primaryAliases?.[primaryAliasKey(scope, primary)]))
      ?? inScope(this.data.categories.find(c => c.id === this.data.primaryAliases?.[primary]));
    return { ...choice, primary: parent?.name ?? primary, secondary: leaf?.name ?? secondary };
  }
  /** 找或建一条两级路径，返回二级分类 ID；同名同级分类直接复用。 */
  private pathId(primary: string, secondary: string, scope: NoteCategoryScope = "todo"): string {
    let parent = this.primaryNamed(primary, scope);
    if (!parent) { parent = newPrimary(primary, scope); this.data.categories.push(parent); }
    let leaf = this.data.categories.find(c => c.parentId === parent!.id && c.name === secondary);
    if (!leaf) { leaf = { id: randomUUID(), name: secondary, parentId: parent.id }; this.data.categories.push(leaf); }
    return leaf.id;
  }
  private existingPathId(primary: string, secondary: string, scope: NoteCategoryScope = "todo"): string | undefined {
    const parent = this.primaryNamed(primary, scope);
    return parent && this.data.categories.find(c => c.parentId === parent.id && c.name === secondary)?.id;
  }
  private leafIds(raw: unknown, scope: NoteCategoryScope = "todo"): string[] {
    if (!Array.isArray(raw) || !raw.length || raw.some(id => typeof id !== "string" || !id)) throw new Error("请至少选择一个有效二级分类");
    const ids = unique(raw as string[]);
    if (ids.length > NOTE_MAX_CATEGORIES) throw new Error(`一条待办最多 ${NOTE_MAX_CATEGORIES} 个分类`);
    if (ids.some(id => !this.data.categories.some(c => c.id === id && c.parentId))) throw new Error("请选择一个有效二级分类");
    if (ids.some(id => this.scopeOfId(id) !== scope)) throw new Error("所选分类不属于这条记录的类型");
    return ids;
  }
  private decoratedCategories(job: Job | undefined) {
    const ids = unique(jobIds(job).map(id => this.data.redirects?.[id] ?? id));
    return ids.map(id => {
      const leaf = this.data.categories.find(c => c.id === id && c.parentId);
      const parent = leaf && this.data.categories.find(c => c.id === leaf.parentId);
      return leaf && parent ? { categoryId: leaf.id, primaryId: parent.id, primary: parent.name, secondary: leaf.name } : undefined;
    }).filter((item): item is { categoryId: string; primaryId: string; primary: string; secondary: string } => !!item);
  }
  decorate(n: Note) {
    const j = this.data.jobs[n.id];
    const categories = this.decoratedCategories(j);
    const first = categories[0];
    const suggestions = jobSuggestions(j).map(s => ({ ...s }));
    return { ...n, classification: {
      state: j?.state ?? "pending",
      ...(j?.source ? { source: j.source } : {}),
      ...(first ? { categoryId: first.categoryId, primaryId: first.primaryId, primary: first.primary, secondary: first.secondary } : {}),
      ...(categories.length ? { categories, categoryIds: categories.map(c => c.categoryId) } : {}),
      ...(suggestions.length ? { suggestion: suggestions[0], suggestions } : {}),
      ...(j?.error ? { error: j.error } : {}), inputHash: j?.hash
    } };
  }
  decide(id: string, input: { action?: unknown; categoryId?: unknown; categoryIds?: unknown; categories?: unknown; primary?: unknown; secondary?: unknown; primaryId?: unknown; inputHash?: unknown; categoryVersion?: unknown }) {
    this.sync();
    const job = this.data.jobs[id];
    if (!job) throw new Error("记录不存在");
    if (input.inputHash !== job.hash) throw new Error("记录已变更，请刷新后再处理分类");
    const rawIds = input.categoryIds !== undefined ? input.categoryIds : input.categoryId !== undefined ? [input.categoryId] : undefined;
    const scope = this.scopeOfNote(id);
    if (input.action === "retry" || input.action === "reject") {
      const keptIds = jobIds(job);
      this.data.jobs[id] = { policyVersion: NOTE_CATEGORY_POLICY, hash: job.hash, ...(job.audit ? { audit: job.audit } : {}), state: input.action === "reject" ? "failed" : "pending", attempts: 0, ...(keptIds.length ? { categoryIds: keptIds, categoryId: keptIds[0] } : {}), ...(input.action === "reject" ? { error: "建议已拒绝，请选择已有二级分类或重新打标" } : {}) };
    } else if (input.action === "assign") {
      const ids = this.leafIds(rawIds, scope);
      this.data.jobs[id] = { policyVersion: NOTE_CATEGORY_POLICY, hash: job.hash, state: "classified", source: "manual", attempts: job.attempts, categoryIds: ids, categoryId: ids[0], ...(job.audit ? { audit: job.audit } : {}) };
    } else if (input.action === "create") {
      // 人工在分类选择器里新建路径并同时归档这条待办；同名路径直接复用，避免重复实体。
      if (input.categoryVersion !== undefined && input.categoryVersion !== this.version()) throw new Error("分类目录已变更，请刷新后再操作");
      const { category } = this.ensurePath(input.primaryId, input.primary, input.secondary, scope);
      // 编辑时可以同时保留已选的其他分类，只把新建路径追加进去。
      const extras = rawIds === undefined ? [] : this.leafIds(rawIds, scope);
      const ids = unique([category.id, ...extras]).slice(0, NOTE_MAX_CATEGORIES);
      this.data.jobs[id] = { policyVersion: NOTE_CATEGORY_POLICY, hash: job.hash, state: "classified", source: "manual", attempts: job.attempts, categoryIds: ids, categoryId: ids[0], ...(job.audit ? { audit: job.audit } : {}) };
    } else if (input.action === "confirm") {
      if (input.categoryVersion !== this.version()) throw new Error("分类目录已变更，请刷新后再确认建议");
      const rawPaths = Array.isArray(input.categories)
        ? input.categories
        : input.primary !== undefined || input.secondary !== undefined ? [{ primary: input.primary, secondary: input.secondary }] : undefined;
      const paths = rawPaths?.map(item => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("分类建议格式不正确");
        return { primary: clean((item as Record<string, unknown>).primary), secondary: clean((item as Record<string, unknown>).secondary) };
      });
      if (paths && (!paths.length || paths.length > NOTE_MAX_CATEGORIES)) throw new Error(`需要 1–${NOTE_MAX_CATEGORIES} 个分类建议`);
      const uniquePaths = paths ? [...new Map(paths.map(p => [JSON.stringify([p.primary, p.secondary]), p])).values()] : undefined;
      if (job.state === "classified") {
        if (!uniquePaths?.length) return this.decorate(this.notes.get(id)!);
        const wanted = unique([...new Set(uniquePaths.map(p => this.existingPathId(p.primary, p.secondary, scope)).filter((x): x is string => !!x))]);
        if (wanted.length === uniquePaths.length && wanted.length === jobIds(job).length && wanted.every(x => jobIds(job).includes(x))) return this.decorate(this.notes.get(id)!);
      }
      const suggestions = jobSuggestions(job);
      if (job.state !== "confirmation" || !suggestions.length) throw new Error("没有有效的待确认建议");
      const targets = uniquePaths ?? suggestions.map(s => ({ primary: s.primary, secondary: s.secondary }));
      const ids = targets.map(p => this.pathId(p.primary, p.secondary, scope));
      const originalKey = JSON.stringify(suggestions.map(s => [s.primary, s.secondary]));
      for (const [otherId, j] of Object.entries(this.data.jobs)) {
        if (j.state !== "confirmation" || this.scopeOfNote(otherId) !== scope) continue;
        const key = JSON.stringify(jobSuggestions(j).map(s => [s.primary, s.secondary]));
        if (key !== originalKey) continue;
        setJobIds(j, ids); j.state = "classified"; j.source = "manual"; setJobSuggestions(j, []); delete j.error;
      }
    } else throw new Error("分类操作无效");
    this.save(); this.changed(); return this.decorate(this.notes.get(id)!);
  }
  wake() {
    if (!this.port) return;
    this.sync();
    for (const n of this.notes.list()) {
      if (this.active.size >= 1) break;
      const j = this.data.jobs[n.id];
      // 还在等 AI 判断是笔记还是待办：先不分类，否则会按错的那套分类。
      if (j.state !== "pending" || this.active.has(n.id) || n.kindPending) continue;
      this.active.add(n.id);
      void this.run(n, j).catch(() => { /* Durable running state recovers on restart. */ }).finally(() => this.active.delete(n.id));
    }
  }
  private async run(n: Note, job: Job) {
    job.state = "running"; job.attempts++; this.save(); this.changed();
    const scope = noteCategoryScope(n);
    const config = scope === "note" ? NOTE_TOPIC_CONFIG : scope === "event" ? NOTE_EVENT_CONFIG : NOTE_CATEGORY_CONFIG;
    try {
      const images = await noteModelImages(this.notes, n);
      // 模型只看到本类型的已确认目录与待确认建议。
      const scoped = () => this.data.categories.filter(c => catScope(c, this.data.categories) === scope);
      const pendingPaths = [...new Map(Object.entries(this.data.jobs)
        .filter(([id, j]) => j.state === "confirmation" && this.scopeOfNote(id) === scope)
        .flatMap(([, j]) => jobSuggestions(j))
        .map(s => [JSON.stringify([s.primary, s.secondary]), { primary: s.primary, secondary: s.secondary }] as const)).values()];
      let allowedPrimary: string[] = [];
      let projectNames: string[] = [];
      const moduleCandidates: Record<string, string[]> = {};
      let request: { system: string; prompt: string };
      if (scope !== "todo") {
        // 笔记按主题 / 话题，日程按活动领域 / 类型；均只参考各自目录。
        const tree = scoped();
        request = { system: scope === "event" ? NOTE_EVENT_SYSTEM : NOTE_TOPIC_SYSTEM, prompt: JSON.stringify({ categories: tree, pendingPaths, text: n.text, imageCount: n.images?.length ?? 0 }) };
      } else {
        projectNames = this.projectNames().filter(n => typeof n === "string" && n.trim() && n.length <= 60);
        const tree = scoped();
        allowedPrimary = allowedNotePrimary(tree, projectNames).filter(name => !tree.some(c => c.id === this.data.primaryAliases?.[name]) || tree.some(c => !c.parentId && c.name === name));
        const pending = pendingPaths.filter(s => allowedPrimary.includes(s.primary));
        for (const primary of allowedPrimary) {
          const parent = tree.find(c => !c.parentId && c.name === primary);
          moduleCandidates[primary] = [...new Set([
            ...tree.filter(c => c.parentId && c.parentId === parent?.id).map(c => c.name),
            ...pending.filter(p => p.primary === primary).map(p => p.secondary),
            ...(NOTE_CATEGORY_MODULES[primary] ?? []).map(m => reuseNoteModule(primary, m, tree))
          ])];
        }
        request = { system: NOTE_CATEGORY_SYSTEM, prompt: JSON.stringify({ allowedPrimary, projectNames, moduleCandidates, categories: tree, pendingPaths: pending, text: n.text, imageCount: n.images?.length ?? 0 }) };
      }
      const result = await invokeStructured<unknown>(this.port!, config, { ...request, images }, v => {
        const raw = v as Record<string, unknown> | null;
        const list = choiceList(v);
        const normalized = raw && list.length
          ? { ...raw, categories: list.map(c => {
            const canonical = this.canonicalChoice(c, scope);
            return { ...c, primary: canonical.primary, secondary: scope !== "todo" ? canonical.secondary : reuseNoteModule(canonical.primary, canonical.secondary, scoped()) };
          }) }
          : raw;
        return scope !== "todo"
          ? validateNoteTopicCategories(normalized, scoped())
          : validateNoteCategories(normalized, allowedPrimary, moduleCandidates);
      });
      this.sync();
      if (this.data.jobs[n.id] !== job) return;
      (job.audit ??= []).push({ attempts: result.attempts, usage: result.usage, config });
      if (!result.ok) throw new Error("AI 分类失败，请重试");
      const choices = choiceList(result.value).map(c => {
        const canonical = this.canonicalChoice(c, scope);
        const choice = { ...canonical, secondary: scope !== "todo" ? canonical.secondary : reuseNoteModule(canonical.primary, canonical.secondary, scoped()) };
        if (choice.newModuleReason) choice.reason = `${choice.reason}（新增${scope !== "todo" ? "分类" : "模块"}必要性：${choice.newModuleReason}）`;
        return choice;
      });
      if (!choices.length) throw new Error("AI 分类失败，请重试");
      if (choices.every(choice => choice.confidence === "high")) {
        const ids = unique(choices.map(choice => this.pathId(choice.primary, choice.secondary, scope)));
        setJobIds(job, ids); job.state = "classified"; job.source = "model"; setJobSuggestions(job, []);
      } else { setJobSuggestions(job, choices); job.state = "confirmation"; }
      delete job.error;
    } catch {
      this.sync();
      if (this.data.jobs[n.id] !== job) return;
      job.state = job.attempts < 2 ? "pending" : "failed"; job.error = "分类失败（模型或图片读取异常），请重试";
    }
    this.save(); this.changed();
  }
}

export async function noteModelImages(notes: NoteStore, n: Note): Promise<ModelImage[]> {
    const result: ModelImage[] = [];
    const originals = n.images ?? [];
    // The completion port accepts eight images; the ninth is paired with the eighth, never omitted.
    for (let i = 0; i < originals.length; i++) {
      const bytes = notes.images.read(originals[i].id).bytes;
      if (i === 7 && originals.length === 9) {
        const other = notes.images.read(originals[8].id).bytes;
        const tiles = await Promise.all([bytes, other].map(b => sharp(b).rotate().resize(800, 900, { fit: "contain", background: "white" }).png().toBuffer()));
        result.push({ mediaType: "image/png", bytes: await sharp({ create: { width: 1600, height: 900, channels: 3, background: "white" } }).composite(tiles.map((input, x) => ({ input, left: x * 800, top: 0 }))).png().toBuffer() }); break;
      }
      result.push({ mediaType: "image/webp", bytes: await sharp(bytes).rotate().resize(1600, 900, { fit: "inside", withoutEnlargement: true }).webp({ quality: 85 }).toBuffer() });
    }
    return result;
  }
