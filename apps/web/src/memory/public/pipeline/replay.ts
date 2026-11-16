import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelInvocationPort } from '@pi-agent/model-port';
import { runPipeline } from './job.js';
import { checkGolden, similarity } from './golden.js';
import { isGoalModule, moduleName } from './modules.js';
import { emptyPipelineState, type PipelineState, type RunRecord, type Shipped, type Topic } from './types.js';

export interface ReplayOptions {
  dataDir: string; outDir: string; port: ModelInvocationPort; since?: string; concurrency?: number; limit?: number; now?: Date;
  /** 现有公共记忆 knowledge.json（只读，用于对照） */
  livePath?: string; log?: (s: string) => void; resolveTitle?: (s: Shipped) => string;
  /** 接着上次回放的状态跑（提炼结果、归属决定都复用）；resetClusters 则只保留提炼结果、重新做归属，用来量结果的稳定性 */
  fromState?: PipelineState; resetClusters?: boolean;
}
export interface ReplayResult { state: PipelineState; run: RunRecord; topics: Topic[]; golden: ReturnType<typeof checkGolden>; report: string }

/** 回放评估：把线上同一条流水线（增量运行器）在一份可丢弃的状态上跑一遍，产出报告。不写线上任何文件。 */
export async function runReplay(opts: ReplayOptions): Promise<ReplayResult> {
  mkdirSync(opts.outDir, { recursive: true });
  const base = opts.fromState ? structuredClone(opts.fromState) : emptyPipelineState();
  if (opts.resetClusters) { base.assignment = {}; base.topics = {}; }
  const now = opts.now ?? new Date();
  const r = await runPipeline(base, { dataDir: opts.dataDir, port: opts.port, now, trigger: 'manual', ...(opts.since ? { since: opts.since } : {}), ...(opts.limit ? { limit: opts.limit } : {}), ...(opts.concurrency ? { concurrency: opts.concurrency } : {}), ...(opts.log ? { log: opts.log } : {}), ...(opts.resolveTitle ? { resolveTitle: opts.resolveTitle } : {}) });
  const topics = Object.values(r.state.topics);
  const golden = checkGolden(topics);
  const report = renderReport({ opts, state: r.state, run: r.run, drops: r.drops, topics, golden, now });
  writeFileSync(join(opts.outDir, 'state.json'), JSON.stringify(r.state));
  writeFileSync(join(opts.outDir, 'topics.json'), JSON.stringify(topics, null, 1));
  writeFileSync(join(opts.outDir, 'report.md'), report);
  return { state: r.state, run: r.run, topics, golden, report };
}

const cell = (s: string): string => s.replace(/\|/g, '／').replace(/\n/g, ' ');
const sid = (s: string): string => s.replace(/^rt-/, '').slice(0, 6);

export function renderReport(a: { opts: ReplayOptions; state: PipelineState; run: RunRecord; drops: { ungrounded: number; timePoint: number; invalid: number; meta: number }; topics: Topic[]; golden: ReplayResult['golden']; now: Date }): string {
  const pub = a.topics.filter(t => t.tier !== 'material');
  const personal = pub.filter(t => t.domain === 'personal'), projects = new Map<string, Topic[]>();
  for (const t of pub.filter(t => t.domain === 'project')) (projects.get(t.project!) ?? projects.set(t.project!, []).get(t.project!)!).push(t);
  const row = (t: Topic): string => `| ${t.tier} | ${t.score} | ${t.domain === 'personal' ? t.sub : moduleName(t.module)} | ${cell(t.topic)} | ${cell(t.statement)} | ${t.signals.explicit}/${t.signals.sessions} | ${t.evidence.slice(0, 2).map(e => sid(e.sessionId)).join('、')} |`;
  const head = '| 层 | 分 | 分类 | 主题 | 陈述 | 明确/会话数 | 依据会话 |\n|---|---|---|---|---|---|---|';
  const r = a.run;
  const out: string[] = [
    '# 回放评估报告（离线，未写线上）', '',
    `生成：${a.now.toISOString()}　数据：${a.opts.dataDir}${a.opts.since ? `　起始：${a.opts.since}` : ''}${a.opts.resetClusters ? '　（复用提炼结果，重新归属）' : ''}`, '',
    '## 一、采集与提炼', '',
    `- 会话 ${r.sessions}（本次需要提炼 ${r.changedSessions}）；观察共 ${Object.keys(a.state.observations).length}（本次 +${r.observationsAdded} / -${r.observationsRemoved}）`,
    `- 本次丢弃：原话对不上 ${a.drops.ungrounded}、带时点信息 ${a.drops.timePoint}、字段不合规 ${a.drops.invalid}、讨论记忆机制本身 ${a.drops.meta}`,
    `- 模型调用：提炼 ${r.distillCalls}、归属 ${r.attachCalls}、陈述 ${r.statementCalls}；失败/兜底 ${r.modelFailures}`, '',
    '## 二、必须出现的用例（召回）', '', '| 用例 | 结果 | 命中主题 |', '|---|---|---|',
    ...a.golden.map(g => `| ${g.label} | ${g.found ? '✅' : '❌'} | ${g.found ? cell(`[${g.tier}] ${g.statement}`) : '—'} |`), '',
    `**召回 ${a.golden.filter(g => g.found).length}/${a.golden.length}**`, '',
    '## 三、体量（上限：个人 30、每项目 30）', '',
    `- 个人偏好：公共层 ${personal.length}（A ${personal.filter(t => t.tier === 'A').length} / B ${personal.filter(t => t.tier === 'B').length}），素材层 ${a.topics.filter(t => t.domain === 'personal' && t.tier === 'material').length}`,
    ...[...projects.entries()].map(([p, l]) => `- 项目 ${p}：公共层 ${l.length}（A ${l.filter(t => t.tier === 'A').length} / B ${l.filter(t => t.tier === 'B').length}），素材层 ${a.topics.filter(t => t.project === p && t.tier === 'material').length}`), '',
    '## 四、个人偏好（公共层）', '', head, ...personal.sort((x, y) => y.score - x.score).map(row), ''
  ];
  for (const [p, l] of projects) out.push(`## 五、项目「${p}」（公共层）`, '', head, ...l.sort((x, y) => (isGoalModule(y.module ?? null) ? 1 : 0) - (isGoalModule(x.module ?? null) ? 1 : 0) || y.score - x.score).map(row), '');
  if (a.opts.livePath && existsSync(a.opts.livePath)) {
    const live = (JSON.parse(readFileSync(a.opts.livePath, 'utf8')) as { knowledge: Array<{ id: string; status: string; kind?: string; text: string }> }).knowledge.filter(k => k.status === 'active');
    const missing = live.filter(k => Math.max(0, ...pub.map(t => similarity(k.text, t.statement))) < 0.18);
    out.push('## 六、与线上现有条目对照', '', `线上生效 ${live.length} 条；回放公共层 ${pub.length} 条。下面是线上有、但回放里找不到相近主题的（可能是回放漏了，也可能本来就不该在）：`, '',
      '| 编号 | 类型 | 内容 |', '|---|---|---|', ...missing.map(k => `| ${k.id.replace(/-/g, '').slice(0, 6)} | ${k.kind ?? ''} | ${cell(Array.from(k.text).slice(0, 90).join(''))} |`), '');
  }
  return out.join('\n');
}
