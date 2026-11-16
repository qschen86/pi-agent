import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { hermesRuntimeConfig } from '../src/hermes-startup.js';

it('loads only the selected project index and bounds operator supplied startup context', () => {
  const root = mkdtempSync(join(tmpdir(), 'memory-startup-'));
  try {
    writeFileSync(join(root, 'startup-policy.json'), JSON.stringify({ version: 1,
      corePreferences: ['先核对已完成的证据，再继续未完成工作。'],
      projects: { alpha: ['auth → login conventions'], beta: ['secret beta index'] }
    }), { mode: 0o600 });
    const config = hermesRuntimeConfig(root, 'alpha');
    expect(config.memoryPolicyCustomText).toContain('auth → login conventions');
    expect(config.memoryPolicyCustomText).not.toContain('secret beta index');
    expect(hermesRuntimeConfig(root, null).memoryPolicyCustomText).not.toContain('auth → login conventions');
    writeFileSync(join(root, 'startup-policy.json'), JSON.stringify({version: 1, corePreferences: ['x'.repeat(5000)], projects: {}}), { mode: 0o600 });
    expect(() => hermesRuntimeConfig(root, 'alpha')).toThrow(/budget/);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

it('rejects a redirected startup policy instead of trusting its instructions', () => {
  const root = mkdtempSync(join(tmpdir(), 'memory-startup-'));
  try {
    writeFileSync(join(root, 'actual.json'), JSON.stringify({version: 1, corePreferences: [], projects: {}}), {mode: 0o600});
    symlinkSync(join(root, 'actual.json'), join(root, 'startup-policy.json'));
    expect(() => hermesRuntimeConfig(root, null)).toThrow(/private.*file/);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
