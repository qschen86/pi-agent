import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { nativeModelPort } from '../src/native-model-port.js';
import type { RuntimeDriver, StartTurnArgs, TurnSink, TurnResult } from '../../../packages/runtime-sessions/src/driver.js';
const config = { role: 'sessionTitle' as const, provider: 'synthetic', model: 'synthetic', promptVersion: '1', schemaVersion: '1', timeoutMs: 50, maxAttempts: 1 };
it('native auxiliary jobs refuse tool approvals and unconfirmed terminal output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-port-'));
  try {
    for (const terminalObserved of [false, true]) {
      const driver = { kind: 'codex', startTurn: async (args: StartTurnArgs, sink: TurnSink) => {
        expect(args.workspace.startsWith(join(root, 'runtime/completions'))).toBe(true);
        expect(args.permissionMode).toBe('read-only');
        expect((await sink.approval({} as never)).approve).toBe(false);
        sink.nativeSession('native-fixture', { effectiveModel: 'actually-reported-model', modelSource: 'fixture' });
        sink.event({ key: 'answer', kind: 'message', role: 'assistant', text: 'a title' } as never);
        return { done: Promise.resolve({ status: 'completed', terminalObserved } as TurnResult), interrupt: async () => {} };
      } } as unknown as RuntimeDriver;
      const result = nativeModelPort(root, driver, () => 'own-native-model').complete(config, { system: 'title only', prompt: 'fixture' });
      if (terminalObserved) { const response = await result; expect(response.text).toBe('a title'); expect(response.model).toBe('actually-reported-model'); }
      else await expect(result).rejects.toThrow('未完成');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('auxiliary timeout interrupts and rejects rather than waiting forever', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-timeout-')); let interrupted = false;
  try {
    const driver = { kind: 'claude-code', startTurn: async () => ({ done: new Promise(() => {}), interrupt: async () => { interrupted = true; } }) } as unknown as RuntimeDriver;
    await expect(nativeModelPort(root, driver, () => undefined).complete({ ...config, timeoutMs: 5 }, { system: 'fixture', prompt: 'fixture' })).rejects.toThrow('超时');
    expect(interrupted).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
