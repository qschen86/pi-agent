/**
 * 版本号比较与更新日志提炼（纯函数）。
 * - 「稳定版」= 版本号只有 X.Y.Z，不带 alpha / beta / rc 等预发布后缀。
 * - 提炼只做启发式：新增功能取 New Features / Added 之类标题下的条目，破坏性变更取 Breaking 标题或 "Breaking:" 开头的条目；
 *   真正的「值不值得升级」由人点分析时再交给 AI，这里不调用模型。
 */

export interface ParsedVersion { core: [number, number, number]; pre: string[] }

export function parseVersion(raw: string): ParsedVersion | null {
  const m = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(raw ?? ""));
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

export const isStableVersion = (raw: string): boolean => {
  const v = parseVersion(raw);
  return !!v && v.pre.length === 0 && /^\D*\d+\.\d+\.\d+$/.test(String(raw).trim());
};

/** semver 比较：a<b 返回负数。预发布 < 同核心的正式版。 */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i += 1) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) { if (Number(p) !== Number(q)) return Number(p) - Number(q); }
    else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

const FEATURE_HEADING = /^(new features?|features?|added|highlights?|what'?s new|新增|新功能)\b/i;
const BREAKING_HEADING = /^(breaking( changes?)?|破坏性变更)\b/i;
const FIX_LINE = /^(fixed|fix|bug ?fix|improved|changed|reverted|updated|bumped|removed|deprecated)\b/i;

const clean = (line: string): string => line
  .replace(/^[-*+]\s+/, "").replace(/\*\*|`/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s*\(\[?#\d+[^)]*\)/g, "").replace(/\s+/g, " ").trim();
const clip = (s: string, n: number): string => (Array.from(s).length > n ? `${Array.from(s).slice(0, n - 1).join("")}…` : s);

export interface NoteSummary { features: string[]; breaking: string[] }

/** 从一个版本的更新日志里提炼「新增功能」「破坏性变更」（各最多 6 / 4 条，每条不超过 180 字）。 */
export function summarizeNotes(notes: string): NoteSummary {
  const features: string[] = [], breaking: string[] = [];
  let mode: "feature" | "breaking" | "other" = "other";
  let sawFeatureHeading = false;
  const unheaded: string[] = [];
  for (const raw of String(notes ?? "").split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.*)$/.exec(raw.trim());
    if (heading) {
      const title = heading[1]!.replace(/[*_`]/g, "").trim();
      mode = BREAKING_HEADING.test(title) ? "breaking" : FEATURE_HEADING.test(title) ? "feature" : "other";
      if (mode === "feature") sawFeatureHeading = true;
      continue;
    }
    if (!/^\s*[-*+]\s+/.test(raw)) continue;
    const text = clean(raw);
    if (!text) continue;
    if (/^breaking[:：]/i.test(text)) { breaking.push(clip(text.replace(/^breaking[:：]\s*/i, ""), 180)); continue; }
    if (mode === "breaking") breaking.push(clip(text, 180));
    else if (mode === "feature") features.push(clip(text, 180));
    else if (!FIX_LINE.test(text)) unheaded.push(clip(text, 180));
  }
  // 没有「新功能」标题（例如 Claude SDK 的扁平更新日志）：把不是修复 / 调整的条目当作新增内容
  const picked = sawFeatureHeading ? features : [...features, ...unheaded];
  return { features: picked.slice(0, 6), breaking: breaking.slice(0, 4) };
}

/** 从 CHANGELOG.md 里切出各版本：`## 0.3.327` / `## [1.2.0] - 2026-10-12` 开头的段（没有版本号的 [Unreleased] 跳过）。 */
export function parseSectionedChangelog(text: string): Array<{ version: string; notes: string; date?: string }> {
  const out: Array<{ version: string; notes: string; date?: string }> = [];
  let current: { version: string; date?: string; lines: string[] } | null = null;
  const flush = () => { if (current) out.push({ version: current.version, notes: current.lines.join("\n").trim(), ...(current.date ? { date: current.date } : {}) }); };
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^##\s+\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?(?:\s*[-–—]\s*(\d{4}-\d{2}-\d{2}))?/.exec(line);
    if (m) { flush(); current = { version: m[1]!, ...(m[2] ? { date: m[2] } : {}), lines: [] }; continue; }
    if (/^##\s/.test(line)) { flush(); current = null; continue; }
    current?.lines.push(line);
  }
  flush();
  return out;
}

const entities: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&amp;": "&" };
const decode = (s: string): string => s.replace(/&(lt|gt|quot|#39|amp);/g, (m) => entities[m] ?? m);

/** GitHub Releases 的 Atom 条目（内容是转义后的 HTML）→ 近似 Markdown：标题、列表项保留，其余标签去掉。 */
export function htmlToMarkdown(html: string): string {
  return decode(decode(String(html ?? "")).replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, t: string) => `\n${"#".repeat(Number(n))} ${t.replace(/<[^>]+>/g, "")}\n`)
    .replace(/<li[^>]*>/gi, "\n- ").replace(/<\/(p|ul|ol|div)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))
    .replace(/\n{3,}/g, "\n\n").trim();
}

/** 解析 GitHub releases.atom：每条 {tag, updated, notes}。 */
export function parseReleasesAtom(xml: string): Array<{ tag: string; updated?: string; notes: string }> {
  const out: Array<{ tag: string; updated?: string; notes: string }> = [];
  for (const entry of String(xml ?? "").split(/<entry>/).slice(1)) {
    const tag = /<link[^>]*href="[^"]*\/releases\/tag\/([^"]+)"/.exec(entry)?.[1];
    if (!tag) continue;
    const updated = /<updated>([^<]+)<\/updated>/.exec(entry)?.[1];
    const content = /<content[^>]*>([\s\S]*?)<\/content>/.exec(entry)?.[1] ?? "";
    out.push({ tag: decodeURIComponent(tag), ...(updated ? { updated } : {}), notes: htmlToMarkdown(content) });
  }
  return out;
}

/** `agy changelog` 的输出：`1.5.16:` 一行起头，后面每条以 `· ` 开头（条目可能很长，但都在一行里）。 */
export function parseAgyChangelog(text: string): Array<{ version: string; notes: string }> {
  const out: Array<{ version: string; notes: string }> = [];
  let current: { version: string; lines: string[] } | null = null;
  const flush = () => { if (current) out.push({ version: current.version, notes: current.lines.join("\n") }); };
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const head = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?):\s*$/.exec(line.trim());
    if (head) { flush(); current = { version: head[1]!, lines: [] }; continue; }
    const item = /^\s*[·•]\s+(.+)$/.exec(line);
    if (item && current) current.lines.push(`- ${item[1]!.trim()}`);
  }
  flush();
  return out;
}

/** antigravity.google/docs/changelog 的页面（服务端渲染 HTML）：CLI 面板里每个 `rel-cli-X.Y.Z` 条目取日期与全部列表项。 */
export function parseAgyChangelogPage(html: string): Array<{ version: string; notes: string; publishedAt?: string }> {
  const out: Array<{ version: string; notes: string; publishedAt?: string }> = [];
  for (const block of String(html ?? "").split(/<article\b/).slice(1)) {
    const head = /\bid="rel-cli-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)"(?:[^>]*\bdata-release-time="(\d+)")?/.exec(block.slice(0, 600));
    if (!head) continue;
    const items = [...block.matchAll(/<li class="rn-item[^"]*">([\s\S]*?)<\/li>/g)].map((m) => decode(m[1]!.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim()).filter(Boolean);
    const at = head[2] ? new Date(Number(head[2])) : undefined;
    out.push({ version: head[1]!, notes: items.map((t) => `- ${t}`).join("\n"), ...(at && Number.isFinite(at.getTime()) ? { publishedAt: at.toISOString() } : {}) });
  }
  return out;
}
