import { appData } from '../../../app-data.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildCatalog, canonicalProjectOf } from '../projects.js';
import { looksSensitive } from '../sensitive.js';
import { originOfActor, readActorIndex } from './origin.js';
import type { CapturedMessage, MessageContext, SessionDigest, Shipped } from './types.js';

/** 平台代发的消息（不是用户说的话）：部署通知、额度恢复自动续聊、群聊框架、故障诊断待办。 */
const AUTO_PREFIXES = ['[pi-agent 自动', '额度已恢复（平台自动', '[群聊 ', '[故障诊断'];
const SHIPPED_RE = /已上线：([0-9a-f]{7,40})（(.+?)）。/s;
/**
 * 「问询」平台记忆时，首条消息里带着一个引用块（格式见 memory-public.js 的 pmAskPrompt / runtime-chat.js 的 rtNoteQuoteOne）：
 * 那条记忆的一句话规则 + 「背景：」（依据原话、演变……）。这些是平台生成的内容、不是用户这次说的话——
 * 提炼和“记住”检测之前必须整块剥掉，否则问询一次某条记忆，就会被当成“又说了一遍”反过来强化它。
 */
const MEMORY_QUOTE_BLOCK = /引用平台记忆（编号 t-[\w-]+ · [^）\n]+）：\n\n(?:>[^\n]*(?:\n|$))+/g;
export const stripMemoryQuotes = (text: string): string => text.replace(MEMORY_QUOTE_BLOCK, '').replace(/^\s+/, '');
/** 引用只供解析指代，不作为新依据；不携带背景里的历史原话。 */
export function memoryQuoteContext(text: string): string | undefined {
  const quotes = [...text.matchAll(MEMORY_QUOTE_BLOCK)].map(m => {
    const [header, , ...lines] = m[0].split('\n');
    const background = lines.findIndex(l => /^>\s*背景：/.test(l));
    return [header, ...lines.slice(0, background < 0 ? lines.length : background)].join('\n').trim();
  });
  return quotes.length ? quotes.join('\n').slice(0, 1600) : undefined;
}
const CORRECTION = /不是必须|不(?:是)?必[须需]|没必要|无需|不用|不需要|不强制|不再|取消|去掉|删掉|删除|改成|改为|改一下|更正|纠正|不对|有误|应该是|应当是|以.+为准/;
const CONFIRM_PRINCIPLE = /(?:就按|按)(?:这些|这个|上述|上面|你说的|新的|这些新的|你总结的)(?:原则|规则|约定|方案|说的)?(?:来|执行|办|做)|确认(?:这些|新的|上述)(?:原则|规则|约定)/;
const QUESTION = /[?？]|(?:是否|为什么|为啥|能否|可否|要不要|是不是)|[吗么呢][。！!\s]*$/;
/** 仅当前引用后的明确纠正，或紧接着该纠正的人类确认；普通问询不触发。 */
export function memoryRevisionContext(text: string, previousHuman = ''): string | undefined {
  const own = stripMemoryQuotes(text).trim();
  if (classifyMessage(own) !== 'user' || !own) return;
  const direct = memoryQuoteContext(text);
  // 疑问中的假设不视为已作出的修订。
  const corrects = (s: string) => CORRECTION.test(s) && !QUESTION.test(s);
  if (direct && corrects(own)) return direct;
  const previous = stripMemoryQuotes(previousHuman).trim();
  if (!direct && CONFIRM_PRINCIPLE.test(own) && !QUESTION.test(own) && !/(?:不要|别|不用|不再)按/.test(own) && classifyMessage(previous) === 'user' && corrects(previous)) return memoryQuoteContext(previousHuman);
}
export type MessageClass = 'user' | 'shipped' | 'auto';
export function classifyMessage(text: string): MessageClass {
  const t = text.trimStart();
  if (t.startsWith('[pi-agent 自动部署通知]') && SHIPPED_RE.test(t)) return 'shipped';
  return AUTO_PREFIXES.some(p => t.startsWith(p)) ? 'auto' : 'user';
}
export function parseShipped(text: string, at: string, sessionId: string): Shipped | null {
  const m = SHIPPED_RE.exec(text);
  return m ? { at, sha: m[1]!, title: m[2]!.trim(), sessionId } : null;
}

/** worktree 会话的工作目录是 <仓库>/.pi-worktrees/rt-xxx：项目取仓库名。 */
export function repoRootOf(workspace: string): string {
  const i = workspace.indexOf('/.pi-worktrees/');
  return (i >= 0 ? workspace.slice(0, i) : workspace).replace(/\/+$/, '');
}
/** 评估 / 验收 / 基线对照用的临时工作目录（-r1 之类的轮次目录）不是用户的真实项目。 */
const EXCLUDED_WORKSPACE = /\.evaluation-qualification|\/acceptance\/|\/tmp-|\/pi-agent-projects\/|-r\d+(\/|$)|\/pi-agent-eval-runs\//;

interface Binding { platformSessionId?: string; runtimeKind?: string; title?: string; workspace?: string; createdAt?: { at?: string }; turns?: Array<{ clientMessageId?: string; operationId?: string }> }

/** 上下文的长度上限：模型回复取结尾（结论 / 提问都在末尾），系统消息取开头。 */
export const CONTEXT_ASSISTANT_MAX = 500, CONTEXT_SYSTEM_MAX = 200;
const tail = (t: string, n: number): string => { const x = t.trim(); return x.length > n ? `…${x.slice(-n)}` : x; };
const head = (t: string, n: number): string => { const x = t.trim(); return x.length > n ? `${x.slice(0, n)}…` : x; };

/** 用户手动「加入记忆」过的消息：会话 id → 账本 key 集合。 */
export type ManualMarks = ReadonlyMap<string, ReadonlySet<string>>;
export interface CaptureOptions { dataDir: string; since?: string; sessionIds?: string[]; manualMarks?: ManualMarks }
export interface CaptureResult { sessions: SessionDigest[]; projects: string[]; stats: { sessions: number; userMessages: number; autoMessages: number; systemActorMessages: number; shipped: number; sensitiveDropped: number } }

/** 读平台事件账本，产出每个会话的用户原话与部署通知。纯读，不写任何文件。 */
export function captureSessions(opts: CaptureOptions): CaptureResult {
  const raw = JSON.parse(readFileSync(appData(opts.dataDir, 'memory').foreign('runtime-sessions', 'runtime', 'bindings.json'), 'utf8')) as unknown;
  const list = (Array.isArray(raw) ? raw : Object.values((raw as { bindings?: object }).bindings ?? (raw as object))) as Binding[];
  const bindings = list.filter(b => b?.platformSessionId && b.workspace && !EXCLUDED_WORKSPACE.test(b.workspace));
  const catalog = buildCatalog(bindings.map(b => ({ workspace: repoRootOf(b.workspace!) })));
  const stats = { sessions: 0, userMessages: 0, autoMessages: 0, systemActorMessages: 0, shipped: 0, sensitiveDropped: 0 };
  const actors = readActorIndex(appData(opts.dataDir, 'memory').foreign('runtime-sessions', 'runtime', 'audit.jsonl'));
  const eventsDir = appData(opts.dataDir, 'memory').foreign('runtime-sessions', 'runtime', 'events');
  const only = opts.sessionIds ? new Set(opts.sessionIds) : null;
  const out: SessionDigest[] = [];
  for (const b of bindings) {
    const sid = b.platformSessionId!;
    if (only && !only.has(sid)) continue;
    const file = join(eventsDir, `${sid}.jsonl`);
    if (!existsSync(file)) continue;
    const project = canonicalProjectOf({ workspace: repoRootOf(b.workspace!) });
    const known = project && catalog.names.includes(project) ? project : null;
    const messages: CapturedMessage[] = [], shipped: Shipped[] = [], seen = new Set<string>();
    // 用户消息的 key 是 user:<clientMessageId>；经 turn 记录找到 operationId，再到审计里查是谁发的
    const actorOfMessage = new Map<string, string>();
    for (const t of b.turns ?? []) { const a = t.operationId ? actors.get(t.operationId) : undefined; if (t.clientMessageId && a) actorOfMessage.set(`user:${t.clientMessageId}`, a); }
    let lastAssistant = '', lastSystem = '', previousHuman = ''; // 指代只关联紧邻的上一条人类消息
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e: { kind?: string; role?: string; source?: string; key?: string; text?: string; recordedAt?: string; turnNo?: number };
      try { e = JSON.parse(line); } catch { continue; }
      if (e.kind === 'message' && e.role === 'assistant' && typeof e.text === 'string' && e.text.trim()) { lastAssistant = e.text; continue; }
      const isPlatformUser = e.kind === 'message' && e.role === 'user' && e.source === 'platform';
      const isPlatformNotice = e.kind === 'notice' && e.source === 'platform';
      if ((!isPlatformUser && !isPlatformNotice) || typeof e.text !== 'string' || !e.text.trim()) continue;
      if (e.key) { if (seen.has(e.key)) continue; seen.add(e.key); }
      const rawText = e.text;
      e.text = stripMemoryQuotes(e.text);
      const at = e.recordedAt ?? '';
      if (opts.since && at < opts.since) continue;
      const cls = classifyMessage(e.text);
      if (cls === 'shipped') { const s = parseShipped(e.text, at, sid); if (s) { shipped.push(s); stats.shipped++; } lastSystem = e.text; continue; }
      if (isPlatformNotice) continue;
      // 不是人发的：前缀认得出的自动消息，或审计里记的发送者是系统 / 评测 harness / 宿主。不进记忆，只留作后面那句话的上下文。
      const systemActor = e.key ? originOfActor(actorOfMessage.get(e.key)) === 'system' : false;
      if (cls === 'auto' || systemActor) { if (systemActor && cls !== 'auto') stats.systemActorMessages++; else stats.autoMessages++; lastSystem = e.text; continue; }
      const revision = memoryRevisionContext(rawText, previousHuman);
      previousHuman = rawText;
      if (!e.text.trim()) continue;                       // 只有引用，不构成依据，也不延续前一次纠正
      if (looksSensitive(e.text) || (revision && looksSensitive(revision))) { stats.sensitiveDropped++; previousHuman = ''; lastAssistant = ''; lastSystem = ''; continue; }
      const context: MessageContext = {};
      if (revision) context.memory = revision;
      if (lastAssistant && !looksSensitive(lastAssistant)) context.assistant = tail(lastAssistant, CONTEXT_ASSISTANT_MAX);
      if (lastSystem && !looksSensitive(lastSystem)) context.system = head(lastSystem, CONTEXT_SYSTEM_MAX);
      lastAssistant = ''; lastSystem = '';
      messages.push({ at, text: e.text.trim(), ...(e.key ? { key: e.key } : {}), ...(e.key && opts.manualMarks?.get(sid)?.has(e.key) ? { manual: true } : {}), ...(revision ? { memoryRevision: true } : {}), ...(e.turnNo != null ? { turnNo: e.turnNo } : {}), ...(context.assistant || context.system || context.memory ? { context } : {}) });
      stats.userMessages++;
    }
    if (!messages.length && !shipped.length) continue;
    stats.sessions++;
    out.push({ sessionId: sid, runtime: b.runtimeKind ?? '?', project: known, title: b.title ?? '', startedAt: b.createdAt?.at ?? messages[0]?.at ?? '', messages, shipped });
  }
  out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return { sessions: out, projects: catalog.names, stats };
}
