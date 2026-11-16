import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeInstallation, readInstallation, verifyPassword } from '../src/initialization.mjs';

function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'pi-mac-initialize-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return { root: join(parent, 'installation'), password: 'synthetic-password-123', passwordConfirmation: 'synthetic-password-123', environment: { eligible: true }, model: { provider: 'deepseek', id: 'synthetic-model', apiKey: 'synthetic-key-not-a-real-credential' } };
}
test('new installation is private, local, empty, and does not claim acceptance', t => {
  const input = fixture(t); const result = initializeInstallation(input); const config = readInstallation(input.root);
  assert.equal(result.state, 'configured');
  assert.equal(config.acceptance.modelConnection, 'pending');
  assert.equal(config.acceptance.firstTask, 'pending');
  assert.deepEqual(config.access, { host: '127.0.0.1', remote: false });
  assert.ok(config.components.includes('quick-actions'));
  assert.equal(statSync(input.root).mode & 0o777, 0o700);
  assert.equal(statSync(join(input.root, 'credentials/pi/auth.json')).mode & 0o777, 0o600);
  const adminText = readFileSync(join(input.root, 'credentials/admin.json'), 'utf8');
  assert.equal(adminText.includes(input.password), false);
  const record = JSON.parse(adminText);
  assert.equal(verifyPassword(input.password, record), true);
  assert.equal(verifyPassword('incorrect', record), false);
  assert.equal(JSON.stringify(config).includes(input.model.apiKey), false);
  const billing = JSON.parse(readFileSync(join(input.root, 'data/runtime-billing.json'), 'utf8'));
  assert.deepEqual(billing, { pi: { mode: 'api' }, codex: { mode: 'api' }, 'claude-code': { mode: 'api' } });
});
test('existing data survives repeated initialization attempts', t => {
  const input = fixture(t); initializeInstallation(input);
  const before = readFileSync(join(input.root, 'credentials/pi/auth.json'), 'utf8');
  assert.throws(() => initializeInstallation({ ...input, model: { ...input.model, apiKey: 'different-key' } }), /已经存在/);
  assert.equal(readFileSync(join(input.root, 'credentials/pi/auth.json'), 'utf8'), before);
});
test('failed hardware check and invalid fields never publish an installation', t => {
  for (const change of [{ environment: { eligible: false } }, { passwordConfirmation: 'different' }, { password: 'short', passwordConfirmation: 'short' }, { model: { provider: 'other' } }]) {
    const input = { ...fixture(t), ...change };
    assert.throws(() => initializeInstallation(input));
    assert.equal(existsSync(input.root), false);
  }
});
test('symlink destination and symlink parent cannot redirect credential writes', t => {
  const input = fixture(t); const other = join(input.root, '..', 'other'); mkdirSync(other);
  symlinkSync(other, input.root);
  assert.throws(() => initializeInstallation(input), /已经存在/);
  const alias = join(input.root, '..', 'alias'); symlinkSync(other, alias);
  assert.throws(() => initializeInstallation({ ...input, root: join(alias, 'install') }), /符号链接/);
  assert.equal(existsSync(join(other, 'credentials')), false);
});
