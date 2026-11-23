import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);
// Never read or write the user's own git config; the identity below only labels the installer's initial commit.
const gitEnv = () => ({ ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
const defaultExec = (command, args, options) => run(command, args, { encoding: 'utf8', timeout: 15_000, env: gitEnv(), ...options }).then(result => result.stdout.trim());

/**
 * Makes `dir` a git repository with one commit so a session can get its own worktree.
 * Returns true when the directory is (now) its own repository with a commit; false when git is unavailable,
 * so callers can fall back to a plain workspace instead of failing the first task.
 */
export async function prepareWorkspaceRepo(dir, exec = defaultExec) {
  try {
    // /usr/bin/git is a shim that pops an install dialog when the Xcode command line tools are missing.
    const shim = await exec('/usr/bin/which', ['git']).catch(() => '');
    if (!shim) return false;
    if (shim === '/usr/bin/git') await exec('/usr/bin/xcode-select', ['-p']);
    const real = realpathSync(dir);
    // A parent directory's repository must not be adopted: the worktree would belong to someone else's repo.
    const top = await exec('git', ['-C', real, 'rev-parse', '--show-toplevel']).then(path => realpathSync(path), () => undefined);
    if (top !== real) await exec('git', ['-C', real, 'init', '-q', '-b', 'main']);
    const hasCommit = await exec('git', ['-C', real, 'rev-parse', '--verify', '-q', 'HEAD^{commit}']).then(() => true, () => false);
    if (!hasCommit) await exec('git', ['-C', real, '-c', 'user.name=pi-agent', '-c', 'user.email=pi-agent@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'Initial workspace']);
    return true;
  } catch { return false; }
}
