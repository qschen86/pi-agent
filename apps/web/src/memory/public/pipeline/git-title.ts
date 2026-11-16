import { execFileSync } from 'node:child_process';
import type { Shipped } from './types.js';

type Run = (root: string, args: string[]) => string;
const defaultRun: Run = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * 「已上线」通知里的标题，集成部署时常是 `Merge commit '…' into pi-deploy/integration-x`，读不出上线了什么。
 * 这里取该合并提交第二父（会话分支的尖端）沿“第一父”往回数、第一个非合并提交的标题——也就是会话自己最近一次真正的提交；
 * 会话分支合过 main 也不会取成别人的提交。取不到就保持原标题（由进展生成那边丢掉仍是合并的）。
 * 只读：`git log`；结果按提交号缓存，失败也缓存，避免反复起进程。
 */
export function gitTitleResolver(roots: () => readonly string[], run: Run = defaultRun): (s: Shipped) => string {
  const cache = new Map<string, string>();
  return s => {
    if (!/^Merge /.test(s.title)) return s.title;
    const hit = cache.get(s.sha);
    if (hit !== undefined) return hit;
    let found = s.title;
    for (const root of roots()) {
      try {
        const t = run(root, ['log', '--first-parent', '--no-merges', '-1', '--format=%s', `${s.sha}^2`]).trim();
        if (t && !/^Merge /.test(t)) { found = t; break; }
      } catch { /* 这个仓库里没有这个提交，换下一个 */ }
    }
    cache.set(s.sha, found);
    return found;
  };
}
