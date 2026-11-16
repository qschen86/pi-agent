import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProbeReaders } from '../../../../../../packages/runtime-sessions/src/memory-probes.js';

/**
 * 取证项读取器（只读本机文件）：模型判定的强约束规则按功能事实核对时，回合开始 / 结束各读一次，比较前后有没有变化。
 * - android-release：原生 App 发布目录的 release.json（打包发布脚本写它）→ {versionCode, versionName, sha256}；没有发布过 = null。
 * - live-deploy：deploys.log 里最近一次部署成功（deploy … ok）的提交与时间 → {commit, at}。
 */
export function evidenceReaders(opts: { releaseDir?: string; guiRoot?: string }): ProbeReaders {
  const guiRoot = opts.guiRoot ?? process.env['PI_AGENT_GUI_ROOT'] ?? join(homedir(), '.pi-agent-gui');
  return {
    'android-release': async () => {
      if (!opts.releaseDir) return null;
      try {
        const j = JSON.parse(await readFile(join(opts.releaseDir, 'release.json'), 'utf8')) as { versionCode?: unknown; versionName?: unknown; sha256?: unknown };
        return { versionCode: j.versionCode ?? null, versionName: j.versionName ?? null, sha256: j.sha256 ?? null };
      } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    },
    'live-deploy': async () => {
      let log: string;
      try { log = await readFile(join(guiRoot, 'deploys.log'), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
      const lines = log.trimEnd().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = /^(\S+(?: \S+)?)\tdeploy\t(\w+)\tok\s*$/.exec(lines[i]!);
        if (m) return { commit: m[2], at: m[1] };
      }
      return null;
    }
  };
}
