import { CROSS_MODULE, PROJECT_MODULES, moduleById, moduleName } from './modules.js';
import type { Observation, PipelineState, Tier, Topic } from './types.js';

/**
 * 存量回填：给还没有模块的老条目做**确定性初判**（不调模型、不改陈述），由人抽查后再写回。
 * 判据只有两种：主题名命中判定词记 2 分（主题名短、专指），陈述命中记 1 分；最高分要 ≥ 2 才算归类成功，
 * 否则一律落跨模块（待归类）——只凭陈述里一个泛词就去猜，更容易猜错，宁可留给人一眼看到。
 * 一切都写进 review 表里（命中了哪些词、次选是谁），所以任何一条都能被人一眼核。
 */
export interface Guess {
  module: string;
  /** high = 命中 ≥ 2 分且有明显领先；medium = 只命中 1 次或领先不多；low = 没命中，落跨模块 */
  confidence: 'high' | 'medium' | 'low';
  hits: string[];
  /** 次选模块与它的分数（给抽查时做对照） */
  alternatives: Array<{ module: string; score: number }>;
  reason: string;
}

const TOPIC_WEIGHT = 2, STATEMENT_WEIGHT = 1, LEAD = 2;

/** 一条条目的模块初判（纯函数）。已有人定 / 已归类的条目原样返回，不覆盖人的决定。 */
export function guessModule(t: Pick<Topic, 'topic' | 'statement' | 'domain' | 'module' | 'origin'>): Guess {
  if (t.domain === 'personal') return { module: '', confidence: 'high', hits: [], alternatives: [], reason: '个人偏好不挂模块' };
  if (t.origin === 'imported') return { module: CROSS_MODULE, confidence: 'low', hits: [], alternatives: [], reason: '导入条目没有原话，留待人定' };
  if (t.module) return { module: t.module, confidence: 'high', hits: [], alternatives: [], reason: '已有模块，保持不变' };
  const topic = t.topic ?? '', statement = t.statement ?? '';
  const scores = new Map<string, { score: number; hits: string[] }>();
  for (const m of PROJECT_MODULES) {
    let score = 0; const hits: string[] = [];
    for (const k of m.hints) {
      if (topic.includes(k)) { score += TOPIC_WEIGHT; hits.push(`${k}(主题)`); }
      if (statement.includes(k)) { score += STATEMENT_WEIGHT; hits.push(k); }
    }
    if (score) scores.set(m.id, { score, hits });
  }
  const ranked = [...scores].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
  const alternatives = ranked.slice(1, 3).map(([module, v]) => ({ module, score: v.score }));
  if (!ranked.length) return { module: CROSS_MODULE, confidence: 'low', hits: [], alternatives: [], reason: '没命中任何模块的判定词，落「待归类」等人定' };
  if (ranked[0]![1].score < TOPIC_WEIGHT) return { module: CROSS_MODULE, confidence: 'low', hits: ranked[0]![1].hits, alternatives: ranked.slice(0, 2).map(([module, v]) => ({ module, score: v.score })), reason: `只在陈述里命中 ${ranked[0]![1].hits.join('、')}（${ranked[0]![1].score} 分），证据太弱，落「待归类」等人定` };
  const [top, runup] = ranked;
  const lead = top![1].score - (runup ? runup[1].score : 0);
  const confidence: Guess['confidence'] = lead >= LEAD ? 'high' : 'medium';
  return {
    module: top![0], confidence, hits: top![1].hits,
    alternatives,
    reason: `命中 ${top![1].hits.join('、')}（${top![1].score} 分）${runup ? `，次选「${moduleName(runup[0])}」${runup[1].score} 分` : ''}`
  };
}

export interface BackfillRow {
  topicId: string; project: string | null; tier: Tier; topic: string; statement: string;
  score: number; current: string; guess: Guess; memberCount: number;
  /** 人的决定（覆盖初判）；写了就按它落库 */
  override?: string;
}
export interface BackfillPlan {
  rows: BackfillRow[];
  /** 需要写回的条目 → 模块（已排除不需要改的） */
  changes: Array<{ topicId: string; module: string; source: 'guess' | 'override' }>;
  counts: { total: number; already: number; personal: number; toWrite: number; cross: number; unknownOverride: string[] };
}

/**
 * 出一份回填计划：只动**还没有模块**的项目条目（不碰个人偏好、不碰已归档的、不碰人定过的层）。
 * overrides：{ topicId: moduleId }，值必须是已知模块或 'cross'，写错的会进 counts.unknownOverride，不猜。
 */
export function planBackfill(state: PipelineState, overrides: Record<string, string> = {}): BackfillPlan {
  const rows: BackfillRow[] = [], changes: BackfillPlan['changes'] = [], unknownOverride: string[] = [];
  let already = 0, personal = 0, cross = 0;
  const known = new Set<string>([CROSS_MODULE, ...PROJECT_MODULES.map(m => m.id)]);
  for (const t of Object.values(state.topics)) {
    if (t.domain === 'personal') { personal++; continue; }
    if (t.module) { already++; continue; }
    const guess = guessModule(t);
    const raw = overrides[t.id];
    const override = raw === undefined ? undefined : known.has(raw) ? raw : (unknownOverride.push(`${t.id}:${raw}`), undefined);
    const memberCount = (t.memberIds ?? []).length;
    rows.push({ topicId: t.id, project: t.project, tier: t.tier, topic: t.topic, statement: t.statement, score: t.score, current: CROSS_MODULE, guess, memberCount, ...(override ? { override } : {}) });
    const chosen = override ?? guess.module;
    if (guess.confidence === 'low') cross++;
    changes.push({ topicId: t.id, module: chosen, source: override ? 'override' : 'guess' });
  }
  rows.sort((a, b) => (a.project ?? '').localeCompare(b.project ?? '') || b.score - a.score || a.topicId.localeCompare(b.topicId));
  return { rows, changes, counts: { total: rows.length, already, personal, toWrite: changes.length, cross, unknownOverride } };
}

/** 把计划落到状态上（纯函数，返回新状态）：只写 topic.module 与它的观察 module，别的一律不动。 */
export function applyBackfill(state: PipelineState, plan: BackfillPlan): PipelineState {
  const next: PipelineState = structuredClone(state);
  const byTopic = new Map(plan.changes.map(c => [c.topicId, c.module]));
  for (const [id, module] of byTopic) {
    const t = next.topics[id];
    if (!t || t.domain === 'personal') continue;
    next.topics[id] = { ...t, module };
    for (const oid of t.memberIds ?? []) { const o = next.observations[oid]; if (o && o.domain === 'project') next.observations[oid] = { ...o, module }; }
  }
  return next;
}

/**
 * review 表（Markdown）：给用户抽查用，一条一行，带上命中依据与次选。
 * 默认只逐条列**公共层**（常驻 / 按需，就是会话能读到的那批）；素材层只在末尾给个汇总，加上 includeMaterial 才逐条列。
 */
export function renderBackfillReview(plan: BackfillPlan, at: string, opts: { includeMaterial?: boolean } = {}): string {
  const head = [
    '# 存量条目的模块初判（待抽查，未写回）', '',
    `生成于 ${at}。项目条目里：已经有模块 ${plan.counts.already} 条，本次要回填 ${plan.counts.toWrite} 条（其中初判不出内容、落「待归类」的 ${plan.counts.cross} 条），个人偏好 ${plan.counts.personal} 条不参与。`, '',
    '判据：主题名命中判定词 2 分、陈述命中 1 分，取最高分；领先不足 2 分或零命中就落跨模块（待归类）。**只看措辞，不调模型、不改任何陈述文字。**', '',
    '想改某条：在 overrides 里写 `"<编号>": "<模块 id 或 cross>"` 再跑一次。模块 id：' + PROJECT_MODULES.map(m => `${m.id}（${m.name}）`).join('、') + `、${CROSS_MODULE}（待归类）。`, ''
  ];
  if (plan.counts.unknownOverride.length) head.push(`⚠ 认不出的 override 已忽略：${plan.counts.unknownOverride.join('，')}`, '');
  const shown = plan.rows.filter(r => opts.includeMaterial || r.tier !== 'material');
  const material = plan.rows.length - shown.length;
  if (material && !opts.includeMaterial) head.push(`素材层另有 ${material} 条（不会被会话读到、不进索引），按同样规则初判，不逐条列出；要看全量加 \`--all\`。`, '');
  const rows = [
    '| 编号 | 层 | 分 | 初判模块 | 把握 | 命中依据 | 次选 | 条目 |',
    '|---|---|---|---|---|---|---|---|'
  ];
  for (const r of shown) {
    const chosen = r.override ?? r.guess.module;
    const label = `${moduleName(chosen)}${r.override ? '（人定）' : ''}`;
    const conf = r.guess.confidence === 'high' ? '高' : r.guess.confidence === 'medium' ? '中' : '低';
    const alt = r.guess.alternatives.map(a => `${moduleName(a.module)} ${a.score}`).join('、') || '—';
    const text = r.statement.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
    rows.push(`| ${r.topicId.replace(/^t-/, '').slice(0, 8)} | ${r.tier === 'A' ? '常驻' : r.tier === 'B' ? '按需' : '素材'} | ${r.score} | ${label} | ${conf} | ${r.guess.hits.join('、') || r.guess.reason} | ${alt} | ${text} |`);
  }
  return [...head, ...rows].join('\n') + '\n';
}

/** 观察层面的对照：这次回填会顺带把哪些观察也写上模块（数量对不上时能立刻看出来）。 */
export const observationCountOf = (state: PipelineState, ids: readonly string[]): number => {
  let n = 0;
  for (const id of ids) { const t = state.topics[id]; if (!t) continue; for (const oid of t.memberIds ?? []) if (state.observations[oid]) n++; }
  return n;
};
export const moduleTitle = (id: string): string => moduleName(id);
export const moduleExists = (id: string): boolean => id === CROSS_MODULE || !!moduleById(id);
