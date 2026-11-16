import { totalmem } from 'node:os';
import { execFileSync } from 'node:child_process';
import { existsSync, statfsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIREMENTS = Object.freeze({ macosMajor: 14, memoryBytes: 16 * 1024 ** 3, freeBytes: 40 * 1000 ** 3 });

/** Pure policy; unknown measurements fail closed instead of being reported as sufficient. */
export function assessEnvironment(facts) {
  const version = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(facts.macosVersion ?? '');
  const checks = [
    { id: 'platform', label: 'macOS', passed: facts.platform === 'darwin', detail: '仅支持 macOS' },
    { id: 'architecture', label: 'Apple Silicon', passed: facts.arch === 'arm64' && facts.appleSilicon === true, detail: '需要 M 系列芯片和原生 arm64 运行环境，不支持 Intel 或 Rosetta 启动' },
    { id: 'system', label: '系统版本', passed: !!version && Number(version[1]) >= REQUIREMENTS.macosMajor, detail: '最低兼容目标为 macOS 14；正式支持以发行版验收名单为准' },
    { id: 'memory', label: '内存', passed: Number.isSafeInteger(facts.memoryBytes) && facts.memoryBytes >= REQUIREMENTS.memoryBytes, detail: '至少 16GB 内存' },
    { id: 'disk', label: '可用空间', passed: Number.isSafeInteger(facts.freeBytes) && facts.freeBytes >= REQUIREMENTS.freeBytes, detail: '安装位置所在磁盘至少有 40GB 可用空间' },
    { id: 'sandbox', label: '执行边界', passed: facts.seatbelt === true, detail: '需要系统 Seatbelt；任务启动时仍须执行读写边界自检' }
  ];
  return { eligible: checks.every(c => c.passed), checks, facts, requirements: REQUIREMENTS };
}

export function inspectEnvironment(target, deps = {}) {
  const exec = deps.exec ?? ((command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  const platform = deps.platform ?? process.platform;
  const read = (command, args) => { try { return exec(command, args); } catch { return undefined; } };
  let ancestor = resolve(target);
  while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor);
  let freeBytes;
  try { const disk = (deps.statfs ?? statfsSync)(realpathSync(ancestor)); freeBytes = disk.bavail * disk.bsize; } catch { /* Unknown disk state blocks initialization. */ }
  return assessEnvironment({
    platform, arch: deps.arch ?? process.arch,
    appleSilicon: platform === 'darwin' && read('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64']) === '1',
    macosVersion: platform === 'darwin' ? read('/usr/bin/sw_vers', ['-productVersion']) : undefined,
    memoryBytes: (deps.totalmem ?? totalmem)(), freeBytes,
    seatbelt: platform === 'darwin' && (deps.exists ?? existsSync)('/usr/bin/sandbox-exec')
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = inspectEnvironment(process.argv[2] ?? process.cwd());
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.eligible ? 0 : 1;
}
