import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

// Real Homebrew acceptance, deliberately refuses a pre-existing installation.
const brew = '/opt/homebrew/bin/brew';
const cli = '/opt/homebrew/bin/pi-agent';
const formula = 'qschen86/pi-agent/pi-agent';
const base = join(homedir(), 'Library/Application Support/pi-agent');
const env = { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1', HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: '1', HOMEBREW_NO_ANALYTICS: '1' };
const run = (file, args) => execFileSync(file, args, { env, encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 ** 2 }).trim();
const state = () => JSON.parse(run(cli, ['status', '--json']));
async function expectState(expected) {
  let last;
  for (let i = 0; i < 40; i++) {
    try { last = state(); if (last.state === expected) return last; } catch { /* Startup may still be publishing control state. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error(`Expected ${expected}, received ${last?.state ?? 'unknown'}`);
}
const report = { formula, checks: {}, realModelTask: 'not-tested', cleanOperatingSystem: false };
try {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert.equal(existsSync(cli), false, 'Refusing to replace an existing pi-agent executable');
  assert.equal(existsSync(join(base, 'instance')), false, 'Use a fresh instance for installation acceptance');
  assert.equal(existsSync(join(base, 'service.json')), false, 'Refusing to interfere with another local service');
  console.log(run(brew, ['tap', 'qschen86/pi-agent']));
  console.log(run(brew, ['install', formula]));
  report.checks.install = 'passed';
  assert.equal(run(cli, ['--version']), '0.1.0');
  assert.equal(state().state, 'stopped');
  console.log(run(brew, ['test', formula])); report.checks.formulaTest = 'passed';
  console.log(run(brew, ['services', 'start', formula]));
  const first = await expectState('running'); report.checks.serviceStart = 'passed';
  const page = await fetch(first.origin + '/setup', { redirect: 'error' });
  assert.equal(page.status, 200); assert.match(await page.text(), /pi-agent/);
  report.checks.localPage = 'passed';
  console.log(run(brew, ['services', 'restart', formula]));
  const restarted = await expectState('running');
  assert.notEqual(restarted.pid, first.pid); report.checks.serviceRestart = 'passed';
  console.log(run(brew, ['services', 'stop', formula]));
  await expectState('stopped'); report.checks.serviceStop = 'passed';
  const proof = join(base, '.homebrew-install-proof-' + randomUUID());
  const contents = randomUUID(); writeFileSync(proof, contents, { flag: 'wx', mode: 0o600 });
  console.log(run(brew, ['uninstall', formula]));
  assert.equal(existsSync(cli), false); assert.equal(readFileSync(proof, 'utf8'), contents);
  report.checks.uninstallPreservesDataMarker = 'passed';
  console.log(run(brew, ['install', formula]));
  assert.equal(run(cli, ['--version']), '0.1.0'); assert.equal(readFileSync(proof, 'utf8'), contents);
  report.checks.reinstall = 'passed'; rmSync(proof);
  console.log(run(brew, ['services', 'start', formula]));
  const final = await expectState('running');
  if (process.argv.includes('--open')) { console.log(run(cli, ['open'])); report.checks.nativeBrowserOpen = 'passed'; }
  report.checks.finalRunning = 'passed';
  report.version = final.version;
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error.message);
  if (error.stderr) console.error(String(error.stderr).slice(-5000));
  console.log(JSON.stringify({ ...report, passed: false }, null, 2));
  process.exitCode = 1;
}
