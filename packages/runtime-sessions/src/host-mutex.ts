/** Local-host Lamport bakery mutex. No lease, clock expiry, or shared-lock deletion.
 * Each synchronous critical section owns a unique intent. Only an OS-confirmed dead
 * local PID is skipped; unreadable/foreign/live owners remain fences. Dead intents
 * stay as evidence so concurrent recovery never unlinks a successor's lock.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
interface Intent { version: 1; pid: number; host: string; ticket: number | null }
const host = createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
const pattern = /^([a-f0-9]{16})-([1-9][0-9]*)-([a-f0-9-]{36})\.json$/;
function dead(pid: number): boolean {
 try { process.kill(pid, 0); return false; }
 catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
function intents(dir: string, own: string): Array<{name: string; ticket: number | null}> | undefined {
 const result: Array<{name: string; ticket: number | null}> = [];
 for (const name of readdirSync(dir)) {
  if (name === own || name.endsWith(".tmp")) continue;
  const match = pattern.exec(name);
  if (!match || match[1] !== host || !Number.isSafeInteger(Number(match[2]))) return;
  const pid = Number(match[2]);
  // Filename ownership is published atomically even if death interrupted its content.
  if (dead(pid)) continue;
  let value: Intent;
  try { value = JSON.parse(readFileSync(join(dir, name), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; return; }
  if (!value || value.version !== 1 || value.pid !== pid || value.host !== host || !(value.ticket === null || Number.isSafeInteger(value.ticket) && value.ticket > 0)) return;
  result.push({name, ticket: value.ticket});
 }
 return result;
}
/** fn must be synchronous; this mutex covers host publication, never native execution. */
export function withHostMutex<T>(root: string, fn: () => T): T | {status: "busy"} {
 // Old ownerless locks cannot be proven dead and need explicit host reconciliation.
 if (existsSync(join(root, "admission.lock"))) return {status: "busy"};
 const dir = join(root, "admission-intents"); mkdirSync(dir, {recursive: true, mode: 0o700});
 const name = `${host}-${process.pid}-${randomUUID()}.json`, file = join(dir, name), temporary = file + ".tmp";
 const value: Intent = {version: 1, pid: process.pid, host, ticket: null};
 // Intents serialize live local processes; durable business ledgers fsync separately.
 // A host power loss kills every contender, so intent publication needs visibility, not disk flush.
 const fd = openSync(file, "wx", 0o600);
 try {
  try { writeFileSync(fd, JSON.stringify(value)); } finally { closeSync(fd); }
  const before = intents(dir, name); if (!before) return {status: "busy"};
  value.ticket = before.reduce((max, i) => Math.max(max, i.ticket ?? 0), 0) + 1;
  if (!Number.isSafeInteger(value.ticket)) return {status: "busy"};
  const next = openSync(temporary, "wx", 0o600);
  try { writeFileSync(next, JSON.stringify(value)); } finally { closeSync(next); }
  renameSync(temporary, file);
  const after = intents(dir, name);
  if (!after || after.some(i => i.ticket === null || i.ticket < value.ticket! || i.ticket === value.ticket && i.name < name)) return {status: "busy"};
  return fn();
 } finally {
  // Only our UUID is removed. Other owners (including dead owners) are immutable.
  if (existsSync(temporary)) unlinkSync(temporary);
  unlinkSync(file);
 }
}
