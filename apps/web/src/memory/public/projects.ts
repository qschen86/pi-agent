import { basename } from 'node:path';
import { claudeProjectLabel } from '../../../../../packages/runtime-memory/src/native/index.js';

/**
 * 公共记忆里的「项目」统一用仓库目录名（和 Pi/Hermes 的项目名同口径，如 pi-agent）。
 * Claude 的项目记忆标签是路径转义后的样子（如 Documents-pi-agent），Codex 没有项目维度；
 * 这里把会话的工作目录换算成它可能出现的所有名字，用于归一来源项目名和匹配会话。
 */
export const claudeKeyOf = (path: string): string => path.replace(/[^A-Za-z0-9]/g, '-');

export interface SessionPaths { workspace: string; repoRoot?: string | null | undefined }

/** 会话对应的规范项目名：优先仓库根（独立 worktree 的会话也算原仓库），否则工作目录名。 */
export function canonicalProjectOf(s: SessionPaths): string | null {
  const name = basename((s.repoRoot || s.workspace || '').replace(/\/+$/, ''));
  return name && name !== '.' && name !== '..' ? name : null;
}

/** 这个会话的项目可能被其它 runtime 记成的名字（含规范名本身）。 */
export function projectAliasesOf(s: SessionPaths): string[] {
  const out = new Set<string>();
  const canonical = canonicalProjectOf(s);
  if (canonical) out.add(canonical);
  for (const p of [s.repoRoot, s.workspace]) if (p) out.add(claudeProjectLabel(claudeKeyOf(p)));
  return [...out];
}

export interface ProjectCatalog {
  /** 已知的规范项目名（供模型从中挑选，最近使用优先） */
  names: string[];
  /** 把某个 runtime 记的项目名换成规范名；不认识就原样返回 */
  canonical(project: string | null): string | null;
}

/** 用户主目录下的通用文件夹不是项目。 */
const GENERIC = new Set(['documents', 'desktop', 'downloads', 'library', 'home', 'users', 'tmp', 'var', 'private', 'volumes']);
/** 至少这么多个会话才算“已知项目”；测试 / 评估 / 一次性目录各只有一两个会话，不该出现在模型的候选项目里。 */
export const MIN_PROJECT_SESSIONS = 3;

export function buildCatalog(sessions: readonly SessionPaths[], extra: readonly string[] = [], opts: { minSessions?: number } = {}): ProjectCatalog {
  const min = opts.minSessions ?? MIN_PROJECT_SESSIONS;
  const counts = new Map<string, number>();
  for (const s of sessions) {
    const name = canonicalProjectOf(s);
    if (name && !GENERIC.has(name.toLowerCase())) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = [...counts.entries()].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n);
  const keep = new Set(names);
  const alias = new Map<string, string>();
  for (const s of sessions) {
    const name = canonicalProjectOf(s);
    if (!name || !keep.has(name)) continue;
    for (const a of projectAliasesOf(s)) if (!alias.has(a)) alias.set(a, name);
  }
  for (const e of extra) if (e && !names.includes(e)) names.push(e);
  return { names: names.slice(0, 60), canonical: project => (project ? alias.get(project) ?? project : null) };
}
