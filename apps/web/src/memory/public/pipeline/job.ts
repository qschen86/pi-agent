import { createHash } from 'node:crypto';
import type { ModelInvocationPort } from '@pi-agent/model-port';
import { reviewTopics } from './topic-review.js';
import { captureSessions, type ManualMarks } from './capture.js';
import { DISTILL_CONFIG, GROUNDING_VERSION, distillInput, distillSession, isMemoryMeta, type DistillDrops } from './distill.js';
import { SCOPE_JUDGE_VERSION, judgeScopes } from './scope-judge.js';
import { resolveModule } from './modules.js';
import { bindRules, judgeConstraints, needsConstraintJudge, settleConstraint } from './constraint.js';
import { RepetitionIndex } from './repetition.js';
import { buildProgress } from './progress.js';
import { appendChanges, diffChanges, type RelationDecision } from './changes.js';
import { Corpus, bothMaterial, enforceCaps, isPinned, memberBasis, placeGroups, planAttach, rebuildTopic, topicIdFor, writeStatements } from './topics.js';
import { MATERIAL_TTL_DAYS, PROGRESS_SUB, PROGRESS_TTL_DAYS, emptyPipelineState, trimRuns, type Observation, type ObservationDraft, type Pending, type PipelineState, type RunRecord, type SessionDigest, type Shipped, type Topic } from './types.js';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);
const day = 86_400_000;

async function pool<T>(items: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => { while (next < items.length) { const i = next++; await fn(items[i]!); } }));
}

/**
 * 项目进展已废弃，不再生成：进展以 git 为准、当前状态以仓库里的代码为准，记忆里再存一份就会出现两个互相打架的版本。
 * 存量进展条目（若有）在下一次运行里自然消失；采集也不再接入部署通知。
 * 留着逻辑与开关只为兼容历史数据与回放脚本，不要再打开。
 */
export const PROGRESS_ENABLED = false;

export interface PipelineRunOptions {
  dataDir: string; port: ModelInvocationPort; now?: Date; since?: string; concurrency?: number; limit?: number;
  trigger?: RunRecord['trigger']; log?: (s: string) => void;
  /** 只提炼这些会话（即时通道）：别的变化了的会话留给每日运行。仍然采集全部会话，进展与主题重算不受影响。 */
  onlySessions?: readonly string[];
  /** 用户手动「加入记忆」的消息：采集时标 manual，当作明确的记忆指令。 */
  manualMarks?: ManualMarks;
  resolveTitle?: (s: Shipped) => string;
  /** 是否生成项目进展；缺省取 PROGRESS_ENABLED（目前关） */
  progress?: boolean;
}
export interface PipelineRunResult { state: PipelineState; run: RunRecord; drops: DistillDrops; projects: string[] }

/** 会话的提炼指纹：输入文本 + 提示词版本 + 落地规则版本 + 已知项目。变了才重新提炼。 */
const digestHash = (d: SessionDigest, input: string, projects: readonly string[]): string => {
  const revisions = d.messages.filter(m => m.memoryRevision).map(m => [m.at, m.context?.memory]);
  // 仅修订会话追加指纹，让旧缓存补提炼，同时保留普通会话的缓存。
  const revisionBasis = revisions.length ? JSON.stringify(revisions) : '';
  // 手动「加入记忆」的消息同样追加指纹：已经提炼过的会话，点了之后要重新提炼一次
  const manual = d.messages.filter(m => m.manual).map(m => m.at);
  return sha(input + DISTILL_CONFIG.promptVersion + GROUNDING_VERSION + projects.join(',') + (d.project ?? '') + revisionBasis + (manual.length ? `|manual:${manual.join(',')}` : ''));
};

/**
 * 一次增量运行：采集 → 只提炼变化了的会话 → 新观察归属（确定性先行，其余问模型一次并落盘）→ 成员变了的主题才重写陈述 → 既有主题复核 → 重算信号与上限 → 进展。
 * 输入状态不被修改，返回新状态；未变化且已复核的主题不重复调用模型。首次运行（空状态）就是全量回填。
 */
export async function runPipeline(prev: PipelineState, opts: PipelineRunOptions): Promise<PipelineRunResult> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => undefined);
  const state: PipelineState = structuredClone(prev);
  state.retired ??= {}; state.changes ??= []; state.pendingObservations ??= {}; state.humanScopeLabels ??= [];
  // 旧迁移合并的条目可能只剩人工确认与导入依据，按导入条目保留，避免无成员时被重算清掉。
  for (const topic of Object.values(state.topics)) {
    if (topic.imported && topic.memberIds.length === 0) topic.origin = 'imported';
  }
  const retired = state.retired;
  const pending = state.pendingObservations;
  const dismissed = state.dismissedObservations ?? {};
  for (const id of Object.keys(dismissed)) delete pending[id];
  const run: RunRecord = { at: now.toISOString(), durationMs: 0, trigger: opts.trigger ?? 'manual', sessions: 0, changedSessions: 0, distillCalls: 0, observationsAdded: 0, observationsRemoved: 0, attachCalls: 0, statementCalls: 0, modelFailures: 0, topicsPublic: 0, topicsMaterial: 0, error: null };
  const drops: DistillDrops = { ungrounded: 0, timePoint: 0, invalid: 0, meta: 0 };

  const cap = captureSessions({ dataDir: opts.dataDir, ...(opts.since ? { since: opts.since } : {}), ...(opts.manualMarks ? { manualMarks: opts.manualMarks } : {}) });
  const sessions = opts.limit ? cap.sessions.slice(-opts.limit) : cap.sessions;
  run.sessions = sessions.length;

  // 0 清掉已有的“讨论公共记忆机制本身”的观察（过滤规则是后来加的；提示词/落地版本没变，所以不会因此重新提炼全部会话）
  // 被清掉观察的会话同时作废提炼指纹：本次按最新规则重新提炼它（真正的元内容会在提炼时再被丢弃，规则不会被一并误伤）
  for (const [id, o] of Object.entries(state.observations)) if (isMemoryMeta(o)) { delete state.observations[id]; delete state.assignment[id]; delete state.sessions[o.sessionId]; run.observationsRemoved++; drops.meta++; }

  // 1 提炼：只处理指纹变了的会话（新会话 / 有了新消息）；一个会话重新提炼后，它旧的观察被整体替换
  const only = opts.onlySessions ? new Set(opts.onlySessions) : null;
  const changed = sessions.filter(s => { if (only && !only.has(s.sessionId)) return false; const input = distillInput(s); return !!input && state.sessions[s.sessionId]?.hash !== digestHash(s, input, cap.projects); });
  run.changedSessions = changed.length;
  const repetitionIndex = changed.length ? new RepetitionIndex(cap.sessions) : null;
  const fresh = new Map<string, { observations: Observation[]; unscoped: ObservationDraft[] }>();
  await pool(changed, opts.concurrency ?? 6, async s => {
    run.distillCalls++;
    const r = await distillSession(opts.port, s, cap.projects, drops, repetitionIndex?.forSession(s));
    if (!r.ok) { run.modelFailures++; log(`提炼失败 ${s.sessionId}: ${r.error}`); return; }
    fresh.set(s.sessionId, { observations: r.observations.filter(o => !dismissed[o.id]), unscoped: r.unscoped.filter(o => !dismissed[o.id]) });
  });
  for (const s of changed) {
    const got = fresh.get(s.sessionId);
    if (!got) continue;                                                          // 失败的下次再试（指纹没更新）
    const obs = got.observations;
    const old = new Set(Object.values(state.observations).filter(o => o.sessionId === s.sessionId).map(o => o.id));
    for (const id of old) if (!obs.some(o => o.id === id)) { delete state.observations[id]; delete state.assignment[id]; run.observationsRemoved++; }
    for (const o of obs) { if (!state.observations[o.id]) run.observationsAdded++; state.observations[o.id] = o; }
    // 归属分不清的：进待判定；会话重新提炼后不再出现的跟进来的观察一起清掉
    const oldPending = Object.values(pending).filter(p => p.sessionId === s.sessionId);
    for (const p of oldPending) if (!got.unscoped.some(d => d.id === p.id)) delete pending[p.id];
    for (const d of got.unscoped) pending[d.id] ??= { ...d, sessionProject: s.project, addedAt: now.toISOString() };
    state.sessions[s.sessionId] = { hash: digestHash(s, distillInput(s)!, cap.projects), obsIds: obs.map(o => o.id) };
  }

  // 2 归属二判：提炼时没把握的，开推理再判一次；high 直接落地，仍 uncertain 的冻结（不进主题 / 注入 / 索引），等人判定
  const toJudge = Object.values(pending).filter(p => p.judged?.version !== SCOPE_JUDGE_VERSION);
  if (toJudge.length) {
    const judged = await judgeScopes(opts.port, toJudge.map(p => ({ draft: p, sessionProject: p.sessionProject })), cap.projects, state.humanScopeLabels);
    run.modelFailures += judged.failures;
    for (const p of toJudge) {
      const s = judged.results.get(p.id);
      if (!s || pending[p.id] !== p) continue;                                    // 模型失败 / 结果不合法：下次再判
      if (s.confidence === 'high') {
        state.observations[p.id] = { id: p.id, sessionId: p.sessionId, runtime: p.runtime, at: p.at, domain: s.domain, project: s.project, ...(s.domain === 'personal' ? { sub: s.sub } : { module: resolveModule(s.module ?? p.module ?? null) }), topic: p.topic, statement: p.statement, quote: p.quote, explicit: p.explicit, redLine: p.redLine, crossFeature: p.crossFeature, ...(p.remember ? { remember: true } : {}), ...(p.repetition ? { repetition: p.repetition } : {}) };
        run.observationsAdded++;
        delete pending[p.id];
      } else {
        p.judged = { at: now.toISOString(), version: SCOPE_JUDGE_VERSION, confidence: 'uncertain', ...(s.reason ? { reason: s.reason } : {}) };
        p.suggestion = s;
      }
    }
  }
  // 没人处理的待判定条目不会永久堆积：90 天后连同原话一起丢掉
  for (const [id, p] of Object.entries(pending)) if (now.getTime() - Date.parse(p.addedAt) > MATERIAL_TTL_DAYS * day) delete pending[id];

  for (const id of Object.keys(retired)) if (!state.observations[id]) delete retired[id];     // 会话重新提炼后观察没了，退役记录跟着清理

  // 2 部署通知 → 进展来源（按提交去重，只留 30 天）
  const progressOn = opts.progress ?? PROGRESS_ENABLED;
  if (progressOn) {
    const known = new Set(state.shipped.map(x => x.sha));
    for (const s of sessions) for (const x of s.shipped) if (!known.has(x.sha)) { known.add(x.sha); state.shipped.push(x); }
    state.shipped = state.shipped.filter(x => now.getTime() - Date.parse(x.at) <= 30 * day).sort((a, b) => b.at.localeCompare(a.at));
  } else state.shipped = [];                                                       // 关着：不接入部署通知，也清掉之前攒下的
  const projectOfSession = new Map(cap.sessions.map(s => [s.sessionId, s.project]));
  for (const x of state.shipped) if (!projectOfSession.has(x.sessionId)) projectOfSession.set(x.sessionId, null);

  // 3 归属：已落盘的不动；新观察先走确定性高相似度，其余分组交给模型一次
  const all = Object.values(state.observations).filter(o => !retired[o.id]).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const byId = new Map(all.map(o => [o.id, o]));
  for (const id of Object.keys(state.assignment)) if (!byId.has(id) || !state.topics[state.assignment[id]!]) delete state.assignment[id];
  const members = new Map<string, Observation[]>();
  for (const [oid, tid] of Object.entries(state.assignment)) (members.get(tid) ?? members.set(tid, []).get(tid)!).push(byId.get(oid)!);
  const unassigned = all.filter(o => !state.assignment[o.id]);
  const dirty = new Set<string>();
  const decisions: RelationDecision[] = [];
  const pendingNew = new Map<string, Pending>();
  if (unassigned.length) {
    const corpus = new Corpus(all);
    const plan = planAttach(corpus, unassigned, members);
    for (const [oid, tid] of plan.attach) { state.assignment[oid] = tid; (members.get(tid) ?? members.set(tid, []).get(tid)!).push(byId.get(oid)!); dirty.add(tid); }
    const topicInfo = new Map([...members].map(([id, m]) => [id, { topic: state.topics[id]?.topic ?? '', statement: state.topics[id]?.statement ?? '', members: m }]));
    const placed = plan.groups.length ? await placeGroups(opts.port, corpus, plan.groups, topicInfo) : { placements: [], calls: 0, failures: 0 };
    run.attachCalls += placed.calls; run.modelFailures += placed.failures;
    const nowIso = now.toISOString();
    for (const p of placed.placements) {
      const target = p.topicId ? state.topics[p.topicId] : undefined;
      let relation = p.relation;
      // 明确记忆意图（记住或引用纠正）才自动取代；人定的旧条目及推断的取代仍交给人裁决。
      if (relation === 'replace' && (!target || isPinned(target) || !!target.override?.statement || !p.observations.some(o => o.remember))) relation = 'conflict';
      if (relation === 'replace' && p.topicId) {
        const tid = p.topicId;
        for (const m of members.get(tid) ?? []) { retired[m.id] = { at: nowIso, by: p.observations[0]!.id, topicId: tid }; delete state.assignment[m.id]; }
        members.set(tid, [...p.observations]);
        for (const o of p.observations) state.assignment[o.id] = tid;
        dirty.add(tid);
        decisions.push({ kind: 'superseded', topicId: tid, ...(p.reason ? { reason: p.reason } : {}) });
        continue;
      }
      if (relation === 'conflict' && p.topicId) {
        const tid = topicIdFor(p.observations);
        for (const o of p.observations) state.assignment[o.id] = tid;
        (members.get(tid) ?? members.set(tid, []).get(tid)!).push(...p.observations);
        dirty.add(tid);
        const reason = p.reason ?? '与已有条目相反，需要你判断以哪个为准';
        pendingNew.set(tid, { kind: 'conflict', withTopicId: p.topicId, reason, at: nowIso });
        decisions.push({ kind: 'conflict', topicId: tid, withTopicId: p.topicId, reason });
        continue;
      }
      const tid = p.topicId ?? topicIdFor(p.observations);
      for (const o of p.observations) state.assignment[o.id] = tid;
      (members.get(tid) ?? members.set(tid, []).get(tid)!).push(...p.observations);
      dirty.add(tid);
    }
  }
  for (const tid of [...members.keys()]) if (!members.get(tid)!.length) members.delete(tid);

  // 4 陈述：成员变了（或还没有陈述）才重写；没变的保持原样——这是结果稳定的关键
  const jobs = [...members].filter(([tid, m]) => !state.topics[tid]?.override?.statement && (!state.topics[tid] || state.topics[tid]!.basis !== memberBasis(m) || dirty.has(tid))).map(([id, m]) => ({ id, members: m }));
  const written = jobs.length ? await writeStatements(opts.port, jobs) : { results: new Map(), calls: 0, failures: 0 };
  run.statementCalls += written.calls; run.modelFailures += written.failures;
  const topics: Topic[] = [];
  for (const [tid, m] of members) topics.push(rebuildTopic(tid, state.topics[tid], m, written.results.get(tid), now));
  for (const t of topics) { const pn = pendingNew.get(t.id); if (pn) t.pending = pn; }

  // 导入的条目没有成员，不走重算，原样带过去
  for (const t of Object.values(state.topics)) if (t.origin === 'imported') topics.push(t);

  // 4b 约束类型：入库的公共层条目判一次强 / 软约束（强制措辞默认强约束，拿不准的留给人）；人定的不动，规则清单变了才重判
  const toConstrain = topics.filter(needsConstraintJudge);
  if (toConstrain.length) {
    const judged = await judgeConstraints(opts.port, toConstrain, now);
    run.constraintCalls = (run.constraintCalls ?? 0) + judged.calls; run.modelFailures += judged.failures;
    for (const t of toConstrain) { const c = judged.results.get(t.id); if (c) t.constraint = c; }
  }
  // 强约束必须绑定规则：自动判成强约束的，DeepSeek 开推理写四要素、写成了才确认并绑定；写不成的留在「待补规则」
  const bound = await bindRules(opts.port, topics, now);
  run.constraintCalls = (run.constraintCalls ?? 0) + bound.calls; run.modelFailures += bound.failures;
  // 兜底：没有可用规则的强约束（旧数据、代码规则被删）落到「待补规则」，含人指定过的
  for (const t of topics) settleConstraint(t);

  // 即时采集不增加复核延迟；定时和手动运行也会处理既有主题，无需新观察。
  state.topics = Object.fromEntries(topics.map(t => [t.id, t]));
  if (run.trigger !== 'instant') {
    const review = await reviewTopics(state, opts.port, now);
    run.reviewCalls = review.calls; run.modelFailures += review.failures;
  }
  topics.splice(0, topics.length, ...Object.values(state.topics));

  // 5 进展（不经模型）+ 上限与过期
  const shippedBy = new Map<string, Shipped[]>();
  for (const x of state.shipped) { const p = projectOfSession.get(x.sessionId); if (p) (shippedBy.get(p) ?? shippedBy.set(p, []).get(p)!).push(x); }
  if (progressOn) for (const [p, list] of shippedBy) { const t = buildProgress(p, list, now, opts.resolveTitle); if (t) topics.push(t); }
  // 待裁决的冲突，如果被冲突的旧条目已经不在了（过期 / 清理），冲突自然消解，新条目按普通条目处理
  const liveIds = new Set(topics.map(t => t.id));
  for (const t of topics) if (t.pending && !liveIds.has(t.pending.withTopicId)) delete t.pending;
  // 两边都在素材层的冲突不需要人裁决
  const topicById = new Map(topics.map(t => [t.id, t]));
  for (const t of topics) if (t.pending && bothMaterial(t, topicById.get(t.pending.withTopicId))) delete t.pending;
  const final = enforceCaps(topics, now);
  // 素材层过期的主题连同它的成员观察一起清掉
  const keep = new Set(final.map(t => t.id));
  for (const t of topics) if (!keep.has(t.id)) for (const oid of t.memberIds) { delete state.observations[oid]; delete state.assignment[oid]; }
  state.topics = Object.fromEntries(final.map(t => [t.id, t]));
  for (const s of Object.values(state.sessions)) s.obsIds = s.obsIds.filter(id => state.observations[id]);

  appendChanges(state, diffChanges(prev, state, { at: now.toISOString(), trigger: run.trigger, decisions }));

  run.topicsPublic = final.filter(t => t.tier !== 'material').length;
  run.topicsMaterial = final.length - run.topicsPublic;
  run.durationMs = Date.now() - started;
  state.runs = trimRuns([...state.runs, run]);
  log(`运行完成：会话 ${run.sessions}（变化 ${run.changedSessions}），观察 +${run.observationsAdded}/-${run.observationsRemoved}，公共层 ${run.topicsPublic}，素材层 ${run.topicsMaterial}，模型调用 提炼 ${run.distillCalls} / 归属 ${run.attachCalls} / 陈述 ${run.statementCalls} / 存量复核 ${run.reviewCalls ?? 0}，失败 ${run.modelFailures}`);
  return { state, run, drops, projects: cap.projects };
}

export { emptyPipelineState, MATERIAL_TTL_DAYS, PROGRESS_SUB, PROGRESS_TTL_DAYS };
