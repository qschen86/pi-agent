import { afterEach, expect, it, vi } from 'vitest';
import { PiRuntimeSupervisor } from '../src/supervisor.js';

afterEach(() => vi.useRealTimers());
it('waits for a human past 30 days and still accepts the original decision', async () => {
  vi.useFakeTimers();
  const runtime = new PiRuntimeSupervisor();
  let event: any;
  runtime.on('event', e => { event = e; });
  const promise = (runtime as any).ask({ kind: 'permissions', title: 'Write', action: 'write', scope: '/workspace', source: 'Pi' }, new AbortController().signal);
  let settled = false; void promise.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(30 * 24 * 3600_000);
  expect(settled).toBe(false);
  runtime.send({type: 'extension_ui_response', id: event.id, confirmed: true});
  expect(await promise).toMatchObject({approve: true});
});
it.each(['abort', 'stop'])('still cancels an indefinite approval on %s', async action => {
  const runtime = new PiRuntimeSupervisor();
  const promise = (runtime as any).ask({kind:'permissions'}, new AbortController().signal);
  if (action === 'stop') await runtime.stop(); else runtime.send({type:'abort'});
  expect(await promise).toMatchObject({approve:false});
});
