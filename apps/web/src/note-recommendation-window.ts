/** Pure, deterministic window reconciliation. Storage belongs to NoteIterations. */
import type { RoiAssessment } from "./note-ranking.js";
export type WindowCandidate = { id: string; revision: number; evaluationVersion: string; score: number; sourceIds: string[]; createdAt: string; assessment?: RoiAssessment; legacyScore?: number };
export type RecommendationWindow = { version: number; algorithmVersion: number; entries: WindowCandidate[] };
export function reconcileRecommendationWindow(previous: RecommendationWindow | undefined, candidates: WindowCandidate[], algorithmVersion: number): RecommendationWindow {
  const positions = new Map(previous?.entries.map((e, i) => [e.id, i]));
  const sorted = [...candidates].filter(c => Number.isFinite(c.score) && c.score > 0).sort((a, b) => b.score - a.score || (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const sources = new Set<string>(), ids = new Set<string>();
  const entries = sorted.filter(c => {
    if (ids.size >= 10 || ids.has(c.id) || !c.sourceIds.length || c.sourceIds.some(id => sources.has(id))) return false;
    ids.add(c.id); c.sourceIds.forEach(id => sources.add(id)); return true;
  });
  if (previous?.algorithmVersion === algorithmVersion && JSON.stringify(previous.entries.map(e => [e.id, e.revision, e.evaluationVersion])) === JSON.stringify(entries.map(e => [e.id, e.revision, e.evaluationVersion]))) return previous;
  return { version: (previous?.version ?? 0) + 1, algorithmVersion, entries };
}
