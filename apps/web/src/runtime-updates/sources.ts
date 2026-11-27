/**
 * 三个 runtime 的「最新稳定版」从哪里取（只读、公开接口，不带任何平台凭据）：
 * - Pi：npm `@earendil-works/pi-coding-agent` 的 latest 为准；更新日志取仓库 packages/coding-agent/CHANGELOG.md 的 `## [X.Y.Z]` 段。
 * - Claude：npm `@anthropic-ai/claude-agent-sdk` 的 latest 为准（SDK 自带 CLI）；更新日志取仓库 CHANGELOG.md 的 `## X.Y.Z` 段。
 * - Codex：GitHub `releases/latest`（非 prerelease 的最新一版，tag rust-vX.Y.Z）+ releases.atom 里近期的稳定版条目；
 *   不用 releases 列表接口（alpha 版太多，一页就是几 MB，会超时）。所以 Codex 的更新记录从首次检测起逐日积累。
 *   ChatGPT.app 内置的 CLI 一般是 alpha，不算稳定版。
 * - Antigravity（agy）：闭源二进制，没有 npm / GitHub。最新版取安装脚本用的发布清单 manifests/<平台>.json 的 version；
 *   更新日志先读已装的 `agy changelog`（离线、与已装版本同源），已装版本之后的版本再从公开页 antigravity.google/docs/changelog 补；
 *   两处都常比清单晚一两天出现，清单里有而日志里没有的版本补一条无正文的占位。
 * 稳定版 = 版本号不带 alpha / beta / rc。GitHub 匿名接口每小时 60 次，每天只查一次足够；设了 GITHUB_TOKEN 就带上。
 */
import { compareVersions, isStableVersion, parseAgyChangelog, parseAgyChangelogPage, parseReleasesAtom, parseSectionedChangelog, parseVersion } from "./versions.js";

export type UpdateKind = "pi" | "claude-code" | "codex" | "antigravity";
export const UPDATE_KINDS: UpdateKind[] = ["pi", "claude-code", "codex", "antigravity"];

export interface ReleaseInfo { version: string; publishedAt?: string; url?: string; notes: string }
export interface SourceResult { latest: string; releases: ReleaseInfo[] }
export type FetchText = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export const SOURCES: Record<UpdateKind, { label: string; npm?: string; homepage: string }> = {
  pi: { label: "Pi", npm: "@earendil-works/pi-coding-agent", homepage: "https://github.com/earendil-works/pi/releases" },
  "claude-code": { label: "Claude Code（Agent SDK）", npm: "@anthropic-ai/claude-agent-sdk", homepage: "https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md" },
  codex: { label: "Codex", homepage: "https://github.com/openai/codex/releases" },
  antigravity: { label: "Antigravity", homepage: "https://antigravity.google/docs/changelog" }
};

export const AGY_MANIFEST_BASE = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
/** 安装脚本里的平台名；linux 的 musl 版本平台不区分（服务端只跑在 macOS / 常见 Linux 上） */
export function agyPlatform(platform: string = process.platform, arch: string = process.arch): string {
  const a = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : "";
  if (!a || (platform !== "darwin" && platform !== "linux")) throw new Error(`Antigravity 暂不支持这个平台：${platform}/${arch}`);
  return `${platform}_${a}`;
}

const NOTES_LIMIT = 12_000;
const KEEP_STABLE = 80;

async function getText(fetchText: FetchText, url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetchText(url, { headers: { "user-agent": "pi-agent-runtime-updates", ...headers } });
  if (!res.ok) throw new Error(`${new URL(url).host} 返回 ${res.status}${res.status === 403 || res.status === 429 ? "（可能触发了访问频率限制，稍后再试）" : ""}`);
  return res.text();
}
const getJson = async <T>(fetchText: FetchText, url: string, headers?: Record<string, string>): Promise<T> => {
  const text = await getText(fetchText, url, headers);
  try { return JSON.parse(text) as T; } catch { throw new Error(`${new URL(url).host} 返回的不是 JSON`); }
};
const ghHeaders = (token?: string): Record<string, string> => ({ accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) });

interface GhRelease { tag_name?: string; prerelease?: boolean; draft?: boolean; body?: string | null; html_url?: string; published_at?: string }

function fromGithub(list: GhRelease[], tagPattern: RegExp): ReleaseInfo[] {
  return list
    .filter((r) => !r.draft && !r.prerelease && typeof r.tag_name === "string")
    .flatMap((r) => {
      const m = tagPattern.exec(r.tag_name!);
      if (!m || !isStableVersion(m[1]!)) return [];
      return [{ version: m[1]!, ...(r.published_at ? { publishedAt: r.published_at } : {}), ...(r.html_url ? { url: r.html_url } : {}), notes: String(r.body ?? "").trim().slice(0, NOTES_LIMIT) }];
    });
}

export interface FetchSourceExtras {
  /** 已装 agy 的 `agy changelog` 输出；读不到（没装、超时）就当空 */
  agyChangelog?: () => Promise<string>;
}

async function fetchAntigravity(fetchText: FetchText, extras: FetchSourceExtras): Promise<SourceResult> {
  const manifest = await getJson<{ version?: string }>(fetchText, `${AGY_MANIFEST_BASE}/${agyPlatform()}.json`);
  const latest = manifest.version;
  if (!latest || !isStableVersion(latest)) throw new Error(`Antigravity 发布清单里的版本号不是稳定版：${String(latest)}`);
  const [local, page] = await Promise.all([
    (extras.agyChangelog?.() ?? Promise.resolve("")).catch(() => ""),
    getText(fetchText, SOURCES.antigravity.homepage).catch(() => "")
  ]);
  const merged = new Map<string, ReleaseInfo>();
  const add = (version: string, notes: string, publishedAt?: string) => {
    if (merged.has(version) || !isStableVersion(version) || compareVersions(version, latest) > 0) return;
    merged.set(version, { version, ...(publishedAt ? { publishedAt } : {}), url: SOURCES.antigravity.homepage, notes: notes.slice(0, NOTES_LIMIT) });
  };
  const pageReleases = parseAgyChangelogPage(page);
  const dates = new Map(pageReleases.flatMap((r) => r.publishedAt ? [[r.version, r.publishedAt] as const] : []));
  for (const r of parseAgyChangelog(local)) add(r.version, r.notes, dates.get(r.version));
  for (const r of pageReleases) add(r.version, r.notes, r.publishedAt);
  if (!merged.has(latest)) merged.set(latest, { version: latest, url: SOURCES.antigravity.homepage, notes: "" });
  const releases = [...merged.values()].sort((a, b) => compareVersions(b.version, a.version)).slice(0, KEEP_STABLE);
  return { latest, releases };
}

export async function fetchSource(kind: UpdateKind, fetchText: FetchText, githubToken?: string, extras: FetchSourceExtras = {}): Promise<SourceResult> {
  if (kind === "antigravity") return fetchAntigravity(fetchText, extras);
  let releases: ReleaseInfo[];
  let latest: string | undefined;
  if (kind === "codex") {
    const [latestRelease, atom] = await Promise.all([
      getJson<GhRelease>(fetchText, "https://api.github.com/repos/openai/codex/releases/latest", ghHeaders(githubToken)),
      getText(fetchText, "https://github.com/openai/codex/releases.atom").catch(() => "")
    ]);
    releases = fromGithub([latestRelease], /^rust-v(\d+\.\d+\.\d+)$/);
    const seen = new Set(releases.map((r) => r.version));
    for (const e of parseReleasesAtom(atom)) {
      const m = /^rust-v(\d+\.\d+\.\d+)$/.exec(e.tag);
      if (!m || seen.has(m[1]!) || !isStableVersion(m[1]!)) continue;
      seen.add(m[1]!);
      releases.push({ version: m[1]!, ...(e.updated ? { publishedAt: e.updated } : {}), url: `https://github.com/openai/codex/releases/tag/${e.tag}`, notes: e.notes.slice(0, NOTES_LIMIT) });
    }
  } else {
    const npm = SOURCES[kind].npm!;
    latest = (await getJson<{ version?: string }>(fetchText, `https://registry.npmjs.org/${npm.replace("/", "%2F")}/latest`)).version;
    if (!latest || !isStableVersion(latest)) throw new Error(`npm 上 ${npm} 的 latest 不是稳定版号：${String(latest)}`);
    const changelog = kind === "pi"
      ? { url: "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/CHANGELOG.md", page: (v: string) => `https://github.com/earendil-works/pi/releases/tag/v${v}` }
      : { url: "https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/CHANGELOG.md", page: () => SOURCES[kind].homepage };
    const text = await getText(fetchText, changelog.url);
    releases = parseSectionedChangelog(text).filter((r) => isStableVersion(r.version))
      .map((r) => ({ version: r.version, ...(r.date ? { publishedAt: r.date } : {}), url: changelog.page(r.version), notes: r.notes.slice(0, NOTES_LIMIT) }));
    // npm 已发布的才算数：更新日志可能先于 npm 包出现
    releases = releases.filter((r) => compareVersions(r.version, latest!) <= 0);
    // 更新日志里还没有最新版的条目（发布流程时差）：补一条占位，至少让人知道有新版本
    if (!releases.some((r) => r.version === latest)) releases.unshift({ version: latest, url: changelog.page(latest), notes: "" });
  }
  releases.sort((a, b) => compareVersions(b.version, a.version));
  releases = releases.slice(0, KEEP_STABLE);
  const top = releases[0];
  if (!top) throw new Error("没有读到任何稳定版发布记录");
  return { latest: latest ?? top.version, releases };
}

/** 把 `codex-cli 0.169.0-alpha.11.1`、`1.2.0` 这类文本里的版本号取出来。 */
export function installedVersionOf(raw: string | undefined | null): string | undefined {
  const m = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(String(raw ?? ""));
  return m && parseVersion(m[0]) ? m[0] : undefined;
}
