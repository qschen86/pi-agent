import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { main, parseArgs } from '../src/cli.mjs';
import { inspectService, readControl } from '../src/service-control.mjs';

const cli = resolve('apps/homebrew/src/cli.mjs');
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'pi-brew-cli-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}
const command = args => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 5000 });
async function launch(t, base) {
  const child = spawn(process.execPath, [cli, 'serve', '--data-parent', base], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => errors += chunk);
  t.after(async () => { if (child.exitCode === null) { const closed = once(child, 'exit'); child.kill('SIGTERM'); await closed; } });
  for (let i = 0; i < 100; i++) {
    if (output.includes('已启动')) return child;
    if (child.exitCode !== null) throw Error(errors);
    await new Promise(yes => setTimeout(yes, 20));
  }
  throw Error('service startup timeout');
}
test('version and stopped status have no data-directory side effects; bad commands fail', t => {
  const base = join(fixture(t), 'missing');
  assert.equal(command(['--version']).trim(), JSON.parse(readFileSync('package.json')).version);
  assert.deepEqual(JSON.parse(command(['status', '--json', '--data-parent', base])), { state: 'stopped' });
  assert.equal(existsSync(base), false);
  assert.throws(() => parseArgs(['serve', '--data-parent']));
  assert.throws(() => parseArgs(['serve', '--json']));
  assert.throws(() => command(['open', '--data-parent', base]), /brew services start/);
});
test('real serve verifies identity, holds exclusive lock, rejects untrusted requests and cleans up', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async t => {
  const base = fixture(t), child = await launch(t, base);
  const state = JSON.parse(command(['status', '--json', '--data-parent', base]));
  assert.equal(state.state, 'running'); assert.equal(state.pid, child.pid);
  const record = readControl(base);
  assert.equal(statSync(join(base, 'service.json')).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(state).includes(record.token), false);
  let browserUrl;
  await main(['open', '--data-parent', base], { openBrowser: async url => { browserUrl = url; } });
  assert.equal(browserUrl, `${state.origin}/setup#${record.token}`);
  await assert.rejects(main(['open', '--data-parent', base], { openBrowser: async () => { throw Error('browser unavailable'); } }), /browser unavailable/);
  assert.equal((await fetch(`${state.origin}/setup`)).status, 200);
  assert.equal((await fetch(`${state.origin}/api/local/status`)).status, 401);
  assert.equal((await fetch(`${state.origin}/api/local/identity`, { method: 'POST', body: '{}' })).status, 403);
  assert.throws(() => command(['serve', '--data-parent', base]), /已有服务/);
  assert.equal(readControl(base).instanceId, record.instanceId);
  const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit;
  assert.equal(existsSync(join(base, 'service.json')), false);
  assert.deepEqual(await inspectService(base), { state: 'stopped' });
  // OS lock releases on shutdown; same data can be reopened.
  await launch(t, base);
});
test('unrelated live PID and wrong HTTP identity never produce running status', async t => {
  const base = fixture(t);
  const server = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ pid: process.pid, instanceId: 'wrong' })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(yes => server.close(yes)));
  writeFileSync(join(base, 'service.json'), JSON.stringify({ schema: 2, pid: process.pid, root: join(base, 'instance'),
    origin: `http://127.0.0.1:${server.address().port}`, token: 'a'.repeat(64), instanceId: 'b'.repeat(32) }), { mode: 0o600 });
  assert.deepEqual(await inspectService(base), { state: 'unverified' });
});
test('live legacy instance refuses a second writer', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, t => {
  const base = fixture(t);
  writeFileSync(join(base, 'service.json'), JSON.stringify({ schema: 1, pid: process.pid }), { mode: 0o600 });
  assert.throws(() => command(['serve', '--data-parent', base]), /先停止旧服务/);
  assert.equal(JSON.parse(readFileSync(join(base, 'service.json'))).schema, 1);
});
