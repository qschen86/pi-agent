import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareWorkspaceRepo } from '../src/workspace-repo.mjs';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
const temp = t => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pi-workspace-repo-'))); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test('a plain workspace becomes its own repository on main with one commit, independent of user git config', async t => {
  const dir = temp(t);
  assert.equal(await prepareWorkspaceRepo(dir), true);
  assert.equal(git(dir, 'rev-parse', '--show-toplevel'), dir);
  assert.equal(git(dir, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(await prepareWorkspaceRepo(dir), true);
  assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), '1', 'a second call must not add commits');
  git(dir, 'worktree', 'add', '-q', '-b', 'session', join(dir, '.pi-worktrees/s'), 'main');
  assert.ok(existsSync(join(dir, '.pi-worktrees/s')), 'the prepared repository must accept a session worktree');
});
test('a repository in a parent directory is not adopted', async t => {
  const parent = temp(t); git(parent, 'init', '-q', '-b', 'main');
  const child = join(parent, 'workspaces'); mkdirSync(child);
  assert.equal(await prepareWorkspaceRepo(child), true);
  assert.equal(git(child, 'rev-parse', '--show-toplevel'), child);
});
test('missing git or developer tools report false instead of throwing', async t => {
  const dir = temp(t);
  assert.equal(await prepareWorkspaceRepo(dir, async () => { throw Error('no git'); }), false);
  assert.equal(await prepareWorkspaceRepo(dir, async (command) => command === '/usr/bin/which' ? '/usr/bin/git' : (() => { throw Error('xcode-select: no developer tools'); })()), false);
});
