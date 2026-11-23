import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const [release, evidence] = process.argv.slice(2);
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const { tag: baseline } = JSON.parse(readFileSync('.github/release-baseline.json', 'utf8'));
assert.match(baseline, /^v\d+\.\d+\.\d+$/);
assert.match(process.env.GITHUB_REPOSITORY, /^[\w.-]+\/[\w.-]+$/);
const archive = join(release, `pi-agent-${version}-macos-arm64.tar.gz`);
const archiveHash = createHash('sha256').update(readFileSync(archive)).digest('hex');
const root = mkdtempSync(join(tmpdir(), 'pi-homebrew-candidate-'));
const fresh = join(root, 'fresh');
const existing = join(root, 'existing');
const password = 'synthetic-password-123';
const tap = 'candidate-verification/local';
const formulaName = tap + '/pi-agent';
const brew = (...args) => execFileSync('brew', args, {
  env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1' },
  encoding: 'utf8', timeout: 600_000
}).trim();
let service;
let browser;
let cli;

function install(formula) {
  const destination = join(brew('--repo', tap), 'Formula');
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'pi-agent.rb'), formula);
  brew('install', '--formula', formulaName);
  cli = join(brew('--prefix', formulaName), 'bin/pi-agent');
}

function command(...args) {
  return execFileSync(cli, args, { encoding: 'utf8', timeout: 10_000 }).trim();
}

async function initialize(base) {
  const prefix = brew('--prefix', formulaName);
  const { initializeInstallation } = await import(pathToFileURL(join(prefix, 'libexec/apps/homebrew/src/initialization.mjs')));
  mkdirSync(base, { mode: 0o700 });
  initializeInstallation({
    root: join(base, 'instance'), password, passwordConfirmation: password,
    environment: { eligible: true }, model: { provider: 'deepseek', id: 'deepseek-flash', apiKey: 'synthetic-not-real' }
  });
}

async function start(base) {
  service = spawn(cli, ['serve', '--data-parent', base], { stdio: ['ignore', 'inherit', 'inherit'] });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (service.exitCode !== null) throw Error('Candidate service exited');
    const status = JSON.parse(command('status', '--json', '--data-parent', base));
    if (status.state === 'running') return status;
    await delay(500);
  }
  throw Error('Candidate did not become ready');
}

async function stop() {
  const exited = once(service, 'exit');
  service.kill('SIGTERM');
  await Promise.race([exited, delay(8000, undefined, { ref: false }).then(() => { throw Error('Candidate did not stop'); })]);
  service = undefined;
}

async function client(origin) {
  const request = (path, init = {}) => fetch(origin + path, { signal: AbortSignal.timeout(10_000), redirect: 'error', ...init });
  const auth = await request('/api/local/login', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password })
  });
  assert.equal(auth.status, 200);
  const cookie = auth.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  return {
    cookie,
    call: (path, method = 'GET', body) => request(path, {
      method, headers: { origin, cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  };
}

try {
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Homebrew Candidate Verification';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'candidate@users.noreply.github.com';
  brew('tap-new', tap);
  const baselineUrl = `https://github.com/${process.env.GITHUB_REPOSITORY}/releases/download/${baseline}/pi-agent.rb`;
  const baselineResponse = await fetch(baselineUrl, { signal: AbortSignal.timeout(15_000) });
  assert.equal(baselineResponse.status, 200);
  const baselineFormula = await baselineResponse.text();
  install(baselineFormula);
  assert.equal(command('--version'), baseline.slice(1));
  await initialize(existing);
  const old = await start(existing);
  const oldClient = await client(old.origin);
  if ((await oldClient.call('/api/notes')).status === 404) {
    assert.equal((await oldClient.call('/api/apps/notes', 'PUT', { enabled: true })).status, 200);
  }
  const text = 'Synthetic cross-version acceptance note';
  const imported = await oldClient.call('/api/notes/import', 'POST', { notes: [{ text, createdAt: '2026-01-01T00:00:00.000Z' }], classify: false });
  assert.ok(imported.ok, await imported.text());
  assert.match(await (await oldClient.call('/api/notes')).text(), /Synthetic cross-version acceptance note/);
  const oldSettings = await (await oldClient.call('/api/runtime-settings')).json();
  assert.ok(oldSettings.workspaceRoots.length);
  await stop();
  brew('uninstall', formulaName);

  const original = readFileSync(join(release, 'pi-agent.rb'), 'utf8');
  assert.ok(original.includes(archiveHash), 'Formula references a different payload');
  install(original.replace(/^(  url )".*"$/m, `$1"${pathToFileURL(archive)}"`));
  assert.equal(command('--version'), version);
  brew('test', formulaName);

  const upgraded = await start(existing);
  assert.equal(upgraded.version, version);
  const upgradedClient = await client(upgraded.origin);
  if ((await upgradedClient.call('/api/notes')).status === 404) {
    assert.equal((await upgradedClient.call('/api/apps/notes', 'PUT', { enabled: true })).status, 200);
  }
  const oldNote = await upgradedClient.call('/api/notes');
  assert.equal(oldNote.status, 200);
  assert.ok((await oldNote.text()).includes(text));
  const upgradedSettings = await (await upgradedClient.call('/api/runtime-settings')).json();
  assert.deepEqual(upgradedSettings.workspaceRoots, oldSettings.workspaceRoots);
  await stop();

  await initialize(fresh);
  const first = await start(fresh);
  assert.equal(first.version, version);
  const newClient = await client(first.origin);
  const page = await newClient.call('/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /pi-agent|合己/i);
  assert.equal((await newClient.call('/api/memory/public')).status, 200);
  assert.equal((await newClient.call('/api/open-source-release')).status, 404);
  assert.equal((await newClient.call('/open-source-release.js')).status, 404);
  assert.equal((await newClient.call('/api/communications')).status, 404);
  assert.equal((await newClient.call('/api/ledger')).status, 404);

  mkdirSync(evidence, { recursive: true });
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const [name, value] = newClient.cookie.split('=');
  await context.addCookies([{ name, value, url: first.origin }]);
  const workbench = await context.newPage();
  const document = await workbench.goto(first.origin + '/#/rt');
  assert.equal(document.status(), 200);
  await workbench.locator('button[data-view="rt"]').waitFor({ state: 'visible' });
  await workbench.locator('button[data-view="rt"]').click();
  await workbench.waitForURL('**/#/rt');
  assert.equal(await workbench.getByRole('button', { name: '开源发布', exact: true }).count(), 0);
  const screenshot = await workbench.screenshot({ path: join(evidence, 'workbench.png') });
  const screenshotHash = createHash('sha256').update(screenshot).digest('hex');
  await browser.close();
  browser = undefined;

  await stop();
  assert.equal(JSON.parse(command('status', '--json', '--data-parent', fresh)).state, 'stopped');
  const restarted = await start(fresh);
  assert.equal(restarted.version, version);
  assert.notEqual(restarted.pid, first.pid);
  await stop();

  writeFileSync(join(evidence, 'result.json'), JSON.stringify({
    status: 'passed', sha: process.env.GITHUB_SHA, version, archiveHash, baseline, screenshotHash,
    brewInstall: true, brewTest: true, isolatedInstance: true, http: true, browser: true, restart: true,
    dataUpgrade: true, preserved: ['notes', 'runtime workspace roots'], modelTask: 'not-run'
  }, null, 2));
} finally {
  await browser?.close();
  if (service && service.exitCode === null) {
    const exited = once(service, 'exit');
    service.kill('SIGKILL');
    await exited;
  }
  rmSync(root, { recursive: true, force: true });
}
