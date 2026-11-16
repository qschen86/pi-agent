/**
 * Web Research Broker：运行在平台侧（宿主进程），替 Agent 调用搜索与网页阅读上游。
 *
 * Agent 只拿到有界、编号化的结果：
 *   - web.search → 本会话的 searchId + 结果编号 R1…Rn（标题、URL、摘要、网页发布时间、检索时间）
 *   - web.open   → 只能打开本会话搜索结果里的某一条（不接受任意 URL），返回来源编号 S#、正文节选、读取时间
 * 平台负责：参数校验、URL 安全、按来源范围逐次询问网关（决策入审计）、预算、来源台账、稳定的错误分类。
 * 密钥只在客户端里：不出现在返回值、错误、日志中。网页内容是不可信数据，原样作为数据返回，不改变任何权限。
 */
import { createHash } from "node:crypto";
import type { WebOpLog, WebOpRecord, WebSourceLedger, WebSourceRecord } from "@pi-agent/runtime-contracts";
import { checkPublicHttpsUrl } from "./url-safety.js";
import { UpstreamError } from "./zhipu.js";
import { sourceKindOf } from "./source-kinds.js";
import { cleanPageText } from "./clean.js";
import type { SourceKind } from "./source-kinds.js";
import { BraveSearchError } from "./brave.js";
import { DeepSeekError } from "./deepseek.js";
import { FirecrawlError } from "./firecrawl.js";
import type { ZhipuSearchResponse, ZhipuToolsClient } from "./zhipu.js";

export type BrokerErrorCode =
  | "CONFIG_MISSING" | "INVALID_INPUT" | "POLICY_DENIED" | "UNKNOWN_RESULT" | "BUDGET_EXHAUSTED"
  | "TOOL_ERROR" | "PROTOCOL_ERROR" | "REQUEST_FAILED" | "AUTH_FAILED" | "QUOTA_EXHAUSTED" | "RATE_LIMITED" | "TIMEOUT" | "UPSTREAM_ERROR" | "UNREADABLE"
  | "ALREADY_READ";

/**
 * 挑选阅读的依据（检索策略）：先判断结果与调研是否相关；相关的里面优先官网（政府、监管机构或对象自己的官网），
 * 其次权威媒体；都没有，才按结果顺序从前三条里选。
 */
export type ReadBasis = "official" | "media" | "top3";
export const READ_BASES: readonly ReadBasis[] = ["official", "media", "top3"];

export class BrokerError extends Error {
  constructor(readonly code: BrokerErrorCode, message: string) {
    super(message);
  }
}

export interface BrokerBudget {
  /** 本轮最多搜索几次 */
  searches: number;
  /** 本轮最多读几个页面 */
  opens: number;
  /** 单次搜索最多几条结果（首版默认 5、上限 10） */
  maxResults: number;
  /** 单页正文最多返回多少字符 */
  maxPageChars: number;
  /** 本轮累计返回的正文字符上限 */
  maxTotalChars: number;
}

export const DEFAULT_BROKER_BUDGET: BrokerBudget = { searches: 8, opens: 8, maxResults: 10, maxPageChars: 12_000, maxTotalChars: 60_000 };

const RECENCY: Record<string, "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit"> = {
  day: "oneDay", week: "oneWeek", month: "oneMonth", year: "oneYear", any: "noLimit"
};

export interface BrokerCheckpoint { failedReads?: Array<[string, { code: BrokerErrorCode; message: string }]>; readUrls?: Array<[string, { sourceId: string; title: string }]>; searchSeq: number; searches: Array<[string, StoredSearch]>; used: { searches: number; opens: number; chars: number } }

export interface BrokerOptions {
  checkpoint?: BrokerCheckpoint;
  /** 没有客户端 = 没配置密钥：每次调用都如实报「搜索服务不可用」 */
  client?: ZhipuToolsClient;
  /** 按计划的来源范围逐次判定一个域名（网关决策，入审计）；返回 ALLOW 才能读 */
  decideDomain: (domain: string) => { effect: string; reason: string; decisionId?: string };
  ledger: WebSourceLedger;
  /** v2.3：联网操作记录（进入预算即登记、完成回填；失败也记） */
  opLog?: WebOpLog;
  budget?: Partial<BrokerBudget>;
  now?: () => Date;
  /** 上游 429/5xx 的重试次数（不确定是否成功的超时不重试） */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** 记录这次调用实际走到哪个上游服务（资源页按它汇总）；不传则沿用旧的 brave/firecrawl 推断 */
  services?: { search: string; fetch: string };
}

interface StoredResult { resultId: string; title: string; url: string; host: string; media?: string; publishedAt: string | null; snippet: string; sourceKind?: SourceKind }
interface StoredSearch { searchId: string; query: string; searchedAt: string; results: StoredResult[] }

export interface SearchOutput {
  searchId: string;
  query: string;
  searchedAt: string;
  /** sourceKind：平台按域名给的来源类型提示；readAs：本轮已经读过，直接引用这个来源编号 */
  results: Array<{ resultId: string; title: string; url: string; media?: string; publishedAt: string | null; snippet: string; sourceKind?: SourceKind; readAs?: string }>;
  /** 因来源范围或 URL 不安全而被剔除的结果数 */
  filtered: number;
  upstreamRequestId?: string;
}

export interface OpenOutput {
  sourceId: string;
  url: string;
  title: string;
  publishedAt: string | null;
  searchedAt: string;
  readAt: string;
  content: string;
  /** 后面还有没读的段 */
  truncated: boolean;
  /** 本页正文（清洗后）分成几段、这是第几段；清洗前后的字数 */
  part: number;
  parts: number;
  fullChars: number;
  rawChars: number;
}

export class WebResearchBroker {
  private readonly budget: BrokerBudget;
  private readonly searches = new Map<string, StoredSearch>();
  private searchSeq = 0;
  private readonly failedReads = new Map<string, { code: BrokerErrorCode; message: string }>();
  /** 本轮已读过的页面（URL；第 2 段起为 URL#段号 → 来源编号）：同一页面同一段不重复读、不重复扣预算 */
  private readonly readUrls = new Map<string, { sourceId: string; title: string }>();
  /** 本轮读到并清洗过的页面：接着读后面的段时不再向阅读服务取（重启后丢失，续读时重新取） */
  private readonly pages = new Map<string, { url: string; title: string; requestId?: string; text: string; rawChars: number; rawHash: string }>();
  private used = { searches: 0, opens: 0, chars: 0 };

  constructor(private readonly o: BrokerOptions) {
    this.budget = { ...DEFAULT_BROKER_BUDGET, ...(o.budget ?? {}) };
    if (o.checkpoint) {
      this.searchSeq = o.checkpoint.searchSeq;
      for (const [url, error] of o.checkpoint.failedReads ?? []) this.failedReads.set(url, error);
      for (const [url, read] of o.checkpoint.readUrls ?? []) this.readUrls.set(url, read);
      this.used = { ...o.checkpoint.used };
      for (const [id, search] of o.checkpoint.searches) this.searches.set(id, structuredClone(search));
    }
  }

  checkpoint(): BrokerCheckpoint {
    return structuredClone({ failedReads: [...this.failedReads], readUrls: [...this.readUrls], searchSeq: this.searchSeq, searches: [...this.searches], used: this.used });
  }

  usage(): { searches: number; opens: number; chars: number; budget: BrokerBudget } {
    return { ...this.used, budget: this.budget };
  }

  /** 登记失败不影响检索本身 */
  private op(record: WebOpRecord): void {
    try { this.o.opLog?.record(record); } catch { /* 记录失败不改变结果 */ }
  }

  async search(input: { query?: unknown; count?: unknown; recency?: unknown; sourceDomain?: unknown }, toolCallId?: string): Promise<SearchOutput> {
    const client = this.requireClient();
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) throw new BrokerError("INVALID_INPUT", "query 不能为空");
    if ([...query].length > 70) throw new BrokerError("INVALID_INPUT", "query 最多 70 个字符，请拆成更短的查询");
    const count = input.count === undefined ? 5 : Number(input.count);
    if (!Number.isInteger(count) || count < 1 || count > this.budget.maxResults) {
      throw new BrokerError("INVALID_INPUT", `count 必须是 1～${this.budget.maxResults} 的整数`);
    }
    let recency: (typeof RECENCY)[string] | undefined;
    if (input.recency !== undefined) {
      recency = RECENCY[String(input.recency)];
      if (!recency) throw new BrokerError("INVALID_INPUT", `recency 只能是 ${Object.keys(RECENCY).join(" / ")}`);
    }
    let domainFilter: string | undefined;
    if (input.sourceDomain !== undefined) {
      domainFilter = String(input.sourceDomain).trim().toLowerCase();
      const d = this.o.decideDomain(domainFilter);
      if (d.effect !== "ALLOW") throw new BrokerError("POLICY_DENIED", `来源域名 ${domainFilter} 不在授权范围内：${d.reason}`);
    }
    if (this.used.searches >= this.budget.searches) throw new BrokerError("BUDGET_EXHAUSTED", `本轮搜索次数已用完（${this.budget.searches} 次），请用已有结果完成任务`);
    this.used.searches += 1; // 调用前预扣：失败也计数
    // v2.3：进入预算即分配编号并登记（失败的搜索同样有编号与记录）
    const searchId = `q${++this.searchSeq}`;
    const startedAt = this.now();
    const base = { opId: searchId, kind: "search" as const, ...(this.o.services ? { service: this.o.services.search } : {}), ...(toolCallId ? { toolCallId } : {}), searchId, query, startedAt };
    this.op({ ...base, status: "pending" });
    let res: Awaited<ReturnType<ZhipuToolsClient["search"]>>;
    try {
      res = await this.withRetry(() => client.search({
        search_query: query, search_engine: "search_std", count,
        ...(recency ? { search_recency_filter: recency } : {}),
        ...(domainFilter ? { search_domain_filter: domainFilter } : {})
      }));
    } catch (e) {
      this.op({ ...base, status: "failed", completedAt: this.now(), errorClass: e instanceof BrokerError ? e.code : "UPSTREAM_ERROR" });
      throw e;
    }
    const searchedAt = this.now();
    // 上游返回的条数可能多于 count：剔除之后再截到 count，编号不会超出 R{count}
    const screened = this.screen(res);
    const results = screened.results.slice(0, count);
    const filtered = screened.filtered;
    this.searches.set(searchId, { searchId, query, searchedAt, results });
    this.op({ ...base, status: "ok", completedAt: searchedAt, returned: results.length, filtered });
    return {
      searchId, query, searchedAt, filtered,
      results: results.map(({ host: _h, ...r }) => ({ ...r, ...(this.readUrls.get(r.url) ? { readAs: this.readUrls.get(r.url)!.sourceId } : {}) })),
      ...(res.request_id ? { upstreamRequestId: res.request_id } : {})
    };
  }

  async open(input: { searchId?: unknown; resultId?: unknown; basis?: unknown; why?: unknown; part?: unknown }, toolCallId: string): Promise<OpenOutput> {
    const part = input.part === undefined || input.part === null ? 1 : Number(input.part);
    if (!Number.isInteger(part) || part < 1 || part > 50) throw new BrokerError("INVALID_INPUT", "part 是第几段，从 1 开始的整数");
    const client = this.requireClient();
    const search = this.searches.get(String(input.searchId ?? ""));
    const hit = search?.results.find((r) => r.resultId === String(input.resultId ?? ""));
    if (!search || !hit) {
      throw new BrokerError("UNKNOWN_RESULT", `没有 ${String(input.searchId)}/${String(input.resultId)}：只能打开本轮 web_search 返回的结果（不接受任意 URL）`);
    }
    const allow = this.o.decideDomain(hit.host);
    if (allow.effect !== "ALLOW") throw new BrokerError("POLICY_DENIED", `来源域名 ${hit.host} 不在授权范围内：${allow.reason}`);
    // 检索策略：说明挑它的依据（不扣预算的校验放在预扣之前）
    const selection = this.selection(search, hit, input);
    const key = (url: string) => (part === 1 ? url : `${url}#${part}`);
    const already = this.readUrls.get(key(hit.url));
    if (already) throw new BrokerError("ALREADY_READ", `这个页面${part > 1 ? `的第 ${part} 段` : ""}本轮已经读过：来源 [${already.sourceId}]（${already.title}），直接引用它；未扣阅读预算`);
    const previous = this.failedReads.get(hit.url);
    if (previous) throw new BrokerError(previous.code, previous.message + "；本轮该页面已失败，请换来源（未再次扣阅读预算）");
    // 接着读同一页的后面几段不算新的阅读次数（不重新检索、通常也不重新取页），只计正文字数
    if (part === 1 && this.used.opens >= this.budget.opens) throw new BrokerError("BUDGET_EXHAUSTED", `本轮阅读次数已用完（${this.budget.opens} 次），请用已有来源完成任务`);
    if (this.used.chars >= this.budget.maxTotalChars) throw new BrokerError("BUDGET_EXHAUSTED", "本轮累计正文字数已达上限，请用已有来源完成任务");
    if (part === 1) this.used.opens += 1;
    // v2.3：进入预算即登记（失败的阅读同样有记录，不伪装成已读）
    const base = { opId: part === 1 ? `o${this.used.opens}` : `o${this.used.opens}.${part}`, kind: "open" as const, ...(this.o.services ? { service: this.o.services.fetch } : {}), toolCallId, searchId: search.searchId, resultId: hit.resultId, startedAt: this.now() };
    this.op({ ...base, status: "pending" });
    try {
      const out = await this.readPage(client, search, hit, toolCallId, selection, part);
      this.readUrls.set(key(hit.url), { sourceId: out.sourceId, title: out.title });
      if (out.url !== hit.url) this.readUrls.set(key(out.url), { sourceId: out.sourceId, title: out.title });
      this.op({ ...base, status: "ok", completedAt: out.readAt, sourceId: out.sourceId });
      return out;
    } catch (e) {
      this.op({ ...base, status: "failed", completedAt: this.now(), errorClass: e instanceof BrokerError ? e.code : "UPSTREAM_ERROR" });
      throw e;
    }
  }

  /**
   * 挑选依据的校验：basis 为 official（政府、监管机构或对象自己的官网）、media（平台名单里的权威媒体）
   * 或 top3（相关结果里没有官网与权威媒体时，按顺序从前三条里选）。没给依据的旧调用照旧放行、记为未说明。
   */
  private selection(search: StoredSearch, hit: StoredResult, input: { basis?: unknown; why?: unknown }): NonNullable<WebSourceRecord["selection"]> {
    const rank = search.results.indexOf(hit) + 1;
    const base = { rank, ...(hit.sourceKind ? { sourceKind: hit.sourceKind } : {}) };
    if (input.basis === undefined && input.why === undefined) return { ...base, basis: "unspecified" };
    const basis = String(input.basis ?? "") as ReadBasis;
    if (!READ_BASES.includes(basis)) throw new BrokerError("INVALID_INPUT", "basis 只能是 official（官网）、media（权威媒体）或 top3（都没有时从前三条里选）");
    const why = typeof input.why === "string" ? input.why.trim() : "";
    if (!why) throw new BrokerError("INVALID_INPUT", "请用一句话说明这条结果与调研的哪个问题相关、为什么选它（why）");
    if ([...why].length > 200) throw new BrokerError("INVALID_INPUT", "why 最多 200 个字符");
    if (basis === "top3" && rank > 3) {
      throw new BrokerError("INVALID_INPUT", `${hit.resultId} 是第 ${rank} 条：只有相关结果里没有官网和权威媒体时，才按顺序从前三条里选；它若是官网或权威媒体请写明对应依据，否则换前三条里相关的`);
    }
    if (basis === "media" && hit.sourceKind !== "media") {
      throw new BrokerError("INVALID_INPUT", `${hit.host} 不在平台的权威媒体名单里：它若是对象或机构的官网请写 official，否则按「前三条」规则挑选`);
    }
    return { ...base, basis, why };
  }

  /** 取页（或用本轮缓存）并做本地清洗：去掉导航、分享按钮、链接列表、图片等页面框架，只留正文 */
  private async fetchPage(client: ZhipuToolsClient, hit: StoredResult): Promise<{ url: string; title: string; requestId?: string; text: string; rawChars: number; rawHash: string }> {
    const cached = this.pages.get(hit.url);
    if (cached) return cached;
    const res = await this.withRetry(() => client.read({ url: hit.url, return_format: "markdown", retain_images: false, timeout: 20 })).catch((e: unknown) => {
      const err = classify(e);
      if (err.code === "TOOL_ERROR" || err.code === "UNREADABLE") this.failedReads.set(hit.url, { code: err.code, message: err.message });
      throw err;
    });
    const rr = res.reader_result ?? {};
    let sourceUrl = hit.url;
    // 重定向之后的最终地址同样要过检查
    if (rr.url && rr.url !== hit.url) {
      const final = checkPublicHttpsUrl(rr.url);
      if (!final.ok) throw new BrokerError("UNREADABLE", `页面跳转到了不安全的地址：${final.reason}`);
      const d = this.o.decideDomain(final.host);
      if (d.effect !== "ALLOW") throw new BrokerError("POLICY_DENIED", `页面跳转到了授权范围外的域名 ${final.host}`);
      sourceUrl = final.url;
    }
    const raw = (rr.content ?? "").trim();
    const cleaned = cleanPageText(raw);
    // 清洗规则把整页都当成了框架（极短的页面）：不因启发式规则让页面变得不可读，退回原文
    const text = cleaned.text || stripImages(raw).trim();
    if (!text) throw new BrokerError("UNREADABLE", "页面没有可读的正文（不会编造内容，请换一条结果）");
    const page = { url: sourceUrl, title: (rr.title || hit.title || sourceUrl).slice(0, 300), ...(res.request_id ? { requestId: res.request_id } : {}),
      text, rawChars: cleaned.rawChars, rawHash: `sha256:${createHash("sha256").update(stripImages(raw).trim()).digest("hex")}` };
    this.pages.set(hit.url, page);
    return page;
  }

  private async readPage(client: ZhipuToolsClient, search: StoredSearch, hit: StoredResult, toolCallId: string, selection: NonNullable<WebSourceRecord["selection"]>, part = 1): Promise<OpenOutput> {
    const page = await this.fetchPage(client, hit);
    const body = page.text;
    const parts = Math.max(1, Math.ceil(body.length / this.budget.maxPageChars));
    const start = (part - 1) * this.budget.maxPageChars;
    if (start >= body.length) throw new BrokerError("INVALID_INPUT", `本页正文（去掉页面框架后 ${body.length} 字）只有 ${parts} 段，没有第 ${part} 段`);
    const room = Math.min(this.budget.maxPageChars, this.budget.maxTotalChars - this.used.chars);
    const content = body.slice(start, start + room);
    const truncated = start + content.length < body.length;
    this.used.chars += content.length;
    const readAt = this.now();
    const sourceUrl = page.url;
    const res = { request_id: page.requestId };
    const rr = { title: page.title };
    const source: WebSourceRecord = this.o.ledger.record({
      url: sourceUrl,
      title: `${(rr.title || hit.title || sourceUrl).slice(0, 280)}${part > 1 ? `（第 ${part} 段）` : ""}`,
      ...(hit.media ? { media: hit.media } : {}),
      publishedAt: hit.publishedAt,
      searchedAt: search.searchedAt,
      readAt,
      query: search.query,
      searchId: search.searchId,
      resultId: hit.resultId,
      toolCallId,
      ...(res.request_id ? { upstreamRequestId: res.request_id } : {}),
      // 第 1 段沿用整页的哈希；后面的段各有自己的哈希（平台按它保存这一段的正文，报告摘录据此核对）
      contentHash: part === 1 ? page.rawHash : `sha256:${createHash("sha256").update(`${page.rawHash}#${part}\n${content}`).digest("hex")}`,
      truncated,
      chars: content.length,
      fullChars: body.length,
      rawChars: page.rawChars,
      part, parts,
      selection
    }, content);
    return { sourceId: source.sourceId, url: source.url, title: source.title, publishedAt: source.publishedAt, searchedAt: search.searchedAt, readAt, content, truncated, part, parts, fullChars: body.length, rawChars: page.rawChars };
  }

  /** 剔除不安全或范围外的结果；编号在剔除之后连续分配。 */
  private screen(res: ZhipuSearchResponse): { results: StoredResult[]; filtered: number } {
    const results: StoredResult[] = [];
    let filtered = 0;
    for (const r of res.search_result ?? []) {
      const check = checkPublicHttpsUrl(r.link ?? "");
      if (!check.ok || this.o.decideDomain(check.host).effect !== "ALLOW") { filtered += 1; continue; }
      results.push({
        resultId: `R${results.length + 1}`,
        title: (r.title ?? "").slice(0, 200) || check.url,
        url: check.url,
        host: check.host,
        ...(r.media ? { media: r.media.slice(0, 80) } : {}),
        publishedAt: r.publish_date ? r.publish_date : null,
        snippet: (r.content ?? "").replace(/\s+/g, " ").slice(0, 300),
        ...(sourceKindOf(check.host) ? { sourceKind: sourceKindOf(check.host) } : {})
      });
    }
    return { results, filtered };
  }

  private requireClient(): ZhipuToolsClient {
    if (!this.o.client) throw new BrokerError("CONFIG_MISSING", "联网检索不可用：没有配置 DeepSeek 密钥，或 Brave Search 与 Firecrawl 密钥");
    return this.o.client;
  }

  private now(): string {
    return (this.o.now ?? (() => new Date()))().toISOString();
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    const retries = this.o.retries ?? 2;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const err = classify(e);
        const retryable = err.code === "RATE_LIMITED" || err.code === "UPSTREAM_ERROR";
        if (!retryable || attempt >= retries) throw err;
        await sleep(500 * 2 ** attempt);
      }
    }
  }
}

function classify(e: unknown): BrokerError {
  if (e instanceof BrokerError) return e;
  if (e instanceof BraveSearchError) {
    if (e.kind === "PROTOCOL") return new BrokerError("PROTOCOL_ERROR", "Brave Search 应答格式与客户端约定不符");
    if (e.kind === "TIMEOUT") return new BrokerError("TIMEOUT", "请求 Brave Search 超时");
    if (e.status === 401 || e.status === 403) return new BrokerError("AUTH_FAILED", "Brave Search 拒绝了密钥（401/403）");
    if (e.status === 429) return new BrokerError("RATE_LIMITED", "Brave Search 限流，请稍后再试");
    if (e.status >= 500) return new BrokerError("UPSTREAM_ERROR", "Brave Search 服务异常，请稍后再试");
    return new BrokerError("REQUEST_FAILED", "Brave Search 请求失败，请检查配置或查询");
  }
  if (e instanceof DeepSeekError) {
    const name = e.operation === "search" ? "DeepSeek Search" : "DeepSeek Fetch";
    if (e.kind === "PROTOCOL") return new BrokerError("PROTOCOL_ERROR", `${name} 应答格式与客户端约定不符`);
    if (e.kind === "TIMEOUT") return new BrokerError("TIMEOUT", `请求 ${name} 超时`);
    if (e.status === 401) return new BrokerError("AUTH_FAILED", "DeepSeek 拒绝了密钥（401）：请检查 DEEPSEEK_API_KEY 或 Pi 配置里的 DeepSeek 凭据");
    if (e.status === 402) return new BrokerError("QUOTA_EXHAUSTED", "DeepSeek 账户余额不足（402），请充值后重试");
    if (e.operation === "read" && (e.status === 403 || e.status === 404)) return new BrokerError("UNREADABLE", `${name} 未能取得可读页面（${e.status}）：页面不可用、被站点策略拦截或没有可提取正文，请换来源`);
    if (e.status === 408) return new BrokerError("TIMEOUT", `请求 ${name} 超时（408）`);
    if (e.status === 429) return new BrokerError("RATE_LIMITED", "DeepSeek 搜索/抓取限流（429），请稍后再试");
    if (e.status >= 500) return new BrokerError("UPSTREAM_ERROR", "DeepSeek 服务异常，请稍后再试");
    return new BrokerError("REQUEST_FAILED", `${name} 请求失败（${e.status || "网络"}），请检查配置或更换来源`);
  }
  if (e instanceof FirecrawlError) {
    if (e.kind === "PROTOCOL") return new BrokerError("PROTOCOL_ERROR", "Firecrawl 应答格式与客户端约定不符");
    if (e.kind === "TIMEOUT") return new BrokerError("TIMEOUT", "请求 Firecrawl 超时");
    if (e.kind === "PAGE_STATUS" || e.kind === "REJECTED") return new BrokerError("UNREADABLE", "Firecrawl 未能取得可读的页面，请换来源");
    if (e.status === 401 || e.status === 403) return new BrokerError("AUTH_FAILED", "Firecrawl 拒绝了密钥（401/403）");
    if (e.status === 402) return new BrokerError("QUOTA_EXHAUSTED", "Firecrawl 额度不足");
    if (e.status === 429) return new BrokerError("RATE_LIMITED", "Firecrawl 限流，请稍后再试");
    if (e.status >= 500) return new BrokerError("UPSTREAM_ERROR", "Firecrawl 服务异常，请稍后再试");
    return new BrokerError("REQUEST_FAILED", "Firecrawl 请求失败，请检查配置或更换来源");
  }
  if (e instanceof UpstreamError) {
    if (e.upstreamCode === "TOOL_ERROR") return new BrokerError("TOOL_ERROR", "智谱 MCP 工具执行失败（HTTP 200，TOOL_ERROR）；原因未提供可安全展示的细节，阅读失败请换来源，不要重复请求同一页面");
    if (e.upstreamCode === "PROTOCOL") return new BrokerError("PROTOCOL_ERROR", "智谱 MCP 应答格式与客户端约定不符，需要检查服务兼容性");
    if (e.upstreamCode === "1113") return new BrokerError("QUOTA_EXHAUSTED", "智谱 Coding Plan MCP 无可用额度：请检查套餐剩余额度及密钥所属套餐；未切换到普通计费 API");
    if (e.status === 401 || e.status === 403) return new BrokerError("AUTH_FAILED", "智谱拒绝了密钥（401/403）：请检查工具 API 密钥");
    if (e.status === 429 || e.upstreamCode === "1701" || e.upstreamCode === "1302") return new BrokerError("RATE_LIMITED", "智谱限流，请稍后再试");
    if (e.upstreamCode === "TIMEOUT") return new BrokerError("TIMEOUT", "请求智谱超时");
    if (e.status >= 500 || e.upstreamCode === "1702" || e.upstreamCode === "1703") return new BrokerError("UPSTREAM_ERROR", "智谱服务异常，请稍后再试");
    return new BrokerError("REQUEST_FAILED", "智谱请求被拒绝，无法判定为临时故障；请检查请求或更换来源");
  }
  return new BrokerError("UPSTREAM_ERROR", "检索服务请求失败，请稍后再试");
}

/** 去掉 Markdown 图片（即使 retain_images=false，智谱仍会带回图片链接）。 */
export function stripImages(md: string): string {
  return md.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\n{3,}/g, "\n\n");
}

/** 进程内的来源台账（测试与单进程使用）；引擎里另有持久化版本。 */
export function memoryLedger(initial: WebSourceRecord[] = []): WebSourceLedger {
  const items = [...initial];
  return {
    record(source) {
      const rec = { ...source, sourceId: `S${items.length + 1}` } as WebSourceRecord;
      items.push(rec);
      return rec;
    },
    list: () => [...items]
  };
}
