/**
 * 时点信息检测：正文里出现提交号 / 会话号 / 文件行号 / 具体日期 / 需求版本号，就说明在记「某次具体的事」，
 * 而不是「怎么做 / 不要做」。流水线用它把这类内容挡在常驻与按需层之外。
 */
const TIME_POINT: Array<[string, RegExp]> = [
  // 7–40 位十六进制，且同时含数字和 a-f 字母（避免把 "decade" 之类的英文单词或纯数字当提交号）
  ['提交号', /(?<![0-9A-Za-z])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![0-9A-Za-z])/],
  ['会话号', /(?<![0-9A-Za-z])rt-[0-9a-f]{8,}/],
  ['文件行号', /\.(?:tsx?|m?js|cjs|json|md|py|css|html|sh)[:#]L?\d+(?![0-9A-Za-z])|第\s*\d+\s*行/],
  ['具体日期', /(?<!\d)20\d{2}-\d{1,2}-\d{1,2}(?!\d)|20\d{2}年\d{1,2}月\d{1,2}日/],
  ['需求版本号', /(?<![0-9A-Za-z.])v\d+\.\d+(?:\.\d+)?(?![0-9A-Za-z])/]
];
export function timePointHits(text: string): string[] {
  return TIME_POINT.filter(([, re]) => re.test(text)).map(([label]) => label);
}
