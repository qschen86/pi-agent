/** 看起来像凭据的内容不送模型，也不会成为公共记忆。 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key)\b\s*[:=]\s*['"]?[^\s'"]{8,}/i
  // 不再把「连续 40 位以上十六进制」当凭据：git 提交号 / 内容摘要满地都是，线上实测 16 条全是误伤
];
export function looksSensitive(text: string): boolean { return SECRET_PATTERNS.some(re => re.test(text)); }
