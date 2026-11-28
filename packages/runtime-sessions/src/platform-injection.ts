/**
 * 平台首轮注入（公共记忆）的只读视图。
 *
 * 派发时平台把 `【平台公共记忆】…` 补在提示词最前面，同时在会话里留一条通知事件，
 * 事件上的 `injection` 字段带着那份正文。会话侧栏的「记忆」卡片取这里的数据，
 * 点开就能看到当时实际注入了什么（正文随规则增删会变，事后无法从数据文件还原）。
 */
import { ruleTitleOf } from "./memory-enforcement.js";
import type { PlatformEnforcement, ProjectedEvent } from "./types.js";

export interface PlatformInjectionItem {
  key: string;
  /** 注入块名字：平台公共记忆 */
  label: string;
  /** 会话里那条通知的原话，与时间线保持一致 */
  notice: string;
  /** 实际补进提示词的正文 */
  text: string;
  /** 常驻注入的条数 */
  count: number;
  /** 只给指针、按需查阅的条数 */
  onDemand?: number;
  /** 正文长度（按字符算，和中文计字一致） */
  chars: number;
  /** 这次注入时登记到会话的强约束检测规则（每轮结束后平台据此检查） */
  rules?: Array<{ topicId: string; ruleId: string; topic: string; statement: string; title: string }>;
  turnNo?: number;
  at: string;
}

/** 强约束记忆的一次回合结束校验：卡片里一条记录，点开看每条规则的结果与怎么改。 */
export interface PlatformCheckItem extends PlatformEnforcement {
  key: string;
  /** 会话里那条通知的原话，与时间线保持一致 */
  notice: string;
  turnNo?: number;
  at: string;
}

/** 单条注入正文的上限：公共记忆本身只有 INJECT_MAX_CHARS 级别的正文，这里只是兜底，防止异常数据把接口撑大 */
const MAX_TEXT = 20_000;

export function platformInjectionItem(e: ProjectedEvent): PlatformInjectionItem | undefined {
  const injection = e.injection;
  if (!injection || typeof injection.text !== "string" || !injection.text.trim()) return undefined;
  const chars = Array.from(injection.text);
  return {
    key: e.key,
    label: injection.label,
    notice: e.text ?? injection.label,
    text: chars.length > MAX_TEXT ? chars.slice(0, MAX_TEXT).join("") : injection.text,
    count: injection.count,
    ...(injection.onDemand !== undefined ? { onDemand: injection.onDemand } : {}),
    chars: chars.length,
    ...(injection.rules?.length ? { rules: injection.rules.map((r) => ({ topicId: r.topicId, ruleId: r.ruleId, topic: r.topic, statement: r.statement, title: ruleTitleOf(r) })) } : {}),
    ...(e.turnNo !== undefined ? { turnNo: e.turnNo } : {}),
    at: e.occurredAt ?? e.recordedAt
  };
}

export function platformInjections(events: readonly ProjectedEvent[]): PlatformInjectionItem[] {
  const out: PlatformInjectionItem[] = [];
  for (const e of events) {
    const item = platformInjectionItem(e);
    if (item) out.push(item);
  }
  return out;
}

export function platformChecks(events: readonly ProjectedEvent[]): PlatformCheckItem[] {
  const out: PlatformCheckItem[] = [];
  for (const e of events) {
    if (!e.enforcement) continue;
    out.push({ ...e.enforcement, key: e.key, notice: e.text ?? "", ...(e.turnNo !== undefined ? { turnNo: e.turnNo } : {}), at: e.occurredAt ?? e.recordedAt });
  }
  return out;
}

/** Only paths, never credentials, travel through native developer instructions. */
export function runtimeRecordInstructions(access:{contextFile:string;clientPath:string}):string{
 return `平台记录入口：需要从本会话新建笔记、待办或日程时，使用 node ${JSON.stringify(access.clientPath)} --context ${JSON.stringify(access.contextFile)}，从 stdin 传 JSON：text、kind（note/todo）、schedule（可选）、schedulePending（可选：已判定为日程但缺起算日期的周期安排，如「每 90 天续费」但没说上次哪天，传 {reason:"missing-anchor",repeat:{freq:"daily",interval:90},suggest:"YYYY-MM-DD",hint:"还在等什么"}）、generationSummary（简短生成依据）、idempotencyKey（同一次创建重试不变）。周期安排缺起算日期时，先在会话里问一句（「上次是哪天？」）拿到日期再用 schedule；问不到也不要当成待办降级记录，用 schedulePending 记成「日程 · 待定时间」，提醒用户补日期。默认继承本会话的明确来源；继续从某个新条目衍生时可传 sourceRefs 替代默认来源。不要读取、输出或改写上下文文件中的凭据；不能根据正文相似度猜测来源。`;
}

/** 注入给所有非只读/非评测会话的进程清理规范，避免 macOS/BSD pkill 误杀代理与后台服务。 */
export const PROCESS_CLEANUP_INSTRUCTIONS = `进程清理规范：停止临时预览或测试进程时，优先按启动时记录的 PID 或精确监听端口（如 lsof -tiTCP:<port> -sTCP:LISTEN）停止，不要宽泛按路径或用户名批量杀进程。macOS/BSD 下的 pkill/pgrep 选项必须写在匹配词之前，严禁写成 pkill -f <pattern> -u $USER 这类把选项放在匹配词之后的命令（后面的 -u、$USER 会被当成 OR 匹配词，误杀本机代理、隧道和后台服务）。`;
