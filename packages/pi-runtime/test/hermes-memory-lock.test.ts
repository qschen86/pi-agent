import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { guardedHermesApi, withMemoryLock } from '../src/hermes-extension.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
const lockPath = () => { const root = mkdtempSync(join(tmpdir(), 'hermes-lock-')); roots.push(root); return join(root, '.runtime-memory.lock'); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

it('holds the lock only while the operation runs, and releases it after success or failure', async () => {
  const lock = lockPath();
  expect(await withMemoryLock(lock, () => { expect(existsSync(lock)).toBe(true); return 'done'; })).toBe('done');
  expect(existsSync(lock)).toBe(false);
  await expect(withMemoryLock(lock, () => { throw new Error('tool failed'); })).rejects.toThrow('tool failed');
  expect(existsSync(lock)).toBe(false);
});

it('serializes overlapping calls in one process in arrival order', async () => {
  const lock = lockPath(), order: string[] = [];
  const run = (name: string, ms: number) => withMemoryLock(lock, async () => { order.push(`${name}:start`); await sleep(ms); order.push(`${name}:end`); });
  await Promise.all([run('a', 40), run('b', 5), run('c', 5)]);
  expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
});

it('serializes calls across processes and a waiting caller proceeds once the holder finishes', async () => {
  const lock = lockPath();
  const child = fork(new URL('./fixtures/hold-memory-lock.mts', import.meta.url).pathname, [lock, '400'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  // Listen for exit right away: the holder can finish before the waiter below returns.
  const exited = new Promise(r => child.once('exit', r));
  await new Promise<void>((resolve, reject) => { child.once('message', m => m === 'held' ? resolve() : reject(new Error(String(m)))); child.once('error', reject); });
  const started = Date.now();
  await withMemoryLock(lock, () => undefined);
  expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  await exited;
  expect(existsSync(lock)).toBe(false);
});

it('times out with a clear error instead of waiting forever on a live holder', async () => {
  const lock = lockPath();
  writeFileSync(lock, JSON.stringify({ pid: process.pid }) + '\n');
  await expect(withMemoryLock(lock, () => 'never', 120)).rejects.toThrow(/memory is busy/);
  expect(existsSync(lock)).toBe(true);
});

it('takes over a lock left by a process that no longer exists, or one far older than any real call', async () => {
  const lock = lockPath();
  writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345 }) + '\n');
  expect(await withMemoryLock(lock, () => 'dead holder', 500)).toBe('dead holder');
  writeFileSync(lock, JSON.stringify({ pid: process.pid }) + '\n');
  const old = new Date(Date.now() - 11 * 60_000); utimesSync(lock, old, old);
  expect(await withMemoryLock(lock, () => 'ancient', 500)).toBe('ancient');
  writeFileSync(lock, 'not json');
  const stale = new Date(Date.now() - 10_000); utimesSync(lock, stale, stale);
  expect(await withMemoryLock(lock, () => 'garbage', 500)).toBe('garbage');
  expect(existsSync(lock)).toBe(false);
});

it('wraps only the Hermes memory tools, running each under the lock', async () => {
  const lock = lockPath(), registered: Record<string, any> = {};
  const api = guardedHermesApi({ registerTool: (t: any) => { registered[t.name] = t; } } as any, lock);
  let during: boolean | undefined;
  api.registerTool({ name: 'memory_add', execute: async () => { during = existsSync(lock); return 'ok'; } } as any);
  api.registerTool({ name: 'skill_manage', execute: async () => 'blocked' } as any);
  expect(Object.keys(registered)).toEqual(['memory_add']);
  expect(await registered.memory_add.execute()).toBe('ok');
  expect(during).toBe(true);
  expect(existsSync(lock)).toBe(false);
});

it('queues the store-writing lifecycle hooks behind the lock but leaves read-path hooks alone', async () => {
  const lock = lockPath(), seen: Record<string, boolean> = {};
  const handlers: Record<string, Function> = {};
  const api = guardedHermesApi({ registerTool() {}, on: (event: string, fn: Function) => { handlers[event] = fn; } } as any, lock);
  for (const event of ['session_start', 'session_shutdown', 'session_before_compact', 'turn_end', 'message_end', 'before_agent_start'])
    (api as any).on(event, async () => { seen[event] = existsSync(lock); });
  for (const event of Object.keys(handlers)) await handlers[event]({}, {});
  expect(seen).toEqual({ session_start: true, session_shutdown: true, session_before_compact: true, turn_end: true, message_end: false, before_agent_start: false });
  expect(existsSync(lock)).toBe(false);
});

it('lets a call nested inside a held lock run instead of deadlocking on itself', async () => {
  const lock = lockPath();
  expect(await withMemoryLock(lock, async () => withMemoryLock(lock, async () => { await sleep(5); return 'nested'; }))).toBe('nested');
  expect(existsSync(lock)).toBe(false);
});
