import { NoteRelationService } from "./note-relation-service.js";
import type { RelationContext } from "./note-relation-types.js";
/**
 * ConsoleService：控制台里不属于运行时会话的那部分服务端状态——
 * 待办记录（含分类与推荐任务）、外部资源（凭据、余额、调用记录）、本机文件夹选择器。
 *
 * 2026-10-18：旧的任务 / 项目 / Golden / 回放 / 盲评 / Agent 管理链路已整体下线（数据归档在数据目录之外），
 * 这里只保留对话、群聊、待办、资源页面仍在用的能力。
 */
import { noteMatchesSearch, parseNoteSearchQuery } from "./note-search.js";
import { NoteIterations } from "./note-iterations.js";
import { NoteCategories } from "./note-categories.js";
import { NoteKinds } from "./note-kind.js";
import { NOTE_MAX_CATEGORIES } from "./note-category-policy.js";
import { alignLunarStart } from "./lunar.js";
import { NoteStore, NOTE_MAX_LENGTH, NOTE_SCHEDULE_MAX_REPEATS, NoteImageError, isNoteRepeat, normalizeNoteRepeat } from "./notes.js";
import type { Note, NoteImage, NoteImportEntry, NoteKind, NoteRepeat, NoteSchedule, NoteWriting } from "./notes.js";
import { noteDisplayKind, isNoteAutomation } from "./notes.js";
import { noteScheduleExpired } from "./calendar.js";
import { withNoteRemind } from "./note-reminder.js";
import { EventEmitter } from "node:events";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { providerCredential } from "@pi-agent/adapter-pi";
import type { RuntimeKind } from "@pi-agent/runtime-sessions";
import { resolveWebResearchKeys, resolveWebResearchProvider } from "@pi-agent/web-research";
import type { WebResearchKeys, WebResearchProvider, WebResearchProviderPreference } from "@pi-agent/web-research";
import { piModelPort } from "@pi-agent/model-port";
import type { ModelInvocationPort } from "@pi-agent/model-port";
import { BALANCE_ADAPTERS, BALANCE_AUTO_REFRESH_MS, BALANCE_MIN_REFRESH_MS, BalanceCache, ProviderCallLog, WebResearchProviderSettings, balanceViewOf, credentialView, isWebResearchProviderPreference, serviceStatus } from "./resources.js";
import type { BalanceView, ResourceProvider, ServiceStatus, WebResearchProviderOption, WebResearchResource } from "./resources.js";
import { pickFolderNative } from "./pick-folder.js";
import { appData } from "./app-data.js";
import { DeepSeekUsageLedger, DeepSeekUsageTracker, readLegacyDeepSeekUsage, recordDeepSeekPort } from "./deepseek-usage.js";
import type { DeepSeekDailyRow, DeepSeekDeviceOf, DeepSeekRuntimeSession, DeepSeekUsageView } from "./deepseek-usage.js";
import { PLATFORM_TIME_ZONE } from "./platform-time.js";
import { scanRuntimeConfigs } from "./runtime-configs.js";
import type { RuntimeConfigsView } from "./runtime-configs.js";
import type { FolderPicker } from "./pick-folder.js";

/** 平台自己调用的模型（会话标题、待办分类、推荐任务、小马伙伴）：用户 2026-09-29 定为 DeepSeek */
export const PLATFORM_MODEL = { provider: "deepseek", model: "deepseek-flash" } as const;

export interface ConsoleOptions {
  noteClassification?: {
    port?: ModelInvocationPort; enabled?: boolean; /** 推荐任务整理前的防抖等待（测试用 0）；默认 15 秒 */ iterationDebounceMs?: number;
    /** 大类判断（笔记 / 待办 / 日程）单独用的模型端口；false 关闭；缺省与分类共用 */
    kindPort?: ModelInvocationPort | false;
  };
  dataDir: string;
  repoRoot: string;
  /** 读服务商只读余额接口用的 fetch（测试注入；默认全局 fetch） */
  fetch?: typeof fetch;
  /** 联网检索凭据查找（测试注入；默认按环境变量、本机文件与 Pi 配置） */
  webKeys?: () => WebResearchKeys;
  /** 资源扩展：可选或私有应用往「外部资源」补充的服务行与余额读取方式（如配音服务）；基础版默认没有 */
  resourceProviders?: ResourceProvider[];
  /** 拉起本机文件夹选择器（测试注入替身；默认弹系统对话框） */
  pickFolder?: FolderPicker;
  /** 运行时配置资源：测试指定三个用户级配置目录；默认按环境变量或家目录 */
  runtimeConfigs?: { dirs?: Partial<Record<RuntimeKind, string>>; home?: string };
  /** Pi 的覆盖项：模型端口与凭据查找都从这里读（测试指向临时目录） */
  pi?: {
    bin?: string;
    osSandbox?: boolean;
    /** 额外放行给 pi 的环境变量名（支持 PREFIX*，夹具测试用） */
    passEnv?: string[];
    /** pi 的状态目录（provider 配置与密钥的来源）；默认 ~/.pi/agent */
    configDir?: string;
  };
}

/** 选文件夹：只剩新建会话选工作目录这一种用途，要本机绝对路径。 */
export type PickFolderInput = { purpose: "workspace"; current?: string };

export interface PickedFolder {
  /** 本机绝对路径 */
  path: string;
}

type NoteClassificationView = { state?: string; categoryId?: string; primaryId?: string; categoryIds?: string[]; categories?: { categoryId?: string; primaryId?: string }[] };
/** 分类计数键：每条待办的所有二级分类都记一次，并带上父级；没有任何分类时记到 pending。 */
function noteCategoryKeys(note: { classification?: NoteClassificationView }): string[] {
  const c = note.classification;
  const rows = c?.categories?.length ? c.categories : c?.categoryId ? [{ categoryId: c.categoryId, primaryId: c.primaryId }] : [];
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.categoryId) keys.add(row.categoryId);
    if (row.primaryId) keys.add(row.primaryId);
  }
  if ((c?.state ?? "pending") !== "classified") keys.add("pending");
  return keys.size ? [...keys] : ["pending"];
}
function noteMatchesCategory(note: { classification?: NoteClassificationView }, keys: readonly string[]): boolean {
  if (!keys.length) return true;
  const own = new Set(noteCategoryKeys(note));
  return keys.some(key => own.has(key));
}

/** 编辑保存时允许新建分类并直接归档：先校验名称，避免正文已更新后才发现分类非法。 */
function noteCreateCategoryInput(value: unknown): { primaryId?: string; primary: string; secondary: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConsoleError("新建分类格式不正确");
  const v = value as Record<string, unknown>;
  const validName = (s: unknown): s is string => typeof s === "string" && !!s.trim() && s.trim().length <= 60 && !/[\r\n\x00-\x1f]/.test(s);
  if (v.primaryId !== undefined && (typeof v.primaryId !== "string" || !v.primaryId)) throw new ConsoleError("请选择有效一级分类");
  if (!validName(v.secondary)) throw new ConsoleError("二级分类名称必须为 1–60 字的单行文字");
  if (v.primaryId === undefined && !validName(v.primary)) throw new ConsoleError("一级分类名称必须为 1–60 字的单行文字");
  return { ...(v.primaryId !== undefined ? { primaryId: v.primaryId } : {}), primary: validName(v.primary) ? v.primary.trim().normalize("NFC") : "", secondary: v.secondary.trim().normalize("NFC") };
}

export type NoteKindFilter = "all" | "mixed" | "note" | "todo" | "event";
/** 批量导入：一次请求最多多少条（CLI 按批调用） */
export const NOTE_IMPORT_MAX_BATCH = 100;
export const NOTE_KIND_FILTERS: readonly NoteKindFilter[] = ["all", "mixed", "note", "todo", "event"];
/** 列表的大类筛选：mixed 是默认的「笔记和待办」混排（日程单独一行展示，不在这里）。 */
export function noteKindMatches(note: Pick<Note, "kind" | "schedule">, filter: NoteKindFilter): boolean {
  if (filter === "all") return true;
  const kind = noteDisplayKind(note);
  return filter === "mixed" ? kind !== "event" : kind === filter;
}

/** 指定大类：只接受 note / todo（日程 = 待办 + 时间，不能单独指定）。 */
function noteKindInput(value: unknown): NoteKind | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value !== "note" && value !== "todo") throw new ConsoleError("类型只能是笔记（note）或待办（todo）");
  return value;
}

/** 合并 start 与 repeats：排序去重后第一个作为 start，其余留作 repeats。 */
function noteScheduleSlots(start: string | undefined, repeats: string[] | undefined): Pick<NoteSchedule, "start" | "repeats"> {
  const all = [...new Set([...(start ? [start] : []), ...(repeats ?? [])])].sort();
  return { ...(all[0] ? { start: all[0] } : {}), ...(all.length > 1 ? { repeats: all.slice(1) } : {}) };
}

function noteScheduleInput(value: unknown): NoteSchedule | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConsoleError("日程时间格式不正确");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => key !== "start" && key !== "end" && key !== "allDay" && key !== "repeats" && key !== "repeat")) throw new ConsoleError("日程时间只能包含开始、结束、全天标记、重复的几天和周期规则");
  const repeat = (rawAllDay: boolean): NoteRepeat | undefined => {
    if (v.repeat === undefined || v.repeat === null) return undefined;
    if (v.repeats !== undefined && v.repeats !== null) throw new ConsoleError("周期重复与另外几天只能选一种");
    if (!isNoteRepeat(v.repeat, rawAllDay)) throw new ConsoleError("周期规则不正确：频率只能是每天 / 每周 / 每月 / 每年，间隔 1–99，次数 1–500，until 与 count 只能给一个，byDay 只能配每周重复且是 MO–SU 里不重复的星期，lunar（农历周期）只能配每月 / 每年重复且不能和 byDay 同用");
    return normalizeNoteRepeat(v.repeat);
  };
  const repeats = (rawAllDay: boolean): string[] | undefined => {
    if (v.repeats === undefined || v.repeats === null) return undefined;
    if (!Array.isArray(v.repeats) || !v.repeats.length || v.repeats.length > NOTE_SCHEDULE_MAX_REPEATS) throw new ConsoleError(`重复的日程最多 ${NOTE_SCHEDULE_MAX_REPEATS} 天`);
    return [...new Set(v.repeats.map((raw) => {
      if (typeof raw !== "string") throw new ConsoleError("重复的日程时间格式不正确");
      if (rawAllDay) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw))) throw new ConsoleError("重复的日期必须是 YYYY-MM-DD");
        return raw;
      }
      const ms = Date.parse(raw);
      if (!Number.isFinite(ms)) throw new ConsoleError("重复的日程时间不是有效时间");
      return new Date(ms).toISOString();
    }))].sort();
  };
  if (v.allDay !== undefined && v.allDay !== false) {
    if (v.allDay !== true) throw new ConsoleError("全天标记格式不正确");
    const day = (raw: unknown, label: string): string | undefined => {
      if (raw === undefined || raw === null || raw === "") return undefined;
      if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw))) throw new ConsoleError(`${label}必须是 YYYY-MM-DD`);
      return raw;
    };
    const start = day(v.start, "开始日期"), end = day(v.end, "结束日期");
    const extra = repeats(true);
    const period = repeat(true);
    const slots = noteScheduleSlots(start, extra);
    if (!slots.start && !end) return null;
    if (slots.start && end && end < slots.start) throw new ConsoleError("结束日期不能早于开始日期");
    return alignLunarStart({ ...slots, ...(end ? { end } : {}), ...(period ? { repeat: period } : {}), allDay: true });
  }
  const parse = (raw: unknown, label: string): string | undefined => {
    if (raw === undefined || raw === null || raw === "") return undefined;
    if (typeof raw !== "string") throw new ConsoleError(`${label}格式不正确`);
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) throw new ConsoleError(`${label}不是有效时间`);
    return new Date(ms).toISOString();
  };
  const start = parse(v.start, "开始时间");
  const end = parse(v.end, "结束时间");
  const slots = noteScheduleSlots(start, repeats(false));
  const period = repeat(false);
  if (!slots.start && !end) return null;
  if (slots.start && end && Date.parse(end) < Date.parse(slots.start)) throw new ConsoleError("结束时间不能早于开始时间");
  return alignLunarStart({ ...slots, ...(end ? { end } : {}), ...(period ? { repeat: period } : {}) });
}

export class ConsoleService extends EventEmitter {
  /** 平台级提供方调用日志（只记元数据）；历史记录仍在资源页显示 */
  readonly callLog: ProviderCallLog;
  /** 待办记录：按时间顺序存下的小想法（大备忘录） */
  readonly notes: NoteStore;
  readonly noteRelations: NoteRelationService;
  readonly noteCategories: NoteCategories;
  readonly noteIterations: NoteIterations;
  /** 笔记 / 待办 / 日程的大类判断（v3.17） */
  readonly noteKinds: NoteKinds;
  /** DeepSeek token 消耗账本：平台功能调用与历史审计；Pi 会话用量读取时另汇总 */
  readonly deepseekUsage: DeepSeekUsageLedger;
  /** 按天分桶的增量统计与缓存（今日/昨日/近 7 天/近 30 日/累计） */
  private readonly deepseekTracker: DeepSeekUsageTracker;
  /** 北京时间口径的统计（「今日费用」按平台日历日；上面那个跟随服务进程的本机时区）；用到时才创建。 */
  private deepseekPlatformTracker: DeepSeekUsageTracker | undefined;
  private readonly balances: BalanceCache;
  /** 平台默认联网供应商的手动选择（数据目录持久化；默认 auto） */
  private readonly webProviderSettings: WebResearchProviderSettings;
  /** 运行时页面触发的余额读取：同一服务同时只发一个 */
  private readonly balanceReads = new Map<string, Promise<unknown>>();
  /** 同一时刻只开一个选择器：对话框是模态的，叠开只会把人弄糊涂 */
  private picking = false;

  constructor(private readonly options: ConsoleOptions) {
    super();
    this.callLog = new ProviderCallLog(appData(options.dataDir, "runtime-sessions").path("provider-calls.jsonl"));
    this.deepseekUsage = new DeepSeekUsageLedger(appData(options.dataDir, "resources").path("deepseek-usage.jsonl"));
    this.deepseekUsage.bootstrap(readLegacyDeepSeekUsage(options.dataDir));
    this.deepseekTracker = new DeepSeekUsageTracker(appData(options.dataDir, "resources").path("deepseek-usage.jsonl"));
    this.notes = new NoteStore(appData(options.dataDir, "notes").path("notes.json"));
    this.noteRelations = new NoteRelationService(this.notes, (input, applyRelations, relationContext) => this.addNote(input.text, input.images, input.schedule, {kind:input.kind,timeZone:input.timeZone,pinned:input.pinned,automation:input.automation,applyRelations,relationContext}), () => this.emit("update", {sessionId:"",kind:"notes"}));
    const pi = options.pi;
    const rawClassificationPort = options.noteClassification?.enabled === false ? undefined : options.noteClassification?.port ?? (pi ? piModelPort({
      ...(pi.bin ? { bin: pi.bin } : {}), ...(pi.osSandbox === false ? { osSandbox: false } : {}),
      ...(pi.passEnv ? { passEnv: pi.passEnv } : {}), ...(pi.configDir ? { piConfigDir: pi.configDir } : {})
    }) : undefined);
    const classificationPort = rawClassificationPort ? recordDeepSeekPort(rawClassificationPort, this.deepseekUsage) : undefined;
    this.noteCategories = new NoteCategories(appData(options.dataDir, "notes").path("note-categories.json"), this.notes, classificationPort, () => this.emit("update", { sessionId: "", kind: "notes" }));
    const kindPort = options.noteClassification?.kindPort === false ? undefined
      : options.noteClassification?.kindPort ? recordDeepSeekPort(options.noteClassification.kindPort, this.deepseekUsage) : classificationPort;
    this.noteKinds = new NoteKinds(this.notes, kindPort, () => this.emit("update", { sessionId: "", kind: "notes" }));
    this.noteIterations = new NoteIterations(appData(options.dataDir, "notes").path("note-iterations.json"), this.notes, classificationPort, () => this.emit("update", { sessionId: "", kind: "notes" }), { ...(options.noteClassification?.iterationDebounceMs !== undefined ? { debounceMs: options.noteClassification.iterationDebounceMs } : {}) });
    this.balances = new BalanceCache(appData(options.dataDir, "resources").path("resource-balances.json"));
    this.webProviderSettings = new WebResearchProviderSettings(appData(options.dataDir, "resources").path("web-research-provider.json"));
  }

  /* ------------------------------- 待办记录 ------------------------------- */

  /** 数据目录：Google 日历等平台私有设置与待办存在同一个目录里 */
  get dataDir(): string { return this.options.dataDir; }

  /** 新的在前：最近的想法的排在最上面 */
  listNotes(): Note[] {
    this.noteCategories.sync();
    this.noteIterations.sync();
    return this.noteRelations.decorate(this.notes.list().map(n => this.noteCategories.decorate(n)));
  }

  /** 按 id 读一条（带分类信息）；不存在时 404 语义的输入错误 */
  getNote(id: string): Note {
    this.noteCategories.sync();
    const note = this.notes.get(String(id));
    if (!note) throw new ConsoleError("记录不存在，可能已被删除");
    return this.noteRelations.decorate([this.noteCategories.decorate(note)])[0];
  }

  /**
   * 分页读取待办（新的在前）：cursor 是上一页末尾的偏移量（base64url 编码）。
   * 完成状态 / 分类 / 关联对话在服务端先筛再分页：某一筛选下第一页就有 50 条命中，
   * 页面不会为了“找到符合筛选的旧记录”把全部记录一页页拉完。
   * 完成状态按大类解释：待办看 done，日程没有完成概念，todo / done 分别表示未过期 / 已过期。
   * 计数（counts / categoryCounts）始终对全部记录统计，滚动续读不会让计数忽大忽小；
   * categoryCounts 按完成状态（all / todo / done）各给一份，供分类树交叉筛选显示。
   * total 是当前筛选下的全量结果数（筛选为空时没有下一页）。
   */
  pageNotes(query: {
    limit?: unknown; cursor?: unknown; status?: unknown; category?: unknown; categories?: unknown; link?: unknown;
    /** 大类筛选（v3.17）：mixed = 笔记和待办（不含日程）/ note / todo / event；缺省 all 全部 */
    kind?: unknown;
    /** 三个 Tab 各自保存的筛选，用于独立计算标签数字。 */
    tabFilters?: unknown;
    /** 待办列表主动隐藏平台 / debug；其它消费者默认仍可读取全部。 */
    hideDebug?: unknown;
    /** 有关联会话的待办 id；link 为 linked / unlinked 时用来筛关联对话 */
    linkedNoteIds?: ReadonlySet<string>;
    /** 搜索关键词（空白分隔，全部命中才算）；只读筛选，不改记录 */
    q?: unknown;
    /** 记录 id → 关联会话标题；搜索时一并作为可搜索文字 */
    sessionTitles?: ReadonlyMap<string, readonly string[]>;
  } = {}): {
    notes: Note[]; total: number; counts: { all: number; todo: number; done: number };
    categoryCounts: Record<string, Record<string, number>>; filteredCounts: { all: number; todo: number; done: number }; nextCursor?: string;
    kindCounts: Record<NoteKindFilter, number>;
  } {
    this.noteCategories.sync();
    const kindFilter: NoteKindFilter = NOTE_KIND_FILTERS.includes(query.kind as NoteKindFilter) ? query.kind as NoteKindFilter : "all";
    const everything = this.notes.list().map(n => this.noteCategories.decorate(n));
    // 计数与分类计数都在当前大类范围内统计：切到「笔记」时，状态 / 分类下拉里的数字只数笔记。
    // 搜索先于其余筛选生效：计数、分类计数、大类计数都只统计命中的记录，页面上的数字与结果一致。
    const terms = parseNoteSearchQuery(query.q);
    const searchMatches = (note: Note): boolean => noteMatchesSearch(note, terms, query.sessionTitles?.get(note.id) ?? []);
    const hideDebug = query.hideDebug === true || query.hideDebug === "1";
    const visible = hideDebug ? everything.filter(note => {
      if (noteDisplayKind(note) !== "todo") return true;
      const c = note.classification;
      const rows = c?.categories?.length ? c.categories : c?.categoryId ? [c] : [];
      return !rows.some(row => row.primary === "平台" && row.secondary?.toLowerCase() === "debug");
    }) : everything;
    const searched = terms.length ? visible.filter(searchMatches) : visible;
    const all = searched.filter(note => noteKindMatches(note, kindFilter));
    // 「完成状态」在大类里有不同含义：待办看 done，日程没有完成概念，只看有没有过结束时间。
    const now = Date.now();
    const isDone = (note: Note): boolean => noteDisplayKind(note) === "event" ? noteScheduleExpired(note, now) : !!note.done;
    const counts = { all: all.length, todo: 0, done: 0 };
    const selectedCategories = (Array.isArray(query.categories)
      ? query.categories
      : typeof query.categories === "string" ? query.categories.split(",")
      : typeof query.category === "string" && query.category ? [query.category] : []).map(String).filter(Boolean);
    const status = query.status === "todo" || query.status === "done" ? query.status : "all";
    const link = query.link === "linked" || query.link === "unlinked" ? query.link : "all";
    const linked = query.linkedNoteIds;
    const linkMatches = (note: Note): boolean => {
      if (link === "all") return true;
      const has = !!linked?.has(note.id);
      return link === "linked" ? has : !has;
    };
    const filteredCounts = { all: 0, todo: 0, done: 0 };
    const categoryCounts: Record<string, Record<string, number>> = { all: { "": all.length, pending: 0 }, todo: { "": 0, pending: 0 }, done: { "": 0, pending: 0 } };
    for (const note of all) {
      const state = isDone(note) ? "done" : "todo";
      counts[state]++;
      categoryCounts[state]![""]!++;
      if (noteMatchesCategory(note, selectedCategories) && linkMatches(note)) { filteredCounts.all++; filteredCounts[state]++; }
      for (const key of noteCategoryKeys(note)) {
        categoryCounts.all![key] = (categoryCounts.all![key] ?? 0) + 1;
        categoryCounts[state]![key] = (categoryCounts[state]![key] ?? 0) + 1;
      }
    }
    const matched = all.filter((note) => {
      if (!noteMatchesCategory(note, selectedCategories) || !linkMatches(note)) return false;
      if (status === "todo" && isDone(note)) return false;
      if (status === "done" && !isDone(note)) return false;
      return true;
    });
    // 大类 Tab 显示各类型总数，不受列表的状态 / 分类 / 关联筛选影响。
    // 搜索和隐藏 debug 仍是页面整体的可见范围；当前筛选数量由 total / filteredCounts 提供。
    const kindCounts = Object.fromEntries(NOTE_KIND_FILTERS.map(k => [k, 0])) as Record<NoteKindFilter, number>;
    for (const note of searched) {
      for (const k of NOTE_KIND_FILTERS) if (noteKindMatches(note, k)) kindCounts[k]++;
    }
    let tabFilters: unknown = query.tabFilters;
    if (typeof tabFilters === "string") {
      try { tabFilters = tabFilters.length <= 16000 ? JSON.parse(tabFilters) : null; } catch { tabFilters = null; }
    }
    if (tabFilters && typeof tabFilters === "object" && !Array.isArray(tabFilters)) {
      for (const kind of ["note", "todo", "event"] as const) {
        const raw = (tabFilters as Record<string, unknown>)[kind];
        const filter = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
        const tabStatus = kind === "note" ? "all" : filter.status === "all" || filter.status === "done" ? filter.status : "todo";
        const categories = Array.isArray(filter.categories) ? filter.categories.filter((v): v is string => typeof v === "string" && !!v) : [];
        kindCounts[kind] = searched.filter(note => {
          if (!noteKindMatches(note, kind) || !noteMatchesCategory(note, categories)) return false;
          if (tabStatus !== "all" && isDone(note) !== (tabStatus === "done")) return false;
          const hasLink = !!linked?.has(note.id);
          return filter.link === "linked" ? hasLink : filter.link === "unlinked" ? !hasLink : true;
        }).length;
      }
    }
    const limit = Math.max(1, Math.min(200, Number(query.limit) || 50));
    const offset = typeof query.cursor === "string" && query.cursor ? Math.max(0, Number(Buffer.from(query.cursor, "base64url").toString()) || 0) : 0;
    const page = matched.slice(offset, offset + limit);
    return { notes: page, total: matched.length, counts, categoryCounts, filteredCounts, kindCounts, ...(offset + limit < matched.length ? { nextCursor: Buffer.from(String(offset + limit)).toString("base64url") } : {}) };
  }

  /** 上传一张待办图片；返回的元数据由后续 addNote/updateNote 引用 */
  async addNoteImage(bytes: Buffer, mime: string, name: string, sourceSha256?: string): Promise<NoteImage> {
    try { return await this.notes.images.save(bytes, mime, name, sourceSha256); }
    catch (e) { if (e instanceof NoteImageError) throw new ConsoleError(e.message); throw e; }
  }

  /** 再次添加同一张待办图片：命中已存的就直接返回新条目，不用重传。 */
  reuseNoteImage(sha256: string): NoteImage | undefined {
    try { return this.notes.images.reuse(sha256); }
    catch (e) { if (e instanceof NoteImageError) throw new ConsoleError(e.message); throw e; }
  }

  /** 待办图片的原图与文件名：供「从待办发起会话」直接转成对话附件 */
  noteImageOriginal(id: string): { bytes: Buffer; mimeType: string; name: string } {
    const meta = this.notes.images.metadata(String(id));
    return { ...this.notes.images.read(meta.id), name: meta.name };
  }

  readNoteImage(id: string, thumbnail = false): { bytes: Buffer; mimeType: string } {
    return this.notes.images.read(String(id), thumbnail);
  }

  private resolveNoteImages(ids: unknown): NoteImage[] {
    try { return this.notes.images.resolve(ids); }
    catch (e) { if (e instanceof NoteImageError) throw new ConsoleError(e.message); throw e; }
  }

  /**
   * 统一输入框新建一条记录。带明确 schedule / kind 的调用（API、测试）按给定的保存；
   * 否则先按待办落盘并标记 kindPending，由 AI 在后台判断是笔记、待办还是日程。
   * skipWriting=true 时不排「整理」：平台自己生成的正文（如故障诊断待办）不需要再被改写，
   * 改写会换掉正文哈希，触发 AI 重新分类并冲掉人工指定的分类。
   */
  addNote(text: unknown, imageIds?: unknown, schedule?: unknown, options: { kind?: unknown; timeZone?: unknown; pinned?: unknown; automation?: unknown; skipWriting?: boolean; applyRelations?: (notes: Note[], note: Note) => void; relationContext?: RelationContext } = {}): Note {
    const images = this.resolveNoteImages(imageIds);
    const body = typeof text === "string" ? text.trim() : "";
    if (!body && !images.length) throw new ConsoleError("写点什么或加张图片再保存");
    if (body.length > NOTE_MAX_LENGTH) throw new ConsoleError(`一条记录最多 ${NOTE_MAX_LENGTH} 个字符`);
    const parsedSchedule = noteScheduleInput(schedule);
    const plannedSchedule = withNoteRemind(parsedSchedule, body);
    const kind = noteKindInput(options.kind);
    if (kind === "note" && plannedSchedule) throw new ConsoleError("笔记不能带日程时间");
    if (options.pinned !== undefined && typeof options.pinned !== "boolean") throw new ConsoleError("pinned 必须是布尔值");
    if (options.automation !== undefined && !isNoteAutomation(options.automation)) throw new ConsoleError("automation 必须包含有效的 taskId 和布尔值 needsHuman");
    const meta = {
      ...(isNoteAutomation(options.automation) ? { automation: options.automation } : {}),
      ...(kind || plannedSchedule ? { kind: kind ?? "todo", kindSource: "user" as const } : this.noteKinds.enabled ? { kindPending: true } : {}),
      ...(options.pinned ? { pinned: true } : {}),
      ...(this.noteKinds.enabled && body && !plannedSchedule && !options.skipWriting ? { writing: { state: "pending" as const } } : {})
    };
    const note = this.notes.add(body, undefined, images, plannedSchedule ?? undefined, meta, options.applyRelations, options.relationContext);
    if (note.kindPending || note.writing?.state === "pending") this.noteKinds.enqueue(note.id, options.timeZone);
    this.emit("update", { sessionId: "", kind: "notes" });
    this.noteCategories.sync();
    this.noteIterations.sync();
    return this.noteRelations.decorate([this.noteCategories.decorate(note)])[0];
  }

  /**
   * 批量导入外部笔记（flomo 等）：保留原始记录时间，按旧 → 新落盘。
   * 导入的是历史原文，默认不进 AI 分类与整理队列；classify 为真时才交给后台按笔记套分类。
   * 同一条（时间 + 正文）已存在就跳过，重复执行导入不会产生副本。
   */
  importNotes(input: unknown, options: { classify?: boolean } = {}): { imported: number; skipped: number; ids: string[] } {
    if (!Array.isArray(input)) throw new ConsoleError("导入内容格式不正确");
    if (!input.length) throw new ConsoleError("没有可导入的记录");
    if (input.length > NOTE_IMPORT_MAX_BATCH) throw new ConsoleError(`一次最多导入 ${NOTE_IMPORT_MAX_BATCH} 条`);
    const seen = new Map(this.notes.list().map((n) => [`${n.createdAt}\n${n.text}`, n.id]));
    const entries: NoteImportEntry[] = [];
    const existing: string[] = [];
    let skipped = 0;
    for (const raw of input) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConsoleError("导入记录格式不正确");
      const item = raw as Record<string, unknown>;
      const text = typeof item.text === "string" ? item.text.trim() : "";
      if (text.length > NOTE_MAX_LENGTH) throw new ConsoleError(`一条记录最多 ${NOTE_MAX_LENGTH} 个字符`);
      const images = this.resolveNoteImages(item.images);
      if (!text && !images.length) throw new ConsoleError("导入记录不能既没有正文也没有图片");
      const at = typeof item.createdAt === "string" ? new Date(item.createdAt) : new Date(NaN);
      if (Number.isNaN(at.getTime())) throw new ConsoleError("导入记录缺少有效的记录时间");
      const createdAt = at.toISOString();
      const kind = noteKindInput(item.kind) ?? "note";
      const key = `${createdAt}\n${text}`;
      const duplicate = seen.get(key);
      if (seen.has(key)) { skipped++; if (duplicate) existing.push(duplicate); continue; }
      const entry: NoteImportEntry = { text, createdAt, images, kind, kindSource: "user" };
      entries.push(entry);
      // 同一次请求里重复的条目也算已存在，避免把副本写进去；占位 id 为空串，不会拿去排队。
      seen.set(key, "");
    }
    // 输入顺序不可靠时按时间从旧到新排；sort 稳定，同一时刻保持入参顺序。
    entries.sort((a, b) => a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? -1 : 1);
    const added = this.notes.addMany(entries);
    this.notes.reorder();
    const ids = added.map((n) => n.id);
    if (options.classify === true) {
      // 新记录由 sync 排队；之前导入过、这次才要求分类的记录显式重新排队。
      this.noteCategories.adoptImported(existing.filter((id) => id), "pending");
      this.noteCategories.sync();
    } else this.noteCategories.adoptImported(ids);
    this.emit("update", { sessionId: "", kind: "notes" });
    this.noteIterations.sync();
    return { imported: added.length, skipped, ids };
  }

  private applyNoteWriting(existing: Note, action: unknown, expectedText: unknown, writingId: unknown): Note {
    if (typeof expectedText !== "string" || expectedText !== existing.text) throw new ConsoleError("正文已变化，请刷新后重新整理");
    let text: string | undefined;
    let writing: NoteWriting | null = null;
    if (action === "retry") {
      if (!this.noteKinds.enabled) throw new ConsoleError("没有配置 AI 模型，无法整理内容");
      if (!existing.text || existing.schedule || existing.writing?.state === "pending") throw new ConsoleError("这条记录暂时不能整理");
      writing = { state: "pending" };
    } else {
      const result = existing.writing;
      if (result?.state !== "ready" || result.formattedText !== existing.text || !result.id || result.id !== writingId) throw new ConsoleError("整理结果已失效，请重新整理");
      const advice = [result.refinedText, result.suggestion].filter(Boolean).join("\n\n");
      if (action === "restore") text = result.originalText;
      else if (action === "replace" && advice) text = advice;
      else if (action === "append" && advice) text = `${existing.text}\n\n${advice}`;
      else if (action !== "ignore" || !advice) throw new ConsoleError("没有可应用的建议");
      // 建议只能消费一次，但消费后仍保留最初原文供恢复。
      if (action !== "restore") writing = { ...result, formattedText: text ?? existing.text, refinedText: "", suggestion: "" };
    }
    if (text !== undefined && text.length > NOTE_MAX_LENGTH) throw new ConsoleError(`一条记录最多 ${NOTE_MAX_LENGTH} 个字符`);
    const note = this.notes.update(existing.id, { ...(text !== undefined ? { text } : {}), writing })!;
    if (writing?.state === "pending") this.noteKinds.enqueue(note.id);
    this.noteCategories.sync(); this.noteIterations.sync();
    this.emit("update", { sessionId: "", kind: "notes" });
    return this.noteRelations.decorate([this.noteCategories.decorate(note)])[0];
  }

  updateNote(id: string, patch: { text?: unknown; images?: unknown; done?: unknown; schedule?: unknown; categoryId?: unknown; categoryIds?: unknown; reclassify?: unknown; newCategory?: unknown; categoryVersion?: unknown; kind?: unknown; reclassifyKind?: unknown; timeZone?: unknown; pinned?: unknown; writingAction?: unknown; expectedText?: unknown; writingId?: unknown }, options: { skipWriting?: boolean } = {}): Note {
    const existing = this.notes.get(String(id));
    if (!existing) throw new ConsoleError("记录不存在，可能已被删除");
    if (patch.writingAction !== undefined) {
      if (Object.keys(patch).some(key => key !== "writingAction" && key !== "expectedText" && key !== "writingId")) throw new ConsoleError("整理操作不能同时修改其他字段");
      return this.applyNoteWriting(existing, patch.writingAction, patch.expectedText, patch.writingId);
    }
    const newCategory = patch.newCategory === undefined ? undefined : noteCreateCategoryInput(patch.newCategory);
    if (newCategory && patch.categoryId !== undefined) throw new ConsoleError("分类选择与新建分类不能同时提交");
    const rawCategoryIds = patch.categoryIds !== undefined ? patch.categoryIds : patch.categoryId !== undefined ? [patch.categoryId] : undefined;
    if (rawCategoryIds !== undefined) {
      if (!Array.isArray(rawCategoryIds) || rawCategoryIds.some(value => typeof value !== "string" || !value)) throw new ConsoleError("分类列表格式不正确");
      const uniqueIds = [...new Set(rawCategoryIds as string[])];
      if (uniqueIds.length > NOTE_MAX_CATEGORIES) throw new ConsoleError(`一条记录最多 ${NOTE_MAX_CATEGORIES} 个分类`);
      if (uniqueIds.some(value => !this.noteCategories.snapshot().categories.some(c => c.id === value && c.parentId))) throw new ConsoleError("请选择一个有效二级分类");
    }
    if (newCategory?.primaryId !== undefined && !this.noteCategories.snapshot().categories.some(c => c.id === newCategory.primaryId && !c.parentId)) throw new ConsoleError("请选择有效一级分类");
    if (newCategory && patch.categoryVersion !== undefined && patch.categoryVersion !== this.noteCategories.snapshot().version) throw new ConsoleError("分类目录已变更，请刷新后再操作");
    const next: { text?: string; images?: NoteImage[]; done?: boolean; schedule?: NoteSchedule | null; kind?: NoteKind; kindSource?: "ai" | "user" | null; kindPending?: boolean; pinned?: boolean; writing?: NoteWriting | null } = {};
    if (patch.text !== undefined) {
      const body = typeof patch.text === "string" ? patch.text.trim() : "";
      if (body.length > NOTE_MAX_LENGTH) throw new ConsoleError(`一条记录最多 ${NOTE_MAX_LENGTH} 个字符`);
      next.text = body;
    }
    if (patch.images !== undefined) next.images = this.resolveNoteImages(patch.images);
    if (patch.schedule !== undefined) next.schedule = noteScheduleInput(patch.schedule);
    // 正文或时间改了就重算提醒：删掉「提前 1 小时提醒」这句话后，旧提醒不会留着。
    if (patch.schedule !== undefined || patch.text !== undefined) {
      const schedule = next.schedule !== undefined ? next.schedule : existing.schedule;
      if (schedule) next.schedule = withNoteRemind(schedule, next.text !== undefined ? next.text : existing.text);
    }
    if (patch.done !== undefined) {
      if (typeof patch.done !== "boolean") throw new ConsoleError("done 必须是布尔值");
      next.done = patch.done;
    }
    if (patch.pinned !== undefined) {
      if (typeof patch.pinned !== "boolean") throw new ConsoleError("pinned 必须是布尔值");
      next.pinned = patch.pinned;
    }
    // 大类：人工指定优先；「AI 重新判断」清掉人工标记重新排队；改了正文且不是人工指定的，也重新判断。
    if (patch.reclassifyKind !== undefined && typeof patch.reclassifyKind !== "boolean") throw new ConsoleError("reclassifyKind 必须是布尔值");
    const kind = noteKindInput(patch.kind);
    if (kind && patch.reclassifyKind === true) throw new ConsoleError("指定类型与 AI 重新判断不能同时提交");
    if (kind === "note" && next.schedule) throw new ConsoleError("笔记不能带日程时间");
    if (kind) {
      next.kind = kind; next.kindSource = "user"; next.kindPending = false;
      // 改为笔记或待办都去掉时间（日程 = 有时间的待办）；笔记也没有完成状态。
      if (next.schedule === undefined && existing.schedule) next.schedule = null;
      if (kind === "note" && existing.done && next.done === undefined) next.done = false;
    } else if (patch.reclassifyKind === true || (existing.kindSource !== "user" && patch.schedule === undefined
      && ((next.text !== undefined && next.text !== existing.text) || (next.images !== undefined && JSON.stringify(next.images.map(i => i.id)) !== JSON.stringify((existing.images ?? []).map(i => i.id)))))) {
      if (patch.reclassifyKind === true && !this.noteKinds.enabled) throw new ConsoleError("没有配置 AI 模型，无法重新判断类型");
      if (this.noteKinds.enabled) { next.kindPending = true; if (patch.reclassifyKind === true) next.kindSource = null; }
    }
    if (patch.schedule !== undefined && next.schedule && !kind) { next.kind = "todo"; next.kindSource = "user"; next.kindPending = false; }
    if (next.done === true && (next.kind ?? existing.kind) === "note") throw new ConsoleError("笔记没有完成状态，可以先改为待办");
    if ((next.text !== undefined && next.text !== existing.text)
      || (next.images !== undefined && JSON.stringify(next.images.map(i => i.id)) !== JSON.stringify((existing.images ?? []).map(i => i.id)))) {
      next.writing = !options.skipWriting && this.noteKinds.enabled && (next.text ?? existing.text) && !(next.schedule === undefined ? existing.schedule : next.schedule) ? { state: "pending" } : null;
    }
    if (next.schedule) next.writing = null;
    if (!Object.keys(next).length) throw new ConsoleError("没有要更新的内容");
    const willHaveText = next.text !== undefined ? next.text : existing.text;
    const willHaveImages = next.images !== undefined ? next.images : existing.images;
    if (!willHaveText.trim() && !(willHaveImages?.length)) throw new ConsoleError("记录不能既没有文字也没有图片");
    if (patch.reclassify !== undefined && typeof patch.reclassify !== "boolean") throw new ConsoleError("reclassify 必须是布尔值");
    const note = this.notes.update(String(id), next);
    if (!note) throw new ConsoleError("记录不存在，可能已被删除");
    if (note.kindPending || note.writing?.state === "pending") this.noteKinds.enqueue(note.id, patch.timeZone);
    this.emit("update", { sessionId: "", kind: "notes" });
    this.noteCategories.sync();
    this.noteIterations.sync();
    if (rawCategoryIds !== undefined || patch.reclassify === true || newCategory) {
      const ids = rawCategoryIds === undefined ? undefined : [...new Set(rawCategoryIds as string[])];
      const pick = newCategory
        ? { action: "create" as const, ...newCategory, ...(ids !== undefined ? { categoryIds: ids } : {}), categoryVersion: patch.categoryVersion }
        : ids?.length ? { action: "assign" as const, categoryIds: ids }
        : { action: "retry" as const };
      return this.noteCategories.decide(id, { ...pick, inputHash: this.noteCategories.decorate(note).classification.inputHash });
    }
    return this.noteRelations.decorate([this.noteCategories.decorate(note)])[0];
  }

  deleteNote(id: string): { ok: true } {
    if (!this.notes.remove(String(id))) throw new ConsoleError("记录不存在，可能已被删除");
    this.emit("update", { sessionId: "", kind: "notes" });
    this.noteCategories.sync();
    this.noteIterations.sync();
    return { ok: true };
  }

  /**
   * 归档会话时把关联的待办标记完成。幂等，且不抛错：记录已被删除或本就完成时什么也不做。
   * 这是归档的副作用，不应让归档后端因待办状态而失败。
   */
  completeNoteFromSession(noteId: string): void {
    this.completeArchivedSessionNotes([noteId]);
  }

  /**
   * 补标：把关联会话已归档的待办标记完成。启动时回填历史遗留（这些归档发生在本特性上线之前，
   * 不会再收到 archived 事件）；幂等、不抛错，返回实际改动的条数。
   */
  completeArchivedSessionNotes(noteIds: Iterable<string>): number {
    let changed = 0;
    for (const raw of noteIds) {
      const id = String(raw);
      try {
        const existing = this.notes.get(id);
        if (!existing || existing.done) continue;
        if (this.notes.update(id, { done: true })) changed++;
      } catch (e) {
        // 待办写入失败不能让启动/归档失败；记一笔供排查。
        console.error("标记关联待办失败：", e);
      }
    }
    if (changed) this.emit("update", { sessionId: "", kind: "notes" });
    return changed;
  }

  /* ------------------------------ 选文件夹 ------------------------------ */

  /** 拉起本机的文件夹选择器（新建会话选工作目录）。取消返回 null。 */
  async pickFolder(input: PickFolderInput): Promise<PickedFolder | null> {
    if (input?.purpose !== "workspace") throw new ConsoleError("purpose 只能是 workspace");
    const startDir = this.pickStart(input);
    if (this.picking) throw new ConsoleError("已经有一个文件夹选择器开着，请先在那边选好或取消");
    this.picking = true;
    let picked: string | null;
    try {
      picked = await (this.options.pickFolder ?? pickFolderNative)({ prompt: "选择工作目录", startDir });
    } catch (e) {
      throw new ConsoleError(`无法打开文件夹选择器：${(e as Error).message}`);
    } finally {
      this.picking = false;
    }
    if (picked === null) return null;
    try {
      const real = realpathSync(picked);
      if (!statSync(real).isDirectory()) throw new Error("not a directory");
      return { path: real };
    } catch {
      throw new ConsoleError(`选中的不是一个存在的文件夹：${picked}`);
    }
  }

  /** 对话框从哪里开始：已填的值（存在就用）→ 家目录。 */
  private pickStart(input: PickFolderInput): string {
    const current = typeof input.current === "string" ? input.current.trim() : "";
    for (const c of current ? [current, homedir()] : [homedir()]) {
      try {
        const real = realpathSync(c);
        if (statSync(real).isDirectory()) return real;
      } catch { /* 不存在：试下一个 */ }
    }
    return homedir();
  }

  /* --------------------------- DeepSeek token 消耗 --------------------------- */

  /** 资源页的 DeepSeek 消耗：账本（平台功能）＋ runtime 受管会话用量，按应用/功能聚合。 */
  deepseekUsageView(sessions: DeepSeekRuntimeSession[] | (() => DeepSeekRuntimeSession[]) = [], signature?: string): DeepSeekUsageView {
    return this.deepseekTracker.view({
      sessions: typeof sessions === "function" ? sessions : () => sessions,
      ...(signature !== undefined ? { signature } : {})
    });
  }

  private platformTracker(): DeepSeekUsageTracker {
    return this.deepseekPlatformTracker ??= new DeepSeekUsageTracker(join(this.options.dataDir, "deepseek-usage.jsonl"), PLATFORM_TIME_ZONE);
  }

  /** 北京时间今日的 DeepSeek 估算花费（USD）：平台功能调用 + 受管会话用量；partial 表示含未知单价模型。 */
  deepseekTodayCost(sessions: () => DeepSeekRuntimeSession[], signature?: string): { usd: number; partial: boolean } {
    const cost = this.platformTracker().view({ sessions, ...(signature !== undefined ? { signature } : {}) }).ranges.today.totals.cost;
    return { usd: cost?.total ?? 0, partial: !!cost?.partial };
  }

  /** 统计应用：北京时间按日的 DeepSeek 明细（渠道 × runtime × 发起端的 token 与估算金额）。 */
  deepseekDailyRows(sessions: () => DeepSeekRuntimeSession[], deviceOf: DeepSeekDeviceOf): DeepSeekDailyRow[] {
    return this.platformTracker().dailyRows({ sessions, deviceOf });
  }

  /* ------------------------------- 外部资源 ------------------------------- */

  /** 资源页列出的模型服务：平台模型的 provider，加上 Pi 配置里有凭据、且登记了余额接口的 provider */
  private modelProviders(): Map<string, ServiceStatus["roles"]> {
    const configDir = this.options.pi?.configDir;
    const roles = new Map<string, ServiceStatus["roles"]>();
    roles.set(PLATFORM_MODEL.provider, [{ role: "平台模型（会话标题、待办分类、推荐任务、小马伙伴）", model: PLATFORM_MODEL.model }]);
    for (const key of Object.keys(BALANCE_ADAPTERS)) {
      if (!key.startsWith("model:")) continue;
      const provider = key.slice(6);
      if (!providerCredential(provider, configDir ? { sourceAgentDir: configDir } : {})) continue;
      roles.set(provider, [...(roles.get(provider) ?? []), { role: "Pi 对话" }]);
    }
    return roles;
  }

  /** 当前联网凭据：优先使用注入值；未注入时按环境变量、本机文件与 Pi 配置查找。 */
  private webResearchKeys(): WebResearchKeys {
    return this.options.webKeys ? this.options.webKeys() : resolveWebResearchKeys(this.options.pi?.configDir ? { piAgentDir: this.options.pi.configDir } : {});
  }

  /** 两套配置的可用状态：资源页据此分组显示并决定能否切换。 */
  private webResearchOptions(): WebResearchProviderOption[] {
    const keys = this.webResearchKeys();
    const braveReady = !!(keys.brave && keys.firecrawl);
    const deepseekReady = !!keys.deepseek;
    return [
      {
        id: "brave", label: "Brave Search + Firecrawl", services: { search: "brave", fetch: "firecrawl" },
        description: "搜索用 Brave，正文抓取用 Firecrawl；需要两把密钥。",
        ready: braveReady,
        ...(braveReady ? {} : { reason: "需要 BRAVE_SEARCH_API_KEY 与 FIRECRAWL_API_KEY（或对应的 0600 密钥文件）" })
      },
      {
        id: "deepseek", label: "DeepSeek Search & Fetch", services: { search: "deepseek-search", fetch: "deepseek-fetch" },
        description: "搜索与正文抓取都由 DeepSeek 提供，共用一把 DeepSeek 密钥。",
        ready: deepseekReady,
        ...(deepseekReady ? {} : { reason: "需要 DEEPSEEK_API_KEY，或 Pi 配置里 deepseek 的 API key" })
      }
    ];
  }

  /** 保存的联网供应商选择；auto 表示跟随环境变量与可用凭据。 */
  webResearchPreference(): WebResearchProviderPreference {
    return this.webProviderSettings.read();
  }

  /** auto 时不向底层传 prefer，让 PI_AGENT_WEB_PROVIDER / 可用凭据继续生效。 */
  private webResearchPreferenceOption(): { prefer?: WebResearchProviderPreference } {
    const preference = this.webResearchPreference();
    return preference === "auto" ? {} : { prefer: preference };
  }

  /** 当前平台默认联网供应商：小马伙伴等联网调用下一次启动时使用。 */
  webResearchProvider(): WebResearchProvider | undefined {
    return resolveWebResearchProvider({
      ...(this.options.pi?.configDir ? { piAgentDir: this.options.pi.configDir } : {}),
      keys: this.webResearchKeys(),
      ...this.webResearchPreferenceOption()
    });
  }

  /** 资源页手动切换平台默认联网供应商；不可用的配置不允许切过去。 */
  setWebResearchProvider(provider: unknown): WebResearchResource {
    if (!isWebResearchProviderPreference(provider)) throw new ConsoleError("联网供应商只能是 auto、brave 或 deepseek");
    if (provider !== "auto") {
      const option = this.webResearchOptions().find((o) => o.id === provider);
      if (!option) throw new ConsoleError(`未知的联网供应商：${provider}`);
      if (!option.ready) throw new ConsoleError(`${option.label} 不可用：${option.reason}`);
    }
    this.webProviderSettings.write(provider);
    this.emit("update", { kind: "resources" });
    return this.resources().webResearch;
  }

  /**
   * 外部资源：模型服务、联网检索（小马伙伴用），以及资源扩展补充的服务（如配音）。凭据只给来源类别与指纹；最近结果来自平台调用日志；
   * 余额只读缓存（刷新另由你触发）。
   */
  resources(): { generatedAt: string; timezone: string; scope: string; services: ServiceStatus[]; webResearch: WebResearchResource; runtimeConfigs: RuntimeConfigsView } {
    const now = Date.now();
    const calls = [...this.callLog.read()];
    const cached = this.balances.all();
    const configDir = this.options.pi?.configDir;
    const roles = this.modelProviders();
    const models = [...roles.keys()].sort().map((provider) => serviceStatus({
      service: `model:${provider}`, kind: "model", label: provider,
      credential: credentialView(providerCredential(provider, configDir ? { sourceAgentDir: configDir } : {})),
      calls, roles: roles.get(provider) ?? [], ...(cached[`model:${provider}`] ? { balance: cached[`model:${provider}`] } : {}), now
    }));
    const keys = this.webResearchKeys();
    const preference = this.webResearchPreference();
    let selected: WebResearchProviderOption["id"] | undefined;
    let selectionError: string | undefined;
    try { selected = this.webResearchProvider()?.id; } catch (e) { selectionError = (e as Error).message; }
    const role = (provider: WebResearchProviderOption["id"], capability: string) => [{ role: `小马伙伴${capability}${selected === provider ? "（当前默认）" : "（备选）"}` }];
    const web = [
      serviceStatus({ service: "brave", kind: "search", label: "Brave Search", credential: credentialView(keys.brave), calls, roles: role("brave", "联网检索"), ...(cached.brave ? { balance: cached.brave } : {}), now }),
      serviceStatus({ service: "firecrawl", kind: "fetch", label: "Firecrawl", credential: credentialView(keys.firecrawl), calls, roles: role("brave", "网页阅读"), ...(cached.firecrawl ? { balance: cached.firecrawl } : {}), now }),
      serviceStatus({ service: "deepseek-search", kind: "search", label: "DeepSeek Search", credential: credentialView(keys.deepseek), calls, roles: role("deepseek", "联网检索"), ...(cached["deepseek-search"] ? { balance: cached["deepseek-search"] } : {}), now }),
      serviceStatus({ service: "deepseek-fetch", kind: "fetch", label: "DeepSeek Fetch", credential: credentialView(keys.deepseek), calls, roles: role("deepseek", "网页阅读"), ...(cached["deepseek-fetch"] ? { balance: cached["deepseek-fetch"] } : {}), now })
    ];
    const extra = (this.options.resourceProviders ?? []).flatMap((provider) => provider.services({ calls, cached, now }));
    const webResearch: WebResearchResource = { preference, ...(selected ? { selected } : {}), ...(selectionError ? { error: selectionError } : {}), options: this.webResearchOptions() };
    const dirs: Partial<Record<RuntimeKind, string>> = {
      ...this.options.runtimeConfigs?.dirs,
      ...(this.options.pi?.configDir ? { pi: this.options.runtimeConfigs?.dirs?.pi ?? this.options.pi.configDir } : {})
    };
    const runtimeConfigs = scanRuntimeConfigs({
      ...(Object.keys(dirs).length ? { dirs } : {}),
      ...(this.options.runtimeConfigs?.home ? { home: this.options.runtimeConfigs.home } : {}),
      now
    });
    return { generatedAt: new Date(now).toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, scope: "本机记录（本控制台数据目录）", services: [...models, ...web, ...extra], webResearch, runtimeConfigs };
  }

  /**
   * 只读缓存、不发请求的余额（会话列表底部的弱化摘要用）：列表每次轮询都会读一次，
   * 不能顺手去请求服务商。最近一次读取时间留在 balance.fetchedAt 里。
   */
  modelBalancesCached(providers: string[]): Array<{ provider: string; balance: BalanceView }> {
    const configDir = this.options.pi?.configDir;
    const list = [...new Set(providers)].filter((p) => { const a = BALANCE_ADAPTERS[`model:${p}`]; return a && !("unsupported" in a); }).sort();
    const now = Date.now(), cached = this.balances.all();
    return list.map((provider) => ({
      provider,
      balance: balanceViewOf(`model:${provider}`, !!providerCredential(provider, configDir ? { sourceAgentDir: configDir } : {}), cached[`model:${provider}`], now)
    }));
  }

  /**
   * 运行时页面（Pi 用到的 DeepSeek / OpenRouter）要显示的模型服务余额。
   * 有登记只读余额接口的 provider 才返回；缓存没有或超过 10 分钟就顺带读一次（同一服务同时只发一个请求），
   * 最多等 waitMs，来不及就先给缓存值、读到的结果下次再显示。密钥只在服务端使用。
   */
  async modelBalances(providers: string[], opts: { waitMs?: number } = {}): Promise<Array<{ provider: string; balance: BalanceView }>> {
    const configDir = this.options.pi?.configDir;
    const list = [...new Set(providers)].filter((p) => { const a = BALANCE_ADAPTERS[`model:${p}`]; return a && !("unsupported" in a); }).sort();
    const configured = new Map(list.map((p) => [p, !!providerCredential(p, configDir ? { sourceAgentDir: configDir } : {})]));
    const cached = this.balances.all();
    const reads: Promise<unknown>[] = [];
    for (const p of list) {
      const service = `model:${p}`, at = cached[service]?.fetchedAt;
      if (!configured.get(p) || (at && Date.now() - Date.parse(at) < BALANCE_AUTO_REFRESH_MS)) continue;
      let read = this.balanceReads.get(service);
      if (!read) {
        read = this.refreshBalance(service).catch(() => undefined).finally(() => this.balanceReads.delete(service));
        this.balanceReads.set(service, read);
      }
      reads.push(read);
    }
    if (reads.length) await Promise.race([Promise.all(reads), new Promise((r) => setTimeout(r, opts.waitMs ?? 0))]);
    const now = Date.now(), fresh = this.balances.all();
    return list.map((provider) => ({ provider, balance: balanceViewOf(`model:${provider}`, configured.get(provider)!, fresh[`model:${provider}`], now) }));
  }

  /**
   * 手动刷新某个服务的余额——只调用登记过的只读接口（服务端发起，密钥不出服务端），
   * 限时 8 秒、同一服务 60 秒内不重复请求；失败保留上次成功值并标为非实时。
   */
  async refreshBalance(service: string): Promise<BalanceView> {
    const adapter = BALANCE_ADAPTERS[service] ?? this.options.resourceProviders?.map((provider) => provider.balance?.[service]).find(Boolean);
    if (!adapter) throw new ConsoleError(`没有这个服务：${service}`);
    if ("unsupported" in adapter) return { status: "unavailable", reason: adapter.unsupported, consoleUrl: adapter.consoleUrl };
    const prev = this.balances.all()[service];
    if (prev?.fetchedAt && Date.now() - Date.parse(prev.fetchedAt) < BALANCE_MIN_REFRESH_MS) {
      throw new ConsoleConflict(`刚刚刷新过（${prev.fetchedAt}），${BALANCE_MIN_REFRESH_MS / 1000} 秒内不重复请求服务商`);
    }
    const configDir = this.options.pi?.configDir;
    const keys = this.webResearchKeys();
    const found = service === "firecrawl" ? keys.firecrawl : service === "brave" ? keys.brave
      : service === "deepseek-search" || service === "deepseek-fetch" ? keys.deepseek
        : service.startsWith("model:") ? providerCredential(service.slice(6), configDir ? { sourceAgentDir: configDir } : {}) : undefined;
    const fetchedAt = new Date().toISOString();
    let view: BalanceView;
    if (!found) view = { status: "unavailable", reason: "本机没有配置凭据", fetchedAt };
    else {
      try { view = { ...(await adapter.read(found.key, this.options.fetch ?? fetch, 8000)), fetchedAt }; }
      catch (e) { view = { status: "unavailable", reason: (e as Error).name === "AbortError" ? "请求超时（8 秒）" : "请求失败（网络或服务商错误）", fetchedAt }; }
    }
    this.balances.put(service, view);
    this.emit("update", { kind: "balances", service });
    return this.resources().services.find((s) => s.service === service)?.balance ?? view;
  }
}

/** 调用方输入有误（400） */
export class ConsoleError extends Error {
  readonly code: string = "CONSOLE_INPUT_INVALID";
}

/** 与当前状态冲突（409） */
export class ConsoleConflict extends ConsoleError {
  override readonly code = "CONSOLE_CONFLICT";
}
