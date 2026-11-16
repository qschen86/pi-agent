/**
 * 模型判定的强约束规则要按「功能事实」核对，而不是只看最终回复里的措辞（用户：APK 要查有没有真的推进到发布里）。
 * 这里是平台提供的取证项目录：DeepSeek 写规则时从中挑（规则的 probes），会话里回合开始 / 结束各读一次，
 * 判定模型拿到的是「本回合前后的事实」。目录里没有的事实，规则就只能落到「待补规则」并写明缺什么取证项。
 */
export interface EvidenceProbeInfo { id: string; label: string; description: string }

export const PROBE_CATALOG: readonly EvidenceProbeInfo[] = [
  { id: "changed-files", label: "本回合改动的文件", description: "本回合（含被中断 / 补救的前几轮）工作区里新增或变化的文件路径列表（相对仓库根，最多 200 条）；值是字符串数组，取不到工作区状态时为 null。用来核对「这一轮到底改了哪些东西」（如是否动了 apps/android/ 下的原生工程）。" },
  { id: "android-release", label: "原生 App 发布状态", description: "原生 App 发布目录（release.json）在本回合前后的状态：{before, after, changed}，before / after 形如 {versionCode, versionName, sha256}，从未发布过为 null；changed=true 表示本回合发布了新版本。用来核对「改了原生 App 之后有没有真的推进到发布」。" },
  { id: "live-deploy", label: "线上部署状态", description: "线上最近一次成功部署的提交在本回合前后的状态：{before, after, changed}，形如 {commit, at}；changed=true 表示本回合有新的提交真的上线了。用来核对「有没有真的部署上线」。" }
];
export const PROBE_IDS: readonly string[] = PROBE_CATALOG.map((p) => p.id);
export const isProbeId = (id: unknown): id is string => typeof id === "string" && PROBE_IDS.includes(id);
export const probeLabel = (id: string): string => PROBE_CATALOG.find((p) => p.id === id)?.label ?? id;

/** 取证项读取器（由平台服务注入）：返回当前状态；读不到抛错或返回 undefined。changed-files 不在这里，由会话管理器按工作区快照给。 */
export type ProbeReaders = Partial<Record<string, () => Promise<unknown>>>;
export const READER_PROBE_IDS = ["android-release", "live-deploy"] as const;

/** 一个「前后对比」型取证项的事实：基线读不到时不下结论（changed 不给）。 */
export function beforeAfterFact(before: unknown, after: unknown, hasBaseline: boolean): Record<string, unknown> {
  if (!hasBaseline) return { after: after ?? null, note: "没有回合开始时的状态，无法判断本回合有没有变化" };
  return { before: before ?? null, after: after ?? null, changed: JSON.stringify(before ?? null) !== JSON.stringify(after ?? null) };
}

/** 带时限地读一组取证项；失败的返回 undefined（不影响会话）。 */
export async function readProbeStates(ids: readonly string[], readers: ProbeReaders, timeoutMs = 3000): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  await Promise.all(ids.map(async (id) => {
    const read = readers[id];
    if (!read) return;
    try { out[id] = await Promise.race([read(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs).unref())]); } catch { /* 读不到就没有这项事实 */ }
  }));
  return out;
}
