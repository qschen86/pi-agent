/**
 * 检测规则「beijing-time」——由 DeepSeek flash（推理强度 high）按需求写成，人工只加了下面的 import type 和这段说明。
 * 验收：10 条验收用例（第 3 轮通过）+ 12 条它没见过的留出用例，全部通过；原始输出和每轮验收结果在
 * docs/requirements/memory-hard-constraint/deepseek-drafts/。要改规则，先改需求和用例，再让模型重写，不要手改判定逻辑。
 */
import type { EnforcementRule, RuleVerdict, TurnEvidence } from "../memory-enforcement.js";

/**
 * 北京时间默认表达规则：
 * 汇报日程 / 定时任务下次运行 / 账单窗口时，主表述应为北京时间（UTC+8），
 * UTC 或洛杉矶本机时间只能作括号补充。
 */

/** 北京时间标记：出现即认为「已以北京时间为主」 */
const BEIJING_MARK =
  /北京时间|北京时区|中国标准时间|中国时间|东八区|UTC\s*[+＋]\s*0?8|GMT\s*[+＋]\s*0?8|Asia\/Shanghai/;

/** 非北京时区标记（UTC+8 / GMT+8 已被否定前瞻排除，不会当成外区） */
const LOCAL_TZ_MARK =
  /(?:UTC|GMT)(?!\s*[+＋]\s*0?8)|PST|PDT|\bEST\b|\bEDT\b|美东时间|美国东部时间|\d\s*PT\b|太平洋时间|美西时间|洛杉矶(?:时间|时区|当地)|本机时间|本地时间|本机时区|系统时区|America\/Los_Angeles/;

/** 具体时刻：06:30 / 6：30 / 9 点 / 9 时 / 9am */
const CLOCK_TIME =
  /\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*点|\d{1,2}\s*时(?![区间段候长差])|\d{1,2}\s*[AaPp][Mm]\b/;

/** 正文里的 ISO 时间串（代码块 / 行内代码已在清洗阶段剔除） */
const ISO_UTC =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]00:?00|UTC|GMT)/;
const ISO_UTC_G = new RegExp(ISO_UTC.source, "g");

/** 排期类词：判断一个 ISO 串是不是在汇报日程 / 下次运行 / 账单窗口 */
const SCHEDULE_WORD =
  /运行|执行|触发|定时|日程|下次|账单|窗口|排期|计划|预约|提醒|任务|周期|每天|每周|每月|到期|截止/;

/** 日志 / 示例语境词：出现则不当成汇报时间 */
const LOG_WORD =
  /日志|\blog\b|时间戳|timestamp|例如|比如|示例|格式|报错|错误|异常/;

/** 用户明确点名要其他时区时的让路标志 */
const USER_DIRECTED = /你的要求|你要求|你要的|你问|按你(?:说|要求|指定|的)|按你说的/;

/** 去掉代码块、行内代码、引用行（平台通知）、日志样式行 */
function stripNoise(text: string): string {
  let t = String(text || "");
  t = t.replace(/```[\s\S]*?(?:```|$)/g, "\n");
  t = t.replace(/~~~[\s\S]*?(?:~~~|$)/g, "\n");
  t = t.replace(/`[^`\n]*`/g, " ");
  const kept: string[] = [];
  for (const line of t.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    if (s.startsWith(">")) continue; // 平台通知 / 引用原文
    if (
      /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s) &&
      /(?:INFO|DEBUG|WARN|ERROR|TRACE|level=)/i.test(s)
    ) {
      continue; // 日志行
    }
    if (/^(?:INFO|DEBUG|WARN|ERROR|TRACE)\b/.test(s)) continue;
    kept.push(s);
  }
  return kept.join("\n");
}

/**
 * 找出「只写了 UTC / 洛杉矶本机时间、没给北京时间」的片段。
 * 逐句（句号/问号/分号/换行）→ 逐分句（逗号/顿号），句或分句里已写北京时间即放行。
 */
function findOffenders(text: string): string[] {
  const hits: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    const key = s.replace(/\s+/g, "");
    if (!key || seen.has(key)) return;
    seen.add(key);
    hits.push(s);
  };

  for (const rawSentence of text.split(/[。！？!?；;\n]+/)) {
    const sentence = rawSentence.trim();
    if (sentence.length < 2) continue;
    if (BEIJING_MARK.test(sentence)) continue; // 这句已以北京时间为主
    if (USER_DIRECTED.test(sentence)) continue; // 用户点名要别的时区
    if (LOG_WORD.test(sentence)) continue; // 日志 / 示例语境

    // 情形一：带排期词的 ISO 时间串（形如 2026-11-13 06:00 UTC / ...Z）
    if (SCHEDULE_WORD.test(sentence) && ISO_UTC.test(sentence)) {
      push(sentence);
      continue;
    }

    // 情形二：同一分句里既有非北京时区词、又有具体时刻
    for (const rawClause of sentence.split(/[，,、]/)) {
      const clause = rawClause.trim();
      if (clause.length < 2) continue;
      if (BEIJING_MARK.test(clause)) continue;
      if (USER_DIRECTED.test(clause)) continue;
      if (LOG_WORD.test(clause)) continue;
      if (!LOCAL_TZ_MARK.test(clause)) continue;
      // 先挖掉 ISO 串本身，避免把「UTC 时间 2026-11-12T06:30:00Z」这种纯展示当成汇报时刻
      const rest = clause.replace(ISO_UTC_G, " ");
      if (!CLOCK_TIME.test(rest)) continue;
      push(clause);
    }
  }
  return hits;
}

export const rule: EnforcementRule = {
  id: "beijing-time",
  title: "对外的时间表达默认用北京时间（UTC+8）",

  description:
    "适合记录：模型与用户沟通时，日期与时刻、日程、定时任务下次运行时间、账单/计费窗口等时间表述默认以北京时间（UTC+8）为主，UTC 或本机时区（America/Los_Angeles）只能放括号里作补充；用户明确问美国时间或其他时区时除外。",

  node: "turn-end",

  scope:
    [
      "看哪里：本回合回复的正文，先去掉代码块、行内代码、> 引用行、日志行",
      "怎么查：按句（句号 / 问号 / 分号 / 换行）、再按分句（逗号 / 顿号）逐段看",
      "算违规：",
      "· 同一分句里有 UTC / 本机时区字样，又有具体时刻（06:30、9 点、9am）",
      "· 一句里有排期词（运行、定时、下次、账单窗口等）+ ISO 时间串（2026-11-13 06:00 UTC）",
      "不算：",
      "· 该句已写北京时间 / UTC+8 / 东八区 / 中国标准时间 / Asia/Shanghai",
      "· 只泛泛提 UTC、没带具体时刻",
      "· 代码或日志里的时间戳、示例 / 报错 / 格式说明的语境",
      "· 用户点名要其他时区"
    ].join("\n"),

  criteria:
    [
      "通过：",
      "· 没有把具体时刻挂在 UTC / 本机时区上当结论报出来",
      "· 或每处具体时刻都先给北京时间，UTC / 洛杉矶时间只在括号里补充",
      "不通过：",
      "· 具体时刻只标 UTC / GMT / 洛杉矶时间 / 本机时间，没有北京时间",
      "· 排期类 ISO 时间串直接当结论报出，读者得自己换算"
    ].join("\n"),

  feedback:
    [
      "1. 指出哪几处只给了 UTC 或本机时间",
      "2. 要求换算成北京时间重写：北京时间作主表述，原时区放括号，如 06:30 UTC 写成「14:30（北京时间，即 06:30 UTC）」",
      "3. 定时任务下次运行、账单窗口同样处理",
      "4. 用户确实要别的时区时，先写明「以下为美国太平洋时间」再给时刻"
    ].join("\n"),

  fits(statement: string): boolean {
    if (typeof statement !== "string") return false;
    const s = statement;
    const aboutBeijing =
      /北京时间|UTC\s*[+＋]\s*0?8|UTC\+08|东八区|Asia\/Shanghai|北京时区/.test(s);
    const aboutTimeTalk =
      /时间|时区|时刻|日程|定时|日历|账单|运行|汇报|沟通/.test(s);
    return aboutBeijing && aboutTimeTalk;
  },

  applies(ev: TurnEvidence): boolean {
    const text = stripNoise(ev.assistantText);
    if (!text) return false;
    // 只有真的存在「具体时刻挂在 UTC / 本机时区上」的片段才检查；
    // 泛泛提到 UTC、只写北京时间、代码/日志里的时间戳，一律放行。
    return findOffenders(text).length > 0;
  },

  check(ev: TurnEvidence): RuleVerdict {
    const text = stripNoise(ev.assistantText);
    if (!text) return { pass: true };
    const offenders = findOffenders(text);
    if (offenders.length === 0) return { pass: true };

    const quoted = offenders
      .slice(0, 3)
      .map((s) => (s.length > 60 ? s.slice(0, 60) + "…" : s))
      .join("；");

    return {
      pass: false,
      problem: `下面这些时间只写了 UTC / 洛杉矶本机时间，没有换成北京时间，用户看不懂：${quoted}`,
      fix: `把上面这些时刻换算成北京时间（UTC+8）后重写一遍：北京时间作主表述，原时区放括号补充。例如原文写「06:30 UTC」，改成「14:30（北京时间，即 06:30 UTC）」。汇报定时任务下次运行、账单窗口时同样处理；如果用户明确要其他时区，先写清「以下为美国太平洋时间」，再给时刻。`,
    };
  },
};
