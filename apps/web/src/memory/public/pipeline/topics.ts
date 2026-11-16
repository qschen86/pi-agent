import { createHash } from 'node:crypto';
import { invokeStructured, type ModelInvocationPort, type RoleModelConfig } from '@pi-agent/model-port';
import { timePointHits } from '../time-point.js';
import { CROSS_MODULE, GOAL_MODULE } from './modules.js';
import { observationId, STATEMENT_MAX, TOPIC_MAX } from './distill.js';
import { BACKGROUND_SUB, CAPS, MATERIAL_TTL_DAYS, PERSONAL_SUBS, PROGRESS_SUB, type Domain, type EvidenceRef, type Observation, type Sub, type Tier, type Topic } from './types.js';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 10);
const EVIDENCE_KEEP = 6, SESSIONS_KEEP = 60, HISTORY_KEEP = 8;
const day = 86_400_000;
/** 个人偏好找不到合法性质时的兜底（旧数据 / 模型没给）：归「流程」，不能归「目标」——目标要真的说过才算 */
export const DEFAULT_PERSONAL_SUB = '流程' as const;

/* ------------------------------ 重要度（确定性） ------------------------------ */

/**
 * 重要度（确定性，不让模型打分）：明确指令 3 + 红线 2 + 跨功能 1 + 多会话重复（最多 3）。
 * A（常驻候选）≥6；B（按需）≥4；其余留在素材层，不进公共层。
 * 只被一个会话提到一次、又没有红线的说法，最高到 B（4 分）：要进常驻，必须有红线或在多个会话里反复出现。
 */
export function scoreOf(s: { explicit: number; sessions: number; redLine: boolean; crossFeature: boolean }): number {
  return (s.explicit > 0 ? 3 : 0) + (s.redLine ? 2 : 0) + (s.crossFeature ? 1 : 0) + Math.min(Math.max(s.sessions - 1, 0), 3);
}
export const tierOf = (score: number): Tier => (score >= 6 ? 'A' : score >= 4 ? 'B' : 'material');
/** 用户亲口说了“记住…”的主题得分下限：至少进按需层（B），不会因为只提了一次、没红线而留在不被消费的素材层。要进常驻仍要靠红线或反复强调。 */
export const REMEMBER_FLOOR = 4;
/** 「背景」类（用户本人和家人的长期事实）且用户亲口说了“记住”：直接进常驻层（A）。它短、稳定，每个新会话都用得上，不必等红线或反复强调。 */
export const BACKGROUND_FLOOR = 6;

/* ------------------------------ 相似度：只用来做“高把握”的合并 ------------------------------ */

export const gramsOf = (s: string): Set<string> => {
  const t = s.replace(/[\s，。；：、（）()「」“”"'\-—,.;:!?！？]+/g, '');
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
};

/**
 * 字符二元组的 idf 加权重叠系数。纯词面相似度抓不住换种说法的同一条规则（实测“键盘遮挡”几种说法只有 0.1–0.3），
 * 所以阈值定得高（0.5）：宁可漏合并也不错合并。漏掉的由模型在“归属”一步判断，判断结果落盘，之后不再变。
 */
export const ATTACH_SIMILARITY = 0.5;
export class Corpus {
  private readonly grams = new Map<string, Set<string>>();
  private readonly idf = new Map<string, number>();
  constructor(observations: readonly Observation[]) {
    const df = new Map<string, number>();
    for (const o of observations) {
      const g = gramsOf(o.topic + o.statement); this.grams.set(o.id, g);
      for (const x of g) df.set(x, (df.get(x) ?? 0) + 1);
    }
    const n = observations.length;
    for (const [g, c] of df) this.idf.set(g, Math.log((n + 1) / (c + 0.5)));
  }
  private weight(set: Set<string>): number { let w = 0; for (const g of set) w += this.idf.get(g) ?? 0; return w; }
  sim(a: Observation, b: Observation): number {
    const x = this.grams.get(a.id), y = this.grams.get(b.id);
    if (!x || !y) return 0;
    let shared = 0; for (const g of x) if (y.has(g)) shared += this.idf.get(g) ?? 0;
    const denom = Math.min(this.weight(x), this.weight(y));
    return denom > 0 ? shared / denom : 0;
  }
  /** 观察与某个主题（成员集合）的最高相似度。 */
  toTopic(o: Observation, members: readonly Observation[]): number { let best = 0; for (const m of members) if (m.id !== o.id) best = Math.max(best, this.sim(o, m)); return best; }
}

/* ------------------------------ 归属：确定性先行，剩下的才问模型 ------------------------------ */

/**
 * 极性护栏：词面高度相似、但一个说“要…”一个说“不要…”的，多半是互相矛盾的两条（“用直链” / “不要用直链，用文件 chip”），
 * 不能当成同一条规则自动合并——交给模型判断关系。只看否定词个数的奇偶：宁可多问模型一次（线上已合并的成员对里约三分之一奇偶不同，
 * 绝大多数是同一条规则的不同说法，模型会判 same），也不能把一对矛盾静默合成一条。去掉否定词再比相似度的做法试过：
 * 带补充说明的矛盾句（“用直链” vs “不要用直链，用文件 chip”）会漏掉。
 */
const NEGATION = /不要|不能|不得|不应|禁止|严禁|勿|不可|无需|不必|不准|切勿|别再|别用|别把|别让|别在|别动|别碰|别去/g;
export const polarityOf = (statement: string): number => (statement.match(NEGATION)?.length ?? 0) % 2;
export const flips = (a: { statement: string }, b: { statement: string }): boolean => polarityOf(a.statement) !== polarityOf(b.statement);

/** 观察的模块（没归类的算跨模块） */
const moduleKey = (o: { module?: string }): string => o.module ?? CROSS_MODULE;
/**
 * 同一个主题只在同一模块内合并（跨模块的可以和任何模块合并）：不同功能模块的两条规则即使措辞很像，
 * 也是两件事——“部署要等空闲”和“部署页要显示进度”不能因为都写了“部署”就并成一条。
 */
export const moduleCompatible = (a: string, b: string): boolean => a === b || a === CROSS_MODULE || b === CROSS_MODULE;

export interface AttachPlan {
  /** 确定性并入已有主题的观察 */
  attach: Map<string, string>;
  /** 其余观察按相似度连成的组（组内已经确定是一回事）；等待模型决定并入哪个主题 / 互相合并 / 新建 */
  groups: Observation[][];
}
export function planAttach(corpus: Corpus, unassigned: readonly Observation[], membersByTopic: ReadonlyMap<string, readonly Observation[]>): AttachPlan {
  const attach = new Map<string, string>();
  const rest: Observation[] = [];
  for (const o of unassigned) {
    let best: { id: string; sim: number } | null = null;
    for (const [id, members] of membersByTopic) {
      if (!moduleCompatible(moduleKey(o), moduleOf(members) ?? CROSS_MODULE)) continue;
      const s = corpus.toTopic(o, members.filter(m => !flips(o, m))); if (s >= ATTACH_SIMILARITY && (!best || s > best.sim || (s === best.sim && id < best.id))) best = { id, sim: s };
    }
    if (best) attach.set(o.id, best.id); else rest.push(o);
  }
  // 剩下的互相连：单链接，相似度 ≥ 阈值就进同一组
  const parent = rest.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; } return i; };
  for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) if (moduleCompatible(moduleKey(rest[i]!), moduleKey(rest[j]!)) && corpus.sim(rest[i]!, rest[j]!) >= ATTACH_SIMILARITY && !flips(rest[i]!, rest[j]!)) parent[find(j)] = find(i);
  const byRoot = new Map<number, Observation[]>();
  rest.forEach((o, i) => { const r = find(i); (byRoot.get(r) ?? byRoot.set(r, []).get(r)!).push(o); });
  return { attach, groups: [...byRoot.values()] };
}

export const ATTACH_CONFIG: RoleModelConfig = {
  role: 'memoryCandidate', provider: 'deepseek', model: 'deepseek-flash', thinking: 'off',
  promptVersion: 'memory-attach@2', schemaVersion: 'memory-attach@2', timeoutMs: 90_000, maxAttempts: 2
};
const ATTACH_BATCH = 25, CANDIDATES_PER_GROUP = 5;
const ATTACH_SYSTEM = [
  '你在判断公共记忆里“哪些说法其实是同一条规则”。你只做归属判断，不改写任何文字。',
  '输入：groups（每组是几条已经确认是同一件事的说法，id 为 g1、g2…）和 candidates（已有主题：id、topic、statement，只是候选，多数组与它们无关）。',
  '把所有 group 分成若干“集合”：同一集合里的 group 讲的是同一条规则（措辞不同也算，如“按钮不能被键盘挡住”和“键盘弹起时操作区要可见”）。每个集合可以并入一个已有主题（topicId=candidates 里的 id），或者新建（topicId=null）。',
  '宁缺毋滥：只是相关、主题相近但规则不同的，不要合并；拿不准就各自单独成集合、topicId=null。每个 group 恰好出现在一个集合里。',
  '每个集合还要给出 relation，说明它和 topicId 指向的已有主题的关系（topicId 为 null 时固定是 "new"）：',
  '- same：同一条规则的不同说法，没有新信息；',
  '- refine：还是那条规则，但补充了细节或收窄 / 放宽了范围；',
  '- replace：和已有主题相反，或用户明显改了主意，新说法应当取代旧的（如以前要求用直链，现在改成文件 chip）；',
  '- conflict：相反或矛盾，但看不出该以谁为准。',
  '一个说“要…”、一个说“不要…”的同一件事不是 same，必须是 replace 或 conflict。reason 用一句话（≤40 字）说明 replace / conflict 的依据，其余可省。',
  '只返回 JSON：{"sets":[{"groups":["g1","g3"],"topicId":"…或null","relation":"same|refine|replace|conflict|new","reason":"…"}]}。'
].join('\n');

export type Relation = 'same' | 'refine' | 'replace' | 'conflict' | 'new';
const RELATIONS: readonly string[] = ['same', 'refine', 'replace', 'conflict', 'new'];
interface AttachSet { groups: string[]; topicId: string | null; relation?: string; reason?: string }
function validateAttach(v: unknown, groupIds: ReadonlySet<string>, topicIds: ReadonlySet<string>): string[] {
  const s = (v as { sets?: unknown } | null)?.sets;
  if (!Array.isArray(s)) return ['sets must be an array'];
  const errors: string[] = [], seen = new Set<string>();
  for (const x of s as AttachSet[]) {
    if (!x || !Array.isArray(x.groups) || !x.groups.length) { errors.push('groups required'); continue; }
    for (const g of x.groups) { if (!groupIds.has(g)) errors.push(`unknown group ${g}`); else if (seen.has(g)) errors.push(`duplicate group ${g}`); seen.add(g); }
    if (x.topicId !== null && !topicIds.has(x.topicId)) errors.push(`unknown topic ${x.topicId}`);
    if (x.relation !== undefined && !RELATIONS.includes(x.relation)) errors.push(`unknown relation ${String(x.relation)}`);
  }
  for (const g of groupIds) if (!seen.has(g)) errors.push(`missing group ${g}`);
  return errors.slice(0, 6);
}

/** relation：新说法与它并入的已有主题的关系；没并入任何主题（topicId=null）固定是 new；模型没给时并入的按 same。 */
export interface Placement { observations: Observation[]; topicId: string | null; relation: Relation; reason?: string }
/**
 * 让模型决定每个确定性分组的去向。返回的每个 Placement 要么并入已有主题，要么（topicId=null）合成一个新主题。
 * 模型失败时每组各自新建——不丢、不乱并；决定一旦落盘就不会再被重新判断。
 */
export async function placeGroups(port: ModelInvocationPort, corpus: Corpus, groups: readonly Observation[][], topics: ReadonlyMap<string, { topic: string; statement: string; members: readonly Observation[] }>): Promise<{ placements: Placement[]; calls: number; failures: number }> {
  const placements: Placement[] = [];
  let calls = 0, failures = 0;
  for (let i = 0; i < groups.length; i += ATTACH_BATCH) {
    const batch = groups.slice(i, i + ATTACH_BATCH);
    const cand = new Map<string, { id: string; topic: string; statement: string }>();
    for (const g of batch) {
      const gm = moduleOf(g) ?? CROSS_MODULE;
      const scored = [...topics].filter(([, t]) => moduleCompatible(gm, moduleOf(t.members) ?? CROSS_MODULE))
        .map(([id, t]) => ({ id, s: Math.max(0, ...g.map(o => corpus.toTopic(o, t.members))) })).sort((a, b) => b.s - a.s || a.id.localeCompare(b.id)).slice(0, CANDIDATES_PER_GROUP);
      for (const { id, s } of scored) if (s > 0) cand.set(id, { id, topic: topics.get(id)!.topic, statement: topics.get(id)!.statement });
    }
    const named = new Map(batch.map((g, k) => [`g${k + 1}`, g]));
    const payload = { groups: [...named].map(([id, g]) => ({ id, statements: g.slice(0, 3).map(o => o.statement) })), candidates: [...cand.values()] };
    calls++;
    const r = await invokeStructured<{ sets: AttachSet[] }>(port, ATTACH_CONFIG, { system: ATTACH_SYSTEM, prompt: JSON.stringify(payload) }, v => validateAttach(v, new Set(named.keys()), new Set(cand.keys())));
    if (!r.ok || !r.value) { failures++; for (const g of batch) placements.push({ observations: g, topicId: null, relation: 'new' }); continue; }
    for (const set of r.value.sets) {
      const relation: Relation = set.topicId === null ? 'new' : set.relation && set.relation !== 'new' ? (set.relation as Relation) : 'same';
      const reason = typeof set.reason === 'string' && set.reason.trim() ? set.reason.trim().slice(0, 80) : undefined;
      placements.push({ observations: set.groups.flatMap(id => named.get(id)!), topicId: set.topicId, relation, ...(reason ? { reason } : {}) });
    }
  }
  return { placements, calls, failures };
}

/* ------------------------------ 陈述：只在成员变了时才写 ------------------------------ */

export const STATEMENT_CONFIG: RoleModelConfig = {
  role: 'memoryCandidate', provider: 'deepseek', model: 'deepseek-flash', thinking: 'off',
  promptVersion: 'memory-statement@1', schemaVersion: 'memory-statement@1', timeoutMs: 90_000, maxAttempts: 2
};
const STATEMENT_BATCH = 10;
const STATEMENT_SYSTEM = [
  '你在给公共记忆的主题写一句话规则。每个主题有若干成员（同一条规则的不同说法，按时间从早到晚）。',
  '为每个主题写：topic（2–16 字，稳定叫法）和 statement（≤140 字，独立可读的“要怎么做/不要怎么做”，只讲一条规则，只写要什么效果、不要什么，不写组件名、变量名、接口、文件路径、实现手段，不含提交号、文件行号、日期、版本号）。成员之间有出入时以时间更晚的为准。',
  '只返回 JSON：{"items":[{"id":"…","topic":"…","statement":"…"}]}，每个主题恰好一项。'
].join('\n');

export interface StatementJob { id: string; members: readonly Observation[] }
export interface StatementResult { id: string; topic: string; statement: string }
const newest = (members: readonly Observation[]): Observation => [...members].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))[0]!;

/** 模型写不出（失败 / 超长 / 带时点信息）时的确定性兜底：取最新成员的说法。 */
export const fallbackStatement = (job: StatementJob): StatementResult => ({ id: job.id, topic: newest(job.members).topic, statement: newest(job.members).statement });

export async function writeStatements(port: ModelInvocationPort, jobs: readonly StatementJob[]): Promise<{ results: Map<string, StatementResult>; calls: number; failures: number }> {
  const results = new Map<string, StatementResult>();
  let calls = 0, failures = 0;
  for (let i = 0; i < jobs.length; i += STATEMENT_BATCH) {
    const batch = jobs.slice(i, i + STATEMENT_BATCH);
    const ids = new Set(batch.map(j => j.id));
    // 单成员主题不必问模型：成员本身就是一句合格的规则
    const need = batch.filter(j => j.members.length > 1);
    for (const j of batch) if (j.members.length === 1) results.set(j.id, fallbackStatement(j));
    if (!need.length) continue;
    calls++;
    const payload = { topics: need.map(j => ({ id: j.id, members: [...j.members].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).slice(-8).map(o => o.statement) })) };
    const r = await invokeStructured<{ items: StatementResult[] }>(port, STATEMENT_CONFIG, { system: STATEMENT_SYSTEM, prompt: JSON.stringify(payload) },
      v => { const it = (v as { items?: unknown } | null)?.items; return Array.isArray(it) ? [] : ['items must be an array']; });
    const got = new Map<string, StatementResult>();
    if (r.ok && r.value) for (const x of r.value.items) { if (ids.has(x?.id) && typeof x.statement === 'string' && typeof x.topic === 'string') got.set(x.id, { id: x.id, topic: x.topic.trim(), statement: x.statement.trim() }); }
    if (!r.ok) failures++;
    for (const j of need) {
      const x = got.get(j.id);
      const ok = x && Array.from(x.statement).length >= 6 && Array.from(x.statement).length <= STATEMENT_MAX && Array.from(x.topic).length >= 2 && Array.from(x.topic).length <= TOPIC_MAX && !timePointHits(x.statement).length;
      if (!ok) failures++;
      results.set(j.id, ok ? x : fallbackStatement(j));
    }
  }
  return { results, calls, failures };
}

/* ------------------------------ 由成员重算主题（确定性） ------------------------------ */

export const memberBasis = (members: readonly Observation[]): string => sha(members.map(o => o.id).sort().join('|'));
export const topicIdFor = (members: readonly Observation[]): string => `t-${sha([...members].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))[0]!.id)}`;

const mostCommon = <T>(xs: readonly T[]): T | undefined => {
  const c = new Map<T, number>(); for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0];
};

/**
 * 主题的功能模块：由成员多数决定（和 domain 一样）。个人偏好没有模块 → null；项目记忆没归类的算跨模块。
 * 声明成函数而不是常量，便于在文件前面的归属 / 候选筛选里直接用。
 */
export function moduleOf(members: readonly Observation[]): string | null {
  const project = members.filter(o => o.domain === 'project');
  if (!project.length) return null;
  return mostCommon(project.map(moduleKey)) ?? CROSS_MODULE;
}

/** 主题的范围由成员多数决定：多数是个人偏好 → 个人偏好；否则是项目记忆（项目取最常见的）。同一条规则不会同时落在两个桶里。 */
export function domainOf(members: readonly Observation[]): { domain: Domain; project: string | null } {
  const personal = members.filter(o => o.domain === 'personal').length;
  if (personal * 2 >= members.length) return { domain: 'personal', project: null };
  return { domain: 'project', project: mostCommon(members.filter(o => o.domain === 'project').map(o => o.project ?? '')) || null };
}

export function rebuildTopic(id: string, prev: Topic | undefined, members: readonly Observation[], text: { topic: string; statement: string } | undefined, now: Date): Topic {
  const base = domainOf(members);
  // 人定的归属（override.scope）优先，流水线不再按成员多数票改回去
  const pinned = prev?.override?.scope;
  const domain = pinned?.domain ?? base.domain;
  const project = domain === 'personal' ? null : pinned?.project ?? base.project;
  // 个人偏好才有性质（目标 / 沟通 / 验收 / 审美 / 流程 / 红线 / 背景）；模型 / 人没给合法值时归「流程」
  const personalSubs: readonly string[] = PERSONAL_SUBS;
  const sub = domain === 'personal'
    ? (pinned?.sub && personalSubs.includes(pinned.sub) ? pinned.sub : mostCommon(members.map(o => o.sub).filter(s => !!s && personalSubs.includes(s))) ?? DEFAULT_PERSONAL_SUB) as Sub
    : undefined;
  // 项目记忆的分类就是模块（含 goal＝目标）；旧数据里的旧性质（约定红线 / 架构边界 / 方法）不再参与归类
  const module = domain === 'project' ? pinned?.module ?? moduleOf(members) ?? CROSS_MODULE : undefined;
  const isGoal = domain === 'project' ? module === GOAL_MODULE : sub === '目标';
  const sorted = [...members].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  const sources = new Map<string, EvidenceRef>();
  for (const o of sorted) for (const e of [
    { obsId: o.id, sessionId: o.sessionId, at: o.at, quote: o.quote, explicit: o.explicit },
    ...(o.repetition ?? []).map(r => ({ ...r, obsId: observationId(r.sessionId, r.quote), explicit: false }))
  ]) {
    const key = `${e.sessionId}\u0000${e.at}\u0000${e.quote}`;
    if (!sources.has(key)) sources.set(key, e);
  }
  const evidence = [...sources.values()].sort((a, b) => b.at.localeCompare(a.at) || a.obsId.localeCompare(b.obsId));
  const sessionIds = [...new Set(evidence.map(e => e.sessionId))].sort();
  const signals = {
    explicit: members.filter(o => o.explicit).length, sessions: sessionIds.length,
    redLine: members.some(o => o.redLine), crossFeature: members.some(o => o.crossFeature),
    firstAt: evidence[evidence.length - 1]!.at, lastAt: evidence[0]!.at, ...(members.some(o => o.remember) ? { remembered: true } : {})
  };
  const remembered = members.some(o => o.remember);
  const score = remembered ? Math.max(scoreOf(signals), sub === BACKGROUND_SUB ? BACKGROUND_FLOOR : REMEMBER_FLOOR) : scoreOf(signals);
  const statement = prev?.override?.statement ?? text?.statement ?? prev?.statement ?? sorted[0]!.statement;
  const history = prev && statement !== prev.statement ? [...prev.history, { at: now.toISOString(), statement: prev.statement }].slice(-HISTORY_KEEP) : prev?.history ?? [];
  return {
    id, domain, project, ...(domain === 'project' && module ? { module } : {}), ...(sub ? { sub } : {}), topic: text?.topic ?? prev?.topic ?? sorted[0]!.topic, statement,
    // 目标不按分数分层：它是后续判断“这个需求符不符合大目标”的尺子，每个新会话都要带上（人定的层优先）
    tier: prev?.override?.tier ?? (isGoal ? 'A' : tierOf(score)), score, signals, sessionIds: sessionIds.slice(-SESSIONS_KEEP),
    evidence: evidence.slice(0, EVIDENCE_KEEP),
    ...(prev?.mergedFrom ? { mergedFrom: prev.mergedFrom } : {}),
    history, asOf: signals.lastAt, memberIds: members.map(o => o.id).sort(), basis: memberBasis(members),
    ...(prev?.origin ? { origin: prev.origin } : {}), ...(prev?.condition ? { condition: prev.condition } : {}), ...(prev?.override ? { override: prev.override } : {}), ...(prev?.imported ? { imported: prev.imported } : {}), ...(prev?.pending ? { pending: prev.pending } : {}), ...(prev?.constraint ? { constraint: prev.constraint } : {})
  };
}

/* ------------------------------ 上限与过期 ------------------------------ */

/** 公共层（A+B）不超过上限，超出的按分数（再按明确次数、会话数、新旧）降为素材层；素材层 90 天无新证据则丢弃。 */
/** 人定的（导入的、被人改过层的）不占上限、不被降级、不过期。 */
export const isPinned = (t: Topic): boolean => t.origin === 'imported' || !!t.override?.tier;

export function enforceCaps(topics: readonly Topic[], now: Date): Topic[] {
  const alive = topics.filter(t => isPinned(t) || !(t.tier === 'material' && now.getTime() - Date.parse(t.signals.lastAt) > MATERIAL_TTL_DAYS * day));
  const demoted = new Set<string>();
  const rank = (a: Topic, b: Topic): number => b.score - a.score || b.signals.explicit - a.signals.explicit || b.signals.sessions - a.signals.sessions || b.signals.lastAt.localeCompare(a.signals.lastAt) || a.id.localeCompare(b.id);
  const eligible = alive.filter(t => t.tier !== 'material' && t.sub !== PROGRESS_SUB && !isPinned(t) && !t.pending);
  // 先按模块限流：一个模块最多 CAPS.perModule 条，热模块不会把别的模块挤光（跨模块 / 未归类的按项目总上限管）
  const byModule = new Map<string, Topic[]>();
  for (const t of eligible) {
    if (t.domain !== 'project' || !t.module || t.module === CROSS_MODULE) continue;
    const k = `${t.project ?? ''}\u0000${t.module}`;
    (byModule.get(k) ?? byModule.set(k, []).get(k)!).push(t);
  }
  for (const list of byModule.values()) { list.sort(rank); for (const t of list.slice(CAPS.perModule)) demoted.add(t.id); }
  // 再按桶（个人 / 每个项目）限总条数，已经在上面被降级的不算名额
  const buckets = new Map<string, Topic[]>();
  for (const t of eligible) {
    if (demoted.has(t.id)) continue;
    const k = t.domain === 'personal' ? 'personal' : `project:${t.project}`;
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(t);
  }
  for (const [k, list] of buckets) {
    const cap = k === 'personal' ? CAPS.personal : CAPS.project;
    list.sort(rank);
    for (const t of list.slice(cap)) demoted.add(t.id);
  }
  return alive.map(t => (demoted.has(t.id) ? { ...t, tier: 'material' as Tier } : t));
}

/** 两边都在素材层的矛盾不影响任何会话（都不会被读到），不值得打扰人去裁决；有一边在公共层才算待裁决。 */
export const bothMaterial = (a: Topic | undefined, b: Topic | undefined): boolean => !!a && !!b && a.tier === 'material' && b.tier === 'material';
