import { appData } from '../../../app-data.js';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelInvocationPort } from '@pi-agent/model-port';
import { catchUpWait } from '../../../diagnostics/scheduler.js';
import { nextBeijingRunAt } from '../../../platform-time.js';
import { dailyBeijingSchedule, registerPlatformScheduledTask } from '../../../platform-scheduled-tasks.js';
import { captureSessions, classifyMessage, stripMemoryQuotes, memoryRevisionContext } from './capture.js';
import { hasRememberCue } from './distill.js';
import { CONSTRAINT_JUDGE_VERSION } from './constraint.js';
import { draftRule, validateDraft, type RuleDraft } from './rule-draft.js';
import { enforcementRule, enforcementRuleCatalog, type EnforcementRuleInfo } from '../../../../../../packages/runtime-sessions/src/memory-enforcement.js';
import { runPipeline } from './job.js';
import { CROSS_MODULE, moduleFromQuery, moduleIds, moduleName, resolveModule } from './modules.js';
import { PipelineStore } from './store.js';
import { appendChanges, diffChanges } from './changes.js';
import { applyReviewUnits, prepareManualReview, type ReviewSummary } from './manual-review.js';
import type { PipelineState } from './types.js';
import { rebuildTopic, topicIdFor } from './topics.js';
import { HUMAN_SCOPE_KEEP, PERSONAL_SUBS, PROGRESS_SUB, trimRuns, type ChangeEntry, type RuleSpec, type Domain, type HumanScopeLabel, type Observation, type PendingObservation, type PersonalSub, type RunRecord, type Shipped, type Topic } from './types.js';

export const FEED_UNREAD_DEFAULT_DAYS = 7;
/** 不计入未读的变更来源：用户自己的裁决 */
export const FEED_UNREAD_EXCLUDED_SOURCE = 'human';

/** 给一条记忆写校验规则的后台任务（落盘到 rule-drafts.json；前端轮询，退出界面再回来可以接着看）。 */
export interface RuleDraftJob { topicId: string; /** 写规则时这条记忆的陈述：陈述变了，旧草稿不再复用 */ statement?: string; state: 'running' | 'ready' | 'error'; startedAt: string; finishedAt?: string; draft?: RuleDraft; codeRule?: boolean; error?: string; /** true = 模型明确判断没法事后检查（不是调用失败） */ infeasible?: boolean }

const RULE_DRAFT_KEEP_MS = 7 * 24 * 3600_000, RULE_DRAFT_MAX = 30;

export class PipelineError extends Error { constructor(readonly code: 'invalid-input' | 'busy' | 'not-found', message: string) { super(message); } }

/** 一条记忆的归类：个人偏好选性质（sub），项目记忆选模块（module）；两者不共存。 */
export interface ScopeChoice { domain: Domain; project: string | null; sub?: PersonalSub; module?: string }
export interface ScopeInput { domain: unknown; project?: unknown; sub?: unknown; module?: unknown; tier?: unknown; note?: unknown }

/** 校验并归一归类入参（接口与页面共用）：个人偏好只要性质，项目只要模块。 */
export function parseScopeChoice(input: ScopeInput): ScopeChoice {
  const domain = input.domain === 'personal' || input.domain === 'project' ? input.domain : null;
  if (!domain) throw new PipelineError('invalid-input', '归属必须是个人偏好或项目');
  // 模块：项目记忆才有的维度，只认清单里的 id / 中文名 / 别名（认不出不能悄悄落成「跨模块」）
  const moduleInput = typeof input.module === 'string' && input.module.trim() ? input.module.trim() : null;
  if (domain === 'personal') {
    if (moduleInput) throw new PipelineError('invalid-input', '个人偏好没有模块');
    if (typeof input.sub !== 'string' || !(PERSONAL_SUBS as readonly string[]).includes(input.sub)) throw new PipelineError('invalid-input', '请选择个人偏好的性质');
    return { domain, project: null, sub: input.sub as PersonalSub };
  }
  const project = typeof input.project === 'string' && input.project.trim() ? input.project.trim() : '';
  if (!project) throw new PipelineError('invalid-input', '项目记忆必须指定项目');
  const module = moduleInput ? moduleFromQuery(moduleInput) : CROSS_MODULE;
  if (!module) throw new PipelineError('invalid-input', '模块不在清单里');
  return { domain, project, module };
}

/** 归类的人话：个人偏好·性质 / 项目·模块。 */
export const scopeChoiceText = (d: { domain: Domain; project: string | null; sub?: unknown; module?: string }): string =>
  d.domain === 'personal' ? `个人偏好 · ${d.sub ?? '—'}` : `${d.project || '项目'} · ${moduleName(d.module ?? CROSS_MODULE)}`;

/** 两条归类是不是同一处（项目比模块，个人比性质）。 */
export const sameScopeChoice = (t: { domain: Domain; project: string | null; sub?: unknown; module?: string }, d: ScopeChoice): boolean =>
  t.domain === d.domain && (d.domain === 'personal' ? (t.sub ?? '') === (d.sub ?? '') : t.project === d.project && (t.module ?? CROSS_MODULE) === (d.module ?? CROSS_MODULE));

export const PIPELINE_HOUR = 3, PIPELINE_MINUTE = 30;   // 北京时间，落在 DeepSeek 波谷

export interface ManualReviewStatus { id: string; scope: ScopeChoice; phase: 'running' | 'ready' | 'applied' | 'error'; result?: ReviewSummary; error?: string; applied?: number }
const stateBasis = (state: PipelineState) => createHash('sha256').update(JSON.stringify(state)).digest('hex');

/** 本轮明确要求记忆，或纠正引用规则、紧接着确认新原则。previousHuman 由调用者排除系统 actor。 */
export const needsInstantIntake = (userTexts: readonly string[], previousHuman = ''): boolean => userTexts.some(t => {
  const own = stripMemoryQuotes(t);
  const hit = classifyMessage(own) === 'user' && (hasRememberCue(own) || !!memoryRevisionContext(t, previousHuman));
  previousHuman = t;
  return hit;
});

const INSTANT_RETRY_MS = 60_000, INSTANT_RETRY_MAX = 3;

export interface PipelineServiceOptions {
  dataDir: string; root: string; port: ModelInvocationPort;
  /** 开关（默认关）：只管定时运行；手动触发不受它限制 */
  enabled: () => boolean;
  now?: () => Date; log?: (m: string) => void; resolveTitle?: (s: Shipped) => string;
  /** 测试用：覆盖并发 */
  concurrency?: number;
  /** 状态写盘之后回调（用来刷新按需索引文件）。回调出错不影响运行结果。 */
  onChange?: () => void;
}

/** 公共记忆 v2 流水线的服务：持久化、单飞、每日增量调度、状态与主题视图。 */
/** 动态里一次运行的汇总：这次运行落下的变更按类型计数（total=0 即“本次无变化”）。 */
export interface ChangeRunSummary { at: string; trigger: 'schedule' | 'manual'; durationMs: number; error: string | null; total: number; kinds: Partial<Record<ChangeEntry['kind'], number>> }
export const CHANGE_SOURCES: readonly ChangeEntry['trigger'][] = ['schedule', 'manual', 'instant', 'human'];

export class PipelineService {
  readonly store: PipelineStore;
  private running: Promise<RunRecord | null> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private catchUp: NodeJS.Timeout | undefined;
  private stopped = false;
  private queued = new Set<string>();
  private retryTimers = new Set<NodeJS.Timeout>();
  private review: ManualReviewStatus | null = null;
  private reviewDraft: { id: string; basis: string } | null = null;
  constructor(private readonly opts: PipelineServiceOptions) { this.store = new PipelineStore(opts.root); }
  private now(): Date { return (this.opts.now ?? (() => new Date()))(); }

  isRunning(): boolean { return this.running !== null; }

  manualReview(): ManualReviewStatus | null { return this.review; }

  /** 子分类整理只处理已有公共记忆。长任务在后台生成预览，不写正式记忆。 */
  startManualReview(input: ScopeInput): ManualReviewStatus {
    if (!input || typeof input !== 'object') throw new PipelineError('invalid-input', '请选择子分类');
    if (input.domain === 'project' && (typeof input.module !== 'string' || !input.module.trim())) throw new PipelineError('invalid-input', '请选择项目的子分类');
    const scope = parseScopeChoice(input);
    if (this.running) throw new PipelineError('busy', '记忆正在处理中，稍后再试');
    const release = this.store.acquire(this.now().getTime());
    if (!release) throw new PipelineError('busy', '别的进程正在处理记忆，稍后再试');
    let state: PipelineState;
    try { state = this.store.read(); } catch (e) { release(); throw e; }
    release(); // 预览只修改副本；其他进程可正常写入，应用时再持锁核对指纹。
    const status: ManualReviewStatus = { id: createHash('sha256').update(`${Date.now()}|${Math.random()}`).digest('hex').slice(0, 16), scope, phase: 'running' };
    this.review = status; this.reviewDraft = null;
    const basis = stateBasis(state);
    const ids = Object.values(state.topics).filter(t => t.tier !== 'material' && sameScopeChoice(t, scope)).map(t => t.id);
    this.running = (async () => {
      try {
        status.result = await prepareManualReview(state, ids, this.opts.port, this.now());
        this.reviewDraft = { id: status.id, basis };
        status.phase = 'ready';
      } catch (e) { status.phase = 'error'; status.error = (e as Error).message; }
      return null;
    })().finally(() => { this.running = null; });
    return status;
  }

  /** unitIds 缺省＝应用预览里默认勾选的（非人工固定）；传了就严格按用户勾选。 */
  applyManualReview(id: unknown, unitIds?: unknown): ManualReviewStatus {
    if (this.running) throw new PipelineError('busy', '记忆正在处理中，稍后再试');
    const review = this.review;
    if (!review || typeof id !== 'string' || id !== review.id) throw new PipelineError('not-found', '整理预览已失效，请重新检查');
    if (review.phase === 'applied') return review;
    const draft = this.reviewDraft;
    if (review.phase !== 'ready' || !draft || draft.id !== id) throw new PipelineError('invalid-input', '整理尚未完成');
    const all = review.result?.units ?? [];
    if (unitIds !== undefined && (!Array.isArray(unitIds) || unitIds.some(u => typeof u !== 'string' || !all.some(x => x.id === u)))) throw new PipelineError('invalid-input', '选中的整理项已失效，请重新检查');
    const chosen = new Set<string>(unitIds === undefined ? all.filter(u => !u.pinned).map(u => u.id) : unitIds as string[]);
    if (!chosen.size) throw new PipelineError('invalid-input', '请至少选择一项');
    const release = this.store.acquire(this.now().getTime());
    if (!release) throw new PipelineError('busy', '别的进程正在处理记忆，稍后再试');
    try {
      const prev = this.store.read();
      if (stateBasis(prev) !== draft.basis) throw new PipelineError('busy', '记忆已变化，请重新检查后应用');
      const next = structuredClone(prev);
      try { review.applied = applyReviewUnits(next, all.filter(u => chosen.has(u.id)), this.now()); }
      catch (e) { throw new PipelineError('invalid-input', `整理项无法应用：${(e as Error).message}`); }
      appendChanges(next, diffChanges(prev, next, { at: this.now().toISOString(), trigger: 'manual', decisions: [] }));
      this.store.write(next);
      review.phase = 'applied'; this.reviewDraft = null;
      try { this.opts.onChange?.(); } catch { /* 下次读取刷新索引 */ }
      return review;
    } finally { release(); }
  }

  /** 跑一次增量运行。同进程单飞；别的进程在跑（锁）时返回 null。失败只记录，不抛。 */
  run(trigger: RunRecord['trigger'] = 'manual', onlySessions?: readonly string[]): Promise<RunRecord | null> {
    if (this.running) return this.running;
    this.running = (async () => {
      const release = this.store.acquire(this.now().getTime());
      if (!release) { this.opts.log?.('公共记忆流水线：别的进程正在运行，跳过'); return null; }
      try {
        const prev = this.store.read();
        try {
          const r = await runPipeline(prev, { dataDir: this.opts.dataDir, port: this.opts.port, now: this.now(), trigger, manualMarks: this.store.manualMarks(), ...(onlySessions ? { onlySessions } : {}), ...(this.opts.log ? { log: this.opts.log } : {}), ...(this.opts.resolveTitle ? { resolveTitle: this.opts.resolveTitle } : {}), ...(this.opts.concurrency ? { concurrency: this.opts.concurrency } : {}) });
          this.store.write(r.state);
          try { this.opts.onChange?.(); } catch { /* 索引下次读取时会重新生成 */ }
          return r.run;
        } catch (e) {
          const run: RunRecord = { at: this.now().toISOString(), durationMs: 0, trigger, sessions: 0, changedSessions: 0, distillCalls: 0, observationsAdded: 0, observationsRemoved: 0, attachCalls: 0, statementCalls: 0, modelFailures: 0, topicsPublic: 0, topicsMaterial: 0, error: (e as Error).message };
          this.opts.log?.(`公共记忆流水线失败：${run.error}`);
          try { prev.runs = trimRuns([...prev.runs, run]); this.store.write(prev); } catch { /* 记不下来也不影响下次 */ }
          return run;
        }
      } finally { release(); }
    })().finally(() => { this.running = null; });
    return this.running;
  }

  /**
   * 即时通道：明确记忆指令或对已有规则的修订，本轮结束只提炼这个会话。
   * 不看 pipelineEnabled——那个开关只管每日定时。已有运行在跑就排到它后面；别的进程占着锁则 60 秒后再试，最多 3 次。
   * 提炼失败不在这里重试：指纹没记，下一次运行会补上。
   */
  instant(sessionId: string, attempt = 0): Promise<RunRecord | null> {
    if (this.stopped) return Promise.resolve(null);
    this.queued.add(sessionId);
    return this.drainInstant(attempt);
  }
  private async drainInstant(attempt: number): Promise<RunRecord | null> {
    while (this.running) await this.running.catch(() => null);
    if (!this.queued.size || this.stopped) return null;      // 前一个等待者已经带走了队列
    const ids = [...this.queued]; this.queued.clear();
    this.opts.log?.(`即时提炼：${ids.join(', ')}`);
    let r: RunRecord | null;
    try { r = await this.run('instant', ids); }
    catch (e) { this.opts.log?.(`即时提炼失败（每日运行会补上）：${(e as Error).message}`); return null; }   // run 自己不抛；读不到状态这类意外也要留下痕迹
    if (r === null && attempt < INSTANT_RETRY_MAX && !this.stopped) {
      for (const id of ids) this.queued.add(id);
      const t = setTimeout(() => { this.retryTimers.delete(t); void this.drainInstant(attempt + 1); }, INSTANT_RETRY_MS);
      t.unref?.(); this.retryTimers.add(t);
    }
    return r;
  }

  /** 这个会话里用户手动「加入记忆」过的消息 key（页面用来显示「已加入」）。 */
  manualKeys(sessionId: string): string[] { return [...(this.store.manualMarks().get(sessionId) ?? [])]; }

  /**
   * 用户在一条消息上点了「加入记忆」：记下这条（本轮结束的自动提炼因此跳过），立刻只提炼这个会话。
   * 消息必须是这个会话里真人发的、过了敏感过滤的用户消息；重复点击不重复调模型（提炼指纹没变）。
   * queued = 别的进程占着锁，稍后自动重试，不是失败。
   */
  async rememberMessage(sessionId: unknown, key: unknown): Promise<{ added: number; queued: boolean; error: string | null }> {
    if (typeof sessionId !== 'string' || !sessionId || typeof key !== 'string' || !key) throw new PipelineError('invalid-input', '缺少会话或消息');
    let found = false;
    try { found = captureSessions({ dataDir: this.opts.dataDir, sessionIds: [sessionId] }).sessions[0]?.messages.some(m => m.key === key) ?? false; }
    catch { throw new PipelineError('not-found', '读不到这个会话的记录'); }
    if (!found) throw new PipelineError('not-found', '这条消息不能加入记忆（不是你发的，或含有敏感内容）');
    this.store.markManual(sessionId, key);
    const r = await this.instant(sessionId);
    return { added: r?.observationsAdded ?? 0, queued: r === null, error: r?.error ?? null };
  }

  status(): { enabled: boolean; running: boolean; conflicts: number; pendingScopes: number; lastRun: RunRecord | null; nextRunAt: string | null; modules: Array<{ id: string; name: string }>; constraintRules: EnforcementRuleInfo[]; counts: { observations: number; sessions: number; personal: Record<string, number>; projects: Record<string, Record<string, number>> } } {
    const s = this.store.read();
    const personal: Record<string, number> = { A: 0, B: 0, material: 0 };
    const projects: Record<string, Record<string, number>> = {};
    for (const t of Object.values(s.topics)) {
      if (t.domain === 'personal') personal[t.tier] = (personal[t.tier] ?? 0) + 1;
      else { const p = (projects[t.project ?? '?'] ??= { A: 0, B: 0, material: 0 }); p[t.tier] = (p[t.tier] ?? 0) + 1; }
    }
    // 模块清单（页面按模块分组 / 筛选用）：id 与显示名都从 modules.ts 来，前端不再各写一份
    const modules = moduleIds().map(id => ({ id, name: moduleName(id) }));
    return { enabled: this.opts.enabled(), running: this.isRunning(), conflicts: Object.values(s.topics).filter(t => t.pending).length, pendingScopes: Object.keys(s.pendingObservations ?? {}).length, modules, constraintRules: enforcementRuleCatalog(), lastRun: s.runs[s.runs.length - 1] ?? null, nextRunAt: this.opts.enabled() ? nextBeijingRunAt(this.now(), PIPELINE_HOUR, PIPELINE_MINUTE).toISOString() : null, counts: { observations: Object.keys(s.observations).length, sessions: Object.keys(s.sessions).length, personal, projects } };
  }

  /** 归属待判定的观察（冻结中，不进主题 / 注入 / 索引）：原话、提炼出的规则、会话所属项目、二判建议。 */
  pendingScopes(): Array<{ id: string; topic: string; statement: string; quote: string; sessionId: string; at: string; addedAt: string; sessionProject: string | null; reason?: string; reasonSource: 'distill' | 'judge'; suggestion?: PendingObservation['suggestion']; judgedAt?: string }> {
    const s = this.store.read();
    return Object.values(s.pendingObservations ?? {})
      .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
      .map(p => ({
        id: p.id, topic: p.topic, statement: p.statement, quote: p.quote, sessionId: p.sessionId, at: p.at, addedAt: p.addedAt, sessionProject: p.sessionProject,
        ...(p.judged?.reason ?? p.scopeReason ? { reason: p.judged?.reason ?? p.scopeReason } : {}),
        reasonSource: p.judged ? 'judge' as const : 'distill' as const,
        ...(p.suggestion ? { suggestion: p.suggestion } : {}),
        ...(p.judged ? { judgedAt: p.judged.at } : {})
      }));
  }

  /**
   * 人判定一条归属（个人偏好 / 项目 + 子类）：把冻结的观察放回素材层并拼进主题，记成人判定样例（全局共用），
   * 写一条 trigger=human 的变更记录。归属钉在主题上（override.scope），流水线以后不再按成员多数票改回去。
   */
  resolveScope(obsId: string, input: ScopeInput): { change: ChangeEntry; topicId: string } {
    if (this.running) throw new PipelineError('busy', '流水线正在运行，稍后再试');
    const choice = parseScopeChoice(input);
    const { domain, project, sub, module } = choice;

    const release = this.store.acquire(this.now().getTime());
    if (!release) throw new PipelineError('busy', '别的进程正在运行流水线，稍后再试');
    try {
      const st = this.store.read();
      st.pendingObservations ??= {}; st.humanScopeLabels ??= [];
      const p = st.pendingObservations[obsId];
      if (!p) throw new PipelineError('not-found', '这条待判定的观察已经不在了（可能已被判定或清理）');
      const now = this.now(), at = now.toISOString();
      const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 120) : undefined;
      const obs: Observation = {
        id: p.id, sessionId: p.sessionId, runtime: p.runtime, at: p.at, domain, project,
        ...(domain === 'personal' ? { sub } : { module: module ?? resolveModule(p.module ?? null) }),
        topic: p.topic, statement: p.statement, quote: p.quote,
        explicit: p.explicit, redLine: p.redLine, crossFeature: p.crossFeature, ...(p.remember ? { remember: true } : {}), ...(p.repetition ? { repetition: p.repetition } : {})
      };
      const target = Object.values(st.topics).find(t => !t.pending && sameScopeChoice(t, choice) && t.topic.trim() === p.topic.trim());
      const tid = target?.id ?? topicIdFor([obs]);
      const members = [
        ...Object.entries(st.assignment).filter(([, t]) => t === tid).map(([oid]) => st.observations[oid]).filter((o): o is Observation => !!o),
        obs
      ];
      st.observations[obs.id] = obs;
      st.assignment[obs.id] = tid;
      const topic = rebuildTopic(tid, target, members, target ? undefined : { topic: obs.topic, statement: obs.statement }, now);
      // 人判定过的至少进按需层（分数够高就常驻），否则刚判定完就落进素材层，用户在新会话里看不到
      if (!target) topic.tier = topic.score >= 6 ? 'A' : 'B';
      topic.override = { ...(target?.override ?? {}), scope: choice, reason: note ?? '你判定的归属', at };
      st.topics[tid] = topic;
      delete st.pendingObservations[obsId];
      const label: HumanScopeLabel = {
        id: obs.id, at, domain, project, ...(sub ? { sub } : {}), ...(module ? { module } : {}), topic: p.topic, statement: p.statement, quote: p.quote,
        ...(p.suggestion ? { suggestion: p.suggestion } : {}), ...(note ? { note } : {})
      };
      st.humanScopeLabels = [label, ...st.humanScopeLabels.filter(l => l.id !== obs.id)].slice(0, HUMAN_SCOPE_KEEP);
      const scopeText = scopeChoiceText(choice);
      const change: ChangeEntry = {
        id: createHash('sha256').update(`${at}|human|scope|${obs.id}`).digest('hex').slice(0, 12),
        at, kind: target ? 'merged' : 'added', topicId: tid, topic: topic.topic, statement: topic.statement,
        tier: topic.tier, domain, project, trigger: 'human', sessionId: obs.sessionId, quote: obs.quote,
        note: `你判定归属：${scopeText}${note ? `（${note}）` : ''}`
      };
      appendChanges(st, [change]);
      this.store.write(st);
      try { this.opts.onChange?.(); } catch { /* 索引下次读取时会重新生成 */ }
      return { change, topicId: tid };
    } finally { release(); }
  }

  /**
   * 人改一条已生效主题的归类（归属 + 个人偏好性质 / 项目模块）：成员观察同步成新归类，override.scope 钉住（流水线不再按成员多数票改回去），
   * 记一条 trigger=human 的变更与人类判定样例。改到的位置已有同归类、同主题名的条目时并过去，原成员与证据完整保留。
   * 待裁决冲突与「进展」类条目不能这样改：前者先裁决，后者由上线通知生成。
   */
  rescopeTopic(topicId: string, input: ScopeInput): { change: ChangeEntry; topicId: string; merged: boolean } {
    if (this.running) throw new PipelineError('busy', '流水线正在运行，稍后再试');
    let choice = parseScopeChoice(input);
    if (input.tier !== undefined && input.tier !== 'A' && input.tier !== 'B') throw new PipelineError('invalid-input', '消费方式必须是常驻或按需');
    const tier = input.tier as 'A' | 'B' | undefined;
    const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 120) : undefined;
    const release = this.store.acquire(this.now().getTime());
    if (!release) throw new PipelineError('busy', '别的进程正在运行流水线，稍后再试');
    try {
      const st = this.store.read();
      st.humanScopeLabels ??= [];
      const t = st.topics[topicId];
      if (!t) throw new PipelineError('not-found', '这条记忆不在了（可能已被合并或移除）');
      if (t.sub === PROGRESS_SUB) throw new PipelineError('invalid-input', '进展类条目由上线通知自动生成，不能改归类');
      if (t.pending) throw new PipelineError('invalid-input', '这条记忆还在等你裁决冲突，先处理冲突再改归类');
      // 没给模块 = 保持原模块（只在项目记忆内改别的维度时），不把模块悄悄落成「跨模块」
      const moduleGiven = choice.domain === 'project' && typeof input.module === 'string' && !!input.module.trim();
      if (choice.domain === 'project' && !moduleGiven && t.domain === 'project') choice = { ...choice, module: t.module ?? CROSS_MODULE };
      const { domain, project, sub, module } = choice;
      if (sameScopeChoice(t, choice) && (tier === undefined || tier === t.tier)) throw new PipelineError('invalid-input', '归类没有变化');
      const now = this.now(), at = now.toISOString();
      const fromText = scopeChoiceText(t), toText = scopeChoiceText(choice);
      const scope = choice;
      const tierOverride = tier === undefined ? {} : { tier };
      const tierNote = tier !== undefined && tier !== t.tier ? `；消费方式：${t.tier === 'A' ? '常驻' : '按需'} → ${tier === 'A' ? '常驻' : '按需'}` : '';
      // 成员观察跟着改成新归类：以后即使有人去掉 override，多数票也不会把它算回旧的
      for (const id of t.memberIds) {
        const o = st.observations[id];
        if (!o) continue;
        o.domain = domain; o.project = project;
        if (domain === 'personal') { if (sub) o.sub = sub; delete o.module; } else { o.module = module ?? resolveModule(o.module ?? null); delete o.sub; }
      }
      const members = t.memberIds.map(id => st.observations[id]).filter((o): o is Observation => !!o);
      const target = Object.values(st.topics).find(x => x.id !== t.id && !x.pending && sameScopeChoice(x, choice) && x.topic.trim() === t.topic.trim());
      let tid = t.id;
      const change: ChangeEntry = {
        id: '', at, kind: 'updated', topicId: t.id, topic: t.topic, statement: t.statement,
        tier: t.tier, domain, project, trigger: 'human',
        note: `你改归类：${fromText} → ${toText}${note ? `（${note}）` : ''}`
      };
      if (target) {
        // 并入已有条目：成员合并、原陈述进历史，证据与会话来源完整保留
        tid = target.id;
        target.override = { ...(target.override ?? {}), scope, ...tierOverride, reason: note ?? '你改的归类', at };
        const next = rebuildTopic(target.id, target, [...target.memberIds.map(id => st.observations[id]).filter((o): o is Observation => !!o), ...members], undefined, now);
        if (t.statement !== next.statement) next.history = [...next.history, { at, statement: t.statement }].slice(-8);
        next.mergedFrom = [...new Set([...(target.mergedFrom ?? []), t.id, ...(t.mergedFrom ?? [])])];
        for (const id of t.memberIds) st.assignment[id] = target.id;
        st.topics[target.id] = next;
        delete st.topics[t.id];
        change.kind = 'merged';
        change.topicId = target.id; change.topic = next.topic; change.statement = next.statement;
        change.tier = next.tier;
        change.note = `你改归类：${fromText} → ${toText}，并入「${next.topic}」${note ? `（${note}）` : ''}`;
      } else {
        t.override = { ...(t.override ?? {}), scope, ...tierOverride, reason: note ?? '你改的归类', at };
        st.topics[t.id] = rebuildTopic(t.id, t, members, undefined, now);
      }
      change.tier = st.topics[tid]!.tier;
      change.tierBefore = t.tier;
      change.note += tierNote;
      const quote = t.evidence[0]?.quote;
      if (quote) {
        const label: HumanScopeLabel = { id: `topic:${t.id}`, at, domain, project, ...(sub ? { sub } : {}), ...(module ? { module } : {}), topic: t.topic, statement: t.statement, quote, ...(note ? { note } : {}) };
        st.humanScopeLabels = [label, ...st.humanScopeLabels.filter(l => l.id !== label.id)].slice(0, HUMAN_SCOPE_KEEP);
      }
      change.id = createHash('sha256').update(`${at}|human|rescope|${t.id}`).digest('hex').slice(0, 12);
      appendChanges(st, [change]);
      this.store.write(st);
      try { this.opts.onChange?.(); } catch { /* 索引下次读取时会重新生成 */ }
      return { change, topicId: tid, merged: !!target };
    } finally { release(); }
  }

  /**
   * 给一条记忆写校验规则（人在记忆页切到强约束的第一步）：DeepSeek 开推理写四要素，要一两分钟，所以后台跑、前端轮询。
   * 只出草稿，不改记忆；人看过、点确认（setConstraint 带上这份规则）才会把记忆标成强约束。同一条记忆同时只跑一个。
   */
  startRuleDraft(topicId: string): RuleDraftJob {
    const t = this.store.read().topics[topicId];
    if (!t) throw new PipelineError('not-found', '这条记忆不在了（可能已被合并或移除）');
    if (t.sub === PROGRESS_SUB) throw new PipelineError('invalid-input', '进展类条目由上线通知自动生成，不能改约束类型');
    const drafts = this.draftMap(), prev = this.ruleDraftJob(topicId);
    if (prev?.state === 'running' && this.draftsInFlight.has(topicId)) return prev;   // 正在跑的接上，不重复调用模型
    const job: RuleDraftJob = { topicId, statement: t.statement, state: 'running', startedAt: this.now().toISOString() };
    drafts.set(topicId, job); this.draftsInFlight.add(topicId);
    this.persistDrafts();
    void draftRule(this.opts.port, t).then(r => {
      if (r.ok) Object.assign(job, { state: 'ready', draft: r.draft, ...(r.draft.ruleId ? { codeRule: true } : {}) });
      else Object.assign(job, { state: 'error', error: r.error, infeasible: r.infeasible });
    }).catch(e => { Object.assign(job, { state: 'error', error: String((e as Error).message ?? e).slice(0, 120), infeasible: false }); })
      .finally(() => { job.finishedAt = this.now().toISOString(); this.draftsInFlight.delete(topicId); if (drafts.get(topicId) === job) this.persistDrafts(); });
    return job;
  }
  /** 这条记忆最近一次的规则草稿（进行中 / 已写好 / 失败）；记忆已不在、陈述变了、超过 7 天的不再复用。 */
  ruleDraftJob(topicId: string): RuleDraftJob | undefined {
    const drafts = this.draftMap(), job = drafts.get(topicId);
    if (!job) return undefined;
    const t = this.store.read().topics[topicId];
    const age = this.now().getTime() - Date.parse(job.finishedAt ?? job.startedAt);
    if (!t || (job.statement !== undefined && job.statement !== t.statement) || age > RULE_DRAFT_KEEP_MS) { drafts.delete(topicId); this.persistDrafts(); return undefined; }
    return job;
  }
  private ruleDrafts: Map<string, RuleDraftJob> | undefined;
  private draftsInFlight = new Set<string>();
  private draftsFile(): string { return join(this.opts.root, 'rule-drafts.json'); }
  /** 草稿表：第一次用到时从磁盘读；上次进程里还在「生成中」的已经没人在跑了，标成被中断。 */
  private draftMap(): Map<string, RuleDraftJob> {
    if (this.ruleDrafts) return this.ruleDrafts;
    const m = new Map<string, RuleDraftJob>();
    try {
      const raw = JSON.parse(readFileSync(this.draftsFile(), 'utf8')) as { jobs?: RuleDraftJob[] };
      for (const j of raw.jobs ?? []) if (j && typeof j.topicId === 'string') m.set(j.topicId, j.state === 'running' ? { ...j, state: 'error', error: '服务重启，生成被中断了，请重新生成', infeasible: false, finishedAt: this.now().toISOString() } : j);
    } catch { /* 没有文件或坏了：当作没有草稿 */ }
    return (this.ruleDrafts = m);
  }
  private persistDrafts(): void {
    try {
      const jobs = [...this.draftMap().values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, RULE_DRAFT_MAX);
      for (const k of [...this.draftMap().keys()]) if (!jobs.some(j => j.topicId === k)) this.draftMap().delete(k);
      mkdirSync(this.opts.root, { recursive: true });
      const file = this.draftsFile(), tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, jobs }));
      renameSync(tmp, file);
    } catch (e) { this.opts.log?.(`规则草稿落盘失败：${(e as Error).message}`); }
  }

  /**
   * 人改一条记忆的约束类型（强约束 / 软约束 / 待补规则）。强约束必须同时带上确认过的校验规则（先 startRuleDraft 写好、人看过再确认）：
   * 校验规则的四要素（校验节点 / 对象范围 / 校验规则 / 结果反馈）与记忆一起绑定，没有规则只能选软约束 / 待补规则。
   * 写 constraint.by='human'：之后流水线不再自动改动；记一条 trigger=human 的变更。
   */
  setConstraint(topicId: string, input: { level?: unknown; rule?: unknown; note?: unknown }): ChangeEntry {
    if (this.running) throw new PipelineError('busy', '流水线正在运行，稍后再试');
    const level = input.level === 'hard' || input.level === 'soft' || input.level === 'needs-rule' ? input.level : null;
    if (!level) throw new PipelineError('invalid-input', '约束类型必须是强约束、软约束或待补规则');
    const bound = level === 'hard' ? this.parseConfirmedRule(input.rule) : undefined;
    const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 120) : undefined;
    const release = this.store.acquire(this.now().getTime());
    if (!release) throw new PipelineError('busy', '别的进程正在运行流水线，稍后再试');
    try {
      const st = this.store.read();
      const t = st.topics[topicId];
      if (!t) throw new PipelineError('not-found', '这条记忆不在了（可能已被合并或移除）');
      if (t.sub === PROGRESS_SUB) throw new PipelineError('invalid-input', '进展类条目由上线通知自动生成，不能改约束类型');
      const before = t.constraint, at = this.now().toISOString();
      // 代码规则要和这条记忆语义一致才挂（确认的草稿里带的 ruleId 以服务端再核一次为准）
      const code = bound?.ruleId ? enforcementRule(bound.ruleId) : undefined;
      if (bound?.ruleId && !code?.fits(t.statement)) delete bound.ruleId;
      const same = (before?.level === level || (!before && level === 'soft')) && before?.by === 'human' && (level !== 'hard' || (before?.rule?.scope === bound?.scope && before?.rule?.criteria === bound?.criteria && before?.rule?.feedback === bound?.feedback && before?.ruleId === bound?.ruleId));
      if (same) throw new PipelineError('invalid-input', '约束类型没有变化');
      const name = (c: Topic['constraint']): string => (c?.level === 'hard' ? '强约束' : c?.level === 'needs-rule' ? '待补规则' : c?.level === 'uncertain' ? '待定' : '软约束');
      const { ruleId, ...rule } = bound ?? ({} as Partial<RuleDraft>);
      t.constraint = { level, by: 'human', ...(level === 'hard' ? { ...(ruleId ? { ruleId } : {}), rule: rule as RuleSpec } : {}), at, v: CONSTRAINT_JUDGE_VERSION };
      const ruleText = level === 'hard' ? `，绑定校验规则「${bound!.title}」` : '';
      const change: ChangeEntry = {
        id: createHash('sha256').update(`${at}|human|constraint|${t.id}`).digest('hex').slice(0, 12), at, kind: 'updated', topicId: t.id, topic: t.topic, statement: t.statement,
        tier: t.tier, domain: t.domain, project: t.project, trigger: 'human',
        note: `你改约束类型：${name(before)} → ${name(t.constraint)}${ruleText}${note ? `（${note}）` : ''}`
      };
      appendChanges(st, [change]);
      this.store.write(st);
      if (level === 'hard' && this.draftMap().delete(topicId)) this.persistDrafts();   // 草稿已用掉，下次重新来过
      try { this.opts.onChange?.(); } catch { /* 索引下次读取时会重新生成 */ }
      return change;
    } finally { release(); }
  }

  /** 确认强约束时带上来的规则：四要素必须齐全、合格（和 DeepSeek 写出来时的校验一样）。 */
  private parseConfirmedRule(raw: unknown): RuleDraft {
    const r = raw as Partial<RuleDraft> | null;
    if (!r || typeof r !== 'object') throw new PipelineError('invalid-input', '强约束必须先生成校验规则并确认：校验节点、校验对象范围、校验规则、结果反馈都要写清楚');
    const errs = validateDraft({ feasible: true, replyOnly: !r.probes?.length, ...r });
    if (errs.length) throw new PipelineError('invalid-input', `校验规则不完整：${errs[0]}`);
    const t = (v: unknown): string => String(v).trim();
    const probes = Array.isArray(r.probes) ? [...new Set(r.probes)] : [];
    return { title: t(r.title), node: 'turn-end', scope: t(r.scope), criteria: t(r.criteria), feedback: t(r.feedback), ...(probes.length ? { probes } : {}), ...(typeof r.ruleId === 'string' && r.ruleId ? { ruleId: r.ruleId } : {}) };
  }

  /**
   * 人删一条记忆：主题移除、成员观察退役（之后运行不会再拼回来，也不会被别的主题合并），记一条 trigger=human 的 removed 变更。
   * 原话与会话记录不动，动态里能看到这次删除。进展类条目由上线通知生成，不能这样删。
   */
  removeTopic(topicId: string, input: { note?: unknown } = {}): ChangeEntry {
    if (this.running) throw new PipelineError('busy', '流水线正在运行，稍后再试');
    const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 120) : undefined;
    const release = this.store.acquire(this.now().getTime());
    if (!release) throw new PipelineError('busy', '别的进程正在运行流水线，稍后再试');
    try {
      const st = this.store.read();
      st.retired ??= {};
      const t = st.topics[topicId];
      if (!t) throw new PipelineError('not-found', '这条记忆不在了（可能已被合并或移除）');
      if (t.sub === PROGRESS_SUB) throw new PipelineError('invalid-input', '进展类条目由上线通知自动生成，不在这里删');
      const at = this.now().toISOString();
      for (const id of t.memberIds) { st.retired[id] = { at, by: 'human', topicId: t.id }; delete st.assignment[id]; }
      delete st.topics[t.id];
      const quote = t.evidence[0]?.quote, sessionId = t.evidence[0]?.sessionId;
      const change: ChangeEntry = {
        id: createHash('sha256').update(`${at}|human|remove|${t.id}`).digest('hex').slice(0, 12),
        at, kind: 'removed', topicId: t.id, topic: t.topic, statement: t.statement,
        tier: t.tier, domain: t.domain, project: t.project, trigger: 'human',
        ...(quote ? { quote } : {}), ...(sessionId ? { sessionId } : {}),
        note: `你删除了这条记忆（${t.memberIds.length} 条依据一并退役）${note ? `：${note}` : ''}`
      };
      appendChanges(st, [change]);
      this.store.write(st);
      try { this.opts.onChange?.(); } catch { /* 索引下次读取时会重新生成 */ }
      return change;
    } finally { release(); }
  }

  /**
   * 「动态」里未读的变动：任何类型的变更（新增、合并、更新、取代、冲突、升降级、移除……），晚于已读时间的。
   * 你自己在页面上做的裁决（trigger=human）不算——那是你刚做的，不是要你去看的新情况。
   * 从没读过时按最近 FEED_UNREAD_DEFAULT_DAYS 天算，免得第一次上线就是一长串数字。
   * since 是这次统计的起点（「仅看有变动」用它取列表，同时带 excludeSource=human），latestAt 是其中最新一条（标已读推到这里）。
   */
  feedUnread(): { count: number; since: string; latestAt: string | null } {
    const since = this.store.feedSeenAt() ?? new Date(this.now().getTime() - FEED_UNREAD_DEFAULT_DAYS * 86_400_000).toISOString();
    const t = Date.parse(since);
    const fresh = (this.store.read().changes ?? []).filter(c => c.trigger !== FEED_UNREAD_EXCLUDED_SOURCE && Date.parse(c.at) > t);
    return { count: fresh.length, since, latestAt: fresh.reduce<string | null>((m, c) => (!m || c.at > m ? c.at : m), null) };
  }
  /** 标「动态」已读到 upTo（缺省 = 现在）。不能晚于现在，也不会往回退。 */
  markFeedSeen(upTo?: unknown): { seenAt: string } {
    const now = this.now().getTime();
    const t = upTo === undefined || upTo === null ? now : typeof upTo === 'string' ? Date.parse(upTo) : NaN;
    if (!Number.isFinite(t)) throw new PipelineError('invalid-input', 'upTo 必须是时间');
    return { seenAt: this.store.markFeedSeen(new Date(Math.min(t, now)).toISOString()) };
  }

  /** 变更日志，新的在前。before = 上一页最后一条的 id（翻页）；limit 缺省 50，最多 200。 */
  changes(opts: { limit?: number; before?: string; kind?: string; source?: string; from?: string; to?: string; since?: string; excludeSource?: string } = {}): { changes: ChangeEntry[]; total: number; daily: { day: string; total: number; kinds: Partial<Record<ChangeEntry['kind'], number>> }[]; runs: ChangeRunSummary[] } {
    const kinds = ['added', 'merged', 'updated', 'superseded', 'conflict', 'resolved', 'promoted', 'demoted', 'removed'];
    if (opts.kind && !kinds.includes(opts.kind)) throw new PipelineError('invalid-input', '操作类型无效');
    if (opts.source && !CHANGE_SOURCES.includes(opts.source as ChangeEntry['trigger'])) throw new PipelineError('invalid-input', '来源无效');
    const date = (value?: string) => {
      if (!value) return undefined;
      const t = Date.parse(`${value}T00:00:00+08:00`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(t) || new Date(t + 8 * 3600000).toISOString().slice(0, 10) !== value) throw new PipelineError('invalid-input', '日期无效');
      return t;
    };
    const from = date(opts.from), to = date(opts.to);
    // since：严格晚于这一刻（ISO）。「仅看有变动」用，比 from 的按日精确。excludeSource：不要这个来源（未读不计用户自己的裁决）。
    const since = opts.since === undefined ? undefined : Date.parse(opts.since);
    if (since !== undefined && !Number.isFinite(since)) throw new PipelineError('invalid-input', 'since 必须是时间');
    if (from !== undefined && to !== undefined && from > to) throw new PipelineError('invalid-input', '开始日期不能晚于结束日期');
    const state = this.store.read();
    const all = [...(state.changes ?? [])].reverse().filter(c =>
      (!opts.kind || c.kind === opts.kind) && (!opts.source || c.trigger === opts.source) && (from === undefined || Date.parse(c.at) >= from) && (to === undefined || Date.parse(c.at) < to + 86400000) && (since === undefined || Date.parse(c.at) > since) && (!opts.excludeSource || c.trigger !== opts.excludeSource));
    const start = opts.before ? all.findIndex(c => c.id === opts.before) + 1 : 0;
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    // Aggregate before pagination; a day's counts must not depend on loaded detail pages.
    const days = new Map<string, { day: string; total: number; kinds: Partial<Record<ChangeEntry['kind'], number>> }>();
    for (const c of all) {
      const time = Date.parse(c.at);
      const day = Number.isFinite(time) ? new Date(time + 8 * 3600000).toISOString().slice(0, 10) : 'unknown';
      const row = days.get(day) ?? { day, total: 0, kinds: {} };
      row.total++; row.kinds[c.kind] = (row.kinds[c.kind] ?? 0) + 1;
      days.set(day, row);
    }
    // 每次定时 / 手动运行一行汇总（含没变化的、失败的）；按操作类型筛选时汇总没有意义，不返回。实时运行每条记忆一次，本身就是一行变更，不汇总。
    const runs: ChangeRunSummary[] = opts.kind ? [] : state.runs
      .filter(r => r.trigger !== 'instant' && (!opts.source || r.trigger === opts.source) && (from === undefined || Date.parse(r.at) >= from) && (to === undefined || Date.parse(r.at) < to + 86400000))
      .map(r => {
        const kinds: ChangeRunSummary['kinds'] = {}; let total = 0;
        for (const c of state.changes ?? []) if (c.at === r.at && c.trigger === r.trigger) { kinds[c.kind] = (kinds[c.kind] ?? 0) + 1; total++; }
        return { at: r.at, trigger: r.trigger as 'schedule' | 'manual', durationMs: r.durationMs, error: r.error, total, kinds };
      }).sort((a, b) => b.at.localeCompare(a.at));
    // 「仅看有变动」（带 since）：没有任何变更的运行不是变动，汇总行只留 since 之后、确实有变更的
    const shownRuns = since === undefined ? runs : runs.filter(r => Date.parse(r.at) > since && r.total > 0);
    return { changes: all.slice(start, start + limit), total: all.length, daily: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)), runs: shownRuns };
  }

  /**
   * 人对一条待裁决冲突的决定：adopt = 采用新的（取代旧的，旧陈述进历史）；keep = 保留旧的（新的退役，不会再被并入）。
   * 和流水线运行互斥（同进程看 running，跨进程抢运行锁）；写一条 trigger=human 的变更记录。
   */
  resolveConflict(topicId: string, choice: 'adopt' | 'keep'): ChangeEntry {
    if (choice !== 'adopt' && choice !== 'keep') throw new PipelineError('invalid-input', 'choice 必须是 adopt 或 keep');
    if (this.running) throw new PipelineError('busy', '流水线正在运行，稍后再试');
    const release = this.store.acquire(this.now().getTime());
    if (!release) throw new PipelineError('busy', '别的进程正在运行流水线，稍后再试');
    try {
      const st = this.store.read();
      st.retired ??= {};
      const t = st.topics[topicId];
      if (!t?.pending) throw new PipelineError('not-found', '这条记忆没有待裁决的冲突（可能已经被裁决或自动消解）');
      const old = st.topics[t.pending.withTopicId];
      const at = this.now().toISOString();
      const by = t.memberIds[0] ?? '';
      let entry: ChangeEntry;
      if (choice === 'adopt') {
        if (old) {
          for (const id of old.memberIds) { st.retired[id] = { at, by, topicId: old.id }; delete st.assignment[id]; }
          delete st.topics[old.id];
          t.history = [...t.history, { at, statement: old.statement }].slice(-8);
        }
        delete t.pending;
        // 人定的：钉在公共层，不被上限降级（沿用旧条目的层，至少按需）
        t.tier = old?.tier === 'A' ? 'A' : 'B';
        t.override = { tier: t.tier, reason: '你裁决采用新的，取代了旧的', at };
        entry = { id: '', at, kind: 'superseded', topicId: t.id, topic: t.topic, statement: t.statement, ...(old ? { before: old.statement } : {}), tier: t.tier, domain: t.domain, project: t.project, trigger: 'human', note: '你裁决：采用新的，取代旧的' };
      } else {
        for (const id of t.memberIds) { st.retired[id] = { at, by: old?.id ?? '', topicId: t.id }; delete st.assignment[id]; }
        delete st.topics[t.id];
        const keep = old ?? t;
        entry = { id: '', at, kind: 'resolved', topicId: keep.id, topic: keep.topic, statement: keep.statement, before: t.statement, tier: keep.tier, domain: keep.domain, project: keep.project, trigger: 'human', note: '你裁决：保留旧的，忽略新的（before 是被忽略的说法）' };
      }
      entry.id = createHash('sha256').update(`${at}|human|${topicId}|${choice}`).digest('hex').slice(0, 12);
      appendChanges(st, [entry]);
      this.store.write(st);
      try { this.opts.onChange?.(); } catch { /* 索引下次读取时会重新生成 */ }
      return entry;
    } finally { release(); }
  }

  /** 公共层主题（默认不含素材层）。证据带平台会话 id 与用户原话，供追溯。 */
  topics(opts: { material?: boolean } = {}): Topic[] {
    const st = this.store.read().topics;
    // 待裁决的冲突和它对应的旧条目，不论层级都要给到界面（否则横幅、待确认卡片、红点都出不来）
    const needed = new Set(Object.values(st).flatMap(t => t.pending ? [t.id, t.pending.withTopicId] : []));
    const all = Object.values(st).filter(t => opts.material || t.tier !== 'material' || needed.has(t.id));
    return all.sort((a, b) => (a.domain === b.domain ? 0 : a.domain === 'personal' ? -1 : 1) || (a.project ?? '').localeCompare(b.project ?? '') || b.score - a.score || a.id.localeCompare(b.id));
  }

  /** 旧模块并入别的模块（mobile → ui）后，把存量数据落盘一次；别的进程占着锁就跳过（读取时本来就会改写）。 */
  private migrateRetiredModules(): void {
    try {
      const release = this.store.acquire(this.now().getTime());
      if (!release) return;
      try { if (this.store.dropMaterialConflicts()) { try { this.opts.onChange?.(); } catch { /* 下次读取刷新索引 */ } } } catch { /* 清理失败不影响启动 */ }
      try { if (this.store.persistRetiredModules()) { try { this.opts.onChange?.(); } catch { /* 下次读取刷新索引 */ } } }
      finally { release(); }
    } catch { /* 迁移失败不影响启动，读取时仍会改写 */ }
  }

  /** 每日 03:30（北京时间）跑一次；开关关着就只续排不运行。服务在计划时刻之后才启动、且上次成功运行已超过一天，则 5 分钟后补跑（避开峰时）。 */
  startScheduler(): () => void {
    this.migrateRetiredModules();
    registerPlatformScheduledTask({ id: 'public-memory-pipeline', schedule: dailyBeijingSchedule(PIPELINE_HOUR, PIPELINE_MINUTE), source: 'apps/web/src/memory/public/pipeline/service.ts' });
    const fire = (): void => { if (!this.stopped && this.opts.enabled()) void this.run('schedule'); };
    const schedule = (): void => {
      if (this.stopped) return;
      const at = nextBeijingRunAt(this.now(), PIPELINE_HOUR, PIPELINE_MINUTE);
      this.timer = setTimeout(() => { fire(); schedule(); }, Math.max(1_000, at.getTime() - this.now().getTime()));
      this.timer.unref?.();
    };
    try {
      const last = this.store.read().runs.filter(r => !r.error).pop();
      if (this.opts.enabled() && (!last || this.now().getTime() - Date.parse(last.at) > 26 * 3_600_000)) {
        const wait = catchUpWait(this.now(), 5 * 60_000);
        this.catchUp = setTimeout(fire, Math.max(1_000, wait)); this.catchUp.unref?.();
      }
    } catch { /* 状态读不到就等正点 */ }
    schedule();
    return () => this.stop();
  }
  stop(): void { this.stopped = true; clearTimeout(this.timer); clearTimeout(this.catchUp); for (const t of this.retryTimers) clearTimeout(t); this.retryTimers.clear(); }
}

export const pipelineRoot = (ledgerDir: string): string => appData(ledgerDir, 'memory').path('memory-public');
