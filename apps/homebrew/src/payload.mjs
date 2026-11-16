import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { CORE_COMPONENTS } from './initialization.mjs';

const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const excluded = /(^|\/)(?:\.git|\.env(?:\.[^/]*)?|auth\.json|service-account\.json|google-services\.json|\.DS_Store|\.diagnostics|\.platform-browser|test|tests|evidence|challenge-island|wrong-book|pet-math-game|word-detective|android)(\/|$)|(^|\/)(?:ledger|communications|web-x)\.(?:js|css)$/i;

/** The packager consumes an explicitly prepared core payload, never the operator's HOME or whole checkout. */
export function validatePayload(payloadDir) {
  payloadDir = resolve(payloadDir);
  const marker = join(payloadDir, 'distribution.json');
  if (!existsSync(marker) || lstatSync(marker).isSymbolicLink() || lstatSync(marker).size > 8 * 1024 ** 2) throw Error('缺少有效的基础版载荷清单');
  const manifest = JSON.parse(readFileSync(marker, 'utf8'));
  if (manifest.schema !== 1 || manifest.edition !== 'mac-local-core' || manifest.arch !== 'arm64' || manifest.entry !== 'main.mjs' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(manifest.version ?? '')) throw Error('载荷版本、架构或入口无效');
  if (!Array.isArray(manifest.components) || [...manifest.components].sort().join(',') !== [...CORE_COMPONENTS].sort().join(',')) throw Error('基础组件清单不匹配');
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files) || !Object.hasOwn(manifest.files, manifest.entry)) throw Error('载荷必须包含真实的 main.mjs 入口');
  const actual = new Set();
  const walk = (dir, prefix = '') => {
    for (const name of readdirSync(dir)) {
      const rel = prefix + name; const path = join(dir, name); const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw Error(`载荷不得包含符号链接：${rel}`);
      if (excluded.test(rel)) throw Error(`载荷包含排除项：${rel}`);
      if (stat.isDirectory()) walk(path, rel + '/');
      else if (stat.isFile()) { if (rel !== 'distribution.json') actual.add(rel); }
      else throw Error(`载荷包含特殊文件：${rel}`);
    }
  };
  walk(payloadDir);
  for (const [path, hash] of Object.entries(manifest.files)) {
    if (isAbsolute(path) || path.split('/').some(part => !part || part === '.' || part === '..') || path.includes('\\') || !/^[a-f0-9]{64}$/.test(hash) || !actual.delete(path)) throw Error('文件清单无效或文件缺失');
    if (digest(join(payloadDir, path)) !== hash) throw Error(`载荷字节校验失败：${path}`);
  }
  if (actual.size) throw Error(`载荷存在未登记文件：${[...actual].slice(0, 3).join(', ')}`);
  return manifest;
}

