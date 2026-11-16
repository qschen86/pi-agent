import { createHash } from 'node:crypto';
import { CHANGES_KEEP, type ChangeEntry, type ChangeKind, type Observation, type PipelineState, type RunRecord, type Tier, type Topic } from './types.js';

/** 一次运行里做出的“取代 / 冲突”决定（diff 看不出原因，由运行器记下来）。 */
export interface RelationDecision {
  kind: 'superseded' | 'conflict';
  /** superseded：被取代的主题 id（沿用，内容换成新的）；conflict：新建的、待裁决的主题 id */
  topicId: string;
  /** conflict：被冲突的已有主题 */
  withTopicId?: string;
  reason?: string;
}

const QUOTE_MAX = 80;
const clip = (s: string, n: number): string => (Array.from(s).length > n ? `${Array.from(s).slice(0, n).join('')}…` : s);
const isPublic = (t: Topic): boolean => t.tier !== 'material' && !t.pending;
const idOf = (...parts: string[]): string => createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12);

/** 这次新并入主题的最新一条观察：触发点位（会话 + 用户原话）。 */
function trigger(t: Topic, prev: Topic | undefined, obs: Record<string, Observation>): { sessionId?: string; quote?: string } {
  const known = new Set(prev?.memberIds ?? []);
  const fresh = t.memberIds.filter(id => !known.has(id)).map(id => obs[id]).filter((o): o is Observation => !!o).sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  const o = fresh[0];
  return o ? { sessionId: o.sessionId, quote: clip(o.quote, QUOTE_MAX) } : {};
}

/**
 * 对比运行前后的主题，生成变更日志。纯函数：只看公共层（A / B，且不在待裁决）的变化——素材层的进出是内部噪声，不算“记忆的更新”。
 * 同一个主题在一次运行里最多一条“内容类”变更（新增 / 更新 / 取代 / 合并），升降级另记一条。
 */
export function diffChanges(prev: PipelineState, next: PipelineState, ctx: { at: string; trigger: RunRecord['trigger']; decisions: readonly RelationDecision[] }): ChangeEntry[] {
  const out: ChangeEntry[] = [];
  const byTopic = new Map(ctx.decisions.map(d => [d.topicId, d]));
  let n = 0;
  const push = (kind: ChangeKind, t: Topic, extra: Partial<ChangeEntry> = {}): void => {
    out.push({ id: idOf(ctx.at, kind, t.id, String(n++)), at: ctx.at, kind, topicId: t.id, topic: t.topic, statement: t.statement, tier: t.tier, domain: t.domain, project: t.project, trigger: ctx.trigger, ...extra });
  };
  for (const t of Object.values(next.topics)) {
    const p = prev.topics[t.id];
    const d = byTopic.get(t.id);
    const trig = trigger(t, p, next.observations);
    if (t.pending) {
      if (!p?.pending) push('conflict', t, { ...trig, before: prev.topics[t.pending.withTopicId]?.statement ?? next.topics[t.pending.withTopicId]?.statement, note: d?.reason ?? t.pending.reason });
      continue;
    }
    if (t.tier === 'material') {
      if (p && isPublic(p)) push('demoted', t, { tierBefore: p.tier, note: '降为素材层（超出上限或证据不足）' });
      continue;
    }
    if (!p || !isPublic(p)) { push('added', t, { ...trig, ...(p?.pending ? { note: '冲突已裁决，采用新的' } : {}) }); continue; }
    if (d?.kind === 'superseded') push('superseded', t, { ...trig, before: p.statement, note: d.reason ?? '用户明确要求，取代了旧的' });
    else if (t.mergedFrom?.some(id => !p.mergedFrom?.includes(id))) push('merged', t, { ...trig, before: p.statement, note: `存量主题合并，来源完整保留：${t.mergedFrom.filter(id => !p.mergedFrom?.includes(id)).join('、')}` });
    else if (t.statement !== p.statement) push('updated', t, { ...trig, before: p.statement });
    else if (t.memberIds.some(id => !p.memberIds.includes(id))) push('merged', t, { ...trig, note: '又被提到一次，证据 +1' });
    if (t.tier !== p.tier) push(rank(t.tier) > rank(p.tier) ? 'promoted' : 'demoted', t, { tierBefore: p.tier });
  }
  for (const p of Object.values(prev.topics)) if (isPublic(p) && !next.topics[p.id]) {
    const target = Object.values(next.topics).find(t => t.mergedFrom?.includes(p.id));
    push('removed', p, { note: target ? `已并入 ${target.id}，原观察和会话来源保留` : '已不再有效（过期、证据撤回或被清理）' });
  }
  return out;
}
const rank = (t: Tier): number => (t === 'A' ? 2 : t === 'B' ? 1 : 0);

export const appendChanges = (state: PipelineState, entries: readonly ChangeEntry[]): void => {
  state.changes = [...(state.changes ?? []), ...entries].slice(-CHANGES_KEEP);
};
