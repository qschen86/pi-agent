import type { RoiAssessment } from './note-ranking.js';
import type { RecommendationWindow } from './note-recommendation-window.js';
export type Exposure = { id: string; at: string; taskId: string; revision: number; evaluationVersion: string; algorithmVersion: number; position: number; score: number; assessment?: RoiAssessment; legacyScore?: number };
export type RecommendationResult = { id: string; at: string; taskId: string; revision: number; evaluationVersion: string; kind: 'launch' | 'done' | 'ignore'; channel: 'manual' | 'archive' | 'sources'; cycle: number; reason?: string; revokedAt?: string };
export type ExposureBatch = { batchId: string; windowVersion: number; algorithmVersion: number; entries: { taskId: string; revision: number; evaluationVersion: string; position: number }[] };
export const IGNORE_REASONS = ['unspecified', 'value', 'effort', 'irrelevant', 'other'] as const;
export function validateExposureBatch(value: unknown, windows: RecommendationWindow[]): ExposureBatch['entries'] {
  const b = value as ExposureBatch | undefined;
  if (!b || typeof b.batchId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(b.batchId) || !Number.isSafeInteger(b.windowVersion) || !Number.isSafeInteger(b.algorithmVersion) || !Array.isArray(b.entries) || b.entries.length < 1 || b.entries.length > 10) throw new Error('曝光记录无效');
  const w = windows.find(w => w.version === b.windowVersion && w.algorithmVersion === b.algorithmVersion);
  if (!w) throw new Error('推荐窗口已过期，请刷新');
  const seen = new Set<string>();
  for (const e of b.entries) {
    const own = e && w.entries[e.position - 1];
    if (!Number.isSafeInteger(e?.position) || !own || own.id !== e.taskId || own.revision !== e.revision || own.evaluationVersion !== e.evaluationVersion || seen.has(e.taskId)) throw new Error('曝光条目与窗口不符');
    seen.add(e.taskId);
  }
  return b.entries;
}
const sameVersion = (e: Exposure, r: RecommendationResult) => e.taskId === r.taskId && e.revision === r.revision && e.evaluationVersion === r.evaluationVersion && Date.parse(e.at) <= Date.parse(r.at);
export function calibrationSample(exposures: Exposure[], results: RecommendationResult[], consumed: string[], now = new Date()) {
  const floor = now.getTime() - 30 * 86400000;
  const liveExposures = exposures.filter(e => Date.parse(e.at) >= floor && Date.parse(e.at) <= now.getTime());
  const latest = new Map<string, RecommendationResult>();
  for (const r of results) {
    if (r.revokedAt || r.channel !== 'manual' || !['done','ignore'].includes(r.kind) || Date.parse(r.at) < floor || Date.parse(r.at) > now.getTime() || !liveExposures.some(e => sameVersion(e,r))) continue;
    const key = `${r.taskId}:${r.revision}:${r.cycle}`;
    const prev = latest.get(key);
    if (!prev || r.kind === 'done' || Date.parse(r.at) > Date.parse(prev.at)) latest.set(key,r);
  }
  const valid = [...latest.values()];
  const newIds = valid.filter(r => !consumed.includes(r.id));
  const counts = { exposed: new Set(liveExposures.map(e => e.taskId)).size, results: new Set(valid.map(r => r.taskId)).size, fresh: new Set(newIds.map(r => r.taskId)).size };
  return { eligible: counts.exposed >= 20 && counts.results >= 10 && counts.fresh >= 5, counts, results: valid,
    behaviors: valid.map(r => ({ ...r, exposure: [...liveExposures].reverse().find(e => sameVersion(e,r)), weakSignals: results.filter(w => !w.revokedAt && w.taskId === r.taskId && w.revision === r.revision && w.evaluationVersion === r.evaluationVersion && Date.parse(w.at) >= floor && Date.parse(w.at) <= Date.parse(r.at) && (w.kind === 'launch' || (w.kind === 'done' && w.channel !== 'manual'))) })) };
}
