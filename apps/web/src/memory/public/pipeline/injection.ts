import { join } from 'node:path';
import { enforcementRule, modelRuleId, type ActiveRule } from '../../../../../../packages/runtime-sessions/src/memory-enforcement.js';
import { indexFileNames } from '../index-files.js';
import { isGoalModule } from './modules.js';
import { hasUsableRule } from './rule-draft.js';
import { PROGRESS_SUB, type Topic } from './types.js';

/** 常驻注入的字数预算，按桶分开计，互不挤占：个人偏好 / 项目目标 / 项目约定。 */
export const RESIDENT_BUDGET = { personal: 700, project: 1250, goal: 300 } as const;
export type ResidentBudget = { personal: number; project: number; goal: number };

const len = (s: string): number => Array.from(s).length;
/** 强约束且绑定了规则：会话回合结束时平台会检查（首轮注入时登记到会话）。没有规则的强约束只在文字里标注。
 * 规则 = DeepSeek 写的四要素（确认强约束时绑定），或有效的代码规则；代码规则非人工判定的还得和记忆语义一致（以前挂错的旧数据在重判前也不再触发检查）。 */
export const isEnforced = (t: Topic): boolean => t.constraint?.level === 'hard' && hasUsableRule(t.constraint, t.statement, t.constraint.by);
export const topicLine = (t: Topic): string => `- ${isEnforced(t) ? '【强约束】' : ''}${t.condition ? `${t.condition}：` : ''}${t.statement}`;
/** 这条强约束的规则名：优先代码规则的名字，其次 DeepSeek 写的标题。 */
export const ruleTitleOfTopic = (t: Topic): string => {
  const c = t.constraint, code = c?.ruleId ? enforcementRule(c.ruleId) : undefined;
  return (code && (c!.by === 'human' || code.fits(t.statement)) ? code.title : c?.rule?.title) ?? code?.title ?? '校验规则';
};
const enforcedLine = (t: Topic): string => `${topicLine(t)}（平台每轮结束后会检查：${ruleTitleOfTopic(t)}）`;
/** 登记到会话的规则：能用代码规则的用代码（确定性），否则带上四要素交给判定模型。 */
export const activeRuleOf = (t: Topic): ActiveRule => {
  const c = t.constraint!, code = c.ruleId ? enforcementRule(c.ruleId) : undefined;
  const useCode = !!code && (c.by === 'human' || code.fits(t.statement) || !c.rule);
  const base = { topicId: t.id, statement: t.statement, topic: t.topic };
  return useCode ? { ...base, ruleId: code!.id } : { ...base, ruleId: modelRuleId(t.id), title: c.rule!.title, spec: { node: c.rule!.node, scope: c.rule!.scope, criteria: c.rule!.criteria, feedback: c.rule!.feedback, ...(c.rule!.probes?.length ? { probes: c.rule!.probes } : {}) } };
};
/** 按重要度排：分高的先占预算（被反复强调的比只说过一次的更该常驻），同分取新的。人定的条目分数钉在 A=6 / B=4，不会因为是“导入”就排在被反复强调的前面。 */
const rankDesc = (a: Topic, b: Topic): number => b.score - a.score || b.signals.lastAt.localeCompare(a.signals.lastAt) || a.id.localeCompare(b.id);

export interface InjectionPreview {
  text: string; chars: number; estTokens: number;
  personal: Topic[]; project: Topic[]; goal: Topic[];
  /** 强约束且有检测规则的条目：不占字数预算、一律常驻注入，规则登记到会话（rules） */
  enforced: Topic[]; rules: ActiveRule[];
  /** 常驻候选（A 层）但这个桶的预算放不下，退到按需查阅的 */
  overflow: Topic[];
  /** 按需查阅里的条目（B 层 + 溢出的 A） */
  onDemand: Topic[];
}

const pack = (list: readonly Topic[], budget: number): { kept: Topic[]; over: Topic[] } => {
  const kept: Topic[] = [], over: Topic[] = []; let used = 0;
  for (const t of list) { const n = len(topicLine(t)); if (used + n <= budget) { kept.push(t); used += n; } else over.push(t); }
  return { kept, over };
};

/**
 * 某个项目的新会话首轮要注入什么（只读纯函数）：个人偏好 + 该项目目标 + 该项目的 A 层主题。
 * 目标（模块 goal）单独一桶、排在最前：会话要先用它判断手上的需求是否符合大目标。个人偏好的「目标」性质留在个人偏好桶里（同样是常驻）。
 * project 为空 = 没有项目的会话，只含个人偏好。素材层（tier=material）与已废弃的进展类从不注入。
 */
export function buildInjection(all: readonly Topic[], project: string | null, opts: { budget?: ResidentBudget; indexDir?: string; baseUrl?: string } = {}): InjectionPreview {
  const budget = opts.budget ?? RESIDENT_BUDGET;
  const visible = all.filter(t => t.tier !== 'material' && !t.pending && t.sub !== PROGRESS_SUB && (t.domain === 'personal' || (project !== null && t.project === project)));
  // 强约束 + 有检测规则的：与常驻 / 按需无关，一律常驻（模型要事先知道会被检查），也不占各桶的预算
  const enforced = visible.filter(isEnforced).sort(rankDesc);
  const plain = visible.filter(t => !isEnforced(t));
  const a = plain.filter(t => t.tier === 'A').sort(rankDesc);
  const personalA = a.filter(t => t.domain === 'personal'), goalA = a.filter(t => t.domain === 'project' && isGoalModule(t.module ?? null)), projectA = a.filter(t => t.domain === 'project' && !isGoalModule(t.module ?? null));
  const p = pack(personalA, budget.personal), g = pack(goalA, budget.goal), j = pack(projectA, budget.project);
  const overflow = [...p.over, ...g.over, ...j.over];
  const onDemand = [...plain.filter(t => t.tier === 'B').sort(rankDesc), ...overflow];
  const lines: string[] = ['【平台公共记忆】以下是用户在 pi-agent 平台上长期要求的做法（由会话原话提炼，可追溯到会话）；与本轮明确要求冲突时以本轮为准；与你自己的私有记忆（runtime 记忆）冲突时，以这里的平台公共记忆为准；不必复述：'];
  if (enforced.length) lines.push('强约束（每轮结束后平台会自动检查，没做到会被要求补齐重做）：', ...enforced.map(enforcedLine));
  if (p.kept.length) lines.push('个人偏好：', ...p.kept.map(topicLine));
  if (g.kept.length && project) lines.push(`项目「${project}」的目标（判断新需求是否符合大目标）：`, ...g.kept.map(topicLine));
  if (j.kept.length && project) lines.push(`项目「${project}」：`, ...j.kept.map(topicLine));
  if (onDemand.length) {
    const names = indexFileNames(project), dir = opts.indexDir ?? '~/.pi-agent-gui/data/memory-public/index', stem = names.map.replace(/\.md$/, '');
    const base = (opts.baseUrl ?? 'http://127.0.0.1:8780').replace(/\/+$/, ''), q = project ? `?project=${encodeURIComponent(project)}&q=关键词` : '?q=关键词';
    lines.push(`按需查阅（另有 ${onDemand.length} 条未列在上面）：先读 ${join(dir, names.map)}（目录，很短），再在同目录 grep -n "#模块或关键词" ${stem}.catalog.md 找条目、grep -n -A8 "### 编号" ${stem}.details.md 看详情；读不到文件就 curl -s '${base}/api/memory/public/index${q}'`);
  }
  const text = lines.join('\n'), chars = len(text);
  const rules: ActiveRule[] = enforced.map(activeRuleOf);
  return { text, chars, estTokens: Math.round(chars * 1.4), personal: p.kept, project: j.kept, goal: g.kept, enforced, rules, overflow, onDemand };
}
