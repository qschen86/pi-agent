import { execFile } from "node:child_process";
import { cpus, freemem, platform, totalmem } from "node:os";
import { statfs } from "node:fs/promises";
import type { Context } from "hono";
import type { Hono } from "hono";

/**
 * 主机（Mac Mini）资源状态：CPU / GPU / 内存 / 硬盘占比 + 最近的网速，给「连接状态」弹层展示。
 *
 * 取舍：
 * - 只在有人读取时才采样（没有后台定时器）；两次读取之间至少隔 MIN_INTERVAL_MS，同时到达的读取共用一次采样，
 *   所以多个设备同时打开弹层也只会起一组外部命令。
 * - CPU 占比与网速都是「两次采样之差」：第一次读取（或上次采样已过期）先取基线、短等再采一次，不返回空值。
 * - 取不到的项（命令失败 / 非 macOS 无 GPU 计数）返回 null，前端显示「—」，不影响其他项。
 */
export interface HostStats {
  at: number;
  /** 两次采样之间的秒数；CPU 与网速都按这个窗口计算。 */
  windowSec: number;
  cpu: { percent: number | null; cores: number };
  gpu: { percent: number | null };
  memory: { usedBytes: number; totalBytes: number; percent: number };
  disk: { usedBytes: number; totalBytes: number; percent: number } | null;
  network: { interface: string | null; rxBytesPerSec: number | null; txBytesPerSec: number | null };
}

export interface CpuTimes { idle: number; total: number }
export interface NetCounters { interface: string; rx: number; tx: number }
export interface RawSample {
  at: number;
  cpu: CpuTimes;
  gpuPercent: number | null;
  memory: { usedBytes: number; totalBytes: number };
  disk: { usedBytes: number; totalBytes: number } | null;
  net: NetCounters | null;
}

export type Runner = (file: string, args: string[]) => Promise<string>;

const run: Runner = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 2500, maxBuffer: 1 << 20, encoding: "utf8" }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

const clampPercent = (value: number) => Math.min(100, Math.max(0, Math.round(value * 10) / 10));

export function readCpuTimes(list: Array<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }> = cpus()): CpuTimes {
  let idle = 0, total = 0;
  for (const { times } of list) { idle += times.idle; total += times.user + times.nice + times.sys + times.idle + times.irq; }
  return { idle, total };
}

export function cpuPercent(prev: CpuTimes, cur: CpuTimes): number | null {
  const total = cur.total - prev.total, idle = cur.idle - prev.idle;
  if (!(total > 0) || idle < 0) return null;
  return clampPercent((1 - idle / total) * 100);
}

/** macOS：Activity Monitor 的「已使用」≈ 活跃 + 联动（wired）+ 被压缩器占用。其他系统退回 os.freemem。 */
export function parseVmStat(text: string, totalBytes: number): { usedBytes: number; totalBytes: number } | null {
  const size = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  const pages = (label: string) => Number(new RegExp(`^${label}:\\s+(\\d+)\\.`, "m").exec(text)?.[1]);
  const active = pages("Pages active"), wired = pages("Pages wired down"), compressed = pages("Pages occupied by compressor");
  if (!(size > 0) || ![active, wired].every(Number.isFinite)) return null;
  const used = (active + wired + (Number.isFinite(compressed) ? compressed : 0)) * size;
  return { usedBytes: Math.min(used, totalBytes), totalBytes };
}

/** `ioreg -r -d 1 -c IOAccelerator` 里 PerformanceStatistics 的 "Device Utilization %"（Apple Silicon 无需 sudo）。 */
export function parseGpuUtilization(text: string): number | null {
  const values = [...text.matchAll(/"Device Utilization %"\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
  return values.length ? clampPercent(Math.max(...values)) : null;
}

export function parseDefaultInterface(text: string): string | null {
  return /^\s*interface:\s*(\S+)/m.exec(text)?.[1] ?? null;
}

/** `netstat -ibn -I <if>` 的 Link 行：从行尾倒数取字节（该行有没有 MAC 地址列都成立）。 */
export function parseNetstat(text: string, iface: string): NetCounters | null {
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f[0] !== iface || !/^<Link#\d+>$/.test(f[2] ?? "") || f.length < 10) continue;
    const rx = Number(f[f.length - 5]), tx = Number(f[f.length - 2]);
    if (Number.isFinite(rx) && Number.isFinite(tx)) return { interface: iface, rx, tx };
  }
  return null;
}

export function networkRates(prev: NetCounters | null, cur: NetCounters | null, seconds: number): { rx: number | null; tx: number | null } {
  // 换了网卡或计数回绕 / 清零：这一窗口不给数，下次再算。
  if (!prev || !cur || prev.interface !== cur.interface || !(seconds > 0) || cur.rx < prev.rx || cur.tx < prev.tx) return { rx: null, tx: null };
  return { rx: Math.round((cur.rx - prev.rx) / seconds), tx: Math.round((cur.tx - prev.tx) / seconds) };
}

export interface HostStatsDeps {
  run?: Runner;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  cpuTimes?: () => CpuTimes;
  totalMem?: () => number;
  freeMem?: () => number;
  diskUsage?: () => Promise<{ usedBytes: number; totalBytes: number } | null>;
  isMac?: boolean;
}

const MIN_INTERVAL_MS = 1500;
const BASELINE_STALE_MS = 30_000;
const BASELINE_WAIT_MS = 700;
const IFACE_TTL_MS = 60_000;

export async function defaultDiskUsage(): Promise<{ usedBytes: number; totalBytes: number } | null> {
  for (const path of platform() === "darwin" ? ["/System/Volumes/Data", "/"] : ["/"]) {
    try {
      const s = await statfs(path);
      const total = s.blocks * s.bsize;
      if (total > 0) return { usedBytes: Math.max(0, total - s.bavail * s.bsize), totalBytes: total };
    } catch { /* 试下一个挂载点 */ }
  }
  return null;
}

export class HostStatsSampler {
  private prev: RawSample | undefined;
  private cached: HostStats | undefined;
  private inflight: Promise<HostStats> | undefined;
  private iface: { name: string | null; at: number } | undefined;
  private readonly deps: Required<Omit<HostStatsDeps, "isMac">> & { isMac: boolean };

  constructor(deps: HostStatsDeps = {}) {
    this.deps = {
      run: deps.run ?? run,
      now: deps.now ?? Date.now,
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      cpuTimes: deps.cpuTimes ?? (() => readCpuTimes()),
      totalMem: deps.totalMem ?? totalmem,
      freeMem: deps.freeMem ?? freemem,
      diskUsage: deps.diskUsage ?? defaultDiskUsage,
      isMac: deps.isMac ?? platform() === "darwin"
    };
  }

  read(): Promise<HostStats> {
    const { now } = this.deps;
    if (this.cached && now() - this.cached.at < MIN_INTERVAL_MS) return Promise.resolve(this.cached);
    this.inflight ??= this.sample().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async sample(): Promise<HostStats> {
    let prev = this.prev;
    let cur = await this.collect();
    if (!prev || cur.at - prev.at > BASELINE_STALE_MS) {
      prev = cur;
      await this.deps.sleep(BASELINE_WAIT_MS);
      cur = await this.collect();
    }
    this.prev = cur;
    const seconds = Math.max(0.001, (cur.at - prev.at) / 1000);
    const rates = networkRates(prev.net, cur.net, seconds);
    const pct = (used: number, total: number) => (total > 0 ? clampPercent((used / total) * 100) : 0);
    const stats: HostStats = {
      at: cur.at,
      windowSec: Math.round(seconds * 10) / 10,
      cpu: { percent: cpuPercent(prev.cpu, cur.cpu), cores: cpus().length },
      gpu: { percent: cur.gpuPercent },
      memory: { ...cur.memory, percent: pct(cur.memory.usedBytes, cur.memory.totalBytes) },
      disk: cur.disk ? { ...cur.disk, percent: pct(cur.disk.usedBytes, cur.disk.totalBytes) } : null,
      network: { interface: cur.net?.interface ?? null, rxBytesPerSec: rates.rx, txBytesPerSec: rates.tx }
    };
    this.cached = stats;
    return stats;
  }

  private async defaultInterface(): Promise<string | null> {
    const { now, run: exec } = this.deps;
    if (this.iface && now() - this.iface.at < IFACE_TTL_MS) return this.iface.name;
    let name: string | null = null;
    try { name = parseDefaultInterface(await exec("/sbin/route", ["-n", "get", "default"])); } catch { /* 没有默认路由 = 离线 */ }
    this.iface = { name, at: now() };
    return name;
  }

  private async collect(): Promise<RawSample> {
    const { run: exec, now, isMac } = this.deps;
    const total = this.deps.totalMem();
    const [gpuText, vmText, disk, netText] = await Promise.all([
      isMac ? exec("/usr/sbin/ioreg", ["-r", "-d", "1", "-c", "IOAccelerator"]).catch(() => "") : Promise.resolve(""),
      isMac ? exec("/usr/bin/vm_stat", []).catch(() => "") : Promise.resolve(""),
      this.deps.diskUsage().catch(() => null),
      this.defaultInterface().then((name) => name ? exec("/usr/sbin/netstat", ["-ibn", "-I", name]).then((t) => ({ name, t })).catch(() => null) : null)
    ]);
    const memory = (vmText && parseVmStat(vmText, total)) || { usedBytes: Math.max(0, total - this.deps.freeMem()), totalBytes: total };
    return {
      at: now(),
      cpu: this.deps.cpuTimes(),
      gpuPercent: gpuText ? parseGpuUtilization(gpuText) : null,
      memory,
      disk,
      net: netText ? parseNetstat(netText.t, netText.name) : null
    };
  }
}

export function mountHostStatsRoute(app: Hono, options: { canRead: (c: Context) => boolean; sampler?: HostStatsSampler }): void {
  const sampler = options.sampler ?? new HostStatsSampler();
  app.get("/api/host/stats", async (c) => {
    c.header("Cache-Control", "private, no-store");
    if (!options.canRead(c)) return c.json({ error: "请先登录并启用会话读取权限" }, 401);
    try { return c.json(await sampler.read()); }
    catch { return c.json({ error: "暂时读不到主机状态" }, 503); }
  });
}
