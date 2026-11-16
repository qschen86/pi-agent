import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { canonicalPath, isWithin } from '../../adapter-pi/src/runtime-guard-policy.js';
const marker = 'pi-runtime-memory.json';
export const HERMES_VERSION = '0.9.10';
export { HERMES_TOOLS } from './hermes-extension.js';
export function initializeHermesProfile(path: string): void {
  if (!isAbsolute(path) || existsSync(path)) throw new Error('Memory initialization requires a new absolute directory');
  mkdirSync(path, { mode: 0o700 });
  for (const child of ['data', 'data/global', 'data/projects-memory']) mkdirSync(join(path, child), { mode: 0o700 });
  writeFileSync(join(path, marker), JSON.stringify({ version: 1, owner: 'pi-runtime', purpose: 'hermes-memory', sourceId: `pi-hermes:${randomUUID()}` }) + '\n', { mode: 0o400, flag: 'wx' });
}
export function validateHermesProfile(path: string, workspace: string): { root: string; sourceId: string } {
  const check = (file: string, directory: boolean) => {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) throw new Error('Memory must use private operator-owned directories and marker');
  };
  if (!isAbsolute(path)) throw new Error('Memory path must be absolute');
  check(path, true);
  const root = realpathSync(path), cwd = canonicalPath(workspace);
  if (isWithin(root, cwd) || isWithin(cwd, root)) throw new Error('Memory must be outside the workspace');
  for (const child of ['data', 'data/global', 'data/projects-memory']) check(join(root, child), true);
  check(join(root, marker), false);
  const raw = JSON.parse(readFileSync(join(root, marker), 'utf8'));
  if (raw.version !== 1 || raw.owner !== 'pi-runtime' || raw.purpose !== 'hermes-memory' || typeof raw.sourceId !== 'string' || !/^pi-hermes:[a-f0-9-]{36}$/.test(raw.sourceId)) throw new Error('Unmanaged Pi memory store');
  return { root, sourceId: raw.sourceId };
}

/** Mirrors Hermes 0.9.10 project.ts, without importing its write-capable extension. */
export function detectHermesProject(workspace: string, storeRoot: string, repositoryRoot?: string): string | null {
  const cwd=resolve(workspace), home=resolve(homedir());
  if (cwd === home || cwd === dirname(cwd)) return null;
  const cwdName=basename(cwd);
  let current=cwd, repo: string | null=null;
  while (true) {
    const git=join(current,'.git');
    if (existsSync(git)) {
      repo=current;
      if (lstatSync(git).isFile()) {
        const pointer=/^gitdir:\s*(.+)$/m.exec(readFileSync(git,'utf8'));
        if (pointer) {
          const dir=resolve(current,pointer[1]!.trim());
          let common: string | undefined;
          if (existsSync(join(dir,'commondir'))) common=resolve(dir,readFileSync(join(dir,'commondir'),'utf8').trim());
          else if (basename(dirname(dir)) === 'worktrees') common=dirname(dirname(dir));
          if (common) repo=basename(common)==='.git'?dirname(common):common;
        }
      }
      break;
    }
    if (dirname(current)===current) break;
    current=dirname(current);
  }
  if (repositoryRoot !== undefined) {
    const hint=resolve(repositoryRoot);
    if (!isAbsolute(repositoryRoot) || !existsSync(join(hint,'.git')) || repo && repo!==hint) throw new Error('Invalid Hermes repository hint');
    if (!repo) repo=hint;
  }
  let name=repo && repo!==cwd && repo!==home ? basename(repo) : cwdName;
  const projects=join(storeRoot,'data/projects-memory');
  if (name!==cwdName && !existsSync(join(projects,name)) && existsSync(join(projects,cwdName))) name=cwdName;
  if (!name || name==='.' || name==='..' || /[\\/\0]/.test(name)) throw new Error('Invalid Hermes project name');
  return name;
}

/** Disabling policy cannot silently route an existing managed ledger through legacy writers. */
export function assertFactActivation(storeRoot:string,enabled:boolean):void {
  if(!enabled&&existsSync(join(storeRoot,'data/runtime-facts.sqlite')))throw new Error('Existing fact ledger requires explicit disabled migration before legacy launch');
}
