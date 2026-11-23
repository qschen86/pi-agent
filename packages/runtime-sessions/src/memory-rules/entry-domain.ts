/**
 * 检测规则「entry-domain」——由 DeepSeek flash（推理强度 high）按需求写成，人工只加了下面的 import type 和这段说明。
 * 验收：10 条验收用例（第 3 轮通过）+ 12 条它没见过的留出用例，全部通过；原始输出和每轮验收结果在
 * docs/requirements/memory-hard-constraint/deepseek-drafts/。要改规则，先改需求和用例，再让模型重写，不要手改判定逻辑。
 */
import type { EnforcementRule, RuleVerdict, TurnEvidence } from "../memory-enforcement.js";

// ===== 辅助常量 =====
/** 旧域名本体（严格边界：前面不能是域名/单词字符，后面不能是域名延续，避免误伤 console.example.com、xxxprimary.example.com、primary.example.com.evil.com） */
const OLD_HOST = /(?<![\w.-])gui\.harness\.fund(?![\w-]|\.\w)/i;
/** 旧域名以「链接」形态出现：紧跟着 http(s):// 、// 或 www. 前缀；裸写域名文字不算链接 */
const OLD_URL = /(?:https?:\/\/|\/\/|www\.)gui\.harness\.fund(?![\w-]|\.\w)/i;
/** 本回合是否涉及这套入口域名（新旧都算），用于决定要不要检查 */
const DOMAIN_HINT = /harness\.fund/i;

/** 行内出现这些词，说明是在「解释 / 对比 / 声明已弃用」，不当作给用户的入口链接 */
const EXPLAIN_HINTS =
  /(不再|不用|不使用|不要用|别用|勿用|禁止|弃用|废弃|停用|下线|移除|删除|去掉|替换|代替|替代|改为|改成|换成|切换|迁移|旧|原来|原先|原本|以前|之前|曾经|已迁移|deprecated|legacy|instead|no longer|replace|migrat)/i;

/** 像日志 / 命令输出的行，里面的网址不算模型给出的链接 */
const LOG_LIKE =
  /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}[T ]\d{1,2}:\d{2}|\b\d{1,2}:\d{2}:\d{2}\b|\b(GET|POST|HEAD|PUT|DELETE|OPTIONS|PATCH)\s+https?:\/\/|\b(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\b/i;

/** 搜索 / 纯文本处理类命令，不产生网络访问 */
const SEARCH_CMD =
  /^(grep|egrep|fgrep|rg|ag|ack|awk|sed|findstr|cat|echo|printf|ls|less|more|head|tail)$/i;

function clip(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > 160 ? t.slice(0, 160) + "…" : t;
}

/** 内联代码整体视为「提及」，不当作链接（日志、报错原文常写在反引号里） */
function stripInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, " ");
}

function checkText(text: string): string[] {
  const hits: string[] = [];
  let inFence = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue; // 代码块里的日志 / 命令输出
    if (!line) continue;
    if (!DOMAIN_HINT.test(line)) continue; // 快速过滤
    if (/^>/.test(line)) continue; // 引用行：平台通知原文
    if (!OLD_URL.test(line)) continue; // 粗筛：必须是链接形态
    if (LOG_LIKE.test(line)) continue; // 行内日志
    if (EXPLAIN_HINTS.test(line)) continue; // 解释「不再用旧域名」之类
    const cleaned = stripInlineCode(line);
    if (!OLD_URL.test(cleaned)) continue; // 只在行内代码里出现，算提及
    hits.push(clip(line));
  }
  return hits;
}

function firstWord(seg: string): string {
  const t = seg.trim().replace(/^[({["'\s]+/, "");
  const noSudo = t.replace(/^sudo\s+/i, "");
  const w = noSudo.split(/\s+/)[0] ?? "";
  return w.toLowerCase();
}

function checkCommands(inputs: string[] | undefined): string[] {
  const hits: string[] = [];
  for (const raw of inputs ?? []) {
    if (typeof raw !== "string" || !raw) continue;
    if (!OLD_HOST.test(raw)) continue; // 只用新域名的访问不算问题
    const cmd = raw.trim();
    const segs = cmd.split(/&&|\|\||[;|\n]/);
    for (const seg of segs) {
      if (!OLD_HOST.test(seg)) continue;
      if (SEARCH_CMD.test(firstWord(seg))) continue; // grep 等只是在搜字符串
      hits.push(clip(cmd));
      break;
    }
  }
  return hits;
}

function summarize(hits: string[]): string {
  const shown = hits.slice(0, 3).map((h) => `「${h}」`).join("\n- ");
  const more = hits.length > 3 ? `\n- …共 ${hits.length} 处` : "";
  return `- ${shown}${more}`;
}

// ===== 规则 =====
export const rule: EnforcementRule = {
  id: "entry-domain",
  title: "入口链接与线上验收只能用 console.example.com",
  description:
    "适合记录「线上入口域名 / 验收地址必须用哪个域名、不得再用哪个旧域名」这类约定。当记忆明确规定：给用户的入口链接和模型自己做的线上验收都要使用 console.example.com，并排除旧入口 primary.example.com 时，挂这条规则。其他域名、本地地址、SSL、DNS 等无关事项不要挂。",
  node: "turn-end",
  scope:
    [
      "什么时候查：本回合回复或访问命令里出现 example.com（新旧域名都算）；两处都没出现就放行",
      "查哪两处：",
      "· 回复正文里给用户的旧域名可点击链接（带 http(s):// 、// 或 www. 前缀才算）",
      "· 本回合访问网址的命令（curl / wget / open / 浏览器工具）里是否访问旧域名",
      "不算违规：",
      "· > 引用行、代码块、行内代码（反引号）里的网址",
      "· 日志、命令输出、HTTP 请求行",
      "· 同一行在解释「不再用 / 已迁移 / 前后对比」的说明文字",
      "· 127.0.0.1 等本地地址、grep 等纯搜索命令",
      "· 只裸写域名文字、没有链接形态的提及"
    ].join("\n"),
  criteria:
    [
      "通过：",
      "· 正文里没有旧域名 primary.example.com 的可点击链接",
      "· 访问命令里没有访问旧域名（console.example.com 是新域名，不算违规）",
      "不要求：本回合必须出现新域名；没给链接、没做线上访问的回合默认通过"
    ].join("\n"),
  feedback:
    [
      "1. 指出具体哪一行文字或哪条访问命令用了旧域名",
      "2. 入口链接换成 https://console.example.com",
      "3. 线上验收用它重做（如 curl -I https://console.example.com 或浏览器打开），确认后再汇报"
    ].join("\n"),

  fits(statement: string): boolean {
    const s = statement;
    const mentionsDomain = DOMAIN_HINT.test(s);
    const aboutUse = /(入口|域名|链接|地址|网址|访问|验收|上线|核查|url|domain|entry|link)/i.test(s);
    const restrictive = /(使用|统一|只|必须|一律|不再|不要|禁止|都用|只能|use|only|must)/i.test(s);
    return mentionsDomain && aboutUse && restrictive;
  },

  applies(ev: TurnEvidence): boolean {
    // 只要本回合回复或访问命令里提到这套入口域名（新旧都算）就检查，具体是否违规交给 check
    if (DOMAIN_HINT.test(ev.assistantText || "")) return true;
    return (ev.commandInputs ?? []).some(
      (c) => typeof c === "string" && DOMAIN_HINT.test(c)
    );
  },

  check(ev: TurnEvidence): RuleVerdict {
    const hits = checkText(ev.assistantText || "").concat(checkCommands(ev.commandInputs));
    if (hits.length === 0) return { pass: true };
    return {
      pass: false,
      problem: `本回合仍用到旧入口域名 primary.example.com：\n${summarize(hits)}`,
      fix:
        "改用国内入口 console.example.com 重做一次：\n" +
        "1) 回复里给用户的入口链接统一写成 https://console.example.com，不要保留任何 primary.example.com 的链接；\n" +
        "2) 线上验收换成 curl -I https://console.example.com（或浏览器打开该地址），确认响应正常后再汇报；\n" +
        "3) 如果只是需要说明「旧域名已停用」，可以保留说明文字，但不要给出旧域名的可点击链接或对旧域名做访问。",
    };
  },
};
