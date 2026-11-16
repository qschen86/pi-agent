import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { withHostMutex } from '../../../../../packages/runtime-sessions/src/host-mutex.js';
import { atomicWrite } from '../store.js';
import { PublicMemoryError, defaultSettings, type PublicData } from './types.js';

export const mutationVersion = (data: PublicData): string => createHash('sha256').update(JSON.stringify(data)).digest('hex');

/**
 * 平台公共记忆的设置持久层：只有 settings.json（条目在 pipeline.json，见 pipeline/store.ts）。
 * 目录 0700、文件 0600、原子写；读-改-写在 withHostMutex 内完成，两个蓝绿槽位共享目录安全。
 * 文件损坏时拒绝写入（抛 storage-error），不静默当成默认值覆盖。
 * 旧机制留下的 knowledge.json / candidates.json / disputes.json 不再读取；settings.json 里已下线的开关（autoAdmit / injectFromTopics）读时忽略、写时丢弃。
 */
export class PublicMemoryStore {
  /** 每次成功写入后回调（锁外）。 */
  onChange: (() => void) | undefined;
  constructor(readonly root: string) {}

  private file(): string { return join(this.root, 'settings.json'); }

  readLocked<T>(fn: (data: PublicData) => T): T {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const result = withHostMutex(this.root, () => ({ value: fn(this.read()) }));
    if ('status' in result) throw new PublicMemoryError('busy');
    return result.value;
  }

  read(): PublicData {
    const file = this.file();
    let parsed: { version?: number; settings?: Partial<PublicData['settings']> } = {};
    if (existsSync(file)) {
      try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new PublicMemoryError('storage-error'); }
      if (parsed.version !== undefined && parsed.version !== 1) throw new PublicMemoryError('storage-error');
    }
    const d = defaultSettings(), s = parsed.settings ?? {};
    return { settings: { injectEnabled: typeof s.injectEnabled === 'boolean' ? s.injectEnabled : d.injectEnabled, pipelineEnabled: typeof s.pipelineEnabled === 'boolean' ? s.pipelineEnabled : d.pipelineEnabled } };
  }

  /** 读-改-写。expectedVersion 与当前版本不一致就拒绝（乐观并发）；内容没变不重写文件。 */
  change<T>(fn: (data: PublicData) => T, expectedVersion?: string): T {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    let error: unknown;
    const result = withHostMutex(this.root, () => {
      try {
        const data = this.read();
        if (expectedVersion !== undefined && expectedVersion !== mutationVersion(data)) throw new PublicMemoryError('conflict', '设置已变化，请刷新后再保存');
        const before = JSON.stringify(data);
        const value = fn(data);
        if (JSON.stringify(data) !== before || !existsSync(this.file())) atomicWrite(this.file(), JSON.stringify({ version: 1, settings: data.settings }) + '\n');
        return { value };
      } catch (e) { error = e; return undefined; }
    });
    if (error) throw error;
    if (!result || 'status' in result) throw new PublicMemoryError('busy');
    try { this.onChange?.(); } catch { /* 索引生成失败不影响写入 */ }
    return (result as { value: T }).value;
  }
}
