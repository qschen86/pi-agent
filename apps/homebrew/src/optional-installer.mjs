import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, renameSync, rmSync, lstatSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { isolatedEnv } from './network-host.mjs';

const run = promisify(execFile);
export const OPTIONAL_RUNTIMES = Object.freeze(['codex', 'claude-code', 'antigravity']);
const ANTIGRAVITY_URL_PREFIX = 'https://storage.googleapis.com/antigravity-public/antigravity-cli/';

export function componentPath(root, runtime) {
  if (!OPTIONAL_RUNTIMES.includes(runtime)) throw Error('运行时选择无效');
  return join(root, 'runtime/components', runtime);
}
export function componentBinary(root, runtime) {
  const base = componentPath(root, runtime);
  const path = runtime === 'codex'
    ? join(base, 'node_modules/.bin/codex')
    : runtime === 'claude-code'
      ? join(base, 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude')
      : join(base, 'bin/agy');
  const real = realpathSync(path);
  if (!real.startsWith(realpathSync(base) + sep) || !lstatSync(real).isFile()) throw Error('运行时组件路径无效');
  return real;
}

export function isComponentInstalled(root, runtime) {
  try {
    const target = componentPath(root, runtime);
    if (!existsSync(join(target, 'receipt.json'))) return false;
    componentBinary(root, runtime);
    return true;
  } catch {
    return false;
  }
}

async function installAntigravity({ root, manifest, target, stage, lockHash, execute }) {
  const spec = JSON.parse(readFileSync(join(manifest, 'manifest.json'), 'utf8'));
  if (spec?.runtime !== 'antigravity' || typeof spec.version !== 'string' || !spec.version.trim() ||
    typeof spec.url !== 'string' || !spec.url.startsWith(ANTIGRAVITY_URL_PREFIX) ||
    typeof spec.sha512 !== 'string' || !/^[a-f0-9]{128}$/.test(spec.sha512)) {
    throw Error('Antigravity 清单无效');
  }
  const archive = join(stage, 'agy.tar.gz');
  const extractDir = join(stage, 'extract');
  const binDir = join(stage, 'bin');
  mkdirSync(extractDir, { mode: 0o700 });
  mkdirSync(binDir, { mode: 0o700 });
  await execute('/usr/bin/curl', [
    '-q', '--fail', '--silent', '--show-error', '--proto', '=https', '--max-redirs', '0',
    '--max-time', '180', '--output', archive, spec.url
  ], { env: isolatedEnv(root), timeout: 210_000, maxBuffer: 1024 * 1024 });
  if (!existsSync(archive)) throw Error('下载未生成归档');
  const actualSha512 = createHash('sha512').update(readFileSync(archive)).digest('hex');
  if (actualSha512 !== spec.sha512) throw Error('Antigravity 校验和不一致');
  await execute('/usr/bin/tar', ['-xzf', archive, '-C', extractDir, 'antigravity'], {
    env: isolatedEnv(root), timeout: 60_000, maxBuffer: 1024 * 1024
  });
  const extracted = join(extractDir, 'antigravity');
  if (!existsSync(extracted) || lstatSync(extracted).isSymbolicLink()) throw Error('解压产物无效');
  const stagedBin = join(binDir, 'agy');
  renameSync(extracted, stagedBin);
  chmodSync(stagedBin, 0o755);
  rmSync(archive, { force: true });
  rmSync(extractDir, { recursive: true, force: true });
  writeFileSync(join(stage, 'receipt.json'), JSON.stringify({ runtime: 'antigravity', version: spec.version, lockHash }) + '\n', { mode: 0o600 });
  renameSync(stage, target);
  try {
    const binary = componentBinary(root, 'antigravity');
    await execute(binary, ['--version'], { env: isolatedEnv(root), timeout: 15_000, maxBuffer: 64_000 });
    writeFileSync(join(target, 'receipt.json'), JSON.stringify({
      runtime: 'antigravity', version: spec.version, lockHash,
      binaryHash: createHash('sha256').update(readFileSync(binary)).digest('hex')
    }) + '\n', { mode: 0o600 });
  } catch {
    rmSync(target, { recursive: true, force: true });
    throw Error('运行时组件验证失败');
  }
  return { installed: true, reused: false, version: spec.version };
}

export async function installOptionalRuntime({ root, runtime, manifestRoot, npmCli, execute = run }) {
  const target = componentPath(root, runtime);
  const manifest = join(manifestRoot, runtime);
  const lockFile = runtime === 'antigravity' ? 'manifest.json' : 'package-lock.json';
  const lock = readFileSync(join(manifest, lockFile));
  const lockHash = createHash('sha256').update(lock).digest('hex');
  if (existsSync(join(target, 'receipt.json'))) {
    const receipt = JSON.parse(readFileSync(join(target, 'receipt.json'), 'utf8'));
    if (receipt.lockHash !== lockHash) throw Error('运行时组件版本需要升级，不能覆盖现有组件');
    const binary = componentBinary(root, runtime);
    if (createHash('sha256').update(readFileSync(binary)).digest('hex') !== receipt.binaryHash) throw Error('运行时组件校验失败，不能复用');
    return { installed: true, reused: true, version: receipt.version };
  }
  if (runtime !== 'antigravity' && (!npmCli || !existsSync(npmCli))) throw Error('安装工具未打包，请更新安装包');
  if (existsSync(target)) throw Error('运行时组件目录已存在，不能覆盖');
  const parent = join(root, 'runtime/components'); mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stage = join(parent, `.install-${runtime}-${randomBytes(8).toString('hex')}`);
  mkdirSync(stage, { mode: 0o700 });
  try {
    if (runtime === 'antigravity') {
      return await installAntigravity({ root, manifest, target, stage, lockHash, execute });
    }
    for (const name of ['package.json', 'package-lock.json']) copyFileSync(join(manifest, name), join(stage, name));
    const emptyConfig = join(stage, '.npmrc-empty'); writeFileSync(emptyConfig, '', { mode: 0o600 });
    const globalConfig = join(stage, '.npmrc-global'); writeFileSync(globalConfig, '', { mode: 0o600 });
    // Lockfile integrity + no lifecycle scripts. Native platform packages are explicit optional deps.
    await execute(process.execPath, [npmCli, 'ci', '--prefix', stage, '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '--fetch-retries=0', '--fetch-timeout=30000', '--cache', join(root, 'runtime/npm-cache'), '--userconfig', emptyConfig, '--globalconfig', globalConfig], { env: isolatedEnv(root), timeout: 300_000, maxBuffer: 1024 * 1024 });
    const packageName = runtime === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-agent-sdk';
    const version = JSON.parse(readFileSync(join(stage, 'node_modules', packageName, 'package.json'), 'utf8')).version;
    writeFileSync(join(stage, 'receipt.json'), JSON.stringify({ runtime, version, lockHash }) + '\n', { mode: 0o600 });
    renameSync(stage, target);
    try {
      const binary = componentBinary(root, runtime);
      await execute(binary, ['--version'], { env: isolatedEnv(root), timeout: 15_000, maxBuffer: 64_000 });
      writeFileSync(join(target, 'receipt.json'), JSON.stringify({ runtime, version, lockHash, binaryHash: createHash('sha256').update(readFileSync(binary)).digest('hex') }) + '\n', { mode: 0o600 });
    }
    catch { rmSync(target, { recursive: true, force: true }); throw Error('运行时组件验证失败'); }
    return { installed: true, reused: false, version };
  } catch (error) {
    if (error?.message === '运行时组件验证失败') throw error;
    throw Error('运行时组件安装失败，请检查网络后重试');
  }
  finally { rmSync(stage, { recursive: true, force: true }); }
}
