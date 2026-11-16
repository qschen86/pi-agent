import { CAPS, PROGRESS_SUB, PROGRESS_TTL_DAYS, type Shipped, type Topic } from './types.js';

const TITLE_MAX = 34;
const trimTitle = (t: string): string => {
  const s = t.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '').replace(/\s+/g, ' ').trim();
  return Array.from(s).length > TITLE_MAX ? Array.from(s).slice(0, TITLE_MAX).join('') + '…' : s;
};
const day = (iso: string): string => new Date(Date.parse(iso) + 8 * 3_600_000).toISOString().slice(0, 10);

/**
 * 项目进展：不经模型，直接由「已上线」部署通知生成一条头条（近 14 天最多 5 个，同一提交去重）。
 * 日期按北京时间。过期后不再进公共层；到期前也标「须核查」（进展随时可能被后续会话改变）。
 */
export function buildProgress(project: string, shipped: readonly Shipped[], now: Date, resolveTitle: (s: Shipped) => string = s => s.title): Topic | null {
  const horizon = now.getTime() - PROGRESS_TTL_DAYS * 86_400_000;
  const seen = new Set<string>();
  const recent = [...shipped].filter(s => Date.parse(s.at) >= horizon).sort((a, b) => b.at.localeCompare(a.at)).filter(s => (seen.has(s.sha) ? false : (seen.add(s.sha), true))).slice(0, CAPS.progressPerProject);
  if (!recent.length) return null;
  const latest = recent[0]!;
  // 标题解析后仍是“Merge …”的读不出上线了什么，不进头条
  const titles = [...new Set(recent.map(s => resolveTitle(s)).filter(t => !/^Merge /.test(t)).map(trimTitle))];
  if (!titles.length) return null;
  const statement = `近期上线（截至 ${day(latest.at)}，须核查）：${titles.join('；')}`;
  return {
    id: `t-progress-${project}`, domain: 'project', project, sub: PROGRESS_SUB, topic: '近期上线', statement, tier: 'A', score: 6,
    signals: { explicit: 0, sessions: new Set(recent.map(s => s.sessionId)).size, redLine: false, crossFeature: false, firstAt: recent[recent.length - 1]!.at, lastAt: latest.at },
    sessionIds: [...new Set(recent.map(s => s.sessionId))],
    evidence: recent.map(s => ({ obsId: `ship-${s.sha}`, sessionId: s.sessionId, at: s.at, quote: `已上线：${s.sha}（${s.title}）`, explicit: false })),
    history: [], memberIds: [], basis: '', asOf: latest.at, expiresAt: new Date(Date.parse(latest.at) + PROGRESS_TTL_DAYS * 86_400_000).toISOString()
  };
}
