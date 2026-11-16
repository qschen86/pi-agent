// Short kernel-owned critical sections shared by HTTP cancellation and cutover.
import { execFileSync } from 'node:child_process';
import { openSync, closeSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export function deploymentActionsSupported(root) {
  try { return readFileSync(join(root, 'control', 'deployment-actions.version'), 'utf8').trim() === '1'; }
  catch { return false; }
}
export function withDeploymentActions(home, action) {
  mkdirSync(home, { recursive: true });
  const fd = openSync(join(home, '.actions.mutex'), 'a');
  try {
    execFileSync('/usr/bin/lockf', ['-s', '-t', '5', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd] });
    return action();
  } finally { closeSync(fd); }
}
export function transitionDeployment(file, sha, phase) {
  return withDeploymentActions(dirname(file), () => {
    const p = JSON.parse(readFileSync(file, 'utf8'));
    if (!sha || p.sha !== sha) {
      if (p.requests?.length) throw new Error('部署版本已变化');
      return true; // An optional progress file for an unrelated manual run is not ours to update.
    }
    // A cancelled request cannot be revived by retry or cutover. Other covered requests may continue.
    if (['preparing', 'waiting', 'switching'].includes(phase) && Array.isArray(p.requests) && p.requests.length &&
        !p.requests.some(q => {
          try { const r = JSON.parse(readFileSync(join(dirname(file), 'requests', `${q.id}.json`), 'utf8')); return r.startedAt === q.startedAt; } catch { return false; }
        })) return false;
    if (p.phase !== phase) {
      const at = new Date().toISOString(); p.phase = phase; p.since = at;
      p.steps.push({ phase, at }); writeFileSync(file + '.tmp', JSON.stringify(p)); renameSync(file + '.tmp', file);
    }
    return true;
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { if (!transitionDeployment(...process.argv.slice(2))) process.exitCode = 77; }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
