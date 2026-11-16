/**
 * 网页正文的本地清洗（确定性、不调用模型）：阅读服务返回的 Markdown 里常有大量页面框架——导航菜单、分享按钮、
 * 页脚链接、图片——实测一轮读到的 16 页里约一半是这类内容，有的页面前 1 万字里八成以上是框架。
 * 先去掉这些再按每页上限截断，同样的字数能装下多得多的正文。
 *
 * 规则：去掉图片；整行只有链接的（导航、分享按钮、相关链接列表）去掉；其余链接只留文字、去掉网址；去掉表格分隔行与只有符号的行；标题与带数字的短行保留
 * （数据常在短行里，例如「年息 36%」）；同一行重复出现两次以上的（菜单、页脚）只留前两次；压缩多余空行。
 */
export interface CleanedPage {
  text: string;
  /** 清洗前的字符数 */
  rawChars: number;
  /** 去掉的行数 */
  removedLines: number;
}

const CJK = /[㐀-鿿豈-﫿]/g;

/** 一行里「有内容」的程度：中日韩字算 2，字母数字算 1；去掉链接网址与标记符号后再算 */
function score(line: string): { score: number; digits: boolean } {
  const bare = line
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[#*_>`|~\-=+•·—–:：;；,，.。!！?？()[\]（）【】{}<>《》"'“”‘’/\\]/g, "")
    .replace(/\s+/g, "");
  const cjk = (bare.match(CJK) ?? []).length;
  const other = bare.replace(CJK, "").replace(/[^A-Za-z0-9%$€£¥]/g, "").length;
  return { score: cjk * 2 + other, digits: /\d/.test(bare) };
}

const LINK = /\[([^\]]*)\]\((?:[^()\s]|\([^)]*\))*(?:\s+"[^"]*")?\)/g;

export function cleanPageText(markdown: string): CleanedPage {
  const rawChars = markdown.length;
  // 图片（含链接里的图片）先去掉
  const md = markdown
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<https?:\/\/[^>]+>/g, "");
  const seen = new Map<string, number>();
  const kept: string[] = [];
  let removed = 0;
  for (const raw of md.split("\n")) {
    const original = raw.replace(/\s+$/g, "");
    const t0 = original.trim();
    if (!t0) { kept.push(""); continue; }
    // 表格分隔行
    if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(t0)) { removed++; continue; }
    // 整行只有链接（导航、分享按钮、相关链接列表）：去掉链接后什么都不剩
    const withoutLinks = t0.replace(LINK, "");
    if (LINK.test(t0) && score(withoutLinks).score === 0) { LINK.lastIndex = 0; removed++; continue; }
    LINK.lastIndex = 0;
    // 其余：链接只留文字；标题、够长的行、带数字的短行保留
    const line = original.replace(LINK, "$1");
    const t = line.trim();
    const s = score(t);
    const heading = /^#{1,6}\s/.test(t) && s.score >= 2;
    if (!(heading || s.score >= 6 || (s.digits && s.score >= 3))) { removed++; continue; }
    const n = (seen.get(t) ?? 0) + 1;
    seen.set(t, n);
    if (n > 2) { removed++; continue; }
    kept.push(line);
  }
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), rawChars, removedLines: removed };
}
