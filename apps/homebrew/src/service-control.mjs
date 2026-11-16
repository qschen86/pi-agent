import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

export const dataParent = () => join(homedir(), 'Library/Application Support/pi-agent');
export function privateDirectory(base) {
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const stat = lstatSync(base);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error('实例目录必须属于当前用户且不能是符号链接');
  chmodSync(base, 0o700);
}
export function readControl(base) {
  try {
    const file = join(base, 'service.json'), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 8192) return undefined;
    const record = JSON.parse(readFileSync(file, 'utf8'));
    if (record.schema !== 2 || record.root !== join(resolve(base), 'instance') || !Number.isSafeInteger(record.pid) || record.pid < 1 ||
      !/^[a-f0-9]{64}$/.test(record.token ?? '') || !/^[a-f0-9]{32}$/.test(record.instanceId ?? '') ||
      !/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.test(record.origin ?? '') || Number(new URL(record.origin).port) > 65535) return undefined;
    return record;
  } catch { return undefined; }
}
export async function inspectService(base) {
  const record = readControl(base);
  if (!record) return { state: 'stopped' };
  let alive = false;
  try {
    process.kill(record.pid, 0);
    alive = true;
    const challenge = randomBytes(16).toString('hex');
    const response = await fetch(`${record.origin}/api/local/identity`, { method: 'POST', redirect: 'error',
      headers: { origin: record.origin, authorization: `Bearer ${record.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ challenge }), signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw Error('identity');
    const body = await response.text();
    if (body.length > 8192) throw Error('identity');
    const identity = JSON.parse(body);
    if (identity.challenge !== challenge || identity.pid !== record.pid || identity.root !== record.root || identity.instanceId !== record.instanceId) throw Error('identity');
    return { state: 'running', pid: record.pid, origin: record.origin, version: identity.version };
  } catch (error) { return alive || error.code !== 'ESRCH' ? { state: 'unverified' } : { state: 'stopped', stale: true }; }
}
export function acquireInstanceLock(base) {
  const file = join(base, 'service.lock');
  try { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error('实例锁无效'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const fd = openSync(file, 'a', 0o600);
  try {
    // macOS lockf can lock an inherited descriptor. The shared open descriptor
    // retains the advisory lock until this process closes it, including on crash.
    execFileSync('/usr/bin/lockf', ['-s', '-t', '0', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd] });
  } catch { closeSync(fd); throw Error('此实例已有服务运行；请使用 pi-agent status 或 open'); }
  return () => closeSync(fd);
}
export function publishControl(base, record) {
  const file = join(base, 'service.json'), temporary = `${file}.${randomBytes(8).toString('hex')}`;
  try { writeFileSync(temporary, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
}
export async function rejectLegacyOwner(base) {
  // Earlier local prototypes did not participate in the Homebrew lock protocol.
  const file = join(base, 'service.json');
  let record;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 8192) throw Error('现有实例控制文件无效，请先检查已有服务');
    record = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (record.schema !== 1) return;
  if (!Number.isSafeInteger(record.pid) || record.pid < 1) throw Error('旧实例控制文件无效，请先检查已有服务');
  try { process.kill(record.pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return; throw error; }
  // A live old process is enough to refuse concurrent access. Do not kill it or
  // turn an unverifiable PID into an asserted running state in `status`.
  throw Error('检测到旧版实例进程，请先停止旧服务再使用 Homebrew 启动');
}
export function removeControl(base, instanceId) {
  if (readControl(base)?.instanceId === instanceId) rmSync(join(base, 'service.json'));
}
