import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const assetDigest = (body: Uint8Array | string) => createHash('sha256').update(body).digest('hex');
export const ASSET_PATH = /^\/assets\/([a-f0-9]{64})\/([a-z][a-z0-9-]*\.(?:js|css))$/;
export type ReleaseManifest = { schema: 1; release: string; htmlDigest?: string; previousRelease?: string; assets: Record<string, string>; previous: Record<string, string>; worker?: string; offline?: { digest: string; csp: string };
  /** 构建这份 release 的源码提交（V1.4 §3.4）；dirty=工作区有未提交改动，诊断时标为「代码版本不确定」 */
  gitCommit?: string; dirty?: boolean;
  /** 源码提交时间（ISO）；previousVersion=上一个 release 的提交与提交时间，供「有更新」面板说明当前版本 */
  committedAt?: string; previousVersion?: { gitCommit?: string; committedAt?: string } };

/** A release is immutable and validated in full before it can serve HTML. */
export class StaticRelease {
  manifest?: ReleaseManifest;
  html?: Buffer;
  worker?: Buffer;
  private bodies = new Map<string, Buffer>();
  constructor(dir: string) {
    if (!existsSync(dir)) return;
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ReleaseManifest;
    if (m.schema !== 1 || !m.assets || !m.previous || !/^[a-f0-9]{64}$/.test(m.release)) throw new Error('Invalid static release');
    for (const [url, digest] of Object.entries({ ...m.previous, ...m.assets })) {
      const match = ASSET_PATH.exec(url);
      if (!match || match[1] !== digest) throw new Error('Invalid release asset path');
      const body = readFileSync(join(dir, digest, match[2]!));
      if (assetDigest(body) !== digest) throw new Error('Corrupt release asset');
      this.bodies.set(url, body);
    }
    const html = readFileSync(join(dir, 'index.html'));
    if (assetDigest(html) !== (m.htmlDigest ?? m.release)) throw new Error('Corrupt release HTML');
    if (m.htmlDigest) {
      const marker = `<meta name="pi-web-release" content="${m.release}">\n`;
      const document = html.toString();
      if (document.split(marker).length !== 2 || assetDigest(document.replace(marker, '')) !== m.release) throw new Error('Invalid release identity');
    }
    if (m.previousRelease && !/^[a-f0-9]{64}$/.test(m.previousRelease)) throw new Error('Invalid previous release');
    const urls = [...html.toString().matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g)].map(match => match[1]!);
    if (!urls.length || urls.some(url => !m.assets[url])) throw new Error('Incomplete release HTML');
    if (m.worker) {
      this.worker = readFileSync(join(dir, 'sw.js'));
      if (assetDigest(this.worker) !== m.worker) throw new Error('Corrupt release worker');
    }
    if (m.offline && assetDigest(readFileSync(join(dir, 'offline.html'))) !== m.offline.digest) throw new Error('Corrupt offline shell');
    this.manifest = m;
    this.html = html;
  }
  get(url: string) { return this.bodies.get(url); }
}
