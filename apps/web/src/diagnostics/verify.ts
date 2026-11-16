/**
 * D 期：修复效果验证（docs/requirements/autonomous-diagnostics §9）。
 *
 * 待上线 → 观察中：修复提交（修复会话报告的 fix.commit，或人工登记）被某个「实际生效」的 release 包含
 *   （releases.jsonl 里有记录，且 git merge-base --is-ancestor 成立）。只构建、只排队、会话归档都不算上线。
 * 观察中 → 已验证：在包含修复的 release 上——
 *   1. 观察满 observeDays（默认 7 天）；
 *   2. 用量够：出问题的关键操作完成 ≥ minAttempts 次（默认 30）；非关键操作类问题用页面打开次数（page_ready）；
 *   3. 被观察的指纹 0 次（指纹来自 finding 本身和它的自动证据包）；
 *   4. 采集没有中断（前端事件没有超过 6 小时的空档）；
 *   5. 报告里登记了回归测试。
 * 证据不足：生效满 giveUpDays（默认 14 天）仍没满足以上条件。零流量、采集中断都不算修好。
 * 复发：被观察的指纹出现在包含修复的 release 上 → 记「复发」，下一轮分诊另起 episode 重新分析。
 * 旧页面（不含修复的 release）上的报错不计入新版本，也不算复发。「0/30」只描述这次观察的样本。
 */
import { execFile, execFileSync } from "node:child_process";
import type { DiagnosticsStore } from "./store.js";
import type { Finding, FindingStore } from "./findings.js";
import { dataQuality, opStats, readRange, type Row } from "./query.js";
import { eventFingerprint } from "./redact.js";
import { COMPONENTS } from "./events.js";

export type VerifySettings = { observeDays: number; minAttempts: number; giveUpDays: number };
export const DEFAULT_VERIFY: VerifySettings = { observeDays: 7, minAttempts: 30, giveUpDays: 14 };
const FAILURE_EVENTS = /^(js_error|unhandled_rejection|resource_error|request_failed|op_failure|op_timeout|server_error|process_error)$/;

const COMMIT_MISSING_RECHECK_MS = 10 * 60_000;
const CONTAINS_CONCURRENCY = 6;

export type VerifyChange = { findingId: string; from: string; to: string; reason: string };

export class FixVerifier {
  private store: DiagnosticsStore;
  private findings: FindingStore;
  private repoRoot: string;
  private now: () => Date;
  readonly settings: VerifySettings;
  private git: (args: string[]) => boolean;
  /** 异步版：contains() 走这条，绝不在事件循环上同步等 git（上线后几百次同步 git 会把服务卡住数秒） */
  private gitAsync: (args: string[]) => Promise<boolean>;
  private containsCache = new Map<string, boolean>();
  private containsFlights = new Map<string, Promise<boolean>>();
  /** 修复提交是否在本仓库：存在就永远存在；不存在可能只是还没 fetch，短时间后再问 */
  private commitKnown = new Map<string, { ok: boolean; at: number }>();
  private commitFlights = new Map<string, Promise<boolean>>();

  constructor(options: { store: DiagnosticsStore; findings: FindingStore; repoRoot: string; now?: () => Date; settings?: Partial<VerifySettings>; git?: (args: string[]) => boolean }) {
    this.store = options.store; this.findings = options.findings; this.repoRoot = options.repoRoot;
    this.now = options.now ?? (() => new Date());
    this.settings = { ...DEFAULT_VERIFY, ...options.settings };
    this.git = options.git ?? ((args) => { try { execFileSync("git", ["-C", this.repoRoot, ...args], { stdio: "ignore", timeout: 5_000 }); return true; } catch { return false; } });
    this.gitAsync = options.git
      ? async (args) => options.git!(args)
      : (args) => new Promise((resolve) => { execFile("git", ["-C", this.repoRoot, ...args], { timeout: 5_000 }, (error) => resolve(!error)); });
  }

  private async commitExists(commit: string): Promise<boolean> {
    const known = this.commitKnown.get(commit);
    if (known && (known.ok || this.now().getTime() - known.at < COMMIT_MISSING_RECHECK_MS)) return known.ok;
    const flight = this.commitFlights.get(commit);
    if (flight) return flight;
    const work = this.gitAsync(["cat-file", "-e", `${commit}^{commit}`]).then((ok) => {
      this.commitKnown.set(commit, { ok, at: this.now().getTime() });
      return ok;
    }).finally(() => this.commitFlights.delete(commit));
    this.commitFlights.set(commit, work);
    return work;
  }

  /**
   * fix 是否包含在 release 的提交里。
   * 提交不在仓库时一次检查就答「不含」，不再对每个 release 各跑一次 git（releases.jsonl 有几百条，
   * 同步跑会把事件循环卡住十秒量级）；提交在仓库里时，包含与否由历史决定、不会再变，两种结果都缓存。
   */
  async contains(fix: string, releaseCommit: string): Promise<boolean> {
    if (fix === releaseCommit) return true;
    const key = `${fix}..${releaseCommit}`;
    const hit = this.containsCache.get(key);
    if (hit !== undefined) return hit;
    const flight = this.containsFlights.get(key);
    if (flight) return flight;
    const work = (async () => {
      if (!await this.commitExists(fix)) return false;
      const ok = await this.gitAsync(["merge-base", "--is-ancestor", fix, releaseCommit]);
      // release 提交还没 fetch 进来时 merge-base 也会失败：只有两个提交都在才算确定的「不含」
      if (ok || await this.commitExists(releaseCommit)) this.containsCache.set(key, ok);
      return ok;
    })().finally(() => this.containsFlights.delete(key));
    this.containsFlights.set(key, work);
    return work;
  }

  /** 对一批 release 提交并发（有上限）判断是否包含 fix，保持输入顺序 */
  private async containsAll(fix: string, commits: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    const unique = [...new Set(commits)];
    let next = 0;
    const worker = async () => { for (let i = next++; i < unique.length; i = next++) if (await this.contains(fix, unique[i]!)) found.add(unique[i]!); };
    await Promise.all(Array.from({ length: Math.min(CONTAINS_CONCURRENCY, unique.length) }, worker));
    return found;
  }

  async run(): Promise<VerifyChange[]> {
    this.findings.reloadIfChanged();
    const changes: VerifyChange[] = [];
    for (const f of this.findings.all()) {
      if (!f.fix?.commit || !["awaiting_release", "observing"].includes(f.status)) continue;
      const c = await this.verifyOne(f);
      if (c) changes.push(c);
    }
    return changes;
  }

  private async fixedReleases(f: Finding): Promise<Array<{ release: string; gitCommit: string | null; activatedAt: string; slot: string }>> {
    const releases = this.store.readReleases().filter((r) => r.gitCommit);
    const contained = await this.containsAll(f.fix!.commit!, releases.map((r) => r.gitCommit!));
    return releases.filter((r) => contained.has(r.gitCommit!)).sort((a, b) => a.activatedAt.localeCompare(b.activatedAt));
  }

  /** 被观察的指纹：finding 自己的（扫描来的）+ 它名下自动证据包的触发指纹；用户上报的「手动上报」指纹不算 */
  watched(f: Finding): Set<string> {
    const out = new Set<string>();
    if (f.source === "scan") out.add(f.fingerprint);
    for (const id of f.bundleIds) {
      const b = this.store.readBundle(id) as { trigger?: { kind?: string; fingerprint?: string } } | null;
      if (b?.trigger?.kind === "auto" && b.trigger.fingerprint) out.add(b.trigger.fingerprint);
    }
    return out;
  }

  async verifyOne(f: Finding): Promise<VerifyChange | null> {
    const now = this.now();
    const fixed = await this.fixedReleases(f);
    if (!fixed.length) return null; // 还没有包含修复的 release 生效：保持「待上线」
    const first = fixed[0]!;
    const original = f.status;
    if (f.status === "awaiting_release") {
      this.findings.withLock((s) => {
        const cur = s.byId(f.id); if (!cur?.fix) return;
        cur.fix.releasedIn = first.release; cur.fix.activatedAt = first.activatedAt;
        s.setStatus(cur, "observing", `修复提交 ${cur.fix.commit!.slice(0, 8)} 已随 release ${first.release.slice(0, 12)} 在 ${first.slot} 生效（${first.activatedAt}）`);
      });
      f = this.findings.byId(f.id) ?? f;
    }
    const activatedAt = Date.parse(f.fix?.activatedAt ?? first.activatedAt);
    const fixedSet = new Set(fixed.map((r) => r.release));
    const { client, server } = await readRange(this.store, activatedAt, now.getTime());
    const onFixed = client.filter((r) => typeof r["page_release"] === "string" && fixedSet.has(r["page_release"] as string) && r["environment"] !== "test");
    const watched = this.watched(f);
    const fixedCommits = new Set(fixed.map((r) => r.gitCommit));
    const serverCommits = [...new Set(server.map((r) => r["server_commit"]).filter((c): c is string => typeof c === "string" && !fixedCommits.has(c)))];
    const serverContained = await this.containsAll(f.fix!.commit!, serverCommits);
    const serverOnFixed = (r: Row) => typeof r["server_commit"] === "string" && (fixedCommits.has(r["server_commit"] as string) || serverContained.has(r["server_commit"] as string));
    const recurrences = [...onFixed, ...server.filter(serverOnFixed)].filter((r) => FAILURE_EVENTS.test(String(r.event_name)) && watched.has(eventFingerprint(r)));
    const component = f.component && COMPONENTS.has(f.component) ? f.component : null;
    const attempts = component ? (opStats(onFixed, now.getTime()).find((s) => s.component === component)?.completed ?? 0) : onFixed.filter((r) => r.event_name === "page_ready").length;
    const quality = dataQuality([], client, activatedAt, now.getTime());
    const days = (now.getTime() - activatedAt) / 86_400_000;
    const usageLabel = component ? `${component} 完成 ${attempts} 次` : `页面打开 ${attempts} 次`;
    const detail = `观察 ${days.toFixed(1)} 天；${usageLabel}；被观察指纹 ${watched.size} 个，复发 ${recurrences.length} 次；数据质量 ${quality.quality}${quality.reasons.length ? `（${quality.reasons.join("；")}）` : ""}`;

    let to: "observing" | "verified" | "insufficient" | "recurred" = "observing";
    const missing: string[] = [];
    if (recurrences.length) to = "recurred";
    else {
      if (days < this.settings.observeDays) missing.push(`观察未满 ${this.settings.observeDays} 天`);
      if (attempts < this.settings.minAttempts) missing.push(`用量不足 ${this.settings.minAttempts} 次`);
      if (quality.quality !== "complete") missing.push("采集有中断");
      if (!watched.size) missing.push("没有可观察的指纹，无法判断是否复发");
      if (!f.fix?.tests?.length) missing.push("没有登记回归测试");
      if (!missing.length) to = "verified";
      else if (days >= this.settings.giveUpDays) to = "insufficient";
    }
    this.findings.withLock((s) => {
      const cur = s.byId(f.id); if (!cur) return;
      cur.verification = { at: now.toISOString(), result: to === "observing" ? "pending" : to, detail: `${detail}${missing.length ? `；尚缺：${missing.join("、")}` : ""}`,
        progress: { days: Math.round(days * 10) / 10, attempts, minAttempts: this.settings.minAttempts, observeDays: this.settings.observeDays, recurrences: recurrences.length, quality: quality.quality } };
      if (to !== "observing") s.setStatus(cur, to, to === "verified" ? `修复已验证：${detail}（只描述这次观察的样本，不代表故障概率为零）` : to === "recurred" ? `修复后再次出现：${recurrences.length} 次（首次 ${String(recurrences[0]?.["occurred_at"] ?? recurrences[0]?.at)}）` : `证据不足：${missing.join("、")}`);
      else s.touch(cur);
    });
    return original !== to ? { findingId: f.id, from: original, to, reason: missing.join("、") || detail } : null;
  }

  /** 修复不是经修复会话完成时，人工登记修复提交与回归测试（提交必须在仓库里） */
  registerFix(findingId: string, commit: string, tests: string[]): { ok: boolean; reason?: string } {
    if (!/^[a-f0-9]{7,40}$/.test(commit)) return { ok: false, reason: "提交哈希格式不对" };
    if (!this.git(["cat-file", "-e", `${commit}^{commit}`])) return { ok: false, reason: `提交 ${commit} 不在仓库里` };
    return this.findings.withLock((s) => {
      const cur = s.byId(findingId);
      if (!cur) return { ok: false, reason: "没有这个诊断记录" };
      cur.fix = { ...(cur.fix ?? {}), commit, ...(tests.length ? { tests: tests.slice(0, 50) } : {}) };
      if (!["awaiting_release", "observing", "verified"].includes(cur.status)) s.setStatus(cur, "awaiting_release", `人工登记修复提交 ${commit.slice(0, 8)}`);
      return { ok: true };
    });
  }
}
