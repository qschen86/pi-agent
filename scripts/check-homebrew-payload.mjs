import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validatePayload } from '../apps/homebrew/src/payload.mjs';

// Offline package smoke: synthetic credential, no model completion and no production directories.
const source = resolve(process.argv[2]);
const manifest = validatePayload(source);
const parent = mkdtempSync('/private/tmp/pi-homebrew-offline-');
const root = join(parent, 'instance');
const payloadRoot = join(parent, 'installed');
cpSync(source, payloadRoot, { recursive: true });
const nodeWrapper = join(payloadRoot, 'bin/node');
const shellQuote = text => "'" + text.replaceAll("'", "'\\''") + "'";
writeFileSync(nodeWrapper, '#!/bin/sh\nexec ' + shellQuote(process.execPath) + ' \"$@\"\n', { mode: 0o755 });
let core;
try {
  const { initializeInstallation } = await import(pathToFileURL(join(payloadRoot, 'apps/homebrew/src/initialization.mjs')));
  initializeInstallation({ root, password: 'synthetic-password-123', passwordConfirmation: 'synthetic-password-123', environment: { eligible: true }, model: { provider: 'deepseek', id: 'deepseek-flash', apiKey: 'synthetic-not-real' } });
  const { createCore } = await import(pathToFileURL(join(payloadRoot, 'bundle/core.mjs')));
  core = await createCore({ root, port: 45124, payloadRoot });
  const get = async path => {
    const response = await core.fetch(new Request('http://127.0.0.1:45124' + path));
    assert.equal(response.status, 200, path);
    return response;
  };
  const html = await (await get('/')).text();
  for (const match of html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)) {
    if (/\.(?:js|css)(?:\?|$)/.test(match[1])) await get(match[1]);
  }
  for (const path of ['/api/notes', '/api/artifacts', '/api/memory/public']) await get(path);
  const cost = await (await get('/api/platform/today-cost')).json();
  assert.equal(cost.total, 0, 'empty installation has no purchased subscriptions or usage');
  assert.equal(process.env.PI_AGENT_GUI_ROOT, root);
  assert.equal(process.env.CODEX_HOME, join(root, 'credentials/codex'));
  assert.equal(process.env.CLAUDE_CONFIG_DIR, join(root, 'credentials/claude'));
  assert.equal((await core.fetch(new Request('http://127.0.0.1:45124/api/ledger'))).status, 404);
  const invalidRecord = await core.fetch(new Request('http://127.0.0.1:45124/api/runtime-sessions/rt-synthetic/records', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pi-record-capability': 'invalid' }, body: '{}' }));
  assert.equal(invalidRecord.status, 401);
  const locations = JSON.parse(readFileSync(join(payloadRoot, 'runtime-locations.json'), 'utf8'));
  const profile = await core.runtime.probe('pi');
  assert.ok(['connectable', 'executable'].includes(profile.state), profile.stateReason);
  assert.ok(profile.models.some(model => model.id === `deepseek/${locations.supportedModels[0]}`));
  const boundaryCheck = spawnSync(process.execPath, [
    '--import', join(payloadRoot, 'node_modules/tsx/dist/loader.mjs'),
    '--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import { spawnSync } from 'node:child_process';
      import { readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      const [payloadRoot, root] = process.argv.slice(1);
      const { preparePiChatBoundary } = await import(pathToFileURL(join(payloadRoot, 'layout/packages/pi-runtime/src/pi-boundary.ts')));
      const locations = JSON.parse(readFileSync(join(payloadRoot, 'runtime-locations.json'), 'utf8'));
      const boundary = await preparePiChatBoundary({
        workspace: join(root, 'workspaces'), sourceAgentDir: join(root, 'credentials/pi'),
        runtimeRoot: join(root, 'runtime/smoke'), guardDir: join(root, 'runtime/smoke-guard'),
        mode: 'pi-ask', provider: 'deepseek'
      });
      try {
        const wrapped = await boundary.wrap(join(payloadRoot, locations.pi), ['--version']);
        const result = spawnSync(wrapped.command, wrapped.args, {
          cwd: join(root, 'workspaces'), env: { ...boundary.env, ...wrapped.env },
          encoding: 'utf8', timeout: 10000
        });
        assert.equal(result.status, 0, 'installed Pi must execute inside Seatbelt');
        assert.match(result.stdout.trim(), /^\\d+\\.\\d+\\.\\d+$/);
      } finally { await boundary.dispose(); }
    `, payloadRoot, root
  ], { encoding: 'utf8', timeout: 30000 });
  assert.equal(boundaryCheck.status, 0, `installed runtime boundary smoke failed: ${boundaryCheck.stderr.slice(-1000)}`);
  console.log(JSON.stringify({ passed: true, files: Object.keys(manifest.files).length, node: process.version, pi: profile.binaryVersion, modelCatalog: profile.models.length, installedRuntimeBoundary: 'passed', realModelTask: 'not-tested', isolation: 'new-temporary-instance' }));
} finally { if (core) await core.close(); rmSync(parent, { recursive: true, force: true }); }
