import { createHash } from 'node:crypto';
import { invokeStructured, type ModelInvocationPort, type RoleModelConfig } from '@pi-agent/model-port';
import { CROSS_MODULE, moduleName } from './modules.js';
import { bothMaterial, gramsOf, moduleCompatible, rebuildTopic } from './topics.js';
import type { PipelineState, Topic } from './types.js';

export const REVIEW_CONFIG: RoleModelConfig = {
  role: 'memoryCandidate', provider: 'deepseek', model: 'deepseek-flash', thinking: 'off',
  promptVersion: 'memory-topic-review@1', schemaVersion: 'memory-topic-review@1', timeoutMs: 90_000, maxAttempts: 2
};
const SYSTEM = [
  '复核已经形成的公共记忆主题，判断是否首次提炼时漏合并。只判断关系，不改写陈述。',
  'same：同一条规则的不同说法；refine：同一条规则，补充细节或范围；related：只是相关但要求不同，应该分别保留；conflict：互相矛盾或取代关系，需要人裁决。',
  '例如“前端改完先给截图”和“界面调整提供浅色夜间手机截图，确认后部署”是 refine。截图验收顺序与图片文件 chip 展示方式是 related。',
  '分类不同不代表规则不同；不能因都提到截图、部署或按钮就合并。拿不准一律 related。',
  '返回 JSON {"items":[{"id":"输入的配对编号","relation":"same|refine|related|conflict"}]}，每对恰好一条。'
].join('\n');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
/** 模块口径：个人偏好没有模块，按跨模块参与比较。 */
const modOf = (t: Topic): string => t.module ?? CROSS_MODULE;
const compatible = (a: Topic, b: Topic) => a.domain === b.domain && a.project === b.project &&
  (a.domain === 'personal' || moduleCompatible(modOf(a), modOf(b)));
const editable = (t: Topic) => t.origin !== 'imported' && t.sub !== '进展' && !t.pending && !t.override && t.memberIds.length > 0;
/** 给复核模型看的归类：个人偏好·性质 / 项目·模块（项目没有性质）。 */
const kindOf = (t: Topic): string => (t.domain === 'personal' ? `个人偏好·${t.sub ?? '流程'}` : `项目·${moduleName(t.module ?? 'cross')}`);

/* ------------------------------ 配对排序：同模块 + 字面相似度优先 ------------------------------ */

/**
 * 预算有限（REVIEW_BUDGET），先看哪些配对：同模块、字面最像的先看。
 * 口径与归属阶段相同（topics.ts 的 gramsOf + idf 加权重叠），但不设阈值——相似度只决定先后，真假仍由模型判断。
 * 之前按 score 排序：高分段两两互比先吃掉整个预算，低分主题之间的近重复永远轮不到
 * （线上 45,589 对兼容配对里，tab 样式统一 / 顶部导航统一 / 顶底模糊这几对排在第 1,610–5,028 位，按 40 对/轮要上百轮）。
 */
class PairRanker {
  private readonly grams = new Map<string, Set<string>>();
  private readonly idf = new Map<string, number>();
  constructor(topics: readonly Topic[]) {
    const df = new Map<string, number>();
    for (const t of topics) {
      const g = gramsOf(`${t.topic}${t.statement}`); this.grams.set(t.id, g);
      for (const x of g) df.set(x, (df.get(x) ?? 0) + 1);
    }
    const n = topics.length;
    for (const [g, c] of df) this.idf.set(g, Math.log((n + 1) / (c + 0.5)));
  }
  private weight(set: Set<string>): number { let w = 0; for (const g of set) w += this.idf.get(g) ?? 0; return w; }
  sim(a: Topic, b: Topic): number {
    const x = this.grams.get(a.id), y = this.grams.get(b.id);
    if (!x || !y) return 0;
    let shared = 0; for (const g of x) if (y.has(g)) shared += this.idf.get(g) ?? 0;
    const denom = Math.min(this.weight(x), this.weight(y));
    return denom > 0 ? shared / denom : 0;
  }
}

/** 完整保留双方陈述；不让摘要模型在合并时删掉截图范围等细节。 */
export function combinedStatement(target: string, source: string): string {
  return target.includes(source) ? target : source.includes(target) ? source : `${target}\n${source}`;
}

/** 只迁移成员关系，不重新提炼来源。调用者持运行锁，或在流水线内持有独立状态。 */
export function mergeTopics(state: PipelineState, sourceId: string, targetId: string, now: Date, statement?: string): Topic {
  const source = state.topics[sourceId], target = state.topics[targetId];
  if (!source || !target || sourceId === targetId) throw new Error('合并双方必须是不同的有效主题');
  if (!compatible(source, target) || source.pending || target.pending || source.origin === 'imported' || target.origin === 'imported') throw new Error('不同归属、导入或待裁决主题不能直接合并');
  const ids = [...new Set([...target.memberIds, ...source.memberIds])];
  const members = ids.map(id => state.observations[id]);
  if (members.some(o => !o || state.retired?.[o.id])) throw new Error('成员缺失或已退役，拒绝合并');
  // assignment 与 memberIds 一致才迁移，避免覆盖并发修改或损坏状态。
  for (const id of ids) if (![sourceId, targetId].includes(state.assignment[id]!)) throw new Error('成员归属不一致，拒绝合并');
  const text = statement ?? combinedStatement(target.statement, source.statement);
  const prev = { ...target, ...(target.override?.statement ? { override: { ...target.override, statement: text } } : {}) };
  const merged = rebuildTopic(targetId, prev, members, { topic: target.topic, statement: text }, now);
  merged.mergedFrom = [...new Set([...(target.mergedFrom ?? []), sourceId, ...(source.mergedFrom ?? [])])].sort();
  merged.history = [...target.history, ...source.history, { at: now.toISOString(), statement: source.statement }, ...(target.statement !== text ? [{ at: now.toISOString(), statement: target.statement }] : [])];
  for (const id of ids) state.assignment[id] = targetId;
  state.topics[targetId] = merged;
  delete state.topics[sourceId];
  // 展示证据有数量上限，完整原话始终由 memberIds -> observations 可追溯。
  return merged;
}

/** 每次常规运行复核至多 REVIEW_BUDGET 对：同模块、字面相似度高的先看，跨分类匹配；成功缓存，内容变化重判，失败下次重试。 */
export const REVIEW_BATCH = 20;
export const REVIEW_BUDGET = 120;
export interface ReviewOptions {
  /** 本轮最多复核多少对，缺省 REVIEW_BUDGET */
  budget?: number;
  /** 只复核这个模块内的主题（一次性全量复核脚本用）；不传就是全部 */
  module?: string;
  /** 手动整理的明确子分类边界；不影响其他分类的复核缓存。 */
  topicIds?: readonly string[];
  force?: boolean;
}

export interface ReviewVerdict { aId: string; bId: string; a: string; b: string; relation: string }

export async function reviewTopics(state: PipelineState, port: ModelInvocationPort, now: Date, opts: ReviewOptions = {}): Promise<{ calls: number; failures: number; judged: ReviewVerdict[] }> {
  const budget = Math.max(1, Math.floor(opts.budget ?? REVIEW_BUDGET));
  const onlyModule = opts.module ?? null;
  const selected = opts.topicIds ? new Set(opts.topicIds) : null;
  const protectedIds = new Set(Object.values(state.topics).flatMap(t => t.pending ? [t.pending.withTopicId] : []));
  const topics = Object.values(state.topics)
    .filter(t => editable(t) && !protectedIds.has(t.id) && (!selected || selected.has(t.id)) && (onlyModule === null || modOf(t) === onlyModule))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const cache = state.topicReviews ??= {};
  const ranker = new PairRanker(topics);
  const all: Array<{ id: string; key: string; a: Topic; b: Topic; sim: number; same: boolean }> = [];
  const live = new Set<string>();
  for (let i = 0; i < topics.length; i++) for (let j = i + 1; j < topics.length; j++) {
    const a = topics[i]!, b = topics[j]!;
    if (!compatible(a, b)) continue;
    const key = hash(JSON.stringify([REVIEW_CONFIG.promptVersion, ...[a, b].sort((x, y) => x.id.localeCompare(y.id)).map(t => [t.id, t.basis, t.topic, t.statement, t.domain, t.project, t.sub, t.module])]));
    live.add(key);
    if (opts.force || !cache[key]) all.push({ id: '', key, a, b, sim: ranker.sim(a, b), same: modOf(a) === modOf(b) });
  }
  all.sort((x, y) => Number(y.same) - Number(x.same) || y.sim - x.sim || (y.a.score + y.b.score) - (x.a.score + x.b.score) || x.a.id.localeCompare(y.a.id) || x.b.id.localeCompare(y.b.id));
  all.forEach((p, i) => { p.id = `p${i}`; });
  // 只复核部分模块时不能把别的模块的判定记录当成过期清掉
  if (onlyModule === null && !selected) for (const key of Object.keys(cache)) if (!live.has(key)) delete cache[key];
  let calls = 0, failures = 0;
  const verdicts: ReviewVerdict[] = [];
  for (let i = 0; i < Math.min(all.length, budget); i += REVIEW_BATCH) {
    const batch = all.slice(i, Math.min(i + REVIEW_BATCH, budget));
    const ids = new Set(batch.map(p => p.id));
    calls++;
    const r = await invokeStructured<{ items: Array<{ id: string; relation: string }> }>(port, REVIEW_CONFIG, {
      system: SYSTEM, prompt: JSON.stringify({ pairs: batch.map(p => ({ id: p.id, a: { topic: p.a.topic, statement: p.a.statement, kind: kindOf(p.a) }, b: { topic: p.b.topic, statement: p.b.statement, kind: kindOf(p.b) } })) })
    }, value => {
      const items = (value as { items?: unknown } | null)?.items;
      if (!Array.isArray(items)) return ['items required'];
      const seen = new Set<string>();
      for (const item of items) {
        if (!item || !ids.has(item.id) || seen.has(item.id) || !['same', 'refine', 'related', 'conflict'].includes(item.relation)) return ['invalid pair or relation'];
        seen.add(item.id);
      }
      return seen.size === ids.size ? [] : ['missing pair'];
    });
    if (!r.ok || !r.value) { failures++; continue; }
    for (const item of r.value.items) {
      const p = batch.find(p => p.id === item.id)!;
      const a = state.topics[p.a.id], b = state.topics[p.b.id];
      // 同批次先前的合并已改变主题时，旧判断作废，下次按新内容复核。
      if (a !== p.a || b !== p.b || !a || !b || !editable(a) || !editable(b) || protectedIds.has(a.id) || protectedIds.has(b.id)) continue;
      if (item.relation === 'conflict' && bothMaterial(a, b)) continue;   // 都在素材层：不挂待裁决，也不缓存，其中一边升到公共层后再复核
      cache[p.key] = { at: now.toISOString(), relation: item.relation };
      verdicts.push({ aId: a.id, bId: b.id, a: a.topic, b: b.topic, relation: item.relation });
      if (item.relation === 'same' || item.relation === 'refine') {
        mergeTopics(state, b.id, a.id, now);
      } else if (item.relation === 'conflict') {
        protectedIds.add(a.id);
        b.pending = { kind: 'conflict', withTopicId: a.id, reason: '存量主题复核发现矛盾，需要你裁决', at: now.toISOString() };
      }
    }
  }
  return { calls, failures, judged: verdicts };
}
