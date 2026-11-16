/**
 * 公共记忆 v2 流水线的数据模型（docs/requirements/v3.92-public-memory-intake-mechanism）。
 * 独立于任何 runtime：一手来源是平台自己的会话事件账本里「用户说的话」。
 */
export type Domain = 'personal' | 'project';
/**
 * 个人偏好的性质。标「目标」的是用户自己的长期方向、优先级与取舍，用来看新需求是否符合大目标；
 * 它不记进展——进展以 git 为准、当前状态以仓库里的代码为准，记忆里再存一份就会出现两个互相打架的版本。
 * 标「背景」的是用户本人和家人的长期事实（谁是谁、年级、兴趣、强弱项、性格），是事实陈述而不是行为规则；
 * 只在用户明说「记住」时才收（distill.ts 确定性校验），收下后按常驻层处理（topics.ts BACKGROUND_FLOOR）。
 */
export const PERSONAL_SUBS = ['目标', '沟通', '验收', '审美', '流程', '红线', '背景'] as const;
/** 个人偏好里记事实而非规则的性质 */
export const BACKGROUND_SUB = '背景' as const;
/**
 * 项目记忆没有「性质」这一维：分类维度就是模块（modules.ts，模块清单里也有「目标」）。
 * 这些值是模块化之前的旧性质，只为读旧数据保留：不再产生、不再展示、不再参与归类，改归类和重算时会换成模块。
 */
export const LEGACY_PROJECT_SUBS = ['约定红线', '架构边界', '方法'] as const;
/** 已废弃：进展不再进记忆（git 就是进展日志；存一份会出现两份状态）。留着只为兼容历史数据，不再产生新条目。 */
export const PROGRESS_SUB = '进展';
export type Sub = typeof PERSONAL_SUBS[number] | typeof LEGACY_PROJECT_SUBS[number] | typeof PROGRESS_SUB;
/** 个人偏好的性质（不含旧项目性质），也是模型 / 人改归类时能选的合法值 */
export type PersonalSub = typeof PERSONAL_SUBS[number];

/** 理解指代用的上下文，含此前回复、系统消息及正在修订的引用规则，均不作为新依据。 */
export interface MessageContext { assistant?: string; system?: string; memory?: string }
/** key = 平台账本里这条用户消息的 key（user:<clientMessageId>）；manual = 用户在消息上点了「加入记忆」，视为明确的记忆指令。 */
export interface CapturedMessage { at: string; text: string; turnNo?: number; context?: MessageContext; memoryRevision?: boolean; key?: string; manual?: boolean }
/** 重复原则的另一处用户原话。来源必须逐条核验，不接受模型生成的摘要作为证据。 */
export interface RepetitionEvidence { sessionId: string; at: string; quote: string }
export interface RepetitionMessage { sessionId: string; at: string; text: string; project: string | null }
export interface Shipped { at: string; sha: string; title: string; sessionId: string }
export interface SessionDigest {
  sessionId: string; runtime: string; project: string | null; title: string; startedAt: string;
  /** 只含用户亲自发出的消息（平台自动通知、自动续聊、群聊框架消息、非人 actor 发送的都已剔除；它们最多出现在 context 里） */
  messages: CapturedMessage[];
  /** 会话里收到的「已上线」部署通知，用于生成项目进展 */
  shipped: Shipped[];
}

/** 提炼出的一条观察：素材层，不注入、不展示给 agent。 */
export interface Observation {
  id: string; sessionId: string; runtime: string; at: string;
  domain: Domain; project: string | null;
  /** 只有个人偏好有性质；项目记忆的分类维度是 module（旧数据可能还带旧性质） */
  sub?: Sub;
  /** 项目记忆挂哪个功能模块（见 modules.ts，含「目标」）。个人偏好没有模块；项目里没归类的落 'cross' */
  module?: string;
  topic: string; statement: string;
  /** 用户原话（逐字出自该会话的用户消息，校验过） */
  quote: string;
  /** 用户明确表达的“以后都这样”：记住 / 以后 / 每次 / 必须 / 不要 / 统一 / 应该 / 都要… */
  explicit: boolean;
  /** 做错代价大（线上部署、数据、对外发送、不可逆） */
  redLine: boolean;
  /** 换一个功能、换一个会话仍成立 */
  crossFeature: boolean;
  /** 确定性的记忆意图，含“记住”类指令、引用纠正及紧邻确认。仍需模型判定明确指令；主题至少进按需层。 */
  remember?: boolean;
  repetition?: RepetitionEvidence[];
}

/** 归属二判（开推理）给出的判断：仍不确定时只是建议，等人判定。 */
export interface ScopeSuggestion {
  domain: Domain; project: string | null;
  /** 个人偏好给性质；项目记忆给模块 */
  sub?: Sub; module?: string;
  confidence: 'high' | 'uncertain';
  reason?: string;
}

/** 提炼出、但归属分不清的观察：冻结在这里，不进主题、不进注入和索引，等人判定。 */
export interface ObservationDraft {
  id: string; sessionId: string; runtime: string; at: string;
  topic: string; statement: string; quote: string;
  explicit: boolean; redLine: boolean; crossFeature: boolean; remember?: boolean;
  repetition?: RepetitionEvidence[];
  /** 模型倾向的功能模块（仅 project 建议；落定时用，缺省 cross） */
  module?: string;
  /** 模型为什么分不清：个人偏好还是项目约定 */
  scopeReason?: string;
  /** 模型自己倾向的归属（可能就是 null） */
  suggestion?: ScopeSuggestion;
}

/** 待判定的观察：会话属于哪个项目、什么时候进来、二判的结果（judged）都留着，供人一眼判断。 */
export interface PendingObservation extends ObservationDraft {
  sessionProject: string | null;
  /** 进入待判定的时间 */
  addedAt: string;
  judged?: { at: string; version: string; confidence: 'high' | 'uncertain'; reason?: string };
}

/** 人判定过的归属（全局共用）：二判不确定时作为参考样例。 */
export interface HumanScopeLabel {
  id: string; at: string;
  domain: Domain; project: string | null;
  /** 个人偏好给性质；项目记忆给模块 */
  sub?: Sub; module?: string;
  topic: string; statement: string; quote: string;
  /** 人判定之前，二判给出的建议与理由 */
  suggestion?: ScopeSuggestion;
  note?: string;
}

export interface EvidenceRef { obsId: string; sessionId: string; at: string; quote: string; explicit: boolean }
export type Tier = 'A' | 'B' | 'material';
/** 并入后的主题条目：一个主题一条，原地更新。 */
export interface Topic {
  id: string; domain: Domain; project: string | null; topic: string; statement: string;
  /** 个人偏好的性质；项目记忆不再有性质（旧数据可能还带，重算 / 改归类时清掉） */
  sub?: Sub;
  /** 项目记忆的功能模块（成员多数决定，见 topics.ts 的 moduleOf）；个人偏好没有模块；没归类的落 'cross' */
  module?: string;
  tier: Tier; score: number;
  signals: { explicit: number; sessions: number; redLine: boolean; crossFeature: boolean; firstAt: string; lastAt: string; remembered?: boolean };
  sessionIds: string[];
  evidence: EvidenceRef[];
  history: Array<{ at: string; statement: string }>;
  asOf: string; expiresAt?: string;
  /** 归属到这个主题的观察 id（成员关系只在这里；信号、证据、会话都由它重算） */
  memberIds: string[];
  /** 写陈述时的成员指纹；成员变了才重写陈述，没变就保持原样（稳定） */
  basis: string;
  /** 被并入的主题编号，原观察及会话来源完整保留。 */
  mergedFrom?: string[];
  /** 来源：pipeline（缺省，由会话原话提炼）｜imported（从旧机制导入：没有会话依据，不参与重算 / 上限 / 过期，由人决定去留） */
  origin?: 'pipeline' | 'imported';
  /** 适用条件（导入的规则带着）；注入时写在陈述前面 */
  condition?: string;
  /** 人工决定：陈述 / 层 / 归属以此为准，流水线不再改写 */
  override?: { statement?: string; tier?: 'A' | 'B'; scope?: { domain: Domain; project: string | null; sub?: Sub; module?: string }; reason: string; at: string };
  /** 导入说明：旧条目编号与当时的确认依据 */
  imported?: { legacyId: string; evidence: string; at: string };
  /** 与已有条目冲突、等人裁决：不注入、不进按需索引；裁决前旧条目照常生效 */
  pending?: Pending;
  /** 约束类型；没有这个字段 = 还没判定过，按软约束处理 */
  constraint?: Constraint;
}
export interface Pending { kind: 'conflict'; withTopicId: string; reason: string; at: string }

/**
 * 约束类型（与常驻 / 按需同级的一个维度）：hard=强约束（必须绑定一条校验规则，会话回合结束时平台会检查，不通过要重做）；
 * soft=软约束（和以前一样，由模型自己决定是否遵循）；uncertain=判定模型拿不准，等人决定（在此之前按软约束处理）；
 * needs-rule=待补规则：要求本身适合强约束，但规则还没写出来（DeepSeek 没写成 / 判定无法事后检查，或人想先放一放）；补上规则之前按软约束处理，不标强约束、不登记检查。
 * 强约束的规则 = rule（DeepSeek 开推理按记忆写的四要素：校验节点 / 对象范围 / 校验规则 / 结果反馈，确认强约束时和记忆一起绑定）；
 * ruleId 是 runtime-sessions/memory-enforcement.ts 里已有的代码规则——记忆要求的恰好是它检查的内容时一并挂上，会话里优先用它做确定性判定，没有就由判定模型按 rule 的四要素判。
 * 强约束没有规则（rule 与有效的 ruleId 都没有）就不成立。
 * by：cue=原话里有必须 / 一定等措辞，默认强约束；model=判定模型；human=人在记忆页指定（之后不再被自动改动）。
 */
export type ConstraintLevel = 'hard' | 'soft' | 'uncertain' | 'needs-rule';
/** 一条校验规则的四要素。node 目前只有回合结束。 */
export interface RuleSpec { title: string; node: 'turn-end'; scope: string; criteria: string; feedback: string; /** 判定要核对的功能事实（取证项，见 runtime-sessions/memory-probes.ts）；没有 = 规则只看回复 / 工具记录 */ probes?: string[] }
export interface Constraint {
  level: ConstraintLevel; ruleId?: string; /** DeepSeek 写的四要素（强约束必有，除非是只挂着代码规则的旧数据） */ rule?: RuleSpec;
  by: 'cue' | 'model' | 'human'; reason?: string; at: string;
  /** 判定时的规则清单版本；清单变了，非人工的判定会重判一次 */ v?: string;
  /** 待补规则：最近一次写规则的提示词版本（写不成时标记，同一版本不再重试；技术失败不标，下次运行再试） */ draftV?: string;
}

/** 变更日志：公共层每一次入库 / 更新 / 取代 / 冲突 / 裁决 / 升降级 / 移除，记一条（供「动态」按时间查看）。 */
export type ChangeKind = 'added' | 'merged' | 'updated' | 'superseded' | 'conflict' | 'resolved' | 'promoted' | 'demoted' | 'removed';
export interface ChangeEntry {
  id: string; at: string; kind: ChangeKind; topicId: string; topic: string; statement: string;
  /** 变更前的陈述（更新 / 取代 / 冲突时是被冲突的旧陈述） */
  before?: string;
  tier: Tier; tierBefore?: Tier; domain: Domain; project: string | null;
  /** 谁触发的：实时（用户说了“记住”）、每晚定时、手动运行、人在页面上裁决 */
  trigger: RunRecord['trigger'] | 'human';
  /** 触发这次变更的会话与用户原话（“触发点位”） */
  sessionId?: string; quote?: string;
  note?: string;
}
export const CHANGES_KEEP = 1000;

/** 结构性上限：条目数不随会话数增长。 */
export const CAPS = { personal: 30, project: 30, perModule: 8, progressPerProject: 5 } as const;
export const MATERIAL_TTL_DAYS = 90;
export const PROGRESS_TTL_DAYS = 14;

/** 一次运行的记录（只留最近 30 条）。 */
export interface RunRecord {
  at: string; durationMs: number; trigger: 'schedule' | 'manual' | 'instant';
  sessions: number; changedSessions: number; distillCalls: number; observationsAdded: number; observationsRemoved: number;
  attachCalls: number; statementCalls: number; modelFailures: number; topicsPublic: number; topicsMaterial: number;
  reviewCalls?: number;
  /** 约束类型判定的模型调用次数 */
  constraintCalls?: number;
  error: string | null;
}

/** 运行记录的保留：定时 / 手动各留 60 条（动态里每次运行一行汇总），实时运行每条记忆一次、很碎，只留 30 条，免得把每晚梳理挤掉。 */
export const trimRuns = (runs: readonly RunRecord[]): RunRecord[] => {
  const keep = (instant: boolean, n: number): Set<RunRecord> => new Set(runs.filter(r => (r.trigger === 'instant') === instant).slice(-n));
  const batch = keep(false, 60), live = keep(true, 30);
  return runs.filter(r => batch.has(r) || live.has(r));
};

/** 流水线的持久状态（memory-public/pipeline.json）。成员关系与每个会话的提炼指纹都在里面，所以增量运行不重做已做过的事。 */
export interface PipelineState {
  version: 1;
  /** 已复核主题对的内容指纹；内容变化或复核版本升级后重判，失败不缓存。 */
  topicReviews?: Record<string, { at: string; relation: string }>;
  /** 已提炼过的会话：digest 指纹 → 该会话的观察 id */
  sessions: Record<string, { hash: string; obsIds: string[] }>;
  observations: Record<string, Observation>;
  /** 观察 → 主题；存量复核确认合并时整体迁移，保留原观察。 */
  assignment: Record<string, string>;
  topics: Record<string, Topic>;
  shipped: Shipped[];
  runs: RunRecord[];
  /** 被新规则取代 / 被人裁决为不采用的观察：不再并入任何主题（观察本身留着作审计，会话重新提炼后随之清理） */
  retired?: Record<string, { at: string; by: string; topicId: string }>;
  /** 人明确排除的误提炼原话，跨重新提炼保留，避免同一观察再次进入素材或待判定。 */
  dismissedObservations?: Record<string, { at: string; reason: string }>;
  /** 变更日志（只留最近 CHANGES_KEEP 条） */
  changes?: ChangeEntry[];
  /** 归属分不清、等人判定的观察（不进主题 / 注入 / 索引） */
  pendingObservations?: Record<string, PendingObservation>;
  /** 人判定过的归属，全局共用：二判不确定时作为参考样例（只留最近 HUMAN_SCOPE_KEEP 条） */
  humanScopeLabels?: HumanScopeLabel[];
}
export const HUMAN_SCOPE_KEEP = 200;
export const emptyPipelineState = (): PipelineState => ({ version: 1, sessions: {}, observations: {}, assignment: {}, topics: {}, shipped: [], runs: [], retired: {}, changes: [], pendingObservations: {}, humanScopeLabels: [] });
