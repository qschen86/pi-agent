/**
 * 运行时之间共享的契约类型：执行边界（OS 守卫）的策略与准备结果、联网检索的操作与来源记录。
 *
 * 2026-10-18：旧任务链路的 RuntimeAdapter / 脚本执行协议已删除。
 */

/** 一次联网操作（v2.3）：进入预算的搜索或阅读。同一 opId 再记一次即更新（登记 → 回填）。 */
export interface WebOpRecord {
  /** 本轮内唯一：搜索用 searchId（q1…），阅读用 o1… */
  opId: string;
  kind: "search" | "open";
  /** 实际调用的上游服务（brave/firecrawl/deepseek-search/deepseek-fetch）；旧记录没有 */
  service?: string;
  /** 平台补上：属于哪一次执行尝试 */
  attemptId?: string;
  toolCallId?: string;
  searchId: string;
  resultId?: string;
  query?: string;
  startedAt: string;
  completedAt?: string;
  status: "pending" | "ok" | "failed";
  /** 搜索：实际返回给执行方的结果数、被来源范围或地址安全规则剔除的数 */
  returned?: number;
  filtered?: number;
  /** 阅读成功：进入来源台账的编号 */
  sourceId?: string;
  /** 失败：可公开的稳定类别（不含密钥、请求头或网页正文） */
  errorClass?: string;
}

export interface WebOpLog {
  record(op: WebOpRecord): void;
}

/** 一条实际读过的网页来源（v1.8）。只记平台亲自取回的内容，模型自写的 URL 不算。 */
export interface WebSourceRecord {
  /** v2.3：平台补上，属于哪一次执行尝试（searchId 每轮从 q1 编号，靠它区分） */
  attemptId?: string;
  /** 本会话内的来源编号：S1、S2……（跨轮次连续编号） */
  sourceId: string;
  url: string;
  title: string;
  media?: string;
  /** 网页自己的发布时间；没有就是 null——不能拿抓取时间冒充 */
  publishedAt: string | null;
  /** 检索时间与读取时间（平台时钟） */
  searchedAt: string;
  readAt: string;
  query: string;
  searchId: string;
  resultId: string;
  toolCallId: string;
  /** 智谱返回的 request_id（审计与对账用） */
  upstreamRequestId?: string;
  contentHash: string;
  truncated: boolean;
  chars: number;
  /** 页面正文全长（字符，去掉导航、链接与图片等页面框架之后）：超过每页上限时，据此看出少读了多少 */
  fullChars?: number;
  /** 清洗前的字符数（含页面框架） */
  rawChars?: number;
  /** 本页正文分成几段、这是第几段（接着读后面的段时 > 1） */
  part?: number;
  parts?: number;
  /**
   * 为什么读这一条（检索策略）：basis 为 official / media / top3，旧调用为 unspecified；why 是执行 Agent 的一句话理由；
   * rank 是它在那次搜索结果里的顺序；sourceKind 是平台按域名给的类型提示（政府与监管机构、权威媒体）
   */
  selection?: { basis: "official" | "media" | "top3" | "unspecified"; why?: string; rank: number; sourceKind?: "government" | "media" };
}

export interface WebSourceLedger {
  /** content：读到并交给 Agent 的正文（v2.1：按内容哈希保存，用于核对调研报告里的摘录） */
  record(source: Omit<WebSourceRecord, "sourceId">, content?: string): WebSourceRecord;
  list(): WebSourceRecord[];
}

export * from "./runtime-guard.js";
