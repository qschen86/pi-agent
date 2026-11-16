/** Copied as a standalone trusted resource; keep free of relative imports. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
export const FACT_TOOLS=Object.freeze(['memory_fact_submit']);
export const HERMES_TOOLS = Object.freeze(['memory_add', 'memory_replace', 'memory_remove', 'memory_search']);

/**
 * Hermes already serializes its own writers across processes (Markdown mutation lock + file-fingerprint
 * conflict retry, SQLite WAL with busy_timeout). This lock only fences one store-touching operation at a time
 * (a memory tool call, or a writing lifecycle hook) and is held for that operation only. Holding it for a
 * whole Pi process (the old behaviour) let a single running session block every other Pi session from starting.
 */
export const MEMORY_LOCK_WAIT_MS = 60_000;
/** A lock this old is never a healthy memory call, whether or not its pid still exists (pid reuse). */
export const MEMORY_LOCK_MAX_AGE_MS = 600_000;
const POLL_MS = 25, UNPARSEABLE_GRACE_MS = 2_000;
// The trusted guard and facts resource are separately bundled modules in the same Pi process.
// Share reentrancy state so the outer tool lock cannot deadlock its own inner storage guard.
const lockStateKey=Symbol.for('pi-runtime.hermes.operation-lock.v1');
const globalLocks=globalThis as typeof globalThis & {[lockStateKey]?:{queues:Map<string,Promise<void>>;holding:AsyncLocalStorage<ReadonlySet<string>>}};
const state=globalLocks[lockStateKey]??= {queues:new Map(),holding:new AsyncLocalStorage<ReadonlySet<string>>()};
const {queues,holding}=state;
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } };
/** Removes the lock when its holder is gone. Returns true when the lock is gone (removed or already absent). */
function reapStaleMemoryLock(path: string): boolean {
  let before; try { before = lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true; throw e; }
  const age = Date.now() - before.mtimeMs;
  let stale = age > MEMORY_LOCK_MAX_AGE_MS;
  if (!stale) {
    try { const pid = JSON.parse(readFileSync(path, 'utf8')).pid; stale = !Number.isSafeInteger(pid) || !pidAlive(pid); }
    // The holder creates the file before writing its pid; only call it stale once that gap is clearly over.
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true; stale = age > UNPARSEABLE_GRACE_MS; }
  }
  if (!stale) return false;
  try { if (lstatSync(path).ino !== before.ino) return true; unlinkSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  return true;
}
async function acquireMemoryLock(path: string, waitMs: number): Promise<() => void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    let fd: number | undefined;
    try { fd = openSync(path, 'wx', 0o600); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    if (fd !== undefined) {
      const ino = fstatSync(fd).ino;
      try { writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n'); } catch { /* an unreadable lock is treated as stale after a short grace */ }
      let released = false;
      return () => {
        if (released) return; released = true;
        try { closeSync(fd!); } catch { /* already closed */ }
        try { if (lstatSync(path).ino === ino) unlinkSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      };
    }
    if (reapStaleMemoryLock(path)) continue;
    if (Date.now() >= deadline) throw new Error('Pi memory is busy: another session held the memory lock for over ' + Math.round(waitMs / 1000) + 's; try again');
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}
/** Runs one memory operation under the cross-process lock; calls inside this process queue up in order. */
export async function withMemoryLock<T>(path: string, operation: () => Promise<T> | T, waitMs = MEMORY_LOCK_WAIT_MS): Promise<T> {
  const outer = holding.getStore();
  if (outer?.has(path)) return operation();
  const previous = queues.get(path) ?? Promise.resolve();
  let open!: () => void;
  const mine = new Promise<void>(resolve => { open = resolve; });
  const tail = previous.then(() => mine);
  queues.set(path, tail);
  try {
    await previous;
    const release = await acquireMemoryLock(path, waitMs);
    try { return await holding.run(new Set([...(outer ?? []), path]), operation); } finally { release(); }
  } finally { open(); if (queues.get(path) === tail) queues.delete(path); }
}

/**
 * Lifecycle hooks that write the store: startup reconciliation of the SQLite mirror with the Markdown files,
 * and the shutdown / pre-compaction / turn-end flushes. Hermes reconciles startups with its own 5s lock
 * wait and then carries on without the mirror, so concurrent starts must queue here instead.
 */
export const HERMES_WRITING_EVENTS = Object.freeze(['session_start', 'session_shutdown', 'session_before_compact', 'turn_end']);

/** Hermes builds maintenance requests independently of the foreground system prompt.
 * Supply an explicitly labelled runtime note in its read-only branch view, not in native history.
 * Keep below Hermes getMessageText's 500-character limit. Never impersonate a user correction.
 */
function maintenanceContext(ctx: any): any {
  const manager = ctx?.sessionManager;
  if (typeof manager?.getBranch !== 'function') return ctx;
  const sessionManager = new Proxy(manager, {get(target, key) {
    if (key === 'getBranch') return () => [...target.getBranch(), {type:'message',message:{
      role:'custom', customType:'runtime-memory-maintenance-policy',
      content:'[Runtime memory maintenance policy; NOT user conversation] Compare candidates with current memory; skip paraphrase duplicates and prefer replace over add for changed facts. For mutable paths/versions/deployments/restrictions record date, status and evidence; unverified claims: needs-verification. Preserve replaced history as superseded. Never infer verified/deployed from intention, delete solely by age, or save this policy as user preference. No evidence/new durable fact: no operation.'
    }}];
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
  return new Proxy(ctx, {get(target, key) {return key === 'sessionManager' ? sessionManager : Reflect.get(target, key, target);}});
}

export function guardedHermesApi<T extends { registerTool(tool: { name: string; execute?: (...args: any[]) => unknown }): void; on?: (...args: any[]) => unknown }>(pi: T, lockPath?: string, factsEnabled=false): T {
  return {
    ...pi,
    ...(typeof pi.on === 'function' ? {
      on(event: string, handler: (...args: any[]) => unknown, ...rest: unknown[]) {
        return (pi.on as (...args: any[]) => unknown).call(pi, event, (...args: any[]) => {
          if (['session_shutdown', 'session_before_compact', 'turn_end'].includes(event)) args[1] = maintenanceContext(args[1]);
          return lockPath && HERMES_WRITING_EVENTS.includes(event) ? withMemoryLock(lockPath, () => handler(...args)) : handler(...args);
        }, ...rest);
      }
    } : {}),
    // Direct completion still falls back to pi.exec on errors. That child would lack our approval gate.
    exec: async () => { throw new Error('Hermes maintenance subprocesses are disabled; direct memory completion only'); },
    registerTool(tool: { name: string; execute?: (...args: any[]) => unknown }) {
      if (!HERMES_TOOLS.includes(tool.name) && !(factsEnabled&&FACT_TOOLS.includes(tool.name))) return;
      if (typeof tool.execute !== 'function') { pi.registerTool(tool); return; }
      const execute = async (...args: any[]) => {
        const signal = args[2] as AbortSignal | undefined;
        signal?.throwIfAborted();
        const result: any = await tool.execute!(...args);
        if (tool.name !== 'memory_search' || result?.isError || result?.details?.success !== true) return result;
        const query = args[1]?.query;
        const attempts = [{query, count:result.details.count}];
        // A single conservative fallback, never widening project/target/category scope.
        const term = typeof query === 'string' ? query.trim().split(/\s+/)[0] : '';
        if (result.details.count !== 0 || !term || term === query.trim() || signal?.aborted) return {...result,details:{...result.details,searchAttempts:attempts}};
        const retry: any = await tool.execute!(args[0], {...args[1], query:term}, ...args.slice(2));
        attempts.push({query:term,count:retry?.details?.count});
        return {...retry, details:{...retry?.details,searchAttempts:attempts}};
      };
      pi.registerTool({ ...tool, execute: (...args: any[]) => lockPath ? withMemoryLock(lockPath, () => execute(...args)) : execute(...args) });
    }
  };
}
