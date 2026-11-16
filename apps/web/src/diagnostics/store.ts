/**
 * 诊断数据落盘（V1.4 §3、§5）：<dataRoot>/diagnostics/
 *
 *   events/YYYY-MM-DD.jsonl         前端事件
 *   server-events/YYYY-MM-DD.jsonl  服务端事件（慢请求、停顿、500、进程异常、启动上报）
 *   bundles/<id>.json               链路证据包
 *   releases.jsonl                  实际生效的 release ↔ commit
 *   health/<slot>.json              每个槽位的接收 / 丢弃 / 写入错误计数
 *
 * 容量是硬上限：事件（前后端合计）200 MB、单日 30 MB；证据包 150 MB、单日 20 MB。
 * 两个槽位进程可能同时写：追加写是 O_APPEND，单行 < 8 KiB；各进程按自己的计数判断上限，
 * 每分钟重新统计一次磁盘实际大小，所以两个进程合计最多短暂越过上限一个刷新周期的写入量。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type Limits = {
  eventsTotal: number; eventsDaily: number; eventsRetentionDays: number;
  bundlesTotal: number; bundlesDaily: number; bundleMax: number; bundleRetentionDays: number; bundleProtectedDays: number;
};
export const DEFAULT_LIMITS: Limits = {
  eventsTotal: 200 * 1024 * 1024, eventsDaily: 30 * 1024 * 1024, eventsRetentionDays: 14,
  bundlesTotal: 150 * 1024 * 1024, bundlesDaily: 20 * 1024 * 1024, bundleMax: 512 * 1024, bundleRetentionDays: 30, bundleProtectedDays: 90
};

export type EventStream = "client" | "server";
export type DropReason = "daily-success" | "daily-full" | "total-full" | "write-error" | "invalid" | "rate-limited" | "duplicate";
export type Health = {
  slot: string; pid: number; startedAt: string; updatedAt: string;
  lastClientIngestAt: string | null; lastServerEventAt: string | null;
  received: { client: number; server: number; bundles: number };
  dropped: Partial<Record<DropReason | "bundle-capacity" | "bundle-rate-limited", number>>;
  bytesToday: { events: number; bundles: number };
  writeErrors: number; lastError: string | null;
};

const day = (d: Date) => d.toISOString().slice(0, 10);
const DIR = { client: "events", server: "server-events" } as const;

export class DiagnosticsStore {
  readonly dir: string;
  readonly limits: Limits;
  private now: () => Date;
  private eventBytesByDay = new Map<string, number>();
  private bundleBytes = new Map<string, { bytes: number; mtime: number; manual: boolean }>();
  private health: Health;
  private healthTimer: NodeJS.Timeout | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  /** 由 B 期 finding 存储提供：关联待办未关闭的证据包延长保留（最长 bundleProtectedDays） */
  protectBundle: (id: string) => boolean = () => false;

  private readOnly: boolean;

  /** readOnly：查询脚本用，只读不写健康记录 */
  constructor(options: { dir: string; limits?: Partial<Limits>; now?: () => Date; slot?: string; refreshMs?: number; readOnly?: boolean }) {
    this.readOnly = !!options.readOnly;
    this.dir = options.dir;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.now = options.now ?? (() => new Date());
    for (const sub of ["events", "server-events", "bundles", "health"]) mkdirSync(join(this.dir, sub), { recursive: true });
    const at = this.now().toISOString();
    this.health = {
      slot: options.slot ?? process.env["PI_AGENT_WEB_SLOT"] ?? "dev", pid: process.pid, startedAt: at, updatedAt: at,
      lastClientIngestAt: null, lastServerEventAt: null, received: { client: 0, server: 0, bundles: 0 }, dropped: {},
      bytesToday: { events: 0, bundles: 0 }, writeErrors: 0, lastError: null
    };
    this.rescan();
    if (options.refreshMs !== 0) {
      this.refreshTimer = setInterval(() => { try { this.rescan(); this.prune(); } catch (e) { this.noteError(e); } }, options.refreshMs ?? 60_000);
      this.refreshTimer.unref?.();
    }
  }

  stop(): void { clearInterval(this.refreshTimer); clearTimeout(this.healthTimer); if (!this.readOnly) this.flushHealth(); }

  /** 重新统计磁盘上的实际大小（含另一个槽位进程写入的）。 */
  rescan(): void {
    this.eventBytesByDay.clear();
    for (const sub of Object.values(DIR)) {
      for (const file of safeList(join(this.dir, sub))) {
        const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
        if (!m) continue;
        const size = safeSize(join(this.dir, sub, file));
        this.eventBytesByDay.set(m[1]!, (this.eventBytesByDay.get(m[1]!) ?? 0) + size);
      }
    }
    this.bundleBytes.clear();
    for (const file of safeList(join(this.dir, "bundles"))) {
      const m = /^([A-Za-z0-9_-]{8,64})\.json$/.exec(file);
      if (!m) continue;
      try {
        const st = statSync(join(this.dir, "bundles", file));
        this.bundleBytes.set(m[1]!, { bytes: st.size, mtime: st.mtimeMs, manual: file.startsWith("m") });
      } catch { /* 另一个进程刚删掉 */ }
    }
  }

  private eventsTotal(): number { let t = 0; for (const v of this.eventBytesByDay.values()) t += v; return t; }
  private bundlesTotal(): number { let t = 0; for (const v of this.bundleBytes.values()) t += v.bytes; return t; }
  private bundlesToday(): number {
    const start = Date.parse(`${day(this.now())}T00:00:00.000Z`);
    let t = 0; for (const v of this.bundleBytes.values()) if (v.mtime >= start) t += v.bytes; return t;
  }

  /**
   * 追加一批事件。返回写入的行数；被丢弃的按原因计数。
   * success 标记的是可淘汰的明细（成功终态、生命周期等），当天用到 80% 后先停写这一类。
   */
  append(stream: EventStream, records: Array<{ line: string; success: boolean }>): { written: number; dropped: number } {
    const today = day(this.now());
    let used = this.eventBytesByDay.get(today) ?? 0, written = 0, dropped = 0;
    const out: string[] = [];
    for (const r of records) {
      const bytes = Buffer.byteLength(r.line) + 1;
      if (this.eventsTotal() + bytes > this.limits.eventsTotal) this.pruneOldestEventDay(today);
      let reason: DropReason | null = null;
      if (used + bytes > this.limits.eventsDaily) reason = "daily-full";
      else if (r.success && used + bytes > this.limits.eventsDaily * 0.8) reason = "daily-success";
      else if (this.eventsTotal() + bytes > this.limits.eventsTotal) reason = "total-full";
      if (reason) { this.drop(reason); dropped++; continue; }
      out.push(r.line); used += bytes; written++;
      this.eventBytesByDay.set(today, used);
    }
    if (out.length) {
      try { appendFileSync(join(this.dir, DIR[stream], `${today}.jsonl`), `${out.join("\n")}\n`); }
      catch (e) { this.noteError(e); this.drop("write-error", out.length); return { written: 0, dropped: dropped + out.length }; }
    }
    const at = this.now().toISOString();
    if (stream === "client") { this.health.received.client += written; if (written) this.health.lastClientIngestAt = at; }
    else { this.health.received.server += written; if (written) this.health.lastServerEventAt = at; }
    this.touchHealth();
    return { written, dropped };
  }

  /** 从最旧的一天删起，不删今天。 */
  private pruneOldestEventDay(today: string): boolean {
    const days = [...this.eventBytesByDay.keys()].filter((d) => d < today).sort();
    const oldest = days[0];
    if (!oldest) return false;
    for (const sub of Object.values(DIR)) { try { unlinkSync(join(this.dir, sub, `${oldest}.jsonl`)); } catch { /* 没有这一天 */ } }
    this.eventBytesByDay.delete(oldest);
    return true;
  }

  /** 保留期：事件 14 天；证据包 30 天（受保护的最长 90 天）。 */
  prune(): void {
    const now = this.now().getTime();
    const cutoff = day(new Date(now - this.limits.eventsRetentionDays * 86_400_000));
    for (const d of [...this.eventBytesByDay.keys()]) {
      if (d >= cutoff) continue;
      for (const sub of Object.values(DIR)) { try { unlinkSync(join(this.dir, sub, `${d}.jsonl`)); } catch { /* 已删 */ } }
      this.eventBytesByDay.delete(d);
    }
    for (const [id, b] of [...this.bundleBytes]) {
      const age = (now - b.mtime) / 86_400_000;
      if (age > this.limits.bundleProtectedDays || (age > this.limits.bundleRetentionDays && !this.protectBundle(id))) this.deleteBundle(id);
    }
  }

  private deleteBundle(id: string): void {
    try { unlinkSync(join(this.dir, "bundles", `${id}.json`)); } catch { /* 已删 */ }
    this.bundleBytes.delete(id);
  }

  /**
   * 写证据包。超限时先删最旧的自动包，再删最旧的手动包（受保护的不删）；
   * 仍放不下：自动包丢弃，手动包拒收（调用方提示用户）。
   * 文件名首字母区分：m=手动、a=自动，重扫磁盘时也能分辨。
   */
  writeBundle(id: string, bundle: unknown, manual: boolean): { ok: true; bytes: number } | { ok: false; reason: "too-large" | "capacity" | "write-error" } {
    const body = JSON.stringify(bundle);
    const bytes = Buffer.byteLength(body);
    if (bytes > this.limits.bundleMax) return { ok: false, reason: "too-large" };
    const dailyOk = () => this.bundlesToday() + bytes <= this.limits.bundlesDaily;
    const fits = () => this.bundlesTotal() + bytes <= this.limits.bundlesTotal && dailyOk();
    if (!fits()) {
      const startOfDay = Date.parse(`${day(this.now())}T00:00:00.000Z`);
      const victims = [...this.bundleBytes].filter(([vid]) => !this.protectBundle(vid))
        .sort((a, b) => Number(a[1].manual) - Number(b[1].manual) || a[1].mtime - b[1].mtime);
      for (const [vid, v] of victims) {
        if (fits()) break;
        if (v.manual && !manual) break; // 自动包不挤掉手动包
        // 当天上限只能靠删当天的包腾出来；总量上限删哪天都行
        if (!dailyOk() && v.mtime < startOfDay && this.bundlesTotal() + bytes <= this.limits.bundlesTotal) continue;
        this.deleteBundle(vid);
      }
    }
    if (!fits()) { this.drop("bundle-capacity"); return { ok: false, reason: "capacity" }; }
    const file = join(this.dir, "bundles", `${id}.json`);
    try { writeFileSync(`${file}.tmp`, body); renameSync(`${file}.tmp`, file); }
    catch (e) { this.noteError(e); return { ok: false, reason: "write-error" }; }
    this.bundleBytes.set(id, { bytes, mtime: this.now().getTime(), manual });
    this.health.received.bundles++;
    this.touchHealth();
    return { ok: true, bytes };
  }

  hasBundle(id: string): boolean { return existsSync(join(this.dir, "bundles", `${id}.json`)); }
  readBundle(id: string): unknown | null {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null;
    try { return JSON.parse(readFileSync(join(this.dir, "bundles", `${id}.json`), "utf8")); } catch { return null; }
  }
  listBundles(): string[] { return [...this.bundleBytes.keys()]; }

  /**
   * 读某段时间内的事件（异步读文件，不阻塞事件循环太久）。
   * 每行 JSON 以 "at" 开头：先按前缀里的时间筛，再解析；requestIds 命中的不论时间都收。
   * window 是数字时前后对称；也可以分别给 before / after。
   */
  async eventsAround(stream: EventStream, at: number, window: number | { before: number; after: number }, requestIds: Set<string> = new Set(), limit = 400): Promise<Record<string, unknown>[]> {
    const { before, after } = typeof window === "number" ? { before: window, after: window } : window;
    const from = at - before, to = at + after;
    const days = new Set([day(new Date(from)), day(new Date(to))]);
    const out: Record<string, unknown>[] = [];
    for (const d of [...days].sort()) {
      let text: string;
      try { text = await readFile(join(this.dir, DIR[stream], `${d}.jsonl`), "utf8"); } catch { continue; }
      for (const line of text.split("\n")) {
        if (!line) continue;
        const t = Date.parse(/^\{"at":"([^"]+)"/.exec(line)?.[1] ?? "");
        const idHit = requestIds.size > 0 && /"request_id":"([A-Za-z0-9_-]+)"/.test(line) && requestIds.has(/"request_id":"([A-Za-z0-9_-]+)"/.exec(line)![1]!);
        if (!idHit && !(t >= from && t <= to)) continue;
        try { out.push(JSON.parse(line)); } catch { /* 半截行：另一个进程正在写 */ }
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** 读某天的全部事件行（查询脚本、每晚分诊用）。 */
  async readDay(stream: EventStream, d: string): Promise<string> {
    try { return await readFile(join(this.dir, DIR[stream], `${d}.jsonl`), "utf8"); } catch { return ""; }
  }
  eventFile(stream: EventStream, d: string): string { return join(this.dir, DIR[stream], `${d}.jsonl`); }

  appendRelease(record: { release: string; gitCommit: string | null; dirty: boolean | null; slot: string; activatedAt: string }): boolean {
    const file = join(this.dir, "releases.jsonl");
    try {
      const existing = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
      const last = existing.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse()
        .find((r: { slot?: string }) => r.slot === record.slot);
      if (last && last.release === record.release && last.gitCommit === record.gitCommit) return false;
      appendFileSync(file, `${JSON.stringify(record)}\n`);
      return true;
    } catch (e) { this.noteError(e); return false; }
  }
  readReleases(): Array<{ release: string; gitCommit: string | null; dirty: boolean | null; slot: string; activatedAt: string }> {
    try { return readFileSync(join(this.dir, "releases.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
    catch { return []; }
  }

  drop(reason: keyof Health["dropped"], n = 1): void { this.health.dropped[reason] = (this.health.dropped[reason] ?? 0) + n; this.touchHealth(); }
  noteError(e: unknown): void { this.health.writeErrors++; this.health.lastError = String((e as Error)?.message ?? e).slice(0, 200); this.touchHealth(); }
  healthSnapshot(): Health {
    const today = day(this.now());
    return { ...this.health, updatedAt: this.now().toISOString(), bytesToday: { events: this.eventBytesByDay.get(today) ?? 0, bundles: this.bundlesToday() }, dropped: { ...this.health.dropped }, received: { ...this.health.received } };
  }
  /** 所有槽位的健康记录（查询脚本、分诊判断采集是否中断用）。 */
  readAllHealth(): Health[] {
    return safeList(join(this.dir, "health")).filter((f) => f.endsWith(".json")).map((f) => { try { return JSON.parse(readFileSync(join(this.dir, "health", f), "utf8")); } catch { return null; } }).filter(Boolean);
  }
  private touchHealth(): void {
    if (this.healthTimer || this.readOnly) return;
    this.healthTimer = setTimeout(() => { this.healthTimer = undefined; this.flushHealth(); }, 5_000);
    this.healthTimer.unref?.();
  }
  flushHealth(): void {
    const file = join(this.dir, "health", `${this.health.slot.replace(/[^\w-]/g, "_")}.json`);
    try { writeFileSync(`${file}.tmp`, JSON.stringify(this.healthSnapshot(), null, 1)); renameSync(`${file}.tmp`, file); } catch { /* 健康记录写不进去也不影响业务 */ }
  }
}

function safeList(dir: string): string[] { try { return readdirSync(dir); } catch { return []; } }
function safeSize(file: string): number { try { return statSync(file).size; } catch { return 0; } }
